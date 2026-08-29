import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  atomicWrite,
  BASELINE_VERSION,
  PATCHES,
  SUBAGENT_ARCHIVE_MARKERS,
  SUBAGENT_ARCHIVE_SNAPSHOT,
  replayCustomUiPatches,
  validateSubagentArchiveSnapshot,
} from './replay-custom-ui-patches.mjs'

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

test('shrimp-shell locked snapshot participates in startup replay', () => {
  const row = PATCHES.find((item) => item.packageName === 'shrimp-shell')
  assert.deepEqual(row, {
    packageName: 'shrimp-shell',
    source: 'custom-ui-patches/shrimp-shell/client.js.modified',
    target: 'extensions/shrimp-shell/client.js',
  })
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

test('rc.2 subagent archive snapshot is the replay source, not the legacy modified bundle', async () => {
  const row = PATCHES.find((item) => item.packageName === 'dsh-client-ui-subagent')
  assert.deepEqual(row, SUBAGENT_ARCHIVE_SNAPSHOT)
  assert.equal(row.source, 'custom-ui-patches/dsh-client-ui-subagent/client.js.rc2-archive.modified')
  assert.notEqual(row.source, 'custom-ui-patches/dsh-client-ui-subagent/client.js.modified')
  const snapshot = readFileSync(join(repoRoot, row.source))
  assert.deepEqual(validateSubagentArchiveSnapshot(snapshot), { ok: true, missing: [] })
  for (const marker of SUBAGENT_ARCHIVE_MARKERS) assert.ok(snapshot.includes(marker), marker)
})

test('rc.2 subagent archive drift is atomically repaired instead of blocked by the legacy hash gate', async () => {
  const root = fixture()
  try {
    const target = join(root, SUBAGENT_ARCHIVE_SNAPSHOT.target)
    writeFileSync(target, 'unexpected upstream drift')
    const result = await replayCustomUiPatches({ root })
    assert.equal(result.status, 'drift')
    assert.equal(result.ok, false)
    const applied = await replayCustomUiPatches({ root, apply: true })
    assert.equal(applied.status, 'applied')
    assert.deepEqual(readFileSync(target), readFileSync(join(root, SUBAGENT_ARCHIVE_SNAPSHOT.source)))
    assert.equal(applied.archiveSnapshot.sourceSha256, '530dc01da4afdc564391eaf4e532bdedc51933dcadc80988a45f6226f526988c')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('invalid rc.2 subagent archive source fails closed before any target write', async () => {
  const root = fixture()
  try {
    const source = join(root, SUBAGENT_ARCHIVE_SNAPSHOT.source)
    const target = join(root, SUBAGENT_ARCHIVE_SNAPSHOT.target)
    writeFileSync(source, 'legacy bundle')
    writeFileSync(target, 'target sentinel')
    const result = await replayCustomUiPatches({ root, apply: true })
    assert.equal(result.code, 'SUBAGENT_ARCHIVE_SNAPSHOT_INVALID')
    assert.equal(result.apply, false)
    assert.equal(result.archiveSnapshot.hashMatches, false)
    assert.equal(readFileSync(target, 'utf8'), 'target sentinel')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rc.2 subagent archive source hash is version locked even when required markers remain', async () => {
  const root = fixture()
  try {
    const source = join(root, SUBAGENT_ARCHIVE_SNAPSHOT.source)
    const target = join(root, SUBAGENT_ARCHIVE_SNAPSHOT.target)
    writeFileSync(source, `${readFileSync(source, 'utf8')}\n`)
    writeFileSync(target, 'target sentinel')
    const result = await replayCustomUiPatches({ root, apply: true })
    assert.equal(result.code, 'SUBAGENT_ARCHIVE_SNAPSHOT_INVALID')
    assert.deepEqual(result.archiveSnapshot.missingMarkers, [])
    assert.equal(result.archiveSnapshot.hashMatches, false)
    assert.equal(readFileSync(target, 'utf8'), 'target sentinel')
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
