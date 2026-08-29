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
export const inject = ['webServer', 'credentials']

export const DINGTALK_VERSION = '0.6.2'
export const DEFAULT_WORKSPACE = '/Users/marcus/Desktop'
export const SETUP_COMMAND = `npx @dingtalk-real-ai/dsh-dingtalk@${DINGTALK_VERSION} setup`
export const STREAM_STALE_MS = 30_000
export const MAX_JSON_BYTES = 256 * 1024

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
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return 0
  return Object.values(bindings).filter((value) => typeof value === 'string' && value.trim()).length
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
    setupCommand: SETUP_COMMAND,
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-dingtalk/status',
    handler: async (req, res) => {
      if (req.method && req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: '只允许 GET' })
        return
      }
      try {
        const credentials = ctx.credentials
        sendJson(res, 200, await dingtalkStatus({
          resolveCredential: (name) => credentials?.resolve?.(name),
        }))
      } catch {
        // Status is advisory.  A malformed/missing local state must not make
        // the Host fail or expose an exception body to the client.
        sendJson(res, 200, await dingtalkStatus())
      }
    },
  }), 'dsh-dingtalk-status: read-only status api')
}
