import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CodeIndexStore, estimateTokens } from './store.js'
import { assertRelativeWorkspacePath, normalizeProjectId, scanWorkspace } from './scanner.js'

let codeModule

async function loadCodeModuleWithRoot(root) {
  const previous = process.env.DSH_CODE_INTELLIGENCE_ROOT
  process.env.DSH_CODE_INTELLIGENCE_ROOT = join(root, 'code-intelligence')
  try {
    codeModule ??= await import('./index.js')
  } catch (error) {
    if (previous === undefined) delete process.env.DSH_CODE_INTELLIGENCE_ROOT
    else process.env.DSH_CODE_INTELLIGENCE_ROOT = previous
    throw error
  }
  return {
    apply: codeModule.apply,
    restore() {
      if (previous === undefined) delete process.env.DSH_CODE_INTELLIGENCE_ROOT
      else process.env.DSH_CODE_INTELLIGENCE_ROOT = previous
    },
  }
}

function git(root, ...args) {
  return execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function write(root, path, content) {
  const file = join(root, path)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

test('code index is incremental, isolated, bounded, provenance-bearing, and removes deleted files', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-code-index-'))
  const dbRoot = join(root, '.index')
  try {
    git(root, 'init', '-q')
    git(root, 'config', 'user.email', 'code-index@test.invalid')
    git(root, 'config', 'user.name', 'code-index-test')
    write(root, '.gitignore', 'ignored.js\n')
    write(root, 'src/main.js', "import { helper } from './util.js'\nexport function main() { return helper() }\n")
    write(root, 'src/util.js', 'export function helper() { return 1 }\n')
    write(root, 'src/中文.js', "export const title = '中文🧠'\n")
    write(root, 'tests/main.test.js', "import { main } from '../src/main.js'\ntest('main', () => main())\n")
    write(root, 'ignored.js', 'export function ignored() {}\n')
    write(root, '.env', 'TOKEN=do-not-index\n')
    write(root, 'src/secret.js', 'export const TOKEN = \'do-not-index\'\n')
    writeFileSync(join(root, 'src/blob.js'), Buffer.from([0, 1, 2, 3, 4]))
    write(root, 'src/large.js', 'x'.repeat(1_100_000))
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'initial')

    const store = new CodeIndexStore({ storageRoot: dbRoot })
    const first = store.build({ projectId: 'project-a', workspaceRoot: root, maxFileBytes: 1_000_000 })
    assert.equal(first.ok, true)
    assert.equal(first.added, 4)
    assert.ok(first.skippedByReason.binary >= 1)
    assert.ok(first.skippedByReason['secret-pattern'] >= 1)
    assert.ok(first.skippedByReason['large-file'] >= 1)

    const second = store.build({ projectId: 'project-a', workspaceRoot: root, maxFileBytes: 1_000_000 })
    assert.equal(second.unchanged, 4)
    assert.equal(second.added, 0)
    assert.equal(second.updated, 0)
    assert.equal(store.status({ projectId: 'project-a', workspaceRoot: root }).journalMode, 'wal')

    const query = store.query({ projectId: 'project-a', workspaceRoot: root, query: 'helper' })
    assert.equal(query.results[0].path, 'src/util.js')
    assert.equal(query.complete, false)
    assert.equal(query.candidate, true)
    assert.match(query.disclaimer, /bounded candidates/i)
    assert.equal(query.results[0].provenance.untrusted, true)
    assert.equal(query.results[0].provenance.contentHash.length, 64)

    const map = store.repoMap({ projectId: 'project-a', workspaceRoot: root, maxTokens: 12 })
    assert.ok(map.tokenEstimate <= 12)
    assert.equal(map.provenance.scope, 'workspace')
    assert.ok(estimateTokens('中文🧠abc') >= 5)

    const impact = store.testImpact({ projectId: 'project-a', workspaceRoot: root, changedPaths: ['src/util.js'] })
    assert.equal(impact.complete, false)
    assert.ok(impact.candidates.some((candidate) => candidate.path === 'src/main.js'))
    assert.match(impact.disclaimer, /not a complete/i)

    write(root, 'src/util.js', 'export function helper() { return 2 }\n')
    const changed = store.build({ projectId: 'project-a', workspaceRoot: root })
    assert.equal(changed.updated, 1)
    unlinkSync(join(root, 'src/main.js'))
    const deleted = store.build({ projectId: 'project-a', workspaceRoot: root })
    assert.ok(deleted.deleted >= 1)

    const branchBefore = git(root, 'branch', '--show-current')
    git(root, 'switch', '-qc', 'feature-code-index')
    const branchStatus = store.status({ projectId: 'project-a', workspaceRoot: root })
    assert.equal(branchStatus.indexed, false)
    const featureBuild = store.build({ projectId: 'project-a', workspaceRoot: root })
    assert.equal(featureBuild.branch, 'feature-code-index')
    git(root, 'switch', '-q', branchBefore)
    const mainStatus = store.status({ projectId: 'project-a', workspaceRoot: root })
    assert.equal(mainStatus.branch, branchBefore)
    assert.notEqual(mainStatus.branch, featureBuild.branch)
    store.close()

    const reopened = new CodeIndexStore({ storageRoot: dbRoot })
    const persisted = reopened.status({ projectId: 'project-a', workspaceRoot: root, branch: featureBuild.branch })
    assert.equal(persisted.indexed, true)
    assert.ok(persisted.files >= 2)
    reopened.close()

    assert.throws(() => assertRelativeWorkspacePath('../outside.js'), /workspace-relative/)
    assert.throws(() => normalizeProjectId('project/../outside'), /invalid path component/)
    assert.throws(() => store.status({ projectId: '..', workspaceRoot: root }), /invalid path component/)
    assert.throws(() => scanWorkspace({ workspaceRoot: join(root, '..') }), /GIT_REQUIRED|not a git repository/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Host registration is explicit and exposes no automatic context hook', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-code-index-apply-'))
  const registered = []
  const effects = []
  const loaded = await loadCodeModuleWithRoot(root)
  try {
    await loaded.apply({
      tools: { register(spec) { registered.push(spec) } },
      effect(factory, label) { effects.push({ factory, label }) },
    })
    assert.deepEqual(registered.map((spec) => spec.name), [
      'code_index_build',
      'code_index_status',
      'code_index_query',
      'code_repo_map',
      'code_test_impact',
    ])
    assert.deepEqual(registered.map((spec) => spec.inject).filter(Boolean), [])
    assert.equal(effects.length, 1)
    assert.equal(effects[0].label, 'dsh-code-intelligence.store')
    const cleanup = effects[0].factory()
    cleanup()
    cleanup()
  } finally {
    loaded.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('tool execute/render returns bounded JSON envelopes without source text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-code-index-render-'))
  const loaded = await loadCodeModuleWithRoot(root)
  const effects = []
  try {
    git(root, 'init', '-q')
    git(root, 'config', 'user.email', 'code-index-render@test.invalid')
    git(root, 'config', 'user.name', 'code-index-render')
    write(root, 'src/helper.js', 'export function helper() { return 1 }\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'render fixture')
    const registered = []
    await loaded.apply({ tools: { register(spec) { registered.push(spec) } }, effect(factory) { effects.push(factory) } })
    const byName = Object.fromEntries(registered.map((spec) => [spec.name, spec]))
    const render = (name, value) => {
      const text = byName[name].output.render({}, value)[0].text
      assert.ok(text.length <= 12_000)
      const parsed = JSON.parse(text)
      assert.equal(parsed.truncated, false)
      assert.doesNotMatch(text, /sourceText|fileContent|BEGIN (?:RSA|OPENSSH) PRIVATE KEY/i)
      return parsed
    }
    const scope = { projectId: 'render-project', workspaceRoot: root }
    const build = await byName.code_index_build.execute(scope)
    const buildRendered = render('code_index_build', build)
    assert.ok(buildRendered.provenance)
    assert.ok(buildRendered.disclaimer)
    assert.ok(buildRendered.dbPath.startsWith(join(root, 'code-intelligence')))
    const statusRendered = render('code_index_status', await byName.code_index_status.execute(scope))
    assert.ok(statusRendered.provenance)
    assert.ok(statusRendered.disclaimer)
    const queryRendered = render('code_index_query', await byName.code_index_query.execute({ ...scope, query: 'helper' }))
    assert.equal(queryRendered.complete, false)
    assert.equal(queryRendered.candidate, true)
    assert.ok(queryRendered.disclaimer)
    const mapRendered = render('code_repo_map', await byName.code_repo_map.execute({ ...scope, maxTokens: 64 }))
    assert.equal(mapRendered.complete, false)
    assert.equal(mapRendered.candidate, true)
    assert.ok(mapRendered.disclaimer)
    assert.equal(Object.prototype.hasOwnProperty.call(mapRendered, 'text'), false)
    const impactRendered = render('code_test_impact', await byName.code_test_impact.execute({ ...scope, changedPaths: ['src/helper.js'] }))
    assert.equal(impactRendered.complete, false)
    assert.equal(impactRendered.candidate, true)
    assert.ok(impactRendered.disclaimer)
  } finally {
    for (const factory of effects) if (typeof factory === 'function') factory()?.()
    loaded.restore()
    rmSync(root, { recursive: true, force: true })
  }
})
