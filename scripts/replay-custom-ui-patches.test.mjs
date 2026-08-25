import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { atomicWrite, BASELINE_VERSION, PATCHES, PROTECTED_BUNDLES, replayCustomUiPatches } from './replay-custom-ui-patches.mjs'

const repoRoot = resolve(import.meta.dirname, '..')

function fixture(version = BASELINE_VERSION) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ui-replay-'))
  mkdirSync(join(root, 'install/node_modules/@deepseek-ai/dsh'), { recursive: true })
  writeFileSync(join(root, 'install/node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ version }))
  for (const row of PATCHES) {
    mkdirSync(resolve(root, row.source, '..'), { recursive: true })
    mkdirSync(resolve(root, row.target, '..'), { recursive: true })
    cpSync(join(repoRoot, row.source), join(root, row.source))
    cpSync(join(repoRoot, row.source), join(root, row.target))
  }
  for (const row of PROTECTED_BUNDLES) {
    mkdirSync(resolve(root, row.target, '..'), { recursive: true })
    cpSync(join(repoRoot, row.target), join(root, row.target))
  }
  return root
}

test('locked baseline reports clean and atomically repairs reviewed drift', async () => {
  const root = fixture()
  try {
    assert.equal((await replayCustomUiPatches({ root })).status, 'clean')
    const target = join(root, PATCHES[0].target)
    writeFileSync(target, 'drift')
    const drift = await replayCustomUiPatches({ root })
    assert.equal(drift.status, 'drift')
    assert.equal(drift.ok, false)
    const applied = await replayCustomUiPatches({ root, apply: true })
    assert.equal(applied.status, 'applied')
    assert.deepEqual(readFileSync(target), readFileSync(join(root, PATCHES[0].source)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('apply rolls back earlier bundle writes when a later write fails', async () => {
  const root = fixture()
  try {
    const first = join(root, PATCHES[0].target)
    const second = join(root, PATCHES[1].target)
    writeFileSync(first, 'first drift')
    writeFileSync(second, 'second drift')
    let calls = 0
    const result = await replayCustomUiPatches({
      root,
      apply: true,
      writer: async (target, content) => {
        calls += 1
        if (calls === 2) throw new Error('injected second write failure')
        await atomicWrite(target, content)
      },
    })
    assert.equal(result.code, 'APPLY_FAILED_ROLLED_BACK')
    assert.equal(readFileSync(first, 'utf8'), 'first drift')
    assert.equal(readFileSync(second, 'utf8'), 'second drift')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reviewed upstream subagent bundle drift blocks check and apply modes', async () => {
  const root = fixture()
  try {
    writeFileSync(join(root, PROTECTED_BUNDLES[0].target), 'unexpected upstream drift')
    const result = await replayCustomUiPatches({ root, apply: true })
    assert.equal(result.code, 'PROTECTED_UPSTREAM_BUNDLE_DRIFT')
    assert.equal(result.apply, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a new upstream version is a blocking compatibility boundary', async () => {
  const root = fixture('0.1.1-rc.3')
  try {
    const result = await replayCustomUiPatches({ root, apply: true })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'UPSTREAM_VERSION_REVIEW_REQUIRED')
    assert.equal(result.apply, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
