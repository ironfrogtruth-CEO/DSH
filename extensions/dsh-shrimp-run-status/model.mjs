const TERMINAL_STATUSES = new Set([
  'done', 'completed', 'succeeded', 'success', 'failed', 'error', 'blocked',
  'cancelled', 'canceled', 'stopped', 'interrupted', 'aborted',
])

const STATUS_ALIASES = new Map([
  ['done', 'completed'], ['succeeded', 'completed'], ['success', 'completed'],
  ['complete', 'completed'], ['error', 'failed'], ['failure', 'failed'],
  ['canceled', 'cancelled'], ['aborted', 'cancelled'], ['stopped', 'cancelled'],
  ['processing', 'running'], ['in_progress', 'running'], ['in-progress', 'running'],
  ['waiting_approval', 'approval_needed'], ['approval', 'approval_needed'],
])

const textOf = (value) => value == null ? '' : typeof value === 'string' ? value : String(value)

export function unwrapEnvelope(value) {
  let current = value
  for (let i = 0; i < 4; i += 1) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || current.schema !== 'api_envelope.v1') break
    current = current.data
  }
  return current
}

export function parseJson(value) {
  if (value && typeof value === 'object') return value
  const raw = textOf(value).trim()
  if (!raw) return null
  try { return JSON.parse(raw) } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    if (!fenced) return null
    try { return JSON.parse(fenced[1]) } catch { return null }
  }
}

export function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join('\n')
  if (!content || typeof content !== 'object') return ''
  return textOf(content.text || content.content || content.value || '')
}

function visit(value, seen, depth, callback) {
  if (depth > 7 || value == null) return null
  if (typeof value !== 'object') return callback(value)
  if (seen.has(value)) return null
  seen.add(value)
  const direct = callback(value)
  if (direct) return direct
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = visit(item, seen, depth + 1, callback)
      if (found) return found
    }
    return null
  }
  for (const [key, item] of Object.entries(value)) {
    if (!['data', 'value', 'result', 'response', 'operation', 'resource_refs', 'resources', 'run'].includes(key)) continue
    const found = visit(item, seen, depth + 1, callback)
    if (found) return found
  }
  return null
}

