#!/usr/local/bin/node
/**
 * Create a safe, local-only daily snapshot of the DSH repository.
 *
 * The command intentionally has no push path. It refuses to run when the
 * index is already staged, protects runtime/private paths even if .gitignore
 * is damaged, validates the staged snapshot, and only then commits it.
 * `runDailyGitCommit()` is exported so tests can exercise the state machine in
 * an isolated temporary repository while the CLI remains fixed to ~/.dsh.
 */
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join, relative, resolve } from 'node:path'

export const DAILY_REPOSITORY = '/Users/marcus/.dsh'
export const DAILY_COMMIT_PREFIX = 'chore(backup): daily snapshot'
const GIT = '/usr/bin/git'
const NODE = '/usr/local/bin/node'
const SHANGHAI_TIMEZONE = 'Asia/Shanghai'
const COMMAND_TIMEOUT_MS = 120_000
const VALIDATION_TIMEOUT_MS = 90_000
const MAX_COMMAND_OUTPUT = 32 * 1024 * 1024
export const DAILY_LOCK_FILENAME = 'dsh-daily-commit.lock'
export const DAILY_LOCK_STALE_AFTER_MS = 15 * 60 * 1000

// These are runtime, private, generated, or backup paths. They are checked
// independently of .gitignore so an accidental ignore edit cannot make the
// daily job commit credentials, histories, or large transient artifacts.
export const PROTECTED_PATH_PATTERNS = Object.freeze([
  /^(?:output|attachments|cross-session|intelligence|memories|vision-media|vision-results|zhipu-images)(?:\/|$)/,
  /^gzh-publisher-profile[^/]*(?:\/|$)/,
  /^xhs-publisher-profile[^/]*(?:\/|$)/,
  /^\.playwright-cli(?:\/|$)/,
  /^\.web-load-signature$/,
  /^heartbeats[^/]*\.json$/,
  /(?:^|\/)\.env(?:\..*)?$/,
  /(?:^|\/)[^/]+\.(?:pem|key|p12|pfx)$/i,
  /(?:^|\/)\.ssh(?:\/|$)/,
  /(?:^|\/)id_rsa(?:\..*)?$/i,
  /(?:^|\/)id_ed25519(?:\..*)?$/i,
  /(?:^|\/)[^/]*private[-_]?key[^/]*$/i,
  /(?:^|\/)[^/]*\.bak[^/]*(?:\/|$)/,
  /^apps\/[^/]*-arm64-new(?:\/|$)/,
  /^plugins\/dsh-market\/plugins-cache\.json$/,
  /(?:^|\/)__pycache__(?:\/|$)/,
  /(?:^|\/)\.pytest_cache(?:\/|$)/,
  /(?:^|\/)pytest\/cache(?:\/|$)/,
  /(?:^|\/)[^/]+\.py[cod]$/,
  /^(?:sessions|storages|goal-first-state|backups|private)(?:\/|$)/,
  /^(?:\.credentials\.yaml|\.anonymous-user-id|web\.log)$/,
])

export const QUICK_VALIDATIONS = Object.freeze([
  Object.freeze({ id: 'reliable-preset', args: ['skills/reliable-development/scripts/verify_reliable_preset.mjs'] }),
  Object.freeze({ id: 'goal-first', args: ['--test', 'extensions/dsh-goal-first-state-machine/goal-first-state-machine.test.mjs'] }),
  Object.freeze({ id: 'dsh-git-heartbeat', args: ['--test', 'extensions/dsh-git/index.test.mjs', 'extensions/shrimp-shell/heartbeat-scheduler.test.mjs'] }),
  Object.freeze({ id: 'shrimp-vision', args: ['--test', 'extensions/shrimp-shell/vision.test.mjs'] }),
  Object.freeze({ id: 'local-route', args: ['--test', 'extensions/dsh-local-route-policy/index.test.mjs'] }),
  Object.freeze({ id: 'subagent-route', args: ['--test', 'scripts/patch-subagent-selected-route.test.mjs'] }),
  Object.freeze({ id: 'ensure-web', args: ['--test', 'scripts/ensure-web.test.mjs'] }),
])

