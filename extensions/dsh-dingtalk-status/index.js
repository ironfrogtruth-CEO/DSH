// @local/dsh-dingtalk-status — read-only Host status projection.
//
// The official connector owns credentials, Stream, sessions and setup.  This
// extension only reads the connector's redacted local state and exposes a
// deliberately small status contract for the existing sidebar utility slot.
// It never writes configuration, invokes a shell, sends a message, or opens a
// network connection.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-dingtalk-status'
export const inject = ['webServer', 'credentials', 'sessionQuery', 'sessionPersistence', 'agents']

export const DINGTALK_VERSION = '0.6.2'
export const DEFAULT_WORKSPACE = '/Users/marcus/Desktop'
export const SETUP_COMMAND = `npx @dingtalk-real-ai/dsh-dingtalk@${DINGTALK_VERSION} setup`
export const STREAM_STALE_MS = 30_000
export const MAX_JSON_BYTES = 256 * 1024
export const MAX_SESSION_ROWS = 5

const text = (value) => String(value ?? '')

function dshHome(home = homedir()) {
  return process.env.DSH_HOME || join(home, '.dsh')
}

export function statePaths({ home = homedir(), stateDir = process.env.DSH_DINGTALK_STATE_DIR } = {}) {
  const root = stateDir || join(home, '.dsh-dingtalk')
  return {
    root,
    package: join(dshHome(home), 'profiles', 'web', 'node_modules', '@dingtalk-real-ai', 'dsh-dingtalk', 'package.json'),
    runtime: join(root, 'runtime.json'),
    owner: join(root, 'owner.json'),
    capabilities: join(root, 'capabilities.json'),
    bindings: join(root, 'bindings.json'),
  }
}

async function readJson(file, readFileImpl = readFile) {
  try {
    const raw = await readFileImpl(file, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > MAX_JSON_BYTES) return null
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

async function readPackageStatus(file, readFileImpl) {
  const value = await readJson(file, readFileImpl)
  const version = typeof value?.version === 'string' && value.version.length < 64 ? value.version : null
  return {
    installed: Boolean(version),
    version,
    supported: version === DINGTALK_VERSION,
  }
}

function credentialValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value.value
  return value
}

export async function credentialPresence({ resolveCredential, env = process.env } = {}) {
  const present = async (name) => {
    try {
      const value = credentialValue(await resolveCredential?.(name))
      if (typeof value === 'string' && value.trim()) return true
    } catch {
      // A credentials provider can be unavailable during early Host startup.
    }
    return typeof env?.[name] === 'string' && env[name].trim().length > 0
  }
  const clientId = await present('DINGTALK_CLIENT_ID')
  const clientSecret = await present('DINGTALK_CLIENT_SECRET')
  return {
    clientIdPresent: clientId,
    clientSecretPresent: clientSecret,
    configured: clientId && clientSecret,
  }
}

export function normalizeStreamStatus(rawStatus, observedAt, now = Date.now()) {
  const observed = Number(observedAt)
  const age = Number.isFinite(observed) && observed > 0 ? now - observed : Infinity
  const fresh = age >= -5_000 && age <= STREAM_STALE_MS
  if (!fresh) return observed > 0 ? 'stale' : 'unobserved'
  if (rawStatus === 'connected') return 'connected'
  if (rawStatus === 'reconnecting') return 'reconnecting'
  return 'stale'
}

function ownerBound(owner) {
  return typeof owner?.ownerStaffId === 'string' && owner.ownerStaffId.trim().length > 0
}

function countBindings(bindings) {
  return canonicalSessionIds(bindings, Number.POSITIVE_INFINITY).length
}

function canonicalSessionId(value) {
  if (typeof value !== 'string') return ''
  const id = value.trim()
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/.test(id) ? id : ''
}

/** Read only binding values; never use or return the DingTalk conversation keys. */
export function canonicalSessionIds(bindings, max = MAX_SESSION_ROWS) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return []
  const ids = []
  const seen = new Set()
  for (const value of Object.values(bindings)) {
    const id = canonicalSessionId(value)
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= max) break
  }
  return ids
}

function safeText(value, max = 240) {
  if (typeof value !== 'string') return ''
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return clean.length > 0 && clean.length <= max ? clean : clean.slice(0, max)
}

function safeCreatedAt(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string' && value.trim().length <= 100 && Number.isFinite(Date.parse(value))) return value.trim()
  return null
}

function sessionCandidateFromAgent(agents, sessionId) {
  try {
    const agent = agents?.get?.(sessionId)
    if (!agent) return null
    const session = agent.session || {}
    const header = session.header || agent.header || {}
    return { agent, value: { ...header, ...session } }
  } catch {
    return null
  }
}

