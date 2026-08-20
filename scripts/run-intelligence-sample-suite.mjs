#!/usr/bin/env node
/**
 * Direct-module replay suite for compaction, task restart/resume, and
 * cross-session ranking. It uses synthetic fixtures and temporary stores;
 * formal session/memory data is never read or written.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

import { appendStructuredSummary, extractContinuationCapsule, parseStructuredCapsule } from '../extensions/dsh-compaction-v2/extractor.js'
import { TaskGraph } from '../extensions/dsh-intelligence/task-graph.js'
import { MemoryStore, normalizeMemoryInput } from '../extensions/dsh-memory/store.js'

const SAMPLE_COUNT = 20

function exactInside(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep))
}

function compactionSummary(index, values) {
  return [
    '## Primary Request and Intent',
    `- Complete migration ${values.marker}.`,
    '',
    '## Critical Context',
    `- ${values.constraint}`,
    '- 采用 append-only event log，禁止覆盖原始事件。',
    '',
    '## Current Work',
    `- Edit ${values.file}.`,
    `- Validation passed for ${values.marker}.`,
    '',
    '## Pending Jobs',
    `- Run ${values.command}.`,
    '',
    '## Next Action',
    `- ${values.command}`,
    '',
    '## Errors and Fixes',
    `- Error ${values.errorCode} was fixed and must not recur.`,
    '',
    '## Files and Code',
    `- ${values.file}`,
    '',
    '## Validation Evidence',
    `- ${values.command} passed.`,
  ].join('\n')
}

function runCompactionCases(count = SAMPLE_COUNT) {
  const started = performance.now()
  const cases = []
  for (let index = 1; index <= count; index += 1) {
    const values = {
      marker: `CASE-${String(index).padStart(2, '0')}-KEEP-${1000 + index}`,
      constraint: `必须保留当前 App UI，样本 ${index} 不得修改 client.js。`,
      file: `/workspace/case-${index}/src/parser-${index}.js`,
      command: `node tests/case-${index}.test.js`,
      errorCode: `E_CASE_${String(index).padStart(2, '0')}`,
      sourceEventId: `event:case:${index}`,
    }
    const summary = compactionSummary(index, values)
    const extracted = extractContinuationCapsule(summary, [{ role: 'user', content: [{ type: 'text', text: values.constraint }] }], {
      sessionId: `session:case:${index}`,
      taskId: `task:case:${index}`,
      projectId: `project:case:${index}`,
      sourceEventIds: [values.sourceEventId],
      protectedConstraints: [values.constraint],
      createdAt: `2026-08-20T10:${String(index).padStart(2, '0')}:00Z`,
      revision: index,
    })
    const appended = extracted.ok ? appendStructuredSummary([{ type: 'text', text: summary }], extracted) : extracted
    const parsed = appended.ok ? parseStructuredCapsule(appended.summary) : appended
    const capsule = parsed.ok ? parsed.capsule : null
    const evidence = {
      extractionOk: extracted.ok === true,
      parseOk: parsed.ok === true,
      markerRetained: Boolean(capsule?.goal?.includes(values.marker)),
      constraintRetained: capsule?.protectedConstraints?.includes(values.constraint) === true,
      pathRetained: capsule?.touchedFiles?.includes(values.file) === true,
      nextActionRetained: capsule?.nextAction === values.command,
      errorRetained: capsule?.errorsAndAttempts?.some((item) => String(item.text || '').includes(values.errorCode)) === true,
      sourceRetained: capsule?.sourceEventIds?.includes(values.sourceEventId) === true,
      revisionRetained: capsule?.revision === index,
      capsuleChars: capsule ? JSON.stringify(capsule).length : null,
    }
    cases.push({ id: `compaction-${index}`, status: Object.entries(evidence).filter(([key]) => key !== 'capsuleChars').every(([, value]) => value === true) ? 'passed' : 'failed', evidence })
  }
  return { id: 'compaction-retention', count, durationMs: Math.round((performance.now() - started) * 100) / 100, cases }
}

async function runTaskResumeCases(root, count = SAMPLE_COUNT) {
  const started = performance.now()
  const graphRoot = join(root, 'task-graph')
  const first = new TaskGraph({ rootDir: graphRoot, backend: 'jsonl' })
  for (let index = 1; index <= count; index += 1) {
    const taskId = `task:resume:${index}`
    const projectId = `project:resume:${index}`
    await first.create({ taskId, projectId, title: `恢复样本 ${index}`, objective: `验证 checkpoint/restart/resume ${index}`, protectedConstraints: [`constraint-${index}`], acceptance: [`resume-${index}`] })
    await first.checkpoint(taskId, {
      capsuleId: `capsule:resume:${index}`,
      sessionId: `session:before:${index}`,
      goal: `resume-goal-${index}`,
      protectedConstraints: [`constraint-${index}`],
      touchedFiles: [`/workspace/resume-${index}.js`],
      pendingJobs: [{ kind: 'pending', text: `pending-${index}` }],
      nextAction: `next-${index}`,
      sourceEventIds: [`event:resume:${index}`],
    }, { projectId, expectedRevision: 1 })
    await first.resume(taskId, { projectId, sessionId: `session:after:${index}`, expectedRevision: 2 })
  }
  await first.close()

  const second = new TaskGraph({ rootDir: graphRoot, backend: 'jsonl' })
  const cases = []
  for (let index = 1; index <= count; index += 1) {
    const taskId = `task:resume:${index}`
    const projectId = `project:resume:${index}`
    const projection = await second.get(taskId, { projectId })
    const events = await second.events(taskId, { projectId })
    const capsule = projection.capsules.at(-1)
    const evidence = {
      taskRestored: projection.task.taskId === taskId,
      projectIsolated: projection.projectId === projectId,
      revisionRestored: projection.revision === 3,
      sessionRestored: projection.lastSessionId === `session:after:${index}`,
      capsuleRestored: capsule?.capsuleId === `capsule:resume:${index}`,
      goalRetained: capsule?.goal === `resume-goal-${index}`,
      constraintRetained: capsule?.protectedConstraints?.includes(`constraint-${index}`) === true,
      pathRetained: capsule?.touchedFiles?.includes(`/workspace/resume-${index}.js`) === true,
      nextActionRetained: capsule?.nextAction === `next-${index}`,
      sourceRetained: capsule?.sourceEventIds?.includes(`event:resume:${index}`) === true,
      appendOnlyEvents: JSON.stringify(events.map((event) => event.type)) === JSON.stringify(['create', 'checkpoint', 'resume']),
    }
    cases.push({ id: `task-resume-${index}`, status: Object.values(evidence).every((value) => value === true) ? 'passed' : 'failed', evidence })
  }
  await second.close()
  return { id: 'task-restart-resume', count, durationMs: Math.round((performance.now() - started) * 100) / 100, cases }
}

async function runMemoryLifecycleCases(root, count = SAMPLE_COUNT) {
  const started = performance.now()
  const dbPath = join(root, 'memory', 'memory.sqlite')
  const store = new MemoryStore(dbPath)
  const staged = []
  for (let index = 1; index <= count; index += 1) {
    const scope = `project:memory:${index}`
    const key = `memory-lifecycle-${index}`
    const firstInput = normalizeMemoryInput({
      id: `memory:${index}:v1`, key, scope, kind: 'semantic', content: `alpha-${index} memory lifecycle fact version one`, source: `event:memory:${index}:1`, status: 'candidate', confidence: 0.9, sensitivity: 'normal',
    })
    const first = store.insert(firstInput)
    const hiddenBeforePromotion = store.search(`alpha-${index} lifecycle`, { scope }).length === 0
    const promotionPreview = store.promote(first.record.id, { scope, dryRun: true, reason: 'sample preview', source: 'sample-suite' })
    const promotedFirst = store.promote(first.record.id, { scope, dryRun: false, reason: 'sample approval', source: 'sample-suite' })
    const recalledFirst = store.search(`alpha-${index} lifecycle`, { scope })
    const duplicate = store.insert(normalizeMemoryInput({ ...firstInput, id: `memory:${index}:duplicate` }))
    const conflictProbe = store.insert(normalizeMemoryInput({
      id: `memory:${index}:conflict`, key, scope, kind: 'semantic', content: `alpha-${index} conflicting candidate`, source: `event:memory:${index}:conflict`, status: 'candidate', confidence: 0.5, sensitivity: 'normal',
    }))
    const second = store.insert(normalizeMemoryInput({
      id: `memory:${index}:v2`, key, scope, kind: 'semantic', content: `alpha-${index} memory lifecycle fact version two current`, source: `event:memory:${index}:2`, status: 'candidate', confidence: 1, sensitivity: 'normal', supersedes: first.record.id,
    }))
    const promotedSecond = store.promote(second.record.id, { scope, dryRun: false, reason: 'newer fact approved', source: 'sample-suite' })
    const currentRecall = store.search(`alpha-${index} version two current`, { scope })
    const forgetPreview = store.forget(second.record.id, { scope, dryRun: true })
    const forgotten = store.forget(second.record.id, { scope, dryRun: false })
    const recallAfterForget = store.search(`alpha-${index} version two current`, { scope })
    const stateEvents = store.stateEvents({ scope, limit: 10 })
    staged.push({
      index, scope, key, firstId: first.record.id, conflictId: conflictProbe.record.id, secondId: second.record.id,
      liveEvidence: {
        candidateHidden: hiddenBeforePromotion,
        promotionPreviewSafe: promotionPreview.ok === true && promotionPreview.dryRun === true && promotionPreview.event === null,
        firstPromotionAudited: promotedFirst.ok === true && promotedFirst.record.status === 'active' && promotedFirst.event?.fromStatus === 'candidate' && promotedFirst.event?.toStatus === 'active',
        firstRecallExact: recalledFirst.length === 1 && recalledFirst[0].id === first.record.id,
        duplicateDeduped: duplicate.deduped === true && duplicate.record.id === first.record.id,
        conflictDetected: conflictProbe.conflicts.includes(first.record.id),
        supersedeApplied: second.supersededIds.includes(first.record.id),
        secondPromotionAudited: promotedSecond.ok === true && promotedSecond.record.status === 'active' && promotedSecond.event?.toStatus === 'active',
        latestRecallExact: currentRecall.length === 1 && currentRecall[0].id === second.record.id,
        forgetPreviewSafe: forgetPreview.length === 1 && forgetPreview[0].status === 'active',
        forgetApplied: forgotten.length === 1 && forgotten[0].status === 'forgotten',
        forgottenExcluded: recallAfterForget.length === 0,
        stateEventsAudited: stateEvents.length === 2 && stateEvents.every((event) => event.fromStatus === 'candidate' && event.toStatus === 'active'),
        foreignScopeLeak: store.search(`alpha-${index} lifecycle`, { scope: `project:memory:foreign:${index}` }).length,
      },
    })
  }
  store.close()

  const reopened = new MemoryStore(dbPath)
  const cases = []
  for (const item of staged) {
    const rows = reopened.allRecords({ scope: item.scope, includeForgotten: true })
    const first = rows.find((row) => row.id === item.firstId)
    const conflict = rows.find((row) => row.id === item.conflictId)
    const second = rows.find((row) => row.id === item.secondId)
    const evidence = {
      ...item.liveEvidence,
      restartFirstSuperseded: first?.status === 'superseded' && Boolean(first.invalidAt),
      restartConflictCandidate: conflict?.status === 'candidate',
      restartSecondForgotten: second?.status === 'forgotten' && Boolean(second.forgottenAt),
      restartNoActiveRecall: reopened.search(`alpha-${item.index} lifecycle`, { scope: item.scope }).length === 0,
      restartStateEvents: reopened.stateEvents({ scope: item.scope, limit: 10 }).length === 2,
    }
    const passed = Object.entries(evidence).every(([key, value]) => key === 'foreignScopeLeak' ? value === 0 : value === true)
    cases.push({ id: `memory-lifecycle-${item.index}`, status: passed ? 'passed' : 'failed', evidence })
  }
  reopened.close()
  return { id: 'memory-lifecycle', count, durationMs: Math.round((performance.now() - started) * 100) / 100, cases }
}

async function runCrossSessionCases(root, count = SAMPLE_COUNT) {
  const started = performance.now()
  const previousDb = process.env.DSH_CROSS_SESSION_DB
  process.env.DSH_CROSS_SESSION_DB = join(root, 'cross-session.sqlite')
  const projectRoots = []
  const records = []
  const titles = new Map()
  for (let index = 1; index <= count; index += 1) {
    const cwd = join(root, `project-${index}`)
    await mkdir(cwd, { recursive: true })
    projectRoots.push(cwd)
    for (const suffix of ['decision', 'validation']) {
      const id = `session:${index}:${suffix}`
      records.push({ header: { id, cwd, createdAt: index, updatedAt: index + 100 } })
      titles.set(id, `alpha-${index} migration-${index} ${suffix}`)
    }
  }
  const sessionQuery = {
    async listSessions() { return records },
    async readTitle(id) { return titles.get(id) || null },
    async traceSession(id) { return { target: records.find((item) => item.header.id === id), ancestors: [], descendants: [], complete: true } },
  }
  const catalog = []
  let dispose = null
  try {
    const module = await import(`../extensions/dsh-cross-session/index.js?sample-suite=${Date.now()}`)
    await module.apply({
      tools: { register(tool) { catalog.push(tool) } },
      sessionQuery,
      get(name) { return name === 'sessionQuery' ? sessionQuery : undefined },
      provide() {},
      on() { return () => {} },
      effect(factory) { dispose = factory(); return dispose },
    })
    const related = catalog.find((tool) => tool.name === 'cross_session_related')
    if (!related) throw new Error('cross_session_related was not registered')
    const cases = []
    for (let index = 1; index <= count; index += 1) {
      const result = await related.execute({ cwd: projectRoots[index - 1], query: `alpha-${index} migration-${index}`, limit: 2 })
      const ids = result.items?.map((item) => item.id) || []
      const expected = [`session:${index}:decision`, `session:${index}:validation`]
      const relevant = expected.filter((id) => ids.includes(id)).length
      const foreign = ids.filter((id) => !expected.includes(id)).length
      const evidence = {
        ok: result.ok === true,
        recallAt2: relevant / expected.length,
        scopeLeakCount: foreign,
        exactResultCount: ids.length,
        sessionQueryUsed: result.sessionQueryUsed === true,
        cwdFilterApplied: result.sessionScope?.cwdFilterApplied === true,
        scopeComplete: result.sessionScope?.complete === true,
        allProvenanceUntrusted: result.items?.every((item) => item.provenance?.untrusted === true) === true,
        noAutoInjection: result.injection?.auto === false && result.injection?.explicitToolOnly === true,
      }
      const passed = evidence.ok && evidence.recallAt2 === 1 && evidence.scopeLeakCount === 0 && evidence.exactResultCount === 2 && evidence.sessionQueryUsed && evidence.cwdFilterApplied && evidence.scopeComplete && evidence.allProvenanceUntrusted && evidence.noAutoInjection
      cases.push({ id: `cross-session-${index}`, status: passed ? 'passed' : 'failed', evidence })
    }
    return { id: 'cross-session-ranking', count, durationMs: Math.round((performance.now() - started) * 100) / 100, cases }
  } finally {
    try { if (typeof dispose === 'function') await dispose() } catch { /* teardown */ }
    if (previousDb === undefined) delete process.env.DSH_CROSS_SESSION_DB
    else process.env.DSH_CROSS_SESSION_DB = previousDb
  }
}

