import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HEARTBEAT_TIMEZONE,
  clearHeartbeatRunnerFailure,
  executeHeartbeatRunner,
  heartbeatFailureFingerprint,
  heartbeatRunnerErrorDetail,
  heartbeatRunnerPayloadEnv,
  heartbeatRunnerSpec,
  heartbeatTaskIsOneShot,
  MAX_SCHEDULE_SCAN_SESSIONS,
  nextHeartbeatCronAt,
  normalizeHeartbeatCron,
  planHeartbeatTask,
  recordHeartbeatRunnerFailure,
  SCHEDULE_SCAN_BATCH_SIZE,
  SCHEDULE_SCAN_CACHE_TTL_MS,
  scheduleScanCacheIsFresh,
} from './index.js'

const CRON = { time: '06:00', days: [1, 3, 5, 0], timezone: HEARTBEAT_TIMEZONE }
const at = (value) => Date.parse(value)

test('Asia/Shanghai cron computes the next Monday/Wednesday/Friday/Sunday 06:00', () => {
  assert.deepEqual(normalizeHeartbeatCron({ time: '06:00', days: [1, 3, 5, 0] }), CRON)
  assert.equal(
    new Date(nextHeartbeatCronAt(at('2026-08-24T01:21:48+08:00'), CRON)).toISOString(),
    '2026-08-23T22:00:00.000Z',
  )
  assert.equal(
    new Date(nextHeartbeatCronAt(at('2026-08-24T06:01:00+08:00'), CRON)).toISOString(),
    '2026-08-25T22:00:00.000Z',
  )
})

test('cron scheduling does not drift by seven-day intervals and marks a stale window missed', () => {
  const scheduledAt = at('2026-08-24T06:00:00+08:00')
  const normal = planHeartbeatTask(
    { cron: CRON, nextRunAt: scheduledAt },
    at('2026-08-24T06:01:00+08:00'),
  )
  assert.equal(normal.action, 'run')
  assert.equal(new Date(normal.nextRunAt).toISOString(), '2026-08-25T22:00:00.000Z')

  const missed = planHeartbeatTask(
    { cron: CRON, nextRunAt: scheduledAt },
    at('2026-08-24T09:00:00+08:00'),
  )
  assert.equal(missed.action, 'miss')
  assert.equal(new Date(missed.nextRunAt).toISOString(), '2026-08-25T22:00:00.000Z')
  assert.ok(missed.missedByMs > 2 * 60 * 1000)
})

test('missing nextRunAt is initialized without firing immediately', () => {
  const plan = planHeartbeatTask({ cron: CRON }, at('2026-08-24T01:00:00+08:00'))
  assert.equal(plan.action, 'schedule')
  assert.equal(new Date(plan.nextRunAt).toISOString(), '2026-08-23T22:00:00.000Z')
})

test('runner is an immutable allowlist and cannot accept an arbitrary command', async () => {
  const spec = heartbeatRunnerSpec('gzh-multi-article')
  assert.equal(spec.command, '/Library/Frameworks/Python.framework/Versions/3.11/bin/python3')
  assert.deepEqual(spec.args, ['/Users/marcus/Desktop/虾缸/scripts/heartbeat_gzh_publish.py'])
  assert.equal(spec.cwd, '/Users/marcus/Desktop/虾缸')
  assert.equal(heartbeatRunnerSpec('rm -rf /'), null)

  const calls = []
  const fakeExecFile = (command, args, options, callback) => {
    calls.push({ command, args, options })
    callback(null, '{"publish_summary":"三篇多图文草稿已保存"}\n', '')
  }
  const result = await executeHeartbeatRunner({ runner: 'gzh-multi-article' }, { execFileImpl: fakeExecFile })
  assert.equal(result.runner, 'gzh-multi-article')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, spec.args)
  assert.equal(calls[0].options.cwd, spec.cwd)
  assert.equal(calls[0].options.shell, undefined)
  assert.equal(calls[0].options.env.DSH_HEARTBEAT_PAYLOAD_JSON, '{}')
})