function trimOutput(value, limit = 4_000) {
  const text = String(value || '')
  return text.length > limit ? `…${text.slice(-limit)}` : text
}

export function runGit(args, { repoRoot, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  let result
  try {
    result = spawnSync(GIT, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: MAX_COMMAND_OUTPUT,
      windowsHide: true,
    })
  } catch (error) {
    return { code: 127, stdout: '', stderr: String(error && error.message || error), error }
  }
  const error = result.error || null
  return {
    code: Number.isInteger(result.status) ? result.status : 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    signal: result.signal || null,
    error,
  }
}

function lockPathFor(repoRoot) {
  return join(resolve(repoRoot), '.git', DAILY_LOCK_FILENAME)
}

function lockPidIsAlive(pid) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return false
  try {
    process.kill(value, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

function readLockRecord(lockPath) {
  let record = null
  try {
    record = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    // A truncated or hand-created lock can still be recovered by age.
  }
  let mtimeMs = 0
  try { mtimeMs = statSync(lockPath).mtimeMs } catch {}
  const startedAtMs = Number(record && record.startedAtMs) || mtimeMs || 0
  return {
    pid: Number(record && record.pid) || 0,
    startedAtMs,
    token: String(record && record.token || ''),
    malformed: !record || typeof record !== 'object',
  }
}

/** Acquire an atomic lock; stale recovery requires both age and a dead PID. */
export function acquireDailyLock(repoRoot, { nowMs = Date.now(), staleAfterMs = DAILY_LOCK_STALE_AFTER_MS } = {}) {
  const lockPath = lockPathFor(repoRoot)
  const parent = join(resolve(repoRoot), '.git')
  if (!existsSync(parent)) return { ok: false, code: 'NOT_A_REPOSITORY', error: '目标路径不是 Git 仓库', path: lockPath }
  const record = {
    pid: process.pid,
    startedAtMs: nowMs,
    startedAt: new Date(nowMs).toISOString(),
    token: randomUUID(),
  }
  const body = JSON.stringify(record)
  let staleRecovered = false
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd = null
    try {
      fd = openSync(lockPath, 'wx', 0o600)
      writeSync(fd, body, null, 'utf8')
      closeSync(fd)
      return { ok: true, path: lockPath, token: record.token, staleRecovered }
    } catch (error) {
      if (fd !== null) {
        try { closeSync(fd) } catch {}
      }
      if (!error || error.code !== 'EEXIST') return { ok: false, code: 'LOCK_ACQUIRE_FAILED', error: String(error && error.message || error), path: lockPath }
      const existing = readLockRecord(lockPath)
      const ageMs = Math.max(0, nowMs - existing.startedAtMs)
      const stale = ageMs >= staleAfterMs && !lockPidIsAlive(existing.pid)
      if (!stale) {
        return {
          ok: false,
          code: 'DAILY_COMMIT_LOCKED',
          error: `每日提交正在执行（pid=${existing.pid || 'unknown'}，已运行 ${Math.round(ageMs / 1000)} 秒）`,
          path: lockPath,
          existing,
        }
      }
      try {
        unlinkSync(lockPath)
        staleRecovered = true
      } catch (unlinkError) {
        return { ok: false, code: 'DAILY_COMMIT_STALE_LOCK_UNRECOVERABLE', error: String(unlinkError && unlinkError.message || unlinkError), path: lockPath, existing }
      }
    }
  }
  return { ok: false, code: 'DAILY_COMMIT_LOCKED', error: '每日提交锁竞争失败', path: lockPath }
}

export function releaseDailyLock(lock) {
  if (!lock || !lock.ok || !lock.path) return { ok: true, released: false }
  try {
    const current = readLockRecord(lock.path)
    if (lock.token !== current.token) {
      return { ok: false, released: false, code: 'DAILY_COMMIT_LOCK_OWNERSHIP_LOST', error: '锁已被其他进程接管，未删除当前锁' }
    }
    unlinkSync(lock.path)
    return { ok: true, released: true }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, released: false }
    return { ok: false, released: false, code: 'DAILY_COMMIT_LOCK_RELEASE_FAILED', error: String(error && error.message || error) }
  }
}

