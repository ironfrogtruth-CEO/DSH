import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, transitionParameters } from './index.js'
import { classifyTask, createInitialState, extractOutputContract, FAILURE_FINGERPRINT_KEYS, governanceForNode, renderStateContext, transitionState, validateStructureContract, validateWorkContract } from './machine.js'
import { GoalFirstStateStore } from './state-store.js'
import { enforceOneSentenceStream, rewriteOneSentenceChunks } from './stream-contract.js'
import { goalFirstCardTitle } from './tool-cards.js'
import { stableJsonChecksumV1, stableJsonStringifyV1 } from './stable-json.js'

const deployedRequire = createRequire(join(import.meta.dirname, '../../install/goal-first-schema-test.cjs'))
const { parameterSchemaSpecToJsonSchema } = deployedRequire('@deepseek-ai/dsh-tools')

function goalContract() {
  return {
    problem: '升级插件且不破坏现有功能',
    audienceAction: '维护者按节点执行并验收',
    deliverables: ['代码', '测试'],
    truthSources: ['仓库'],
    constraints: ['保留用户改动'],
    successCriteria: ['测试通过'],
    minimumDeliverable: '可回滚补丁',
    validation: ['聚焦测试'],
    rollbackPoints: ['修改前版本'],
  }
}

async function temporaryStore() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-goal-first-'))
  return { root, store: new GoalFirstStateStore(root), cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('classifier keeps one-sentence rewrite simple and routes risky plugin work to SOP', () => {
  assert.equal(classifyTask('把这句话改得自然一些，只给出改写后的句子。').classification, 'simple_direct')
  assert.equal(extractOutputContract('把这句话改得自然一些，只给出改写后的句子。').exactSentences, 1)
  const simple = createInitialState({ sessionId: 'simple', text: '把这句话改得自然一些，只给出改写后的句子。' })
  assert.equal(simple.governance, null)
  assert.match(renderStateContext(simple), /implicit_checks=truth,action,terminal/)
  assert.doesNotMatch(renderStateContext(simple), /province=|ministry=|gate=/)
  assert.equal(classifyTask('请升级这个插件，分阶段验收并提供回滚方案。').classification, 'sop_required')
  assert.deepEqual(extractOutputContract('只给一句，不要解释，用中文，20字以内。'), {
    exactSentences: 1,
    resultOnly: true,
    continuousUntilTerminal: false,
    silentUntilTerminal: false,
    format: null,
    language: 'zh',
    maxChars: 20,
    forbidden: ['解释'],
  })
})

test('output contract captures continuous final-delivery instructions without changing ordinary phased work', () => {
  const request = '明确要求产出，遇阻自行修复，只在最后交付完整过程与结论。'
  const contract = extractOutputContract(request)
  assert.equal(contract.continuousUntilTerminal, true)
  assert.equal(contract.silentUntilTerminal, true)
  for (const phrase of ['不要中途停', '一直执行到完成']) {
    const phraseContract = extractOutputContract(phrase)
    assert.equal(phraseContract.continuousUntilTerminal, true)
    assert.equal(phraseContract.silentUntilTerminal, false)
  }
  for (const phrase of ['跑通后再汇报', '只在最后交付', '最后告诉我', '只在完成后汇报']) {
    const phraseContract = extractOutputContract(phrase)
    assert.equal(phraseContract.continuousUntilTerminal, true)
    assert.equal(phraseContract.silentUntilTerminal, true)
  }
  const initial = createInitialState({ sessionId: 'continuous', text: request })
  const afterTransition = transitionState(initial, { action: 'record_goal', goalContract: goalContract() }, { turn: 1, sourceEventSeq: 1 })
  const sameTurn = renderStateContext(afterTransition, 1)
  assert.match(sameTurn, /continue executing the current node/i)
  assert.match(sameTurn, /may call goal_first_state_transition again using the current revision/i)
  assert.doesNotMatch(sameTurn, /Do not call goal_first_state_transition again in this turn/i)
  assert.doesNotMatch(sameTurn, /finish the response now/i)

  const phased = createInitialState({ sessionId: 'phased', text: '请分阶段执行这个升级方案，完成验收并提供回滚方案后逐阶段汇报并等待下一步。' })
  assert.equal(phased.outputContract.continuousUntilTerminal, false)
  assert.equal(phased.outputContract.silentUntilTerminal, false)
  const phasedAfterTransition = transitionState(phased, { action: 'record_goal', goalContract: goalContract() }, { turn: 1, sourceEventSeq: 1 })
  assert.match(renderStateContext(phasedAfterTransition, 1), /finish the response now/i)
})

test('deployed DSH schema compiler accepts the real transition tool parameters', () => {
  const schema = parameterSchemaSpecToJsonSchema(transitionParameters())
  assert.equal(schema.type, 'object')
  assert.equal(schema.properties.failureFingerprint.type, 'object')
  assert.equal(schema.properties.failureFingerprint.additionalProperties, true)
  assert.deepEqual(schema.required, ['expectedRevision', 'action'])
})

test('append-only store isolates sessions, replays after restart, ignores torn tail, and enforces CAS', async () => {
  const fixture = await temporaryStore()
  try {
    const a = await fixture.store.append('session-a', createInitialState({ sessionId: 'session-a', text: '复杂插件升级与回滚方案', sourceEventSeq: 4 }), 0)
    await fixture.store.append('session-b', createInitialState({ sessionId: 'session-b', text: '只给一句', sourceEventSeq: 2 }), 0)
    const reopened = new GoalFirstStateStore(fixture.root)
    assert.equal((await reopened.load('session-a')).taskFingerprint, a.taskFingerprint)
    assert.equal((await reopened.load('session-b')).classification, 'simple_direct')
    await assert.rejects(() => reopened.append('session-a', a, 0), /expected revision 0, current revision is 1/)
    await appendFile(reopened.file('session-a'), '{"torn":')
    assert.equal((await reopened.load('session-a')).revision, 1)
  } finally { await fixture.cleanup() }
})

test('state transition is sequential and validate gate controls export', () => {
  let state = createInitialState({ sessionId: 's', text: '实现复杂插件并测试导出', sourceEventSeq: 1 })
  let turn = 1
  assert.deepEqual(state.governance, governanceForNode('route'))
  assert.match(renderStateContext(state), /province=行动省; ministry=澄清部; gate=/)
  assert.match(renderStateContext(state, 1), /deliverables:string\[\]/)
  state = transitionState(state, { action: 'record_goal', goalContract: goalContract() }, { turn: 1, sourceEventSeq: 2 })
  assert.equal(state.currentNode, 'parse')
  assert.deepEqual(state.governance, governanceForNode('parse'))
  assert.match(renderStateContext(state, 1), /already been recorded in this turn/)
  assert.doesNotMatch(renderStateContext(state, 1), /Call goal_first_state_transition/)
  assert.throws(() => transitionState(state, { action: 'complete_node', node: 'parse', evidence: ['same-turn'] }, { turn: 1, sourceEventSeq: 3 }), /only one goal-first state transition is allowed per turn/)
  assert.throws(() => transitionState(state, { action: 'complete_node', node: 'structure', evidence: ['x'] }, { turn: ++turn, sourceEventSeq: 3 }), /cannot complete node structure/)
  for (const node of ['parse', 'structure', 'generate']) state = transitionState(state, { action: 'complete_node', node, evidence: [`${node} ok`], actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] }, { turn: ++turn, sourceEventSeq: 4 })
  const failed = transitionState(state, { action: 'complete_node', node: 'validate', evidence: ['failed check'], qaStatus: 'failed', rollbackTo: 'generate', reason: 'test failed' }, { turn: ++turn, sourceEventSeq: 5 })
  assert.equal(failed.phase, 'blocked')
  assert.equal(failed.rollbackTarget, 'generate')
  state = transitionState(state, { action: 'complete_node', node: 'validate', evidence: ['tests passed'], qaStatus: 'passed', qaChecks: ['unit'], actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] }, { turn: ++turn, sourceEventSeq: 5 })
  assert.equal(state.currentNode, 'export')
  assert.deepEqual(state.governance, governanceForNode('export'))
  state = transitionState(state, { action: 'complete_node', node: 'export', evidence: ['artifact hash'], actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] }, { turn: ++turn, sourceEventSeq: 6 })
  assert.equal(state.currentNode, 'review')
  assert.deepEqual(state.governance, governanceForNode('review'))
})

