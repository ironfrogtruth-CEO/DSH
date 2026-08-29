import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_WORKSPACE,
  DINGTALK_VERSION,
  SETUP_COMMAND,
  dingtalkStatus,
  credentialPresence,
  normalizeStreamStatus,
  statePaths,
} from './index.js'

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
  })
  assert.deepEqual(result.package, { installed: true, version: DINGTALK_VERSION, supported: true })
  assert.deepEqual(result.credentials, { clientIdPresent: true, clientSecretPresent: true, configured: true })
  assert.equal(result.ownerBound, true)
  assert.deepEqual(result.stream, { status: 'connected', observedAt: 99_000 })
  assert.deepEqual(result.aiCard, { known: true, available: true, observedAt: 98_000 })
  assert.equal(result.boundSessionCount, 2)
  assert.equal(result.setupCommand, SETUP_COMMAND)
  assert.equal(JSON.stringify(result).includes('staff-123'), false)
  assert.equal(JSON.stringify(result).includes('BIND-ME'), false)
  assert.equal(JSON.stringify(result).includes('conversation-1'), false)
  assert.equal(JSON.stringify(result).includes('sessionWebhook'), false)
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
