import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createInitialState, extractOutputContract, renderStateContext, transitionState, userText } from './machine.js'
import { GoalFirstStateError, GoalFirstStateStore } from './state-store.js'
import { enforceOneSentenceStream } from './stream-contract.js'

export const name = 'dsh-goal-first-state-machine'
export const inject = ['tools', 'agents', 'sessions', 'llm']

const DEFAULT_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

async function runtimeExport(packageName, exportName) {
  try {
    const module = await import(packageName)
    if (module?.[exportName]) return module[exportName]
  } catch { /* resolve from the deployed Harness below */ }
  for (const candidate of [
    join(DEFAULT_HOME, 'profiles/web/node_modules', ...packageName.split('/')),
    join(DEFAULT_HOME, 'profiles/node_modules', ...packageName.split('/')),
    join(DEFAULT_HOME, 'install/node_modules', ...packageName.split('/')),
  ]) {
    try {
      const loaded = createRequire(join(DEFAULT_HOME, 'goal-first-runtime.cjs'))(candidate)
      if (loaded?.[exportName]) return loaded[exportName]
    } catch { /* try the next root */ }
  }
  throw new Error(`${name} cannot resolve ${packageName}.${exportName}`)
}

function outputSchema() {
  return { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true }, code: { type: 'string' }, error: { type: 'string' } } }
}

function boundedJson(value, limit = 12_000) {
  let text = JSON.stringify(value)
  if (text.length <= limit) return text
  text = JSON.stringify({ ok: value?.ok === true, code: value?.code, truncated: true, state: value?.state ? { revision: value.state.revision, classification: value.state.classification, phase: value.state.phase, currentNode: value.state.currentNode, qa: value.state.qa } : undefined })
  return text.length <= limit ? text : JSON.stringify({ ok: false, code: 'OUTPUT_TRUNCATED' })
}

function position(session) {
  const start = session.events.findLast((event) => event.type === 'step/start')
  return { turn: start?.data?.turn ?? 0, step: start?.data?.step ?? 0, sourceEventSeq: Math.max(session.seq - 1, 0) }
}

function stateError(error) {
  return { ok: false, code: error?.code || 'GOAL_FIRST_STATE_ERROR', error: String(error?.message || error).slice(0, 1_000) }
}

function sourceSummary(state) {
  return state.classification === 'simple_direct' ? 'simple output contract' : `${state.currentNode} r${state.revision}`
}

function latestHumanText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.source?.kind !== 'user') continue
    const text = (message.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n').trim()
    if (text) return text
  }
  return ''
}

function goalContractText(goalContract) {
  if (!goalContract || typeof goalContract !== 'object') return ''
  const values = [
    goalContract.constraints,
    goalContract.deliverables,
    goalContract.successCriteria ?? goalContract.success_criteria,
    goalContract.minimumDeliverable ?? goalContract.minimum_deliverable,
  ]
  return values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join('\n')
}

function rehydrateOutputContract(state, latestText, sourceEventSeq) {
  if (!state || state.classification !== 'sop_required' || state.phase !== 'active') return null
  const current = state.outputContract && typeof state.outputContract === 'object' ? state.outputContract : {}
  const fields = ['continuousUntilTerminal', 'silentUntilTerminal']
  const missing = fields.some((field) => typeof current[field] !== 'boolean')
  const latest = latestText ? extractOutputContract(latestText) : null
  const explicitUpgrade = latest?.continuousUntilTerminal === true || latest?.silentUntilTerminal === true
  if (!missing && !explicitUpgrade) return null
  const inferred = missing
    ? extractOutputContract([latestText, goalContractText(state.goalContract)].filter(Boolean).join('\n'))
    : latest
  const outputContract = { ...current }
  let changed = false
  for (const field of fields) {
    if (typeof current[field] !== 'boolean') {
      outputContract[field] = field === 'continuousUntilTerminal' && current.silentUntilTerminal === true
        ? true
        : inferred?.[field] === true
      changed = true
    } else if (inferred?.[field] === true && current[field] !== true) {
      outputContract[field] = true
      changed = true
    }
  }
  return changed
    ? { ...state, outputContract, sourceEventSeq: Math.max(Number(sourceEventSeq || 0), Number(state.sourceEventSeq || 0)), updatedAt: Date.now() }
    : null
}

function isExportLike(exec) {
  const nameText = String(exec?.name || '').toLowerCase()
  if (/(?:^|[_-])(export|publish|deliver|package|pdf|pptx)(?:$|[_-])/.test(nameText)) return true
  if (!/(?:shell|bash|exec|command|terminal|run)/.test(nameText)) return false
  const command = String(exec?.arguments?.command || exec?.arguments?.cmd || exec?.arguments?.script || '').toLowerCase()
  return /(?:^|\s)(?:export|publish|deliver|package|pdf|pptx)(?:\s|$)/.test(command) || /(?:npm\s+publish|git\s+push|pandoc\b|wkhtmltopdf\b)/.test(command)
}

