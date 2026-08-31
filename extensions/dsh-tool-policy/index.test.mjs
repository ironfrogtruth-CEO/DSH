import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  apply,
  avengersAgentRole,
  avengersParentToolDecision,
  classifyToolCall,
  createAvengersRequestListener,
  detachedBackgroundReason,
  effectiveAgentPreset,
  nextAvengersReasoningEffort,
  shrimpRunApiBypassReason,
  ToolPolicy,
} from './index.js'

function agent(preset, header = {}, events = [], root = {}) {
  return { session: { ...root, header: { agentPreset: preset, ...header }, events } }
}

test('Avengers role and parent execution gate are preset-scoped', async () => {
  const parent = agent('avengers')
  const child = agent('avengers', { origin: 'subagent', delegationDepth: 1 })
  const cyberMarcus = agent('reliable-development')

  assert.equal(avengersAgentRole(parent), 'parent')
  assert.equal(avengersAgentRole(child), 'child')
  assert.equal(avengersAgentRole(cyberMarcus), 'other')
  for (const name of ['avenger', 'list_agents', 'send_message', 'interrupt_agent', 'ask_user_question', 'skill', 'todo_write', 'memory_recall', 'memory_checkpoint', 'goal_first_state_get', 'goal_first_state_transition', 'exit_plan_mode']) {
    assert.equal(avengersParentToolDecision({ agent: parent, name }), undefined, name)
  }
  const denied = avengersParentToolDecision({ agent: parent, name: 'bash' })
  assert.deepEqual(denied, {
    kind: 'deny',
    code: 'AVENGERS_PARENT_EXECUTION_BLOCKED',
    reason: 'Avengers 主代理只负责目标、派单、监督和验收；请把 bash 直接分配给 avenger 子代理执行',
  })
  assert.equal(avengersParentToolDecision({ agent: child, name: 'bash' }), undefined)
  assert.equal(avengersParentToolDecision({ agent: cyberMarcus, name: 'bash' }), undefined)
})

test('effective preset follows live composition and latest selection event over a stale header', () => {
  const selectedCyberMarcus = agent('avengers', {}, [{ type: 'agent-preset/selected', data: { agentPreset: 'reliable-development' } }])
  assert.equal(effectiveAgentPreset(selectedCyberMarcus), 'reliable-development')
  assert.equal(avengersAgentRole(selectedCyberMarcus), 'other')
  assert.equal(avengersParentToolDecision({ agent: selectedCyberMarcus, name: 'bash' }), undefined)

  const selectedAvengers = agent('reliable-development', {}, [{ type: 'agent-preset/selected', data: { agentPreset: 'avengers' } }])
  assert.equal(effectiveAgentPreset(selectedAvengers), 'avengers')
  assert.equal(avengersAgentRole(selectedAvengers), 'parent')
  assert.equal(avengersParentToolDecision({ agent: selectedAvengers, name: 'bash' })?.code, 'AVENGERS_PARENT_EXECUTION_BLOCKED')

  const liveComposition = agent('avengers', {}, [{ type: 'agent-preset/selected', data: { agentPreset: 'avengers' } }])
  liveComposition.ctx = {
    get(name) {
      assert.equal(name, 'agentPresets')
      return { composedPreset: () => 'reliable-development' }
    },
  }
  assert.equal(effectiveAgentPreset(liveComposition), 'reliable-development')
  assert.equal(avengersAgentRole(liveComposition), 'other')

  const directComposition = agent('avengers')
  directComposition.ctx = { agentPresets: { composedPreset: () => 'reliable-development' } }
  assert.equal(effectiveAgentPreset(directComposition), 'reliable-development')
  assert.equal(avengersAgentRole(directComposition), 'other')
})

