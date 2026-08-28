import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import {
  atomicReplaceFile,
  MARKER,
  PACKAGE_NAME,
  PATCH_TEXT,
  patchAvengersModelDefault,
  resolveAvengersDefaultSelection,
  SUPPORTED_VERSION,
} from './patch-avengers-model-default.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..')
const sourcePackage = path.join(repoRoot, 'install/node_modules/@deepseek-ai/dsh-host-apiproxy')

function installedIndex() {
  return readFileSync(path.join(sourcePackage, 'lib/index.js'), 'utf8')
}

function baselineIndex() {
  const source = installedIndex()
  if (!source.includes(MARKER)) return source
  assert.equal(source.split(MARKER).length - 1, 1, 'installed patch marker must be unique')
  return source.replace(PATCH_TEXT.defaultBranchPatched, PATCH_TEXT.defaultBranchBaseline)
}

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-avengers-model-default-'))
  const packageRoot = path.join(root, 'node_modules/@deepseek-ai/dsh-host-apiproxy')
  mkdirSync(path.join(packageRoot, 'lib'), { recursive: true })
  copyFileSync(path.join(sourcePackage, 'package.json'), path.join(packageRoot, 'package.json'))
  writeFileSync(path.join(packageRoot, 'lib/index.js'), baselineIndex(), 'utf8')
  return { root, packageRoot, indexPath: path.join(packageRoot, 'lib/index.js'), baseline: baselineIndex() }
}

function readFixture(fixture) {
  return readFileSync(fixture.indexPath, 'utf8')
}

test('Avengers default selection maps top-level and child headers, leaving other presets to global defaults', () => {
  assert.deepEqual(resolveAvengersDefaultSelection({ agentPreset: 'avengers' }), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
  })
  assert.deepEqual(resolveAvengersDefaultSelection({ agentPreset: 'avengers', origin: 'subagent' }), {
    provider: 'zhipu-glm',
    model: 'glm-5.3-flash',
    reasoningEffort: 'medium',
  })
  assert.deepEqual(resolveAvengersDefaultSelection({ agentPreset: 'avengers', delegationDepth: 1 }), {
    provider: 'zhipu-glm',
    model: 'glm-5.3-flash',
    reasoningEffort: 'medium',
  })
  assert.equal(resolveAvengersDefaultSelection({ agentPreset: 'reliable-development' }), undefined)
  assert.equal(resolveAvengersDefaultSelection(undefined), undefined)
})

