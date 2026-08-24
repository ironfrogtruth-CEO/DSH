import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const clientSource = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

function loadStatusHelpers() {
  const start = clientSource.indexOf('      const normalizeShrimpRef =')
  const end = clientSource.indexOf('      const normalizeShrimp =', start)
  assert.ok(start >= 0 && end > start, 'status helper block must stay in client.js')
  const context = {}
  vm.runInNewContext(`${clientSource.slice(start, end)}\nglobalThis.__status = { latestRunForShrimp, runBelongsToShrimp }`, context)
  return context.__status
}

function loadNormalizeShrimp() {
  const start = clientSource.indexOf('      const normalizeShrimp =')
  const end = clientSource.indexOf('      const normalizeShrimps =', start)
  assert.ok(start >= 0 && end > start, 'normalizeShrimp must stay in client.js')
  const context = {
    signalWasSeen: () => false,
    artifactWasSeen: () => false,
    shrimpSignalStamp: (row, kind, run) => `${kind}:${run?.updated_at || row?.updated_at || 'fallback'}`,
    RUNNING_SIGNAL_STATUSES: new Set(['running']),
    ACTIVE_RUN_STATUSES: new Set(['running', 'queued', 'processing', 'trialing', 'awaiting_confirmation', 'awaiting_external', 'waiting_external', 'cancel_requested']),
    BLOCKED_RUN_STATUSES: new Set(['blocked', 'failed', 'stopped', 'cancelled', 'blocked_ai_provider', 'blocked_external_dependency']),
  }
  vm.runInNewContext(`${clientSource.slice(start, end)}\nglobalThis.__normalizeShrimp = normalizeShrimp`, context)
  return context.__normalizeShrimp
}

test('每只虾只绑定自己的最新运行记录，缺失 ref 不得匹配', () => {
  const { latestRunForShrimp, runBelongsToShrimp } = loadStatusHelpers()
  const item = { ref: 'alpha' }
  const newest = { id: 'run-alpha-new', pipeline_slug: 'alpha', status: 'running', updated_at: '2026-08-24T10:00:00Z' }
  const older = { id: 'run-alpha-old', pipeline_slug: 'alpha', status: 'done', updated_at: '2026-08-24T09:00:00Z' }
  assert.equal(runBelongsToShrimp({ status: 'running' }, item), false)
  assert.equal(runBelongsToShrimp({ pipeline_slug: 'beta', status: 'running' }, item), false)
  assert.equal(latestRunForShrimp(item, [older, { status: 'running' }, newest]).id, 'run-alpha-new')
  assert.equal(latestRunForShrimp({ ref: '' }, [{ status: 'running' }]), null)
})

test('运行灯只由对应虾的真实运行状态点亮，其他虾保持自己的终态信号', () => {
  const normalizeShrimp = loadNormalizeShrimp()
  const running = normalizeShrimp(
    { ref: 'alpha', state: 'artifacts_ready', signals: { blocked: false, artifacts_ready: true } },
    { id: 'run-alpha', status: 'running', updated_at: '2026-08-24T10:00:00Z', artifacts_ready: false },
  )
  const completed = normalizeShrimp(
    { ref: 'beta', state: 'blocked', signals: { blocked: true, artifacts_ready: false } },
    { id: 'run-beta', status: 'done', updated_at: '2026-08-24T10:00:01Z', artifacts_ready: true, artifact_count: 1 },
  )
  assert.equal(running.signals.running, true)
  assert.equal(running.signals.blocked_unread, false)
  assert.equal(completed.signals.running, false)
  assert.equal(completed.signals.blocked_unread, false)
  assert.equal(completed.signals.unread_artifacts, true)
  const queued = normalizeShrimp(
    { ref: 'gamma', state: 'ready' },
    { id: 'run-gamma', status: 'queued', updated_at: '2026-08-24T10:00:02Z', artifacts_ready: false },
  )
  assert.equal(queued.signals.running, false)
})

test('完成后的最新终态覆盖旧阻断状态，不回跳过期红灯', () => {
  const normalizeShrimp = loadNormalizeShrimp()
  const normalized = normalizeShrimp(
    { ref: 'alpha', state: 'blocked', signals: { blocked: true } },
    { id: 'run-alpha-new', status: 'done', updated_at: '2026-08-24T10:01:00Z', artifacts_ready: true, artifact_count: 2 },
  )
  assert.equal(normalized.signals.running, false)
  assert.equal(normalized.signals.blocked, false)
  assert.equal(normalized.signals.blocked_unread, false)
  assert.equal(normalized.signals.unread_artifacts, true)
})

test('行内只有一盏灯且颜色语义固定：绿运行、红未读阻断、蓝未读产物、其余熄灭', () => {
  assert.match(clientSource, /const signalColor = running \? '#2c9a68' : blockedUnread \? '#d94b50' : outputUnread \? '#3d83e6' : 'transparent'/)
  assert.match(clientSource, /\[dot\(signalColor, signalOn, running\), h\('div'/)
  const badgeStart = clientSource.indexOf('const statusBadge =')
  const badgeEnd = clientSource.indexOf('\n      const apiError', badgeStart)
  assert.ok(badgeStart >= 0 && badgeEnd > badgeStart)
  assert.doesNotMatch(clientSource.slice(badgeStart, badgeEnd), /dot\(/)
})
