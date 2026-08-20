import test from 'node:test'
import assert from 'node:assert/strict'

import { runSampleSuite } from './run-intelligence-sample-suite.mjs'

test('direct sample suite invokes real modules with isolated stores and exact scope evidence', async () => {
  const report = await runSampleSuite({ count: 3 })
  assert.equal(report.ok, true)
  assert.equal(report.summary.total, 12)
  assert.equal(report.summary.passed, 12)
  assert.equal(report.isolation.formalDataRead, false)
  assert.equal(report.isolation.formalDataWritten, false)
  assert.equal(report.metrics['compaction-retention'].passRate, 1)
  assert.equal(report.metrics['compaction-retention'].pathRetentionRate, 1)
  assert.equal(report.metrics['task-restart-resume'].passRate, 1)
  assert.equal(report.metrics['task-restart-resume'].capsuleExactnessRate, 1)
  assert.equal(report.metrics['memory-lifecycle'].passRate, 1)
  assert.equal(report.metrics['memory-lifecycle'].scopeLeakTotal, 0)
  assert.equal(report.metrics['memory-lifecycle'].forgetPersistenceRate, 1)
  assert.equal(report.metrics['cross-session-ranking'].passRate, 1)
  assert.equal(report.metrics['cross-session-ranking'].scopeLeakTotal, 0)
  for (const sample of report.groups.find((group) => group.id === 'cross-session-ranking').cases) {
    assert.equal(sample.evidence.recallAt2, 1)
    assert.equal(sample.evidence.scopeLeakCount, 0)
    assert.equal(sample.evidence.noAutoInjection, true)
  }
})