test('schemaVersion=1 snapshots without governance remain readable and rehydrate on transition', () => {
  const state = createInitialState({ sessionId: 'legacy', text: '实现复杂插件并测试导出', sourceEventSeq: 1 })
  delete state.governance
  assert.match(renderStateContext(state), /province=行动省; ministry=澄清部; gate=/)
  const resumed = transitionState(state, { action: 'record_goal', goalContract: goalContract() }, { turn: 1, sourceEventSeq: 2 })
  assert.deepEqual(resumed.governance, governanceForNode('parse'))
})

test('stream contract rewrites three alternatives to one consistent sentence and removes replay metadata', async () => {
  const text = '- 把能力建设做实，让协同真正形成闭环。\n- 以能力建设为支撑，推动协同。\n- 靠能力建设完成协同。'
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { id: 'r' }, blocks: [{ id: 'b' }] } },
  ]
  const rewritten = rewriteOneSentenceChunks(chunks)
  assert.equal(rewritten.changed, true)
  assert.equal(rewritten.text, '把能力建设做实，让协同真正形成闭环。')
  assert.equal(rewritten.chunks.find((chunk) => chunk.type === 'text-delta').text, rewritten.text)
  assert.equal(rewritten.chunks.find((chunk) => chunk.type === 'block-end').block.text, rewritten.text)
  assert.equal('replayState' in rewritten.chunks.find((chunk) => chunk.type === 'finish'), false)

  const toolChunks = [...chunks, { type: 'tool-call-delta', index: 1, id: 'c1', name: 'bash', argumentsDelta: '{}' }]
  assert.deepEqual(rewriteOneSentenceChunks(toolChunks).chunks, toolChunks)
  assert.deepEqual(rewriteOneSentenceChunks(chunks, 10).chunks, chunks)

  async function* source() { yield* chunks }
  const untouched = []
  for await (const chunk of enforceOneSentenceStream(source(), { exactSentences: null, resultOnly: false })) untouched.push(chunk)
  assert.deepEqual(untouched, chunks)
})

function fakeRuntime(root) {
  const listeners = new Map()
  const registered = []
  const sessions = new Map()
  let activeAgent = null
  const ctx = {
    tools: { register(spec) { registered.push(spec) } },
    agents: { requireInitiator() { if (!activeAgent) throw new Error('no initiator'); return activeAgent } },
    sessions: { get(id) { return sessions.get(id) } },
    on(name, listener) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(listener); return () => {} },
    provide() {},
  }
  const config = {
    root,
    defineTool: (spec) => spec,
    createUserMessage: (input) => ({ ...input, role: 'user', id: `m-${Math.random()}` }),
    isAgentLoopRequest: () => true,
  }
  return { ctx, config, listeners, registered, sessions, setAgent(agent) { activeAgent = agent } }
}

test('pre-step rehydrates missing continuous contract fields from the latest user text and goal contract', async () => {
  const fixture = await temporaryStore()
  try {
    const runtime = fakeRuntime(fixture.root)
    await apply(runtime.ctx, runtime.config)
    const events = [{ type: 'step/start', data: { turn: 2, step: 1 } }]
    const agent = { id: 'legacy-contract-session', session: { events, seq: 2 }, steer() {} }
    runtime.sessions.set(agent.id, agent.session)
    runtime.setAgent(agent)
    const store = new GoalFirstStateStore(fixture.root)
    const legacy = createInitialState({ sessionId: agent.id, text: '实现复杂插件并测试导出' })
    delete legacy.outputContract.continuousUntilTerminal
    delete legacy.outputContract.silentUntilTerminal
    legacy.outputContract.format = 'markdown'
    legacy.goalContract = { ...goalContract(), constraints: ['遇阻自行修复跑通，只在最后交付'] }
    legacy.qa = { status: 'not_run', checks: ['legacy-check'], evidence: ['legacy evidence'] }
    await store.append(agent.id, legacy, 0)
    const preStep = runtime.listeners.get('agent/pre-step')[0]
    const user = { role: 'user', id: 'legacy-user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续执行当前任务。' }] }
    await preStep({ agent, messages: [user], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [user] }))
    let state = await store.load(agent.id)
    assert.equal(state.outputContract.continuousUntilTerminal, true)
    assert.equal(state.outputContract.silentUntilTerminal, true)
    assert.equal(state.outputContract.format, 'markdown')
    assert.deepEqual(state.qa.evidence, ['legacy evidence'])
    assert.equal(state.revision, 2)
    assert.equal(state.sourceEventSeq, 1)
    const revision = state.revision

    await preStep({ agent, messages: [user], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [user] }))
    state = await store.load(agent.id)
    assert.equal(state.revision, revision)
  } finally { await fixture.cleanup() }
})

