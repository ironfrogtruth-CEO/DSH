import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-v2-'))
  process.env.DSH_MEMORY_ROOT = root
  process.env.DSH_MEMORY_DB = join(root, 'memory.sqlite')
  const module = await import(`./index.js?v2=${Date.now()}-${Math.random()}`)
  const catalog = []
  module.apply({ tools: { register(tool) { catalog.push(tool) } } })
  return { root, module, tool(name) { return catalog.find((item) => item.name === name) } }
}

async function cleanup(root) {
  delete process.env.DSH_MEMORY_ROOT
  delete process.env.DSH_MEMORY_DB
  await rm(root, { recursive: true, force: true })
}

test('v2 keeps original six tools and writes SQLite records with FTS/source/scope', async () => {
  const { root, tool } = await fixture()
  try {
    for (const name of ['memory_save', 'memory_recall', 'memory_checkpoint', 'memory_get', 'memory_list', 'memory_search']) assert.ok(tool(name), name)
    const saved = await tool('memory_save').execute({ key: 'compat-project', content: 'SQLite 持久化与跨会话恢复', source: 'user-confirmed', scope: 'project-a' })
    assert.equal(saved.ok, true)
    const wrongScope = await tool('memory_recall').execute({ query: 'SQLite 持久化', scope: 'default' })
    assert.equal(wrongScope.matchedKeys, '')
    const result = await tool('memory_recall').execute({ query: 'SQLite 持久化', scope: 'project-a' })
    assert.match(result.context, /SQLite 持久化/)
    assert.match(result.sources, /user-confirmed/)
    assert.equal(result.records[0].scope, 'project-a')
    const search = await tool('memory_search').execute({ query: '跨会话恢复', scope: 'project-a' })
    assert.match(search.results, /compat-project/)
    assert.match(search.sources, /user-confirmed/)
  } finally { await cleanup(root) }
})

test('candidate, conflict/version and explicit supersede are queryable without destructive overwrite', async () => {
  const { root, tool } = await fixture()
  try {
    const first = await tool('memory_record').execute({ key: 'decision', content: '采用 SQLite', scope: 'p', source: 'meeting', confidence: 0.8 })
    assert.equal(first.record.version, 1)
    const second = await tool('memory_record').execute({ key: 'decision', content: '候选：评估 FTS5', scope: 'p', candidate: true, source: 'agent' })
    assert.equal(second.record.status, 'candidate')
    assert.equal(second.record.version, 2)
    assert.deepEqual(second.conflicts, [first.record.id])
    const normal = await tool('memory_recall').execute({ query: '评估 FTS5', scope: 'p' })
    assert.equal(normal.matchedKeys, '')
    const candidates = await tool('memory_recall').execute({ query: '评估 FTS5', scope: 'p', includeCandidates: true })
    assert.match(candidates.context, /评估 FTS5/)
    const third = await tool('memory_record').execute({ key: 'decision', content: '最终采用 FTS5', scope: 'p', source: 'user-confirmed', supersedes: first.record.id })
    assert.deepEqual(third.supersededIds, [first.record.id])
    const old = await tool('memory_get').execute({ key: 'decision', scope: 'p' })
    assert.equal(old.record.id, third.record.id)
    const stored = await tool('memory_record').execute({ key: 'decision', content: '最终采用 FTS5', scope: 'p', source: 'user-confirmed' })
    assert.equal(stored.deduped, true)

    const mirroredCandidate = await tool('memory_save').execute({ key: 'candidate-mirror', content: '候选镜像不会默认召回', status: 'candidate' })
    assert.equal(mirroredCandidate.ok, true)
    assert.equal((await tool('memory_recall').execute({ query: '候选镜像' })).matchedKeys, '')
    assert.equal((await tool('memory_recall').execute({ query: '候选镜像', includeCandidates: true })).matchedKeys, 'candidate-mirror')
  } finally { await cleanup(root) }
})