test('effective preset safely falls back when live composition is unavailable', () => {
  const fromDirectService = agent('avengers', {}, [{ type: 'agent-preset/selected', data: { agentPreset: 'reliable-development' } }])
  fromDirectService.ctx = { agentPresets: { composedPreset: () => { throw new Error('unavailable') } } }
  assert.equal(effectiveAgentPreset(fromDirectService), 'reliable-development')

  const fromHeader = agent('reliable-development')
  fromHeader.ctx = { get() { throw new Error('unavailable') } }
  assert.equal(effectiveAgentPreset(fromHeader), 'reliable-development')
})

test('live session root fields take precedence over conflicting headers for Avengers role', () => {
  const child = agent(
    'reliable-development',
    { origin: 'parent', delegationDepth: 0 },
    [],
    { agentPreset: 'avengers', origin: 'subagent', delegationDepth: 1, id: 'session-child' },
  )
  assert.equal(effectiveAgentPreset(child), 'avengers')
  assert.equal(avengersAgentRole(child), 'child')
  assert.equal(avengersParentToolDecision({ agent: child, name: 'shrimp_run' }), undefined)

  const parent = agent(
    'reliable-development',
    { origin: 'subagent', delegationDepth: 1 },
    [],
    { agentPreset: 'avengers', origin: 'parent', delegationDepth: 0, id: 'session-parent' },
  )
  assert.equal(effectiveAgentPreset(parent), 'avengers')
  assert.equal(avengersAgentRole(parent), 'parent')
  assert.equal(avengersParentToolDecision({ agent: parent, name: 'bash' })?.code, 'AVENGERS_PARENT_EXECUTION_BLOCKED')

  const cyberMarcus = agent(
    'avengers',
    { origin: 'parent', delegationDepth: 0 },
    [],
    { agentPreset: 'reliable-development', origin: 'subagent', delegationDepth: 1, id: 'session-cyber' },
  )
  assert.equal(effectiveAgentPreset(cyberMarcus), 'reliable-development')
  assert.equal(avengersAgentRole(cyberMarcus), 'other')
  assert.equal(avengersParentToolDecision({ agent: cyberMarcus, name: 'bash' }), undefined)
})

test('latest preset selection event supersedes creation-time session root preset', () => {
  const selectedCyberMarcus = agent(
    'avengers',
    { agentPreset: 'avengers' },
    [{ type: 'agent-preset/selected', data: { agentPreset: 'reliable-development' } }],
    { agentPreset: 'avengers' },
  )
  assert.equal(effectiveAgentPreset(selectedCyberMarcus), 'reliable-development')
  assert.equal(avengersAgentRole(selectedCyberMarcus), 'other')
  assert.equal(avengersParentToolDecision({ agent: selectedCyberMarcus, name: 'bash' }), undefined)

  const selectedAvengers = agent(
    'reliable-development',
    { agentPreset: 'reliable-development' },
    [{ type: 'agent-preset/selected', data: { agentPreset: 'avengers' } }],
    { agentPreset: 'reliable-development' },
  )
  assert.equal(effectiveAgentPreset(selectedAvengers), 'avengers')
  assert.equal(avengersAgentRole(selectedAvengers), 'parent')
  assert.equal(avengersParentToolDecision({ agent: selectedAvengers, name: 'bash' })?.code, 'AVENGERS_PARENT_EXECUTION_BLOCKED')
})

test('Avengers parent can inspect policy and shrimp state but cannot execute bash or shrimp_run', () => {
  const parent = agent('avengers')
  for (const name of [
    'policy_evaluate',
    'policy_metrics',
    'policy_list',
    'shrimp_list',
    'shrimp_match',
    'shrimp_knowledge_list',
    'shrimp_knowledge_search',
    'shrimp_run_status',
  ]) assert.equal(avengersParentToolDecision({ agent: parent, name }), undefined, name)
  for (const name of ['bash', 'shrimp_run', 'shrimp_create_draft', 'read', 'grep']) {
    assert.equal(avengersParentToolDecision({ agent: parent, name })?.code, 'AVENGERS_PARENT_EXECUTION_BLOCKED', name)
  }
  const child = agent('avengers', { origin: 'subagent', delegationDepth: 1 })
  assert.equal(avengersParentToolDecision({ agent: child, name: 'bash' }), undefined)
})

