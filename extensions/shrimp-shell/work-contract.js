// work-contract.js — cybermarcus_work_contract.v1 桥接纯函数模块
// 只做无副作用的构造/投影：把工作合同折叠进抓虾草稿 facts、给运行 POST body
// 附 checksum/版本锁，并生成工具卡片标题。所有返回值都是新对象或原样透传，
// 不改写调用方传入的 base/opts/workContract。

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmpty(value) {
  return value !== undefined && value !== null && String(value) !== ''
}

/**
 * 构造 POST /api/v1/catch-drafts 的 facts。
 * 既有字段逻辑与现实现一致（product_name/institution_name/goal_text/
 * acceptance_text/goal_complete/acceptance_complete/current_step_key）。
 * 当 workContract 为对象时附 facts.work_contract（原样引用）。
 * 兼容投影：goal 为空且 workContract.goal_contract.problem 存在 → goal_text 取之；
 * acceptance 为空且 workContract.qa_contract.final_acceptance 存在 → acceptance_text 取之
 * （数组则取其中字符串项以 '\n' 连接）；用户已填值永不覆盖。
 * current_step_key 相应推进：有验收文本 → knowledge_strategy，否则 acceptance。
 */
export function buildCatchDraftFacts({ product, institution, goal, acceptance, workContract } = {}) {
  const hasContract = isPlainObject(workContract)
  let goalText = String(goal || '').trim()
  let acceptanceText = String(acceptance || '').trim()
  if (!goalText && hasContract) {
    const problem = workContract.goal_contract && workContract.goal_contract.problem
    if (problem !== undefined && problem !== null) goalText = String(problem).trim()
  }
  if (!acceptanceText && hasContract) {
    const finalAcceptance = workContract.qa_contract && workContract.qa_contract.final_acceptance
    if (Array.isArray(finalAcceptance)) {
      acceptanceText = finalAcceptance
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
        .join('\n')
    } else if (finalAcceptance !== undefined && finalAcceptance !== null) {
      acceptanceText = String(finalAcceptance).trim()
    }
  }
  const facts = {
    product_name: String(product || '').trim(),
    institution_name: String(institution || '').trim(),
    goal_text: goalText,
    acceptance_text: acceptanceText,
    goal_complete: Boolean(goalText),
    acceptance_complete: Boolean(acceptanceText),
    current_step_key: acceptanceText ? 'knowledge_strategy' : 'acceptance',
  }
  if (hasContract) facts.work_contract = workContract
  return facts
}

/**
 * 构造 POST /api/v1/pipelines/{slug}/runs 的 body：浅合并 base，
 * 仅当参数非空时附顶层 work_contract_checksum / pipeline_version_id。
 * 值原样透传，不做 trim/类型改写。
 */
export function buildRunBody(base, { workContractChecksum, pipelineVersionId } = {}) {
  const body = { ...(isPlainObject(base) ? base : {}) }
  if (isNonEmpty(workContractChecksum)) body.work_contract_checksum = workContractChecksum
  if (isNonEmpty(pipelineVersionId)) body.pipeline_version_id = pipelineVersionId
  return body
}

/**
 * 创建草稿工具卡片标题；hasContract 时追加『（含工作合同）』。
 */
export function draftCardTitle(base, { hasContract } = {}) {
  const prefix = base === undefined || base === null ? '' : String(base)
  return hasContract ? `${prefix}（含工作合同）` : prefix
}

/**
 * 运行工具卡片标题；追加『锁定运行合同』。
 */
export function runCardTitle(base) {
  const prefix = base === undefined || base === null ? '' : String(base)
  return `${prefix}锁定运行合同`
}
