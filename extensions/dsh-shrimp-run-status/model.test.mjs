import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dismissKey,
  domainOf,
  extractRunReference,
  heartbeatRunnerCommand,
  isTerminalStatus,
  latestShrimpRun,
  normalizeRunPayload,
  parseRunResult,
  visibleNodes,
} from './model.mjs'

test('parses run ids from API envelopes and resource refs', () => {
  assert.equal(extractRunReference({ schema: 'api_envelope.v1', data: { run_id: 'run-1' } }), 'run-1')
  assert.equal(extractRunReference({ resource_refs: [{ type: 'run', id: 'run-2' }] }), 'run-2')
  assert.equal(extractRunReference({ operation: { aggregate_id: 'run-3' } }), 'run-3')
})

test('real heartbeat bash launch becomes a durable article-run candidate, but grep/read commands do not', () => {
  const command = `cd /Users/marcus/Desktop/虾缸\nnohup /Library/Frameworks/Python.framework/Versions/3.11/bin/python3 scripts/heartbeat_gzh_publish.py > output/run.log 2>&1 &`
  assert.equal(heartbeatRunnerCommand({ command }), true)
  assert.equal(heartbeatRunnerCommand({ command: 'grep -n heartbeat_gzh_publish.py scripts/x' }), false)
  const candidate = latestShrimpRun({ runningCalls: [], nodes: [{ kind: 'tool-result', callId: 'bash-1', seq: 20, call: { name: 'bash', argsRaw: JSON.stringify({ command }) }, content: [{ type: 'text', text: 'PID=49194' }] }], pending: [] })
  assert.equal(candidate.sourceType, 'heartbeat')
  assert.equal(candidate.runner, 'gzh-multi-article')
  assert.equal(candidate.pipelineSlug, 'shrimp-c433b57dac59419d')
  assert.equal(candidate.pid, '49194')
  assert.equal(candidate.domain, 'article')
})

test('latest durable shrimp_run candidate uses call-only or paired result', () => {
  const callOnly = latestShrimpRun({ runningCalls: [{ callId: 'c1', name: 'shrimp_run', argsRaw: '{"pipelineSlug":"article-main"}', seq: 5 }], nodes: [], pending: [] })
  assert.equal(callOnly.pipelineSlug, 'article-main')
  assert.equal(callOnly.runId, undefined)
  const paired = latestShrimpRun({ runningCalls: [], nodes: [{ kind: 'tool-result', callId: 'c2', seq: 9, time: 20, call: { name: 'shrimp_run', argsRaw: '{"pipelineSlug":"xhs-main"}' }, content: [{ type: 'text', text: '{"data":{"runId":"run-9"}}' }] }], pending: [] })
  assert.equal(paired.runId, 'run-9')
  assert.equal(paired.pipelineSlug, 'xhs-main')
})

test('domain mapping and run summary normalize real node state/progress', () => {
  assert.equal(domainOf({ domain: 'article' }, ''), 'article')
  assert.equal(domainOf({ display_name: '小红书选题' }, ''), 'xiaohongshu')
  assert.equal(domainOf({ pipelineSlug: 'enterprise-health-report' }, ''), 'enterprise-health')
  const view = normalizeRunPayload({ summary: { status: 'running', progress_percent: 42, nodes: [{ node_id: 'a', name: '接收任务', status: 'completed' }, { node_id: 'b', name: '生成', status: 'processing', progress_percent: 40 }] } }, { status: 'running' })
  assert.equal(view.status, 'running')
  assert.equal(view.progress, 42)
  assert.deepEqual(view.nodes.map((node) => node.state), ['done', 'running'])
})

test('terminal states, node compaction and session/run dismiss key are stable', () => {
  assert.equal(isTerminalStatus('completed'), true)
  assert.equal(isTerminalStatus('blocked'), true)
  assert.equal(isTerminalStatus('running'), false)
  assert.equal(visibleNodes(Array.from({ length: 8 }, (_, index) => ({ id: String(index) }))).filter((item) => item.ellipsis).length, 1)
  assert.equal(dismissKey('session-1', 'run-1'), 'dsh-shrimp-run-status:dismissed:session-1:run-1')
})

test('result errors remain visible and do not invent a run id', () => {
  const result = parseRunResult({ isError: true, error: { code: 'RUN_FAILED', message: '虾缸拒绝运行' }, content: [{ type: 'text', text: '失败' }] })
  assert.equal(result.runId, '')
  assert.equal(result.isError, true)
  assert.match(result.errorSummary, /RUN_FAILED/)
})
