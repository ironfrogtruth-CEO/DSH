import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACTIVE_RUN_STATUSES,
  AUTO_DISCOVERY_INTERVAL_MS,
  FULL_SUMMARY_REFRESH_INTERVAL_MS,
  HIDDEN_AUTO_DISCOVERY_INTERVAL_MS,
  activeRunSignature,
  autoDiscoveryDelayMs,
  canonicalShrimpName,
  groupLatestActiveRuns,
  isActiveRunStatus,
  mergeRunSignatures,
  normalizeRunPayload,
  pipelineRefsOf,
  projectPublishedShrimps,
  refsMatch,
  runBelongsToShrimp,
  runSignatureEntries,
  shouldAutoOpen,
  shrimpTankDismissedStorageKey,
  visibleNodes,
} from './model.mjs'

test('active status policy is exact and terminal states are excluded', () => {
  for (const status of ['running', 'processing', 'queued', 'trialing', 'awaiting_confirmation', 'awaiting_external', 'waiting_external', 'cancel_requested']) assert.equal(isActiveRunStatus(status), true)
  for (const status of ['completed', 'succeeded', 'failed', 'blocked', 'cancelled', 'stopped', 'unknown']) assert.equal(isActiveRunStatus(status), false)
  assert.deepEqual([...ACTIVE_RUN_STATUSES], ['running', 'processing', 'queued', 'trialing', 'awaiting_confirmation', 'awaiting_external', 'waiting_external', 'cancel_requested'])
})

test('pipeline matching refuses empty refs', () => {
  assert.deepEqual(pipelineRefsOf({ ref: '  ' }), [])
  assert.equal(refsMatch({}, { ref: 'p1' }), false)
  assert.equal(refsMatch({ ref: 'p1' }, {}), false)
  assert.equal(refsMatch({ ref: 'p1' }, { pipeline_ref: 'p1' }), true)
  assert.equal(runBelongsToShrimp({ status: 'running' }, { ref: 'p1' }), false)
})

test('embedded and list runs are combined, grouped by pipeline, and newest active wins', () => {
  const items = [
    { ref: 'p1', display_name: 'UU爱学习@铁皮蛙', run: { id: 'embedded-old', status: 'queued', updated_at: '2026-08-26T01:00:00Z' } },
    { ref: 'p1', display_name: 'UU爱学习@铁皮蛙' },
    { ref: 'p2', name: '企业健康报告@平安' },
    { ref: '' },
  ]
  const runs = [
    { id: 'r-old', pipeline_ref: 'p1', status: 'running', updated_at: '2026-08-26T02:00:00Z' },
    { id: 'r-new', pipeline_ref: 'p1', status: 'processing', updated_at: '2026-08-26T03:00:00Z' },
    { id: 'r-done', pipeline_ref: 'p1', status: 'completed', updated_at: '2026-08-26T04:00:00Z' },
    { id: 'r-p2', pipeline_ref: 'p2', status: 'awaiting_external', updated_at: '2026-08-26T02:30:00Z' },
    { id: 'r-empty', status: 'running', updated_at: '2026-08-26T09:00:00Z' },
  ]
  const groups = groupLatestActiveRuns(items, runs)
  assert.deepEqual(groups.map((group) => group.ref), ['p1', 'p2'])
  assert.equal(groups.find((group) => group.ref === 'p1').run.id, 'r-new')
  assert.equal(groups.find((group) => group.ref === 'p2').run.id, 'r-p2')
  assert.equal(groups.find((group) => group.ref === 'p1').name, 'UU爱学习@铁皮蛙')
})

test('summary normalization keeps real nodes, progress, current node and failure/block messages', () => {
  const view = normalizeRunPayload({ summary: {
    status: 'processing',
    progress_percent: 42,
    current_node: { id: 'build' },
    failure_message: '运行失败说明',
    blocked_reason: '依赖未满足',
    nodes: [
      { node_id: 'prepare', node_name: '准备', status: 'completed' },
      { node_id: 'build', node_name: '生成', status: 'processing', progress_percent: 40, blocked_message: '等待外部确认' },
      { node_id: 'failed', node_name: '失败节点', status: 'failed' },
      { node_id: 'blocked', node_name: '阻断节点', status: 'blocked' },
    ],
  } }, { status: 'processing' })
  assert.equal(view.status, 'running')
  assert.equal(view.progress, 42)
  assert.equal(view.currentNode, '生成')
  assert.equal(view.currentNodeId, 'build')
  assert.equal(view.failure, '运行失败说明')
  assert.equal(view.blocked, '依赖未满足')
  assert.deepEqual(view.nodes.map((node) => node.state), ['done', 'running', 'failed', 'blocked'])
  assert.equal(view.nodes[1].blocked, '等待外部确认')
  assert.equal(view.nodes[2].state, 'failed')
  assert.equal(view.nodes[3].state, 'blocked')
})

test('summary facts override stale run-list status/progress while preserving summary nodes', () => {
  const view = normalizeRunPayload({ summary: { status: 'completed', progress_percent: 100, nodes: [{ node_id: 'done', node_name: '完成', status: 'completed' }] } }, { status: 'running', progress_percent: 20 })
  assert.equal(view.status, 'completed')
  assert.equal(view.progress, 100)
  assert.deepEqual(view.nodes.map((node) => node.id), ['done'])
})

