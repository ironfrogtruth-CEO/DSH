// Chinese presentCall titles for the goal-first Host tools. Kept in its own
// module so the tests can pin the full mapping without driving the runtime.

const COMPLETE_NODE_TITLES = Object.freeze({
  parse: '核对真源',
  structure: '锁定生产蓝图',
  generate: '按蓝图执行',
  validate: '执行QA',
  export: '交付产出',
  review: '复盘核对',
})

export function goalFirstCardTitle(action, node) {
  if (action === 'get') return '读取工作合同'
  if (action === 'record_goal') return '建立目标合同'
  if (action === 'complete_node') return COMPLETE_NODE_TITLES[node] || 'Goal-first 状态迁移'
  if (action === 'pause') return '暂停待确认'
  if (action === 'block') return '阻断回滚'
  if (action === 'resume') return '恢复执行'
  return 'Goal-first 状态迁移'
}
