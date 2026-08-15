// shrimp-shell — Client half(浏览器 ModuleLoader 格式)
// 1) 左上角 logo 换成虾缸 wordmark(明/暗两版, 保留 harness 布局)
// 2) 会话头部新增"📦 产物"按钮 → 右侧产物面板(文件列表 + 文件树 + 预览)
window.__ModuleLoader__.load({
  id: '@local/dsh-shrimp-shell/client',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    let React = require('react')

    const inject = ['slots']

    function apply(ctx) {
      const slots = ctx.slots

      // ---- 样式 ----
      const style = document.createElement('style')
      style.textContent = [
        // 左上角 logo: 隐藏原 DeepSeek wordmark, 替换为虾缸 wordmark(明/暗)
        '.hHd-Xa_brand svg { display: none !important; }',
        ".hHd-Xa_brand::before { content: ''; width: 78px; height: 42px; flex: none; background: url('/api/shrimp/assets/wordmark-light.png') no-repeat center / contain; }",
        "@media (prefers-color-scheme: dark) { .hHd-Xa_brand::before { background-image: url('/api/shrimp/assets/wordmark-dark.png'); } }",
        // 产物按钮
        '.shrimp-files-btn { display: inline-flex; align-items: center; gap: 4px; }',
        // 右侧产物面板
        '.shrimp-panel { position: fixed; top: 0; right: 0; bottom: 0; width: 400px; z-index: 9999; display: flex; flex-direction: column; background: var(--dsw-specific-panel-fill, #ffffff); border-left: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12)); box-shadow: -8px 0 24px rgba(0,0,0,0.18); font-size: 13px; color: var(--dsw-alias-label-primary, #1f2329); }',
        '.shrimp-panel-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1)); font-weight: 600; flex: none; }',
        '.shrimp-panel-close { cursor: pointer; border: none; background: none; font-size: 16px; color: inherit; padding: 2px 6px; border-radius: 6px; }',
        '.shrimp-panel-close:hover { background: rgba(128,128,128,0.15); }',
        '.shrimp-panel-body { flex: 1; overflow: auto; padding: 8px; }',
        '.shrimp-note { padding: 10px 12px; color: var(--dsw-alias-label-secondary, #8a8f98); }',
        '.shrimp-file { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; cursor: pointer; min-width: 0; }',
        '.shrimp-file:hover { background: rgba(128,128,128,0.12); }',
        '.shrimp-file .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '.shrimp-file .meta { margin-left: auto; flex: none; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 11px; }',
        '.shrimp-tree-item { display: flex; align-items: center; gap: 6px; padding: 4px 8px 4px 14px; cursor: pointer; border-radius: 6px; min-width: 0; }',
        '.shrimp-tree-item:hover { background: rgba(128,128,128,0.12); }',
        '.shrimp-tree-item .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '.shrimp-tree-children { padding-left: 14px; }',
        '.shrimp-preview { padding: 10px 14px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1)); white-space: pre-wrap; max-height: 260px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: rgba(0,0,0,0.04); color: var(--dsw-alias-label-primary, #1f2329); }',
        '@media (prefers-color-scheme: dark) { .shrimp-preview { background: rgba(255,255,255,0.05); } }',
      ].join('\n')
      document.head.appendChild(style)
      ctx.effect(() => { document.head.removeChild(style) }, 'shrimp-shell: styles')

      // ---- 产物面板 ----
      let panel = null

      const fmtSize = (n) => {
        if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'M'
        if (n >= 1024) return (n / 1024).toFixed(1) + 'K'
        return n + 'B'
      }
      const fmtTime = (t) => {
        const d = new Date(t * 1000)
        return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
      }
      const api = async (path) => {
        const r = await fetch(path, { cache: 'no-store' })
        return r.json()
      }

      const closePanel = () => {
        if (panel) { panel.remove(); panel = null }
      }

      const showPreview = (body, filePath) => {
        let old = body.querySelector('.shrimp-preview')
        if (old) old.remove()
        api('/api/shrimp/read?path=' + encodeURIComponent(filePath)).then((data) => {
          const pre = document.createElement('div')
          pre.className = 'shrimp-preview'
          pre.textContent = data.ok ? (data.content + (data.truncated ? '\n…(已截断)' : '')) : ('读取失败: ' + data.error)
          body.appendChild(pre)
        }).catch(() => {})
      }

      const openTree = (container, dir) => {
        container.textContent = '加载中…'
        api('/api/shrimp/tree?dir=' + encodeURIComponent(dir)).then((data) => {
          container.textContent = ''
          if (!data.ok) { container.textContent = '错误: ' + data.error; return }
          for (const e of data.entries) {
            const row = document.createElement('div')
            row.className = 'shrimp-tree-item'
            const icon = e.type === 'directory' ? '📁' : '📄'
            const nm = document.createElement('span')
            nm.className = 'nm'
            nm.textContent = e.name
            const meta = document.createElement('span')
            meta.className = 'meta'
            meta.textContent = e.type === 'directory' ? '' : fmtSize(e.size)
            row.appendChild(document.createTextNode(icon + ' '))
            row.appendChild(nm)
            row.appendChild(meta)
            if (e.type === 'directory') {
              const kids = document.createElement('div')
              kids.className = 'shrimp-tree-children'
              kids.style.display = 'none'
              row.addEventListener('click', () => {
                const open = kids.style.display !== 'none'
                kids.style.display = open ? 'none' : 'block'
                if (!open && kids.childElementCount === 0) openTree(kids, e.path)
              })
              container.appendChild(row)
              container.appendChild(kids)
            } else {
              row.addEventListener('click', () => showPreview(container.closest('.shrimp-panel-body'), e.path))
              container.appendChild(row)
            }
          }
        }).catch(() => { container.textContent = '加载失败' })
      }

      const openPanel = (sessionId) => {
        closePanel()
        panel = document.createElement('div')
        panel.className = 'shrimp-panel'
        const head = document.createElement('div')
        head.className = 'shrimp-panel-head'
        const title = document.createElement('span')
        title.textContent = '📦 会话产物'
        const close = document.createElement('button')
        close.className = 'shrimp-panel-close'
        close.textContent = '✕'
        close.title = '关闭'
        close.addEventListener('click', closePanel)
        head.appendChild(title)
        head.appendChild(close)
        const body = document.createElement('div')
        body.className = 'shrimp-panel-body'
        panel.appendChild(head)
        panel.appendChild(body)
        document.body.appendChild(panel)

        body.textContent = '扫描会话产物中…'
        api('/api/shrimp/files?session=' + encodeURIComponent(sessionId)).then((data) => {
          body.textContent = ''
          if (!data.ok) {
            const note = document.createElement('div')
            note.className = 'shrimp-note'
            note.textContent = '获取失败: ' + data.error
            body.appendChild(note)
            return
          }
          if (!data.files || data.files.length === 0) {
            const note = document.createElement('div')
            note.className = 'shrimp-note'
            note.textContent = '此会话暂无产出文件'
            body.appendChild(note)
            return
          }
          for (const f of data.files) {
            const row = document.createElement('div')
            row.className = 'shrimp-file'
            const nm = document.createElement('span')
            nm.className = 'nm'
            let rel = f.path
            if (data.cwd && f.path.startsWith(data.cwd)) rel = f.path.slice(data.cwd.length).replace(/^\//, '')
            nm.textContent = '📄 ' + rel
            nm.title = f.path
            const meta = document.createElement('span')
            meta.className = 'meta'
            meta.textContent = fmtSize(f.size) + ' · ' + fmtTime(f.mtime)
            row.appendChild(nm)
            row.appendChild(meta)
            row.addEventListener('click', () => {
              const dir = f.path.slice(0, f.path.lastIndexOf('/'))
              const tree = document.createElement('div')
              tree.className = 'shrimp-tree-children'
              const prev = body.querySelector('.shrimp-open-tree')
              if (prev) prev.remove()
              tree.className = 'shrimp-tree-children shrimp-open-tree'
              body.appendChild(tree)
              openTree(tree, dir)
              showPreview(body, f.path)
            })
            body.appendChild(row)
          }
        }).catch(() => { body.textContent = '加载失败' })
      }

      // ---- 语音输入按钮(原生桥: 大神.app 标题栏已移除,按钮入输入框) ----
      ctx.effect(() => slots.inject('conversation.input.left', () => slots.register(
        { name: 'conversation.input.left', id: 'shrimp-voice', order: 1, label: '语音' },
        () => {
          const [vstate, setVState] = React.useState('idle')
          React.useEffect(() => {
            window.__shrimpVoiceState = (s) => { setVState(s || 'idle') }
            return () => { if (window.__shrimpVoiceState) delete window.__shrimpVoiceState }
          }, [])
          const native = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.shrimpVoice
          const label = vstate === 'recording' ? '⏹ 结束' : '🎤 语音'
          return React.createElement(
            'button',
            {
              type: 'button',
              className: 'shrimp-voice-btn',
              title: native
                ? (vstate === 'recording' ? '正在录音,点击结束并填入文字' : '点击开始语音输入(本地识别)')
                : '浏览器中不可用: 请用 macOS 系统听写(连按两下 Fn)后说话',
              style: vstate === 'recording' ? { color: '#e5484d' } : undefined,
              onClick: () => {
                if (native) {
                  native.postMessage('toggle')
                } else if (vstate !== 'recording') {
                  setVState('browser')
                  window.setTimeout(() => { setVState('idle') }, 2500)
                }
              },
            },
            label,
          )
        },
      )), 'shrimp-shell: voice button')

      // ---- 会话头部"产物"按钮 ----
      ctx.effect(() => slots.inject('conversation.session.header.utilities', () => slots.register(
        { name: 'conversation.session.header.utilities', id: 'shrimp-files', order: 5, label: '产物' },
        (props) => {
          const sessionId = props && props.sessionId
          return React.createElement(
            'button',
            {
              type: 'button',
              className: 'shrimp-files-btn',
              title: '查看本会话产出文件',
              onClick: () => { if (sessionId) openPanel(sessionId) },
            },
            '📦 产物',
          )
        },
      )), 'shrimp-shell: files button')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
