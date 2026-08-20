#!/usr/bin/env node
/**
 * Read-only validation for the rc.8 upgrade compatibility contract.
 * It never installs, switches, rewrites a baseline, migrates data, or starts DSH.
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

function parseArgs(argv) {
  const args = { root: process.cwd(), contract: null, mode: 'baseline', stagingRoot: null, format: 'text' }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--root') args.root = argv[++i]
    else if (token === '--contract') args.contract = argv[++i]
    else if (token === '--mode') args.mode = argv[++i]
    else if (token === '--staging-root') args.stagingRoot = argv[++i]
    else if (token === '--json' || token === '--format=json') args.format = 'json'
    else if (token === '--help' || token === '-h') args.help = true
    else throw new Error(`unknown option ${token}`)
  }
  if (!['baseline', 'candidate'].includes(args.mode)) throw new Error('--mode must be baseline or candidate')
  args.root = resolve(args.root)
  args.contract = resolve(args.contract || join(args.root, 'architecture/upgrade-contract.json'))
  args.stagingRoot = args.stagingRoot ? resolve(args.stagingRoot) : null
  return args
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function safeRootPath(root, path, label) {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path) || path.split('/').includes('..')) {
    throw new Error(`${label} must be a non-empty root-relative path`)
  }
  return join(root, path)
}

function validateContract(root, contract, mode, stagingRoot) {
  const checks = []
  const add = (id, ok, detail) => checks.push({ id, status: ok ? 'pass' : 'fail', detail })
  const baseline = String(contract?.baselineVersion || '')
  add('schema-version', contract?.schemaVersion === 1, `schemaVersion=${String(contract?.schemaVersion)}`)
  add('baseline-version', /^0\.1\.0-rc\.\d+$/.test(baseline), `baselineVersion=${baseline || 'missing'}`)
  add('no-in-place-overwrite', contract?.installStrategy?.stagingRequired === true && contract?.installStrategy?.allowInPlaceOverwrite === false, 'stagingRequired=true and allowInPlaceOverwrite=false')
  add('no-automatic-ui-rebaseline', contract?.uiContract?.allowAutomaticRebaseline === false, 'allowAutomaticRebaseline=false')
  add('offline-rollback', contract?.installStrategy?.offlineRollbackArtifactRequired === true && contract?.rollback?.targetVersion === baseline, `rollback=${String(contract?.rollback?.targetVersion || 'missing')}`)
  add('canonical-data-protection', contract?.dataContract?.migrationOnCopyFirst === true && contract?.dataContract?.rollbackVerificationRequired === true && contract?.rollback?.deleteOrRewriteCanonicalData === false, 'copy-first migration and canonical data rewrite forbidden')

  let manifest = null
  try { manifest = safeRootPath(root, contract?.uiContract?.manifest, 'uiContract.manifest') } catch (error) { add('ui-manifest-path', false, error.message) }
  if (manifest) add('ui-manifest-exists', existsSync(manifest), contract.uiContract.manifest)

  const missingExtensions = []
  for (const path of contract?.capabilityContract?.requiredExtensions ?? []) {
    try {
      if (!existsSync(safeRootPath(root, path, 'required extension'))) missingExtensions.push(path)
    } catch { missingExtensions.push(String(path)) }
  }
  add('required-extensions', missingExtensions.length === 0, missingExtensions.length === 0 ? `${contract.capabilityContract.requiredExtensions.length} present` : `missing: ${missingExtensions.join(', ')}`)

  const missingProfiles = []
  for (const path of contract?.capabilityContract?.requiredProfiles ?? []) {
    try {
      if (!existsSync(safeRootPath(root, path, 'required profile'))) missingProfiles.push(path)
    } catch { missingProfiles.push(String(path)) }
  }
  add('required-profiles', missingProfiles.length === 0, missingProfiles.length === 0 ? `${contract?.capabilityContract?.requiredProfiles?.length ?? 0} present` : `missing: ${missingProfiles.join(', ')}`)

  const gates = Array.isArray(contract?.gates) ? contract.gates : []
  const ids = gates.map((gate) => gate?.id).filter(Boolean)
  const requiredGateIds = ['runtime-contract', 'ui-integrity', 'intelligence-regression', 'headless-loader', 'doctor']
  const missingGates = requiredGateIds.filter((id) => !ids.includes(id))
  const duplicateGates = ids.filter((id, index) => ids.indexOf(id) !== index)
  const invalidCommands = gates.filter((gate) => typeof gate?.command !== 'string' || gate.command.trim().length === 0).map((gate) => String(gate?.id || 'unknown'))
  add('gate-contract', missingGates.length === 0 && duplicateGates.length === 0 && invalidCommands.length === 0, `missing=${missingGates.join(',') || 'none'} duplicate=${duplicateGates.join(',') || 'none'} invalid=${invalidCommands.join(',') || 'none'}`)

  const installRoot = mode === 'candidate' ? stagingRoot : root
  if (mode === 'candidate') {
    add('candidate-version-declared', typeof contract?.candidateVersion === 'string' && contract.candidateVersion.length > 0, `candidateVersion=${String(contract?.candidateVersion || 'missing')}`)
    add('staging-root-isolated', Boolean(stagingRoot) && stagingRoot !== root && !root.startsWith(`${stagingRoot}/`) && !stagingRoot.startsWith(`${root}/install`), stagingRoot || 'missing')
  }
  if (installRoot) {
    const installedFile = join(installRoot, 'install/node_modules/@deepseek-ai/dsh/package.json')
    try {
      const installedVersion = String(readJson(installedFile).version || '')
      const expected = mode === 'candidate' ? String(contract.candidateVersion || '') : baseline
      add('installed-version', installedVersion === expected, `expected=${expected || 'missing'} installed=${installedVersion || 'missing'}`)
    } catch (error) {
      add('installed-version', false, error.message)
    }
  }
  return checks
}

function main() {
  let args
  try { args = parseArgs(process.argv.slice(2)) } catch (error) {
    console.error(error.message)
    process.exitCode = 2
    return
  }
  if (args.help) {
    console.log('Usage: verify-upgrade-readiness.mjs [--root PATH] [--contract PATH] [--mode baseline|candidate] [--staging-root PATH] [--json]')
    return
  }
  let contract
  try { contract = readJson(args.contract) } catch (error) {
    const result = { ok: false, mode: args.mode, contract: args.contract, checks: [], errors: [`cannot read contract: ${error.message}`] }
    console.log(args.format === 'json' ? JSON.stringify(result, null, 2) : `FAIL upgrade-readiness: ${result.errors[0]}`)
    process.exitCode = 1
    return
  }
  const checks = validateContract(args.root, contract, args.mode, args.stagingRoot)
  const failed = checks.filter((check) => check.status === 'fail')
  const result = { ok: failed.length === 0, mode: args.mode, contract: args.contract, checks, errors: failed.map((check) => `${check.id}: ${check.detail}`) }
  if (args.format === 'json') console.log(JSON.stringify(result, null, 2))
  else {
    for (const check of checks) console.log(`${check.status === 'pass' ? 'PASS' : 'FAIL'} ${check.id}: ${check.detail}`)
    console.log(`${result.ok ? 'PASS' : 'FAIL'} upgrade-readiness: ${checks.length - failed.length}/${checks.length} checks passed`)
  }
  process.exitCode = result.ok ? 0 : 1
}

main()