function routeAgent({ preset = 'avengers', role = 'child', parentSession = 'parent-session' } = {}) {
  const isChild = role === 'child'
  return agent(
    preset,
    { origin: isChild ? 'subagent' : 'parent', delegationDepth: isChild ? 1 : 0 },
    [],
    { id: `${role}-session`, parentSession },
  )
}

function goalStateStore(classification) {
  return { async load(sessionId) { return { sessionId, classification } } }
}

function modelResolver(efforts, calls = []) {
  return {
    async resolveModelInfo(provider, model) {
      calls.push({ provider, model })
      return efforts === null ? {} : { reasoning: { efforts } }
    },
  }
}

test('Avengers simple child inherits the fully resolved parent request unchanged', async () => {
  const calls = []
  const listener = createAvengersRequestListener({
    stateStore: goalStateStore('simple_direct'),
    llm: modelResolver([{ id: 'off' }, { id: 'low' }, { id: 'medium' }, { id: 'high' }], calls),
  })
  const inherited = { provider: 'ollama-local', model: 'cybermarcus:latest', reasoningEffort: 'low', maxTokens: 12_345, temperature: 0.2 }
  const child = await listener({ agent: routeAgent() }, async () => inherited)
  assert.deepEqual(child, inherited)
  assert.deepEqual(calls, [])
})

test('Avengers complex child raises reasoning exactly one actual supported level', async () => {
  const calls = []
  const listener = createAvengersRequestListener({
    stateStore: goalStateStore('sop_required'),
    llm: modelResolver([{ id: 'off' }, { id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'max' }], calls),
  })
  const inherited = { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'medium', maxTokens: 12_345, temperature: 0.2 }
  const child = await listener({ agent: routeAgent() }, async () => inherited)
  assert.deepEqual(child, { ...inherited, reasoningEffort: 'high' })
  assert.deepEqual(calls, [{ provider: inherited.provider, model: inherited.model }])
  assert.equal(inherited.reasoningEffort, 'medium')
})

test('Avengers complex child can raise from the exact model default when parent omitted an effort', async () => {
  const listener = createAvengersRequestListener({
    stateStore: goalStateStore('sop_required'),
    llm: {
      async resolveModelInfo() {
        return { reasoning: { defaultEffort: 'low', efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] } }
      },
    },
  })
  const inherited = { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 12_345 }
  assert.deepEqual(await listener({ agent: routeAgent() }, async () => inherited), { ...inherited, reasoningEffort: 'medium' })
})

test('Avengers complex child keeps max unchanged', async () => {
  const listener = createAvengersRequestListener({
    stateStore: goalStateStore('sop_required'),
    llm: modelResolver([{ id: 'off' }, { id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'max' }]),
  })
  const inherited = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max', maxTokens: 32_768 }
  assert.deepEqual(await listener({ agent: routeAgent() }, async () => inherited), inherited)
})

test('Avengers complex child skips unsupported intermediate levels', async () => {
  assert.equal(nextAvengersReasoningEffort('low', [{ id: 'low' }, { id: 'max' }]), 'max')
  const listener = createAvengersRequestListener({
    stateStore: goalStateStore('sop_required'),
    llm: modelResolver([{ id: 'low' }, { id: 'max' }]),
  })
  const inherited = { provider: 'zhipu-glm', model: 'glm-marcus:latest', reasoningEffort: 'low', maxTokens: 4_096 }
  assert.deepEqual(await listener({ agent: routeAgent() }, async () => inherited), { ...inherited, reasoningEffort: 'max' })
})

