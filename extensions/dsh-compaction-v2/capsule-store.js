import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { validateContinuationCapsule } from '@local/dsh-intelligence/schemas'

const DSH_ROOT = process.env.DSH_HOME || join(homedir(), '.dsh')
const DEFAULT_ROOT = process.env.DSH_COMPACTION_V2_ROOT || join(DSH_ROOT, 'intelligence', 'compactions')
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function hashCapsule(capsule) {
  return createHash('sha256').update(stableJson(capsule)).digest('hex')
}

function stableRecordId(sessionId, compactionId) {
  return `capsule-record:${createHash('sha256').update(`${sessionId}\0${compactionId}`).digest('hex').slice(0, 32)}`
}

function validateRecord(record) {
  const errors = []
  if (!record || typeof record !== 'object' || Array.isArray(record)) return ['record must be an object']
  const required = ['schemaVersion', 'recordId', 'idempotencyKey', 'sessionId', 'compactionId', 'capsule', 'capsuleHash', 'sourceSeqs', 'sourceEventIds', 'model', 'provider', 'createdAt', 'revision', 'status']
  for (const key of required) if (!(key in record)) errors.push(`${key} is required`)
  if (record.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  for (const key of ['recordId', 'idempotencyKey', 'sessionId', 'compactionId', 'capsuleHash', 'model', 'provider']) if (key in record && (typeof record[key] !== 'string' || !record[key].trim())) errors.push(`${key} must be a non-empty string`)
  if (record.status !== 'committed') errors.push('status must be committed')
  if (record.createdAt !== undefined && (typeof record.createdAt !== 'string' || !ISO_RE.test(record.createdAt))) errors.push('createdAt must be ISO date-time')
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) errors.push('revision must be a positive safe integer')
  if (!Array.isArray(record.sourceSeqs) || record.sourceSeqs.some((seq) => !Number.isSafeInteger(seq) || seq < 0)) errors.push('sourceSeqs must contain non-negative safe integers')
  if (!Array.isArray(record.sourceEventIds) || record.sourceEventIds.some((id) => typeof id !== 'string' || !id)) errors.push('sourceEventIds must contain non-empty strings')
  const capsuleResult = validateContinuationCapsule(record.capsule)
  if (!capsuleResult.ok) errors.push(...capsuleResult.errors.map((item) => `capsule ${item.path} ${item.message || item.keyword}`))
  if (record.capsuleHash !== undefined && record.capsule && record.capsuleHash !== hashCapsule(record.capsule)) errors.push('capsuleHash does not match capsule content')
  return errors
}

function scopeKey(sessionId) {
  return String(sessionId)
}

export class CapsuleStoreError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'CapsuleStoreError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export class CapsuleStoreConflictError extends CapsuleStoreError {
  constructor(sessionId, expectedRevision, actualRevision) {
    super('CAS_CONFLICT', `capsule ledger revision conflict for ${sessionId}: expected ${expectedRevision}, actual ${actualRevision}`, { sessionId, expectedRevision, actualRevision })
    this.name = 'CapsuleStoreConflictError'
  }
}

async function loadSqlite() {
  try { return await import('node:sqlite') } catch { return null }
}

/** Append-only immutable capsule ledger with SQLite/JSONL backends. */
export class CapsuleStore {
  constructor(options = {}) {
    this.rootDir = options.rootDir || DEFAULT_ROOT
    this.backendPreference = options.backend || 'auto'
    this.backend = null
    this.dbPath = options.dbPath || join(this.rootDir, 'capsules.sqlite')
    this.eventsPath = options.eventsPath || join(this.rootDir, 'capsules.events.jsonl')
    this.projectionPath = options.projectionPath || join(this.rootDir, 'capsules.projection.json')
    this.now = options.now || (() => new Date().toISOString())
    this._db = null
    this._records = new Map()
    this._byScope = new Map()
    this._ready = null
    this._queue = Promise.resolve()
  }

  async open() { await this._ensureReady(); return this }

  async _ensureReady() {
    if (!this._ready) this._ready = this._open()
    return this._ready
  }