test('pre-step upgrades false continuous fields only from a new explicit instruction and fills ordinary legacy sessions with false once', async () => {
  const fixture = await temporaryStore()
  try {
    const runtime = fakeRuntime(fixture.root)
    await apply(runtime.ctx, runtime.config)
    const events = [{ type: 'step/start', data: { turn: 2, step: 1 } }]
    const agent = { id: 'upgrade-contract-session', session: { events, seq: 2 }, steer() {} }
    runtime.sessions.set(agent.id, agent.session)
    runtime.setAgent(agent)
    const store = new GoalFirstStateStore(fixture.root)
    const preStep = runtime.listeners.get('agent/pre-step')[0]
    const upgrade = createInitialState({ sessionId: agent.id, text: '实现复杂插件并测试导出' })
    upgrade.outputContract.continuousUntilTerminal = false
    upgrade.outputContract.silentUntilTerminal = false
    await store.append(agent.id, upgrade, 0)
    const upgradeUser = { role: 'user', id: 'upgrade-user', source: { kind: 'user' }, content: [{ type: 'text', text: '不要中途停，跑通后再汇报。' }] }
    await preStep({ agent, messages: [upgradeUser], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [upgradeUser] }))
    let state = await store.load(agent.id)
    assert.equal(state.outputContract.continuousUntilTerminal, true)
    assert.equal(state.outputContract.silentUntilTerminal, true)
    assert.equal(state.revision, 2)
    const upgradedRevision = state.revision
    await preStep({ agent, messages: [upgradeUser], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [upgradeUser] }))
    state = await store.load(agent.id)
    assert.equal(state.revision, upgradedRevision)
    const ordinaryUser = { role: 'user', id: 'ordinary-after-upgrade', source: { kind: 'user' }, content: [{ type: 'text', text: '继续当前节点并汇报阶段结果。' }] }
    await preStep({ agent, messages: [ordinaryUser], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [ordinaryUser] }))
    state = await store.load(agent.id)
    assert.equal(state.outputContract.continuousUntilTerminal, true)
    assert.equal(state.outputContract.silentUntilTerminal, true)
    assert.equal(state.revision, upgradedRevision)

    const ordinaryAgent = { id: 'ordinary-legacy-session', session: { events, seq: 2 }, steer() {} }
    runtime.sessions.set(ordinaryAgent.id, ordinaryAgent.session)
    runtime.setAgent(ordinaryAgent)
    const ordinary = createInitialState({ sessionId: ordinaryAgent.id, text: '实现复杂插件并测试导出' })
    delete ordinary.outputContract.continuousUntilTerminal
    delete ordinary.outputContract.silentUntilTerminal
    await store.append(ordinaryAgent.id, ordinary, 0)
    const ordinaryLegacyUser = { role: 'user', id: 'ordinary-user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续当前节点并汇报阶段结果。' }] }
    await preStep({ agent: ordinaryAgent, messages: [ordinaryLegacyUser], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [ordinaryLegacyUser] }))
    state = await store.load(ordinaryAgent.id)
    assert.equal(state.outputContract.continuousUntilTerminal, false)
    assert.equal(state.outputContract.silentUntilTerminal, false)
    assert.equal(state.revision, 2)
    const ordinaryRevision = state.revision
    await preStep({ agent: ordinaryAgent, messages: [ordinaryLegacyUser], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [ordinaryLegacyUser] }))
    state = await store.load(ordinaryAgent.id)
    assert.equal(state.revision, ordinaryRevision)
  } finally { await fixture.cleanup() }
})

test('Host hooks inject state, deny export before QA, steer once, then block', async () => {
  const fixture = await temporaryStore()
  try {
    const runtime = fakeRuntime(fixture.root)
    await apply(runtime.ctx, runtime.config)
    const events = [{ type: 'step/start', data: { turn: 1, step: 1 } }]
    const steers = []
    const agent = { id: 'host-session', session: { events, seq: 2 }, steer(message) { steers.push(message) } }
    runtime.sessions.set(agent.id, agent.session)
    runtime.setAgent(agent)
    const human = { role: 'user', id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '实现复杂插件，完成测试、验收与可回滚导出。' }] }
    const preStep = runtime.listeners.get('agent/pre-step')[0]
    const decision = await preStep({ agent, messages: [human], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [human] }))
    assert.equal(decision.messages.at(-1).source.plugin, 'dsh-goal-first-state-machine')
    const initial = await new GoalFirstStateStore(fixture.root).load(agent.id)
    assert.equal(initial.classification, 'sop_required')
    assert.deepEqual(initial.governance, governanceForNode('route'))
    assert.match(decision.messages.at(-1).content[0].text, /province=行动省; ministry=澄清部; gate=/)

    const preExecute = runtime.listeners.get('tools/pre-execute')[0]
    const denied = await preExecute({ agent, name: 'pdf_export', arguments: {} }, async () => ({ kind: 'allow' }))
    assert.equal(denied.kind, 'deny')

    const stopping = runtime.listeners.get('agent/turn-stopping')[0]
    await stopping({ agent, turn: 1, signal: new AbortController().signal })
    assert.equal(steers.length, 1)
    await stopping({ agent, turn: 1, signal: new AbortController().signal })
    const blocked = await new GoalFirstStateStore(fixture.root).load(agent.id)
    assert.equal(blocked.phase, 'blocked')
    assert.equal(blocked.failure.code, 'STATE_TRANSITION_MISSING')
  } finally { await fixture.cleanup() }
})