test('Avengers complex child leaves requests unchanged without reasoning or on capability loader failure', async () => {
  const noReasoning = createAvengersRequestListener({
    stateStore: goalStateStore('sop_required'),
    llm: modelResolver(null),
  })
  const inherited = { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'medium', maxTokens: 8_192 }
  assert.deepEqual(await noReasoning({ agent: routeAgent() }, async () => inherited), inherited)

  const loaderFailure = createAvengersRequestListener({
    stateStore: goalStateStore('sop_required'),
    llm: { async resolveModelInfo() { throw new Error('model loader unavailable') } },
  })
  assert.deepEqual(await loaderFailure({ agent: routeAgent() }, async () => inherited), inherited)

  const noEffort = { provider: 'deepseek-official', model: 'deepseek-chat', maxTokens: 8_192 }
  assert.deepEqual(await noReasoning({ agent: routeAgent() }, async () => noEffort), noEffort)
})

test('Avengers parent and CyberMarcus requests remain unchanged', async () => {
  const listener = createAvengersRequestListener({
    stateStore: goalStateStore('sop_required'),
    llm: modelResolver([{ id: 'off' }, { id: 'low' }, { id: 'medium' }, { id: 'high' }]),
  })
  const inherited = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'medium', maxTokens: 12_345 }
  assert.deepEqual(await listener({ agent: routeAgent({ role: 'parent' }) }, async () => inherited), inherited)
  assert.deepEqual(await listener({ agent: routeAgent({ preset: 'reliable-development' }) }, async () => inherited), inherited)
})

test('apply wires the injected model resolver and shared goal-first store into the Avengers listener', async () => {
  const listeners = new Map()
  const ctx = {
    llm: modelResolver([{ id: 'low' }, { id: 'medium' }, { id: 'high' }]),
    dshGoalFirstStateMachine: { store: goalStateStore('sop_required') },
    toolPolicyConfig: { mode: 'observe', operationMode: 'act' },
    tools: { register() {} },
    on(event, listener) { listeners.set(event, listener); return () => listeners.delete(event) },
    effect(factory) { return factory() },
    provide() {},
  }
  await apply(ctx)
  const inherited = { provider: 'ollama-local', model: 'glm-marcus:latest', reasoningEffort: 'low', maxTokens: 4_096 }
  const resolved = await listeners.get('agent/request')({ agent: routeAgent() }, async () => inherited)
  assert.deepEqual(resolved, { ...inherited, reasoningEffort: 'medium' })
})

test('classifier recognizes built-ins, unknown shell, and ignores content fields', async () => {
  assert.equal(classifyToolCall('git_commit', { message: 'ok' }).category, 'destructive')
  assert.ok(classifyToolCall('git_push', {}).categories.includes('external'))
  assert.equal(classifyToolCall('memory_forget', { dryRun: true }).category, 'read')
  assert.equal(classifyToolCall('memory_forget', { dryRun: false, confirm: true }).category, 'destructive')
  assert.equal(classifyToolCall('cross_session_rebuild', { dryRun: true }).category, 'read')
  assert.equal(classifyToolCall('cross_session_rebuild', { dryRun: false }).category, 'write')
  assert.equal(classifyToolCall('code_index_build', {}).category, 'write')
  assert.equal(classifyToolCall('frontend_diff', { writeFiles: true, path: 'out.html' }).category, 'write')
  const unknownShell = classifyToolCall('shell', { command: 'some-private-wrapper --run' })
  assert.equal(unknownShell.category, 'unknown')
  const contentOnly = classifyToolCall('memory_record', { content: 'rm -rf /; curl https://evil.example' })
  assert.equal(contentOnly.category, 'write')
  assert.equal(contentOnly.commandInspected, false)
})

