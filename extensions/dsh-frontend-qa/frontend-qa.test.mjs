import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from './index.js'
import { canonicalArtifactPath, ArtifactPathError } from './artifacts.js'
import { comparePngBuffers, encodePng, visualDiff } from './png-diff.js'
import { evaluateFrontendSignoff, validateDesignQAManifest, validateDesignSystemManifest } from './schemas.js'

function designManifest() {
  return {
    schemaVersion: 1,
    fonts: { families: [{ family: 'Inter', weights: [400, 700], source: 'local' }] },
    colors: { tokens: { primary: '#1f6feb', surface: '#ffffff', text: '#111827' } },
    spacing: { unit: 4, scale: { xs: 4, sm: 8, md: 16 } },
    radius: { tokens: { sm: 4, md: 8 } },
    elevation: { tokens: { card: '0 2px 8px #0002' } },
    icon: { set: 'lucide', sizes: [16, 20, 24] },
    motion: { durations: { fast: '120ms', normal: '240ms' }, easings: { standard: 'ease-out' }, reducedMotion: true },
    breakpoint: { values: { mobile: 0, tablet: 768, desktop: 1280 }, names: ['mobile', 'tablet', 'desktop'] },
  }
}

function qaManifest() {
  return {
    schemaVersion: 2,
    viewports: [{ id: 'desktop', width: 1280, height: 800, deviceScaleFactor: 1 }],
    themes: [{ id: 'light' }],
    states: [{ id: 'default' }],
    screenshots: [{ id: 'home-desktop', path: 'output/actual.png', viewport: 'desktop', theme: 'light', state: 'default', reviewed: true }],
    visualDiffs: [{ id: 'home-baseline', baselinePath: 'output/baseline.png', actualPath: 'output/actual.png', diffPath: 'output/diff.png', diffRatio: 0, reviewed: true }],
    console: [],
    page: { url: 'http://127.0.0.1:3080' },
    network: [],
    a11y: [],
    interactions: [{ id: 'open-home', status: 'passed', critical: true }],
    trace: { reviewed: true },
    reviewed: true,
    verdict: { functional: 'pass', visual: 'pass', a11y: 'pass', overall: 'pass' },
  }
}

test('schema validators cover design-system and QA contracts', () => {
  assert.equal(validateDesignSystemManifest(designManifest()).ok, true)
  assert.equal(validateDesignQAManifest(qaManifest()).ok, true)
  assert.equal(validateDesignSystemManifest({ schemaVersion: 1 }).ok, false)
  assert.equal(validateDesignQAManifest({ schemaVersion: 2 }).ok, false)
})

test('PNG diff reports match, pixels, dimensions, and safe artifact paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-frontend-qa-'))
  const allowedRoot = mkdtempSync(join(tmpdir(), 'dsh-frontend-qa-allowed-'))
  try {
    mkdirSync(join(root, 'output'), { recursive: true })
    const base = encodePng({ width: 2, height: 2, data: Buffer.alloc(16, 255) })
    const changedPixels = Buffer.from(Buffer.alloc(16, 255))
    changedPixels.set([255, 0, 0, 255], 4)
    const changed = encodePng({ width: 2, height: 2, data: changedPixels })
    const decoded = changed
    writeFileSync(join(root, 'output/baseline.png'), base)
    writeFileSync(join(root, 'output/actual.png'), changed)
    const same = comparePngBuffers(base, base)
    assert.equal(same.ok, true)
    assert.equal(same.diffPixels, 0)
    const diff = comparePngBuffers(base, decoded)
    assert.equal(diff.ok, false)
    assert.equal(diff.diffPixels, 1)
    assert.equal(diff.diffRatio, 0.25)
    const dimensions = comparePngBuffers(base, encodePng({ width: 1, height: 1, data: Buffer.from([0, 0, 0, 255]) }))
    assert.equal(dimensions.ok, false)
    assert.equal(dimensions.code, 'DIMENSIONS_MISMATCH')
    const persisted = visualDiff({ baselinePath: join(root, 'output/baseline.png'), actualPath: join(root, 'output/actual.png'), diffPath: join(root, 'output/diff.png') })
    assert.equal(persisted.ok, false)
    assert.equal(persisted.diffPixels, 1)
    assert.equal(canonicalArtifactPath({ workspaceRoot: root, artifactPath: 'output/actual.png' }).rootKind, 'workspace/output')
    writeFileSync(join(allowedRoot, 'external.png'), base)
    assert.equal(canonicalArtifactPath({ workspaceRoot: root, artifactPath: join(allowedRoot, 'external.png'), allowedRoot }).rootKind, 'allowedRoot')
    assert.throws(() => canonicalArtifactPath({ workspaceRoot: root, artifactPath: '../outside.png' }), (error) => error instanceof ArtifactPathError && error.code === 'ARTIFACT_PATH_ESCAPE')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(allowedRoot, { recursive: true, force: true })
  }
})

