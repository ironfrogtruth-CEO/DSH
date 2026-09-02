import { homedir } from 'node:os'
import { isAbsolute, dirname, relative, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'

export const SUBSCRIBER_PROTECTED_RESPONSE = '订阅者只能使用已授权能力，不能读取或修改大神本体、配置、工作模式、Skill、插件或虾定义。'
export const SUBSCRIBER_WORKSPACE_RESPONSE = '该操作只能访问当前选中的订阅工作区。'
export const SUBSCRIBER_SHRIMP_RESPONSE = '这只虾不存在或你没有使用权限。'

const CORE_TOOL_NAMES = new Set([
  'bash', 'shell', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'terminal', 'command', 'exec',
  'read', 'write', 'edit', 'apply_patch', 'str_replace_editor', 'file_read', 'file_write',
  'read_file', 'write_file', 'move_file', 'copy_file', 'delete_file',
])
const HARD_DENY_COMMAND_TOOL_NAMES = new Set(['bash', 'shell', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'terminal', 'command', 'exec'])
const SHRIMP_LIST_NAMES = new Set(['shrimp_list', 'shrimp_match', 'shrimp_search', 'shrimp_knowledge_list', 'shrimp_knowledge_search'])
const SHRIMP_RUN_NAMES = new Set(['shrimp_run', 'shrimp_run_status'])
const CAPABILITY_ADMIN_NAMES = new Set([
  'skill_install', 'skill_remove', 'plugin_install', 'plugin_remove', 'plugin_update',
  'model_install', 'connector_install', 'preset_create', 'preset_update', 'mode_create',
  'shrimp_create', 'shrimp_edit', 'shrimp_publish', 'shrimp_delete', 'workflow_create',
  'workflow_update', 'sandbox_upgrade', 'elevate_sandbox', 'sudo',
])
const SENSITIVE_SEGMENTS = new Set([
  '.dsh', '大神.app', 'skills', 'skill', 'plugins', 'plugin', 'presets', 'preset',
  'modes', 'mode', 'credentials', 'secrets', 'config', 'configuration', 'system-prompt',
  'system_prompt', 'workflows', 'workflow-definitions', '虾定义', '虾缸源码',
])
const PATH_KEYS = new Set([
  'path', 'paths', 'cwd', 'directory', 'dir', 'file', 'files', 'filename', 'filenames',
  'target', 'source', 'destination', 'dest', 'output', 'workspace', 'workspaceRoot',
  'workspace_root', 'root', 'absolutePath', 'absolute_path',
])
const COMMAND_KEYS = new Set(['command', 'cmd', 'script', 'shell', 'argv', 'args'])

function asText(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : ''
}

function flattenValues(value, key = '', depth = 0) {
  if (depth > 5 || value === null || value === undefined) return []
  if (typeof value === 'string') return [{ key, value }]
  if (Array.isArray(value)) return value.flatMap((item) => flattenValues(item, key, depth + 1))
  if (typeof value !== 'object') return []
  return Object.entries(value).flatMap(([entryKey, entryValue]) => flattenValues(entryValue, entryKey, depth + 1))
}

export function normalizePath(value, base = process.cwd()) {
  let raw = asText(value)
  if (!raw || /^(?:https?|wss?|data):/iu.test(raw)) return null
  if (raw.includes('\u0000')) return null
  // Decode URL-escaped traversal once (and only once more for nested
  // encodings) before resolving.  A downstream file adapter may decode these
  // sequences, so the lexical gate must inspect the decoded form as well.
  for (let depth = 0; depth < 2 && /%[0-9a-f]{2}/iu.test(raw); depth += 1) {
    try {
      const decoded = decodeURIComponent(raw)
      if (decoded === raw) break
      raw = decoded
    } catch { return null }
  }
  if (raw === '~' || raw.startsWith('~/')) return resolve(homedir(), raw.slice(2))
  return isAbsolute(raw) ? resolve(raw) : resolve(base, raw)
}

function existingRealPath(value) {
  let candidate = resolve(value)
  const suffix = []
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const base = realpathSync(candidate)
      return suffix.length ? resolve(base, ...suffix.reverse()) : base
    } catch {
      const parent = dirname(candidate)
      if (parent === candidate) return null
      suffix.push(candidate.slice(parent.length + 1))
      candidate = parent
    }
  }
  return null
}

export function isPathWithin(root, candidate) {
  const base = normalizePath(root)
  const target = normalizePath(candidate, base || process.cwd())
  if (!base || !target) return false
  const rest = relative(base, target)
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
}