test('detached background hard gate catches shell escape forms without false positives', () => {
  for (const syntax of [
    'nohup node worker.mjs > worker.log 2>&1 &',
    'disown %1',
    'setsid node worker.mjs',
    'sleep 30 &',
  ]) {
    const decision = detachedBackgroundReason('bash', { command: syntax, run_in_background: true })
    assert.deepEqual(decision, {
      kind: 'deny',
      reason: '后台任务必须移除脱管语法并使用 run_in_background: true；跨重启请使用 schedule/heartbeat/canonical run',
    })
  }
  assert.equal(detachedBackgroundReason('bash', { command: 'bash -lc "nohup node worker.mjs &"' }).kind, 'deny')
  assert.equal(detachedBackgroundReason('bash', { command: 'bash -lc "sleep 30 &"' }).kind, 'deny')
  assert.equal(detachedBackgroundReason('shell', { command: 'sh -c \'setsid node worker.mjs\'' }).kind, 'deny')
  assert.equal(detachedBackgroundReason('shell', { command: 'eval "sleep 30 &"' }).kind, 'deny')
  assert.equal(detachedBackgroundReason('bash', { command: 'echo first && echo second' }), undefined)
  assert.equal(detachedBackgroundReason('shell', { command: 'echo output &> /tmp/output.log' }), undefined)
  assert.equal(detachedBackgroundReason('bash', { command: 'echo output >& /tmp/output.log' }), undefined)
  assert.equal(detachedBackgroundReason('bash', { command: 'echo "nohup & disown setsid"' }), undefined)
  assert.equal(detachedBackgroundReason('bash', { command: "rg -n 'nohup|disown|setsid' ." }), undefined)
  assert.equal(detachedBackgroundReason('bash', { command: "printf '%s\\n' nohup disown setsid" }), undefined)
  assert.equal(detachedBackgroundReason('bash', { command: 'env MODE=prod nohup node worker.mjs' }).kind, 'deny')
  assert.equal(detachedBackgroundReason('bash', { command: 'sudo -n setsid node worker.mjs' }).kind, 'deny')
  assert.equal(detachedBackgroundReason('bash', { command: 'echo \\&' }), undefined)
  assert.equal(detachedBackgroundReason('bash', { command: 'echo nohup-wrapper' }), undefined)
  assert.equal(detachedBackgroundReason('python', { command: 'nohup python worker.py &' }), undefined)
  assert.equal(detachedBackgroundReason('bash', { description: 'nohup is only documentation' }), undefined)
})

test('shrimp run API bypass hard gate blocks shell POST/PUT forms but permits reads and non-shell tools', () => {
  const endpoint = 'http://127.0.0.1:7843/api/v1/pipelines/shrimp-c433b57dac59419d/runs'
  const legacyEndpoint = 'http://127.0.0.1:7843/api/pipelines/shrimp-c433b57dac59419d/run'
  const blocked = [
    ['bash', { command: `curl -sS -X POST ${endpoint} -d '{}'` }],
    ['shell', { command: `python -c "import requests; requests.post('${endpoint}', json={})"` }],
    ['command', { command: `python -c "from urllib.request import Request; Request('${legacyEndpoint}', method='PUT')"` }],
    ['exec', { argv: ['curl', '--request', 'PUT', legacyEndpoint] }],
    ['terminal', { command: `fetch('${endpoint}', { method: 'POST', body: '{}' })` }],
    ['dsh-command', { command: `http POST ${endpoint}` }],
  ]
  for (const [toolName, args] of blocked) {
    assert.deepEqual(shrimpRunApiBypassReason(toolName, args), {
      kind: 'deny',
      code: 'SHRIMP_RUN_API_BYPASS_BLOCKED',
      reason: '禁止通过 shell/bash/command 直接写入虾缸运行 API；请使用 shrimp_run 工具。',
    }, `${toolName}: ${JSON.stringify(args)}`)
  }

  const allowed = [
    ['bash', { command: 'curl -sS http://127.0.0.1:7843/health' }],
    ['bash', { command: 'curl -sS -X GET http://127.0.0.1:7843/api/v1/runs/run-1/summary' }],
    ['bash', { command: `python -c "import requests; requests.get('${endpoint}')"` }],
    ['bash', { command: 'curl -X POST http://127.0.0.1:7843/health -d \"{}\"' }],
    ['shrimp_run', { command: `curl -X POST ${endpoint}` }],
    ['article_runner', { command: `curl -X POST ${endpoint}` }],
  ]
  for (const [toolName, args] of allowed) assert.equal(shrimpRunApiBypassReason(toolName, args), undefined, `${toolName}: ${JSON.stringify(args)}`)
})

