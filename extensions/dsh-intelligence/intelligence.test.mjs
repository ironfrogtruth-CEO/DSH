import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildContextBundle, estimateTokens } from './context-bundle.js'
import { JSON_SCHEMAS, validate, validateContinuationCapsule } from './schemas.js'
import { TaskGraph, TaskGraphConflictError, TaskGraphError, hashProjection } from './task-graph.js'

function clock() {
  let index = 0
  return () => `2026-08-20T12:00:${String(index++).padStart(2, '0')}Z`
}

function taskSpec(overrides = {}) {
  return {
    taskId: 'task:demo',
    projectId: 'project:alpha',
    title: '合同测试任务',
    objective: '验证任务图可以安全恢复',
    protectedConstraints: ['不得修改前端 UI 与交互功能'],
    acceptance: ['focused test 通过'],
    ...overrides,
  }
}

test('contracts expose JSON schemas and reject malformed ContinuationCapsule', () => {
  assert.deepEqual(Object.keys(JSON_SCHEMAS).sort(), [
    'ContextBundle', 'ContextRequest', 'ContinuationCapsule', 'EvidenceRecord', 'OmissionRecord', 'TaskNode', 'TaskSpec',
  ])
  const result = validateContinuationCapsule({ schemaVersion: 1 })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((item) => item.keyword === 'required'))
  assert.equal(validate('TaskSpec', taskSpec()).ok, false, 'raw drafts intentionally need runtime defaults')
})

test('index createStore resolves DSH root at call time without touching the default root', async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), 'dsh-intelligence-fake-home-'))
  const previousHome = process.env.DSH_HOME
  const previousRoot = process.env.DSH_INTELLIGENCE_ROOT
  delete process.env.DSH_INTELLIGENCE_ROOT
  process.env.DSH_HOME = fakeHome
  try {
    const module = await import(`./index.js?dynamic-root=${Date.now()}`)
    const graph = module.createStore()
    assert.equal(graph.rootDir, join(fakeHome, 'intelligence'))
    await graph.close()
    await assert.rejects(access(join(fakeHome, 'intelligence', 'task-graph.sqlite')))
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousRoot === undefined) delete process.env.DSH_INTELLIGENCE_ROOT
    else process.env.DSH_INTELLIGENCE_ROOT = previousRoot
    await rm(fakeHome, { recursive: true, force: true })
  }
})

