import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const script = new URL('./verify-upgrade-readiness.mjs', import.meta.url)

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-contract-'))
  const extension = 'extensions/dsh-intelligence'
  mkdirSync(join(root, extension), { recursive: true })
  mkdirSync(join(root, 'profiles/headless'), { recursive: true })
  mkdirSync(join(root, 'architecture'), { recursive: true })
  mkdirSync(join(root, 'output/ui'), { recursive: true })
  mkdirSync(join(root, 'install/node_modules/@deepseek-ai/dsh'), { recursive: true })
  writeFileSync(join(root, 'output/ui/baseline.json'), '{}\n')
  writeFileSync(join(root, 'install/node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ version: '0.1.0-rc.8' }))
  const contract = {
    schemaVersion: 1,
    baselineVersion: '0.1.0-rc.8',
    candidateVersion: null,
    installStrategy: { stagingRequired: true, allowInPlaceOverwrite: false, offlineRollbackArtifactRequired: true },
    uiContract: { manifest: 'output/ui/baseline.json', allowAutomaticRebaseline: false },
    capabilityContract: { requiredProfiles: ['profiles/headless'], requiredExtensions: [extension] },
    gates: ['runtime-contract', 'ui-integrity', 'intelligence-regression', 'headless-loader', 'doctor'].map((id) => ({ id, command: `run ${id}` })),
    dataContract: { migrationOnCopyFirst: true, rollbackVerificationRequired: true },
    rollback: { targetVersion: '0.1.0-rc.8', deleteOrRewriteCanonicalData: false },
  }
  writeFileSync(join(root, 'architecture/upgrade-contract.json'), JSON.stringify(contract, null, 2))
  return { root, contract }
}

test('baseline contract passes without mutating its files', () => {
  const { root } = fixture()
  const result = spawnSync(process.execPath, [script.pathname, '--root', root, '--json'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const output = JSON.parse(result.stdout)
  assert.equal(output.ok, true)
  assert.equal(output.mode, 'baseline')
})

test('automatic rebaseline and in-place upgrade are blocking failures', () => {
  const { root, contract } = fixture()
  contract.installStrategy.allowInPlaceOverwrite = true
  contract.uiContract.allowAutomaticRebaseline = true
  writeFileSync(join(root, 'architecture/upgrade-contract.json'), JSON.stringify(contract, null, 2))
  const result = spawnSync(process.execPath, [script.pathname, '--root', root, '--json'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  const output = JSON.parse(result.stdout)
  assert.equal(output.ok, false)
  assert.ok(output.errors.some((error) => error.startsWith('no-in-place-overwrite:')))
  assert.ok(output.errors.some((error) => error.startsWith('no-automatic-ui-rebaseline:')))
})
