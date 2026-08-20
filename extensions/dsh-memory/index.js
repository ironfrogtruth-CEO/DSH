// dsh-memory — Host-only persistent memory tools.
//
// The six original Markdown tools keep their input/output contracts. Memory
// v2 mirrors new writes into SQLite/FTS5 and exposes structured records,
// provenance, scopes, candidate states, versioning and dry-run forgetting.
// No browser/client/UI code is imported here.
import { appendFile, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  MAX_CHECKPOINT_FILE_CHARS,
  assertSafeMemory,
  containsSecret,
  createMemoryStore,
  getMemoryRoot,
  hashContent,
  normalizeMemoryInput,
  recordToPublic,
  sanitizeMemoryKey,
  sanitizeScope,
  MemoryStore,
} from './store.js'

export const name = 'dsh-memory'
export const inject = ['tools']

// Keep these exports stable for focused host tests and downstream adapters.
export { MemoryStore, createMemoryStore, getMemoryRoot, hashContent, normalizeMemoryInput, recordToPublic, sanitizeMemoryKey, sanitizeScope }

const MAX_RECALL_CHARS = 12_000
const DEFAULT_RECALL_CHARS = 6_000
const MAX_CHECKPOINT_CONTENT_CHARS = 20_000

function queryTerms(query) {
  return [...new Set(String(query || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5_-]+/).map((item) => item.trim()).filter((item) => item.length >= 2))]
}

function memoryExcerpt(text, terms, limit) {
  const lines = String(text || '').split('\n')
  const indexes = []
  for (let index = 0; index < lines.length; index += 1) {
    const lower = lines[index].toLowerCase()
    if (terms.some((term) => lower.includes(term))) indexes.push(index)
  }
  const selected = new Set()
  for (const index of indexes.slice(0, 12)) {
    for (let cursor = Math.max(0, index - 1); cursor <= Math.min(lines.length - 1, index + 2); cursor += 1) selected.add(cursor)
  }
  const excerpt = [...selected].sort((a, b) => a - b).map((index) => lines[index]).join('\n').trim()
  return (excerpt || lines.slice(0, 24).join('\n')).slice(0, limit)
}

function legacyScore(row, terms) {
  const text = `${row.key} ${row.content}`.toLowerCase()
  let score = 0
  for (const term of terms) {
    const matches = text.split(term).length - 1
    if (matches > 0) score += Math.min(matches, 20)
    if (row.key.toLowerCase().includes(term)) score += 8
  }
  return score
}

function legacyMatchesEnough(row, terms) {
  const text = `${row.key} ${row.content}`.toLowerCase()
  const matched = terms.reduce((count, term) => count + (text.includes(term) ? 1 : 0), 0)
  return matched >= (terms.length === 1 ? 1 : Math.min(2, terms.length))
}

function safeError(error) {
  return String(error?.message || error || '未知错误').slice(0, 500)
}

const RENDER_REDACT_KEYS = /^(?:content|message|prompt|body|html|markdown|arguments?|token|secret|password|api[_-]?key|private[_-]?key|authorization|cookie)$/i
const RENDER_RAW_KEYS = /^(?:events|raw[_-]?(?:events?|history|log)|fullHistory|history)$/i
const RENDER_SECRET_TEXT = /(?:api[_-]?key|access[_-]?token|auth(?:entication)?[_-]?token|password|private[_-]?key|secret)\s*[:=]\s*\S+/ig

function safeRenderValue(value, key = '', depth = 0) {
  if (RENDER_REDACT_KEYS.test(key)) return '[redacted]'
  if (RENDER_RAW_KEYS.test(key)) return { truncated: true, reason: 'raw memory/events omitted' }
  if (depth > 6) return '[truncated]'
  if (typeof value === 'string') {
    const redacted = value.replace(RENDER_SECRET_TEXT, '[redacted]')
    return redacted.length > 2_000 ? `${redacted.slice(0, 2_000)}…[truncated]` : redacted
  }
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    const items = value.slice(0, 60).map((item) => safeRenderValue(item, '', depth + 1))
    if (value.length > 60) items.push({ truncated: true, reason: 'array limit' })
    return items
  }
  const output = {}
  const entries = Object.entries(value)
  for (const [entryKey, entryValue] of entries.slice(0, 80)) output[entryKey] = safeRenderValue(entryValue, entryKey, depth + 1)
  if (entries.length > 80) output.truncated = true
  return output
}

export function boundedJson(value, maxChars = 12_000) {
  const limit = Math.max(2, Math.floor(Number(maxChars) || 12_000))
  const safe = safeRenderValue(value)
  const text = JSON.stringify(safe) ?? 'null'
  if (text.length <= limit) return text
  const compact = { truncated: true, maxChars: limit }
  const preferred = ['ok', 'dryRun', 'key', 'scope', 'kind', 'status', 'confidence', 'source', 'hash', 'version', 'deduped', 'conflicts', 'supersededIds', 'unresolvedSupersedes', 'wouldForget', 'forgotten', 'reason', 'imported', 'skipped', 'files', 'path', 'recordId']
  compact.fields = {}
  for (const key of preferred) if (safe && typeof safe === 'object' && Object.hasOwn(safe, key)) compact.fields[key] = safe[key]
  let output = JSON.stringify(compact)
  if (output.length > limit) output = JSON.stringify({ truncated: true, maxChars: limit })
  if (output.length > limit) output = '{}'
  return output
}

