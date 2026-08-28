#!/usr/bin/env node
/**
 * Replay the Avengers preset's session-local model defaults into the locked
 * rc.2 Host API proxy bundle.
 *
 * The package has one process-wide default model.  A preset cannot change
 * that value without leaking into every other session, so this compatibility
 * patch adds a narrow, session-header-aware fallback inside selectionFor().
 * It is deliberately limited to the branch where there is neither a
 * session-picked selection nor a logged request.  Picked and logged routes
 * therefore retain their existing precedence.
 *
 * This is a version-locked replay patch.  Unknown upstream or partial source
 * is a review boundary: never guess, never overwrite.  Runtime replacement
 * is staged in the target directory, fsynced, and atomically renamed.
 */
import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const PACKAGE_NAME = '@deepseek-ai/dsh-host-apiproxy'
export const SUPPORTED_VERSION = '0.1.1-rc.2'
export const MARKER = '[dsh-patch:avengers-model-default v1]'

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultPackageRoot = path.join(scriptRoot, 'install/node_modules/@deepseek-ai/dsh-host-apiproxy')

const SELECTION_FUNCTION = 'function selectionFor(agent) {'
const SELECTION_END = '\n\t/** Pre-publication setup used by both fresh and resumed Web agents. */'

/** The exact rc.2 fallback branch that is safe to replace. */
const DEFAULT_BRANCH_BASELINE = '\t\t\tif (logged === void 0) return defaults.defaultModelSelection();'

/**
 * The only runtime change made by this patch.  Keep the default fallback as
 * the final statement so every non-Avengers session is byte-for-byte logical
 * equivalent to the upstream branch.
 */
const DEFAULT_BRANCH_PATCHED = `\t\t\tif (logged === void 0) {
\t\t\t\t// ${MARKER}
\t\t\t\tconst header = agent.session.header;
\t\t\t\tif (header?.agentPreset === "avengers") {
\t\t\t\t\tconst child = header.origin === "subagent" || header.delegationDepth > 0;
\t\t\t\t\treturn child ? {
\t\t\t\t\t\tprovider: "zhipu-glm",
\t\t\t\t\t\tmodel: "glm-5.3-flash",
\t\t\t\t\t\treasoningEffort: "medium"
\t\t\t\t\t} : {
\t\t\t\t\t\tprovider: "deepseek-official",
\t\t\t\t\t\tmodel: "deepseek-v4-pro",
\t\t\t\t\t\treasoningEffort: "high"
\t\t\t\t\t};
\t\t\t\t}
\t\t\t\treturn defaults.defaultModelSelection();
\t\t\t}`

// Export exact source fragments so fixture tests can prove that only the
// reviewed selectionFor fallback changed.
export const PATCH_TEXT = Object.freeze({
  selectionFunction: SELECTION_FUNCTION,
  selectionEnd: SELECTION_END,
  defaultBranchBaseline: DEFAULT_BRANCH_BASELINE,
  defaultBranchPatched: DEFAULT_BRANCH_PATCHED,
})

/**
 * Return the model selection that the patched fallback must use.
 *
 * `undefined` means this is not an Avengers session and the caller must use
 * the process-wide default.  A fresh record is returned for each call so
 * callers cannot mutate a shared routing object.
 */
export function resolveAvengersDefaultSelection(header) {
  if (header?.agentPreset !== 'avengers') return undefined
  const child = header.origin === 'subagent' || header.delegationDepth > 0
  return child ? {
    provider: 'zhipu-glm',
    model: 'glm-5.3-flash',
    reasoningEffort: 'medium',
  } : {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
  }
}

function targetPaths(packageRoot) {
  return {
    packageJson: path.join(packageRoot, 'package.json'),
    index: path.join(packageRoot, 'lib/index.js'),
  }
}

function countOccurrences(source, text) {
  return source.split(text).length - 1
}

function replaceExactly(source, oldText, newText, label) {
  const count = countOccurrences(source, oldText)
  if (count !== 1) throw new Error(`Avengers model-default patch expected exactly one ${label}, found ${count}`)
  return source.replace(oldText, newText)
}

async function readRequired(file, label) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (error) {
    throw new Error(`Avengers model-default patch ${label} is unavailable: ${file} (${error.code ?? error.message})`)
  }
}

function parseManifest(manifestText, file) {
  let manifest
  try {
    manifest = JSON.parse(manifestText)
  } catch (error) {
    throw new Error(`Avengers model-default patch package manifest is not valid JSON: ${file} (${error.message})`)
  }
  if (manifest.name !== PACKAGE_NAME) throw new Error(`Avengers model-default patch expected ${PACKAGE_NAME}, found ${String(manifest.name)}`)
  if (manifest.version !== SUPPORTED_VERSION) throw new Error(`Avengers model-default patch supports only ${PACKAGE_NAME} ${SUPPORTED_VERSION}, found ${String(manifest.version)}`)
  return manifest
}

function selectionBodyBounds(source) {
  if (countOccurrences(source, SELECTION_FUNCTION) !== 1) throw new Error('Avengers model-default patch expected exactly one selectionFor(agent) function')
  const start = source.indexOf(SELECTION_FUNCTION)
  const end = source.indexOf(SELECTION_END, start)
  if (end < 0) throw new Error('Avengers model-default patch could not locate selectionFor(agent) end anchor; refusing to guess')
  return { start, end }
}

