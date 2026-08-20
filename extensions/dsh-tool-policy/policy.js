// Pure classification + policy decisions for Host tool execution.
// The classifier intentionally does not inspect arbitrary content fields.
import { realpathSync } from 'node:fs'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'

export const MODES = Object.freeze(['observe', 'enforce'])
export const OPERATION_MODES = Object.freeze(['plan', 'act', 'debug', 'review', 'architect'])
export const CATEGORIES = Object.freeze(['read', 'write', 'destructive', 'external', 'unknown'])

const PATH_KEYS = new Set(['path', 'paths', 'cwd', 'workdir', 'root', 'workspace', 'workspaceRoot', 'file', 'files', 'directory', 'dir', 'target', 'destination', 'dest', 'outputPath', 'outputFile', 'sourcePath', 'repository'])
const COMMAND_KEYS = new Set(['command', 'cmd', 'shell', 'script', 'argv', 'args'])
const CONTENT_KEYS = new Set(['content', 'text', 'prompt', 'query', 'html', 'markdown', 'body', 'message', 'input', 'memory', 'context', 'image', 'images', 'url'])

function text(value) { return String(value ?? '').trim() }

function list(value) {
  if (Array.isArray(value)) return value.flatMap((item) => typeof item === 'string' ? [item] : [])
  return typeof value === 'string' ? [value] : []
}

export function canonicalWorkspacePath(value, base = process.cwd()) {
  const raw = text(value)
  if (!raw) return null
  const candidate = isAbsolute(raw) ? raw : resolve(base, raw)
  try { return realpathSync(candidate) } catch { return normalize(candidate) }
}

export function canonicalWorkspaceRoots(roots = []) {
  return list(roots).map((root) => canonicalWorkspacePath(root)).filter(Boolean).map((root) => root.endsWith(sep) ? root.slice(0, -1) : root)
}

