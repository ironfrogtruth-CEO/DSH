// @local/dsh-dingtalk-status — read-only client half.
//
// The client uses the existing utility footer seam.  It only reads the local
// status API and copies the fixed setup command; it cannot edit configuration,
// run commands, send messages, or contact DingTalk itself.
window.__ModuleLoader__.load({
  id: '@local/dsh-dingtalk-status',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const inject = ['slots', 'sessions']
    const safe = (value, fallback = '') => String(value ?? fallback)
    let openHostSession = null

    function nativeSubscriberAdminAvailable() {
      return typeof window?.webkit?.messageHandlers?.dingtalkSubscriptionAdmin?.postMessage === 'function'
    }

    function DingTalkIcon() {
      return h('svg', { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M5.2 4.5h13.6A2.7 2.7 0 0 1 21.5 7.2v7.1a2.7 2.7 0 0 1-2.7 2.7H11l-4.4 3v-3H5.2a2.7 2.7 0 0 1-2.7-2.7V7.2a2.7 2.7 0 0 1 2.7-2.7Z', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linejoin': 'round' }),
        h('path', { d: 'm7.2 9.3 3.1 2.2 3.8-3.2 2.6 2.1', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
      )
    }

    const STREAM_LABEL = { connected: '已连接', reconnecting: '重连中', stale: '状态过期', unobserved: '未观测' }

    function Dot({ color }) {
      return h('span', { 'aria-hidden': true, style: { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 15%, transparent)` } })
    }

    function streamColor(status) {
      return status === 'connected' ? '#35a56f' : status === 'reconnecting' ? '#e3a72f' : '#9aa0a8'
    }

    function statusHeadline(state) {
      if (!state?.package?.installed) return '未安装'
      if (!state?.credentials?.configured) return '待配置'
      if (!state.ownerBound) return '待绑定'
      return STREAM_LABEL[state.stream?.status] || '未观测'
    }

    function statusDescription(state) {
      if (!state?.package?.installed) return '官方连接器尚未安装'
      if (!state?.credentials?.configured) return '需要在本机完成一次官方 setup'
      if (!state.ownerBound) return '需要用管理员账号完成绑定'
      return `Stream ${STREAM_LABEL[state.stream?.status] || '未观测'}`
    }

    async function readStatus() {
      const response = await fetch('/api/dsh-dingtalk/status', { cache: 'no-store', headers: { Accept: 'application/json' } })
      const value = await response.json().catch(() => ({}))
      if (!response.ok || value.ok === false) throw new Error(value.error || `状态读取失败(${response.status})`)
      return value
    }

    async function openSession(sessionId) {
      if (!sessionId) return
      try {
        if (typeof openHostSession === 'function') {
          await openHostSession(sessionId)
          return
        }
      } catch {
        // Fall through to the legacy event bridge only when the native session
        // opener rejects this canonical id.
      }
      window.dispatchEvent(new CustomEvent('dsh:open-session', { detail: { sessionId } }))
    }

    async function copyCommand(value) {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
        return
      }
      const textarea = document.createElement('textarea')
      textarea.value = value
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      textarea.remove()
    }

    function DingTalkPanel(props) {
      const [open, setOpen] = React.useState(false)
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const dialogRef = React.useRef(null)
      const firstFocusRef = React.useRef(null)

      const load = React.useCallback(async () => {
        try { setState(await readStatus()); setError('') } catch (cause) { setError(safe(cause?.message, '钉钉状态读取失败')) }
      }, [])

      React.useEffect(() => {
        void load()
        const timer = setInterval(() => void load(), 10_000)
        return () => clearInterval(timer)
      }, [load])
      React.useEffect(() => {
        const closeOther = (event) => { if (event?.detail?.id !== 'dsh-dingtalk-status') setOpen(false) }
        const openStatus = () => { window.dispatchEvent(new CustomEvent('dsh:utility-open', { detail: { id: 'dsh-dingtalk-status' } })); setOpen(true) }
        window.addEventListener('dsh:utility-open', closeOther)
        window.addEventListener('dsh:open-dingtalk-status', openStatus)
        return () => { window.removeEventListener('dsh:utility-open', closeOther); window.removeEventListener('dsh:open-dingtalk-status', openStatus) }
      }, [])
      React.useEffect(() => {
        if (!open) return undefined
        const previous = document.activeElement
        const focusTimer = setTimeout(() => (firstFocusRef.current || dialogRef.current)?.focus?.(), 0)
        const onKey = (event) => {
          if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return }
          if (event.key !== 'Tab' || !dialogRef.current) return
          const nodes = [...dialogRef.current.querySelectorAll('button:not([disabled]),[tabindex]:not([tabindex="-1"])')]
          if (!nodes.length) return
          const first = nodes[0]; const last = nodes[nodes.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }
        document.addEventListener('keydown', onKey)
        return () => { clearTimeout(focusTimer); document.removeEventListener('keydown', onKey); setTimeout(() => previous?.focus?.(), 0) }
      }, [open])

      const openPanel = () => {
        const next = !open
        if (next) window.dispatchEvent(new CustomEvent('dsh:utility-open', { detail: { id: 'dsh-dingtalk-status' } }))
        setOpen(next)
      }
      const close = () => { setOpen(false); setError(''); setNotice('') }
      const copySetup = async () => {
        try { await copyCommand(state?.setupCommand || 'npx @dingtalk-real-ai/dsh-dingtalk@0.6.2 setup'); setNotice('命令已复制，可在本机终端手动运行') }
        catch (cause) { setError(safe(cause?.message, '复制失败，请手动选择命令')) }
      }
      const openSubscriptions = () => { setOpen(false); window.dispatchEvent(new CustomEvent('dsh:open-dingtalk-subscriptions')) }
      const headline = statusHeadline(state)
      const status = state?.stream?.status || 'unobserved'
      const color = streamColor(status)
      const trigger = h('button', { type: 'button', className: 'dsh-dingtalk-trigger', 'aria-label': `钉钉：${headline}`, 'aria-expanded': open, title: `钉钉：${headline}`, onClick: openPanel }, h(DingTalkIcon), props?.wide ? h('span', { className: 'dsh-dingtalk-trigger-label' }, '钉钉') : null, props?.wide ? h('span', { className: 'dsh-dingtalk-trigger-dot', 'aria-hidden': true, style: { background: color } }) : null)
      if (!open) return h('div', { className: 'dsh-dingtalk-root dsh-sidebar-footer-entry' }, trigger)

      const card = state?.aiCard
      const cardText = !card?.known ? '未观测' : card.available ? '已知可用' : '已知不可用'
      const observed = state?.stream?.observedAt ? new Date(state.stream.observedAt).toLocaleTimeString() : '—'
      return h('div', { className: 'dsh-dingtalk-root dsh-sidebar-footer-entry' }, trigger,
        h('div', { className: 'dsh-dingtalk-backdrop', onMouseDown: (event) => { if (event.target === event.currentTarget) close() }, 'aria-hidden': true }),
        h('section', { ref: dialogRef, className: 'dsh-dingtalk-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'dsh-dingtalk-title', tabIndex: -1 },
          h('header', { className: 'dsh-dingtalk-head' },
            h('div', { className: 'dsh-dingtalk-title-row' }, h('span', { className: 'dsh-dingtalk-mark' }, h(DingTalkIcon)), h('div', null, h('h2', { id: 'dsh-dingtalk-title' }, '钉钉'), h('p', null, '官方 Stream 连接状态'))),
            h('button', { type: 'button', className: 'dsh-dingtalk-close', onClick: close, 'aria-label': '关闭钉钉面板' }, '×'),
          ),
          h('div', { className: 'dsh-dingtalk-body' },
            error ? h('div', { className: 'dsh-dingtalk-alert error', role: 'alert' }, error) : null,
            notice ? h('div', { className: 'dsh-dingtalk-alert success', role: 'status' }, notice) : null,
            h('div', { className: 'dsh-dingtalk-state' }, h(Dot, { color }), h('strong', null, headline), h('span', null, statusDescription(state))),
            h('p', { className: 'dsh-dingtalk-intro' }, '钉钉支持收任务/续聊/审批/图片/流式结果；会话仍由大神 Host 与官方连接器共同管理。'),
            h('section', { className: 'dsh-dingtalk-section' },
              h('div', { className: 'dsh-dingtalk-section-title' }, '连接状态'),
              h('div', { className: 'dsh-dingtalk-grid' },
                h('span', null, '官方插件', h('strong', null, state?.package?.version || '未安装')),
                h('span', null, '凭据', h('strong', null, state?.credentials?.configured ? '已配置' : '待配置')),
                h('span', null, '管理员', h('strong', null, state?.ownerBound ? '已绑定' : '待绑定')),
                h('span', null, 'Stream', h('strong', null, STREAM_LABEL[status] || '未观测')),
                h('span', null, 'AI Card', h('strong', null, cardText)),
                h('span', null, '最近观测', h('strong', null, observed)),
                h('span', null, '已绑定会话', h('strong', null, Number(state?.boundSessionCount || 0))),
              ),
            ),
            nativeSubscriberAdminAvailable() ? h('section', { className: 'dsh-dingtalk-section' },
              h('div', { className: 'dsh-dingtalk-admin-card' },
                h('div', { className: 'dsh-dingtalk-admin-copy' },
                  h('div', { className: 'dsh-dingtalk-admin-title' }, h('strong', null, '订阅管理'), h('span', null, '仅大神.app')),
                  h('p', null, '添加订阅者，设置工作区、模式、模型、推理强度、周额度和逐只虾权限。'),
                ),
                h('button', { ref: firstFocusRef, type: 'button', onClick: openSubscriptions }, '进入管理'),
              ),
            ) : null,
            h('section', { className: 'dsh-dingtalk-section' },
              h('div', { className: 'dsh-dingtalk-section-title' }, '最近钉钉会话'),
              Array.isArray(state?.sessions) && state.sessions.length
                ? h('div', { className: 'dsh-dingtalk-sessions' }, state.sessions.map((session) => h('div', { className: 'dsh-dingtalk-session', key: session.sessionId },
                    h('div', { className: 'dsh-dingtalk-session-main' }, h('strong', null, session.title || '钉钉会话'), h('small', null, session.running ? '执行中' : '已暂停')),
                    h('button', { type: 'button', onClick: () => { void openSession(session.sessionId) }, title: '打开对应会话' }, '打开'),
                  )))
                : h('div', { className: 'dsh-dingtalk-empty' }, '暂无可显示的绑定会话。'),
            ),
            h('section', { className: 'dsh-dingtalk-section' },
              h('div', { className: 'dsh-dingtalk-section-title' }, '真实边界'),
              h('p', { className: 'dsh-dingtalk-note' }, '当前官方连接器不支持入站文件、音频、视频；输出以 AI Card 或 Markdown 为主。本地产物仍需在大神会话中打开。'),
            ),
            !state?.credentials?.configured ? h('section', { className: 'dsh-dingtalk-section' },
              h('div', { className: 'dsh-dingtalk-section-title' }, '本机配置'),
              h('p', { className: 'dsh-dingtalk-note' }, '请在独立本机终端手动执行以下固定命令；面板不会自动执行，也不会读取或录制私密终端。'),
              h('div', { className: 'dsh-dingtalk-command' }, h('code', null, state?.setupCommand || 'npx @dingtalk-real-ai/dsh-dingtalk@0.6.2 setup'), h('button', { ref: firstFocusRef, type: 'button', onClick: copySetup }, '复制命令')),
            ) : null,
          ),
        ),
      )
    }

    function apply(ctx) {
      openHostSession = ctx.sessions.open.bind(ctx.sessions)
      const style = document.createElement('style')
      style.id = 'dsh-dingtalk-status-styles'
      style.textContent = `
        [data-slot="sidebar.footer.action"]{box-sizing:border-box!important;display:flex!important;flex-direction:column!important;align-items:stretch!important;gap:6px!important;width:100%!important;min-width:0!important}
        [data-slot="sidebar.footer.action"] > .dsh-sidebar-footer-entry,[data-slot="sidebar.footer.action"] > .dsbalance-card,[data-slot="sidebar.footer.action"] > .dsbalance-rail{box-sizing:border-box!important;display:flex!important;flex:0 0 auto!important;align-items:center!important;width:100%!important;max-width:none!important;height:36px!important;min-height:36px!important;margin:0!important;min-width:0!important}
        [data-sidebar-collapsed] [data-slot="sidebar.footer.action"]{width:36px!important;align-items:center!important;gap:4px!important}
        [data-sidebar-collapsed] [data-slot="sidebar.footer.action"] > .dsh-sidebar-footer-entry,[data-sidebar-collapsed] [data-slot="sidebar.footer.action"] > .dsbalance-card,[data-sidebar-collapsed] [data-slot="sidebar.footer.action"] > .dsbalance-rail{width:36px!important;min-width:36px!important;max-width:36px!important;height:36px!important;min-height:36px!important;padding:0!important}
        .dsh-dingtalk-root{box-sizing:border-box;position:relative;display:flex;align-items:center;flex:0 0 auto;width:auto;height:36px;min-height:36px;font:13px/1.4 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--dsw-alias-label-primary,#f5f6f7)}
            .dsh-dingtalk-trigger{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:7px;height:36px;min-height:36px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:999px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#f5f6f7);cursor:pointer;white-space:nowrap;line-height:1}.dsh-dingtalk-trigger:hover,.dsh-dingtalk-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));border-color:#35a56f88}.dsh-dingtalk-trigger svg,.dsh-dingtalk-mark svg{display:block;width:17px;height:17px;flex:0 0 17px}.dsh-dingtalk-trigger-dot{margin-left:auto;width:8px;height:8px;flex:0 0 8px;border-radius:50%;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 12%,transparent)}
        .dsh-dingtalk-backdrop{position:fixed;inset:0;z-index:10020;background:rgba(8,12,18,.43);backdrop-filter:blur(1px)}
        .dsh-dingtalk-dialog{position:fixed;z-index:10021;top:56px;right:18px;bottom:18px;display:flex;flex-direction:column;box-sizing:border-box;width:min(620px,calc(100vw - 36px));max-height:calc(100vh - 74px);overflow:hidden;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:16px;background:var(--dsw-alias-bg-layer-1,#191b1f);box-shadow:0 24px 80px rgba(0,0,0,.5);color:var(--dsw-alias-label-primary,#f5f6f7);outline:none;left:calc(50% + var(--dsh-sidebar-half-width,140px))!important;right:auto!important;transform:translateX(-50%)}
        .dsh-dingtalk-title-row{display:flex;align-items:center;gap:10px;min-width:0}.dsh-dingtalk-head{display:flex;align-items:center;justify-content:space-between;min-height:68px;padding:0 18px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));flex:none}.dsh-dingtalk-mark{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;color:#35a56f;background:#35a56f18}.dsh-dingtalk-head h2{margin:0;font-size:16px;line-height:22px}.dsh-dingtalk-head p{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px}.dsh-dingtalk-close{display:grid;place-items:center;width:32px;height:32px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary,#8c949d);font-size:21px;cursor:pointer}
        .dsh-dingtalk-body{display:flex;flex-direction:column;min-height:0;flex:1;overflow:auto;padding:13px 15px 16px}.dsh-dingtalk-alert{padding:8px 10px;margin-bottom:9px;border-radius:9px;font-size:12px}.dsh-dingtalk-alert.error{background:#d84c4516;color:#f08077}.dsh-dingtalk-alert.success{background:#35a56f16;color:#68c895}.dsh-dingtalk-state{display:flex;align-items:center;gap:8px;padding:10px 11px;margin-bottom:12px;border:1px solid #35a56f30;border-radius:10px;background:#35a56f0d}.dsh-dingtalk-state span:last-child{margin-left:auto;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsh-dingtalk-intro{margin:0 0 3px;color:var(--dsw-alias-label-secondary,#b1b7bf);font-size:11px;line-height:18px}.dsh-dingtalk-section{padding:12px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.13))}.dsh-dingtalk-section-title{margin-bottom:9px;color:var(--dsw-alias-label-secondary,#b1b7bf);font-size:12px;font-weight:650}.dsh-dingtalk-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:9px;border-radius:9px;background:var(--dsw-alias-bg-base,#141619);color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10px}.dsh-dingtalk-grid span{display:flex;flex-direction:column;gap:3px}.dsh-dingtalk-grid strong{color:var(--dsw-alias-label-primary,#f5f6f7);font-size:11px;font-weight:550}.dsh-dingtalk-sessions{display:grid;gap:6px}.dsh-dingtalk-session{display:flex;align-items:center;gap:8px;min-width:0;padding:8px 9px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.15));border-radius:9px;background:var(--dsw-alias-bg-base,#141619)}.dsh-dingtalk-session-main{display:flex;flex-direction:column;min-width:0;flex:1}.dsh-dingtalk-session-main strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.dsh-dingtalk-session-main small{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10px}.dsh-dingtalk-session button{min-height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:7px;background:transparent;color:inherit;font-size:10px;cursor:pointer;white-space:nowrap}.dsh-dingtalk-empty{padding:8px;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10px}.dsh-dingtalk-note{margin:0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10px;line-height:16px}.dsh-dingtalk-command{display:flex;align-items:center;gap:8px;padding:9px;border-radius:9px;background:var(--dsw-alias-bg-base,#141619)}.dsh-dingtalk-command code{min-width:0;overflow:auto;color:var(--dsw-alias-label-primary,#f5f6f7);font:10px/16px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}.dsh-dingtalk-command button{flex:none;min-height:28px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:8px;background:transparent;color:inherit;font-size:11px;cursor:pointer}
            [data-dsh-sidebar-foot]{box-sizing:border-box!important;display:grid!important;grid-template-columns:minmax(0,1fr) minmax(0,1fr)!important;grid-template-rows:auto auto!important;align-items:center!important;gap:6px 8px!important;width:100%!important;min-width:0!important}
            [data-dsh-footer-actions],[data-dsh-settings-area]{display:contents!important}
            [data-dsh-footer-actions] > [data-slot="sidebar.footer.action"],[data-dsh-settings-area] > [data-slot="sidebar.settings"]{display:contents!important}
            .dsh-dingtalk-root{grid-column:2!important;grid-row:2!important;width:100%!important}.dsh-dingtalk-trigger{width:100%!important;justify-content:flex-start!important}[data-dsh-sidebar-foot] .dsbalance-card{grid-column:1 / -1!important;grid-row:1!important;width:100%!important;margin:0!important}[data-dsh-sidebar-foot] [data-slot="sidebar.settings"] > *{grid-column:1!important;grid-row:2!important;width:100%!important;margin:0!important}
            [data-sidebar-collapsed] [data-dsh-sidebar-foot]{display:flex!important;flex-direction:column!important;align-items:center!important;gap:4px!important;width:36px!important}[data-sidebar-collapsed] [data-dsh-sidebar-foot] .dsbalance-rail{order:1!important;width:36px!important;height:36px!important;margin:0!important}[data-sidebar-collapsed] [data-dsh-sidebar-foot] .dsh-dingtalk-root{order:2!important;width:36px!important;height:36px!important}[data-sidebar-collapsed] [data-dsh-sidebar-foot] [data-slot="sidebar.settings"] > *{order:3!important;width:36px!important;height:36px!important;padding:0!important;justify-content:center!important}.dsh-dingtalk-trigger-label,.dsh-dingtalk-trigger-dot{display:inline}
            @media(max-width:520px) and (pointer:coarse),(max-width:380px){.dsh-dingtalk-trigger-label,.dsh-dingtalk-trigger-dot{display:none}.dsh-dingtalk-trigger{width:36px;padding:0;justify-content:center}.dsh-dingtalk-dialog{left:8px!important;right:8px!important;transform:none;width:calc(100vw - 16px)!important}.dsh-dingtalk-grid{grid-template-columns:1fr}}
      `
      style.textContent += `.dsh-dingtalk-admin-card{display:flex;align-items:center;gap:14px;padding:12px;border:1px solid #35a56f38;border-radius:10px;background:linear-gradient(135deg,#35a56f12,rgba(20,22,25,.92))}.dsh-dingtalk-admin-copy{min-width:0;flex:1}.dsh-dingtalk-admin-title{display:flex;align-items:center;gap:8px}.dsh-dingtalk-admin-title strong{font-size:12px}.dsh-dingtalk-admin-title span{padding:2px 6px;border-radius:999px;background:#35a56f1d;color:#75d09c;font-size:9px}.dsh-dingtalk-admin-copy p{margin:5px 0 0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10px;line-height:16px}.dsh-dingtalk-admin-card button{flex:none;min-height:30px;padding:0 10px;border:1px solid #35a56f55;border-radius:8px;background:#244332;color:#dcf6e6;font-size:11px;cursor:pointer}`
      document.getElementById(style.id)?.remove()
      document.head.appendChild(style)
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
        const width = sidebarRoot?.getBoundingClientRect?.().width || 0
        document.documentElement.style.setProperty('--dsh-sidebar-half-width', `${Math.max(28, width > 0 ? width / 2 : 140)}px`)
      }
      markSidebarFoot()
      const observer = new MutationObserver(markSidebarFoot)
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-sidebar-collapsed'] })
      let resize
      const root = document.querySelector('[data-dsh-sidebar-foot]')?.parentElement
      if (root && typeof ResizeObserver !== 'undefined') { resize = new ResizeObserver(markSidebarFoot); resize.observe(root) }
      ctx.effect(() => () => { observer.disconnect(); resize?.disconnect(); document.documentElement.style.removeProperty('--dsh-sidebar-half-width'); style.remove() }, 'dsh-dingtalk-status: styles')
      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-dingtalk-status', order: 70, label: '钉钉' }, DingTalkPanel)), 'dsh-dingtalk-status: sidebar footer')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