export async function apply(ctx, config = {}) {
  const defineTool = config.defineTool || await runtimeExport('@deepseek-ai/dsh-tools', 'defineTool')
  const createUserMessage = config.createUserMessage || await runtimeExport('@deepseek-ai/dsh-llm', 'createUserMessage')
  const isAgentLoopRequest = config.isAgentLoopRequest || await runtimeExport('@deepseek-ai/dsh-llm', 'isAgentLoopRequest')
  const root = config.root || process.env.DSH_GOAL_FIRST_ROOT || join(process.env.DSH_HOME || DEFAULT_HOME, 'goal-first-state')
  const store = config.store || new GoalFirstStateStore(root)
  const maxBufferChars = Math.max(4_096, Math.min(1_000_000, Number(config.maxBufferChars || 65_536)))
  const maxRepairAttempts = Math.max(0, Math.min(2, Number(config.maxRepairAttempts ?? 1)))
  const { tools } = ctx

  const register = (spec) => tools.register(defineTool({ ...spec, output: { schema: outputSchema(), render: (_args, value) => [{ type: 'text', text: boundedJson(value) }] } }))

  register({
    name: 'goal_first_state_get',
    description: 'Read the current Host-enforced goal-first state for this exact session. It does not advance or rewrite the state.',
    parameters: {},
    timeoutMs: 10_000,
    async execute() {
      try {
        const agent = ctx.agents.requireInitiator()
        return { ok: true, state: await store.load(agent.id) }
      } catch (error) { return stateError(error) }
    },
    presentCall() { return { card: 'generic', title: 'Read goal-first state' } },
  })

  register({
    name: 'goal_first_state_transition',
    description: 'Advance or pause the Host-enforced goal-first state using revision CAS. Nodes are sequential; ordinary tasks allow one transition per turn, while continuousUntilTerminal tasks may continue with evidence-backed sequential transitions in the same turn. Failed QA blocks and export requires passed QA.',
    parameters: {
      expectedRevision: { type: 'integer', required: true },
      action: { type: 'string', required: true, enum: ['record_goal', 'complete_node', 'pause', 'block', 'resume'] },
      node: { type: 'string' },
      goalContract: { type: 'object', additionalProperties: true },
      qaStatus: { type: 'string', enum: ['passed', 'failed'] },
      qaChecks: { type: 'array' },
      evidence: { type: 'array' },
      rollbackTo: { type: 'string' },
      code: { type: 'string' },
      reason: { type: 'string' },
    },
    timeoutMs: 10_000,
    async execute(args) {
      try {
        const agent = ctx.agents.requireInitiator()
        const current = await store.load(agent.id)
        if (!current) throw new GoalFirstStateError('STATE_NOT_FOUND', 'goal-first state is not initialized')
        if (args.expectedRevision !== current.revision) throw new GoalFirstStateError('STATE_REVISION_CONFLICT', `expected revision ${args.expectedRevision}, current revision is ${current.revision}`)
        const at = position(agent.session)
        const candidate = transitionState(current, args, at)
        const state = await store.append(agent.id, candidate, args.expectedRevision)
        return { ok: true, state }
      } catch (error) { return stateError(error) }
    },
    presentCall(args) { return { card: 'generic', title: `Goal-first ${args.action || 'transition'}` } },
  })

  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()
    const human = userText(messages)
    let state = await store.load(agent.id)
    if (state && state.sourceEventSeq > agent.session.seq) {
      state = await store.append(agent.id, {
        ...state,
        phase: 'blocked',
        nodes: { ...state.nodes, [state.currentNode]: 'blocked' },
        rollbackTarget: state.currentNode,
        failure: { code: 'STATE_SOURCE_AHEAD', message: 'persisted goal-first state is ahead of the resumed session log' },
        sourceEventSeq: Math.max(agent.session.seq - 1, 0),
        updatedAt: Date.now(),
      }, state.revision)
    }
    const rehydrated = rehydrateOutputContract(state, latestHumanText(messages), Math.max(agent.session.seq - 1, 0))
    if (rehydrated) state = await store.append(agent.id, rehydrated, state.revision)
    if (human && (!state || state.phase === 'complete' || state.classification === 'simple_direct')) {
      const initial = createInitialState({ sessionId: agent.id, text: human, sourceEventSeq: Math.max(agent.session.seq - 1, 0), turn })
      state = await store.append(agent.id, initial, state?.revision ?? 0)
    }
    if (!state) return decision
    const context = createUserMessage({
      content: [{ type: 'text', text: renderStateContext(state, turn) }],
      source: { kind: 'plugin', plugin: name, form: 'notice', summary: sourceSummary(state) },
    })
    return { kind: 'enter', messages: [...decision.messages, context] }
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!exec?.agent || !isExportLike(exec) || exec.name.startsWith('goal_first_state_')) return next()
    const state = await store.load(exec.agent.id)
    if (!state || state.classification !== 'sop_required' || state.qa.status === 'passed') return next()
    return { kind: 'deny', reason: `goal-first QA gate blocks ${exec.name}: validate must pass before export` }
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    signal.throwIfAborted()
    const state = await store.load(agent.id)
    if (!state) return
    if (state.classification === 'simple_direct') {
      if (state.phase !== 'complete') await store.append(agent.id, { ...state, phase: 'complete', currentNode: 'direct', nodes: { direct: 'completed' }, sourceEventSeq: Math.max(agent.session.seq - 1, 0), updatedAt: Date.now() }, state.revision)
      return
    }
    if (state.phase !== 'active') return
    const continuousUntilTerminal = state.outputContract?.continuousUntilTerminal === true
    const transitionRecordedThisTurn = state.lastModelTransitionTurn === turn
    if (continuousUntilTerminal && transitionRecordedThisTurn) {
      const attempts = state.repair?.turn === turn ? state.repair.attempts : 0
      if (attempts < maxRepairAttempts) {
        const repaired = await store.append(agent.id, {
          ...state,
          repair: { turn, attempts: attempts + 1 },
          sourceEventSeq: Math.max(agent.session.seq - 1, 0),
          updatedAt: Date.now(),
        }, state.revision)
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: `<goal_first_continuation_required revision="${repaired.revision}">The user explicitly requires this task to continue until terminal. A legal state transition already occurred in this turn. Continue the current task with available tools. After genuinely completing the current node with evidence, call goal_first_state_transition for the next sequential node using the current revision; do not batch-jump or invent evidence. Do not end the response merely because this transition was recorded. Stop only for terminal completion, a user decision that changes the result, new permission, an external security block, or an unrecoverable failure.</goal_first_continuation_required>` }],
          source: { kind: 'plugin', plugin: name, form: 'notice', summary: 'continuous execution required' },
        }))
        return
      }
      await store.append(agent.id, {
        ...state,
        phase: 'blocked',
        nodes: { ...state.nodes, [state.currentNode]: 'blocked' },
        rollbackTarget: state.currentNode,
        failure: { code: 'CONTINUOUS_EXECUTION_STOPPED', message: 'model attempted to end before terminal after the bounded continuation reminder' },
        sourceEventSeq: Math.max(agent.session.seq - 1, 0),
        updatedAt: Date.now(),
      }, state.revision)
      return
    }
    if (transitionRecordedThisTurn) return
    const attempts = state.repair?.turn === turn ? state.repair.attempts : 0
    if (attempts < maxRepairAttempts) {
      const repaired = await store.append(agent.id, { ...state, repair: { turn, attempts: attempts + 1 }, sourceEventSeq: Math.max(agent.session.seq - 1, 0), updatedAt: Date.now() }, state.revision)
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: `<goal_first_transition_required revision="${repaired.revision}">Before ending this turn, call goal_first_state_transition with expectedRevision=${repaired.revision}. Record the goal contract, advance the current node with evidence, or pause/block explicitly. Do not repeat the user's request.</goal_first_transition_required>` }],
        source: { kind: 'plugin', plugin: name, form: 'notice', summary: 'state transition required' },
      }))
      return
    }
    await store.append(agent.id, {
      ...state,
      phase: 'blocked',
      nodes: { ...state.nodes, [state.currentNode]: 'blocked' },
      rollbackTarget: state.currentNode,
      failure: { code: 'STATE_TRANSITION_MISSING', message: 'model did not record a state transition after one repair request' },
      sourceEventSeq: Math.max(agent.session.seq - 1, 0),
      updatedAt: Date.now(),
    }, state.revision)
  })

  ctx.on('llm/stream', (options, next) => {
    if (!isAgentLoopRequest(options) || options.sessionId === undefined) return next()
    return (async function* () {
      const state = await store.load(String(options.sessionId))
      yield* enforceOneSentenceStream(next(), state?.outputContract, maxBufferChars)
    })()
  })

  if (typeof ctx.provide === 'function') ctx.provide('dshGoalFirstStateMachine', { store, classify: createInitialState, transition: transitionState })
  return undefined
}

export { GoalFirstStateStore, GoalFirstStateError }
export * from './machine.js'
export * from './stream-contract.js'
