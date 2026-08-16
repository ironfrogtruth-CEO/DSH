// dsh-git — Host half: Git/GitHub 工作流工具集
// 薄封装本地 git 与 gh CLI: status/diff/stage/commit/push/log/branch/PR/review
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-git'
export const inject = ['tools', 'subprocess']

const GIT = '/usr/bin/git'
const GH = '/usr/local/bin/gh'

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
  if (path) {
    const sp = ctx.get('sandboxPolicy')
    const root = sp && sp.workspaceRoot ? sp.workspaceRoot : '/'
    return path.startsWith('/') ? path : root + '/' + path
  }
  const sp = ctx.get('sandboxPolicy')
  return (sp && sp.workspaceRoot ? sp.workspaceRoot : '/') || '/'
}

function errOut(r, fallback) {
  return { ok: false, error: ((r.stderr || r.stdout || fallback) + '').slice(0, 800) }
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
      const argv = [GIT, 'add', ...(args.files ? args.files.split(',').map((f) => f.trim()).filter(Boolean) : ['.'])]
      const r = await run(ctx, argv, cwd)
      if (r.code !== 0) return errOut(r, 'git add 失败')
      return { ok: true }
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
      const argv = [GIT, 'restore', '--staged', ...(args.files ? args.files.split(',').map((f) => f.trim()).filter(Boolean) : ['.'])]
      const r = await run(ctx, argv, cwd)
      if (r.code !== 0) return errOut(r, '取消暂存失败')
      return { ok: true }
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
}