test('continuous Host hook steers after a same-turn transition and permits evidence-backed completion', async () => {
  const fixture = await temporaryStore()
  try {
    const runtime = fakeRuntime(fixture.root)
    await apply(runtime.ctx, runtime.config)
    const events = [{ type: 'step/start', data: { turn: 1, step: 1 } }]
    const steers = []
    const agent = { id: 'continuous-session', session: { events, seq: 2 }, steer(message) { steers.push(message) } }
    runtime.sessions.set(agent.id, agent.session)
    runtime.setAgent(agent)
    const human = { role: 'user', id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: '明确要求产出，遇阻自行修复，只在最后交付。' }] }
    const preStep = runtime.listeners.get('agent/pre-step')[0]
    await preStep({ agent, messages: [human], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [human] }))
    const store = new GoalFirstStateStore(fixture.root)
    let state = await store.load(agent.id)
    const transition = runtime.registered.find((tool) => tool.name === 'goal_first_state_transition')
    const result = await transition.execute({ expectedRevision: state.revision, action: 'record_goal', goalContract: goalContract() })
    assert.equal(result.ok, true)
    const stopping = runtime.listeners.get('agent/turn-stopping')[0]
    await stopping({ agent, turn: 1, signal: new AbortController().signal })
    assert.equal(steers.length, 1)
    assert.match(steers[0].content[0].text, /continue the current task/i)
    assert.match(steers[0].content[0].text, /call goal_first_state_transition for the next sequential node/i)
    state = await store.load(agent.id)
    assert.equal(state.phase, 'active')
    assert.equal(state.currentNode, 'parse')
    assert.equal(state.repair.attempts, 1)

    for (const node of ['parse', 'structure', 'generate']) {
      const next = await transition.execute({ expectedRevision: state.revision, action: 'complete_node', node, evidence: [`${node} ok`], actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] })
      assert.equal(next.ok, true)
      state = next.state
    }
    let next = await transition.execute({ expectedRevision: state.revision, action: 'complete_node', node: 'validate', evidence: ['qa ok'], qaStatus: 'passed', actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] })
    assert.equal(next.ok, true)
    state = next.state
    next = await transition.execute({ expectedRevision: state.revision, action: 'complete_node', node: 'export', evidence: ['artifact hash'], actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] })
    assert.equal(next.ok, true)
    state = next.state
    next = await transition.execute({ expectedRevision: state.revision, action: 'complete_node', node: 'review', evidence: ['final review complete'], actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] })
    assert.equal(next.ok, true)
    state = next.state
    assert.equal(state.phase, 'complete')
    await stopping({ agent, turn: 1, signal: new AbortController().signal })
    assert.equal(steers.length, 1)
  } finally { await fixture.cleanup() }
})

test('ordinary Host mode still permits the existing same-turn stop after one transition', async () => {
  const fixture = await temporaryStore()
  try {
    const runtime = fakeRuntime(fixture.root)
    await apply(runtime.ctx, runtime.config)
    const events = [{ type: 'step/start', data: { turn: 1, step: 1 } }]
    const steers = []
    const agent = { id: 'ordinary-session', session: { events, seq: 2 }, steer(message) { steers.push(message) } }
    runtime.sessions.set(agent.id, agent.session)
    runtime.setAgent(agent)
    const store = new GoalFirstStateStore(fixture.root)
    let state = await store.append(agent.id, createInitialState({ sessionId: agent.id, text: '实现复杂插件并测试导出' }), 0)
    const transition = runtime.registered.find((tool) => tool.name === 'goal_first_state_transition')
    const result = await transition.execute({ expectedRevision: state.revision, action: 'record_goal', goalContract: goalContract() })
    assert.equal(result.ok, true)
    const stopping = runtime.listeners.get('agent/turn-stopping')[0]
    await stopping({ agent, turn: 1, signal: new AbortController().signal })
    state = await store.load(agent.id)
    assert.equal(state.phase, 'active')
    assert.equal(steers.length, 0)
  } finally { await fixture.cleanup() }
})

test('Host transition tool enforces revision and QA-passed export gate allows execution', async () => {
  const fixture = await temporaryStore()
  try {
    const runtime = fakeRuntime(fixture.root)
    await apply(runtime.ctx, runtime.config)
    const agent = { id: 'tool-session', session: { events: [{ type: 'step/start', data: { turn: 2, step: 1 } }], seq: 3 }, steer() {} }
    runtime.sessions.set(agent.id, agent.session)
    runtime.setAgent(agent)
    const store = new GoalFirstStateStore(fixture.root)
    let state = await store.append(agent.id, createInitialState({ sessionId: agent.id, text: '复杂插件测试与导出', sourceEventSeq: 1 }), 0)
    const transition = runtime.registered.find((tool) => tool.name === 'goal_first_state_transition')
    let result = await transition.execute({ expectedRevision: state.revision, action: 'record_goal', goalContract: goalContract() })
    assert.equal(result.ok, true)
    assert.equal(result.state.currentNode, 'parse')
    const stale = await transition.execute({ expectedRevision: state.revision, action: 'complete_node', node: 'parse', evidence: ['ok'], actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] })
    assert.equal(stale.code, 'STATE_REVISION_CONFLICT')

    state = result.state
    let turn = 2
    for (const node of ['parse', 'structure', 'generate']) {
      turn += 1
      agent.session.events.push({ type: 'step/start', data: { turn, step: 1 } })
      result = await transition.execute({ expectedRevision: state.revision, action: 'complete_node', node, evidence: [`${node} ok`], actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] })
      state = result.state
    }
    turn += 1
    agent.session.events.push({ type: 'step/start', data: { turn, step: 1 } })
    result = await transition.execute({ expectedRevision: state.revision, action: 'complete_node', node: 'validate', evidence: ['qa ok'], qaStatus: 'passed', actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] })
    state = result.state
    const preExecute = runtime.listeners.get('tools/pre-execute')[0]
    const allowed = await preExecute({ agent, name: 'pdf_export', arguments: {} }, async () => ({ kind: 'allow' }))
    assert.equal(allowed.kind, 'allow')
  } finally { await fixture.cleanup() }
})

