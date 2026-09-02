#!/usr/local/bin/node
/**
 * Never Stop — 周四版合并心跳 wrapper（黑豹·编排-06，2026-09-02）。
 *
 * 背景：原「Git 快照心跳」（git-daily-commit，周四 23:30）与「Never Stop」
 * （reliable-evolution-weekly，周二 08:30）合二为一。weekly-evolution-review.mjs
 * 的 preflight 要求 ~/.dsh 工作树干净（status --porcelain 非空即跳过），
 * 因此本脚本必须先做本地快照提交、再启动评审。
 *
 * 流程：
 *   1. git -C /Users/marcus/.dsh status --porcelain --untracked-files=all
 *      非空 → git add -A + git commit -m "chore(backup): auto snapshot
 *      before Never Stop weekly review <YYYY-MM-DD>"（沿用 daily-git-commit
 *      的约定：只本地 commit、永不 push；commit 失败则终止并输出明确错误）。
 *      干净 → 跳过提交，直接评审。
 *   2. spawn `node /Users/marcus/.dsh/scripts/weekly-evolution-review.mjs
 *      --execute`，继承 stdio，退出码透传。
 *
 * 用法：
 *   never-stop-thursday.mjs            # 真实执行（快照提交 + 评审）
 *   never-stop-thursday.mjs --execute  # 同上（host 心跳调用形式）
 *   never-stop-thursday.mjs --dry-run  # 只打印将执行的步骤，不做任何改动
 */
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const REPO_ROOT = '/Users/marcus/.dsh'
const REVIEW_SCRIPT = '/Users/marcus/.dsh/scripts/weekly-evolution-review.mjs'
const NODE = '/usr/local/bin/node'
const GIT = '/usr/bin/git'
const COMMIT_MESSAGE_PREFIX = 'chore(backup): auto snapshot before Never Stop weekly review'
const COMMAND_TIMEOUT_MS = 120_000

function shanghaiDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value)
  const fields = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return `${fields.year}-${fields.month}-${fields.day}`
}

function runGit(args) {
  const result = spawnSync(GIT, ['-C', REPO_ROOT, ...args], {
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
  return {
    code: Number.isInteger(result.status) ? result.status : 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error || null,
  }
}

function fail(message, detail = '') {
  console.error(`[never-stop-thursday] 失败：${message}`)
  if (detail) console.error(detail.trimEnd())
  process.exit(1)
}

function parseArgs(argv) {
  const args = { dryRun: false, execute: false }
  for (const token of argv) {
    if (token === '--dry-run') args.dryRun = true
    else if (token === '--execute') args.execute = true
    else fail(`未知参数 ${token}（仅支持 --dry-run / --execute）`)
  }
  return args
}

function snapshotStep(dryRun) {
  const status = runGit(['status', '--porcelain', '--untracked-files=all'])
  if (status.code !== 0) fail('读取 git status 失败，工作树状态未知，拒绝继续', status.stderr || status.stdout)
  const dirtyLines = status.stdout.split('\n').filter((line) => line.trim() !== '')
  const dirtyCount = dirtyLines.length

  if (dirtyCount === 0) {
    console.log('[never-stop-thursday] 工作树干净，无需快照提交，直接进入评审')
    return
  }

  if (dryRun) {
    console.log(`[never-stop-thursday] [dry-run] 检测到 ${dirtyCount} 条脏记录`)
    console.log(`[never-stop-thursday] [dry-run] 将提交 ${dirtyCount} 条脏记录 → 将执行评审`)
    console.log(`[never-stop-thursday] [dry-run] 将执行: git -C ${REPO_ROOT} add -A`)
    console.log(`[never-stop-thursday] [dry-run] 将执行: git -C ${REPO_ROOT} commit -m "${COMMIT_MESSAGE_PREFIX} ${shanghaiDate()}"`)
    return
  }

  console.log(`[never-stop-thursday] 检测到 ${dirtyCount} 条脏记录，开始本地快照提交（绝不 push）`)
  const add = runGit(['add', '-A'])
  if (add.code !== 0) fail('git add -A 失败，未创建快照，评审不会启动', add.stderr || add.stdout)

  const commit = runGit(['commit', '-m', `${COMMIT_MESSAGE_PREFIX} ${shanghaiDate()}`])
  if (commit.code !== 0) fail('git commit 失败，快照未落库，评审不会启动（请检查 git 身份配置或仓库锁）', commit.stderr || commit.stdout)

  const hash = runGit(['rev-parse', '--short', 'HEAD'])
  console.log(`[never-stop-thursday] 快照提交成功：${hash.code === 0 ? hash.stdout.trim() : '(hash 未知)'}（${dirtyCount} 条脏记录）`)
}

function reviewStep(dryRun) {
  const commandLine = `${NODE} ${REVIEW_SCRIPT} --execute`
  if (dryRun) {
    console.log(`[never-stop-thursday] [dry-run] 将执行评审: ${commandLine}（cwd=${REPO_ROOT}，继承 stdio）`)
    return
  }
  console.log(`[never-stop-thursday] 启动评审: ${commandLine}`)
  const child = spawn(NODE, [REVIEW_SCRIPT, '--execute'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    windowsHide: true,
  })
  // 透传中断信号，保证 wrapper 被杀时评审子进程一起退出。
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal))
  }
  child.on('error', (error) => fail(`评审进程启动失败：${error && error.message}`))
  child.on('close', (code, signal) => {
    if (signal) {
      console.error(`[never-stop-thursday] 评审进程被信号 ${signal} 终止`)
      process.exit(1)
    }
    process.exitCode = Number.isInteger(code) ? code : 1
  })
}

const scriptPath = resolve(process.argv[1] || '')
if (scriptPath === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  const mode = args.dryRun ? '[dry-run] ' : ''
  console.log(`[never-stop-thursday] ${mode}Never Stop 周四心跳启动（先快照提交，再评审）`)
  snapshotStep(args.dryRun)
  reviewStep(args.dryRun)
}
