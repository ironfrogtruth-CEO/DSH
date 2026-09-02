import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  createShrimpAuthorizationGate,
  explicitShrimpRunIntent,
  extractShrimpRunId,
  apply,
  findShrimpPipeline,
  findShrimpTarget,
  normalizeShrimpRunInputs,
  normalizeShrimpRunUsage,
  normalizeShrimpToolResponse,
  readShrimpRunStandingAuth,
  resolveSubscriberAgentContext,
  SHRIMP_AUTH_RECEIPT_MAX_AUTH_USES,
  subscriberRequestHeaders,
  subscriberToolDenied,
  runShrimpWithReceipt,
  runShrimpWithDedupe,
  ShrimpRunRequestRegistry,
  ShrimpAuthorizationReceipts,
  shrimpAgentIdentity,
  shrimpRunBatchCount,
  stableShrimpRunIdempotencyKey,
} from './index.js'

function fakeClock() {
  let value = 0
  return {
    now: () => value,
    sleep: async (ms) => { value += Number(ms) || 0 },
  }
}

function makeReaders(calls, summaries, artifacts = { ok: true, data: { total: 0, items: [] } }) {
  let index = 0
  return {
    readSummary: async (runId) => {
      calls.push({ method: 'GET', path: `/api/v1/runs/${encodeURIComponent(runId)}/summary` })
      const value = summaries[Math.min(index, summaries.length - 1)]
      index += 1
      return value
    },
    readArtifacts: async (runId) => {
      calls.push({ method: 'GET', path: `/api/v1/runs/${encodeURIComponent(runId)}/artifacts` })
      return artifacts
    },
  }
}

