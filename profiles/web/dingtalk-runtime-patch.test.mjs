import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DINGTALK_ROUTE_TTL_MS,
  Renderer,
} from './node_modules/@dingtalk-real-ai/dsh-dingtalk/lib/renderer.js'
import { Commands } from './node_modules/@dingtalk-real-ai/dsh-dingtalk/lib/commands.js'
import { Bridge } from './node_modules/@dingtalk-real-ai/dsh-dingtalk/lib/bridge.js'
import { scanArtifacts } from './node_modules/@dingtalk-real-ai/dsh-dingtalk/lib/commands.js'
import { ConsoleCards } from './node_modules/@dingtalk-real-ai/dsh-dingtalk/lib/console.js'
import { normalizeCardCallback } from './node_modules/@dingtalk-real-ai/dsh-dingtalk/lib/stream.js'
import { InteractionCards } from './node_modules/@dingtalk-real-ai/dsh-dingtalk/lib/interaction-card.js'
import { DwsTools } from './node_modules/@dingtalk-real-ai/dsh-dingtalk/lib/tools.js'
import { AICard, CardCapability } from './node_modules/@dingtalk-real-ai/dsh-dingtalk/lib/aicard.js'
import { Outbound } from './node_modules/@dingtalk-real-ai/dsh-dingtalk/lib/outbound.js'
import { DeliveryStore, textChecksum } from './node_modules/@dingtalk-real-ai/dsh-dingtalk/lib/delivery-store.js'

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function message(overrides = {}) {
  return {
    msgId: 'dt-message-1',
    conversationId: 'dt-conversation-1',
    conversationType: 'direct',
    senderStaffId: 'owner-staff',
    senderNick: 'Owner',
    text: '开始',
    sessionWebhook: 'https://example.invalid/webhook',
    ...overrides,
  }
}

function textEvent(turn, text) {
  return {
    turn,
    message: { content: [{ type: 'text', text }] },
  }
}

function drive(renderer, sessionId, type, data) {
  renderer.onSessionEvent({ id: sessionId }, { type, data })
}

function deps({ cardFactory } = {}) {
  const cards = []
  const markdown = []
  const texts = []
  let creates = 0
  const createCard = cardFactory
    ? async (target) => cardFactory(++creates, target, cards)
    : async (_target) => ({ finish: async (content) => cards.push(content), stream: async () => {} })
  return {
    cards,
    markdown,
    texts,
    renderer: new Renderer({
      config: {
        replyMode: { direct: 'aicard', group: 'aicard' },
        streaming: { enabled: false, throttleMs: 1, maxCardChars: 15_000 },
        asyncMode: false,
        ackText: 'ack',
        markdownTitle: 'DSH',
        emotionFirstResponse: false,
      },
      outbound: {
        sendMarkdown: async (_webhook, _title, content) => { markdown.push(content); return true },
        sendText: async (_webhook, content) => { texts.push(content); return true },
      },
      emotion: { recall: async () => {} },
      createCard,
      log: () => {},
    }),
  }
}