export function protectedRoots(options = {}) {
  const dshRoot = options.dshRoot || process.env.DSH_HOME || resolve(homedir(), '.dsh')
  return [
    dshRoot,
    options.appRoot || '/Applications/大神.app',
    options.shrimpRoot || resolve(homedir(), 'Desktop', '虾缸'),
    options.credentialsRoot || resolve(dshRoot, 'private'),
  ].map((item) => normalizePath(item)).filter(Boolean)
}

function segmentProtected(pathValue) {
  const pieces = String(pathValue || '').split(/[\\/]+/u).filter(Boolean)
  return pieces.some((piece) => SENSITIVE_SEGMENTS.has(piece.toLowerCase()) || SENSITIVE_SEGMENTS.has(piece))
}

export function workspacePathDecision(pathValue, workspaceRoot, options = {}) {
  const workspace = normalizePath(workspaceRoot)
  if (!workspace) return { allowed: false, code: 'SUBSCRIBER_WORKSPACE_MISSING', reason: SUBSCRIBER_WORKSPACE_RESPONSE }
  const raw = asText(pathValue)
  if (!raw) return { allowed: true, path: workspace }
  const candidate = normalizePath(raw, workspace)
  if (!candidate || !isPathWithin(workspace, candidate)) {
    return { allowed: false, code: 'SUBSCRIBER_WORKSPACE_ESCAPE', reason: SUBSCRIBER_WORKSPACE_RESPONSE, path: candidate }
  }
  if (protectedRoots(options).some((root) => isPathWithin(root, candidate))) {
    return { allowed: false, code: 'SUBSCRIBER_CORE_PATH_BLOCKED', reason: SUBSCRIBER_PROTECTED_RESPONSE, path: candidate }
  }
  const workspaceReal = existingRealPath(workspace)
  const candidateReal = existingRealPath(candidate)
  if (workspaceReal && candidateReal && !isPathWithin(workspaceReal, candidateReal)) {
    return { allowed: false, code: 'SUBSCRIBER_WORKSPACE_ESCAPE', reason: SUBSCRIBER_WORKSPACE_RESPONSE, path: candidate }
  }
  // A workspace may legitimately be named "config"; reject sensitive path
  // segments only below the workspace root so the selected root itself is not
  // accidentally denied.  This still prevents `workspace/.dsh/...` and
  // workflow/preset definition folders from being used as a side door.
  const rest = relative(workspace, candidate)
  if (rest && segmentProtected(rest)) {
    return { allowed: false, code: 'SUBSCRIBER_CORE_PATH_BLOCKED', reason: SUBSCRIBER_PROTECTED_RESPONSE, path: candidate }
  }
  return { allowed: true, path: candidate }
}

function commandText(args) {
  return flattenValues(args).filter(({ key }) => COMMAND_KEYS.has(key) || !key).map(({ value }) => value).join('\n')
}

function pathValues(args) {
  return flattenValues(args).filter(({ key }) => PATH_KEYS.has(key) || PATH_KEYS.has(String(key).toLowerCase())).map(({ value }) => value)
}

