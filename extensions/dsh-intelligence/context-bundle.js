import { createHash } from 'node:crypto'

import { assertValid } from './schemas.js'

const DEFAULT_PRIORITY = Object.freeze({
  constraint: 10_000,
  task: 9_000,
  capsule: 8_000,
  activeTask: 7_500,
  decision: 6_000,
  memory: 5_000,
  artifact: 4_000,
  recentEvent: 3_000,
  source: 2_000,
})

const DETERMINISTIC_EPOCH = '1970-01-01T00:00:00Z'

function stableId(prefix, value) {
  const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
  return `${prefix}:${digest}`
}

/**
 * A deterministic, conservative token estimate for budgeting before a model
 * tokenizer is available.  It intentionally rounds up so a bundle does not
 * claim to fit more tightly than it really does.
 */
export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  let cjkOrEmoji = 0
  let ascii = 0
  let otherUnicode = 0
  for (const character of [...text]) {
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}\p{Regional_Indicator}]$/u.test(character)) cjkOrEmoji += 1
    else if (/^[\x00-\x7F]$/.test(character)) ascii += 1
    else otherUnicode += 1
  }
  // CJK/emoji are close to one token per code point for budgeting purposes;
  // ASCII runs are priced at roughly four characters per token.  Unknown
  // Unicode is conservatively counted as one token so the view never silently
  // under-budgets a non-ASCII script.
  return cjkOrEmoji + otherUnicode + Math.ceil(ascii / 4)
}

function stringifyContent(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function asList(value) {
  return Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === 'string' && item.length > 0))] : []
}

function normaliseCandidate(candidate, fallbackKind, index) {
  const source = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : { content: candidate }
  const kind = String(source.kind || fallbackKind || 'source')
  const content = stringifyContent(source.content ?? source.text ?? source.value ?? source)
  const id = String(source.id || source.memoryId || source.artifactRef || source.eventId || `${kind}:${index + 1}`)
  return {
    id,
    kind,
    content,
    tokenEstimate: Number.isSafeInteger(source.tokenEstimate) && source.tokenEstimate >= 0 ? source.tokenEstimate : estimateTokens(content),
    sourceEventIds: asList(source.sourceEventIds || (source.eventId ? [source.eventId] : [])),
    memoryIds: asList(source.memoryIds || (source.memoryId ? [source.memoryId] : [])),
    artifactRefs: asList(source.artifactRefs || (source.artifactRef ? [source.artifactRef] : [])),
    protected: source.protected === true || source.kind === 'constraint',
    untrusted: source.untrusted === true || source.trust === 'untrusted',
    priority: Number.isFinite(Number(source.priority)) ? Number(source.priority) : (DEFAULT_PRIORITY[kind] ?? DEFAULT_PRIORITY.source),
    provenance: source.provenance && typeof source.provenance === 'object' ? { ...source.provenance } : {},
  }
}

function collectCandidates(request, sources = {}) {
  const candidates = []
  const add = (value, kind) => {
    if (!Array.isArray(value)) value = value === undefined || value === null ? [] : [value]
    value.forEach((item, index) => {
      const candidate = normaliseCandidate(item, kind, candidates.length + index)
      if (candidate.content || candidate.protected) candidates.push(candidate)
    })
  }

  // Constraints are generated from the explicit request first, so no caller
  // can accidentally let a low-priority memory evict them.
  add((request.protectedConstraints || []).map((content, index) => ({
    id: `constraint:${index + 1}`,
    kind: 'constraint',
    content,
    protected: true,
    provenance: { source: 'ContextRequest.protectedConstraints' },
  })), 'constraint')
  add(sources.constraints, 'constraint')
  add(sources.task || sources.taskSpec, 'task')
  add(sources.capsule || sources.continuationCapsule, 'capsule')
  add(sources.activeTask, 'activeTask')
  add(sources.decisions, 'decision')
  add(sources.memories || sources.memory, 'memory')
  add(sources.artifacts || sources.artifact, 'artifact')
  add(sources.recentEvents || sources.events, 'recentEvent')
  add(sources.sections, 'source')
  return candidates
}

