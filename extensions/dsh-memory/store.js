// dsh-memory v2 storage adapter.
// Host-only: the UI and client bundle never depend on this module.
// SQLite is preferred when node:sqlite is available. The JSON adapter is a
// conservative compatibility fallback for older Node runtimes.
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

const require = createRequire(import.meta.url)
let DatabaseSync = null
try {
  ({ DatabaseSync } = require('node:sqlite'))
} catch {
  // Older supported Node versions can still use the JSON adapter below.
}

export const DEFAULT_SCOPE = 'default'
export const MAX_MEMORY_KEY = 80
export const MAX_SCOPE = 120
export const MAX_KIND = 80
export const MAX_SOURCE = 500
export const MAX_CONTENT_CHARS = 512_000
export const MAX_METADATA_CHARS = 64_000
export const MAX_CHECKPOINT_FILE_CHARS = 512_000

const STATUS_VALUES = new Set(['candidate', 'active', 'superseded', 'forgotten'])
const SENSITIVITY_VALUES = new Set(['normal', 'internal', 'confidential', 'secret'])

/** Return the current root rather than freezing an env value at module load. */
export function getMemoryRoot() {
  return process.env.DSH_MEMORY_ROOT || join(homedir(), '.dsh', 'memories')
}

/**
 * Resolve a database path from the host configuration. URI-style SQLite
 * paths are deliberately rejected: they can escape the host's path policy.
 */
export function getMemoryDbPath() {
  const configured = String(process.env.DSH_MEMORY_DB || '').trim()
  if (!configured) return join(getMemoryRoot(), 'memory-v2.sqlite')
  if (configured === ':memory:') return configured
  if (/^file:/i.test(configured)) throw new Error('DSH_MEMORY_DB 只接受本地文件路径，不接受 file: URI')
  const path = resolve(configured)
  if (path === dirname(path)) throw new Error('DSH_MEMORY_DB 必须指向文件')
  return path
}

export function sanitizeMemoryKey(value) {
  const raw = String(value ?? '').trim()
  if (!raw || raw === '.' || raw === '..' || raw.includes('/') || raw.includes('\\') || raw.includes('\0')) {
    throw new Error('key 无效: 不得含路径分隔符或 ..')
  }
  const clean = raw.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!clean) throw new Error('key 无效: 需含字母/数字/中文/连字符')
  if (clean.length > MAX_MEMORY_KEY) throw new Error(`key 过长(>${MAX_MEMORY_KEY})`)
  return clean
}

export function sanitizeScope(value = DEFAULT_SCOPE) {
  const raw = String(value || DEFAULT_SCOPE).trim()
  if (!raw || raw === '.' || raw === '..' || raw.includes('/') || raw.includes('\\') || raw.includes('\0')) {
    throw new Error('scope 无效: 不得为空、含路径分隔符或 ..')
  }
  if (raw.length > MAX_SCOPE) throw new Error(`scope 过长(>${MAX_SCOPE})`)
  if (!/^[\p{L}\p{N}._:-]+$/u.test(raw)) throw new Error('scope 只允许字母、数字、中文、点、下划线、冒号和连字符')
  return raw
}

export function sanitizeKind(value = 'semantic') {
  const kind = String(value || 'semantic').trim().toLowerCase()
  if (!kind || kind.length > MAX_KIND || !/^[a-z0-9][a-z0-9._:-]*$/i.test(kind)) throw new Error('kind 无效')
  return kind
}

export function sanitizeSource(value = 'unknown') {
  const source = String(value || 'unknown').trim()
  if (!source || source.length > MAX_SOURCE || source.includes('\0')) throw new Error('source 无效或过长')
  return source
}

export function normalizeTime(value = new Date().toISOString()) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('time 必须是可解析的 ISO 时间')
  return date.toISOString()
}

export function hashContent(content) {
  return createHash('sha256').update(String(content), 'utf8').digest('hex')
}

