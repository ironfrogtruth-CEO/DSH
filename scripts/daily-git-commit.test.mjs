import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  DAILY_LOCK_FILENAME,
  DAILY_REPOSITORIES,
  QUICK_VALIDATIONS,
  acquireDailyLock,
  captureStagedSnapshot,
  isProtectedRuntimePath,
  parseArgs,
  parsePorcelainZ,
  releaseDailyLock,
  runDailyGitCommit,
  runDailyGitCommitAll,
} from './daily-git-commit.mjs'

const GIT = '/usr/bin/git'

function git(root, args) {
  const result = spawnSync(GIT, args, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result
}

function fixture({ ignore = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-daily-git-'))
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'daily-test@example.com'])
  git(root, ['config', 'user.name', 'Daily Test'])
  writeFileSync(join(root, 'README.md'), 'baseline\n')
  if (ignore) writeFileSync(join(root, '.gitignore'), `${ignore.trim()}\n`)
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'baseline'])
  return root
}

const passValidation = () => [{ id: 'fixture', ok: true, detail: '通过' }]

test('porcelain parser keeps status paths and protected-path policy is explicit', () => {
  assert.deepEqual(parsePorcelainZ(' M settings.yaml\0?? output/\0'), [
    { xy: ' M', path: 'settings.yaml' },
    { xy: '??', path: 'output/' },
  ])
  assert.equal(isProtectedRuntimePath('output/report.json'), true)
  assert.equal(isProtectedRuntimePath('heartbeats-secret.json'), true)
  assert.equal(isProtectedRuntimePath('.env.production'), true)
  assert.equal(isProtectedRuntimePath('certs/service.pem'), true)
  assert.equal(isProtectedRuntimePath('keys/service.p12'), true)
  assert.equal(isProtectedRuntimePath('.ssh/id_ed25519'), true)
  assert.equal(isProtectedRuntimePath('keys/private-key.txt'), true)
  assert.equal(isProtectedRuntimePath('screen-memory/shots/2026-09-01/a.png'), true)
  assert.equal(isProtectedRuntimePath('runtimes/stenographer/models/model.pt'), true)
  assert.equal(isProtectedRuntimePath('cleanup-reports/weekly-safe-cleanup/latest.json'), true)
  assert.equal(isProtectedRuntimePath('notify-watcher-state.json'), true)
  assert.equal(isProtectedRuntimePath('shrimp-run-standing-auth.json'), true)
  assert.equal(isProtectedRuntimePath('data/shrimptank.db'), true)
  assert.equal(isProtectedRuntimePath('skills/reliable-development/SKILL.md'), false)
  assert.equal(isProtectedRuntimePath('extensions/dsh-git/index.js'), false)
})

test('daily lock admits one owner, releases cleanly, and recovers a dead stale lock', () => {
  const root = fixture()
  const first = acquireDailyLock(root)
  assert.equal(first.ok, true)
  assert.equal(existsSync(join(root, '.git', DAILY_LOCK_FILENAME)), true)
  const second = acquireDailyLock(root)
  assert.equal(second.ok, false)
  assert.equal(second.code, 'DAILY_COMMIT_LOCKED')
  assert.equal(releaseDailyLock(first).ok, true)
  assert.equal(existsSync(join(root, '.git', DAILY_LOCK_FILENAME)), false)

  writeFileSync(join(root, '.git', DAILY_LOCK_FILENAME), JSON.stringify({ pid: 99999999, startedAtMs: 1, startedAt: '1970-01-01T00:00:00.000Z', token: 'stale' }))
  const recovered = acquireDailyLock(root, { staleAfterMs: 1 })
  assert.equal(recovered.ok, true)
  assert.equal(recovered.staleRecovered, true)
  assert.equal(releaseDailyLock(recovered).ok, true)
})