test('shrimp run API bypass is a global hard gate before Avengers role policy, including observe mode', async () => {
  const endpoint = 'http://127.0.0.1:7843/api/v1/pipelines/shrimp-c433b57dac59419d/runs'
  const listeners = new Map()
  const ctx = {
    toolPolicyConfig: { mode: 'observe', operationMode: 'act' },
    tools: { register() {} },
    on(event, listener) { listeners.set(event, listener); return () => listeners.delete(event) },
    effect(factory) { return factory() },
    provide() {},
  }
  await apply(ctx)
  const listener = listeners.get('tools/pre-execute')
  let nextCalls = 0
  const next = async () => { nextCalls += 1; return { kind: 'allow' } }
  const agents = [
    { session: { agentPreset: 'avengers', origin: 'parent' } },
    { session: { agentPreset: 'avengers', origin: 'subagent', parentSession: 'parent', delegationDepth: 1 } },
    { session: { agentPreset: 'reliable-development' } },
  ]
  for (const agentContext of agents) {
    const denied = await listener({ agent: agentContext, name: 'bash', arguments: { command: `curl -X POST ${endpoint}` } }, next)
    assert.deepEqual(denied, {
      kind: 'deny',
      code: 'SHRIMP_RUN_API_BYPASS_BLOCKED',
      reason: '禁止通过 shell/bash/command 直接写入虾缸运行 API；请使用 shrimp_run 工具。',
    })
  }
  const readOnly = await listener({ agent: agents[1], name: 'bash', arguments: { command: 'curl -X GET http://127.0.0.1:7843/api/v1/runs/run-1/summary' } }, next)
  assert.deepEqual(readOnly, { kind: 'allow' })
  assert.equal(nextCalls, 1)
})