function validWorkContract() {
  return {
    schema: 'cybermarcus_work_contract.v1',
    goal_contract: { problem: 'p', audience_action: 'a', deliverables: ['d'], minimum_deliverable: 'm' },
    source_contract: { truth_sources: [], derived_outputs: [], debug_notes: [], pollution_risks: [], knowledge_versions: [] },
    output_contract: {},
    production_blueprint: { task_mode: 'one_off_complex', nodes: [{ node_id: 'n', goal: 'g', dependencies: [], inputs: [], outputs: ['o'], qa_gate: {}, rollback_to: null }] },
    qa_contract: { node_gates: [], final_acceptance: [], release_conditions: [] },
    recovery_contract: { rollback_points: ['r'], max_retries: 1, failure_fingerprint_fields: ['node'] },
    lineage: {},
  }
}

test('stable-json v1 canonicalizes the F1 fixture with the exact anchor checksum', () => {
  const input = { b: [3, 1, 2], a: '张三', n: { z: true, y: null, x: -1.5 }, arr: [{ k: 2, j: '甲' }, { k: 1, j: '乙' }] }
  assert.equal(stableJsonStringifyV1(input), '{"a":"张三","arr":[{"j":"甲","k":2},{"j":"乙","k":1}],"b":[3,1,2],"n":{"x":-1.5,"y":null,"z":true}}')
  assert.equal(stableJsonChecksumV1(input), 'f517ca29dc2763987e6746056240404ac6a36b9d0f7a5e24b431ba4cd55f1f68')
})

test('stable-json v1 canonicalizes the F2 fixture with integer floats, -0 and raw UTF-8', () => {
  const input = { p: 2.0, q: -0.0, s: '换行\n引号"', u: 'emoji🦐' }
  assert.equal(stableJsonStringifyV1(input), '{"p":2,"q":0,"s":"换行\\n引号\\"","u":"emoji🦐"}')
  assert.equal(stableJsonChecksumV1(input), 'c6c127cd354b72d642bd2a0e9140c81eb0231bac27be6dfdb9a83a13fa507ce0')
})

test('createInitialState carries the four production-contract fields with null/empty defaults', () => {
  const state = createInitialState({ sessionId: 'init-fields', text: '实现复杂插件并测试导出', sourceEventSeq: 1 })
  assert.equal(state.workContract, null)
  assert.equal(state.structureContract, null)
  assert.equal(state.workContractRef, null)
  assert.deepEqual(state.productionReceipts, [])
})

test('record_goal persists a route production receipt into the JSONL store', async () => {
  const fixture = await temporaryStore()
  try {
    const store = fixture.store
    let state = await store.append('receipt-session', createInitialState({ sessionId: 'receipt-session', text: '实现复杂插件并测试导出', sourceEventSeq: 1 }), 0)
    state = await store.append('receipt-session', transitionState(state, { action: 'record_goal', goalContract: goalContract() }, { turn: 1, sourceEventSeq: 2 }), state.revision)
    assert.equal(state.productionReceipts.length, 1)
    const receipt = state.productionReceipts[0]
    assert.equal(receipt.schema, 'production_receipt.v1')
    assert.equal(receipt.node_id, 'route')
    assert.equal(receipt.status, 'completed')
    assert.equal(receipt.input_checksum, state.taskFingerprint)
    assert.equal(receipt.version_refs.schemaVersion, 1)
    assert.deepEqual(receipt.qa_result, { status: 'passed', checks: ['goal contract recorded'] })
    assert.equal(receipt.evidence.length, 1)
    assert.equal(receipt.failure_fingerprint, null)
    assert.equal(receipt.rollback_to, null)
    const reopened = new GoalFirstStateStore(fixture.root)
    const persisted = await reopened.load('receipt-session')
    assert.equal(persisted.productionReceipts.length, 1)
    assert.equal(persisted.productionReceipts[0].node_id, 'route')
    assert.equal(persisted.productionReceipts[0].input_checksum, persisted.taskFingerprint)
  } finally { await fixture.cleanup() }
})

test('complete_node appends isomorphic receipts and validate failure records a blocked receipt', () => {
  let state = createInitialState({ sessionId: 'receipt-nodes', text: '实现复杂插件并测试导出', sourceEventSeq: 1 })
  state = transitionState(state, { action: 'record_goal', goalContract: goalContract() }, { turn: 1, sourceEventSeq: 2 })
  state = transitionState(state, { action: 'complete_node', node: 'parse', evidence: ['source map locked'], actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] }, { turn: 2, sourceEventSeq: 3 })
  assert.equal(state.productionReceipts.length, 2)
  const parseReceipt = state.productionReceipts[1]
  assert.equal(parseReceipt.node_id, 'parse')
  assert.equal(parseReceipt.status, 'completed')
  assert.equal(parseReceipt.qa_result.status, 'passed')
  assert.ok(parseReceipt.evidence.length >= 1)
  state = transitionState(state, { action: 'complete_node', node: 'structure', evidence: ['blueprint locked'], actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] }, { turn: 3, sourceEventSeq: 4 })
  state = transitionState(state, { action: 'complete_node', node: 'generate', evidence: ['artifact built'], actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] }, { turn: 4, sourceEventSeq: 5 })
  const failed = transitionState(state, { action: 'complete_node', node: 'validate', evidence: ['qa evidence'], qaStatus: 'failed', qaChecks: ['unit'], rollbackTo: 'generate', reason: 'test failed' }, { turn: 5, sourceEventSeq: 6 })
  const blockedReceipt = failed.productionReceipts.at(-1)
  assert.equal(blockedReceipt.node_id, 'validate')
  assert.equal(blockedReceipt.status, 'blocked')
  assert.equal(blockedReceipt.qa_result.status, 'failed')
  assert.equal(blockedReceipt.rollback_to, 'generate')
  assert.ok(blockedReceipt.failure_fingerprint)
})