// Keep this detector conservative enough for ordinary prose while blocking
// common credentials and private-key material before it reaches disk/SQLite.
const SECRET_PATTERNS = [
  /\b(?:api[_ -]?key|access[_ -]?token|auth(?:entication)?[_ -]?token|private[_ -]?key|client[_ -]?secret|password)\s*[:=]\s*\S+/i,
  /\b(?:aws_access_key_id|aws_secret_access_key)\s*[:=]\s*\S+/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /-----BEGIN\s+(?:[A-Z0-9]+\s+)?PRIVATE KEY-----/i,
  /\b(?:token|secret)\s*[:=]\s*[A-Za-z0-9/_+=.-]{12,}/i,
]

export function containsSecret(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return SECRET_PATTERNS.some((pattern) => pattern.test(text || ''))
}

export function assertSafeMemory(content, sensitivity = 'normal', metadata = undefined) {
  const normalizedSensitivity = String(sensitivity || 'normal').toLowerCase()
  if (!SENSITIVITY_VALUES.has(normalizedSensitivity)) throw new Error('sensitivity 无效')
  if (normalizedSensitivity === 'secret' || containsSecret(content) || (metadata !== undefined && containsSecret(metadata))) {
    throw new Error('记忆疑似包含凭据或 secret，禁止写入')
  }
  return normalizedSensitivity
}