function runNode(args, repoRoot) {
  let result
  try {
    result = spawnSync(NODE, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: VALIDATION_TIMEOUT_MS,
      maxBuffer: MAX_COMMAND_OUTPUT,
      windowsHide: true,
    })
  } catch (error) {
    return { code: 127, stdout: '', stderr: String(error && error.message || error), error }
  }
  return {
    code: Number.isInteger(result.status) ? result.status : 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    signal: result.signal || null,
    error: result.error || null,
  }
}

function normalizeRelativePath(value) {
  const raw = String(value || '').replaceAll('\\', '/')
  if (!raw || raw.includes('\0') || raw.startsWith('/') || raw.split('/').includes('..')) return null
  return raw.replace(/^\.\//, '')
}

function parseNulPaths(output) {
  return String(output || '').split('\0').filter(Boolean).map((value) => normalizeRelativePath(value)).filter(Boolean)
}

/** Parse porcelain v1 -z entries without invoking a shell or a path parser. */
export function parsePorcelainZ(output) {
  const chunks = String(output || '').split('\0')
  const entries = []
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]
    if (!chunk) continue
    const xy = chunk.slice(0, 2)
    const path = normalizeRelativePath(chunk.slice(3))
    if (!path) continue
    const entry = { xy, path }
    if (xy[0] === 'R' || xy[0] === 'C') {
      const original = normalizeRelativePath(chunks[index + 1])
      if (original) {
        entry.originalPath = original
        index += 1
      }
    }
    entries.push(entry)
  }
  return entries
}

export function isProtectedRuntimePath(value) {
  const path = normalizeRelativePath(value)
  return Boolean(path && PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(path)))
}

function repositoryIsSafe(repoRoot) {
  const root = resolve(repoRoot)
  if (!existsSync(join(root, '.git'))) return { ok: false, code: 'NOT_A_REPOSITORY', error: '目标路径不是 Git 仓库' }
  const top = runGit(['rev-parse', '--show-toplevel'], { repoRoot })
  if (top.code !== 0) return { ok: false, code: 'REPOSITORY_CHECK_FAILED', error: trimOutput(top.stderr || top.stdout || '无法读取仓库根目录') }
  try {
    const canonicalRoot = realpathSync(root)
    const canonicalTop = realpathSync(top.stdout.trim())
    if (canonicalRoot !== canonicalTop) return { ok: false, code: 'REPOSITORY_ROOT_MISMATCH', error: '仓库根目录与目标目录不一致' }
  } catch (error) {
    return { ok: false, code: 'REPOSITORY_PATH_FAILED', error: String(error && error.message || error) }
  }
  return { ok: true, root }
}

function candidatePathCheck(repoRoot, entries) {
  const root = resolve(repoRoot)
  const protectedPaths = []
  const invalidPaths = []
  for (const entry of entries) {
    for (const value of [entry.path, entry.originalPath].filter(Boolean)) {
      const path = normalizeRelativePath(value)
      if (!path) {
        invalidPaths.push(String(value || ''))
        continue
      }
      if (isProtectedRuntimePath(path)) protectedPaths.push(path)
      const absolute = resolve(root, path)
      const rel = relative(root, absolute)
      if (rel.startsWith('..') || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || rel === '') invalidPaths.push(path)
      try {
        if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) invalidPaths.push(path)
      } catch {
        // Deleted paths are valid Git candidates; Git itself will report any
        // other failure during add/check.
      }
    }
  }
  if (invalidPaths.length) return { ok: false, code: 'CANDIDATE_PATH_INVALID', paths: [...new Set(invalidPaths)] }
  if (protectedPaths.length) return { ok: false, code: 'PROTECTED_PATH', paths: [...new Set(protectedPaths)] }
  return { ok: true }
}