function assertInsideSelection(source, fragment, bounds, label) {
  if (countOccurrences(source, fragment) !== 1) throw new Error(`Avengers model-default patch expected exactly one ${label}`)
  const position = source.indexOf(fragment)
  if (position < bounds.start || position > bounds.end) throw new Error(`Avengers model-default patch found ${label} outside selectionFor(agent); refusing to guess`)
}

function assertBaselineShape(source) {
  if (source.includes(MARKER) || source.includes(DEFAULT_BRANCH_PATCHED)) throw new Error('Avengers model-default patch found a marker or patched branch in an unexpected baseline state; refusing to guess')
  const bounds = selectionBodyBounds(source)
  assertInsideSelection(source, DEFAULT_BRANCH_BASELINE, bounds, 'selectionFor default branch')
}

function assertPatchedShape(source) {
  if (countOccurrences(source, MARKER) !== 1 || source.includes(DEFAULT_BRANCH_BASELINE)) throw new Error('Avengers model-default patch found an ambiguous patched state; refusing to guess')
  const bounds = selectionBodyBounds(source)
  assertInsideSelection(source, DEFAULT_BRANCH_PATCHED, bounds, 'patched Avengers default branch')
  for (const fragment of [
    'header?.agentPreset === "avengers"',
    'header.origin === "subagent" || header.delegationDepth > 0',
    'provider: "deepseek-official"',
    'model: "deepseek-v4-pro"',
    'reasoningEffort: "high"',
    'provider: "zhipu-glm"',
    'model: "glm-5.3-flash"',
    'reasoningEffort: "medium"',
    'return defaults.defaultModelSelection();',
  ]) {
    if (countOccurrences(DEFAULT_BRANCH_PATCHED, fragment) !== 1 || countOccurrences(source, fragment) < 1) throw new Error(`Avengers model-default patch is missing ${fragment}; refusing to guess`)
  }
}

/**
 * Replace one runtime bundle through a same-directory temporary file.  The
 * optional fsApi is injectable for failure-path tests.
 */
export async function atomicReplaceFile(file, content, { fsApi = fs } = {}) {
  const temporary = `${file}.tmp-avengers-model-default-${process.pid}-${randomUUID()}`
  let handle
  try {
    handle = await fsApi.open(temporary, 'wx', 0o644)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fsApi.rename(temporary, file)
  } catch (error) {
    try { await handle?.close() } catch {}
    try { await fsApi.unlink(temporary) } catch {}
    throw error
  }
}

/**
 * Inspect or apply the version-locked Avengers default-model patch.
 *
 * `apply: false` is a read-only check.  A clean patched bundle returns
 * `ok: true`; a valid baseline returns `ok: false, status: "pending"` so a
 * CI/boot check cannot mistake an unapplied compatibility patch for success.
 */
export async function patchAvengersModelDefault({ packageRoot = defaultPackageRoot, apply = false, fsApi = fs } = {}) {
  const normalizedRoot = path.resolve(packageRoot)
  const targets = targetPaths(normalizedRoot)
  const manifestText = await readRequired(targets.packageJson, 'package manifest')
  const manifest = parseManifest(manifestText, targets.packageJson)
  const source = await readRequired(targets.index, 'index runtime')

  const patched = source.includes(MARKER)
  if (patched) assertPatchedShape(source)
  else assertBaselineShape(source)

  if (patched) {
    return {
      ok: true,
      changed: false,
      status: 'clean',
      packageName: PACKAGE_NAME,
      version: manifest.version,
      packageRoot: normalizedRoot,
      target: targets.index,
      apply: Boolean(apply),
    }
  }

  if (!apply) {
    return {
      ok: false,
      changed: false,
      status: 'pending',
      packageName: PACKAGE_NAME,
      version: manifest.version,
      packageRoot: normalizedRoot,
      target: targets.index,
      apply: false,
    }
  }

  const next = replaceExactly(source, DEFAULT_BRANCH_BASELINE, DEFAULT_BRANCH_PATCHED, 'selectionFor default branch')
  await atomicReplaceFile(targets.index, next, { fsApi })
  return {
    ok: true,
    changed: true,
    status: 'applied',
    packageName: PACKAGE_NAME,
    version: manifest.version,
    packageRoot: normalizedRoot,
    target: targets.index,
    apply: true,
  }
}

function parseArgs(argv) {
  const args = { packageRoot: defaultPackageRoot, apply: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--package-root') {
      const value = argv[++index]
      if (!value) throw new Error('--package-root requires a path')
      args.packageRoot = value
    } else if (token === '--apply') args.apply = true
    else if (token === '--check') args.apply = false
    else if (token === '--help' || token === '-h') args.help = true
    else throw new Error(`unknown option ${token}`)
  }
  return args
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) console.log('Usage: patch-avengers-model-default.mjs [--check | --apply] [--package-root PACKAGE_ROOT]')
    else {
      const result = await patchAvengersModelDefault(args)
      console.log(JSON.stringify(result, null, 2))
      process.exitCode = result.ok ? 0 : 1
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, status: 'failed', error: String(error?.message || error) }))
    process.exitCode = 2
  }
}
