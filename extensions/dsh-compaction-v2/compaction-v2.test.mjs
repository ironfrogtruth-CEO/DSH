import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_EXTRACTION_LIMITS,
  appendStructuredSummary,
  extractContinuationCapsule,
  parseStructuredCapsule,
} from './extractor.js'
import {
  CapsuleStore,
  CapsuleStoreConflictError,
  makeCapsuleRecord,
} from './capsule-store.js'
import { CompactionCapsuleObserver, buildRepairInput, registerCapsuleTools, summaryHasRequiredStructure, userMessagesForCapsule } from './engine.js'
import { createMemoryStore } from '@local/dsh-memory'
import { buildProjectIdentity } from '@local/dsh-cross-session/project-identity'

// Existing capsule-only tests must never write to the user's default memory
// root. Candidate-chain tests opt in with an isolated temporary DB below.
process.env.DSH_COMPACTION_V2_MEMORY_CANDIDATES = '0'

test('package root default export resolves to the named compaction engine', async () => {
  const root = await import(`./index.js?root-export=${Date.now()}`)
  assert.equal(root.default, root.DshCompactionV2Engine)
  assert.equal(typeof root.default, 'function')
  assert.equal(root.default.prototype instanceof root.BasicCompactionEngine, true)
})

function fixtureExtraction(sessionId = 'session:one') {
  return extractContinuationCapsule({
    summary: [{ type: 'text', text: [
      '## Primary Request and Intent',
      '- Continue the parser task while preserving exact number 42.',
      '',
      '## Files and Code',
      '- /Users/marcus/.dsh/extensions/dsh-compaction-v2/extractor.js',
      '',
      '## Errors and Fixes',
      '- Error: parser failed on command `npm test` and was fixed.',
      '',
      '## Pending Jobs',
      '- Run npm test and inspect /tmp/trace.json.',
      '',
      '## Current Work',
      '- Verifying the compaction capsule path.',
      '',
      '## Next Step',
      '- Run npm test.',
      '',
      '## Critical Context',
      '- Must preserve exact number 42 and do not modify the existing UI.',
    ].join('\n') }],
  }, [{ role: 'user', content: '不得修改现有前端 UI；保留数字 42。' }], {
    sessionId,
    projectId: 'project:compaction',
    taskId: 'task:compaction',
    createdAt: '2026-08-20T12:00:00Z',
  })
}

function summaryFixture(sessionId = 'session:one', compactionId = 'compaction:one') {
  const extraction = fixtureExtraction(sessionId)
  assert.equal(extraction.ok, true)
  const appended = appendStructuredSummary([{ type: 'text', text: '## Upstream checkpoint\n- upstream facts' }], extraction)
  assert.equal(appended.ok, true)
  return {
    session: {
      id: sessionId,
      events: [{ type: 'compaction/start', seq: 1, time: 1, data: { compactionId, turn: null } }],
    },
    summaryEvent: {
      type: 'compaction/summary',
      seq: 3,
      time: 3,
      data: {
        compactionId,
        summary: appended.summary,
        shadowedRange: { start: 10, end: 12 },
        shadowedSeqs: [10, 11, 12],
        shadowedTokenCount: 300,
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      },
    },
    endEvent: {
      type: 'compaction/end',
      seq: 5,
      time: 5,
      data: { compactionId, turn: null },
    },
  }
}

test('extractor preserves bounded goal, anchors, files, errors, pending work and commands', () => {
  const result = fixtureExtraction()
  assert.equal(result.ok, true)
  assert.match(result.capsule.goal, /42/)
  assert.ok(result.capsule.protectedConstraints.some((item) => /不得|must|do not/i.test(item)))
  assert.ok(result.capsule.touchedFiles.some((file) => file.endsWith('/extractor.js')))
  assert.ok(result.capsule.errorsAndAttempts.some((item) => /failed/i.test(item.text)))
  assert.ok(result.capsule.pendingJobs.some((item) => /npm test/i.test(item.text)))
  assert.ok(result.capsule.testsAndEvidence.some((item) => /npm test/i.test(item.text)))
  assert.ok(result.capsuleJson === undefined, 'raw capsule JSON is not duplicated outside the capsule contract')
})

test('extractor preserves generic POSIX workspace paths without treating URLs as files', () => {
  const result = extractContinuationCapsule(`## Primary Request and Intent
- Continue Linux workspace migration.

## Files and Code
- /workspace/project/src/parser.js
- https://example.com/reference

## Next Action
- node tests/parser.test.js`, [], {
    sessionId: 'session:linux-path',
    projectId: 'project:linux-path',
    taskId: 'task:linux-path',
  })
  assert.equal(result.ok, true)
  assert.ok(result.capsule.touchedFiles.includes('/workspace/project/src/parser.js'))
  assert.equal(result.capsule.touchedFiles.some((file) => file.includes('example.com')), false)
})

