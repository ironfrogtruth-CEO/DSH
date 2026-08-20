// dsh-git — Host half: Git/GitHub 工作流工具集
// 薄封装本地 git 与 gh CLI: status/diff/stage/commit/push/log/branch/PR/review
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const name = 'dsh-git'
export const inject = ['tools', 'subprocess', 'webServer']

const GIT = '/usr/bin/git'
const GH = '/usr/local/bin/gh'
const DSH_HOME = homedir()
const ALLOWED_REPO_ROOTS = [resolve(DSH_HOME, 'Desktop'), resolve(DSH_HOME, '.dsh')]
const WORKSPACE_STORE = join(DSH_HOME, '.dsh', 'storages', 'workspace.json')
const MAX_HTTP_BODY = 128 * 1024
const MAX_DIFF_CHARS = 120_000

export class GitApiError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'GitApiError'
    this.code = code
    this.status = status
  }
}

function inside(root, candidate) {
  const base = resolve(root)
  const value = resolve(candidate)
  return value === base || value.startsWith(base + sep)
}

// 这是路径策略的纯判断部分，API 与工具共用；实际访问还会 realpath 并检查 .git。
export function allowedGitPathCandidate(requested, basePath = '') {
  const raw = typeof requested === 'string' ? requested.trim() : ''
  if (!raw || raw.includes('\0')) return { ok: false, code: 'GIT_PATH_REQUIRED', error: '缺少仓库路径' }
  const normalized = raw.replaceAll('\\', '/')
  if (normalized.split('/').includes('..')) return { ok: false, code: 'GIT_PATH_TRAVERSAL', error: '仓库路径不允许包含 ..' }
  if (!isAbsolute(raw) && !basePath) return { ok: false, code: 'GIT_PATH_ABSOLUTE_REQUIRED', error: '仓库路径必须是已登记工作区内的路径' }
  const candidate = resolve(isAbsolute(raw) ? raw : basePath, isAbsolute(raw) ? '.' : raw)
  if (!ALLOWED_REPO_ROOTS.some((root) => inside(root, candidate))) {
    return { ok: false, code: 'GIT_PATH_OUTSIDE_ALLOWLIST', error: '只允许 /Users/marcus/Desktop 与 /Users/marcus/.dsh 下的 Git 仓库' }
  }
  return { ok: true, candidate }
}

async function resolveRepository(requested, basePath = '') {
  const checked = allowedGitPathCandidate(requested, basePath)
  if (!checked.ok) throw new GitApiError(checked.code, checked.error, 403)
  let repository
  try {
    repository = await realpath(checked.candidate)
  } catch {
    throw new GitApiError('GIT_REPO_NOT_FOUND', '仓库路径不存在', 404)
  }
  if (!ALLOWED_REPO_ROOTS.some((root) => inside(root, repository))) {
    throw new GitApiError('GIT_PATH_SYMLINK_ESCAPE', '仓库路径解析后超出允许范围', 403)
  }
  if (!existsSync(join(repository, '.git'))) {
    throw new GitApiError('GIT_NOT_REPOSITORY', '目标路径不是 Git 仓库', 400)
  }
  return repository
}

export function normalizeGitFiles(value) {
  if (value === undefined || value === null || value === '') return []
  const list = Array.isArray(value) ? value : String(value).split(',')
  const files = list.map((item) => String(item || '').trim()).filter(Boolean)
  for (const file of files) {
    const normalized = file.replaceAll('\\', '/')
    if (normalized.startsWith('/') || normalized.split('/').includes('..') || normalized.includes('\0')) {
      throw new GitApiError('GIT_FILE_PATH_INVALID', `文件路径无效：${file}`, 400)
    }
    if (file.startsWith('-')) throw new GitApiError('GIT_FILE_PATH_INVALID', `文件路径无效：${file}`, 400)
  }
  return files
}

export function validateGitAction(action, body = {}) {
  if ((action === 'commit' || action === 'commit_push') && !String(body.message || '').trim()) {
    return { ok: false, code: 'GIT_MESSAGE_REQUIRED', error: '提交信息不能为空' }
  }
  if ((action === 'push' || action === 'commit_push') && body.confirm !== true) {
    return { ok: false, code: 'GIT_PUSH_CONFIRM_REQUIRED', error: '推送前必须明确确认 confirm=true' }
  }
  return { ok: true }
}

