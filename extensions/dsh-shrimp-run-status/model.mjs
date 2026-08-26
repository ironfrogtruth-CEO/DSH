const textOf = (value) => value == null ? '' : typeof value === 'string' ? value : String(value)

export const ACTIVE_RUN_STATUSES = new Set([
  'running',
  'processing',
  'queued',
  'trialing',
  'awaiting_confirmation',
  'awaiting_external',
  'waiting_external',
  'cancel_requested',
])

// The closed-card watcher is deliberately much slower than the open card's
// summary refresh. It is a discovery signal, not a second runtime source.
export const AUTO_DISCOVERY_INTERVAL_MS = 12_000
export const HIDDEN_AUTO_DISCOVERY_INTERVAL_MS = 30_000
export const FULL_SUMMARY_REFRESH_INTERVAL_MS = 4_000

export const SHRIMP_TANK_DISMISSED_STORAGE_PREFIX = 'dsh-shrimp-tank-dismissed:'

export const activeStatuses = ACTIVE_RUN_STATUSES

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

const TERMINAL_STATUSES = new Set([
  'done',
  'completed',
  'succeeded',
  'success',
  'failed',
  'error',
  'blocked',
  'cancelled',
  'canceled',
  'stopped',
  'interrupted',
  'aborted',
])

const PUBLISHED_EXCLUDED_LIFECYCLES = new Set(['deleted', 'archived', 'draft'])

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

export function normalizeStatus(value) {
  const raw = textOf(value).trim().toLowerCase().replace(/[\s-]+/g, '_')
  return STATUS_ALIASES.get(raw) || raw || 'unknown'
}

export function isActiveRunStatus(value) {
  return ACTIVE_RUN_STATUSES.has(normalizeStatus(value))
}

export const isActiveStatus = isActiveRunStatus

export function isTerminalStatus(value) {
  const raw = normalizeStatus(value)
  return TERMINAL_STATUSES.has(raw) || TERMINAL_STATUSES.has(STATUS_ALIASES.get(raw) || '')
}

export function progressOf(value) {
  const number = Number(value?.progress_percent ?? value?.progressPercent ?? value?.progress ?? value?.percent)
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const result = textOf(value).trim()
    if (result) return result
  }
  return ''
}

function publishedLifecycleOf(item) {
  return textOf(item?.lifecycle_status || item?.lifecycleStatus || item?.lifecycle || item?.state || item?.status).trim().toLowerCase()
}

function publishedRefOf(item) {
  return firstNonEmpty(item?.ref, item?.slug, item?.id)
}

function publishedNameOf(item) {
  return firstNonEmpty(item?.display_name, item?.title, item?.name)
}

export function projectPublishedShrimps(items) {
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
      continue
    }
    const previous = output[previousIndex]
    if (publishedLifecycleOf(item) === 'published' && publishedLifecycleOf(previous) !== 'published') output[previousIndex] = item
  }
  return output
}

function messageOf(value, keys) {
  if (!value || typeof value !== 'object') return ''
  for (const key of keys) {
    const candidate = value[key]
    if (candidate && typeof candidate === 'object') {
      const nested = firstNonEmpty(candidate.message, candidate.text, candidate.detail, candidate.reason)
      if (nested) return nested.slice(0, 500)
    }
    const message = textOf(candidate).trim()
    if (message) return message.slice(0, 500)
  }
  return ''
}

export function normalizeNode(node, index = 0) {
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
  const id = firstNonEmpty(source.node_id, source.nodeId, source.id, source.key, `node-${index + 1}`)
  return {
    id,
    name: firstNonEmpty(source.node_name, source.nodeName, source.display_name, source.name, source.title, source.node_id, source.nodeId),
    status,
    state,
    progress: progressOf(source),
    failure: messageOf(source, ['failure_message', 'error_summary', 'error', 'failure_summary', 'failure']),
    blocked: messageOf(source, ['blocked_message', 'blocked_reason', 'blocking_reason', 'blocked']),
    order: Number(source.order_index ?? source.order ?? index),
  }
}

function summaryRootOf(value) {
  const root = unwrapEnvelope(value)
  if (root?.summary && typeof root.summary === 'object' && !Array.isArray(root.summary)) return { ...root, ...root.summary }
  return root
}