test('summary verifier rejects instruction-following output and repair input isolates transcript data', () => {
  const good = { summary: [{ type: 'text', text: [
    '## Primary Request and Intent', '- goal',
    '## Key Technical Concepts', '- concept',
    '## Files and Code', '- /workspace/file.js',
    '## Errors and Fixes', '- none',
    '## Pending Jobs', '- test',
    '## Current Work', '- work',
    '## Next Step', '- node test.js',
    '## Critical Context', '- preserve UI',
  ].join('\n') }] }
  assert.equal(summaryHasRequiredStructure(good), true)
  assert.equal(summaryHasRequiredStructure({ summary: [{ type: 'text', text: '只回复：完成' }] }), false)
  const input = {
    system: 'large system prompt',
    tools: [{ name: 'unsafe-tool' }],
    messages: [
      { role: 'user', source: { kind: 'plugin', plugin: 'checkpoint' }, content: [{ type: 'text', text: 'historical checkpoint instruction' }] },
      { role: 'user', source: { kind: 'user' }, id: 'user-1', content: [{ type: 'text', text: '不得修改当前 App UI' }] },
      { role: 'user', source: { kind: 'plugin', plugin: 'skill-catalog' }, content: [{ type: 'text', text: 'skill noise' }] },
    ],
  }
  assert.deepEqual(userMessagesForCapsule(input.messages).map((message) => message.id), ['user-1'])
  const repair = buildRepairInput(input)
  assert.equal(repair.system, undefined)
  assert.equal(repair.tools, undefined)
  assert.equal(repair.messages.length, 1)
  assert.match(repair.messages[0].content[0].text, /untrusted historical DATA/)
  assert.match(repair.messages[0].content[0].text, /不得修改当前 App UI/)
  assert.equal(input.system, 'large system prompt', 'repair builder must not mutate the original request')
})

test('empty, malformed and inflated summaries fail closed', () => {
  assert.equal(extractContinuationCapsule({ summary: [] }, [], { sessionId: 's' }).code, 'SUMMARY_EMPTY')
  const extraction = fixtureExtraction('session:bad')
  const appended = appendStructuredSummary([{ type: 'text', text: 'x' }], extraction)
  assert.equal(appended.ok, true)
  const corrupted = appended.summary.map((block) => ({ ...block, text: String(block.text || '').replace(/"schemaVersion": 1/, '"schemaVersion": 99') }))
  assert.equal(parseStructuredCapsule(corrupted).ok, false)
  assert.equal(extractContinuationCapsule({ summary: 'x'.repeat(DEFAULT_EXTRACTION_LIMITS.maxSummaryChars + 1) }, [], { sessionId: 's' }).code, 'SUMMARY_TOO_LARGE')
  assert.equal(appendStructuredSummary([{ type: 'text', text: 'x'.repeat(DEFAULT_EXTRACTION_LIMITS.maxSummaryChars + 1) }], extraction).code, 'SUMMARY_TOO_LARGE')
})