test('retains only the parent DingTalk route and forwards a later subagent report once', async () => {
  const { renderer, cards, markdown } = deps()
  const settled = renderer.onInbound('parent-session', message())
  drive(renderer, 'parent-session', 'turn/start', { turn: 1 })
  drive(renderer, 'parent-session', 'assistant/message', textEvent(1, '首轮回复'))
  drive(renderer, 'parent-session', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settled
  await tick()
  assert.deepEqual(cards, ['首轮回复'])

  drive(renderer, 'parent-session', 'turn/start', { turn: 2 })
  drive(renderer, 'parent-session', 'user/message', {
    source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-session' },
  })
  drive(renderer, 'parent-session', 'assistant/message', textEvent(2, '子代理已完成'))
  drive(renderer, 'parent-session', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await tick()
  assert.deepEqual(cards, ['首轮回复', '子代理已完成'])
  assert.deepEqual(markdown, [])

  // A duplicate delivery for the already completed turn cannot create a second card.
  drive(renderer, 'parent-session', 'assistant/message', textEvent(2, '重复回报'))
  drive(renderer, 'parent-session', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await tick()
  assert.deepEqual(cards, ['首轮回复', '子代理已完成'])
})

test('does not publish pure-tool follow-ups and clears the route on a manual App user message', async () => {
  const { renderer, cards, markdown } = deps()
  const settled = renderer.onInbound('parent-session', message())
  drive(renderer, 'parent-session', 'turn/start', { turn: 1 })
  drive(renderer, 'parent-session', 'assistant/message', textEvent(1, '首轮回复'))
  drive(renderer, 'parent-session', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settled
  await tick()
  const before = cards.length

  drive(renderer, 'parent-session', 'turn/start', { turn: 2 })
  drive(renderer, 'parent-session', 'user/message', {
    source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-session' },
  })
  drive(renderer, 'parent-session', 'tool/call', { turn: 2, name: 'tool-only' })
  drive(renderer, 'parent-session', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await tick()
  assert.equal(cards.length, before)
  assert.deepEqual(markdown, [])

  drive(renderer, 'parent-session', 'turn/start', { turn: 3 })
  drive(renderer, 'parent-session', 'user/message', { source: { kind: 'user' } })
  drive(renderer, 'parent-session', 'assistant/message', textEvent(3, '不能泄漏到钉钉'))
  drive(renderer, 'parent-session', 'turn/end', { turn: 3, reason: { kind: 'completed' } })
  await tick()
  assert.equal(cards.length, before)
  assert.deepEqual(markdown, [])
})

test('expires the in-memory route after two hours and falls back to Markdown when a replay card fails', async () => {
  const originalNow = Date.now
  let now = 1_000
  Date.now = () => now
  try {
    const failed = deps({
      cardFactory: (createNumber, _target, cards) => createNumber === 1
        ? { finish: async (content) => cards.push(content), stream: async () => {} }
        : { finish: async () => { throw new Error('card unavailable') } },
    })
    const first = failed.renderer.onInbound('parent-session', message())
    drive(failed.renderer, 'parent-session', 'turn/start', { turn: 1 })
    drive(failed.renderer, 'parent-session', 'assistant/message', textEvent(1, '首轮'))
    drive(failed.renderer, 'parent-session', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    await first
    await tick()
    drive(failed.renderer, 'parent-session', 'turn/start', { turn: 2 })
    drive(failed.renderer, 'parent-session', 'user/message', { source: { kind: 'subagent-settled' } })
    drive(failed.renderer, 'parent-session', 'assistant/message', textEvent(2, '卡片失败时的回报'))
    drive(failed.renderer, 'parent-session', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
    await tick()
    assert.deepEqual(failed.cards, ['首轮'])
    assert.deepEqual(failed.markdown, ['卡片失败时的回报'])

    now += DINGTALK_ROUTE_TTL_MS + 1
    drive(failed.renderer, 'parent-session', 'turn/start', { turn: 3 })
    drive(failed.renderer, 'parent-session', 'user/message', { source: { kind: 'subagent-settled' } })
    drive(failed.renderer, 'parent-session', 'assistant/message', textEvent(3, '过期后不得发送'))
    drive(failed.renderer, 'parent-session', 'turn/end', { turn: 3, reason: { kind: 'completed' } })
    await tick()
    assert.deepEqual(failed.markdown, ['卡片失败时的回报'])
  } finally {
    Date.now = originalNow
  }
})

test('DingTalk HTTP calls time out even when fetch or the response body never resolves', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = () => new Promise(() => {})
    const outbound = new Outbound({ clientId: 'client', clientSecret: 'secret' }, () => {}, { timeoutMs: 15 })
    const start = Date.now()
    assert.equal(await outbound.sendMarkdown('https://example.invalid/webhook', 'DSH', 'hello'), false)
    assert.ok(Date.now() - start < 500)

    globalThis.fetch = async (url) => url.includes('/accessToken')
      ? { ok: true, status: 200, text: async () => JSON.stringify({ accessToken: 'token', expireIn: 3600 }) }
      : { ok: false, status: 500, text: () => new Promise(() => {}) }
    const bodyStart = Date.now()
    assert.equal(await new Outbound({ clientId: 'client', clientSecret: 'secret' }, () => {}, { timeoutMs: 15 }).sendMarkdown('https://example.invalid/webhook', 'DSH', 'hello'), false)
    assert.ok(Date.now() - bodyStart < 500)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('AICard serializes stream/finalize and ignores a late non-final frame', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return { ok: true, status: 200, text: async () => '' }
    }
    const card = await AICard.create({
      token: async () => 'token',
      robotCode: 'robot',
      target: { type: 'user', userId: 'user' },
      capability: new CardCapability(),
      log: () => {},
      timeoutMs: 100,
      maxCardChars: 100,
    })
    await Promise.all([card.stream('first'), card.finish('final'), card.stream('late')])
    const frames = calls
      .filter((call) => call.url.endsWith('/card/streaming'))
      .map((call) => call.body.content)
    assert.deepEqual(frames, ['first', 'final'])
    assert.equal(calls.at(-1).body.cardData.cardParamMap.flowStatus, '3')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Renderer waits for an uncertain card timeout, persists pending, and does not send duplicate Markdown', async () => {
  const root = mkdtempSync('/tmp/dsh-delivery-pending-')
  try {
    const store = new DeliveryStore(root)
    const markdown = []
    const renderer = new Renderer({
      timeoutMs: 15,
      deliveryStore: store,
      config: {
        replyMode: { direct: 'aicard', group: 'aicard' },
        streaming: { enabled: false, throttleMs: 1, maxCardChars: 15000 },
        asyncMode: false,
        ackText: 'ack',
        markdownTitle: 'DSH',
        emotionFirstResponse: false,
      },
      outbound: {
        sendMarkdown: async (_webhook, _title, text) => { markdown.push(text); return true },
        sendText: async () => true,
      },
      emotion: { recall: async () => {} },
      createCard: async () => ({ outTrackId: 'dshdt_uncertain', finish: async () => new Promise(() => {}) }),
      log: () => {},
    })
    const settled = renderer.onInbound('session-1', message())
    drive(renderer, 'session-1', 'turn/start', { turn: 10 })
    drive(renderer, 'session-1', 'assistant/message', textEvent(10, '本机已完成'))
    drive(renderer, 'session-1', 'turn/end', { turn: 10, reason: { kind: 'completed' } })
    await settled
    assert.deepEqual(markdown, [])
    assert.deepEqual(store.list().map((entry) => [entry.outTrackId, entry.text, entry.turn]), [['dshdt_uncertain', '本机已完成', 10]])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Renderer uses Markdown only for a clear card error and recovers the same outTrackId after restart', async () => {
  const clear = deps({ cardFactory: () => ({ outTrackId: 'dshdt_clear', finish: async () => { throw Object.assign(new Error('HTTP 400'), { uncertain: false }) }, stream: async () => {} }) })
  const settled = clear.renderer.onInbound('session-1', message())
  drive(clear.renderer, 'session-1', 'turn/start', { turn: 1 })
  drive(clear.renderer, 'session-1', 'assistant/message', textEvent(1, '明确失败降级'))
  drive(clear.renderer, 'session-1', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settled
  assert.deepEqual(clear.markdown, ['明确失败降级'])

  const root = mkdtempSync('/tmp/dsh-delivery-restart-')
  try {
    const store = new DeliveryStore(root)
    store.put({ scope: 'conversation', session: 'session-1', turn: 10, outTrackId: 'dshdt_restart', text: '重启后补发', sessionWebhook: 'https://example.invalid/webhook', mode: 'aicard', updatedAt: Date.now() })
    assert.equal(statSync(root).mode & 0o777, 0o700)
    assert.equal(statSync(join(root, 'delivery-pending.json')).mode & 0o777, 0o600)
    const options = []
    const renderer = new Renderer({
      timeoutMs: 50,
      deliveryStore: store,
      config: { replyMode: { direct: 'aicard', group: 'aicard' }, streaming: { enabled: false, throttleMs: 1, maxCardChars: 15000 }, asyncMode: false, ackText: 'ack', markdownTitle: 'DSH', emotionFirstResponse: false },
      outbound: { sendMarkdown: async () => true, sendText: async () => true },
      emotion: { recall: async () => {} },
      createCard: async (_target, opts) => { options.push(opts); return { outTrackId: opts.outTrackId, finish: async () => {} } },
      log: () => {},
    })
    const recovered = await renderer.recoverPending()
    assert.deepEqual(recovered, { attempted: 1, recovered: 1 })
    assert.deepEqual(options, [{ existing: true, outTrackId: 'dshdt_restart' }])
    assert.deepEqual(store.list(), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Renderer does not silently settle when the pending journal cannot be written', async () => {
  const markdown = []
  let finished = false
  const renderer = new Renderer({
    timeoutMs: 20,
    deliveryStore: {
      put() { throw new Error('read-only journal') },
      remove() {},
    },
    config: { replyMode: { direct: 'aicard', group: 'aicard' }, streaming: { enabled: false, throttleMs: 1, maxCardChars: 15000 }, asyncMode: false, ackText: 'ack', markdownTitle: 'DSH', emotionFirstResponse: false },
    outbound: { sendMarkdown: async (_webhook, _title, text) => { markdown.push(text); return true }, sendText: async () => true },
    emotion: { recall: async () => {} },
    createCard: async () => ({ outTrackId: 'dshdt-journal-failure', finish: async () => { finished = true } }),
    log: () => {},
  })
  const settled = renderer.onInbound('session-journal-failure', message())
  drive(renderer, 'session-journal-failure', 'turn/start', { turn: 1 })
  drive(renderer, 'session-journal-failure', 'assistant/message', textEvent(1, '不应静默完成'))
  drive(renderer, 'session-journal-failure', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settled
  assert.equal(finished, false)
  assert.match(markdown.at(-1), /交付状态暂时无法确认/)
})

test('Renderer dispose settles an active card with bounded FAILED handling and long replies are split', async () => {
  const failed = []
  const renderer = new Renderer({
    timeoutMs: 50,
    config: { replyMode: { direct: 'aicard', group: 'aicard' }, streaming: { enabled: false, throttleMs: 1, maxCardChars: 5 }, asyncMode: false, ackText: 'ack', markdownTitle: 'DSH', emotionFirstResponse: false },
    outbound: { sendMarkdown: async () => true, sendText: async () => true },
    emotion: { recall: async () => {} },
    createCard: async (_target) => ({ outTrackId: `card-${failed.length}`, finish: async (text) => { failed.push(text) }, fail: async (text) => { failed.push(`FAILED:${text}`) } }),
    log: () => {},
  })
  const settled = renderer.onInbound('session-dispose', message())
  await renderer.dispose()
  await settled
  assert.ok(failed.some((text) => text.startsWith('FAILED:')))

  const chunks = []
  const long = new Renderer({
    config: { replyMode: { direct: 'aicard', group: 'aicard' }, streaming: { enabled: false, throttleMs: 1, maxCardChars: 5 }, asyncMode: false, ackText: 'ack', markdownTitle: 'DSH', emotionFirstResponse: false },
    outbound: { sendMarkdown: async () => true, sendText: async () => true },
    emotion: { recall: async () => {} },
    createCard: async () => ({ outTrackId: `card-${chunks.length}`, finish: async (text) => { chunks.push(text) } }),
    log: () => {},
  })
  const longSettled = long.onInbound('session-long', message())
  drive(long, 'session-long', 'turn/start', { turn: 1 })
  drive(long, 'session-long', 'assistant/message', textEvent(1, 'abcdefghijk'))
  drive(long, 'session-long', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await longSettled
  assert.ok(chunks.length >= 3)
  assert.ok(chunks.every((chunk) => chunk.length <= 5))
  assert.equal(chunks.join(''), 'abcdefghijk')
})

class MapStore {
  constructor(entries = []) { this.map = new Map(entries) }
  get(key) { return this.map.get(key) }
  set(key, value) { this.map.set(key, value) }
  delete(key) { this.map.delete(key) }
}

function commandMessage(text, senderStaffId = 'owner-staff', conversationType = 'direct') {
  return {
    msgId: `msg-${Math.random()}`,
    conversationId: 'dt-conversation-1',
    conversationType,
    senderStaffId,
    senderNick: senderStaffId,
    text,
    sessionWebhook: 'https://example.invalid/webhook',
  }
}

function commandFixture() {
  const replies = []
  const bindings = new MapStore()
  const modelOverrides = new MapStore()
  const presetOverrides = new MapStore()
  const sessionHeaders = [
    { id: 'root-a', cwd: '/workspace', createdAt: 300, agentPreset: 'CyberMarcus' },
    { id: 'root-b', cwd: '/other', createdAt: 500, agentPreset: 'Avengers' },
    { id: 'child-a', cwd: '/workspace', createdAt: 600, origin: 'subagent', parentSession: 'root-a' },
    { id: 'blank-a', cwd: '/workspace', createdAt: 700 },
  ]
  const titleById = new Map([
    ['root-a', 'CyberMarcus 主会话'],
    ['root-b', 'Avengers 主会话'],
    ['child-a', '子代理不应出现'],
    ['blank-a', '   '],
  ])
  const sessionQuery = {
    async listSessions() {
      return sessionHeaders.map((header) => ({ header, live: true, persisted: true }))
    },
    async readTitleSnapshots(ids) {
      return ids.map((id) => {
        const key = String(id)
        const header = sessionHeaders.find((item) => item.id === key)
        return header && titleById.has(key)
          ? { sessionId: key, status: 'fulfilled', value: { session: header, title: { title: titleById.get(key) } } }
          : { sessionId: key, status: 'rejected', reason: new Error('missing') }
      })
    },
  }
  const llm = {
    listProviders: () => [{ id: 'provider-a', name: 'Provider A' }],
    async listModels() { return [{ provider: 'provider-a', id: 'model-a', name: 'Model A' }] },
    async resolveModelInfo(provider, model) {
      if (provider !== 'provider-a' || model !== 'model-a') throw new Error('unknown route')
      return { provider, id: model, name: 'Model A', reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }] } }
    },
    async resolveCallConfig(config) { return config },
  }
  const presetRows = [
    { id: 'reliable-development', name: 'CyberMarcus', description: '可靠工作模式' },
    { id: 'avengers', name: 'Avengers', description: '直接委派模式' },
    { id: 'broken-preset', name: '损坏模式', broken: 'invalid' },
  ]
  const agentPresets = {
    async list() { return presetRows },
    async resolve(id) {
      const row = presetRows.find((item) => item.id === id)
      if (!row) throw new Error('unknown preset')
      return row
    },
  }
  const deps = {
    agents: { get: () => undefined },
    outbound: { sendMarkdown: async (_webhook, _title, content) => { replies.push(content); return true } },
    bindings,
    modelOverrides,
    presetOverrides,
    queue: { depth: () => 0, clear: () => {} },
    sessionQuery,
    llm,
    agentPresets,
    defaultPresetId: 'reliable-development',
    isOwner: (msg) => msg.conversationType === 'direct' && msg.senderStaffId === 'owner-staff',
    defaultModel: () => ({ provider: 'provider-a', model: 'model-a' }),
    connectorStatus: () => [],
    markdownTitle: 'DSH',
    log: () => {},
    workspaceOverrides: new MapStore(),
    defaultWorkspace: '/workspace',
  }
  return { commands: new Commands(deps), deps, replies, bindings, modelOverrides, presetOverrides, sessionQuery, sessionHeaders, titleById, agentPresets }
}

test('session roster resolves titles only for the ten pre-ranked canonical candidates', async () => {
  const fixture = commandFixture()
  for (let index = 0; index < 30; index += 1) {
    const id = `extra-${String(index).padStart(2, '0')}`
    fixture.sessionHeaders.push({ id, cwd: '/workspace', createdAt: 1_000 + index, agentPreset: 'CyberMarcus' })
    fixture.titleById.set(id, `额外会话 ${index}`)
  }
  const originalRead = fixture.sessionQuery.readTitleSnapshots.bind(fixture.sessionQuery)
  const batches = []
  fixture.sessionQuery.readTitleSnapshots = async (ids) => {
    batches.push(ids.map(String))
    return originalRead(ids)
  }
  const rows = await fixture.commands.sessionRowsFor('dt-conversation-1')
  assert.equal(rows.length, 10)
  assert.deepEqual(batches.map((ids) => ids.length), [10])
  assert.equal(rows[0].id, 'extra-29')
  assert.equal(rows.at(-1).id, 'extra-20')
})

test('management commands are owner-only and use the canonical session/model services', async () => {
  const fixture = commandFixture()
  const { commands, replies, bindings, modelOverrides, presetOverrides } = fixture

  await commands.handle(commandMessage('/sessions', 'not-owner'))
  assert.equal(replies.at(-1), '当前入口仅管理员可用。')
  assert.equal(replies.some((reply) => reply.includes('CyberMarcus 主会话')), false)
  await commands.handle(commandMessage('/artifacts', 'not-owner'))
  assert.equal(replies.at(-1), '当前入口仅管理员可用。')

  await commands.handle(commandMessage('/sessions'))
  const sessionsReply = replies.at(-1)
  assert.ok(sessionsReply.includes('CyberMarcus 主会话'))
  assert.ok(sessionsReply.includes('Avengers 主会话'))
  assert.equal(sessionsReply.includes('子代理不应出现'), false)
  assert.equal(sessionsReply.includes('blank-a'), false)
  assert.ok(sessionsReply.indexOf('CyberMarcus 主会话') < sessionsReply.indexOf('Avengers 主会话'))

  await commands.handle(commandMessage('/session use root'))
  assert.equal(bindings.get('dt-conversation-1'), undefined)
  assert.match(replies.at(-1), /匹配多个会话/)
  await commands.handle(commandMessage('/session use root-a'))
  assert.equal(bindings.get('dt-conversation-1'), 'root-a')

  await commands.handle(commandMessage('/models'))
  assert.match(replies.at(-1), /provider-a\/model-a/)
  assert.match(replies.at(-1), /low.*medium/)

  modelOverrides.set('dt-conversation-1', { provider: 'provider-a', model: 'model-a', reasoningEffort: 'low' })
  await commands.handle(commandMessage('/model use provider-a/model-a medium'))
  assert.deepEqual(modelOverrides.get('dt-conversation-1'), { provider: 'provider-a', model: 'model-a', reasoningEffort: 'medium' })
  assert.equal(bindings.get('dt-conversation-1'), undefined)

  modelOverrides.set('dt-conversation-1', { provider: 'provider-a', model: 'model-a', reasoningEffort: 'medium' })
  await commands.handle(commandMessage('/effort invalid'))
  assert.deepEqual(modelOverrides.get('dt-conversation-1'), { provider: 'provider-a', model: 'model-a', reasoningEffort: 'medium' })
  await commands.handle(commandMessage('/effort low'))
  assert.deepEqual(modelOverrides.get('dt-conversation-1'), { provider: 'provider-a', model: 'model-a', reasoningEffort: 'low' })
  assert.equal(bindings.get('dt-conversation-1'), undefined)

  await commands.handle(commandMessage('/help'))
  assert.match(replies.at(-1), /\/menu/)
  assert.match(replies.at(-1), /\/session use/)
  await commands.handle(commandMessage('/menu', 'not-owner'))
  assert.match(replies.at(-1), /不伪造按钮/)

  bindings.set('dt-conversation-1', 'root-a')
  await commands.handle(commandMessage('/new'))
  assert.equal(bindings.get('dt-conversation-1'), undefined)
  assert.equal(presetOverrides.get('dt-conversation-1'), 'reliable-development')
  assert.match(replies.at(-1), /CyberMarcus/)
})

test('/replies and /resend are owner-only, use completed canonical turns, and reject snapshot drift', async () => {
  const fixture = commandFixture()
  fixture.bindings.set('dt-conversation-1', 'root-a')
  let events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: textEvent(1, '第一次已完成') },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', data: { turn: 10 } },
    { type: 'assistant/message', data: textEvent(10, '昨晚的完整答复') },
    { type: 'turn/end', data: { turn: 10, reason: { kind: 'completed' } } },
    { type: 'turn/start', data: { turn: 11 } },
    { type: 'assistant/message', data: textEvent(11, '错误结果不应出现') },
    { type: 'turn/end', data: { turn: 11, reason: { kind: 'error' } } },
  ]
  fixture.sessionQuery.readSession = async (id) => ({ session: { id, origin: 'main' }, events })
  const sent = []
  fixture.deps.outbound.sendMarkdown = async (_webhook, _title, text) => { sent.push(text); fixture.replies.push(text); return true }

  await fixture.commands.handle(commandMessage('/replies'))
  assert.match(fixture.replies.at(-1), /turn 10/)
  assert.match(fixture.replies.at(-1), /turn 1/)
  assert.equal(fixture.replies.at(-1).includes('https://example.invalid'), false)
  assert.equal(fixture.replies.at(-1).includes('错误结果不应出现'), false)

  await fixture.commands.handle(commandMessage('/resend 1'))
  assert.ok(sent.includes('昨晚的完整答复'))
  await fixture.commands.handle(commandMessage('/resend turn:10'))
  assert.equal(sent.filter((text) => text === '昨晚的完整答复').length, 2)

  events = events.map((event) => event.data?.turn === 10 && event.type === 'assistant/message'
    ? { ...event, data: textEvent(10, '内容已漂移') }
    : event)
  const before = sent.filter((text) => text === '昨晚的完整答复').length
  await fixture.commands.handle(commandMessage('/resend 1'))
  assert.equal(sent.filter((text) => text === '昨晚的完整答复').length, before)
  assert.match(fixture.replies.at(-1), /清单已变化/)

  await fixture.commands.handle(commandMessage('/replies', 'not-owner'))
  assert.equal(fixture.replies.at(-1), '当前入口仅管理员可用。')
})

test('resuming a bound session composes the preset recorded by that session header', async () => {
  let composedPreset
  let resumeOptions
  const bindings = new MapStore([['dt-conversation-1', 'root-a']])
  const modelOverrides = new MapStore()
  const resumedAgent = {
    id: 'root-a',
    status: 'idle',
    ctx: { tools: { register: () => () => {} }, on: () => () => {} },
    followup: () => {},
  }
  const agents = {
    get: () => undefined,
    async resume(options) { resumeOptions = options; return { agent: resumedAgent } },
  }
  const renderer = { onInbound: async () => {} }
  const bridge = new Bridge(agents, renderer, bindings, {
    cwd: '/workspace',
    log: () => {},
    modelOverrides,
    workspaceOverrides: new MapStore(),
    presetOverrides: new MapStore([['dt-conversation-1', 'avengers']]),
    defaultPresetId: 'reliable-development',
    sessionQuery: {
      async readTitleSnapshots() {
        return [{ status: 'fulfilled', value: { session: { id: 'root-a', agentPreset: 'CyberMarcus' } } }]
      },
    },
    modelSelection: () => ({ provider: 'provider-a', model: 'model-a' }),
    compose: async (preset) => {
      composedPreset = preset
      return { agentPreset: preset, setup: async () => {} }
    },
    onAgentMessage: () => {},
  })
  await bridge.process(commandMessage('继续任务'), 'dt-conversation-1')
  assert.equal(composedPreset, 'CyberMarcus')
  assert.equal(resumeOptions.resumeSessionId, 'root-a')
  assert.equal(resumeOptions.agentOptions.provider, 'provider-a')
})

test('fresh DingTalk sessions use CyberMarcus by default and a validated conversation override when present', async () => {
  const created = []
  const agents = {
    get: () => undefined,
    async create(options) {
      created.push(options)
      return { agent: { id: options.sessionId, status: 'idle' } }
    },
  }
  const presetOverrides = new MapStore([['dt-conversation-avengers', 'avengers']])
  const bridge = new Bridge(agents, {}, new MapStore(), {
    cwd: '/workspace',
    log: () => {},
    modelOverrides: new MapStore(),
    workspaceOverrides: new MapStore(),
    presetOverrides,
    defaultPresetId: 'reliable-development',
    modelSelection: () => ({ provider: 'provider-a', model: 'model-a' }),
    compose: async (preset) => ({ agentPreset: preset, setup: async () => {} }),
    onAgentMessage: () => {},
  })
  await bridge.agentFor('dt-conversation-default')
  await bridge.agentFor('dt-conversation-avengers')
  assert.equal(created[0].meta.agentPreset, 'reliable-development')
  assert.equal(created[1].meta.agentPreset, 'avengers')
})

test('artifacts require a known bound non-subagent session and never scan an unknown route', async () => {
  const fixture = commandFixture()
  const { commands, replies, bindings } = fixture
  await commands.handle(commandMessage('/artifacts'))
  assert.match(replies.at(-1), /尚未绑定可读取产物/)

  bindings.set('dt-conversation-1', 'missing-session')
  await commands.handle(commandMessage('/artifacts'))
  assert.match(replies.at(-1), /未知、未绑定或子代理会话不会扫描/)

  bindings.set('dt-conversation-1', 'child-a')
  await commands.handle(commandMessage('/artifacts'))
  assert.match(replies.at(-1), /未知、未绑定或子代理会话不会扫描/)
})

test('artifact scan is bounded, recent-only, relative, and rejects symlink or sensitive paths', () => {
  const root = mkdtempSync('/tmp/dsh-artifacts-')
  const external = mkdtempSync('/tmp/dsh-artifacts-external-')
  const now = Date.now()
  try {
    const output = join(root, 'output')
    mkdirSync(join(output, 'nested'), { recursive: true })
    mkdirSync(join(external, 'nested-external'), { recursive: true })
    mkdirSync(join(output, '.git'), { recursive: true })
    mkdirSync(join(output, 'node_modules'), { recursive: true })
    writeFileSync(join(external, 'outside.txt'), 'must not be followed')
    writeFileSync(join(external, 'nested-external', 'outside.txt'), 'must not be followed')
    symlinkSync(join(external, 'outside.txt'), join(output, 'symlink.txt'))
    symlinkSync(join(external, 'nested-external'), join(output, 'nested-link'))
    writeFileSync(join(output, 'credentials.json'), 'must not appear')
    writeFileSync(join(output, 'session-log.md'), 'must not appear')
    writeFileSync(join(output, '.hidden.md'), 'must not appear')
    writeFileSync(join(output, '.git', 'history.txt'), 'must not appear')
    writeFileSync(join(output, 'node_modules', 'dep.js'), 'must not appear')
    writeFileSync(join(output, 'old.txt'), 'must not appear')
    utimesSync(join(output, 'old.txt'), new Date(now - 120_000), new Date(now - 120_000))
    for (let index = 0; index < 12; index += 1) writeFileSync(join(output, `report-${String(index).padStart(2, '0')}.md`), `report-${index}`)

    const rows = scanArtifacts({ cwd: root, createdAt: now - 1_000, now })
    assert.equal(rows.length, 10)
    assert.ok(rows.every((row) => row.relativeName.startsWith('output/')))
    assert.ok(rows.every((row) => !row.relativeName.startsWith('/')))
    assert.ok(rows.every((row) => !row.relativeName.includes('credentials')))
    assert.ok(rows.every((row) => !row.relativeName.includes('session')))
    assert.equal(rows.some((row) => row.relativeName.includes('symlink')), false)
    assert.equal(rows.some((row) => row.relativeName.includes('nested-link')), false)
    assert.equal(rows.some((row) => row.relativeName.includes('old.txt')), false)
    assert.ok(rows.every((row) => row.type === 'MD'))
    assert.ok(rows.every((row) => row.size.endsWith(' B')))
    assert.ok(rows.every((row) => row.time.endsWith('Z')))

    const noOutput = mkdtempSync('/tmp/dsh-artifacts-no-output-')
    try {
      writeFileSync(join(noOutput, 'fallback.json'), '{}')
      const fallback = scanArtifacts({ cwd: noOutput, createdAt: now - 1_000, now })
      assert.deepEqual(fallback.map((row) => row.relativeName), ['fallback.json'])
    } finally {
      rmSync(noOutput, { recursive: true, force: true })
    }

    const symlinkOutput = mkdtempSync('/tmp/dsh-artifacts-output-link-')
    try {
      symlinkSync(external, join(symlinkOutput, 'output'))
      assert.deepEqual(scanArtifacts({ cwd: symlinkOutput, createdAt: now - 1_000, now }), [])
    } finally {
      rmSync(symlinkOutput, { recursive: true, force: true })
    }
  } finally {
    assert.equal(existsSync(root), true)
    rmSync(root, { recursive: true, force: true })
    rmSync(external, { recursive: true, force: true })
  }
})

test('/send is owner-only, rescans the bound canonical session, and sends only a numbered artifact', async () => {
  const root = mkdtempSync('/tmp/dsh-artifact-send-')
  const now = Date.now()
  try {
    const output = join(root, 'output')
    mkdirSync(output, { recursive: true })
    const first = join(output, 'first.pdf')
    const second = join(output, 'second.png')
    writeFileSync(first, 'first')
    utimesSync(first, new Date(now - 500), new Date(now - 500))
    writeFileSync(second, 'second')
    utimesSync(second, new Date(now), new Date(now))

    const fixture = commandFixture()
    fixture.sessionHeaders[0].cwd = root
    fixture.sessionHeaders[0].createdAt = now - 1_000
    fixture.bindings.set('dt-conversation-1', 'root-a')
    const sends = []
    fixture.deps.dws = {
      async sendFile(request) {
        sends.push(request)
        return { ok: true }
      },
    }

    await fixture.commands.handle(commandMessage('/artifacts'))
    assert.match(fixture.replies.at(-1), /1\. `output\/second\.png`/)
    assert.match(fixture.replies.at(-1), /`\/send 1`/)

    // A new file inserted after the list is shown must not shift the old
    // `/send 1` selection onto that new file.
    const inserted = join(output, 'inserted-later.zip')
    writeFileSync(inserted, 'inserted')
    utimesSync(inserted, new Date(now + 1_000), new Date(now + 1_000))

    await fixture.commands.handle(commandMessage('/send 1'))
    assert.equal(sends.length, 1)
    assert.equal(sends[0].conversationType, 'direct')
    assert.equal(sends[0].senderStaffId, 'owner-staff')
    assert.equal(sends[0].filePath, second)
    assert.match(fixture.replies.at(-1), /已发送到当前钉钉对话/)

    await fixture.commands.handle(commandMessage('/send /tmp/secret.pdf'))
    assert.equal(sends.length, 1)
    await fixture.commands.handle(commandMessage('/send 1', 'not-owner'))
    assert.equal(sends.length, 1)
    assert.match(fixture.replies.at(-1), /仅管理员可用/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('DwsTools sends direct and group files with account-local env credentials only', async () => {
  const calls = []
  const logs = []
  const tool = new DwsTools({
    workspace: '/workspace',
    clientId: 'primary-client',
    clientSecret: 'primary-secret',
    runner: async (cmd, args, options) => {
      calls.push({ cmd, args: [...args], options })
      return { code: 0, stdout: '{"success":true}', stderr: '' }
    },
    log: (line) => logs.push(line),
  })
  const direct = await tool.sendFile({
    conversationType: 'direct',
    senderStaffId: 'direct-user',
    filePath: '/workspace/output/direct.pdf',
    clientId: 'direct-client',
    clientSecret: 'direct-secret',
  })
  const group = await tool.sendFile({
    conversationType: 'group',
    conversationId: 'group-conversation',
    filePath: '/workspace/output/group.png',
    clientId: 'group-client',
    clientSecret: 'group-secret',
  })
  assert.deepEqual(direct, { ok: true })
  assert.deepEqual(group, { ok: true })
  assert.deepEqual(calls.map((call) => call.args), [
    [
      'chat', 'message', 'send-by-bot', '--robot-code', 'direct-client',
      '--msg-type', 'file', '--file-path', '/workspace/output/direct.pdf',
      '--users', 'direct-user', '--format', 'json',
    ],
    [
      'chat', 'message', 'send-by-bot', '--robot-code', 'group-client',
      '--msg-type', 'file', '--file-path', '/workspace/output/group.png',
      '--conversation-id', 'group-conversation', '--format', 'json',
    ],
  ])
  assert.equal(calls[0].options.env.DWS_CLIENT_ID, 'direct-client')
  assert.equal(calls[0].options.env.DWS_CLIENT_SECRET, 'direct-secret')
  assert.equal(calls[1].options.env.DWS_CLIENT_ID, 'group-client')
  assert.equal(calls[1].options.env.DWS_CLIENT_SECRET, 'group-secret')
  assert.equal(calls.some((call) => call.args.includes('direct-secret') || call.args.includes('group-secret')), false)
  assert.equal(logs.some((line) => line.includes('direct-secret') || line.includes('group-secret')), false)
})

test('DwsTools treats nonzero, timeout, and failed JSON as send failures', async () => {
  const responses = [
    { code: 1, stdout: '{"success":true}', stderr: 'rejected' },
    { code: null, timedOut: true, stdout: '', stderr: '' },
    { code: 0, stdout: '{"success":false,"error":"denied"}', stderr: '' },
  ]
  const tool = new DwsTools({
    workspace: '/workspace',
    clientId: 'client',
    clientSecret: 'secret',
    runner: async () => responses.shift(),
    log: () => {},
  })
  const request = { conversationType: 'direct', senderStaffId: 'owner', filePath: '/workspace/output/file.pdf' }
  const nonzero = await tool.sendFile(request)
  const timeout = await tool.sendFile(request)
  const failedJson = await tool.sendFile(request)
  assert.equal(nonzero.ok, false)
  assert.match(nonzero.reason, /发送失败/)
  assert.equal(timeout.ok, false)
  assert.match(timeout.reason, /超时/)
  assert.equal(failedJson.ok, false)
  assert.match(failedJson.reason, /未确认/)
})

test('dws auth status is advisory while bot attachment capability remains available', async () => {
  const tool = new DwsTools({
    workspace: '/workspace',
    runner: async (_cmd, args) => args[0] === '--version'
      ? { code: 0, stdout: 'dws version v1.0.60\n' }
      : { code: 0, stdout: '{"success":true,"authenticated":false,"message":"未登录"}' },
    log: () => {},
  })
  const status = await tool.enable()
  assert.equal(status.dwsFound, true)
  assert.equal(status.botFileAvailable, true)
  assert.equal(status.authed, false)
  assert.match(tool.statusLine(), /机器人附件可用/)
  assert.match(tool.statusLine(), /个人身份：未登录/)
})

test('interactive console seeds the real dynamic form and updates one card idempotently', async () => {
  const fixture = commandFixture()
  const calls = { sessionRowsFor: 0, modelRowsFor: 0, artifactRowsFor: 0, resolveModelInfo: 0 }
  for (const name of ['sessionRowsFor', 'modelRowsFor', 'artifactRowsFor']) {
    const original = fixture.commands[name].bind(fixture.commands)
    fixture.commands[name] = async (...args) => {
      calls[name] += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return original(...args)
    }
  }
  const originalResolveModelInfo = fixture.deps.llm.resolveModelInfo
  fixture.deps.llm.resolveModelInfo = async (...args) => {
    calls.resolveModelInfo += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    return originalResolveModelInfo(...args)
  }
  const requests = []
  const consoleCards = new ConsoleCards({
    interactionCards: {
      async create(request) { requests.push(request); return true },
    },
    commands: fixture.commands,
    outbound: fixture.deps.outbound,
    markdownTitle: 'DSH',
    isOwner: fixture.deps.isOwner,
    isOwnerId: (userId) => userId === 'owner-staff',
    log: () => {},
  })
  const ownerMessage = commandMessage('/menu')
  const openStartedAt = performance.now()
  assert.equal(await consoleCards.open(ownerMessage, 'dt-conversation-1'), true)
  assert.ok(performance.now() - openStartedAt < 1_000)
  assert.deepEqual(calls, { sessionRowsFor: 0, modelRowsFor: 0, artifactRowsFor: 0, resolveModelInfo: 0 })
  assert.equal(requests.length, 1)
  const first = requests[0]
  assert.equal(first.kind, 'console')
  assert.equal('privateData' in first, false)
  assert.match(first.outTrackId, /^dshc1_[0-9a-f]{16}_[0-9a-f]{24}$/)
  assert.deepEqual(Object.keys(first.cardData).sort(), ['button_text', 'err_msg', 'form_fields', 'form_status', 'title'])
  assert.equal(first.cardData.title, '大神控制台')
  assert.equal(first.cardData.button_text, '应用设置 / 执行动作')
  const fields = JSON.parse(first.cardData.form_fields)
  assert.deepEqual(fields.map((field) => field.name), ['status', 'view'])
  assert.deepEqual(new Set(fields.map((field) => field.type)), new Set(['TEXT', 'SELECT']))
  assert.equal(fields.some((field) => field.type.startsWith('CHECKBOX')), false)
  const slots = fields.filter((field) => field.type === 'SELECT').flatMap((field) => field.options.map((option) => option.value))
  assert.ok(slots.every((value) => /^v1:v\d+$/.test(value)))

  const select = await consoleCards.handleCardCallback({
    outTrackId: first.outTrackId,
    userId: 'owner-staff',
    actionIds: [],
    params: { version: '1', name: 'view', type: 'SELECT', view: { index: 1, value: fields.find((field) => field.name === 'view').options[1].value } },
  })
  assert.equal(select.handled, true)
  assert.equal(select.response.outTrackId, first.outTrackId)
  assert.equal(select.response.version, '2')
  assert.equal(select.response.cardData.cardParamMap.title, '大神控制台')
  assert.equal(select.response.cardUpdateOptions.updatePrivateDataByKey, true)
  assert.equal(Object.keys(select.response.userPrivateData.cardParamMap).sort().join(','), 'button_text,err_msg,form_fields,form_status')
  assert.equal(calls.sessionRowsFor, 1)
  assert.deepEqual(calls, { sessionRowsFor: 1, modelRowsFor: 0, artifactRowsFor: 0, resolveModelInfo: 0 })

  const currentFields = JSON.parse(select.response.userPrivateData.cardParamMap.form_fields)
  assert.deepEqual(currentFields.map((field) => field.name), ['status', 'view', 'sessionSlot'])
  const sessionField = currentFields.find((field) => field.name === 'sessionSlot')
  const sessionSelectStartedAt = performance.now()
  const sessionSelected = await consoleCards.handleCardCallback({
    outTrackId: first.outTrackId,
    userId: 'owner-staff',
    actionIds: [],
    params: { version: '2', name: 'sessionSlot', type: 'SELECT', sessionSlot: { index: 0, value: sessionField.options[0].value } },
  })
  assert.ok(performance.now() - sessionSelectStartedAt < 200)
  assert.equal(sessionSelected.response.version, '3')
  assert.deepEqual(calls, { sessionRowsFor: 1, modelRowsFor: 0, artifactRowsFor: 0, resolveModelInfo: 0 })
  const selectedFields = JSON.parse(sessionSelected.response.userPrivateData.cardParamMap.form_fields)
  assert.equal(selectedFields.find((field) => field.name === 'sessionSlot').default_number, 0)
  const submitFields = selectedFields
  const submit = {
    outTrackId: first.outTrackId,
    userId: 'owner-staff',
    actionIds: ['node_submit_button'],
    params: { version: '3', submit_form_fields: submitFields },
  }
  const applied = await consoleCards.handleCardCallback(submit)
  assert.equal(applied.handled, true)
  assert.equal(applied.response.outTrackId, first.outTrackId)
  assert.equal(applied.response.version, '4')
  assert.equal(applied.response.userPrivateData.cardParamMap.form_status, 'normal')
  assert.equal(applied.response.userPrivateData.cardParamMap.button_text, '✓ 设置已应用')
  assert.equal(JSON.parse(applied.response.userPrivateData.cardParamMap.form_fields).some((field) => field.name === 'notice'), false)
  assert.deepEqual(await consoleCards.handleCardCallback(submit), applied)

  const appliedFields = JSON.parse(applied.response.userPrivateData.cardParamMap.form_fields)
  const appliedView = appliedFields.find((field) => field.name === 'view')
  const resumed = await consoleCards.handleCardCallback({
    outTrackId: first.outTrackId,
    userId: 'owner-staff',
    actionIds: [],
    params: { version: '4', name: 'view', type: 'SELECT', view: { index: 2, value: appliedView.options[2].value } },
  })
  assert.equal(resumed.response.version, '5')
  assert.equal(resumed.response.userPrivateData.cardParamMap.button_text, '应用设置 / 执行动作')
  assert.equal(JSON.parse(resumed.response.userPrivateData.cardParamMap.form_fields).some((field) => field.name === 'notice'), false)

  const stale = await consoleCards.handleCardCallback({
    outTrackId: first.outTrackId,
    userId: 'owner-staff',
    actionIds: [],
    params: { version: '1', name: 'view', type: 'SELECT', view: { index: 2 } },
  })
  assert.equal(stale.response.version, '5')
  const wrongUser = await consoleCards.handleCardCallback({
    outTrackId: first.outTrackId,
    userId: 'not-owner',
    actionIds: [],
    params: { name: 'view', type: 'SELECT', view: { index: 2 } },
  })
  assert.deepEqual(wrongUser.response, {})
  const tampered = await consoleCards.handleCardCallback({
    outTrackId: `${first.outTrackId.slice(0, -24)}${'0'.repeat(24)}`,
    userId: 'owner-staff',
    actionIds: [],
    params: { name: 'view', type: 'SELECT', view: { index: 2 } },
  })
  assert.equal(tampered.handled, false)
  assert.equal(await consoleCards.open(commandMessage('/menu', 'not-owner'), 'dt-conversation-1'), false)
  assert.equal(requests.length, 1)
})

test('model and reasoning selections are submitted as one revalidated route', async () => {
  const fixture = commandFixture()
  const requests = []
  const consoleCards = new ConsoleCards({
    interactionCards: { async create(request) { requests.push(request); return true } },
    commands: fixture.commands,
    outbound: fixture.deps.outbound,
    markdownTitle: 'DSH',
    isOwner: fixture.deps.isOwner,
    isOwnerId: (userId) => userId === 'owner-staff',
    log: () => {},
  })
  assert.equal(await consoleCards.open(commandMessage('/menu'), 'dt-conversation-1'), true)
  const first = requests[0]
  const homeFields = JSON.parse(first.cardData.form_fields)
  const homeView = homeFields.find((field) => field.name === 'view')
  const modelsView = await consoleCards.handleCardCallback({
    outTrackId: first.outTrackId,
    userId: 'owner-staff',
    actionIds: [],
    params: { version: '1', name: 'view', type: 'SELECT', view: { index: 2, value: homeView.options[2].value } },
  })
  const modelFields = JSON.parse(modelsView.response.userPrivateData.cardParamMap.form_fields)
  const modelField = modelFields.find((field) => field.name === 'modelSlot')
  const selectedModel = await consoleCards.handleCardCallback({
    outTrackId: first.outTrackId,
    userId: 'owner-staff',
    actionIds: [],
    params: { version: '2', name: 'modelSlot', type: 'SELECT', modelSlot: { index: 0, value: modelField.options[0].value } },
  })
  const selectedModelFields = JSON.parse(selectedModel.response.userPrivateData.cardParamMap.form_fields)
  const selectedModelView = selectedModelFields.find((field) => field.name === 'view')
  const effortView = await consoleCards.handleCardCallback({
    outTrackId: first.outTrackId,
    userId: 'owner-staff',
    actionIds: [],
    params: { version: '3', name: 'view', type: 'SELECT', view: { index: 3, value: selectedModelView.options[3].value } },
  })
  const effortFields = JSON.parse(effortView.response.userPrivateData.cardParamMap.form_fields)
  assert.deepEqual(effortFields.map((field) => field.name), ['status', 'view', 'modelSlot', 'effortSlot'])
  assert.equal(effortFields.find((field) => field.name === 'modelSlot').default_number, 0)
  const effortField = effortFields.find((field) => field.name === 'effortSlot')
  const selectedEffort = await consoleCards.handleCardCallback({
    outTrackId: first.outTrackId,
    userId: 'owner-staff',
    actionIds: [],
    params: { version: '4', name: 'effortSlot', type: 'SELECT', effortSlot: { index: 1, value: effortField.options[1].value } },
  })
  const submitFields = JSON.parse(selectedEffort.response.userPrivateData.cardParamMap.form_fields)
  const applied = await consoleCards.handleCardCallback({
    outTrackId: first.outTrackId,
    userId: 'owner-staff',
    actionIds: ['node_submit_button'],
    params: { version: '5', submit_form_fields: submitFields },
  })
  assert.equal(applied.response.version, '6')
  assert.deepEqual(fixture.modelOverrides.get('dt-conversation-1'), { provider: 'provider-a', model: 'model-a', reasoningEffort: 'medium' })
})

test('task view is reachable and keeps artifact navigation separate', async () => {
  const fixture = commandFixture()
  assert.equal((await fixture.commands.prepareNewSession('invalid-scope', 'broken-preset')).ok, false)
  assert.equal(fixture.presetOverrides.get('invalid-scope'), undefined)
  fixture.bindings.set('dt-conversation-1', 'root-a')
  const requests = []
  const consoleCards = new ConsoleCards({
    interactionCards: { async create(request) { requests.push(request); return true } },
    commands: fixture.commands,
    outbound: fixture.deps.outbound,
    markdownTitle: 'DSH',
    isOwner: fixture.deps.isOwner,
    isOwnerId: (userId) => userId === 'owner-staff',
    log: () => {},
  })
  await consoleCards.open(commandMessage('/menu'), 'dt-conversation-1')
  const first = requests[0]
  const homeFields = JSON.parse(first.cardData.form_fields)
  const view = homeFields.find((field) => field.name === 'view')
  assert.equal(view.options[5].text.zh_CN, '任务')
  const taskView = await consoleCards.handleCardCallback({
    outTrackId: first.outTrackId,
    userId: 'owner-staff',
    actionIds: [],
    params: { version: '1', name: 'view', type: 'SELECT', view: { index: 5, value: view.options[5].value } },
  })
  const taskFields = JSON.parse(taskView.response.userPrivateData.cardParamMap.form_fields)
  assert.deepEqual(taskFields.map((field) => field.name), ['status', 'view', 'presetSlot', 'taskAction'])
  const presetSlot = taskFields.find((field) => field.name === 'presetSlot')
  assert.equal(presetSlot.default_number, 0)
  assert.deepEqual(presetSlot.options.map((option) => option.text.zh_CN), ['CyberMarcus', 'Avengers'])
  const taskAction = taskFields.find((field) => field.name === 'taskAction')
  assert.deepEqual(taskAction.options.map((option) => option.text.zh_CN), ['不执行动作', '停止当前任务', '新会话'])
  const applied = await consoleCards.handleCardCallback({
    outTrackId: first.outTrackId,
    userId: 'owner-staff',
    actionIds: ['node_submit_button'],
    params: { version: '2', submit_form_fields: taskFields },
  })
  assert.equal(applied.response.userPrivateData.cardParamMap.button_text, '✓ 设置已应用')
  assert.equal(fixture.bindings.get('dt-conversation-1'), 'root-a')

  const appliedFields = JSON.parse(applied.response.userPrivateData.cardParamMap.form_fields)
  const appliedTask = appliedFields.find((field) => field.name === 'taskAction')
  const selectedNew = await consoleCards.handleCardCallback({
    outTrackId: first.outTrackId,
    userId: 'owner-staff',
    actionIds: [],
    params: { version: '3', name: 'taskAction', type: 'SELECT', taskAction: { index: 2, value: appliedTask.options[2].value } },
  })
  const newFields = JSON.parse(selectedNew.response.userPrivateData.cardParamMap.form_fields)
  const prepared = await consoleCards.handleCardCallback({
    outTrackId: first.outTrackId,
    userId: 'owner-staff',
    actionIds: ['node_submit_button'],
    params: { version: '4', submit_form_fields: newFields },
  })
  assert.equal(fixture.presetOverrides.get('dt-conversation-1'), 'reliable-development')
  assert.equal(fixture.bindings.get('dt-conversation-1'), undefined)
  assert.equal(prepared.response.userPrivateData.cardParamMap.button_text, '✓ 新会话已准备：CyberMarcus')
})

test('stream normalizer keeps dynamic-form callbacks with empty actionIds and rejects malformed params', async () => {
  const normalized = normalizeCardCallback({
    outTrackId: 'card-1',
    userId: 'owner-staff',
    content: JSON.stringify({ cardPrivateData: { actionIds: [], params: { submit_form_fields: [{ name: 'view', type: 'SELECT' }] } } }),
  })
  assert.deepEqual(normalized, {
    outTrackId: 'card-1',
    userId: 'owner-staff',
    actionIds: [],
    params: { submit_form_fields: [{ name: 'view', type: 'SELECT' }] },
  })
  assert.equal(normalizeCardCallback({ outTrackId: 'card-1', userId: 'owner-staff', content: JSON.stringify({ cardPrivateData: { actionIds: [], params: [] } }) }), undefined)
  const unknownCard = new ConsoleCards({ commands: commandFixture().commands, outbound: { sendMarkdown: async () => true }, markdownTitle: 'DSH', isOwnerId: () => true, log: () => {} })
  const unknownResult = await unknownCard.handleCardCallback(normalized)
  assert.equal(unknownResult.handled, false)
})

test('interaction sender keeps approval template isolated and seeds dynamic-form data through cardData', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) })
    return { ok: true, text: async () => '' }
  }
  try {
    const sender = new InteractionCards(async () => 'token', 'robot', 'console-template', () => {})
    const delivered = await sender.create({
      outTrackId: 'dshc1_0123456789abcdef_0123456789abcdef01234567',
      kind: 'console',
      target: { type: 'user', userId: 'owner-staff' },
      title: '大神控制台',
      detail: '',
      approveLabel: '应用设置 / 执行动作',
      rejectLabel: '应用设置 / 执行动作',
      cardData: { title: '大神控制台', form_fields: '[]', form_status: 'normal', button_text: '应用设置 / 执行动作', err_msg: '' },
      privateData: { must_not_reach_api: 'regression-guard' },
    })
    assert.equal(delivered, true)
    assert.equal(requests.length, 2)
    assert.equal(requests[0].body.cardTemplateId, 'console-template')
    assert.deepEqual(requests[0].body.cardData, { cardParamMap: { title: '大神控制台', form_fields: '[]', form_status: 'normal', button_text: '应用设置 / 执行动作', err_msg: '' } })
    assert.equal('privateData' in requests[0].body, false)
    assert.equal(requests[0].body.callbackType, 'STREAM')
    assert.equal(requests[1].body.outTrackId, requests[0].body.outTrackId)
  } finally {
    globalThis.fetch = originalFetch
  }
})