async function lookupSession(sessionId, options) {
  const { sessionQuery, readTitleSnapshot, sessionPersistence, agents } = options
  const call = async (candidate, receiver = undefined) => {
    try {
      if (typeof candidate === 'function') return await candidate.call(receiver, sessionId)
      if (candidate?.get) return await candidate.get.call(candidate, sessionId)
      if (candidate?.query) return await candidate.query.call(candidate, sessionId)
      if (candidate?.inspect) return await candidate.inspect.call(candidate, sessionId)
    } catch {
      return null
    }
    return null
  }
  let value = null
  // Current Host exposes the settled-array batch contract.  Keep the input
  // single-id and accept only the fulfilled result for that canonical id;
  // never project a channel key or a rejected reason into the card.
  if (typeof sessionQuery?.readTitleSnapshots === 'function') {
    try {
      const results = await sessionQuery.readTitleSnapshots.call(sessionQuery, [sessionId])
      const item = Array.isArray(results)
        ? results.find((candidate) => candidate?.status === 'fulfilled' && canonicalSessionId(candidate.sessionId) === sessionId)
        : null
      value = item?.value || null
    } catch {
      value = null
    }
  }
  if (!value) value = await call(sessionQuery)
  if (!value && typeof sessionQuery?.readTitleSnapshot === 'function') value = await call(sessionQuery.readTitleSnapshot, sessionQuery)
  if (!value) value = await call(readTitleSnapshot)
  if (!value && sessionPersistence?.inspect) {
    value = await call(sessionPersistence.inspect, sessionPersistence)
  }
  if (!value && sessionPersistence?.list) {
    try {
      const list = await sessionPersistence.list()
      value = Array.isArray(list) ? list.find((item) => canonicalSessionId(item?.id || item?.sessionId) === sessionId) : null
    } catch { value = null }
  }
  const agentRecord = sessionCandidateFromAgent(agents, sessionId)
  return { value: value || agentRecord?.value || null, agent: agentRecord?.agent || null }
}

function projectSession(sessionId, value, agent) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const meta = value.meta && typeof value.meta === 'object' ? value.meta : value.session && typeof value.session === 'object' ? value.session : value
  const titleValue = value.title && typeof value.title === 'object' ? value.title.title : value.title
  const title = safeText(titleValue || meta.title || meta.displayTitle || meta.label) || '钉钉会话'
  const createdAt = safeCreatedAt(meta.createdAt || meta.created_at || meta.startedAt)
  const running = agent?.status === 'running'
  return { sessionId, title, createdAt, running }
}

/** Project at most five bound sessions without retaining channel identifiers. */
export async function projectBoundSessions(bindings, options = {}) {
  const ids = canonicalSessionIds(bindings, options.max ?? MAX_SESSION_ROWS)
  const sessions = []
  for (const sessionId of ids) {
    const record = await lookupSession(sessionId, options)
    const projected = projectSession(sessionId, record.value, record.agent)
    if (projected) sessions.push(projected)
  }
  return sessions
}

function aiCardStatus(capabilities) {
  const card = capabilities?.aiCard
  if (!card || typeof card !== 'object' || typeof card.available !== 'boolean') {
    return { known: false, available: null, observedAt: null }
  }
  const observedAt = Number(card.observedAt)
  return {
    known: true,
    available: card.available,
    observedAt: Number.isFinite(observedAt) && observedAt > 0 ? observedAt : null,
  }
}

export async function dingtalkStatus({
  home = homedir(),
  stateDir,
  readFileImpl = readFile,
  resolveCredential,
  env = process.env,
  now = Date.now(),
  sessionQuery,
  readTitleSnapshot,
  sessionPersistence,
  agents,
} = {}) {
  const paths = statePaths({ home, stateDir })
  const [pkg, runtime, owner, capabilities, bindings, credentials] = await Promise.all([
    readPackageStatus(paths.package, readFileImpl),
    readJson(paths.runtime, readFileImpl),
    readJson(paths.owner, readFileImpl),
    readJson(paths.capabilities, readFileImpl),
    readJson(paths.bindings, readFileImpl),
    credentialPresence({ resolveCredential, env }),
  ])
  const observedAt = Number(runtime?.stream?.observedAt)
  const streamStatus = normalizeStreamStatus(runtime?.stream?.status, observedAt, now)
  const streamObservedAt = Number.isFinite(observedAt) && observedAt > 0 ? observedAt : null
  const card = aiCardStatus(capabilities)
  const sessions = await projectBoundSessions(bindings, { sessionQuery, readTitleSnapshot, sessionPersistence, agents })
  return {
    ok: true,
    source: 'dingtalk-status.v1',
    workspace: DEFAULT_WORKSPACE,
    package: pkg,
    credentials,
    ownerBound: ownerBound(owner),
    stream: { status: streamStatus, observedAt: streamObservedAt },
    aiCard: card,
    boundSessionCount: countBindings(bindings),
    sessions,
    setupCommand: SETUP_COMMAND,
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

export function captureProjectionServices(ctx) {
  return {
    credentials: ctx.credentials,
    sessionQuery: ctx.sessionQuery,
    sessionPersistence: ctx.sessionPersistence,
    agents: ctx.agents,
  }
}

export function apply(ctx) {
  // Capture injected services during apply.  Cordis narrows the context after
  // plugin setup; deferred HTTP handlers must not re-resolve them from the
  // later narrowed context or the live projection silently degrades to empty.
  const { credentials, sessionQuery, sessionPersistence, agents } = captureProjectionServices(ctx)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-dingtalk/status',
    handler: async (req, res) => {
      if (req.method && req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: '只允许 GET' })
        return
      }
      try {
        sendJson(res, 200, await dingtalkStatus({
          resolveCredential: (name) => credentials?.resolve?.(name),
          sessionQuery,
          sessionPersistence,
          agents,
        }))
      } catch {
        // Status is advisory.  A malformed/missing local state must not make
        // the Host fail or expose an exception body to the client.
        sendJson(res, 200, await dingtalkStatus())
      }
    },
  }), 'dsh-dingtalk-status: read-only status api')
}