test('signoff separates functional, visual, and a11y blockers', () => {
  const passing = evaluateFrontendSignoff(qaManifest())
  assert.equal(passing.ok, true)
  const blocked = qaManifest()
  blocked.reviewed = false
  blocked.screenshots[0].reviewed = false
  blocked.console.push({ level: 'error', message: 'uncaught error' })
  blocked.network.push({ url: '/api/data', status: 500, error: 'server error' })
  blocked.interactions[0].status = 'failed'
  blocked.a11y.push({ id: 'button-name', impact: 'serious', resolved: false })
  blocked.verdict = { functional: 'fail', visual: 'fail', a11y: 'fail', overall: 'fail' }
  const result = evaluateFrontendSignoff(blocked)
  assert.equal(result.ok, false)
  assert.equal(result.functional.ok, false)
  assert.equal(result.visual.ok, false)
  assert.equal(result.a11y.ok, false)
  assert.ok(result.blockers.some((item) => /unreviewed screenshots/.test(item)))
  assert.ok(result.blockers.some((item) => /console errors/.test(item)))
})

test('tool execute/render exposes bounded model-consumable JSON', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-frontend-qa-render-'))
  try {
    mkdirSync(join(root, 'output'), { recursive: true })
    const pixels = Buffer.alloc(16, 255)
    const png = encodePng({ width: 2, height: 2, data: pixels })
    for (const name of ['baseline.png', 'actual.png', 'diff.png']) writeFileSync(join(root, 'output', name), png)
    const registered = []
    await apply({ tools: { register(spec) { registered.push(spec) } } })
    const byName = Object.fromEntries(registered.map((spec) => [spec.name, spec]))
    assert.deepEqual(Object.keys(byName), ['frontend_design_validate', 'frontend_qa_validate', 'frontend_visual_diff', 'frontend_signoff'])
    const renderText = (name, value) => {
      const blocks = byName[name].output.render({}, value)
      assert.equal(blocks.length, 1)
      assert.equal(blocks[0].type, 'text')
      assert.ok(blocks[0].text.length <= 12_000)
      assert.doesNotMatch(blocks[0].text, /data:image\/|base64,|<html/i)
      return JSON.parse(blocks[0].text)
    }
    const designValue = await byName.frontend_design_validate.execute({ manifest: designManifest(), workspaceRoot: root })
    const designRendered = renderText('frontend_design_validate', designValue)
    assert.ok('schema' in designRendered)
    assert.ok('errors' in designRendered)
    const qaValue = await byName.frontend_qa_validate.execute({ manifest: qaManifest(), workspaceRoot: root })
    const qaRendered = renderText('frontend_qa_validate', qaValue)
    assert.deepEqual(qaRendered.manifestSummary, { viewports: 1, themes: 1, states: 1, screenshots: 1, visualDiffs: 1, console: 0, network: 0, a11y: 0, interactions: 1, reviewed: true, verdict: { functional: 'pass', visual: 'pass', a11y: 'pass', overall: 'pass' } })
    const diffValue = await byName.frontend_visual_diff.execute({ workspaceRoot: root, baselinePath: 'output/baseline.png', actualPath: 'output/actual.png', diffPath: 'output/diff.png' })
    const diffRendered = renderText('frontend_visual_diff', diffValue)
    assert.equal(diffRendered.diffPixels, 0)
    assert.ok('diffRatio' in diffRendered)
    assert.ok('dimensions' in diffRendered)
    assert.equal(diffRendered.diffPath, canonicalArtifactPath({ workspaceRoot: root, artifactPath: 'output/diff.png' }).path)
    const signoffValue = await byName.frontend_signoff.execute({ manifest: qaManifest(), workspaceRoot: root })
    const signoffRendered = renderText('frontend_signoff', signoffValue)
    for (const key of ['functional', 'visual', 'a11y', 'blockers', 'verdict']) assert.ok(key in signoffRendered)
    const bounded = renderText('frontend_signoff', { ok: true, functional: { ok: true }, visual: { ok: true }, a11y: { ok: true }, blockers: Array.from({ length: 100 }, (_, index) => `blocker-${index}-${'x'.repeat(600)}`), verdict: { overall: 'pass' } })
    assert.equal(bounded.truncated, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
