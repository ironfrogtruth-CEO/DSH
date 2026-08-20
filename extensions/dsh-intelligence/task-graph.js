import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  assertValid,
  SchemaValidationError,
} from './schemas.js'

const DEFAULT_HOME = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh')
const DEFAULT_ROOT = process.env.DSH_INTELLIGENCE_ROOT || join(DEFAULT_HOME, 'intelligence')

const isoNow = () => new Date().toISOString()

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function makeId(prefix) {
  return `${prefix}:${randomUUID()}`
}

function asIso(value, fallback) {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' && value.length) return value
  return fallback()
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function taskPatchFromChanges(changes) {
  const source = changes?.spec && typeof changes.spec === 'object' ? changes.spec : changes
  const patch = source && typeof source === 'object' ? { ...source } : {}
  delete patch.spec
  delete patch.addNodes
  delete patch.addEvidence
  delete patch.addCapsules
  return patch
}

function normaliseUpdateChanges(changes, { taskId, projectId, createdAt, revision, spec, sessionId }) {
  const taskPatch = taskPatchFromChanges(changes)
  const normalized = { spec: clone(taskPatch) }
  if (Array.isArray(changes?.addNodes)) {
    normalized.addNodes = changes.addNodes.map((item) => defaultNode(item, {
      taskId,
      projectId,
      now: () => createdAt,
      revision,
    }))
  }
  if (Array.isArray(changes?.addEvidence)) {
    normalized.addEvidence = changes.addEvidence.map((item) => defaultEvidence(item, {
      taskId,
      projectId,
      now: () => createdAt,
    }))
  }
  if (Array.isArray(changes?.addCapsules)) {
    normalized.addCapsules = changes.addCapsules.map((item) => defaultCapsule(item, {
      taskId,
      projectId,
      sessionId: item?.sessionId || sessionId || 'session:unknown',
      now: () => createdAt,
      revision,
      spec,
    }))
  }
  return normalized
}

function defaultSpec(input, now) {
  const source = input && typeof input === 'object' ? input : {}
  const createdAt = asIso(source.createdAt, now)
  const taskId = source.taskId || makeId('task')
  return {
    schemaVersion: 1,
    taskId,
    projectId: source.projectId,
    title: source.title,
    objective: source.objective,
    status: source.status || 'planned',
    protectedConstraints: safeArray(source.protectedConstraints),
    acceptance: safeArray(source.acceptance),
    createdAt,
    updatedAt: asIso(source.updatedAt, () => createdAt),
    revision: 0,
    ...(source.metadata && typeof source.metadata === 'object' ? { metadata: clone(source.metadata) } : {}),
  }
}

function defaultNode(input, { taskId, projectId, now, revision }) {
  const source = input && typeof input === 'object' ? input : {}
  const createdAt = asIso(source.createdAt, now)
  return {
    schemaVersion: 1,
    nodeId: source.nodeId || makeId('node'),
    taskId: source.taskId || taskId,
    projectId: source.projectId || projectId,
    title: source.title,
    kind: source.kind || 'execute',
    status: source.status || 'planned',
    dependsOn: safeArray(source.dependsOn),
    evidenceIds: safeArray(source.evidenceIds),
    createdAt,
    updatedAt: asIso(source.updatedAt, () => createdAt),
    revision,
    ...(source.metadata && typeof source.metadata === 'object' ? { metadata: clone(source.metadata) } : {}),
  }
}

function defaultEvidence(input, { taskId, projectId, now }) {
  const source = input && typeof input === 'object' ? input : {}
  return {
    schemaVersion: 1,
    evidenceId: source.evidenceId || makeId('evidence'),
    taskId: source.taskId || taskId,
    projectId: source.projectId || projectId,
    kind: source.kind || 'observation',
    status: source.status || 'unknown',
    summary: source.summary,
    sourceRefs: safeArray(source.sourceRefs),
    createdAt: asIso(source.createdAt, now),
    untrusted: source.untrusted === true,
    ...(source.metadata && typeof source.metadata === 'object' ? { metadata: clone(source.metadata) } : {}),
  }
}

function defaultCapsule(input, { taskId, projectId, sessionId, now, revision, spec }) {
  const source = input && typeof input === 'object' ? input : {}
  return {
    schemaVersion: 1,
    capsuleId: source.capsuleId || makeId('capsule'),
    taskId: source.taskId || taskId,
    projectId: source.projectId || projectId,
    sessionId: source.sessionId || sessionId,
    goal: source.goal || spec.objective,
    protectedConstraints: safeArray(source.protectedConstraints || spec.protectedConstraints),
    planSnapshot: source.planSnapshot && typeof source.planSnapshot === 'object' ? clone(source.planSnapshot) : {},
    activeTask: source.activeTask && typeof source.activeTask === 'object' ? clone(source.activeTask) : null,
    decisions: safeArray(source.decisions).map(clone),
    touchedFiles: safeArray(source.touchedFiles),
    testsAndEvidence: safeArray(source.testsAndEvidence).map(clone),
    errorsAndAttempts: safeArray(source.errorsAndAttempts).map(clone),
    artifacts: safeArray(source.artifacts).map(clone),
    pendingJobs: safeArray(source.pendingJobs).map(clone),
    nextAction: source.nextAction || '恢复后先读取本任务的最新检查点，并按验收条件继续。',
    sourceEventIds: safeArray(source.sourceEventIds),
    createdAt: asIso(source.createdAt, now),
    revision,
    ...(source.metadata && typeof source.metadata === 'object' ? { metadata: clone(source.metadata) } : {}),
  }
}

export class TaskGraphError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'TaskGraphError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export class TaskGraphConflictError extends TaskGraphError {
  constructor(taskId, expectedRevision, actualRevision) {
    super('CAS_CONFLICT', `task ${taskId} revision conflict: expected ${expectedRevision}, actual ${actualRevision}`, {
      taskId,
      expectedRevision,
      actualRevision,
    })
    this.name = 'TaskGraphConflictError'
  }
}

