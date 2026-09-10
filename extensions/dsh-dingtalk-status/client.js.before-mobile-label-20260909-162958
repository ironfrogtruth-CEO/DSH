// @local/dsh-dingtalk-status — mobile gateway client half.
//
// One-click recovery button: the footer entry shows the tunnel state dot and
// clicking it runs the full recovery (tunnel + gateway edge + netwatch) and
// reports via a toast. No dialog, no extra chrome.
window.__ModuleLoader__.load({
  id: '@local/dsh-dingtalk-status',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const inject = ['slots']
    const safe = (value, fallback = '') => String(value ?? fallback)

    function GatewayIcon() {
      return h('svg', { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('rect', { x: '6.5', y: '2.8', width: '11', height: '18.4', rx: '2.6', stroke: 'currentColor', 'stroke-width': '1.7' }),
        h('path', { d: 'M10.3 5.4h3.4', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' }),
        h('circle', { cx: '12', cy: '18', r: '1.15', fill: 'currentColor' }),
      )
    }

    const STATE_LABEL = { connected: '隧道已连接', degraded: '隧道降级', stopped: '隧道未运行' }

    function stateColor(state) {
      if (state === 'connected') return '#35a56f'
      if (state === 'degraded') return '#e3a72f'
      return '#d84c45'
    }

    async function readStatus() {
      const response = await fetch('/api/mobile-gateway/status', { cache: 'no-store', headers: { Accept: 'application/json' } })
      const value = await response.json().catch(() => ({}))
      if (!response.ok || value.ok === false) throw new Error(value.error || `状态读取失败(${response.status})`)
      return value
    }

    async function postRecover() {
      const response = await fetch('/api/mobile-gateway/action', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'recover' }),
      })
      const value = await response.json().catch(() => ({}))
      if (!response.ok || value.ok === false) throw new Error(value.error || `恢复失败(${response.status})`)
      return value
    }

    let toastTimer = null
    function showToast(text, isError) {
      let toast = document.getElementById('dsh-mobile-gateway-toast')
      if (!toast) {
        toast = document.createElement('div')
        toast.id = 'dsh-mobile-gateway-toast'
        toast.setAttribute('role', 'status')
        document.body.appendChild(toast)
      }
      toast.textContent = text
      toast.dataset.visible = 'true'
      toast.dataset.error = isError ? 'true' : 'false'
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => { toast.dataset.visible = 'false' }, 3200)
    }

    function MobileGatewayEntry() {
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        const load = () => { readStatus().then(setState).catch(() => {}) }
        load()
        const timer = setInterval(load, 10_000)
        return () => clearInterval(timer)
      }, [])

      const recover = async () => {
        if (busy) return
        setBusy(true)
        try {
          const next = await postRecover()
          setState(next)
          showToast('已全量恢复（隧道 + 网关 + 守护），几秒内生效', false)
        } catch (cause) {
          showToast(safe(cause?.message, '恢复失败，请稍后再试'), true)
        } finally { setBusy(false) }
      }

      const stateKey = state?.state || 'connected'
      const headline = STATE_LABEL[stateKey] || '状态未知'
      const color = stateColor(stateKey)
      return h('div', { className: 'dsh-dingtalk-root dsh-sidebar-footer-entry' },
        h('button', {
          type: 'button', className: 'dsh-dingtalk-trigger', 'aria-label': `移动端连接：${headline}，点击全量恢复`,
          title: `移动端连接：${headline} · 点击全量恢复`, onClick: recover,
        },
          h(GatewayIcon),
          h('span', { className: 'dsh-dingtalk-trigger-label' }, busy ? '恢复中…' : '移动端'),
          h('span', { className: 'dsh-dingtalk-trigger-dot', 'aria-hidden': true, style: { background: color } }),
        ),
      )
    }

    function apply(ctx) {
      const style = document.createElement('style')
      style.id = 'dsh-dingtalk-status-styles'
      style.textContent = `
        [data-slot="sidebar.footer.action"]{box-sizing:border-box!important;display:flex!important;flex-direction:column!important;align-items:stretch!important;gap:6px!important;width:100%!important;min-width:0!important}
        [data-slot="sidebar.footer.action"] > .dsh-sidebar-footer-entry,[data-slot="sidebar.footer.action"] > .dsbalance-card,[data-slot="sidebar.footer.action"] > .dsbalance-rail{box-sizing:border-box!important;display:flex!important;flex:0 0 auto!important;align-items:center!important;width:100%!important;max-width:none!important;height:36px!important;min-height:36px!important;margin:0!important;min-width:0!important}
        [data-sidebar-collapsed] [data-slot="sidebar.footer.action"]{width:36px!important;align-items:center!important;gap:4px!important}
        [data-sidebar-collapsed] [data-slot="sidebar.footer.action"] > .dsh-sidebar-footer-entry,[data-sidebar-collapsed] [data-slot="sidebar.footer.action"] > .dsbalance-card,[data-sidebar-collapsed] [data-slot="sidebar.footer.action"] > .dsbalance-rail{width:36px!important;min-width:36px!important;max-width:36px!important;height:36px!important;min-height:36px!important;padding:0!important}
        .dsh-dingtalk-root{box-sizing:border-box;position:relative;display:flex;align-items:center;flex:0 0 auto;width:auto;height:36px;min-height:36px;font:13px/1.4 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--dsw-alias-label-primary,#f5f6f7)}
            .dsh-dingtalk-trigger{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:7px;height:36px;min-height:36px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:999px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#f5f6f7);cursor:pointer;white-space:nowrap;line-height:1}.dsh-dingtalk-trigger[disabled]{opacity:.6;cursor:wait}.dsh-dingtalk-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}.dsh-dingtalk-trigger svg{display:block;width:17px;height:17px;flex:0 0 17px}.dsh-dingtalk-trigger-dot{margin-left:auto;width:8px;height:8px;flex:0 0 8px;border-radius:50%;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 12%,transparent)}
            #dsh-mobile-gateway-toast{position:fixed;left:50%;bottom:76px;transform:translateX(-50%) translateY(8px);z-index:10060;max-width:min(78vw,420px);padding:9px 14px;border:1px solid rgba(128,128,128,.3);border-radius:10px;background:rgba(20,24,30,.96);color:#eef1f5;font:12px/1.5 ui-sans-serif,-apple-system,sans-serif;opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease}
            #dsh-mobile-gateway-toast[data-visible="true"]{opacity:1;transform:translateX(-50%) translateY(0)}
            #dsh-mobile-gateway-toast[data-error="true"]{border-color:#d84c4588;color:#f0a29b}
        [data-dsh-sidebar-foot]{box-sizing:border-box!important;display:grid!important;grid-template-columns:minmax(0,1fr) minmax(0,1fr)!important;grid-template-rows:auto auto!important;align-items:center!important;gap:6px 8px!important;width:100%!important;min-width:0!important}
        [data-dsh-footer-actions],[data-dsh-settings-area]{display:contents!important}
        [data-dsh-footer-actions] > [data-slot="sidebar.footer.action"],[data-dsh-settings-area] > [data-slot="sidebar.settings"]{display:contents!important}
        .dsh-dingtalk-root{grid-column:2!important;grid-row:2!important;width:100%!important}.dsh-dingtalk-trigger{width:100%!important;justify-content:flex-start!important}[data-dsh-sidebar-foot] .dsbalance-card{grid-column:1 / -1!important;grid-row:1!important;width:100%!important;margin:0!important}[data-dsh-sidebar-foot] [data-slot="sidebar.settings"] > *{grid-column:1!important;grid-row:2!important;width:100%!important;margin:0!important}
        [data-sidebar-collapsed] [data-dsh-sidebar-foot]{display:flex!important;flex-direction:column!important;align-items:center!important;gap:4px!important;width:36px!important}[data-sidebar-collapsed] [data-dsh-sidebar-foot] .dsbalance-rail{order:1!important;width:36px!important;height:36px!important;margin:0!important}[data-sidebar-collapsed] [data-dsh-sidebar-foot] .dsh-dingtalk-root{order:2!important;width:36px!important;height:36px!important}[data-sidebar-collapsed] [data-dsh-sidebar-foot] [data-slot="sidebar.settings"] > *{order:3!important;width:36px!important;height:36px!important;padding:0!important;justify-content:center!important}.dsh-dingtalk-trigger-label,.dsh-dingtalk-trigger-dot{display:inline}
        @media(max-width:520px) and (pointer:coarse),(max-width:380px){.dsh-dingtalk-trigger-label,.dsh-dingtalk-trigger-dot{display:none}.dsh-dingtalk-trigger{width:36px;padding:0;justify-content:center}}
      `
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
      ctx.effect(() => () => { observer.disconnect(); resize?.disconnect(); document.documentElement.style.removeProperty('--dsh-sidebar-half-width'); style.remove(); document.getElementById('dsh-mobile-gateway-toast')?.remove() }, 'dsh-dingtalk-status: styles')
      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-dingtalk-status', order: 70, label: '移动端' }, MobileGatewayEntry)), 'dsh-dingtalk-status: sidebar footer')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
