// dsh-dsbalance — Client half(浏览器 ModuleLoader 格式)
// 输入框下方显示 DeepSeek 余额 + 充值入口; 每 60 秒刷新
// 数据源: 同源 fetch /api/dsbalance/balance(Host 路由,服务端持有密钥)
window.__ModuleLoader__.load({
  id: '@local/dsh-dsbalance',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    let React = require('react')

    const inject = ['slots', 'timer']

    function apply(ctx) {
      const slots = ctx.slots
      const timer = ctx.get('timer')

      const style = document.createElement('style')
      style.textContent = [
        '.dsbalance-row { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--color-text-3, #8a8f98); line-height: 1; }',
        '.dsbalance-row a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }',
        '.dsbalance-low { color: #e5484d; font-weight: 600; }',
      ].join('\n')
      document.head.appendChild(style)
      ctx.effect(() => { document.head.removeChild(style) }, 'dsbalance: styles')

      ctx.effect(() => slots.inject('conversation.composer.dock', () => slots.register(
        { name: 'conversation.composer.dock', id: 'dsbalance', order: 5 },
        () => {
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

          const topUp = React.createElement('a', { href: 'https://platform.deepseek.com/top_up', target: '_blank', rel: 'noreferrer' }, '充值')
          if (state === null) {
            return React.createElement('div', { className: 'dsbalance-row' }, 'DeepSeek 余额查询中…')
          }
          if (!state.ok) {
            return React.createElement('div', { className: 'dsbalance-row' }, '余额不可用', topUp)
          }
          const infos = state.infos || []
          const main = infos.find((b) => b.currency === 'CNY') || infos[0]
          const total = main ? main.total : null
          const low = total !== null && Number(total) < 10
          const label = total !== null ? '¥' + total : '—'
          return React.createElement(
            'div',
            { className: 'dsbalance-row' + (low ? ' dsbalance-low' : '') },
            'DeepSeek 余额 ' + label,
            low ? '余额不足' : null,
            topUp,
          )
        },
      )), 'dsbalance: composer dock')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