function renderLegacy(value, successText) {
  return [{ type: 'text', text: value?.ok ? successText(value) : `失败: ${value?.error || ''}` }]
}

function renderEnhanced(value, enhancedValue, legacyText) {
  if (!value?.ok) return [{ type: 'text', text: `失败: ${value?.error || ''}` }]
  return value.recordId
    ? [{ type: 'text', text: boundedJson(enhancedValue(value)) }]
    : [{ type: 'text', text: legacyText(value) }]
}

function recordRender(value) {
  const record = value?.record || {}
  return {
    ok: value?.ok === true,
    dryRun: value?.dryRun === true,
    key: record.key,
    scope: record.scope,
    kind: record.kind,
    status: record.status,
    confidence: record.confidence ?? null,
    source: record.source,
    hash: record.hash,
    version: record.version ?? null,
    deduped: value?.deduped === true,
    conflicts: value?.conflicts || [],
    supersededIds: value?.supersededIds || [],
    unresolvedSupersedes: value?.unresolvedSupersedes || null,
  }
}

function forgetRender(value) {
  const records = value?.dryRun ? value?.wouldForget || [] : value?.forgotten || []
  const key = value?.dryRun ? 'wouldForget' : 'forgotten'
  return {
    ok: value?.ok === true,
    dryRun: value?.dryRun === true,
    [key]: records.map((record) => ({ id: record.id, key: record.key, status: record.status, reason: value.reason || '' })),
    reason: value?.reason || '',
  }
}

function promoteRender(value) {
  const record = value?.record || {}
  return {
    ok: value?.ok === true,
    dryRun: value?.dryRun === true,
    idempotent: value?.idempotent === true,
    record: { id: record.id, key: record.key, scope: record.scope, status: record.status, version: record.version, hash: record.hash },
    event: value?.event ? {
      eventId: value.event.eventId,
      recordId: value.event.recordId,
      scope: value.event.scope,
      fromStatus: value.event.fromStatus,
      toStatus: value.event.toStatus,
      reason: value.event.reason || '',
      source: value.event.source || '',
      time: value.event.time,
    } : null,
  }
}

async function ensureRoot() {
  await mkdir(getMemoryRoot(), { recursive: true })
}

/**
 * Canonicalize an import root before reading it. By default imports are
 * confined to DSH_MEMORY_ROOT, including through symlinks and `..` paths.
 * An external root is an explicit, opt-in maintenance operation only.
 */
async function canonicalImportRoot(requestedRoot) {
  const configuredRoot = getMemoryRoot()
  await mkdir(configuredRoot, { recursive: true })
  const canonicalBase = await realpath(configuredRoot)
  const raw = requestedRoot === undefined || requestedRoot === null || String(requestedRoot) === ''
    ? canonicalBase
    : String(requestedRoot)
  if (raw.includes('\0')) throw new Error('root 无效')
  const candidate = resolve(raw.startsWith(sep) ? raw : join(canonicalBase, raw))
  const canonicalCandidate = await realpath(candidate)
  const inside = canonicalCandidate === canonicalBase || canonicalCandidate.startsWith(`${canonicalBase}${sep}`)
  if (!inside && process.env.DSH_MEMORY_ALLOW_EXTERNAL_ROOT !== '1') {
    throw new Error('root 必须位于 DSH_MEMORY_ROOT 内；外部导入需显式设置 DSH_MEMORY_ALLOW_EXTERNAL_ROOT=1')
  }
  return canonicalCandidate
}

function legacyPathFor(key, scope = 'default') {
  return scope === 'default'
    ? join(getMemoryRoot(), `${key}.md`)
    : join(getMemoryRoot(), '.scopes', scope, `${key}.md`)
}

async function readLegacyRows(scope = 'default') {
  if (scope !== 'default') return []
  await ensureRoot()
  const files = (await readdir(getMemoryRoot())).filter((file) => file.endsWith('.md')).sort()
  const rows = []
  for (const file of files) {
    try {
      const content = await readFile(join(getMemoryRoot(), file), 'utf8')
      rows.push({
        id: `markdown:${file}`,
        scope,
        key: file.replace(/\.md$/, ''),
        kind: 'legacy-markdown',
        content,
        source: `markdown:${file}`,
        time: null,
        status: 'active',
        confidence: null,
        sensitivity: containsSecret(content) ? 'secret' : 'normal',
        hash: hashContent(content),
        supersedes: null,
        metadata: { legacyMarkdown: true, filename: file },
        version: 0,
      })
    } catch {
      // A concurrently removed/unreadable legacy file is simply omitted.
    }
  }
  return rows
}

async function withStore(callback) {
  const store = createMemoryStore()
  try {
    return await callback(store)
  } finally {
    try { store.close() } catch { /* preserve tool result even if close fails */ }
  }
}

