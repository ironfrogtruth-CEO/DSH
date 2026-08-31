// dsh-dsbalance — Client half (浏览器 ModuleLoader 格式)
// 侧边栏底部同时显示 DS / GLM 余额；金额各自直达官方账户页，每 60 秒刷新。
// 数据源：同源 fetch /api/dsbalance/balance?provider=deepseek|zhipu（Host 路由，服务端持有密钥）
window.__ModuleLoader__.load({
  id: '@local/dsh-dsbalance',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const BRANDS = {
      deepseek: {
        key: 'deepseek',
        short: 'DS',
        full: 'DeepSeek',
        apiProvider: 'deepseek',
        topUpUrl: 'https://platform.deepseek.com/top_up',
        dot: '#4d6bfe',
      },
      zhipu: {
        key: 'zhipu',
        short: 'GLM',
        full: '智谱 GLM',
        apiProvider: 'zhipu',
        topUpUrl: 'https://open.bigmodel.cn/finance-center/finance/overview',
        dot: '#2b9ef3',
      },
    }
    const BRAND_LIST = [BRANDS.deepseek, BRANDS.zhipu]
    const LOW_BALANCE_THRESHOLD = 10

    // styles：顶层幂等注入，HMR 重载后样式可恢复；挂 data-plugin 让 client-hmr 一致管理。
    if (typeof document !== 'undefined') {
      const style = document.createElement('style')
      style.id = 'dsbalance-styles'
      style.dataset.plugin = '@local/dsh-dsbalance'
      style.textContent = [
        '.dsbalance-card { box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; height: 38px; margin: 0 0 6px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2)); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, color-mix(in srgb, currentColor 3%, transparent)); color: var(--dsw-alias-label-primary, #1f2329); font: 12px/1.2 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; transition: background .15s ease, border-color .15s ease; }',
        '.dsbalance-card:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); border-color: color-mix(in srgb, var(--dsw-alias-label-secondary, #8a8f98) 42%, transparent); }',
        '.dsbalance-card:focus-within { outline: 2px solid #5b8ff9; outline-offset: 2px; }',
        '.dsbalance-label { flex: 0 0 auto; color: var(--dsw-alias-label-secondary, #747982); white-space: nowrap; }',
        '.dsbalance-providers { display: flex; align-items: center; justify-content: flex-end; gap: 10px; min-width: 0; margin-left: auto; }',
        '.dsbalance-provider { display: inline-flex; align-items: baseline; gap: 4px; min-width: 0; white-space: nowrap; }',
        '.dsbalance-badge { box-sizing: border-box; flex: 0 0 auto; min-width: 26px; height: 18px; padding: 0 6px; display: inline-flex; align-items: center; justify-content: center; border-radius: 5px; color: #fff; font: 700 10px/1 ui-sans-serif, -apple-system, "Segoe UI", sans-serif; letter-spacing: .02em; }',
        '.dsbalance-value { color: var(--dsw-alias-label-primary, #1f2329); font-weight: 650; text-decoration: none; text-underline-offset: 3px; }',
        '.dsbalance-value:hover { color: #5b8ff9; text-decoration: underline; }',
        '.dsbalance-value:focus-visible { color: #5b8ff9; text-decoration: underline; outline: 2px solid #5b8ff9; outline-offset: 2px; border-radius: 3px; }',
        '.dsbalance-low .dsbalance-value { color: #e5484d; }',
        '.dsbalance-low .dsbalance-value:hover, .dsbalance-low .dsbalance-value:focus-visible { color: #f06a6e; }',
        '.dsbalance-unavailable .dsbalance-value { color: var(--dsw-alias-label-secondary, #747982); }',
        '.dsbalance-rail { display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; margin-bottom: 6px; border-radius: 9px; color: var(--dsw-alias-label-primary, #1f2329); font: 650 13px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }',
        'body[data-ds-dark-theme] .dsbalance-card, body[data-ds-dark-theme] .dsbalance-rail { color: var(--dsw-alias-label-primary, #f5f6f7); }',
      ].join('\n')
      document.getElementById(style.id)?.remove()
      document.head.appendChild(style)
    }

    const inject = ['slots', 'timer']

    function errorText(cause) {
      return String(cause && cause.message ? cause.message : cause || '余额读取失败')
    }

    function amountFrom(data) {
      if (!data || data.ok !== true || data.balanceUnknown === true || !Array.isArray(data.infos)) return null
      const main = data.infos.find((item) => item && item.currency === 'CNY') || data.infos[0]
      const amount = main && main.total
      const number = amount === null || amount === undefined || amount === '' ? NaN : Number(amount)
      return Number.isFinite(number) ? number : null
    }

    function displayAmount(state) {
      const amount = amountFrom(state && state.data)
      return amount === null ? '—' : '¥' + amount.toFixed(2)
    }

    function apply(ctx) {
      const slots = ctx.slots
      const timer = ctx.get('timer')

      ctx.effect(() => slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'dsbalance', order: 90, label: '余额' },
        (props) => {
          // 每个 provider 使用独立 key；一侧失败只更新自己的 state，另一侧继续保留结果。
          const [balances, setBalances] = React.useState({ deepseek: null, zhipu: null })

          React.useEffect(() => {
            let disposed = false

            const loadProvider = (brand) => fetch(
              '/api/dsbalance/balance?provider=' + brand.apiProvider,
              { cache: 'no-store', headers: { Accept: 'application/json' } },
            )
              .then((response) => response.json().then((data) => {
                if (response.ok === false || data?.ok === false) {
                  throw new Error(data?.error || `状态读取失败(${response.status || 0})`)
                }
                return data
              }))
              .then((data) => {
                if (disposed) return
                setBalances((previous) => ({
                  ...previous,
                  [brand.key]: { data, error: null },
                }))
              })
              .catch((cause) => {
                if (disposed) return
                setBalances((previous) => ({
                  ...previous,
                  [brand.key]: { data: null, error: errorText(cause) },
                }))
              })

            // 不等待任一请求，两个 provider 在同一轮并行启动且各自处理结果。
            const loadAll = () => { void Promise.all(BRAND_LIST.map(loadProvider)) }
            loadAll()
            const cancel = timer && typeof timer.interval === 'function'
              ? timer.interval(loadAll, 60000)
              : setInterval(loadAll, 60000)
            return () => {
              disposed = true
              if (typeof cancel === 'function') cancel()
              else clearInterval(cancel)
            }
          }, [])

          if (!(props && props.wide)) {
            return React.createElement(
              'span',
              {
                className: 'dsbalance-rail',
                title: '余额：展开侧栏查看 DS 与 GLM',
                'aria-label': '余额：展开侧栏查看 DS 与 GLM',
              },
              '¥',
            )
          }

          return React.createElement(
            'div',
            { className: 'dsbalance-card', role: 'group', 'aria-label': '余额' },
            React.createElement('span', { className: 'dsbalance-label' }, '余额'),
            React.createElement(
              'div',
              { className: 'dsbalance-providers' },
              BRAND_LIST.map((brand) => {
                const state = balances[brand.key]
                const amount = amountFrom(state && state.data)
                const value = displayAmount(state)
                const low = amount !== null && amount < LOW_BALANCE_THRESHOLD
                const unavailable = amount === null
                const providerTitle = state === null
                  ? brand.full + ' 余额查询中，点击金额打开官方账户页面'
                  : unavailable
                    ? brand.full + ' 余额暂不可用，点击金额打开官方账户页面'
                    : brand.full + ' 余额 ' + value + '，点击金额打开官方账户页面'
                return React.createElement(
                  'span',
                  { className: 'dsbalance-provider' + (low ? ' dsbalance-low' : '') + (unavailable ? ' dsbalance-unavailable' : ''), key: brand.key },
                  React.createElement('span', {
                    className: 'dsbalance-badge',
                    style: { background: brand.dot },
                    'aria-hidden': true,
                  }, brand.short),
                  React.createElement(
                    'a',
                    {
                      className: 'dsbalance-value',
                      href: brand.topUpUrl,
                      target: '_blank',
                      rel: 'noopener noreferrer',
                      title: providerTitle,
                      'aria-label': providerTitle,
                    },
                    value,
                  ),
                )
              }),
            ),
          )
        },
      )), 'dsbalance: sidebar footer')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
