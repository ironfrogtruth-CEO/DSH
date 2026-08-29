import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_WORKSPACE,
  DINGTALK_VERSION,
  SETUP_COMMAND,
  inject,
  dingtalkStatus,
  canonicalSessionIds,
  captureProjectionServices,
  credentialPresence,
  normalizeStreamStatus,
  projectBoundSessions,
  statePaths,
} from './index.js'

test('runtime declares the canonical Host services used by its live projection', () => {
  assert.deepEqual(inject, ['webServer', 'credentials', 'sessionQuery', 'sessionPersistence', 'agents'])
})

test('deferred status handlers retain the services captured during plugin apply', () => {
  const expected = {
    credentials: { resolve() {} },
    sessionQuery: { readTitleSnapshots() {} },
    sessionPersistence: { inspect() {} },
    agents: { get() {} },
  }
  let available = true
  const ctx = Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, undefined]))
  for (const [key, value] of Object.entries(expected)) {
    Object.defineProperty(ctx, key, { configurable: true, get: () => {
      if (!available) throw new Error(`late access to ${key}`)
      return value
    } })
  }
  const captured = captureProjectionServices(ctx)
  available = false
  assert.equal(captured.credentials, expected.credentials)
  assert.equal(captured.sessionQuery, expected.sessionQuery)
  assert.equal(captured.sessionPersistence, expected.sessionPersistence)
  assert.equal(captured.agents, expected.agents)
})

function fixtureFiles({ packageValue, runtimeValue, ownerValue, capabilitiesValue, bindingsValue }) {
  const paths = statePaths({ home: '/tmp/dsh-status-home', stateDir: '/tmp/dsh-status-state' })
  const values = new Map([
    [paths.package, packageValue],
    [paths.runtime, runtimeValue],
    [paths.owner, ownerValue],
    [paths.capabilities, capabilitiesValue],
    [paths.bindings, bindingsValue],
  ])
  return {
    readFileImpl: async (path) => {
      if (!values.has(path)) throw new Error('missing')
      return JSON.stringify(values.get(path))
    },
  }
}

test('status returns only the safe contract and never echoes connector secrets or identifiers', async () => {
  const result = await dingtalkStatus({
    home: '/tmp/dsh-status-home',
    stateDir: '/tmp/dsh-status-state',
    now: 100_000,
    env: { DINGTALK_CLIENT_ID: 'client-secret-value', DINGTALK_CLIENT_SECRET: 'secret-value' },
    ...fixtureFiles({
      packageValue: { name: '@dingtalk-real-ai/dsh-dingtalk', version: DINGTALK_VERSION },
      runtimeValue: { stream: { status: 'connected', observedAt: 99_000 }, secret: 'do-not-return' },
      ownerValue: { ownerStaffId: 'staff-123', challenge: { code: 'BIND-ME' } },
      capabilitiesValue: { aiCard: { available: true, observedAt: 98_000 }, raw: { sessionWebhook: 'https://secret' } },
      bindingsValue: { 'conversation-1': 'session-1', 'conversation-2': 'session-2' },
    }),
    sessionQuery: {
      readTitleSnapshot: async (sessionId) => ({
        session: { id: sessionId, createdAt: 97_000, cwd: '/Users/marcus/Desktop' },
        title: { title: `标题 ${sessionId}`, messageSeqs: [1], source: { kind: 'fallback' } },
        conversationId: 'must-not-return',
      }),
    },
    agents: { get: (sessionId) => sessionId === 'session-1' ? { status: 'running' } : undefined },
  })
  assert.deepEqual(result.package, { installed: true, version: DINGTALK_VERSION, supported: true })
  assert.deepEqual(result.credentials, { clientIdPresent: true, clientSecretPresent: true, configured: true })
  assert.equal(result.ownerBound, true)
  assert.deepEqual(result.stream, { status: 'connected', observedAt: 99_000 })
  assert.deepEqual(result.aiCard, { known: true, available: true, observedAt: 98_000 })
  assert.equal(result.boundSessionCount, 2)
  assert.deepEqual(result.sessions, [
    { sessionId: 'session-1', title: '标题 session-1', createdAt: 97_000, running: true },
    { sessionId: 'session-2', title: '标题 session-2', createdAt: 97_000, running: false },
  ])
  assert.equal(result.setupCommand, SETUP_COMMAND)
  assert.equal(JSON.stringify(result).includes('staff-123'), false)
  assert.equal(JSON.stringify(result).includes('BIND-ME'), false)
  assert.equal(JSON.stringify(result).includes('conversation-1'), false)
  assert.equal(JSON.stringify(result).includes('sessionWebhook'), false)
  assert.equal(JSON.stringify(result).includes('conversationId'), false)
  assert.equal(JSON.stringify(result).includes('must-not-return'), false)
  assert.equal(result.workspace, DEFAULT_WORKSPACE)
})