test('forget is dry-run by default, then persists forgotten state across a fresh store', async () => {
  const { root, module, tool } = await fixture()
  try {
    const created = await tool('memory_record').execute({ key: 'forget-me', content: '只用于验证 dry-run', source: 'test' })
    const preview = await tool('memory_forget').execute({ id: created.record.id })
    assert.equal(preview.dryRun, true)
    assert.equal(preview.wouldForget.length, 1)
    assert.equal((await tool('memory_recall').execute({ query: '验证 dry-run' })).matchedKeys, 'forget-me')
    const forgotten = await tool('memory_forget').execute({ id: created.record.id, dryRun: false, confirm: true, reason: '测试' })
    assert.equal(forgotten.dryRun, false)
    assert.equal(forgotten.forgotten[0].status, 'forgotten')
    const reopened = module.createMemoryStore(process.env.DSH_MEMORY_DB)
    try { assert.equal(reopened.getLatest('forget-me'), null) } finally { reopened.close() }

    const mirrored = await tool('memory_save').execute({ key: 'mirrored-forget', content: 'Markdown 镜像也应受 tombstone 控制' })
    assert.equal(mirrored.ok, true)
    const forgottenMirror = await tool('memory_forget').execute({ key: 'mirrored-forget', dryRun: false, confirm: true })
    assert.equal(forgottenMirror.forgotten[0].status, 'forgotten')
    assert.equal((await tool('memory_get').execute({ key: 'mirrored-forget' })).ok, false)
    assert.equal((await tool('memory_recall').execute({ query: 'tombstone 控制' })).matchedKeys, '')
  } finally { await cleanup(root) }
})

test('secret/path validation and explicit idempotent Markdown import', async () => {
  const { root, tool, module } = await fixture()
  try {
    const blocked = await tool('memory_record').execute({ key: 'secret', content: 'API_KEY=should-not-store', source: 'test' })
    assert.equal(blocked.ok, false)
    const blockedSource = await tool('memory_save').execute({ key: 'secret-source', content: 'safe note', source: 'access_token=should-not-store' })
    assert.equal(blockedSource.ok, false)
    await assert.rejects(readFile(join(root, 'secret-source.md')))
    const badScope = await tool('memory_record').execute({ key: '../escape', content: 'safe' })
    assert.equal(badScope.ok, false)
    await writeFile(join(root, 'legacy-note.md'), '# 旧记忆\n\n跨会话 Markdown 兼容读取', 'utf8')
    const dry = await tool('memory_migrate').execute({ dryRun: true })
    assert.equal(dry.imported, 1)
    const imported = await tool('memory_migrate').execute({ dryRun: false, confirm: true })
    assert.equal(imported.imported, 1)
    const again = await tool('memory_migrate').execute({ dryRun: false, confirm: true })
    assert.equal(again.imported, 0)
    assert.ok(again.skipped >= 1)
    assert.match(await readFile(join(root, 'legacy-note.md'), 'utf8'), /旧记忆/)
    const reopened = module.createMemoryStore(process.env.DSH_MEMORY_DB)
    try { assert.ok(reopened.getLatest('legacy-note')) } finally { reopened.close() }
  } finally { await cleanup(root) }
})

test('Markdown import rejects canonical external and symlink roots unless explicitly opted in', async () => {
  const { root, tool } = await fixture()
  const external = await mkdtemp(join(tmpdir(), 'dsh-memory-external-'))
  try {
    await writeFile(join(external, 'outside.md'), '外部 root 不应默认导入', 'utf8')
    const link = join(root, 'external-link')
    await symlink(external, link, 'dir')
    const symlinkRejected = await tool('memory_migrate').execute({ root: link, dryRun: true })
    assert.equal(symlinkRejected.ok, false)
    assert.match(symlinkRejected.error, /DSH_MEMORY_ROOT|外部导入/)
    const parentRejected = await tool('memory_migrate').execute({ root: join(root, '..', basename(external)), dryRun: true })
    assert.equal(parentRejected.ok, false)
    process.env.DSH_MEMORY_ALLOW_EXTERNAL_ROOT = '1'
    const optedIn = await tool('memory_migrate').execute({ root: external, dryRun: true })
    assert.equal(optedIn.ok, true)
    assert.equal(optedIn.imported, 1)
  } finally {
    delete process.env.DSH_MEMORY_ALLOW_EXTERNAL_ROOT
    await cleanup(root)
    await rm(external, { recursive: true, force: true })
  }
})

