import assert from 'node:assert/strict'
import test from 'node:test'

import { HEARTBEAT_CHECKPOINT, HEARTBEAT_STATE, heartbeatRuntimeStatus } from './index.js'

test('heartbeat runtime bridge projects the fixed checkpoint and current canonical run', async () => {
  const checkpoint = {
    batch_id: 'heartbeat-20260826', heartbeat_task_id: 'hb-gzh', created_at: '2026-08-26T06:00:00Z', updated_at: '2026-08-26T06:01:00Z',
    login_preflight: 'passed', publish_status: 'pending', multi_verify_status: 'pending', merge_completed: false,
    topics: [{}, {}, {}], runs: [{ out: '01_news_ai', kind: 'news', run_id: 'manual:shrimp-main:run-1', status: 'queued' }],
  }
  const state = { tasks: [{ id: 'hb-gzh', name: '虾六答', runner: 'gzh-multi-article', pipelineSlug: 'shrimp-main' }] }
  const readFileImpl = async (path) => JSON.stringify(path === HEARTBEAT_CHECKPOINT ? checkpoint : path === HEARTBEAT_STATE ? state : {})
  const execFileImpl = (_command, _args, _options, callback) => callback(null, '49194\n', '')
  const result = await heartbeatRuntimeStatus({ readFileImpl, execFileImpl })
  assert.equal(result.exists, true)
  assert.equal(result.processRunning, true)
  assert.equal(result.status, 'running')
  assert.equal(result.currentRunId, 'manual:shrimp-main:run-1')
  assert.equal(result.pipelineSlug, 'shrimp-main')
  assert.equal(result.stage, 'run:01_news_ai')
})

test('missing checkpoint stays empty and never invents a run', async () => {
  const result = await heartbeatRuntimeStatus({ readFileImpl: async () => { throw new Error('missing') } })
  assert.deepEqual(result, { ok: true, exists: false, source: 'heartbeat-checkpoint.v1' })
})
