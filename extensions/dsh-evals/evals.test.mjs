import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  assertLosslessJson,
  compareEvaluations,
  hashJson,
  listEvaluations,
  loadFixture,
  normalizeLosslessJson,
  runEvaluation,
} from './runner.js'
import { validateFixture } from './schemas.js'

function memoryFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    fixtureId: 'memory-compare',
    title: 'compare memory ranking',
    taskType: 'memory-retrieval',
    input: {
      query: 'alpha parser',
      topK: 2,
      allowedScope: 'project:alpha',
      forbiddenScopes: ['project:beta'],
      candidates: [
        { id: 'alpha-1', scope: 'project:alpha', text: 'alpha parser decision' },
        { id: 'alpha-2', scope: 'project:alpha', text: 'alpha parser test' },
        { id: 'beta-1', scope: 'project:beta', text: 'alpha parser unrelated' },
      ],
    },
    expected: { relevantIds: ['alpha-1', 'alpha-2'], enforceExact: true },
    ...overrides,
  }
}

test('fixture contract and hash are deterministic regardless of key order', () => {
  assert.equal(validateFixture(memoryFixture()).ok, true)
  assert.equal(hashJson({ a: 1, b: { c: 2 } }), hashJson({ b: { c: 2 }, a: 1 }))
  assert.equal(validateFixture({ schemaVersion: 1 }).ok, false)
})

test('default six task fixtures run offline with explicit optional-module status', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'dsh-evals-default-'))
  try {
    for (const fixtureId of [
      'compaction-retention-basic',
      'memory-retrieval-basic',
      'task-resume-basic',
      'code-context-basic',
      'cross-session-ranking-basic',
      'frontend-signoff-basic',
    ]) {
      const artifact = await runEvaluation({ fixtureId, outputRoot, runId: `default-${fixtureId}` })
      assert.equal(artifact.status, 'passed')
      assert.equal(artifact.fingerprint, (await runEvaluation({ fixtureId, outputRoot, runId: `repeat-${fixtureId}` })).fingerprint)
      assert.equal(typeof artifact.fixtureHash, 'string')
      assert.ok(['available', 'skipped', 'not-configured'].includes(artifact.cases[0].optionalModule.status))
    }
    const listed = await listEvaluations({ outputRoot, limit: 3 })
    assert.equal(listed.length, 3)
  } finally {
    await rm(outputRoot, { recursive: true, force: true })
  }
})

test('required adapter absence is explicit skipped and fixture paths cannot escape allowedRoot', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'dsh-evals-skipped-'))
  try {
    const skipped = await runEvaluation({
      outputRoot,
      runId: 'skipped-case',
      fixture: { ...memoryFixture({ fixtureId: 'requires-adapter' }), adapterModule: '@local/missing-eval-adapter', requiresModule: true },
    })
    assert.equal(skipped.status, 'skipped')
    assert.equal(skipped.cases[0].optionalModule.status, 'skipped')
    await assert.rejects(loadFixture({ fixturePath: '../package.json' }), /escapes allowedRoot|cannot be resolved/)
  } finally {
    await rm(outputRoot, { recursive: true, force: true })
  }
})