function uniqueId(id, seen) {
  if (!seen.has(id)) {
    seen.add(id)
    return id
  }
  let index = 2
  while (seen.has(`${id}:${index}`)) index += 1
  const unique = `${id}:${index}`
  seen.add(unique)
  return unique
}

function omissionFor(candidate, reason, createdAt, detail = undefined) {
  return {
    schemaVersion: 1,
    omissionId: stableId('omission', { sectionId: candidate.id, reason, sourceEventIds: candidate.sourceEventIds, memoryIds: candidate.memoryIds, artifactRefs: candidate.artifactRefs }),
    sectionId: candidate.id,
    reason,
    sourceEventIds: candidate.sourceEventIds,
    memoryIds: candidate.memoryIds,
    artifactRefs: candidate.artifactRefs,
    protected: candidate.protected,
    createdAt,
    ...(detail ? { detail } : {}),
  }
}

function truncateForBudget(candidate, remainingTokens) {
  if (remainingTokens <= 0) return null
  // Leave enough room for an explicit truncation marker.  This is only used
  // for unprotected content; protected constraints are never truncated.
  const marker = '\n…[truncated for context budget]'
  const codePoints = [...candidate.content]
  let low = 0
  let high = codePoints.length
  let best = ''
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const content = codePoints.slice(0, middle).join('') + marker
    if (estimateTokens(content) <= remainingTokens) {
      best = content
      low = middle + 1
    } else high = middle - 1
  }
  if (!best || estimateTokens(best) > remainingTokens) return null
  const content = best
  return { ...candidate, content, tokenEstimate: estimateTokens(content), truncated: true }
}

/**
 * Assemble a model-facing context view from explicit sources.
 *
 * This function has no session lookup, hook registration, or implicit memory
 * read.  A caller must explicitly pass sources and explicitly call it.  The
 * resulting bundle is a derived view and can always be reconstructed from the
 * source event IDs in its provenance.
 */
