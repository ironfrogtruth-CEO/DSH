import { createHash } from 'node:crypto'

import { validateContinuationCapsule } from '@local/dsh-intelligence/schemas'

export const DEFAULT_EXTRACTION_LIMITS = Object.freeze({
  maxSummaryChars: 80_000,
  maxCapsuleChars: 16_000,
  maxItems: 32,
  maxItemChars: 600,
  maxFiles: 80,
  maxAnchors: 16,
  maxAnchorChars: 420,
})

const EPOCH = '1970-01-01T00:00:00Z'

function stableId(prefix, value) {
  const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
  return `${prefix}:${digest}`
}

function bounded(text, maxChars) {
  const value = String(text || '').trim()
  if (value.length <= maxChars) return value
  return value.slice(0, Math.max(1, maxChars - 18)).trimEnd() + '…[truncated]'
}

function uniqueBounded(values, maxItems, maxChars) {
  const result = []
  const seen = new Set()
  for (const value of values || []) {
    const item = bounded(value, maxChars)
    if (!item || seen.has(item)) continue
    seen.add(item)
    result.push(item)
    if (result.length >= maxItems) break
  }
  return result
}

function asText(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('\n')
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (Array.isArray(value.content)) return asText(value.content)
    if (typeof value.content === 'string') return value.content
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  return String(value)
}

function summaryText(upstream) {
  if (typeof upstream === 'string') return upstream
  if (Array.isArray(upstream)) return upstream.map(asText).filter(Boolean).join('\n')
  if (upstream && typeof upstream === 'object') return asText(upstream.summary ?? upstream.text ?? upstream.content ?? upstream.rawOutput)
  return ''
}

function messageText(message) {
  if (!message || typeof message !== 'object') return asText(message)
  const role = typeof message.role === 'string' ? `${message.role}: ` : ''
  return role + asText(message.content ?? message.text)
}

function inputText(messages) {
  return (Array.isArray(messages) ? messages : []).map(messageText).filter((text) => text.trim()).join('\n')
}

function sectionsFromMarkdown(text) {
  const sections = {}
  const matches = [...text.matchAll(/^##\s+(.+?)\s*$/gm)]
  for (let index = 0; index < matches.length; index += 1) {
    const title = matches[index][1].trim()
    const start = matches[index].index + matches[index][0].length
    const end = matches[index + 1]?.index ?? text.length
    sections[title.toLowerCase()] = text.slice(start, end).trim()
  }
  return sections
}

function section(sections, ...names) {
  for (const name of names) {
    const value = sections[String(name).toLowerCase()]
    if (value) return value
  }
  return ''
}

function bulletLines(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).map((line) => line.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '').trim()).filter((line) => line && line !== '(none)' && line !== '（无）')
}

function matchesDirective(line) {
  return /\b(?:must|never|do not|don't|preserve|keep|only|cannot|without|shall|required|protected|constraint)\b/i.test(line)
    || /(?:必须|不得|不要|严禁|禁止|仅限|只能|保留|不能|不应|约束|不可|先|不要修改|不改)/.test(line)
}

function extractAnchors(summary, input, limits, provided = []) {
  const candidates = [
    ...provided,
    ...bulletLines(section(summary, 'Critical Context', 'Protected Constraints', 'Primary Request and Intent')).filter(matchesDirective),
    ...input.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && matchesDirective(line)),
  ]
  return uniqueBounded(candidates, limits.maxAnchors, limits.maxAnchorChars)
}

function extractFiles(text, limits) {
  const candidates = []
  const patterns = [
    // Linux containers and remote workspaces often live under /workspace or
    // another arbitrary absolute root. Do not start inside a URL (`://`).
    /(?<![A-Za-z0-9:/])\/(?:[\w@.+-]+\/)*[\w@.+-]+/g,
    /(?:\/Users\/|\/tmp\/|\/var\/|\.\/|\.\.\/)[^\s`"'<>\],;)]+/g,
    /\b[\w@.-]+\/(?:[\w@.-]+\/)*[\w@.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|yml|yaml|py|rs|swift|css|html|sql|sh)\b/g,
    /\b[\w@.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|yml|yaml|py|rs|swift|css|html|sql|sh)\b/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) candidates.push(match[0].replace(/[.,:]+$/, ''))
  }
  const unique = uniqueBounded(candidates, limits.maxFiles * 2, 500)
  return unique.filter((candidate, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.length > candidate.length && other.endsWith(`/${candidate}`))).slice(0, limits.maxFiles)
}

function extractCommands(text, limits) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return uniqueBounded(lines.filter((line) => /(?:^[$>]\s|`[^`]+`|\b(?:npm|pnpm|yarn|node|python|pytest|git|curl|npx|playwright|cargo)\s)/i.test(line)), limits.maxItems, limits.maxItemChars)
}

