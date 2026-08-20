import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROFILE_DIR = dirname(fileURLToPath(import.meta.url))
const DSH_HOME = dirname(dirname(PROFILE_DIR))
const BIN = join(DSH_HOME, 'bin', 'dsh')
const EXPECTED_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@local/dsh-browser',
  '@local/dsh-dsbalance',
  '@local/dsh-git',
  '@local/dsh-memory',
  '@local/dsh-screen',
  '@local/dsh-shrimp-shell',
  '@local/zhipu-media',
  '@dsh-market/plugin',
  '@local/dsh-tool-policy',
  '@local/dsh-intelligence',
  '@local/dsh-code-intelligence',
  '@local/dsh-cross-session',
  '@local/dsh-frontend-qa',
  '@local/dsh-evals',
]
const HOST_ROWS = [
  '@local/dsh-tool-policy',
  '@local/dsh-intelligence',
  '@local/dsh-memory',
  '@local/dsh-code-intelligence',
  '@local/dsh-cross-session',
  '@local/dsh-frontend-qa',
  '@local/dsh-evals',
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

function assertManifest(manifest) {
  assert.deepEqual(manifest.dsh?.profile?.bundles, EXPECTED_BUNDLES, 'candidate bundle order changed')
  for (const name of EXPECTED_BUNDLES.filter((name) => name.startsWith('@local/') || name === '@dsh-market/plugin')) {
    assert.match(String(manifest.dependencies?.[name] || ''), /^link:/, `${name} must remain a local link`)
  }
  assert.match(String(manifest.dependencies?.['@local/dsh-compaction-v2'] || ''), /^link:/)
  assert.equal(manifest.dsh.profile.bundles.includes('@local/dsh-compaction-v2'), false, 'compaction-v2 is resolved by the reliable agent preset, not a global bundle row')
}

function assertDump(dump) {
  const rows = rowsFromDump(dump)
  for (const name of HOST_ROWS) assert.equal(rows.filter((row) => row.name === name && !row.disabled).length, 1, `${name} must have one enabled row`)
  assert.equal(rows.filter((row) => row.name === '@deepseek-ai/dsh-web-app' && !row.disabled).length > 0, true, 'candidate must keep the current Web app')
  const original = rows.filter((row) => row.name === '@deepseek-ai/dsh-compaction-basic')
  assert.equal(original.length, 1)
  assert.equal(original[0].disabled, true, 'Web app disables the global provider; agent presets own isolated compaction')
  const replacement = rows.filter((row) => row.name === '@local/dsh-compaction-v2' && !row.disabled)
  assert.equal(replacement.length, 0, 'v2 must not be registered globally and again inside a reliable agent')
  const policy = rows.find((row) => row.name === '@local/dsh-tool-policy' && !row.disabled)
  assert.match(policy.lines.join('\n'), /mode: observe/)
  assert.match(policy.lines.join('\n'), /operationMode: act/)
  assert.match(policy.lines.join('\n'), /\/Users\/marcus\/Desktop/)
  assert.match(policy.lines.join('\n'), /\/Users\/marcus\/.dsh/)
}

function isolatedEnv(temporaryHome) {
  return {
    ...process.env,
    DSH_HOME: temporaryHome,
    DSH_MEMORY_ROOT: join(temporaryHome, 'memory'),
    DSH_MEMORY_DB: join(temporaryHome, 'memory', 'memory.sqlite'),
    DSH_INTELLIGENCE_ROOT: join(temporaryHome, 'intelligence'),
    DSH_CODE_INTELLIGENCE_ROOT: join(temporaryHome, 'code-intelligence'),
    DSH_CROSS_SESSION_DB: join(temporaryHome, 'cross-session.sqlite'),
    DSH_COMPACTION_V2_ROOT: join(temporaryHome, 'compaction-v2'),
    DSH_EVALS_ROOT: join(temporaryHome, 'evals'),
  }
}

async function waitForWeb(child, timeoutMs = 30_000) {
  let stdout = ''
  let stderr = ''
  let settled = false
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      error ? reject(error) : resolve(value)
    }
    const inspect = () => {
      const match = stdout.match(/dsh web: http:\/\/127\.0\.0\.1:(\d+)/)
      if (match) finish(null, { port: Number(match[1]), stdout, stderr })
    }
    child.stdout.on('data', (chunk) => { stdout += String(chunk); inspect() })
    child.stderr.on('data', (chunk) => { stderr += String(chunk); inspect() })
    child.once('exit', (code, signal) => finish(new Error(`candidate exited before listen: code=${code} signal=${signal}\n${stdout}\n${stderr}`)))
    const timer = setTimeout(() => finish(new Error(`candidate startup timed out\n${stdout}\n${stderr}`)), timeoutMs)
  })
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGINT')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
}

async function smoke() {
  const temporaryHome = await mkdtemp('/tmp/dsh-web-intelligence-profile-')
  let child
  try {
    await mkdir(join(temporaryHome, 'profiles'), { recursive: true })
    await symlink(PROFILE_DIR, join(temporaryHome, 'profiles', 'web-intelligence'))
    const env = isolatedEnv(temporaryHome)
    const help = spawnSync(BIN, ['--profile', 'web-intelligence', '--port', '0', '--help'], { cwd: temporaryHome, env, encoding: 'utf8', timeout: 30_000 })
    assert.equal(help.status, 0, `${help.stdout}\n${help.stderr}`)
    assert.match(help.stdout, /Usage: dsh --profile web/)
    assert.doesNotMatch(help.stderr, /plugin tree failed|duplicate loader entry|failed to load/i)

    child = spawn(BIN, ['--profile', 'web-intelligence', '--port', '0', '--no-open'], { cwd: temporaryHome, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const started = await waitForWeb(child)
    const home = await fetch(`http://127.0.0.1:${started.port}/`)
    assert.equal(home.status, 200)
    const policyResponse = await fetch(`http://127.0.0.1:${started.port}/api/shrimp/vision/policy`)
    assert.equal(policyResponse.status, 200)
    const policy = await policyResponse.json()
    assert.equal(policy.ok, true)
    assert.equal(policy.mode, 'bridge')
    assert.equal(policy.model, 'deepseek-v4-flash')
    return {
      helpStatus: help.status,
      startup: { status: 'passed', ephemeralPort: true, homeStatus: home.status, visionPolicy: policy.mode },
      isolatedHome: true,
      modelOrToolAcceptance: false,
    }
  } finally {
    if (child) await stopChild(child)
    await rm(temporaryHome, { recursive: true, force: true })
  }
}

export async function verify({ runSmoke = process.argv.includes('--smoke') } = {}) {
  const manifest = JSON.parse(await readFile(join(PROFILE_DIR, 'package.json'), 'utf8'))
  assertManifest(manifest)
  const dump = spawnSync(BIN, ['--profile', 'web-intelligence', '--dump-config'], { cwd: DSH_HOME, encoding: 'utf8', timeout: 30_000 })
  assert.equal(dump.status, 0, `${dump.stdout}\n${dump.stderr}`)
  assertDump(dump.stdout)
  return {
    profile: 'web-intelligence',
    bundles: EXPECTED_BUNDLES,
    hostRows: HOST_ROWS,
    profileCompactionProvider: null,
    reliableDevelopmentCompactionTarget: '@local/dsh-compaction-v2',
    defaultProfileChanged: false,
    evidenceLevel: runSmoke ? 'config + full Loader + isolated ephemeral Web startup; no model/tool acceptance' : 'config dump only',
    smoke: runSmoke ? await smoke() : null,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verify().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`${error.stack || error}\n`)
    process.exitCode = 1
  })
}