function readStatusEntries(repoRoot) {
  const result = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { repoRoot })
  if (result.code !== 0) return { ok: false, code: 'STATUS_FAILED', error: trimOutput(result.stderr || result.stdout || '读取 Git 状态失败') }
  return { ok: true, entries: parsePorcelainZ(result.stdout) }
}

function readStagedPaths(repoRoot) {
  const result = runGit(['diff', '--cached', '--name-only', '-z'], { repoRoot })
  if (result.code !== 0) return { ok: false, code: 'STAGED_CHECK_FAILED', error: trimOutput(result.stderr || result.stdout || '读取暂存区失败') }
  return { ok: true, paths: parseNulPaths(result.stdout) }
}

export function captureStagedSnapshot(repoRoot) {
  const tree = runGit(['write-tree'], { repoRoot })
  if (tree.code !== 0) return { ok: false, code: 'STAGED_SNAPSHOT_FAILED', error: trimOutput(tree.stderr || tree.stdout || '无法读取暂存树') }
  const names = readStagedPaths(repoRoot)
  if (!names.ok) return names
  const paths = [...new Set(names.paths)].sort()
  const fingerprint = createHash('sha256').update(`${tree.stdout.trim()}\0${paths.join('\0')}`).digest('hex')
  return { ok: true, tree: tree.stdout.trim(), paths, fingerprint }
}

function cleanupCreatedStaged(repoRoot, paths, expectedSnapshot) {
  if (!expectedSnapshot || !expectedSnapshot.ok) {
    return { ok: false, code: 'STAGED_OWNERSHIP_LOST', error: '缺少本次暂存的所有权指纹，未执行撤销暂存', errors: [] }
  }
  const actualSnapshot = captureStagedSnapshot(repoRoot)
  if (!actualSnapshot.ok || actualSnapshot.fingerprint !== expectedSnapshot.fingerprint) {
    return {
      ok: false,
      code: 'STAGED_OWNERSHIP_LOST',
      error: '暂存区在清理前已被外部修改，未执行撤销暂存',
      expected: expectedSnapshot,
      actual: actualSnapshot,
      errors: [],
    }
  }
  const unique = [...new Set(paths.map(normalizeRelativePath).filter(Boolean))]
  const errors = []
  // Chunk the argv to keep cleanup safe even if a broken ignore file exposes
  // many entries. The preflight refuses pre-existing staged work, so every
  // path here was staged by this invocation.
  for (let offset = 0; offset < unique.length; offset += 128) {
    const result = runGit(['reset', '--', ...unique.slice(offset, offset + 128)], { repoRoot })
    if (result.code !== 0) errors.push(trimOutput(result.stderr || result.stdout || '撤销暂存失败'))
  }
  return { ok: errors.length === 0, code: errors.length ? 'STAGED_CLEANUP_FAILED' : null, errors }
}

function failureWithCleanup(root, message, base, cleanup) {
  if (!cleanup || cleanup.ok) return { ...resultBase(root, message), ...base, cleanup: cleanup ? cleanup.errors : [] }
  return {
    ...resultBase(root, message),
    ...base,
    ok: false,
    status: 'failed',
    code: cleanup.code || 'STAGED_OWNERSHIP_LOST',
    error: cleanup.error || '暂存区所有权检查失败，未执行撤销暂存',
    cleanup,
  }
}

export function formatShanghaiDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SHANGHAI_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value)
  const fields = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return `${fields.year}-${fields.month}-${fields.day}`
}

