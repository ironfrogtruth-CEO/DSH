import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { apply, inject, protocolVersion } from './index.js'

function createHarness() {
  const routes = []
  const tools = []
  const ctx = {
    webServer: { register(route) { routes.push(route); return () => {} } },
    tools: { register(tool) { tools.push(tool); return () => {} } },
    effect(callback) { return callback() },
  }
  apply(ctx)
  return { routes, tools }
}

async function request(route, { method = 'GET', url = '/api/webbridge/status', body, contentType = 'application/json' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = contentType ? { 'content-type': contentType } : {}
  let resolveResponse
  const completed = new Promise((resolve) => { resolveResponse = resolve })
  const res = {
    statusCode: null,
    headers: null,
    writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers },
    end(payload = '') { resolveResponse({ statusCode: this.statusCode, headers: this.headers, body: JSON.parse(String(payload || '{}')) }) },
  }
  const running = route.handler(req, res)
  if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
  req.emit('end')
  await running
  return await completed
}

test('webbridge declares every Host service it reads and registers all routes/tools', () => {
  const { routes, tools } = createHarness()
  assert.deepEqual(inject, ['webServer', 'tools'])
  assert.equal(protocolVersion, 2)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/api/webbridge')
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(tools.length, 21)
  assert.equal(new Set(tools.map((tool) => tool.name)).size, 21)
  for (const tool of tools) {
    assert.match(tool.name, /^webbridge_/)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.run, undefined)
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(tool.output.schema.additionalProperties, true)
    assert.equal(typeof tool.output.render, 'function')
    assert.match(tool.output.render({}, { ok: true })[0].text, /"ok": true/)
  }
})

test('POST JSON control plane carries a command/result and reports native activity', async () => {
  const { routes, tools } = createHarness()
  const route = routes[0]
  const statusTool = tools.find((tool) => tool.name === 'webbridge_status')
  const toolResult = statusTool.execute({})

  const next = await request(route, {
    method: 'POST',
    url: '/api/webbridge/next',
    body: { protocol: 2 },
  })
  assert.equal(next.statusCode, 200)
  assert.equal(next.body.kind, 'status')
  assert.match(next.body.cmdId, /^w\d+-/)

  const posted = await request(route, {
    method: 'POST',
    url: '/api/webbridge/result',
    body: { protocol: 2, cmdId: next.body.cmdId, result: { ok: true, data: { bridgeConnected: true } } },
  })
  assert.equal(posted.statusCode, 200)
  assert.deepEqual(await toolResult, { ok: true, data: { bridgeConnected: true } })

  const status = await request(route)
  assert.equal(status.body.protocol, 2)
  assert.equal(status.body.controlPlane, 'post-json')
  assert.equal(status.body.nativeHostConnected, true)
  assert.equal(typeof status.body.lastNativeActivityAt, 'number')
})

test('control plane rejects GET, wrong media type, and protocol mismatches', async () => {
  const { routes } = createHarness()
  const route = routes[0]
  assert.equal((await request(route, { method: 'GET', url: '/api/webbridge/next' })).statusCode, 405)
  assert.equal((await request(route, { method: 'POST', url: '/api/webbridge/next', body: {}, contentType: 'text/plain' })).statusCode, 415)
  const mismatch = await request(route, { method: 'POST', url: '/api/webbridge/next', body: { protocol: 1 } })
  assert.equal(mismatch.statusCode, 409)
  assert.equal(mismatch.body.expected, 2)
})

test('localhost command API uses the same Native Host queue and returns the browser result', async () => {
  const { routes } = createHarness()
  const route = routes[0]
  const commandResponse = request(route, {
    method: 'POST',
    url: '/api/webbridge/command',
    body: { protocol: 2, command: { kind: 'status', tabId: 42 }, timeoutMs: 5000 },
  })
  const next = await request(route, {
    method: 'POST',
    url: '/api/webbridge/next',
    body: { protocol: 2 },
  })
  assert.equal(next.body.kind, 'status')
  assert.equal(next.body.tabId, 42)
  await request(route, {
    method: 'POST',
    url: '/api/webbridge/result',
    body: { protocol: 2, cmdId: next.body.cmdId, result: { ok: true, data: { tabId: 42 } } },
  })
  const completed = await commandResponse
  assert.equal(completed.statusCode, 200)
  assert.deepEqual(completed.body, { ok: true, data: { tabId: 42 } })
})

test('operation lease drives Chrome indicator and activate routes to the owned tab', async () => {
  const { routes } = createHarness()
  const route = routes[0]
  const begun = await request(route, {
    method: 'POST',
    url: '/api/webbridge/operation',
    body: { protocol: 2, action: 'begin', operationId: 'op-1', label: '公众号发布', owner: 'article@虾六答', tabId: 77 },
  })
  assert.equal(begun.statusCode, 200)
  assert.equal(begun.body.operation.tabId, 77)

  const active = await request(route)
  assert.equal(active.body.chromeOperating, true)
  assert.equal(active.body.operation.operationId, 'op-1')
  assert.equal(active.body.operation.source, 'lease')

  const activating = request(route, {
    method: 'POST',
    url: '/api/webbridge/activate',
    body: { protocol: 2, tabId: 77 },
  })
  const next = await request(route, {
    method: 'POST',
    url: '/api/webbridge/next',
    body: { protocol: 2 },
  })
  assert.equal(next.body.kind, 'activate_tab')
  assert.equal(next.body.tabId, 77)
  await request(route, {
    method: 'POST',
    url: '/api/webbridge/result',
    body: { protocol: 2, cmdId: next.body.cmdId, result: { ok: true, data: { tabId: 77, active: true } } },
  })
  assert.equal((await activating).body.ok, true)

  const ended = await request(route, {
    method: 'POST',
    url: '/api/webbridge/operation',
    body: { protocol: 2, action: 'end', operationId: 'op-1' },
  })
  assert.equal(ended.body.active, false)
})