test('compare fails on accuracy decrease, scope leak, secret leak, and frontend blocking omission', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'dsh-evals-compare-'))
  try {
    const baseline = await runEvaluation({ outputRoot, runId: 'baseline', fixture: memoryFixture() })
    const lowerRecall = await runEvaluation({
      outputRoot,
      runId: 'lower-recall',
      fixture: memoryFixture({ input: { ...memoryFixture().input, topK: 1 } }),
    })
    const recallComparison = await compareEvaluations({ outputRoot, baselineRunId: baseline.runId, candidateRunId: lowerRecall.runId })
    assert.equal(recallComparison.status, 'failed')
    assert.ok(recallComparison.regressions.some((item) => item.includes('recallAtK-decrease')))

    const scopeLeak = await runEvaluation({
      outputRoot,
      runId: 'scope-leak',
      fixture: memoryFixture({ input: { ...memoryFixture().input, topK: 3 } }),
    })
    const scopeComparison = await compareEvaluations({ outputRoot, baselineRunId: baseline.runId, candidateRunId: scopeLeak.runId })
    assert.equal(scopeComparison.status, 'failed')
    assert.ok(scopeComparison.issues.some((item) => item.includes('scope-leak')))

    const secretLeak = await runEvaluation({
      outputRoot,
      runId: 'secret-leak',
      fixture: memoryFixture({ input: { ...memoryFixture().input, candidates: [{ id: 'alpha-1', scope: 'project:alpha', text: 'api_key=sk-12345678901234567890' }] }, expected: { relevantIds: ['alpha-1'] } }),
    })
    const secretComparison = await compareEvaluations({ outputRoot, baselineRunId: baseline.runId, candidateRunId: secretLeak.runId })
    assert.equal(secretComparison.status, 'failed')
    assert.ok(secretComparison.issues.some((item) => item.includes('secret-leak')))

    const frontendBaseline = await runEvaluation({ outputRoot, runId: 'frontend-base', fixture: {
      schemaVersion: 1,
      fixtureId: 'frontend-compare',
      title: 'frontend compare',
      taskType: 'frontend-signoff',
      input: { gateClaim: true, requiredChecks: ['dom', 'visual'], checks: [{ id: 'dom', blocking: true, pass: true }, { id: 'visual', blocking: true, pass: true }] },
      expected: { requiredChecks: ['dom', 'visual'], enforceExact: true },
    } })
    const frontendCandidate = await runEvaluation({ outputRoot, runId: 'frontend-omit', fixture: {
      schemaVersion: 1,
      fixtureId: 'frontend-compare',
      title: 'frontend compare',
      taskType: 'frontend-signoff',
      input: { gateClaim: true, requiredChecks: ['dom', 'visual'], checks: [{ id: 'dom', blocking: true, pass: true }] },
      expected: { requiredChecks: ['dom', 'visual'], enforceExact: true },
    } })
    const frontendComparison = await compareEvaluations({ outputRoot, baselineRunId: frontendBaseline.runId, candidateRunId: frontendCandidate.runId })
    assert.equal(frontendComparison.status, 'failed')
    assert.ok(frontendComparison.issues.some((item) => item.includes('frontend-blocking-gate-omitted')))
  } finally {
    await rm(outputRoot, { recursive: true, force: true })
  }
})

test('run, compare, list, and every explicit tool return only lossless JSON', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'dsh-evals-lossless-'))
  try {
    assert.throws(() => assertLosslessJson({ optional: undefined }), /NON_LOSSLESS_JSON|undefined/)
    assert.throws(() => assertLosslessJson([undefined]), /NON_LOSSLESS_JSON|undefined/)
    assert.throws(() => assertLosslessJson({ value: NaN }), /NON_LOSSLESS_JSON|finite/)
    const normalized = normalizeLosslessJson({ optional: undefined, nested: { value: 1 } })
    assert.deepEqual(normalized, { nested: { value: 1 } })

    const baseline = await runEvaluation({ outputRoot, runId: 'lossless-base', fixtureId: 'memory-retrieval-basic' })
    const candidate = await runEvaluation({ outputRoot, runId: 'lossless-candidate', fixtureId: 'memory-retrieval-basic' })
    assertLosslessJson(baseline)
    assertLosslessJson(candidate)
    assert.equal(Object.hasOwn(baseline.cases[0].optionalModule, 'version'), false, 'skipped adapter must omit undefined version')
    const comparison = await compareEvaluations({ outputRoot, baselineRunId: baseline.runId, candidateRunId: candidate.runId })
    assertLosslessJson(comparison)
    assertLosslessJson(await listEvaluations({ outputRoot }))

    const root = await import(`./index.js?lossless-tools=${Date.now()}`)
    const catalog = []
    await root.apply({ tools: { register(tool) { catalog.push(tool) } } })
    const evalRun = catalog.find((tool) => tool.name === 'eval_run')
    const evalCompare = catalog.find((tool) => tool.name === 'eval_compare')
    const evalList = catalog.find((tool) => tool.name === 'eval_list')
    const runResult = await evalRun.execute({ fixtureId: 'memory-retrieval-basic', outputRoot, runId: 'lossless-tool' })
    const compareResult = await evalCompare.execute({ outputRoot, baselineRunId: baseline.runId, candidateRunId: candidate.runId })
    const listResult = await evalList.execute({ outputRoot, limit: 10 })
    assertLosslessJson(runResult)
    assertLosslessJson(compareResult)
    assertLosslessJson(listResult)
    const runText = evalRun.output.render({}, runResult)[0].text
    const compareText = evalCompare.output.render({}, compareResult)[0].text
    const listText = evalList.output.render({}, listResult)[0].text
    for (const text of [runText, compareText, listText]) {
      assert.ok(text.length <= 12_000)
      assert.doesNotMatch(text, /rawOutput|fullHistory|api[_-]?key|sk-[A-Za-z0-9]{16,}/i)
      JSON.parse(text.slice(text.indexOf('\n') + 1))
    }
    assert.match(runText, /runId|status|score|gateFailures|metrics|artifactPath/)
    assert.match(compareText, /status|regressions/)
    assert.match(listText, /records/)
  } finally {
    await rm(outputRoot, { recursive: true, force: true })
  }
})