function extractErrors(text, limits) {
  const lines = bulletLines(text)
  return uniqueBounded(lines.filter((line) => /(?:error|failed|failure|exception|timeout|invalid|bug|错误|失败|异常|报错|超时|阻断)/i.test(line)), limits.maxItems, limits.maxItemChars)
}

function extractTests(text, limits) {
  const lines = bulletLines(text)
  return uniqueBounded(lines.filter((line) => /(?:test|tests|passed|pass|qa|验收|测试|通过|校验)/i.test(line)), limits.maxItems, limits.maxItemChars)
}

function recordObjects(items, kind) {
  return items.map((text) => ({ kind, text }))
}

function fail(code, message, extra = {}) {
  return { ok: false, code, error: message, ...extra }
}

/**
 * Extract a bounded, structured ContinuationCapsule without model calls or I/O.
 *
 * `upstream` can be the `SummaryResult` from rc.8 (`{summary: ContentBlock[]}`),
 * a ContentBlock array, or a plain string.  The result is a discriminated
 * `{ok:true,capsule,anchors,...}` / `{ok:false,code,...}` object so callers can
 * fail closed instead of silently falling back to an unstructured summary.
 */
export function extractContinuationCapsule(upstream, inputMessages = [], options = {}) {
  const limits = { ...DEFAULT_EXTRACTION_LIMITS, ...(options.limits || {}) }
  const summary = summaryText(upstream)
  if (!summary.trim()) return fail('SUMMARY_EMPTY', 'upstream compaction summary is empty')
  if (summary.length > limits.maxSummaryChars) return fail('SUMMARY_TOO_LARGE', `upstream compaction summary exceeds ${limits.maxSummaryChars} characters`)
  const messages = inputText(inputMessages)
  const sections = sectionsFromMarkdown(summary)
  const primary = section(sections, 'Primary Request and Intent', 'Goal', 'Request')
  const currentSection = section(sections, 'Current Work', 'Current Task', 'Active Task')
  const pendingSection = section(sections, 'Pending Jobs', 'Pending Work')
  const nextSection = section(sections, 'Next Step', 'Next Action')
  const errorsSection = section(sections, 'Errors and Fixes', 'Errors', 'Failures')
  const contextSection = section(sections, 'Critical Context', 'Constraints')
  const filesSection = section(sections, 'Files and Code', 'Files')
  const technicalSection = section(sections, 'Key Technical Concepts', 'Technical Concepts')

  const goal = bounded(bulletLines(primary)[0] || bulletLines(messages)[0] || messages || 'Continue the current task.', limits.maxItemChars * 2)
  const anchors = extractAnchors(sections, messages, limits, options.protectedConstraints || [])
  const files = extractFiles([filesSection, messages, summary].join('\n'), limits)
  const commands = extractCommands([summary, messages].join('\n'), limits)
  const errors = extractErrors(errorsSection || summary, limits)
  const tests = extractTests([errorsSection, currentSection, section(sections, 'Validation Evidence', 'Tests and Evidence')].join('\n'), limits)
  const pending = uniqueBounded(bulletLines(pendingSection), limits.maxItems, limits.maxItemChars)
  const current = uniqueBounded(bulletLines(currentSection), limits.maxItems, limits.maxItemChars)
  const next = bounded(bulletLines(nextSection)[0] || (pending[0] ? `Continue: ${pending[0]}` : 'Continue from the latest checkpoint.'), limits.maxItemChars)
  const decisions = uniqueBounded([...bulletLines(technicalSection), ...bulletLines(contextSection)].filter((line) => /(?:decid|use|adopt|keep|preserve|采用|决定|保留|使用|改为|选择)/i.test(line)), limits.maxItems, limits.maxItemChars)
  const sourceEventIds = (Array.isArray(options.sourceEventIds) ? options.sourceEventIds : []).map((value) => String(value)).filter(Boolean).slice(0, 500)
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : ''
  if (!sessionId) return fail('SESSION_REQUIRED', 'sessionId is required to build a ContinuationCapsule')
  const projectId = String(options.projectId || `session:${sessionId}`)
  const taskId = String(options.taskId || `task:${sessionId}`)
  const capsule = {
    schemaVersion: 1,
    capsuleId: options.capsuleId || stableId('capsule', { sessionId, taskId, projectId, summary }),
    taskId,
    projectId,
    sessionId,
    goal,
    protectedConstraints: anchors,
    planSnapshot: {
      current: current.map((text) => ({ text })),
      pending: pending.map((text) => ({ text })),
      decisions: decisions.map((text) => ({ text })),
    },
    activeTask: current.length ? { text: current[0] } : null,
    decisions: recordObjects(decisions, 'decision'),
    touchedFiles: files,
    testsAndEvidence: recordObjects([...tests, ...commands.filter((line) => /(?:test|check|lint|qa|验收|测试|校验)/i.test(line))], 'test-or-command'),
    errorsAndAttempts: recordObjects(errors, 'error'),
    artifacts: recordObjects(files.filter((file) => /(?:output|artifact|deliver|report|report|\.pdf$|\.html?$|\.pptx?$|\.xlsx?$)/i.test(file)), 'artifact'),
    pendingJobs: recordObjects(pending, 'pending'),
    nextAction: next,
    sourceEventIds,
    createdAt: options.createdAt || EPOCH,
    revision: Number.isSafeInteger(options.revision) && options.revision >= 0 ? options.revision : 0,
  }
  const encoded = JSON.stringify(capsule)
  if (encoded.length > limits.maxCapsuleChars) return fail('CAPSULE_TOO_LARGE', `ContinuationCapsule exceeds ${limits.maxCapsuleChars} characters`)
  const validated = validateContinuationCapsule(capsule)
  if (!validated.ok) return fail('CAPSULE_INVALID', 'extracted ContinuationCapsule failed validation', { errors: validated.errors, capsule })
  return {
    ok: true,
    capsule,
    anchors,
    summary,
    fields: { goal, files, errors, pending, current, next, commands, decisions },
  }
}