/** Host API for compaction/session services; it does not register a tool. */
export async function searchMemory(query, options = {}) {
  const scope = sanitizeScope(options.scope || 'default')
  return withStore((store) => store.search(query, {
    ...options,
    scope,
    includeCandidates: Boolean(options.includeCandidates),
  }))
}

/** Host API for structured candidate/fact writes. */
export function putMemoryRecord(input = {}) {
  const normalized = normalizeMemoryInput(input)
  const store = createMemoryStore()
  try { return store.insert(normalized) } finally { store.close() }
}

/** Host API for explicit, auditable forgetting. dryRun remains the default. */
export function forgetMemory(selector, options = {}) {
  const scope = sanitizeScope(options.scope || 'default')
  const dryRun = options.dryRun !== false || options.confirm !== true
  const store = createMemoryStore()
  try { return store.forget(String(selector), { ...options, scope, dryRun }) } finally { store.close() }
}

/** Host API for candidate review; callers can explicitly pass dryRun:false. */
export function promoteMemory(selector, options = {}) {
  const scope = sanitizeScope(options.scope || 'default')
  const dryRun = options.dryRun !== false
  const store = createMemoryStore()
  try { return store.promote(String(selector), { ...options, scope, dryRun }) } finally { store.close() }
}

function publicEvidence(row) {
  return {
    id: row.id,
    key: row.key,
    scope: row.scope,
    kind: row.kind,
    source: row.source,
    time: row.time,
    status: row.status,
    confidence: row.confidence,
    sensitivity: row.sensitivity,
    hash: row.hash,
    supersedes: row.supersedes,
    version: row.version,
  }
}

function suppressLegacyFor(row, includeCandidates = false) {
  if (!row) return false
  if (row.status === 'forgotten' || row.status === 'superseded') return true
  return row.status === 'candidate' && !includeCandidates
}

function mergeRows(dbRows, legacyRows, terms, includeSecrets = false, suppressedKeys = new Set()) {
  const selected = []
  const dbKeys = new Set(dbRows.map((row) => `${row.scope}:${row.key}`))
  for (const row of dbRows) selected.push(row)
  for (const row of legacyRows) {
    if (!includeSecrets && row.sensitivity === 'secret') continue
    if (suppressedKeys.has(`${row.scope}:${row.key}`)) continue
    if (dbKeys.has(`${row.scope}:${row.key}`)) continue
    const score = legacyScore(row, terms)
    if (score > 0 && legacyMatchesEnough(row, terms)) selected.push({ ...row, score })
  }
  return selected.sort((left, right) => Number(right.score || 0) - Number(left.score || 0) || String(right.time || '').localeCompare(String(left.time || '')))
}

function formatContext(rows, terms, limit, withSources = true) {
  const sections = []
  let used = 0
  for (const row of rows.slice(0, 12)) {
    const remaining = limit - used
    if (remaining < 180) break
    const source = withSources
      ? `\n\n[来源] ${row.source || 'unknown'} · scope=${row.scope} · time=${row.time || 'legacy'} · status=${row.status}${row.confidence === null || row.confidence === undefined ? '' : ` · confidence=${row.confidence}`}`
      : ''
    const excerptLimit = Math.max(80, Math.min(2_400, remaining - row.key.length - source.length - 8))
    const section = `## ${row.key}\n${memoryExcerpt(row.content, terms, excerptLimit)}${source}`
    sections.push(section.slice(0, remaining))
    used += Math.min(section.length, remaining) + 2
  }
  return sections.join('\n\n').slice(0, limit)
}

function registerMemorySave(tools) {
  tools.register(defineTool({
    name: 'memory_save',
    description: '保存一条持久记忆到 ~/.dsh/memories/。保留旧版 Markdown 参数；同时写入 Host-only SQLite 记忆索引。禁止保存密码、Token、私钥等凭据。同名 key 仍覆盖 Markdown 文件。',
    parameters: {
      key: { type: 'string', required: true, description: '记忆键(如 user-profile / shrimptank-conventions)' },
      content: { type: 'string', required: true, description: '记忆内容(markdown)' },
      scope: { type: 'string', description: '隔离域，默认 default；不得含路径分隔符' },
      kind: { type: 'string', description: 'semantic/episodic/procedural 等类型' },
      source: { type: 'string', description: '来源说明，如 user-confirmed 或 task:123' },
      time: { type: 'string', description: '事件时间 ISO 字符串' },
      status: { type: 'string', description: 'active 或 candidate' },
      confidence: { type: 'number', description: '0 到 1 的可信度' },
      sensitivity: { type: 'string', description: 'normal/internal/confidential；secret 会拒绝写入' },
      supersedes: { type: 'string', description: '要被当前记录替代的记录 id/hash/key' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, path: { type: 'string' }, recordId: { type: 'string' }, scope: { type: 'string' }, error: { type: 'string' } },
      },
      render: (_a, value) => renderEnhanced(value, (result) => ({ ok: true, path: result.path, recordId: result.recordId, scope: result.scope }), (result) => `已保存: ${result.path}`),
    },
    timeoutMs: 15000,
    async execute(args) {
      try {
        const key = sanitizeMemoryKey(args.key)
        const scope = sanitizeScope(args.scope || 'default')
        const content = String(args.content ?? '')
        assertSafeMemory(content, args.sensitivity || 'normal')
        // Validate all structured fields (including source/hash/metadata)
        // before the Markdown half is written.
        normalizeMemoryInput({ ...args, key, content, scope, source: args.source || 'memory_save', kind: args.kind || 'semantic', status: args.status || 'active' })
        await ensureRoot()
        const path = legacyPathFor(key, scope)
        await mkdir(join(path, '..'), { recursive: true })
        const header = `# ${String(args.key).trim()}\n\n> 保存于 ${new Date().toISOString()}\n\n`
        await writeFile(path, header + content, 'utf8')
        const stored = await withStore((store) => {
          let supersedes = args.supersedes
          if (!supersedes) supersedes = store.getLatest(key, { scope, includeCandidates: true })?.id
          return store.insert(normalizeMemoryInput({ ...args, key, content, scope, source: args.source || 'memory_save', kind: args.kind || 'semantic', status: args.status || 'active', supersedes }))
        })
        const enhanced = ['scope', 'kind', 'source', 'time', 'status', 'confidence', 'sensitivity', 'supersedes'].some((field) => args[field] !== undefined)
        return enhanced ? { ok: true, path, recordId: stored.record.id, scope } : { ok: true, path }
      } catch (error) {
        return { ok: false, error: safeError(error) }
      }
    },
    presentCall() { return { card: 'generic', title: 'Save memory' } },
  }))
}

