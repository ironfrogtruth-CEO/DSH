// dsh-cross-session — Host-only append-only association store.
// SQLite is preferred; the JSON adapter is only a runtime compatibility
// fallback for Node versions without node:sqlite. No UI/client dependency.
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
let DatabaseSync = null
try { ({ DatabaseSync } = require('node:sqlite')) } catch { /* JSON fallback below */ }

export const DEFAULT_ROOT = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'cross-session')
export const DEFAULT_DB = join(DEFAULT_ROOT, 'cross-session.sqlite')
export const MAX_PAYLOAD_CHARS = 256_000

export function getCrossSessionDbPath() {
  const configured = String(process.env.DSH_CROSS_SESSION_DB || '').trim()
  if (!configured) return DEFAULT_DB
  if (configured === ':memory:') return configured
  if (/^file:/i.test(configured)) throw new Error('DSH_CROSS_SESSION_DB 只接受本地文件路径')
  return configured
}

export function hashId(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function now() { return new Date().toISOString() }

function json(value) {
  const text = JSON.stringify(value ?? {})
  if (text.length > MAX_PAYLOAD_CHARS) throw new Error(`payload 过长(>${MAX_PAYLOAD_CHARS} 字符)`)
  return text
}

function parse(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback } catch { return fallback }
}

function safeParent(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temp, JSON.stringify(value), 'utf8')
  renameSync(temp, path)
}

function readJson(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return value && Array.isArray(value.events) && Array.isArray(value.projections) && Array.isArray(value.associations)
      ? value
      : null
  } catch { return null }
}

export class CrossSessionError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'CrossSessionError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function projectionKey(type, id, projectId) { return `${projectId}\u0000${type}\u0000${id}` }

function rowEvent(row) {
  if (!row) return null
  return {
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    projectId: row.project_id,
    revision: Number(row.revision),
    payload: parse(row.payload_json),
    occurredAt: row.occurred_at,
  }
}

function rowProjection(row) {
  if (!row) return null
  return {
    entityType: row.entity_type,
    entityId: row.entity_id,
    projectId: row.project_id,
    revision: Number(row.revision),
    payload: parse(row.payload_json),
    updatedAt: row.updated_at,
  }
}

