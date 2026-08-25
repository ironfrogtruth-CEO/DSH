import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export class GoalFirstStateError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'GoalFirstStateError'
    this.code = code
  }
}

function record(value) { return value && typeof value === 'object' && !Array.isArray(value) }

export function validateSnapshot(state) {
  if (!record(state) || state.schemaVersion !== 1) throw new GoalFirstStateError('STATE_SCHEMA_INVALID', 'goal-first state must use schemaVersion=1')
  if (typeof state.sessionId !== 'string' || !state.sessionId) throw new GoalFirstStateError('STATE_SCHEMA_INVALID', 'sessionId is required')
  if (!Number.isSafeInteger(state.revision) || state.revision < 1) throw new GoalFirstStateError('STATE_SCHEMA_INVALID', 'revision must be a positive integer')
  if (!Number.isSafeInteger(state.sourceEventSeq) || state.sourceEventSeq < 0) throw new GoalFirstStateError('STATE_SCHEMA_INVALID', 'sourceEventSeq must be a non-negative integer')
  if (!['simple_direct', 'sop_required'].includes(state.classification)) throw new GoalFirstStateError('STATE_SCHEMA_INVALID', 'classification is invalid')
  if (!['active', 'paused', 'blocked', 'complete'].includes(state.phase)) throw new GoalFirstStateError('STATE_SCHEMA_INVALID', 'phase is invalid')
  return state
}

function fileKey(sessionId) {
  return createHash('sha256').update(String(sessionId)).digest('hex')
}

export class GoalFirstStateStore {
  constructor(rootDir) {
    if (typeof rootDir !== 'string' || !rootDir) throw new GoalFirstStateError('STATE_ROOT_REQUIRED', 'state root is required')
    this.rootDir = rootDir
    this.locks = new Map()
  }

  file(sessionId) { return join(this.rootDir, `${fileKey(sessionId)}.jsonl`) }

  async load(sessionId) {
    let text
    try { text = await readFile(this.file(sessionId), 'utf8') } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
    const lines = text.split('\n')
    let latest = null
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line.trim()) continue
      try {
        const parsed = validateSnapshot(JSON.parse(line))
        if (parsed.sessionId !== sessionId) throw new GoalFirstStateError('STATE_SESSION_MISMATCH', 'state record belongs to another session')
        if (latest && parsed.revision !== latest.revision + 1) throw new GoalFirstStateError('STATE_REVISION_GAP', 'state revision is not monotonic')
        latest = parsed
      } catch (error) {
        const isTornTail = index === lines.length - 1 && !text.endsWith('\n')
        if (isTornTail) break
        throw error
      }
    }
    return latest
  }

  async append(sessionId, snapshot, expectedRevision) {
    const key = fileKey(sessionId)
    const previous = this.locks.get(key) || Promise.resolve()
    const task = previous.then(async () => {
      const current = await this.load(sessionId)
      const actual = current?.revision ?? 0
      if (expectedRevision !== actual) throw new GoalFirstStateError('STATE_REVISION_CONFLICT', `expected revision ${expectedRevision}, current revision is ${actual}`)
      const next = validateSnapshot({ ...structuredClone(snapshot), schemaVersion: 1, sessionId, revision: actual + 1 })
      await mkdir(this.rootDir, { recursive: true })
      const handle = await open(this.file(sessionId), 'a')
      try {
        await handle.write(`${JSON.stringify(next)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      return next
    })
    this.locks.set(key, task.catch(() => undefined))
    return task
  }
}