test('daily commit supports dry-run without staging', () => {
  const root = fixture()
  writeFileSync(join(root, 'settings.yaml'), 'changed\n')
  const result = runDailyGitCommit({ repoRoot: root, dryRun: true, validate: passValidation })
  assert.equal(result.ok, true)
  assert.equal(result.status, 'dry-run')
  assert.equal(result.push, false)
  assert.equal(spawnSync(GIT, ['diff', '--cached', '--quiet'], { cwd: root }).status, 0)
  assert.match(spawnSync(GIT, ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout, /settings\.yaml/)
})

test('daily commit skips clean and ignored runtime-only repositories', () => {
  const clean = fixture()
  const cleanResult = runDailyGitCommit({ repoRoot: clean, validate: passValidation })
  assert.deepEqual({ ok: cleanResult.ok, status: cleanResult.status, reason: cleanResult.reason }, { ok: true, status: 'skipped', reason: '无改动' })

  const ignored = fixture({ ignore: '/heartbeats*.json\n/apps/*-arm64-new' })
  writeFileSync(join(ignored, 'heartbeats.json'), '{}\n')
  mkdirSync(join(ignored, 'apps'), { recursive: true })
  writeFileSync(join(ignored, 'apps/大神-arm64-new'), 'binary-placeholder\n')
  const ignoredResult = runDailyGitCommit({ repoRoot: ignored, validate: passValidation })
  assert.equal(ignoredResult.ok, true)
  assert.equal(ignoredResult.status, 'skipped')
  assert.equal(spawnSync(GIT, ['check-ignore', '--no-index', 'heartbeats.json'], { cwd: ignored }).status, 0)
  assert.equal(spawnSync(GIT, ['check-ignore', '--no-index', 'apps/大神-arm64-new'], { cwd: ignored }).status, 0)
})

test('gitignore ignores environment, certificate, key, and SSH private material', () => {
  const root = fixture({ ignore: '/.env\n/.env.*\n*.pem\n*.key\n*.p12\n*.pfx\n/.ssh/\n**/id_rsa\n**/id_ed25519\n**/*private-key*' })
  mkdirSync(join(root, '.ssh'), { recursive: true })
  for (const path of ['.env', '.env.production', 'cert.pem', 'cert.key', 'bundle.p12', 'bundle.pfx', '.ssh/id_rsa', '.ssh/id_ed25519', 'keys/private-key.txt']) {
    const parent = join(root, path, '..')
    mkdirSync(parent, { recursive: true })
    writeFileSync(join(root, path), 'secret\n')
    assert.equal(spawnSync(GIT, ['check-ignore', '--no-index', path], { cwd: root }).status, 0, path)
  }
})

test('daily commit fails closed when staged work already exists', () => {
  const root = fixture()
  writeFileSync(join(root, 'already-staged.txt'), 'keep staged\n')
  git(root, ['add', 'already-staged.txt'])
  const result = runDailyGitCommit({ repoRoot: root, validate: passValidation })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'blocked')
  assert.equal(result.code, 'PREEXISTING_STAGED')
  assert.match(spawnSync(GIT, ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).stdout, /already-staged\.txt/)
})

test('daily commit blocks unignored sensitive/runtime candidates', () => {
  const root = fixture()
  writeFileSync(join(root, 'heartbeats-secret.json'), '{}\n')
  const result = runDailyGitCommit({ repoRoot: root, validate: passValidation })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'blocked')
  assert.equal(result.code, 'PROTECTED_PATH')
  assert.deepEqual(result.paths, ['heartbeats-secret.json'])
  assert.match(spawnSync(GIT, ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout, /heartbeats-secret\.json/)
})

test('daily commit validates, commits locally with the required message, and never pushes', () => {
  const root = fixture()
  writeFileSync(join(root, 'settings.yaml'), 'daily snapshot\n')
  const result = runDailyGitCommit({ repoRoot: root, validate: passValidation, now: new Date('2026-08-25T00:00:00.000Z') })
  assert.equal(result.ok, true)
  assert.equal(result.status, 'committed')
  assert.equal(result.message, 'chore(backup): daily snapshot 2026-08-25')
  assert.equal(result.push, false)
  assert.match(spawnSync(GIT, ['log', '-1', '--format=%s'], { cwd: root, encoding: 'utf8' }).stdout, /^chore\(backup\): daily snapshot 2026-08-25\n$/)
  assert.equal(spawnSync(GIT, ['diff', '--cached', '--quiet'], { cwd: root }).status, 0)
  assert.equal(spawnSync(GIT, ['remote'], { cwd: root, encoding: 'utf8' }).stdout, '')
  assert.equal(existsSync(join(root, '.git', DAILY_LOCK_FILENAME)), false)
})

