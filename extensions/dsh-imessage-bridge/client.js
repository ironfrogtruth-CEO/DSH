// @local/dsh-imessage-bridge — Client half
//
// A small, explicit control panel.  It never renders chat bodies, contact
// lists, or credentials; task rows contain only ids/status and a session jump.
window.__ModuleLoader__.load({
  id: '@local/dsh-imessage-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const inject = ['slots']
    let hostContext = null

    const safe = (value, fallback = '') => String(value ?? fallback)
    const api = async (path, options = {}) => {
      const response = await fetch(path, { cache: 'no-store', ...options, headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(options.headers || {}) } })
      const value = await response.json().catch(() => ({}))
      if (!response.ok || value.ok === false) throw new Error(value.error || `请求失败(${response.status})`)
      return value
    }

    function IMessageIcon() {
      return h('svg', { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M5.2 4.5h13.6A2.7 2.7 0 0 1 21.5 7.2v7.1a2.7 2.7 0 0 1-2.7 2.7H11l-4.4 3v-3H5.2a2.7 2.7 0 0 1-2.7-2.7V7.2a2.7 2.7 0 0 1 2.7-2.7Z', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linejoin': 'round' }),
        h('path', { d: 'm7 10 3 2 4-3 3 2', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
      )
    }

    const permissionLabel = { granted: '已授权', denied: '未授权', unknown: '未检查' }
    const permissionColor = { granted: '#35a56f', denied: '#d84c45', unknown: '#9aa0a8' }
    const taskLabel = { queued: '排队中', running: '执行中', completed: '已完成', failed: '失败', interrupted: '已中断', approval_needed: '需窗口审批' }

    function Dot({ color }) {
      return h('span', { 'aria-hidden': true, style: { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 15%, transparent)` } })
    }

    function IMessagePanel(props) {
      const [open, setOpen] = React.useState(false)
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const dialogRef = React.useRef(null)
      const triggerRef = React.useRef(null)
      const firstFocusRef = React.useRef(null)

      const load = React.useCallback(async () => {
        try { setState(await api('/api/dsh-imessage/status')); setError('') } catch (cause) { setError(safe(cause?.message, 'iMessage 状态读取失败')) }
      }, [])

      React.useEffect(() => { if (open) { void load(); const timer = setInterval(() => void load(), 10_000); return () => clearInterval(timer) } }, [open, load])
      React.useEffect(() => {
        const closeOther = (event) => { if (event?.detail?.id !== 'dsh-imessage') setOpen(false) }
        window.addEventListener('dsh:utility-open', closeOther)
        return () => window.removeEventListener('dsh:utility-open', closeOther)
      }, [])
      React.useEffect(() => {
        if (!open) return undefined
        const previous = document.activeElement
        const timer = setTimeout(() => (firstFocusRef.current || dialogRef.current)?.focus?.(), 0)
        const onKey = (event) => {
          if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return }
          if (event.key !== 'Tab' || !dialogRef.current) return
          const nodes = [...dialogRef.current.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')]
          if (!nodes.length) return
          const first = nodes[0]; const last = nodes[nodes.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }
        document.addEventListener('keydown', onKey)
        return () => { clearTimeout(timer); document.removeEventListener('keydown', onKey); setTimeout(() => previous?.focus?.(), 0) }
      }, [open])

      const setConfig = async (patch) => {
        setBusy(true); setError(''); setNotice('')
        try { setState(await api('/api/dsh-imessage/config', { method: 'POST', body: JSON.stringify(patch) })); setNotice('设置已保存') }
        catch (cause) { setError(safe(cause?.message, '设置保存失败')) }
        finally { setBusy(false) }
      }
      const checkMessages = async () => {
        setBusy(true); setError(''); setNotice('')
        try { const value = await api('/api/dsh-imessage/check', { method: 'POST', body: '{}' }); setState((old) => ({ ...(old || {}), permissions: value.permissions })); setNotice('Messages 权限检查完成') }
        catch (cause) { setError(safe(cause?.message, '权限检查失败')) }
        finally { setBusy(false) }
      }
      const testSend = async (kind) => {
        if (!window.confirm(kind === 'text' ? '确认通过 Messages 发出测试文字？' : '确认通过 Messages 发出最近安全产物？')) return
        setBusy(true); setError(''); setNotice('')
        try { const value = await api('/api/dsh-imessage/test', { method: 'POST', body: JSON.stringify({ kind, confirm: true }) }); setNotice(value.status === 'queued-to-Messages' ? '已交给 Messages（不代表已送达）' : '测试完成'); await load() }
        catch (cause) { setError(safe(cause?.message, '测试发送失败')) }
        finally { setBusy(false) }
      }
      const openSession = (sessionId) => {
        if (!sessionId) return
        try { hostContext?.sessions?.open?.(sessionId) } catch { window.dispatchEvent(new CustomEvent('dsh:open-session', { detail: { sessionId } })) }
      }
      const toggle = () => setConfig({ enabled: !Boolean(state?.enabled) })
      const openPanel = () => { const next = !open; if (next) window.dispatchEvent(new CustomEvent('dsh:utility-open', { detail: { id: 'dsh-imessage' } })); setOpen(next) }
      const close = () => { setOpen(false); setError(''); setNotice('') }
      const status = state?.enabled ? '已启用' : '已关闭'
      const color = state?.enabled ? '#35a56f' : '#9aa0a8'
      const trigger = h('button', { ref: triggerRef, type: 'button', className: 'dsh-imessage-trigger', 'aria-label': 'iMessage', 'aria-expanded': open, title: 'iMessage 任务桥', onClick: openPanel }, h(IMessageIcon), props?.wide ? h('span', { className: 'dsh-imessage-trigger-label' }, 'iMessage') : null, props?.wide && state?.tasks?.some((item) => item.status === 'running') ? h('span', { className: 'dsh-imessage-count' }, '●') : null)
      if (!open) return h('div', { className: 'dsh-imessage-root dsh-sidebar-footer-entry' }, trigger)

      const permissions = state?.permissions || {}
      const tasks = Array.isArray(state?.tasks) ? state.tasks : []
      const workspaces = Array.isArray(state?.workspaces) ? state.workspaces : []
      return h('div', { className: 'dsh-imessage-root dsh-sidebar-footer-entry' }, trigger,
        h('div', { className: 'dsh-imessage-backdrop', onMouseDown: (event) => { if (event.target === event.currentTarget) close() }, 'aria-hidden': true }),
        h('section', { ref: dialogRef, className: 'dsh-imessage-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'dsh-imessage-title', tabIndex: -1 },
          h('header', { className: 'dsh-imessage-head' },
            h('div', { className: 'dsh-imessage-title-row' }, h('span', { className: 'dsh-imessage-mark' }, h(IMessageIcon)), h('div', null, h('h2', { id: 'dsh-imessage-title' }, 'iMessage'), h('p', null, '通过本机 Messages 接收任务与发送完成提醒'))),
            h('button', { type: 'button', className: 'dsh-imessage-close', onClick: close, 'aria-label': '关闭 iMessage 面板' }, '×'),
          ),
          h('div', { className: 'dsh-imessage-body' },
            error ? h('div', { className: 'dsh-imessage-alert error', role: 'alert' }, error) : null,
            notice ? h('div', { className: 'dsh-imessage-alert success', role: 'status' }, notice) : null,
            h('div', { className: 'dsh-imessage-state' }, h(Dot, { color }), h('strong', null, status), h('span', null, state?.runtime?.lastError || '白名单专用通道：直接发送自然语言')),
            h('section', { className: 'dsh-imessage-section' },
              h('div', { className: 'dsh-imessage-section-title' }, '基本配置'),
              h('div', { className: 'dsh-imessage-grid' },
                h('span', null, 'Messages 账号', h('strong', null, safe(state?.account, 'we***@me.com'))),
                h('span', null, '提醒收件人', h('strong', null, safe(state?.recipient, 'we***@me.com'))),
                h('span', null, '消息前缀', h('strong', null, `${safe(state?.prefix, '大神：')}（兼容大神:）`)),
                h('span', null, '余额阈值', h('strong', null, `¥${safe(state?.balanceThreshold, '10')}`)),
              ),
              h('div', { className: 'dsh-imessage-allowlist' }, '发件人白名单：', (state?.allowlist || []).join('、')),
              h('label', { className: 'dsh-imessage-workspace' }, '任务工作区', h('select', { ref: firstFocusRef, value: safe(state?.workspaceId), disabled: busy, onChange: (event) => setConfig({ workspaceId: event.target.value }) }, h('option', { value: '' }, `自动选择：${safe(state?.workspacePath, 'Desktop')}`), workspaces.map((item) => h('option', { key: item.workspaceId, value: item.workspaceId }, `${item.title} · ${item.path}`)))),
            ),
            h('section', { className: 'dsh-imessage-section' },
              h('div', { className: 'dsh-imessage-section-title' }, '权限状态'),
              h('div', { className: 'dsh-imessage-permissions' },
                h('span', null, h(Dot, { color: permissionColor[permissions.database] || permissionColor.unknown }), `Messages 数据库：${permissionLabel[permissions.database] || '未检查'}`),
                h('span', null, h(Dot, { color: permissionColor[permissions.automation] || permissionColor.unknown }), `Messages 自动化：${permissionLabel[permissions.automation] || '未检查'}`),
              ),
              h('p', { className: 'dsh-imessage-note' }, '需要在系统设置中手动授予“完全磁盘访问权限”和 Messages 自动化；大神不会修改 TCC。'),
              h('div', { className: 'dsh-imessage-actions' }, h('button', { type: 'button', disabled: busy, onClick: checkMessages }, busy ? '处理中…' : '检查 Messages'), h('button', { type: 'button', disabled: busy || !state?.enabled, onClick: () => testSend('text') }, '测试发文字'), h('button', { type: 'button', disabled: busy || !state?.enabled, onClick: () => testSend('file') }, '测试发文件')),
            ),
            h('section', { className: 'dsh-imessage-section' },
              h('div', { className: 'dsh-imessage-section-title' }, '任务与提醒', h('small', { className: 'dsh-imessage-conversation-count' }, ` · 活跃会话 ${Number(state?.activeConversationCount || 0)}`)),
              tasks.length ? h('div', { className: 'dsh-imessage-tasks' }, tasks.map((task) => h('div', { className: 'dsh-imessage-task', key: task.taskId }, h('div', { className: 'dsh-imessage-task-main' }, h('strong', null, task.taskId), h('small', null, taskLabel[task.status] || task.status, task.lastError ? ` · ${task.lastError}` : '')), task.sessionId ? h('button', { type: 'button', onClick: () => openSession(task.sessionId), title: '打开对应会话' }, '打开会话') : null))) : h('div', { className: 'dsh-imessage-empty' }, '还没有通过 iMessage 接收任务。'),
            ),
            h('footer', { className: 'dsh-imessage-footer' }, h('span', null, '直接发送自然语言；大神：可选，用于明确新开会话；发送“结束对话”可清除 route'), h('button', { type: 'button', className: 'dsh-imessage-toggle', disabled: busy, onClick: toggle }, state?.enabled ? '关闭 iMessage' : '启用 iMessage')),
          ),
        ),
      )
    }

    function apply(ctx) {
      hostContext = ctx
      const style = document.createElement('style')
      style.id = 'dsh-imessage-bridge-styles'
      style.textContent = `
        /* The host renders this list slot through a display:contents anchor.
           Re-establish one stable vertical stack for the three utility entries;
           the frame's data-sidebar-collapsed contract keeps the rail at 36px. */
        [data-slot="sidebar.footer.action"]{box-sizing:border-box!important;display:flex!important;flex-direction:column!important;align-items:stretch!important;gap:6px!important;width:100%!important;min-width:0!important}
        [data-slot="sidebar.footer.action"] > .dsh-sidebar-footer-entry,[data-slot="sidebar.footer.action"] > .dsbalance-card,[data-slot="sidebar.footer.action"] > .dsbalance-rail{box-sizing:border-box!important;display:flex!important;flex:0 0 auto!important;align-items:center!important;width:100%!important;max-width:none!important;height:36px!important;min-height:36px!important;margin:0!important;min-width:0!important}
        [data-slot="sidebar.footer.action"] > .dsh-sidebar-footer-entry > .dsh-imessage-trigger,[data-slot="sidebar.footer.action"] > .dsh-sidebar-footer-entry > .dsh-kb-trigger{width:100%!important;justify-content:flex-start!important}
        [data-sidebar-collapsed] [data-slot="sidebar.footer.action"]{width:36px!important;align-items:center!important;gap:4px!important}
        [data-sidebar-collapsed] [data-slot="sidebar.footer.action"] > .dsh-sidebar-footer-entry,[data-sidebar-collapsed] [data-slot="sidebar.footer.action"] > .dsbalance-card,[data-sidebar-collapsed] [data-slot="sidebar.footer.action"] > .dsbalance-rail{width:36px!important;min-width:36px!important;max-width:36px!important;height:36px!important;min-height:36px!important;padding:0!important}
        [data-sidebar-collapsed] [data-slot="sidebar.footer.action"] .dsh-imessage-trigger,[data-sidebar-collapsed] [data-slot="sidebar.footer.action"] .dsh-kb-trigger{width:36px!important;min-width:36px!important;padding:0!important;justify-content:center!important}
        /* The collapsed toggle contains a railMark span and the upstream panel
           icon. Hide both so the ShrimpTank mark is the one unambiguous entry. */
        button[aria-label="打开侧边栏"] > *,button[aria-label="Open sidebar"] > *{display:none!important}
        button[aria-label="打开侧边栏"]::before,button[aria-label="Open sidebar"]::before{content:"";display:block;width:26px;height:26px;flex:0 0 26px;background:currentColor;-webkit-mask:url('/api/shrimp/assets/hero-mark-cropped.png') center/contain no-repeat;mask:url('/api/shrimp/assets/hero-mark-cropped.png') center/contain no-repeat}
        button[aria-label="打开侧边栏"]:focus-visible,button[aria-label="Open sidebar"]:focus-visible{outline:2px solid #5b8ff9;outline-offset:2px}
        .dsh-imessage-root{box-sizing:border-box;position:relative;display:flex;align-items:center;flex:0 0 auto;width:auto;height:36px;min-height:36px;font:13px/1.4 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--dsw-alias-label-primary,#f5f6f7)}
        .dsh-imessage-trigger{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:7px;height:36px;min-height:36px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:999px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#f5f6f7);cursor:pointer;white-space:nowrap;line-height:1}.dsh-imessage-trigger:hover,.dsh-imessage-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));border-color:#35a56f88}.dsh-imessage-trigger svg,.dsh-imessage-mark svg{display:block;width:17px;height:17px;flex:0 0 17px}.dsh-imessage-count{font-size:10px;color:#35a56f}.dsh-imessage-backdrop{position:fixed;inset:0;z-index:10020;background:rgba(8,12,18,.43);backdrop-filter:blur(1px)}
        .dsh-imessage-dialog{position:fixed;z-index:10021;top:56px;right:18px;bottom:18px;display:flex;flex-direction:column;box-sizing:border-box;width:min(620px,calc(100vw - 36px));max-height:calc(100vh - 74px);overflow:hidden;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:16px;background:var(--dsw-alias-bg-layer-1,#191b1f);box-shadow:0 24px 80px rgba(0,0,0,.5);color:var(--dsw-alias-label-primary,#f5f6f7);outline:none}.dsh-imessage-head{display:flex;align-items:center;justify-content:space-between;min-height:68px;padding:0 18px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));flex:none}.dsh-imessage-title-row{display:flex;align-items:center;gap:10px;min-width:0}.dsh-imessage-mark{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;color:#35a56f;background:#35a56f18}.dsh-imessage-head h2{margin:0;font-size:16px;line-height:22px}.dsh-imessage-head p{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px}.dsh-imessage-close{display:grid;place-items:center;width:32px;height:32px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary,#8c949d);font-size:21px;cursor:pointer}.dsh-imessage-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));color:var(--dsw-alias-label-primary)}
        .dsh-imessage-body{display:flex;flex-direction:column;min-height:0;flex:1;overflow:auto;padding:13px 15px 16px}.dsh-imessage-alert{padding:8px 10px;margin-bottom:9px;border-radius:9px;font-size:12px}.dsh-imessage-alert.error{background:#d84c4516;color:#f08077}.dsh-imessage-alert.success{background:#35a56f16;color:#68c895}.dsh-imessage-state{display:flex;align-items:center;gap:8px;padding:10px 11px;margin-bottom:12px;border:1px solid #35a56f30;border-radius:10px;background:#35a56f0d}.dsh-imessage-state span:last-child{margin-left:auto;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsh-imessage-section{padding:12px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.13))}.dsh-imessage-section-title{margin-bottom:9px;color:var(--dsw-alias-label-secondary,#b1b7bf);font-size:12px;font-weight:650}.dsh-imessage-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:9px;border-radius:9px;background:var(--dsw-alias-bg-base,#141619);color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10px}.dsh-imessage-grid span{display:flex;flex-direction:column;gap:3px}.dsh-imessage-grid strong{color:var(--dsw-alias-label-primary,#f5f6f7);font-size:11px;font-weight:550}.dsh-imessage-allowlist{margin-top:8px;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10px;line-height:16px}.dsh-imessage-workspace{display:grid;gap:5px;margin-top:10px;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10px}.dsh-imessage-workspace select{box-sizing:border-box;min-height:32px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:8px;background:var(--dsw-alias-bg-base,#141619);color:inherit;font:inherit;font-size:11px}.dsh-imessage-permissions{display:flex;gap:15px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary,#b1b7bf);font-size:11px}.dsh-imessage-permissions span{display:inline-flex;align-items:center;gap:7px}.dsh-imessage-note{margin:8px 0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10px;line-height:16px}.dsh-imessage-actions{display:flex;gap:7px;flex-wrap:wrap}.dsh-imessage-actions button,.dsh-imessage-toggle{min-height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:8px;background:transparent;color:inherit;font-size:11px;cursor:pointer}.dsh-imessage-actions button:hover,.dsh-imessage-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}.dsh-imessage-actions button:disabled,.dsh-imessage-toggle:disabled{cursor:not-allowed;opacity:.45}.dsh-imessage-tasks{display:grid;gap:6px}.dsh-imessage-task{display:flex;align-items:center;gap:8px;min-width:0;padding:8px 9px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.15));border-radius:9px;background:var(--dsw-alias-bg-base,#141619)}.dsh-imessage-task-main{display:flex;flex-direction:column;min-width:0;flex:1}.dsh-imessage-task-main strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px/16px ui-monospace,SFMono-Regular,Menlo,monospace}.dsh-imessage-task-main small{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-imessage-task button{min-height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:7px;background:transparent;color:inherit;font-size:10px;cursor:pointer;white-space:nowrap}.dsh-imessage-empty{padding:18px;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;text-align:center}.dsh-imessage-footer{display:flex;align-items:center;gap:10px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.13));color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10px}.dsh-imessage-footer span{min-width:0;flex:1}.dsh-imessage-toggle{color:#35a56f;border-color:#35a56f66}
        @media(max-width:760px){.dsh-imessage-trigger-label,.dsh-imessage-count{display:none}.dsh-imessage-trigger{width:36px;padding:0}.dsh-imessage-dialog{top:8px;right:8px;bottom:8px;width:calc(100vw - 16px);max-height:none}.dsh-imessage-grid{grid-template-columns:1fr}.dsh-imessage-footer{align-items:flex-start;flex-direction:column}.dsh-imessage-toggle{width:100%}}
      `
      document.getElementById(style.id)?.remove()
      document.head.appendChild(style)
      // Keep labels on fine-pointer Mac windows. The legacy max-width rule is
      // still useful for touch/tiny surfaces, but CSS pixels alone misclassify
      // a HiDPI Mac App window as mobile.
      const responsiveStyle = document.createElement('style')
      responsiveStyle.id = 'dsh-imessage-responsive-styles'
      responsiveStyle.textContent = `
        /* Keep the panel centered in the conversation area, not at the far
           window edge. The half-width variable is measured from the live
           sidebar root so drag-resized and collapsed rails stay aligned. */
        .dsh-imessage-dialog{left:calc(50% + var(--dsh-sidebar-half-width,140px))!important;right:auto!important;transform:translateX(-50%)}
        [data-sidebar-collapsed] .dsh-imessage-dialog{left:calc(50% + var(--dsh-sidebar-half-width,28px))!important}
        /* Footer contract: API balance owns row one; Settings and iMessage
           share row two. The marker is attached to the stable foot-area
           ancestry because upstream CSS-module class names are not API. */
        [data-dsh-sidebar-foot]{box-sizing:border-box!important;display:grid!important;grid-template-columns:minmax(0,1fr) minmax(0,1fr)!important;grid-template-rows:auto auto!important;align-items:center!important;gap:6px 8px!important;width:100%!important;min-width:0!important}
        [data-dsh-footer-actions],[data-dsh-settings-area]{display:contents!important}
        [data-dsh-footer-actions] > [data-slot="sidebar.footer.action"],[data-dsh-settings-area] > [data-slot="sidebar.settings"]{display:contents!important}
        [data-dsh-sidebar-foot] .dsbalance-card{grid-column:1 / -1!important;grid-row:1!important;width:100%!important;margin:0!important}
        [data-dsh-sidebar-foot] .dsh-imessage-root{grid-column:2!important;grid-row:2!important;width:100%!important}
        [data-dsh-sidebar-foot] [data-slot="sidebar.settings"] > *{grid-column:1!important;grid-row:2!important;width:100%!important;margin:0!important}
        [data-dsh-sidebar-foot] .dsh-imessage-trigger{width:100%!important;justify-content:flex-start!important}
        [data-sidebar-collapsed] [data-dsh-sidebar-foot]{display:flex!important;flex-direction:column!important;align-items:center!important;gap:4px!important;width:36px!important}
        [data-sidebar-collapsed] [data-dsh-sidebar-foot] .dsbalance-rail{order:1!important;width:36px!important;height:36px!important;margin:0!important}
        [data-sidebar-collapsed] [data-dsh-sidebar-foot] .dsh-imessage-root{order:2!important;width:36px!important;height:36px!important}
        [data-sidebar-collapsed] [data-dsh-sidebar-foot] [data-slot="sidebar.settings"] > *{order:3!important;width:36px!important;height:36px!important;padding:0!important;justify-content:center!important}
        [data-sidebar-collapsed] [data-dsh-sidebar-foot] .dsh-imessage-trigger{width:36px!important;justify-content:center!important;padding:0!important}
        .dsh-imessage-trigger-label,.dsh-imessage-count{display:inline}
        .dsh-imessage-trigger{width:auto;padding:0 12px}
        @media(max-width:520px) and (pointer:coarse),(max-width:380px){
          .dsh-imessage-trigger-label,.dsh-imessage-count{display:none}
          .dsh-imessage-trigger{width:36px;padding:0}
          .dsh-imessage-dialog{left:8px!important;right:8px!important;transform:none;width:calc(100vw - 16px)!important}
        }
      `
      document.getElementById(responsiveStyle.id)?.remove()
      document.head.appendChild(responsiveStyle)
      let observedSidebarRoot = null
      let sidebarResizeObserver = null
      const markSidebarFoot = () => {
        const actionSlot = document.querySelector('[data-slot="sidebar.footer.action"]')
        const settingsSlot = document.querySelector('[data-slot="sidebar.settings"]')
        const footerActions = actionSlot?.parentElement
        const settingsArea = settingsSlot?.parentElement
        const footArea = footerActions?.parentElement
        if (!actionSlot || !settingsSlot || !footerActions || !settingsArea || !footArea || settingsArea.parentElement !== footArea) return
        footArea.dataset.dshSidebarFoot = 'true'
        footerActions.dataset.dshFooterActions = 'true'
        settingsArea.dataset.dshSettingsArea = 'true'
        const sidebarRoot = footArea.parentElement
        if (sidebarRoot && sidebarRoot !== observedSidebarRoot) {
          sidebarResizeObserver?.disconnect()
          observedSidebarRoot = sidebarRoot
          if (typeof ResizeObserver !== 'undefined') {
            sidebarResizeObserver = new ResizeObserver(markSidebarFoot)
            sidebarResizeObserver.observe(sidebarRoot)
          }
        }
        const width = sidebarRoot?.getBoundingClientRect?.().width || 0
        document.documentElement.style.setProperty('--dsh-sidebar-half-width', `${Math.max(28, width > 0 ? width / 2 : 140)}px`)
      }
      markSidebarFoot()
      const sidebarFootObserver = new MutationObserver(markSidebarFoot)
      sidebarFootObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-sidebar-collapsed'] })
      ctx.effect(() => () => {
        sidebarFootObserver.disconnect()
        sidebarResizeObserver?.disconnect()
        document.documentElement.style.removeProperty('--dsh-sidebar-half-width')
        document.querySelectorAll('[data-dsh-sidebar-foot]').forEach((el) => delete el.dataset.dshSidebarFoot)
        document.querySelectorAll('[data-dsh-footer-actions]').forEach((el) => delete el.dataset.dshFooterActions)
        document.querySelectorAll('[data-dsh-settings-area]').forEach((el) => delete el.dataset.dshSettingsArea)
        style.remove(); responsiveStyle.remove()
      }, 'dsh-imessage: styles')
      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-imessage', order: 70, label: 'iMessage' }, IMessagePanel)), 'dsh-imessage: sidebar footer')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