async function run(ctx, argv, cwd, timeoutMs = 30000) {
  const spec = {
    argv,
    cwd: cwd || '/',
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 32 * 1024 * 1024 },
      stderr: { maxBytes: 4 * 1024 * 1024 },
    },
    graceMs: timeoutMs,
  }
  const proc = ctx.subprocess.spawn(spec)
  const outcome = await proc.done
  const collected = proc.collected
  const out = collected && collected.stdout ? collected.stdout.readFrom(0).text : ''
  const err = collected && collected.stderr ? collected.stderr.readFrom(0).text : ''
  return { code: outcome.exitCode, stdout: out, stderr: err }
}

async function resolveCwd(ctx, path) {
  const sp = typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : null
  const root = sp && sp.workspaceRoot ? sp.workspaceRoot : ''
  return resolveRepository(path || root, root)
}

function errOut(r, fallback) {
  return { ok: false, error: ((r.stderr || r.stdout || fallback) + '').slice(0, 800) }
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_HTTP_BODY) throw new GitApiError('GIT_BODY_TOO_LARGE', '请求体过大', 413)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be object')
    return value
  } catch {
    throw new GitApiError('GIT_INVALID_JSON', '请求体不是有效 JSON', 400)
  }
}

function parseStatus(output) {
  return String(output || '').split(/\r?\n/).filter(Boolean).map((line) => {
    const code = line.slice(0, 2)
    return {
      code,
      index: code[0] || ' ',
      worktree: code[1] || ' ',
      path: line.slice(3),
    }
  })
}

function parseLog(output) {
  return String(output || '').split(/\r?\n/).filter(Boolean).map((line) => {
    const [hash = '', date = '', ...message] = line.split('\t')
    return { hash, date, message: message.join('\t') }
  })
}

function capText(value, max = MAX_DIFF_CHARS) {
  const text = String(value || '')
  return text.length > max ? `${text.slice(0, max)}\n…(内容已截断，共 ${text.length} 字符)` : text
}

async function repositorySnapshot(ctx, repository) {
  const [branch, status, log] = await Promise.all([
    run(ctx, [GIT, 'branch', '--show-current'], repository),
    run(ctx, [GIT, 'status', '--short', '--untracked-files=all'], repository),
    run(ctx, [GIT, 'log', '--date=iso-strict', '--format=%h%x09%ad%x09%s', '-n', '8'], repository),
  ])
  if (branch.code !== 0 || status.code !== 0 || log.code !== 0) {
    const failure = [branch, status, log].find((result) => result.code !== 0)
    throw new GitApiError('GIT_READ_FAILED', (failure && (failure.stderr || failure.stdout)) || '读取仓库状态失败', 400)
  }
  const files = parseStatus(status.stdout)
  return {
    branch: branch.stdout.trim() || '(detached)',
    files,
    recentCommits: parseLog(log.stdout),
    hasStaged: files.some((file) => file.index !== ' ' && file.index !== '?'),
  }
}

async function listWorkspaceRepositories() {
  let raw
  try {
    raw = JSON.parse(await readFile(WORKSPACE_STORE, 'utf8'))
  } catch {
    return []
  }
  const table = (raw && raw.tables && raw.tables.workspaces) || {}
  const seen = new Set()
  const workspaces = []
  for (const [id, value] of Object.entries(table)) {
    const requested = value && (value.path || value.root)
    try {
      const path = await resolveRepository(requested)
      if (seen.has(path)) continue
      seen.add(path)
      workspaces.push({
        id,
        name: (value && (value.title || value.name)) || path.split('/').pop() || id,
        path,
      })
    } catch {
      // workspace.json 可能包含已移除目录；只暴露当前允许范围内的真实 Git 仓库。
    }
  }
  return workspaces
}

function safeRef(value, label) {
  const text = String(value || '').trim()
  if (!text || text.startsWith('-') || /[\0\s]/.test(text)) throw new GitApiError('GIT_REF_INVALID', `${label}无效`, 400)
  return text
}

function apiFailure(error) {
  return {
    ok: false,
    code: error && error.code ? error.code : 'GIT_API_ERROR',
    error: String(error && error.message ? error.message : error).slice(0, 800),
  }
}

const COMMON = {
  path: { type: 'string', description: '仓库路径(默认当前工作区)' },
}

