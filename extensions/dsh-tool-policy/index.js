// dsh-tool-policy — Host-only pre-execute policy for headless profiles.
// This extension never touches client slots, UI files, or the current web
// profile. It only observes/gates the official tools/pre-execute waterfall.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { ToolPolicy, classifyToolCall, normalizePolicyConfig } from './policy.js'

export const name = 'dsh-tool-policy'
export const inject = ['tools']

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
let defineToolPromise

async function resolveDefineTool() {
  if (!defineToolPromise) defineToolPromise = (async () => {
    try {
      const module = await import('@deepseek-ai/dsh-tools')
      if (typeof module.defineTool === 'function') return module.defineTool
    } catch { /* try deployed Host install */ }
    const candidates = [
      join(HOME, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-tools'),
      join(HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools'),
      join(HOME, 'install', 'node_modules', '@deepseek-ai', 'dsh-tools'),
    ]
    for (const candidate of candidates) {
      try {
        const required = createRequire(join(HOME, 'dsh-tool-policy-runtime.cjs'))(candidate)
        if (typeof required.defineTool === 'function') return required.defineTool
      } catch { /* try next path */ }
    }
    throw new Error('dsh-tool-policy requires @deepseek-ai/dsh-tools rc.8 at Host runtime')
  })()
  return defineToolPromise
}

function errorText(error) { return String(error?.message || error || 'unknown error').slice(0, 1_000) }

const RENDER_LIMIT = 12_000
const DETACHED_BACKGROUND_MESSAGE = '后台任务必须移除脱管语法并使用 run_in_background: true；跨重启请使用 schedule/heartbeat/canonical run'
const SHRIMP_RUN_API_BYPASS_MESSAGE = '禁止通过 shell/bash/command 直接写入虾缸运行 API；请使用 shrimp_run 工具。'
const SHELL_TOOL_NAMES = new Set([
  'bash',
  'shell',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'tool-bash',
  'dsh-tool-bash',
  '@deepseek-ai/dsh-tool-bash',
])
const COMMAND_TOOL_NAMES = new Set(['command', 'exec', 'terminal'])
const COMMAND_KEYS = new Set(['command', 'cmd', 'shell', 'script', 'argv', 'args'])

const AVENGERS_PRESET_ID = 'avengers'
const AVENGERS_CHILD_ROUTE = Object.freeze({
  provider: 'zhipu-glm',
  model: 'glm-5.3-flash',
  reasoningEffort: 'medium',
})
const AVENGERS_PARENT_TOOLS = new Set([
  'avenger',
  'ask_user_question',
  'create_goal',
  'exit_plan_mode',
  'get_goal',
  'goal_first_state_get',
  'goal_first_state_transition',
  'interrupt_agent',
  'list_agents',
  'memory_checkpoint',
  'memory_get',
  'memory_list',
  'memory_recall',
  'memory_record',
  'memory_save',
  'memory_search',
  'policy_evaluate',
  'policy_metrics',
  'policy_list',
  'send_message',
  'skill',
  'shrimp_list',
  'shrimp_match',
  'shrimp_knowledge_list',
  'shrimp_knowledge_search',
  'shrimp_run_status',
  'todo_write',
  'update_goal',
])

function sessionRoot(agent) {
  return agent?.session && typeof agent.session === 'object' ? agent.session : {}
}

function sessionField(agent, field) {
  const session = sessionRoot(agent)
  const header = session.header && typeof session.header === 'object' ? session.header : {}
  const value = session[field]
  if (value !== null && value !== undefined && String(value).trim() !== '') return value
  const headerValue = header[field]
  return headerValue !== null && headerValue !== undefined && String(headerValue).trim() !== '' ? headerValue : undefined
}

function sessionAgentPreset(agent) {
  const session = sessionRoot(agent)
  const events = Array.isArray(session.events) ? session.events : []
  // A later live selection supersedes the creation-time preset persisted on
  // the session root. Ignore malformed selection events and continue to the
  // next compatibility source.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'agent-preset/selected') continue
    const selected = event.data?.agentPreset
    if (selected !== null && selected !== undefined && String(selected).trim() !== '') return selected
  }
  // The persisted session root is authoritative when no later selection is
  // recorded. Older sessions only expose agentPreset in session.header.
  const rootPreset = session.agentPreset ?? session.agent_preset
  if (rootPreset !== null && rootPreset !== undefined && String(rootPreset).trim() !== '') return rootPreset
  return sessionField(agent, 'agentPreset')
}

/**
 * Resolve the preset that governs this live agent, not only its creation-time
 * header. Blank sessions may record a later `agent-preset/selected` event, and
 * a mounted preset is the strongest live source because it is the composition
 * whose tools and listeners actually cover the agent.
 */
export function effectiveAgentPreset(agent) {
  const agentCtx = agent?.ctx
  if (agentCtx) {
    const candidates = []
    try { if (agentCtx.agentPresets) candidates.push(agentCtx.agentPresets) } catch { /* fall through to ctx.get */ }
    try {
      if (typeof agentCtx.get === 'function') candidates.push(agentCtx.get('agentPresets'))
    } catch { /* fall through to the session log */ }
    for (const agentPresets of candidates) {
      if (!agentPresets || typeof agentPresets.composedPreset !== 'function') continue
      try {
        const preset = agentPresets.composedPreset(agentCtx)
        if (typeof preset === 'string' && preset.trim()) return preset
      } catch { /* fall through to the session log */ }
    }
  }
  return sessionAgentPreset(agent)
}

export function avengersAgentRole(agent) {
  if (effectiveAgentPreset(agent) !== AVENGERS_PRESET_ID) return 'other'
  const origin = sessionField(agent, 'origin')
  const delegationDepth = sessionField(agent, 'delegationDepth')
  return origin === 'subagent' || Number(delegationDepth || 0) > 0 ? 'child' : 'parent'
}

export function avengersParentToolDecision(exec) {
  if (avengersAgentRole(exec?.agent) !== 'parent') return undefined
  const toolName = String(exec?.name || '')
  if (AVENGERS_PARENT_TOOLS.has(toolName)) return undefined
  return {
    kind: 'deny',
    code: 'AVENGERS_PARENT_EXECUTION_BLOCKED',
    reason: `Avengers 主代理只负责目标、派单、监督和验收；请把 ${toolName || '该操作'} 直接分配给 avenger 子代理执行`,
  }
}

export function createAvengersRequestListener() {
  return async function avengersRequestListener(payload, next) {
    const resolved = await next()
    if (avengersAgentRole(payload?.agent) !== 'child') return resolved
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
    return { ...withoutInheritedEffort, ...AVENGERS_CHILD_ROUTE }
  }
}

function shellToolName(toolName) {
  const value = String(toolName ?? '').trim().toLowerCase()
  return SHELL_TOOL_NAMES.has(value) || /(?:^|[-_:])(?:bash|shell)(?:$|[-_:])/.test(value)
}

function commandToolName(toolName) {
  const value = String(toolName ?? '').trim().toLowerCase()
  return shellToolName(value)
    || COMMAND_TOOL_NAMES.has(value)
    || /(?:^|[-_:])(?:command|exec|terminal)(?:$|[-_:])/.test(value)
}

// For ampersand detection, replace quoted and escaped text with spaces while
// retaining shell operators. Utility names are checked separately against raw
// command text so nested `bash -lc "nohup ..."` cannot hide from the gate.
function maskShellLiterals(value) {
  const source = String(value ?? '')
  let result = ''
  let quote = ''
  let escaped = false
  let comment = false
  for (const character of source) {
    if (comment) {
      if (character === '\n') comment = false
      result += character === '\n' ? '\n' : ' '
      continue
    }
    if (escaped) {
      result += ' '
      escaped = false
      continue
    }
    if (quote === "'") {
      result += character === "'" ? ' ' : ' '
      if (character === "'") quote = ''
      continue
    }
    if (quote === '"') {
      if (character === '\\') {
        result += ' '
        escaped = true
      } else {
        result += ' '
        if (character === '"') quote = ''
      }
      continue
    }
    if (character === '\\') {
      result += ' '
      escaped = true
    } else if (character === "'" || character === '"') {
      result += ' '
      quote = character
    } else if (character === '#') {
      result += ' '
      comment = true
    } else {
      result += character
    }
  }
  return result
}

function commandValues(value, fieldName = '', depth = 0) {
  if (depth > 4 || value === null || value === undefined) return []
  if (typeof value === 'string') return COMMAND_KEYS.has(fieldName.toLowerCase()) ? [value] : []
  if (Array.isArray(value)) {
    if (!COMMAND_KEYS.has(fieldName.toLowerCase())) return []
    return value.flatMap((item) => typeof item === 'string' ? [item] : commandValues(item, fieldName, depth + 1))
  }
  if (typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => commandValues(child, key, depth + 1))
}

function commandTexts(args) {
  const values = typeof args === 'string' ? [args] : commandValues(args)
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    for (const key of COMMAND_KEYS) {
      if (!Array.isArray(args[key])) continue
      const tokens = args[key].filter((item) => typeof item === 'string')
      if (tokens.length) values.push(tokens.join(' '))
    }
  }
  return [...new Set(values.map((value) => String(value).replace(/\\\//g, '/')))]
}

const SHRIMP_RUN_ENDPOINT_RE = /(?:https?:\/\/)?127\.0\.0\.1:7843\/(?:api\/v1\/pipelines\/[A-Za-z0-9_.-]+\/runs|api\/pipelines\/[A-Za-z0-9_.-]+\/run)(?=[/?#\s"'`),;]|$)/iu

function shellCommandSegments(source) {
  return String(source || '').split(/(?:&&|\|\||[;\n])/u)
}

function curlWritesShrimpRunApi(source) {
  for (const segment of shellCommandSegments(source)) {
    if (!/\bcurl\b/iu.test(segment) || !SHRIMP_RUN_ENDPOINT_RE.test(segment)) continue
    const explicit = segment.match(/(?:^|\s)(?:-X|--request)(?:\s*=\s*|\s*)(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)\b/iu)
    if (explicit) {
      if (/^(?:POST|PUT)$/iu.test(explicit[1])) return true
      continue
    }
    if (/(?:^|\s)(?:-G|--get)(?:\s*=|\s|$)/iu.test(segment)) continue
    // curl sends POST when a data flag is present; -T/--upload-file sends PUT.
    if (/(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode)?|--json|--form|-F|--upload-file|-T)(?:\s*=|\s|$)/iu.test(segment)) return true
  }
  return false
}

function structuredClientWritesShrimpRunApi(source) {
  const text = String(source || '')
  if (!SHRIMP_RUN_ENDPOINT_RE.test(text)) return false
  // requests/httpx/axios/client.post(...) and request('POST', ...) forms.
  if (/\.\s*(?:post|put)\s*\(/iu.test(text)) return true
  if (/\b(?:request|request_async|request_sync)\s*\(\s*["']?(?:POST|PUT)\b/iu.test(text)) return true
  // urllib Request(..., method='POST') and urlopen(..., data=...) forms.
  if (/\bmethod\s*[:=]\s*["']?(?:POST|PUT)\b/iu.test(text)) return true
  if (/\b(?:Request|urlopen)\s*\([\s\S]{0,320}\bdata\s*[:=]/iu.test(text)) return true
  // Generic fetch/http clients and command-line HTTP clients.
  if (/\b(?:method\s*[:=]\s*["']?(?:POST|PUT)|(?:POST|PUT)\s+https?:\/\/)/iu.test(text)) return true
  if (/\b(?:http|httpie)\s+(?:[^\s]+\s+)*(?:POST|PUT)\b[\s\S]{0,240}127\.0\.0\.1:7843/iu.test(text)) return true
  if (/\bwget\b[\s\S]{0,240}(?:--method\s*=\s*|--method\s+)(?:POST|PUT)\b/iu.test(text)) return true
  return false
}

/**
 * Global hard gate for attempts to bypass shrimp_run through a command tool.
 * Read-only health/summary requests and non-command tools are intentionally
 * outside this gate. The gate is independent of policy mode and Avengers
 * parent restrictions.
 */
export function shrimpRunApiBypassReason(toolName, args = {}) {
  if (!commandToolName(toolName)) return undefined
  const texts = commandTexts(args)
  for (const text of texts) {
    if (!SHRIMP_RUN_ENDPOINT_RE.test(text)) continue
    if (curlWritesShrimpRunApi(text) || structuredClientWritesShrimpRunApi(text)) {
      return { kind: 'deny', code: 'SHRIMP_RUN_API_BYPASS_BLOCKED', reason: SHRIMP_RUN_API_BYPASS_MESSAGE }
    }
  }
  return undefined
}

function hasStandaloneAmpersand(value) {
  const masked = maskShellLiterals(value)
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] !== '&') continue
    const previous = masked[index - 1] || ''
    const next = masked[index + 1] || ''
    // Keep compound conditionals and redirections (`&&`, `&>`, `>&`, `|&`)
    // out of the detached-process gate.
    if (previous === '&' || next === '&' || previous === '>' || next === '>' || previous === '|' || next === '|') continue
    return true
  }
  return false
}

function shellTokens(value) {
  const source = String(value ?? '')
  const tokens = []
  let current = ''
  let quote = ''
  let quoted = false
  let escaped = false
  const flush = () => {
    if (current || quoted) tokens.push({ value: current, quoted })
    current = ''
    quoted = false
  }
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (quote) {
      if (character === quote) {
        quote = ''
        quoted = true
      } else if (quote === '"' && character === '\\') escaped = true
      else current += character
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      quoted = true
      continue
    }
    if (character === '#') {
      if (!current) {
        while (index < source.length && source[index] !== '\n') index += 1
        flush()
        if (index < source.length) tokens.push({ operator: '\n' })
        continue
      }
    }
    if (/\s/.test(character)) {
      flush()
      if (character === '\n') tokens.push({ operator: '\n' })
      continue
    }
    if (';&|()'.includes(character)) {
      flush()
      const pair = source.slice(index, index + 2)
      if (pair === '&&' || pair === '||' || pair === '|&' || pair === '&>') {
        tokens.push({ operator: pair })
        index += 1
      } else tokens.push({ operator: character })
      continue
    }
    current += character
  }
  if (escaped) current += '\\'
  flush()
  return tokens
}

const COMMAND_SEPARATORS = new Set(['\n', ';', '&&', '||', '|', '|&', '&', '('])
const CONTROL_WORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', 'time'])
const COMMAND_PREFIXES = new Set(['command', 'builtin', 'exec', 'sudo', 'env'])
const DETACHED_UTILITIES = new Set(['nohup', 'disown', 'setsid'])

function commandName(value) {
  return String(value ?? '').split('/').filter(Boolean).pop()?.toLowerCase() || ''
}

function hasDetachedUtility(value, depth = 0) {
  if (depth > 4) return null
  // Re-run the operator check for recursive `shell -c` / `eval` payloads.
  // Their quoted ampersand is literal to the parent, but active shell syntax
  // once the child parses the payload.
  if (hasStandaloneAmpersand(value)) return '&'
  const tokens = shellTokens(value)
  let commandPosition = true
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.operator) {
      if (COMMAND_SEPARATORS.has(token.operator) || token.operator === ')') commandPosition = true
      continue
    }
    const lower = token.value.toLowerCase()
    if (!commandPosition) continue
    if (CONTROL_WORDS.has(lower)) continue
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) continue
    let name = commandName(token.value)
    while (COMMAND_PREFIXES.has(name)) {
      index += 1
      while (index < tokens.length && !tokens[index].operator && (/^-/.test(tokens[index].value) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index].value))) index += 1
      if (index >= tokens.length || tokens[index].operator) break
      name = commandName(tokens[index].value)
    }
    if (DETACHED_UTILITIES.has(name)) return name
    if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(name)) {
      for (let cursor = index + 1; cursor < tokens.length && !tokens[cursor].operator; cursor += 1) {
        if (!/^-.*c/.test(tokens[cursor].value)) continue
        const payload = tokens[cursor + 1]?.value
        const nested = payload ? hasDetachedUtility(payload, depth + 1) : null
        if (nested) return nested
        break
      }
    } else if (name === 'eval') {
      const payload = []
      for (let cursor = index + 1; cursor < tokens.length && !tokens[cursor].operator; cursor += 1) payload.push(tokens[cursor].value)
      const nested = payload.length ? hasDetachedUtility(payload.join(' '), depth + 1) : null
      if (nested) return nested
    }
    commandPosition = false
  }
  return null
}

/**
 * Pure hard-gate classifier for detached shell work. Returns the deny decision
 * for high-confidence shell syntax and `undefined` for all other calls.
 */
export function detachedBackgroundReason(toolName, args = {}) {
  if (!shellToolName(toolName)) return undefined
  const values = typeof args === 'string' ? [args] : commandValues(args)
  for (const value of values) {
    if (hasStandaloneAmpersand(value) || hasDetachedUtility(value)) return { kind: 'deny', reason: DETACHED_BACKGROUND_MESSAGE }
  }
  return undefined
}

function redactPolicyValue(value, key = '') {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (/(?:token|secret|password|credential|api[_-]?key|authorization)/i.test(key)) return '[redacted]'
    return value
      .replace(/((?:Bearer|Basic)\s+)[^\s,;]+/gi, '$1[redacted]')
      .replace(/((?:token|secret|password|credential|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
      .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, '[redacted]')
      .slice(0, 600)
  }
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => redactPolicyValue(item, key))
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactPolicyValue(childValue, childKey)]))
  return String(value)
}

function policyRenderValue(kind, value) {
  if (value?.ok === false) return { ok: false, code: value.code ?? null, error: redactPolicyValue(value.error ?? '', 'error'), truncated: false }
  if (kind === 'evaluate') {
    const result = value?.result ?? {}
    return {
      ok: true,
      result: {
        toolName: result.toolName,
        mode: result.mode,
        operationMode: result.operationMode,
        observed: result.observed,
        decision: result.decision,
        appliedDecision: result.appliedDecision,
        hardGate: result.hardGate,
        classification: {
          category: result.classification?.category,
          categories: result.classification?.categories,
          pathBoundary: result.classification?.pathBoundary,
          reasons: result.classification?.reasons,
          unknown: result.classification?.unknown,
          commandInspected: result.classification?.commandInspected,
        },
        matchedPatterns: result.matchedPatterns,
        argumentsRedacted: true,
      },
      truncated: false,
    }
  }
  if (kind === 'metrics') return { ok: true, metrics: value?.metrics, truncated: false }
  return { ok: true, policy: value?.policy, truncated: false }
}

function boundedPolicyJson(kind, value) {
  const selected = redactPolicyValue(policyRenderValue(kind, value))
  let text = JSON.stringify(selected)
  if (text.length <= RENDER_LIMIT) return text
  const compact = { ok: value?.ok === true, truncated: true }
  if (kind === 'evaluate') compact.result = { decision: value?.result?.decision, appliedDecision: value?.result?.appliedDecision, hardGate: value?.result?.hardGate, classification: { category: value?.result?.classification?.category, pathBoundary: value?.result?.classification?.pathBoundary, reasons: value?.result?.classification?.reasons } }
  if (kind === 'metrics') compact.metrics = { metrics: value?.metrics?.metrics, recentCount: value?.metrics?.recent?.length ?? 0 }
  if (kind === 'list') compact.policy = { mode: value?.policy?.mode, operationMode: value?.policy?.operationMode, workspaceRoots: value?.policy?.workspaceRoots }
  text = JSON.stringify(redactPolicyValue(compact))
  return text.length <= RENDER_LIMIT ? text : JSON.stringify({ ok: value?.ok === true, truncated: true })
}

function outputSchema() {
  return { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true }, error: { type: 'string' }, code: { type: 'string' } } }
}

