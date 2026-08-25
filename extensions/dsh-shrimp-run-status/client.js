// @local/dsh-shrimp-run-status — session run-status rail.
// It reads durable tool evidence and a fixed read-only heartbeat checkpoint;
// it never infers a run from user prose.
window.__ModuleLoader__.load({
  id: '@local/dsh-shrimp-run-status',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const inject = ['slots']
    const TERMINAL = new Set(['done', 'completed', 'succeeded', 'success', 'failed', 'error', 'blocked', 'cancelled', 'canceled', 'stopped', 'interrupted', 'aborted'])
    const ALIASES = new Map([
      ['done', 'completed'], ['succeeded', 'completed'], ['success', 'completed'], ['complete', 'completed'],
      ['error', 'failed'], ['failure', 'failed'], ['canceled', 'cancelled'], ['aborted', 'cancelled'], ['stopped', 'cancelled'],
      ['processing', 'running'], ['in_progress', 'running'], ['in-progress', 'running'],
      ['waiting_approval', 'approval_needed'], ['approval', 'approval_needed'],
    ])
    const text = (value) => value == null ? '' : typeof value === 'string' ? value : String(value)
    const unwrap = (value) => {
      let current = value
      for (let index = 0; index < 4; index += 1) {
        if (!current || typeof current !== 'object' || Array.isArray(current) || current.schema !== 'api_envelope.v1') break
        current = current.data
      }
      return current
    }
    const parseJson = (value) => {
      if (value && typeof value === 'object') return value
      const raw = text(value).trim()
      if (!raw) return null
      try { return JSON.parse(raw) } catch {
        const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
        if (!fenced) return null
        try { return JSON.parse(fenced[1]) } catch { return null }
      }
    }
    const contentText = (value) => {
      if (typeof value === 'string') return value
      if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n')
      if (!value || typeof value !== 'object') return ''
      return text(value.text || value.content || value.value || '')
    }
    function visit(value, seen, depth, callback) {
      if (depth > 7 || value == null) return null
      if (typeof value !== 'object') return callback(value)
      if (seen.has(value)) return null
      seen.add(value)
      const direct = callback(value)
      if (direct) return direct
      if (Array.isArray(value)) {
        for (const item of value) { const found = visit(item, seen, depth + 1, callback); if (found) return found }
        return null
      }
      for (const [key, item] of Object.entries(value)) {
        if (!['data', 'value', 'result', 'response', 'operation', 'resource_refs', 'resources', 'run'].includes(key)) continue
        const found = visit(item, seen, depth + 1, callback)
        if (found) return found
      }
      return null
    }
    const runReference = (value) => visit(unwrap(value), new Set(), 0, (item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const direct = item.run_id || item.runId
      if (direct) return String(direct)
      if (Array.isArray(item.resource_refs)) {
        const ref = item.resource_refs.find((candidate) => candidate && (candidate.type === 'run' || candidate.kind === 'run') && (candidate.id || candidate.run_id || candidate.runId))
        if (ref) return String(ref.id || ref.run_id || ref.runId)
      }
      if (item.operation && typeof item.operation === 'object' && item.operation.aggregate_id) return String(item.operation.aggregate_id)
      return null
    }) || ''
    const normalizeStatus = (value) => {
      const raw = text(value).trim().toLowerCase().replace(/\s+/g, '_')
      return ALIASES.get(raw) || raw || 'unknown'
    }
    const terminal = (value) => {
      const raw = text(value).trim().toLowerCase().replace(/\s+/g, '_')
      return TERMINAL.has(raw) || TERMINAL.has(ALIASES.get(raw) || '')
    }
    const progress = (value) => {
      const number = Number(value?.progress_percent ?? value?.progressPercent ?? value?.progress ?? value?.percent)
      return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null
    }
    const parseResult = (node) => {
      const plain = contentText(node?.content)
      const parsed = parseJson(plain) || parseJson(node?.meta) || parseJson(node?.result)
      return {
        runId: runReference(parsed || { content: node?.content, meta: node?.meta, result: node?.result }),
        isError: Boolean(node?.isError || node?.error),
        error: text([node?.error?.code, node?.error?.message].filter(Boolean).join('：') || (node?.isError ? plain : '')).slice(0, 500),
      }
    }
    const domainOf = (value, slug = '') => {
      const source = [value?.domain, value?.shrimp_domain, value?.pipelineSlug, value?.pipeline_slug, value?.name, value?.display_name, slug].filter(Boolean).join(' ').toLowerCase()
      if (/(xiaohongshu|xhs|小红书)/i.test(source)) return 'xiaohongshu'
      if (/(enterprise[-_ ]?health|enterprise[-_ ]?report|企业健康|企康|平安健康)/i.test(source)) return 'enterprise-health'
      if (/(article|wechat|公众号|文章|虾六答)/i.test(source)) return 'article'
      return 'generic'
    }
    const heartbeatCommand = (value) => {
      const parsed = parseJson(value)
      const command = text(parsed?.command ?? value)
      return /(?:^|[\n;&])\s*(?:nohup\s+)?(?:arch\s+-arm64\s+)?(?:\/\S*\/)?python(?:3(?:\.\d+)?)?\s+(?:\S*\/)?scripts\/heartbeat_gzh_publish\.py(?:\s|>|&|$)/m.test(command)
    }
    function latestRun(snapshot) {
      const map = new Map()
      const add = (call, fallback, source) => {
        if (!call || String(call.name || '').trim() !== 'shrimp_run') return
        const args = parseJson(call.argsRaw) || call.args || {}
        const id = text(call.callId || call.id || `${source}-${fallback}`)
        const previous = map.get(id) || {}
        map.set(id, { ...previous, callId: id, seq: Number(call.seq ?? fallback ?? previous.seq ?? 0), time: Number(call.time ?? previous.time ?? 0), pipelineSlug: text(args?.pipelineSlug || args?.pipeline_slug || args?.slug), args, source })
      }
      const addHeartbeat = (call, fallback, source) => {
        if (!call || String(call.name || '').trim() !== 'bash') return
        const args = parseJson(call.argsRaw) || call.args || {}
        if (!heartbeatCommand(args)) return
        const id = text(call.callId || call.id || `${source}-${fallback}`)
        const previous = map.get(id) || {}
        map.set(id, { ...previous, callId: id, seq: Number(call.seq ?? fallback ?? previous.seq ?? 0), time: Number(call.time ?? previous.time ?? 0), pipelineSlug: 'shrimp-c433b57dac59419d', args, runner: 'gzh-multi-article', sourceType: 'heartbeat', source })
      }
      ;(Array.isArray(snapshot?.runningCalls) ? snapshot.runningCalls : []).forEach((call, index) => add(call, call?.seq ?? call?.time ?? index, 'call'))
      ;(Array.isArray(snapshot?.runningCalls) ? snapshot.runningCalls : []).forEach((call, index) => addHeartbeat(call, call?.seq ?? call?.time ?? index, 'heartbeat-call'))
      ;(Array.isArray(snapshot?.nodes) ? snapshot.nodes : []).forEach((node, index) => {
        if (node?.kind !== 'tool-result') return
        if (String(node.call?.name || '') === 'bash') {
          const heartbeatCallId = node.callId || node.call?.callId
          addHeartbeat({ ...node.call, ...(heartbeatCallId ? { callId: heartbeatCallId } : {}), seq: node.seq, time: node.callTime || node.time }, node.seq ?? index, 'heartbeat-result')
          const heartbeatId = text(heartbeatCallId || `heartbeat-result-${node.seq ?? index}`)
          const heartbeat = map.get(heartbeatId)
          if (heartbeat) map.set(heartbeatId, { ...heartbeat, callId: heartbeatId, seq: Number(node.seq ?? heartbeat.seq), time: Number(node.time ?? heartbeat.time), pid: /\bPID\s*=\s*(\d+)\b/.exec(contentText(node.content))?.[1] || '', source: 'heartbeat-result' })
          return
        }
        if (String(node.call?.name || '') !== 'shrimp_run') return
        const resultCallId = node.callId || node.call?.callId
        add({ ...node.call, ...(resultCallId ? { callId: resultCallId } : {}), seq: node.seq, time: node.callTime || node.time }, node.seq ?? index, 'result')
        const id = text(resultCallId || `result-${node.seq ?? index}`)
        const previous = map.get(id)
        if (!previous) return
        const result = parseResult(node)
        map.set(id, { ...previous, callId: id, seq: Number(node.seq ?? previous.seq), time: Number(node.time ?? previous.time), result, runId: result.runId, isError: result.isError, error: result.error, source: 'result' })
      })
      const entries = [...map.values()].sort((left, right) => (left.seq - right.seq) || (left.time - right.time))
      const candidate = entries.at(-1)
      if (!candidate) return null
      return { ...candidate, approvalPending: Array.isArray(snapshot?.pending) && snapshot.pending.some((item) => item?.kind === 'approval'), domain: candidate.sourceType === 'heartbeat' ? 'article' : domainOf(candidate, candidate.pipelineSlug) }
    }
    const normalizeNode = (node, index) => {
      const status = normalizeStatus(node?.status || node?.state || node?.lifecycle_status)
      const state = status === 'completed' ? 'done' : status === 'failed' || status === 'blocked' ? 'failed' : status === 'cancelled' ? 'blocked' : status === 'running' || status === 'queued' || status === 'pending' || status === 'approval_needed' ? status : 'pending'
      return { id: text(node?.node_id || node?.id || node?.key || `node-${index + 1}`), name: text(node?.node_name || node?.display_name || node?.name || node?.title || node?.node_id || `节点 ${index + 1}`), state, status, progress: progress(node), failure: text(node?.error_summary || node?.error || node?.failure_summary || '').slice(0, 500), order: Number(node?.order_index ?? node?.order ?? index) }
    }
    const normalizePayload = (summaryValue, statusValue) => {
      const summaryRoot = unwrap(summaryValue)
      const statusRoot = unwrap(statusValue)
      const summary = summaryRoot?.summary && typeof summaryRoot.summary === 'object' ? { ...summaryRoot, ...summaryRoot.summary } : summaryRoot
      const status = statusRoot?.status && typeof statusRoot.status === 'object' ? { ...statusRoot, ...statusRoot.status } : statusRoot
      const merged = { ...(summary && typeof summary === 'object' ? summary : {}), ...(status && typeof status === 'object' ? status : {}) }
      const source = Array.isArray(merged.nodes) ? merged.nodes : Array.isArray(merged.node_states) ? merged.node_states : Array.isArray(merged.steps) ? merged.steps : []
      const nodes = source.map(normalizeNode).sort((a, b) => a.order - b.order)
      const value = progress(merged)
      const statusName = normalizeStatus(merged.status || merged.state || merged.lifecycle_status)
      return { status: statusName, terminal: terminal(statusName), progress: value == null && nodes.length ? Math.round(nodes.reduce((sum, node) => sum + (node.progress ?? (node.state === 'done' ? 100 : 0)), 0) / nodes.length) : value, nodes, name: text(merged.display_name || merged.pipeline_name || merged.name || merged.title || merged.shrimp_name || ''), domain: text(merged.domain || merged.shrimp_domain || merged.kind || ''), startedAt: text(merged.started_at || merged.startedAt || merged.created_at || ''), updatedAt: text(merged.updated_at || merged.updatedAt || merged.finished_at || merged.completed_at || ''), failure: text(merged.error_summary || merged.error || merged.failure_summary || '').slice(0, 500), raw: merged }
    }
    const displayNodes = (nodes) => {
      const source = Array.isArray(nodes) ? nodes : []
      if (source.length <= 6) return source.map((node) => ({ node }))
      const indexes = [...new Set([0, 1, 2, 3, source.length - 2, source.length - 1])].sort((a, b) => a - b)
      const output = []; let previous = -1
      for (const index of indexes) { if (previous >= 0 && index - previous > 1) output.push({ ellipsis: true, key: `ellipsis-${previous}-${index}` }); output.push({ node: source[index] }); previous = index }
      return output
    }
    const storageKey = (sessionId, runId) => `dsh-shrimp-run-status:dismissed:${text(sessionId)}:${text(runId)}`
    const readDismissed = (key) => { try { return Boolean(key && window.localStorage.getItem(key) === '1') } catch { return false } }
    const saveDismissed = (key) => { try { if (key) window.localStorage.setItem(key, '1') } catch {} }
    const fetchApi = async (path) => {
      const query = new URLSearchParams({ path })
      const response = await fetch(`/api/shrimp/tank?${query.toString()}`, { cache: 'no-store', headers: { Accept: 'application/json' } })
      const value = await response.json().catch(() => null)
      if (!response.ok) throw new Error(text(value?.error || value?.message || `虾缸请求失败（${response.status}）`))
      return unwrap(value)
    }
    const fetchHeartbeatRuntime = async () => {
      const response = await fetch('/api/dsh-shrimp-run-status/heartbeat', { cache: 'no-store', headers: { Accept: 'application/json' } })
      const value = await response.json().catch(() => null)
      if (!response.ok || value?.ok !== true) throw new Error(text(value?.error || `运行状态请求失败（${response.status}）`))
      return value
    }
    const statusText = { completed: '已完成', running: '运行中', queued: '排队中', pending: '待运行', approval_needed: '等待确认', failed: '失败', blocked: '已阻断', cancelled: '已取消', unknown: '启动中', offline: '虾缸离线' }
    const stateColor = { done: '#35a56f', running: '#3d83e6', queued: '#3d83e6', pending: '#858c96', approval_needed: '#d99532', failed: '#d84c45', blocked: '#d84c45' }
    const finalState = (status) => status === 'completed' ? 'done' : status === 'failed' ? 'failed' : status === 'cancelled' ? 'blocked' : status === 'blocked' ? 'failed' : status

    function RunStatus({ sessionId, useSession }) {
      const snapshot = useSession((value) => value)
      const candidate = latestRun(snapshot)
      const identity = candidate ? `${sessionId}:${candidate.runId || candidate.callId || candidate.seq}` : ''
      const [remote, setRemote] = React.useState(null)
      const [error, setError] = React.useState('')
      const [dismissed, setDismissed] = React.useState(false)
      React.useEffect(() => {
        setRemote(null); setError('')
        const dismissalId = candidate?.runId || candidate?.callId
        setDismissed(Boolean(dismissalId && readDismissed(storageKey(sessionId, dismissalId))))
      }, [identity, sessionId, candidate?.runId, candidate?.callId])
      React.useEffect(() => {
        const runId = candidate?.runId
        if ((!runId && candidate?.sourceType !== 'heartbeat') || dismissed) return undefined
        let alive = true
        let timer = null
        const read = async () => {
          let heartbeat = null
          let activeRunId = runId
          if (candidate?.sourceType === 'heartbeat') {
            try { heartbeat = await fetchHeartbeatRuntime(); activeRunId = text(heartbeat.currentRunId) } catch (cause) {
              if (alive) setError(text(cause?.message || cause)); return
            }
          }
          const paths = activeRunId
            ? [`/api/v1/runs/${encodeURIComponent(activeRunId)}/summary`, `/api/v1/runs/${encodeURIComponent(activeRunId)}/status`]
            : heartbeat?.pipelineSlug ? [`/api/v1/pipelines/${encodeURIComponent(heartbeat.pipelineSlug)}/summary`] : []
          const results = await Promise.allSettled(paths.map(fetchApi))
          if (!alive) return
          const summary = results[0]?.status === 'fulfilled' ? results[0].value : null
          const status = results[1]?.status === 'fulfilled' ? results[1].value : null
          if (!summary && !status && !heartbeat?.exists) { setError('虾缸当前不可用，运行节点会在恢复后重试。'); return }
          setError('')
          const canonical = normalizePayload(summary, status)
          const next = heartbeat ? {
            ...canonical,
            runId: activeRunId,
            status: heartbeat.status || canonical.status,
            terminal: Boolean(heartbeat.terminal),
            progress: activeRunId ? canonical.progress : 0,
            name: `${heartbeat.taskName || '虾六答'}${heartbeat.currentOut ? ` · ${heartbeat.currentOut}` : ''}`,
            domain: 'article',
            startedAt: heartbeat.createdAt || canonical.startedAt,
            updatedAt: heartbeat.updatedAt || canonical.updatedAt,
            failure: canonical.failure,
            heartbeat,
          } : canonical
          setRemote(next)
          if (next.terminal && timer) clearInterval(timer)
        }
        void read()
        timer = setInterval(() => { void read() }, 3000)
        return () => { alive = false; if (timer) clearInterval(timer) }
      }, [candidate?.runId, candidate?.sourceType, candidate?.callId, dismissed])
      if (!candidate || dismissed) return null
      const run = remote || { status: candidate.approvalPending ? 'approval_needed' : candidate.isError ? 'failed' : 'unknown', terminal: Boolean(candidate.isError), progress: null, nodes: [], name: '', domain: '', startedAt: '', updatedAt: '', failure: candidate.error || '' }
      const kind = domainOf(run, candidate.pipelineSlug)
      const status = normalizeStatus(error && !run.terminal ? 'offline' : run.status)
      const terminalState = run.terminal || terminal(status)
      const name = run.name || candidate.pipelineSlug || '虾运行'
      const runId = candidate.runId || run.runId || ''
      const dismissalId = runId || candidate.callId
      const close = () => { if (!terminalState || !dismissalId) return; saveDismissed(storageKey(sessionId, dismissalId)); setDismissed(true) }
      const openDetail = () => {
        if (!candidate.pipelineSlug) return
        window.dispatchEvent(new CustomEvent('shrimp:request-library', { detail: { ref: candidate.pipelineSlug, shrimpRef: candidate.pipelineSlug, shrimpDomain: kind, identity: 'pipeline', runId: runId || undefined } }))
      }
      const nodes = displayNodes(run.nodes)
      const failure = run.failure || candidate.error || error
      return h('section', { className: 'dsh-shrimp-run-status', 'data-shrimp-kind': kind, 'data-run-status': status, 'data-run-id': runId || undefined, 'aria-label': '虾运行节点', onClick: openDetail },
        h('header', { className: 'dsh-shrimp-run-status-head' }, h('div', { className: 'dsh-shrimp-run-status-title' }, h('strong', null, '运行节点'), h('span', null, nodes.length ? `${run.nodes.length} 个节点` : '等待节点'), h('span', { className: `dsh-shrimp-run-status-badge is-${finalState(status)}` }, statusText[status] || status)), run.progress != null ? h('span', { className: 'dsh-shrimp-run-status-progress' }, `${Number(run.progress).toFixed(1)}%`) : null, terminalState && dismissalId ? h('button', { type: 'button', className: 'dsh-shrimp-run-status-close', 'aria-label': '关闭运行节点', onClick: (event) => { event.stopPropagation(); close() } }, '×') : null),
        h('div', { className: 'dsh-shrimp-run-status-meta' }, h('span', null, name), runId ? h('code', null, runId) : null, run.startedAt ? h('time', null, new Date(run.startedAt).toLocaleString('zh-CN')) : null),
        nodes.length ? h('div', { className: 'dsh-shrimp-run-status-track', role: 'list' }, nodes.map((entry, index) => entry.ellipsis ? h('span', { className: 'dsh-shrimp-run-status-ellipsis', key: entry.key, 'aria-label': '中间节点已省略' }, '…') : h('button', { type: 'button', role: 'listitem', key: entry.node.id || index, className: `dsh-shrimp-run-status-node is-${entry.node.state}`, title: `${entry.node.name} · ${entry.node.failure || statusText[entry.node.state] || entry.node.state}`, onClick: (event) => { event.stopPropagation(); openDetail() } }, h('span', { className: 'dsh-shrimp-run-status-dot', 'aria-hidden': true }), h('span', { className: 'dsh-shrimp-run-status-node-name' }, entry.node.name), h('span', { className: 'dsh-shrimp-run-status-node-state' }, entry.node.state === 'done' ? '已完成' : entry.node.state === 'running' ? `${Math.round(Number(entry.node.progress || 0))}%` : entry.node.state === 'failed' || entry.node.state === 'blocked' ? '已阻断' : entry.node.state === 'approval_needed' ? '等确认' : '待运行')))) : h('div', { className: 'dsh-shrimp-run-status-empty' }, '已识别运行请求，等待虾缸返回真实节点…'),
        failure ? h('p', { className: 'dsh-shrimp-run-status-failure', role: status === 'offline' ? 'status' : 'alert' }, failure) : null)
    }

    function apply(ctx) {
      const style = document.createElement('style')
      style.id = 'dsh-shrimp-run-status-styles'
      style.textContent = `
        .dsh-shrimp-run-status{box-sizing:border-box;display:flex;flex-direction:column;gap:8px;flex:none;min-width:0;margin:8px 16px 2px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:14px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.08));color:var(--dsw-alias-label-primary);cursor:pointer;overflow:hidden}.dsh-shrimp-run-status-head{display:flex;align-items:center;gap:8px;min-width:0}.dsh-shrimp-run-status-title{display:flex;align-items:center;gap:8px;min-width:0;flex:1}.dsh-shrimp-run-status-title strong{font-size:15px}.dsh-shrimp-run-status-title>span:not(.dsh-shrimp-run-status-badge){color:var(--dsw-alias-label-tertiary);font-size:12px}.dsh-shrimp-run-status-badge{padding:2px 7px;border-radius:999px;font-size:11px;white-space:nowrap}.dsh-shrimp-run-status-badge.is-done{color:#35a56f;background:#35a56f18}.dsh-shrimp-run-status-badge.is-running,.dsh-shrimp-run-status-badge.is-queued{color:#3d83e6;background:#3d83e618}.dsh-shrimp-run-status-badge.is-failed,.dsh-shrimp-run-status-badge.is-blocked{color:#d84c45;background:#d84c4518}.dsh-shrimp-run-status-badge.is-pending,.dsh-shrimp-run-status-badge.is-approval_needed{color:#d99532;background:#d9953218}.dsh-shrimp-run-status-progress{color:#ee785f;font-size:14px;font-variant-numeric:tabular-nums}.dsh-shrimp-run-status-close{display:grid;place-items:center;width:24px;height:24px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:18px;cursor:pointer}.dsh-shrimp-run-status-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dsh-shrimp-run-status-meta{display:flex;align-items:center;gap:8px;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:11px}.dsh-shrimp-run-status-meta span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-shrimp-run-status-meta code{padding:1px 5px;border-radius:5px;background:var(--dsw-alias-bg-base);font-size:10px}.dsh-shrimp-run-status-meta time{margin-left:auto;white-space:nowrap}.dsh-shrimp-run-status-track{display:flex;align-items:stretch;gap:7px;min-width:0;overflow-x:auto;padding:2px 1px 4px;scrollbar-width:thin}.dsh-shrimp-run-status-node{display:flex;flex:1 1 0;flex-direction:column;align-items:flex-start;gap:4px;min-width:116px;max-width:210px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base,rgba(128,128,128,.07));color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left}.dsh-shrimp-run-status-node:hover{border-color:var(--dsw-alias-label-secondary)}.dsh-shrimp-run-status-node-name{width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600}.dsh-shrimp-run-status-node-state{font-size:10px;color:var(--dsw-alias-label-tertiary)}.dsh-shrimp-run-status-dot{width:9px;height:9px;flex:none;border-radius:50%;background:#858c96}.dsh-shrimp-run-status-node.is-done{border-color:#35a56f66;background:#35a56f0d}.dsh-shrimp-run-status-node.is-done .dsh-shrimp-run-status-dot{background:#35a56f}.dsh-shrimp-run-status-node.is-running,.dsh-shrimp-run-status-node.is-queued{border-color:#3d83e666;background:#3d83e60d}.dsh-shrimp-run-status-node.is-running .dsh-shrimp-run-status-dot,.dsh-shrimp-run-status-node.is-queued .dsh-shrimp-run-status-dot{background:#3d83e6;box-shadow:0 0 0 3px #3d83e622}.dsh-shrimp-run-status-node.is-failed,.dsh-shrimp-run-status-node.is-blocked{border-color:#d84c4566;background:#d84c450d}.dsh-shrimp-run-status-node.is-failed .dsh-shrimp-run-status-dot,.dsh-shrimp-run-status-node.is-blocked .dsh-shrimp-run-status-dot{background:#d84c45}.dsh-shrimp-run-status-ellipsis{display:grid;place-items:center;min-width:24px;color:var(--dsw-alias-label-tertiary);font-size:22px}.dsh-shrimp-run-status-empty{padding:7px 0;color:var(--dsw-alias-label-tertiary);font-size:11px}.dsh-shrimp-run-status-failure{margin:0;padding-top:2px;color:#d84c45;font-size:11px;line-height:17px}.dsh-shrimp-run-status[data-run-status=offline]{border-color:#d9953266}.dsh-shrimp-run-status[data-run-status=offline] .dsh-shrimp-run-status-badge{color:#d99532;background:#d9953218}@media(max-width:760px){.dsh-shrimp-run-status{margin:7px 8px 2px;padding:10px}.dsh-shrimp-run-status-track{margin-right:-3px}.dsh-shrimp-run-status-node{flex:0 0 132px}.dsh-shrimp-run-status-meta time{display:none}}@media(prefers-reduced-motion:reduce){.dsh-shrimp-run-status *{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
      `
      document.getElementById(style.id)?.remove()
      document.head.appendChild(style)
      ctx.effect(() => () => style.remove(), 'dsh-shrimp-run-status: styles')
      ctx.effect(() => ctx.slots.inject('conversation.session.run-status', () => ctx.slots.register({ name: 'conversation.session.run-status', id: 'dsh-shrimp-run-status', order: 0, label: '运行节点' }, RunStatus)), 'dsh-shrimp-run-status: session slot')
    }

    exports.apply = apply
    exports.inject = inject
    exports.latestRun = latestRun
    exports.normalizePayload = normalizePayload
    return module.exports
  },
})