test('missing, malformed, oversized and stale local state fail closed without breaking status', async () => {
  const paths = statePaths({ home: '/tmp/dsh-status-home', stateDir: '/tmp/dsh-status-state' })
  const result = await dingtalkStatus({
    home: '/tmp/dsh-status-home',
    stateDir: '/tmp/dsh-status-state',
    now: 100_000,
    env: {},
    readFileImpl: async (path) => {
      if (path === paths.package) return '{broken'
      if (path === paths.runtime) return JSON.stringify({ stream: { status: 'connected', observedAt: 1 } })
      if (path === paths.owner) return '[]'
      if (path === paths.capabilities) return 'x'.repeat(300_000)
      if (path === paths.bindings) return JSON.stringify({ bad: { raw: true } })
      throw new Error('missing')
    },
  })
  assert.equal(result.package.installed, false)
  assert.equal(result.credentials.configured, false)
  assert.equal(result.ownerBound, false)
  assert.equal(result.stream.status, 'stale')
  assert.deepEqual(result.aiCard, { known: false, available: null, observedAt: null })
  assert.equal(result.boundSessionCount, 0)
  assert.deepEqual(result.sessions, [])
})

test('binding projection reads only canonical session values, caps at five, and omits corrupt metadata', async () => {
  const bindings = {
    'conversation-secret': 'session-a',
    other: 'session-b',
    duplicate: 'session-a',
    malformed: 'https://webhook',
    whitespace: 'bad value',
    c: 'session-c',
    d: 'session-d',
    e: 'session-e',
    f: 'session-f',
  }
  assert.deepEqual(canonicalSessionIds(bindings), ['session-a', 'session-b', 'session-c', 'session-d', 'session-e'])
  const sessions = await projectBoundSessions(bindings, {
    sessionQuery: {
      readTitleSnapshot: async (id) => id === 'session-b' ? null : ({
        session: { id, createdAt: '2026-08-29T00:00:00Z' },
        title: { title: id },
        staffId: 'private',
      }),
    },
  })
  assert.deepEqual(sessions, [
    { sessionId: 'session-a', title: 'session-a', createdAt: '2026-08-29T00:00:00Z', running: false },
    { sessionId: 'session-c', title: 'session-c', createdAt: '2026-08-29T00:00:00Z', running: false },
    { sessionId: 'session-d', title: 'session-d', createdAt: '2026-08-29T00:00:00Z', running: false },
    { sessionId: 'session-e', title: 'session-e', createdAt: '2026-08-29T00:00:00Z', running: false },
  ])
  assert.equal(JSON.stringify(sessions).includes('conversation-secret'), false)
  assert.equal(JSON.stringify(sessions).includes('staffId'), false)
})

test('persistence inspection uses only meta and does not report an idle agent as running', async () => {
  const sessions = await projectBoundSessions({ one: 'session-one', two: 'session-two' }, {
    sessionPersistence: {
      inspect: async (id) => ({ meta: { id, title: `meta ${id}`, createdAt: 123 }, events: [{ secret: 'never-return' }] }),
    },
    agents: { get: (id) => ({ id, status: id === 'session-one' ? 'running' : 'idle' }) },
  })
  assert.deepEqual(sessions, [
    { sessionId: 'session-one', title: 'meta session-one', createdAt: 123, running: true },
    { sessionId: 'session-two', title: 'meta session-two', createdAt: 123, running: false },
  ])
  assert.equal(JSON.stringify(sessions).includes('secret'), false)
})

test('current Host readTitleSnapshots settled-array contract projects only fulfilled canonical ids', async () => {
  const calls = []
  const sessions = await projectBoundSessions({ 'channel-key-with-secret': 'session-batch' }, {
    sessionQuery: {
      async readTitleSnapshots(ids) {
        calls.push(ids)
        return [{
          sessionId: ids[0],
          status: 'fulfilled',
          value: {
            session: { id: ids[0], createdAt: 456 },
            title: { title: '批量读取会话' },
            conversationKey: 'do-not-return',
          },
        }]
      },
    },
  })
  assert.deepEqual(calls, [['session-batch']])
  assert.deepEqual(sessions, [{ sessionId: 'session-batch', title: '批量读取会话', createdAt: 456, running: false }])
  assert.equal(JSON.stringify(sessions).includes('channel-key-with-secret'), false)
  assert.equal(JSON.stringify(sessions).includes('conversationKey'), false)

  const rejected = await projectBoundSessions({ channel: 'session-rejected' }, {
    sessionQuery: { readTitleSnapshots: async () => [{ sessionId: 'session-rejected', status: 'rejected', reason: { secret: 'hidden' } }] },
  })
  assert.deepEqual(rejected, [])
})

test('stream freshness exposes only connected, reconnecting, stale or unobserved', () => {
  assert.equal(normalizeStreamStatus('connected', 99_000, 100_000), 'connected')
  assert.equal(normalizeStreamStatus('connected', 60_001, 100_000), 'stale')
  assert.equal(normalizeStreamStatus('reconnecting', 99_500, 100_000), 'reconnecting')
  assert.equal(normalizeStreamStatus('connecting', 99_500, 100_000), 'stale')
  assert.equal(normalizeStreamStatus('connected', 0, 100_000), 'unobserved')
})

test('credentials are reduced to booleans and provider failures fail closed', async () => {
  const result = await credentialPresence({
    resolveCredential: async (name) => {
      if (name === 'DINGTALK_CLIENT_ID') return { value: 'id' }
      throw new Error('provider unavailable')
    },
    env: { DINGTALK_CLIENT_SECRET: '' },
  })
  assert.deepEqual(result, { clientIdPresent: true, clientSecretPresent: false, configured: false })
})
