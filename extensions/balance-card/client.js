// dsbalance — Client half(作为 cordis_define 的 code.client 传入)
// 依赖: slots 服务(conversation.composer.dock)、timer 服务、React/host/styles builtins
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const timer = ctx.get('timer')

    styles.insert(`
      .dsbalance-row { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--color-text-3, #8a8f98); line-height: 1; }
      .dsbalance-row a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
      .dsbalance-low { color: #e5484d; font-weight: 600; }
    `)

    slots.inject('conversation.composer.dock', () => slots.register(
      { name: 'conversation.composer.dock', id: 'dsbalance', order: 5 },
      () => {
        const [state, setState] = React.useState(null)
        React.useEffect(() => {
          let disposed = false
          const load = () => {
            host.call('dsbalance.get').then((r) => {
              if (!disposed) setState(r)
            }).catch((e) => {
              if (!disposed) setState({ ok: false, error: String(e) })
            })
          }
          load()
          const disposeTimer = timer ? timer.interval(load, 60000) : null
          return () => {
            disposed = true
            if (disposeTimer) disposeTimer()
          }
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
    ))
  },
}
