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
  SUPPORTED_VERSION,
} from './patch-avengers-model-default.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..')
const sourcePackage = path.join(repoRoot, 'install/node_modules/@deepseek-ai/dsh-host-apiproxy')

function installedIndex() {
  return readFileSync(path.join(sourcePackage, 'lib/index.js'), 'utf8')
}

function baselineIndex() {
  const source = installedIndex()
  assert.equal(source.includes(MARKER), false, 'installed Host bundle must be on the canonical baseline')
  return source
}

function legacyBranch() {
  // A fixture-only historical v1 shape. The migration recognizes it by the
  // reviewed marker and structural anchors, not by knowing any model ids.
  return `${PATCH_TEXT.legacyBranchPrefix}
				const header = agent.session.header;
				if (header?.agentPreset === "avengers") {
					const child = header.origin === "subagent" || header.delegationDepth > 0;
					return child ? { provider: "fixture-child", model: "fixture-child-model", reasoningEffort: "fixture-child-effort" } : { provider: "fixture-parent", model: "fixture-parent-model", reasoningEffort: "fixture-parent-effort" };
				}
				return defaults.defaultModelSelection();
			}`
}

function makeFixture(state = 'baseline') {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-avengers-model-default-'))
  const packageRoot = path.join(root, 'node_modules/@deepseek-ai/dsh-host-apiproxy')
  mkdirSync(path.join(packageRoot, 'lib'), { recursive: true })
  const baseline = baselineIndex()
  copyFileSync(path.join(sourcePackage, 'package.json'), path.join(packageRoot, 'package.json'))
  const source = state === 'baseline'
    ? baseline
    : state === 'v1'
      ? baseline.replace(PATCH_TEXT.defaultBranchBaseline, legacyBranch())
      : state === 'partial'
        ? baseline.replace(PATCH_TEXT.defaultBranchBaseline, `			// ${MARKER}`)
        : (() => { throw new Error(`unknown fixture state ${state}`) })()
  writeFileSync(path.join(packageRoot, 'lib/index.js'), source, 'utf8')
  return { root, packageRoot, indexPath: path.join(packageRoot, 'lib/index.js'), baseline, source }
}

function readFixture(fixture) {
  return readFileSync(fixture.indexPath, 'utf8')
}

test('clean baseline is the only default state and is idempotently verified', async () => {
  const fixture = makeFixture()
  try {
    const before = readFixture(fixture)
    assert.equal(before.includes(MARKER), false)
    assert.equal(before.match(/if \(logged === void 0\) return defaults\.defaultModelSelection\(\);/g)?.length, 1)
    const check = await patchAvengersModelDefault({ packageRoot: fixture.packageRoot, apply: false })
    assert.deepEqual(check, {
      ok: true,
      changed: false,
      status: 'clean',
      packageName: PACKAGE_NAME,
      version: SUPPORTED_VERSION,
      packageRoot: path.resolve(fixture.packageRoot),
      target: fixture.indexPath,
      apply: false,
    })
    const apply = await patchAvengersModelDefault({ packageRoot: fixture.packageRoot, apply: true })
    assert.equal(apply.ok, true)
    assert.equal(apply.changed, false)
    assert.equal(apply.status, 'clean')
    assert.equal(readFixture(fixture), before)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('recognizes and atomically restores the historical v1 hard-coded branch', async () => {
  const fixture = makeFixture('v1')
  try {
    const before = readFixture(fixture)
    assert.equal(before.split(MARKER).length - 1, 1)
    const pending = await patchAvengersModelDefault({ packageRoot: fixture.packageRoot, apply: false })
    assert.equal(pending.ok, false)
    assert.equal(pending.changed, false)
    assert.equal(pending.status, 'pending')
    assert.equal(readFixture(fixture), before, 'check must not write')

    const restored = await patchAvengersModelDefault({ packageRoot: fixture.packageRoot, apply: true })
    assert.deepEqual(restored, {
      ok: true,
      changed: true,
      status: 'restored',
      packageName: PACKAGE_NAME,
      version: SUPPORTED_VERSION,
      packageRoot: path.resolve(fixture.packageRoot),
      target: fixture.indexPath,
      apply: true,
    })
    assert.equal(readFixture(fixture), fixture.baseline)

    const second = await patchAvengersModelDefault({ packageRoot: fixture.packageRoot, apply: true })
    assert.equal(second.ok, true)
    assert.equal(second.changed, false)
    assert.equal(second.status, 'clean')
    assert.equal(readFixture(fixture), fixture.baseline)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('preserves picked/logged/default precedence and never reintroduces an Avengers override', () => {
  const source = baselineIndex()
  const start = source.indexOf(PATCH_TEXT.selectionFunction)
  const end = source.indexOf(PATCH_TEXT.selectionEnd, start)
  assert.ok(start >= 0 && end > start)
  const selection = source.slice(start, end)
  const picked = selection.indexOf('if (picked !== void 0) return picked;')
  const logged = selection.indexOf('const logged = agent.session.requestHeader()?.config;')
  const fallback = selection.indexOf(PATCH_TEXT.defaultBranchBaseline)
  assert.ok(picked >= 0)
  assert.ok(logged > picked)
  assert.ok(fallback > logged)
  assert.doesNotMatch(selection, /agentPreset.*avengers/)
  assert.doesNotMatch(selection, /reasoningEffort:.*(?:high|medium)/)
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
    await assert.rejects(() => patchAvengersModelDefault({ packageRoot: anchorFixture.packageRoot, apply: true }), /expected exactly one canonical default branch/)
    assert.equal(readFixture(anchorFixture), before.replace(PATCH_TEXT.defaultBranchBaseline, '/* changed upstream */'))
  } finally {
    rmSync(anchorFixture.root, { recursive: true, force: true })
  }

  const partialFixture = makeFixture('partial')
  try {
    const before = readFixture(partialFixture)
    await assert.rejects(() => patchAvengersModelDefault({ packageRoot: partialFixture.packageRoot, apply: true }), /malformed v1 branch|could not close the v1 branch/)
    assert.equal(readFixture(partialFixture), before)
  } finally {
    rmSync(partialFixture.root, { recursive: true, force: true })
  }
})

test('atomic replacement leaves the original target and no temporary file on rename failure', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-avengers-model-default-atomic-'))
  const target = path.join(root, 'runtime.js')
  writeFileSync(target, 'old', 'utf8')
  try {
    const fsApi = { ...fs, rename: async () => { throw new Error('injected rename failure') } }
    await assert.rejects(() => atomicReplaceFile(target, 'new', { fsApi }), /injected rename failure/)
    assert.equal(readFileSync(target, 'utf8'), 'old')
    assert.deepEqual(readdirSync(root), ['runtime.js'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('restore propagates atomic failure without leaving a temp or changing the bundle', async () => {
  const fixture = makeFixture('v1')
  try {
    const before = readFixture(fixture)
    const fsApi = { ...fs, rename: async () => { throw new Error('injected restore rename failure') } }
    await assert.rejects(() => patchAvengersModelDefault({ packageRoot: fixture.packageRoot, apply: true, fsApi }), /injected restore rename failure/)
    assert.equal(readFixture(fixture), before)
    assert.deepEqual(readdirSync(path.dirname(fixture.indexPath)), ['index.js'])
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})