function groupMetrics(group) {
  const passed = group.cases.filter((item) => item.status === 'passed').length
  const base = { total: group.cases.length, passed, failed: group.cases.length - passed, passRate: group.cases.length ? passed / group.cases.length : 0 }
  const ratio = (predicate) => group.cases.length ? group.cases.filter(predicate).length / group.cases.length : 0
  if (group.id === 'compaction-retention') return {
    ...base,
    markerRetentionRate: ratio((item) => item.evidence.markerRetained),
    constraintRetentionRate: ratio((item) => item.evidence.constraintRetained),
    pathRetentionRate: ratio((item) => item.evidence.pathRetained),
    nextActionRetentionRate: ratio((item) => item.evidence.nextActionRetained),
    errorRetentionRate: ratio((item) => item.evidence.errorRetained),
    sourceRetentionRate: ratio((item) => item.evidence.sourceRetained),
    averageCapsuleChars: Math.round(group.cases.reduce((sum, item) => sum + Number(item.evidence.capsuleChars || 0), 0) / Math.max(1, group.cases.length)),
  }
  if (group.id === 'task-restart-resume') return {
    ...base,
    restartRecoveryRate: ratio((item) => item.evidence.taskRestored && item.evidence.sessionRestored),
    capsuleExactnessRate: ratio((item) => item.evidence.capsuleRestored && item.evidence.goalRetained && item.evidence.constraintRetained && item.evidence.pathRetained && item.evidence.nextActionRetained && item.evidence.sourceRetained),
    appendOnlyEventRate: ratio((item) => item.evidence.appendOnlyEvents),
    projectIsolationRate: ratio((item) => item.evidence.projectIsolated),
  }
  if (group.id === 'memory-lifecycle') return {
    ...base,
    candidateHiddenRate: ratio((item) => item.evidence.candidateHidden),
    promotionAuditRate: ratio((item) => item.evidence.firstPromotionAudited && item.evidence.secondPromotionAudited && item.evidence.stateEventsAudited),
    dedupeRate: ratio((item) => item.evidence.duplicateDeduped),
    conflictDetectionRate: ratio((item) => item.evidence.conflictDetected),
    supersedeRate: ratio((item) => item.evidence.supersedeApplied && item.evidence.restartFirstSuperseded),
    forgetPersistenceRate: ratio((item) => item.evidence.forgetApplied && item.evidence.restartSecondForgotten && item.evidence.restartNoActiveRecall),
    scopeLeakTotal: group.cases.reduce((sum, item) => sum + Number(item.evidence.foreignScopeLeak || 0), 0),
  }
  if (group.id === 'cross-session-ranking') return {
    ...base,
    meanRecallAt2: group.cases.reduce((sum, item) => sum + Number(item.evidence.recallAt2 || 0), 0) / Math.max(1, group.cases.length),
    scopeLeakTotal: group.cases.reduce((sum, item) => sum + Number(item.evidence.scopeLeakCount || 0), 0),
    completeScopeRate: ratio((item) => item.evidence.cwdFilterApplied && item.evidence.scopeComplete),
    provenanceUntrustedRate: ratio((item) => item.evidence.allProvenanceUntrusted),
    noAutoInjectionRate: ratio((item) => item.evidence.noAutoInjection),
  }
  return base
}

