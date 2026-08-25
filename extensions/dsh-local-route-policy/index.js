/**
 * CyberMarcus local-route tool visibility policy.
 *
 * This is deliberately a prompt-assembly policy, not an execution or
 * authority boundary. Hidden specialist tools remain registered and can be
 * reached by a top-level agent through execute_flash/subagents. The policy
 * only reduces the schema payload sent to the small local model.
 */

export const name = 'dsh-local-route-policy'
export const inject = []

// Keep the local request below Ollama's practical 32K context ceiling while
// retaining the development/orchestration surface needed by CyberMarcus.
// This list is intentionally fixed and small. Specialist browser/MCP/media/
// WeChat/ShrimpTank schemas stay registered but are delegated through Marvel
// workers when the local route needs them.
export const LOCAL_MODEL_TOOL_NAMES = Object.freeze([
  'bash',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'str_replace_editor',
  'skill',
  'memory_save',
  'memory_recall',
  'memory_checkpoint',
  'memory_get',
  'memory_list',
  'get_goal',
  'create_goal',
  'update_goal',
  'goal_first_state_get',
  'goal_first_state_transition',
  'todo_write',
  'subagent',
  'subagent_fork',
  'execute_flash',
  'list_agents',
  'send_message',
  'interrupt_agent',
  'workflow',
  'job_output',
  'job_list',
  'job_kill',
  'git_status',
  'git_diff',
  'git_log',
  'git_stage',
  'git_unstage',
  'git_commit',
  'code_index_build',
  'code_index_query',
  'code_repo_map',
  'code_test_impact',
  'intelligence_task_create',
  'intelligence_task_update',
  'intelligence_task_checkpoint',
  'intelligence_task_list',
  'intelligence_context_bundle',
  'schedule_create',
  'schedule_list',
  'web_search',
])

// These are the minimum controls required for the local route to inspect,
// edit, and delegate. A deliberately slim deployment may omit optional
// specialist tools, but losing one of these makes the filtered catalog
// misleading, so local assembly fails closed.
export const REQUIRED_CORE_TOOL_NAMES = Object.freeze([
  'bash',
  'read',
  'skill',
  'subagent',
  'execute_flash',
  'goal_first_state_get',
  'goal_first_state_transition',
])

export class LocalRoutePolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'LocalRoutePolicyError'
    this.code = code
    Object.assign(this, details)
  }
}

function toolName(tool) {
  return typeof tool?.name === 'string' ? tool.name : ''
}

/**
 * Purely filter a PromptAssembly tool array for the local route.
 *
 * The source array and its schema objects are never mutated. Array order is
 * retained exactly. Missing required tools throw instead of returning a
 * deceptively incomplete local catalog (fail-closed assembly gate).
 */
export function filterLocalModelTools(tools, options = {}) {
  if (!Array.isArray(tools)) {
    throw new LocalRoutePolicyError('LOCAL_TOOL_POLICY_INVALID_TOOLS', 'local route policy requires an assembly.tools array')
  }

  const allowedNames = new Set(options.allowedNames || LOCAL_MODEL_TOOL_NAMES)
  const requiredNames = [...(options.requiredNames || REQUIRED_CORE_TOOL_NAMES)]
  const available = new Set(tools.map(toolName).filter(Boolean))
  const missing = requiredNames.filter((required) => !available.has(required))
  if (missing.length > 0) {
    throw new LocalRoutePolicyError(
      'LOCAL_TOOL_POLICY_CORE_MISSING',
      `local route policy refused to hide tools because required core tools are missing: ${missing.join(', ')}`,
      { missing },
    )
  }

  return tools.filter((tool) => allowedNames.has(toolName(tool)))
}

/**
 * Route-aware pure helper used by tests and by the assembly listener.
 * Non-local providers receive the exact original array, including order and
 * object identity. Only the final Ollama route is reduced.
 */
export function filterToolsForProvider(tools, provider, allowlist = LOCAL_MODEL_TOOL_NAMES) {
  if (!Array.isArray(tools)) {
    throw new LocalRoutePolicyError('LOCAL_TOOL_POLICY_INVALID_TOOLS', 'local route policy requires an assembly.tools array')
  }
  if (provider !== 'ollama-local') return tools
  return filterLocalModelTools(tools, {
    allowedNames: allowlist,
    requiredNames: REQUIRED_CORE_TOOL_NAMES,
  })
}

export function isOllamaAssembly(assembly) {
  return assembly?.variables?.provider === 'ollama-local'
}

/**
 * Create the listener separately so the waterfall behavior can be tested
 * without booting a Cordis profile.
 */
export function createAssemblyListener(config = {}) {
  return async function localRouteAssemblyListener(assembly, _context, next) {
    // `next()` is authoritative. Read provider and tools only from its final
    // result so a later scoped listener cannot be bypassed by an earlier view.
    const finalAssembly = await next()
    if (!isOllamaAssembly(finalAssembly)) return finalAssembly
    return {
      ...finalAssembly,
      tools: filterToolsForProvider(
        finalAssembly.tools,
        finalAssembly.variables?.provider,
        config.allowedNames || config.allowlist || LOCAL_MODEL_TOOL_NAMES,
      ),
    }
  }
}

export function apply(ctx, config = {}) {
  if (!ctx || typeof ctx.on !== 'function') return undefined
  const listener = createAssemblyListener(config)
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => ctx.on('system-prompt/assemble', listener), 'dsh-local-route-policy: local tool filter')
  } else {
    ctx.on('system-prompt/assemble', listener)
  }
  return undefined
}