test('structure validates workContract, stores its checksum, and blocks unconfirmed entry into generate', () => {
  let state = createInitialState({ sessionId: 'work-contract', text: '实现复杂插件并测试导出', sourceEventSeq: 1 })
  state = transitionState(state, { action: 'record_goal', goalContract: goalContract() }, { turn: 1, sourceEventSeq: 2 })
  state = transitionState(state, { action: 'complete_node', node: 'parse', evidence: ['ok'], actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] }, { turn: 2, sourceEventSeq: 3 })
  assert.throws(
    () => transitionState(state, { action: 'complete_node', node: 'structure', evidence: ['ok'], workContract: { schema: 'wrong' } }, { turn: 3, sourceEventSeq: 4 }),
    (error) => error.code === 'WORK_CONTRACT_INVALID',
  )
  const missingKey = validWorkContract()
  delete missingKey.lineage
  assert.throws(
    () => transitionState(state, { action: 'complete_node', node: 'structure', evidence: ['ok'], workContract: missingKey }, { turn: 3, sourceEventSeq: 4 }),
    (error) => error.code === 'WORK_CONTRACT_INVALID',
  )
  assert.throws(
    () => transitionState(state, { action: 'complete_node', node: 'structure', evidence: ['ok'], workContract: validWorkContract(), confirm: false }, { turn: 3, sourceEventSeq: 4 }),
    (error) => error.code === 'WORK_CONTRACT_NOT_CONFIRMED',
  )
  state = transitionState(state, { action: 'complete_node', node: 'structure', evidence: ['ok'], workContract: validWorkContract(), confirm: true, actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] }, { turn: 3, sourceEventSeq: 4 })
  assert.equal(state.currentNode, 'generate')
  assert.deepEqual(state.workContract, validWorkContract())
  assert.equal(state.workContractChecksum, stableJsonChecksumV1(validWorkContract()))
  assert.equal(state.workContractChecksum.length, 64)
  assert.equal(state.blueprintConfirmed, true)
})

test('structureContract validation rejects bad version and malformed ref, and records valid refs', () => {
  let state = createInitialState({ sessionId: 'structure-contract', text: '实现复杂插件并测试导出', sourceEventSeq: 1 })
  state = transitionState(state, { action: 'record_goal', goalContract: goalContract() }, { turn: 1, sourceEventSeq: 2 })
  state = transitionState(state, { action: 'complete_node', node: 'parse', evidence: ['ok'], actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] }, { turn: 2, sourceEventSeq: 3 })
  assert.throws(
    () => transitionState(state, { action: 'complete_node', node: 'structure', evidence: ['ok'], structureContract: { contract_version: 0 } }, { turn: 3, sourceEventSeq: 4 }),
    (error) => error.code === 'STRUCTURE_CONTRACT_INVALID',
  )
  assert.throws(
    () => transitionState(state, { action: 'complete_node', node: 'structure', evidence: ['ok'], structureContract: { contract_version: 1, ref: { uri: 'x' } } }, { turn: 3, sourceEventSeq: 4 }),
    (error) => error.code === 'STRUCTURE_CONTRACT_INVALID',
  )
  assert.throws(
    () => validateWorkContract('not-an-object'),
    (error) => error.code === 'WORK_CONTRACT_INVALID',
  )
  assert.throws(
    () => validateStructureContract({ contract_version: -1 }),
    (error) => error.code === 'STRUCTURE_CONTRACT_INVALID',
  )
  state = transitionState(state, { action: 'complete_node', node: 'structure', evidence: ['ok'], structureContract: { contract_version: 2, ref: { uri: 'file://blueprint.json', sha256: 'a'.repeat(64) } }, actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] }, { turn: 3, sourceEventSeq: 4 })
  assert.equal(state.currentNode, 'generate')
  assert.deepEqual(state.structureContract, { contract_version: 2, ref: { uri: 'file://blueprint.json', sha256: 'a'.repeat(64) } })
  assert.equal(state.workContractRef, null)
})

test('renderStateContext appends work_contract, blueprint, and receipts to the SOP overlay', () => {
  let state = createInitialState({ sessionId: 'render-contract', text: '实现复杂插件并测试导出', sourceEventSeq: 1 })
  assert.match(renderStateContext(state), /work_contract=none; blueprint=none; receipts=0/)
  state = transitionState(state, { action: 'record_goal', goalContract: goalContract() }, { turn: 1, sourceEventSeq: 2 })
  assert.match(renderStateContext(state), /receipts=1/)
  state = transitionState(state, { action: 'complete_node', node: 'parse', evidence: ['ok'], actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] }, { turn: 2, sourceEventSeq: 3 })
  state = transitionState(state, { action: 'complete_node', node: 'structure', evidence: ['ok'], workContract: validWorkContract(), confirm: true, structureContract: { contract_version: 1, text: 'plan' }, actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] }, { turn: 3, sourceEventSeq: 4 })
  const context = renderStateContext(state)
  assert.match(context, /work_contract=[0-9a-f]{8}; blueprint=confirmed; receipts=3/)
  const draft = { ...state, workContract: null, workContractChecksum: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', blueprintConfirmed: false }
  assert.match(renderStateContext(draft), /work_contract=01234567; blueprint=draft; receipts=3/)
})

test('tool cards map every action and node to Chinese titles and wire into presentCall', async () => {
  assert.equal(goalFirstCardTitle('get'), '读取工作合同')
  assert.equal(goalFirstCardTitle('record_goal'), '建立目标合同')
  assert.equal(goalFirstCardTitle('complete_node', 'parse'), '核对真源')
  assert.equal(goalFirstCardTitle('complete_node', 'structure'), '锁定生产蓝图')
  assert.equal(goalFirstCardTitle('complete_node', 'generate'), '按蓝图执行')
  assert.equal(goalFirstCardTitle('complete_node', 'validate'), '执行QA')
  assert.equal(goalFirstCardTitle('complete_node', 'export'), '交付产出')
  assert.equal(goalFirstCardTitle('complete_node', 'review'), '复盘核对')
  assert.equal(goalFirstCardTitle('pause'), '暂停待确认')
  assert.equal(goalFirstCardTitle('block'), '阻断回滚')
  assert.equal(goalFirstCardTitle('resume'), '恢复执行')
  assert.equal(goalFirstCardTitle('complete_node', 'unknown'), 'Goal-first 状态迁移')
  assert.equal(goalFirstCardTitle('mystery'), 'Goal-first 状态迁移')
  const fixture = await temporaryStore()
  try {
    const runtime = fakeRuntime(fixture.root)
    await apply(runtime.ctx, runtime.config)
    const getTool = runtime.registered.find((tool) => tool.name === 'goal_first_state_get')
    assert.deepEqual(getTool.presentCall(), { card: 'generic', title: '读取工作合同' })
    const transitionTool = runtime.registered.find((tool) => tool.name === 'goal_first_state_transition')
    assert.deepEqual(transitionTool.presentCall({ action: 'complete_node', node: 'structure' }), { card: 'generic', title: '锁定生产蓝图' })
    assert.deepEqual(transitionTool.presentCall({ action: 'record_goal' }), { card: 'generic', title: '建立目标合同' })
  } finally { await fixture.cleanup() }
})