test('git daily commit runner uses the fixed local Node script and ignores payload command/path', async () => {
  const spec = heartbeatRunnerSpec('git-daily-commit')
  assert.deepEqual(spec, {
    runner: 'git-daily-commit',
    command: '/usr/local/bin/node',
    args: ['/Users/marcus/.dsh/scripts/daily-git-commit.mjs'],
    cwd: '/Users/marcus/.dsh',
    timeoutMs: 5 * 60 * 1000,
  })
  const calls = []
  const fakeExecFile = (command, args, options, callback) => {
    calls.push({ command, args, options })
    callback(null, '{"status":"skipped","reason":"无改动"}\n', '')
  }
  const result = await executeHeartbeatRunner({
    runner: 'git-daily-commit',
    payload: { command: 'rm -rf /', path: '/tmp/evil', args: ['--push'] },
  }, { execFileImpl: fakeExecFile })
  assert.equal(result.runner, 'git-daily-commit')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, '/usr/local/bin/node')
  assert.deepEqual(calls[0].args, ['/Users/marcus/.dsh/scripts/daily-git-commit.mjs'])
  assert.equal(calls[0].options.cwd, '/Users/marcus/.dsh')
  assert.equal(calls[0].options.timeout, 5 * 60 * 1000)
  assert.deepEqual(JSON.parse(calls[0].options.env.DSH_HEARTBEAT_PAYLOAD_JSON), { command: 'rm -rf /', path: '/tmp/evil', args: ['--push'] })
})

test('runner passes only bounded JSON payload and supports one-shot tasks', async () => {
  const payload = {
    one_shot: true,
    batch_id: 'temporary-test',
    topics: [{ topic: 'one' }, { topic: 'two' }, { topic: 'three' }],
  }
  assert.equal(heartbeatTaskIsOneShot({ payload }), true)
  assert.equal(heartbeatTaskIsOneShot({ payload: { one_shot: false } }), false)
  assert.deepEqual(JSON.parse(heartbeatRunnerPayloadEnv(payload)), payload)
  assert.throws(() => heartbeatRunnerPayloadEnv({ value: 'x'.repeat(70 * 1024) }), /64KB/)

  const calls = []
  const fakeExecFile = (command, args, options, callback) => {
    calls.push({ command, args, options })
    callback(null, '{}', '')
  }
  await executeHeartbeatRunner({ runner: 'gzh-multi-article', payload }, { execFileImpl: fakeExecFile })
  assert.deepEqual(JSON.parse(calls[0].options.env.DSH_HEARTBEAT_PAYLOAD_JSON), payload)
  assert.deepEqual(calls[0].args, ['/Users/marcus/Desktop/虾缸/scripts/heartbeat_gzh_publish.py'])
})

test('runner failure surfaces structured stdout before generic command error', async () => {
  const error = new Error('Command failed')
  error.stdout = '{"status":"failed","error":"WORKFLOW_INVALID"}'
  error.stderr = ''
  assert.match(heartbeatRunnerErrorDetail(error), /WORKFLOW_INVALID/)
  assert.doesNotMatch(heartbeatRunnerErrorDetail(error), /^Command failed$/)
})

test('runner failure fingerprint excludes dynamic timestamps and auto-pauses after two identical failures', () => {
  const first = heartbeatFailureFingerprint({ stderr: 'network timeout at 2026-08-25T01:02:03.000Z' })
  const second = heartbeatFailureFingerprint({ stderr: 'network timeout at 2026-08-26T09:08:07.000Z' })
  assert.equal(first, second)
  assert.notEqual(first, heartbeatFailureFingerprint({ stderr: 'permission denied' }))

  const task = { id: 'git-daily', runner: 'git-daily-commit', enabled: true, nextRunAt: 123 }
  const one = recordHeartbeatRunnerFailure(task, { stderr: 'network timeout at 2026-08-25T01:02:03.000Z' })
  assert.equal(one.count, 1)
  assert.equal(one.autoPaused, false)
  assert.equal(one.task.enabled, true)
  const two = recordHeartbeatRunnerFailure(one.task, { stderr: 'network timeout at 2026-08-26T09:08:07.000Z' })
  assert.equal(two.count, 2)
  assert.equal(two.autoPaused, true)
  assert.equal(two.task.enabled, false)
  assert.equal(two.task.nextRunAt, null)
  assert.equal(two.task.autoPaused, true)
  assert.equal(two.task.failure_fingerprint, two.fingerprint)

  const reset = clearHeartbeatRunnerFailure(two.task)
  assert.equal(reset.failure_fingerprint, null)
  assert.equal(reset.failure_count, 0)
  assert.equal(reset.autoPaused, false)
})