test('multi-repository daily commit creates one local commit per Git root and includes plugin source in ShrimpTank parent', () => {
  const dashen = fixture()
  const shrimptank = fixture()
  writeFileSync(join(dashen, 'settings.yaml'), 'dashen\n')
  mkdirSync(join(shrimptank, 'CyberMarcus-Chrome'), { recursive: true })
  writeFileSync(join(shrimptank, 'CyberMarcus-Chrome/background.js'), 'export const ok = true\n')
  const result = runDailyGitCommitAll({
    repositories: [
      { id: 'dashen', path: dashen },
      { id: 'shrimptank', path: shrimptank },
    ],
    validations: { dashen: passValidation, shrimptank: passValidation },
    now: new Date('2026-09-01T00:00:00+08:00'),
  })
  assert.equal(result.ok, true)
  assert.equal(result.committed_count, 2)
  assert.equal(result.push, false)
  assert.equal(git(dashen, ['log', '-1', '--format=%s']).stdout.trim(), 'chore(backup): daily snapshot 2026-09-01')
  assert.equal(git(shrimptank, ['log', '-1', '--format=%s']).stdout.trim(), 'chore(backup): daily snapshot 2026-09-01')
  assert.match(git(shrimptank, ['show', '--name-only', '--format=', 'HEAD']).stdout, /CyberMarcus-Chrome\/background\.js/)
})

test('multi-repository result reports one protected-path block without pushing either repository', () => {
  const dashen = fixture()
  const shrimptank = fixture()
  mkdirSync(join(dashen, 'screen-memory', 'shots'), { recursive: true })
  writeFileSync(join(dashen, 'screen-memory', 'shots', 'capture.png'), 'runtime\n')
  writeFileSync(join(shrimptank, 'README.md'), 'changed\n')
  const result = runDailyGitCommitAll({
    repositories: [
      { id: 'dashen', path: dashen },
      { id: 'shrimptank', path: shrimptank },
    ],
    validations: { dashen: passValidation, shrimptank: passValidation },
  })
  assert.equal(result.ok, false)
  assert.equal(result.blocked_count, 1)
  assert.equal(result.results.find((item) => item.id === 'dashen').code, 'PROTECTED_PATH')
  assert.equal(result.results.find((item) => item.id === 'shrimptank').status, 'committed')
  assert.equal(result.push, false)
})

test('validation failure removes only this invocation staging and does not commit', () => {
  const root = fixture()
  writeFileSync(join(root, 'settings.yaml'), 'should remain unstaged\n')
  const result = runDailyGitCommit({ repoRoot: root, validate: () => [{ id: 'fixture', ok: false, detail: 'failed' }] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'VALIDATION_FAILED')
  assert.equal(spawnSync(GIT, ['diff', '--cached', '--quiet'], { cwd: root }).status, 0)
  assert.match(spawnSync(GIT, ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout, /settings\.yaml/)
})

test('staged ownership change blocks cleanup instead of resetting external staging', () => {
  const root = fixture()
  writeFileSync(join(root, 'settings.yaml'), 'script candidate\n')
  const result = runDailyGitCommit({
    repoRoot: root,
    validate: (repo) => {
      writeFileSync(join(repo, 'external.txt'), 'external owner\n')
      git(repo, ['add', 'external.txt'])
      return [{ id: 'fixture', ok: false, detail: 'force cleanup' }]
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'STAGED_OWNERSHIP_LOST')
  assert.equal(result.cleanup.code, 'STAGED_OWNERSHIP_LOST')
  const staged = spawnSync(GIT, ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).stdout
  assert.match(staged, /settings\.yaml/)
  assert.match(staged, /external\.txt/)
  const snapshot = captureStagedSnapshot(root)
  assert.equal(snapshot.ok, true)
})

test('CLI accepts only dry-run', () => {
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true })
  assert.throws(() => parseArgs(['--repo', '/tmp/other']), /unknown option/)
})

test('daily quick validations cover the runtime seams before commit', () => {
  assert.deepEqual(DAILY_REPOSITORIES.map((item) => item.id), ['dashen', 'shrimptank'])
  assert.deepEqual(
    QUICK_VALIDATIONS.map((check) => check.id),
    ['reliable-preset', 'avengers-preset', 'avengers-model-default', 'goal-first', 'dsh-git-heartbeat', 'shrimp-vision', 'local-route', 'subagent-route', 'ensure-web'],
  )
})
