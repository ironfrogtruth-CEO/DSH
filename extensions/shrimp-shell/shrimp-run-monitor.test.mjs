import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  createShrimpAuthorizationGate,
  explicitShrimpRunIntent,
  extractShrimpRunId,
  findShrimpPipeline,
  findShrimpTarget,
  normalizeShrimpRunInputs,
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
  ref: 'shrimp-c433b57dac59419d',
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

test('真实两篇授权原句识别两项批次并签发两次额度', () => {
  const intent = explicitShrimpRunIntent([human('运行文章虾，连续产出资讯和总结两篇并保存到公众号草稿箱')])
  assert.equal(intent.explicit, true)
  assert.equal(intent.batchCount, 2)
  assert.equal(intent.maxUses, 2)
})

test('文章生产自然指令建立正确批次授权，历史描述、询问和维护指令不触发', () => {
  const direct = [
    ['升级了文章虾，试一下。一篇资讯，一篇关于过去12小时我们对大神升级的总结。', 2],
    ['用文章虾写一篇关于本周发布的文章。', 1],
    ['让文章@虾六答产出两篇文章并保存到草稿箱。', 2],
    ['交给文章虾生成并发布一篇文章。', 1],
    ['运行文章虾...；禁止直接调用 7843 API。', 1],
  ]
  for (const [text, batchCount] of direct) {
    const intent = explicitShrimpRunIntent([human(text)])
    assert.equal(intent.explicit, true, text)
    assert.equal(intent.batchCount, batchCount, text)
    assert.equal(intent.maxUses, batchCount, text)
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
    messages: [human('调用文章虾完成一次文章发布')],
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
    messages: [human('调用文章虾完成一次文章发布')],
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
    messages: [human('调用文章虾完成一次文章发布')],
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
    messages: [human('调用文章虾完成一次文章发布')],
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