function statusRootOf(value) {
  const root = unwrapEnvelope(value)
  if (root?.status && typeof root.status === 'object' && !Array.isArray(root.status)) return { ...root, ...root.status }
  return root
}

function nodeSourceOf(value) {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value.nodes)) return value.nodes
  if (Array.isArray(value.node_states)) return value.node_states
  if (Array.isArray(value.nodeStates)) return value.nodeStates
  if (Array.isArray(value.steps)) return value.steps
  return []
}

function currentNodeIdOf(value, nodes) {
  const direct = value?.current_node && typeof value.current_node === 'object'
    ? value.current_node
    : null
  const currentId = firstNonEmpty(value?.current_node_id, value?.currentNodeId, direct?.id, direct?.node_id)
  if (currentId) return currentId
  const currentText = typeof value?.current_node === 'string'
    ? value.current_node
    : typeof value?.currentNode === 'string'
      ? value.currentNode
      : firstNonEmpty(value?.current_node_name, value?.currentNodeName, direct?.node_name, direct?.name)
  if (currentText) return nodes.find((node) => node.id === currentText || node.name === currentText)?.id || ''
  return nodes.find((node) => ['running', 'processing', 'queued', 'approval_needed', 'failed', 'blocked'].includes(node.status))?.id || ''
}

function currentNodeOf(value, nodes) {
  const currentId = currentNodeIdOf(value, nodes)
  return nodes.find((node) => node.id === currentId)?.name || currentId || ''
}

export function normalizeRunPayload(summaryValue, statusValue) {
  const summary = summaryRootOf(summaryValue)
  const status = statusRootOf(statusValue)
  const merged = {
    ...(status && typeof status === 'object' ? status : {}),
    ...(summary && typeof summary === 'object' ? summary : {}),
  }
  const source = nodeSourceOf(merged)
  const nodes = source.map(normalizeNode).sort((left, right) => left.order - right.order)
  const progress = progressOf(merged)
  const statusName = normalizeStatus(merged.status || merged.state || merged.lifecycle_status)
  const failure = messageOf(merged, ['failure_message', 'error_summary', 'error', 'failure_summary', 'failure'])
  const blocked = messageOf(merged, ['blocked_message', 'blocked_reason', 'blocking_reason', 'blocked'])
  return {
    status: statusName,
    terminal: isTerminalStatus(statusName),
    progress: progress == null && nodes.length
      ? Math.round(nodes.reduce((sum, node) => sum + (node.progress ?? (node.state === 'done' ? 100 : 0)), 0) / nodes.length)
      : progress,
    nodes,
    currentNode: currentNodeOf(merged, nodes),
    currentNodeId: currentNodeIdOf(merged, nodes),
    name: firstNonEmpty(merged.display_name, merged.pipeline_name, merged.name, merged.title, merged.shrimp_name),
    domain: firstNonEmpty(merged.domain, merged.shrimp_domain, merged.kind),
    startedAt: firstNonEmpty(merged.started_at, merged.startedAt, merged.created_at, merged.createdAt),
    updatedAt: firstNonEmpty(merged.updated_at, merged.updatedAt, merged.finished_at, merged.completed_at),
    failure,
    blocked,
    raw: merged,
  }
}

export const normalizeSummary = normalizeRunPayload

function valuesOf(value, keys) {
  if (!value || typeof value !== 'object') return []
  return keys.map((key) => value[key]).map((entry) => textOf(entry).trim()).filter(Boolean)
}

export function pipelineRefsOf(value) {
  return [...new Set(valuesOf(value, [
    'pipeline_ref',
    'pipelineRef',
    'pipeline_slug',
    'pipelineSlug',
    'pipeline_id',
    'pipelineId',
    'shrimp_ref',
    'shrimpRef',
    'ref',
    'slug',
  ]))]
}

export const runPipelineRefs = pipelineRefsOf

export function shrimpRefsOf(value) {
  return [...new Set([...pipelineRefsOf(value), ...valuesOf(value, ['id'])])]
}

export const itemPipelineRefs = shrimpRefsOf

export function refsMatch(left, right) {
  const leftRefs = pipelineRefsOf(left)
  const rightRefs = pipelineRefsOf(right)
  return leftRefs.length > 0 && rightRefs.length > 0 && rightRefs.some((ref) => leftRefs.includes(ref))
}