/**
 * Append finite machine-readable state to a successful upstream summary.
 * The original provider output is not rewritten; this returns a new text-block
 * array suitable for `SummaryResult.summary`.
 */
export function appendStructuredSummary(summaryBlocks, extraction, limits = DEFAULT_EXTRACTION_LIMITS) {
  if (!extraction?.ok) return fail(extraction?.code || 'CAPSULE_INVALID', extraction?.error || 'invalid capsule extraction')
  const base = Array.isArray(summaryBlocks) ? summaryBlocks : [{ type: 'text', text: String(summaryBlocks || '') }]
  const baseText = base.map(asText).join('\n')
  if (!baseText.trim()) return fail('SUMMARY_EMPTY', 'cannot append to an empty summary')
  if (baseText.length > limits.maxSummaryChars) return fail('SUMMARY_TOO_LARGE', `summary exceeds ${limits.maxSummaryChars} characters before capsule append`)
  const capsuleJson = JSON.stringify(extraction.capsule, null, 2)
  const anchors = extraction.anchors.length ? extraction.anchors.map((anchor) => `- ${anchor}`).join('\n') : '- (none)'
  const suffix = `\n\n## Continuation Capsule\n\n\`\`\`json\n${capsuleJson}\n\`\`\`\n\n## Protected Anchors\n${anchors}\n`
  if (baseText.length + suffix.length > limits.maxSummaryChars) return fail('SUMMARY_TOO_LARGE', `summary plus capsule exceeds ${limits.maxSummaryChars} characters`)
  return {
    ok: true,
    summary: [...base, { type: 'text', text: suffix }],
    capsule: extraction.capsule,
    anchors: extraction.anchors,
  }
}

/** Read back only the structured capsule block emitted by this package. */
export function parseStructuredCapsule(summaryBlocks) {
  const text = summaryText(summaryBlocks)
  const match = text.match(/##\s+Continuation Capsule\s*```json\s*([\s\S]*?)\s*```/i)
  if (!match) return fail('CAPSULE_BLOCK_MISSING', 'summary has no Continuation Capsule block')
  let capsule
  try { capsule = JSON.parse(match[1]) } catch (error) { return fail('CAPSULE_JSON_INVALID', 'Continuation Capsule block is not valid JSON', { cause: String(error) }) }
  const validation = validateContinuationCapsule(capsule)
  if (!validation.ok) return fail('CAPSULE_INVALID', 'structured ContinuationCapsule failed validation', { errors: validation.errors, capsule })
  const anchorText = text.match(/##\s+Protected Anchors\s*([\s\S]*)$/i)?.[1] || ''
  const anchors = uniqueBounded(bulletLines(anchorText), DEFAULT_EXTRACTION_LIMITS.maxAnchors, DEFAULT_EXTRACTION_LIMITS.maxAnchorChars)
  return { ok: true, capsule, anchors }
}

export function extractAndAppendSummary(upstream, inputMessages, options = {}) {
  const extraction = extractContinuationCapsule(upstream, inputMessages, options)
  if (!extraction.ok) return extraction
  const appended = appendStructuredSummary(upstream?.summary || upstream, extraction, { ...DEFAULT_EXTRACTION_LIMITS, ...(options.limits || {}) })
  return appended.ok ? { ...extraction, summary: appended.summary } : appended
}
