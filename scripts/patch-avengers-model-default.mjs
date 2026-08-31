#!/usr/bin/env node
/**
 * Restore and verify the Host's canonical default-model selection.
 *
 * The old Avengers compatibility patch (v1) injected a hard-coded parent and
 * child route into the blank-session fallback. That made an empty Avengers
 * session diverge from the model currently selected by the user, and it also
 * made the child route diverge from its parent. The canonical Host behavior
 * is the only safe default: when there is no picked or logged selection,
 * `defaults.defaultModelSelection()` is consulted on every read.
 *
 * This migration intentionally does not know, or reproduce, any model or
 * reasoning-effort identifier. It recognizes the old state by its reviewed
 * marker and block shape, then atomically removes that whole block. Unknown
 * or partial bundle states fail closed rather than guessing.
 */
import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const PACKAGE_NAME = '@deepseek-ai/dsh-host-apiproxy'
export const SUPPORTED_VERSION = '0.1.1-rc.2'
/** Marker left by the historical hard-coded Avengers fallback. */
export const MARKER = '[dsh-patch:avengers-model-default v1]'
export const LEGACY_MARKER = MARKER

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultPackageRoot = path.join(scriptRoot, 'install/node_modules/@deepseek-ai/dsh-host-apiproxy')

const SELECTION_FUNCTION = 'function selectionFor(agent) {'
const SELECTION_END = '\n\t/** Pre-publication setup used by both fresh and resumed Web agents. */'
const DEFAULT_BRANCH_BASELINE = '\t\t\tif (logged === void 0) return defaults.defaultModelSelection();'
const LEGACY_BRANCH_PREFIX = `\t\t\tif (logged === void 0) {\n\t\t\t\t// ${MARKER}`

// Export reviewed anchors for fixture tests and future package-refresh checks.
// There is deliberately no legacy model/effort text here: the migration only
// removes the marker-delimited branch and never recreates its contents.
export const PATCH_TEXT = Object.freeze({
  selectionFunction: SELECTION_FUNCTION,
  selectionEnd: SELECTION_END,
  defaultBranchBaseline: DEFAULT_BRANCH_BASELINE,
  legacyBranchPrefix: LEGACY_BRANCH_PREFIX,
})

function targetPaths(packageRoot) {
  return {
    packageJson: path.join(packageRoot, 'package.json'),
    index: path.join(packageRoot, 'lib/index.js'),
  }
}

function countOccurrences(source, text) {
  return source.split(text).length - 1
}

async function readRequired(file, label) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (error) {
    throw new Error(`Avengers baseline migration ${label} is unavailable: ${file} (${error.code ?? error.message})`)
  }
}

function parseManifest(manifestText, file) {
  let manifest
  try {
    manifest = JSON.parse(manifestText)
  } catch (error) {
    throw new Error(`Avengers baseline migration package manifest is not valid JSON: ${file} (${error.message})`)
  }
  if (manifest.name !== PACKAGE_NAME) throw new Error(`Avengers baseline migration expected ${PACKAGE_NAME}, found ${String(manifest.name)}`)
  if (manifest.version !== SUPPORTED_VERSION) throw new Error(`Avengers baseline migration supports only ${PACKAGE_NAME} ${SUPPORTED_VERSION}, found ${String(manifest.version)}`)
  return manifest
}

function selectionBodyBounds(source) {
  if (countOccurrences(source, SELECTION_FUNCTION) !== 1) throw new Error('Avengers baseline migration expected exactly one selectionFor(agent) function')
  const start = source.indexOf(SELECTION_FUNCTION)
  const end = source.indexOf(SELECTION_END, start)
  if (end < 0) throw new Error('Avengers baseline migration could not locate selectionFor(agent) end anchor; refusing to guess')
  return { start, end }
}

function assertInsideSelection(position, bounds, label) {
  if (position < bounds.start || position >= bounds.end) throw new Error(`Avengers baseline migration found ${label} outside selectionFor(agent); refusing to guess`)
}

