#!/usr/bin/env node

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

export const RETENTION_DAYS = 45
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000
const SCRIPT_VERSION = '1.0.0'
const CURRENT_UID = typeof process.getuid === 'function' ? process.getuid() : -1
const TEST_MODE = process.env.DSH_WEEKLY_CLEANUP_TEST_MODE === '1'
const requestedMode = process.argv.slice(2)

if (requestedMode.some((arg) => !['--dry-run', '--execute'].includes(arg))
  || requestedMode.filter((arg) => arg === '--dry-run' || arg === '--execute').length > 1) {
  process.stderr.write('Usage: weekly-safe-cleanup.mjs [--dry-run|--execute]\n')
  process.exit(2)
}

const mode = requestedMode.includes('--execute') ? 'execute' : 'dry-run'
const now = Date.now()
const runId = new Date(now).toISOString().replace(/[-:.]/g, '').replace('Z', 'Z')
const userHome = homedir()

function command(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 10 * 60 * 1000,
    cwd: options.cwd,
    env: options.env || process.env,
  })
}

function getDarwinTempDir() {
  const result = command('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'])
  if (result.status !== 0 || !String(result.stdout || '').trim()) return ''
  return String(result.stdout).trim().replace(/\/$/, '')
}

const testRoot = TEST_MODE ? resolve(String(process.env.DSH_WEEKLY_CLEANUP_TEST_ROOT || '')) : ''
if (TEST_MODE && (!testRoot || testRoot === '/' || !statSafe(join(testRoot, '.weekly-safe-cleanup-test-root')))) {
  process.stderr.write('Invalid weekly cleanup test root.\n')
  process.exit(2)
}

const reportRoot = TEST_MODE
  ? join(testRoot, 'reports')
  : join(userHome, '.dsh', 'cleanup-reports', 'weekly-safe-cleanup')

const cacheRoots = TEST_MODE
  ? [
      { label: 'library-caches', path: join(testRoot, 'Library', 'Caches'), policy: 'all' },
      { label: 'dot-cache', path: join(testRoot, '.cache'), policy: 'all' },
      { label: 'user-temp', path: join(testRoot, 'user-temp'), policy: 'all' },
      { label: 'private-tmp', path: join(testRoot, 'private-tmp'), policy: 'temp-prefix' },
    ]
  : [
      { label: 'library-caches', path: join(userHome, 'Library', 'Caches'), policy: 'all' },
      { label: 'dot-cache', path: join(userHome, '.cache'), policy: 'all' },
      { label: 'npm-cache', path: join(userHome, '.npm', '_cacache'), policy: 'all' },
      { label: 'xcode-derived-data', path: join(userHome, 'Library', 'Developer', 'Xcode', 'DerivedData'), policy: 'all' },
      { label: 'user-temp', path: getDarwinTempDir(), policy: 'all' },
      { label: 'private-tmp', path: '/private/tmp', policy: 'temp-prefix' },
    ]

const report = {
  schema: 'dsh_weekly_safe_cleanup_report.v1',
  version: SCRIPT_VERSION,
  run_id: runId,
  mode,
  retention_days: RETENTION_DAYS,
  started_at: new Date(now).toISOString(),
  status: 'running',
  roots: [],
  candidates: [],
  git: [],
  deleted_count: 0,
  deleted_logical_kib: 0,
  skipped_count: 0,
  blocked_count: 0,
  physical_available_before_bytes: diskAvailableBytes(),
  physical_available_after_bytes: null,
  physical_released_bytes: 0,
  summary: '',
}

function statSafe(target) {
  try { return lstatSync(target) } catch { return null }
}

function diskAvailableBytes() {
  try {
    const value = statfsSync(TEST_MODE ? testRoot : '/System/Volumes/Data')
    return Number(value.bavail) * Number(value.bsize)
  } catch {
    return null
  }
}

function canonical(target) {
  try { return realpathSync(target) } catch { return '' }
}

function logicalKib(target) {
  const result = command('/usr/bin/du', ['-sk', target], { timeout: 30 * 60 * 1000 })
  if (result.status !== 0) return null
  const value = Number.parseInt(String(result.stdout || '').trim().split(/\s+/)[0], 10)
  return Number.isFinite(value) ? value : null
}

