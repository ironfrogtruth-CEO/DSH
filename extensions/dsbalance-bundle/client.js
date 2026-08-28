// dsh-dsbalance — Client half(浏览器 ModuleLoader 格式)
// 侧边栏底部显示当前品牌(DS/GLM)的 API 余额 + 充值入口;每 60 秒刷新。
// 感知: 订阅 modelDirectories 的会话目录, 模型选择器切换 provider 后卡片联动。
// 数据源: 同源 fetch /api/dsbalance/balance?provider=deepseek|zhipu(Host 路由,服务端持有密钥)
window.__ModuleLoader__.load({
  id: '@local/dsh-dsbalance',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    let React = require('react')

    // 品牌注册表: key → 展示信息。品牌缩写按用户要求用 DS / GLM。
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
    // provider route(模型选择器里的 provider id)→ 品牌 key; 未知回退 DeepSeek。
    function brandForProvider(provider) {
      if (typeof provider !== 'string' || provider.length === 0) return 'deepseek'
      const p = provider.toLowerCase()
      if (p.includes('zhipu') || p.includes('zai') || p.includes('glm') || p === 'zhipu-glm') return 'zhipu'
      if (p.includes('deepseek') || p.includes('ds')) return 'deepseek'
      return 'deepseek'
    }

    // styles: 注入在模块顶层而非 apply 内 —— HMR 重载(entry.refresh 重跑 factory)后样式可恢复;
    // 先删后建幂等注入;挂 data-plugin 让 client-hmr 的 removeOwnedStyles 一致管理。
    if (typeof document !== 'undefined') {
      const style = document.createElement('style')
      style.id = 'dsbalance-styles'
      style.dataset.plugin = '@local/dsh-dsbalance'
      style.textContent = [
        '.dsbalance-card { box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; height: 38px; margin: 0 0 6px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2)); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, color-mix(in srgb, currentColor 3%, transparent)); color: var(--dsw-alias-label-primary, #1f2329); text-decoration: none; font: 12px/1.2 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; transition: background .15s ease, border-color .15s ease; }',
        '.dsbalance-card:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); border-color: color-mix(in srgb, var(--dsw-alias-label-secondary, #8a8f98) 42%, transparent); }',
        '.dsbalance-card:focus-visible { outline: 2px solid #5b8ff9; outline-offset: 2px; }',
        '.dsbalance-badge { box-sizing: border-box; flex: 0 0 auto; min-width: 26px; height: 18px; padding: 0 6px; display: inline-flex; align-items: center; justify-content: center; border-radius: 5px; color: #fff; font: 700 10px/1 ui-sans-serif, -apple-system, "Segoe UI", sans-serif; letter-spacing: .02em; }',
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

    const inject = ['slots', 'timer', 'modelDirectories']

    function apply(ctx) {
      const slots = ctx.slots
      const timer = ctx.get('timer')
      // 模型目录服务(可选): 提供 per-session 的模型选择快照, 用于感知当前 provider。
      const directories = ctx.get('modelDirectories')

      ctx.effect(() => slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'dsbalance', order: 90, label: 'API 余额' },
        (props) => {
          const [state, setState] = React.useState(null)
          // 当前品牌: 由模型目录快照推导(provider → DS/GLM); 目录不可用时回退 DeepSeek。
          const [snap, setSnap] = React.useState(null)
          React.useEffect(() => {
            // 订阅所有活跃会话的模型目录, 任一会话当前选中 provider 变化即联动。
            let stops = []
            const sync = () => {
              const live = directories && directories.live ? directories.live.directories : null
              if (!live) return
              let provider = null
              // Map 插入顺序≈会话活跃顺序: 取最后一个有非空选择的会话。
              for (const directory of live.values()) {
                if (!directory || !directory.store) continue
                const s = directory.store.getSnapshot()
                if (s && s.current && s.current.provider) {
                  provider = s.current.provider
                }
              }
              setSnap({ provider })
            }
            const subscribeAll = () => {
              stops.forEach((stop) => { try { stop() } catch (e) {} })
              stops = []
              const live = directories && directories.live ? directories.live.directories : null
              if (!live) return
              for (const directory of live.values()) {
                if (!directory || !directory.store) continue
                try { stops.push(directory.store.subscribe(sync)) } catch (e) {}
              }
            }
            sync()
            subscribeAll()
            // 目录服务懒创建会话目录, 轮询兜底补订阅。
            const poll = timer ? timer.interval(() => { sync(); subscribeAll() }, 5000) : null
            return () => {
              stops.forEach((stop) => { try { stop() } catch (e) {} })
              if (poll !== null) poll()
            }
          }, [])

          // 数据刷新: 按当前品牌查对应余额接口。
          React.useEffect(() => {
            let disposed = false
            const brandKey = snap && snap.provider ? brandForProvider(snap.provider) : 'deepseek'
            const brand = BRANDS[brandKey] || BRANDS.deepseek
            const load = () => {
              fetch('/api/dsbalance/balance?provider=' + brand.apiProvider, { cache: 'no-store' })
                .then((r) => r.json())
                .then((data) => { if (!disposed) setState(data) })
                .catch((e) => { if (!disposed) setState({ ok: false, error: String(e) }) })
            }
            load()
            const id = timer ? timer.interval(load, 60000) : null
            return () => { disposed = true; if (id !== null) id() }
          }, [snap && snap.provider ? brandForProvider(snap.provider) : 'deepseek'])

          const brandKey = snap && snap.provider ? brandForProvider(snap.provider) : 'deepseek'
          const brand = BRANDS[brandKey] || BRANDS.deepseek
          const ok = Boolean(state && state.ok)
          // 智谱侧无公开余额 API: host 返回 balanceUnknown, 简洁降级(不反复提醒"到控制台")。
          const unknown = ok && state.balanceUnknown === true
          const infos = ok && !unknown ? (state.infos || []) : []
          const main = infos.find((b) => b.currency === 'CNY') || infos[0]
          const total = main ? main.total : null
          const low = total !== null && Number(total) < 10
          const value = state === null
            ? '查询中…'
            : unknown
              ? '—'
              : total !== null
                ? '¥' + total
                : '—'
          const title = state === null
            ? brand.full + ' API 余额查询中'
            : unknown
              ? brand.full + ' 余额登录态未同步或已过期，点击前往控制台'
              : ok
                ? brand.full + ' API 余额 ' + value + '，点击前往官方充值'
                : '余额暂不可用，点击前往' + brand.full + '官方平台'
          const className = ok ? (low ? 'dsbalance-card dsbalance-low' : 'dsbalance-card') : 'dsbalance-card dsbalance-unavailable'
          const badge = React.createElement('span', {
            className: 'dsbalance-badge',
            style: { background: brand.dot },
            'aria-hidden': true,
          }, brand.short)
          if (!(props && props.wide)) {
            return React.createElement(
              'a',
              {
                className: 'dsbalance-rail' + (low ? ' dsbalance-low' : ''),
                href: brand.topUpUrl,
                target: '_blank',
                rel: 'noopener noreferrer',
                title,
                'aria-label': title,
              },
              brand.short,
            )
          }
          return React.createElement(
            'a',
            {
              className,
              href: brand.topUpUrl,
              target: '_blank',
              rel: 'noopener noreferrer',
              title,
              'aria-label': title,
            },
            badge,
            React.createElement('span', { className: 'dsbalance-label' }, ok ? 'API 余额' : '余额暂不可用'),
            React.createElement('span', { className: 'dsbalance-value' }, value),
            React.createElement('span', { className: 'dsbalance-topup' }, unknown ? '控制台 ↗' : '充值 ↗'),
          )
        },
      )), 'dsbalance: sidebar footer')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
