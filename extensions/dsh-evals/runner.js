import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { assertFixture, validateFixture } from './schemas.js'

const PACKAGE_VERSION = '0.1.0'
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ALLOWED_ROOT = join(MODULE_DIR, 'fixtures')
const DSH_ROOT = process.env.DSH_HOME || join(homedir(), '.dsh')
const DEFAULT_OUTPUT_ROOT = process.env.DSH_EVALS_ROOT || join(DSH_ROOT, 'intelligence', 'evals')
const DEFAULT_ADAPTER_MODULES = Object.freeze({
  'compaction-retention': '@local/dsh-compaction-v2/extractor',
  'memory-retrieval': '@local/dsh-memory',
  'task-resume': '@local/dsh-intelligence',
  'code-context': '@local/dsh-code-intelligence',
  'cross-session-ranking': '@local/dsh-intelligence',
  'frontend-signoff': '@local/dsh-browser',
})

const QUALITY_METRICS = Object.freeze([
  'protectedAnchorRetention',
  'pathRetention',
  'numberRetention',
  'recallAtK',
  'mrr',
  'resumeExactness',
  'contextTokenBudget',
  'candidateCompletenessHonesty',
  'frontendBlockingGate',
])

function losslessError(path, message) {
  const error = new TypeError(`non-lossless JSON at ${path}: ${message}`)
  error.code = 'NON_LOSSLESS_JSON'
  error.path = path
  return error
}

/** Strictly assert the JSON value contract used by tool output and artifacts. */
export function assertLosslessJson(value) {
  const seen = new WeakSet()
  const visit = (node, path) => {
    if (node === undefined) throw losslessError(path, 'undefined must be omitted')
    if (typeof node === 'function' || typeof node === 'symbol' || typeof node === 'bigint') throw losslessError(path, `${typeof node} is not supported`)
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return
    if (typeof node === 'number') {
      if (!Number.isFinite(node) || Object.is(node, -0)) throw losslessError(path, 'number must be finite and not -0')
      return
    }
    if (Array.isArray(node)) {
      if (seen.has(node)) throw losslessError(path, 'cyclic reference')
      seen.add(node)
      for (let index = 0; index < node.length; index += 1) {
        if (!Object.hasOwn(node, index)) throw losslessError(`${path}[${index}]`, 'sparse array item')
        visit(node[index], `${path}[${index}]`)
      }
      seen.delete(node)
      return
    }
    if (typeof node === 'object') {
      const prototype = Object.getPrototypeOf(node)
      if (prototype !== Object.prototype && prototype !== null) throw losslessError(path, 'only plain objects are supported')
      if (Object.getOwnPropertySymbols(node).length) throw losslessError(path, 'symbol keys are not supported')
      if (seen.has(node)) throw losslessError(path, 'cyclic reference')
      seen.add(node)
      for (const key of Object.keys(node)) visit(node[key], `${path}.${key}`)
      seen.delete(node)
      return
    }
    throw losslessError(path, `unsupported type ${typeof node}`)
  }
  visit(value, '$')
  return value
}

/** Clone a JSON value while deliberately omitting undefined object fields. */
export function normalizeLosslessJson(value) {
  const seen = new WeakSet()
  const normalize = (node, path, root = false) => {
    if (node === undefined) {
      if (root) return undefined
      throw losslessError(path, 'undefined array/root value cannot be normalized')
    }
    if (typeof node === 'function' || typeof node === 'symbol' || typeof node === 'bigint') throw losslessError(path, `${typeof node} is not supported`)
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return node
    if (typeof node === 'number') {
      if (!Number.isFinite(node) || Object.is(node, -0)) throw losslessError(path, 'number must be finite and not -0')
      return node
    }
    if (Array.isArray(node)) {
      if (seen.has(node)) throw losslessError(path, 'cyclic reference')
      seen.add(node)
      const output = []
      for (let index = 0; index < node.length; index += 1) {
        if (!Object.hasOwn(node, index)) throw losslessError(`${path}[${index}]`, 'sparse array item')
        output.push(normalize(node[index], `${path}[${index}]`))
      }
      seen.delete(node)
      return output
    }
    if (typeof node === 'object') {
      const prototype = Object.getPrototypeOf(node)
      if (prototype !== Object.prototype && prototype !== null) throw losslessError(path, 'only plain objects are supported')
      if (Object.getOwnPropertySymbols(node).length) throw losslessError(path, 'symbol keys are not supported')
      if (seen.has(node)) throw losslessError(path, 'cyclic reference')
      seen.add(node)
      const output = {}
      for (const key of Object.keys(node)) {
        if (node[key] === undefined) continue
        output[key] = normalize(node[key], `${path}.${key}`)
      }
      seen.delete(node)
      return output
    }
    throw losslessError(path, `unsupported type ${typeof node}`)
  }
  const normalized = normalize(value, '$', true)
  if (normalized !== undefined) assertLosslessJson(normalized)
  return normalized
}

