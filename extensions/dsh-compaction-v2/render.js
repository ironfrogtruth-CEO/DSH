const DEFAULT_MAX_CHARS = 12_000
const SECRET_KEY = /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|private[_-]?key|credential)/i
const OMIT_KEY = /^(?:rawOutput|history|messages|transcript|fullHistory|events|eventLog|summary|rawSummary|toolResults|rawHistory)$/i
const SECRET_VALUE = /(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[^\s,"']{6,})/gi

function redactText(value) { return String(value).replace(SECRET_VALUE, '[REDACTED]') }

function sanitize(value, key, seen) {
  if (value === undefined) return undefined
  if (key && OMIT_KEY.test(key)) return '[omitted]'
  if (key && SECRET_KEY.test(key)) return '[REDACTED]'
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return redactText(value)
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : '[invalid-number]'
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') return `[omitted-${typeof value}]`
  if (seen.has(value)) return '[cycle-omitted]'
  seen.add(value)
  if (Array.isArray(value)) {
    const output = value.slice(0, 200).map((item) => sanitize(item, '', seen)).filter((item) => item !== undefined)
    if (value.length > 200) output.push(`[${value.length - 200} items omitted]`)
    seen.delete(value)
    return output
  }
  const output = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    const sanitized = sanitize(childValue, childKey, seen)
    if (sanitized !== undefined) output[childKey] = sanitized
  }
  seen.delete(value)
  return output
}

export function boundedJson(value, maxChars = DEFAULT_MAX_CHARS) {
  const serialized = JSON.stringify(sanitize(value, '', new WeakSet()))
  if (serialized.length <= maxChars) return serialized
  return JSON.stringify({ truncated: true, originalChars: serialized.length, preview: serialized.slice(0, Math.max(100, maxChars - 120)) })
}

function compactRecord(record) {
  return {
    recordId: record.recordId,
    sessionId: record.sessionId,
    compactionId: record.compactionId,
    capsuleHash: record.capsuleHash,
    sourceEventIds: record.sourceEventIds || [],
    sourceSeqs: record.sourceSeqs || [],
    revision: record.revision,
    status: record.status,
    model: record.model,
    provider: record.provider,
    createdAt: record.createdAt,
    ...(record.capsule ? { capsule: record.capsule } : {}),
  }
}

export function projectCapsuleResult(toolName, value) {
  if (toolName === 'capsule_get') return { ok: value?.ok, record: value?.record ? compactRecord(value.record) : undefined }
  if (toolName === 'capsule_list') return { ok: value?.ok, records: (value?.records || []).map(compactRecord) }
  if (toolName === 'capsule_verify') return { ok: value?.ok, recordId: value?.recordId, capsuleHash: value?.capsuleHash, sourceEventIds: value?.sourceEventIds || [] }
  return value
}

export function renderCapsuleResult(toolName, value, maxChars = DEFAULT_MAX_CHARS) {
  if (value?.ok === false) return [{ type: 'text', text: `失败: ${value.code || 'CAPSULE_ERROR'} ${redactText(String(value.error || 'unknown error')).slice(0, maxChars - 80)}` }]
  return [{ type: 'text', text: `${toolName}\n${boundedJson(projectCapsuleResult(toolName, value), maxChars)}` }]
}

export { DEFAULT_MAX_CHARS }