test('operation modes and patterns produce explicit decisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-policy-root-'))
  try {
    const plan = new ToolPolicy({ mode: 'enforce', operationMode: 'plan', workspaceRoots: [root] })
    assert.equal(plan.evaluate('git_status', { path: root }).decision.kind, 'allow')
    assert.equal(plan.evaluate('git_commit', { path: root }).decision.kind, 'deny')
    assert.equal(plan.evaluate('fs_write', { path: root }).decision.kind, 'deny')
    assert.equal(plan.evaluate('shell', { command: 'mystery_command', cwd: root }).decision.kind, 'deny')
    const act = new ToolPolicy({ mode: 'enforce', operationMode: 'act', workspaceRoots: [root] })
    assert.equal(act.evaluate('git_commit', { path: root }).decision.kind, 'ask')
    assert.equal(act.evaluate('fs_write', { path: root }).decision.kind, 'allow')
    const configured = new ToolPolicy({ mode: 'enforce', operationMode: 'plan', allow: ['git_commit'], deny: ['git_status'], ask: ['shell'] })
    assert.equal(configured.evaluate('git_commit', {}).decision.kind, 'allow')
    assert.equal(configured.evaluate('git_status', {}).decision.kind, 'deny')
    assert.equal(configured.evaluate('shell', { command: 'pwd' }).decision.kind, 'ask')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('workspace path escapes deny and observe mode never blocks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-policy-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-policy-outside-'))
  try {
    const policy = new ToolPolicy({ mode: 'enforce', operationMode: 'act', workspaceRoots: [root] })
    const escaped = policy.evaluate('fs_write', { path: outside })
    assert.equal(escaped.classification.pathBoundary, 'outside')
    assert.equal(escaped.decision.kind, 'deny')
    const observe = new ToolPolicy({ mode: 'observe', operationMode: 'plan', workspaceRoots: [root] })
    const result = observe.evaluate('git_commit', { path: outside })
    assert.equal(result.decision.kind, 'deny')
    assert.equal(result.appliedDecision.kind, 'allow')
    assert.equal(result.observed, true)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('fake ctx enforce listener preserves next, ask/deny/allow and cleanup', async () => {
  const listeners = new Map()
  const disposers = []
  const tools = []
  const ctx = {
    toolPolicyConfig: { mode: 'enforce', operationMode: 'act' },
    tools: { register(tool) { tools.push(tool); return () => {} } },
    on(event, listener) { listeners.set(event, listener); return () => listeners.delete(event) },
    effect(factory) { const dispose = factory(); disposers.push(dispose); return dispose },
    provide() {},
  }
  await apply(ctx)
  assert.ok(tools.some((tool) => tool.name === 'policy_evaluate'))
  const listener = listeners.get('tools/pre-execute')
  assert.equal(typeof listener, 'function')
  let nextCalls = 0
  const next = async () => { nextCalls += 1; return { kind: 'allow' } }
  assert.deepEqual(await listener({ name: 'git_status', arguments: {} }, next), { kind: 'allow' })
  assert.equal(nextCalls, 1)
  assert.equal((await listener({ name: 'git_commit', arguments: {} }, next)).kind, 'ask')
  assert.equal((await listener({ name: 'shell', arguments: { command: 'mystery_command' } }, next)).kind, 'ask')
  const observeCtx = { ...ctx, toolPolicyConfig: { mode: 'observe', operationMode: 'plan' }, on(event, listener) { listeners.set(`observe:${event}`, listener); return () => listeners.delete(`observe:${event}`) } }
  await apply(observeCtx)
  const observe = listeners.get('observe:tools/pre-execute')
  assert.deepEqual(await observe({ name: 'git_commit', arguments: {} }, next), { kind: 'allow' })
  assert.ok(nextCalls >= 2)
  for (const dispose of disposers) if (typeof dispose === 'function') dispose()
  assert.equal(listeners.has('tools/pre-execute'), false)
  assert.equal(listeners.has('observe:tools/pre-execute'), false)
})

test('observe mode still hard-denies detached shell work, while explicit opt-out preserves observe behavior', async () => {
  const listeners = new Map()
  const tools = []
  const provided = {}
  const ctx = {
    toolPolicyConfig: { mode: 'observe', operationMode: 'act', blockDetachedBackground: true },
    tools: { register(tool) { tools.push(tool); return () => {} } },
    on(event, listener) { listeners.set(event, listener); return () => listeners.delete(event) },
    effect(factory) { return factory() },
    provide(name, value) { provided[name] = value },
  }
  await apply(ctx)
  const listener = listeners.get('tools/pre-execute')
  let nextCalls = 0
  const next = async () => { nextCalls += 1; return { kind: 'allow' } }
  const denied = await listener({ name: 'bash', arguments: { command: 'nohup node worker.mjs &' } }, next)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /run_in_background/)
  assert.equal(nextCalls, 0)
  const snapshot = provided.dshToolPolicy.policy.snapshot()
  assert.equal(snapshot.recent.at(-1).hardGate, 'detached-background')
  assert.equal(snapshot.recent.at(-1).decision, 'deny')

  const optOutListeners = new Map()
  const optOutCtx = {
    ...ctx,
    toolPolicyConfig: { mode: 'observe', operationMode: 'act', blockDetachedBackground: false },
    on(event, listener) { optOutListeners.set(event, listener); return () => optOutListeners.delete(event) },
  }
  await apply(optOutCtx)
  assert.deepEqual(await optOutListeners.get('tools/pre-execute')({ name: 'bash', arguments: { command: 'nohup node worker.mjs &' } }, next), { kind: 'allow' })
  assert.equal(nextCalls, 1)
})