export function assembleContextBundle(rawRequest, sources = {}) {
  const fallbackRequestId = stableId('context-request', {
    sessionId: rawRequest?.sessionId,
    taskId: rawRequest?.taskId,
    projectId: rawRequest?.projectId,
    query: rawRequest?.query || '',
    mode: rawRequest?.mode || 'act',
  })
  const request = {
    schemaVersion: 1,
    requestId: rawRequest?.requestId || fallbackRequestId,
    sessionId: rawRequest?.sessionId,
    ...(rawRequest?.taskId ? { taskId: rawRequest.taskId } : {}),
    projectId: rawRequest?.projectId,
    modelTarget: rawRequest?.modelTarget || {},
    tokenBudget: rawRequest?.tokenBudget,
    query: rawRequest?.query || '',
    mode: rawRequest?.mode || 'act',
    protectedConstraints: Array.isArray(rawRequest?.protectedConstraints) ? rawRequest.protectedConstraints : [],
    ...(rawRequest?.createdAt ? { createdAt: rawRequest.createdAt } : {}),
    ...(rawRequest?.metadata ? { metadata: rawRequest.metadata } : {}),
  }
  assertValid('ContextRequest', request)

  const createdAt = request.createdAt || (typeof sources.createdAt === 'string' ? sources.createdAt : DETERMINISTIC_EPOCH)
  const seen = new Set()
  const candidates = collectCandidates(request, sources)
    .map((item) => ({ ...item, id: uniqueId(item.id, seen) }))
    .sort((left, right) => Number(right.protected) - Number(left.protected) || right.priority - left.priority)

  const sections = []
  const omitted = []
  let usedTokens = 0

  for (const candidate of candidates) {
    if (candidate.protected) {
      const section = {
        id: candidate.id,
        kind: candidate.kind,
        content: candidate.content,
        tokenEstimate: candidate.tokenEstimate,
        sourceEventIds: candidate.sourceEventIds,
        memoryIds: candidate.memoryIds,
        artifactRefs: candidate.artifactRefs,
        protected: true,
        untrusted: candidate.untrusted,
        priority: candidate.priority,
        ...(candidate.provenance && Object.keys(candidate.provenance).length ? { provenance: candidate.provenance } : {}),
      }
      sections.push(section)
      usedTokens += section.tokenEstimate
      continue
    }

    const remaining = request.tokenBudget - usedTokens
    if (candidate.tokenEstimate <= remaining) {
      sections.push({
        id: candidate.id,
        kind: candidate.kind,
        content: candidate.content,
        tokenEstimate: candidate.tokenEstimate,
        sourceEventIds: candidate.sourceEventIds,
        memoryIds: candidate.memoryIds,
        artifactRefs: candidate.artifactRefs,
        protected: false,
        untrusted: candidate.untrusted,
        priority: candidate.priority,
        ...(candidate.provenance && Object.keys(candidate.provenance).length ? { provenance: candidate.provenance } : {}),
      })
      usedTokens += candidate.tokenEstimate
      continue
    }

    const truncated = truncateForBudget(candidate, remaining)
    if (truncated) {
      sections.push({
        id: candidate.id,
        kind: candidate.kind,
        content: truncated.content,
        tokenEstimate: truncated.tokenEstimate,
        sourceEventIds: candidate.sourceEventIds,
        memoryIds: candidate.memoryIds,
        artifactRefs: candidate.artifactRefs,
        protected: false,
        untrusted: candidate.untrusted,
        priority: candidate.priority,
        truncated: true,
        ...(candidate.provenance && Object.keys(candidate.provenance).length ? { provenance: candidate.provenance } : {}),
      })
      usedTokens += truncated.tokenEstimate
      omitted.push(omissionFor(candidate, 'budget', createdAt, 'section was partially retained'))
    } else {
      omitted.push(omissionFor(candidate, 'budget', createdAt, 'section did not fit the remaining token budget'))
    }
  }

  const sourceEventIds = [...new Set(sections.flatMap((section) => section.sourceEventIds))]
  const memoryIds = [...new Set(sections.flatMap((section) => section.memoryIds))]
  const artifactRefs = [...new Set(sections.flatMap((section) => section.artifactRefs))]
  const untrustedSourceIds = [...new Set([
    ...sections.filter((section) => section.untrusted).flatMap((section) => [section.id, ...section.sourceEventIds, ...section.memoryIds, ...section.artifactRefs]),
    ...candidates.filter((candidate) => candidate.untrusted).flatMap((candidate) => [candidate.id, ...candidate.sourceEventIds, ...candidate.memoryIds, ...candidate.artifactRefs]),
  ])]
  const bundle = {
    schemaVersion: 1,
    bundleId: stableId('context-bundle', { requestId: request.requestId, sessionId: request.sessionId, taskId: request.taskId, projectId: request.projectId, tokenBudget: request.tokenBudget, sections, omitted }),
    requestId: request.requestId,
    sessionId: request.sessionId,
    ...(request.taskId ? { taskId: request.taskId } : {}),
    projectId: request.projectId,
    sections,
    sourceEventIds,
    memoryIds,
    artifactRefs,
    omitted,
    estimatedTokens: usedTokens,
    tokenBudget: request.tokenBudget,
    hasUntrusted: untrustedSourceIds.length > 0,
    untrustedSourceIds,
    createdAt,
    provenance: {
      strategy: 'explicit-jit-v1',
      requestId: request.requestId,
      query: request.query,
      mode: request.mode,
      sourceCount: candidates.length,
      retainedCount: sections.length,
      omittedCount: omitted.length,
    },
  }
  assertValid('ContextBundle', bundle)
  return bundle
}

// Public name used by downstream context/compaction adapters.
export const buildContextBundle = assembleContextBundle

export const CONTEXT_DEFAULT_PRIORITY = DEFAULT_PRIORITY
