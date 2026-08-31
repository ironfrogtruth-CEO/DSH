#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FakeModelBackend, StenographerService } from '../index.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-stenographer-two-hour-'))
const service = new StenographerService({ storageRoot: root, port: 43124, backend: new FakeModelBackend() })
const jsonHeaders = { 'content-type': 'application/json' }

async function call(method, url, body, headers = {}) {
  let status = 0
  let responseBody = ''
  let responseHeaders = {}
  await service.handle({ method, url, headers: { ...(body === undefined ? {} : Buffer.isBuffer(body) ? { 'content-type': 'application/octet-stream' } : jsonHeaders), ...headers }, ...(body === undefined ? {} : { body }) }, {
    writeHead(code, values) { status = code; responseHeaders = values || {} },
    end(value) { responseBody = value || '' },
  })
  const value = responseHeaders['Content-Type']?.includes('json') ? JSON.parse(responseBody) : null
  if (status >= 400 || value?.ok === false) throw new Error(`${status} ${responseBody}`)
  return value
}

try {
  await service.ready()
  const created = await call('POST', '/api/stenographer/sessions', JSON.stringify({ source: 'microphone', expectedSpeakers: 'auto', language: 'zh-CN', title: '两小时长稳验收' }))
  const id = created.session.id
  const token = created.upload.token
  const auth = { 'x-stenographer-token': token }
  await call('POST', `/api/stenographer/sessions/${id}/state`, JSON.stringify({ state: 'recording' }), auth)
  const chunk = Buffer.alloc(1_048_576)
  const chunks = 220
  for (let seq = 0; seq < chunks; seq += 1) {
    await call('POST', `/api/stenographer/sessions/${id}/audio?source=microphone&seq=${seq}&capturedAtMs=${Date.now() + seq * 32768}`, chunk, auth)
  }
  const stopped = await call('POST', `/api/stenographer/sessions/${id}/state`, JSON.stringify({ state: 'stopped' }), auth)
  assert.ok(stopped.session.durationMs >= 7_200_000, `duration too short: ${stopped.session.durationMs}`)
  await call('POST', `/api/stenographer/sessions/${id}/finalize`, JSON.stringify({ baseRevision: stopped.session.revision }), auth)
  const deadline = Date.now() + 120_000
  let snapshot
  while (Date.now() < deadline) {
    snapshot = (await call('GET', `/api/stenographer/sessions/${id}`)).session
    if (snapshot.state === 'ready' || snapshot.state === 'error') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(snapshot?.state, 'ready', JSON.stringify(snapshot?.error || snapshot?.progress))
  assert.equal(snapshot.document.blocks.length, 0, 'two hours of silence must not fabricate text')
  await service.close()

  const restored = new StenographerService({ storageRoot: root, port: 43124, backend: new FakeModelBackend() })
  await restored.ready()
  const afterRestart = (await callRestored(restored, id)).session
  assert.equal(afterRestart.state, 'ready')
  assert.ok(afterRestart.durationMs >= 7_200_000)
  await restored.close()
  process.stdout.write(`${JSON.stringify({ ok: true, chunks, bytes: chunk.byteLength * chunks, durationMs: afterRestart.durationMs, state: afterRestart.state })}\n`)
} finally {
  await service.close().catch(() => {})
  await rm(root, { recursive: true, force: true })
}

async function callRestored(instance, id) {
  let status = 0
  let responseBody = ''
  let responseHeaders = {}
  await instance.handle({ method: 'GET', url: `/api/stenographer/sessions/${id}`, headers: {} }, {
    writeHead(code, values) { status = code; responseHeaders = values || {} },
    end(value) { responseBody = value || '' },
  })
  assert.equal(status, 200)
  assert.ok(responseHeaders['Content-Type']?.includes('json'))
  return JSON.parse(responseBody)
}
