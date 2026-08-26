import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from './index.js'
import { classifyTask, createInitialState, extractOutputContract, governanceForNode, renderStateContext, transitionState } from './machine.js'
import { GoalFirstStateStore } from './state-store.js'
import { enforceOneSentenceStream, rewriteOneSentenceChunks } from './stream-contract.js'

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
  for (const node of ['parse', 'structure', 'generate']) state = transitionState(state, { action: 'complete_node', node, evidence: [`${node} ok`] }, { turn: ++turn, sourceEventSeq: 4 })
  const failed = transitionState(state, { action: 'complete_node', node: 'validate', evidence: ['failed check'], qaStatus: 'failed', rollbackTo: 'generate', reason: 'test failed' }, { turn: ++turn, sourceEventSeq: 5 })
  assert.equal(failed.phase, 'blocked')
  assert.equal(failed.rollbackTarget, 'generate')
  state = transitionState(state, { action: 'complete_node', node: 'validate', evidence: ['tests passed'], qaStatus: 'passed', qaChecks: ['unit'] }, { turn: ++turn, sourceEventSeq: 5 })
  assert.equal(state.currentNode, 'export')
  assert.deepEqual(state.governance, governanceForNode('export'))
  state = transitionState(state, { action: 'complete_node', node: 'export', evidence: ['artifact hash'] }, { turn: ++turn, sourceEventSeq: 6 })
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
      const next = await transition.execute({ expectedRevision: state.revision, action: 'complete_node', node, evidence: [`${node} ok`] })
      assert.equal(next.ok, true)
      state = next.state
    }
    let next = await transition.execute({ expectedRevision: state.revision, action: 'complete_node', node: 'validate', evidence: ['qa ok'], qaStatus: 'passed' })
    assert.equal(next.ok, true)
    state = next.state
    next = await transition.execute({ expectedRevision: state.revision, action: 'complete_node', node: 'export', evidence: ['artifact hash'] })
    assert.equal(next.ok, true)
    state = next.state
    next = await transition.execute({ expectedRevision: state.revision, action: 'complete_node', node: 'review', evidence: ['final review complete'] })
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
    const stale = await transition.execute({ expectedRevision: state.revision, action: 'complete_node', node: 'parse', evidence: ['ok'] })
    assert.equal(stale.code, 'STATE_REVISION_CONFLICT')

    state = result.state
    let turn = 2
    for (const node of ['parse', 'structure', 'generate']) {
      turn += 1
      agent.session.events.push({ type: 'step/start', data: { turn, step: 1 } })
      result = await transition.execute({ expectedRevision: state.revision, action: 'complete_node', node, evidence: [`${node} ok`] })
      state = result.state
    }
    turn += 1
    agent.session.events.push({ type: 'step/start', data: { turn, step: 1 } })
    result = await transition.execute({ expectedRevision: state.revision, action: 'complete_node', node: 'validate', evidence: ['qa ok'], qaStatus: 'passed' })
    state = result.state
    const preExecute = runtime.listeners.get('tools/pre-execute')[0]
    const allowed = await preExecute({ agent, name: 'pdf_export', arguments: {} }, async () => ({ kind: 'allow' }))
    assert.equal(allowed.kind, 'allow')
  } finally { await fixture.cleanup() }
})