function registerMemoryRecall(tools) {
  tools.register(defineTool({
    name: 'memory_recall',
    description: '按任务关键词召回跨会话持久记忆。默认只读 default scope 的 active 记录；使用 scope、kind 和 includeCandidates 做隔离筛选。结果带来源说明，仍需核验仓库现状。',
    parameters: {
      query: { type: 'string', required: true, description: '工作区名、任务目标、技术关键词的组合' },
      maxChars: { type: 'number', description: '最多返回字符数，默认 6000，上限 12000' },
      scope: { type: 'string', description: '记忆隔离域，默认 default' },
      kind: { type: 'string', description: '只召回指定 kind' },
      includeCandidates: { type: 'boolean', description: '是否包含尚未确认的 candidate，默认 false' },
      withSources: { type: 'boolean', description: '是否在上下文中展示来源行，默认 true' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true }, context: { type: 'string' }, matchedKeys: { type: 'string' }, sources: { type: 'string' },
          records: { type: 'array', items: { type: 'object', additionalProperties: true } }, error: { type: 'string' },
        },
      },
      render: (_a, value) => [{ type: 'text', text: value.ok ? value.context : `失败: ${value.error}` }],
    },
    timeoutMs: 15000,
    async execute(args) {
      try {
        const terms = queryTerms(args.query)
        if (!terms.length) throw new Error('query 至少包含一个长度不小于 2 的关键词')
        const scope = sanitizeScope(args.scope || 'default')
        const limit = Math.min(MAX_RECALL_CHARS, Math.max(1000, Number(args.maxChars || DEFAULT_RECALL_CHARS)))
        const dbState = await withStore((store) => ({
          rows: store.search(args.query, { scope, includeCandidates: Boolean(args.includeCandidates), limit: 50 }),
          latest: store.list({ scope, includeCandidates: true, includeForgotten: true }),
        }))
        const dbRows = dbState.rows
        const suppressedKeys = new Set(dbState.latest.filter((row) => suppressLegacyFor(row, Boolean(args.includeCandidates))).map((row) => `${row.scope}:${row.key}`))
        const legacyRows = await readLegacyRows(scope)
        const filteredDbRows = args.kind ? dbRows.filter((row) => row.kind === String(args.kind).toLowerCase()) : dbRows
        const rows = mergeRows(filteredDbRows, legacyRows, terms, false, suppressedKeys)
        const legacyMode = args.scope === undefined && args.kind === undefined && args.includeCandidates === undefined && args.withSources === undefined
        const context = rows.length ? formatContext(rows, terms, limit, legacyMode ? false : args.withSources !== false) : `(没有找到与 “${args.query}” 相关的持久记忆)`
        const base = { ok: true, context, matchedKeys: rows.slice(0, 8).map((row) => row.key).join(', ') }
        return legacyMode ? base : {
          ...base,
          sources: rows.slice(0, 8).map((row) => `${row.key} <- ${row.source || 'unknown'} (${row.scope})`).join('\n'),
          records: rows.slice(0, 8).map(publicEvidence),
        }
      } catch (error) {
        return { ok: false, error: safeError(error) }
      }
    },
    presentCall() { return { card: 'generic', title: 'Recall memory' } },
  }))
}

