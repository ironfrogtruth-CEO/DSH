import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const PROFILE_DIR = dirname(fileURLToPath(import.meta.url))
const DSH_HOME = dirname(dirname(PROFILE_DIR))
const BIN = join(DSH_HOME, 'bin', 'dsh')
const EXPECTED_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-headless',
  '@local/dsh-tool-policy',
  '@local/dsh-intelligence',
  '@local/dsh-memory',
  '@local/dsh-code-intelligence',
  '@local/dsh-cross-session',
  '@local/dsh-frontend-qa',
  '@local/dsh-evals',
]
const EXPECTED_LINKS = [
  '@local/dsh-intelligence',
  '@local/dsh-tool-policy',
  '@local/dsh-memory',
  '@local/dsh-code-intelligence',
  '@local/dsh-cross-session',
  '@local/dsh-frontend-qa',
  '@local/dsh-evals',
  '@local/dsh-compaction-v2',
]

function rowsFromDump(dump) {
  const rows = []
  let current = null
  for (const line of dump.split(/\r?\n/)) {
    const id = line.match(/^- id: (.+)$/)
    if (id) {
      if (current) rows.push(current)
      current = { id: id[1].trim(), lines: [line], disabled: false, name: '' }
      continue
    }
    if (!current) continue
    current.lines.push(line)
    const name = line.match(/^  name: ['"]?([^'"]+)['"]?$/)
    if (name) current.name = name[1]
    if (/^  disabled: true$/.test(line)) current.disabled = true
  }
  if (current) rows.push(current)
  return rows
}

function assertProfileManifest(manifest) {
  assert.deepEqual(manifest.dsh?.profile?.bundles, EXPECTED_BUNDLES, 'headless bundles must stay Host-only and ordered')
  for (const name of EXPECTED_LINKS) {
    assert.equal(typeof manifest.dependencies?.[name], 'string', `${name} must be a profile dependency`)
    assert.match(manifest.dependencies[name], /^link:/, `${name} must use a local link`)
  }
  assert.equal(manifest.dsh?.profile?.bundles.includes('@local/dsh-compaction-v2'), false, 'compaction-v2 is a dependency, not a bundle row')
}

function assertDump(dump) {
  const rows = rowsFromDump(dump)
  assert.doesNotMatch(dump, /@deepseek-ai\/dsh-web-app|@deepseek-ai\/dsh-client(?:-|\/)|client-ui/i, 'headless dump must not contain web-app/client/UI bundle rows')
  for (const name of EXPECTED_BUNDLES.slice(2)) assert.equal(rows.filter((row) => row.name === name && !row.disabled).length, 1, `${name} must have one enabled Host row`)
  const original = rows.filter((row) => row.name === '@deepseek-ai/dsh-compaction-basic')
  assert.equal(original.length, 1)
  assert.equal(original[0].disabled, true, 'original compaction provider must be disabled')
  const replacements = rows.filter((row) => row.name === '@local/dsh-compaction-v2' && !row.disabled)
  assert.equal(replacements.length, 1, 'one enabled local compaction replacement is required')
  const compactionConfig = replacements[0].lines.join('\n')
  for (const expected of ['thresholdRatio: 0.65', 'retainRatio: 0.24', 'maxTokens: 8192', 'compactionRetries: 1', 'maxOverflowRetries: 1', 'auto: true']) assert.match(compactionConfig, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const policyRows = rows.filter((row) => row.name === '@local/dsh-tool-policy' && !row.disabled)
  assert.equal(policyRows.length, 1, 'one enabled tool policy row is required')
  const policyConfig = policyRows[0].lines.join('\n')
  assert.match(policyConfig, /mode: observe/)
  assert.match(policyConfig, /operationMode: act/)
  assert.match(policyConfig, /workspaceRoots:/)
  assert.match(policyConfig, /\/Users\/marcus\/.dsh/)
  const activeForbidden = rows.filter((row) => !row.disabled && /(?:web-app|dsh-client|client-ui|dsh-web|tool-web)/i.test(row.name))
  assert.deepEqual(activeForbidden, [], 'headless dump must not enable Web/client/UI rows')
}

async function smoke() {
  const temporaryHome = await mkdtemp(join('/tmp', 'dsh-headless-profile-'))
  try {
    await mkdir(join(temporaryHome, 'profiles'), { recursive: true })
    await symlink(PROFILE_DIR, join(temporaryHome, 'profiles', 'headless'))
    const env = {
      ...process.env,
      HOME: process.env.HOME || homedir(),
      DSH_HOME: temporaryHome,
      DSH_MEMORY_ROOT: join(temporaryHome, 'memories'),
      DSH_MEMORY_DB: join(temporaryHome, 'memory.sqlite'),
      DSH_INTELLIGENCE_ROOT: join(temporaryHome, 'intelligence'),
      DSH_CODE_INTELLIGENCE_ROOT: join(temporaryHome, 'code-intelligence'),
      DSH_CROSS_SESSION_DB: join(temporaryHome, 'cross-session.sqlite'),
      DSH_EVALS_ROOT: join(temporaryHome, 'evals'),
    }
    const packageProbe = spawnSync(process.execPath, ['--input-type=module', '-e', "const pkg = await import('@local/dsh-compaction-v2'); if (pkg.default !== pkg.DshCompactionV2Engine || typeof pkg.default !== 'function') throw new Error('compaction-v2 package root default export mismatch')"], { cwd: PROFILE_DIR, env, encoding: 'utf8', timeout: 30_000 })
    assert.equal(packageProbe.status, 0, `${packageProbe.stdout}\n${packageProbe.stderr}`)
    const result = spawnSync(BIN, ['--profile', 'headless', '--help'], { cwd: temporaryHome, env, encoding: 'utf8', timeout: 30_000 })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /Usage: dsh --profile headless/)
    assert.doesNotMatch(result.stderr, /plugin tree failed|duplicate loader entry|failed to load/i)
    const noModel = spawnSync(BIN, ['--profile', 'headless', ''], { cwd: temporaryHome, env, encoding: 'utf8', timeout: 30_000 })
    const noModelOutput = `${noModel.stdout}\n${noModel.stderr}`
    assert.equal(noModel.status, 1, noModelOutput)
    assert.match(noModelOutput, /a task is required/i)
    assert.doesNotMatch(noModelOutput, /plugin tree failed|failed to apply loader entry|failed to import loader entry|duplicate loader entry/i)
    return {
      status: result.status,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      fullLoaderNoModel: { status: noModel.status, reachedTaskValidation: true },
    }
  } finally {
    await rm(temporaryHome, { recursive: true, force: true })
  }
}

export async function verify({ runSmoke = process.argv.includes('--smoke') } = {}) {
  const manifest = JSON.parse(await readFile(join(PROFILE_DIR, 'package.json'), 'utf8'))
  assertProfileManifest(manifest)
  const dump = spawnSync(BIN, ['--profile', 'headless', '--dump-config'], { cwd: DSH_HOME, encoding: 'utf8', timeout: 30_000 })
  assert.equal(dump.status, 0, `${dump.stdout}\n${dump.stderr}`)
  assertDump(dump.stdout)
  const smokeResult = runSmoke ? await smoke() : null
  return {
    profile: 'headless',
    bundles: EXPECTED_BUNDLES,
    compactionProvider: '@local/dsh-compaction-v2',
    evidenceLevel: runSmoke ? 'config + package import + full Loader task validation; no model/tool acceptance' : 'config dump only',
    smoke: smokeResult,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verify().then((result) => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  }).catch((error) => {
    process.stderr.write(`${error.stack || error}\n`)
    process.exitCode = 1
  })
}