function tempPrefixAllowed(name) {
  return /^(tmp|temp|dsh-|dashen-|codex-|cybermarcus-|playwright-|pytest-|pip-|npm-|swift-|pingan-|pafc-|ehr_|article-|font-home)/i.test(name)
    || /\.(tmp|cache)$/i.test(name)
}

function lsofSnapshot() {
  if (TEST_MODE && process.env.DSH_WEEKLY_CLEANUP_TEST_LSOF_FAIL === '1') {
    return { ok: false, error: 'TEST_LSOF_FAILED', text: '' }
  }
  if (TEST_MODE && process.env.DSH_WEEKLY_CLEANUP_TEST_LSOF_SNAPSHOT) {
    try {
      return { ok: true, text: readFileSync(process.env.DSH_WEEKLY_CLEANUP_TEST_LSOF_SNAPSHOT, 'utf8') }
    } catch (error) {
      return { ok: false, error: String(error), text: '' }
    }
  }
  const result = command('/usr/sbin/lsof', ['-nP'], { timeout: 15 * 60 * 1000 })
  if (result.status !== 0 || String(result.stderr || '').trim()) {
    return { ok: false, error: String(result.stderr || `lsof exit ${result.status}`).slice(-2000), text: '' }
  }
  return { ok: true, text: String(result.stdout || '') }
}