function registerMemoryCheckpoint(tools) {
  tools.register(defineTool({
    name: 'memory_checkpoint',
    description: '向项目持久记忆追加一个结构化续办检查点。保留 Markdown 追加行为，同时写入 SQLite 事件记录；禁止写入密码、Token、私钥等凭据。',
    parameters: {
      key: { type: 'string', required: true, description: '项目记忆键，如 project-shrimptank' },
      content: { type: 'string', required: true, description: '包含目标、决定、文件、测试、剩余工作、风险和下一步的 Markdown' },
      scope: { type: 'string', description: '记忆隔离域，默认 default' },
      source: { type: 'string', description: '来源说明' },
      confidence: { type: 'number', description: '0 到 1 的可信度' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, path: { type: 'string' }, recordId: { type: 'string' }, error: { type: 'string' } },
      },
      render: (_a, value) => renderEnhanced(value, (result) => ({ ok: true, path: result.path, recordId: result.recordId }), (result) => `检查点已追加: ${result.path}`),
    },
    timeoutMs: 15000,
    async execute(args) {
      try {
        const key = sanitizeMemoryKey(args.key)
        const scope = sanitizeScope(args.scope || 'default')
        const content = String(args.content ?? '').trim()
        if (!content) throw new Error('content 不能为空')
        if (content.length > MAX_CHECKPOINT_CONTENT_CHARS) throw new Error(`单个检查点过长(>${MAX_CHECKPOINT_CONTENT_CHARS} 字符)`)
        assertSafeMemory(content)
        normalizeMemoryInput({ key, content, scope, kind: 'episodic', source: args.source || 'memory_checkpoint', confidence: args.confidence, status: 'active' })
        await ensureRoot()
        const path = legacyPathFor(key, scope)
        await mkdir(join(path, '..'), { recursive: true })
        let existing = ''
        try { existing = await readFile(path, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (existing.length + content.length > MAX_CHECKPOINT_FILE_CHARS) throw new Error('项目记忆文件已超过 512000 字符，请先归档旧检查点')
        if (!existing) await writeFile(path, `# ${String(args.key).trim()}\n\n> 追加式项目检查点；新记录不得静默覆盖旧决定。\n`, 'utf8')
        await appendFile(path, `\n\n## Checkpoint ${new Date().toISOString()}\n\n${content}\n`, 'utf8')
        const stored = await withStore((store) => store.insert(normalizeMemoryInput({ key, content, scope, kind: 'episodic', source: args.source || 'memory_checkpoint', confidence: args.confidence, status: 'active' })))
        const enhanced = ['scope', 'source', 'confidence'].some((field) => args[field] !== undefined)
        return enhanced ? { ok: true, path, recordId: stored.record.id } : { ok: true, path }
      } catch (error) {
        return { ok: false, error: safeError(error) }
      }
    },
    presentCall() { return { card: 'generic', title: 'Checkpoint memory' } },
  }))
}

function registerMemoryGet(tools) {
  tools.register(defineTool({
    name: 'memory_get',
    description: '读取一条持久记忆。旧版 Markdown 仍优先按原路径读取；结构化记录返回来源和版本信息。',
    parameters: {
      key: { type: 'string', required: true, description: '记忆键' },
      scope: { type: 'string', description: '记忆隔离域，默认 default' },
      includeCandidates: { type: 'boolean', description: '是否允许读取 candidate，默认 false' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, content: { type: 'string' }, record: { type: 'object', additionalProperties: true }, error: { type: 'string' } },
      },
      render: (_a, value) => [{ type: 'text', text: value.ok ? value.content : `失败: ${value.error}` }],
    },
    timeoutMs: 15000,
    async execute(args) {
      try {
        const key = sanitizeMemoryKey(args.key)
        const scope = sanitizeScope(args.scope || 'default')
        try {
          const state = await withStore((store) => ({
            record: store.getLatest(key, { scope, includeCandidates: Boolean(args.includeCandidates) }),
            latest: store.list({ scope, includeCandidates: true, includeForgotten: true }).find((item) => item.key === key),
          }))
          if (suppressLegacyFor(state.latest, Boolean(args.includeCandidates))) throw Object.assign(new Error(`没有找到记忆 "${args.key}"`), { code: 'ENOENT' })
          const content = await readFile(legacyPathFor(key, scope), 'utf8')
          const record = state.record
          const enhanced = args.scope !== undefined || args.includeCandidates !== undefined
          return enhanced ? { ok: true, content, ...(record ? { record: publicEvidence(record) } : {}) } : { ok: true, content }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        const record = await withStore((store) => store.getLatest(key, { scope, includeCandidates: Boolean(args.includeCandidates) }))
        if (!record) throw Object.assign(new Error(`没有找到记忆 "${args.key}"`), { code: 'ENOENT' })
        return { ok: true, content: record.content, record: publicEvidence(record) }
      } catch (error) {
        return { ok: false, error: error.code === 'ENOENT' ? `没有找到记忆 "${args.key}"` : safeError(error) }
      }
    },
    presentCall() { return { card: 'generic', title: 'Get memory' } },
  }))
}

function registerMemoryList(tools) {
  tools.register(defineTool({
    name: 'memory_list',
    description: '列出所有持久记忆键(附首行摘要)，兼容旧版 Markdown 并包含 SQLite 记录。',
    parameters: {
      scope: { type: 'string', description: '记忆隔离域，默认 default' },
      includeCandidates: { type: 'boolean', description: '是否包含 candidate' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, memories: { type: 'string' }, error: { type: 'string' } },
      },
      render: (_a, value) => [{ type: 'text', text: value.ok ? value.memories : `失败: ${value.error}` }],
    },
    timeoutMs: 15000,
    async execute(args) {
      try {
        const scope = sanitizeScope(args.scope || 'default')
        const dbState = await withStore((store) => ({
          rows: store.list({ scope, includeCandidates: Boolean(args.includeCandidates) }),
          latest: store.list({ scope, includeCandidates: true, includeForgotten: true }),
        }))
        const dbRows = dbState.rows
        const suppressedKeys = new Set(dbState.latest.filter((row) => suppressLegacyFor(row, Boolean(args.includeCandidates))).map((row) => `${row.scope}:${row.key}`))
        const legacyRows = await readLegacyRows(scope)
        const byKey = new Map(dbRows.map((row) => [row.key, row]))
        for (const row of legacyRows) if (!byKey.has(row.key) && !suppressedKeys.has(`${row.scope}:${row.key}`)) byKey.set(row.key, row)
        const lines = []
        for (const row of [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key))) {
          const first = String(row.content).split('\n').find((line) => line.trim() && !line.startsWith('>') && !line.startsWith('#')) || ''
          lines.push(`${row.key}: ${first.trim().slice(0, 80)}`)
        }
        return { ok: true, memories: lines.length ? lines.join('\n') : '(无记忆)' }
      } catch (error) {
        return { ok: false, error: safeError(error) }
      }
    },
    presentCall() { return { card: 'generic', title: 'List memories' } },
  }))
}

