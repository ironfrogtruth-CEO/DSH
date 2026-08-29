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

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
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
  const deps = {
    agents: { get: () => undefined },
    outbound: { sendMarkdown: async (_webhook, _title, content) => { replies.push(content); return true } },
    bindings,
    modelOverrides,
    queue: { depth: () => 0, clear: () => {} },
    sessionQuery,
    llm,
    isOwner: (msg) => msg.conversationType === 'direct' && msg.senderStaffId === 'owner-staff',
    defaultModel: () => ({ provider: 'provider-a', model: 'model-a' }),
    connectorStatus: () => [],
    markdownTitle: 'DSH',
    log: () => {},
    workspaceOverrides: new MapStore(),
    defaultWorkspace: '/workspace',
  }
  return { commands: new Commands(deps), deps, replies, bindings, modelOverrides, sessionQuery }
}

test('management commands are owner-only and use the canonical session/model services', async () => {
  const fixture = commandFixture()
  const { commands, replies, bindings, modelOverrides } = fixture

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
    mkdirSync(join(output, '.git'), { recursive: true })
    mkdirSync(join(output, 'node_modules'), { recursive: true })
    writeFileSync(join(external, 'outside.txt'), 'must not be followed')
    symlinkSync(join(external, 'outside.txt'), join(output, 'symlink.txt'))
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

test('interactive console seeds the real dynamic form and updates one card idempotently', async () => {
  const fixture = commandFixture()
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
  assert.equal(await consoleCards.open(ownerMessage, 'dt-conversation-1'), true)
  assert.equal(requests.length, 1)
  const first = requests[0]
  assert.equal(first.kind, 'console')
  assert.match(first.outTrackId, /^dshc1_[0-9a-f]{16}_[0-9a-f]{24}$/)
  assert.deepEqual(Object.keys(first.cardData).sort(), ['button_text', 'err_msg', 'form_fields', 'form_status', 'title'])
  assert.equal(first.cardData.title, '大神控制台')
  assert.equal(first.cardData.button_text, '应用设置 / 执行动作')
  const fields = JSON.parse(first.cardData.form_fields)
  assert.deepEqual(fields.map((field) => field.name), ['status', 'notice', 'view', 'sessionSlot', 'modelSlot', 'effortSlot', 'taskAction'])
  assert.deepEqual(new Set(fields.map((field) => field.type)), new Set(['TEXT', 'SELECT']))
  assert.equal(fields.some((field) => field.type.startsWith('CHECKBOX')), false)
  const slots = fields.filter((field) => field.type === 'SELECT').flatMap((field) => field.options.map((option) => option.value))
  assert.ok(slots.some((value) => /^v1:s\d+$/.test(value)))
  assert.ok(slots.some((value) => /^v1:m\d+$/.test(value)))
  assert.ok(slots.some((value) => /^v1:e\d+$/.test(value)))
  assert.ok(slots.every((value) => /^v1:(?:v|s|m|e|a)\d+$/.test(value)))

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

  const currentFields = JSON.parse(select.response.userPrivateData.cardParamMap.form_fields)
  assert.deepEqual(currentFields.map((field) => field.name), ['status', 'notice', 'view', 'sessionSlot'])
  const submitFields = currentFields.map((field) => {
    if (field.type === 'SELECT' && field.name !== 'view' && field.options.length > 0) return { ...field, default_number: 0 }
    return field
  })
  const submit = {
    outTrackId: first.outTrackId,
    userId: 'owner-staff',
    actionIds: [],
    params: { version: '2', submit_form_fields: submitFields },
  }
  const applied = await consoleCards.handleCardCallback(submit)
  assert.equal(applied.handled, true)
  assert.equal(applied.response.outTrackId, first.outTrackId)
  assert.equal(applied.response.version, '3')
  assert.equal(applied.response.userPrivateData.cardParamMap.form_status, 'normal')
  assert.match(JSON.parse(applied.response.userPrivateData.cardParamMap.form_fields).find((field) => field.name === 'notice').default_string, /设置已应用/)
  assert.deepEqual(await consoleCards.handleCardCallback(submit), applied)

  const stale = await consoleCards.handleCardCallback({
    outTrackId: first.outTrackId,
    userId: 'owner-staff',
    actionIds: [],
    params: { version: '1', name: 'view', type: 'SELECT', view: { index: 2 } },
  })
  assert.equal(stale.response.version, '3')
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