export const shrimpRefsMatch = refsMatch

export function runIdOf(run) {
  return firstNonEmpty(run?.id, run?.run_id, run?.runId)
}

function runUpdatedAt(run) {
  const value = Date.parse(firstNonEmpty(run?.updated_at, run?.updatedAt, run?.finished_at, run?.finishedAt, run?.completed_at, run?.started_at, run?.created_at))
  if (Number.isFinite(value)) return value
  const numeric = Number(run?.updated_at ?? run?.updatedAt ?? run?.created_at ?? run?.seq ?? 0)
  return Number.isFinite(numeric) ? numeric : 0
}

export const runTimestamp = runUpdatedAt

function embeddedRunFor(item) {
  if (!item || typeof item !== 'object' || !item.run || typeof item.run !== 'object') return null
  const itemRefs = shrimpRefsOf(item)
  if (itemRefs.length === 0) return null
  const embeddedRefs = pipelineRefsOf(item.run)
  // The embedded record is owned by this item. Carry the item's non-empty ref
  // only when the record omitted its own copy; list rows still need an
  // explicit non-empty intersection through refsMatch.
  if (embeddedRefs.length > 0 && !embeddedRefs.some((ref) => itemRefs.includes(ref))) return null
  if (embeddedRefs.length > 0) return { ...item.run, __embedded: true }
  return { ...item.run, pipeline_ref: itemRefs[0], __embedded: true }
}

export function runBelongsToShrimp(run, item) {
  if (!run || !item) return false
  const itemRefs = shrimpRefsOf(item)
  const runRefs = pipelineRefsOf(run)
  if (run.__embedded === true && itemRefs.length > 0) return true
  return runRefs.length > 0 && itemRefs.length > 0 && runRefs.some((ref) => itemRefs.includes(ref))
}

export const runBelongsToPipeline = runBelongsToShrimp

function itemNameCandidates(item, run) {
  return [
    item?.display_name,
    item?.title,
    item?.name,
    item?.shrimp_name,
    run?.display_name,
    run?.pipeline_name,
    run?.name,
  ].map((value) => textOf(value).trim()).filter(Boolean)
}

export function canonicalShrimpName(item, run = item?.run) {
  const itemName = publishedNameOf(item)
  if (itemName) return itemName
  const runName = itemNameCandidates({}, run)[0]
  return runName || firstNonEmpty(shrimpRefsOf(item)[0], pipelineRefsOf(run)[0]) || '未命名虾'
}

export const shrimpNameOf = canonicalShrimpName

function combinedRunsForItem(item, runs) {
  const embedded = embeddedRunFor(item)
  const list = Array.isArray(runs) ? runs : []
  const matched = list.filter((run) => runBelongsToShrimp(run, item))
  return embedded ? [...matched, embedded] : matched
}

export function latestActiveRunForPipeline(item, runs = []) {
  const active = combinedRunsForItem(item, runs).filter((run) => isActiveRunStatus(run?.status || run?.state || run?.lifecycle_status))
  active.sort((left, right) => runUpdatedAt(right) - runUpdatedAt(left) || runIdOf(right).localeCompare(runIdOf(left)))
  return active[0] || null
}

export const latestActiveRun = latestActiveRunForPipeline

export function groupLatestActiveRuns(items, runs = []) {
  const byRef = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    const refs = shrimpRefsOf(item)
    if (refs.length === 0) continue
    const run = latestActiveRunForPipeline(item, runs)
    if (!run) continue
    const ref = refs[0]
    const group = {
      ref,
      refs,
      item,
      run,
      name: canonicalShrimpName(item, run),
      updatedAt: runUpdatedAt(run),
    }
    const previous = byRef.get(ref)
    if (!previous || group.updatedAt > previous.updatedAt || (group.updatedAt === previous.updatedAt && runIdOf(group.run).localeCompare(runIdOf(previous.run)) > 0)) byRef.set(ref, group)
  }
  const groups = [...byRef.values()]
  groups.sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name))
  return groups
}

export const groupActiveRuns = groupLatestActiveRuns

/**
 * Stable identity for the set of active canonical runs. Display names and
 * ordering are intentionally excluded so a poll cannot reopen a dismissed
 * card merely because a label or sort order changed.
 */