export async function runSampleSuite({ count = SAMPLE_COUNT } = {}) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-intelligence-samples-'))
  const startedAt = new Date().toISOString()
  const started = performance.now()
  try {
    const groups = [
      runCompactionCases(count),
      await runTaskResumeCases(temporaryRoot, count),
      await runMemoryLifecycleCases(temporaryRoot, count),
      await runCrossSessionCases(temporaryRoot, count),
    ]
    const metrics = Object.fromEntries(groups.map((group) => [group.id, groupMetrics(group)]))
    const failed = Object.values(metrics).reduce((sum, item) => sum + item.failed, 0)
    const total = Object.values(metrics).reduce((sum, item) => sum + item.total, 0)
    return {
      schemaVersion: 1,
      kind: 'deepseek-harness-intelligence-direct-sample-suite',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      status: failed === 0 ? 'passed' : 'failed',
      ok: failed === 0,
      isolation: { syntheticFixtures: true, temporaryStores: true, formalDataRead: false, formalDataWritten: false, cleaned: true },
      summary: { total, passed: total - failed, failed, groups: groups.length, samplesPerGroup: count },
      metrics,
      groups,
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function parseArgs(argv) {
  const args = { output: null, allowedRoot: null, count: SAMPLE_COUNT }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--output') args.output = argv[++index]
    else if (token === '--allowed-root') args.allowedRoot = argv[++index]
    else if (token === '--count') args.count = Number(argv[++index])
    else if (token === '--help' || token === '-h') args.help = true
    else throw new Error(`unknown option ${token}`)
  }
  if (!Number.isSafeInteger(args.count) || args.count < 1 || args.count > 200) throw new Error('--count must be an integer from 1 to 200')
  if (Boolean(args.output) !== Boolean(args.allowedRoot)) throw new Error('--output and --allowed-root must be supplied together')
  return args
}

async function writeReport(report, args) {
  const text = `${JSON.stringify(report, null, 2)}\n`
  if (!args.output) { process.stdout.write(text); return }
  const root = await realpath(resolve(args.allowedRoot))
  const target = resolve(root, args.output)
  if (!exactInside(root, target)) throw new Error(`output escapes allowed root: ${target}`)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, text, 'utf8')
  process.stdout.write(`${JSON.stringify({ ok: report.ok, status: report.status, summary: report.summary, output: target }, null, 2)}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
    if (args.help) {
      process.stdout.write('Usage: run-intelligence-sample-suite.mjs [--count 20] [--output report.json --allowed-root DIR]\n')
    } else {
      const report = await runSampleSuite({ count: args.count })
      await writeReport(report, args)
      process.exitCode = report.ok ? 0 : 1
    }
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`)
    process.exitCode = 2
  }
}
