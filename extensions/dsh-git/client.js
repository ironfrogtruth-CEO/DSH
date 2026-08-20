// dsh-git — Client half: 会话顶部 Git 工作台
window.__ModuleLoader__.load({
  id: '@local/dsh-git',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const inject = ['slots']
    const h = React.createElement

    async function api(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        cache: 'no-store',
      })
      const value = await response.json().catch(() => ({}))
      if (!response.ok || value.ok === false) throw new Error(value.error || `Git 请求失败（${response.status}）`)
      return value
    }

    function GitIcon() {
      return h('svg', { viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': true },
        h('circle', { cx: 5, cy: 4.5, r: 1.8, stroke: 'currentColor', 'stroke-width': 1.45 }),
        h('circle', { cx: 5, cy: 15.5, r: 1.8, stroke: 'currentColor', 'stroke-width': 1.45 }),
        h('path', { d: 'M5 6.3v7.4M5 10c0-1.8 1.6-3 3.8-3h5.8m-2-2 2 2-2 2', stroke: 'currentColor', 'stroke-width': 1.45, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
      )
    }

    function GitUtility() {
      const [open, setOpen] = React.useState(false)
      const [repositories, setRepositories] = React.useState([])
      const [path, setPath] = React.useState('')
      const [snapshot, setSnapshot] = React.useState(null)
      const [diff, setDiff] = React.useState('')
      const [diffTitle, setDiffTitle] = React.useState('选择文件查看差异')
      const [message, setMessage] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const rootRef = React.useRef(null)

      const loadStatus = React.useCallback(async (nextPath = path) => {
        if (!nextPath) return
        setBusy(true); setError('')
        try {
          const query = new URLSearchParams({ path: nextPath })
          const value = await api(`/api/dsh-git/status?${query}`)
          setSnapshot(value)
          try { window.localStorage.setItem('dsh-git-last-repository', nextPath) } catch {}
        } catch (e) { setError(String(e.message || e)) } finally { setBusy(false) }
      }, [path])

      React.useEffect(() => {
        let alive = true
        api('/api/dsh-git/workspaces').then((value) => {
          if (!alive) return
          const rows = value.repositories || []
          setRepositories(rows)
          let saved = ''
          try { saved = window.localStorage.getItem('dsh-git-last-repository') || '' } catch {}
          const selected = rows.find((item) => item.path === saved) || rows[0]
          if (selected) setPath(selected.path)
        }).catch((e) => { if (alive) setError(String(e.message || e)) })
        return () => { alive = false }
      }, [])

      React.useEffect(() => { if (path) loadStatus(path) }, [path])
      React.useEffect(() => {
        if (!open || !path) return undefined
        const timer = setInterval(() => loadStatus(path), 15000)
        return () => clearInterval(timer)
      }, [open, path, loadStatus])
      React.useEffect(() => {
        const onUtilityOpen = (event) => {
          if (event && event.detail && event.detail.id !== 'git') setOpen(false)
        }
        window.addEventListener('dsh:utility-open', onUtilityOpen)
        return () => window.removeEventListener('dsh:utility-open', onUtilityOpen)
      }, [])
      React.useEffect(() => {
        if (!open) return undefined
        const close = (event) => {
          if (event.type === 'keydown' && event.key !== 'Escape') return
          if (event.type === 'mousedown' && rootRef.current && rootRef.current.contains(event.target)) return
          setOpen(false)
        }
        document.addEventListener('mousedown', close)
        document.addEventListener('keydown', close)
        return () => {
          document.removeEventListener('mousedown', close)
          document.removeEventListener('keydown', close)
        }
      }, [open])

      const showDiff = async (file, staged) => {
        if (!path) return
        setBusy(true); setError(''); setDiffTitle(`${staged ? '已暂存' : '未暂存'} · ${file.path}`)
        try {
          const query = new URLSearchParams({ path, file: file.path, staged: staged ? '1' : '0' })
          const value = await api(`/api/dsh-git/diff?${query}`)
          setDiff(value.diff || '(无差异)')
        } catch (e) { setError(String(e.message || e)); setDiff('') } finally { setBusy(false) }
      }

      const runAction = async (action, payload = {}) => {
        if (!path) return
        setBusy(true); setError(''); setNotice('')
        try {
          const value = await api('/api/dsh-git/action', { method: 'POST', body: JSON.stringify({ action, path, ...payload }) })
          setSnapshot(value); setDiff(''); setDiffTitle('选择文件查看差异')
          setNotice(action === 'commit' ? '提交完成' : action === 'push' ? '推送完成' : action === 'commit_push' ? '本地提交并推送完成' : '暂存区已更新')
          if (action === 'commit' || action === 'commit_push') setMessage('')
        } catch (e) { setError(String(e.message || e)) } finally { setBusy(false) }
      }

      const files = snapshot && Array.isArray(snapshot.files) ? snapshot.files : []
      const dirtyCount = files.length
      const trigger = h('button', {
        type: 'button',
        className: 'dsh-git-trigger',
        'aria-label': 'Git',
        'aria-expanded': open,
        title: dirtyCount ? `${snapshot.branch || ''} · ${dirtyCount} 个改动` : 'Git 工作台',
        onClick: () => {
          const next = !open
          if (next) window.dispatchEvent(new CustomEvent('dsh:utility-open', { detail: { id: 'git' } }))
          setOpen(next)
          if (next) loadStatus(path)
        },
      }, h(GitIcon), h('span', null, 'Git'), dirtyCount ? h('span', { className: 'dsh-git-count' }, String(dirtyCount)) : null)

      if (!open) return h('div', { ref: rootRef, className: 'dsh-git-root' }, trigger)

      const fileRows = files.length ? files.map((file) => {
        const staged = file.index !== ' ' && file.index !== '?'
        const unstaged = file.worktree !== ' ' || file.code === '??'
        return h('div', { key: `${file.code}:${file.path}`, className: 'dsh-git-file' },
          h('button', { type: 'button', className: 'dsh-git-file-main', title: file.path, onClick: () => showDiff(file, !unstaged && staged) },
            h('code', { className: 'dsh-git-code' }, file.code), h('span', null, file.path)),
          unstaged ? h('button', { type: 'button', className: 'dsh-git-mini', disabled: busy, title: '暂存此文件', onClick: () => runAction('stage', { files: [file.path] }) }, '+') : null,
          staged ? h('button', { type: 'button', className: 'dsh-git-mini', disabled: busy, title: '取消暂存此文件', onClick: () => runAction('unstage', { files: [file.path] }) }, '−') : null,
        )
      }) : h('div', { className: 'dsh-git-empty' }, '工作区干净')

      const recent = snapshot && snapshot.recentCommits || []
      return h('div', { ref: rootRef, className: 'dsh-git-root' }, trigger,
        h('section', { className: 'dsh-git-panel', 'aria-label': 'Git 工作台' },
          h('header', { className: 'dsh-git-head' },
            h('strong', null, 'Git 工作台'),
            snapshot ? h('span', { className: 'dsh-git-branch' }, snapshot.branch) : null,
            h('button', { type: 'button', className: 'dsh-git-head-btn', disabled: busy, onClick: () => loadStatus(path) }, '刷新'),
            h('button', { type: 'button', className: 'dsh-git-close', 'aria-label': '关闭 Git', onClick: () => setOpen(false) }, '×')),
          h('div', { className: 'dsh-git-repo' },
            h('label', null, '仓库', h('select', { value: path, onChange: (event) => { setPath(event.target.value); setDiff(''); setDiffTitle('选择文件查看差异') } }, repositories.map((repo) => h('option', { key: repo.path, value: repo.path }, `${repo.name} · ${repo.path}`)))),
            h('div', { className: 'dsh-git-actions' },
              h('button', { type: 'button', disabled: busy || !files.length, onClick: () => { if (window.confirm(`暂存「${path}」的全部改动？`)) runAction('stage') } }, '暂存全部'),
              h('button', { type: 'button', disabled: busy || !(snapshot && snapshot.hasStaged), onClick: () => { if (window.confirm('取消全部已暂存改动？文件内容不会被删除。')) runAction('unstage') } }, '全部取消暂存'))),
          error ? h('div', { className: 'dsh-git-message', 'data-tone': 'error' }, error) : null,
          notice ? h('div', { className: 'dsh-git-message', 'data-tone': 'success' }, notice) : null,
          h('div', { className: 'dsh-git-grid' },
            h('div', { className: 'dsh-git-files' }, h('div', { className: 'dsh-git-section-title' }, `改动文件 · ${files.length}`), fileRows),
            h('div', { className: 'dsh-git-diff' }, h('div', { className: 'dsh-git-section-title' }, diffTitle), h('pre', null, diff || '点击左侧文件查看差异'))),
          h('div', { className: 'dsh-git-commit' },
            h('input', { value: message, placeholder: '提交说明', 'aria-label': '提交说明', onChange: (event) => setMessage(event.target.value) }),
            h('button', { type: 'button', className: 'dsh-git-primary', disabled: busy || !message.trim() || !(snapshot && snapshot.hasStaged), onClick: () => { if (window.confirm(`提交到 ${snapshot.branch}？\n\n${message.trim()}`)) runAction('commit', { message: message.trim() }) } }, '提交'),
            h('button', { type: 'button', className: 'dsh-git-primary', disabled: busy || !message.trim() || !files.length, onClick: () => { if (window.confirm(`一键提交并推送？\n\n仓库：${path}\n分支：${snapshot.branch}\n改动：${files.length} 个文件\n\n这会暂存全部改动、本地提交并更新 GitHub。`)) runAction('commit_push', { message: message.trim(), confirm: true, branch: snapshot.branch }) } }, '提交并推送'),
            h('button', { type: 'button', disabled: busy || !snapshot, onClick: () => { if (window.confirm(`确认把 ${snapshot.branch} 推送到远端？这会修改远程仓库。`)) runAction('push', { confirm: true, branch: snapshot.branch }) } }, '推送')),
          recent.length ? h('details', { className: 'dsh-git-history' }, h('summary', null, '最近提交'), recent.map((item) => h('div', { key: `${item.hash}:${item.date}` }, h('code', null, item.hash), h('span', null, item.message), h('time', null, item.date)))) : null,
        ))
    }

    function apply(ctx) {
      const style = document.createElement('style')
      style.id = 'dsh-git-ui-styles'
      style.textContent = `
        .dsh-git-root{position:relative;flex:none;font:13px/1.4 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
        .dsh-git-trigger{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:7px;height:36px;padding:0 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}
        .dsh-git-trigger:hover,.dsh-git-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));border-color:color-mix(in srgb,#8a72d8 42%,transparent)}
        .dsh-git-trigger svg{width:16px;height:16px;color:#8a72d8}.dsh-git-count{min-width:16px;padding:0 5px;border-radius:999px;background:#8a72d81c;color:#765fc4;font-size:10px;line-height:18px;text-align:center}
        .dsh-git-panel{position:fixed;z-index:10020;top:62px;right:126px;box-sizing:border-box;width:min(680px,calc(100vw - 28px));max-height:min(76vh,700px);overflow:auto;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:15px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary);box-shadow:0 20px 60px rgba(20,24,31,.24),0 3px 12px rgba(20,24,31,.1)}
        .dsh-git-head{display:flex;align-items:center;gap:8px;min-height:34px;padding:0 2px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsh-git-branch{padding:2px 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);font:11px/18px ui-monospace,SFMono-Regular,Menlo,monospace}.dsh-git-head-btn{margin-left:auto}.dsh-git-head button,.dsh-git-actions button,.dsh-git-commit button{min-height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:inherit;cursor:pointer}.dsh-git-head button:disabled,.dsh-git-actions button:disabled,.dsh-git-commit button:disabled{opacity:.45;cursor:not-allowed}.dsh-git-close{width:28px;padding:0!important;border:0!important;font-size:18px}
        .dsh-git-repo{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px;margin-top:10px}.dsh-git-repo label{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:11px}.dsh-git-repo select,.dsh-git-commit input{box-sizing:border-box;width:100%;height:30px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}.dsh-git-actions{display:flex;gap:6px}
        .dsh-git-message{margin-top:9px;padding:7px 9px;border-radius:8px;background:#2c9a6814;color:#2c9a68;font-size:12px}.dsh-git-message[data-tone=error]{background:#d94b5014;color:#d94b50}
        .dsh-git-grid{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:260px;margin-top:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:11px;overflow:hidden}.dsh-git-files{max-height:380px;overflow:auto;border-right:1px solid var(--dsw-alias-border-l1)}.dsh-git-diff{min-width:0;max-height:380px;overflow:auto;background:var(--dsw-alias-bg-base)}.dsh-git-section-title{position:sticky;top:0;z-index:1;padding:7px 9px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px}.dsh-git-file{display:flex;align-items:center;gap:4px;padding:3px 5px;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsh-git-file-main{display:flex;min-width:0;flex:1;align-items:center;gap:6px;padding:4px;border:0;background:transparent;color:inherit;cursor:pointer;text-align:left}.dsh-git-file-main span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-git-code{color:#8a72d8;font-size:10px}.dsh-git-mini{width:24px;height:24px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:inherit;cursor:pointer}.dsh-git-empty{padding:18px 9px;color:var(--dsw-alias-label-tertiary)}.dsh-git-diff pre{box-sizing:border-box;min-height:230px;margin:0;padding:10px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);font:11px/17px ui-monospace,SFMono-Regular,Menlo,monospace}
        .dsh-git-commit{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:7px;margin-top:10px}.dsh-git-primary{border-color:#8a72d8!important;background:#8a72d8!important;color:#fff!important}.dsh-git-history{margin-top:10px;color:var(--dsw-alias-label-secondary);font-size:11px}.dsh-git-history summary{cursor:pointer}.dsh-git-history div{display:grid;grid-template-columns:64px minmax(0,1fr) auto;gap:8px;padding:4px 2px}.dsh-git-history span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-git-history time{color:var(--dsw-alias-label-tertiary)}
        @media(max-width:760px){.dsh-git-panel{right:8px;left:8px;width:auto}.dsh-git-grid{grid-template-columns:1fr}.dsh-git-files{border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1);max-height:220px}.dsh-git-repo{grid-template-columns:1fr}.dsh-git-commit{grid-template-columns:1fr auto auto}}
      `
      document.getElementById(style.id)?.remove()
      document.head.appendChild(style)
      ctx.effect(() => () => style.remove(), 'dsh-git: styles')
      ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities', id: 'dsh-git-utility', order: 6, label: 'Git',
      }, GitUtility)), 'dsh-git: utility entry')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
