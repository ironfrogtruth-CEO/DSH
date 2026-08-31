import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const SCRIPT = '/Users/marcus/.dsh/scripts/weekly-safe-cleanup.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weekly-safe-cleanup-test.'))
  writeFileSync(join(root, '.weekly-safe-cleanup-test-root'), 'ok\n')
  for (const relative of ['Library/Caches', '.cache', 'user-temp', 'private-tmp', 'git-dirty', 'git-clean']) {
    mkdirSync(join(root, relative), { recursive: true })
  }
  const old = new Date('2020-01-01T00:00:00Z')
  const oldCache = join(root, 'Library/Caches/old-cache')
  const activeCache = join(root, 'Library/Caches/active-cache')
  const freshCache = join(root, 'Library/Caches/fresh-cache')
  const allowedTmp = join(root, 'private-tmp/dsh-old.ABC123')
  const unknownTmp = join(root, 'private-tmp/important-project')
  for (const target of [oldCache, activeCache, freshCache, allowedTmp, unknownTmp]) {
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'payload'), 'x')
  }
  for (const target of [oldCache, activeCache, allowedTmp, unknownTmp]) utimesSync(target, old, old)
  symlinkSync(oldCache, join(root, 'Library/Caches/old-link'))
  const lsof = join(root, 'lsof.txt')
  writeFileSync(lsof, `process 1 user txt ${realpathSync(activeCache)}/payload\n`)
  return { root, oldCache, activeCache, freshCache, allowedTmp, unknownTmp, lsof }
}

function run(args, data, extra = {}) {
  return spawnSync('/usr/local/bin/node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_WEEKLY_CLEANUP_TEST_MODE: '1',
      DSH_WEEKLY_CLEANUP_TEST_ROOT: data.root,
      DSH_WEEKLY_CLEANUP_TEST_LSOF_SNAPSHOT: data.lsof,
      ...extra,
    },
  })
}

test('dry-run and execute keep fresh, active, symlink and unknown temp paths', () => {
  const data = fixture()
  const dry = run(['--dry-run'], data)
  assert.equal(dry.status, 0, dry.stderr)
  const drySummary = JSON.parse(dry.stdout.trim().split(/\r?\n/).at(-1))
  assert.equal(drySummary.status, 'ok')
  assert.match(drySummary.summary, /45 天/)
  assert.equal(Boolean(readFileSync(join(data.oldCache, 'payload'))), true)

  const executed = run(['--execute'], data)
  assert.equal(executed.status, 0, executed.stderr)
  assert.equal(statExists(data.oldCache), false)
  assert.equal(statExists(data.allowedTmp), false)
  assert.equal(statExists(data.activeCache), true)
  assert.equal(statExists(data.freshCache), true)
  assert.equal(statExists(data.unknownTmp), true)
  const report = JSON.parse(readFileSync(join(data.root, 'reports/latest.json'), 'utf8'))
  assert.equal(report.retention_days, 45)
  assert.ok(report.candidates.some((item) => item.reason === 'ACTIVE_PROCESS_HANDLE'))
  assert.ok(report.candidates.some((item) => item.reason === 'TEMP_NAME_NOT_ALLOWLISTED'))
})

test('lsof failure blocks before deletion', () => {
  const data = fixture()
  const result = run(['--execute'], data, { DSH_WEEKLY_CLEANUP_TEST_LSOF_FAIL: '1' })
  assert.notEqual(result.status, 0)
  assert.equal(statExists(data.oldCache), true)
  const summary = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
  assert.equal(summary.status, 'blocked')
})

test('unknown or repeated mode arguments are rejected', () => {
  const data = fixture()
  assert.notEqual(run(['--execute', '--dry-run'], data).status, 0)
  assert.notEqual(run(['--root', '/'], data).status, 0)
})

function statExists(target) {
  try { readFileSync(join(target, 'payload')); return true } catch { return false }
}