/** Find a JavaScript block's closing brace without being confused by strings/comments. */
function matchingBrace(source, open) {
  let depth = 0
  let quote = undefined
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote !== undefined) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = undefined
      }
      continue
    }
    if (char === '/' && next === '/') {
      lineComment = true
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      index += 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index + 1
      if (depth < 0) return -1
    }
  }
  return -1
}

function legacyBranchBounds(source, bounds) {
  if (countOccurrences(source, MARKER) !== 1) throw new Error('Avengers baseline migration found an ambiguous v1 marker; refusing to guess')
  const marker = source.indexOf(MARKER)
  const start = source.lastIndexOf('\t\t\tif (logged === void 0) {', marker)
  if (start < 0 || !source.startsWith(LEGACY_BRANCH_PREFIX, start)) throw new Error('Avengers baseline migration found a malformed v1 branch; refusing to guess')
  assertInsideSelection(start, bounds, 'v1 branch')
  const open = source.indexOf('{', start)
  const end = matchingBrace(source, open)
  if (end < 0 || end > bounds.end) throw new Error('Avengers baseline migration could not close the v1 branch; refusing to guess')
  const branch = source.slice(start, end)
  // These shape anchors identify the reviewed old branch without embedding any
  // model or reasoning identifiers in the migration code.
  for (const fragment of [
    LEGACY_BRANCH_PREFIX,
    'header?.agentPreset === "avengers"',
    'header.origin === "subagent" || header.delegationDepth > 0',
    'return defaults.defaultModelSelection();',
  ]) {
    if (countOccurrences(branch, fragment) !== 1) throw new Error(`Avengers baseline migration v1 branch is missing ${fragment}; refusing to guess`)
  }
  return { start, end }
}

function assertBaselineShape(source, bounds) {
  if (source.includes(MARKER)) throw new Error('Avengers baseline migration found a v1 marker in an unexpected baseline state; refusing to guess')
  if (countOccurrences(source, DEFAULT_BRANCH_BASELINE) !== 1) throw new Error(`Avengers baseline migration expected exactly one canonical default branch, found ${countOccurrences(source, DEFAULT_BRANCH_BASELINE)}`)
  assertInsideSelection(source.indexOf(DEFAULT_BRANCH_BASELINE), bounds, 'canonical default branch')
}

/** Replace one runtime file through a same-directory staged atomic rename. */
export async function atomicReplaceFile(file, content, { fsApi = fs } = {}) {
  const temporary = `${file}.tmp-avengers-baseline-${process.pid}-${randomUUID()}`
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
 * Restore the canonical Host default branch and verify it.
 *
 * `apply: true` migrates the old v1 bundle exactly once. A subsequent call
 * (or a clean `apply: false` check) is idempotent and reports `clean`.
 */
export async function patchAvengersModelDefault({ packageRoot = defaultPackageRoot, apply = false, fsApi = fs } = {}) {
  const normalizedRoot = path.resolve(packageRoot)
  const targets = targetPaths(normalizedRoot)
  const manifest = parseManifest(await readRequired(targets.packageJson, 'package manifest'), targets.packageJson)
  const source = await readRequired(targets.index, 'index runtime')
  const bounds = selectionBodyBounds(source)
  const legacy = source.includes(MARKER)

  if (!legacy) {
    assertBaselineShape(source, bounds)
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

  const old = legacyBranchBounds(source, bounds)
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

  const next = source.slice(0, old.start) + DEFAULT_BRANCH_BASELINE + source.slice(old.end)
  await atomicReplaceFile(targets.index, next, { fsApi })
  // Re-read and validate after the rename. This makes a successful return a
  // real baseline proof, not just proof that a write was attempted.
  const verified = await readRequired(targets.index, 'restored index runtime')
  const verifiedBounds = selectionBodyBounds(verified)
  assertBaselineShape(verified, verifiedBounds)
  return {
    ok: true,
    changed: true,
    status: 'restored',
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
    } else if (token === '--apply' || token === '--restore') args.apply = true
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
