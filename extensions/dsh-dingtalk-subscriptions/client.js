// @local/dsh-dingtalk-subscriptions — native-only subscriber administration.
// This file is a browser ModuleLoader bundle, matching the existing DSH client
// seam.  It does not use fetch: every write crosses the Swift WebKit bridge,
// which owns the loopback URL and X-Dashen-Native-Admin token.
window.__ModuleLoader__.load({
  id: '@local/dsh-dingtalk-subscriptions',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const inject = ['slots']
    const HANDLER = 'dingtalkSubscriptionAdmin'
    const CALLBACK = '__dshDingTalkSubscriptionAdminResult'
    const text = (value, fallback = '') => String(value ?? fallback)
    const first = (...values) => values.map((value) => text(value).trim()).find(Boolean) || ''
    const ENTITLEMENT_LABELS = Object.freeze({ mode: '模式', workspace: '工作区', model: '模型', effort: '推理强度', shrimp: '虾' })
    const STATUS_LABELS = Object.freeze({ pending: '待配置', waiting_robot: '等待机器人', waiting_binding: '等待绑定', waiting_workspace: '等待工作区', active: '已启用', suspended: '已暂停', revoked: '已删除', quota_exhausted: '额度已用完' })
    const REQUIRED_CONFIG_KINDS = Object.freeze(['mode', 'workspace', 'model', 'effort'])
    const CONFIG_FLOW_KINDS = Object.freeze([...REQUIRED_CONFIG_KINDS, 'shrimp'])
    const TOKENS_PER_WAN = 10_000
    const tokensFromWan = (value) => Math.max(0, Math.round(Number(value || 0) * TOKENS_PER_WAN))
    const wanFromTokens = (value) => String(Math.round((Number(value || 0) / TOKENS_PER_WAN) * 100) / 100)
    const formatTokens = (value) => {
      const amount = Number(value || 0)
      return amount >= TOKENS_PER_WAN ? `${Math.round((amount / TOKENS_PER_WAN) * 100) / 100} 万 Token` : `${amount.toLocaleString()} Token`
    }

    function bridgeAvailable() {
      return typeof window?.webkit?.messageHandlers?.[HANDLER]?.postMessage === 'function'
    }

    function createBridge() {
      const pending = new Map()
      const previous = window[CALLBACK]
      const handle = (message) => {
        let value = message?.detail && typeof message.detail === 'object' ? message.detail : message
        if (typeof value === 'string') { try { value = JSON.parse(value) } catch { return false } }
        const requestId = text(value?.requestId)
        const item = pending.get(requestId)
        if (!requestId || !item) return false
        pending.delete(requestId)
        clearTimeout(item.timer)
        if (value.ok === false) item.reject(new Error(value.error || value.code || '原生管理失败'))
        else item.resolve(value.data === undefined ? value : value.data)
        return true
      }
      window[CALLBACK] = handle
      const request = (action, payload = {}) => {
        if (!bridgeAvailable()) return Promise.reject(new Error('当前不是大神.app原生管理面板'))
        const requestId = `admin_${Date.now()}_${Math.random().toString(36).slice(2)}`
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('原生管理操作超时')) }, 20_000)
          pending.set(requestId, { resolve, reject, timer })
          try { window.webkit.messageHandlers[HANDLER].postMessage({ requestId, action, payload }) } catch (error) { clearTimeout(timer); pending.delete(requestId); reject(error) }
        })
      }
      const dispose = () => {
        for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('原生管理桥已关闭')) }
        pending.clear()
        if (window[CALLBACK] === handle) { if (typeof previous === 'function') window[CALLBACK] = previous; else delete window[CALLBACK] }
      }
      return { request, dispose }
    }

    function unwrap(value) {
      if (Array.isArray(value)) return value
      if (value?.data !== undefined) return value.data
      return value
    }

    function listFrom(value, key) {
      const root = unwrap(value)
      if (Array.isArray(root)) return root
      return Array.isArray(root?.[key]) ? root[key] : []
    }

    function Select({ value, onChange, options, placeholder = '请选择' }) {
      return h('select', { value: value || '', onChange: (event) => onChange(event.target.value), className: 'dsh-sub-select' },
        h('option', { value: '' }, placeholder), (options || []).map((item) => h('option', { key: item.resourceId || item.workspaceId || item.id, value: item.resourceId || item.workspaceId || item.id }, item.displayName || item.name || item.resourceId || item.id)))
    }

    function SubscriberPanel() {
      const [open, setOpen] = React.useState(false)
      const [tab, setTab] = React.useState('subscribers')
      const [state, setState] = React.useState({ subscribers: [], catalog: {}, audit: [], selected: null })
      const [form, setForm] = React.useState({ displayName: '', weeklyTokenLimit: '1', workspaceMode: 'existing', workspaceName: '', workspaceRoot: '', shareWorkspaceId: '', kind: 'mode', resourceId: '', displayNameEntitlement: '', modeId: '', workspaceId: '', model: '', effortId: '' })
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [qr, setQr] = React.useState(null)
      const bridgeRef = React.useRef(null)
      const bindingStartedRef = React.useRef(false)
      const entitlementFlowRef = React.useRef(null)

      const load = React.useCallback(async (selectedId = state.selected?.subscriberId) => {
        if (!bridgeRef.current) return
        try {
          const [subscribers, catalog] = await Promise.all([bridgeRef.current.request('subscriber.list', {}), bridgeRef.current.request('catalog.list', {})])
          const catalogValue = unwrap(catalog) || {}
          const rows = listFrom(subscribers, 'subscribers').filter((item) => item.status !== 'revoked')
          const baseSelected = rows.find((item) => item.subscriberId === selectedId) || rows[0] || null
          const details = baseSelected
            ? await Promise.allSettled([
              bridgeRef.current.request('entitlement.list', { subscriberId: baseSelected.subscriberId }),
              bridgeRef.current.request('selection.list', { subscriberId: baseSelected.subscriberId }),
              bridgeRef.current.request('quota.status', { subscriberId: baseSelected.subscriberId }),
              bridgeRef.current.request('robot.list', { subscriberId: baseSelected.subscriberId }),
            ])
            : []
          const selected = baseSelected ? {
            ...baseSelected,
            entitlements: details[0]?.status === 'fulfilled' ? listFrom(details[0].value, 'entitlements') : [],
            selection: details[1]?.status === 'fulfilled' ? unwrap(details[1].value) : null,
            quota: details[2]?.status === 'fulfilled' ? unwrap(details[2].value) : null,
            robots: details[3]?.status === 'fulfilled' ? listFrom(details[3].value, 'robots') : [],
          } : null
          setState((old) => ({ ...old, subscribers: rows, catalog: catalogValue, selected }))
          if (selected) {
            const selectedWorkspace = (catalogValue.workspaces || []).find((item) => (item.workspaceId || item.resourceId) === selected.selection?.workspaceId)
            setForm((old) => ({ ...old, weeklyTokenLimit: wanFromTokens(selected.weeklyTokenLimit), shareWorkspaceId: selectedWorkspace?.metadata?.hostWorkspaceId || selected.selection?.workspaceId || '' }))
          }
          setError('')
        } catch (cause) { setError(text(cause?.message, '订阅管理读取失败')) }
      }, [state.selected?.subscriberId])

      React.useEffect(() => {
        if (!open || !bridgeAvailable()) return undefined
        bridgeRef.current = createBridge()
        void load()
        return () => { bridgeRef.current?.dispose(); bridgeRef.current = null }
      }, [open, load])

      React.useEffect(() => {
        const openPanel = () => {
          if (!bridgeAvailable()) return
          window.dispatchEvent(new CustomEvent('dsh:utility-open', { detail: { id: 'dsh-dingtalk-subscriptions' } }))
          setOpen(true)
        }
        const closeOther = (event) => { if (event?.detail?.id !== 'dsh-dingtalk-subscriptions') setOpen(false) }
        window.addEventListener('dsh:open-dingtalk-subscriptions', openPanel)
        window.addEventListener('dsh:utility-open', closeOther)
        return () => {
          window.removeEventListener('dsh:open-dingtalk-subscriptions', openPanel)
          window.removeEventListener('dsh:utility-open', closeOther)
        }
      }, [])

      React.useEffect(() => {
        if (!open || (!qr?.registrationId && !qr?.verificationUri && !qr?.qrDataUrl && !qr?.qrSvg) || !bridgeRef.current) return undefined
        let stopped = false
        const timer = setInterval(async () => {
          if (stopped || !bridgeRef.current) return
          try {
            const status = await bridgeRef.current.request('registration.status', { subscriberId: qr.subscriberId, accountId: qr.accountId, registrationId: qr.registrationId })
            setQr((old) => ({ ...(old || {}), ...status }))
            if (status?.status === 'brand-pending') await load(qr.subscriberId)
            if (status?.status === 'succeeded' && !bindingStartedRef.current) {
              bindingStartedRef.current = true
              const binding = await bridgeRef.current.request('binding.begin', { subscriberId: qr.subscriberId, accountId: qr.accountId })
              if (!stopped && binding) setQr((old) => ({ ...(old || {}), bindingStatus: 'awaiting_confirmation', status: 'binding_pending' }))
            }
            if (['failed', 'cancelled', 'expired'].includes(status?.status)) { stopped = true; clearInterval(timer) }
          } catch (cause) { if (!stopped) setError(text(cause?.message, '注册状态读取失败')) }
        }, 3_000)
        return () => { stopped = true; clearInterval(timer) }
      }, [open, qr?.registrationId, qr?.verificationUri, qr?.qrDataUrl, qr?.qrSvg, qr?.subscriberId, qr?.accountId])

      const act = async (action, payload = {}, after = true) => {
        if (!bridgeRef.current) return
        setBusy(true); setError(''); setNotice('')
        try {
          const value = await bridgeRef.current.request(action, payload)
          if (value?.registrationId || value?.verificationUri || value?.qrDataUrl || value?.qrSvg) { bindingStartedRef.current = false; setQr(value) }
          setNotice('已完成')
          if (after) await load(state.selected?.subscriberId)
          return value
        } catch (cause) { setError(text(cause?.message, '操作失败')); return null } finally { setBusy(false) }
      }

      const selected = state.selected
      const selectedRobot = selected?.robots?.[0] || null
      const selectSubscriber = (subscriberId) => { if (subscriberId !== state.selected?.subscriberId) setQr(null); setState((old) => ({ ...old, selected: old.subscribers.find((item) => item.subscriberId === subscriberId) || null })); void load(subscriberId) }
      const createSubscriber = async () => {
        const created = await act('subscriber.create', { displayName: form.displayName, weeklyTokenLimit: tokensFromWan(form.weeklyTokenLimit) }, false)
        if (!created?.subscriberId) return
        setTab('subscribers')
        await load(created.subscriberId)
        const workspace = await act('workspace.host-create', { subscriberId: created.subscriberId, displayName: `${form.displayName}工作区` }, false)
        if (!workspace?.workspaceId) return
        await act('registration.begin', { subscriberId: created.subscriberId }, false)
        await load(created.subscriberId)
      }
      const updateQuota = () => selected && act('subscriber.update', { subscriberId: selected.subscriberId, weeklyTokenLimit: tokensFromWan(form.weeklyTokenLimit), expectedRevision: selected.revision })
      const suspend = () => selected && act('subscriber.suspend', { subscriberId: selected.subscriberId, expectedRevision: selected.revision })
      const resume = () => selected && act('subscriber.resume', { subscriberId: selected.subscriberId, expectedRevision: selected.revision })
      const revoke = () => selected && window.confirm?.(`确认删除订阅者“${selected.displayName}”？机器人会立即停用并从列表移除；工作区、会话、额度和审计仍会保留。`) && act('subscriber.revoke', { subscriberId: selected.subscriberId, expectedRevision: selected.revision })
      const finishWorkspaceSelection = async (workspaceId) => {
        if (!selected || !workspaceId) return
        const current = selected.selection
        if (current?.modeId && current?.modelProvider && current?.modelId && current?.effortId && current.workspaceId !== workspaceId) {
          await act('selection.set', { subscriberId: selected.subscriberId, modeId: current.modeId, workspaceId, model: `${current.modelProvider}/${current.modelId}`, effortId: current.effortId, expectedRevision: current.revision }, false)
        }
        await load(selected.subscriberId)
        setNotice('已选择工作区')
      }
      const createWorkspace = async () => {
        if (!selected) return
        const workspace = await act('workspace.host-create', { subscriberId: selected.subscriberId, displayName: form.workspaceName || `${selected.displayName}工作区`, ...(form.workspaceRoot ? { rootPath: form.workspaceRoot } : {}) }, false)
        if (!workspace?.workspaceId) return
        await finishWorkspaceSelection(workspace.workspaceId)
        setForm((old) => ({ ...old, workspaceMode: 'existing', shareWorkspaceId: workspace.workspaceId, workspaceName: '', workspaceRoot: '' }))
        setNotice(workspace.reused ? '工作区已存在，已直接选中' : '工作区已创建并选中')
      }
      const useExistingWorkspace = async () => {
        if (!selected || !form.shareWorkspaceId) return
        const candidate = catalogOptions('workspace').find((item) => item.resourceId === form.shareWorkspaceId)
        if (!candidate) return
        let workspaceId = candidate.resourceId
        if (candidate.source === 'host') {
          const workspace = await act('workspace.share', { subscriberId: selected.subscriberId, hostWorkspaceId: candidate.resourceId }, false)
          if (!workspace?.workspaceId) return
          workspaceId = workspace.workspaceId
        } else if (!authorizedWorkspaceIds.has(candidate.resourceId)) {
          const granted = await act('workspace.grant', { subscriberId: selected.subscriberId, workspaceId: candidate.resourceId }, false)
          if (!granted) return
        }
        await finishWorkspaceSelection(workspaceId)
      }
      const grant = async () => {
        if (!selected || !form.resourceId) return
        const currentKind = form.kind
        const catalogItem = catalogOptions(currentKind).find((item) => item.resourceId === form.resourceId)
        const value = await act('entitlement.grant', { subscriberId: selected.subscriberId, kind: currentKind, resourceId: form.resourceId, displayName: catalogItem?.displayName || form.resourceId, ...(currentKind === 'model' && form.resourceId.includes('/') ? { provider: form.resourceId.split('/')[0], model: form.resourceId.slice(form.resourceId.indexOf('/') + 1), usageMetered: catalogItem?.usageMetered === true, metadata: { usageMetered: catalogItem?.usageMetered === true } } : {}) })
        if (!value) return
        const satisfied = new Set((selected.entitlements || []).filter((item) => item.status === 'active' || (item.kind === 'shrimp' && item.status === 'pending')).map((item) => item.kind))
        satisfied.add(currentKind)
        const nextKind = CONFIG_FLOW_KINDS.find((kind) => !satisfied.has(kind))
        setForm((old) => ({ ...old, kind: nextKind || 'shrimp', resourceId: '', displayNameEntitlement: '' }))
        window.requestAnimationFrame?.(() => entitlementFlowRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }))
      }
      const setSelection = () => selected && act('selection.set', { subscriberId: selected.subscriberId, modeId: effectiveDefaults.mode, workspaceId: effectiveDefaults.workspace, model: effectiveDefaults.model, effortId: effectiveDefaults.effort, expectedRevision: selected.selection?.revision })
      const beginRegistration = () => selected && act('registration.begin', { subscriberId: selected.subscriberId }, false)
      const confirmBrandAndStart = async () => {
        if (!selected || !selectedRobot) return
        const branded = await act('robot.brand', { accountId: selectedRobot.accountId, expectedRevision: selectedRobot.revision, name: '大神', description: '大神｜Visible Workflow. Reliable Intelligence.', avatarSha256: '380efb54e7271281ddf4fac530915c03cbf90fb4bb2e01fc62d838c2aa7ce1ff', attested: true }, false)
        if (!branded?.accountId) return
        const binding = await act('binding.begin', { subscriberId: selected.subscriberId, accountId: branded.accountId }, false)
        if (binding) setQr((old) => ({ ...(old || {}), subscriberId: selected.subscriberId, accountId: branded.accountId, bindingStatus: 'awaiting_confirmation', status: 'binding_pending' }))
        await load(selected.subscriberId)
      }
      const renewBinding = async () => {
        if (!selected || !selectedRobot) return
        const binding = await act('binding.begin', { subscriberId: selected.subscriberId, accountId: selectedRobot.accountId }, false)
        if (binding) setQr((old) => ({ ...(old || {}), subscriberId: selected.subscriberId, accountId: selectedRobot.accountId, bindingStatus: 'awaiting_confirmation', status: 'binding_pending' }))
        await load(selected.subscriberId)
      }
      const resetQuota = () => selected && act('quota.reset', { subscriberId: selected.subscriberId })
      const loadAudit = async () => { const value = await act('audit.list', { subscriberId: selected?.subscriberId, limit: 100 }, false); if (value) setState((old) => ({ ...old, audit: listFrom(value, 'audit') })) }
      const catalogOptions = (kind) => (state.catalog[`${kind}s`] || state.catalog[kind] || []).map((item) => ({ ...item, resourceId: item.resourceId || item.workspaceId || item.id })).filter((item) => kind !== 'model' || item.usageMetered === true)
      const hostWorkspaceOptions = catalogOptions('workspace').filter((item) => item.source === 'host')
      const subscriberWorkspaceOptions = catalogOptions('workspace').filter((item) => item.source !== 'host' && (!selected || !item.subscriberId || item.subscriberId === selected.subscriberId))
      const authorizedWorkspaceIds = new Set((selected?.entitlements || []).filter((item) => item.kind === 'workspace' && item.status === 'active').map((item) => item.resourceId))
      const selectedWorkspaceRecord = catalogOptions('workspace').find((item) => item.resourceId === selected?.selection?.workspaceId)
      const currentHostWorkspaceId = selectedWorkspaceRecord?.metadata?.hostWorkspaceId || selected?.selection?.workspaceId || ''
      const authorizedHostWorkspaceIds = new Set(catalogOptions('workspace').filter((item) => authorizedWorkspaceIds.has(item.resourceId)).map((item) => item.metadata?.hostWorkspaceId || (item.source === 'host' ? item.resourceId : '')).filter(Boolean))
      const existingWorkspaceOptions = hostWorkspaceOptions.map((item) => ({ ...item, displayName: `${item.displayName}${currentHostWorkspaceId === item.resourceId ? '（当前）' : authorizedHostWorkspaceIds.has(item.resourceId) ? '（已授权）' : ''}` }))
      const selectedWorkspaceCandidate = existingWorkspaceOptions.find((item) => item.resourceId === form.shareWorkspaceId)
      const authorizedOptions = (kind) => (selected?.entitlements || []).filter((item) => item.kind === kind && item.status === 'active').map((item) => ({ resourceId: item.resourceId, displayName: item.displayName, provider: item.provider, model: item.model }))
      const entitlementDisplayName = (item) => catalogOptions(item.kind).find((entry) => entry.resourceId === item.resourceId)?.displayName || item.displayName || item.resourceId
      const workspaceSummary = (item) => {
        const workspace = catalogOptions('workspace').find((entry) => entry.resourceId === item.resourceId)
        if (!workspace) return '已授权工作区'
        return `${workspace.source === 'host' || workspace.source === 'shared' ? '共享' : '专属'} · ${workspace.rootPath || workspace.displayName}`
      }
      const effectiveDefaults = {
        mode: form.modeId || selected?.selection?.modeId || authorizedOptions('mode')[0]?.resourceId || '',
        workspace: form.workspaceId || selected?.selection?.workspaceId || authorizedOptions('workspace')[0]?.resourceId || '',
        model: form.model || (selected?.selection?.modelProvider && selected?.selection?.modelId ? `${selected.selection.modelProvider}/${selected.selection.modelId}` : '') || authorizedOptions('model')[0]?.resourceId || '',
        effort: form.effortId || selected?.selection?.effortId || authorizedOptions('effort')[0]?.resourceId || '',
      }
      const selectedModelCatalog = catalogOptions('model').find((item) => item.resourceId === effectiveDefaults.model)
      const compatibleEffortOptions = authorizedOptions('effort').filter((item) => !selectedModelCatalog?.efforts?.length || selectedModelCatalog.efforts.includes(item.resourceId))
      if (selectedModelCatalog?.efforts?.length && !compatibleEffortOptions.some((item) => item.resourceId === effectiveDefaults.effort)) effectiveDefaults.effort = compatibleEffortOptions[0]?.resourceId || ''
      const entitlementSatisfied = (kind) => (selected?.entitlements || []).some((item) => item.kind === kind && (item.status === 'active' || (kind === 'shrimp' && item.status === 'pending')))
      const missingRequiredKind = REQUIRED_CONFIG_KINDS.find((kind) => !entitlementSatisfied(kind)) || ''
      const baseConfigurationComplete = Boolean(selected) && !missingRequiredKind
      const entitlementProgressKey = (selected?.entitlements || []).map((item) => `${item.kind}:${item.status}:${item.resourceId}`).sort().join('|')
      const visibleEntitlements = (selected?.entitlements || []).filter((item) => item.kind !== 'workspace' || item.resourceId === selected?.selection?.workspaceId)
      React.useEffect(() => {
        if (!open || tab !== 'entitlement' || !selected || !missingRequiredKind || !entitlementSatisfied(form.kind)) return
        setForm((old) => ({ ...old, kind: missingRequiredKind, resourceId: '', displayNameEntitlement: '' }))
        window.requestAnimationFrame?.(() => entitlementFlowRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }))
      }, [open, tab, selected?.subscriberId, entitlementProgressKey, missingRequiredKind])
      const revokeEntitlement = (item) => selected && window.confirm?.(`确认撤销“${item.displayName || item.resourceId}”？`) && act('entitlement.revoke', { subscriberId: selected.subscriberId, entitlementId: item.entitlementId, expectedRevision: item.revision })
      const close = () => { setOpen(false); setError(''); setNotice('') }
      const backToDingTalk = () => { close(); window.dispatchEvent(new CustomEvent('dsh:open-dingtalk-status')) }
      const registrationCard = qr ? h('div', { className: 'dsh-sub-registration' }, [
        h('div', { key: 'head', className: 'dsh-sub-registration-head' }, [h('div', { key: 'copy' }, [h('strong', { key: 'title' }, '请订阅者使用钉钉扫码'), h('p', { key: 'tip' }, '二维码会在订阅者自己的组织中创建一名独立“大神”机器人。')]), h('span', { key: 'badge' }, '机器人：大神')]),
        qr.qrDataUrl ? h('img', { key: 'png', src: qr.qrDataUrl, alt: '钉钉机器人创建二维码' }) : qr.qrSvg ? h('img', { key: 'svg', src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.qrSvg)}`, alt: '钉钉机器人创建二维码' }) : null,
        h('ol', { key: 'steps' }, [h('li', { key: 'scan' }, '订阅者用自己的钉钉扫描二维码并同意创建机器人。'), h('li', { key: 'chat' }, '创建完成后，订阅者私聊“大神”。'), h('li', { key: 'confirm' }, '在私聊中回复“确认绑定”；配置齐全后账户自动激活。')]),
        qr.verificationUri ? h('a', { key: 'uri', href: qr.verificationUri, target: '_blank', rel: 'noreferrer' }, '无法扫码？打开钉钉验证链接') : null,
        qr.status === 'failed' ? h('p', { key: 'failed', className: 'dsh-sub-registration-status error' }, `扫码未完成绑定：${qr.error || '机器人凭据未被大神安全接管，请重新生成二维码。'}`) : qr.status === 'brand-pending' ? h('p', { key: 'brand', className: 'dsh-sub-registration-status warning' }, '机器人已创建，品牌回读尚未通过。请按提示补齐头像、名称和描述。') : qr.bindingStatus === 'awaiting_confirmation' ? h('p', { key: 'binding', className: 'dsh-sub-registration-status success' }, '机器人已创建，正在等待订阅者私聊确认绑定。') : h('p', { key: 'pending', className: 'dsh-sub-registration-status' }, '等待订阅者扫码创建机器人…'),
      ]) : null
      const robotStateCard = selected && (selectedRobot || !qr) ? !selectedRobot
        ? h('div', { className: 'dsh-sub-brand-state error' }, [h('strong', { key: 'title' }, '机器人尚未接入大神'), h('p', { key: 'copy' }, '钉钉侧即使已经出现“DeepSeek 助手”，只要这里没有机器人账户，就表示凭据没有被大神接管。请重新生成二维码并再次扫码。'), h('button', { key: 'retry', type: 'button', disabled: busy, onClick: beginRegistration }, '重新生成二维码')])
        : selectedRobot.brandStatus !== 'verified'
          ? h('div', { className: 'dsh-sub-brand-state warning' }, [h('div', { key: 'head', className: 'dsh-sub-brand-head' }, [h('img', { key: 'avatar', src: '/api/dsh-dingtalk/subscriptions/brand-avatar.png', alt: '大神机器人头像' }), h('div', { key: 'copy' }, [h('strong', { key: 'title' }, '扫码成功，还差品牌设置'), h('p', { key: 'desc' }, '钉钉扫码接口只返回机器人凭据，不会替换默认名称和头像。')])]), h('ol', { key: 'steps' }, [h('li', { key: 'name' }, '在订阅者组织的钉钉开发者后台，把机器人名称改为“大神”。'), h('li', { key: 'desc' }, '描述改为“大神｜Visible Workflow. Reliable Intelligence.”。'), h('li', { key: 'avatar' }, [h('span', { key: 'text' }, '头像使用配套无边框虾缸 Logo：'), h('a', { key: 'download', href: '/api/dsh-dingtalk/subscriptions/brand-avatar.png', download: 'dashen-bot-avatar.png' }, '下载头像')])]), h('button', { key: 'confirm', type: 'button', disabled: busy, onClick: confirmBrandAndStart }, '我已完成品牌设置，启动机器人')])
          : !selected.identityBound
            ? h('div', { className: 'dsh-sub-brand-state success' }, [h('strong', { key: 'title' }, '机器人 Stream 已具备启动条件'), h('p', { key: 'copy' }, '请让订阅者在私聊中直接回复“确认绑定”。确认后，配置齐全就会自动激活对话。'), h('button', { key: 'renew', type: 'button', disabled: busy, onClick: renewBinding }, '刷新10分钟确认窗口')])
            : h('div', { className: 'dsh-sub-brand-state success' }, [h('strong', { key: 'title' }, '机器人与订阅身份已绑定'), h('p', { key: 'copy' }, '后续是否可对话取决于工作区、授权组合和周额度是否配置完整。')]) : null

      const subscriberView = tab === 'subscribers' ? h('section', null, [
        h('div', { className: 'dsh-sub-form' }, [
          h('input', { key: 'name', placeholder: '订阅者名称', value: form.displayName, onChange: (event) => setForm({ ...form, displayName: event.target.value }) }),
          h('label', { key: 'tokens-wrap', className: 'dsh-sub-token-input' }, [h('input', { key: 'tokens', type: 'number', min: 0.1, step: 0.1, inputMode: 'decimal', placeholder: '周额度', 'aria-label': '每周额度，单位万 Token', value: form.weeklyTokenLimit, onChange: (event) => setForm({ ...form, weeklyTokenLimit: event.target.value }) }), h('span', { key: 'unit' }, '万 Token/周')]),
          h('button', { key: 'create', type: 'button', disabled: busy || !form.displayName || Number(form.weeklyTokenLimit || 0) <= 0, onClick: createSubscriber }, busy ? '正在生成…' : '新增并生成二维码'),
        ]),
        state.subscribers.length
          ? h('div', { className: 'dsh-sub-list' }, state.subscribers.map((item) => h('button', { type: 'button', key: item.subscriberId, className: selected?.subscriberId === item.subscriberId ? 'selected' : '', onClick: () => selectSubscriber(item.subscriberId) }, [h('strong', { key: 'name' }, item.displayName), h('small', { key: 'status' }, `${STATUS_LABELS[item.status] || item.status} · ${formatTokens(item.weeklyTokenLimit)}/周`)])))
          : h('div', { className: 'dsh-sub-empty' }, [h('strong', { key: 'title' }, '还没有订阅者'), h('p', { key: 'copy' }, '填写名称和周额度后，大神会自动创建专属工作区并生成钉钉机器人二维码。')]),
        selected ? h('div', { className: 'dsh-sub-account-settings' }, [
          h('div', { key: 'actions', className: 'dsh-sub-actions dsh-sub-account-actions' }, [
            h('button', { key: 'suspend', type: 'button', disabled: busy || selected.status === 'suspended', onClick: suspend }, '暂停'),
            h('button', { key: 'resume', type: 'button', disabled: busy || selected.status !== 'suspended', onClick: resume }, '恢复'),
            h('button', { key: 'registration', type: 'button', disabled: busy || selected.status === 'revoked', onClick: beginRegistration }, '重新生成二维码'),
            h('button', { key: 'revoke', type: 'button', className: 'danger', disabled: busy || selected.status === 'revoked', onClick: revoke }, '删除订阅者'),
          ]),
          h('div', { key: 'quota', className: 'dsh-sub-quota-editor' }, [h('span', { key: 'label' }, '周额度'), h('label', { key: 'input-wrap', className: 'dsh-sub-token-input' }, [h('input', { key: 'input', type: 'number', min: 0.1, step: 0.1, inputMode: 'decimal', value: form.weeklyTokenLimit, onChange: (event) => setForm({ ...form, weeklyTokenLimit: event.target.value }), 'aria-label': '每周额度，单位万 Token' }), h('span', { key: 'unit' }, '万 Token/周')]), h('button', { key: 'save', type: 'button', disabled: busy || selected.status === 'revoked', onClick: updateQuota }, '保存额度')]),
        ]) : null,
        registrationCard,
        robotStateCard,
      ]) : null
      const workspaceView = tab === 'workspace' ? h('section', null, [
        h('p', { key: 'selected', className: 'dsh-sub-selected' }, selected ? `当前：${selected.displayName}` : '请先选择订阅者'),
        h('div', { key: 'form', className: 'dsh-sub-form vertical dsh-sub-workspace-picker' }, [
          h('div', { key: 'mode', className: 'dsh-sub-workspace-modes', role: 'tablist', 'aria-label': '工作区来源' }, [
            h('button', { key: 'existing', type: 'button', role: 'tab', 'aria-selected': form.workspaceMode === 'existing', className: form.workspaceMode === 'existing' ? 'active' : '', onClick: () => setForm({ ...form, workspaceMode: 'existing' }) }, '选择已有'),
            h('button', { key: 'new', type: 'button', role: 'tab', 'aria-selected': form.workspaceMode === 'new', className: form.workspaceMode === 'new' ? 'active' : '', onClick: () => setForm({ ...form, workspaceMode: 'new' }) }, '新建工作区'),
          ]),
          form.workspaceMode === 'existing' ? h('div', { key: 'existing-panel', className: 'dsh-sub-workspace-panel' }, [
            h('label', { key: 'existing-workspace', className: 'dsh-sub-field' }, [h('span', { key: 'label' }, '已有工作区'), h(Select, { key: 'select', value: form.shareWorkspaceId, onChange: (value) => setForm({ ...form, shareWorkspaceId: value }), options: existingWorkspaceOptions, placeholder: existingWorkspaceOptions.length ? '请选择已创建的工作区' : '暂无已有工作区' })]),
            selectedWorkspaceCandidate ? h('p', { key: 'path', className: 'dsh-sub-workspace-path' }, `${selectedWorkspaceCandidate.source === 'host' || selectedWorkspaceCandidate.source === 'shared' ? '共享工作区' : '专属工作区'} · ${selectedWorkspaceCandidate.rootPath || ''}`) : null,
            h('button', { key: 'use', type: 'button', disabled: busy || !selected || !form.shareWorkspaceId || currentHostWorkspaceId === form.shareWorkspaceId, onClick: useExistingWorkspace }, currentHostWorkspaceId === form.shareWorkspaceId ? '当前正在使用' : '使用这个工作区'),
          ]) : h('div', { key: 'new-panel', className: 'dsh-sub-workspace-panel' }, [
            h('input', { key: 'name', placeholder: selected ? `${selected.displayName}工作区` : '工作区名称', value: form.workspaceName, onChange: (event) => setForm({ ...form, workspaceName: event.target.value }) }),
            h('details', { key: 'advanced', className: 'dsh-sub-workspace-advanced' }, [h('summary', { key: 'summary' }, '自定义保存位置（可选）'), h('input', { key: 'root', placeholder: '工作区绝对路径', value: form.workspaceRoot, onChange: (event) => setForm({ ...form, workspaceRoot: event.target.value }) })]),
            h('button', { key: 'create', type: 'button', disabled: busy || !selected, onClick: createWorkspace }, '创建并使用这个工作区'),
          ]),
        ]),
        selected?.entitlements?.filter((item) => item.kind === 'workspace' && item.status === 'active').length ? h('div', { key: 'list', className: 'dsh-sub-list' }, selected.entitlements.filter((item) => item.kind === 'workspace' && item.status === 'active').map((item) => h('div', { className: `dsh-sub-audit ${selected?.selection?.workspaceId === item.resourceId ? 'current' : ''}`, key: item.entitlementId }, [h('strong', { key: 'name' }, `${entitlementDisplayName(item)}${selected?.selection?.workspaceId === item.resourceId ? ' · 当前' : ''}`), h('small', { key: 'path' }, workspaceSummary(item))]))) : null,
      ]) : null
      const entitlementView = tab === 'entitlement' ? h('section', null, [
        h('p', { key: 'selected', className: 'dsh-sub-selected' }, selected ? `当前：${selected.displayName}` : '请先选择订阅者'),
        h('div', { key: 'form', ref: entitlementFlowRef, className: 'dsh-sub-form vertical dsh-sub-entitlement-flow' }, [
          h('div', { key: 'progress', className: `dsh-sub-flow-status ${baseConfigurationComplete ? 'complete' : ''}` }, [h('strong', { key: 'title' }, baseConfigurationComplete ? '基础配置已完成' : `下一项：${ENTITLEMENT_LABELS[missingRequiredKind] || '待配置'}`), h('span', { key: 'copy' }, baseConfigurationComplete ? '完成身份绑定后即可对话；虾权限可按需增加。' : '授予后会自动进入下一项。')]),
          h('div', { key: 'kind', className: 'dsh-sub-kind-picker', role: 'tablist', 'aria-label': '授权类型' }, CONFIG_FLOW_KINDS.map((kind) => h('button', { key: kind, type: 'button', role: 'tab', 'aria-selected': form.kind === kind, className: `${form.kind === kind ? 'active' : ''} ${entitlementSatisfied(kind) ? 'complete' : ''}`.trim(), onClick: () => setForm({ ...form, kind, resourceId: '', displayNameEntitlement: '' }) }, `${entitlementSatisfied(kind) ? '✓ ' : ''}${ENTITLEMENT_LABELS[kind]}${kind === 'shrimp' ? '（可选）' : ''}`))),
          h('label', { key: 'resource', className: 'dsh-sub-field' }, [h('span', { key: 'label' }, `选择${ENTITLEMENT_LABELS[form.kind]}`), h(Select, { key: 'select', value: form.resourceId, onChange: (value) => setForm({ ...form, resourceId: value }), options: form.kind === 'workspace' ? subscriberWorkspaceOptions : catalogOptions(form.kind), placeholder: `请选择可授权的${ENTITLEMENT_LABELS[form.kind]}` })]),
          h('button', { key: 'grant', type: 'button', disabled: busy || !selected || !form.resourceId, onClick: grant }, `授予${ENTITLEMENT_LABELS[form.kind]}权限${form.kind === 'shrimp' ? '' : '，继续下一项'}`),
        ]),
        selected ? h('div', { key: 'defaults', className: 'dsh-sub-defaults' }, [
          h('div', { key: 'head', className: 'dsh-sub-defaults-head' }, [h('strong', { key: 'title' }, '当前默认组合'), h('span', { key: 'tip' }, '首次配齐时自动生成，之后可调整')]),
          h('div', { key: 'grid', className: 'dsh-sub-defaults-grid' }, [
            h('label', { key: 'mode', className: 'dsh-sub-field' }, [h('span', { key: 'label' }, '模式'), h(Select, { key: 'select', value: effectiveDefaults.mode, onChange: (value) => setForm({ ...form, modeId: value }), options: authorizedOptions('mode'), placeholder: '先授权模式' })]),
            h('label', { key: 'workspace', className: 'dsh-sub-field' }, [h('span', { key: 'label' }, '工作区'), h(Select, { key: 'select', value: effectiveDefaults.workspace, onChange: (value) => setForm({ ...form, workspaceId: value }), options: authorizedOptions('workspace'), placeholder: '先授权工作区' })]),
            h('label', { key: 'model', className: 'dsh-sub-field' }, [h('span', { key: 'label' }, '模型'), h(Select, { key: 'select', value: effectiveDefaults.model, onChange: (value) => setForm({ ...form, model: value }), options: authorizedOptions('model'), placeholder: '先授权模型' })]),
            h('label', { key: 'effort', className: 'dsh-sub-field' }, [h('span', { key: 'label' }, '推理强度'), h(Select, { key: 'select', value: effectiveDefaults.effort, onChange: (value) => setForm({ ...form, effortId: value }), options: compatibleEffortOptions, placeholder: effectiveDefaults.model ? '先授权兼容的推理强度' : '先选择模型' })]),
          ]),
          h('button', { key: 'save', type: 'button', disabled: busy || !effectiveDefaults.mode || !effectiveDefaults.workspace || !effectiveDefaults.model || !effectiveDefaults.effort, onClick: setSelection }, '保存默认组合'),
        ]) : null,
        visibleEntitlements.length ? h('div', { key: 'list', className: 'dsh-sub-list' }, visibleEntitlements.map((item) => h('div', { className: 'dsh-sub-audit', key: item.entitlementId }, [h('strong', { key: 'name' }, `${ENTITLEMENT_LABELS[item.kind] || item.kind} · ${entitlementDisplayName(item)}`), h('button', { key: 'revoke', type: 'button', disabled: busy || item.status === 'revoked', onClick: () => revokeEntitlement(item) }, '撤销')]))) : h('p', { key: 'empty', className: 'dsh-sub-selected' }, '暂无授权；虾授权在 ShrimpTank 远端回执前保持待同步。'),
      ]) : null
      const quotaView = tab === 'quota' ? h('section', null, [
        h('p', { key: 'selected', className: 'dsh-sub-selected' }, selected ? `当前：${selected.displayName}` : '请先选择订阅者'),
        selected?.quota ? h('div', { key: 'grid', className: 'dsh-sub-grid' }, [h('span', { key: 'limit' }, ['周额度', h('strong', { key: 'value' }, formatTokens(selected.quota.cycle?.limitTokens ?? selected.weeklyTokenLimit))]), h('span', { key: 'used' }, ['已用', h('strong', { key: 'value' }, formatTokens(selected.quota.usedTokens))]), h('span', { key: 'reserved' }, ['预留', h('strong', { key: 'value' }, formatTokens(selected.quota.reservedTokens))]), h('span', { key: 'remaining' }, ['剩余', h('strong', { key: 'value' }, formatTokens(selected.quota.remainingTokens))])]) : null,
        h('div', { key: 'actions', className: 'dsh-sub-actions' }, [h('button', { key: 'reset', type: 'button', disabled: busy || !selected, onClick: resetQuota }, '重置本周额度')]),
      ]) : null
      const auditView = tab === 'audit' ? h('section', null, [h('div', { key: 'list', className: 'dsh-sub-list' }, state.audit.map((item) => h('div', { className: 'dsh-sub-audit', key: item.eventId }, [h('strong', { key: 'action' }, item.action), h('small', { key: 'time' }, `${item.outcome} · ${item.createdAt}`)])))]) : null
      if (!open) return null
      return h('div', { className: 'dsh-sub-root' },
        h('div', { className: 'dsh-sub-backdrop', onMouseDown: (event) => event.target === event.currentTarget && close(), 'aria-hidden': true }),
        h('section', { className: 'dsh-sub-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': '钉钉订阅管理' },
          h('header', { className: 'dsh-sub-head' }, h('div', { className: 'dsh-sub-head-main' }, h('button', { type: 'button', className: 'dsh-sub-back', onClick: backToDingTalk }, '← 钉钉'), h('div', null, h('h2', null, '订阅管理'), h('p', null, '仅大神.app管理员可配置用户、权限、额度与绑定'))), h('button', { type: 'button', className: 'dsh-sub-close', onClick: close, 'aria-label': '关闭订阅管理' }, '×')),
          h('nav', { className: 'dsh-sub-tabs' }, ['subscribers', 'workspace', 'entitlement', 'quota', 'audit'].map((item) => h('button', { key: item, type: 'button', className: tab === item ? 'active' : '', onClick: () => { setTab(item); if (item === 'audit') void loadAudit() } }, { subscribers: '订阅用户', workspace: '工作区', entitlement: '授权与默认', quota: '额度', audit: '审计' }[item]))),
          h('main', { className: 'dsh-sub-body' }, [
            error ? h('div', { key: 'error', className: 'dsh-sub-alert error', role: 'alert' }, error) : null,
            notice ? h('div', { key: 'notice', className: 'dsh-sub-alert success', role: 'status' }, notice) : null,
            subscriberView,
            workspaceView,
            entitlementView,
            quotaView,
            auditView,
          ]),
          h('footer', { className: 'dsh-sub-foot' }, h('span', null, busy ? '处理中…' : '状态来自 Host SQLite'), h('button', { type: 'button', onClick: () => void load(selected?.subscriberId), disabled: busy }, '刷新')),
        ),
      )
    }

    function apply(ctx) {
      // Do not even register a visible entry in an ordinary browser.  Native
      // WebKit is the sole management surface.
      if (!bridgeAvailable() || !ctx?.slots) return
      const style = document.createElement('style')
      style.id = 'dsh-dingtalk-subscriptions-styles'
      style.textContent = `.dsh-sub-root{position:relative;display:flex;align-items:center;height:36px;font:13px/1.4 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--dsw-alias-label-primary,#f5f6f7)}.dsh-sub-trigger{height:32px;padding:0 12px;border:1px solid rgba(255,255,255,.18);border-radius:999px;background:transparent;color:inherit;cursor:pointer}.dsh-sub-backdrop{position:fixed;inset:0;z-index:10020;background:rgba(8,12,18,.43);backdrop-filter:blur(1px)}.dsh-sub-dialog{position:fixed;z-index:10021;top:52px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;width:min(680px,calc(100vw - 32px));max-height:calc(100vh - 68px);overflow:hidden;border:1px solid rgba(255,255,255,.14);border-radius:16px;background:#191b1f;box-shadow:0 24px 80px rgba(0,0,0,.5);color:#f5f6f7}.dsh-sub-head{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.12)}.dsh-sub-head h2{margin:0;font-size:16px}.dsh-sub-head p{margin:3px 0 0;color:#9aa0a8;font-size:11px}.dsh-sub-head button{border:0;background:transparent;color:#9aa0a8;font-size:22px;cursor:pointer}.dsh-sub-tabs{display:flex;gap:4px;padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.1);overflow:auto}.dsh-sub-tabs button{padding:7px 10px;border:0;border-radius:8px;background:transparent;color:#9aa0a8;cursor:pointer;white-space:nowrap}.dsh-sub-tabs button.active{background:#35a56f22;color:#75d09c}.dsh-sub-body{min-height:260px;overflow:auto;padding:13px 15px}.dsh-sub-form{display:flex;gap:7px;margin-bottom:12px}.dsh-sub-form.vertical{flex-direction:column}.dsh-sub-form input,.dsh-sub-form select,.dsh-sub-select{box-sizing:border-box;min-height:32px;padding:0 9px;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:#111318;color:#f5f6f7}.dsh-sub-form button,.dsh-sub-actions button{min-height:32px;padding:0 10px;border:1px solid rgba(255,255,255,.17);border-radius:8px;background:#26352d;color:#dff5e7;cursor:pointer}.dsh-sub-form button:disabled,.dsh-sub-actions button:disabled{opacity:.45;cursor:not-allowed}.dsh-sub-list{display:grid;gap:6px}.dsh-sub-list>button,.dsh-sub-audit{display:flex;justify-content:space-between;gap:10px;padding:9px 10px;border:1px solid rgba(255,255,255,.12);border-radius:9px;background:#111318;color:inherit;text-align:left;cursor:pointer}.dsh-sub-list>button.selected{border-color:#35a56f88;background:#35a56f12}.dsh-sub-list small,.dsh-sub-selected,.dsh-sub-foot{color:#9aa0a8;font-size:11px}.dsh-sub-alert{padding:8px 10px;margin-bottom:9px;border-radius:8px;font-size:12px}.dsh-sub-alert.error{background:#d84c4516;color:#f08077}.dsh-sub-alert.success{background:#35a56f16;color:#68c895}.dsh-sub-actions{display:flex;gap:8px;flex-wrap:wrap}.dsh-sub-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin-bottom:12px}.dsh-sub-grid span{display:flex;flex-direction:column;gap:3px;padding:9px;border-radius:8px;background:#111318;color:#9aa0a8;font-size:10px}.dsh-sub-grid strong{color:#f5f6f7;font-size:13px}.dsh-sub-qr-card{display:flex;flex-direction:column;align-items:center;gap:8px;margin-top:12px;padding:12px;border-radius:9px;background:#111318}.dsh-sub-qr-card img{width:220px;height:220px;object-fit:contain;background:#fff}.dsh-sub-qr-card a{color:#75d09c;font-size:11px;word-break:break-all}.dsh-sub-foot{display:flex;justify-content:space-between;padding:10px 15px;border-top:1px solid rgba(255,255,255,.1)}.dsh-sub-foot button{border:1px solid rgba(255,255,255,.15);border-radius:7px;background:transparent;color:inherit;padding:5px 9px}@media(max-width:520px){.dsh-sub-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}`
      style.textContent += `.dsh-sub-root{display:contents;height:0}.dsh-sub-dialog{top:56px;bottom:18px;left:calc(50% + var(--dsh-sidebar-half-width,140px));width:min(620px,calc(100vw - 36px));max-height:calc(100vh - 74px);box-sizing:border-box;background:var(--dsw-alias-bg-layer-1,#191b1f);border-color:var(--dsw-alias-border-l2,rgba(255,255,255,.14))}.dsh-sub-head{min-height:68px;padding:0 18px;flex:none;border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.2))}.dsh-sub-head-main{display:flex;align-items:center;gap:12px;min-width:0}.dsh-sub-head h2{line-height:22px}.dsh-sub-back{min-height:30px!important;padding:0 9px!important;border:1px solid #35a56f55!important;border-radius:8px!important;background:#35a56f12!important;color:#75d09c!important;font-size:11px!important;white-space:nowrap}.dsh-sub-close{display:grid!important;place-items:center;width:32px;height:32px;border-radius:9px!important;background:transparent!important;font-size:21px!important}.dsh-sub-tabs{gap:5px;flex:none;border-color:var(--dsw-alias-border-l1,rgba(128,128,128,.13))}.dsh-sub-tabs button{min-height:30px;border:1px solid transparent}.dsh-sub-tabs button:hover{background:rgba(128,128,128,.08);color:#d8dce1}.dsh-sub-tabs button.active{border-color:#35a56f40;background:#35a56f18}.dsh-sub-body{display:flex;flex-direction:column;min-height:0;flex:1;padding:13px 15px 16px}.dsh-sub-body>section{padding:12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.14));border-radius:11px;background:var(--dsw-alias-bg-base,#141619)}.dsh-sub-form input,.dsh-sub-form select,.dsh-sub-actions input,.dsh-sub-select{min-height:34px;padding:0 10px;background:#0f1114;outline:none}.dsh-sub-form input:focus,.dsh-sub-form select:focus,.dsh-sub-actions input:focus{border-color:#35a56f88;box-shadow:0 0 0 3px #35a56f16}.dsh-sub-form button,.dsh-sub-actions button{min-height:34px;padding:0 11px;border-color:#35a56f50;background:#244332}.dsh-sub-actions button.danger{border-color:#d84c4555;background:#d84c4512;color:#f28d85}.dsh-sub-actions{align-items:center;margin-top:12px}.dsh-sub-list{gap:7px}.dsh-sub-list>button,.dsh-sub-audit{align-items:center;min-height:42px;background:#0f1114}.dsh-sub-audit button{min-height:28px;border:1px solid #d84c4544;border-radius:7px;background:transparent;color:#f28d85}.dsh-sub-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:150px;padding:24px;border:1px dashed rgba(128,128,128,.24);border-radius:10px;background:#0f111480;text-align:center}.dsh-sub-empty strong{font-size:13px}.dsh-sub-empty p{max-width:360px;margin:7px 0 0;color:#9aa0a8;font-size:10px;line-height:16px}.dsh-sub-grid span,.dsh-sub-qr-card{border:1px solid rgba(255,255,255,.07);background:#0f1114}.dsh-sub-qr-card{padding:14px}.dsh-sub-qr-card img{border-radius:8px}.dsh-sub-foot{align-items:center;flex:none}.dsh-sub-foot button{min-height:28px;padding:0 9px}@media(max-width:520px){.dsh-sub-dialog{left:8px;right:8px;transform:none;width:calc(100vw - 16px)}.dsh-sub-head p{display:none}}`
      style.textContent += `.dsh-sub-flow-status{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 10px;border:1px solid #d9953240;border-radius:9px;background:#d9953210;color:#e4b55e}.dsh-sub-flow-status span{color:#aeb4bc;font-size:10px}.dsh-sub-flow-status.complete{border-color:#35a56f45;background:#35a56f12;color:#75d09c}.dsh-sub-kind-picker{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:5px;padding:4px;border:1px solid rgba(128,128,128,.2);border-radius:10px;background:#0b0d10}.dsh-sub-form .dsh-sub-kind-picker button{min-width:0;min-height:32px;padding:0 6px;border:1px solid transparent;background:transparent;color:#8f969f;font-size:10px}.dsh-sub-form .dsh-sub-kind-picker button:hover{background:rgba(128,128,128,.08);color:#d8dce1}.dsh-sub-form .dsh-sub-kind-picker button.active{border-color:#35a56f45;background:#35a56f1a;color:#7bd4a1}.dsh-sub-form .dsh-sub-kind-picker button.complete{color:#75d09c}.dsh-sub-field{display:flex;flex-direction:column;gap:6px;color:#9aa0a8;font-size:10px}.dsh-sub-field>span{padding-left:2px}.dsh-sub-select{width:100%;padding-right:32px!important;appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,#858c95 50%),linear-gradient(135deg,#858c95 50%,transparent 50%)!important;background-position:calc(100% - 15px) 50%,calc(100% - 10px) 50%!important;background-size:5px 5px,5px 5px!important;background-repeat:no-repeat!important}.dsh-sub-registration{display:grid;grid-template-columns:190px minmax(0,1fr);gap:12px;margin-top:12px;padding:13px;border:1px solid #35a56f38;border-radius:11px;background:linear-gradient(135deg,#35a56f0d,#0f1114)}.dsh-sub-registration-head{grid-column:1/-1;display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.dsh-sub-registration-head strong{font-size:13px}.dsh-sub-registration-head p{margin:4px 0 0;color:#9aa0a8;font-size:10px;line-height:16px}.dsh-sub-registration-head>span{flex:none;padding:3px 7px;border-radius:999px;background:#35a56f1d;color:#75d09c;font-size:9px}.dsh-sub-registration>img{width:190px;height:190px;object-fit:contain;border-radius:9px;background:#fff}.dsh-sub-registration ol{margin:3px 0 0;padding-left:20px;color:#c8cdd3;font-size:10px;line-height:18px}.dsh-sub-registration li::marker{color:#75d09c;font-weight:700}.dsh-sub-registration>a{grid-column:2;color:#75d09c;font-size:10px}.dsh-sub-registration-status{grid-column:2;margin:0;padding:8px 9px;border-radius:8px;background:rgba(128,128,128,.09);color:#aeb4bc;font-size:10px}.dsh-sub-registration-status.warning{background:#e3a72f14;color:#e9be64}.dsh-sub-registration-status.success{background:#35a56f14;color:#75d09c}.dsh-sub-registration-status.error{background:#d84c4516;color:#f28d85}@media(max-width:520px){.dsh-sub-flow-status{align-items:flex-start;flex-direction:column}.dsh-sub-kind-picker{grid-template-columns:repeat(3,minmax(0,1fr))}.dsh-sub-registration{grid-template-columns:1fr}.dsh-sub-registration>img{justify-self:center}.dsh-sub-registration>a,.dsh-sub-registration-status{grid-column:1}}`
      style.textContent += `.dsh-sub-brand-state{margin-top:12px;padding:12px;border:1px solid rgba(128,128,128,.2);border-radius:10px;background:#0f1114}.dsh-sub-brand-state.error{border-color:#d84c4544;background:#d84c450c}.dsh-sub-brand-state.warning{border-color:#e3a72f44;background:#e3a72f0b}.dsh-sub-brand-state.success{border-color:#35a56f44;background:#35a56f0b}.dsh-sub-brand-state>strong{font-size:12px}.dsh-sub-brand-state>p,.dsh-sub-brand-head p{margin:5px 0 0;color:#9aa0a8;font-size:10px;line-height:16px}.dsh-sub-brand-state>button{min-height:32px;margin-top:10px;padding:0 10px;border:1px solid #35a56f55;border-radius:8px;background:#244332;color:#dcf6e6}.dsh-sub-brand-head{display:flex;align-items:center;gap:10px}.dsh-sub-brand-head img{width:44px;height:44px;border-radius:9px;background:#090b0d}.dsh-sub-brand-state ol{margin:10px 0 0;padding-left:20px;color:#c8cdd3;font-size:10px;line-height:18px}.dsh-sub-brand-state a{color:#75d09c}.dsh-sub-defaults{margin:14px 0;padding:12px;border:1px solid rgba(128,128,128,.18);border-radius:10px;background:#0c0e11}.dsh-sub-defaults-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.dsh-sub-defaults-head strong{font-size:11px}.dsh-sub-defaults-head span{color:#848b94;font-size:9px}.dsh-sub-defaults-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.dsh-sub-defaults>button{width:100%;min-height:34px;margin-top:10px;border:1px solid #35a56f50;border-radius:8px;background:#244332;color:#dcf6e6}.dsh-sub-defaults>button:disabled{opacity:.4}.dsh-sub-actions input[aria-label*="万 Token"]{max-width:128px}@media(max-width:520px){.dsh-sub-defaults-grid{grid-template-columns:1fr}}`
      style.textContent += `.dsh-sub-workspace-modes{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;border:1px solid rgba(128,128,128,.2);border-radius:10px;background:#0b0d10}.dsh-sub-form .dsh-sub-workspace-modes button{border-color:transparent;background:transparent;color:#9299a2}.dsh-sub-form .dsh-sub-workspace-modes button.active{border-color:#35a56f45;background:#35a56f1a;color:#75d09c}.dsh-sub-workspace-panel{display:grid;gap:9px;padding:11px;border:1px solid rgba(128,128,128,.16);border-radius:10px;background:#0c0e11}.dsh-sub-workspace-path{margin:0;color:#858c95;font-size:10px;line-height:16px;overflow-wrap:anywhere}.dsh-sub-workspace-advanced{color:#8f969f;font-size:10px}.dsh-sub-workspace-advanced summary{cursor:pointer}.dsh-sub-workspace-advanced input{box-sizing:border-box;width:100%;margin-top:8px}.dsh-sub-audit.current{border-color:#35a56f55;background:#35a56f0c}.dsh-sub-audit.current strong{white-space:nowrap}.dsh-sub-account-settings{display:grid;gap:10px;margin-top:12px}.dsh-sub-account-actions{margin-top:0}.dsh-sub-quota-editor{display:grid;grid-template-columns:auto minmax(180px,1fr) auto;align-items:center;gap:9px;padding:10px;border:1px solid rgba(128,128,128,.18);border-radius:10px;background:#0c0e11}.dsh-sub-quota-editor>span{color:#9aa0a8;font-size:10px}.dsh-sub-quota-editor>button{min-height:34px;padding:0 12px;border:1px solid #35a56f50;border-radius:8px;background:#244332;color:#dcf6e6}.dsh-sub-token-input{display:flex;align-items:center;min-width:0;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:#0f1114;overflow:hidden}.dsh-sub-token-input:focus-within{border-color:#35a56f88;box-shadow:0 0 0 3px #35a56f16}.dsh-sub-form>.dsh-sub-token-input{min-width:160px}.dsh-sub-token-input input{min-width:0!important;width:100%!important;border:0!important;box-shadow:none!important;background:transparent!important;-moz-appearance:textfield}.dsh-sub-token-input input::-webkit-inner-spin-button,.dsh-sub-token-input input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}.dsh-sub-token-input span{flex:none;padding:0 10px;border-left:1px solid rgba(128,128,128,.18);color:#8f969f;font-size:10px;white-space:nowrap}@media(max-width:520px){.dsh-sub-workspace-modes{grid-template-columns:1fr}.dsh-sub-quota-editor{grid-template-columns:1fr}.dsh-sub-quota-editor>button{width:100%}}`
      document.getElementById(style.id)?.remove()
      document.head.appendChild(style)
      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-dingtalk-subscriptions', order: 69, label: '钉钉订阅管理' }, SubscriberPanel)), 'dsh-dingtalk-subscriptions: native admin panel')
      ctx.effect(() => () => style.remove(), 'dsh-dingtalk-subscriptions: styles')
    }

    exports.apply = apply
    exports.inject = inject
    exports.bridgeAvailable = bridgeAvailable
    return module.exports
  },
})