export function runQuickValidations(repoRoot) {
  return QUICK_VALIDATIONS.map((check) => {
    const result = runNode(check.args, repoRoot)
    const detail = trimOutput([result.stdout, result.stderr].filter(Boolean).join('\n'))
    return {
      id: check.id,
      ok: result.code === 0,
      code: result.code,
      detail: detail || (result.code === 0 ? '通过' : '命令失败'),
    }
  })
}

function normalizeValidationResult(value) {
  if (Array.isArray(value)) {
    const checks = value
    return { ok: checks.every((check) => check && check.ok !== false && check.status !== 'fail'), checks }
  }
  if (value && typeof value === 'object') {
    const checks = Array.isArray(value.checks) ? value.checks : []
    return { ok: value.ok !== false && checks.every((check) => check && check.ok !== false && check.status !== 'fail'), checks }
  }
  return { ok: false, checks: [], error: '验证器未返回有效结果' }
}

function resultBase(root, message) {
  return { repository: root, message, push: false }
}

function runDailyGitCommitUnlocked({ repoRoot, dryRun = false, now = new Date(), validate = runQuickValidations }) {
  const root = resolve(repoRoot)
  const message = `${DAILY_COMMIT_PREFIX} ${formatShanghaiDate(now)}`
  const preflightStaged = readStagedPaths(root)
  if (!preflightStaged.ok) return { ...resultBase(root, message), ok: false, status: 'failed', code: preflightStaged.code, error: preflightStaged.error }
  if (preflightStaged.paths.length) {
    return {
      ...resultBase(root, message), ok: false, status: 'blocked', code: 'PREEXISTING_STAGED',
      error: '已有暂存改动，已停止每日提交以保护用户暂存区', stagedPaths: preflightStaged.paths,
    }
  }

  const status = readStatusEntries(root)
  if (!status.ok) return { ...resultBase(root, message), ok: false, status: 'failed', code: status.code, error: status.error }
  if (!status.entries.length) return { ...resultBase(root, message), ok: true, status: 'skipped', reason: '无改动', candidateCount: 0 }

  const candidate = candidatePathCheck(root, status.entries)
  if (!candidate.ok) {
    return { ...resultBase(root, message), ok: false, status: 'blocked', code: candidate.code, error: candidate.code === 'PROTECTED_PATH' ? '候选包含敏感或运行时路径，已停止提交' : '候选路径无效，已停止提交', paths: candidate.paths }
  }

  const candidatePaths = [...new Set(status.entries.flatMap((entry) => [entry.path, entry.originalPath].filter(Boolean)))]
  if (dryRun) {
    return { ...resultBase(root, message), ok: true, status: 'dry-run', candidateCount: candidatePaths.length, candidates: candidatePaths, validation: 'skipped' }
  }

  const add = runGit(['add', '-A'], { repoRoot: root, timeoutMs: COMMAND_TIMEOUT_MS })
  if (add.code !== 0) return { ...resultBase(root, message), ok: false, status: 'failed', code: 'ADD_FAILED', error: trimOutput(add.stderr || add.stdout || 'git add 失败') }

  const staged = captureStagedSnapshot(root)
  if (!staged.ok) {
    return { ...resultBase(root, message), ok: false, status: 'failed', code: staged.code, error: staged.error, cleanup: { ok: false, code: 'STAGED_OWNERSHIP_LOST', error: '暂存树指纹读取失败，未执行撤销暂存', errors: [] } }
  }
  const createdStaged = staged.paths
  const stagedCandidate = candidatePathCheck(root, createdStaged.map((path) => ({ path })))
  if (!stagedCandidate.ok) {
    const cleanup = cleanupCreatedStaged(root, createdStaged, staged)
    return failureWithCleanup(root, message, { ok: false, status: 'blocked', code: stagedCandidate.code, error: '暂存路径包含敏感或运行时内容，已撤销本次暂存', paths: stagedCandidate.paths }, cleanup)
  }
  if (!createdStaged.length) return { ...resultBase(root, message), ok: true, status: 'skipped', reason: '无可提交改动', candidateCount: candidatePaths.length }

  const whitespace = runGit(['diff', '--cached', '--check'], { repoRoot: root })
  if (whitespace.code !== 0) {
    const cleanup = cleanupCreatedStaged(root, createdStaged, staged)
    return failureWithCleanup(root, message, { ok: false, status: 'failed', code: 'STAGED_DIFF_CHECK_FAILED', error: trimOutput(whitespace.stderr || whitespace.stdout || '暂存差异检查失败') }, cleanup)
  }

  let validation
  try {
    validation = normalizeValidationResult(validate(root))
  } catch (error) {
    validation = { ok: false, checks: [], error: String(error && error.message || error) }
  }
  if (!validation.ok) {
    const cleanup = cleanupCreatedStaged(root, createdStaged, staged)
    return failureWithCleanup(root, message, { ok: false, status: 'failed', code: 'VALIDATION_FAILED', error: validation.error || '快速验证失败', validation: validation.checks }, cleanup)
  }

  const commit = runGit(['commit', '-m', message], { repoRoot: root, timeoutMs: COMMAND_TIMEOUT_MS })
  if (commit.code !== 0) {
    const cleanup = cleanupCreatedStaged(root, createdStaged, staged)
    return failureWithCleanup(root, message, { ok: false, status: 'failed', code: 'COMMIT_FAILED', error: trimOutput(commit.stderr || commit.stdout || '本地提交失败'), validation: validation.checks }, cleanup)
  }
  const hash = runGit(['rev-parse', '--short', 'HEAD'], { repoRoot: root })
  return {
    ...resultBase(root, message), ok: true, status: 'committed', candidateCount: candidatePaths.length,
    stagedCount: createdStaged.length, validation: validation.checks, commit: hash.code === 0 ? hash.stdout.trim() : null,
  }
}