test('structure write gate allows read-only and diagnostic tool calls', async () => {
  const fixture = await temporaryStore()
  try {
    const runtime = fakeRuntime(fixture.root)
    await apply(runtime.ctx, runtime.config)
    const agent = { id: 'gate-allow-session', session: { events: [{ type: 'step/start', data: { turn: 1, step: 1 } }], seq: 2 }, steer() {} }
    runtime.sessions.set(agent.id, agent.session)
    runtime.setAgent(agent)
    const store = new GoalFirstStateStore(fixture.root)
    await store.append(agent.id, createInitialState({ sessionId: agent.id, text: '实现复杂插件并测试导出', sourceEventSeq: 1 }), 0)
    const preExecute = runtime.listeners.get('tools/pre-execute')[0]
    const allowed = [
      { name: 'read', arguments: { file_path: '/x' } },
      { name: 'goal_first_state_get', arguments: {} },
      { name: 'bash', arguments: { command: 'git status' } },
      { name: 'bash', arguments: { command: 'pytest -q' } },
      { name: 'bash', arguments: { command: 'node --test x.test.mjs' } },
      { name: 'bash', arguments: { command: 'git log --oneline | tail -5' } },
      { name: 'bash', arguments: { command: 'sqlite3 "file:db.sqlite?mode=ro" "SELECT 1"' } },
    ]
    for (const exec of allowed) {
      const decision = await preExecute({ agent, ...exec }, async () => ({ kind: 'allow' }))
      assert.equal(decision.kind, 'allow', `${exec.name} ${JSON.stringify(exec.arguments)} must be allowed`)
    }
  } finally { await fixture.cleanup() }
})

test('structure write gate blocks mutating tools and write-style bash with STRUCTURE_WRITE_BLOCKED', async () => {
  const fixture = await temporaryStore()
  try {
    const runtime = fakeRuntime(fixture.root)
    await apply(runtime.ctx, runtime.config)
    const agent = { id: 'gate-deny-session', session: { events: [{ type: 'step/start', data: { turn: 1, step: 1 } }], seq: 2 }, steer() {} }
    runtime.sessions.set(agent.id, agent.session)
    runtime.setAgent(agent)
    const store = new GoalFirstStateStore(fixture.root)
    await store.append(agent.id, createInitialState({ sessionId: agent.id, text: '实现复杂插件并测试导出', sourceEventSeq: 1 }), 0)
    const preExecute = runtime.listeners.get('tools/pre-execute')[0]
    const blocked = [
      { name: 'edit', arguments: { file_path: '/x' } },
      { name: 'write', arguments: { file_path: '/x' } },
      { name: 'str_replace_editor', arguments: { file_path: '/x' } },
      { name: 'bash', arguments: { command: 'echo x > /tmp/a.txt' } },
      { name: 'bash', arguments: { command: 'sed -i s/a/b/ f.txt' } },
      { name: 'bash', arguments: { command: 'rm -rf /tmp/x' } },
      { name: 'bash', arguments: { command: 'git commit -m x' } },
    ]
    for (const exec of blocked) {
      const decision = await preExecute({ agent, ...exec }, async () => ({ kind: 'allow' }))
      assert.equal(decision.kind, 'deny', `${exec.name} ${JSON.stringify(exec.arguments)} must be denied`)
      assert.equal(decision.code, 'STRUCTURE_WRITE_BLOCKED')
    }
  } finally { await fixture.cleanup() }
})

test('production receipts cap at 50 and drop the oldest', () => {
  let state = createInitialState({ sessionId: 'receipt-cap', text: '实现复杂插件并测试导出', sourceEventSeq: 1 })
  state = transitionState(state, { action: 'record_goal', goalContract: goalContract() }, { turn: 1, sourceEventSeq: 2 })
  state = { ...state, productionReceipts: Array.from({ length: 50 }, (_, index) => ({ node_id: `seed-${index}` })) }
  state = transitionState(state, { action: 'complete_node', node: 'parse', evidence: ['ok'], actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] }, { turn: 2, sourceEventSeq: 3 })
  assert.equal(state.productionReceipts.length, 50)
  assert.equal(state.productionReceipts[0].node_id, 'seed-1')
  assert.equal(state.productionReceipts.at(-1).node_id, 'parse')
})

test('pre-step rehydrates missing production-contract fields together with output fields in one append', async () => {
  const fixture = await temporaryStore()
  try {
    const runtime = fakeRuntime(fixture.root)
    await apply(runtime.ctx, runtime.config)
    const events = [{ type: 'step/start', data: { turn: 2, step: 1 } }]
    const agent = { id: 'legacy-contract-fields', session: { events, seq: 2 }, steer() {} }
    runtime.sessions.set(agent.id, agent.session)
    runtime.setAgent(agent)
    const store = new GoalFirstStateStore(fixture.root)
    const legacy = createInitialState({ sessionId: agent.id, text: '实现复杂插件并测试导出' })
    delete legacy.outputContract.continuousUntilTerminal
    delete legacy.outputContract.silentUntilTerminal
    delete legacy.workContract
    delete legacy.structureContract
    delete legacy.workContractRef
    delete legacy.productionReceipts
    await store.append(agent.id, legacy, 0)
    const preStep = runtime.listeners.get('agent/pre-step')[0]
    const user = { role: 'user', id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: '继续执行当前任务。' }] }
    await preStep({ agent, messages: [user], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [user] }))
    const state = await store.load(agent.id)
    assert.equal(state.revision, 2)
    assert.equal(state.workContract, null)
    assert.equal(state.structureContract, null)
    assert.equal(state.workContractRef, null)
    assert.deepEqual(state.productionReceipts, [])
    assert.equal(state.outputContract.continuousUntilTerminal, false)
    assert.equal(state.outputContract.silentUntilTerminal, false)
  } finally { await fixture.cleanup() }
})