function writeReport() {
  mkdirSync(reportRoot, { recursive: true, mode: 0o700 })
  const target = join(reportRoot, `${runId}.json`)
  const temporary = `${target}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, target)
  const latestTemporary = join(reportRoot, `.latest.tmp-${process.pid}`)
  writeFileSync(latestTemporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  renameSync(latestTemporary, join(reportRoot, 'latest.json'))
  const history = readdirSync(reportRoot)
    .filter((name) => /^\d{8}T\d{6}\d*Z\.json$/.test(name))
    .sort()
  for (const stale of history.slice(0, Math.max(0, history.length - 60))) {
    rmSync(join(reportRoot, stale), { force: false })
  }
  return target
}

function finish(status, summary, exitCode = 0) {
  report.status = status
  report.finished_at = new Date().toISOString()
  report.physical_available_after_bytes = diskAvailableBytes()
  if (report.physical_available_before_bytes !== null && report.physical_available_after_bytes !== null) {
    report.physical_released_bytes = Math.max(0, report.physical_available_after_bytes - report.physical_available_before_bytes)
  }
  report.summary = summary
  const reportPath = writeReport()
  process.stdout.write(`${JSON.stringify({
    status,
    summary,
    report: reportPath,
    deleted_count: report.deleted_count,
    deleted_logical_kib: report.deleted_logical_kib,
    blocked_count: report.blocked_count,
  })}\n`)
  process.exit(exitCode)
}

const handles = lsofSnapshot()
if (!handles.ok) {
  report.blocked_count += 1
  report.errors = [{ code: 'LSOF_SNAPSHOT_FAILED', detail: handles.error }]
  finish('blocked', '全盘安全清理已阻断：无法取得进程句柄快照，未删除任何内容', 2)
}

for (const rootConfig of cacheRoots) {
  if (!rootConfig.path) continue
  const rootStat = statSafe(rootConfig.path)
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) continue
  const rootReal = canonical(rootConfig.path)
  if (!rootReal || rootReal === '/' || rootReal === userHome) continue
  const rootReceipt = { label: rootConfig.label, path: rootReal, policy: rootConfig.policy, scanned: 0 }
  report.roots.push(rootReceipt)
  let children = []
  try { children = readdirSync(rootReal) } catch (error) {
    report.blocked_count += 1
    report.candidates.push({ root: rootConfig.label, path: rootReal, action: 'blocked', reason: `READDIR_FAILED:${error.code || error}` })
    continue
  }
  for (const name of children) {
    rootReceipt.scanned += 1
    const target = join(rootReal, name)
    const item = statSafe(target)
    const receipt = { root: rootConfig.label, path: target, action: 'skipped', reason: '', logical_kib: null }
    if (!item || item.isSymbolicLink()) receipt.reason = 'INVALID_OR_SYMLINK'
    else if (item.uid !== CURRENT_UID) receipt.reason = 'OWNER_MISMATCH'
    else if (dirname(target) !== rootReal) receipt.reason = 'PARENT_MISMATCH'
    else if (now - item.mtimeMs < RETENTION_MS) receipt.reason = 'YOUNGER_THAN_45_DAYS'
    else if (rootConfig.policy === 'temp-prefix' && !tempPrefixAllowed(name)) receipt.reason = 'TEMP_NAME_NOT_ALLOWLISTED'
    else {
      const targetReal = canonical(target)
      if (!targetReal || dirname(targetReal) !== rootReal) receipt.reason = 'REALPATH_BOUNDARY_FAILED'
      else if (handles.text.includes(targetReal)) receipt.reason = 'ACTIVE_PROCESS_HANDLE'
      else {
        receipt.logical_kib = logicalKib(targetReal)
        if (receipt.logical_kib === null) receipt.reason = 'DU_FAILED'
        else if (mode === 'dry-run') {
          receipt.action = 'would_delete'
          receipt.reason = 'SAFE_REGENERABLE_45D'
        } else {
          try {
            rmSync(targetReal, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 })
            receipt.action = 'deleted'
            receipt.reason = 'SAFE_REGENERABLE_45D'
            report.deleted_count += 1
            report.deleted_logical_kib += receipt.logical_kib
          } catch (error) {
            receipt.action = 'blocked'
            receipt.reason = `DELETE_FAILED:${error.code || error}`
            report.blocked_count += 1
            report.candidates.push(receipt)
            finish('blocked', '全盘安全清理部分阻断：删除失败，已停止后续清理', 2)
          }
        }
      }
    }
    if (receipt.action === 'skipped') report.skipped_count += 1
    report.candidates.push(receipt)
  }
}

function gitInfo(target) {
  const topResult = command('/usr/bin/git', ['-C', target, 'rev-parse', '--show-toplevel'])
  if (topResult.status !== 0) return null
  const top = canonical(String(topResult.stdout || '').trim())
  if (!top) return null
  const status = command('/usr/bin/git', ['-C', top, 'status', '--porcelain=v1', '--untracked-files=all'])
  const upstream = command('/usr/bin/git', ['-C', top, 'rev-list', '--count', '@{upstream}..HEAD'])
  const prune = command('/usr/bin/git', ['-C', top, 'worktree', 'prune', '--dry-run', '--verbose'])
  return {
    path: top,
    dirty: Boolean(String(status.stdout || '').trim()) || status.status !== 0,
    unpushed_count: upstream.status === 0 ? Number.parseInt(String(upstream.stdout).trim(), 10) || 0 : null,
    has_upstream: upstream.status === 0,
    worktree_prune_dry_run: String(prune.stdout || prune.stderr || '').trim(),
    action: 'report_only',
    reason: 'Git 仓库和 worktree 不做自动删除；需同时证明无任务引用、无脏改且已同步上游',
  }
}

const gitSeeds = TEST_MODE
  ? [join(testRoot, 'git-dirty'), join(testRoot, 'git-clean')]
  : [join(userHome, '.dsh'), join(userHome, 'Desktop', '虾缸')]
const codexWorktrees = TEST_MODE ? join(testRoot, 'codex-worktrees') : join(userHome, '.codex', 'worktrees')
try {
  for (const name of readdirSync(codexWorktrees)) gitSeeds.push(join(codexWorktrees, name))
} catch { /* optional root */ }
const seenGit = new Set()
for (const seed of gitSeeds) {
  const info = gitInfo(seed)
  if (!info || seenGit.has(info.path)) continue
  seenGit.add(info.path)
  report.git.push(info)
}

const selected = report.candidates.filter((item) => item.action === 'deleted' || item.action === 'would_delete').length
const verb = mode === 'execute' ? `删除 ${report.deleted_count} 项` : `试跑发现 ${selected} 项可清理`
finish('ok', `大神每周全盘安全清理完成：${verb}；45 天门槛已执行；Git/worktree ${report.git.length} 个仅做保护性盘点`)