export function apply(ctx) {
  const { tools } = ctx

  tools.register(defineTool({
    name: 'git_status',
    description: '查看仓库状态: 当前分支 + 暂存/未暂存/未跟踪文件。',
    parameters: { ...COMMON },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          branch: { type: 'string' },
          status: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? `分支: ${v.branch}\n${v.status}` : `失败: ${v.error}` }],
    },
    timeoutMs: 30000,
    async execute(args) {
      const cwd = await resolveCwd(ctx, args.path)
      const b = await run(ctx, [GIT, 'branch', '--show-current'], cwd)
      const s = await run(ctx, [GIT, 'status', '--short'], cwd)
      if (b.code !== 0) return errOut(b, '不是 git 仓库?')
      return { ok: true, branch: b.stdout.trim() || '(detached)', status: s.stdout || '(clean)' }
    },
    presentCall() {
      return { card: 'generic', title: 'Git status' }
    },
  }))

  tools.register(defineTool({
    name: 'git_diff',
    description: '查看工作区差异(未暂存默认; staged=true 查看已暂存)。',
    parameters: {
      ...COMMON,
      staged: { type: 'boolean', description: '查看已暂存差异(默认 false)' },
      stat: { type: 'boolean', description: '只输出统计(默认 false)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          diff: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.diff : `失败: ${v.error}` }],
    },
    timeoutMs: 30000,
    async execute(args) {
      const cwd = await resolveCwd(ctx, args.path)
      const argv = [GIT, 'diff']
      if (args.staged) argv.push('--cached')
      if (args.stat) argv.push('--stat')
      const r = await run(ctx, argv, cwd)
      if (r.code !== 0) return errOut(r, 'git diff 失败')
      return { ok: true, diff: r.stdout || '(无差异)' }
    },
    presentCall(args) {
      return { card: 'generic', title: `Git diff${args.staged ? ' (staged)' : ''}` }
    },
  }))

  tools.register(defineTool({
    name: 'git_stage',
    description: '暂存文件(git add)。files 为空时暂存全部。',
    parameters: {
      ...COMMON,
      files: { type: 'string', description: '文件路径,逗号分隔(默认全部)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, error: { type: 'string' } },
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? '已暂存' : `失败: ${v.error}` }],
    },
    timeoutMs: 30000,
    async execute(args) {
      const cwd = await resolveCwd(ctx, args.path)
      const files = normalizeGitFiles(args.files)
      const argv = files.length ? [GIT, 'add', '--', ...files] : [GIT, 'add', '-A']
      const r = await run(ctx, argv, cwd)
      if (r.code !== 0) return errOut(r, 'git add 失败')
      return { ok: true, action: 'stage', files: files.length ? files : ['*'] }
    },
    presentCall() {
      return { card: 'generic', title: 'Git stage' }
    },
  }))

  tools.register(defineTool({
    name: 'git_unstage',
    description: '取消暂存(git restore --staged)。files 为空时全部取消。',
    parameters: {
      ...COMMON,
      files: { type: 'string', description: '文件路径,逗号分隔(默认全部)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, error: { type: 'string' } },
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? '已取消暂存' : `失败: ${v.error}` }],
    },
    timeoutMs: 30000,
    async execute(args) {
      const cwd = await resolveCwd(ctx, args.path)
      const files = normalizeGitFiles(args.files)
      const argv = [GIT, 'restore', '--staged', '--', ...(files.length ? files : ['.'])]
      const r = await run(ctx, argv, cwd)
      if (r.code !== 0) return errOut(r, '取消暂存失败')
      return { ok: true, action: 'unstage', files: files.length ? files : ['*'] }
    },
    presentCall() {
      return { card: 'generic', title: 'Git unstage' }
    },
  }))

  tools.register(defineTool({
    name: 'git_commit',
    description: '提交已暂存改动。若无暂存内容会报错(先 git_stage)。',
    parameters: {
      ...COMMON,
      message: { type: 'string', required: true, description: '提交信息' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, output: { type: 'string' }, error: { type: 'string' } },
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.output : `失败: ${v.error}` }],
    },
    timeoutMs: 30000,
    async execute(args) {
      const cwd = await resolveCwd(ctx, args.path)
      if (!String(args.message || '').trim()) return { ok: false, error: '提交信息不能为空', code: 'GIT_MESSAGE_REQUIRED' }
      const check = await run(ctx, [GIT, 'diff', '--cached', '--quiet'], cwd)
      if (check.code !== 0 && check.stderr) return errOut(check, 'git 检查失败')
      if (check.code === 1 && check.stdout === '' && check.stderr === '') {
        // --quiet 退出码 1 表示有差异; 0 表示无差异。有差异时 stdout/stderr 为空。
      }
      const hasChanges = check.code === 1
      if (!hasChanges) return { ok: false, error: '没有已暂存的改动,请先 git_stage' }
      const r = await run(ctx, [GIT, 'commit', '-m', args.message], cwd)
      if (r.code !== 0) return errOut(r, '提交失败')
      return { ok: true, output: (r.stdout + r.stderr).slice(0, 800) }
    },
    presentCall() {
      return { card: 'generic', title: 'Git commit' }
    },
  }))

  tools.register(defineTool({
    name: 'git_push',
    description: '推送当前分支到远端。',
    parameters: {
      ...COMMON,
      remote: { type: 'string', description: '远端名(默认 origin)' },
      branch: { type: 'string', description: '分支(默认当前分支)' },
      setUpstream: { type: 'boolean', description: '设置上游(-u,默认 true)' },
      confirm: { type: 'boolean', required: true, description: '必须明确传 true 才允许推送' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, output: { type: 'string' }, error: { type: 'string' } },
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.output : `失败: ${v.error}` }],
    },
    timeoutMs: 60000,
    async execute(args) {
      const guard = validateGitAction('push', args)
      if (!guard.ok) return guard
      const cwd = await resolveCwd(ctx, args.path)
      const argv = [GIT, 'push']
      if (args.setUpstream !== false) argv.push('-u')
      if (args.remote) argv.push(args.remote)
      if (args.branch) argv.push(args.branch)
      const r = await run(ctx, argv, cwd, 60000)
      if (r.code !== 0) return errOut(r, '推送失败')
      return { ok: true, output: (r.stdout + r.stderr).slice(0, 800) }
    },
    presentCall() {
      return { card: 'generic', title: 'Git push' }
    },
  }))

  tools.register(defineTool({
    name: 'git_log',
    description: '查看提交历史。',
    parameters: {
      ...COMMON,
      n: { type: 'number', description: '条数(默认 10)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, log: { type: 'string' }, error: { type: 'string' } },
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.log : `失败: ${v.error}` }],
    },
    timeoutMs: 30000,
    async execute(args) {
      const cwd = await resolveCwd(ctx, args.path)
      const r = await run(ctx, [GIT, 'log', '--oneline', '-n', String(args.n || 10)], cwd)
      if (r.code !== 0) return errOut(r, 'git log 失败')
      return { ok: true, log: r.stdout || '(空)' }
    },
    presentCall() {
      return { card: 'generic', title: 'Git log' }
    },
  }))

  tools.register(defineTool({
    name: 'git_branch',
    description: '查看分支。',
    parameters: { ...COMMON },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, branches: { type: 'string' }, error: { type: 'string' } },
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.branches : `失败: ${v.error}` }],
    },
    timeoutMs: 30000,
    async execute(args) {
      const cwd = await resolveCwd(ctx, args.path)
      const r = await run(ctx, [GIT, 'branch', '-a'], cwd)
      if (r.code !== 0) return errOut(r, 'git branch 失败')
      return { ok: true, branches: r.stdout || '(无分支)' }
    },
    presentCall() {
      return { card: 'generic', title: 'Git branch' }
    },
  }))

  tools.register(defineTool({
    name: 'git_pr_create',
    description: '用 gh 为当前分支创建 PR(需 gh 已登录)。',
    parameters: {
      ...COMMON,
      title: { type: 'string', required: true, description: 'PR 标题' },
      body: { type: 'string', description: 'PR 描述' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, url: { type: 'string' }, error: { type: 'string' } },
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? `PR 已创建: ${v.url}` : `失败: ${v.error}` }],
    },
    timeoutMs: 60000,
    async execute(args) {
      const cwd = await resolveCwd(ctx, args.path)
      const auth = await run(ctx, [GH, 'auth', 'status'], cwd)
      if (auth.code !== 0) return errOut(auth, 'gh 未登录,请先运行 gh auth login')
      const argv = [GH, 'pr', 'create', '--title', args.title]
      if (args.body) argv.push('--body', args.body)
      const r = await run(ctx, argv, cwd, 60000)
      if (r.code !== 0) return errOut(r, '创建 PR 失败')
      const url = (r.stdout.trim().match(/https?:\/\/\S+/g) || [])[0] || r.stdout.trim()
      return { ok: true, url }
    },
    presentCall() {
      return { card: 'generic', title: 'Create PR' }
    },
  }))

  tools.register(defineTool({
    name: 'git_pr_view',
    description: '查看 PR 详情与评论(gh pr view + diff)。',
    parameters: {
      ...COMMON,
      number: { type: 'string', description: 'PR 编号(默认当前分支的 PR)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, view: { type: 'string' }, error: { type: 'string' } },
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.view : `失败: ${v.error}` }],
    },
    timeoutMs: 60000,
    async execute(args) {
      const cwd = await resolveCwd(ctx, args.path)
      const argv = [GH, 'pr', 'view', ...(args.number ? [args.number] : []), '--json', 'number,title,state,body,author,additions,deletions,comments,reviews']
      const r = await run(ctx, argv, cwd, 60000)
      if (r.code !== 0) return errOut(r, 'gh pr view 失败')
      return { ok: true, view: r.stdout }
    },
    presentCall() {
      return { card: 'generic', title: 'View PR' }
    },
  }))

  tools.register(defineTool({
    name: 'git_review',
    description: '审查当前分支相对基准分支的改动: 返回差异全文供模型审查,并附统计。',
    parameters: {
      ...COMMON,
      base: { type: 'string', description: '基准分支(默认 origin/main 或 origin/master)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          base: { type: 'string' },
          stats: { type: 'string' },
          diff: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? `基准: ${v.base}\n${v.stats}\n${v.diff}` : `失败: ${v.error}` }],
    },
    timeoutMs: 60000,
    async execute(args) {
      const cwd = await resolveCwd(ctx, args.path)
      const branch = await run(ctx, [GIT, 'branch', '--show-current'], cwd)
      const cur = branch.stdout.trim()
      const bases = args.base ? [args.base] : ['origin/main', 'origin/master']
      let base = null
      for (const b of bases) {
        const chk = await run(ctx, [GIT, 'rev-parse', '--verify', b], cwd)
        if (chk.code === 0) { base = b; break }
      }
      if (!base) return { ok: false, error: '找不到基准分支(origin/main 或 origin/master),请指定 base' }
      const range = base + '...' + cur
      const stats = await run(ctx, [GIT, 'diff', '--stat', range], cwd)
      const diff = await run(ctx, [GIT, 'diff', range], cwd, 60000)
      if (diff.code !== 0) return errOut(diff, 'git diff 失败')
      const maxBytes = 60000
      const text = diff.stdout.length > maxBytes ? diff.stdout.slice(0, maxBytes) + `\n…(截断, 共 ${diff.stdout.length} 字符)` : diff.stdout
      return { ok: true, base, stats: stats.stdout || '(无)', diff: text || '(无差异)' }
    },
    presentCall() {
      return { card: 'generic', title: 'Review branch' }
    },
  }))

  const registerApi = (path, handler) => ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      try {
        await handler(req, res)
      } catch (error) {
        const failure = apiFailure(error)
        sendJson(res, error instanceof GitApiError ? error.status : 500, failure)
      }
    },
  })

  ctx.effect(() => registerApi('/api/dsh-git/workspaces', async (_req, res) => {
    const repositories = await listWorkspaceRepositories()
    try {
      const path = await resolveRepository(join(DSH_HOME, '.dsh'))
      if (!repositories.some((item) => item.path === path)) repositories.unshift({ id: 'dsh-home', name: '大神配置', path })
    } catch {
      // .dsh 尚未初始化为仓库时不展示。
    }
    sendJson(res, 200, { ok: true, repositories })
  }), 'dsh-git: workspaces api')

  ctx.effect(() => registerApi('/api/dsh-git/status', async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const repository = await resolveRepository(url.searchParams.get('path') || '')
    const snapshot = await repositorySnapshot(ctx, repository)
    sendJson(res, 200, { ok: true, repository, ...snapshot })
  }), 'dsh-git: status api')

  ctx.effect(() => registerApi('/api/dsh-git/diff', async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const repository = await resolveRepository(url.searchParams.get('path') || '')
    const staged = url.searchParams.get('staged') === '1'
    const files = normalizeGitFiles(url.searchParams.get('file') || '')
    const argv = [GIT, 'diff', '--no-ext-diff', '--no-color']
    if (staged) argv.push('--cached')
    if (files.length) argv.push('--', ...files)
    const result = await run(ctx, argv, repository)
    if (result.code !== 0) throw new GitApiError('GIT_DIFF_FAILED', result.stderr || result.stdout || '读取差异失败', 400)
    sendJson(res, 200, { ok: true, repository, staged, file: files[0] || '', diff: capText(result.stdout || '(无可显示差异)') })
  }), 'dsh-git: diff api')

  ctx.effect(() => registerApi('/api/dsh-git/action', async (req, res) => {
    if (req.method !== 'POST') throw new GitApiError('GIT_METHOD_NOT_ALLOWED', '只允许 POST', 405)
    const body = await readJsonBody(req)
    const action = String(body.action || '').trim()
    const guard = validateGitAction(action, body)
    if (!guard.ok) throw new GitApiError(guard.code, guard.error, 400)
    const repository = await resolveRepository(body.path || '')
    const files = normalizeGitFiles(body.files)
    let result
    if (action === 'stage') {
      result = await run(ctx, files.length ? [GIT, 'add', '--', ...files] : [GIT, 'add', '-A'], repository)
    } else if (action === 'unstage') {
      result = await run(ctx, [GIT, 'restore', '--staged', '--', ...(files.length ? files : ['.'])], repository)
    } else if (action === 'commit') {
      const check = await run(ctx, [GIT, 'diff', '--cached', '--quiet'], repository)
      if (check.code === 0) throw new GitApiError('GIT_NOTHING_STAGED', '没有已暂存的改动', 400)
      if (check.code !== 1) throw new GitApiError('GIT_STAGED_CHECK_FAILED', check.stderr || '无法检查暂存区', 400)
      result = await run(ctx, [GIT, 'commit', '-m', String(body.message).trim()], repository, 60000)
    } else if (action === 'commit_push') {
      const stage = await run(ctx, [GIT, 'add', '-A'], repository)
      if (stage.code !== 0) throw new GitApiError('GIT_STAGE_FAILED', stage.stderr || stage.stdout || '暂存失败', 400)
      const commit = await run(ctx, [GIT, 'commit', '-m', String(body.message).trim()], repository, 60000)
      if (commit.code !== 0) throw new GitApiError('GIT_COMMIT_FAILED', commit.stderr || commit.stdout || '提交失败', 400)
      const branchResult = await run(ctx, [GIT, 'branch', '--show-current'], repository)
      const branch = safeRef(body.branch || branchResult.stdout.trim(), '分支')
      const remote = safeRef(body.remote || 'origin', '远端')
      const upstream = await run(ctx, [GIT, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repository)
      const push = await run(ctx, upstream.code === 0 ? [GIT, 'push', remote, branch] : [GIT, 'push', '-u', remote, branch], repository, 90000)
      if (push.code !== 0) {
        throw new GitApiError('GIT_PUSH_FAILED_AFTER_COMMIT', `本地已提交，但推送失败：${push.stderr || push.stdout || '未知错误'}`, 502)
      }
      result = { code: 0, stdout: `${commit.stdout || commit.stderr}\n${push.stdout || push.stderr}` }
    } else if (action === 'push') {
      const branchResult = await run(ctx, [GIT, 'branch', '--show-current'], repository)
      const branch = safeRef(body.branch || branchResult.stdout.trim(), '分支')
      const remote = safeRef(body.remote || 'origin', '远端')
      const upstream = await run(ctx, [GIT, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repository)
      result = await run(ctx, upstream.code === 0 ? [GIT, 'push', remote, branch] : [GIT, 'push', '-u', remote, branch], repository, 90000)
    } else {
      throw new GitApiError('GIT_ACTION_UNSUPPORTED', '不支持的 Git 操作', 400)
    }
    if (result.code !== 0) throw new GitApiError('GIT_ACTION_FAILED', result.stderr || result.stdout || 'Git 操作失败', 400)
    const snapshot = await repositorySnapshot(ctx, repository)
    sendJson(res, 200, { ok: true, action, output: capText(result.stdout || result.stderr || '操作完成', 4000), repository, ...snapshot })
  }), 'dsh-git: action api')
}
