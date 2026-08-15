// shrimp-shell — Host half: 虾缸品牌资源 + 会话产物 API
// 路由:
//   /api/shrimp/assets/*      — 虾缸 wordmark 图片(明/暗)
//   /api/shrimp/files         — 会话工作区产物文件(会话开始后修改的文件)
//   /api/shrimp/tree          — 目录列表(文件树)
//   /api/shrimp/read          — 文本预览
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-shrimp-shell'

export const inject = ['fs', 'sessionQuery', 'shell', 'webServer']

const ASSETS = join(homedir(), '.dsh', 'extensions', 'shrimp-shell', 'assets')

const sendJson = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function parseQuery(url) {
  const q = {}
  const i = url.indexOf('?')
  if (i < 0) return q
  for (const pair of url.slice(i + 1).split('&')) {
    const [k, v] = pair.split('=')
    if (k) q[decodeURIComponent(k)] = decodeURIComponent(v || '')
  }
  return q
}

const SCAN_CODE = [
  'import os,json,sys',
  'root=sys.argv[1]; since=float(sys.argv[2])',
  "skip=set('node_modules .git .runtime .venv .cache dist build .dsh __pycache__ .hermes .trash Library .npm .codex .gemini .ollama .pytest_cache .turbo coverage tmp .tmp'.split())",
  'out=[]',
  'for dp,dn,fn in os.walk(root):',
  "  dn[:]=[d for d in dn if d not in skip]",
  '  for f in fn:',
  '    p=os.path.join(dp,f)',
  '    try:',
  '      st=os.stat(p)',
  '      if st.st_mtime>=since and st.st_size<200*1024*1024:',
  '        out.append([f,p,st.st_size,int(st.st_mtime)])',
  '    except Exception:',
  '      pass',
  'out.sort(key=lambda x:-x[3])',
  "print(json.dumps(out[:400],ensure_ascii=False))",
].join('\n')

export function apply(ctx) {
  const fs = ctx.fs

  // ---- 品牌资源(明/暗 wordmark) ----
  // 注意: prefix 匹配器会自行在 path 后补 "/", 因此 path 不能以 "/" 结尾,
  // 否则 "/api/shrimp/assets/xxx.png" 永远匹配不上(历史 404 根因)。
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/shrimp/assets',
    handler: async (req, res) => {
      const name = (req.url || '').split('?')[0].split('/').pop()
      if (!/^[a-zA-Z0-9._-]+$/.test(name || '')) {
        res.writeHead(404); res.end(); return
      }
      try {
        const buf = await readFile(join(ASSETS, name))
        const ext = name.split('.').pop()
        const mime = ext === 'webp' ? 'image/webp' : ext === 'svg' ? 'image/svg+xml' : 'image/png'
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' })
        res.end(buf)
      } catch (e) {
        res.writeHead(404); res.end()
      }
    },
  }), 'shrimp-shell: assets')

  // ---- 会话产物文件列表 ----
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/shrimp/files',
    handler: async (req, res) => {
      const { session } = parseQuery(req.url || '')
      if (!session) { sendJson(res, 400, { ok: false, error: '缺少 session' }); return }
      try {
        const snap = await ctx.sessionQuery.readSession(session)
        const meta = snap && snap.session
        const cwd = meta && meta.cwd
        if (!cwd) { sendJson(res, 200, { ok: true, files: [], note: '会话无工作区' }); return }
        const since = meta.createdAt ? meta.createdAt - 60000 : 0
        const spec = {
          command: 'python3 -c ' + JSON.stringify(SCAN_CODE) + ' ' + JSON.stringify(cwd) + ' ' + String(since),
          workdir: cwd,
          timeoutMs: 20000,
          stdoutMaxBytes: 8 * 1024 * 1024,
        }
        const result = await ctx.shell.run(spec)
        let files = []
        const text = result && result.stdout ? result.stdout.text : ''
        try {
          const rows = JSON.parse(text)
          files = rows.map((r) => ({ name: r[0], path: r[1], size: r[2], mtime: r[3] }))
        } catch (e) { /* 解析失败则空 */ }
        sendJson(res, 200, { ok: true, cwd, since, files })
      } catch (e) {
        sendJson(res, 200, { ok: false, error: String(e && e.message ? e.message : e) })
      }
    },
  }), 'shrimp-shell: files')

  // ---- 目录列表(文件树) ----
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/shrimp/tree',
    handler: async (req, res) => {
      const { dir } = parseQuery(req.url || '')
      if (!dir) { sendJson(res, 400, { ok: false, error: '缺少 dir' }); return }
      try {
        const target = await fs.resolve(dir)
        const entries = await fs.listDir(target)
        const list = entries.map((e) => ({
          name: e.name,
          type: e.type,
          size: e.size || 0,
          path: e.target.displayPath || dirname(dir) + '/' + e.name,
        })).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))
        sendJson(res, 200, { ok: true, dir, entries: list })
      } catch (e) {
        sendJson(res, 200, { ok: false, error: String(e && e.message ? e.message : e) })
      }
    },
  }), 'shrimp-shell: tree')

  // ---- 文本预览 ----
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/shrimp/read',
    handler: async (req, res) => {
      const { path: p } = parseQuery(req.url || '')
      if (!p) { sendJson(res, 400, { ok: false, error: '缺少 path' }); return }
      try {
        const target = await fs.resolve(p)
        const text = await fs.readText(target)
        const truncated = text.length > 4000
        sendJson(res, 200, { ok: true, path: p, truncated, content: text.slice(0, 4000) })
      } catch (e) {
        sendJson(res, 200, { ok: false, error: String(e && e.message ? e.message : e) })
      }
    },
  }), 'shrimp-shell: read')
}
