#!/usr/bin/env node
/**
 * Check or replay the reviewed CyberMarcus UI bundles for the locked DSH
 * baseline. A different upstream version is a compatibility-review boundary:
 * this script refuses to overwrite it.
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

export const BASELINE_VERSION = '0.1.1-rc.2'
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const PATCHES = Object.freeze([
  'dsh-client-ui-agent-preset',
  'dsh-client-ui-conversation',
  'dsh-client-ui-jobs',
  'dsh-client-ui-skill',
  'dsh-client-ui-trajectory',
  'dsh-client-ui-workspace',
  'dsh-session-log-export',
].map((packageName) => Object.freeze({
  packageName,
  source: `custom-ui-patches/${packageName}/client.js.modified`,
  target: `install/node_modules/@deepseek-ai/${packageName}/lib/client.js`,
})))

// The current rc.2 subagent bundle intentionally keeps the reviewed upstream
// lineage UI. The older custom modified file is not replayable, but the live
// upstream hash remains protected so --check cannot report a false clean.
export const PROTECTED_BUNDLES = Object.freeze([Object.freeze({
  packageName: 'dsh-client-ui-subagent',
  target: 'install/node_modules/@deepseek-ai/dsh-client-ui-subagent/lib/client.js',
  expectedSha256: '5499863cb2fc4d2b68157e6fa2d072b5e3b29be99ecfa6ec71fa1c659aef80cb',
  policy: 'reviewed-upstream-do-not-replay-legacy-custom-bundle',
})])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function installedVersion(root) {
  const manifest = JSON.parse(await readFile(join(root, 'install/node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
  return String(manifest.version || '')
}

export async function atomicWrite(target, content) {
  const temporary = `${target}.tmp-ui-replay-${process.pid}-${randomUUID()}`
  const mode = (await stat(target)).mode & 0o777
  try {
    await writeFile(temporary, content, { mode: mode || 0o644 })
    await rename(temporary, target)
  } catch (error) {
    try { await unlink(temporary) } catch {}
    throw error
  }
}

export async function replayCustomUiPatches({ root = scriptRoot, apply = false, writer = atomicWrite } = {}) {
  const normalizedRoot = resolve(root)
  const version = await installedVersion(normalizedRoot)
  if (version !== BASELINE_VERSION) {
    return {
      ok: false,
      status: 'blocked',
      code: 'UPSTREAM_VERSION_REVIEW_REQUIRED',
      baselineVersion: BASELINE_VERSION,
      installedVersion: version,
      apply: false,
      message: '检测到新的 DSH 版本；必须在隔离目录完成 bundle 兼容比对和全部升级 Gate，禁止盲目覆盖。',
      patches: [],
    }
  }
  const protectedBundles = []
  for (const bundle of PROTECTED_BUNDLES) {
    const content = await readFile(join(normalizedRoot, bundle.target))
    const actualSha256 = sha256(content)
    protectedBundles.push({ ...bundle, actualSha256, matches: actualSha256 === bundle.expectedSha256 })
  }
  if (protectedBundles.some((bundle) => !bundle.matches)) {
    return {
      ok: false,
      status: 'drift',
      code: 'PROTECTED_UPSTREAM_BUNDLE_DRIFT',
      baselineVersion: BASELINE_VERSION,
      installedVersion: version,
      apply: false,
      patches: [],
      protectedBundles,
    }
  }
  const prepared = []
  for (const patch of PATCHES) {
    const sourcePath = join(normalizedRoot, patch.source)
    const targetPath = join(normalizedRoot, patch.target)
    const [source, target] = await Promise.all([readFile(sourcePath), readFile(targetPath)])
    const beforeMatches = source.equals(target)
    prepared.push({ patch, source, target, targetPath, beforeMatches })
  }
  const appliedTargets = []
  if (apply) {
    try {
      for (const row of prepared) {
        if (row.beforeMatches) continue
        await writer(row.targetPath, row.source)
        appliedTargets.push(row)
      }
    } catch (error) {
      const rollbackErrors = []
      for (const row of appliedTargets.reverse()) {
        try { await atomicWrite(row.targetPath, row.target) } catch (rollbackError) { rollbackErrors.push(String(rollbackError?.message || rollbackError)) }
      }
      return {
        ok: false,
        status: 'failed',
        code: rollbackErrors.length ? 'APPLY_FAILED_ROLLBACK_INCOMPLETE' : 'APPLY_FAILED_ROLLED_BACK',
        error: String(error?.message || error),
        rollbackErrors,
        baselineVersion: BASELINE_VERSION,
        installedVersion: version,
        apply: true,
        patches: [],
        protectedBundles,
      }
    }
  }
  const rows = prepared.map(({ patch, source, target, beforeMatches }) => ({
    ...patch,
    beforeMatches,
    matches: apply ? true : beforeMatches,
    applied: apply && !beforeMatches,
    sourceSha256: sha256(source),
    targetSha256: apply ? sha256(source) : sha256(target),
  }))
  const clean = rows.every((row) => row.matches)
  return {
    ok: clean,
    status: clean ? (rows.some((row) => row.applied) ? 'applied' : 'clean') : 'drift',
    baselineVersion: BASELINE_VERSION,
    installedVersion: version,
    apply,
    patches: rows,
    protectedBundles,
    studioReplay: 'custom-ui-patches/dsh-idesign-ippt-studio/replay-brand.sh',
  }
}

function parseArgs(argv) {
  const args = { root: scriptRoot, apply: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--root') args.root = argv[++index]
    else if (token === '--apply') args.apply = true
    else if (token === '--check') args.apply = false
    else if (token === '--help' || token === '-h') args.help = true
    else throw new Error(`unknown option ${token}`)
  }
  return args
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) console.log('Usage: replay-custom-ui-patches.mjs [--check | --apply] [--root PATH]')
    else {
      const result = await replayCustomUiPatches(args)
      console.log(JSON.stringify(result, null, 2))
      process.exitCode = result.ok ? 0 : 1
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, status: 'failed', error: String(error?.message || error) }))
    process.exitCode = 2
  }
}
