import { createHash, randomUUID } from 'node:crypto'
import { stableJsonChecksumV1, stableJsonStringifyV1 } from './stable-json.js'

export const SOP_NODES = Object.freeze(['route', 'parse', 'structure', 'generate', 'validate', 'export', 'review'])

// G2+ structured failure fingerprint: failure/blocked receipts must record at
// least the input/work-contract checksum, workflow/capability versions, node,
// provider+model ('none' when unknown), the error code, and the checksums of
// related artifacts. production_receipt.v1 types failure_fingerprint as
// string|null, so the structured object is persisted as a canonical
// stableJsonStringifyV1 JSON string that parses back to an object carrying
// exactly these keys; successful completed receipts keep null.
export const GOAL_FIRST_WORKFLOW_VERSION = 'goal-first-sop.v1'
export const GOAL_FIRST_CAPABILITY_VERSION = 'production_receipt.v1'
export const FAILURE_FINGERPRINT_KEYS = Object.freeze([
  'input_checksum',
  'contract_checksum',
  'workflow_version',
  'capability_version',
  'node_id',
  'provider_model',
  'error_code',
  'artifact_checksums',
])

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
// A direct call to an already published shrimp is an executable request, not
// a request to design or govern a workflow. Keep this narrow: only an
// explicit shrimp_run(...) expression or an action verb at the beginning of
// a sentence naming a shrimp is allowed to bypass the seven-node overlay.
const DIRECT_SHRIMP_CALL_RE = /(?:^|[^\p{L}\p{N}_])shrimp_run\s*\(/iu
const DIRECT_SHRIMP_SENTENCE_RE = /^(?:请\s*)?(?:帮我\s*)?(?:直接\s*)?(?:运行|调用|启动|执行|开跑)\s*(?:(?:这|该|已发布的?|发布的?|指定的?)\s*)?[^。！？!?\n]{0,100}虾(?=[，,、。！？!?（）();；.\s]|$)/u
const DIRECT_SHRIMP_PRODUCTION_RE = /^(?:请\s*)?用\s*文章@?虾(?:六答)?[\s\S]{0,100}(?:写|生成|产出|发布|保存|编写|制作)/u
const DIRECT_SHRIMP_ASSIGN_RE = /^(?:请\s*)?(?:让|交给)\s*[^。！？!?\n]{0,100}(?:文章@?虾|@[^。！？!?\n]{1,100}虾)[\s\S]{0,100}(?:写|生成|产出|发布|保存|编写|制作|运行|调用|启动|执行)/u
const DIRECT_SHRIMP_TRY_RE = /^(?:升级了?|更新了?)[\s\S]{0,40}文章@?虾(?:六答)?[\s\S]{0,40}(?:试一下|试试|试跑|跑一下|试用)/u
const DIRECT_SHRIMP_TOOL_RE = /\bshrimp_run\b[\s\S]{0,100}(?:运行|调用|启动|执行|开跑)\s*[^。！？!?\n]{0,100}虾/iu
const DIRECT_SHRIMP_NEGATED_RE = /(?:不要|别|禁止|不可|不能|无需|不需要|暂不|先别|先不要)[^。！？!?；;，,、\n]{0,24}(?:shrimp_run\s*(?:\(|\b)|(?:运行|调用|启动|执行|开跑|用|让|交给)\s*[^。！？!?；;，,、\n]{0,60}虾)/iu
const DIRECT_SHRIMP_QUERY_PREFIX_RE = /^(?:请问|了解(?:一下)?|介绍(?:一下)?|推荐|匹配|看看|查看|检查|分析|帮我(?:看看|查看|检查|分析|了解)|怎么|如何|能否|是否|可以|能不能|可不可以|为什么)/u
const DIRECT_SHRIMP_COMPLEX_PREFIX_RE = /^(?:请\s*)?(?:修复|升级|部署|迁移|重构|开发|实现|调试|排查|审计|测试|验收)/u
const SHRIMP_MAINTENANCE_RE = /^(?:请\s*)?(?:修复|升级|调试)[\s\S]{0,100}文章@?虾/u
const DIRECT_SHRIMP_INQUIRY_RE = /(?:吗|？|\?)\s*$/u
const DIRECT_SHRIMP_PAST_RE = /^(?:刚才|之前|上次|此前|曾经|已经)[^。！？!?\n]{0,60}(?:运行|调用|启动|执行|开跑)[^。！？!?\n]{0,24}(?:过|了|失败|完成)(?:[。！？!?]|$)/u

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

export function isDirectShrimpRunInstruction(text) {
  const source = String(text || '').trim()
  const complexPrefix = DIRECT_SHRIMP_COMPLEX_PREFIX_RE.test(source) && !DIRECT_SHRIMP_TRY_RE.test(source)
  if (!source || DIRECT_SHRIMP_NEGATED_RE.test(source) || DIRECT_SHRIMP_QUERY_PREFIX_RE.test(source) || complexPrefix || DIRECT_SHRIMP_INQUIRY_RE.test(source) || DIRECT_SHRIMP_PAST_RE.test(source)) return false
  return DIRECT_SHRIMP_CALL_RE.test(source)
    || DIRECT_SHRIMP_SENTENCE_RE.test(source)
    || DIRECT_SHRIMP_PRODUCTION_RE.test(source)
    || DIRECT_SHRIMP_ASSIGN_RE.test(source)
    || DIRECT_SHRIMP_TRY_RE.test(source)
    || DIRECT_SHRIMP_TOOL_RE.test(source)
}

export function classifyTask(text) {
  const source = String(text || '').trim()
  if (isDirectShrimpRunInstruction(source)) {
    return {
      classification: 'simple_direct',
      reasons: ['explicit published-shrimp run request; execute directly and preserve tool authorization checks'],
    }
  }
  if (SHRIMP_MAINTENANCE_RE.test(source)) {
    return {
      classification: 'sop_required',
      reasons: ['shrimp repair, upgrade, or debugging requires the normal governed workflow'],
    }
  }
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
    workContract: null,
    workContractChecksum: null,
    blueprintConfirmed: null,
    structureContract: null,
    workContractRef: null,
    productionReceipts: [],
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

const MAX_PRODUCTION_RECEIPTS = 50
const WORK_CONTRACT_KEYS = ['goal_contract', 'source_contract', 'output_contract', 'production_blueprint', 'qa_contract', 'recovery_contract', 'lineage']

function contractError(code, message) {
  return Object.assign(new Error(message), { code })
}

export function validateWorkContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw contractError('WORK_CONTRACT_INVALID', 'workContract must be an object')
  if (value.schema !== 'cybermarcus_work_contract.v1') throw contractError('WORK_CONTRACT_INVALID', 'workContract.schema must be cybermarcus_work_contract.v1')
  for (const key of WORK_CONTRACT_KEYS) {
    if (!(key in value)) throw contractError('WORK_CONTRACT_INVALID', `workContract.${key} is required`)
  }
  return value
}

export function validateStructureContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw contractError('STRUCTURE_CONTRACT_INVALID', 'structureContract must be an object')
  if (!Number.isInteger(value.contract_version) || value.contract_version <= 0) throw contractError('STRUCTURE_CONTRACT_INVALID', 'structureContract.contract_version must be a positive integer')
  if (value.text === undefined && value.ref === undefined) throw contractError('STRUCTURE_CONTRACT_INVALID', 'structureContract must provide text or ref')
  if (value.text !== undefined && typeof value.text !== 'string') throw contractError('STRUCTURE_CONTRACT_INVALID', 'structureContract.text must be a string')
  if (value.ref !== undefined && (!value.ref || typeof value.ref !== 'object' || typeof value.ref.uri !== 'string' || typeof value.ref.sha256 !== 'string')) {
    throw contractError('STRUCTURE_CONTRACT_INVALID', 'structureContract.ref must be { uri, sha256 }')
  }
  return value
}

export function validateWorkContractRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.uri !== 'string' || !value.uri || typeof value.sha256 !== 'string' || !value.sha256) {
    throw contractError('WORK_CONTRACT_REF_INVALID', 'workContractRef must be { uri, sha256 }')
  }
  return { uri: value.uri, sha256: value.sha256 }
}