test('legacy renders remain text while structured/enhanced renders are bounded JSON', async () => {
  const { root, tool } = await fixture()
  try {
    const legacySave = await tool('memory_save').execute({ key: 'legacy-render', content: 'legacy render text' })
    assert.match(tool('memory_save').output.render({}, legacySave)[0].text, /^已保存:/)
    const legacyCheckpoint = await tool('memory_checkpoint').execute({ key: 'legacy-render', content: 'legacy checkpoint text' })
    assert.match(tool('memory_checkpoint').output.render({}, legacyCheckpoint)[0].text, /^检查点已追加:/)
    const legacyRecall = await tool('memory_recall').execute({ query: 'legacy render' })
    assert.match(tool('memory_recall').output.render({}, legacyRecall)[0].text, /legacy-render/)
    const legacyGet = await tool('memory_get').execute({ key: 'legacy-render' })
    assert.match(tool('memory_get').output.render({}, legacyGet)[0].text, /legacy render text/)
    const legacyList = await tool('memory_list').execute({})
    assert.match(tool('memory_list').output.render({}, legacyList)[0].text, /legacy-render/)
    const legacySearch = await tool('memory_search').execute({ query: 'legacy render' })
    assert.match(tool('memory_search').output.render({}, legacySearch)[0].text, /legacy-render/)

    const enhancedSave = await tool('memory_save').execute({ key: 'enhanced-render', content: 'structured save', scope: 'project-a', source: 'test' })
    const savedJson = JSON.parse(tool('memory_save').output.render({}, enhancedSave)[0].text)
    assert.equal(savedJson.recordId, enhancedSave.recordId)
    assert.equal(savedJson.scope, 'project-a')
    assert.equal(savedJson.path, enhancedSave.path)
    const enhancedCheckpoint = await tool('memory_checkpoint').execute({ key: 'enhanced-render', content: 'structured checkpoint', scope: 'project-a', source: 'test' })
    const checkpointJson = JSON.parse(tool('memory_checkpoint').output.render({}, enhancedCheckpoint)[0].text)
    assert.equal(checkpointJson.recordId, enhancedCheckpoint.recordId)

    const record = await tool('memory_record').execute({ key: 'structured', content: 'record body', scope: 'project-a', kind: 'semantic', source: 'user-confirmed', status: 'active', confidence: 0.9 })
    const recordText = tool('memory_record').output.render({}, record)[0].text
    assert.ok(recordText.length <= 12_000)
    const recordJson = JSON.parse(recordText)
    for (const field of ['key', 'scope', 'kind', 'status', 'confidence', 'source', 'hash', 'version', 'deduped', 'conflicts', 'supersededIds', 'unresolvedSupersedes']) assert.ok(Object.hasOwn(recordJson, field), field)
    assert.equal(recordJson.key, 'structured')

    const forget = await tool('memory_forget').execute({ id: record.record.id, scope: 'project-a' })
    const forgetJson = JSON.parse(tool('memory_forget').output.render({}, forget)[0].text)
    assert.equal(forgetJson.dryRun, true)
    assert.equal(forgetJson.wouldForget[0].id, record.record.id)
    assert.equal(Object.hasOwn(forgetJson.wouldForget[0], 'content'), false)
    assert.equal(forgetJson.wouldForget[0].reason, '')

    await writeFile(join(root, 'render-import.md'), 'x'.repeat(200), 'utf8')
    const migrate = await tool('memory_migrate').execute({ dryRun: true })
    const migrateText = tool('memory_migrate').output.render({}, migrate)[0].text
    assert.ok(migrateText.length <= 12_000)
    const migrateJson = JSON.parse(migrateText)
    assert.equal(migrateJson.dryRun, true)
    assert.equal(migrateJson.imported >= 1, true)
    assert.ok(Array.isArray(migrateJson.files))
  } finally { await cleanup(root) }
})

