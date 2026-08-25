// dsh-knowledge-manager — Client half
// 虾缸知识库管理：只通过明确的 UI 按钮触发写操作，不提供上传入口。
window.__ModuleLoader__.load({
  id: '@local/dsh-knowledge-manager',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const inject = ['slots']

    const safeText = (value, fallback = '') => String(value ?? fallback)
    const listFrom = (value) => {
      if (Array.isArray(value)) return value
      if (value && Array.isArray(value.items)) return value.items
      if (value && value.data) return listFrom(value.data)
      return []
    }
    const idOf = (item) => safeText(item && (item.id || item.knowledge_base_id)).trim()
    const nameOf = (item) => safeText(item && (item.name || item.title), '未命名知识库').trim() || '未命名知识库'
    const statusText = { active: '活跃', ready: '就绪', draft: '草稿', archived: '已归档', processing: '处理中', failed: '失败', deleted: '已删除' }
    const statusColor = { active: '#35a56f', ready: '#35a56f', draft: '#d99532', archived: '#8b929b', processing: '#4c8bea', failed: '#d84c45', deleted: '#d84c45' }
    const visibilityText = { private: '私有', team: '团队可见', shared: '共享', public: '公开' }
    const makeKey = (id) => `dsh-kb-ui:${id || 'none'}:${Date.now()}:${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`

    function decodeApiError(value, status) {
      const detail = value && value.detail
      const code = safeText((detail && detail.code) || (value && value.code) || `HTTP_${status}`)
      const message = safeText((detail && detail.message) || (value && value.message) || (value && value.error) || '知识库请求失败')
      const error = new Error(`${code}：${message}`)
      error.code = code
      error.status = status
      error.offline = status === 503 || /fetch|network|failed to fetch|连接|超时|offline/i.test(message)
      return error
    }

    async function tankApi(path, options = {}) {
      const query = new URLSearchParams({ path })
      const response = await fetch('/api/shrimp/tank?' + query.toString(), {
        ...options,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(options.headers || {}) },
        cache: 'no-store',
      })
      const contentType = response.headers.get('content-type') || ''
      let value
      try { value = contentType.includes('json') ? await response.json() : await response.text() } catch { value = null }
      if (!response.ok) throw decodeApiError(value && typeof value === 'object' ? value : { error: value }, response.status)
      return value && value.schema === 'api_envelope.v1' ? value.data : value
    }

    function KBIcon() {
      return h('svg', { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M5 4.8c0-1 1-1.8 2-1.8h10c1.1 0 2 .8 2 1.8v14.4c0 1-.9 1.8-2 1.8H7c-1 0-2-.8-2-1.8V4.8Z', stroke: 'currentColor', 'stroke-width': 1.65, 'stroke-linejoin': 'round' }),
        h('path', { d: 'M8 7h8M8 11h8M8 15h5', stroke: 'currentColor', 'stroke-width': 1.65, 'stroke-linecap': 'round' }),
      )
    }

    function StatusPill({ value }) {
      const status = safeText(value, 'unknown').toLowerCase()
      const color = statusColor[status] || '#8b929b'
      return h('span', { className: 'dsh-kb-status', style: { color, background: `color-mix(in srgb, ${color} 12%, transparent)` } }, statusText[status] || status || '未知')
    }

    function KnowledgeManager(props) {
      const settingsSection = Boolean(props && props.settingsSection)
      const [open, setOpen] = React.useState(false)
      const [items, setItems] = React.useState([])
      const [selectedId, setSelectedId] = React.useState('')
      const [selected, setSelected] = React.useState(null)
      const [filter, setFilter] = React.useState('')
      const [statusFilter, setStatusFilter] = React.useState('all')
      const [mode, setMode] = React.useState('view')
      const [form, setForm] = React.useState({ name: '', description: '', visibility: 'private' })
      const [deleteName, setDeleteName] = React.useState('')
      const [searchQuery, setSearchQuery] = React.useState('')
      const [searchResults, setSearchResults] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [searchBusy, setSearchBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [offline, setOffline] = React.useState(false)
      const triggerRef = React.useRef(null)
      const dialogRef = React.useRef(null)
      const firstFocusRef = React.useRef(null)

      const loadList = React.useCallback(async (keepSelection = true) => {
        setBusy(true)
        setError('')
        try {
          const value = await tankApi('/api/v1/knowledge-bases')
          const next = listFrom(value).filter((item) => safeText(item && item.status).toLowerCase() !== 'deleted')
          setItems(next)
          setOffline(false)
          if (keepSelection && selectedId) {
            const row = next.find((item) => idOf(item) === selectedId)
            if (row) setSelected(row)
            else { setSelectedId(''); setSelected(null) }
          }
        } catch (cause) {
          setOffline(Boolean(cause && cause.offline) || !navigator.onLine)
          setError(cause && cause.status === 403 ? '没有读取知识库的权限。' : safeText(cause && cause.message, '知识库读取失败'))
        } finally { setBusy(false) }
      }, [selectedId])

      React.useEffect(() => {
        if (open || settingsSection) loadList(false)
      }, [open, settingsSection, loadList])

      React.useEffect(() => {
        const closeOther = (event) => { if (event && event.detail && event.detail.id !== 'knowledge-manager') setOpen(false) }
        window.addEventListener('dsh:utility-open', closeOther)
        return () => window.removeEventListener('dsh:utility-open', closeOther)
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        const previous = document.activeElement
        const timer = setTimeout(() => (firstFocusRef.current || dialogRef.current)?.focus?.(), 0)
        const onKeyDown = (event) => {
          if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return }
          if (event.key !== 'Tab' || !dialogRef.current) return
          const focusable = [...dialogRef.current.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
          if (!focusable.length) { event.preventDefault(); return }
          const first = focusable[0]; const last = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => { clearTimeout(timer); document.removeEventListener('keydown', onKeyDown); setTimeout(() => previous?.focus?.(), 0) }
      }, [open])

      const close = () => { setOpen(false); setMode('view'); setSearchResults(null); setDeleteName(''); setError('') }
      const openManager = () => {
        const next = !open
        if (next) window.dispatchEvent(new CustomEvent('dsh:utility-open', { detail: { id: 'knowledge-manager' } }))
        setOpen(next)
      }
      const selectItem = async (item) => {
        const id = idOf(item)
        if (!id) return
        setSelectedId(id); setSelected(item); setMode('view'); setSearchResults(null); setDeleteName(''); setError('')
        try {
          const detail = await tankApi(`/api/v1/knowledge-bases/${encodeURIComponent(id)}`)
          setSelected(detail && detail.data ? detail.data : detail)
        } catch (cause) {
          // 列表元数据仍可用；把详情读取问题呈现出来，不让整个面板消失。
          setError(cause && cause.status === 403 ? '没有读取该知识库详情的权限。' : safeText(cause && cause.message, '知识库详情读取失败'))
        }
      }
      const startCreate = () => { setMode('create'); setSelected(null); setSelectedId(''); setForm({ name: '', description: '', visibility: 'private' }); setSearchResults(null); setError(''); setNotice('') }
      const startEdit = () => {
        if (!selected) return
        setMode('edit'); setForm({ name: nameOf(selected), description: safeText(selected.description), visibility: safeText(selected.visibility, 'private') }); setError(''); setNotice('')
      }
      const write = async (action, path, body, success) => {
        setBusy(true); setError(''); setNotice('')
        try {
          const value = await tankApi(path, { method: action, body: body === undefined ? undefined : JSON.stringify(body), ...(action === 'POST' && path.includes(':archive') ? { headers: { 'Idempotency-Key': makeKey(selectedId) } } : {}) })
          setNotice(success)
          await loadList(false)
          return value
        } catch (cause) {
          setOffline(Boolean(cause && cause.offline))
          setError(cause && cause.status === 403 ? '没有执行此操作的权限。' : safeText(cause && cause.message, '操作失败'))
          return null
        } finally { setBusy(false) }
      }
      const submitCreate = async (event) => {
        event.preventDefault()
        const name = safeText(form.name).trim()
        if (!name) { setError('知识库名称不能为空。'); return }
        const result = await write('POST', '/api/v1/knowledge-bases', { name, description: safeText(form.description).trim(), visibility: safeText(form.visibility, 'private') }, '知识库已新增')
        if (result) { const created = result.data || result; setMode('view'); if (created && created.id) { setSelectedId(idOf(created)); setSelected(created) } }
      }
      const submitEdit = async (event) => {
        event.preventDefault()
        const name = safeText(form.name).trim()
        if (!selectedId || !name) { setError('名称不能为空。'); return }
        const result = await write('PATCH', `/api/v1/knowledge-bases/${encodeURIComponent(selectedId)}`, { name, description: safeText(form.description).trim() }, '知识库信息已更新')
        if (result) { const updated = result.data || result; setSelected(updated); setMode('view') }
      }
      const archiveSelected = async () => {
        if (!selectedId || !selected || busy) return
        if (!window.confirm(`确认归档「${nameOf(selected)}」？归档后不会出现在默认活跃列表中。`)) return
        const result = await write('POST', `/api/v1/knowledge-bases/${encodeURIComponent(selectedId)}:archive`, undefined, '知识库已归档')
        if (result) { setSelected(null); setSelectedId('') }
      }
      const deleteSelected = async () => {
        if (!selectedId || !selected || busy || safeText(deleteName).trim() !== nameOf(selected)) return
        if (!window.confirm(`确认删除「${nameOf(selected)}」？此操作会软删除知识库并撤销 Grant。共享源文件会保留。`)) return
        const result = await write('DELETE', `/api/v1/knowledge-bases/${encodeURIComponent(selectedId)}`, undefined, '知识库已删除；共享源文件仍保留')
        if (result) { setSelected(null); setSelectedId(''); setDeleteName('') }
      }
      const search = async (event) => {
        event.preventDefault()
        const query = safeText(searchQuery).trim()
        if (!selectedId || !query) { setError('请选择知识库并输入检索内容。'); return }
        setSearchBusy(true); setError(''); setNotice('')
        try {
          const value = await tankApi(`/api/v1/knowledge-bases/${encodeURIComponent(selectedId)}/search`, { method: 'POST', headers: { 'Idempotency-Key': makeKey(selectedId) }, body: JSON.stringify({ query, top_k: 8, max_context_tokens: 4096 }) })
          setSearchResults(value && value.data ? value.data : value)
        } catch (cause) {
          setError(cause && cause.status === 403 ? '没有检索该知识库的权限。' : safeText(cause && cause.message, '内容检索失败'))
        } finally { setSearchBusy(false) }
      }

      const needle = filter.trim().toLocaleLowerCase()
      const filtered = items.filter((item) => {
        const status = safeText(item && item.status, 'unknown').toLowerCase()
        if (statusFilter !== 'all' && status !== statusFilter) return false
        if (!needle) return true
        return `${nameOf(item)} ${safeText(item && item.description)}`.toLocaleLowerCase().includes(needle)
      })
      const trigger = h('button', { ref: triggerRef, type: 'button', className: 'dsh-kb-trigger', 'aria-label': '虾缸知识库', 'aria-expanded': open, title: '虾缸知识库', onClick: openManager }, h(KBIcon), props && props.wide ? h('span', { className: 'dsh-kb-trigger-label' }, '虾缸知识库') : null, props && props.wide && items.length ? h('span', { className: 'dsh-kb-count' }, String(items.length)) : null)
      if (!settingsSection && !open) return h('div', { className: 'dsh-kb-root dsh-sidebar-footer-entry' }, trigger)

      const metadata = selected && h('section', { className: 'dsh-kb-meta', 'aria-label': '知识库元数据' },
        h('div', { className: 'dsh-kb-meta-head' }, h('div', { className: 'dsh-kb-meta-title' }, nameOf(selected)), h(StatusPill, { value: selected.status }), h('button', { type: 'button', className: 'dsh-kb-link-btn', disabled: busy, onClick: startEdit }, '编辑')),
        h('p', { className: 'dsh-kb-description' }, safeText(selected.description, '暂无说明')),
        h('div', { className: 'dsh-kb-meta-grid' },
          h('span', null, '可见性', h('strong', null, visibilityText[safeText(selected.visibility)] || safeText(selected.visibility, '私有'))),
          h('span', null, '文档数', h('strong', null, safeText(selected.document_count, '0'))),
          h('span', null, '存储', h('strong', null, selected.storage_bytes == null ? '—' : `${Math.round(Number(selected.storage_bytes) / 1024)} KB`)),
          h('span', null, '更新时间', h('strong', null, safeText(selected.updated_at, '—'))),
        ),
        h('div', { className: 'dsh-kb-search' }, h('div', { className: 'dsh-kb-section-label' }, '内容检索（只读）'), h('form', { onSubmit: search, className: 'dsh-kb-search-form' }, h('input', { value: searchQuery, onChange: (event) => setSearchQuery(event.target.value), placeholder: '输入问题或关键词', 'aria-label': '知识库内容检索' }), h('button', { type: 'submit', disabled: searchBusy || !searchQuery.trim() }, searchBusy ? '检索中…' : '检索'))),
        searchResults ? h('div', { className: 'dsh-kb-results', 'aria-live': 'polite' }, h('div', { className: 'dsh-kb-section-label' }, '检索结果'), h('pre', null, JSON.stringify(searchResults, null, 2))) : null,
        h('div', { className: 'dsh-kb-danger' }, h('div', { className: 'dsh-kb-section-label' }, '生命周期管理'), h('div', { className: 'dsh-kb-danger-actions' }, h('button', { type: 'button', disabled: busy || safeText(selected.status).toLowerCase() === 'archived', onClick: archiveSelected }, '归档'), h('div', { className: 'dsh-kb-delete-box' }, h('label', null, `删除请输入名称「${nameOf(selected)}」`, h('input', { value: deleteName, onChange: (event) => setDeleteName(event.target.value), placeholder: '输入完整名称确认删除', 'aria-label': '删除确认名称' })), h('button', { type: 'button', className: 'dsh-kb-delete-btn', disabled: busy || safeText(deleteName).trim() !== nameOf(selected), onClick: deleteSelected }, '删除')))),
        h('p', { className: 'dsh-kb-delete-note' }, '删除是软删除，会撤销该知识库的 Grant；共享源文件不会被删除。面板不提供上传，底层源文件仍由虾缸既有流程管理。'),
      )

      const formPanel = mode !== 'view' && h(
        'section', { className: 'dsh-kb-form-panel' },
        h('div', { className: 'dsh-kb-form-head' },
          h('strong', null, mode === 'create' ? '新增知识库' : '编辑知识库'),
          h('button', { type: 'button', className: 'dsh-kb-link-btn', onClick: () => setMode('view') }, '取消'),
        ),
        h('form', { onSubmit: mode === 'create' ? submitCreate : submitEdit },
          h('label', null, '名称', h('input', { ref: firstFocusRef, value: form.name, onChange: (event) => setForm({ ...form, name: event.target.value }), maxLength: 160, required: true, autoComplete: 'off' })),
          h('label', null, '说明', h('textarea', { value: form.description, onChange: (event) => setForm({ ...form, description: event.target.value }), maxLength: 1000, rows: 4 })),
          mode === 'create'
            ? h('label', null, '可见性', h('select', { value: form.visibility, onChange: (event) => setForm({ ...form, visibility: event.target.value }) },
                h('option', { value: 'private' }, '私有'),
                h('option', { value: 'team' }, '团队可见'),
                h('option', { value: 'shared' }, '共享'),
                h('option', { value: 'public' }, '公开'),
              ))
            : null,
          h('button', { type: 'submit', className: 'dsh-kb-primary', disabled: busy || !form.name.trim() }, busy ? '保存中…' : mode === 'create' ? '确认新增' : '保存修改'),
        ),
      )

      const body = h('div', { className: 'dsh-kb-body' },
        offline ? h('div', { className: 'dsh-kb-alert dsh-kb-alert-offline', role: 'status' }, '虾缸当前不可用或网络已断开；恢复后可点击刷新重试。') : null,
        error ? h('div', { className: 'dsh-kb-alert dsh-kb-alert-error', role: 'alert' }, error) : null,
        notice ? h('div', { className: 'dsh-kb-alert dsh-kb-alert-success', role: 'status' }, notice) : null,
        h('div', { className: 'dsh-kb-toolbar' }, h('div', { className: 'dsh-kb-toolbar-search' }, h('input', { ref: mode === 'view' && !selected ? firstFocusRef : null, value: filter, onChange: (event) => setFilter(event.target.value), placeholder: '按名称或说明即时筛选', 'aria-label': '筛选知识库' }), h('select', { value: statusFilter, onChange: (event) => setStatusFilter(event.target.value), 'aria-label': '按状态筛选' }, h('option', { value: 'all' }, '全部状态'), h('option', { value: 'active' }, '活跃'), h('option', { value: 'ready' }, '就绪'), h('option', { value: 'draft' }, '草稿'), h('option', { value: 'archived' }, '已归档'))), h('span', { className: 'dsh-kb-total' }, busy ? '读取中…' : `${filtered.length} / ${items.length} 个`), h('button', { type: 'button', className: 'dsh-kb-refresh', disabled: busy, onClick: () => loadList(false), title: '刷新知识库列表' }, '刷新'), h('button', { type: 'button', className: 'dsh-kb-primary dsh-kb-add', disabled: busy, onClick: startCreate }, '+ 新增')),
        h('div', { className: 'dsh-kb-content' },
          h('div', { className: 'dsh-kb-list', 'aria-label': '知识库列表' }, busy && !items.length ? h('div', { className: 'dsh-kb-state' }, h('span', { className: 'dsh-kb-spinner' }), '正在读取知识库…') : filtered.length ? filtered.map((item) => h('button', { type: 'button', key: idOf(item), className: `dsh-kb-row${idOf(item) === selectedId ? ' is-selected' : ''}`, onClick: () => selectItem(item) }, h('span', { className: 'dsh-kb-row-main' }, h('strong', null, nameOf(item)), h('small', null, safeText(item.description, '暂无说明'))), h(StatusPill, { value: item.status }), h('span', { className: 'dsh-kb-row-count' }, safeText(item.document_count, '0')))) : h('div', { className: 'dsh-kb-state' }, items.length ? '没有匹配的知识库。' : '当前账户还没有可访问的知识库。')),
          mode !== 'view' ? formPanel : selected ? metadata : h('div', { className: 'dsh-kb-placeholder' }, h(KBIcon), h('strong', null, '选择一个知识库'), h('span', null, '右侧将显示元数据、只读检索与生命周期操作。')),
        ),
      )

      if (props && props.settingsSection) {
        return h('section', { className: 'dsh-kb-settings-section', 'data-settings-section': 'shrimp-knowledge', 'aria-label': '虾缸知识库' },
          h('header', { className: 'dsh-kb-settings-head' }, h('div', { className: 'dsh-kb-title-row' }, h('span', { className: 'dsh-kb-mark' }, h(KBIcon)), h('div', null, h('h2', null, '虾缸知识库'), h('p', null, '管理当前账户可访问的知识库与只读检索')))),
          body,
        )
      }

      return h('div', { className: 'dsh-kb-root dsh-sidebar-footer-entry' }, trigger,
        h('div', { className: 'dsh-kb-backdrop', onMouseDown: (event) => { if (event.target === event.currentTarget) close() }, 'aria-hidden': true }),
        h('section', { ref: dialogRef, className: 'dsh-kb-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'dsh-kb-title', tabIndex: -1 },
          h('header', { className: 'dsh-kb-head' }, h('div', { className: 'dsh-kb-title-row' }, h('span', { className: 'dsh-kb-mark' }, h(KBIcon)), h('div', null, h('h2', { id: 'dsh-kb-title' }, '虾缸知识库'), h('p', null, '管理当前账户可访问的知识库与只读检索'))), h('button', { type: 'button', className: 'dsh-kb-close', onClick: close, 'aria-label': '关闭虾缸知识库' }, '×')),
          body,
        ),
      )
    }

    function apply(ctx) {
      const style = document.createElement('style')
      style.id = 'dsh-knowledge-manager-styles'
      style.textContent = `
        .dsh-kb-root{box-sizing:border-box;position:relative;display:flex;align-items:center;flex:0 0 auto;width:auto;height:36px;min-height:36px;font:13px/1.4 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--dsw-alias-label-primary,#f5f6f7)}
        .dsh-kb-trigger{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:7px;height:36px;min-height:36px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:999px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#f5f6f7);cursor:pointer;white-space:nowrap;line-height:1}
        .dsh-kb-trigger:hover,.dsh-kb-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));border-color:color-mix(in srgb,#ed654f 48%,transparent)}
        .dsh-kb-trigger svg,.dsh-kb-mark svg,.dsh-kb-placeholder svg{display:block;width:17px;height:17px;flex:0 0 17px}.dsh-kb-count{min-width:16px;padding:0 5px;border-radius:999px;background:#ed654f1c;color:#ed654f;font-size:10px;line-height:18px;text-align:center}.dsh-kb-backdrop{position:fixed;inset:0;z-index:10020;background:rgba(8,12,18,.43);backdrop-filter:blur(1px)}
        .dsh-kb-dialog{position:fixed;z-index:10021;top:56px;right:18px;bottom:18px;display:flex;flex-direction:column;box-sizing:border-box;width:min(980px,calc(100vw - 36px));max-height:calc(100vh - 74px);overflow:hidden;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:16px;background:var(--dsw-alias-bg-layer-1,#191b1f);box-shadow:0 24px 80px rgba(0,0,0,.5);color:var(--dsw-alias-label-primary,#f5f6f7);outline:none}
        .dsh-kb-head{display:flex;align-items:center;justify-content:space-between;min-height:68px;padding:0 18px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));flex:none}.dsh-kb-title-row{display:flex;align-items:center;gap:10px;min-width:0}.dsh-kb-mark{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;color:#ed654f;background:#ed654f18}.dsh-kb-head h2{margin:0;font-size:16px;line-height:22px}.dsh-kb-head p{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px}.dsh-kb-close{display:grid;place-items:center;width:32px;height:32px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary,#8c949d);font-size:21px;cursor:pointer}.dsh-kb-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));color:var(--dsw-alias-label-primary)}
        .dsh-kb-body{display:flex;flex-direction:column;min-height:0;flex:1;padding:13px 15px 16px}.dsh-kb-alert{padding:8px 10px;margin-bottom:9px;border-radius:9px;font-size:12px}.dsh-kb-alert-error{background:#d84c4516;color:#f08077}.dsh-kb-alert-success{background:#35a56f16;color:#68c895}.dsh-kb-alert-offline{background:#d9953216;color:#ebb463}.dsh-kb-toolbar{display:flex;align-items:center;gap:7px;min-height:34px;flex:none}.dsh-kb-toolbar-search{display:flex;gap:7px;min-width:0;flex:1}.dsh-kb-toolbar input,.dsh-kb-toolbar select,.dsh-kb-form-panel input,.dsh-kb-form-panel select,.dsh-kb-form-panel textarea,.dsh-kb-search-form input,.dsh-kb-delete-box input{box-sizing:border-box;width:100%;min-height:32px;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:8px;background:var(--dsw-alias-bg-base,#141619);color:inherit;font:inherit;font-size:12px;outline:none}.dsh-kb-toolbar-search select{width:105px;flex:none}.dsh-kb-toolbar input:focus,.dsh-kb-toolbar select:focus,.dsh-kb-form-panel input:focus,.dsh-kb-form-panel textarea:focus,.dsh-kb-search-form input:focus,.dsh-kb-delete-box input:focus{border-color:#5b8ff9;box-shadow:0 0 0 2px #5b8ff933}.dsh-kb-total{flex:none;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;white-space:nowrap}.dsh-kb-refresh,.dsh-kb-link-btn,.dsh-kb-danger-actions button,.dsh-kb-search-form button{min-height:30px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:8px;background:transparent;color:inherit;font-size:11px;cursor:pointer;white-space:nowrap}.dsh-kb-refresh:disabled,.dsh-kb-link-btn:disabled,.dsh-kb-danger-actions button:disabled,.dsh-kb-search-form button:disabled,.dsh-kb-primary:disabled{cursor:not-allowed;opacity:.45}.dsh-kb-primary{min-height:30px;padding:0 11px;border:1px solid #ed654f;border-radius:8px;background:#ed654f;color:#fff;font-size:11px;cursor:pointer;white-space:nowrap}.dsh-kb-content{display:grid;grid-template-columns:minmax(270px,.9fr) minmax(0,1.35fr);gap:10px;min-height:0;flex:1;margin-top:10px}.dsh-kb-list{min-width:0;overflow:auto;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:11px;padding:5px;background:var(--dsw-alias-bg-base,#141619)}.dsh-kb-row{display:flex;align-items:center;gap:7px;width:100%;min-width:0;min-height:53px;padding:7px 8px;border:0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.1));background:transparent;color:inherit;text-align:left;cursor:pointer}.dsh-kb-row:last-child{border-bottom:0}.dsh-kb-row:hover,.dsh-kb-row.is-selected{background:color-mix(in srgb,#ed654f 9%,transparent)}.dsh-kb-row-main{display:flex;flex-direction:column;min-width:0;flex:1}.dsh-kb-row-main strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:620}.dsh-kb-row-main small{margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10px}.dsh-kb-status{display:inline-flex;align-items:center;justify-content:center;flex:none;min-height:20px;padding:0 6px;border-radius:999px;font-size:10px;white-space:nowrap}.dsh-kb-row-count{flex:none;min-width:22px;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10px;text-align:right}.dsh-kb-meta,.dsh-kb-form-panel{min-width:0;min-height:0;overflow:auto;padding:13px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:11px;background:var(--dsw-alias-bg-layer-1,#191b1f)}.dsh-kb-meta-head,.dsh-kb-form-head{display:flex;align-items:center;gap:7px}.dsh-kb-meta-title{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;font-weight:650}.dsh-kb-description{min-height:30px;margin:8px 0 11px;color:var(--dsw-alias-label-secondary,#b1b7bf);font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}.dsh-kb-meta-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;padding:9px;border-radius:9px;background:var(--dsw-alias-bg-base,#141619);color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10px}.dsh-kb-meta-grid span{display:flex;flex-direction:column;gap:3px;min-width:0}.dsh-kb-meta-grid strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#f5f6f7);font-size:11px;font-weight:550}.dsh-kb-section-label{margin-bottom:6px;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10px}.dsh-kb-search{margin-top:14px}.dsh-kb-search-form{display:flex;gap:6px}.dsh-kb-search-form button{color:#fff;background:#4c73c8;border-color:#4c73c8}.dsh-kb-results{margin-top:10px;max-height:190px;overflow:auto;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-base,#141619)}.dsh-kb-results pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#b1b7bf);font:10px/15px ui-monospace,SFMono-Regular,Menlo,monospace}.dsh-kb-danger{margin-top:15px;padding-top:12px;border-top:1px solid #d84c4528}.dsh-kb-danger-actions{display:flex;gap:8px;align-items:flex-start}.dsh-kb-danger-actions>button{color:#e77870;border-color:#d84c4566}.dsh-kb-delete-box{display:flex;gap:6px;min-width:0;flex:1}.dsh-kb-delete-box label{display:grid;gap:4px;min-width:0;flex:1;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10px}.dsh-kb-delete-btn{color:#fff!important;background:#b64540!important;border-color:#b64540!important}.dsh-kb-delete-note{margin:9px 0 0;color:#c97c76;font-size:10px;line-height:15px}.dsh-kb-form-panel form{display:grid;gap:11px;margin-top:13px}.dsh-kb-form-panel label{display:grid;gap:5px;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px}.dsh-kb-form-panel textarea{resize:vertical}.dsh-kb-form-panel .dsh-kb-primary{justify-self:start;margin-top:2px}.dsh-kb-placeholder,.dsh-kb-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:180px;padding:20px;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;text-align:center}.dsh-kb-placeholder svg{width:29px;height:29px;color:#ed654f}.dsh-kb-placeholder strong{color:var(--dsw-alias-label-secondary,#b1b7bf)}.dsh-kb-spinner{width:16px;height:16px;border:2px solid #ed654f38;border-top-color:#ed654f;border-radius:50%;animation:dsh-kb-spin .8s linear infinite}@keyframes dsh-kb-spin{to{transform:rotate(360deg)}}
        @media(max-width:760px){.dsh-kb-trigger-label,.dsh-kb-count{display:none}.dsh-kb-trigger{width:36px;padding:0}.dsh-kb-dialog{top:8px;right:8px;bottom:8px;width:calc(100vw - 16px);max-height:none}.dsh-kb-content{grid-template-columns:1fr;grid-template-rows:minmax(160px,.7fr) minmax(260px,1.3fr)}.dsh-kb-meta-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dsh-kb-toolbar{flex-wrap:wrap}.dsh-kb-toolbar-search{width:100%;flex-basis:100%}.dsh-kb-total{margin-left:auto}.dsh-kb-danger-actions{flex-direction:column}.dsh-kb-delete-box{width:100%}}
      `
      document.getElementById(style.id)?.remove()
      document.head.appendChild(style)
      // The base CSS keeps the historical mobile fallback. This later,
      // explicit contract keeps list/detail side by side on fine-pointer Mac
      // windows even when HiDPI makes the CSS viewport look narrow.
      const layoutStyle = document.createElement('style')
      layoutStyle.id = 'dsh-knowledge-manager-layout-styles'
      layoutStyle.textContent = `
        .dsh-kb-settings-section{box-sizing:border-box;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#f5f6f7)}
        .dsh-kb-settings-head{box-sizing:border-box;display:flex;align-items:center;flex:none;min-height:54px;padding:10px 0 8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2))}
        .dsh-kb-settings-head .dsh-kb-title-row{display:flex;align-items:center;gap:10px;min-width:0}
        .dsh-kb-settings-head h2{margin:0;font-size:16px;line-height:22px;font-weight:600}
        .dsh-kb-settings-head p{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:16px}
        .dsh-kb-settings-section > .dsh-kb-body{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;padding:12px 0 0}
        .dsh-kb-content{grid-template-columns:minmax(170px,.9fr) minmax(0,1.35fr)!important;grid-template-rows:none!important;min-width:0;overflow-x:auto}
        .dsh-kb-content > .dsh-kb-list,.dsh-kb-content > .dsh-kb-meta,.dsh-kb-content > .dsh-kb-form-panel,.dsh-kb-content > .dsh-kb-placeholder{min-width:0}
        .dsh-kb-trigger-label,.dsh-kb-count{display:inline}
        .dsh-kb-trigger{width:auto;padding:0 12px}
        @media(max-width:520px) and (pointer:coarse),(max-width:380px){
          .dsh-kb-trigger-label,.dsh-kb-count{display:none}
          .dsh-kb-trigger{width:36px;padding:0}
          .dsh-kb-content{grid-template-columns:1fr!important;grid-template-rows:minmax(160px,.7fr) minmax(260px,1.3fr)!important;overflow-x:hidden}
        }
      `
      document.getElementById(layoutStyle.id)?.remove()
      document.head.appendChild(layoutStyle)
      ctx.effect(() => () => { style.remove(); layoutStyle.remove() }, 'dsh-knowledge-manager: styles')
      // Knowledge management is a first-class Settings section. It no longer
      // occupies the sidebar footer; SettingsRoot owns the left navigation and
      // renders this component directly in its right content column.
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'dsh-knowledge-manager', order: 100, label: '虾缸知识库',
        inject: () => ({ settingsSection: true }),
      }, KnowledgeManager)), 'dsh-knowledge-manager: settings section')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