function registerMemorySearch(tools) {
  tools.register(defineTool({
    name: 'memory_search',
    description: '在指定 scope 的持久记忆中进行 FTS5 + LIKE 混合词法搜索，返回匹配键、命中行和来源。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索关键词' },
      scope: { type: 'string', description: '记忆隔离域，默认 default' },
      includeCandidates: { type: 'boolean', description: '是否包含 candidate' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, results: { type: 'string' }, sources: { type: 'string' }, error: { type: 'string' } },
      },
      render: (_a, value) => [{ type: 'text', text: value.ok ? value.results : `失败: ${value.error}` }],
    },
    timeoutMs: 15000,
    async execute(args) {
      try {
        const query = String(args.query ?? '')
        if (!query.trim()) throw new Error('query 不能为空')
        const scope = sanitizeScope(args.scope || 'default')
        const terms = queryTerms(query)
        const dbState = await withStore((store) => ({
          rows: store.search(query, { scope, includeCandidates: Boolean(args.includeCandidates), limit: 50 }),
          latest: store.list({ scope, includeCandidates: true, includeForgotten: true }),
        }))
        const dbRows = dbState.rows
        const suppressedKeys = new Set(dbState.latest.filter((row) => suppressLegacyFor(row, Boolean(args.includeCandidates))).map((row) => `${row.scope}:${row.key}`))
        const legacyRows = await readLegacyRows(scope)
        const rows = mergeRows(dbRows, legacyRows, terms, false, suppressedKeys)
        const hits = []
        for (const row of rows.slice(0, 50)) {
          const line = String(row.content).split('\n').find((item) => item.toLowerCase().includes(query.toLowerCase()) || terms.some((term) => item.toLowerCase().includes(term))) || String(row.content).split('\n').find((item) => item.trim()) || ''
          hits.push(`${row.key}: ${line.trim().slice(0, 120)}`)
        }
        const base = { ok: true, results: hits.length ? hits.join('\n') : `(未找到含 "${query}" 的记忆)` }
        const enhanced = args.scope !== undefined || args.includeCandidates !== undefined
        return enhanced ? { ...base, sources: rows.slice(0, 50).map((row) => `${row.key} <- ${row.source || 'unknown'} (${row.scope})`).join('\n') } : base
      } catch (error) {
        return { ok: false, error: safeError(error) }
      }
    },
    presentCall() { return { card: 'generic', title: 'Search memories' } },
  }))
}