test('applies exactly one selectionFor fallback replacement and is idempotent', async () => {
  const fixture = makeFixture()
  try {
    const first = await patchAvengersModelDefault({ packageRoot: fixture.packageRoot, apply: true })
    assert.deepEqual(first, {
      ok: true,
      changed: true,
      status: 'applied',
      packageName: PACKAGE_NAME,
      version: SUPPORTED_VERSION,
      packageRoot: path.resolve(fixture.packageRoot),
      target: fixture.indexPath,
      apply: true,
    })
    const patched = readFixture(fixture)
    assert.equal(patched, fixture.baseline.replace(PATCH_TEXT.defaultBranchBaseline, PATCH_TEXT.defaultBranchPatched))
    assert.equal(patched.split(MARKER).length - 1, 1)

    const second = await patchAvengersModelDefault({ packageRoot: fixture.packageRoot, apply: true })
    assert.equal(second.ok, true)
    assert.equal(second.changed, false)
    assert.equal(second.status, 'clean')
    assert.equal(readFixture(fixture), patched)

    const check = await patchAvengersModelDefault({ packageRoot: fixture.packageRoot, apply: false })
    assert.equal(check.ok, true)
    assert.equal(check.changed, false)
    assert.equal(check.status, 'clean')
    assert.equal(readFixture(fixture), patched)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('keeps picked and logged selection precedence ahead of the Avengers fallback', async () => {
  const fixture = makeFixture()
  try {
    await patchAvengersModelDefault({ packageRoot: fixture.packageRoot, apply: true })
    const source = readFixture(fixture)
    const start = source.indexOf(PATCH_TEXT.selectionFunction)
    const end = source.indexOf(PATCH_TEXT.selectionEnd, start)
    assert.ok(start >= 0 && end > start)
    const selection = source.slice(start, end)
    const picked = selection.indexOf('if (picked !== void 0) return picked;')
    const logged = selection.indexOf('const logged = agent.session.requestHeader()?.config;')
    const fallback = selection.indexOf(PATCH_TEXT.defaultBranchPatched)
    assert.ok(picked >= 0)
    assert.ok(logged > picked)
    assert.ok(fallback > logged)
    assert.match(selection, /if \(logged === void 0\) \{[\s\S]*return defaults\.defaultModelSelection\(\);/)
    assert.match(selection, /return \{\s+provider: logged\.provider,\s+model: logged\.model,/)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('check is read-only and reports a valid baseline as pending', async () => {
  const fixture = makeFixture()
  try {
    const before = readFixture(fixture)
    const result = await patchAvengersModelDefault({ packageRoot: fixture.packageRoot, apply: false })
    assert.equal(result.ok, false)
    assert.equal(result.changed, false)
    assert.equal(result.status, 'pending')
    assert.equal(readFixture(fixture), before)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('fails closed for unsupported version, unknown anchor, and partial marker without writing', async () => {
  const versionFixture = makeFixture()
  try {
    const manifestPath = path.join(versionFixture.packageRoot, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.version = '0.1.1-rc.3'
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8')
    const before = readFixture(versionFixture)
    await assert.rejects(() => patchAvengersModelDefault({ packageRoot: versionFixture.packageRoot, apply: true }), /supports only .*0\.1\.1-rc\.2/)
    assert.equal(readFixture(versionFixture), before)
  } finally {
    rmSync(versionFixture.root, { recursive: true, force: true })
  }

  const anchorFixture = makeFixture()
  try {
    const before = readFixture(anchorFixture)
    writeFileSync(anchorFixture.indexPath, before.replace(PATCH_TEXT.defaultBranchBaseline, '/* changed upstream */'), 'utf8')
    await assert.rejects(() => patchAvengersModelDefault({ packageRoot: anchorFixture.packageRoot, apply: true }), /expected exactly one selectionFor default branch/)
    assert.equal(readFixture(anchorFixture), before.replace(PATCH_TEXT.defaultBranchBaseline, '/* changed upstream */'))
  } finally {
    rmSync(anchorFixture.root, { recursive: true, force: true })
  }

  const partialFixture = makeFixture()
  try {
    const partial = readFixture(partialFixture).replace(PATCH_TEXT.defaultBranchBaseline, `\t\t\t// ${MARKER}`)
    writeFileSync(partialFixture.indexPath, partial, 'utf8')
    await assert.rejects(() => patchAvengersModelDefault({ packageRoot: partialFixture.packageRoot, apply: true }), /ambiguous patched state|patched Avengers default branch/)
    assert.equal(readFixture(partialFixture), partial)
  } finally {
    rmSync(partialFixture.root, { recursive: true, force: true })
  }
})

test('atomic replacement leaves the original target and no temporary file on rename failure', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-avengers-model-default-atomic-'))
  const target = path.join(root, 'runtime.js')
  writeFileSync(target, 'old', 'utf8')
  try {
    const fsApi = {
      ...fs,
      rename: async () => { throw new Error('injected rename failure') },
    }
    await assert.rejects(() => atomicReplaceFile(target, 'new', { fsApi }), /injected rename failure/)
    assert.equal(readFileSync(target, 'utf8'), 'old')
    assert.deepEqual(readdirSync(root), ['runtime.js'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('patch apply propagates atomic failure without leaving a temp or changing the bundle', async () => {
  const fixture = makeFixture()
  try {
    const before = readFixture(fixture)
    const fsApi = {
      ...fs,
      rename: async () => { throw new Error('injected patch rename failure') },
    }
    await assert.rejects(() => patchAvengersModelDefault({ packageRoot: fixture.packageRoot, apply: true, fsApi }), /injected patch rename failure/)
    assert.equal(readFixture(fixture), before)
    assert.deepEqual(readdirSync(path.dirname(fixture.indexPath)), ['index.js'])
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})