function rowAssociation(row) {
  if (!row) return null
  return {
    relationId: row.relation_id,
    relationType: row.relation_type,
    fromType: row.from_type,
    fromId: row.from_id,
    toType: row.to_type,
    toId: row.to_id,
    projectId: row.project_id,
    source: row.source,
    evidence: parse(row.evidence_json),
    status: row.status,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function schema(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS cross_session_events (
      rowid INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cross_session_events_project_time
      ON cross_session_events(project_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS cross_session_events_entity_revision
      ON cross_session_events(project_id, entity_type, entity_id, revision DESC);
    CREATE TABLE IF NOT EXISTS cross_session_projections (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, entity_type, entity_id)
    );
    CREATE TABLE IF NOT EXISTS cross_session_associations (
      relation_id TEXT PRIMARY KEY,
      relation_type TEXT NOT NULL,
      from_type TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_type TEXT NOT NULL,
      to_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      source TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, relation_type, from_type, from_id, to_type, to_id)
    );
    CREATE INDEX IF NOT EXISTS cross_session_assoc_from
      ON cross_session_associations(project_id, from_type, from_id, status);
    CREATE INDEX IF NOT EXISTS cross_session_assoc_to
      ON cross_session_associations(project_id, to_type, to_id, status);
  `)
}

export class CrossSessionStore {
  constructor(path = getCrossSessionDbPath()) {
    this.path = path
    this.db = null
    this.backend = 'sqlite'
    this.fallbackPath = null
    this.state = null
    this.dirty = false
    if (DatabaseSync) {
      try {
        safeParent(path)
        this.db = new DatabaseSync(path)
        this.db.exec('PRAGMA busy_timeout=5000;')
        if (path !== ':memory:') {
          try { this.db.exec('PRAGMA journal_mode=WAL;') } catch { /* best effort */ }
        }
        try { this.db.exec('PRAGMA synchronous=NORMAL;') } catch { /* best effort */ }
        schema(this.db)
      } catch {
        try { this.db?.close() } catch { /* ignore */ }
        this.db = null
      }
    }
    if (!this.db) {
      this.backend = 'json'
      this.fallbackPath = path === ':memory:' ? null : `${path}.json`
      this.state = (this.fallbackPath && readJson(this.fallbackPath)) || { schemaVersion: 1, events: [], projections: [], associations: [] }
    }
  }

  close() {
    if (this.backend === 'sqlite') {
      this.db?.close()
      this.db = null
    }
    else if (this.dirty && this.fallbackPath) atomicWrite(this.fallbackPath, this.state)
  }

  _eventByIdempotency(key) {
    if (this.backend === 'sqlite') return rowEvent(this.db.prepare('SELECT * FROM cross_session_events WHERE idempotency_key = ?').get(key))
    return this.state.events.find((item) => item.idempotencyKey === key) || null
  }

  getProjection(entityType, entityId, projectId) {
    if (this.backend === 'sqlite') return rowProjection(this.db.prepare(`SELECT * FROM cross_session_projections
      WHERE entity_type = ? AND entity_id = ? AND project_id = ?`).get(entityType, entityId, projectId))
    const item = this.state.projections.find((row) => row.entityType === entityType && row.entityId === entityId && row.projectId === projectId)
    return item || null
  }

  _setProjection(projection) {
    if (this.backend === 'sqlite') {
      this.db.prepare(`INSERT INTO cross_session_projections(entity_type, entity_id, project_id, revision, payload_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, entity_type, entity_id) DO UPDATE SET revision=excluded.revision,
        payload_json=excluded.payload_json, updated_at=excluded.updated_at`).run(
        projection.entityType, projection.entityId, projection.projectId, projection.revision, json(projection.payload), projection.updatedAt,
      )
      return
    }
    const index = this.state.projections.findIndex((row) => row.entityType === projection.entityType && row.entityId === projection.entityId && row.projectId === projection.projectId)
    if (index >= 0) this.state.projections[index] = projection
    else this.state.projections.push(projection)
    this.dirty = true
  }

  _insertEvent(event) {
    if (this.backend === 'sqlite') {
      this.db.prepare(`INSERT INTO cross_session_events
        (event_id, idempotency_key, event_type, entity_type, entity_id, project_id, revision, payload_json, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        event.eventId, event.idempotencyKey, event.eventType, event.entityType, event.entityId, event.projectId,
        event.revision, json(event.payload), event.occurredAt,
      )
      return
    }
    this.state.events.push(event)
    this.dirty = true
  }

  appendEntityEvent({ eventType, entityType, entityId, projectId, payload = {}, expectedRevision, idempotencyKey }) {
    if (!eventType || !entityType || !entityId || !projectId) throw new CrossSessionError('ENTITY_REQUIRED', 'eventType/entityType/entityId/projectId are required')
    const normalizedPayload = { ...payload }
    const idem = String(idempotencyKey || hashId(JSON.stringify({ eventType, entityType, entityId, projectId, payload: normalizedPayload })))
    const existing = this._eventByIdempotency(idem)
    if (existing) return { deduped: true, event: existing, projection: this.getProjection(entityType, entityId, projectId) }
    const current = this.getProjection(entityType, entityId, projectId)
    const currentRevision = current?.revision || 0
    if (expectedRevision !== undefined && Number(expectedRevision) !== currentRevision) {
      throw new CrossSessionError('CAS_CONFLICT', `expected revision ${expectedRevision}, current revision ${currentRevision}`, { currentRevision })
    }
    const revision = currentRevision + 1
    const event = {
      eventId: randomUUID(), idempotencyKey: idem, eventType, entityType, entityId, projectId, revision,
      payload: normalizedPayload, occurredAt: now(),
    }
    const projection = { entityType, entityId, projectId, revision, payload: normalizedPayload, updatedAt: event.occurredAt }
    if (this.backend === 'sqlite') this.db.exec('BEGIN IMMEDIATE')
    try {
      this._insertEvent(event)
      this._setProjection(projection)
      if (this.backend === 'sqlite') this.db.exec('COMMIT')
    } catch (error) {
      if (this.backend === 'sqlite') { try { this.db.exec('ROLLBACK') } catch { /* ignore */ } }
      if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new CrossSessionError('IDEMPOTENCY_CONFLICT', 'idempotency key already exists')
      throw error
    }
    return { deduped: false, event, projection }
  }

  getAssociation(relationId, projectId) {
    if (this.backend === 'sqlite') return rowAssociation(this.db.prepare('SELECT * FROM cross_session_associations WHERE relation_id = ? AND project_id = ?').get(relationId, projectId))
    const row = this.state.associations.find((item) => item.relationId === relationId && item.projectId === projectId)
    return row || null
  }

  listAssociations({ projectId, relationType, fromId, toId, limit = 200 } = {}) {
    const max = Math.max(1, Math.min(2_000, Number(limit || 200)))
    if (this.backend === 'sqlite') {
      const where = ['project_id = ?', "status = 'active'"]
      const params = [projectId]
      if (relationType) { where.push('relation_type = ?'); params.push(relationType) }
      if (fromId) { where.push('from_id = ?'); params.push(fromId) }
      if (toId) { where.push('to_id = ?'); params.push(toId) }
      params.push(max)
      return this.db.prepare(`SELECT * FROM cross_session_associations WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`).all(...params).map(rowAssociation)
    }
    return this.state.associations.filter((row) => row.projectId === projectId && row.status === 'active'
      && (!relationType || row.relationType === relationType) && (!fromId || row.fromId === fromId) && (!toId || row.toId === toId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, max)
  }

  associate({ relationType, fromType, fromId, toType, toId, projectId, source = 'explicit', evidence = {}, expectedRevision, idempotencyKey, relationId }) {
    const validRelations = new Set(['continues', 'forks', 'belongs_to', 'depends_on', 'produces', 'constrains', 'resumes_at'])
    if (!validRelations.has(relationType)) throw new CrossSessionError('RELATION_INVALID', `unsupported relation ${relationType}`)
    for (const [name, value] of [['fromType', fromType], ['fromId', fromId], ['toType', toType], ['toId', toId], ['projectId', projectId]]) {
      if (!String(value || '').trim()) throw new CrossSessionError('RELATION_REQUIRED', `${name} is required`)
    }
    const shapes = {
      continues: [['session', 'session'], ['session', 'task']],
      forks: [['session', 'session']],
      belongs_to: [['task', 'project']],
      depends_on: [['task', 'task']],
      produces: [['task', 'artifact']],
      constrains: [['decision', 'task']],
      resumes_at: [['checkpoint', 'task'], ['checkpoint', 'session']],
    }
    const allowedShape = (shapes[relationType] || []).some(([from, to]) => String(fromType).toLowerCase() === from && String(toType).toLowerCase() === to)
    if (!allowedShape) throw new CrossSessionError('RELATION_SHAPE_INVALID', `${relationType} does not allow ${fromType} -> ${toType}`)
    const id = relationId || `relation:${hashId(JSON.stringify({ relationType, fromType, fromId, toType, toId, projectId })).slice(0, 32)}`
    const existing = this.getAssociation(id, projectId)
    if (existing && idempotencyKey === undefined) {
      if (expectedRevision !== undefined && Number(expectedRevision) !== existing.revision) throw new CrossSessionError('CAS_CONFLICT', `expected revision ${expectedRevision}, current revision ${existing.revision}`, { currentRevision: existing.revision })
      return { deduped: true, association: existing, event: null }
    }
    const revision = existing?.revision || 0
    if (expectedRevision !== undefined && Number(expectedRevision) !== revision) throw new CrossSessionError('CAS_CONFLICT', `expected revision ${expectedRevision}, current revision ${revision}`, { currentRevision: revision })
    const eventKey = String(idempotencyKey || hashId(JSON.stringify({ relationType, fromType, fromId, toType, toId, projectId, source, evidence })))
    const priorEvent = this._eventByIdempotency(eventKey)
    if (priorEvent) return { deduped: true, association: this.getAssociation(id, projectId), event: priorEvent }
    const createdAt = existing?.createdAt || now()
    const updatedAt = now()
    const association = { relationId: id, relationType, fromType, fromId, toType, toId, projectId, source, evidence, status: 'active', revision: revision + 1, createdAt, updatedAt }
    const event = { eventId: randomUUID(), idempotencyKey: eventKey, eventType: 'association/add', entityType: 'association', entityId: id, projectId, revision: association.revision, payload: association, occurredAt: updatedAt }
    if (this.backend === 'sqlite') this.db.exec('BEGIN IMMEDIATE')
    try {
      this._insertEvent(event)
      if (this.backend === 'sqlite') {
        this.db.prepare(`INSERT INTO cross_session_associations
          (relation_id, relation_type, from_type, from_id, to_type, to_id, project_id, source, evidence_json, status, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(relation_id) DO UPDATE SET source=excluded.source, evidence_json=excluded.evidence_json,
          status=excluded.status, revision=excluded.revision, updated_at=excluded.updated_at`).run(
          id, relationType, fromType, fromId, toType, toId, projectId, source, json(evidence), 'active', association.revision, createdAt, updatedAt,
        )
      } else {
        const index = this.state.associations.findIndex((row) => row.relationId === id && row.projectId === projectId)
        if (index >= 0) this.state.associations[index] = association
        else this.state.associations.push(association)
        this.dirty = true
      }
      if (this.backend === 'sqlite') this.db.exec('COMMIT')
    } catch (error) {
      if (this.backend === 'sqlite') { try { this.db.exec('ROLLBACK') } catch { /* ignore */ } }
      throw error
    }
    return { deduped: false, association, event }
  }

  listEntities({ projectId, entityType, limit = 200 } = {}) {
    const max = Math.max(1, Math.min(2_000, Number(limit || 200)))
    if (this.backend === 'sqlite') {
      const where = ['project_id = ?']; const params = [projectId]
      if (entityType) { where.push('entity_type = ?'); params.push(entityType) }
      params.push(max)
      return this.db.prepare(`SELECT * FROM cross_session_projections WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`).all(...params).map(rowProjection)
    }
    return this.state.projections.filter((row) => row.projectId === projectId && (!entityType || row.entityType === entityType))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, max)
  }

  listEvents({ projectId, entityType, entityId, limit = 500 } = {}) {
    const max = Math.max(1, Math.min(5_000, Number(limit || 500)))
    if (this.backend === 'sqlite') {
      const where = ['project_id = ?']; const params = [projectId]
      if (entityType) { where.push('entity_type = ?'); params.push(entityType) }
      if (entityId) { where.push('entity_id = ?'); params.push(entityId) }
      params.push(max)
      return this.db.prepare(`SELECT * FROM cross_session_events WHERE ${where.join(' AND ')} ORDER BY occurred_at DESC LIMIT ?`).all(...params).map(rowEvent)
    }
    return this.state.events.filter((row) => row.projectId === projectId && (!entityType || row.entityType === entityType) && (!entityId || row.entityId === entityId))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, max)
  }
}

export function createCrossSessionStore(path = getCrossSessionDbPath()) {
  return new CrossSessionStore(path)
}