function structuredFailureFingerprint(provided, { state, node, artifacts = [], actualBindings = {} }) {
  const checksums = (Array.isArray(artifacts) ? artifacts : [])
    .map((item) => (item && typeof item === 'object' ? item.checksum : undefined))
    .filter((checksum) => typeof checksum === 'string' && checksum)
  const provider = String(actualBindings?.provider ?? actualBindings?.provider_id ?? '').trim()
  const model = String(actualBindings?.model ?? actualBindings?.model_id ?? '').trim()
  const providerModel = provider || model
    ? `${provider || 'none'}/${model || 'none'}`
    : 'none'
  const base = {
    input_checksum: state.taskFingerprint,
    contract_checksum: state.workContractChecksum ?? 'none',
    workflow_version: GOAL_FIRST_WORKFLOW_VERSION,
    capability_version: GOAL_FIRST_CAPABILITY_VERSION,
    node_id: node,
    provider_model: providerModel,
    error_code: 'FAILURE_UNSPECIFIED',
    artifact_checksums: checksums,
  }
  const merged = { ...base, ...(provided && typeof provided === 'object' && !Array.isArray(provided) ? provided : {}) }
  for (const key of FAILURE_FINGERPRINT_KEYS) if (merged[key] === undefined) merged[key] = base[key]
  if (!Array.isArray(merged.artifact_checksums)) merged.artifact_checksums = base.artifact_checksums
  return merged
}