test('candidate promotion is dry-run by default, audited, scope-isolated and durable', async () => {
  const { root, module, tool } = await fixture()
  try {
    const candidate = await tool('memory_record').execute({ key: 'review-me', content: '待审核事实', scope: 'scope-a', candidate: true, source: 'agent', confidence: 0.7 })
    assert.equal(candidate.record.status, 'candidate')
    const preview = await tool('memory_promote').execute({ id: candidate.record.id, scope: 'scope-a' })
    assert.equal(preview.ok, true)
    assert.equal(preview.dryRun, true)
    assert.equal(preview.record.status, 'candidate')
    assert.equal((await tool('memory_recall').execute({ query: '待审核事实', scope: 'scope-a' })).matchedKeys, '')

    const noConfirm = await tool('memory_promote').execute({ id: candidate.record.id, scope: 'scope-a', dryRun: false, confirm: false })
    assert.equal(noConfirm.dryRun, true)
    const promoted = await tool('memory_promote').execute({ id: candidate.record.id, scope: 'scope-a', dryRun: false, confirm: true, reason: '人工核验通过', source: 'reviewer' })
    assert.equal(promoted.ok, true)
    assert.equal(promoted.dryRun, false)
    assert.equal(promoted.record.status, 'active')
    assert.equal(promoted.event.fromStatus, 'candidate')
    assert.equal(promoted.event.toStatus, 'active')
    const rendered = JSON.parse(tool('memory_promote').output.render({}, promoted)[0].text)
    assert.equal(rendered.record.status, 'active')
    assert.equal(rendered.event.fromStatus, 'candidate')
    assert.equal(Object.hasOwn(rendered.record, 'content'), false)
    assert.equal((await tool('memory_recall').execute({ query: '待审核事实', scope: 'scope-a' })).matchedKeys, 'review-me')

    const reopened = module.createMemoryStore(process.env.DSH_MEMORY_DB)
    try {
      const events = reopened.stateEvents({ scope: 'scope-a', recordId: candidate.record.id })
      assert.equal(events.length, 1)
      assert.equal(events[0].reason, '人工核验通过')
      assert.equal(reopened.getLatest('review-me', { scope: 'scope-a' }).status, 'active')
      assert.equal(reopened.getLatest('review-me', { scope: 'scope-b' }), null)
    } finally { reopened.close() }
    const idempotent = await tool('memory_promote').execute({ id: candidate.record.id, scope: 'scope-a', dryRun: false, confirm: true })
    assert.equal(idempotent.ok, true)
    assert.equal(idempotent.idempotent, true)

    const isolated = await tool('memory_record').execute({ key: 'scope-only', content: '隔离候选', scope: 'scope-b', candidate: true })
    const wrongScope = await tool('memory_promote').execute({ id: isolated.record.id, scope: 'scope-a', dryRun: false, confirm: true })
    assert.equal(wrongScope.ok, false)
    assert.equal(wrongScope.code, 'MEMORY_NOT_FOUND')
    const active = await tool('memory_record').execute({ key: 'already-active', content: 'active', scope: 'scope-a', status: 'active' })
    const activeAgain = await tool('memory_promote').execute({ id: active.record.id, scope: 'scope-a', dryRun: false, confirm: true })
    assert.equal(activeAgain.idempotent, true)
    const forgotten = await tool('memory_forget').execute({ id: active.record.id, scope: 'scope-a', dryRun: false, confirm: true })
    assert.equal(forgotten.ok, true)
    const rejected = await tool('memory_promote').execute({ id: active.record.id, scope: 'scope-a', dryRun: false, confirm: true })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.code, 'PROMOTION_INVALID_STATE')
  } finally { await cleanup(root) }
})
