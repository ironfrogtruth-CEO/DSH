import { createHash, randomUUID } from 'node:crypto'

export const SOP_NODES = Object.freeze(['route', 'parse', 'structure', 'generate', 'validate', 'export', 'review'])

// Governance is an overlay on the existing seven-node state machine. Keep the
// node ids stable: persisted schemaVersion=1 snapshots may not have a
// governance field and must still render and resume safely.
export const NODE_GOVERNANCE = Object.freeze({
  route: Object.freeze({
    provinces: Object.freeze(['行动省']),
    ministries: Object.freeze(['澄清部']),
    gate: '目标合同、受众动作、交付物、约束、验收和回退点完整',
  }),
  parse: Object.freeze({
    provinces: Object.freeze(['内容省']),
    ministries: Object.freeze(['搜寻部']),
    gate: '真源、派生、调试和污染风险分开，关键输入可追溯',
  }),
  structure: Object.freeze({
    provinces: Object.freeze(['行动省']),
    ministries: Object.freeze(['规划部']),
    gate: '结构能落到输入、输出、技能、工具、模型、QA 和回退',
  }),
  generate: Object.freeze({
    provinces: Object.freeze(['行动省']),
    ministries: Object.freeze(['执行部']),
    gate: '只按已确认结构生成，保护上游和用户改动',
  }),
  validate: Object.freeze({
    provinces: Object.freeze(['内容省', '渲染省']),
    ministries: Object.freeze(['检查部']),
    gate: '事实、结构、格式、渲染和用户约束均有证据；失败阻断',
  }),
  export: Object.freeze({
    provinces: Object.freeze(['渲染省']),
    ministries: Object.freeze(['产出部']),
    gate: '仅导出已通过 QA 的产物，记录路径、版本和交付清单',
  }),
  review: Object.freeze({
    provinces: Object.freeze(['行动省', '渲染省']),
    ministries: Object.freeze(['检查部', '产出部']),
    gate: '逐项回读完成标准，分开报告实现、测试、实时验收和生产就绪',
  }),
})

export function governanceForNode(node) {
  const governance = NODE_GOVERNANCE[node]
  if (!governance) return null
  return {
    provinces: [...governance.provinces],
    ministries: [...governance.ministries],
    gate: governance.gate,
  }
}

function governanceForState(classification, node) {
  return classification === 'sop_required' ? governanceForNode(node) : null
}

const SIMPLE_WORDING = /(?:只给一句|只用一句话|仅用一句话|只(?:给|写|输出|回复)(?:出)?(?:改写后的)?(?:一|1)句|翻译成|改写(?:这|下列|以下)?(?:句子)?)/i
const COMPLEX_WORDING = /(?:复杂|多步骤|可回滚|状态机|工作流|流水线|方案|规划|架构|实施|验收|回归|部署|升级|迁移|重构|开发|实现|修复|调试|排查|审计|报告|PPT|HTML|PDF|插件|代码|仓库|项目|文件)/i
const RISK_WORDING = /(?:真源|证据|来源|QA|质量|渲染|导出|发布|提交|权限|确认|回滚|恢复|失败|风险|约束)/i

function boundedText(value, max = 1_000) {
  const text = String(value ?? '').trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function contentText(message) {
  return (message?.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n').trim()
}

export function userText(messages = []) {
  return messages.filter((message) => message?.source?.kind === 'user').map(contentText).filter(Boolean).join('\n')
}

export function fingerprint(text) {
  return createHash('sha256').update(String(text || '')).digest('hex')
}

function parseChineseNumber(value) {
  const normalized = String(value || '').trim()
  if (/^\d+$/.test(normalized)) return Number(normalized)
  return ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 })[normalized] ?? null
}