  async _open() {
    await mkdir(this.rootDir, { recursive: true })
    let sqlite = null
    if (this.backendPreference !== 'jsonl') sqlite = await loadSqlite()
    if (sqlite?.DatabaseSync) {
      this.backend = 'sqlite'
      await mkdir(dirname(this.dbPath), { recursive: true })
      this._db = new sqlite.DatabaseSync(this.dbPath)
      this._db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS compaction_capsules (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          record_id TEXT NOT NULL UNIQUE,
          idempotency_key TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL,
          compaction_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          capsule_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          record_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_compaction_capsules_session
          ON compaction_capsules(session_id, revision);
        CREATE INDEX IF NOT EXISTS idx_compaction_capsules_compaction
          ON compaction_capsules(session_id, compaction_id);
      `)
      return
    }
    if (this.backendPreference === 'sqlite') throw new CapsuleStoreError('SQLITE_UNAVAILABLE', 'node:sqlite is unavailable; use backend:"jsonl" or Node 22+')
    this.backend = 'jsonl'
    await this._loadJsonl()
  }

  async _loadJsonl() {
    let content = ''
    try { content = await readFile(this.eventsPath, 'utf8') } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return
    }
    const lines = content.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim()
      if (!line) continue
      let record
      try { record = JSON.parse(line) } catch (error) {
        if (index === lines.length - 1) break
        throw new CapsuleStoreError('EVENT_LOG_CORRUPT', `invalid capsule JSONL event at line ${index + 1}`, { cause: String(error) })
      }
      const errors = validateRecord(record)
      if (errors.length) throw new CapsuleStoreError('CAPSULE_RECORD_INVALID', `invalid persisted capsule record at line ${index + 1}`, { errors })
      this._index(record)
    }
  }

  _index(record) {
    this._records.set(record.recordId, clone(record))
    this._records.set(record.idempotencyKey, clone(record))
    const scope = scopeKey(record.sessionId)
    const bucket = this._byScope.get(scope) || []
    if (!bucket.some((item) => item.recordId === record.recordId)) bucket.push(clone(record))
    bucket.sort((left, right) => left.revision - right.revision || left.createdAt.localeCompare(right.createdAt))
    this._byScope.set(scope, bucket)
  }

  _getById(recordId) {
    if (this.backend === 'sqlite') {
      const row = this._db.prepare('SELECT record_json FROM compaction_capsules WHERE record_id = ? OR idempotency_key = ?').get(recordId, recordId)
      return row ? JSON.parse(row.record_json) : null
    }
    return this._records.get(recordId) || null
  }

  _scopeRevision(sessionId) {
    if (this.backend === 'sqlite') {
      const row = this._db.prepare('SELECT MAX(revision) AS revision FROM compaction_capsules WHERE session_id = ?').get(sessionId)
      return Number(row?.revision || 0)
    }
    return (this._byScope.get(scopeKey(sessionId)) || []).reduce((max, record) => Math.max(max, record.revision), 0)
  }

  _existingByIdempotency(key) {
    if (this.backend === 'sqlite') {
      const row = this._db.prepare('SELECT record_json FROM compaction_capsules WHERE idempotency_key = ?').get(key)
      return row ? JSON.parse(row.record_json) : null
    }
    return this._records.get(key) || null
  }

  _sqliteAppend(record, expectedRevision) {
    this._db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this._db.prepare('SELECT record_json FROM compaction_capsules WHERE idempotency_key = ?').get(record.idempotencyKey)
      if (existing) {
        this._db.exec('ROLLBACK')
        return { record: JSON.parse(existing.record_json), idempotent: true }
      }
      const actualRevision = this._scopeRevision(record.sessionId)
      if (actualRevision !== expectedRevision) throw new CapsuleStoreConflictError(record.sessionId, expectedRevision, actualRevision)
      const next = { ...record, revision: actualRevision + 1 }
      const errors = validateRecord(next)
      if (errors.length) throw new CapsuleStoreError('CAPSULE_RECORD_INVALID', 'capsule record failed validation', { errors })
      this._db.prepare(`
        INSERT INTO compaction_capsules (
          record_id, idempotency_key, session_id, compaction_id, revision,
          capsule_hash, created_at, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(next.recordId, next.idempotencyKey, next.sessionId, next.compactionId, next.revision, next.capsuleHash, next.createdAt, JSON.stringify(next))
      this._db.exec('COMMIT')
      return { record: next, idempotent: false }
    } catch (error) {
      try { this._db.exec('ROLLBACK') } catch { /* preserve primary error */ }
      throw error
    }
  }

  async _persistJsonlProjection() {
    const all = []
    for (const records of this._byScope.values()) all.push(...records.map(clone))
    all.sort((left, right) => left.revision - right.revision || left.createdAt.localeCompare(right.createdAt))
    const data = { schemaVersion: 1, backend: 'jsonl', generatedAt: this.now(), records: all }
    const temporary = `${this.projectionPath}.tmp-${process.pid}-${randomUUID()}`
    await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', 'utf8')
    await rename(temporary, this.projectionPath)
  }

  _exclusive(operation) {
    const run = this._queue.then(operation, operation)
    this._queue = run.catch(() => {})
    return run
  }

  async append(input, options = {}) {
    await this._ensureReady()
    return this._exclusive(async () => {
      const record = clone(input)
      const errors = validateRecord(record)
      if (errors.length) throw new CapsuleStoreError('CAPSULE_RECORD_INVALID', 'capsule record failed validation', { errors })
      const existing = this._existingByIdempotency(record.idempotencyKey)
      if (existing) {
        if (existing.capsuleHash !== record.capsuleHash) throw new CapsuleStoreError('IDEMPOTENCY_CONFLICT', `idempotency key ${record.idempotencyKey} already maps to a different capsule`, { existing: existing.recordId, incoming: record.recordId })
        return { ok: true, record: clone(existing), idempotent: true }
      }
      const expectedRevision = options.expectedRevision === undefined ? this._scopeRevision(record.sessionId) : options.expectedRevision
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new CapsuleStoreError('REVISION_INVALID', 'expectedRevision must be a non-negative safe integer')
      if (this.backend === 'sqlite') {
        const result = this._sqliteAppend(record, expectedRevision)
        return { ok: true, record: clone(result.record), idempotent: result.idempotent }
      }
      const actualRevision = this._scopeRevision(record.sessionId)
      if (actualRevision !== expectedRevision) throw new CapsuleStoreConflictError(record.sessionId, expectedRevision, actualRevision)
      const next = { ...record, revision: actualRevision + 1 }
      const nextErrors = validateRecord(next)
      if (nextErrors.length) throw new CapsuleStoreError('CAPSULE_RECORD_INVALID', 'capsule record failed validation', { errors: nextErrors })
      await appendFile(this.eventsPath, JSON.stringify(next) + '\n', 'utf8')
      this._index(next)
      await this._persistJsonlProjection()
      return { ok: true, record: clone(next), idempotent: false }
    })
  }

  async get(options = {}) {
    await this._ensureReady()
    return this._exclusive(async () => {
      let record = null
      if (options.recordId) record = this._getById(options.recordId)
      else if (options.idempotencyKey) record = this._getById(options.idempotencyKey)
      else if (options.sessionId && options.compactionId) {
        if (this.backend === 'sqlite') {
          const row = this._db.prepare('SELECT record_json FROM compaction_capsules WHERE session_id = ? AND compaction_id = ?').get(options.sessionId, options.compactionId)
          record = row ? JSON.parse(row.record_json) : null
        } else record = (this._byScope.get(scopeKey(options.sessionId)) || []).find((item) => item.compactionId === options.compactionId) || null
      }
      if (!record) throw new CapsuleStoreError('CAPSULE_NOT_FOUND', 'capsule record not found')
      if (options.sessionId && record.sessionId !== options.sessionId) throw new CapsuleStoreError('SESSION_SCOPE_MISMATCH', 'capsule does not belong to the requested session')
      return clone(record)
    })
  }

  async list(options = {}) {
    await this._ensureReady()
    return this._exclusive(async () => {
      const sessionId = options.sessionId
      const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 10_000
      let records
      if (this.backend === 'sqlite') {
        const rows = sessionId
          ? this._db.prepare('SELECT record_json FROM compaction_capsules WHERE session_id = ? ORDER BY revision DESC LIMIT ?').all(sessionId, limit)
          : this._db.prepare('SELECT record_json FROM compaction_capsules ORDER BY created_at DESC LIMIT ?').all(limit)
        records = rows.map((row) => JSON.parse(row.record_json))
      } else {
        records = sessionId
          ? [...(this._byScope.get(scopeKey(sessionId)) || [])].sort((left, right) => right.revision - left.revision)
          : [...new Map([...this._records.values()].map((item) => [item.recordId, item])).values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        records = records.slice(0, limit)
      }
      return records.map(clone)
    })
  }

  async verify(input) {
    await this._ensureReady()
    return this._exclusive(async () => {
      const record = typeof input === 'string' ? this._getById(input) : clone(input)
      if (!record) return { ok: false, code: 'CAPSULE_NOT_FOUND', error: 'capsule record not found' }
      const errors = validateRecord(record)
      return errors.length
        ? { ok: false, code: 'CAPSULE_VERIFY_FAILED', errors }
        : { ok: true, recordId: record.recordId, capsuleHash: record.capsuleHash, sourceEventIds: record.sourceEventIds || [], sourceSeqs: record.sourceSeqs || [] }
    })
  }

  async close() {
    if (!this._ready) return
    await this._ready
    await this._queue
    if (this._db) {
      this._db.close()
      this._db = null
    }
    this._ready = null
    this.backend = null
  }
}

export function makeCapsuleRecord({ sessionId, compactionId, capsule, summaryEvent = {}, endEvent = {}, startEvent = {}, model = 'unknown', provider = 'unknown', createdAt, sourceSeqs, sourceEventIds }) {
  const resolvedSessionId = String(sessionId || '')
  const resolvedCompactionId = String(compactionId || summaryEvent.data?.compactionId || '')
  if (!resolvedSessionId || !resolvedCompactionId) throw new CapsuleStoreError('IDENTITY_REQUIRED', 'sessionId and compactionId are required')
  const resolvedSourceSeqs = (sourceSeqs || summaryEvent.data?.shadowedSeqs || []).map((seq) => Number(seq)).filter((seq) => Number.isSafeInteger(seq) && seq >= 0)
  const resolvedSourceEventIds = (sourceEventIds || [
    ...resolvedSourceSeqs.map((seq) => `session:${resolvedSessionId}:seq:${seq}`),
    ...(Number.isSafeInteger(summaryEvent.seq) ? [`session:${resolvedSessionId}:seq:${summaryEvent.seq}`] : []),
  ]).map(String)
  const record = {
    schemaVersion: 1,
    recordId: stableRecordId(resolvedSessionId, resolvedCompactionId),
    idempotencyKey: `${resolvedSessionId}:${resolvedCompactionId}`,
    sessionId: resolvedSessionId,
    compactionId: resolvedCompactionId,
    capsule: clone(capsule),
    capsuleHash: hashCapsule(capsule),
    sourceSeqs: [...new Set(resolvedSourceSeqs)],
    sourceEventIds: [...new Set(resolvedSourceEventIds)],
    startSeq: Number.isSafeInteger(startEvent.seq) ? startEvent.seq : undefined,
    summarySeq: Number.isSafeInteger(summaryEvent.seq) ? summaryEvent.seq : undefined,
    endSeq: Number.isSafeInteger(endEvent.seq) ? endEvent.seq : undefined,
    model: String(model || summaryEvent.data?.model || 'unknown'),
    provider: String(provider || summaryEvent.data?.provider || 'unknown'),
    createdAt: createdAt || (Number.isSafeInteger(endEvent.time) ? new Date(endEvent.time).toISOString() : new Date(0).toISOString()),
    revision: 1,
    status: 'committed',
  }
  if (record.startSeq === undefined) delete record.startSeq
  if (record.summarySeq === undefined) delete record.summarySeq
  if (record.endSeq === undefined) delete record.endSeq
  return record
}
