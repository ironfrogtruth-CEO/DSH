import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  COMPLETION_TITLE,
  POLL_INTERVAL_MS,
  buildOutboxTask,
  createApiHandlers,
  createCompletionTracker,
  endpointFingerprint,
  inject,
  lastTurnFromAgent,
  lastUserTextFromEvents,
  mergeSubscriptions,
  normalizeSubscribeBody,
  shouldNotifyCompletion,
  truncateBody,
} from './index.js'

const FIXTURE_HOME = mkdtempSync(join(tmpdir(), 'dsh-mobile-push-test-'))
process.env.DSH_MOBILE_PUSH_DIR = join(FIXTURE_HOME, 'mobile-push')

function fakeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(payload) {
      this.body = payload === undefined ? null : JSON.parse(payload)
    },
  }
}

function fakeReq(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    [Symbol.asyncIterator]: async function* () {
      yield* chunks
    },
  }
}

function fixturePaths() {
  const dir = process.env.DSH_MOBILE_PUSH_DIR
  return {
    dir,
    vapid: join(dir, 'vapid.json'),
    subscriptions: join(dir, 'subscriptions.json'),
    outbox: join(dir, 'outbox.jsonl'),
  }
}

const validBody = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  keys: { p256dh: 'BKey123', auth: 'Auth456' },
}

test('runtime declares the canonical Host services used by the plugin', () => {
  assert.deepEqual(inject, ['webServer', 'sessionQuery', 'sessionPersistence', 'agents'])
  assert.equal(POLL_INTERVAL_MS, 5_000)
})