test('JSONL task graph recovers after restart, protects CAS, and isolates projects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-intelligence-jsonl-'))
  const now = clock()
  try {
    const first = new TaskGraph({ rootDir: root, backend: 'jsonl', now })
    const created = await first.create(taskSpec())
    assert.equal(created.revision, 1)
    assert.equal(created.task.status, 'planned')

    await assert.rejects(
      first.update('task:demo', { status: 'active' }, { projectId: 'project:alpha', expectedRevision: 0 }),
      (error) => error instanceof TaskGraphConflictError && error.code === 'CAS_CONFLICT',
    )

    const evidence = {
      evidenceId: 'evidence:test',
      taskId: 'task:demo',
      projectId: 'project:alpha',
      kind: 'test',
      status: 'pass',
      summary: 'focused test passed',
      sourceRefs: ['test://intelligence'],
      createdAt: '2026-08-20T12:00:10Z',
      untrusted: false,
    }
    const updated = await first.update('task:demo', { status: 'active', addEvidence: [evidence] }, { projectId: 'project:alpha', expectedRevision: 1 })
    assert.equal(updated.revision, 2)
    const done = await first.update('task:demo', { status: 'done' }, { projectId: 'project:alpha', expectedRevision: 2 })
    assert.equal(done.task.status, 'done')
    await first.close()

    const second = new TaskGraph({ rootDir: root, backend: 'jsonl', now })
    const restored = await second.get('task:demo', { projectId: 'project:alpha' })
    assert.equal(restored.task.status, 'done')
    assert.equal(restored.evidence.length, 1)
    assert.equal((await second.list({ projectId: 'project:beta' })).length, 0)
    await assert.rejects(
      second.get('task:demo', { projectId: 'project:beta' }),
      (error) => error.code === 'PROJECT_SCOPE_MISMATCH',
    )
    const events = await second.events('task:demo', { projectId: 'project:alpha' })
    assert.deepEqual(events.map((event) => event.type), ['create', 'update', 'update'])
    const jsonl = await readFile(join(root, 'task-graph.events.jsonl'), 'utf8')
    assert.equal(jsonl.trim().split('\n').length, 3, 'event log remains append-only')
    await second.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('done status without evidence is rejected and checkpoint/resume are durable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-intelligence-done-'))
  const now = clock()
  try {
    const graph = new TaskGraph({ rootDir: root, backend: 'jsonl', now })
    await graph.create(taskSpec({ taskId: 'task:no-evidence', projectId: 'project:alpha' }))
    await assert.rejects(
      graph.update('task:no-evidence', { status: 'done' }, { projectId: 'project:alpha', expectedRevision: 1 }),
      (error) => error instanceof TaskGraphError && error.code === 'DONE_REQUIRES_EVIDENCE',
    )
    const checkpoint = await graph.checkpoint('task:no-evidence', {
      sessionId: 'session:one',
      goal: '恢复任务',
      nextAction: '继续验证',
    }, { projectId: 'project:alpha', expectedRevision: 1 })
    assert.equal(validateContinuationCapsule(checkpoint.capsule).ok, true)
    const resumed = await graph.resume('task:no-evidence', { projectId: 'project:alpha', sessionId: 'session:two', expectedRevision: 2 })
    assert.equal(resumed.resumed, true)
    assert.equal(resumed.lastSessionId, 'session:two')
    await graph.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('context budget trims unprotected sources while retaining protected and marking untrusted provenance', () => {
  const bundle = buildContextBundle({
    sessionId: 'session:ctx',
    projectId: 'project:alpha',
    tokenBudget: 24,
    query: 'explicit context test',
    mode: 'review',
    protectedConstraints: ['不得修改前端 UI 与交互功能'],
  }, {
    memories: [{ id: 'memory:old', content: 'old memory '.repeat(40), memoryIds: ['memory:old'], priority: 1 }],
    artifacts: [{ id: 'artifact:external', content: 'external artifact '.repeat(30), artifactRefs: ['artifact:external'], untrusted: true, priority: 2 }],
    recentEvents: [{ id: 'event:recent', content: 'recent event', sourceEventIds: ['event:recent'], priority: 10 }],
  })
  assert.ok(bundle.sections.some((section) => section.protected && section.content.includes('不得修改前端 UI')))
  assert.equal(bundle.hasUntrusted, true)
  assert.ok(bundle.untrustedSourceIds.includes('artifact:external'))
  assert.ok(bundle.omitted.length > 0)
  assert.equal(bundle.projectId, 'project:alpha')
  assert.ok(bundle.estimatedTokens >= 24 || bundle.sections.some((section) => section.protected), 'protected constraints may exceed budget by design')
  assert.equal(validate('ContextBundle', bundle).ok, true)
})

test('mixed-language token estimation is conservative for CJK, emoji, and ASCII budgets', () => {
  assert.equal(estimateTokens('a'.repeat(40)), 10)
  assert.equal(estimateTokens('你好世界'), 4)
  assert.equal(estimateTokens('你好🙂abc'), 4)
  const bundle = buildContextBundle({
    requestId: 'request:mixed',
    sessionId: 'session:mixed',
    projectId: 'project:mixed',
    tokenBudget: 8,
    query: 'mixed-language budget',
    mode: 'review',
    protectedConstraints: ['必须保留中文约束'],
  }, { sections: [{ id: 'english', content: 'a'.repeat(40), priority: 1 }, { id: 'cjk', content: '中文内容必须按字符保留', priority: 2 }] })
  assert.ok(bundle.sections.some((section) => section.protected && section.content.includes('中文约束')))
  assert.ok(bundle.omitted.length > 0 || bundle.sections.some((section) => section.truncated))
  assert.ok(bundle.sections.filter((section) => !section.protected).reduce((sum, section) => sum + section.tokenEstimate, 0) <= bundle.tokenBudget)
})

test('TaskGraph normalizes update additions before event append and replays identical projection', async () => {
  let sqliteAvailable = true
  try { await import('node:sqlite') } catch { sqliteAvailable = false }
  const backends = sqliteAvailable ? ['jsonl', 'sqlite'] : ['jsonl']
  for (const backend of backends) {
    const root = await mkdtemp(join(tmpdir(), `dsh-intelligence-update-${backend}-`))
    try {
      const now = clock()
      const graph = new TaskGraph({ rootDir: root, backend, now })
      await graph.create(taskSpec({ taskId: `task:update-${backend}`, projectId: `project:update-${backend}` }))
      const addedCapsule = {
        schemaVersion: 1,
        capsuleId: `capsule:update-${backend}`,
        taskId: `task:update-${backend}`,
        projectId: `project:update-${backend}`,
        sessionId: 'session:update',
        goal: 'persist normalized update',
        protectedConstraints: ['preserve exact fields'],
        planSnapshot: {},
        activeTask: null,
        decisions: [],
        touchedFiles: [],
        testsAndEvidence: [],
        errorsAndAttempts: [],
        artifacts: [],
        pendingJobs: [],
        nextAction: 'resume',
        sourceEventIds: [],
        createdAt: '2026-08-20T12:01:00Z',
        revision: 2,
      }
      const updated = await graph.update(`task:update-${backend}`, {
        status: 'active',
        addNodes: [{ nodeId: `node:${backend}`, title: 'normalized node', kind: 'verify', status: 'planned', dependsOn: [], evidenceIds: [] }],
        addEvidence: [{ evidenceId: `evidence:${backend}`, kind: 'test', status: 'pass', summary: 'normalized evidence', sourceRefs: [], untrusted: false }],
        addCapsules: [addedCapsule],
      }, { projectId: `project:update-${backend}`, expectedRevision: 1, sessionId: 'session:update' })
      const events = await graph.events(`task:update-${backend}`, { projectId: `project:update-${backend}` })
      assert.deepEqual(Object.keys(events[1].payload.changes).sort(), ['addCapsules', 'addEvidence', 'addNodes', 'spec'])
      assert.equal(events[1].payload.changes.addNodes[0].schemaVersion, 1)
      assert.equal(events[1].payload.changes.addEvidence[0].createdAt, events[1].createdAt)
      assert.equal(events[1].payload.changes.addCapsules[0].revision, 2)
      const beforeHash = hashProjection(updated)
      await graph.close()
      const restoredGraph = new TaskGraph({ rootDir: root, backend, now })
      const restored = await restoredGraph.get(`task:update-${backend}`, { projectId: `project:update-${backend}` })
      assert.equal(restored.nodes.length, 1)
      assert.equal(restored.evidence.length, 1)
      assert.equal(restored.capsules.length, 1)
      assert.equal(hashProjection(restored), beforeHash)
      await restoredGraph.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('SQLite backend recovers when Node built-in SQLite is available', async (t) => {
  let sqlite
  try { sqlite = await import('node:sqlite') } catch { sqlite = null }
  if (!sqlite?.DatabaseSync) {
    t.skip('node:sqlite is unavailable on this Node runtime')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'dsh-intelligence-sqlite-'))
  const now = clock()
  try {
    const first = new TaskGraph({ rootDir: root, backend: 'sqlite', now })
    await first.create(taskSpec({ taskId: 'task:sqlite', projectId: 'project:sqlite' }))
    await first.close()
    await first.close()
    assert.equal(first._db, null)
    assert.equal(first._ready, null)
    const second = new TaskGraph({ rootDir: root, backend: 'sqlite', now })
    const restored = await second.get('task:sqlite', { projectId: 'project:sqlite' })
    assert.equal(restored.task.taskId, 'task:sqlite')
    assert.equal(restored.revision, 1)
    await second.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('TaskGraph close is no-op before open, waits writes, is idempotent, and safely reopens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-intelligence-lifecycle-'))
  try {
    const graph = new TaskGraph({ rootDir: root, backend: 'jsonl', now: clock() })
    await graph.close()
    await graph.close()
    assert.equal(graph.backend, null)
    const created = await graph.create(taskSpec({ taskId: 'task:lifecycle', projectId: 'project:lifecycle' }))
    assert.equal(created.task.taskId, 'task:lifecycle')
    await graph.close()
    await graph.close()
    assert.equal(graph.backend, null)
    assert.equal(graph._ready, null)
    const restarted = new TaskGraph({ rootDir: root, backend: 'jsonl', now: clock() })
    const restored = await restarted.get('task:lifecycle', { projectId: 'project:lifecycle' })
    assert.equal(restored.task.taskId, 'task:lifecycle')
    await restarted.close()
    // Contract choice: a closed graph safely reopens on the next operation.
    const reopened = await restarted.get('task:lifecycle', { projectId: 'project:lifecycle' })
    assert.equal(reopened.task.status, 'planned')
    await restarted.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('dsh-intelligence apply registers fake plugin cleanup that closes its graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-intelligence-plugin-cleanup-'))
  const previousRoot = process.env.DSH_INTELLIGENCE_ROOT
  const previousBackend = process.env.DSH_INTELLIGENCE_BACKEND
  process.env.DSH_INTELLIGENCE_ROOT = root
  process.env.DSH_INTELLIGENCE_BACKEND = 'jsonl'
  try {
    const module = await import(`./index.js?cleanup=${Date.now()}`)
    const registered = []
    const cleanups = []
    const services = {}
    await module.apply({
      tools: { register(tool) { registered.push(tool) } },
      provide(name, value) { services[name] = value },
      effect(execute) {
        const disposer = execute()
        cleanups.push(disposer)
        return disposer
      },
    })
    assert.ok(registered.length >= 7)
    const graph = services.dshIntelligence.graph
    await graph.create(taskSpec({ taskId: 'task:plugin-cleanup', projectId: 'project:plugin-cleanup' }))
    assert.equal(cleanups.length, 1)
    await cleanups[0]()
    await cleanups[0]()
    assert.equal(graph.backend, null)
    assert.equal(graph._ready, null)
    const reopened = await graph.get('task:plugin-cleanup', { projectId: 'project:plugin-cleanup' })
    assert.equal(reopened.task.taskId, 'task:plugin-cleanup')
    await graph.close()
  } finally {
    if (previousRoot === undefined) delete process.env.DSH_INTELLIGENCE_ROOT
    else process.env.DSH_INTELLIGENCE_ROOT = previousRoot
    if (previousBackend === undefined) delete process.env.DSH_INTELLIGENCE_BACKEND
    else process.env.DSH_INTELLIGENCE_BACKEND = previousBackend
    await rm(root, { recursive: true, force: true })
  }
})

test('intelligence tool execute render exposes bounded structured success fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-intelligence-render-'))
  const previousRoot = process.env.DSH_INTELLIGENCE_ROOT
  const previousBackend = process.env.DSH_INTELLIGENCE_BACKEND
  process.env.DSH_INTELLIGENCE_ROOT = root
  process.env.DSH_INTELLIGENCE_BACKEND = 'jsonl'
  try {
    const module = await import(`./index.js?render=${Date.now()}`)
    const catalog = []
    const cleanups = []
    await module.apply({
      tools: { register(tool) { catalog.push(tool) } },
      provide() {},
      effect(execute) { const disposer = execute(); cleanups.push(disposer); return disposer },
    })
    const findTool = (name) => catalog.find((tool) => tool.name === name)
    const create = await findTool('intelligence_task_create').execute({ task: {
      taskId: 'task:render',
      projectId: 'project:render',
      title: 'render task',
      objective: 'render structured output',
      protectedConstraints: ['do not expose secrets'],
      acceptance: ['render passes'],
    } })
    const update = await findTool('intelligence_task_update').execute({ taskId: 'task:render', projectId: 'project:render', expectedRevision: 1, changes: {
      status: 'active',
      addEvidence: [{ evidenceId: 'evidence:render', kind: 'test', status: 'pass', summary: 'render test passed', sourceRefs: [], untrusted: false }],
    } })
    const checkpoint = await findTool('intelligence_task_checkpoint').execute({ taskId: 'task:render', projectId: 'project:render', expectedRevision: 2, capsule: { sessionId: 'session:render', goal: 'render task', nextAction: 'resume' } })
    const resume = await findTool('intelligence_task_resume').execute({ taskId: 'task:render', projectId: 'project:render', sessionId: 'session:render-next', expectedRevision: 3 })
    const list = await findTool('intelligence_task_list').execute({ projectId: 'project:render' })
    const bundle = await findTool('intelligence_context_bundle').execute({ request: { requestId: 'request:render', sessionId: 'session:render', projectId: 'project:render', tokenBudget: 80, query: 'render', mode: 'review', protectedConstraints: ['do not expose secrets'] }, sources: { memories: [{ id: 'memory:render', content: 'provenance fact', memoryIds: ['memory:render'] }] } })
    const validation = await findTool('intelligence_contract_validate').execute({ schema: 'TaskSpec', value: create.task.task })
    const cases = [
      ['intelligence_task_create', create, ['task', 'revision']],
      ['intelligence_task_update', update, ['task', 'revision', 'evidence']],
      ['intelligence_task_checkpoint', checkpoint, ['capsule', 'revision']],
      ['intelligence_task_resume', resume, ['capsule', 'revision']],
      ['intelligence_task_list', list, ['tasks', 'revision']],
      ['intelligence_context_bundle', bundle, ['bundle', 'provenance']],
      ['intelligence_contract_validate', validation, ['schema', 'errors']],
    ]
    for (const [name, value, required] of cases) {
      assert.equal(value.ok, true)
      const text = findTool(name).output.render({}, value)[0].text
      assert.ok(text.length <= 12_000)
      assert.doesNotMatch(text, /api[_-]?key|sk-[A-Za-z0-9]{16,}|undefined|rawOutput|fullHistory/i)
      for (const key of required) assert.match(text, new RegExp(key))
      JSON.parse(text.slice(text.indexOf('\n') + 1))
    }
    for (const cleanup of cleanups) await cleanup()
  } finally {
    if (previousRoot === undefined) delete process.env.DSH_INTELLIGENCE_ROOT
    else process.env.DSH_INTELLIGENCE_ROOT = previousRoot
    if (previousBackend === undefined) delete process.env.DSH_INTELLIGENCE_BACKEND
    else process.env.DSH_INTELLIGENCE_BACKEND = previousBackend
    await rm(root, { recursive: true, force: true })
  }
})