function assertNoHeartbeatWrites(calls) {
  assert.equal(calls.some((call) => /heartbeat/i.test(call.path)), false)
  assert.equal(calls.some((call) => call.method !== 'GET' && /\/api\/v1\/runs\//.test(call.path)), false)
}

function subscriberContextFixture() {
  const assertionInputs = []
  const service = {
    resolveSubscriberForSession(sessionId) {
      return sessionId === 'subscriber-session' ? 'subscriber-a' : null
    },
    resolveRuntimePolicy(subscriberId) {
      return subscriberId === 'subscriber-a'
        ? { role: 'subscriber', status: 'active', active: true }
        : null
    },
    createSubscriberAssertionForSession(input) {
      assertionInputs.push(input)
      return {
        'X-DSH-Subscriber-Assertion': `assertion-${assertionInputs.length}`,
        'X-DSH-Subscriber-Signature': `signature-${assertionInputs.length}`,
      }
    },
  }
  return {
    service,
    assertionInputs,
    ctx: { get: (name) => name === 'dingtalkSubscriptions' ? service : null },
    subscriber: { id: 'subscriber-agent', session: { id: 'subscriber-session' } },
    otherSession: { id: 'subscriber-agent', session: { id: 'other-session' } },
    owner: { id: 'owner-agent', session: { id: 'owner-session' } },
  }
}

test('subscriber assertion follows session lineage and never accepts exec argument identity', () => {
  const fixture = subscriberContextFixture()
  const resolved = resolveSubscriberAgentContext(fixture.ctx, fixture.subscriber)
  assert.equal(resolved.subscriber, true)
  assert.equal(resolved.subscriberId, 'subscriber-a')
  assert.equal(resolved.sessionId, 'subscriber-session')

  const headers = subscriberRequestHeaders(fixture.ctx, fixture.subscriber, ['pipeline:run'])
  assert.deepEqual(headers.headers, {
    'x-dsh-subscriber-assertion': 'assertion-1',
    'x-dsh-subscriber-signature': 'signature-1',
  })
  assert.deepEqual(fixture.assertionInputs, [{ sessionId: 'subscriber-session', scopes: ['pipeline:run'] }])

  const isolated = subscriberRequestHeaders(fixture.ctx, fixture.otherSession, ['pipeline:run'])
  assert.equal(isolated.subscriber, false)
  assert.deepEqual(isolated.headers, {})
})

test('只有 agentId 时先由 core session lineage 解析 sessionId，不从机器人列表猜账户', () => {
  const fixture = subscriberContextFixture()
  const resolvedSessions = []
  fixture.service.resolveSessionForAgent = (agentId) => {
    resolvedSessions.push(agentId)
    return agentId === 'subscriber-agent' ? 'subscriber-session' : null
  }
  const agentOnly = { id: 'subscriber-agent', session: { events: [] } }
  const headers = subscriberRequestHeaders(fixture.ctx, agentOnly, ['pipeline:run'])
  assert.equal(headers.subscriber, true)
  assert.equal(headers.sessionId, 'subscriber-session')
  assert.deepEqual(resolvedSessions, ['subscriber-agent'])
  assert.deepEqual(fixture.assertionInputs, [{ sessionId: 'subscriber-session', scopes: ['pipeline:run'] }])
})

test('owner path remains unchanged and subscriber discovery/creation tools are denied', () => {
  const fixture = subscriberContextFixture()
  assert.deepEqual(subscriberRequestHeaders(fixture.ctx, fixture.owner, ['pipeline:run']), { subscriber: false, headers: {} })
  assert.equal(subscriberToolDenied(fixture.ctx, fixture.owner, 'shrimp_list'), null)
  assert.equal(subscriberToolDenied(fixture.ctx, fixture.owner, 'shrimp_create_draft'), null)
  assert.equal(subscriberToolDenied(fixture.ctx, fixture.subscriber, 'shrimp_list').code, 'SUBSCRIBER_TOOL_NOT_ALLOWED')
  assert.equal(subscriberToolDenied(fixture.ctx, fixture.subscriber, 'shrimp_match').blocked, true)
  assert.equal(subscriberToolDenied(fixture.ctx, fixture.subscriber, 'shrimp_knowledge_search').blocked, true)
  assert.equal(subscriberToolDenied(fixture.ctx, fixture.subscriber, 'shrimp_create_draft').blocked, true)
})

test('shrimp_run 为 subscriber 注入 session assertion 并保持 owner 请求不带订阅身份', async () => {
  const fixture = subscriberContextFixture()
  const registered = new Map()
  const calls = []
  const context = {
    get: fixture.ctx.get,
    effect() {},
    on() {},
    inject() {},
    webServer: { register() {} },
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => {}
      },
    },
  }
  apply(context)
  const runTool = registered.get('shrimp_run')
  const listTool = registered.get('shrimp_list')
  assert.ok(runTool)
  assert.ok(listTool)

  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(String(input))
      const headers = Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [String(key).toLowerCase(), String(value)]))
      calls.push({ method: String(options.method || 'GET'), path: url.pathname, headers })
      let payload
      if (url.pathname.endsWith('/pipelines/subscriber-pipeline/runs')) {
        payload = { ok: true, run_id: 'run-subscriber' }
      } else if (url.pathname.endsWith('/runs/run-subscriber/summary')) {
        payload = { ok: true, data: { id: 'run-subscriber', status: 'done', tokens_total: 17 } }
      } else if (url.pathname.endsWith('/runs/run-subscriber/artifacts')) {
        payload = { ok: true, data: { total: 0, items: [] } }
      } else if (url.pathname.endsWith('/pipelines/owner-pipeline/runs')) {
        payload = { ok: true, run_id: 'run-owner' }
      } else if (url.pathname.endsWith('/runs/run-owner/summary')) {
        payload = { ok: true, data: { id: 'run-owner', status: 'done', tokens_total: 19 } }
      } else if (url.pathname.endsWith('/runs/run-owner/artifacts')) {
        payload = { ok: true, data: { total: 0, items: [] } }
      } else {
        payload = { ok: true, data: { items: [] } }
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    const subscriberResult = await runTool.execute({
      pipelineSlug: 'subscriber-pipeline',
      payload: { topic: 'subscriber-only' },
      confirm: true,
    }, { agent: fixture.subscriber })
    assert.equal(subscriberResult.run_id, 'run-subscriber')
    assert.deepEqual(subscriberResult.usage, { total_tokens: 17 })
    const subscriberCalls = calls.splice(0)
    assert.deepEqual(subscriberCalls.map((call) => [call.method, call.path]), [
      ['POST', '/api/v1/pipelines/subscriber-pipeline/runs'],
      ['GET', '/api/v1/runs/run-subscriber/summary'],
      ['GET', '/api/v1/runs/run-subscriber/artifacts'],
    ])
    for (const call of subscriberCalls) {
      assert.equal(call.headers['x-dsh-subscriber-assertion'].startsWith('assertion-'), true)
      assert.equal(call.headers['x-dsh-subscriber-signature'].startsWith('signature-'), true)
    }
    assert.deepEqual(fixture.assertionInputs, [
      { sessionId: 'subscriber-session', scopes: ['pipeline:run'] },
      { sessionId: 'subscriber-session', scopes: ['run:read'] },
      { sessionId: 'subscriber-session', scopes: ['run:read', 'artifact:read'] },
    ])

    const denied = await listTool.execute({ group: 'all' }, { agent: fixture.subscriber })
    assert.equal(denied.code, 'SUBSCRIBER_TOOL_NOT_ALLOWED')
    assert.equal(calls.length, 0, 'subscriber discovery must be denied before tank fetch')

    const ownerResult = await runTool.execute({
      pipelineSlug: 'owner-pipeline',
      payload: { topic: 'owner-only' },
      confirm: true,
    }, { agent: fixture.owner })
    assert.equal(ownerResult.run_id, 'run-owner')
    assert.deepEqual(calls.map((call) => [call.method, call.path]), [
      ['POST', '/api/v1/pipelines/owner-pipeline/runs'],
      ['GET', '/api/v1/runs/run-owner/summary'],
      ['GET', '/api/v1/runs/run-owner/artifacts'],
    ])
    assert.equal(calls.some((call) => call.headers['x-dsh-subscriber-assertion']), false)
    assert.equal(calls.some((call) => call.headers['x-dsh-subscriber-signature']), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('tank tool normalizes structured API errors without losing details or transport status', async () => {
  const envelope = normalizeShrimpToolResponse({
    ok: false,
    status: 409,
    json: {
      ok: false,
      status: 499,
      error: { code: 'ACTIVE_RUN_CONFLICT', message: '已有运行', existing_run_id: 'run-existing' },
      data: { preserved: true },
    },
  })
  assert.equal(envelope.ok, false)
  assert.equal(envelope.status, 409)
  assert.equal(typeof envelope.error, 'string')
  assert.equal(envelope.error, '已有运行')
  assert.deepEqual(envelope.error_detail, { code: 'ACTIVE_RUN_CONFLICT', message: '已有运行', existing_run_id: 'run-existing' })
  assert.equal(envelope.code, 'RUN_ALREADY_ACTIVE')
  assert.equal(envelope.existing_run_id, 'run-existing')
  assert.deepEqual(envelope.data, { preserved: true })

  const fastApi = normalizeShrimpToolResponse({
    ok: false,
    status: 409,
    json: { detail: { code: 'ACTIVE_RUN_CONFLICT', detail: '已有文章运行', existing_run_id: 'run-fastapi' } },
  })
  assert.equal(fastApi.error, '已有文章运行')
  assert.equal(fastApi.code, 'RUN_ALREADY_ACTIVE')
  assert.equal(fastApi.existing_run_id, 'run-fastapi')
  assert.deepEqual(fastApi.error_detail, { code: 'ACTIVE_RUN_CONFLICT', detail: '已有文章运行', existing_run_id: 'run-fastapi' })

  const plain = normalizeShrimpToolResponse({ ok: false, status: 400, json: '请求格式错误' })
  assert.equal(plain.error, '请求格式错误')
  assert.equal(typeof plain.error, 'string')

  const success = normalizeShrimpToolResponse({
    ok: true,
    status: 200,
    json: { ok: false, status: 503, data: { preserved: true } },
  })
  assert.equal(success.ok, true)
  assert.equal(success.status, 200)
  assert.deepEqual(success.data, { preserved: true })

  let summaryReads = 0
  const conflictRun = await runShrimpWithReceipt({
    launch: async () => envelope,
    readSummary: async () => { summaryReads += 1; return { ok: true, data: { status: 'done' } } },
  })
  assert.equal(conflictRun.ok, false)
  assert.equal(conflictRun.started, false)
  assert.equal(conflictRun.code, 'RUN_ALREADY_ACTIVE')
  assert.equal(conflictRun.existing_run_id, 'run-existing')
  assert.equal(typeof conflictRun.error_summary, 'string')
  assert.equal(summaryReads, 0, '409 active conflict should not enter terminal polling')
})

test('单独运行成功后返回终态、节点、进度和产物摘要，只读 summary/artifacts', async () => {
  const calls = [{ method: 'POST', path: '/api/v1/pipelines/article/runs' }]
  const readers = makeReaders(calls, [{
    ok: true,
    data: {
      id: 'manual:article:success',
      status: 'done',
      progress_percent: 100,
      current_node_id: 'article-8',
      error_summary: null,
    },
  }], {
    ok: true,
    data: {
      total: 2,
      items: [
        { id: 'a1', name: 'article.html', type: 'html', bucket: 'final', size_bytes: 120, mime_type: 'text/html', previewable: true, path: '/private/should-not-leak.html' },
        { id: 'a2', name: 'article.png', type: 'png', bucket: 'delivery', size_bytes: 240, mime_type: 'image/png', previewable: true },
      ],
    },
  })

  const result = await runShrimpWithReceipt({
    launch: async () => ({
      ok: true,
      operation_id: 'op-success',
      resource_refs: [{ type: 'run', id: 'manual:article:success' }],
    }),
    ...readers,
    timeoutMs: 10,
    pollIntervalMs: 1,
  })

  assert.equal(extractShrimpRunId({ data: { resource_refs: [{ type: 'run', id: 'manual:article:success' }] } }), 'manual:article:success')
  assert.equal(result.ok, true)
  assert.equal(result.reported, true)
  assert.equal(result.run_id, 'manual:article:success')
  assert.equal(result.final_status, 'done')
  assert.equal(result.progress, 100)
  assert.equal(result.current_node, 'article-8')
  assert.equal(result.error_summary, null)
  assert.equal(result.artifacts.total, 2)
  assert.deepEqual(result.artifacts.items.map((item) => item.name), ['article.html', 'article.png'])
  assert.equal('path' in result.artifacts.items[0], false)
  assertNoHeartbeatWrites(calls)
})

test('单独运行失败也返回明确终态和错误，不把失败伪装成创建成功', async () => {
  const calls = [{ method: 'POST', path: '/api/v1/pipelines/article/runs' }]
  const result = await runShrimpWithReceipt({
    launch: async () => ({ ok: true, resource_refs: [{ type: 'run', id: 'manual:article:failed' }] }),
    ...makeReaders(calls, [{
      ok: true,
      data: {
        id: 'manual:article:failed',
        status: 'failed',
        progress_percent: 46,
        current_node_id: 'article-5-fact-qa',
        error_summary: '事实来源闸门未通过',
      },
    }]),
    timeoutMs: 10,
    pollIntervalMs: 1,
  })

  assert.equal(result.ok, false)
  assert.equal(result.reported, true)
  assert.equal(result.run_id, 'manual:article:failed')
  assert.equal(result.final_status, 'failed')
  assert.equal(result.progress, 46)
  assert.equal(result.current_node, 'article-5-fact-qa')
  assert.equal(result.error_summary, '事实来源闸门未通过')
  assertNoHeartbeatWrites(calls)
})

test('有界等待超时返回 run_id 和 still_running，并给出继续查询动作，不读取 artifacts', async () => {
  const clock = fakeClock()
  const calls = [{ method: 'POST', path: '/api/v1/pipelines/article/runs' }]
  const result = await runShrimpWithReceipt({
    launch: async () => ({ ok: true, resource_refs: [{ type: 'run', id: 'manual:article:running' }] }),
    ...makeReaders(calls, [{
      ok: true,
      data: { id: 'manual:article:running', status: 'running', progress_percent: 18, current_node_id: 'article-3' },
    }]),
    timeoutMs: 25,
    pollIntervalMs: 10,
    sleep: clock.sleep,
    now: clock.now,
  })

  assert.equal(result.ok, false)
  assert.equal(result.reported, false)
  assert.equal(result.run_id, 'manual:article:running')
  assert.equal(result.final_status, 'running')
  assert.equal(result.still_running, true)
  assert.deepEqual(result.next_action, {
    tool: 'shrimp_run_status',
    run_id: 'manual:article:running',
    wait_seconds: 120,
  })
  assert.equal(calls.some((call) => call.path.endsWith('/artifacts')), false)
  assertNoHeartbeatWrites(calls)
})

test('创建响应没有 run_id 时明确阻断，不启动轮询、不创建第二条运行', async () => {
  const calls = []
  const result = await runShrimpWithReceipt({
    launch: async () => ({ ok: true, operation_id: 'op-without-run-id', status: 'queued' }),
    readSummary: async () => { throw new Error('不应开始状态读取') },
    readArtifacts: async () => { throw new Error('不应开始产物读取') },
  })

  assert.equal(result.ok, false)
  assert.equal(result.blocked, true)
  assert.equal(result.started, false)
  assert.equal(result.reported, true)
  assert.equal(result.run_id, null)
  assert.equal(result.final_status, null)
  assert.match(result.error_summary, /缺少 run_id/)
  assert.deepEqual(calls, [])
  assertNoHeartbeatWrites(calls)
})

test('0 秒查询仍立即读取一次；已是终态正常返回，运行中则诚实返回 still_running', async () => {
  const terminalCalls = []
  const terminal = await runShrimpWithReceipt({
    launch: async () => ({ ok: true, run_id: 'run-zero-done' }),
    ...makeReaders(terminalCalls, [{ ok: true, status: 'done', progress_percent: 100 }]),
    timeoutMs: 0,
  })
  assert.equal(terminal.final_status, 'done')
  assert.equal(terminal.still_running, undefined)
  assert.equal(terminalCalls.filter((call) => call.path.endsWith('/summary')).length, 1)

  const runningCalls = []
  const running = await runShrimpWithReceipt({
    launch: async () => ({ ok: true, run_id: 'run-zero-running' }),
    ...makeReaders(runningCalls, [{ ok: true, status: 'running', progress_percent: 1 }]),
    timeoutMs: 0,
  })
  assert.equal(running.final_status, 'running')
  assert.equal(running.still_running, true)
  assert.equal(runningCalls.filter((call) => call.path.endsWith('/summary')).length, 1)
  assertNoHeartbeatWrites([...terminalCalls, ...runningCalls])
})

test('终态回执把虾缸 tokens_total/total_tokens 归一为 DSH usage.total_tokens', async () => {
  assert.deepEqual(normalizeShrimpRunUsage({ data: { tokens_total: '123' } }), { total_tokens: 123 })
  assert.deepEqual(normalizeShrimpRunUsage({ data: { usage: { total_tokens: 0 } } }), { total_tokens: 0 })
  assert.equal(normalizeShrimpRunUsage({ data: { tokens_total: -1 } }), null)
  assert.equal(normalizeShrimpRunUsage({ data: {} }), null)

  const receipt = await runShrimpWithReceipt({
    launch: async () => ({ ok: true, run_id: 'run-usage-normalized' }),
    readSummary: async () => ({ ok: true, data: { id: 'run-usage-normalized', status: 'done', tokens_total: 321 } }),
    readArtifacts: async () => ({ ok: true, data: { total: 0, items: [] } }),
    timeoutMs: 0,
  })
  assert.deepEqual(receipt.usage, { total_tokens: 321 })
})

test('shrimp_run 工具合同要求回执且不提供裸 curl 或心跳写入口', () => {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  const start = source.indexOf("name: 'shrimp_run'")
  const end = source.indexOf("name: 'shrimp_run_status'", start)
  assert.ok(start >= 0 && end > start, 'shrimp_run tool registration must stay in index.js')
  const runTool = source.slice(start, end)
  assert.match(runTool, /still_running=true/)
  assert.match(runTool, /\/api\/v1\/runs\/\{run_id\}\/summary/)
  assert.match(runTool, /裸 curl/)
  assert.doesNotMatch(runTool, /\/api\/shrimp\/heartbeat\//)
  assert.match(source, /name: 'shrimp_run_status'/)
  assert.match(source, /exec\.name === 'shrimp_run'/)
})

const ARTICLE_PIPELINE = {
  identity: 'pipeline',
  // 旧策略用例统一使用非白名单 slug；真实白名单 slug 的常驻授权行为
  // 由文末 standing-auth 专项用例覆盖（读真实 ~/.dsh/shrimp-run-standing-auth.json）。
  ref: 'shrimp-test-article',
  display_name: '文章@虾六答',
  lifecycle_status: 'published',
}
const OTHER_PIPELINE = {
  identity: 'pipeline',
  ref: 'shrimp-other',
  display_name: '企业健康报告@平安',
  lifecycle_status: 'published',
}
const CATALOG = [ARTICLE_PIPELINE, OTHER_PIPELINE]

function human(text) {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

function liveAgent(id = 'agent-1', turn = 7) {
  return { id, session: { events: [{ type: 'turn/start', data: { turn } }] } }
}

test('用户明确授权原话在当前回合建立文章虾 receipt，approval=never 分支继续下游 allow', async () => {
  const receiptStore = new ShrimpAuthorizationReceipts({ maxUses: 2, ttlMs: 60_000, now: () => 1_000 })
  const gate = createShrimpAuthorizationGate({ receipts: receiptStore, readCatalog: async () => CATALOG, now: () => 1_000 })
  const agent = liveAgent()
  const text = '调用文章虾完成一次文章发布…如遇阻断，请自行修复跑通，只在最后交付'
  assert.equal(explicitShrimpRunIntent([human(text)]).explicit, true)
  await gate.preStep({ agent, messages: [human(text)], turn: 7 }, async () => ({ kind: 'enter', messages: [] }))
  let nextCalls = 0
  const decision = await gate.preExecute({
    name: 'shrimp_run',
    agent,
    arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true },
  }, async () => { nextCalls += 1; return { kind: 'allow' } })
  assert.deepEqual(decision, { kind: 'allow' })
  assert.equal(nextCalls, 1)
  assert.equal(receiptStore.peek({ agentId: agent.id, turn: 7, pipelineSlug: ARTICLE_PIPELINE.ref }).uses, 1)
})

test('上一回合的运行指令不会污染本回合只读状态问题', async () => {
  const gate = createShrimpAuthorizationGate({ readCatalog: async () => CATALOG })
  const agent = liveAgent('agent-history', 8)
  await gate.preStep({
    agent,
    turn: 8,
    messages: [human('上一回合请运行文章虾'), human('本回合只查询文章虾最新状态')],
  }, async () => ({ kind: 'enter', messages: [] }))
  const decision = await gate.preExecute({
    name: 'shrimp_run', agent,
    arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true },
  }, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'ask')
  assert.equal(explicitShrimpRunIntent([human('上一回合请运行文章虾'), human('本回合只查询文章虾最新状态')]).explicit, false)
})

test('推荐、匹配和询问不会建立 receipt，未明确授权仍保持 ask', async () => {
  for (const text of ['推荐文章虾', '帮我匹配文章虾', '请问如何运行文章虾？']) {
    const gate = createShrimpAuthorizationGate({ readCatalog: async () => CATALOG })
    const agent = liveAgent()
    assert.equal(explicitShrimpRunIntent([human(text)]).explicit, false)
    await gate.preStep({ agent, messages: [human(text)], turn: 7 }, async () => ({ kind: 'enter', messages: [] }))
    let nextCalls = 0
    const decision = await gate.preExecute({
      name: 'shrimp_run',
      agent,
      arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true },
    }, async () => { nextCalls += 1; return { kind: 'allow' } })
    assert.equal(decision.kind, 'ask')
    assert.equal(nextCalls, 0)
  }
})

test('receipt 只匹配同一目标虾和会话，批次可跨回合消费，错虾或跨会话不会放行', async () => {
  const gate = createShrimpAuthorizationGate({ readCatalog: async () => CATALOG })
  const agent = liveAgent('agent-1', 7)
  await gate.preStep({ agent, messages: [human('请运行文章虾完成三篇')], turn: 7 }, async () => ({ kind: 'enter', messages: [] }))
  let nextCalls = 0
  const wrongTarget = await gate.preExecute({
    name: 'shrimp_run', agent,
    arguments: { pipelineSlug: OTHER_PIPELINE.ref, confirm: true },
  }, async () => { nextCalls += 1; return { kind: 'allow' } })
  assert.equal(wrongTarget.kind, 'ask')
  assert.equal(nextCalls, 0)

  agent.session.events = [{ type: 'turn/start', data: { turn: 8 } }]
  const nextBatchItem = await gate.preExecute({
    name: 'shrimp_run', agent,
    arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true, payload: { topic: '第二篇' } },
  }, async () => { nextCalls += 1; return { kind: 'allow' } })
  assert.equal(nextBatchItem.kind, 'allow')
  assert.equal(nextCalls, 1)
  assert.equal(findShrimpTarget(CATALOG, '请运行文章虾完成三篇'), ARTICLE_PIPELINE)
  assert.equal(findShrimpPipeline(CATALOG, ARTICLE_PIPELINE.ref), ARTICLE_PIPELINE)
})