function productionReceipt({ state, node, status = 'completed', qaStatus = 'passed', checks = [], evidence = [], actualBindings = {}, artifacts = [], versionRefs = {}, failureFingerprint = null, rollbackTo = null, workContractRef = null }) {
  if (status === 'completed') {
    if (evidence.length < 1) throw contractError('RECEIPT_INCOMPLETE', 'completed receipt requires evidence')
    if (qaStatus !== 'passed') throw contractError('RECEIPT_INCOMPLETE', 'completed receipt requires qa_result.status=passed')
    if (!actualBindings || typeof actualBindings !== 'object' || Object.keys(actualBindings).length === 0) throw contractError('RECEIPT_INCOMPLETE', 'completed receipt requires non-empty actual_bindings')
    if (!Array.isArray(artifacts) || artifacts.length === 0) {
      if (!workContractRef || typeof workContractRef !== 'object') throw contractError('RECEIPT_INCOMPLETE', 'completed receipt requires artifacts or workContractRef')
    }
  }
  return {
    schema: 'production_receipt.v1',
    node_id: node,
    status,
    input_checksum: state.taskFingerprint,
    version_refs: { schemaVersion: state.schemaVersion, revision: state.revision, ...versionRefs },
    actual_bindings: actualBindings,
    artifacts: Array.isArray(artifacts) ? artifacts : [],
    qa_result: { status: qaStatus, checks },
    evidence,
    failure_fingerprint: failureFingerprint === null || failureFingerprint === undefined
      ? null
      : typeof failureFingerprint === 'string'
        ? failureFingerprint
        : stableJsonStringifyV1(structuredFailureFingerprint(failureFingerprint, { state, node, artifacts, actualBindings })),
    rollback_to: rollbackTo,
    workContract_ref: workContractRef,
  }
}

function appendReceipt(state, receipt) {
  const receipts = [...(state.productionReceipts ?? []), receipt]
  return receipts.length > MAX_PRODUCTION_RECEIPTS ? receipts.slice(receipts.length - MAX_PRODUCTION_RECEIPTS) : receipts
}