function registerMemoryRecord(tools) {
  tools.register(defineTool({
    name: 'memory_record',
    description: '写入一条带 scope/kind/source/time/status/confidence/sensitivity/hash/supersedes/版本的结构化记忆。candidate 默认不会进入普通 recall；dryRun 只校验和预览，不写磁盘。',
    parameters: {
      key: { type: 'string', required: true, description: '记忆键' },
      content: { type: 'string', required: true, description: '事实、经历或规则内容' },
      scope: { type: 'string', description: '隔离域，默认 default' },
      kind: { type: 'string', description: 'semantic/episodic/procedural' },
      source: { type: 'string', description: '来源说明或 source event id' },
      time: { type: 'string', description: '事件时间 ISO 字符串' },
      status: { type: 'string', description: 'candidate 或 active' },
      candidate: { type: 'boolean', description: 'true 时 status 默认 candidate' },
      confidence: { type: 'number', description: '0 到 1' },
      sensitivity: { type: 'string', description: 'normal/internal/confidential；secret 拒绝写入' },
      hash: { type: 'string', description: '可选 SHA-256，供校验' },
      supersedes: { type: 'string', description: '旧记录 id/hash/key；只在同 scope 内生效' },
      metadata: { type: 'object', additionalProperties: true, description: '可审计的来源、任务、标签等 JSON 对象' },
      id: { type: 'string', description: '可选稳定 id；默认 UUID' },
      dryRun: { type: 'boolean', description: '只返回校验后的记录，不写入' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true }, dryRun: { type: 'boolean' }, deduped: { type: 'boolean' }, record: { type: 'object', additionalProperties: true },
          conflicts: { type: 'array', items: { type: 'string' } }, supersededIds: { type: 'array', items: { type: 'string' } }, unresolvedSupersedes: { type: 'string' }, error: { type: 'string' },
        },
      },
      render: (_a, value) => value?.ok ? [{ type: 'text', text: boundedJson(recordRender(value)) }] : [{ type: 'text', text: `失败: ${value?.error || ''}` }],
    },
    timeoutMs: 15000,
    async execute(args) {
      try {
        const input = normalizeMemoryInput(args)
        if (args.dryRun) return { ok: true, dryRun: true, deduped: false, record: recordToPublic(input), conflicts: [], supersededIds: [] }
        const result = await withStore((store) => store.insert(input))
        return {
          ok: true, dryRun: false, deduped: result.deduped, record: recordToPublic(result.record), conflicts: result.conflicts,
          supersededIds: result.supersededIds, ...(result.unresolvedSupersedes ? { unresolvedSupersedes: result.unresolvedSupersedes } : {}),
        }
      } catch (error) {
        return { ok: false, error: safeError(error) }
      }
    },
    presentCall() { return { card: 'generic', title: 'Record structured memory' } },
  }))
}

function registerMemoryForget(tools) {
  tools.register(defineTool({
    name: 'memory_forget',
    description: '按 id、key 或 hash 预览/忘记结构化记忆。默认 dryRun=true；实际操作必须显式 confirm=true。原始 Markdown 不会被删除。',
    parameters: {
      id: { type: 'string', description: '记录 id' },
      key: { type: 'string', description: '同 scope 下的 key' },
      hash: { type: 'string', description: 'content SHA-256' },
      scope: { type: 'string', description: '记忆隔离域，默认 default' },
      dryRun: { type: 'boolean', description: '默认 true' },
      confirm: { type: 'boolean', description: '只有 true 才允许实际标记 forgotten' },
      reason: { type: 'string', description: '审计原因；不会写入原始内容' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, dryRun: { type: 'boolean' }, wouldForget: { type: 'array', items: { type: 'object', additionalProperties: true } }, forgotten: { type: 'array', items: { type: 'object', additionalProperties: true } }, reason: { type: 'string' }, error: { type: 'string' } },
      },
      render: (_a, value) => value?.ok ? [{ type: 'text', text: boundedJson(forgetRender(value)) }] : [{ type: 'text', text: `失败: ${value?.error || ''}` }],
    },
    timeoutMs: 15000,
    async execute(args) {
      try {
        const selector = args.id || args.key || args.hash
        if (!selector) throw new Error('id、key、hash 至少提供一个')
        const scope = sanitizeScope(args.scope || 'default')
        const dryRun = args.dryRun !== false || args.confirm !== true
        const records = await withStore((store) => store.forget(String(selector), { scope, dryRun }))
        return { ok: true, dryRun, wouldForget: records.map(publicEvidence), forgotten: dryRun ? [] : records.map(publicEvidence), reason: String(args.reason || '').slice(0, 300) }
      } catch (error) {
        return { ok: false, error: safeError(error) }
      }
    },
    presentCall() { return { card: 'generic', title: 'Forget memory' } },
  }))
}

function registerMemoryPromote(tools) {
  tools.register(defineTool({
    name: 'memory_promote',
    description: '显式审核 candidate 记忆为 active。默认 dryRun=true；只有 confirm=true 且 dryRun=false 才会写入状态事件。active 重复审核幂等，forgotten/superseded 拒绝。',
    parameters: {
      id: { type: 'string', description: '记录 id' },
      key: { type: 'string', description: '同 scope 下的 key' },
      hash: { type: 'string', description: 'content SHA-256' },
      scope: { type: 'string', description: '记忆隔离域，默认 default' },
      dryRun: { type: 'boolean', description: '默认 true' },
      confirm: { type: 'boolean', description: '只有 true 才允许实际审核' },
      reason: { type: 'string', description: '审核理由' },
      source: { type: 'string', description: '审核来源' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, dryRun: { type: 'boolean' }, idempotent: { type: 'boolean' }, record: { type: 'object', additionalProperties: true }, event: { type: 'object', additionalProperties: true }, error: { type: 'string' } },
      },
      render: (_a, value) => value?.ok ? [{ type: 'text', text: boundedJson(promoteRender(value)) }] : [{ type: 'text', text: `失败: ${value?.error || ''}` }],
    },
    timeoutMs: 15000,
    async execute(args) {
      try {
        const selector = args.id || args.key || args.hash
        if (!selector) throw new Error('id、key、hash 至少提供一个')
        const scope = sanitizeScope(args.scope || 'default')
        const dryRun = args.dryRun !== false || args.confirm !== true
        const result = await withStore((store) => store.promote(String(selector), { scope, dryRun, reason: args.reason, source: args.source || 'memory_promote' }))
        return result
      } catch (error) {
        return { ok: false, error: safeError(error), code: error?.code || 'PROMOTION_ERROR' }
      }
    },
    presentCall() { return { card: 'generic', title: 'Promote memory candidate' } },
  }))
}