test('遇阻自行修复跑通使用同一 receipt，最多初始运行加一次有界重试，第三次仍 ask', async () => {
  const gate = createShrimpAuthorizationGate({ readCatalog: async () => CATALOG })
  const agent = liveAgent()
  await gate.preStep({ agent, messages: [human('请运行文章虾，遇阻自行修复跑通')], turn: 7 }, async () => ({ kind: 'enter', messages: [] }))
  const allow = async () => gate.preExecute({
    name: 'shrimp_run', agent,
    arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true },
  }, async () => ({ kind: 'allow' }))
  assert.equal((await allow()).kind, 'allow')
  assert.equal((await allow()).kind, 'allow')
  assert.equal((await allow()).kind, 'ask')
})

test('普通明确运行只允许一次，过期 receipt 也不能继续放行', async () => {
  let now = 1_000
  const receiptStore = new ShrimpAuthorizationReceipts({ now: () => now, ttlMs: 100 })
  const gate = createShrimpAuthorizationGate({ receipts: receiptStore, readCatalog: async () => CATALOG, now: () => now })
  const agent = liveAgent('agent-expiry', 7)
  await gate.preStep({ agent, messages: [human('请运行文章虾')], turn: 7 }, async () => ({ kind: 'enter', messages: [] }))
  const run = () => gate.preExecute({
    name: 'shrimp_run', agent,
    arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true },
  }, async () => ({ kind: 'allow' }))
  assert.equal((await run()).kind, 'allow')
  assert.equal((await run()).kind, 'ask')
  now = 2_000
  assert.equal((await run()).kind, 'ask')
})