export function runDailyGitCommit({ repoRoot = DAILY_REPOSITORY, dryRun = false, now = new Date(), validate = runQuickValidations } = {}) {
  const root = resolve(repoRoot)
  const message = `${DAILY_COMMIT_PREFIX} ${formatShanghaiDate(now)}`
  const repository = repositoryIsSafe(root)
  if (!repository.ok) return { ...resultBase(root, message), ok: false, status: 'failed', code: repository.code, error: repository.error }
  const lock = acquireDailyLock(root)
  if (!lock.ok) return { ...resultBase(root, message), ok: false, status: 'blocked', code: lock.code, error: lock.error, lock: lock.path }
  let result
  try {
    result = runDailyGitCommitUnlocked({ repoRoot: root, dryRun, now, validate })
  } finally {
    const released = releaseDailyLock(lock)
    if (result && !released.ok) result.lockRelease = released
  }
  if (result && lock.staleRecovered) result.staleLockRecovered = true
  return result
}

export function parseArgs(argv) {
  const args = { dryRun: false }
  for (const token of argv) {
    if (token === '--dry-run') args.dryRun = true
    else if (token === '--help' || token === '-h') args.help = true
    else throw new Error(`unknown option ${token}`)
  }
  return args
}

export function main(argv = process.argv.slice(2)) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    const result = { ok: false, status: 'failed', code: 'ARGUMENT_INVALID', error: String(error && error.message || error), push: false }
    console.log(JSON.stringify(result))
    process.exitCode = 2
    return result
  }
  if (args.help) {
    const result = { ok: true, status: 'help', usage: 'daily-git-commit.mjs [--dry-run]', repository: DAILY_REPOSITORY, push: false }
    console.log(JSON.stringify(result))
    return result
  }
  const result = runDailyGitCommit({ dryRun: args.dryRun })
  console.log(JSON.stringify(result))
  process.exitCode = result.ok ? 0 : 1
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