function projectError(taskId, projectId, actualProjectId) {
  return new TaskGraphError('PROJECT_SCOPE_MISMATCH', `task ${taskId} is not in project ${projectId}`, { taskId, projectId, actualProjectId })
}

function ensureProject(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TaskGraphError('PROJECT_REQUIRED', 'projectId is required for TaskGraph isolation')
  return value.trim()
}

function ensureExpectedRevision(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || value < 0) throw new TaskGraphError('REVISION_INVALID', 'expectedRevision must be a non-negative safe integer')
  return value
}

function publicProjection(projection) {
  return clone({
    projectId: projection.projectId,
    task: projection.task,
    nodes: projection.nodes,
    evidence: projection.evidence,
    capsules: projection.capsules,
    revision: projection.revision,
    lastEventId: projection.lastEventId,
    updatedAt: projection.updatedAt,
    lastSessionId: projection.lastSessionId,
    lastResumedAt: projection.lastResumedAt,
  })
}

async function loadSqlite() {
  try {
    return await import('node:sqlite')
  } catch {
    return null
  }
}

/**
 * Append-only task graph with a projection rebuilt from durable events.
 *
 * `backend: "sqlite"` uses Node 22's built-in SQLite (WAL); `backend:
 * "jsonl"` uses an append-only event file and a derived projection snapshot.
 * `backend: "auto"` prefers SQLite and falls back to JSONL on older Node
 * versions.  Both backends expose the same CAS and project-scope semantics.
 */
export class TaskGraph {
  constructor(options = {}) {
    this.rootDir = options.rootDir || DEFAULT_ROOT
    this.backendPreference = options.backend || 'auto'
    this.backend = null
    this.dbPath = options.dbPath || join(this.rootDir, 'task-graph.sqlite')
    this.eventsPath = options.eventsPath || join(this.rootDir, 'task-graph.events.jsonl')
    this.projectionPath = options.projectionPath || join(this.rootDir, 'task-graph.projection.json')
    this.now = options.now || isoNow
    this._db = null
    this._events = []
    this._projections = new Map()
    this._sequence = 0
    this._ready = null
    this._queue = Promise.resolve()
    this._closePromise = null
  }