test('subscribe 校验字段齐全且拒绝畸形输入', async () => {
  const handlers = createApiHandlers({ paths: fixturePaths() })
  for (const bad of [undefined, {}, { endpoint: 'ftp://x' }, { ...validBody, keys: {} }, { ...validBody, keys: { p256dh: '', auth: 'x' } }]) {
    const res = fakeRes()
    await handlers.subscribe(fakeReq('POST', bad), res)
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(bad)}`)
  }
  const res = fakeRes()
  await handlers.subscribe(fakeReq('POST', validBody), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { ok: true, count: 1 })
})

test('subscribe 按 endpoint sha256 去重并更新 keys', async () => {
  const handlers = createApiHandlers({ paths: fixturePaths() })
  const first = fakeRes()
  await handlers.subscribe(fakeReq('POST', validBody), first)
  const again = fakeRes()
  await handlers.subscribe(fakeReq('POST', validBody), again)
  assert.deepEqual(again.body, { ok: true, count: 1 })
  const rotated = fakeRes()
  await handlers.subscribe(fakeReq('POST', { ...validBody, keys: { p256dh: 'BNew', auth: 'ANew' } }), rotated)
  assert.deepEqual(rotated.body, { ok: true, count: 1 })
  const stored = JSON.parse(readFileSync(fixturePaths().subscriptions, 'utf8'))
  assert.equal(stored.length, 1)
  assert.equal(stored[0].fingerprint, endpointFingerprint(validBody.endpoint))
  assert.deepEqual(stored[0].keys, { p256dh: 'BNew', auth: 'ANew' })
  assert.equal(typeof stored[0].subscribedAt, 'string')
  assert.equal(statSync(fixturePaths().subscriptions).mode & 0o777, 0o600)
})

test('config 返回 vapidPublicKey，缺失时 503', async () => {
  const handlers = createApiHandlers({ paths: fixturePaths() })
  const missing = fakeRes()
  await handlers.config(fakeReq('GET'), missing)
  assert.equal(missing.statusCode, 503)
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(fixturePaths().dir, { recursive: true, mode: 0o700 })
  writeFileSync(fixturePaths().vapid, JSON.stringify({ public: 'BPub', private: 'Priv', subject: 'mailto:dashen@yizhiwa.cn' }), { mode: 0o600 })
  const ok = fakeRes()
  await handlers.config(fakeReq('GET'), ok)
  assert.equal(ok.statusCode, 200)
  assert.deepEqual(ok.body, { ok: true, vapidPublicKey: 'BPub' })
  assert.equal(ok.body.public, undefined)
  assert.equal(JSON.stringify(ok.body).includes('Priv'), false, '私钥绝不返回')
  const post = fakeRes()
  await handlers.config(fakeReq('POST'), post)
  assert.equal(post.statusCode, 405)
})

test('test handler 立即写一条 outbox 任务', async () => {
  const handlers = createApiHandlers({ paths: fixturePaths() })
  const storedCount = existsSync(fixturePaths().subscriptions) ? JSON.parse(readFileSync(fixturePaths().subscriptions, 'utf8')).length : 0
  const res = fakeRes()
  await handlers.test(fakeReq('POST'), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { ok: true, queued: true, count: storedCount })
  const raw = readFileSync(fixturePaths().outbox, 'utf8').trim().split('\n').filter((line) => line.includes('大神 · 测试推送'))
  assert.equal(raw.length, 1)
  const task = JSON.parse(raw[0])
  assert.equal(task.title, '大神 · 测试推送')
  assert.equal(task.attempts, 0)
  assert.match(task.id, /^[0-9a-f-]{36}$/)
  assert.equal(statSync(fixturePaths().outbox).mode & 0o777, 0o600)
})

test('completion tracker 写入 outbox 且按 (sessionId, turn) 幂等', async () => {
  const tracker = createCompletionTracker({
    sessionQuery: {
      async readTitleSnapshots(ids) {
        return [{ sessionId: ids[0], status: 'fulfilled', value: { title: { title: '批量标题' } } }]
      },
    },
  })
  const first = await tracker.handleCompletion('session-a', 3, null)
  assert.equal(first.title, COMPLETION_TITLE)
  assert.equal(first.body, '批量标题')
  assert.equal(first.path, '/')
  const duplicate = await tracker.handleCompletion('session-a', 3, null)
  assert.equal(duplicate, null)
  const raw = readFileSync(fixturePaths().outbox, 'utf8').trim().split('\n').filter((line) => line.includes(COMPLETION_TITLE))
  assert.equal(raw.length, 1)
})

test('标题缺失时回退到最后一条真实用户消息并截断到 60 字', async () => {
  const longText = '长'.repeat(100)
  const tracker = createCompletionTracker({ sessionQuery: {} })
  const session = {
    events: [
      { type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: '早前消息' }] } } },
      { type: 'user/message', data: { message: { source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: '内部投影不算' }] } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '回答' }] } } },
      { type: 'turn/end', data: { turn: 7 } },
      { type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: longText }] } } },
    ],
  }
  const task = await tracker.handleCompletion('session-b', 7, session)
  assert.equal(task.body.length, 60)
  assert.equal(task.body.endsWith('…'), true)
})

test('lastTurnFromAgent 只认已落盘的 turn 边界', () => {
  assert.equal(lastTurnFromAgent(undefined), 0)
  assert.equal(lastTurnFromAgent({ session: {} }), 0)
  assert.equal(lastTurnFromAgent({ session: { events: [{ type: 'turn/start', data: { turn: 2 } }, { type: 'turn/end', data: { turn: 2 } }, { type: 'user/message' }] } }), 2)
  assert.equal(lastTurnFromAgent({ session: { events: [{ type: 'turn/start', data: { turn: 5 } }] } }), 5)
})

test('shouldNotifyCompletion 幂等语义', () => {
  const state = { notifiedTurns: new Map() }
  assert.equal(shouldNotifyCompletion(state, 's1', 1), true)
  assert.equal(shouldNotifyCompletion(state, 's1', 1), false)
  assert.equal(shouldNotifyCompletion(state, 's1', 0), false)
  assert.equal(shouldNotifyCompletion(state, 's2', 4), true)
  assert.equal(shouldNotifyCompletion(state, '', 5), false)
})

test('mergeSubscriptions 拒绝非数组输入且保持稳定', () => {
  const next = { ...normalizeSubscribeBody(validBody), subscribedAt: 't' }
  const merged = mergeSubscriptions(undefined, next)
  assert.equal(merged.list.length, 1)
  assert.equal(merged.changed, true)
  const unchanged = mergeSubscriptions([{ fingerprint: next.fingerprint, endpoint: next.endpoint, keys: next.keys }], { ...next })
  assert.equal(unchanged.changed, false)
})

test('truncateBody 清洗控制字符并保留省略号语义', () => {
  assert.equal(truncateBody('  a\u0000b  '), 'a b')
  assert.equal(truncateBody('ok'), 'ok')
  assert.equal(truncateBody('x'.repeat(61)).length, 60)
})

test('buildOutboxTask 附带 uuid/时间戳且 clear 任务可构造', () => {
  const task = buildOutboxTask({ title: 't', body: 'b', extra: { clear: true } })
  assert.match(task.id, /^[0-9a-f-]{36}$/)
  assert.equal(task.attempts, 0)
  assert.equal(task.clear, true)
  assert.equal(typeof task.createdAt, 'string')
  assert.equal(Number.isFinite(Date.parse(task.createdAt)), true)
})

after(() => {
  rmSync(FIXTURE_HOME, { recursive: true, force: true })
  assert.equal(existsSync(FIXTURE_HOME), false)
})

test('plugin effects obey Cordis return contract, including event fallback', async () => {
  const { apply } = await import('./index.js')
  for (const throws of [false, true]) {
    const disposers = []
    const ctx = {
      webServer: { register: () => () => {} },
      on: () => { if (throws) throw new Error('unsupported event'); return () => {} },
      effect(fn) {
        const result = fn()
        assert.ok(result == null || typeof result === 'function', 'Invalid effect')
        if (typeof result === 'function') disposers.push(result)
      },
    }
    try { apply(ctx) } finally { disposers.reverse().forEach(fn => fn()) }
  }
})
