import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createCrossSessionStore, CrossSessionError } from './store.js'
import { buildProjectIdentity, resolveProjectIdentity } from './project-identity.js'
import { normalizeTrace, SessionQueryAdapter } from './session-adapter.js'

function fakeQuery(root) {
  let readSessionCalls = 0
  const records = [
    { header: { id: 's-root', cwd: root, createdAt: 1, updatedAt: 4 } },
    { header: { id: 's-child', cwd: root, parentSession: 's-root', createdAt: 2, updatedAt: 5 } },
    { header: { id: 's-other', cwd: join(root, '..', 'other-project'), createdAt: 3, updatedAt: 6 } },
  ]
  const titles = { 's-root': '初始化项目架构', 's-child': '继续实现任务图', 's-other': '隔离项目任务' }
  const service = {
    async listSessions() { return records },
    async readTitle(id) { return titles[id] },
    async traceSession(id) {
      const target = records.find((item) => item.header.id === id)
      const parent = target?.header.parentSession ? records.find((item) => item.header.id === target.header.parentSession) : null
      return { target, ancestors: parent ? [parent] : [], descendants: id === 's-root' ? [records[1]] : [], complete: true, root: parent || target }
    },
    async readSession() { readSessionCalls += 1; throw new Error('rebuild must not read full session') },
  }
  return { service, get readSessionCalls() { return readSessionCalls } }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cross-session-'))
  process.env.DSH_CROSS_SESSION_DB = join(root, 'cross.sqlite')
  const fake = fakeQuery(root)
  // Self-reference import exercises the package root exports as Cordis will.
  const module = await import('@local/dsh-cross-session')
  const catalog = []
  let intelligenceCloseCalls = 0
  const fakeIntelligence = {
    createStore() {
      return {
        async list() {
          return [{
            projectId: 'placeholder',
            task: { taskId: 'task-1', title: '继续实现任务图', objective: '恢复跨会话工作' },
            capsules: [{ capsuleId: 'capsule-1', taskId: 'task-1', nextAction: '先读取最新检查点', revision: 2 }],
            revision: 2,
          }]
        },
        async close() { intelligenceCloseCalls += 1 },
      }
    },
  }
  let dispose
  const values = {
    sessionQuery: fake.service,
    tools: { register(tool) { catalog.push(tool) } },
    get(name) { return name === 'sessionQuery' ? fake.service : name === 'dshIntelligence' ? fakeIntelligence : undefined },
    provide() {},
    on() { return () => {} },
    effect(factory) { dispose = factory(); return dispose },
  }
  const strictCtx = new Proxy(values, { get(target, property) { if (property in target) return target[property]; throw new Error(`unexpected ctx property: ${String(property)}`) } })
  await module.apply(strictCtx)
  return { root, fake, module, dispose, get intelligenceCloseCalls() { return intelligenceCloseCalls }, tool(name) { return catalog.find((item) => item.name === name) } }
}

async function cleanup(root, dispose = null) {
  try { if (typeof dispose === 'function') dispose() } catch { /* test teardown */ }
  delete process.env.DSH_CROSS_SESSION_DB
  await rm(root, { recursive: true, force: true })
}

test('strict Cordis-like ctx accepts package-root apply without undeclared property access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cross-strict-'))
  process.env.DSH_CROSS_SESSION_DB = join(root, 'cross.sqlite')
  const module = await import('@local/dsh-cross-session')
  const tools = []
  const fakeSessionQuery = {
    async listSessions() { return [] },
    async readTitle() { return null },
    async traceSession() { return { target: { header: { id: 'none' } }, ancestors: [], descendants: [], complete: false } },
  }
  let dispose
  const values = {
    sessionQuery: fakeSessionQuery,
    tools: { register(tool) { tools.push(tool) } },
    get(name) { return name === 'sessionQuery' ? fakeSessionQuery : undefined },
    provide() {},
    on() { return () => {} },
    effect(factory) { dispose = factory(); return dispose },
  }
  const strictCtx = new Proxy(values, { get(target, property) { if (property in target) return target[property]; throw new Error(`unexpected ctx property: ${String(property)}`) } })
  try {
    await module.apply(strictCtx)
    assert.equal(tools.length, 4)
  } finally {
    if (typeof dispose === 'function') dispose()
    delete process.env.DSH_CROSS_SESSION_DB
    await rm(root, { recursive: true, force: true })
  }
})