test('三篇批次授权在同一 agent/session 内可跨回合消费，每篇最多一次', async () => {
  let now = 1_000
  const receiptStore = new ShrimpAuthorizationReceipts({ now: () => now, ttlMs: 3_600_000 })
  const gate = createShrimpAuthorizationGate({ receipts: receiptStore, readCatalog: async () => CATALOG, now: () => now })
  const agent = liveAgent('batch-agent', 7)
  await gate.preStep({ agent, messages: [human('请依次运行三篇文章虾')], turn: 7 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(shrimpRunBatchCount('请依次运行三篇文章'), 3)
  assert.equal(receiptStore.peek({ agentId: agent.id, pipelineSlug: ARTICLE_PIPELINE.ref }).maxUses, 3)

  for (const [turn, topic] of [[7, '第一篇'], [8, '第二篇'], [9, '第三篇']]) {
    agent.session.events = [{ type: 'turn/start', data: { turn } }]
    const decision = await gate.preExecute({
      name: 'shrimp_run', agent,
      arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true, payload: { topic } },
    }, async () => ({ kind: 'allow' }))
    assert.equal(decision.kind, 'allow')
  }
  assert.equal(receiptStore.peek({ agentId: agent.id, pipelineSlug: ARTICLE_PIPELINE.ref }).uses, 3)

  agent.session.events = [{ type: 'turn/start', data: { turn: 10 } }]
  const repeatedItem = await gate.preExecute({
    name: 'shrimp_run', agent,
    arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true, payload: { topic: '第三篇' } },
  }, async () => ({ kind: 'allow' }))
  assert.equal(repeatedItem.kind, 'ask', '同一篇不能被普通批次重复消费')
})

