import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalOutputPath, createIsolatedDataRoots, DEFAULT_FOCUSED_GROUPS, formatTextReport, runRegression } from './run-intelligence-regression.mjs'

test('headless group evidence records full no-model Loader validation without overclaiming model/tool acceptance', () => {
  const headless = DEFAULT_FOCUSED_GROUPS.find((group) => group.id === 'headless-profile')
  assert.equal(headless.evidenceLevel, 'config + package import + full Loader no-model task validation')
  assert.equal(headless.fullLoaderAcceptance, true)
  assert.match(headless.note, /No model\/tool acceptance/)
})

test('upgrade-readiness contract and vision bridge stay in the focused regression set', () => {
  assert.ok(DEFAULT_FOCUSED_GROUPS.some((group) => group.id === 'upgrade-readiness-focused-test'))
  assert.ok(DEFAULT_FOCUSED_GROUPS.some((group) => group.id === 'rollback-snapshot-focused-test'))
  assert.ok(DEFAULT_FOCUSED_GROUPS.some((group) => group.id === 'web-intelligence-profile-focused-test'))
  assert.ok(DEFAULT_FOCUSED_GROUPS.some((group) => group.id === 'direct-sample-suite-20'))
  assert.ok(DEFAULT_FOCUSED_GROUPS.some((group) => group.id === 'reliable-development-preset'))
  assert.ok(DEFAULT_FOCUSED_GROUPS.some((group) => group.id === 'shrimp-shell-vision'))
})

test('data groups receive isolated roots for every persistent subsystem and clean them up', () => {
  const sandbox = createIsolatedDataRoots()
  const root = sandbox.paths.root
  try {
    for (const key of ['DSH_MEMORY_ROOT', 'DSH_MEMORY_DB', 'DSH_INTELLIGENCE_ROOT', 'DSH_CROSS_SESSION_DB', 'DSH_CODE_INTELLIGENCE_ROOT', 'DSH_COMPACTION_V2_ROOT', 'DSH_EVALS_ROOT']) assert.ok(sandbox.env[key])
    assert.ok(sandbox.env.DSH_MEMORY_ROOT.startsWith(root))
  } finally {
    sandbox.cleanup()
  }
  assert.equal(existsSync(root), false)
})

test('fixture regression groups continue after one failure and total status is failed', () => {
  const calls = []
  const cleanups = []
  const groups = [
    { id: 'fixture-pass-one', category: 'fixture', command: () => ['/fixture/node', 'pass-one'] },
    { id: 'fixture-fail', category: 'fixture', command: () => ['/fixture/node', 'fail'] },
    { id: 'fixture-pass-two', category: 'fixture', command: () => ['/fixture/node', 'pass-two'] },
  ]
  const report = runRegression({
    root: process.cwd(),
    nodePath: '/fixture/node',
    groups,
    createSandbox() {
      return { paths: { root: '/tmp/fixture-root' }, env: { DSH_MEMORY_ROOT: '/tmp/fixture-memory' }, cleanup() { cleanups.push(true) } }
    },
    execute(command) {
      calls.push(command)
      const failed = command[1] === 'fail'
      return { command, commandText: command.join(' '), exitCode: failed ? 7 : 0, signal: null, durationMs: 1, status: failed ? 'failed' : 'passed', stdout: failed ? 'fixture stdout' : 'pass stdout', stderr: failed ? 'fixture stderr' : '', error: null }
    },
  })
  assert.equal(calls.length, 3)
  assert.equal(cleanups.length, 3)
  assert.deepEqual(report.groups.map((group) => group.status), ['passed', 'failed', 'passed'])
  assert.equal(report.status, 'failed')
  assert.equal(report.ok, false)
  assert.equal(report.summary.total, groups.length)
  assert.equal(report.summary.passed, report.groups.filter((group) => group.status === 'passed').length)
  assert.equal(report.summary.failed, report.groups.filter((group) => group.status === 'failed').length)
  assert.match(formatTextReport(report), /fixture stderr/)
})

test('output must remain inside an explicit allowed root, including symlink targets', () => {
  const allowed = mkdtempSync(join(tmpdir(), 'dsh-regression-output-'))
  const outside = mkdtempSync(join(tmpdir(), 'dsh-regression-outside-'))
  try {
    const target = canonicalOutputPath({ output: join(allowed, 'reports/report.json'), allowedRoot: allowed })
    assert.equal(target, join(allowed, 'reports/report.json'))
    assert.throws(() => canonicalOutputPath({ output: join(allowed, '..', 'escape.json'), allowedRoot: allowed }), /escapes explicit allowedRoot/)
    mkdirSync(join(allowed, 'links'), { recursive: true })
    symlinkSync(outside, join(allowed, 'links/outside'))
    assert.throws(() => canonicalOutputPath({ output: join(allowed, 'links/outside/report.json'), allowedRoot: allowed }), /escapes explicit allowedRoot/)
  } finally {
    rmSync(allowed, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