export function transitionState(state, input, { turn, sourceEventSeq }) {
  if (!state || state.classification !== 'sop_required') throw new Error('state transition is available only for sop_required tasks')
  if (state.outputContract?.continuousUntilTerminal !== true && state.lastModelTransitionTurn === turn) {
    throw new Error('only one goal-first state transition is allowed per turn unless continuousUntilTerminal is enabled')
  }
  const action = String(input?.action || '')
  const next = structuredClone(state)
  // Historical schemaVersion=1 snapshots predate the production-contract
  // fields. Rehydrate the defaults in memory while leaving their append-only
  // records intact; index.js pre-step persists them once on resume.
  next.workContract = state.workContract ?? null
  next.workContractChecksum = state.workContractChecksum ?? null
  next.blueprintConfirmed = state.blueprintConfirmed ?? null
  next.structureContract = state.structureContract ?? null
  next.workContractRef = state.workContractRef ?? null
  next.productionReceipts = Array.isArray(state.productionReceipts) ? state.productionReceipts : []
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
    next.productionReceipts = appendReceipt(next, productionReceipt({
      state,
      node: 'route',
      status: 'completed',
      qaStatus: 'passed',
      checks: ['goal contract recorded'],
      evidence: [next.goalContract.problem],
      actualBindings: { skills: ['goal-first-control', 'three-provinces-six-ministries', 'plan-before-action'], execution: 'host_state_machine_deterministic' },
      artifacts: [{ name: 'goal_contract', checksum: stableJsonChecksumV1(next.goalContract) }],
    }))
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
    let receiptStatus = 'completed'
    let qaStatus = 'passed'
    let checks = []
    let failureFingerprint = null
    let rollbackTo = null
    if (node === 'validate') {
      if (!['passed', 'failed'].includes(input.qaStatus)) throw new Error('validate completion requires qaStatus passed or failed')
      qaStatus = input.qaStatus
      checks = list(input.qaChecks)
      next.qa = { status: input.qaStatus, checks, evidence: proof }
      if (input.qaStatus === 'failed') {
        const target = String(input.rollbackTo || '')
        if (!SOP_NODES.slice(0, SOP_NODES.indexOf('validate')).includes(target)) throw new Error('failed validation requires an earlier rollbackTo node')
        receiptStatus = 'blocked'
        failureFingerprint = { error_code: 'QA_FAILED' }
        rollbackTo = target
      }
    }
    if (node === 'export' && state.qa.status !== 'passed') throw new Error('export requires passed QA')
    if (input.actualBindings !== undefined && (!input.actualBindings || typeof input.actualBindings !== 'object' || Array.isArray(input.actualBindings))) {
      throw contractError('RECEIPT_PARAM_INVALID', 'actualBindings must be an object')
    }
    if (input.artifacts !== undefined && (!Array.isArray(input.artifacts) || input.artifacts.some((item) => !item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name))) {
      throw contractError('RECEIPT_PARAM_INVALID', 'artifacts must be an array of { name, ref|checksum }')
    }
    if (input.versionRefs !== undefined && (!input.versionRefs || typeof input.versionRefs !== 'object' || Array.isArray(input.versionRefs))) {
      throw contractError('RECEIPT_PARAM_INVALID', 'versionRefs must be an object')
    }
    if (input.failureFingerprint !== undefined && input.failureFingerprint !== null && (typeof input.failureFingerprint !== 'object' || Array.isArray(input.failureFingerprint))) {
      throw contractError('RECEIPT_PARAM_INVALID', 'failureFingerprint must be an object or null')
    }
    if (node === 'structure') {
      if (input.workContract !== undefined) {
        const contract = validateWorkContract(input.workContract)
        next.workContract = structuredClone(contract)
        next.workContractChecksum = stableJsonChecksumV1(contract)
        next.blueprintConfirmed = input.confirm === true
      }
      if (input.structureContract !== undefined) {
        next.structureContract = validateStructureContract(input.structureContract)
      }
      if (input.workContractRef !== undefined) {
        next.workContractRef = validateWorkContractRef(input.workContractRef)
      }
      if (next.workContract && next.blueprintConfirmed !== true) {
        throw contractError('WORK_CONTRACT_NOT_CONFIRMED', 'generate requires a confirmed work contract: complete structure with workContract and confirm=true')
      }
    }
    const versionRefs = { ...(input.versionRefs && typeof input.versionRefs === 'object' ? input.versionRefs : {}) }
    if (node === 'structure' && next.workContractChecksum) versionRefs.workContractChecksum = next.workContractChecksum
    const receipt = productionReceipt({
      state,
      node,
      status: receiptStatus,
      qaStatus,
      checks,
      evidence: proof,
      actualBindings: input.actualBindings,
      artifacts: input.artifacts,
      versionRefs,
      failureFingerprint: input.failureFingerprint !== undefined ? input.failureFingerprint : failureFingerprint,
      rollbackTo,
      workContractRef: next.workContractRef,
    })
    next.productionReceipts = appendReceipt(next, receipt)
    if (node === 'validate' && receiptStatus === 'blocked') {
      next.nodes.validate = 'blocked'
      next.phase = 'blocked'
      next.rollbackTarget = rollbackTo
      next.failure = { code: 'QA_FAILED', message: boundedText(input.reason || 'validation failed') }
      return next
    }
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
    const blockCode = boundedText(input.code || 'BLOCKED', 80)
    next.failure = { code: blockCode, message: boundedText(input.reason || 'blocked') }
    // G2+: blocked receipts carry the structured failure fingerprint so a
    // blocked run is diagnosable from the JSONL log alone.
    next.productionReceipts = appendReceipt(next, productionReceipt({
      state,
      node: state.currentNode,
      status: 'blocked',
      qaStatus: 'blocked',
      checks: list(input.qaChecks),
      evidence: evidence(input.evidence),
      artifacts: Array.isArray(input.artifacts) ? input.artifacts : [],
      versionRefs: input.versionRefs && typeof input.versionRefs === 'object' && !Array.isArray(input.versionRefs) ? input.versionRefs : {},
      failureFingerprint: input.failureFingerprint !== undefined ? input.failureFingerprint : { error_code: blockCode },
      rollbackTo,
      workContractRef: state.workContractRef ?? null,
    }))
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
  const workContractChecksum = state.workContractChecksum ? String(state.workContractChecksum).slice(0, 8) : 'none'
  const blueprint = state.blueprintConfirmed === true ? 'confirmed' : (state.blueprintConfirmed === false ? 'draft' : 'none')
  const receipts = Array.isArray(state.productionReceipts) ? state.productionReceipts.length : 0
  const overlay = `province=${provinces}; ministry=${ministries}; gate=${gate}; work_contract=${workContractChecksum}; blueprint=${blueprint}; receipts=${receipts}`
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