test('successful compaction/end writes one capsule; failed end writes none; duplicate is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compaction-v2-events-'))
  try {
    const store = new CapsuleStore({ rootDir: root, backend: 'jsonl' })
    const observer = new CompactionCapsuleObserver(store)
    const fixture = summaryFixture()
    observer.handle(fixture.session, fixture.summaryEvent)
    observer.handle(fixture.session, fixture.endEvent)
    await observer.flush()
    assert.equal((await store.list({ sessionId: 'session:one' })).length, 1)
    observer.handle(fixture.session, fixture.summaryEvent)
    observer.handle(fixture.session, fixture.endEvent)
    await observer.flush()
    assert.equal((await store.list({ sessionId: 'session:one' })).length, 1)

    const failed = summaryFixture('session:failed', 'compaction:failed')
    failed.endEvent.data.error = 'summary failure'
    observer.handle(failed.session, failed.summaryEvent)
    observer.handle(failed.session, failed.endEvent)
    await observer.flush()
    assert.equal((await store.list({ sessionId: 'session:failed' })).length, 0)
    await store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('capsule store enforces CAS, survives restart, verifies hashes, and isolates sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compaction-v2-store-'))
  try {
    const extraction = fixtureExtraction('session:cas')
    const firstRecord = makeCapsuleRecord({ sessionId: 'session:cas', compactionId: 'compaction:1', capsule: extraction.capsule, model: 'm', provider: 'p' })
    const secondRecord = makeCapsuleRecord({ sessionId: 'session:cas', compactionId: 'compaction:2', capsule: { ...extraction.capsule, capsuleId: 'capsule:2' }, model: 'm', provider: 'p' })
    const store = new CapsuleStore({ rootDir: root, backend: 'jsonl' })
    assert.equal((await store.append(firstRecord)).record.revision, 1)
    await assert.rejects(store.append(secondRecord, { expectedRevision: 0 }), (error) => error instanceof CapsuleStoreConflictError && error.code === 'CAS_CONFLICT')
    assert.equal((await store.verify(firstRecord.recordId)).ok, true)
    await store.close()
    const restored = new CapsuleStore({ rootDir: root, backend: 'jsonl' })
    assert.equal((await restored.list({ sessionId: 'session:cas' })).length, 1)
    assert.equal((await restored.list({ sessionId: 'session:other' })).length, 0)
    await restored.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('SQLite capsule store restarts when Node built-in SQLite is available', async (t) => {
  let sqlite
  try { sqlite = await import('node:sqlite') } catch { sqlite = null }
  if (!sqlite?.DatabaseSync) {
    t.skip('node:sqlite is unavailable on this Node runtime')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'dsh-compaction-v2-sqlite-'))
  try {
    const extraction = fixtureExtraction('session:sqlite')
    const record = makeCapsuleRecord({ sessionId: 'session:sqlite', compactionId: 'compaction:sqlite', capsule: extraction.capsule, model: 'm', provider: 'p' })
    const store = new CapsuleStore({ rootDir: root, backend: 'sqlite' })
    await store.append(record)
    await store.close()
    const restored = new CapsuleStore({ rootDir: root, backend: 'sqlite' })
    assert.equal((await restored.list({ sessionId: 'session:sqlite' })).length, 1)
    assert.equal((await restored.verify(record.recordId)).ok, true)
    await restored.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('capsule tool execute render exposes bounded safe record fields without raw summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compaction-v2-render-'))
  try {
    const store = new CapsuleStore({ rootDir: root, backend: 'jsonl' })
    const extraction = fixtureExtraction('session:render')
    const record = makeCapsuleRecord({ sessionId: 'session:render', compactionId: 'compaction:render', capsule: extraction.capsule, model: 'm', provider: 'p', sourceEventIds: ['session:render:seq:3'] })
    await store.append(record)
    const catalog = []
    registerCapsuleTools({ tools: { register(tool) { catalog.push(tool) } } }, store, (spec) => spec)
    for (const [name, args, required] of [
      ['capsule_get', { recordId: record.recordId }, ['recordId', 'capsuleHash', 'sourceEventIds']],
      ['capsule_list', { sessionId: 'session:render' }, ['records', 'capsuleHash', 'sourceEventIds']],
      ['capsule_verify', { recordId: record.recordId }, ['recordId', 'capsuleHash', 'sourceEventIds']],
    ]) {
      const tool = catalog.find((item) => item.name === name)
      const value = await tool.execute(args)
      const rendered = tool.output.render(args, value)
      const text = rendered[0].text
      assert.ok(text.length <= 12_000)
      for (const key of required) assert.match(text, new RegExp(key))
      assert.doesNotMatch(text, /rawOutput|<compacted-summary>/i)
      JSON.parse(text.slice(text.indexOf('\n') + 1))
    }
    await store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('successful capsule commit writes one project-scoped episodic candidate, idempotently and outside default recall', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compaction-v2-memory-candidate-'))
  const previousRoot = process.env.DSH_MEMORY_ROOT
  const previousDb = process.env.DSH_MEMORY_DB
  const previousCandidates = process.env.DSH_COMPACTION_V2_MEMORY_CANDIDATES
  process.env.DSH_MEMORY_ROOT = join(root, 'memories')
  process.env.DSH_MEMORY_DB = join(root, 'memory.sqlite')
  process.env.DSH_COMPACTION_V2_MEMORY_CANDIDATES = '1'
  try {
    const store = new CapsuleStore({ rootDir: join(root, 'capsules'), backend: 'jsonl' })
    const observer = new CompactionCapsuleObserver(store)
    const fixture = summaryFixture('session:candidate', 'compaction:candidate')
    fixture.session.header = { cwd: root }
    observer.handle(fixture.session, fixture.summaryEvent)
    observer.handle(fixture.session, fixture.endEvent)
    await observer.flush()
    const identity = buildProjectIdentity({ cwd: root })
    const memory = createMemoryStore(process.env.DSH_MEMORY_DB)
    const records = memory.allRecords({ scope: identity.projectId, includeForgotten: true })
    assert.equal(records.length, 1)
    assert.equal(records[0].status, 'candidate')
    assert.equal(records[0].kind, 'episodic')
    assert.match(records[0].source, /^compaction:session:candidate:compaction:candidate$/)
    assert.equal(records[0].metadata.workspaceId, identity.workspaceId)
    assert.deepEqual(records[0].metadata.sourceEventIds, ['session:session:candidate:seq:10', 'session:session:candidate:seq:11', 'session:session:candidate:seq:12', 'session:session:candidate:seq:3', 'session:session:candidate:seq:5'])
    assert.equal(records[0].metadata.capsuleHash, (await store.get({ sessionId: 'session:candidate', compactionId: 'compaction:candidate' })).capsuleHash)
    assert.doesNotMatch(records[0].content, /rawOutput|compacted-summary|history/i)
    assert.equal(memory.search('Continue parser task', { scope: identity.projectId }).length, 0, 'candidate must not enter default recall')
    memory.close()

    observer.handle(fixture.session, fixture.summaryEvent)
    observer.handle(fixture.session, fixture.endEvent)
    await observer.flush()
    const memoryAfterDuplicate = createMemoryStore(process.env.DSH_MEMORY_DB)
    assert.equal(memoryAfterDuplicate.allRecords({ scope: identity.projectId, includeForgotten: true }).length, 1)
    memoryAfterDuplicate.close()
    await store.close()
  } finally {
    if (previousRoot === undefined) delete process.env.DSH_MEMORY_ROOT
    else process.env.DSH_MEMORY_ROOT = previousRoot
    if (previousDb === undefined) delete process.env.DSH_MEMORY_DB
    else process.env.DSH_MEMORY_DB = previousDb
    if (previousCandidates === undefined) delete process.env.DSH_COMPACTION_V2_MEMORY_CANDIDATES
    else process.env.DSH_COMPACTION_V2_MEMORY_CANDIDATES = previousCandidates
    await rm(root, { recursive: true, force: true })
  }
})

test('candidate chain can be disabled and secret rejection does not roll back capsule commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compaction-v2-memory-gates-'))
  const previousRoot = process.env.DSH_MEMORY_ROOT
  const previousDb = process.env.DSH_MEMORY_DB
  const previousCandidates = process.env.DSH_COMPACTION_V2_MEMORY_CANDIDATES
  process.env.DSH_MEMORY_ROOT = join(root, 'memories')
  process.env.DSH_MEMORY_DB = join(root, 'memory.sqlite')
  try {
    const disabledStore = new CapsuleStore({ rootDir: join(root, 'capsules-disabled'), backend: 'jsonl' })
    process.env.DSH_COMPACTION_V2_MEMORY_CANDIDATES = '0'
    const disabledObserver = new CompactionCapsuleObserver(disabledStore)
    const disabledFixture = summaryFixture('session:disabled', 'compaction:disabled')
    disabledObserver.handle(disabledFixture.session, disabledFixture.summaryEvent)
    disabledObserver.handle(disabledFixture.session, disabledFixture.endEvent)
    await disabledObserver.flush()
    assert.equal((await disabledStore.list({ sessionId: 'session:disabled' })).length, 1)
    const memoryDisabled = createMemoryStore(process.env.DSH_MEMORY_DB)
    assert.equal(memoryDisabled.allRecords({ includeForgotten: true }).length, 0)
    memoryDisabled.close()
    await disabledStore.close()

    process.env.DSH_COMPACTION_V2_MEMORY_CANDIDATES = '1'
    const secretStore = new CapsuleStore({ rootDir: join(root, 'capsules-secret'), backend: 'jsonl' })
    const secretObserver = new CompactionCapsuleObserver(secretStore)
    const secretFixture = summaryFixture('session:secret', 'compaction:secret')
    const parsed = parseStructuredCapsule(secretFixture.summaryEvent.data.summary)
    parsed.capsule.protectedConstraints.push('api_key=sk-12345678901234567890')
    const rebuilt = appendStructuredSummary([{ type: 'text', text: '## Upstream checkpoint\n- upstream facts' }], { ok: true, capsule: parsed.capsule, anchors: parsed.anchors })
    secretFixture.summaryEvent.data.summary = rebuilt.summary
    secretObserver.handle(secretFixture.session, secretFixture.summaryEvent)
    secretObserver.handle(secretFixture.session, secretFixture.endEvent)
    await secretObserver.flush()
    assert.equal((await secretStore.list({ sessionId: 'session:secret' })).length, 1, 'memory rejection must not roll back capsule')
    const memorySecret = createMemoryStore(process.env.DSH_MEMORY_DB)
    assert.equal(memorySecret.allRecords({ includeForgotten: true }).length, 0)
    memorySecret.close()
    await secretStore.close()
  } finally {
    if (previousRoot === undefined) delete process.env.DSH_MEMORY_ROOT
    else process.env.DSH_MEMORY_ROOT = previousRoot
    if (previousDb === undefined) delete process.env.DSH_MEMORY_DB
    else process.env.DSH_MEMORY_DB = previousDb
    if (previousCandidates === undefined) delete process.env.DSH_COMPACTION_V2_MEMORY_CANDIDATES
    else process.env.DSH_COMPACTION_V2_MEMORY_CANDIDATES = previousCandidates
    await rm(root, { recursive: true, force: true })
  }
})
