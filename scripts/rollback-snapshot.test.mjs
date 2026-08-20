import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createRollbackSnapshot } from './create-rollback-snapshot.mjs'
import { verifyRollbackSnapshot, verifyExtractedRoot } from './verify-rollback-snapshot.mjs'

test('rollback snapshot excludes user data, verifies archive, and detects extracted drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rollback-fixture-'))
  const output = join(root, 'rollback-output')
  const included = ['install', 'profiles', 'extensions', 'architecture', 'ui.txt']
  const critical = ['install/node_modules/@deepseek-ai/dsh/package.json', 'profiles/web/package.json', 'extensions/host.js', 'architecture/contract.json', 'ui.txt']
  try {
    for (const dir of ['install/node_modules/@deepseek-ai/dsh', 'profiles/web', 'extensions', 'architecture', 'sessions']) await mkdir(join(root, dir), { recursive: true })
    await writeFile(join(root, 'install/node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ version: '0.1.0-rc.8' }))
    await writeFile(join(root, 'profiles/web/package.json'), '{}')
    await writeFile(join(root, 'extensions/host.js'), 'export const ok = true\n')
    await writeFile(join(root, 'architecture/contract.json'), '{}')
    await writeFile(join(root, 'ui.txt'), 'ui-baseline')
    await writeFile(join(root, 'sessions/formal.json'), 'must-not-archive')
    const created = await createRollbackSnapshot({ root, outputDir: output, name: 'fixture', includedPaths: included, criticalPaths: critical })
    assert.equal(created.manifest.dataPolicy.sessionsIncluded, false)
    const verified = await verifyRollbackSnapshot({ manifestPath: created.manifestPath })
    assert.equal(verified.ok, true, JSON.stringify(verified.failures))
    const extracted = join(root, 'extracted')
    const kept = await verifyRollbackSnapshot({ manifestPath: created.manifestPath, extractTo: extracted })
    assert.equal(kept.ok, true)
    await writeFile(join(extracted, 'profiles/web/package.json'), '{"drift":true}')
    const drifted = await verifyExtractedRoot(created.manifest, extracted)
    assert.equal(drifted.ok, false)
    assert.ok(drifted.failures.some((failure) => failure.includes('profiles/web/package.json')))
    const tarList = await readFile(created.manifestPath, 'utf8')
    assert.doesNotMatch(tarList, /sessions\/formal/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