async function legacyMarkdownFiles(root) {
  const files = (await readdir(root)).filter((file) => file.endsWith('.md')).sort()
  const rows = []
  for (const file of files) {
    const content = await readFile(join(root, file), 'utf8')
    rows.push({ file, key: sanitizeMemoryKey(file.replace(/\.md$/, '')), content })
  }
  return rows
}

/**
 * Explicit Markdown import for maintenance/migration callers. It is dry-run
 * by default and never deletes or rewrites the source files.
 */
export async function importMarkdownMemory(options = {}) {
  const root = await canonicalImportRoot(options.root)
  const scope = sanitizeScope(options.scope || 'default')
  const files = await legacyMarkdownFiles(root)
  const limit = Math.max(1, Math.min(10_000, Number(options.limit || 1000)))
  const limited = files.slice(0, limit)
  const inputs = []
  for (const row of limited) {
    try {
      inputs.push(normalizeMemoryInput({ key: row.key, content: row.content, scope, kind: 'legacy-markdown', source: `markdown:${row.file}`, status: 'active', metadata: { legacyMarkdown: true, filename: row.file } }))
    } catch {
      // Keep malformed/secret Markdown readable, but do not import it.
    }
  }
  const dryRun = options.dryRun !== false || options.confirm !== true
  if (dryRun) return { dryRun: true, imported: inputs.length, skipped: limited.length - inputs.length, files: limited.map((row) => row.file) }
  const result = await withStore((store) => {
    let imported = 0
    let skipped = limited.length - inputs.length
    for (const input of inputs) {
      const stored = store.insert(input)
      if (stored.deduped) skipped += 1
      else imported += 1
    }
    return { imported, skipped }
  })
  return { dryRun: false, ...result, files: limited.map((row) => row.file) }
}

function registerMemoryMigrate(tools) {
  tools.register(defineTool({
    name: 'memory_migrate',
    description: '显式、幂等地把旧版 Markdown 导入 SQLite。默认 dryRun=true；不会自动迁移正式数据，confirm=true 才写入，且不删除/改写 Markdown。',
    parameters: {
      root: { type: 'string', description: '旧版 Markdown 根目录，默认 DSH_MEMORY_ROOT' },
      scope: { type: 'string', description: '导入后的 scope，默认 default' },
      dryRun: { type: 'boolean', description: '默认 true' },
      confirm: { type: 'boolean', description: '只有 true 才写入' },
      limit: { type: 'number', description: '最多处理文件数，默认 1000' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, dryRun: { type: 'boolean' }, imported: { type: 'number' }, skipped: { type: 'number' }, files: { type: 'array', items: { type: 'string' } }, error: { type: 'string' } },
      },
      render: (_a, value) => value?.ok ? [{ type: 'text', text: boundedJson({ ok: true, dryRun: value.dryRun === true, imported: value.imported, skipped: value.skipped, files: value.files || [] }) }] : [{ type: 'text', text: `失败: ${value?.error || ''}` }],
    },
    timeoutMs: 15000,
    async execute(args) {
      try {
        const root = await canonicalImportRoot(args.root)
        const scope = sanitizeScope(args.scope || 'default')
        const files = await legacyMarkdownFiles(root)
        const limited = files.slice(0, Math.max(1, Math.min(10_000, Number(args.limit || 1000))))
        const inputs = []
        for (const row of limited) {
          try {
            inputs.push(normalizeMemoryInput({ key: row.key, content: row.content, scope, kind: 'legacy-markdown', source: `markdown:${row.file}`, status: 'active', metadata: { legacyMarkdown: true, filename: row.file } }))
          } catch {
            // Secret or malformed legacy material remains readable but is not imported.
          }
        }
        const dryRun = args.dryRun !== false || args.confirm !== true
        if (dryRun) return { ok: true, dryRun: true, imported: inputs.length, skipped: limited.length - inputs.length, files: limited.map((row) => row.file) }
        const result = await withStore((store) => {
          let imported = 0
          let skipped = limited.length - inputs.length
          for (const input of inputs) {
            const stored = store.insert(input)
            if (stored.deduped) skipped += 1
            else imported += 1
          }
          return { imported, skipped }
        })
        return { ok: true, dryRun: false, ...result, files: limited.map((row) => row.file) }
      } catch (error) {
        return { ok: false, error: safeError(error) }
      }
    },
    presentCall() { return { card: 'generic', title: 'Migrate Markdown memory' } },
  }))
}

export function apply(ctx) {
  const { tools } = ctx
  registerMemorySave(tools)
  registerMemoryRecall(tools)
  registerMemoryCheckpoint(tools)
  registerMemoryGet(tools)
  registerMemoryList(tools)
  registerMemorySearch(tools)
  registerMemoryRecord(tools)
  registerMemoryForget(tools)
  registerMemoryPromote(tools)
  registerMemoryMigrate(tools)
}