export function extractOutputContract(text) {
  const source = String(text || '')
  const sentenceMatch = source.match(/(?:只|仅)(?:给|写|用|输出|回复)?(?:出)?(?:改写后的)?([一二两三四五六七八九十\d]+)(?:个)?句(?:话)?/i)
  const maxCharsMatch = source.match(/(?:不超过|最多|控制在)\s*(\d+)\s*(?:个)?字|(?:在)?\s*(\d+)\s*字以内/i)
  const forbidden = []
  for (const match of source.matchAll(/不要(?:出现|包含|写|使用)?[“"']?([^，。；;\n]{1,40})[”"']?/g)) forbidden.push(boundedText(match[1], 40))
  let format = null
  if (/\bJSON\b/i.test(source)) format = 'json'
  else if (/Markdown/i.test(source)) format = 'markdown'
  else if (/表格/.test(source)) format = 'table'
  else if (/代码块/.test(source)) format = 'code_block'
  const language = /(?:用|使用|请用)英文|in English/i.test(source) ? 'en' : (/(?:用|使用|请用)中文|汉语/.test(source) ? 'zh' : null)
  const impliedSingleSentence = /(?:只|仅)(?:给|输出|回复)(?:出)?(?:改写后的)?句子/i.test(source)
  const exactSentences = sentenceMatch ? parseChineseNumber(sentenceMatch[1]) : (impliedSingleSentence ? 1 : null)
  const silentUntilTerminal = /(?:只在\s*)?最后\s*(?:再\s*)?(?:交付|告诉我|汇报)|(?:完成|跑通|跑完|全部完成|任务完成)\s*后\s*(?:再\s*)?(?:交付|告诉我|汇报)/i.test(source)
  const continuousUntilTerminal = silentUntilTerminal || /不要\s*(?:在\s*)?(?:中途|半途|途中|中间)\s*(?:停|停下|停止|停下来)|一直(?:执行|运行|处理|做到|推进|跑)\s*(?:到|至)\s*完成|跑通后\s*再\s*(?:交付|告诉我|汇报)/i.test(source)
  return {
    exactSentences: Number.isSafeInteger(exactSentences) && exactSentences > 0 ? exactSentences : null,
    resultOnly: /(?:只|仅)(?:给|要|输出|回复)(?:出)?(?:改写后的)?(?:结果|答案|句子|一句|一段)|不要解释|无需解释|不加前言|不要前言/i.test(source),
    continuousUntilTerminal,
    silentUntilTerminal,
    format,
    language,
    maxChars: Number(maxCharsMatch?.[1] || maxCharsMatch?.[2]) || null,
    forbidden: [...new Set(forbidden)].slice(0, 10),
  }
}

export function classifyTask(text) {
  const source = String(text || '').trim()
  const numberedRequirements = (source.match(/(?:^|\n)\s*\d+[.)、]/g) || []).length
  const explicitSimple = SIMPLE_WORDING.test(source) && !/(?:代码|仓库|文件|插件|实现|修复|升级|部署|状态机)/i.test(source)
  const continuousExecution = extractOutputContract(source).continuousUntilTerminal === true
  const complexSignals = [COMPLEX_WORDING.test(source), RISK_WORDING.test(source), continuousExecution, numberedRequirements >= 2, source.length > 260].filter(Boolean).length
  const classification = explicitSimple || complexSignals < 2 ? 'simple_direct' : 'sop_required'
  return {
    classification,
    reasons: classification === 'sop_required'
      ? ['multiple steps, durable artifacts, source/QA risk, or rollback are present'].filter(Boolean)
      : ['one-step request with low durable-artifact and rollback risk'],
  }
}

function nodeMap(classification) {
  if (classification === 'simple_direct') return { direct: 'in_progress' }
  return Object.fromEntries(SOP_NODES.map((node, index) => [node, index === 0 ? 'in_progress' : 'pending']))
}

export function createInitialState({ sessionId, text, sourceEventSeq = 0, turn = 1 }) {
  const route = classifyTask(text)
  const currentNode = route.classification === 'simple_direct' ? 'direct' : 'route'
  return {
    schemaVersion: 1,
    sessionId,
    runId: `goal-first-${randomUUID()}`,
    taskFingerprint: fingerprint(text),
    classification: route.classification,
    classificationReasons: route.reasons,
    phase: 'active',
    goalContract: null,
    outputContract: extractOutputContract(text),
    currentNode,
    nodes: nodeMap(route.classification),
    governance: governanceForState(route.classification, currentNode),
    qa: { status: 'not_run', checks: [], evidence: [] },
    rollbackTarget: null,
    failure: null,
    repair: { turn, attempts: 0 },
    lastModelTransitionTurn: 0,
    sourceEventSeq,
    revision: 1,
    updatedAt: Date.now(),
  }
}

function list(value, max = 40) { return Array.isArray(value) ? value.slice(0, max).map((item) => boundedText(item, 1_000)) : [] }

export function normalizeGoalContract(value) {
  const input = value && typeof value === 'object' ? value : {}
  const result = {
    problem: boundedText(input.problem),
    audienceAction: boundedText(input.audienceAction ?? input.audience_action),
    deliverables: list(input.deliverables),
    truthSources: list(input.truthSources ?? input.truth_sources),
    constraints: list(input.constraints),
    successCriteria: list(input.successCriteria ?? input.success_criteria),
    minimumDeliverable: boundedText(input.minimumDeliverable ?? input.minimum_deliverable),
    validation: list(input.validation),
    rollbackPoints: list(input.rollbackPoints ?? input.rollback_points),
  }
  for (const key of ['problem', 'audienceAction', 'minimumDeliverable']) if (!result[key]) throw new Error(`goalContract.${key} is required`)
  for (const key of ['deliverables', 'constraints', 'successCriteria', 'validation', 'rollbackPoints']) if (result[key].length === 0) throw new Error(`goalContract.${key} must not be empty`)
  return result
}

function nextNode(node) {
  const index = SOP_NODES.indexOf(node)
  return index >= 0 ? SOP_NODES[index + 1] ?? null : null
}

function evidence(value) { return list(value, 30) }

export function transitionState(state, input, { turn, sourceEventSeq }) {
  if (!state || state.classification !== 'sop_required') throw new Error('state transition is available only for sop_required tasks')
  if (state.outputContract?.continuousUntilTerminal !== true && state.lastModelTransitionTurn === turn) {
    throw new Error('only one goal-first state transition is allowed per turn unless continuousUntilTerminal is enabled')
  }
  const action = String(input?.action || '')
  const next = structuredClone(state)
  // Historical schemaVersion=1 snapshots predate governance. Rehydrate the
  // derived overlay in memory while leaving their append-only records intact.
  next.governance = governanceForState(state.classification, state.currentNode)
  next.updatedAt = Date.now()
  next.sourceEventSeq = Math.max(Number(sourceEventSeq || 0), state.sourceEventSeq)
  next.lastModelTransitionTurn = turn
  next.repair = { turn, attempts: 0 }

  if (action === 'record_goal') {
    if (state.phase !== 'active' || state.currentNode !== 'route') throw new Error('record_goal requires active route node')
    next.goalContract = normalizeGoalContract(input.goalContract)
    next.nodes.route = 'completed'
    next.nodes.parse = 'in_progress'
    next.currentNode = 'parse'
    next.governance = governanceForState(next.classification, next.currentNode)
    return next
  }

  if (action === 'complete_node') {
    const node = String(input.node || '')
    if (state.phase !== 'active' || node !== state.currentNode || state.nodes[node] !== 'in_progress') throw new Error(`cannot complete node ${node || '<missing>'} from ${state.currentNode}`)
    if (node === 'route') throw new Error('route must use record_goal')
    const proof = evidence(input.evidence)
    if (proof.length === 0) throw new Error('node completion requires evidence')
    if (node === 'validate') {
      if (!['passed', 'failed'].includes(input.qaStatus)) throw new Error('validate completion requires qaStatus passed or failed')
      next.qa = { status: input.qaStatus, checks: list(input.qaChecks), evidence: proof }
      if (input.qaStatus === 'failed') {
        const rollbackTo = String(input.rollbackTo || '')
        if (!SOP_NODES.slice(0, SOP_NODES.indexOf('validate')).includes(rollbackTo)) throw new Error('failed validation requires an earlier rollbackTo node')
        next.nodes.validate = 'blocked'
        next.phase = 'blocked'
        next.rollbackTarget = rollbackTo
        next.failure = { code: 'QA_FAILED', message: boundedText(input.reason || 'validation failed') }
        return next
      }
    }
    if (node === 'export' && state.qa.status !== 'passed') throw new Error('export requires passed QA')
    next.nodes[node] = 'completed'
    const following = nextNode(node)
    if (following) {
      next.nodes[following] = 'in_progress'
      next.currentNode = following
    } else {
      next.phase = 'complete'
      next.currentNode = 'review'
    }
    next.governance = governanceForState(next.classification, next.currentNode)
    return next
  }

  if (action === 'pause') {
    if (state.phase !== 'active') throw new Error('pause requires active state')
    if (!String(input.reason || '').trim()) throw new Error('pause requires reason')
    next.phase = 'paused'
    next.failure = { code: 'AWAITING_CONFIRMATION', message: boundedText(input.reason) }
    return next
  }

  if (action === 'block') {
    const rollbackTo = String(input.rollbackTo || '')
    if (!SOP_NODES.includes(rollbackTo)) throw new Error('block requires rollbackTo')
    next.phase = 'blocked'
    next.nodes[state.currentNode] = 'blocked'
    next.rollbackTarget = rollbackTo
    next.failure = { code: boundedText(input.code || 'BLOCKED', 80), message: boundedText(input.reason || 'blocked') }
    return next
  }

  if (action === 'resume') {
    if (!['paused', 'blocked'].includes(state.phase)) throw new Error('resume requires paused or blocked state')
    const target = state.rollbackTarget || state.currentNode
    const index = SOP_NODES.indexOf(target)
    for (let position = 0; position < SOP_NODES.length; position += 1) {
      if (position < index && next.nodes[SOP_NODES[position]] === 'completed') continue
      next.nodes[SOP_NODES[position]] = position === index ? 'in_progress' : 'pending'
    }
    next.phase = 'active'
    next.currentNode = target
    next.rollbackTarget = null
    next.failure = null
    next.governance = governanceForState(next.classification, next.currentNode)
    return next
  }

  throw new Error(`unknown transition action: ${action || '<missing>'}`)
}

export function renderStateContext(state, currentTurn = null) {
  const contract = JSON.stringify(state.outputContract)
  if (state.classification === 'simple_direct') return `<goal_first_host_state version="1">route=simple_direct; implicit_checks=truth,action,terminal; output_contract=${contract}; answer directly and satisfy every populated output constraint.</goal_first_host_state>`
  const governance = state.governance || governanceForState(state.classification, state.currentNode)
  const provinces = governance?.provinces?.join('+') || '未映射'
  const ministries = governance?.ministries?.join('+') || '未映射'
  const gate = governance?.gate || '当前节点 Gate 未定义'
  const overlay = `province=${provinces}; ministry=${ministries}; gate=${gate}`
  const continuousUntilTerminal = state.outputContract?.continuousUntilTerminal === true
  const silentUntilTerminal = state.outputContract?.silentUntilTerminal === true
  if (Number.isSafeInteger(currentTurn) && state.lastModelTransitionTurn === currentTurn) {
    const sameTurnInstruction = state.phase === 'complete'
      ? 'The task is terminal. Provide the final delivery and conclusion now.'
      : continuousUntilTerminal
        ? `A legal Host state transition has already been recorded in this turn. The user explicitly requires continuous execution until terminal${silentUntilTerminal ? ' and no progress report before terminal' : ''}. Continue executing the current node with available tools. After genuinely completing that node with evidence, you may call goal_first_state_transition again using the current revision for the next sequential node; never batch-jump or invent evidence. Do not end the response merely because this transition was recorded. Stop only for terminal completion, a user decision that changes the result, new permission, an external security block, or an unrecoverable failure.`
        : 'A legal Host state transition has already been recorded in this turn. Do not advance another node in this turn; finish the response now and report the recorded current node.'
    return `<goal_first_host_state version="1">route=sop_required; revision=${state.revision}; phase=${state.phase}; current_node=${state.currentNode}; ${overlay}; qa=${state.qa.status}; output_contract=${contract}. ${sameTurnInstruction}</goal_first_host_state>`
  }
  const routeSchema = state.currentNode === 'route' ? ' For record_goal, goalContract must contain non-empty problem:string, audienceAction:string, deliverables:string[], constraints:string[], successCriteria:string[], minimumDeliverable:string, validation:string[], rollbackPoints:string[]; truthSources is string[] and may be empty only when explicitly marked pending.' : ''
  const continuousInstruction = continuousUntilTerminal
    ? ` The user explicitly requires continuous execution until terminal${silentUntilTerminal ? ' and only a final delivery' : ''}. Continue node by node with available tools. After each real node completion with evidence, continue with the next sequential transition using the current revision; never batch-jump or invent evidence, and do not stop at a normal node boundary. Stop only for terminal completion, a user decision that changes the result, new permission, an external security block, or an unrecoverable failure.`
    : ''
  return `<goal_first_host_state version="1">route=sop_required; revision=${state.revision}; phase=${state.phase}; current_node=${state.currentNode}; ${overlay}; qa=${state.qa.status}; output_contract=${contract}. This Host state is authoritative. Call goal_first_state_transition with expectedRevision=${state.revision} before the turn ends.${routeSchema} Nodes must advance in order and export is forbidden until QA passes.${continuousInstruction}</goal_first_host_state>`
}