test('nested run-list status envelopes remain readable under summary precedence', () => {
  const view = normalizeRunPayload({ summary: { status: 'completed', progress_percent: 100 } }, { status: { status: 'running', progress_percent: 20 } })
  assert.equal(view.status, 'completed')
  assert.equal(view.progress, 100)
})

test('published shrimp projection is API-backed, ordered, deduplicated and excludes drafts/catch drafts', () => {
  const items = [
    { identity: 'pipeline', ref: 'uu', display_name: 'UU爱学习@铁皮蛙', lifecycle_status: 'published' },
    { identity: 'pipeline', ref: 'ai', title: 'AI老师@小红书', lifecycle_status: 'published' },
    { identity: 'pipeline', ref: 'article', name: '文章@虾六答', status: 'ready' },
    { identity: 'pipeline', ref: 'health', display_name: '企业健康报告@平安', lifecycle_status: 'published' },
    { identity: 'pipeline', ref: 'draft', display_name: '草稿虾', lifecycle_status: 'draft' },
    { identity: 'catch_draft', ref: 'catch-1', display_name: '不应出现', lifecycle_status: 'published' },
    { identity: 'pipeline', ref: 'ai', title: 'AI老师旧版', lifecycle_status: 'trialing' },
  ]
  assert.deepEqual(projectPublishedShrimps(items).map((item) => item.display_name || item.title || item.name), ['UU爱学习@铁皮蛙', 'AI老师@小红书', '文章@虾六答', '企业健康报告@平安'])
  assert.equal(canonicalShrimpName({ pipeline_ref: 'pipixia-main' }), 'pipixia-main')
  assert.equal(canonicalShrimpName({ display_name: '未知真实虾', pipeline_ref: 'pipixia-main' }), '未知真实虾')
})

test('visibleNodes keeps first/current neighbors/last for long tracks', () => {
  const nodes = Array.from({ length: 10 }, (_, index) => ({ id: String(index), name: `节点${index}`, status: index === 5 ? 'running' : 'pending' }))
  const output = visibleNodes(nodes, 6, { currentNodeId: '5' })
  assert.ok(output.filter((item) => item.ellipsis).length >= 1)
  assert.equal(output.filter((item) => item.node).length, 6)
  const visibleIds = output.filter((item) => item.node).map((item) => item.node.id)
  assert.ok(visibleIds.includes('0'))
  assert.ok(visibleIds.includes('4'))
  assert.ok(visibleIds.includes('5'))
  assert.ok(visibleIds.includes('6'))
  assert.ok(visibleIds.includes('9'))
  assert.equal(visibleNodes([]).length, 0)
})

test('active run signature is stable, canonical, sorted, and name-independent', () => {
  const groups = [
    { ref: 'health', name: '旧名称', run: { id: 'run-2', pipeline_ref: 'health' } },
    { ref: 'article', name: '文章', run: { run_id: 'run-1', pipeline_ref: 'article' } },
  ]
  assert.equal(activeRunSignature(groups), 'article:run-1|health:run-2')
  assert.equal(activeRunSignature([...groups].reverse()), activeRunSignature(groups))
  assert.equal(activeRunSignature([{ ref: 'health', name: '改名', run: { id: 'run-2', pipeline_ref: 'health' } }]), 'health:run-2')
  assert.equal(activeRunSignature([{ run: { id: 'missing-pipeline' } }]), '')
})

test('closed-card discovery cadence and session dismissal key are explicit', () => {
  assert.equal(autoDiscoveryDelayMs(false), AUTO_DISCOVERY_INTERVAL_MS)
  assert.equal(autoDiscoveryDelayMs(true), HIDDEN_AUTO_DISCOVERY_INTERVAL_MS)
  assert.equal(AUTO_DISCOVERY_INTERVAL_MS, 12_000)
  assert.equal(HIDDEN_AUTO_DISCOVERY_INTERVAL_MS, 30_000)
  assert.equal(FULL_SUMMARY_REFRESH_INTERVAL_MS, 4_000)
  assert.equal(shrimpTankDismissedStorageKey('session/1'), 'dsh-shrimp-tank-dismissed:session%2F1')
  assert.equal(shrimpTankDismissedStorageKey(''), '')
  assert.equal(shouldAutoOpen('p1:r1', ''), true)
  assert.equal(shouldAutoOpen('p1:r1', 'p1:r1'), false)
  assert.equal(shouldAutoOpen('p1:r1', 'p1:r1|p2:r2'), false)
  assert.equal(shouldAutoOpen('p1:r1|p3:r3', 'p1:r1|p2:r2'), true)
  assert.equal(shouldAutoOpen('', ''), false)
  assert.deepEqual(runSignatureEntries('p2:r2|p1:r1|p2:r2'), ['p1:r1', 'p2:r2'])
  assert.equal(mergeRunSignatures('p2:r2|p1:r1', 'p3:r3|p1:r1'), 'p1:r1|p2:r2|p3:r3')
})