test('explicit evaluate and in-memory metrics/list tools do not execute target tools', async () => {
  const tools = []
  const ctx = { toolPolicyConfig: { mode: 'observe', operationMode: 'review' }, tools: { register(tool) { tools.push(tool) } }, effect(factory) { return factory() }, on() { return () => {} }, provide() {} }
  await apply(ctx)
  const evaluate = tools.find((tool) => tool.name === 'policy_evaluate')
  const metrics = tools.find((tool) => tool.name === 'policy_metrics')
  const list = tools.find((tool) => tool.name === 'policy_list')
  const render = (tool, value) => {
    const text = tool.output.render({}, value)[0].text
    assert.ok(text.length <= 12_000)
    assert.doesNotMatch(text, /SUPER-SECRET|sk-test-secret|Bearer\s+[A-Za-z0-9]/i)
    return JSON.parse(text)
  }
  const first = await evaluate.execute({ toolName: 'git_commit', arguments: { command: 'curl -H "Authorization: Bearer SUPER-SECRET" --token=sk-test-secret' } })
  assert.equal(first.ok, true)
  assert.equal(first.result.decision.kind, 'deny')
  assert.equal(first.result.appliedDecision.kind, 'allow')
  const evaluated = render(evaluate, first)
  assert.equal(evaluated.result.decision.kind, 'deny')
  assert.equal(evaluated.result.classification.category, 'destructive')
  assert.ok(evaluated.result.classification.pathBoundary)
  assert.ok(Array.isArray(evaluated.result.classification.reasons))
  assert.equal(evaluated.result.argumentsRedacted, true)
  const detached = await evaluate.execute({ toolName: 'bash', arguments: { command: 'nohup node worker.mjs &' } })
  assert.equal(detached.ok, true)
  assert.equal(detached.result.decision.kind, 'deny')
  assert.equal(detached.result.appliedDecision.kind, 'deny')
  assert.equal(detached.result.hardGate, 'detached-background')
  const metricResult = await metrics.execute({ recentLimit: 10 })
  assert.equal(metricResult.ok, true)
  assert.ok(metricResult.metrics.metrics.total >= 1)
  const metricRendered = render(metrics, metricResult)
  assert.ok(metricRendered.metrics.metrics.total >= 1)
  const listed = await list.execute({})
  assert.equal(listed.ok, true)
  assert.equal(listed.policy.mode, 'observe')
  assert.equal(listed.policy.blockDetachedBackground, true)
  const listedRendered = render(list, listed)
  assert.equal(listedRendered.policy.mode, 'observe')
})

test('Cordis row config passed as apply second argument overrides ctx fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-policy-row-'))
  const listeners = new Map()
  const disposers = []
  const ctx = {
    toolPolicyConfig: { mode: 'observe', operationMode: 'act' },
    tools: { register() {} },
    on(event, listener) { listeners.set(event, listener); return () => listeners.delete(event) },
    effect(factory) { const dispose = factory(); disposers.push(dispose); return dispose },
    provide() {},
  }
  try {
    await apply(ctx, { mode: 'enforce', operationMode: 'plan', workspaceRoots: [root] })
    const next = async () => ({ kind: 'allow' })
    assert.equal((await listeners.get('tools/pre-execute')({ name: 'fs_write', arguments: { path: root } }, next)).kind, 'deny')
    for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    disposers.length = 0
    await apply(ctx, { mode: 'observe', operationMode: 'plan', workspaceRoots: [root] })
    assert.equal((await listeners.get('tools/pre-execute')({ name: 'fs_write', arguments: { path: root } }, next)).kind, 'allow')
  } finally {
    for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    await rm(root, { recursive: true, force: true })
  }
})