test('真实两篇生产授权原句识别两项批次并给出每项一次恢复额度', () => {
  const intent = explicitShrimpRunIntent([human('运行文章虾，连续产出资讯和总结两篇并保存到公众号草稿箱')])
  assert.equal(intent.explicit, true)
  assert.equal(intent.batchCount, 2)
  assert.equal(intent.outcome, true)
  assert.equal(intent.recoverable, true)
  assert.equal(intent.maxUses, 4)
})

test('文章生产自然指令建立正确批次授权，历史描述、询问和维护指令不触发', () => {
  const direct = [
    ['升级了文章虾，试一下。一篇资讯，一篇关于过去12小时我们对大神升级的总结。', 2],
    ['用文章虾写一篇关于本周发布的文章。', 1],
    ['让文章@虾六答产出两篇文章并保存到草稿箱。', 2, 4],
    ['交给文章虾生成并发布一篇文章。', 1, 2],
    ['运行文章虾...；禁止直接调用 7843 API。', 1],
  ]
  for (const [text, batchCount, expectedMaxUses = batchCount] of direct) {
    const intent = explicitShrimpRunIntent([human(text)])
    assert.equal(intent.explicit, true, text)
    assert.equal(intent.batchCount, batchCount, text)
    assert.equal(intent.maxUses, expectedMaxUses, text)
  }
  for (const text of [
    '不要运行文章虾。',
    '描述历史产物，之前文章虾生成的内容有问题。',
    '能否运行文章虾？',
    '检查文章虾是否运行。',
    '分析文章虾生成的内容有问题。',
    '修复并升级文章虾插件/工作流。',
  ]) assert.equal(explicitShrimpRunIntent([human(text)]).explicit, false, text)
  assert.equal(shrimpRunBatchCount('一篇资讯，一篇总结'), 2)
  assert.equal(shrimpRunBatchCount('让文章@虾六答产出三篇'), 3)
  assert.equal(shrimpRunBatchCount('第3篇'), 1)
})

test('十项结果型批次保留每项一次恢复额度，总授权上限为二十次', async () => {
  assert.equal(SHRIMP_AUTH_RECEIPT_MAX_AUTH_USES, 20)
  let now = 1_000
  const receiptStore = new ShrimpAuthorizationReceipts({ now: () => now })
  const gate = createShrimpAuthorizationGate({ receipts: receiptStore, readCatalog: async () => CATALOG, now: () => now })
  const agent = liveAgent('ten-item-batch', 7)
  const text = '用文章虾完成十篇资讯并保存到公众号草稿箱'
  const intent = explicitShrimpRunIntent([human(text)])
  assert.equal(shrimpRunBatchCount(text), 10)
  assert.equal(intent.batchCount, 10)
  assert.equal(intent.maxUses, 20)
  await gate.preStep({ agent, messages: [human(text)], turn: 7 }, async () => ({ kind: 'enter', messages: [] }))
  let receipt = receiptStore.peek({ agentId: agent.id, pipelineSlug: ARTICLE_PIPELINE.ref })
  assert.equal(receipt.batchCount, 10)
  assert.equal(receipt.itemMaxUses, 2)
  assert.equal(receipt.maxUses, 20)
  for (let index = 0; index < 10; index += 1) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      agent.session.events = [{ type: 'turn/start', data: { turn: 7 + index * 2 + attempt } }]
      const decision = await gate.preExecute({
        name: 'shrimp_run', agent,
        arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true, payload: { topic: `第${index + 1}篇` } },
      }, async () => ({ kind: 'allow' }))
      assert.equal(decision.kind, 'allow')
    }
  }
  receipt = receiptStore.peek({ agentId: agent.id, pipelineSlug: ARTICLE_PIPELINE.ref })
  assert.equal(receipt.uses, 20)
  const overflow = await gate.preExecute({
    name: 'shrimp_run', agent,
    arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true, payload: { topic: '第11篇' } },
  }, async () => ({ kind: 'allow' }))
  assert.equal(overflow.kind, 'ask')
})

test('授权 receipt 默认 TTL 为 1 小时，过期后跨回合也不能继续运行', async () => {
  assert.equal(new ShrimpAuthorizationReceipts().ttlMs, 3_600_000)
  let now = 1_000
  const receiptStore = new ShrimpAuthorizationReceipts({ now: () => now })
  const gate = createShrimpAuthorizationGate({ receipts: receiptStore, readCatalog: async () => CATALOG, now: () => now })
  const agent = liveAgent('expiry-agent', 7)
  await gate.preStep({ agent, messages: [human('请运行文章虾')], turn: 7 }, async () => ({ kind: 'enter', messages: [] }))
  agent.session.events = [{ type: 'turn/start', data: { turn: 8 } }]
  now += 3_600_001
  const decision = await gate.preExecute({
    name: 'shrimp_run', agent,
    arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true },
  }, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'ask')
})

test('不同 agent、session 或 pipelineSlug 不能借用批次授权，否定语义不建立 receipt', async () => {
  const receiptStore = new ShrimpAuthorizationReceipts()
  const gate = createShrimpAuthorizationGate({ receipts: receiptStore, readCatalog: async () => CATALOG })
  const owner = liveAgent('owner-agent', 7)
  owner.session.header = { id: 'owner-session' }
  await gate.preStep({ agent: owner, messages: [human('请运行三篇文章虾')], turn: 7 }, async () => ({ kind: 'enter', messages: [] }))

  const otherAgent = liveAgent('other-agent', 8)
  otherAgent.session.header = { id: 'owner-session' }
  const otherAgentDecision = await gate.preExecute({
    name: 'shrimp_run', agent: otherAgent,
    arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true, payload: { topic: '另一会话' } },
  }, async () => ({ kind: 'allow' }))
  assert.equal(otherAgentDecision.kind, 'ask')

  owner.session.header = { id: 'new-session' }
  owner.session.events = [{ type: 'turn/start', data: { turn: 9 } }]
  const otherSessionDecision = await gate.preExecute({
    name: 'shrimp_run', agent: owner,
    arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true, payload: { topic: '新会话' } },
  }, async () => ({ kind: 'allow' }))
  assert.equal(otherSessionDecision.kind, 'ask')

  owner.session.header = { id: 'owner-session' }
  const otherSlugDecision = await gate.preExecute({
    name: 'shrimp_run', agent: owner,
    arguments: { pipelineSlug: OTHER_PIPELINE.ref, confirm: true, payload: { topic: '错误目标' } },
  }, async () => ({ kind: 'allow' }))
  assert.equal(otherSlugDecision.kind, 'ask')
  assert.equal(explicitShrimpRunIntent([human('不要运行三篇文章虾')]).explicit, false)
})