export function classifyProtectedContentRequest(input) {
  const text = asText(typeof input === 'string' ? input : input?.text || input?.message || input?.prompt || input?.content)
  if (!text) return { protected: false, category: 'ordinary', code: null, reason: null }
  const lowered = text.toLocaleLowerCase('zh-CN')
  const readIntent = /(读取|查看|展示|给出|给我|提供|说明|解释|告诉我|导出|打印|dump|show|reveal|disclose|read|cat|内容)/iu.test(text)
  const mutateIntent = /(修改|篡改|新增|创建|安装|删除|升级|编辑|覆盖|写入|重置|改动|update|write|edit|install|delete|create|change)/iu.test(text)
  if (/(?:系统提示词|系统提示|system\s*prompt|隐藏提示|内部提示|prompt\s*泄露)/iu.test(text)) {
    return { protected: true, category: 'prompt_disclosure', code: 'SUBSCRIBER_PROMPT_BLOCKED', reason: SUBSCRIBER_PROTECTED_RESPONSE }
  }
  if (/(?:配置文件|配置内容|配置参数|\.dsh|config(?:uration)?\s*(?:file|content|value)|credentials?|secret|api[-_ ]?key|token\s*(?:配置|额度|账本))/iu.test(text) && (readIntent || mutateIntent)) {
    return { protected: true, category: mutateIntent ? 'core_mutation' : 'config_disclosure', code: mutateIntent ? 'SUBSCRIBER_CORE_MUTATION_BLOCKED' : 'SUBSCRIBER_CONFIG_BLOCKED', reason: SUBSCRIBER_PROTECTED_RESPONSE }
  }
  if (/(?:工作模式|模式定义|mode\s*(?:definition|file|content)|预设(?:文件|定义|内容)|preset\s*(?:definition|file|content))/iu.test(text) && (readIntent || mutateIntent)) {
    return { protected: true, category: mutateIntent ? 'core_mutation' : 'mode_disclosure', code: mutateIntent ? 'SUBSCRIBER_CORE_MUTATION_BLOCKED' : 'SUBSCRIBER_MODE_BLOCKED', reason: SUBSCRIBER_PROTECTED_RESPONSE }
  }
  if (/(?:skill|插件|plugin|连接器|connector|能力|工作流定义|workflow\s*(?:definition|file|content))/iu.test(text) && (readIntent || mutateIntent)) {
    return { protected: true, category: mutateIntent ? 'capability_creation' : 'capability_disclosure', code: mutateIntent ? 'SUBSCRIBER_CAPABILITY_BLOCKED' : 'SUBSCRIBER_CAPABILITY_CONTENT_BLOCKED', reason: SUBSCRIBER_PROTECTED_RESPONSE }
  }
  if (/(?:虾缸源码|虾定义|虾的(?:实际|原始)?(?:文件|源码|实现|配置|内容)|shrimp\s*(?:definition|source|file|implementation))/iu.test(text) && (readIntent || mutateIntent)) {
    return { protected: true, category: mutateIntent ? 'capability_creation' : 'shrimp_definition_disclosure', code: mutateIntent ? 'SUBSCRIBER_CAPABILITY_BLOCKED' : 'SUBSCRIBER_SHRIMP_DEFINITION_BLOCKED', reason: SUBSCRIBER_PROTECTED_RESPONSE }
  }
  if (/(?:大神本体|大神功能|系统功能|新增功能|修改大神|改大神)/iu.test(text) && mutateIntent) {
    return { protected: true, category: 'core_mutation', code: 'SUBSCRIBER_CORE_MUTATION_BLOCKED', reason: SUBSCRIBER_PROTECTED_RESPONSE }
  }
  if (/(?:沙箱|sandbox)\s*(?:升权|提权|elevat|upgrade)|(?:sudo|run\s+as\s+root|管理员权限)/iu.test(text)) {
    return { protected: true, category: 'sandbox_escalation', code: 'SUBSCRIBER_SANDBOX_ESCALATION_BLOCKED', reason: SUBSCRIBER_PROTECTED_RESPONSE }
  }
  return { protected: false, category: 'ordinary', code: null, reason: null }
}

export const isProtectedContentRequest = (input) => classifyProtectedContentRequest(input).protected