test('validate failure receipt persists a structured eight-key failure_fingerprint readable from JSONL', async () => {
  const fixture = await temporaryStore()
  try {
    const store = fixture.store
    let state = await store.append('fingerprint-session', createInitialState({ sessionId: 'fingerprint-session', text: '实现复杂插件并测试导出', sourceEventSeq: 1 }), 0)
    state = await store.append('fingerprint-session', transitionState(state, { action: 'record_goal', goalContract: goalContract() }, { turn: 1, sourceEventSeq: 2 }), state.revision)
    let turn = 1
    for (const node of ['parse', 'structure', 'generate']) {
      turn += 1
      state = await store.append('fingerprint-session', transitionState(state, { action: 'complete_node', node, evidence: [`${node} ok`], actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] }, { turn, sourceEventSeq: 3 }), state.revision)
    }
    turn += 1
    state = await store.append('fingerprint-session', transitionState(state, { action: 'complete_node', node: 'validate', evidence: ['qa failed'], qaStatus: 'failed', qaChecks: ['unit'], rollbackTo: 'generate', reason: 'test failed', actualBindings: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, artifacts: [{ name: 'qa-report', checksum: 'sha256:qa' }] }, { turn, sourceEventSeq: 4 }), state.revision)
    assert.equal(state.phase, 'blocked')
    const receipt = state.productionReceipts.at(-1)
    assert.equal(receipt.status, 'blocked')
    assert.equal(receipt.rollback_to, 'generate')
    assert.equal(typeof receipt.failure_fingerprint, 'string')
    const parsed = JSON.parse(receipt.failure_fingerprint)
    assert.deepEqual(Object.keys(parsed).sort(), [...FAILURE_FINGERPRINT_KEYS].sort())
    assert.equal(parsed.input_checksum, state.taskFingerprint)
    assert.equal(parsed.contract_checksum, 'none')
    assert.equal(parsed.provider_model, 'deepseek-official/deepseek-v4-flash')
    assert.equal(parsed.node_id, 'validate')
    assert.equal(parsed.error_code, 'QA_FAILED')
    assert.deepEqual(parsed.artifact_checksums, ['sha256:qa'])
    assert.ok(parsed.workflow_version)
    assert.ok(parsed.capability_version)
    const reopened = new GoalFirstStateStore(fixture.root)
    const persisted = await reopened.load('fingerprint-session')
    const persistedReceipt = persisted.productionReceipts.at(-1)
    assert.equal(typeof persistedReceipt.failure_fingerprint, 'string')
    assert.deepEqual(JSON.parse(persistedReceipt.failure_fingerprint), parsed)
    assert.equal(persistedReceipt.input_checksum, persisted.taskFingerprint)
    const passingState = transitionState(
      { ...state, phase: 'active', nodes: { ...state.nodes, validate: 'in_progress' }, rollbackTarget: null, failure: null },
      { action: 'complete_node', node: 'validate', evidence: ['tests passed'], qaStatus: 'passed', qaChecks: ['unit'], actualBindings: { skills: ['test-skill'], execution: 'test_deterministic' }, artifacts: [{ name: 'test-artifact', checksum: 'sha256:test' }] },
      { turn: turn + 1, sourceEventSeq: 5 },
    )
    assert.equal(passingState.productionReceipts.at(-1).failure_fingerprint, null)
  } finally { await fixture.cleanup() }
})

test('transition tool parameter schema keeps failureFingerprint as a plain object with no type arrays anywhere', () => {
  const params = transitionParameters()
  assert.equal(params.failureFingerprint.type, 'object')
  assert.equal(Array.isArray(params.failureFingerprint.type), false)
  for (const [name, spec] of Object.entries(params)) {
    assert.equal(Array.isArray(spec.type), false, `parameter ${name} must not use a type array`)
    assert.ok(['object', 'string', 'integer', 'number', 'boolean', 'array'].includes(spec.type), `parameter ${name} has unsupported type ${spec.type}`)
  }
  const schema = parameterSchemaSpecToJsonSchema(params)
  assert.equal(schema.type, 'object')
  assert.equal(schema.properties.failureFingerprint.type, 'object')
})

test('block transition appends a blocked receipt carrying the structured failure fingerprint', () => {
  let state = createInitialState({ sessionId: 'block-receipt', text: '实现复杂插件并测试导出', sourceEventSeq: 1 })
  state = transitionState(state, { action: 'record_goal', goalContract: goalContract() }, { turn: 1, sourceEventSeq: 2 })
  state = transitionState(state, { action: 'block', rollbackTo: 'route', code: 'MISSING_SOURCE', reason: 'truth source unavailable', evidence: ['missing source'], failureFingerprint: { error_code: 'MISSING_SOURCE', provider_model: 'none' } }, { turn: 2, sourceEventSeq: 3 })
  assert.equal(state.phase, 'blocked')
  assert.equal(state.failure.code, 'MISSING_SOURCE')
  const receipt = state.productionReceipts.at(-1)
  assert.equal(receipt.status, 'blocked')
  assert.equal(receipt.node_id, 'parse')
  assert.equal(receipt.rollback_to, 'route')
  assert.equal(receipt.input_checksum, state.taskFingerprint)
  const parsed = JSON.parse(receipt.failure_fingerprint)
  assert.deepEqual(Object.keys(parsed).sort(), [...FAILURE_FINGERPRINT_KEYS].sort())
  assert.equal(parsed.error_code, 'MISSING_SOURCE')
  assert.equal(parsed.node_id, 'parse')
  assert.equal(parsed.provider_model, 'none')
  assert.deepEqual(parsed.artifact_checksums, [])
  const defaulted = transitionState(state, { action: 'block', rollbackTo: 'route', reason: 'blocked again' }, { turn: 3, sourceEventSeq: 4 })
  assert.equal(JSON.parse(defaulted.productionReceipts.at(-1).failure_fingerprint).error_code, 'BLOCKED')
})