test('相同 turn、目标和规范化 inputs 生成稳定幂等键', () => {
  const first = { topic: '  文章主题  ', nested: { b: '  内容  ', a: 1 } }
  const second = { nested: { a: 1, b: '内容' }, topic: '文章主题' }
  assert.deepEqual(normalizeShrimpRunInputs(first), normalizeShrimpRunInputs(second))
  const base = { agentId: 'agent', sessionId: 'session', turn: 7, pipelineSlug: ARTICLE_PIPELINE.ref, payload: first }
  assert.equal(stableShrimpRunIdempotencyKey(base), stableShrimpRunIdempotencyKey({ ...base, payload: second }))
  assert.notEqual(stableShrimpRunIdempotencyKey(base), stableShrimpRunIdempotencyKey({ ...base, turn: 8 }))
  assert.notEqual(stableShrimpRunIdempotencyKey(base), stableShrimpRunIdempotencyKey({ ...base, sessionId: 'other-session' }))
})

test('still_running 的同一请求只读原 run，不再次 launch', async () => {
  const clock = fakeClock()
  const registry = new ShrimpRunRequestRegistry({ now: clock.now, ttlMs: 60_000 })
  const requestKey = {
    agentId: 'agent',
    sessionId: 'session',
    pipelineSlug: ARTICLE_PIPELINE.ref,
    payload: { topic: '同一篇' },
    idempotencyKey: stableShrimpRunIdempotencyKey({ agentId: 'agent', sessionId: 'session', turn: 7, pipelineSlug: ARTICLE_PIPELINE.ref, payload: { topic: '同一篇' } }),
  }
  let launches = 0
  let reads = 0
  const readSummary = async (runId) => {
    reads += 1
    return { ok: true, data: { id: runId, status: 'running', progress_percent: 12, current_node_id: 'article-1' } }
  }
  const first = await runShrimpWithDedupe({
    registry,
    requestKey,
    launch: async () => { launches += 1; return { ok: true, operation_id: 'op-1', run_id: 'run-1' } },
    readSummary,
    timeoutMs: 0,
    pollIntervalMs: 0,
    sleep: clock.sleep,
    now: clock.now,
  })
  assert.equal(first.still_running, true)
  const second = await runShrimpWithDedupe({
    registry,
    requestKey,
    launch: async () => { launches += 1; throw new Error('不应再次启动') },
    readSummary,
    timeoutMs: 0,
    pollIntervalMs: 0,
    sleep: clock.sleep,
    now: clock.now,
  })
  assert.equal(second.deduplicated, true)
  assert.equal(second.run_id, 'run-1')
  assert.equal(launches, 1)
  assert.equal(reads, 2)
})

test('我的虾运行中按钮真正 disabled，防止重复点击', () => {
  const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  assert.match(source, /disabled: busy \|\| Boolean\(activeRun\)/)
  assert.match(source, /disabled: busy \|\| active \|\| !\(item\.capabilities/)
})

test('审批分支保留：非 shrimp_run 继续，confirm 缺失或下游拒绝不消耗 receipt', async () => {
  const gate = createShrimpAuthorizationGate({ readCatalog: async () => CATALOG })
  const agent = liveAgent()
  await gate.preStep({ agent, messages: [human('启动文章虾')], turn: 7 }, async () => ({ kind: 'enter', messages: [] }))
  let nonShrimpNext = 0
  assert.deepEqual(await gate.preExecute({ name: 'shrimp_list', agent, arguments: {} }, async () => {
    nonShrimpNext += 1
    return { kind: 'allow' }
  }), { kind: 'allow' })
  assert.equal(nonShrimpNext, 1)

  const noConfirm = await gate.preExecute({
    name: 'shrimp_run', agent,
    arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: false },
  }, async () => ({ kind: 'allow' }))
  assert.equal(noConfirm.kind, 'ask')
  assert.equal(gate.receipts.peek({ agentId: agent.id, turn: 7, pipelineSlug: ARTICLE_PIPELINE.ref }).uses, 0)

  const downstreamDenied = await gate.preExecute({
    name: 'shrimp_run', agent,
    arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true },
  }, async () => ({ kind: 'deny', reason: 'policy' }))
  assert.deepEqual(downstreamDenied, { kind: 'deny', reason: 'policy' })
  assert.equal(gate.receipts.peek({ agentId: agent.id, turn: 7, pipelineSlug: ARTICLE_PIPELINE.ref }).uses, 0)
})

test('Avengers child consumes parent article authorization receipt without its own receipt', async () => {
  let now = 1_000
  const receiptStore = new ShrimpAuthorizationReceipts({ maxUses: 1, ttlMs: 100, now: () => now })
  const gate = createShrimpAuthorizationGate({ receipts: receiptStore, readCatalog: async () => CATALOG, now: () => now })
  const parent = liveAgent('avengers-parent', 7)
  const child = liveAgent('avengers-child', 8)
  child.session.header = { origin: 'subagent', parentSession: parent.id }
  await gate.preStep({
    agent: parent,
    messages: [human('调用文章虾')],
    turn: 7,
  }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(receiptStore.peek({ agentId: child.id, turn: 8, pipelineSlug: ARTICLE_PIPELINE.ref }), null)

  const run = () => gate.preExecute({
    name: 'shrimp_run',
    agent: child,
    arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true },
  }, async () => ({ kind: 'allow' }))
  assert.deepEqual(await run(), { kind: 'allow' })
  assert.equal(receiptStore.peek({ agentId: parent.id, turn: 7, pipelineSlug: ARTICLE_PIPELINE.ref }).uses, 1)
  assert.equal((await run()).kind, 'ask', 'the normal parent receipt is one-shot')

  const wrongSlug = await gate.preExecute({
    name: 'shrimp_run',
    agent: child,
    arguments: { pipelineSlug: OTHER_PIPELINE.ref, confirm: true },
  }, async () => ({ kind: 'allow' }))
  assert.equal(wrongSlug.kind, 'ask')

  const expiredParent = liveAgent('avengers-parent-expired', 9)
  const expiredChild = liveAgent('avengers-child-expired', 10)
  expiredChild.session.header = { origin: 'subagent', parentSession: expiredParent.id }
  await gate.preStep({
    agent: expiredParent,
    messages: [human('调用文章虾')],
    turn: 9,
  }, async () => ({ kind: 'enter', messages: [] }))
  now = 1_101
  const expired = await gate.preExecute({
    name: 'shrimp_run',
    agent: expiredChild,
    arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true },
  }, async () => ({ kind: 'allow' }))
  assert.equal(expired.kind, 'ask')

  const noParent = liveAgent('avengers-child-no-parent', 11)
  noParent.session.header = { origin: 'subagent' }
  const missingParent = await gate.preExecute({
    name: 'shrimp_run',
    agent: noParent,
    arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true },
  }, async () => ({ kind: 'allow' }))
  assert.equal(missingParent.kind, 'ask')
})