function configFromContext(ctx, rowConfig) {
  const supplied = rowConfig !== undefined && rowConfig !== null
    ? rowConfig
    : ctx.toolPolicyConfig
    || ctx.toolPolicy
    || ctx.config?.toolPolicy
    || (ctx.config && (ctx.config.mode || ctx.config.operationMode || ctx.config.workspaceRoots) ? ctx.config : null)
    || (typeof ctx.get === 'function' ? ctx.get('toolPolicyConfig') : null)
    || {}
  if (typeof supplied === 'string') {
    try { return JSON.parse(supplied) } catch { return {} }
  }
  return supplied && typeof supplied === 'object' ? supplied : {}
}

export async function apply(ctx, config) {
  const defineTool = await resolveDefineTool()
  const suppliedConfig = configFromContext(ctx, config)
  const policy = new ToolPolicy(suppliedConfig)
  const blockDetachedBackground = suppliedConfig?.blockDetachedBackground !== false
  policy.config.blockDetachedBackground = blockDetachedBackground
  const { tools } = ctx
  const register = (spec, renderKind) => tools.register(defineTool({
    ...spec,
    output: {
      schema: outputSchema(),
      render: (_args, value) => [{ type: 'text', text: boundedPolicyJson(renderKind, value) }],
    },
  }))

  register({
    name: 'policy_evaluate',
    description: '显式评估一次工具调用的分类、workspace 边界和 allow/ask/deny 决策；不会执行目标工具。',
    parameters: {
      toolName: { type: 'string', required: true },
      arguments: { type: 'object', additionalProperties: true, description: '目标工具的结构化参数；图片、网页和记忆正文不会被策略扫描' },
    },
    output: { schema: outputSchema(), render: (_a, value) => [{ type: 'text', text: value.ok ? JSON.stringify(value.result) : `失败: ${value.error}` }] },
    timeoutMs: 10_000,
    async execute(args) {
      try {
        const detached = blockDetachedBackground ? detachedBackgroundReason(args.toolName, args.arguments || {}) : undefined
        const result = policy.evaluate(args.toolName, args.arguments || {}, detached ? { id: 'detached-background', decision: detached } : undefined)
        return { ok: true, result }
      } catch (error) { return { ok: false, code: 'POLICY_EVALUATE_ERROR', error: errorText(error) } }
    },
    presentCall() { return { card: 'generic', title: 'Evaluate tool policy' } },
  }, 'evaluate')

  register({
    name: 'policy_metrics',
    description: '显式读取本进程内存中的策略决策计数和最近记录；不会读取会话、网页、图片或记忆内容。',
    parameters: { recentLimit: { type: 'integer', description: '最近记录数量，默认 50' } },
    output: { schema: outputSchema(), render: (_a, value) => [{ type: 'text', text: value.ok ? JSON.stringify(value.metrics) : `失败: ${value.error}` }] },
    timeoutMs: 10_000,
    async execute(args) {
      try {
        const metrics = policy.snapshot()
        const limit = Math.max(0, Math.min(metrics.recent.length, Number(args.recentLimit || 50)))
        metrics.recent = metrics.recent.slice(-limit)
        return { ok: true, metrics }
      } catch (error) { return { ok: false, code: 'POLICY_METRICS_ERROR', error: errorText(error) } }
    },
    presentCall() { return { card: 'generic', title: 'Policy metrics' } },
  }, 'metrics')

  register({
    name: 'policy_list',
    description: '显式查看当前策略配置和可用模式；策略不会自动修改工具或 UI。',
    parameters: {},
    output: { schema: outputSchema(), render: (_a, value) => [{ type: 'text', text: value.ok ? JSON.stringify(value.policy) : `失败: ${value.error}` }] },
    timeoutMs: 10_000,
    async execute() { return { ok: true, policy: policy.snapshot().config } },
    presentCall() { return { card: 'generic', title: 'List tool policy' } },
  }, 'list')

  const listener = async (exec, next) => {
    const shrimpBypass = shrimpRunApiBypassReason(exec?.name || '', exec?.arguments || {})
    if (shrimpBypass) {
      // This hard gate is global: policy observe mode and Avengers role
      // restrictions must not turn a direct API bypass into an allow/ask.
      policy.evaluate(exec?.name || '', exec?.arguments || {}, { id: 'shrimp-run-api-bypass', decision: shrimpBypass })
      return shrimpBypass
    }
    const avengersDecision = avengersParentToolDecision(exec)
    if (avengersDecision) return avengersDecision
    const detached = blockDetachedBackground ? detachedBackgroundReason(exec?.name || '', exec?.arguments || {}) : undefined
    const result = policy.evaluate(exec?.name || '', exec?.arguments || {}, detached ? { id: 'detached-background', decision: detached } : undefined)
    if (detached) return detached
    if (policy.config.mode === 'observe' || result.appliedDecision.kind === 'allow') return next()
    return result.appliedDecision
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => typeof ctx.on === 'function' ? ctx.on('tools/pre-execute', listener) : undefined, 'dsh-tool-policy: pre-execute policy')
    ctx.effect(() => typeof ctx.on === 'function' ? ctx.on('agent/request', createAvengersRequestListener()) : undefined, 'dsh-tool-policy: Avengers child route')
  } else if (typeof ctx.on === 'function') {
    ctx.on('tools/pre-execute', listener)
    ctx.on('agent/request', createAvengersRequestListener())
  }
  if (typeof ctx.provide === 'function') ctx.provide('dshToolPolicy', {
    policy,
    classifyToolCall,
    detachedBackgroundReason,
    shrimpRunApiBypassReason,
    avengersAgentRole,
    avengersParentToolDecision,
    avengersChildRoute: { ...AVENGERS_CHILD_ROUTE },
    config: { ...normalizePolicyConfig(policy.config), blockDetachedBackground },
  })
  return undefined
}

export { ToolPolicy, classifyToolCall, normalizePolicyConfig }
