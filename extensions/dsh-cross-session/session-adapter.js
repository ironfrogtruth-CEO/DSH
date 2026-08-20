// Adapter boundary for the rc.8 sessionQuery Host service. Tests can inject a
// fake implementing the same four methods without booting the Harness.

export const SESSION_QUERY_METHODS = ['listSessions', 'readTitle', 'traceSession', 'readSession']

function headerOf(record) { return record?.header || record?.session || record || {} }

export function normalizeSessionRecord(record) {
  const header = headerOf(record)
  const id = String(header.id || record?.id || '').trim()
  return {
    id,
    cwd: header.cwd ? String(header.cwd) : null,
    createdAt: header.createdAt ?? null,
    updatedAt: header.updatedAt ?? header.lastActivityAt ?? null,
    parentSession: header.parentSession ? String(header.parentSession) : null,
    branch: header.branch || header.gitBranch || null,
    worktree: header.worktree || header.worktreeId || null,
    gitRemote: header.gitRemote || header.remote || null,
    model: header.model || null,
    untrusted: true,
    rawHeader: {
      id,
      cwd: header.cwd ?? null,
      createdAt: header.createdAt ?? null,
      updatedAt: header.updatedAt ?? header.lastActivityAt ?? null,
      parentSession: header.parentSession ?? null,
    },
  }
}

function descendants(value, out = []) {
  if (!value) return out
  const id = value.header?.id || value.id
  if (id) out.push(String(id))
  for (const child of value.descendants || value.children || []) descendants(child, out)
  return out
}

export function normalizeTrace(trace, sessionId) {
  const target = normalizeSessionRecord(trace?.target || { id: sessionId })
  const ancestors = (trace?.ancestors || []).map(normalizeSessionRecord)
  const descendantRecords = []
  for (const child of trace?.descendants || trace?.children || []) {
    const id = child?.header?.id || child?.id
    if (id) descendantRecords.push(String(id))
    descendants(child, descendantRecords)
  }
  return {
    target,
    ancestorIds: ancestors.map((item) => item.id).filter(Boolean),
    descendantIds: [...new Set(descendantRecords.filter((id) => id && id !== target.id))],
    parentSession: target.parentSession,
    complete: trace?.complete !== false,
    unresolvedParentId: trace?.unresolvedParentId || null,
    rootId: trace?.root?.header?.id || trace?.root?.id || ancestors.at(-1)?.id || target.id,
    untrusted: true,
  }
}

export class SessionQueryAdapter {
  constructor(service) {
    this.service = service
    if (!service || typeof service.listSessions !== 'function' || typeof service.readTitle !== 'function' || typeof service.traceSession !== 'function') {
      const error = new Error('sessionQuery must provide listSessions/readTitle/traceSession; readSession remains available for explicit callers')
      error.code = 'SESSION_QUERY_UNAVAILABLE'
      throw error
    }
  }

  async listSessions() {
    const records = await this.service.listSessions()
    return (Array.isArray(records) ? records : []).map(normalizeSessionRecord).filter((item) => item.id)
  }

  async readTitle(sessionId) {
    const title = await this.service.readTitle(sessionId)
    if (title === undefined || title === null) return null
    if (typeof title === 'string') return title.slice(0, 1_000)
    return String(title.title || title.text || '').slice(0, 1_000) || null
  }

  async traceSession(sessionId) {
    return normalizeTrace(await this.service.traceSession(sessionId), sessionId)
  }

  async readSession(sessionId) {
    if (typeof this.service.readSession !== 'function') {
      const error = new Error('sessionQuery.readSession is unavailable')
      error.code = 'SESSION_QUERY_READ_UNAVAILABLE'
      throw error
    }
    const result = await this.service.readSession(sessionId)
    return { ...result, untrusted: true }
  }
}