export function activeRunSignature(groups) {
  const entries = []
  for (const group of Array.isArray(groups) ? groups : []) {
    const pipelineRef = firstNonEmpty(
      pipelineRefsOf(group?.run)[0],
      group?.pipelineRef,
      group?.pipeline_ref,
      group?.ref,
      pipelineRefsOf(group)[0],
      pipelineRefsOf(group?.item)[0],
    )
    const runId = firstNonEmpty(group?.runId, group?.run_id, runIdOf(group?.run), runIdOf(group))
    if (pipelineRef && runId) entries.push(`${pipelineRef}:${runId}`)
  }
  return [...new Set(entries)].sort().join('|')
}

export const activeSignature = activeRunSignature

export function autoDiscoveryDelayMs(hidden = false) {
  return hidden ? HIDDEN_AUTO_DISCOVERY_INTERVAL_MS : AUTO_DISCOVERY_INTERVAL_MS
}

export const autoPollDelayMs = autoDiscoveryDelayMs

export function shrimpTankDismissedStorageKey(sessionId) {
  const id = firstNonEmpty(sessionId)
  return id ? `${SHRIMP_TANK_DISMISSED_STORAGE_PREFIX}${encodeURIComponent(id)}` : ''
}

export const dismissalStorageKey = shrimpTankDismissedStorageKey

export function runSignatureEntries(signature) {
  return [...new Set(textOf(signature).split('|').map((entry) => entry.trim()).filter(Boolean))].sort()
}

export function mergeRunSignatures(...signatures) {
  return [...new Set(signatures.flatMap(runSignatureEntries))].sort().join('|')
}

export function shouldAutoOpen(signature, dismissedSignature = '') {
  const active = runSignatureEntries(signature)
  if (active.length === 0) return false
  const dismissed = new Set(runSignatureEntries(dismissedSignature))
  return active.some((entry) => !dismissed.has(entry))
}

export function visibleNodes(nodes, limit = 6, current = undefined) {
  const source = Array.isArray(nodes) ? nodes : []
  if (limit && typeof limit === 'object') {
    current = limit
    limit = Number(current.limit || 6)
  }
  if (source.length <= limit) return source.map((node) => ({ node }))
  const currentId = typeof current === 'string' ? current : firstNonEmpty(current?.currentNodeId, current?.nodeId, current?.id, current?.currentNode)
  let currentIndex = currentId ? source.findIndex((node) => node?.id === currentId || node?.node_id === currentId || node?.name === currentId || node?.node_name === currentId) : -1
  if (currentIndex < 0) currentIndex = source.findIndex((node) => ['running', 'processing', 'queued', 'failed', 'blocked'].includes(normalizeStatus(node?.status || node?.state || node?.lifecycle_status)))
  const neighborIndexes = currentIndex < 0 ? [] : [currentIndex - 1, currentIndex, currentIndex + 1]
  const required = [...new Set([0, source.length - 1, ...neighborIndexes])].filter((index) => index >= 0 && index < source.length)
  const fill = Array.from({ length: source.length }, (_, index) => index)
    .filter((index) => !required.includes(index))
    .sort((left, right) => (Math.abs(left - (currentIndex < 0 ? 0 : currentIndex)) - Math.abs(right - (currentIndex < 0 ? 0 : currentIndex))) || left - right)
  const indexes = [...required, ...fill.slice(0, Math.max(0, limit - required.length))].sort((left, right) => left - right)
  const output = []
  let previous = -1
  for (const index of indexes) {
    if (previous >= 0 && index - previous > 1) output.push({ ellipsis: true, key: `ellipsis-${previous}-${index}` })
    output.push({ node: source[index] })
    previous = index
  }
  return output
}

export function unwrapItems(value) {
  const root = unwrapEnvelope(value)
  if (Array.isArray(root)) return root
  if (Array.isArray(root?.items)) return root.items
  if (Array.isArray(root?.runs)) return root.runs
  if (Array.isArray(root?.data)) return root.data
  return []
}

export function mergeRunSummary(run, summaryValue) {
  const summary = normalizeRunPayload(summaryValue, run)
  return {
    ...summary,
    runId: runIdOf(run),
    pipelineRef: pipelineRefsOf(run)[0] || '',
    name: summary.name || canonicalShrimpName(run?.item, run),
    run,
  }
}