test('shrimp git history uses async runner and heartbeat persistence is atomic', async () => {
  const fsPromises = await import('node:fs/promises')
  assert.ok(fsPromises.rename)
  const implementation = (await import('node:fs')).readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(implementation, /execFileSync\(/)
  assert.match(implementation, /async function gitHistory\(dir\)/)
  assert.match(implementation, /\.\.\.\(await gitHistory\(w\.path\)\)/)
  assert.match(implementation, /await rename\(temporary, HEARTBEATS_FILE\)/)
})

test('heartbeat read-modify-write operations share one Host transaction queue', async () => {
  const implementation = (await import('node:fs')).readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  assert.match(implementation, /let heartbeatMutationTail = Promise\.resolve\(\)/)
  assert.match(implementation, /function withHeartbeatMutation\(mutator\)/)
  assert.match(implementation, /heartbeatMutationTail = operation\.catch\(\(\) => \{\}\)/)
  assert.match(implementation, /await withHeartbeatMutation\(async \(data\) => \{/)
  assert.match(implementation, /await withHeartbeatMutation\(async \(latest\) => \{/)
})

test('corrupt heartbeat state fails closed and execution locks follow durable persistence', async () => {
  const implementation = (await import('node:fs')).readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  assert.match(implementation, /error && error\.code === 'ENOENT'[\s\S]*心跳状态文件不可读或已损坏/)
  assert.doesNotMatch(implementation, /async function readHeartbeats\(\) \{\s*try \{[^}]+\} catch \{ return \{ tasks: \[\], history: \{\} \} \}/)
  const mutationReturn = implementation.indexOf('return { value: due, write: changed }')
  const durableLock = implementation.indexOf('for (const item of due) shrimpHeartbeatLocks.add(item.id)')
  assert.ok(mutationReturn >= 0 && durableLock > mutationReturn, 'execution locks must be acquired only after the mutation transaction returns')
  assert.equal(implementation.slice(mutationReturn - 1500, mutationReturn).includes('shrimpHeartbeatLocks.add(task.id)'), false)
})

test('Git backup fails closed on locks and propagates commit failure', async () => {
  const implementation = (await import('node:fs')).readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  assert.match(implementation, /GIT_BACKUP_LOCK_NAMES = Object\.freeze\(\['index\.lock', 'dsh-daily-commit\.lock'\]\)/)
  assert.match(implementation, /if \(!initialLock\.ok\) return \{ ok: false/)
  assert.match(implementation, /await runGit\(\['commit', '-m', `dsh backup \$\{tag\}`\]/)
  assert.doesNotMatch(implementation, /catch \{ \/\* 无改动时 commit 无输出,忽略 \*\/ \}/)
})

test('heartbeat list never awaits a schedule scan and refreshes only in the background', async () => {
  assert.ok(SCHEDULE_SCAN_CACHE_TTL_MS >= 5 * 60 * 1000)
  assert.ok(MAX_SCHEDULE_SCAN_SESSIONS <= 8)
  assert.equal(SCHEDULE_SCAN_BATCH_SIZE, 1)
  assert.equal(scheduleScanCacheIsFresh({ at: 1_000, tasks: [], ready: true }, 1_000 + SCHEDULE_SCAN_CACHE_TTL_MS - 1), true)
  assert.equal(scheduleScanCacheIsFresh({ at: 1_000, tasks: [], ready: true }, 1_000 + SCHEDULE_SCAN_CACHE_TTL_MS), false)

  const implementation = (await import('node:fs')).readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  const listStart = implementation.indexOf("path: '/api/shrimp/heartbeat/list'")
  const listEnd = implementation.indexOf("}), 'shrimp-shell: heartbeat list')", listStart)
  assert.ok(listStart >= 0 && listEnd > listStart)
  const listHandler = implementation.slice(listStart, listEnd)
  assert.match(listHandler, /ensureScheduleScan\(\{ force: true \}\)\.catch\(\(\) => \{\}\)/)
  assert.doesNotMatch(listHandler, /await\s+ensureScheduleScan/)
  assert.match(implementation, /const yieldToHost = \(\) => new Promise\(\(resolve\) => setImmediate\(resolve\)\)/)
  assert.match(implementation, /await yieldToHost\(\)\n        for \(const session of batch\)/)
})