function clone(value) { return normalizeLosslessJson(value) }

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function hashJson(value) {
  assertLosslessJson(value)
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function nowIso() { return new Date().toISOString() }
function latencyMs(start) { return Number(process.hrtime.bigint() - start) / 1_000_000 }
function asArray(value) { return Array.isArray(value) ? value : [] }
function textOf(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n')
  if (typeof value === 'object') return [value.text, value.content, value.summary].map(textOf).filter(Boolean).join('\n') || JSON.stringify(value)
  return String(value)
}

export function estimateTokens(value) {
  const text = textOf(value)
  let cjkOrEmoji = 0
  let ascii = 0
  let otherUnicode = 0
  for (const character of [...text]) {
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}\p{Regional_Indicator}]$/u.test(character)) cjkOrEmoji += 1
    else if (/^[\x00-\x7F]$/.test(character)) ascii += 1
    else otherUnicode += 1
  }
  return cjkOrEmoji + otherUnicode + Math.ceil(ascii / 4)
}

function terms(query) {
  return [...new Set(String(query || '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length >= 2))]
}

function lexicalScore(text, query) {
  const lower = String(text || '').toLowerCase()
  return terms(query).reduce((score, term) => score + Math.min(8, lower.split(term).length - 1), 0)
}

function rankCandidates(candidates, query, idKey = 'id') {
  return asArray(candidates).map((candidate, index) => ({
    candidate,
    index,
    score: Number.isFinite(candidate.score) ? candidate.score : lexicalScore(textOf(candidate.text ?? candidate.content ?? candidate), query),
  })).sort((left, right) => right.score - left.score || String(left.candidate[idKey] || '').localeCompare(String(right.candidate[idKey] || '')) || left.index - right.index)
}

function fraction(found, total) { return total === 0 ? 1 : found / total }

export function retentionMetric(actualText, expectedValues) {
  const text = String(actualText || '')
  const expected = asArray(expectedValues).map(String).filter(Boolean)
  const retained = expected.filter((value) => text.includes(value))
  return { score: fraction(retained.length, expected.length), retained, missing: expected.filter((value) => !retained.includes(value)) }
}

function exactFields(actual, expected, fields = Object.keys(expected || {})) {
  const mismatches = []
  for (const field of fields) if (JSON.stringify(actual?.[field]) !== JSON.stringify(expected?.[field])) mismatches.push(field)
  return { score: fraction(fields.length - mismatches.length, fields.length), mismatches }
}

function secretLeak(text) {
  const value = String(text || '')
  return /(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|(?:api[_ -]?key|access[_ -]?token|password)\s*[:=]\s*[^\s,;]{8,})/i.test(value) ? 1 : 0
}

function scopeLeak(candidates, input = {}, returnedIds = []) {
  const selected = asArray(candidates).filter((candidate) => returnedIds.includes(candidate.id))
  const forbidden = new Set(asArray(input.forbiddenScopes || input.forbiddenProjects).map(String))
  const allowed = input.allowedScope || input.allowedProjectId
  let leaked = 0
  for (const candidate of selected) {
    const scope = String(candidate.scope || candidate.projectId || '')
    if (forbidden.has(scope) || allowed && scope !== String(allowed)) leaked += 1
  }
  return leaked > 0 ? 1 : 0
}

function candidateCompletenessHonesty(input, expected, returnedIds) {
  const required = asArray(expected.requiredIds || expected.relevantIds || input.requiredIds).map(String)
  const candidates = asArray(input.candidateIds || expected.candidateIds).map(String)
  const returned = asArray(returnedIds).map(String)
  const requiredFound = required.filter((id) => returned.includes(id)).length
  const completeness = fraction(requiredFound, required.length)
  const claimsComplete = expected.complete === true || input.completeClaim === true
  const honest = claimsComplete && candidates.length > 0 ? (candidates.every((id) => returned.includes(id)) ? 1 : 0) : 1
  return { score: Math.min(completeness, honest), completeness, honest, required, returned }
}

function rankingMetrics(rankedIds, relevantIds, topK) {
  const relevant = new Set(asArray(relevantIds).map(String))
  const top = rankedIds.slice(0, topK)
  const hits = top.filter((id) => relevant.has(String(id)))
  const first = rankedIds.findIndex((id) => relevant.has(String(id)))
  return {
    recallAtK: fraction(hits.length, relevant.size),
    mrr: first === -1 ? (relevant.size ? 0 : 1) : 1 / (first + 1),
  }
}

function frontendMetrics(input, expected) {
  const checks = asArray(input.checks)
  const requiredIds = asArray(expected.requiredChecks || input.requiredChecks).map(String)
  const byId = new Map(checks.map((check) => [String(check.id), check]))
  const missing = requiredIds.filter((id) => !byId.has(id))
  const failed = requiredIds.filter((id) => byId.has(id) && byId.get(id).pass !== true)
  const blockingFailures = checks.filter((check) => check.blocking === true && check.pass !== true)
  const gate = missing.length === 0 && failed.length === 0 && blockingFailures.length === 0 ? 1 : 0
  const claimedGate = input.gateClaim === true || expected.gateClaim === true
  return {
    frontendBlockingGate: gate,
    frontendBlockingGateOmitted: claimedGate && missing.length > 0 ? 1 : 0,
    requiredCheckCompleteness: fraction(requiredIds.length - missing.length, requiredIds.length),
    missingChecks: missing,
    failedChecks: failed,
    blockingFailures: blockingFailures.map((check) => check.id),
  }
}

function scoreMetrics(metrics) {
  const values = QUALITY_METRICS.filter((name) => Object.hasOwn(metrics, name)).map((name) => Number(metrics[name])).filter((value) => Number.isFinite(value))
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 1
}

function compactionEvaluator(fixture) {
  const input = fixture.input || {}
  const expected = fixture.expected || {}
  const actualText = input.summary || input.actualSummary || textOf(input.messages)
  const anchor = retentionMetric(actualText, expected.protectedAnchors || input.protectedAnchors)
  const paths = retentionMetric(actualText, expected.paths || input.paths)
  const numbers = retentionMetric(actualText, expected.numbers || input.numbers)
  const tokenLimit = input.tokenBudget ?? expected.tokenBudget ?? expected.maxTokens
  const metrics = {
    protectedAnchorRetention: anchor.score,
    pathRetention: paths.score,
    numberRetention: numbers.score,
    contextTokenBudget: tokenLimit === undefined ? 1 : (estimateTokens(actualText) <= tokenLimit ? 1 : 0),
    scopeLeak: 0,
    secretLeak: secretLeak(actualText),
    candidateCompletenessHonesty: candidateCompletenessHonesty(input, expected, expected.returnedIds || input.returnedIds || []).score,
  }
  return { actual: { text: actualText }, metrics, evidence: { anchor, paths, numbers, estimatedTokens: estimateTokens(actualText), tokenBudget: tokenLimit } }
}

function retrievalEvaluator(fixture, crossSession = false) {
  const input = fixture.input || {}
  const expected = fixture.expected || {}
  const ranked = rankCandidates(crossSession ? input.sessions : input.candidates, input.query)
  const topK = Number.isSafeInteger(input.topK) && input.topK > 0 ? input.topK : ranked.length
  const returnedIds = ranked.slice(0, topK).map((item) => String(item.candidate.id))
  const ranking = rankingMetrics(returnedIds, expected.relevantIds, topK)
  const candidates = crossSession ? input.sessions : input.candidates
  const actualText = returnedIds.map((id) => candidates.find((candidate) => String(candidate.id) === id)?.text || candidates.find((candidate) => String(candidate.id) === id)?.content || '').join('\n')
  const metrics = {
    ...ranking,
    scopeLeak: scopeLeak(candidates, input, returnedIds),
    secretLeak: secretLeak(actualText),
    candidateCompletenessHonesty: candidateCompletenessHonesty(input, expected, returnedIds).score,
  }
  return { actual: { returnedIds, rankedIds: ranked.map((item) => String(item.candidate.id)), text: actualText }, metrics, evidence: { rankedIds: ranked.map((item) => ({ id: item.candidate.id, score: item.score })), relevantIds: expected.relevantIds || [] } }
}

function resumeEvaluator(fixture) {
  const input = fixture.input || {}
  const expected = fixture.expected || {}
  const actual = input.capsule || input.actual || {}
  const expectedCapsule = expected.capsule || expected
  const fields = expected.fields || Object.keys(expectedCapsule).filter((key) => key !== 'schemaVersion')
  const exact = exactFields(actual, expectedCapsule, fields)
  const serialized = JSON.stringify(actual)
  const metrics = {
    resumeExactness: exact.score,
    protectedAnchorRetention: retentionMetric(serialized, expectedCapsule.protectedConstraints).score,
    pathRetention: retentionMetric(serialized, expectedCapsule.touchedFiles).score,
    numberRetention: retentionMetric(serialized, expectedCapsule.numbers).score,
    contextTokenBudget: input.tokenBudget === undefined ? 1 : (estimateTokens(serialized) <= input.tokenBudget ? 1 : 0),
    scopeLeak: 0,
    secretLeak: secretLeak(serialized),
    candidateCompletenessHonesty: 1,
  }
  return { actual, metrics, evidence: { exact, fields } }
}

function codeContextEvaluator(fixture) {
  const input = fixture.input || {}
  const expected = fixture.expected || {}
  const ranked = rankCandidates(asArray(input.files).map((file) => ({ ...file, text: `${file.path}\n${file.content || ''}` })), input.query, 'path')
  const topK = Number.isSafeInteger(input.topK) && input.topK > 0 ? input.topK : ranked.length
  const returnedPaths = ranked.slice(0, topK).map((item) => String(item.candidate.path))
  const selected = ranked.slice(0, topK).map((item) => item.candidate)
  const text = selected.map((file) => `${file.path}\n${file.content || ''}`).join('\n')
  const requiredPaths = asArray(expected.requiredPaths).map(String)
  const path = retentionMetric(returnedPaths.join('\n'), requiredPaths)
  const requiredSymbols = asArray(expected.requiredSymbols).map(String)
  const symbols = retentionMetric(text, requiredSymbols)
  const tokenLimit = input.tokenBudget ?? expected.tokenBudget
  const metrics = {
    pathRetention: path.score,
    protectedAnchorRetention: symbols.score,
    numberRetention: retentionMetric(text, expected.numbers).score,
    contextTokenBudget: tokenLimit === undefined ? 1 : (estimateTokens(text) <= tokenLimit ? 1 : 0),
    scopeLeak: input.allowedPaths ? (returnedPaths.some((candidatePath) => !asArray(input.allowedPaths).some((allowed) => candidatePath === allowed || candidatePath.startsWith(`${allowed}/`))) ? 1 : 0) : 0,
    secretLeak: secretLeak(text),
    candidateCompletenessHonesty: candidateCompletenessHonesty(input, expected, returnedPaths).score,
  }
  return { actual: { returnedPaths, text }, metrics, evidence: { path, symbols, returnedPaths } }
}

function frontendEvaluator(fixture) {
  const input = fixture.input || {}
  const expected = fixture.expected || {}
  const gate = frontendMetrics(input, expected)
  const metrics = {
    ...gate,
    protectedAnchorRetention: 1,
    pathRetention: 1,
    numberRetention: 1,
    contextTokenBudget: 1,
    scopeLeak: 0,
    secretLeak: secretLeak(JSON.stringify(input.checks || [])),
    candidateCompletenessHonesty: gate.requiredCheckCompleteness,
  }
  return { actual: { checks: input.checks || [], gate: gate.frontendBlockingGate }, metrics, evidence: gate }
}

function evaluateBuiltin(fixture) {
  switch (fixture.taskType) {
    case 'compaction-retention': return compactionEvaluator(fixture)
    case 'memory-retrieval': return retrievalEvaluator(fixture, false)
    case 'task-resume': return resumeEvaluator(fixture)
    case 'code-context': return codeContextEvaluator(fixture)
    case 'cross-session-ranking': return retrievalEvaluator(fixture, true)
    case 'frontend-signoff': return frontendEvaluator(fixture)
    default: throw new Error(`unsupported fixture taskType ${fixture.taskType}`)
  }
}

function gateFailures(metrics) {
  const failures = []
  if (metrics.scopeLeak > 0) failures.push('scope-leak')
  if (metrics.secretLeak > 0) failures.push('secret-leak')
  if (metrics.contextTokenBudget === 0) failures.push('context-token-budget')
  if (metrics.frontendBlockingGate === 0) failures.push('frontend-blocking-gate')
  if (metrics.frontendBlockingGateOmitted > 0) failures.push('frontend-blocking-gate-omitted')
  return failures
}

function isForbiddenModuleSpecifier(specifier) {
  return /^(?:https?|data|node):/i.test(specifier)
}

async function resolveAdapter(fixture) {
  const specifier = fixture.adapterModule || DEFAULT_ADAPTER_MODULES[fixture.taskType]
  if (!specifier) return { status: 'not-configured', specifier: null }
  if (isForbiddenModuleSpecifier(specifier)) return { status: 'skipped', specifier, reason: 'network-or-runtime module specifier is forbidden' }
  try {
    const module = await import(specifier.startsWith('/') ? pathToFileURL(specifier).href : specifier)
    return { status: 'available', specifier, module, version: module.version || module.VERSION || 'unknown' }
  } catch (error) {
    return { status: 'skipped', specifier, reason: String(error?.message || error).slice(0, 400) }
  }
}

function optionalModuleInfo(adapter) {
  return {
    status: adapter.status,
    ...(adapter.specifier !== undefined ? { specifier: adapter.specifier } : {}),
    ...(adapter.version !== undefined ? { version: adapter.version } : {}),
    ...(adapter.reason !== undefined ? { reason: adapter.reason } : {}),
  }
}

function withinRoot(root, target) {
  const rel = relative(root, target)
  return rel === '' || rel === '..' || rel.startsWith(`..${resolve('/', '.')}`) || isAbsolute(rel) ? false : true
}

async function safeFixturePath(rawPath, allowedRoot) {
  const candidate = resolve(allowedRoot, rawPath)
  let rootReal
  let candidateReal
  try {
    rootReal = await realpath(allowedRoot)
    candidateReal = await realpath(candidate)
  } catch (error) {
    throw new Error(`fixture path cannot be resolved: ${String(error?.message || error)}`)
  }
  if (!withinRoot(rootReal, candidateReal)) throw new Error(`fixture path escapes allowedRoot: ${rawPath}`)
  return candidateReal
}

export async function loadFixture(options = {}) {
  if (options.fixture && typeof options.fixture === 'object') return normalizeLosslessJson(assertFixture(clone(options.fixture)))
  const allowedRoot = resolve(options.allowedRoot || DEFAULT_ALLOWED_ROOT)
  const rawPath = options.fixturePath || (options.fixtureId ? `${options.fixtureId}.json` : null)
  if (!rawPath) throw new Error('fixturePath, fixtureId, or fixture object is required')
  const path = await safeFixturePath(rawPath, allowedRoot)
  const fixture = JSON.parse(await readFile(path, 'utf8'))
  return normalizeLosslessJson(assertFixture(fixture))
}

async function runCase(fixture) {
  const started = process.hrtime.bigint()
  const adapter = await resolveAdapter(fixture)
  if (fixture.requiresModule === true && adapter.status !== 'available') {
    return {
      caseId: fixture.fixtureId,
      taskType: fixture.taskType,
      status: 'skipped',
      skipReason: adapter.reason || 'optional adapter unavailable',
      optionalModule: optionalModuleInfo(adapter),
      metrics: {},
      score: null,
      latencyMs: latencyMs(started),
    }
  }
  let evaluated
  try {
    if (adapter.status === 'available' && typeof adapter.module?.evaluateFixture === 'function') evaluated = await adapter.module.evaluateFixture(clone(fixture))
    else evaluated = evaluateBuiltin(fixture)
    evaluated = normalizeLosslessJson(evaluated)
    assertLosslessJson(evaluated)
  } catch (error) {
    return {
      caseId: fixture.fixtureId,
      taskType: fixture.taskType,
      status: 'failed',
      error: String(error?.message || error).slice(0, 1_000),
      optionalModule: optionalModuleInfo(adapter),
      metrics: { secretLeak: 0 },
      score: 0,
      latencyMs: latencyMs(started),
    }
  }
  const evaluatedMetrics = evaluated.metrics || {}
  const failures = gateFailures(evaluatedMetrics)
  const qualityScore = scoreMetrics(evaluatedMetrics)
  const correctnessFailure = qualityScore < 1 && fixture.expected?.enforceExact === true
  if (correctnessFailure) failures.push('correctness')
  return {
    caseId: fixture.fixtureId,
    taskType: fixture.taskType,
    status: failures.length ? 'failed' : 'passed',
    optionalModule: optionalModuleInfo(adapter),
    metrics: evaluatedMetrics,
    score: qualityScore,
    evidence: evaluated.evidence || {},
    actual: evaluated.actual || {},
    gateFailures: failures,
    latencyMs: latencyMs(started),
  }
}

async function writeJsonAtomic(path, value) {
  const normalized = normalizeLosslessJson(value)
  assertLosslessJson(normalized)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temporary, JSON.stringify(normalized, null, 2) + '\n', 'utf8')
  await rename(temporary, path)
}

function runFingerprint(artifact) {
  return hashJson({
    fixtureHash: artifact.fixtureHash,
    moduleVersions: artifact.moduleVersions,
    cases: artifact.cases.map((item) => ({
      caseId: item.caseId,
      taskType: item.taskType,
      status: item.status,
      metrics: item.metrics,
      ...(item.evidence !== undefined ? { evidence: item.evidence } : {}),
      ...(item.actual !== undefined ? { actual: item.actual } : {}),
      ...(item.gateFailures !== undefined ? { gateFailures: item.gateFailures } : {}),
    })),
    score: artifact.score,
    status: artifact.status,
  })
}

export async function runEvaluation(options = {}) {
  const startedAt = nowIso()
  const fixture = await loadFixture(options)
  const fixtureHash = hashJson(fixture)
  const caseResult = await runCase(fixture)
  const endedAt = nowIso()
  const runId = options.runId || `eval-${Date.now()}-${randomUUID()}`
  const status = caseResult.status === 'failed' ? 'failed' : caseResult.status === 'skipped' ? 'skipped' : 'passed'
  const score = caseResult.score
  const artifact = normalizeLosslessJson({
    schemaVersion: 1,
    runId,
    fixtureId: fixture.fixtureId,
    fixtureHash,
    fixture,
    moduleVersions: {
      runner: { name: '@local/dsh-evals', version: PACKAGE_VERSION },
      adapter: caseResult.optionalModule,
    },
    startedAt,
    endedAt,
    latencyMs: caseResult.latencyMs,
    cases: [caseResult],
    score,
    status,
    gateFailures: caseResult.gateFailures || [],
  })
  assertLosslessJson(artifact)
  artifact.fingerprint = runFingerprint(artifact)
  const outputRoot = resolve(options.outputRoot || DEFAULT_OUTPUT_ROOT)
  const artifactPath = join(outputRoot, 'runs', `${runId}.json`)
  await writeJsonAtomic(artifactPath, artifact)
  await mkdir(dirname(join(outputRoot, 'runs.index.jsonl')), { recursive: true })
  const indexRecord = normalizeLosslessJson({ runId, fixtureId: fixture.fixtureId, fixtureHash, status, score, startedAt, endedAt, artifactPath })
  assertLosslessJson(indexRecord)
  await appendFile(join(outputRoot, 'runs.index.jsonl'), JSON.stringify(indexRecord) + '\n', 'utf8')
  const result = normalizeLosslessJson({ ...artifact, artifactPath })
  assertLosslessJson(result)
  return result
}

async function loadRun(runId, outputRoot) {
  const path = join(resolve(outputRoot || DEFAULT_OUTPUT_ROOT), 'runs', `${runId}.json`)
  const artifact = normalizeLosslessJson(JSON.parse(await readFile(path, 'utf8')))
  assertLosslessJson(artifact)
  return artifact
}

function compareCase(baseline, candidate) {
  const regressions = []
  const issues = []
  if (!candidate) return { regressions: ['candidate-case-missing'], issues: ['candidate-case-missing'] }
  if (candidate.status === 'skipped' && baseline.status !== 'skipped') regressions.push('candidate-skipped')
  for (const name of QUALITY_METRICS) {
    const before = baseline.metrics?.[name]
    const after = candidate.metrics?.[name]
    if (typeof before !== 'number' || typeof after !== 'number') continue
    if (after + 1e-12 < before) regressions.push(`${name}-decrease`)
  }
  if ((candidate.metrics?.scopeLeak || 0) > 0) issues.push('scope-leak')
  if ((candidate.metrics?.secretLeak || 0) > 0) issues.push('secret-leak')
  if ((candidate.metrics?.frontendBlockingGateOmitted || 0) > 0) issues.push('frontend-blocking-gate-omitted')
  if ((candidate.metrics?.frontendBlockingGate || 1) === 0 && baseline.metrics?.frontendBlockingGate === 1) issues.push('frontend-blocking-gate')
  return { regressions, issues }
}

export async function compareEvaluations(options = {}) {
  const outputRoot = resolve(options.outputRoot || DEFAULT_OUTPUT_ROOT)
  const baseline = options.baseline && typeof options.baseline === 'object' ? normalizeLosslessJson(options.baseline) : await loadRun(options.baselineRunId, outputRoot)
  const candidate = options.candidate && typeof options.candidate === 'object' ? normalizeLosslessJson(options.candidate) : await loadRun(options.candidateRunId, outputRoot)
  assertLosslessJson(baseline)
  assertLosslessJson(candidate)
  const byId = new Map(candidate.cases.map((item) => [item.caseId, item]))
  const regressions = []
  const issues = []
  const caseResults = []
  for (const baseCase of baseline.cases) {
    const compared = compareCase(baseCase, byId.get(baseCase.caseId))
    regressions.push(...compared.regressions.map((item) => `${baseCase.caseId}:${item}`))
    issues.push(...compared.issues.map((item) => `${baseCase.caseId}:${item}`))
    caseResults.push({ caseId: baseCase.caseId, ...compared })
  }
  const result = {
    schemaVersion: 1,
    compareId: `compare-${Date.now()}-${randomUUID()}`,
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    baselineFingerprint: baseline.fingerprint,
    candidateFingerprint: candidate.fingerprint,
    scoreDelta: (candidate.score ?? 0) - (baseline.score ?? 0),
    regressions,
    issues,
    cases: caseResults,
    status: regressions.length || issues.length ? 'failed' : 'passed',
    comparedAt: nowIso(),
  }
  const normalized = normalizeLosslessJson(result)
  assertLosslessJson(normalized)
  await writeJsonAtomic(join(outputRoot, 'compares', `${normalized.compareId}.json`), normalized)
  return normalized
}

export async function listEvaluations(options = {}) {
  const outputRoot = resolve(options.outputRoot || DEFAULT_OUTPUT_ROOT)
  let text = ''
  try { text = await readFile(join(outputRoot, 'runs.index.jsonl'), 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const records = normalizeLosslessJson(text.split('\n').filter(Boolean).map((line) => JSON.parse(line)).reverse())
  assertLosslessJson(records)
  const result = records.slice(0, Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 100)
  assertLosslessJson(result)
  return result
}

export const DEFAULTS = Object.freeze({ DEFAULT_ALLOWED_ROOT, DEFAULT_OUTPUT_ROOT, DEFAULT_ADAPTER_MODULES })