test('Avengers child reads lineage from the live session root and matches parent session id', async () => {
  let now = 1_000
  const receiptStore = new ShrimpAuthorizationReceipts({ maxUses: 1, ttlMs: 10_000, now: () => now })
  const gate = createShrimpAuthorizationGate({ receipts: receiptStore, readCatalog: async () => CATALOG, now: () => now })
  const parent = liveAgent('parent-agent', 7)
  parent.session = {
    id: 'session-parent',
    events: [{ type: 'turn/start', data: { turn: 7 } }],
    header: { id: 'stale-parent-header' },
  }
  const child = liveAgent('child-agent', 8)
  child.session = {
    id: 'session-child',
    origin: 'subagent',
    parentSession: 'session-parent',
    delegationDepth: 1,
    events: [{ type: 'turn/start', data: { turn: 8 } }],
    // Deliberately conflicting legacy values prove that the live root wins.
    header: { id: 'stale-child-header', origin: 'parent', parentSession: 'wrong-parent-session' },
  }
  assert.deepEqual(shrimpAgentIdentity(parent), { agentId: 'parent-agent', sessionId: 'session-parent' })
  assert.deepEqual(shrimpAgentIdentity(child), { agentId: 'child-agent', sessionId: 'session-child' })

  await gate.preStep({
    agent: child,
    messages: [human('调用文章虾')],
    turn: 8,
  }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(receiptStore.peek({ agentId: 'child-agent', sessionId: 'session-child', pipelineSlug: ARTICLE_PIPELINE.ref }), null, '子代理派单词不能自行签发 receipt')
  const beforeParent = await gate.preExecute({
    name: 'shrimp_run',
    agent: child,
    arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true, payload: { topic: 'before-parent' } },
  }, async () => ({ kind: 'allow' }))
  assert.equal(beforeParent.kind, 'ask', '没有父 receipt 时子代理必须被拦截')

  await gate.preStep({
    agent: parent,
    messages: [human('调用文章虾')],
    turn: 7,
  }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(receiptStore.peek({ agentId: 'parent-agent', sessionId: 'session-parent', pipelineSlug: ARTICLE_PIPELINE.ref }).uses, 0)

  const decision = await gate.preExecute({
    name: 'shrimp_run',
    agent: child,
    arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true, payload: { topic: 'root-lineage' } },
  }, async () => ({ kind: 'allow' }))
  assert.deepEqual(decision, { kind: 'allow' })
  assert.equal(receiptStore.peek({ agentId: 'parent-agent', sessionId: 'session-parent', pipelineSlug: ARTICLE_PIPELINE.ref }).uses, 1)
  assert.equal(receiptStore.peekConsumable({ sessionId: 'session-parent', pipelineSlug: ARTICLE_PIPELINE.ref }), null)
})

test('真实两篇文章授权可由子代理连续消费两次，第三次被门禁拦截', async () => {
  let now = 1_000
  const receiptStore = new ShrimpAuthorizationReceipts({ maxUses: 1, ttlMs: 10_000, now: () => now })
  const gate = createShrimpAuthorizationGate({ receipts: receiptStore, readCatalog: async () => CATALOG, now: () => now })
  const userText = '运行文章虾（文章@虾六答，shrimp-c433b57dac59419d），连续产出资讯和总结两篇并保存到公众号草稿箱'
  const parent = liveAgent('parent-agent-e2e', 7)
  parent.session = { id: 'session-parent', events: [{ type: 'turn/start', data: { turn: 7 } }] }
  const child = liveAgent('child-agent-e2e', 8)
  child.session = {
    id: 'session-child',
    origin: 'subagent',
    parentSession: 'session-parent',
    delegationDepth: 1,
    events: [{ type: 'turn/start', data: { turn: 8 } }],
  }

  await gate.preStep({ agent: child, messages: [human(userText)], turn: 8 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(receiptStore.peek({ agentId: 'child-agent-e2e', sessionId: 'session-child', pipelineSlug: ARTICLE_PIPELINE.ref }), null)
  const beforeParent = await gate.preExecute({
    name: 'shrimp_run', agent: child,
    arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true, payload: { topic: '无父授权时不得运行' } },
  }, async () => ({ kind: 'allow' }))
  assert.equal(beforeParent.kind, 'ask')

  await gate.preStep({ agent: parent, messages: [human(userText)], turn: 7 }, async () => ({ kind: 'enter', messages: [] }))
  const run = (topic) => gate.preExecute({
    name: 'shrimp_run', agent: child,
    arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true, payload: { topic } },
  }, async () => ({ kind: 'allow' }))
  assert.equal((await run('资讯篇')).kind, 'allow')
  assert.equal((await run('总结篇')).kind, 'allow')
  assert.equal((await run('第三篇')).kind, 'ask')
  assert.equal(receiptStore.peek({ agentId: 'parent-agent-e2e', sessionId: 'session-parent', pipelineSlug: ARTICLE_PIPELINE.ref }).uses, 2)
})

