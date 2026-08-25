import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('UI QA manifest accepts reviewed evidence and blocks console errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'consumer-ui-qa-'))
  try {
    const screenshot = join(root, 'desktop-dark.png')
    const manifest = join(root, 'ui-qa.json')
    await writeFile(screenshot, 'test screenshot fixture')
    const data = {
      schema: 'consumer-ui-qa.v1',
      consoleErrors: 0,
      pageErrors: 0,
      horizontalOverflow: false,
      clippedCriticalRegions: [],
      functionalChecks: [{ name: 'primary action', passed: true }],
      screens: [{ width: 1440, height: 900, theme: 'dark', state: 'loaded', screenshot, reviewed: true }],
      visualReview: { passed: true, notes: 'Hierarchy, spacing, contrast, and clipping reviewed.' },
    }
    await writeFile(manifest, JSON.stringify(data))
    const script = new URL('./check_ui_qa_manifest.mjs', import.meta.url)
    const accepted = spawnSync(process.execPath, [script.pathname, manifest], { encoding: 'utf8' })
    assert.equal(accepted.status, 0, accepted.stderr)
    assert.match(accepted.stdout, /consumer UI QA: OK/)

    await writeFile(manifest, JSON.stringify({ ...data, consoleErrors: 1 }))
    const rejected = spawnSync(process.execPath, [script.pathname, manifest], { encoding: 'utf8' })
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /consoleErrors must be 0/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