export function extractRunReference(value) {
  const root = unwrapEnvelope(value)
  return visit(root, new Set(), 0, (item) => {
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
}

export function parseRunResult(node) {
  const payload = {
    content: node?.content,
    meta: node?.meta,
    result: node?.result,
    error: node?.error,
  }
  const text = contentText(node?.content)
  const parsed = parseJson(text) || parseJson(node?.meta) || parseJson(node?.result)
  const runId = extractRunReference(parsed || payload)
  return {
    runId,
    payload: parsed || payload,
    isError: Boolean(node?.isError || node?.error),
    errorSummary: textOf([node?.error?.code, node?.error?.message].filter(Boolean).join('：') || (node?.isError ? text : '')).slice(0, 500),
  }
}

export function normalizeStatus(value) {
  const raw = textOf(value).trim().toLowerCase().replace(/\s+/g, '_')
  return STATUS_ALIASES.get(raw) || raw || 'unknown'
}

export function isTerminalStatus(value) {
  const raw = textOf(value).trim().toLowerCase().replace(/\s+/g, '_')
  return TERMINAL_STATUSES.has(raw) || TERMINAL_STATUSES.has(STATUS_ALIASES.get(raw) || '')
}

export function progressOf(value) {
  const number = Number(value?.progress_percent ?? value?.progressPercent ?? value?.progress ?? value?.percent)
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null
}

export function normalizeNode(node, index = 0) {
  const status = normalizeStatus(node?.status || node?.state || node?.lifecycle_status)
  const state = status === 'completed' ? 'done' : status === 'failed' || status === 'blocked' ? 'failed' : status === 'cancelled' ? 'blocked' : status === 'running' || status === 'queued' || status === 'pending' || status === 'approval_needed' ? status : 'pending'
  return {
    id: textOf(node?.node_id || node?.id || node?.key || `node-${index + 1}`),
    name: textOf(node?.node_name || node?.display_name || node?.name || node?.title || node?.node_id || `节点 ${index + 1}`),
    status,
    state,
    progress: progressOf(node),
    failure: textOf(node?.error_summary || node?.error || node?.failure_summary || '').slice(0, 500),
    order: Number(node?.order_index ?? node?.order ?? index),
  }
}

export function normalizeRunPayload(summaryValue, statusValue) {
  const summaryRoot = unwrapEnvelope(summaryValue)
  const statusRoot = unwrapEnvelope(statusValue)
  const summary = summaryRoot?.summary && typeof summaryRoot.summary === 'object' ? { ...summaryRoot, ...summaryRoot.summary } : summaryRoot
  const status = statusRoot?.status && typeof statusRoot.status === 'object' ? { ...statusRoot, ...statusRoot.status } : statusRoot
  const merged = { ...(summary && typeof summary === 'object' ? summary : {}), ...(status && typeof status === 'object' ? status : {}) }
  const nodesSource = Array.isArray(merged.nodes) ? merged.nodes : Array.isArray(merged.node_states) ? merged.node_states : Array.isArray(merged.steps) ? merged.steps : []
  const nodes = nodesSource.map(normalizeNode).sort((a, b) => a.order - b.order)
  const progress = progressOf(merged)
  const statusName = normalizeStatus(merged.status || merged.state || merged.lifecycle_status)
  return {
    status: statusName,
    terminal: isTerminalStatus(statusName),
    progress: progress == null && nodes.length ? Math.round(nodes.reduce((sum, node) => sum + (node.progress ?? (node.state === 'done' ? 100 : 0)), 0) / nodes.length) : progress,
    nodes,
    name: textOf(merged.display_name || merged.pipeline_name || merged.name || merged.title || merged.shrimp_name || ''),
    domain: textOf(merged.domain || merged.shrimp_domain || merged.kind || ''),
    startedAt: textOf(merged.started_at || merged.startedAt || merged.created_at || ''),
    updatedAt: textOf(merged.updated_at || merged.updatedAt || merged.finished_at || merged.completed_at || ''),
    failure: textOf(merged.error_summary || merged.error || merged.failure_summary || '').slice(0, 500),
    raw: merged,
  }
}

export function domainOf(value, pipelineSlug = '') {
  const text = [value?.domain, value?.shrimp_domain, value?.pipelineSlug, value?.pipeline_slug, value?.name, value?.display_name, pipelineSlug].filter(Boolean).join(' ').toLowerCase()
  if (/(xiaohongshu|xhs|小红书)/i.test(text)) return 'xiaohongshu'
  if (/(enterprise[-_ ]?health|enterprise[-_ ]?report|企业健康|企康|平安健康)/i.test(text)) return 'enterprise-health'
  if (/(article|wechat|公众号|文章|虾六答)/i.test(text)) return 'article'
  return 'generic'
}

export function heartbeatRunnerCommand(value) {
  const parsed = parseJson(value)
  const command = textOf(parsed?.command ?? value)
  return /(?:^|[\n;&])\s*(?:nohup\s+)?(?:arch\s+-arm64\s+)?(?:\/\S*\/)?python(?:3(?:\.\d+)?)?\s+(?:\S*\/)?scripts\/heartbeat_gzh_publish\.py(?:\s|>|&|$)/m.test(command)
}

export function latestShrimpRun(snapshot) {
  const calls = new Map()
  const running = Array.isArray(snapshot?.runningCalls) ? snapshot.runningCalls : []
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : []
  const addCall = (call, fallbackSeq, source = 'call') => {
    if (!call || String(call.name || '').trim() !== 'shrimp_run') return
    const args = parseJson(call.argsRaw) || (call.args && typeof call.args === 'object' ? call.args : {}) || {}
    const callId = textOf(call.callId || call.id || `${source}-${fallbackSeq}`)
    const current = calls.get(callId)
    calls.set(callId, {
      ...(current || {}),
      callId,
      seq: Number(call.seq ?? fallbackSeq ?? current?.seq ?? 0),
      time: Number(call.time ?? current?.time ?? 0),
      pipelineSlug: textOf(args.pipelineSlug || args.pipeline_slug || args.slug),
      args,
      source,
    })
  }
  const addHeartbeat = (call, fallbackSeq, source = 'heartbeat-call') => {
    if (!call || String(call.name || '').trim() !== 'bash') return
    const args = parseJson(call.argsRaw) || (call.args && typeof call.args === 'object' ? call.args : {}) || {}
    if (!heartbeatRunnerCommand(args)) return
    const callId = textOf(call.callId || call.id || `${source}-${fallbackSeq}`)
    const current = calls.get(callId)
    calls.set(callId, {
      ...(current || {}),
      callId,
      seq: Number(call.seq ?? fallbackSeq ?? current?.seq ?? 0),
      time: Number(call.time ?? current?.time ?? 0),
      pipelineSlug: 'shrimp-c433b57dac59419d',
      args,
      runner: 'gzh-multi-article',
      sourceType: 'heartbeat',
      source,
    })
  }
  running.forEach((call, index) => addCall(call, call?.seq ?? call?.time ?? index, 'call'))
  running.forEach((call, index) => addHeartbeat(call, call?.seq ?? call?.time ?? index, 'heartbeat-call'))
  nodes.forEach((node, index) => {
    if (node?.kind !== 'tool-result') return
    if (String(node.call?.name || '') === 'bash') {
      const resultCallId = node.callId || node.call?.callId
      addHeartbeat({ ...node.call, ...(resultCallId ? { callId: resultCallId } : {}), seq: node.seq, time: node.callTime || node.time }, node.seq ?? index, 'heartbeat-result')
      const heartbeatKey = textOf(resultCallId || `heartbeat-result-${node.seq ?? index}`)
      const heartbeat = calls.get(heartbeatKey)
      if (heartbeat) {
        const pid = /\bPID\s*=\s*(\d+)\b/.exec(contentText(node.content))?.[1] || ''
        calls.set(heartbeatKey, { ...heartbeat, callId: heartbeatKey, seq: Number(node.seq ?? heartbeat.seq), time: Number(node.time ?? heartbeat.time), pid, source: 'heartbeat-result' })
      }
      return
    }
    if (String(node.call?.name || '') !== 'shrimp_run') return
    const result = parseRunResult(node)
    const resultCallId = node.callId || node.call?.callId
    addCall({ ...node.call, ...(resultCallId ? { callId: resultCallId } : {}), seq: node.seq, time: node.callTime || node.time }, node.seq ?? index, 'result')
    const key = textOf(node.callId || node.call?.callId || `result-${node.seq ?? index}`)
    const current = calls.get(key) || calls.get(`result-${node.seq ?? index}`)
    if (!current) return
    calls.set(key, {
      ...current,
      callId: key,
      seq: Number(node.seq ?? current.seq),
      time: Number(node.time ?? current.time),
      result,
      runId: result.runId,
      isError: result.isError,
      errorSummary: result.errorSummary,
      source: 'result',
    })
  })
  const entries = [...calls.values()].sort((a, b) => (a.seq - b.seq) || (a.time - b.time))
  const latest = entries.at(-1)
  if (!latest) return null
  const approval = Array.isArray(snapshot?.pending) && snapshot.pending.some((item) => item?.kind === 'approval')
  return { ...latest, approvalPending: approval, domain: latest.sourceType === 'heartbeat' ? 'article' : domainOf(latest, latest.pipelineSlug) }
}

export function visibleNodes(nodes, limit = 6) {
  const source = Array.isArray(nodes) ? nodes : []
  if (source.length <= limit) return source.map((node) => ({ node }))
  const indexes = [...new Set([0, 1, 2, 3, source.length - 2, source.length - 1])].filter((index) => index >= 0 && index < source.length).sort((a, b) => a - b)
  const output = []
  let previous = -1
  for (const index of indexes) {
    if (previous >= 0 && index - previous > 1) output.push({ ellipsis: true, key: `ellipsis-${previous}-${index}` })
    output.push({ node: source[index] })
    previous = index
  }
  return output
}

export function dismissKey(sessionId, runId) {
  return `dsh-shrimp-run-status:dismissed:${textOf(sessionId)}:${textOf(runId)}`
}

export { TERMINAL_STATUSES }
