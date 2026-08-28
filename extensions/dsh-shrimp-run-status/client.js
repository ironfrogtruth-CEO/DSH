// @local/dsh-shrimp-run-status — the `/虾缸` input card.
// It is a read-only surface: the command contribution only opens this card.
window.__ModuleLoader__.load({
  id: '@local/dsh-shrimp-run-status',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const inject = ['slots', 'commandUi']
    const OPEN_EVENT = 'shrimp:tank-open'
    const COMPOSER_WORKBENCH_EVENT = 'dsh:composer-workbench'
    const AUTO_DISCOVERY_INTERVAL_MS = 12_000
    const HIDDEN_AUTO_DISCOVERY_INTERVAL_MS = 30_000
    const FULL_SUMMARY_REFRESH_INTERVAL_MS = 4_000
    const DISMISSED_STORAGE_PREFIX = 'dsh-shrimp-tank-dismissed:'
    const ACTIVE_STATUSES = new Set([
      'running',
      'processing',
      'queued',
      'trialing',
      'awaiting_confirmation',
      'awaiting_external',
      'waiting_external',
      'cancel_requested',
    ])
    const STATUS_ALIASES = new Map([
      ['done', 'completed'],
      ['succeeded', 'completed'],
      ['success', 'completed'],
      ['complete', 'completed'],
      ['error', 'failed'],
      ['failure', 'failed'],
      ['canceled', 'cancelled'],
      ['aborted', 'cancelled'],
      ['stopped', 'cancelled'],
      ['processing', 'running'],
      ['in_progress', 'running'],
      ['in-progress', 'running'],
      ['waiting_approval', 'approval_needed'],
      ['approval', 'approval_needed'],
    ])
    const IDLE_COLORS = ['#6f9d9a', '#8f86ad', '#b28b6b', '#6f8eae']
    const PUBLISHED_EXCLUDED_LIFECYCLES = new Set(['deleted', 'archived', 'draft'])
    const STATUS_LABELS = {
      running: '运行中',
      processing: '处理中',
      queued: '排队中',
      trialing: '试跑中',
      awaiting_confirmation: '等待确认',
      awaiting_external: '等待外部处理',
      waiting_external: '等待外部处理',
      cancel_requested: '取消中',
      completed: '已完成',
      failed: '失败',
      blocked: '已阻断',
      cancelled: '已取消',
      approval_needed: '等待确认',
      pending: '待运行',
      unknown: '状态未知',
    }

    const text = (value) => value == null ? '' : typeof value === 'string' ? value : String(value)
    const first = (...values) => {
      for (const value of values) {
        const result = text(value).trim()
        if (result) return result
      }
      return ''
    }
    const normalizeStatus = (value) => {
      const raw = text(value).trim().toLowerCase().replace(/[\s-]+/g, '_')
      return STATUS_ALIASES.get(raw) || raw || 'unknown'
    }
    const isActiveStatus = (value) => ACTIVE_STATUSES.has(normalizeStatus(value))
    const unwrap = (value) => {
      let current = value
      for (let index = 0; index < 4; index += 1) {
        if (!current || typeof current !== 'object' || Array.isArray(current) || current.schema !== 'api_envelope.v1') break
        current = current.data
      }
      return current
    }
    const unwrapItems = (value) => {
      const root = unwrap(value)
      if (Array.isArray(root)) return root
      if (Array.isArray(root?.items)) return root.items
      if (Array.isArray(root?.runs)) return root.runs
      if (Array.isArray(root?.data)) return root.data
      return []
    }
    const publishedLifecycleOf = (item) => text(item?.lifecycle_status || item?.lifecycleStatus || item?.lifecycle || item?.state || item?.status).trim().toLowerCase()
    const publishedRefOf = (item) => first(item?.ref, item?.slug, item?.id)
    const publishedNameOf = (item) => first(item?.display_name, item?.title, item?.name)
    const projectPublishedShrimps = (items) => {
      const output = []
      const positions = new Map()
      for (const item of Array.isArray(items) ? items : []) {
        if (!item || item.identity !== 'pipeline') continue
        const ref = publishedRefOf(item)
        const name = publishedNameOf(item)
        const lifecycle = publishedLifecycleOf(item)
        if (!ref || !name || PUBLISHED_EXCLUDED_LIFECYCLES.has(lifecycle)) continue
        const previousIndex = positions.get(ref)
        if (previousIndex === undefined) {
          positions.set(ref, output.length)
          output.push(item)
        } else if (lifecycle === 'published' && publishedLifecycleOf(output[previousIndex]) !== 'published') {
          output[previousIndex] = item
        }
      }
      return output
    }
    const progressOf = (value) => {
      const number = Number(value?.progress_percent ?? value?.progressPercent ?? value?.progress ?? value?.percent)
      return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null
    }
    const messageOf = (value, keys) => {
      if (!value || typeof value !== 'object') return ''
      for (const key of keys) {
        const candidate = value[key]
        if (candidate && typeof candidate === 'object') {
          const nested = first(candidate.message, candidate.text, candidate.detail, candidate.reason)
          if (nested) return nested.slice(0, 500)
        }
        const message = text(candidate).trim()
        if (message) return message.slice(0, 500)
      }
      return ''
    }
    const normalizeNode = (node, index = 0) => {
      const source = node && typeof node === 'object' ? node : {}
      const status = normalizeStatus(source.status || source.state || source.lifecycle_status)
      const state = status === 'completed'
        ? 'done'
        : status === 'failed'
          ? 'failed'
          : status === 'blocked' || status === 'cancelled'
            ? 'blocked'
            : status === 'running' || status === 'processing' || status === 'queued' || status === 'pending' || status === 'approval_needed'
              ? status
              : 'pending'
      return {
        id: first(source.node_id, source.nodeId, source.id, source.key, `node-${index + 1}`),
        name: first(source.node_name, source.nodeName, source.display_name, source.name, source.title, source.node_id, source.nodeId),
        status,
        state,
        progress: progressOf(source),
        failure: messageOf(source, ['failure_message', 'error_summary', 'error', 'failure_summary', 'failure']),
        blocked: messageOf(source, ['blocked_message', 'blocked_reason', 'blocking_reason', 'blocked']),
        order: Number(source.order_index ?? source.order ?? index),
      }
    }
    const summaryRoot = (value) => {
      const root = unwrap(value)
      return root?.summary && typeof root.summary === 'object' && !Array.isArray(root.summary) ? { ...root, ...root.summary } : root
    }
    const statusRoot = (value) => {
      const root = unwrap(value)
      return root?.status && typeof root.status === 'object' && !Array.isArray(root.status) ? { ...root, ...root.status } : root
    }
    const nodeSource = (value) => {
      if (!value || typeof value !== 'object') return []
      if (Array.isArray(value.nodes)) return value.nodes
      if (Array.isArray(value.node_states)) return value.node_states
      if (Array.isArray(value.nodeStates)) return value.nodeStates
      if (Array.isArray(value.steps)) return value.steps
      return []
    }
    const currentNodeIdOf = (value, nodes) => {
      const direct = value?.current_node && typeof value.current_node === 'object' ? value.current_node : null
      const currentId = first(value?.current_node_id, value?.currentNodeId, direct?.id, direct?.node_id)
      if (currentId) return currentId
      const currentText = typeof value?.current_node === 'string' ? value.current_node : typeof value?.currentNode === 'string' ? value.currentNode : first(value?.current_node_name, value?.currentNodeName, direct?.node_name, direct?.name)
      if (currentText) return nodes.find((node) => node.id === currentText || node.name === currentText)?.id || ''
      return nodes.find((node) => ['running', 'processing', 'queued', 'failed', 'blocked'].includes(node.status))?.id || ''
    }
    const currentNodeOf = (value, nodes) => {
      const currentId = currentNodeIdOf(value, nodes)
      return nodes.find((node) => node.id === currentId)?.name || currentId || ''
    }
    const normalizeRunPayload = (summaryValue, statusValue) => {
      const summary = summaryRoot(summaryValue)
      const status = statusRoot(statusValue)
      const merged = { ...(status && typeof status === 'object' ? status : {}), ...(summary && typeof summary === 'object' ? summary : {}) }
      const nodes = nodeSource(merged).map(normalizeNode).sort((left, right) => left.order - right.order)
      const progress = progressOf(merged)
      const statusName = normalizeStatus(merged.status || merged.state || merged.lifecycle_status)
      const failure = messageOf(merged, ['failure_message', 'error_summary', 'error', 'failure_summary', 'failure'])
      const blocked = messageOf(merged, ['blocked_message', 'blocked_reason', 'blocking_reason', 'blocked'])
      return {
        status: statusName,
        progress: progress == null && nodes.length ? Math.round(nodes.reduce((sum, node) => sum + (node.progress ?? (node.state === 'done' ? 100 : 0)), 0) / nodes.length) : progress,
        nodes,
        currentNode: currentNodeOf(merged, nodes),
        currentNodeId: currentNodeIdOf(merged, nodes),
        name: first(merged.display_name, merged.pipeline_name, merged.name, merged.title, merged.shrimp_name),
        startedAt: first(merged.started_at, merged.startedAt, merged.created_at, merged.createdAt),
        updatedAt: first(merged.updated_at, merged.updatedAt, merged.finished_at, merged.completed_at),
        failure,
        blocked,
        raw: merged,
      }
    }
    const valuesOf = (value, keys) => !value || typeof value !== 'object' ? [] : keys.map((key) => text(value[key]).trim()).filter(Boolean)
    const pipelineRefsOf = (value) => [...new Set(valuesOf(value, ['pipeline_ref', 'pipelineRef', 'pipeline_slug', 'pipelineSlug', 'pipeline_id', 'pipelineId', 'shrimp_ref', 'shrimpRef', 'ref', 'slug']))]
    const refsMatch = (left, right) => {
      const leftRefs = pipelineRefsOf(left)
      const rightRefs = pipelineRefsOf(right)
      return leftRefs.length > 0 && rightRefs.length > 0 && rightRefs.some((ref) => leftRefs.includes(ref))
    }
    const runIdOf = (run) => first(run?.id, run?.run_id, run?.runId)
    const runUpdatedAt = (run) => {
      const parsed = Date.parse(first(run?.updated_at, run?.updatedAt, run?.finished_at, run?.finishedAt, run?.completed_at, run?.started_at, run?.created_at))
      if (Number.isFinite(parsed)) return parsed
      const numeric = Number(run?.updated_at ?? run?.updatedAt ?? run?.created_at ?? run?.seq ?? 0)
      return Number.isFinite(numeric) ? numeric : 0
    }
    const embeddedRun = (item) => {
      if (!item || typeof item !== 'object' || !item.run || typeof item.run !== 'object') return null
      const refs = [...new Set([...pipelineRefsOf(item), ...valuesOf(item, ['id'])])]
      if (refs.length === 0) return null
      if (pipelineRefsOf(item.run).length > 0 && !pipelineRefsOf(item.run).some((ref) => refs.includes(ref))) return null
      return pipelineRefsOf(item.run).length > 0 ? { ...item.run, __embedded: true } : { ...item.run, pipeline_ref: refs[0], __embedded: true }
    }
    const itemRefsOf = (item) => [...new Set([...pipelineRefsOf(item), ...valuesOf(item, ['id'])])]
    const runBelongsTo = (run, item) => {
      const itemRefs = itemRefsOf(item)
      const runRefs = pipelineRefsOf(run)
      return Boolean(run && item && itemRefs.length > 0 && ((run.__embedded === true) || (runRefs.length > 0 && runRefs.some((ref) => itemRefs.includes(ref)))))
    }
    const latestActiveRun = (item, runs) => {
      const embedded = embeddedRun(item)
      const matched = (Array.isArray(runs) ? runs : []).filter((run) => runBelongsTo(run, item))
      if (embedded) matched.push(embedded)
      const active = matched.filter((run) => isActiveStatus(run?.status || run?.state || run?.lifecycle_status))
      active.sort((left, right) => runUpdatedAt(right) - runUpdatedAt(left) || runIdOf(right).localeCompare(runIdOf(left)))
      return active[0] || null
    }
    const canonicalName = (item, run) => {
      const itemName = publishedNameOf(item)
      if (itemName) return itemName
      const runName = first(run?.display_name, run?.pipeline_name, run?.name, run?.title)
      return runName || first(itemRefsOf(item)[0], pipelineRefsOf(run)[0]) || '未命名虾'
    }
    const groupLatestActiveRuns = (items, runs) => {
      const byRef = new Map()
      for (const item of Array.isArray(items) ? items : []) {
        const refs = itemRefsOf(item)
        if (refs.length === 0) continue
        const run = latestActiveRun(item, runs)
        if (!run) continue
        const group = { ref: refs[0], refs, item, run, name: canonicalName(item, run), updatedAt: runUpdatedAt(run) }
        const previous = byRef.get(group.ref)
        if (!previous || group.updatedAt > previous.updatedAt || (group.updatedAt === previous.updatedAt && runIdOf(group.run).localeCompare(runIdOf(previous.run)) > 0)) byRef.set(group.ref, group)
      }
      return [...byRef.values()].sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name))
    }
    // Stable identity for active canonical runs. Names, ordering and progress
    // are deliberately excluded so a dismissed run cannot bounce the card.
    const activeRunSignature = (groups) => {
      const entries = []
      for (const group of Array.isArray(groups) ? groups : []) {
        const pipelineRef = first(
          pipelineRefsOf(group?.run)[0],
          group?.pipelineRef,
          group?.pipeline_ref,
          group?.ref,
          pipelineRefsOf(group)[0],
          pipelineRefsOf(group?.item)[0],
        )
        const runId = first(group?.runId, group?.run_id, runIdOf(group?.run), runIdOf(group))
        if (pipelineRef && runId) entries.push(`${pipelineRef}:${runId}`)
      }
      return [...new Set(entries)].sort().join('|')
    }
    const activeSignature = activeRunSignature
    const autoDiscoveryDelayMs = (hidden = false) => hidden ? HIDDEN_AUTO_DISCOVERY_INTERVAL_MS : AUTO_DISCOVERY_INTERVAL_MS
    const autoPollDelayMs = autoDiscoveryDelayMs
    const runSignatureEntries = (signature) => [...new Set(text(signature).split('|').map((entry) => entry.trim()).filter(Boolean))].sort()
    const mergeRunSignatures = (...signatures) => [...new Set(signatures.flatMap(runSignatureEntries))].sort().join('|')
    const dismissalStorageKey = (sessionId) => {
      const id = first(sessionId)
      return id ? `${DISMISSED_STORAGE_PREFIX}${encodeURIComponent(id)}` : ''
    }
    const readDismissedSignature = (sessionId) => {
      const key = dismissalStorageKey(sessionId)
      if (!key || typeof window === 'undefined') return ''
      try { return first(window.localStorage?.getItem(key)) } catch { return '' }
    }
    const writeDismissedSignature = (sessionId, signature) => {
      const key = dismissalStorageKey(sessionId)
      if (!key || !signature || typeof window === 'undefined') return
      try { window.localStorage?.setItem(key, signature) } catch { /* private mode/storage quota */ }
    }
    const clearDismissedSignature = (sessionId) => {
      const key = dismissalStorageKey(sessionId)
      if (!key || typeof window === 'undefined') return
      try { window.localStorage?.removeItem(key) } catch { /* private mode/storage quota */ }
    }
    const shouldAutoOpen = (signature, dismissedSignature = '') => {
      const active = runSignatureEntries(signature)
      if (active.length === 0) return false
      const dismissed = new Set(runSignatureEntries(dismissedSignature))
      return active.some((entry) => !dismissed.has(entry))
    }
    const visibleNodes = (nodes, limit = 6, current = undefined) => {
      const source = Array.isArray(nodes) ? nodes : []
      if (limit && typeof limit === 'object') {
        current = limit
        limit = Number(current.limit || 6)
      }
      const maxVisible = Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : 6)
      if (source.length <= maxVisible) return source.map((node) => ({ node }))
      const currentId = typeof current === 'string' ? current : first(current?.currentNodeId, current?.nodeId, current?.id, current?.currentNode)
      let currentIndex = currentId ? source.findIndex((node) => node?.id === currentId || node?.node_id === currentId || node?.name === currentId || node?.node_name === currentId) : -1
      const nodeState = (node) => normalizeStatus(node?.state || node?.status || node?.lifecycle_status)
      const runningIndexes = source
        .map((node, index) => ({ node, index }))
        .filter(({ node }) => nodeState(node) === 'running' || normalizeStatus(node?.status || node?.state || node?.lifecycle_status) === 'running')
        .map(({ index }) => index)
      if (currentIndex < 0) currentIndex = runningIndexes[0] ?? source.findIndex((node) => ['processing', 'queued', 'failed', 'blocked'].includes(nodeState(node)))
      const focusIndex = currentIndex < 0 ? (runningIndexes[0] ?? 0) : currentIndex
      const required = []
      const addRequired = (index) => {
        if (index >= 0 && index < source.length && !required.includes(index)) required.push(index)
      }
      // Keep first, last, current and every running node visible. A stale
      // currentNodeId must never hide the node that is actually running.
      addRequired(0)
      addRequired(source.length - 1)
      addRequired(currentIndex)
      for (const index of runningIndexes) addRequired(index)
      const preferred = []
      const addPreferred = (index) => {
        if (index >= 0 && index < source.length && !required.includes(index) && !preferred.includes(index)) preferred.push(index)
      }
      for (let distance = 1; distance < source.length; distance += 1) {
        addPreferred(focusIndex - distance)
        addPreferred(focusIndex + distance)
      }
      const fill = Array.from({ length: source.length }, (_, index) => index)
        .filter((index) => !required.includes(index) && !preferred.includes(index))
        .sort((left, right) => (Math.abs(left - focusIndex) - Math.abs(right - focusIndex)) || left - right)
      const visibleCount = Math.max(maxVisible, required.length)
      const indexes = [...required, ...preferred, ...fill].slice(0, visibleCount).sort((left, right) => left - right)
      const output = []
      let previous = -1
      for (const index of indexes) {
        if (previous >= 0 && index - previous > 1) output.push({ ellipsis: true, key: `ellipsis-${previous}-${index}` })
        output.push({ node: source[index] })
        previous = index
      }
      return output
    }

    const tankApi = async (path, options = {}) => {
      const query = new URLSearchParams({ path })
      const response = await fetch(`/api/shrimp/tank?${query.toString()}`, { cache: 'no-store', headers: { Accept: 'application/json' }, signal: options.signal })
      const value = await response.json().catch(() => null)
      if (!response.ok) throw new Error(text(value?.error?.message || value?.error || value?.message || `虾缸请求失败（${response.status}）`))
      return unwrap(value)
    }
    const dispatchOpen = (sessionId) => {
      if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
      window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { sessionId: text(sessionId) } }))
    }

    const formatProgress = (value) => value == null ? '' : `${Math.round(Number(value))}%`
    const statusLabel = (status) => STATUS_LABELS[normalizeStatus(status)] || normalizeStatus(status)

    function ShrimpMark({ color }) {
      return h('svg', {
        className: 'dsh-shrimp-tank-idle-mark',
        viewBox: '0 0 48 32',
        role: 'img',
        'aria-label': '虾缸标识',
        focusable: 'false',
      },
      h('path', { d: 'M8 20c4-10 16-14 25-8 4 3 6 6 8 10-5-2-10-2-14 1-5 4-12 3-19-3Z', fill: 'none', stroke: color, 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
      h('path', { d: 'M13 22c-3 4-6 5-10 4', fill: 'none', stroke: color, 'stroke-width': '2.4', 'stroke-linecap': 'round' }),
      h('circle', { cx: '37', cy: '7', r: '2.8', fill: '#e15f59' }),
      )
    }

    const idleIdentityParts = (identity) => {
      const name = publishedNameOf(identity) || '未命名虾'
      const marker = name.indexOf('@')
      if (marker <= 0) return { primary: name, owner: '' }
      return { primary: name.slice(0, marker).trim() || name, owner: name.slice(marker).trim() }
    }

    function IdleView({ shrimps }) {
      const entries = Array.isArray(shrimps) ? shrimps : []
      if (entries.length === 0) return h('p', { className: 'dsh-shrimp-tank-idle-empty' }, '虾缸里还没有已发布的虾')
      return h('section', { className: 'dsh-shrimp-tank-idle', 'aria-label': '虾缸中的虾' },
        h('p', { className: 'dsh-shrimp-tank-idle-hint' }, '现在没有虾在运行'),
        h('div', { className: 'dsh-shrimp-tank-pond', 'aria-label': '已发布虾' },
          h('ul', { className: 'dsh-shrimp-tank-idle-grid' }, entries.map((identity, index) => {
            const parts = idleIdentityParts(identity)
            const color = IDLE_COLORS[index % IDLE_COLORS.length]
            return h('li', {
              key: publishedRefOf(identity) || identity.name || identity.title || index,
              className: 'dsh-shrimp-tank-idle-card',
              style: { '--idle-color': color },
              title: publishedNameOf(identity),
            },
            h('span', { className: 'dsh-shrimp-tank-idle-card-mark', 'aria-hidden': true }, h(ShrimpMark, { color })),
            h('span', { className: 'dsh-shrimp-tank-idle-card-copy' }, h('strong', null, parts.primary), parts.owner ? h('span', null, parts.owner) : null),
            h('span', { className: 'dsh-shrimp-tank-idle-card-state' }, '待命'),
            )
          }))
        ),
      )
    }

    function NodeStepper({ nodes, currentNodeId, currentNode, unavailable }) {
      if (unavailable) return h('p', { className: 'dsh-shrimp-tank-node-unavailable', role: 'status' }, `真实节点暂时无法读取：${unavailable}`)
      const entries = visibleNodes(nodes, 6, { currentNodeId, currentNode })
      if (entries.length === 0) return h('p', { className: 'dsh-shrimp-tank-empty' }, '虾缸尚未返回真实节点')
      return h('div', { className: 'dsh-shrimp-tank-stepper', role: 'list', 'aria-label': '运行节点' }, entries.map((entry, index) => {
        if (entry.ellipsis) return h('span', { key: entry.key, className: 'dsh-shrimp-tank-stepper-ellipsis', 'aria-label': '中间节点已省略' }, '…')
        const node = entry.node
        const running = node.state === 'running'
        const stateText = node.state === 'done' ? '已完成' : running ? `${formatProgress(node.progress) ? `${formatProgress(node.progress)} · ` : ''}运行中` : node.state === 'queued' ? '排队中' : node.state === 'failed' ? '失败' : node.state === 'blocked' ? '已阻断' : statusLabel(node.status)
        return h('div', { key: node.id || index, className: `dsh-shrimp-tank-stepper-item is-${node.state}`, role: 'listitem', 'aria-current': running ? 'step' : undefined, title: node.failure || node.blocked || node.name || stateText },
          h('span', { className: 'dsh-shrimp-tank-stepper-dot', 'aria-hidden': true }),
          h('div', { className: 'dsh-shrimp-tank-stepper-label' }, h('strong', null, node.name || '未命名节点'), h('span', null, stateText)),
        )
      }))
    }

    function RunCard({ group }) {
      const summary = group.summary || normalizeRunPayload(null, group.run)
      const status = normalizeStatus(summary.status || group.run?.status || group.run?.state)
      const failure = group.summaryError ? '' : summary.failure || messageOf(group.run, ['failure_message', 'error_summary', 'error', 'failure_summary', 'failure'])
      const blocked = group.summaryError ? '' : summary.blocked || messageOf(group.run, ['blocked_message', 'blocked_reason', 'blocking_reason', 'blocked'])
      const currentNode = group.summaryError ? '' : summary.currentNode
      return h('article', { className: 'dsh-shrimp-tank-run-summary', 'data-run-status': status, 'data-run-id': runIdOf(group.run) || undefined },
        h('div', { className: 'dsh-shrimp-tank-summary-head' },
          h('span', { className: 'dsh-shrimp-tank-summary-shrimp', role: 'img', 'aria-label': `${group.name} 虾` }, h(ShrimpMark, { color: '#3d83e6' })),
          h('div', { className: 'dsh-shrimp-tank-summary-title' }, h('h3', null, group.name), h('span', { className: `dsh-shrimp-tank-badge is-${status}` }, statusLabel(status))),
          summary.progress != null ? h('strong', { className: 'dsh-shrimp-tank-progress' }, formatProgress(summary.progress)) : null,
        ),
        summary.progress != null ? h('div', { className: 'dsh-shrimp-tank-progress-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(Number(summary.progress)) }, h('span', { style: { width: `${Math.max(0, Math.min(100, Number(summary.progress)))}%` } })) : null,
        currentNode ? h('p', { className: 'dsh-shrimp-tank-current' }, `当前在「${currentNode}」` ) : null,
        failure ? h('p', { className: 'dsh-shrimp-tank-message is-failure', role: 'alert' }, failure) : null,
        blocked ? h('p', { className: 'dsh-shrimp-tank-message is-blocked', role: 'alert' }, blocked) : null,
        h(NodeStepper, { nodes: summary.nodes, currentNodeId: summary.currentNodeId, currentNode: summary.currentNode, unavailable: group.summaryError }),
      )
    }

    function ActiveView({ groups, selectedRef, onSelect }) {
      const selected = groups.find((group) => group.ref === selectedRef) || groups[0]
      return h('section', { className: 'dsh-shrimp-tank-active', 'aria-label': '运行中的虾' },
        groups.length > 1 ? h('div', { className: 'dsh-shrimp-tank-segmented', role: 'tablist', 'aria-label': '运行中的虾' }, groups.map((group) => h('button', {
          key: group.ref,
          type: 'button',
          role: 'tab',
          'aria-selected': group.ref === selected?.ref,
          className: `dsh-shrimp-tank-segment${group.ref === selected?.ref ? ' is-selected' : ''}`,
          onClick: () => onSelect(group.ref),
        }, group.name))) : null,
        selected ? h(RunCard, { group: selected }) : null,
      )
    }

    function TankCard({ sessionId }) {
      const [open, setOpen] = React.useState(false)
      const [state, setState] = React.useState({ phase: 'idle', groups: [], shrimps: [], error: '' })
      const [selectedRef, setSelectedRef] = React.useState('')
      const [reloadKey, setReloadKey] = React.useState(0)
      const dismissedSignatureRef = React.useRef(readDismissedSignature(sessionId))
      const observedSignatureRef = React.useRef('')
      const activeSignatureRef = React.useRef('')
      const dismissNextDiscoveryRef = React.useRef(false)
      const generationRef = React.useRef(0)
      const close = React.useCallback(() => {
        const signature = first(activeSignatureRef.current, observedSignatureRef.current)
        if (signature) {
          const dismissed = mergeRunSignatures(dismissedSignatureRef.current, signature)
          dismissedSignatureRef.current = dismissed
          writeDismissedSignature(sessionId, dismissed)
        } else dismissNextDiscoveryRef.current = true
        // Invalidate an in-flight read synchronously; effect cleanup follows on
        // the next commit, so a late response cannot reopen the dismissed run.
        generationRef.current += 1
        setOpen(false)
      }, [sessionId])
      const forceOpen = React.useCallback(() => {
        generationRef.current += 1
        dismissedSignatureRef.current = ''
        observedSignatureRef.current = ''
        activeSignatureRef.current = ''
        dismissNextDiscoveryRef.current = false
        clearDismissedSignature(sessionId)
        setState({ phase: 'loading', groups: [], shrimps: [], error: '' })
        setSelectedRef('')
        setReloadKey((value) => value + 1)
        setOpen(true)
      }, [sessionId])
      const headerStatus = state.phase === 'ready' ? state.groups.length > 0 ? `${state.groups.length}只运行中` : state.shrimps.length > 0 ? '都在休息' : '还没有已发布的虾' : ''

      React.useEffect(() => {
        dismissedSignatureRef.current = readDismissedSignature(sessionId)
        observedSignatureRef.current = ''
        activeSignatureRef.current = ''
        dismissNextDiscoveryRef.current = false
      }, [sessionId])

      React.useEffect(() => {
        const onOpen = (event) => {
          const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {}
          if (detail.sessionId && text(detail.sessionId) !== text(sessionId)) return
          // Explicit `/虾缸` always wins over a previous close decision.
          forceOpen()
        }
        window.addEventListener(OPEN_EVENT, onOpen)
        return () => window.removeEventListener(OPEN_EVENT, onOpen)
      }, [sessionId, forceOpen])

      React.useEffect(() => {
        const onWorkbenchSwitch = (event) => {
          const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {}
          if (detail.panel === 'plan') close()
        }
        window.addEventListener(COMPOSER_WORKBENCH_EVENT, onWorkbenchSwitch)
        return () => window.removeEventListener(COMPOSER_WORKBENCH_EVENT, onWorkbenchSwitch)
      }, [close])

      React.useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => { if (event.key === 'Escape') { event.preventDefault(); close() } }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [open, close])

      React.useEffect(() => {
        let alive = true
        let timer = null
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        const signal = controller?.signal
        const generation = generationRef.current
        const current = () => alive && generation === generationRef.current
        let inFlight = false
        const discover = async () => {
          // Keep discovery serial and list-only while the card is closed. It
          // observes canonical pipeline/run state without fetching summaries.
          const shrimpValue = await tankApi('/api/v1/dsh/shrimps', { signal })
          const runValue = await tankApi('/api/v1/runs?limit=50', { signal })
          const shrimps = projectPublishedShrimps(unwrapItems(shrimpValue))
          const groups = groupLatestActiveRuns(shrimps, unwrapItems(runValue))
          return { shrimps, groups, signature: activeRunSignature(groups) }
        }
        const read = async () => {
          try {
            const snapshot = await discover()
            if (!current()) return
            const { shrimps, groups, signature } = snapshot
            observedSignatureRef.current = signature
            activeSignatureRef.current = signature
            const withSummaries = []
            // Summary requests are serial: one run's transition cannot leave
            // several overlapping refresh chains behind when the card closes.
            for (const group of groups) {
              if (!current()) return
              const runId = runIdOf(group.run)
              if (!runId) {
                withSummaries.push({ ...group, summary: normalizeRunPayload(null, group.run) })
                continue
              }
              try {
                const summaryValue = await tankApi(`/api/v1/runs/${encodeURIComponent(runId)}/summary`, { signal })
                const summary = normalizeRunPayload(summaryValue, group.run)
                // The summary is newer than the list. Keep a just-finished or
                // failed run visible for this list cycle so its terminal result
                // is not replaced by an unexplained idle animation.
                withSummaries.push({ ...group, summary })
              } catch (error) {
                if (error?.name === 'AbortError') throw error
                withSummaries.push({ ...group, summary: normalizeRunPayload(null, group.run), summaryError: text(error?.message || error) || 'summary 请求失败' })
              }
            }
            if (!current()) return
            // Keep the list signature even when a summary has already reached
            // a terminal state. A stale run list may still report it as active
            // for one poll; closing here must dismiss that exact identity.
            activeSignatureRef.current = activeRunSignature(withSummaries) || signature
            observedSignatureRef.current = signature
            setState({ phase: 'ready', groups: withSummaries, shrimps, error: '' })
            setSelectedRef((current) => withSummaries.some((group) => group.ref === current) ? current : withSummaries[0]?.ref || '')
          } catch (error) {
            if (!current() || error?.name === 'AbortError') return
            setState({ phase: 'error', groups: [], shrimps: [], error: text(error?.message || error) || '虾缸读取失败' })
            activeSignatureRef.current = ''
            setSelectedRef('')
          }
        }
        const discoverWhileClosed = async () => {
          try {
            const snapshot = await discover()
            if (!current()) return
            const { shrimps, groups, signature } = snapshot
            observedSignatureRef.current = signature
            activeSignatureRef.current = signature
            if (dismissNextDiscoveryRef.current) {
              dismissNextDiscoveryRef.current = false
              if (signature) {
                const dismissed = mergeRunSignatures(dismissedSignatureRef.current, signature)
                dismissedSignatureRef.current = dismissed
                writeDismissedSignature(sessionId, dismissed)
              }
              return
            }
            if (shouldAutoOpen(signature, dismissedSignatureRef.current)) {
              setState({ phase: 'loading', groups: [], shrimps, error: '' })
              setSelectedRef('')
              setOpen(true)
            }
          } catch (error) {
            // A closed watcher is intentionally quiet. The explicit card read
            // will show a recoverable error when the user opens it.
            if (!current() || error?.name === 'AbortError') return
          }
        }
        const tick = async () => {
          if (!current() || inFlight) return
          inFlight = true
          timer = null
          try {
            if (open) await read()
            else await discoverWhileClosed()
          } finally {
            inFlight = false
          }
          if (!current()) return
          const delay = open ? FULL_SUMMARY_REFRESH_INTERVAL_MS : autoDiscoveryDelayMs(document.hidden)
          timer = window.setTimeout(() => { void tick() }, delay)
        }
        const onVisibilityChange = () => {
          if (open || !current()) return
          // While a list read is in flight there is no timer to retime; the
          // read's completion schedules exactly one next tick.
          if (inFlight || timer === null) return
          if (timer !== null) window.clearTimeout(timer)
          timer = window.setTimeout(() => { void tick() }, autoDiscoveryDelayMs(document.hidden))
        }
        if (!open) document.addEventListener('visibilitychange', onVisibilityChange)
        void tick()
        return () => {
          alive = false
          if (timer !== null) window.clearTimeout(timer)
          controller?.abort()
          if (!open) document.removeEventListener('visibilitychange', onVisibilityChange)
        }
      }, [open, reloadKey, sessionId])

      if (!open) return null
      const content = state.phase === 'error'
        ? h('div', { className: 'dsh-shrimp-tank-error-wrap' }, h('p', { className: 'dsh-shrimp-tank-error', role: 'alert' }, `虾缸读取失败：${state.error}`), h('button', { type: 'button', className: 'dsh-shrimp-tank-retry', onClick: () => { setState({ phase: 'loading', groups: [], shrimps: [], error: '' }); setReloadKey((value) => value + 1) } }, '重新读取'))
        : state.phase === 'loading'
          ? h('p', { className: 'dsh-shrimp-tank-loading', role: 'status' }, '正在读取运行状态…')
          : state.groups.length > 0
            ? h(ActiveView, { groups: state.groups, selectedRef, onSelect: setSelectedRef })
            : h(IdleView, { shrimps: state.shrimps })
      return h('section', { className: 'dsh-shrimp-tank-card', role: 'region', 'aria-labelledby': 'dsh-shrimp-tank-title' },
        h('header', { className: 'dsh-shrimp-tank-header' }, h('h2', { id: 'dsh-shrimp-tank-title' }, '虾缸'), headerStatus ? h('span', { className: 'dsh-shrimp-tank-header-status' }, headerStatus) : null, h('button', { type: 'button', className: 'dsh-shrimp-tank-close', onClick: close }, '关闭')),
        h('div', { className: 'dsh-shrimp-tank-body' }, content),
      )
    }

    function apply(ctx) {
      const style = document.createElement('style')
      style.id = 'dsh-shrimp-tank-styles'
      style.textContent = `
        .dsh-shrimp-tank-card{box-sizing:border-box;display:flex;flex-direction:column;width:calc(100% - (var(--dsh-composer-side-clearance,16px) * 2));max-width:var(--dsh-composer-card-max-width,780px);max-height:min(48vh,480px);margin:0 auto calc(var(--dsh-composer-stack-gap,6px) * -1);flex:none;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-block-end-color:transparent;border-radius:22px 22px 0 0;background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base)));box-shadow:var(--dsw-shadow-lv2,0 8px 24px rgba(0,0,0,.12));color:var(--dsw-alias-label-primary)}
        [data-composer-seat]:has(.dsh-shrimp-tank-card)>:has(>[data-slot="conversation.input.dock"]>.dsh-shrimp-tank-card){gap:0;--dsh-composer-stack-gap:0px}
        [data-composer-seat]:has(.dsh-shrimp-tank-card) [data-composer-card]{border-radius:0 0 22px 22px}
        .dsh-shrimp-tank-header{box-sizing:border-box;display:flex;align-items:center;flex-wrap:wrap;gap:8px;flex:none;min-height:48px;padding:8px 14px;border-block-end:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}
        .dsh-shrimp-tank-header h2{margin:0;color:var(--dsw-alias-label-primary);font-size:16px;line-height:24px;font-weight:600}
        .dsh-shrimp-tank-header-status{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
        .dsh-shrimp-tank-close{display:inline-flex;align-items:center;justify-content:center;flex:none;min-height:28px;margin-left:auto;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;cursor:pointer}
        .dsh-shrimp-tank-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dsh-shrimp-tank-close:focus-visible,.dsh-shrimp-tank-segment:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#3d83e6);outline-offset:2px}
        .dsh-shrimp-tank-body{box-sizing:border-box;min-height:0;padding:9px 14px 10px;overflow:auto}
        .dsh-shrimp-tank-loading,.dsh-shrimp-tank-error,.dsh-shrimp-tank-idle-hint{margin:4px 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
        .dsh-shrimp-tank-error{color:var(--dsw-alias-state-error-primary,#d84c45)}
        .dsh-shrimp-tank-error-wrap{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.dsh-shrimp-tank-retry{min-height:30px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}.dsh-shrimp-tank-retry:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-shrimp-tank-retry:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#3d83e6);outline-offset:2px}
        .dsh-shrimp-tank-segmented{display:flex;flex-wrap:wrap;gap:5px;min-width:0;margin:0 0 10px}
        .dsh-shrimp-tank-segment{min-width:0;max-width:100%;padding:5px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.07));color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .dsh-shrimp-tank-segment:hover,.dsh-shrimp-tank-segment.is-selected{border-color:var(--dsw-alias-button-info-fill,#3d83e6);background:color-mix(in srgb,var(--dsw-alias-button-info-fill,#3d83e6) 10%,transparent);color:var(--dsw-alias-label-primary)}
        .dsh-shrimp-tank-run-summary{display:flex;flex-direction:column;gap:9px;min-width:0}
        .dsh-shrimp-tank-summary-head{display:flex;align-items:center;gap:9px;min-width:0}
        .dsh-shrimp-tank-summary-shrimp{display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px}.dsh-shrimp-tank-summary-shrimp .dsh-shrimp-tank-idle-mark{width:28px;height:20px}
        .dsh-shrimp-tank-summary-title{display:flex;align-items:center;flex-wrap:wrap;gap:7px;min-width:0;flex:1}.dsh-shrimp-tank-summary-title h3{margin:0;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;font-weight:600}
        .dsh-shrimp-tank-badge{padding:3px 8px;border-radius:999px;font-size:11px;line-height:17px;white-space:nowrap}
        .dsh-shrimp-tank-badge.is-running,.dsh-shrimp-tank-badge.is-processing,.dsh-shrimp-tank-badge.is-trialing,.dsh-shrimp-tank-badge.is-queued{color:#2c9a68;background:#35a56f18}
        .dsh-shrimp-tank-badge.is-failed,.dsh-shrimp-tank-badge.is-blocked{color:#d84c45;background:#d84c4518}
        .dsh-shrimp-tank-badge.is-awaiting_confirmation,.dsh-shrimp-tank-badge.is-awaiting_external,.dsh-shrimp-tank-badge.is-waiting_external,.dsh-shrimp-tank-badge.is-cancel_requested{color:#d99532;background:#d9953218}
        .dsh-shrimp-tank-progress{flex:none;color:#ee785f;font-size:16px;font-variant-numeric:tabular-nums}
        .dsh-shrimp-tank-progress-bar{height:4px;border-radius:999px;background:var(--dsw-alias-border-l3);overflow:hidden}.dsh-shrimp-tank-progress-bar span{display:block;height:100%;border-radius:inherit;background:var(--dsw-alias-state-business-primary,#35a56f);transition:width .2s ease}
        .dsh-shrimp-tank-current{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
        .dsh-shrimp-tank-stepper{box-sizing:border-box;display:flex;align-items:stretch;justify-content:space-between;gap:0;width:100%;min-width:0;margin:2px 0 0;padding:5px 12px 6px;overflow-x:auto;scrollbar-width:thin}
        .dsh-shrimp-tank-stepper-item{box-sizing:border-box;display:flex;flex:0 0 110px;flex-direction:column;gap:4px;min-width:100px;padding:4px 10px 2px;border:1px solid transparent;border-block-start-color:var(--dsw-alias-border-l2);border-radius:0;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--dsw-alias-state-business-primary,#35a56f) 9%,transparent),transparent);background-size:200% 100%;background-repeat:no-repeat}
        .dsh-shrimp-tank-stepper-item:first-child{border-block-start-color:transparent}.dsh-shrimp-tank-stepper-item + .dsh-shrimp-tank-stepper-item{margin-inline-start:-1px}
        .dsh-shrimp-tank-stepper-dot{width:9px;height:9px;flex:none;border:2px solid var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-2));border-radius:50%;background:var(--dsw-alias-label-caption)}
        .dsh-shrimp-tank-stepper-label{display:flex;flex-direction:column;gap:1px;min-width:0}.dsh-shrimp-tank-stepper-label strong{min-width:0;color:var(--dsw-alias-label-primary);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-shrimp-tank-stepper-label span{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px;white-space:nowrap}
        .dsh-shrimp-tank-stepper-item.is-done .dsh-shrimp-tank-stepper-dot{background:#35a56f}.dsh-shrimp-tank-stepper-item.is-running{border-color:var(--dsw-alias-button-info-fill,#3d83e6);border-radius:8px;background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-button-info-fill,#3d83e6) 8%,var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-2))),color-mix(in srgb,var(--dsw-alias-button-info-fill,#3d83e6) 18%,var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-2))),color-mix(in srgb,var(--dsw-alias-button-info-fill,#3d83e6) 8%,var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-2))));background-size:200% 100%;box-shadow:0 0 0 2px rgba(61,131,230,.22),0 5px 14px rgba(61,131,230,.22)}.dsh-shrimp-tank-stepper-item.is-running .dsh-shrimp-tank-stepper-dot{background:var(--dsw-alias-button-info-fill,#3d83e6);box-shadow:0 0 0 4px rgba(61,131,230,.2),0 0 10px rgba(61,131,230,.34)}.dsh-shrimp-tank-stepper-item.is-running .dsh-shrimp-tank-stepper-label strong,.dsh-shrimp-tank-stepper-item.is-running .dsh-shrimp-tank-stepper-label span{color:var(--dsw-alias-button-info-fill,#3d83e6);font-weight:600}.dsh-shrimp-tank-stepper-item.is-queued .dsh-shrimp-tank-stepper-dot{background:var(--dsw-alias-label-caption)}.dsh-shrimp-tank-stepper-item.is-failed .dsh-shrimp-tank-stepper-dot,.dsh-shrimp-tank-stepper-item.is-blocked .dsh-shrimp-tank-stepper-dot{background:#d84c45}.dsh-shrimp-tank-stepper-ellipsis{display:flex;flex:0 0 18px;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:18px}
        .dsh-shrimp-tank-stepper-item.is-running .dsh-shrimp-tank-stepper-dot{animation:dsh-shrimp-stepper-pulse 1.8s ease-in-out infinite}.dsh-shrimp-tank-stepper-item.is-running{animation:dsh-shrimp-stepper-highlight 2s ease-in-out infinite}
        @keyframes dsh-shrimp-stepper-pulse{0%,100%{opacity:.55;transform:scale(.9)}50%{opacity:1;transform:scale(1.18)}}
        @keyframes dsh-shrimp-stepper-highlight{0%,100%{background-position:0 0}50%{background-position:100% 0}}
        .dsh-shrimp-tank-empty,.dsh-shrimp-tank-node-unavailable{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}.dsh-shrimp-tank-node-unavailable{color:#d99532}
        .dsh-shrimp-tank-message{margin:0;padding:6px 9px;border-radius:8px;background:var(--dsw-alias-bg-base,rgba(128,128,128,.06));font-size:11px;line-height:17px;overflow-wrap:anywhere}
        .dsh-shrimp-tank-pond{min-height:92px;padding:13px;border:1px solid color-mix(in srgb,#6f9d9a 22%,var(--dsw-alias-border-l2));border-radius:18px;background:radial-gradient(circle at 18% 20%,color-mix(in srgb,#6f9d9a 12%,transparent),transparent 30%),linear-gradient(145deg,color-mix(in srgb,#6f9d9a 6%,transparent),color-mix(in srgb,#8f86ad 5%,transparent));box-shadow:inset 0 1px 0 rgba(255,255,255,.07);overflow:hidden}
        .dsh-shrimp-tank-idle-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:0;padding:0;list-style:none}
        .dsh-shrimp-tank-idle-card{box-sizing:border-box;display:flex;align-items:center;gap:9px;min-width:0;min-height:92px;padding:11px;border:1px solid color-mix(in srgb,var(--idle-color) 30%,var(--dsw-alias-border-l2));border-radius:15px;background:color-mix(in srgb,var(--idle-color) 9%,var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-2)));color:var(--dsw-alias-label-primary);transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease}
        .dsh-shrimp-tank-idle-card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--idle-color) 58%,var(--dsw-alias-border-l2));box-shadow:0 5px 14px color-mix(in srgb,var(--idle-color) 18%,transparent)}
        .dsh-shrimp-tank-idle-card-mark{display:inline-flex;align-items:center;justify-content:center;flex:none;width:42px;height:42px;border-radius:12px;background:color-mix(in srgb,var(--idle-color) 14%,transparent)}
        .dsh-shrimp-tank-idle-mark{display:block;width:34px;height:25px;overflow:visible}
        .dsh-shrimp-tank-idle-card-copy{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0}.dsh-shrimp-tank-idle-card-copy strong{min-width:0;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:13px;line-height:19px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}.dsh-shrimp-tank-idle-card-copy span{min-width:0;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;text-overflow:ellipsis;white-space:nowrap}
        .dsh-shrimp-tank-idle-card-state{align-self:flex-start;flex:none;padding:2px 6px;border:1px solid color-mix(in srgb,var(--idle-color) 34%,transparent);border-radius:6px;color:color-mix(in srgb,var(--idle-color) 78%,var(--dsw-alias-label-primary));font-size:10px;line-height:15px;white-space:nowrap}
        @media(max-width:680px){.dsh-shrimp-tank-idle-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
        @media(max-width:440px){.dsh-shrimp-tank-idle-grid{grid-template-columns:1fr}}
        @media(max-width:760px){.dsh-shrimp-tank-header{padding:8px 11px}.dsh-shrimp-tank-body{padding:9px 11px 11px}.dsh-shrimp-tank-stepper-item{flex-basis:104px;min-width:100px}.dsh-shrimp-tank-pond{padding:10px}.dsh-shrimp-tank-idle-card{min-height:88px;padding:10px}}
        @media(prefers-reduced-motion:reduce){.dsh-shrimp-tank-stepper-item,.dsh-shrimp-tank-stepper-item.is-running .dsh-shrimp-tank-stepper-dot{animation:none!important;transform:none!important}.dsh-shrimp-tank-progress-bar span{transition:none!important}.dsh-shrimp-tank-idle-card{transition:none!important}.dsh-shrimp-tank-idle-card:hover{transform:none!important}}
      `
      document.getElementById(style.id)?.remove()
      document.head.appendChild(style)
      ctx.effect(() => () => style.remove(), 'dsh-shrimp-run-status: styles')

      const commandUi = ctx.commandUi || (typeof ctx.get === 'function' ? ctx.get('commandUi') : null)
      ctx.effect(() => commandUi.register({
        name: '虾缸',
        description: '打开虾缸运行状态',
        available: () => true,
        ui: {
          kind: 'action',
          run: (session) => dispatchOpen(session?.sessionId),
        },
      }), 'dsh-shrimp-run-status: command contribution')
      ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
        { name: 'conversation.input.dock', id: 'dsh-shrimp-run-status', order: 10, label: '虾缸' },
        TankCard,
      )), 'dsh-shrimp-run-status: input dock')
    }

    exports.apply = apply
    exports.inject = inject
    exports.normalizeRunPayload = normalizeRunPayload
    exports.visibleNodes = visibleNodes
    exports.groupLatestActiveRuns = groupLatestActiveRuns
    exports.isActiveStatus = isActiveStatus
    exports.canonicalName = canonicalName
    exports.activeRunSignature = activeRunSignature
    exports.mergeRunSignatures = mergeRunSignatures
    exports.autoDiscoveryDelayMs = autoDiscoveryDelayMs
    exports.shouldAutoOpen = shouldAutoOpen
    return module.exports
  },
})