function isInside(root, candidate) {
  if (!root || !candidate) return false
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function collectFields(value, depth = 0, fieldName = '') {
  if (depth > 3 || value === null || value === undefined) return { paths: [], commands: [] }
  if (typeof value === 'string') {
    if (COMMAND_KEYS.has(fieldName.toLowerCase())) return { paths: [], commands: [value] }
    if (PATH_KEYS.has(fieldName)) return { paths: [value], commands: [] }
    return { paths: [], commands: [] }
  }
  if (Array.isArray(value)) {
    return value.reduce((acc, item) => {
      const nested = collectFields(item, depth + 1, fieldName)
      acc.paths.push(...nested.paths); acc.commands.push(...nested.commands)
      return acc
    }, { paths: [], commands: [] })
  }
  if (typeof value !== 'object') return { paths: [], commands: [] }
  return Object.entries(value).reduce((acc, [key, item]) => {
    const lower = key.toLowerCase()
    if (CONTENT_KEYS.has(lower)) return acc
    const nested = collectFields(item, depth + 1, key)
    acc.paths.push(...nested.paths); acc.commands.push(...nested.commands)
    return acc
  }, { paths: [], commands: [] })
}

function commandText(commands) {
  return commands.map((item) => Array.isArray(item) ? item.join(' ') : item).join('\n').trim()
}

function addCategory(categories, category) {
  if (!categories.includes(category)) categories.push(category)
}

function hasAny(value, patterns) { return patterns.some((pattern) => value.includes(pattern)) }

function classifyShell(toolName, commands, categories, reasons) {
  const command = commandText(commands).toLowerCase()
  if (!command) return
  const destructive = [
    'rm -rf', 'rm -r', 'git reset --hard', 'git clean -fd', 'git clean -xdf', 'mkfs', 'dd if=', 'truncate -s',
    'shutdown', 'reboot', 'kill -9', 'killall', 'chmod 777', 'chown -r', '> /', 'npm publish', 'pip uninstall',
  ]
  const external = ['curl ', 'wget ', 'http://', 'https://', 'ssh ', 'scp ', 'rsync ', 'git push', 'npm install', 'pnpm add', 'pip install']
  const safeRead = /^(?:\s*)(?:pwd|ls(?:\s|$)|find(?:\s|$)|cat(?:\s|$)|head(?:\s|$)|tail(?:\s|$)|git\s+(?:status|diff|log|branch|show|remote\s+-v)|rg(?:\s|$)|grep(?:\s|$)|sed(?:\s|$)|wc(?:\s|$))/m.test(command)
  if (hasAny(command, destructive)) { addCategory(categories, 'destructive'); reasons.push('shell command matches destructive pattern') }
  if (hasAny(command, external)) { addCategory(categories, 'external'); reasons.push('shell command matches external/network pattern') }
  if (!categories.length && safeRead) { addCategory(categories, 'read'); reasons.push('shell command is a recognized read-only command') }
  if (!categories.length) { addCategory(categories, 'unknown'); reasons.push('shell command is not safely classifiable') }
}

export function classifyToolCall(toolName, args = {}, options = {}) {
  const name = text(toolName).toLowerCase()
  const categories = []
  const reasons = []
  const fields = collectFields(args)
  const command = commandText(fields.commands).toLowerCase()
  const toolText = `${name} ${command}`
  const shellLike = /(?:^|[_-])(shell|bash|sh|exec|command|terminal|run)(?:$|[_-])/.test(name) || ['shell', 'bash', 'exec', 'command'].includes(name)
  const networkLike = /(?:browser|web|http|fetch|crawl|search|network|request|url|download|upload|publish|push)/.test(name)
  const readLike = /(?:^|[_-])(get|read|list|search|recall|status|diff|log|branch|view|inspect|show|query|find|check|stat)(?:$|[_-])/.test(name)
  const writeLike = /(?:^|[_-])(write|save|create|update|edit|patch|apply|stage|unstage|append|checkpoint|record|index|build|generate|mkdir|touch|copy|move|rename|set)(?:$|[_-])/.test(name)
  const destructiveLike = /(?:^|[_-])(delete|remove|forget|destroy|reset|clean|kill|stop|drop|truncate|commit|push|publish)(?:$|[_-])/.test(name)

  if (name === 'memory_forget') {
    if (args?.dryRun === false && args?.confirm === true) { addCategory(categories, 'destructive'); reasons.push('memory_forget has explicit execution confirmation') }
    else { addCategory(categories, 'read'); reasons.push('memory_forget is dry-run without explicit confirmation') }
  } else if (name === 'cross_session_rebuild') {
    if (args?.dryRun === false) { addCategory(categories, 'write'); reasons.push('cross_session_rebuild writes its index') }
    else { addCategory(categories, 'read'); reasons.push('cross_session_rebuild is dry-run') }
  } else if (name === 'code_index_build' || /(?:^|[_-])code[_-]index[_-]build(?:$|[_-])/.test(name)) {
    addCategory(categories, 'write'); reasons.push('code index build writes derived index state')
  } else if (/frontend/.test(name) && /(?:diff|patch|apply|write|edit)/.test(name) && (args?.write === true || args?.apply === true || args?.writeFiles === true || fields.paths.length > 0)) {
    addCategory(categories, 'write'); reasons.push('frontend diff operation can write files')
  } else if (destructiveLike || /(?:^|[_-])git[_-](?:commit|push)(?:$|[_-])/.test(name)) {
    addCategory(categories, 'destructive'); reasons.push('tool name matches destructive git/filesystem action')
    if (/(?:^|[_-])git[_-]push(?:$|[_-])/.test(name)) { addCategory(categories, 'external'); reasons.push('git push changes an external remote') }
  } else if (networkLike) {
    addCategory(categories, 'external'); reasons.push('tool name matches browser/network/external action')
  } else if (shellLike) {
    classifyShell(name, fields.commands.length ? fields.commands : [args?.command || args?.cmd || ''], categories, reasons)
  } else if (writeLike || /(?:fs|file|edit|write|patch|atomic)[_-]/.test(name)) {
    addCategory(categories, 'write'); reasons.push('tool name matches filesystem/edit action')
  } else if (readLike) {
    addCategory(categories, 'read'); reasons.push('tool name matches read-only action')
  }

  if (!categories.length) { addCategory(categories, 'unknown'); reasons.push('tool name has no registered policy classification') }
  const roots = (options.workspaceRoots || []).map((root) => text(root)).filter(Boolean)
  const canonicalPaths = fields.paths.map((path) => canonicalWorkspacePath(path, options.baseCwd || process.cwd())).filter(Boolean)
  let pathBoundary = 'not-applicable'
  let escapedPaths = []
  if (canonicalPaths.length && roots.length) {
    escapedPaths = canonicalPaths.filter((path) => !roots.some((root) => isInside(root, path)))
    pathBoundary = escapedPaths.length ? 'outside' : 'inside'
    if (escapedPaths.length) reasons.push('one or more paths escape configured workspaceRoots')
  } else if (canonicalPaths.length) pathBoundary = 'unconfigured'

  return {
    toolName: text(toolName),
    categories,
    category: categories.includes('destructive') ? 'destructive' : categories.includes('external') ? 'external' : categories[0],
    reasons,
    pathBoundary,
    paths: canonicalPaths,
    escapedPaths,
    unknown: categories.includes('unknown'),
    commandInspected: Boolean(command),
  }
}

function patternMatches(pattern, toolName, classification) {
  if (typeof pattern === 'object' && pattern) {
    if (pattern.category && !classification.categories.includes(String(pattern.category))) return false
    pattern = pattern.tool || pattern.name || ''
  }
  const value = text(pattern).toLowerCase()
  const target = text(toolName).toLowerCase()
  if (!value) return false
  if (value === '*') return true
  if (!value.includes('*')) return value === target
  const escaped = value.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${escaped}$`, 'i').test(target)
}

function patternList(value) { return Array.isArray(value) ? value : value ? [value] : [] }

export function normalizePolicyConfig(input = {}) {
  const mode = MODES.includes(input.mode) ? input.mode : 'observe'
  const operationMode = OPERATION_MODES.includes(input.operationMode) ? input.operationMode : 'plan'
  return {
    mode,
    operationMode,
    workspaceRoots: canonicalWorkspaceRoots(input.workspaceRoots || []),
    baseCwd: canonicalWorkspacePath(input.baseCwd || process.cwd()) || process.cwd(),
    allow: patternList(input.allow),
    ask: patternList(input.ask),
    deny: patternList(input.deny),
    maxRecent: Math.max(20, Math.min(2_000, Number(input.maxRecent || 200))),
  }
}

function defaultDecision(classification, operationMode) {
  if (classification.pathBoundary === 'outside') return { kind: 'deny', reason: 'tool path escapes configured workspaceRoots' }
  if (classification.category === 'read') return { kind: 'allow', reason: 'read-only tool' }
  if (classification.category === 'write') {
    if (['plan', 'review', 'architect'].includes(operationMode)) return { kind: 'deny', reason: `${operationMode} mode denies write tools` }
    return { kind: 'allow', reason: `${operationMode} mode permits ordinary writes` }
  }
  if (classification.category === 'destructive' || classification.category === 'external') {
    if (['plan', 'review', 'architect'].includes(operationMode)) return { kind: 'deny', reason: `${operationMode} mode denies ${classification.category} tools` }
    return { kind: 'ask', reason: `${operationMode} mode requires approval for ${classification.category} tools` }
  }
  return ['plan', 'review', 'architect'].includes(operationMode)
    ? { kind: 'deny', reason: `${operationMode} mode denies unknown tools` }
    : { kind: 'ask', reason: 'unknown tool behavior requires approval' }
}

export class ToolPolicy {
  constructor(config = {}) {
    this.config = normalizePolicyConfig(config)
    this.metrics = { total: 0, byDecision: {}, byCategory: {}, byTool: {} }
    this.recent = []
  }

  evaluate(toolName, args = {}) {
    const classification = classifyToolCall(toolName, args, { workspaceRoots: this.config.workspaceRoots, baseCwd: this.config.baseCwd })
    let would = defaultDecision(classification, this.config.operationMode)
    const matched = { deny: patternList(this.config.deny).filter((pattern) => patternMatches(pattern, toolName, classification)), ask: patternList(this.config.ask).filter((pattern) => patternMatches(pattern, toolName, classification)), allow: patternList(this.config.allow).filter((pattern) => patternMatches(pattern, toolName, classification)) }
    if (classification.pathBoundary === 'outside') would = { kind: 'deny', reason: 'tool path escapes configured workspaceRoots' }
    else if (matched.deny.length) would = { kind: 'deny', reason: 'tool matches configured deny pattern' }
    else if (matched.ask.length) would = { kind: 'ask', reason: 'tool matches configured ask pattern' }
    else if (matched.allow.length) would = { kind: 'allow', reason: 'tool matches configured allow pattern' }
    const applied = this.config.mode === 'observe' ? { kind: 'allow', reason: 'observe mode never blocks execution' } : would
    const result = { toolName: text(toolName), args, classification, decision: would, appliedDecision: applied, matchedPatterns: matched, mode: this.config.mode, operationMode: this.config.operationMode, observed: this.config.mode === 'observe' }
    this.record(result)
    return result
  }

  record(result) {
    this.metrics.total += 1
    const decision = result.decision.kind
    const category = result.classification.category
    this.metrics.byDecision[decision] = (this.metrics.byDecision[decision] || 0) + 1
    this.metrics.byCategory[category] = (this.metrics.byCategory[category] || 0) + 1
    this.metrics.byTool[result.toolName] = (this.metrics.byTool[result.toolName] || 0) + 1
    this.recent.push({ at: new Date().toISOString(), toolName: result.toolName, category, decision, appliedDecision: result.appliedDecision.kind, mode: result.mode, operationMode: result.operationMode, pathBoundary: result.classification.pathBoundary })
    if (this.recent.length > this.config.maxRecent) this.recent.splice(0, this.recent.length - this.config.maxRecent)
  }

  snapshot() { return { config: { ...this.config, workspaceRoots: [...this.config.workspaceRoots] }, metrics: JSON.parse(JSON.stringify(this.metrics)), recent: this.recent.slice() } }
}
