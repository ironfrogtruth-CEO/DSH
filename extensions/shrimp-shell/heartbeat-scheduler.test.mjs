import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HEARTBEAT_TIMEZONE,
  executeHeartbeatRunner,
  heartbeatRunnerErrorDetail,
  heartbeatRunnerSpec,
  nextHeartbeatCronAt,
  normalizeHeartbeatCron,
  planHeartbeatTask,
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
})

test('runner failure surfaces structured stdout before generic command error', async () => {
  const error = new Error('Command failed')
  error.stdout = '{"status":"failed","error":"WORKFLOW_INVALID"}'
  error.stderr = ''
  assert.match(heartbeatRunnerErrorDetail(error), /WORKFLOW_INVALID/)
  assert.doesNotMatch(heartbeatRunnerErrorDetail(error), /^Command failed$/)
})
