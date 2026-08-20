// dsh-dsbalance — Client half(浏览器 ModuleLoader 格式)
// 侧边栏底部显示 DeepSeek API 余额 + 充值入口；每 60 秒刷新。
// 数据源: 同源 fetch /api/dsbalance/balance(Host 路由,服务端持有密钥)
window.__ModuleLoader__.load({
  id: '@local/dsh-dsbalance',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    let React = require('react')

    // styles: 注入在模块顶层而非 apply 内 —— HMR 重载(entry.refresh 重跑 factory)后样式可恢复；
    // 先删后建幂等注入；挂 data-plugin 让 client-hmr 的 removeOwnedStyles 一致管理。
    if (typeof document !== 'undefined') {
      const style = document.createElement('style')
      style.id = 'dsbalance-styles'
      style.dataset.plugin = '@local/dsh-dsbalance'
      style.textContent = [
        '.dsbalance-card { box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; height: 38px; margin: 0 0 6px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2)); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, color-mix(in srgb, currentColor 3%, transparent)); color: var(--dsw-alias-label-primary, #1f2329); text-decoration: none; font: 12px/1.2 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; transition: background .15s ease, border-color .15s ease; }',
        '.dsbalance-card:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); border-color: color-mix(in srgb, var(--dsw-alias-label-secondary, #8a8f98) 42%, transparent); }',
        '.dsbalance-card:focus-visible { outline: 2px solid #5b8ff9; outline-offset: 2px; }',
        '.dsbalance-dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: #35a56f; box-shadow: 0 0 0 3px color-mix(in srgb, #35a56f 14%, transparent); }',
        '.dsbalance-label { min-width: 0; color: var(--dsw-alias-label-secondary, #747982); white-space: nowrap; }',
        '.dsbalance-value { margin-left: auto; color: var(--dsw-alias-label-primary, #1f2329); font-weight: 650; white-space: nowrap; }',
        '.dsbalance-topup { color: #e55f48; font-weight: 600; white-space: nowrap; }',
        '.dsbalance-low .dsbalance-dot { background: #e5484d; box-shadow: 0 0 0 3px color-mix(in srgb, #e5484d 14%, transparent); }',
        '.dsbalance-low .dsbalance-value { color: #e5484d; }',
        '.dsbalance-unavailable .dsbalance-dot { background: #9aa0a8; box-shadow: none; }',
        '.dsbalance-rail { display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; margin-bottom: 6px; border-radius: 9px; color: var(--dsw-alias-label-primary, #1f2329); text-decoration: none; font: 650 13px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }',
        '.dsbalance-rail:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }',
        'body[data-ds-dark-theme] .dsbalance-card, body[data-ds-dark-theme] .dsbalance-rail { color: var(--dsw-alias-label-primary, #f5f6f7); }',
      ].join('\n')
      document.getElementById(style.id)?.remove()
      document.head.appendChild(style)
    }

    const inject = ['slots', 'timer']

    function apply(ctx) {
      const slots = ctx.slots
      const timer = ctx.get('timer')

      ctx.effect(() => slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'dsbalance', order: 90, label: 'DeepSeek API 余额' },
        (props) => {
          const [state, setState] = React.useState(null)
          React.useEffect(() => {
            let disposed = false
            const load = () => {
              fetch('/api/dsbalance/balance', { cache: 'no-store' })
                .then((r) => r.json())
                .then((data) => { if (!disposed) setState(data) })
                .catch((e) => { if (!disposed) setState({ ok: false, error: String(e) }) })
            }
            load()
            const id = timer ? timer.interval(load, 60000) : null
            return () => { disposed = true; if (id !== null) id() }
          }, [])

          const ok = Boolean(state && state.ok)
          const infos = ok ? (state.infos || []) : []
          const main = infos.find((b) => b.currency === 'CNY') || infos[0]
          const total = main ? main.total : null
          const low = total !== null && Number(total) < 10
          const value = state === null ? '查询中…' : total !== null ? '¥' + total : '—'
          const title = state === null
            ? 'DeepSeek API 余额查询中'
            : ok
              ? 'DeepSeek API 余额 ' + value + '，点击前往官方充值'
              : '余额暂不可用，点击前往 DeepSeek 官方平台'
          const className = ok ? (low ? 'dsbalance-card dsbalance-low' : 'dsbalance-card') : 'dsbalance-card dsbalance-unavailable'
          if (!(props && props.wide)) {
            return React.createElement(
              'a',
              {
                className: 'dsbalance-rail' + (low ? ' dsbalance-low' : ''),
                href: 'https://platform.deepseek.com/top_up',
                target: '_blank',
                rel: 'noopener noreferrer',
                title,
                'aria-label': title,
              },
              '¥',
            )
          }
          return React.createElement(
            'a',
            {
              className,
              href: 'https://platform.deepseek.com/top_up',
              target: '_blank',
              rel: 'noopener noreferrer',
              title,
              'aria-label': title,
            },
            React.createElement('span', { className: 'dsbalance-dot', 'aria-hidden': true }),
            React.createElement('span', { className: 'dsbalance-label' }, ok ? 'API 余额' : '余额暂不可用'),
            React.createElement('span', { className: 'dsbalance-value' }, value),
            React.createElement('span', { className: 'dsbalance-topup' }, '充值 ↗'),
          )
        },
      )), 'dsbalance: sidebar footer')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