test('project identity is deterministic and no-remote identity remains stable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cross-project-'))
  try {
    const second = resolveProjectIdentity({ cwd: root, branch: 'main', worktree: 'wt-a' })
    const first = buildProjectIdentity({ cwd: second.canonicalCwd, branch: 'main', worktree: 'wt-a' })
    assert.equal(first.projectId, second.projectId)
    assert.equal(first.remotePresent, false)
    assert.equal(first.stable, true)
    const feature = buildProjectIdentity({ cwd: second.canonicalCwd, branch: 'feature', worktree: 'wt-a' })
    assert.equal(first.projectId, feature.projectId)
    assert.notEqual(first.workspaceId, feature.workspaceId)
    const remoteMain = buildProjectIdentity({ cwd: '/workspace/repo', gitRemote: 'git@github.com:org/repo.git', branch: 'main', worktree: 'main' })
    const remoteFeature = buildProjectIdentity({ cwd: '/workspace/repo-feature', gitRemote: 'https://github.com/org/repo.git', branch: 'feature', worktree: 'feature' })
    assert.equal(remoteMain.projectId, remoteFeature.projectId)
    assert.notEqual(remoteMain.workspaceId, remoteFeature.workspaceId)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('SQLite append-only event projection supports idempotency, CAS and restart persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cross-store-'))
  const path = join(root, 'store.sqlite')
  try {
    const store = createCrossSessionStore(path)
    const first = store.appendEntityEvent({ eventType: 'task/index', entityType: 'task', entityId: 't1', projectId: 'project:p', payload: { title: 'one' }, idempotencyKey: 'event-1' })
    assert.equal(first.deduped, false)
    assert.equal(first.projection.revision, 1)
    assert.equal(store.appendEntityEvent({ eventType: 'task/index', entityType: 'task', entityId: 't1', projectId: 'project:p', payload: { title: 'one' }, idempotencyKey: 'event-1' }).deduped, true)
    assert.throws(() => store.appendEntityEvent({ eventType: 'task/update', entityType: 'task', entityId: 't1', projectId: 'project:p', payload: { title: 'two' }, expectedRevision: 0 }), (error) => error instanceof CrossSessionError && error.code === 'CAS_CONFLICT')
    const second = store.appendEntityEvent({ eventType: 'task/update', entityType: 'task', entityId: 't1', projectId: 'project:p', payload: { title: 'two' }, expectedRevision: 1, idempotencyKey: 'event-2' })
    assert.equal(second.projection.revision, 2)
    assert.equal(store.listEvents({ projectId: 'project:p', entityType: 'task', entityId: 't1' }).length, 2)
    store.close()
    const reopened = createCrossSessionStore(path)
    try { assert.equal(reopened.getProjection('task', 't1', 'project:p').payload.title, 'two') } finally { reopened.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('fake sessionQuery rebuild is dry-run by default, project-isolated and never reads full content', async () => {
  const { root, fake, tool, module, dispose } = await fixture()
  try {
    const preview = await tool('cross_session_rebuild').execute({ cwd: root })
    assert.equal(preview.ok, true)
    assert.equal(preview.dryRun, true)
    assert.equal(preview.count, 2)
    assert.equal(preview.readSessionCalls, 0)
    assert.ok(preview.project.workspaceId)
    const renderedPreview = JSON.parse(tool('cross_session_rebuild').output.render({}, preview)[0].text)
    assert.equal(renderedPreview.dryRun, true)
    assert.equal(renderedPreview.count, 2)
    assert.equal(renderedPreview.readSessionCalls, 0)
    assert.equal(fake.readSessionCalls, 0)
    const written = await tool('cross_session_rebuild').execute({ cwd: root, dryRun: false })
    assert.equal(written.ok, true)
    assert.equal(written.indexed, 2)
    assert.equal(written.relations, 1)
    assert.equal(fake.readSessionCalls, 0)
    const store = module.createCrossSessionStore(process.env.DSH_CROSS_SESSION_DB)
    try {
      const sessions = store.listEntities({ projectId: resolveProjectIdentity({ cwd: root }).projectId, entityType: 'session' })
      assert.equal(sessions.length, 2)
      assert.equal(sessions[0].payload.contentIndexed, false)
      assert.equal(sessions[0].payload.untrusted, true)
    } finally { store.close() }
  } finally { await cleanup(root, dispose) }
})

test('associate/related/resume return explainable provenance and never auto-inject', async () => {
  const fixtureValue = await fixture()
  const { root, tool, dispose } = fixtureValue
  try {
    const project = resolveProjectIdentity({ cwd: root }).projectId
    const task = createCrossSessionStore(process.env.DSH_CROSS_SESSION_DB)
    task.appendEntityEvent({ eventType: 'task/create', entityType: 'task', entityId: 'task-1', projectId: project, payload: { title: '继续实现任务图', objective: '恢复跨会话工作', nextActions: ['运行测试'] }, idempotencyKey: 'task-create' })
    task.close()
    const associated = await tool('cross_session_associate').execute({ projectId: project, relation: 'produces', fromType: 'task', fromId: 'task-1', toType: 'artifact', toId: 'artifact-1', source: 'explicit-test', evidence: { path: 'out.txt' } })
    assert.equal(associated.ok, true)
    assert.equal(associated.relation.relationType, 'produces')
    const renderedAssociate = JSON.parse(tool('cross_session_associate').output.render({}, associated)[0].text)
    assert.equal(renderedAssociate.relation.revision, 1)
    assert.equal(renderedAssociate.event.revision, 1)
    const taskContinuation = await tool('cross_session_associate').execute({ projectId: project, relation: 'continues', fromType: 'session', fromId: 's-child', toType: 'task', toId: 'task-1', source: 'explicit-test' })
    assert.equal(taskContinuation.ok, true)
    const checkpointRelation = await tool('cross_session_associate').execute({ projectId: project, relation: 'resumes_at', fromType: 'checkpoint', fromId: 'checkpoint-1', toType: 'session', toId: 's-child', source: 'explicit-test' })
    assert.equal(checkpointRelation.ok, true)
    const checkpointTask = await tool('cross_session_associate').execute({ projectId: project, relation: 'resumes_at', fromType: 'checkpoint', fromId: 'checkpoint-1', toType: 'task', toId: 'task-1', source: 'explicit-test' })
    assert.equal(checkpointTask.ok, true)
    const related = await tool('cross_session_related').execute({ cwd: root, sessionId: 's-child', query: '任务图', limit: 10 })
    assert.equal(related.ok, true)
    assert.ok(related.items.some((item) => item.explain.some((factor) => factor.factor === 'lineage')))
    assert.ok(related.items.every((item) => item.provenance.untrusted === true))
    const renderedRelated = JSON.parse(tool('cross_session_related').output.render({}, related)[0].text)
    assert.ok(Array.isArray(renderedRelated.items))
    assert.ok(renderedRelated.items.some((item) => Array.isArray(item.explain) && item.provenance.untrusted === true))
    assert.equal(renderedRelated.sessionScope.cwdFilterApplied, true)
    const projectOnly = await tool('cross_session_related').execute({ projectId: project, query: '任务图', limit: 10 })
    assert.equal(projectOnly.ok, true)
    assert.equal(projectOnly.sessionScope.cwdFilterApplied, false)
    assert.match(projectOnly.sessionScope.note, /projectId-only/)
    const resumed = await tool('cross_session_resume_context').execute({ projectId: project, taskId: 'task-1', query: '恢复跨会话', includeMemory: false })
    assert.equal(resumed.ok, true)
    assert.equal(resumed.capsule.capsuleId, 'capsule-1')
    assert.equal(resumed.capsule.nextAction, '先读取最新检查点')
    assert.equal(resumed.taskGraphTask.task.taskId, 'task-1')
    assert.ok(fixtureValue.intelligenceCloseCalls >= 1)
    assert.ok(resumed.sessionRefs.some((item) => item.id === 's-child'))
    assert.equal(resumed.injection.auto, false)
    assert.equal(resumed.injection.explicitToolOnly, true)
    const renderedResume = JSON.parse(tool('cross_session_resume_context').output.render({}, resumed)[0].text)
    assert.equal(renderedResume.capsule.capsuleId, 'capsule-1')
    assert.equal(renderedResume.capsule.untrusted, true)
    assert.equal(renderedResume.injection.auto, false)
    assert.ok(renderedResume.sessionRefs.every((item) => item.untrusted === true))
    const missing = await tool('cross_session_resume_context').execute({ projectId: project, taskId: 'missing-task', includeMemory: false })
    assert.equal(missing.ok, true)
    assert.equal(missing.capsule, null)
  } finally { await cleanup(root, dispose) }
})

test('bounded JSON renderer remains parseable, redacts raw events, and marks truncation', async () => {
  const module = await import('@local/dsh-cross-session')
  const output = module.boundedJson({ ok: true, events: [{ type: 'user/message', data: { content: 'secret' } }], evidence: { api_key: 'should-not-print' }, capsule: { nextAction: 'continue' }, text: 'x'.repeat(10_000) }, 240)
  assert.ok(output.length <= 240)
  const parsed = JSON.parse(output)
  assert.equal(parsed.truncated, true)
})

test('session adapter normalizes lineage and keeps historical source untrusted', async () => {
  const adapter = new SessionQueryAdapter({
    async listSessions() { return [{ header: { id: 'a', cwd: '/tmp/a' } }] },
    async readTitle() { return '历史标题' },
    async traceSession() { return { target: { header: { id: 'a' } }, ancestors: [], descendants: [], complete: false } },
    async readSession() { return { session: {}, events: [] } },
  })
  const trace = normalizeTrace(await adapter.traceSession('a'), 'a')
  assert.equal(trace.untrusted, true)
  assert.equal((await adapter.readTitle('a')), '历史标题')
})