test('结果型父授权支持子代理失败重试和成功幂等，两个文章项互相隔离', async () => {
  const clock = fakeClock()
  const receiptStore = new ShrimpAuthorizationReceipts({ ttlMs: 3_600_000, now: clock.now })
  const registry = new ShrimpRunRequestRegistry({ ttlMs: 3_600_000, now: clock.now })
  const gate = createShrimpAuthorizationGate({
    receipts: receiptStore,
    readCatalog: async () => CATALOG,
    now: clock.now,
    isSafeRepeat: (request) => registry.isSafeRepeat(request),
  })
  const userText = '用文章虾完成资讯和总结两篇并保存到公众号草稿箱'
  const parent = liveAgent('outcome-parent', 7)
  parent.session = { id: 'outcome-parent-session', events: [{ type: 'turn/start', data: { turn: 7 } }] }
  const child = liveAgent('outcome-child', 8)
  child.session = {
    id: 'outcome-child-session',
    origin: 'subagent',
    parentSession: 'outcome-parent-session',
    delegationDepth: 1,
    events: [{ type: 'turn/start', data: { turn: 8 } }],
  }

  await gate.preStep({ agent: child, messages: [human(userText)], turn: 8 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(receiptStore.peek({ agentId: child.id, sessionId: child.session.id, pipelineSlug: ARTICLE_PIPELINE.ref }), null)
  await gate.preStep({ agent: parent, messages: [human(userText)], turn: 7 }, async () => ({ kind: 'enter', messages: [] }))
  const authorization = receiptStore.peek({ agentId: parent.id, sessionId: parent.session.id, pipelineSlug: ARTICLE_PIPELINE.ref })
  assert.equal(authorization.batchCount, 2)
  assert.equal(authorization.itemMaxUses, 2)
  assert.equal(authorization.maxUses, 4)

  const attempts = new Map()
  const statuses = new Map()
  const launchKeys = []
  let launches = 0
  let turn = 8
  const invoke = async (topic) => {
    child.session.events = [{ type: 'turn/start', data: { turn: turn++ } }]
    const payload = { topic }
    const decision = await gate.preExecute({
      name: 'shrimp_run', agent: child,
      arguments: { pipelineSlug: ARTICLE_PIPELINE.ref, confirm: true, payload },
    }, async () => ({ kind: 'allow' }))
    if (decision.kind !== 'allow') return { decision }
    let runId = ''
    const requestKey = {
      agentId: child.id,
      sessionId: child.session.id,
      pipelineSlug: ARTICLE_PIPELINE.ref,
      payload,
      idempotencyKey: stableShrimpRunIdempotencyKey({ agentId: child.id, sessionId: child.session.id, turn, pipelineSlug: ARTICLE_PIPELINE.ref, payload }),
    }
    const result = await runShrimpWithDedupe({
      registry,
      requestKey,
      launch: async ({ idempotencyKey }) => {
        launches += 1
        launchKeys.push(idempotencyKey)
        const attempt = Number(attempts.get(topic) || 0) + 1
        attempts.set(topic, attempt)
        runId = `outcome-${topic}-${attempt}`
        const status = topic === '资讯' && attempt === 1 ? 'failed' : topic === '资讯' ? 'done' : 'failed'
        statuses.set(runId, status)
        return { ok: true, operation_id: `op-${runId}`, run_id: runId }
      },
      readSummary: async (id) => ({ ok: true, data: { id, status: statuses.get(id) } }),
      readArtifacts: async () => ({ ok: true, data: { total: 0, items: [] } }),
      timeoutMs: 0,
      pollIntervalMs: 0,
      sleep: clock.sleep,
      now: clock.now,
    })
    return { decision, result }
  }

  const firstArticle = await invoke('资讯')
  assert.equal(firstArticle.decision.kind, 'allow')
  assert.equal(firstArticle.result.final_status, 'failed')
  const retriedArticle = await invoke('资讯')
  assert.equal(retriedArticle.decision.kind, 'allow')
  assert.equal(retriedArticle.result.final_status, 'done')
  const repeatedSuccess = await invoke('资讯')
  assert.equal(repeatedSuccess.decision.kind, 'allow')
  assert.equal(repeatedSuccess.result.deduplicated, true)
  assert.equal(repeatedSuccess.result.final_status, 'done')
  assert.equal(attempts.get('资讯'), 2)
  assert.equal(launches, 2)
  assert.notEqual(launchKeys[0], launchKeys[1], '同一回合的失败重试必须使用新 idempotency key')

  const firstSummary = await invoke('总结')
  assert.equal(firstSummary.decision.kind, 'allow')
  assert.equal(firstSummary.result.final_status, 'failed')
  const secondSummary = await invoke('总结')
  assert.equal(secondSummary.decision.kind, 'allow')
  assert.equal(secondSummary.result.final_status, 'failed')
  assert.equal(attempts.get('总结'), 2)
  assert.equal(launches, 4, '两个文章项各自最多启动两次，成功项重复调用不新建')

  const thirdSummary = await invoke('总结')
  assert.equal(thirdSummary.decision.kind, 'ask')
  const extraItem = await invoke('多余')
  assert.equal(extraItem.decision.kind, 'ask', '超过授权批次项数也不能借额度运行')
  assert.equal(launches, 4)
  assert.equal(receiptStore.peek({ agentId: parent.id, sessionId: parent.session.id, pipelineSlug: ARTICLE_PIPELINE.ref }).uses, 4)
})

test('成功运行 receipt 按 payload、session 和 slug 隔离，并在 TTL 到期后释放', async () => {
  const clock = fakeClock()
  const registry = new ShrimpRunRequestRegistry({ ttlMs: 100, now: clock.now })
  const request = { agentId: 'agent-a', sessionId: 'session-a', pipelineSlug: ARTICLE_PIPELINE.ref, payload: { topic: '唯一主题' } }
  registry.remember({ ...request, runId: 'run-success', status: 'done', result: { ok: true, final_status: 'done', run_id: 'run-success' } })
  assert.equal(registry.isSafeRepeat(request), true)
  assert.equal(registry.isSafeRepeat({ ...request, payload: { topic: '另一个主题' } }), false)
  assert.equal(registry.isSafeRepeat({ ...request, sessionId: 'session-b' }), false)
  assert.equal(registry.isSafeRepeat({ ...request, pipelineSlug: 'shrimp-other' }), false)
  await clock.sleep(100)
  assert.equal(registry.isSafeRepeat(request), false)
})

test('常驻授权（standing auth）清单内 slug 免动词签发回执，否定语气与 confirm 门槛保留', async (t) => {
  const grants = readShrimpRunStandingAuth()
  const standingSlug = 'shrimp-c433b57dac59419d'
  if (!grants[standingSlug]) return t.skip('真实 ~/.dsh/shrimp-run-standing-auth.json 未包含白名单 slug，跳过')
  const clock = fakeClock()
  const receiptStore = new ShrimpAuthorizationReceipts({ ttlMs: 3_600_000, now: clock.now })
  const gate = createShrimpAuthorizationGate({
    receipts: receiptStore,
    readCatalog: async () => [{
      identity: 'pipeline',
      ref: standingSlug,
      display_name: '常驻@测试虾',
      lifecycle_status: 'published',
    }],
    now: clock.now,
  })
  const parent = liveAgent('standing-parent', 7)
  parent.session = { id: 'standing-parent-session', events: [{ type: 'turn/start', data: { turn: 7 } }] }

  // 无运行动词的普通消息也能为白名单 slug 签发常驻回执
  await gate.preStep({ agent: parent, messages: [human('帮我把常驻测试虾的产出整理一下')], turn: 7 }, async () => ({ kind: 'enter', messages: [] }))
  const receipt = receiptStore.peek({ agentId: parent.id, sessionId: parent.session.id, pipelineSlug: standingSlug })
  assert.ok(receipt, '白名单 slug 应免动词签发常驻回执')
  assert.equal(receipt.standing, true)
  assert.equal(receipt.maxUses, grants[standingSlug].maxUses || 10)

  // confirm=true 即可运行，无需消息点名目标（slug 白名单即授权凭证）
  const decision = await gate.preExecute({
    name: 'shrimp_run', agent: parent,
    arguments: { pipelineSlug: standingSlug, confirm: true, payload: { topic: '常驻授权一' } },
  }, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'allow')
  assert.equal(receiptStore.peek({ agentId: parent.id, sessionId: parent.session.id, pipelineSlug: standingSlug }).uses, 1)

  // 否定语气不签发新回执
  const negatedAgent = liveAgent('standing-negated', 8)
  negatedAgent.session = { id: 'standing-negated-session', events: [{ type: 'turn/start', data: { turn: 8 } }] }
  await gate.preStep({ agent: negatedAgent, messages: [human('先不要运行常驻测试虾')], turn: 8 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(receiptStore.peek({ agentId: negatedAgent.id, sessionId: negatedAgent.session.id, pipelineSlug: standingSlug }), null)

  // confirm 缺失仍被拦截
  const noConfirm = await gate.preExecute({
    name: 'shrimp_run', agent: parent,
    arguments: { pipelineSlug: standingSlug, payload: { topic: '常驻授权二' } },
  }, async () => ({ kind: 'allow' }))
  assert.equal(noConfirm.kind, 'ask')
})