  async open() {
    await this._ensureReady()
    return this
  }

  async _ensureReady() {
    if (this._closePromise) await this._closePromise
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
        CREATE TABLE IF NOT EXISTS task_graph_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          type TEXT NOT NULL,
          expected_revision INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_task_graph_events_scope
          ON task_graph_events(project_id, task_id, sequence);
        CREATE TABLE IF NOT EXISTS task_graph_projection (
          task_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          task_json TEXT NOT NULL,
          nodes_json TEXT NOT NULL,
          evidence_json TEXT NOT NULL,
          capsules_json TEXT NOT NULL,
          last_event_id TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_session_id TEXT,
          last_resumed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_task_graph_projection_project
          ON task_graph_projection(project_id, updated_at);
      `)
      return
    }
    if (this.backendPreference === 'sqlite') throw new TaskGraphError('SQLITE_UNAVAILABLE', 'node:sqlite is unavailable; use backend:"jsonl" or Node 22+')
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
      let event
      try { event = JSON.parse(line) } catch (error) {
        // An interrupted append can leave a final partial line.  Never hide a
        // corrupt middle event, but tolerate the final incomplete write so a
        // later process can continue from the last complete event.
        if (index === lines.length - 1) break
        throw new TaskGraphError('EVENT_LOG_CORRUPT', `invalid JSONL event at line ${index + 1}`, { cause: String(error) })
      }
      this._events.push(event)
      this._sequence = Math.max(this._sequence, Number(event.sequence) || this._events.length)
      this._applyEvent(event)
    }
  }

  async close() {
    if (this._closePromise) return this._closePromise
    // Closing a never-opened store is a true no-op: it must not create a root
    // directory or a SQLite file merely as part of plugin disposal.
    if (!this._ready && !this._db) return
    const ready = this._ready
    const closing = (async () => {
      let readyError
      try {
        if (ready) await ready
      } catch (error) {
        readyError = error
      }
      // Every mutating operation owns its complete JSONL projection write (or
      // SQLite transaction) inside this queue.  Waiting here makes close a
      // durable barrier rather than just a handle close.
      await this._queue
      if (this._db) {
        this._db.close()
        this._db = null
      }
      this._ready = null
      this.backend = null
      this._queue = Promise.resolve()
      if (readyError) throw readyError
    })()
    this._closePromise = closing
    try {
      return await closing
    } finally {
      if (this._closePromise === closing) this._closePromise = null
    }
  }

  _exclusive(operation) {
    const run = this._queue.then(operation, operation)
    this._queue = run.catch(() => {})
    return run
  }

  _sqliteRow(taskId) {
    const row = this._db.prepare('SELECT * FROM task_graph_projection WHERE task_id = ?').get(taskId)
    if (!row) return null
    return {
      task: JSON.parse(row.task_json),
      nodes: JSON.parse(row.nodes_json),
      evidence: JSON.parse(row.evidence_json),
      capsules: JSON.parse(row.capsules_json),
      revision: Number(row.revision),
      lastEventId: row.last_event_id,
      updatedAt: row.updated_at,
      projectId: row.project_id,
      lastSessionId: row.last_session_id || undefined,
      lastResumedAt: row.last_resumed_at || undefined,
    }
  }

  _getProjection(taskId) {
    return this.backend === 'sqlite' ? this._sqliteRow(taskId) : this._projections.get(taskId) || null
  }

  _checkScope(projection, taskId, projectId) {
    const scope = ensureProject(projectId)
    if (!projection) throw new TaskGraphError('TASK_NOT_FOUND', `task ${taskId} was not found`, { taskId, projectId: scope })
    if (projection.projectId !== scope || projection.task.projectId !== scope) throw projectError(taskId, scope, projection.projectId)
    return scope
  }

  _validateProjection(projection) {
    assertValid('TaskSpec', projection.task)
    for (const node of projection.nodes) assertValid('TaskNode', node)
    for (const evidence of projection.evidence) assertValid('EvidenceRecord', evidence)
    for (const capsule of projection.capsules) assertValid('ContinuationCapsule', capsule)
  }

  _applyEvent(event) {
    let projection = this._projections.get(event.taskId)
    if (event.type === 'create') {
      const payload = event.payload
      projection = {
        task: clone(payload.task),
        nodes: clone(payload.nodes || []),
        evidence: clone(payload.evidence || []),
        capsules: clone(payload.capsules || []),
        revision: event.revision,
        lastEventId: event.eventId,
        updatedAt: event.createdAt,
        projectId: event.projectId,
      }
      this._projections.set(event.taskId, projection)
      return projection
    }
    if (!projection) throw new TaskGraphError('EVENT_LOG_CORRUPT', `event ${event.eventId} has no create projection`, { event })
    if (event.type === 'update') {
      const changes = event.payload.changes || {}
      const taskPatch = taskPatchFromChanges(changes)
      projection.task = {
        ...projection.task,
        ...clone(taskPatch),
        taskId: projection.task.taskId,
        projectId: projection.projectId,
        schemaVersion: 1,
        revision: event.revision,
        updatedAt: event.createdAt,
      }
      if (Array.isArray(changes.addNodes)) projection.nodes.push(...clone(changes.addNodes))
      if (Array.isArray(changes.addEvidence)) projection.evidence.push(...clone(changes.addEvidence))
      if (Array.isArray(changes.addCapsules)) projection.capsules.push(...clone(changes.addCapsules))
    } else if (event.type === 'checkpoint') {
      const capsule = clone(event.payload.capsule)
      projection.capsules.push(capsule)
      projection.task = { ...projection.task, revision: event.revision, updatedAt: event.createdAt }
    } else if (event.type === 'resume') {
      projection.lastSessionId = event.payload.sessionId
      projection.lastResumedAt = event.createdAt
      projection.task = { ...projection.task, revision: event.revision, updatedAt: event.createdAt }
    } else {
      throw new TaskGraphError('EVENT_LOG_CORRUPT', `unknown task graph event type ${event.type}`, { event })
    }
    projection.revision = event.revision
    projection.lastEventId = event.eventId
    projection.updatedAt = event.createdAt
    this._projections.set(event.taskId, projection)
    return projection
  }

  async _persistJsonlProjection() {
    const data = {
      schemaVersion: 1,
      generatedAt: this.now(),
      backend: 'jsonl',
      tasks: [...this._projections.values()].map(publicProjection),
    }
    const temporary = `${this.projectionPath}.tmp-${process.pid}-${randomUUID()}`
    await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', 'utf8')
    await rename(temporary, this.projectionPath)
  }

  _sqliteWriteProjection(projection) {
    this._db.prepare(`
      INSERT INTO task_graph_projection (
        task_id, project_id, revision, task_json, nodes_json, evidence_json,
        capsules_json, last_event_id, updated_at, last_session_id, last_resumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        project_id = excluded.project_id,
        revision = excluded.revision,
        task_json = excluded.task_json,
        nodes_json = excluded.nodes_json,
        evidence_json = excluded.evidence_json,
        capsules_json = excluded.capsules_json,
        last_event_id = excluded.last_event_id,
        updated_at = excluded.updated_at,
        last_session_id = excluded.last_session_id,
        last_resumed_at = excluded.last_resumed_at
    `).run(
      projection.task.taskId,
      projection.projectId,
      projection.revision,
      JSON.stringify(projection.task),
      JSON.stringify(projection.nodes),
      JSON.stringify(projection.evidence),
      JSON.stringify(projection.capsules),
      projection.lastEventId,
      projection.updatedAt,
      projection.lastSessionId || null,
      projection.lastResumedAt || null,
    )
  }

  _appendSqlite(event, projection) {
    this._db.exec('BEGIN IMMEDIATE')
    try {
      const current = this._db.prepare('SELECT revision, project_id AS projectId FROM task_graph_projection WHERE task_id = ?').get(event.taskId)
      const actualRevision = current ? Number(current.revision) : 0
      if (current && current.projectId !== event.projectId) throw projectError(event.taskId, event.projectId, current.projectId)
      if (actualRevision !== event.expectedRevision) throw new TaskGraphConflictError(event.taskId, event.expectedRevision, actualRevision)
      if (event.type === 'create' && current) throw new TaskGraphError('TASK_EXISTS', `task ${event.taskId} already exists`, { taskId: event.taskId, projectId: event.projectId })
      this._db.prepare(`
        INSERT INTO task_graph_events (
          event_id, task_id, project_id, type, expected_revision, revision,
          payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.eventId,
        event.taskId,
        event.projectId,
        event.type,
        event.expectedRevision,
        event.revision,
        JSON.stringify(event.payload),
        event.createdAt,
      )
      this._sqliteWriteProjection(projection)
      this._db.exec('COMMIT')
    } catch (error) {
      try { this._db.exec('ROLLBACK') } catch { /* preserve primary error */ }
      throw error
    }
  }

  async _append(event, projection) {
    if (this.backend === 'sqlite') {
      this._appendSqlite(event, projection)
      return
    }
    await appendFile(this.eventsPath, JSON.stringify(event) + '\n', 'utf8')
    this._events.push(event)
    this._sequence = event.sequence
    this._projections.set(event.taskId, projection)
    await this._persistJsonlProjection()
  }

  _event({ taskId, projectId, type, expectedRevision, revision, payload, createdAt }) {
    return {
      schemaVersion: 1,
      eventId: makeId('task-event'),
      sequence: this._sequence + 1,
      taskId,
      projectId,
      type,
      expectedRevision,
      revision,
      payload: clone(payload),
      createdAt,
    }
  }

  _prepareProjection(projection, { event, validate = true } = {}) {
    projection.revision = event.revision
    projection.lastEventId = event.eventId
    projection.updatedAt = event.createdAt
    if (validate) this._validateProjection(projection)
    return projection
  }

  async create(input, options = {}) {
    await this._ensureReady()
    return this._exclusive(async () => {
      const now = () => asIso(this.now(), isoNow)
      const source = input && typeof input === 'object' && input.spec ? input.spec : input
      const spec = defaultSpec(source, now)
      const projectId = ensureProject(options.projectId || spec.projectId)
      spec.projectId = projectId
      spec.createdAt = asIso(spec.createdAt, now)
      spec.updatedAt = asIso(spec.updatedAt, () => spec.createdAt)
      spec.revision = 1
      assertValid('TaskSpec', spec)

      const existing = this._getProjection(spec.taskId)
      if (existing) throw new TaskGraphError('TASK_EXISTS', `task ${spec.taskId} already exists`, { taskId: spec.taskId, projectId })
      const nodes = safeArray(options.nodes || input?.nodes).map((item) => defaultNode(item, { taskId: spec.taskId, projectId, now, revision: 1 }))
      const evidence = safeArray(options.evidence || input?.evidence).map((item) => defaultEvidence(item, { taskId: spec.taskId, projectId, now }))
      const capsules = safeArray(options.capsules || input?.capsules).map((item) => defaultCapsule(item, { taskId: spec.taskId, projectId, sessionId: item?.sessionId || options.sessionId || 'session:unknown', now, revision: 1, spec }))
      for (const node of nodes) { node.taskId = spec.taskId; node.projectId = projectId; assertValid('TaskNode', node) }
      for (const item of evidence) { item.taskId = spec.taskId; item.projectId = projectId; assertValid('EvidenceRecord', item) }
      for (const capsule of capsules) { capsule.taskId = spec.taskId; capsule.projectId = projectId; assertValid('ContinuationCapsule', capsule) }
      if (spec.status === 'done' && evidence.length === 0) throw new TaskGraphError('DONE_REQUIRES_EVIDENCE', `task ${spec.taskId} cannot be done without evidence`, { taskId: spec.taskId })
      const createdAt = now()
      const event = this._event({ taskId: spec.taskId, projectId, type: 'create', expectedRevision: 0, revision: 1, payload: { task: spec, nodes, evidence, capsules }, createdAt })
      const projection = { task: spec, nodes, evidence, capsules, revision: 1, lastEventId: event.eventId, updatedAt: createdAt, projectId }
      this._validateProjection(projection)
      await this._append(event, projection)
      return publicProjection(projection)
    })
  }

  async get(taskId, options = {}) {
    await this._ensureReady()
    return this._exclusive(async () => {
      const projection = this._getProjection(taskId)
      this._checkScope(projection, taskId, options.projectId)
      return publicProjection(projection)
    })
  }

  async list(options = {}) {
    await this._ensureReady()
    return this._exclusive(async () => {
      const projectId = ensureProject(options.projectId)
      let items
      if (this.backend === 'sqlite') {
        const rows = this._db.prepare('SELECT * FROM task_graph_projection WHERE project_id = ? ORDER BY updated_at DESC, task_id ASC LIMIT ?').all(projectId, Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 10_000)
        items = rows.map((row) => publicProjection({
          task: JSON.parse(row.task_json),
          nodes: JSON.parse(row.nodes_json),
          evidence: JSON.parse(row.evidence_json),
          capsules: JSON.parse(row.capsules_json),
          revision: Number(row.revision),
          lastEventId: row.last_event_id,
          updatedAt: row.updated_at,
          projectId: row.project_id,
          lastSessionId: row.last_session_id || undefined,
          lastResumedAt: row.last_resumed_at || undefined,
        }))
      } else items = [...this._projections.values()].filter((item) => item.projectId === projectId).map(publicProjection)
      if (options.status) items = items.filter((item) => item.task.status === options.status)
      if (options.limit && items.length > options.limit) items = items.slice(0, options.limit)
      return items
    })
  }

  async update(taskId, changes = {}, options = {}) {
    await this._ensureReady()
    return this._exclusive(async () => {
      const current = this._getProjection(taskId)
      const projectId = this._checkScope(current, taskId, options.projectId)
      const expectedRevision = ensureExpectedRevision(options.expectedRevision, current.revision)
      if (expectedRevision !== current.revision) throw new TaskGraphConflictError(taskId, expectedRevision, current.revision)
      const createdAt = asIso(this.now(), isoNow)
      const nextRevision = current.revision + 1
      const projection = clone(current)
      const taskPatch = taskPatchFromChanges(changes)
      projection.task = { ...projection.task, ...clone(taskPatch), taskId, projectId, schemaVersion: 1, revision: nextRevision, updatedAt: createdAt }
      const normalizedChanges = normaliseUpdateChanges(changes, {
        taskId,
        projectId,
        createdAt,
        revision: nextRevision,
        spec: projection.task,
        sessionId: options.sessionId,
      })
      if (Array.isArray(normalizedChanges.addNodes)) projection.nodes.push(...clone(normalizedChanges.addNodes))
      if (Array.isArray(normalizedChanges.addEvidence)) projection.evidence.push(...clone(normalizedChanges.addEvidence))
      if (Array.isArray(normalizedChanges.addCapsules)) projection.capsules.push(...clone(normalizedChanges.addCapsules))
      if (projection.task.status === 'done' && projection.evidence.length === 0) throw new TaskGraphError('DONE_REQUIRES_EVIDENCE', `task ${taskId} cannot be done without evidence`, { taskId })
      const event = this._event({ taskId, projectId, type: 'update', expectedRevision, revision: nextRevision, payload: { changes: normalizedChanges }, createdAt })
      this._prepareProjection(projection, { event })
      await this._append(event, projection)
      return publicProjection(projection)
    })
  }

  async checkpoint(taskId, capsuleInput, options = {}) {
    await this._ensureReady()
    return this._exclusive(async () => {
      const current = this._getProjection(taskId)
      const projectId = this._checkScope(current, taskId, options.projectId)
      const expectedRevision = ensureExpectedRevision(options.expectedRevision, current.revision)
      if (expectedRevision !== current.revision) throw new TaskGraphConflictError(taskId, expectedRevision, current.revision)
      const createdAt = asIso(this.now(), isoNow)
      const nextRevision = current.revision + 1
      const capsule = defaultCapsule(capsuleInput, { taskId, projectId, sessionId: capsuleInput?.sessionId || options.sessionId || 'session:unknown', now: () => createdAt, revision: nextRevision, spec: current.task })
      capsule.taskId = taskId
      capsule.projectId = projectId
      assertValid('ContinuationCapsule', capsule)
      const event = this._event({ taskId, projectId, type: 'checkpoint', expectedRevision, revision: nextRevision, payload: { capsule }, createdAt })
      const projection = clone(current)
      projection.capsules.push(capsule)
      projection.task = { ...projection.task, revision: nextRevision, updatedAt: createdAt }
      this._prepareProjection(projection, { event })
      await this._append(event, projection)
      return { capsule: clone(capsule), ...publicProjection(projection) }
    })
  }

  async resume(taskId, options = {}) {
    await this._ensureReady()
    return this._exclusive(async () => {
      const current = this._getProjection(taskId)
      const projectId = this._checkScope(current, taskId, options.projectId)
      const expectedRevision = ensureExpectedRevision(options.expectedRevision, current.revision)
      if (expectedRevision !== current.revision) throw new TaskGraphConflictError(taskId, expectedRevision, current.revision)
      const sessionId = options.sessionId
      if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TaskGraphError('SESSION_REQUIRED', 'sessionId is required when resuming a task')
      const createdAt = asIso(this.now(), isoNow)
      const nextRevision = current.revision + 1
      const event = this._event({ taskId, projectId, type: 'resume', expectedRevision, revision: nextRevision, payload: { sessionId }, createdAt })
      const projection = clone(current)
      projection.lastSessionId = sessionId
      projection.lastResumedAt = createdAt
      projection.task = { ...projection.task, revision: nextRevision, updatedAt: createdAt }
      this._prepareProjection(projection, { event })
      await this._append(event, projection)
      return { ...publicProjection(projection), capsule: clone(projection.capsules.at(-1) || null), resumed: true, sessionId }
    })
  }

  async events(taskId, options = {}) {
    await this._ensureReady()
    return this._exclusive(async () => {
      const projection = this._getProjection(taskId)
      const projectId = this._checkScope(projection, taskId, options.projectId)
      if (this.backend === 'sqlite') {
        return this._db.prepare('SELECT sequence, event_id AS eventId, task_id AS taskId, project_id AS projectId, type, expected_revision AS expectedRevision, revision, payload_json, created_at AS createdAt FROM task_graph_events WHERE task_id = ? AND project_id = ? ORDER BY sequence ASC').all(taskId, projectId).map((row) => ({
          sequence: Number(row.sequence), eventId: row.eventId, taskId: row.taskId, projectId: row.projectId, type: row.type, expectedRevision: Number(row.expectedRevision), revision: Number(row.revision), payload: JSON.parse(row.payload_json), createdAt: row.createdAt,
        }))
      }
      return this._events.filter((event) => event.taskId === taskId && event.projectId === projectId).map(clone)
    })
  }
}

// Stable alias so callers can depend on a storage role rather than an
// implementation name while the SQLite/JSONL backends evolve.
export const TaskGraphStore = TaskGraph

export const TASK_GRAPH_BACKENDS = Object.freeze(['auto', 'sqlite', 'jsonl'])
export const TASK_GRAPH_ERROR_CODES = Object.freeze([
  'CAS_CONFLICT',
  'DONE_REQUIRES_EVIDENCE',
  'EVENT_LOG_CORRUPT',
  'PROJECT_REQUIRED',
  'PROJECT_SCOPE_MISMATCH',
  'REVISION_INVALID',
  'SESSION_REQUIRED',
  'SQLITE_UNAVAILABLE',
  'TASK_EXISTS',
  'TASK_NOT_FOUND',
])

export function hashProjection(projection) {
  return createHash('sha256').update(JSON.stringify(projection)).digest('hex')
}

export { SchemaValidationError }