export function parseMetadata(value) {
  if (value === undefined || value === null || value === '') return {}
  let metadata = value
  if (typeof value === 'string') {
    try { metadata = JSON.parse(value) } catch { throw new Error('metadata 必须是 JSON 对象') }
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('metadata 必须是对象')
  const encoded = JSON.stringify(metadata)
  if (encoded.length > MAX_METADATA_CHARS) throw new Error(`metadata 过长(>${MAX_METADATA_CHARS} 字符)`)
  return metadata
}

export function normalizeMemoryInput(input = {}, defaults = {}) {
  const key = sanitizeMemoryKey(input.key)
  const content = String(input.content ?? '')
  if (!content.trim()) throw new Error('content 不能为空')
  if (content.length > MAX_CONTENT_CHARS) throw new Error(`content 过长(>${MAX_CONTENT_CHARS} 字符)`)
  const scope = sanitizeScope(input.scope ?? defaults.scope ?? DEFAULT_SCOPE)
  const kind = sanitizeKind(input.kind ?? defaults.kind ?? 'semantic')
  const source = sanitizeSource(input.source ?? defaults.source ?? 'unknown')
  const metadata = parseMetadata(input.metadata ?? defaults.metadata)
  const sensitivity = assertSafeMemory(`${content}\n${source}`, input.sensitivity ?? defaults.sensitivity ?? 'normal', metadata)
  const status = String(input.status ?? (input.candidate ? 'candidate' : defaults.status ?? 'active')).toLowerCase()
  if (!STATUS_VALUES.has(status)) throw new Error(`status 无效: ${status}`)
  const confidenceValue = input.confidence ?? defaults.confidence
  const confidence = confidenceValue === undefined || confidenceValue === null || confidenceValue === ''
    ? null
    : Number(confidenceValue)
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw new Error('confidence 必须在 0 到 1 之间')
  const time = normalizeTime(input.time ?? input.createdAt ?? defaults.time)
  const hash = hashContent(content)
  if (input.hash !== undefined && String(input.hash).toLowerCase() !== hash) throw new Error('hash 与 content 不一致')
  const supersedes = input.supersedes === undefined || input.supersedes === null || input.supersedes === ''
    ? null
    : String(input.supersedes).trim().slice(0, 200)
  if (supersedes && supersedes.length === 0) throw new Error('supersedes 无效')
  const idCandidate = input.id === undefined || input.id === null || input.id === '' ? randomUUID() : String(input.id).trim()
  if (idCandidate.length > 120 || /[\0\r\n]/.test(idCandidate)) throw new Error('id 无效')
  return {
    id: idCandidate,
    scope,
    key,
    kind,
    content,
    source,
    time,
    status,
    confidence,
    sensitivity,
    hash,
    supersedes,
    metadata,
  }
}

function recordFromRow(row) {
  if (!row) return null
  let metadata = {}
  try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {} } catch { metadata = {} }
  return {
    id: row.id,
    scope: row.scope,
    key: row.key,
    kind: row.kind,
    content: row.content,
    source: row.source,
    time: row.record_time,
    status: row.status,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    sensitivity: row.sensitivity,
    hash: row.content_hash,
    supersedes: row.supersedes,
    metadata,
    version: Number(row.version || 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    invalidAt: row.invalid_at || null,
    forgottenAt: row.forgotten_at || null,
  }
}

function stateEventFromRow(row) {
  if (!row) return null
  return {
    eventId: row.event_id,
    recordId: row.record_id,
    scope: row.scope,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reason: row.reason || '',
    source: row.source || '',
    time: row.event_time,
  }
}

function makeSchema(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS memory_records (
      rowid INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      record_time TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('candidate','active','superseded','forgotten')),
      confidence REAL,
      sensitivity TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      supersedes TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,
      invalid_at TEXT,
      forgotten_at TEXT,
      UNIQUE(scope, key, content_hash)
    );
    CREATE INDEX IF NOT EXISTS memory_records_scope_key_version
      ON memory_records(scope, key, version DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS memory_records_scope_status
      ON memory_records(scope, status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS memory_state_events (
      event_id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      event_time TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_state_events_record_time
      ON memory_state_events(scope, record_id, event_time DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      record_id UNINDEXED,
      scope UNINDEXED,
      key,
      content,
      source,
      tokenize='unicode61'
    );
  `)
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temp, JSON.stringify(value), 'utf8')
  renameSync(temp, path)
}

function now() { return new Date().toISOString() }

function safeDbParent(path) {
  if (path === ':memory:') return
  mkdirSync(dirname(path), { recursive: true })
}

function ftsQuery(terms) {
  return terms.map((term) => `"${String(term).replaceAll('"', '""')}"`).join(' OR ')
}

function jsTerms(query) {
  return [...new Set(String(query || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5_-]+/).map((item) => item.trim()).filter((item) => item.length >= 2))]
}

function scoreText(row, terms) {
  const haystack = `${row.key} ${row.content} ${row.source}`.toLowerCase()
  let score = 0
  for (const term of terms) {
    const occurrences = haystack.split(term).length - 1
    if (occurrences > 0) score += Math.min(occurrences, 20)
    if (String(row.key).toLowerCase().includes(term)) score += 8
  }
  return score
}

function matchingTermCount(row, terms) {
  const haystack = `${row.key} ${row.content} ${row.source}`.toLowerCase()
  return terms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0)
}

function statusClause(includeCandidates = false, includeForgotten = false) {
  const statuses = includeForgotten ? ['active', 'candidate', 'superseded', 'forgotten'] : includeCandidates ? ['active', 'candidate'] : ['active']
  return { values: statuses, sql: statuses.map(() => '?').join(', ') }
}

/** A small synchronous adapter keeps each tool call transactionally bounded. */
export class MemoryStore {
  constructor(path = getMemoryDbPath()) {
    this.path = path
    this.db = null
    this.backend = 'sqlite'
    this.fallbackPath = null
    this.jsonState = null
    this.dirty = false
    if (DatabaseSync) {
      try {
        safeDbParent(path)
        this.db = new DatabaseSync(path)
        this.db.exec('PRAGMA busy_timeout=5000;')
        if (path !== ':memory:') {
          try { this.db.exec('PRAGMA journal_mode=WAL;') } catch { /* some filesystems do not support WAL */ }
        }
        try { this.db.exec('PRAGMA synchronous=NORMAL;') } catch { /* best effort */ }
        makeSchema(this.db)
      } catch {
        try { this.db?.close() } catch { /* ignore close failures */ }
        this.db = null
      }
    }
    if (!this.db) {
      this.backend = 'json'
      this.fallbackPath = path === ':memory:' ? null : `${path}.json`
      this.jsonState = this.fallbackPath && readFileIfJson(this.fallbackPath)
        ? readFileIfJson(this.fallbackPath)
        : { schemaVersion: 2, records: [], events: [] }
      if (!Array.isArray(this.jsonState.events)) this.jsonState.events = []
    }
  }

  close() {
    if (this.backend === 'sqlite') {
      this.db?.close()
    } else if (this.dirty && this.fallbackPath) {
      atomicWriteJson(this.fallbackPath, this.jsonState)
    }
  }

  records() {
    if (this.backend === 'sqlite') return this.db.prepare('SELECT * FROM memory_records').all()
    return this.jsonState.records.map((item) => ({
      id: item.id,
      scope: item.scope,
      key: item.key,
      kind: item.kind,
      content: item.content,
      source: item.source,
      record_time: item.time,
      created_at: item.createdAt,
      updated_at: item.updatedAt,
      status: item.status,
      confidence: item.confidence,
      sensitivity: item.sensitivity,
      content_hash: item.hash,
      supersedes: item.supersedes,
      metadata_json: JSON.stringify(item.metadata || {}),
      version: item.version,
      invalid_at: item.invalidAt,
      forgotten_at: item.forgottenAt,
    }))
  }

  /** Public, normalized view of all rows; internal methods use records(). */
  allRecords(options = {}) {
    const scope = options.scope ?? null
    const includeForgotten = Boolean(options.includeForgotten)
    return this.records()
      .filter((row) => (scope === null || row.scope === scope) && (includeForgotten || row.status !== 'forgotten'))
      .map((row) => recordFromRow(row))
  }

  insert(input) {
    const duplicate = this.findDuplicate(input.scope, input.key, input.hash)
    if (duplicate) return { record: recordFromRow(duplicate), deduped: true, conflicts: [], supersededIds: [], unresolvedSupersedes: null }
    const rows = this.records()
    const current = rows.filter((row) => row.scope === input.scope && row.key === input.key && row.status !== 'forgotten')
    const conflicts = current.filter((row) => row.status === 'active').map((row) => row.id)
    const supersedeTargets = input.supersedes ? this.resolveSupersedes(input.scope, input.supersedes, input.key) : []
    const unresolvedSupersedes = input.supersedes && !supersedeTargets.length ? input.supersedes : null
    const version = current.reduce((max, row) => Math.max(max, Number(row.version || 0)), 0) + 1
    const createdAt = now()
    const record = { ...input, version, createdAt, updatedAt: createdAt, invalidAt: null, forgottenAt: null }
    if (this.backend === 'sqlite') {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.prepare(`INSERT INTO memory_records
          (id, scope, key, kind, content, source, record_time, created_at, updated_at, status,
           confidence, sensitivity, content_hash, supersedes, metadata_json, version, invalid_at, forgotten_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`).run(
          record.id, record.scope, record.key, record.kind, record.content, record.source, record.time,
          record.createdAt, record.updatedAt, record.status, record.confidence, record.sensitivity,
          record.hash, record.supersedes, JSON.stringify(record.metadata), record.version,
        )
        this.db.prepare('INSERT INTO memory_fts(record_id, scope, key, content, source) VALUES (?, ?, ?, ?, ?)')
          .run(record.id, record.scope, record.key, record.content, record.source)
        if (supersedeTargets.length) this.markSupersededSql(supersedeTargets, createdAt)
        this.db.exec('COMMIT')
      } catch (error) {
        try { this.db.exec('ROLLBACK') } catch { /* ignore rollback errors */ }
        throw error
      }
    } else {
      for (const target of supersedeTargets) {
        const item = this.jsonState.records.find((row) => row.id === target)
        if (item && item.status !== 'forgotten') { item.status = 'superseded'; item.invalidAt = createdAt; item.updatedAt = createdAt }
      }
      this.jsonState.records.push(record)
      this.dirty = true
    }
    return { record, deduped: false, conflicts, supersededIds: supersedeTargets, unresolvedSupersedes }
  }

  findDuplicate(scope, key, hash) {
    if (this.backend === 'sqlite') return this.db.prepare('SELECT * FROM memory_records WHERE scope = ? AND key = ? AND content_hash = ? LIMIT 1').get(scope, key, hash)
    const row = this.jsonState.records.find((item) => item.scope === scope && item.key === key && item.hash === hash)
    if (!row) return null
    return {
      id: row.id, scope: row.scope, key: row.key, kind: row.kind, content: row.content, source: row.source,
      record_time: row.time, status: row.status, confidence: row.confidence, sensitivity: row.sensitivity,
      content_hash: row.hash, supersedes: row.supersedes, metadata_json: JSON.stringify(row.metadata || {}), version: row.version,
      created_at: row.createdAt, updated_at: row.updatedAt, invalid_at: row.invalidAt, forgotten_at: row.forgottenAt,
    }
  }

  resolveSupersedes(scope, selector, key = null) {
    if (this.backend === 'sqlite') {
      const rows = this.db.prepare(`SELECT id FROM memory_records
        WHERE scope = ? AND status != 'forgotten' AND (id = ? OR content_hash = ? OR key = ?)
        ORDER BY version DESC`).all(scope, selector, selector, selector === key ? selector : '')
      return rows.map((row) => row.id)
    }
    return this.jsonState.records.filter((row) => row.scope === scope && row.status !== 'forgotten'
      && (row.id === selector || row.hash === selector || (key && selector === key && row.key === key))).map((row) => row.id)
  }

  markSupersededSql(ids, at = now()) {
    if (!ids.length) return
    const placeholders = ids.map(() => '?').join(',')
    this.db.prepare(`UPDATE memory_records SET status = 'superseded', invalid_at = ?, updated_at = ?
      WHERE id IN (${placeholders}) AND status NOT IN ('forgotten','superseded')`).run(at, at, ...ids)
  }

  search(query, options = {}) {
    const terms = jsTerms(query)
    if (!terms.length) return []
    const scope = options.scope ?? DEFAULT_SCOPE
    const { values: statuses, sql: statusSql } = statusClause(options.includeCandidates, options.includeForgotten)
    let rows = []
    if (this.backend === 'sqlite') {
      try {
        const matches = this.db.prepare(`SELECT r.*, bm25(memory_fts) AS fts_rank
          FROM memory_fts JOIN memory_records r ON r.id = memory_fts.record_id
          WHERE memory_fts MATCH ? AND r.scope = ? AND r.status IN (${statusSql})
          ORDER BY fts_rank ASC, r.updated_at DESC LIMIT ?`).all(ftsQuery(terms), scope, ...statuses, Number(options.limit || 50))
        rows = matches
      } catch {
        rows = []
      }
      // LIKE is deliberately retained as the second leg: unicode61 does not
      // segment every CJK phrase, while path/identifier text benefits from it.
      const likeRows = this.db.prepare(`SELECT * FROM memory_records
        WHERE scope = ? AND status IN (${statusSql})
        AND (${terms.map(() => '(lower(key) LIKE ? OR lower(content) LIKE ? OR lower(source) LIKE ?)').join(' OR ')})
        ORDER BY updated_at DESC LIMIT ?`).all(scope, ...statuses, ...terms.flatMap((term) => [`%${term}%`, `%${term}%`, `%${term}%`]), Number(options.limit || 50))
      const byId = new Map()
      for (const row of [...rows, ...likeRows]) byId.set(row.id, row)
      rows = [...byId.values()]
    } else {
      rows = this.records().filter((row) => row.scope === scope && statuses.includes(row.status))
        .filter((row) => scoreText(row, terms) > 0)
    }
    const requiredTerms = terms.length === 1 ? 1 : Math.min(2, terms.length)
    return rows.filter((row) => matchingTermCount(row, terms) >= requiredTerms)
      .map((row) => ({ ...recordFromRow(row), score: scoreText(row, terms) }))
      .sort((left, right) => right.score - left.score || String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .slice(0, Number(options.limit || 50))
  }

  getLatest(key, options = {}) {
    const scope = options.scope ?? DEFAULT_SCOPE
    const { values: statuses, sql: statusSql } = statusClause(options.includeCandidates, options.includeForgotten)
    if (this.backend === 'sqlite') {
      const row = this.db.prepare(`SELECT * FROM memory_records WHERE scope = ? AND key = ? AND status IN (${statusSql})
        ORDER BY version DESC, updated_at DESC LIMIT 1`).get(scope, key, ...statuses)
      return recordFromRow(row)
    }
    const row = this.records().filter((item) => item.scope === scope && item.key === key && statuses.includes(item.status))
      .sort((a, b) => Number(b.version || 0) - Number(a.version || 0) || String(b.updated_at).localeCompare(String(a.updated_at)))[0]
    return recordFromRow(row)
  }

  list(options = {}) {
    const scope = options.scope ?? DEFAULT_SCOPE
    const { values: statuses } = statusClause(options.includeCandidates, options.includeForgotten)
    const rows = this.records().filter((row) => row.scope === scope && statuses.includes(row.status))
      .map((row) => recordFromRow(row))
      .sort((a, b) => a.key.localeCompare(b.key) || Number(b.version || 0) - Number(a.version || 0))
    const latest = new Map()
    for (const row of rows) if (!latest.has(row.key)) latest.set(row.key, row)
    return [...latest.values()]
  }

  _promotionRows(selector, scope) {
    if (this.backend === 'sqlite') {
      return this.db.prepare(`SELECT * FROM memory_records
        WHERE scope = ? AND (id = ? OR key = ? OR content_hash = ?)
        ORDER BY version DESC, updated_at DESC`).all(scope, selector, selector, selector)
    }
    return this.records().filter((row) => row.scope === scope
      && (row.id === selector || row.key === selector || row.content_hash === selector))
      .sort((a, b) => Number(b.version || 0) - Number(a.version || 0) || String(b.updated_at).localeCompare(String(a.updated_at)))
  }

  stateEvents({ scope, recordId, limit = 100 } = {}) {
    const max = Math.max(1, Math.min(1_000, Number(limit || 100)))
    if (this.backend === 'sqlite') {
      const clauses = ['scope = ?']; const params = [scope]
      if (recordId) { clauses.push('record_id = ?'); params.push(recordId) }
      params.push(max)
      return this.db.prepare(`SELECT * FROM memory_state_events WHERE ${clauses.join(' AND ')} ORDER BY event_time DESC LIMIT ?`).all(...params).map(stateEventFromRow)
    }
    return this.jsonState.events.filter((event) => event.scope === scope && (!recordId || event.recordId === recordId))
      .sort((a, b) => String(b.time).localeCompare(String(a.time))).slice(0, max)
  }

  promote(selector, options = {}) {
    const scope = options.scope ?? DEFAULT_SCOPE
    const rows = this._promotionRows(String(selector), scope)
    if (!rows.length) {
      const error = new Error(`没有找到可审核记忆 "${selector}"`)
      error.code = 'MEMORY_NOT_FOUND'
      throw error
    }
    const current = recordFromRow(rows[0])
    if (current.status === 'active') return { ok: true, dryRun: Boolean(options.dryRun), idempotent: true, record: current, event: null }
    if (current.status !== 'candidate') {
      const error = new Error(`只能把 candidate 审核为 active，当前状态为 ${current.status}`)
      error.code = 'PROMOTION_INVALID_STATE'
      throw error
    }
    if (options.dryRun !== false) return { ok: true, dryRun: true, idempotent: false, record: current, event: null }
    const eventTime = now()
    const reason = String(options.reason || '').trim().slice(0, 500)
    const source = String(options.source || 'memory_promote').trim().slice(0, 500)
    const event = {
      eventId: randomUUID(), recordId: current.id, scope, fromStatus: 'candidate', toStatus: 'active', reason, source, time: eventTime,
    }
    if (this.backend === 'sqlite') {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const latest = this.db.prepare('SELECT * FROM memory_records WHERE id = ? AND scope = ?').get(current.id, scope)
        if (!latest) throw new Error('promotion target disappeared')
        if (latest.status !== 'candidate') {
          const conflict = new Error(`promotion target changed to ${latest.status}`)
          conflict.code = 'PROMOTION_INVALID_STATE'
          throw conflict
        }
        const nextVersion = Number(latest.version || 1) + 1
        this.db.prepare(`UPDATE memory_records SET status = 'active', version = ?, updated_at = ? WHERE id = ? AND scope = ?`).run(nextVersion, eventTime, current.id, scope)
        this.db.prepare(`INSERT INTO memory_state_events(event_id, record_id, scope, from_status, to_status, reason, source, event_time)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(event.eventId, event.recordId, event.scope, event.fromStatus, event.toStatus, event.reason, event.source, event.time)
        this.db.exec('COMMIT')
        const updated = this.db.prepare('SELECT * FROM memory_records WHERE id = ? AND scope = ?').get(current.id, scope)
        return { ok: true, dryRun: false, idempotent: false, record: recordFromRow(updated), event }
      } catch (error) {
        try { this.db.exec('ROLLBACK') } catch { /* ignore rollback errors */ }
        throw error
      }
    }
    const item = this.jsonState.records.find((row) => row.id === current.id && row.scope === scope)
    if (!item || item.status !== 'candidate') {
      const error = new Error(`promotion target changed state`)
      error.code = 'PROMOTION_INVALID_STATE'
      throw error
    }
    item.status = 'active'
    item.version = Number(item.version || 1) + 1
    item.updatedAt = eventTime
    this.jsonState.events.push(event)
    this.dirty = true
    return { ok: true, dryRun: false, idempotent: false, record: recordFromRow(this.records().find((row) => row.id === current.id && row.scope === scope)), event }
  }

  forget(selector, options = {}) {
    const scope = options.scope ?? DEFAULT_SCOPE
    let rows
    if (this.backend === 'sqlite') {
      const params = [scope, selector, selector, selector]
      rows = this.db.prepare(`SELECT * FROM memory_records WHERE scope = ? AND (id = ? OR key = ? OR content_hash = ?)
        AND status != 'forgotten' ORDER BY version DESC`).all(...params)
    } else {
      rows = this.records().filter((row) => row.scope === scope && row.status !== 'forgotten'
        && (row.id === selector || row.key === selector || row.content_hash === selector))
    }
    const records = rows.map((row) => recordFromRow(row))
    if (!options.dryRun && records.length) {
      const at = now()
      if (this.backend === 'sqlite') {
        this.db.exec('BEGIN IMMEDIATE')
        try {
          this.db.prepare(`UPDATE memory_records SET status = 'forgotten', forgotten_at = ?, updated_at = ?
            WHERE scope = ? AND (id = ? OR key = ? OR content_hash = ?)`).run(at, at, scope, selector, selector, selector)
          this.db.exec('COMMIT')
        } catch (error) {
          try { this.db.exec('ROLLBACK') } catch { /* ignore rollback errors */ }
          throw error
        }
      } else {
        for (const row of this.jsonState.records) {
          if (row.scope === scope && row.status !== 'forgotten' && (row.id === selector || row.key === selector || row.hash === selector)) {
            row.status = 'forgotten'; row.forgottenAt = at; row.updatedAt = at
          }
        }
        this.dirty = true
      }
      for (const record of records) {
        record.status = 'forgotten'
        record.forgottenAt = at
        record.updatedAt = at
      }
    }
    return records
  }
}

function readFileIfJson(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (!value || !Array.isArray(value.records)) return null
    if (!Array.isArray(value.events)) value.events = []
    return value
  } catch {
    return null
  }
}

export function createMemoryStore(path = getMemoryDbPath()) {
  return new MemoryStore(path)
}

export function recordToPublic(record) {
  return record ? { ...record, metadata: record.metadata || {} } : null
}