function hasAbsoluteCommandEscape(text, workspaceRoot, options) {
  const absolutePaths = String(text || '').match(/(?:^|[\s'"`=])\/(?:[^\s'"`;&|()]+)+/gu) || []
  for (const candidate of absolutePaths) {
    const pathValue = candidate.trim().replace(/^[='"`]/u, '')
    const decision = workspacePathDecision(pathValue, workspaceRoot, options)
    if (!decision.allowed) return decision
  }
  if (/(?:^|[;&|\n])\s*(?:sudo|su\s|doas|pkexec)\b/iu.test(text)) {
    return { allowed: false, code: 'SUBSCRIBER_SANDBOX_ESCALATION_BLOCKED', reason: SUBSCRIBER_PROTECTED_RESPONSE }
  }
  return null
}

/**
 * Hard, subscriber-only tool gate.  It is deliberately independent of the
 * existing observe-mode policy: an observe policy never weakens this result.
 */
export function evaluateSubscriberToolCall(input = {}) {
  const toolName = asText(input.toolName || input.name).toLowerCase()
  const args = input.arguments || input.args || {}
  const workspaceRoot = input.workspaceRoot || input.currentWorkspaceRoot || input.workspace
  const text = [input.text, input.message, input.prompt, commandText(args)].filter(Boolean).join('\n')
  const content = classifyProtectedContentRequest(text)
  if (content.protected) return { allowed: false, ...content, toolName }
  if (HARD_DENY_COMMAND_TOOL_NAMES.has(toolName)) {
    return { allowed: false, category: 'subscriber_shell_disabled', code: 'SUBSCRIBER_SHELL_BLOCKED', reason: SUBSCRIBER_PROTECTED_RESPONSE, toolName }
  }
  if (CAPABILITY_ADMIN_NAMES.has(toolName) || /(?:install|uninstall|upgrade|create|publish|register).*(?:skill|plugin|mode|preset|connector|shrimp|workflow)/iu.test(toolName)) {
    return { allowed: false, category: 'capability_creation', code: 'SUBSCRIBER_CAPABILITY_BLOCKED', reason: SUBSCRIBER_PROTECTED_RESPONSE, toolName }
  }
  if (SHRIMP_LIST_NAMES.has(toolName)) {
    return { allowed: false, category: 'shrimp_discovery', code: 'SUBSCRIBER_SHRIMP_DISCOVERY_BLOCKED', reason: SUBSCRIBER_SHRIMP_RESPONSE, toolName }
  }
  if (SHRIMP_RUN_NAMES.has(toolName)) {
    if (toolName === 'shrimp_run' && input.invocationReceiptValid !== true) {
      return { allowed: false, category: 'shrimp_run', code: 'SUBSCRIBER_SHRIMP_RECEIPT_REQUIRED', reason: SUBSCRIBER_SHRIMP_RESPONSE, toolName }
    }
    return { allowed: true, category: 'shrimp_run', code: null, reason: null, toolName }
  }
  const values = pathValues(args)
  for (const value of values) {
    const decision = workspacePathDecision(value, workspaceRoot, input)
    if (!decision.allowed) return { ...decision, allowed: false, category: 'workspace_boundary', toolName }
  }
  const commandDecision = hasAbsoluteCommandEscape(commandText(args), workspaceRoot, input)
  if (commandDecision) return { ...commandDecision, category: 'workspace_boundary', toolName }
  if (toolName === 'sandbox_upgrade' || /(?:elevat|upgrade).*sandbox/iu.test(toolName)) {
    return { allowed: false, category: 'sandbox_escalation', code: 'SUBSCRIBER_SANDBOX_ESCALATION_BLOCKED', reason: SUBSCRIBER_PROTECTED_RESPONSE, toolName }
  }
  // Unknown tools without a path are not automatically denied: non-file
  // tools (for example a bounded model call) do not widen the filesystem
  // boundary.  Capability/admin tools above remain explicitly denied.
  return { allowed: true, category: CORE_TOOL_NAMES.has(toolName) ? 'workspace_tool' : 'ordinary', code: null, reason: null, toolName }
}

export const subscriberToolGate = evaluateSubscriberToolCall

export function detectProtectedContentDisclosure(value, fingerprints = []) {
  const text = String(value ?? '')
  const supplied = Array.isArray(fingerprints) ? fingerprints.filter((item) => typeof item === 'string' && item.length >= 12) : []
  const fingerprint = supplied.find((item) => text.includes(item))
  if (fingerprint) return { blocked: true, code: 'SUBSCRIBER_OUTPUT_PROTECTED', reason: SUBSCRIBER_PROTECTED_RESPONSE }
  const classified = classifyProtectedContentRequest(text)
  if (classified.protected && ['prompt_disclosure', 'config_disclosure', 'mode_disclosure', 'capability_disclosure', 'shrimp_definition_disclosure'].includes(classified.category)) {
    return { blocked: true, code: 'SUBSCRIBER_OUTPUT_PROTECTED', reason: SUBSCRIBER_PROTECTED_RESPONSE }
  }
  return { blocked: false, code: null, reason: null }
}

export const protectedContentRequest = classifyProtectedContentRequest
export const protectedContentGate = detectProtectedContentDisclosure

export function createSubscriberPreExecuteListener(service) {
  return async function subscriberPreExecute(exec, next) {
    const agent = exec?.agent || {}
    const sessionId = agent?.id || agent?.sessionId || agent?.session?.id || agent?.session?.header?.id
    const parentSessionId = agent?.parentSessionId || agent?.parent_session_id || agent?.session?.parentSessionId || agent?.session?.parent_session_id || agent?.session?.header?.parentSession
    const subscriberId = service?.resolveSubscriberForAgent?.(agent?.id || agent?.agentId)
      || service?.resolveSubscriberForSession?.(sessionId)
      || service?.resolveSubscriberForSession?.(parentSessionId)
    if (!subscriberId) return next()
    const policy = service.resolveRuntimePolicy?.(subscriberId)
    if (!policy || policy.role !== 'subscriber') return next()
    let invocationReceiptValid = false
    if (String(exec?.name || '').toLowerCase() === 'shrimp_run') {
      try {
        const args = exec?.arguments || {}
        const receipt = service.consumeShrimpInvocation?.({
          receiptId: args.receiptId || args.invocationReceiptId || args.shrimpInvocationReceiptId,
          subscriberId,
          sessionId: args.sessionId || sessionId || args.scopeKey,
          scopeKey: args.scopeKey,
          messageId: args.messageId || args.turnId,
          resourceId: args.pipelineSlug || args.resourceId || args.slug,
        })
        invocationReceiptValid = receipt?.allowed === true
      } catch { invocationReceiptValid = false }
    }
    const decision = evaluateSubscriberToolCall({
      toolName: exec?.name,
      arguments: exec?.arguments || {},
      workspaceRoot: policy.workspaceRoot,
      currentWorkspaceRoot: policy.workspaceRoot,
      invocationReceiptValid,
      ...policy.pathPolicy,
    })
    if (!decision.allowed) return { kind: 'deny', code: decision.code, reason: decision.reason }
    return next()
  }
}
