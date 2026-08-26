#!/usr/bin/env node
/**
 * Add the client-only `ui.kind === "action"` command path to the locked rc.2
 * CommandUiRuntime bundle. The patch has an explicit v1 -> v2 migration; any
 * other upstream or partial shape is a compatibility boundary.
 */
import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const SUPPORTED_VERSION = '0.1.1-rc.2'
export const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-commands'
export const PACKAGE_RELATIVE_PATH = 'install/node_modules/@deepseek-ai/dsh-client-ui-commands'
export const TARGET_RELATIVE_PATH = `${PACKAGE_RELATIVE_PATH}/lib/client.js`
export const LEGACY_MARKER = '[dsh-patch:client-command-actions v1]'
export const MARKER = '[dsh-patch:client-command-actions v2]'

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJsonRelativePath = `${PACKAGE_RELATIVE_PATH}/package.json`

const DISPATCH_BASELINE = `\t\t\t\tif (contribution !== void 0 && contribution.available(pick.session)) {
\t\t\t\t\tthis.openPopup(name, contribution.ui, pick.session, {
\t\t\t\t\t\tvia: "menu",
\t\t\t\t\t\tspan: pick.span
\t\t\t\t\t});
\t\t\t\t\treturn "handled";
\t\t\t\t}`

const DISPATCH_V1 = `\t\t\t\tif (contribution !== void 0 && contribution.available(pick.session)) {
\t\t\t\t\tif (contribution.ui.kind === "action") {
\t\t\t\t\t\tthis.consumeVia(pick.session.sessionId, {
\t\t\t\t\t\t\tvia: "menu",
\t\t\t\t\t\t\tspan: pick.span
\t\t\t\t\t\t});
\t\t\t\t\t\tthis.runClientAction(name, contribution.ui, pick.session);
\t\t\t\t\t\treturn "handled";
\t\t\t\t\t}
\t\t\t\t\tthis.openPopup(name, contribution.ui, pick.session, {
\t\t\t\t\t\tvia: "menu",
\t\t\t\t\t\tspan: pick.span
\t\t\t\t\t});
\t\t\t\t\treturn "handled";
\t\t\t\t}`

const DISPATCH_V2 = `\t\t\t\tif (contribution !== void 0 && contribution.available(pick.session)) {
\t\t\t\t\tif (contribution.ui.kind === "action") {
\t\t\t\t\t\tconst consumed = this.consumeVia(pick.session.sessionId, {
\t\t\t\t\t\t\tvia: "menu",
\t\t\t\t\t\t\tspan: pick.span
\t\t\t\t\t\t});
\t\t\t\t\t\tif (consumed) this.runClientAction(name, contribution.ui, pick.session);
\t\t\t\t\t\treturn "handled";
\t\t\t\t\t}
\t\t\t\t\tthis.openPopup(name, contribution.ui, pick.session, {
\t\t\t\t\t\tvia: "menu",
\t\t\t\t\t\tspan: pick.span
\t\t\t\t\t});
\t\t\t\t\treturn "handled";
\t\t\t\t}`

const MATCH_ENTER_BASELINE = `\t\t\t\tif (contribution !== void 0 && contribution.available(session)) {
\t\t\t\t\tif (!bare) return void 0;
\t\t\t\t\tif (envelope.images > 0) refuseImages();
\t\t\t\t\tthis.openPopup(name, contribution.ui, session, {
\t\t\t\t\t\tvia: "enter",
\t\t\t\t\t\ttoken
\t\t\t\t\t});
\t\t\t\t\treturn "handled";
\t\t\t\t}`

const MATCH_ENTER_V1 = `\t\t\t\tif (contribution !== void 0 && contribution.available(session)) {
\t\t\t\t\tif (!bare) return void 0;
\t\t\t\t\tif (contribution.ui.kind === "action") {
\t\t\t\t\t\tif (envelope.images > 0) refuseImages();
\t\t\t\t\t\tthis.consumeVia(session.sessionId, {
\t\t\t\t\t\t\tvia: "enter",
\t\t\t\t\t\t\ttoken
\t\t\t\t\t\t});
\t\t\t\t\t\tthis.runClientAction(name, contribution.ui, session);
\t\t\t\t\t\treturn "handled";
\t\t\t\t\t}
\t\t\t\t\tif (envelope.images > 0) refuseImages();
\t\t\t\t\tthis.openPopup(name, contribution.ui, session, {
\t\t\t\t\t\tvia: "enter",
\t\t\t\t\t\ttoken
\t\t\t\t\t});
\t\t\t\t\treturn "handled";
\t\t\t\t}`

const MATCH_ENTER_V2 = `\t\t\t\tif (contribution !== void 0 && contribution.available(session)) {
\t\t\t\t\tif (!bare) return void 0;
\t\t\t\t\tif (contribution.ui.kind === "action") {
\t\t\t\t\t\tif (envelope.images > 0) refuseImages();
\t\t\t\t\t\tconst consumed = this.consumeVia(session.sessionId, {
\t\t\t\t\t\t\tvia: "enter",
\t\t\t\t\t\t\ttoken
\t\t\t\t\t\t});
\t\t\t\t\t\tif (consumed) this.runClientAction(name, contribution.ui, session);
\t\t\t\t\t\treturn "handled";
\t\t\t\t\t}
\t\t\t\t\tif (envelope.images > 0) refuseImages();
\t\t\t\t\tthis.openPopup(name, contribution.ui, session, {
\t\t\t\t\t\tvia: "enter",
\t\t\t\t\t\ttoken
\t\t\t\t\t});
\t\t\t\t\treturn "handled";
\t\t\t\t}`

const CONSUME_BASELINE = `\t\t\tconsumeVia(id, segment) {
\t\t\t\tconst actx = this.scopeFor(id);
\t\t\t\tif (actx === void 0) return;
\t\t\t\tactx.bail(actx, "slash/input-consume-token", { guard: segment.via === "menu" ? {
\t\t\t\t\tkind: "span",
\t\t\t\t\tspan: segment.span
\t\t\t\t} : {
\t\t\t\t\tkind: "bare-token",
\t\t\t\t\ttoken: segment.token
\t\t\t\t} });
\t\t\t}`

const CONSUME_V2 = `\t\t\tconsumeVia(id, segment) {
\t\t\t\tconst actx = this.scopeFor(id);
\t\t\t\tif (actx === void 0) return false;
\t\t\t\treturn actx.bail(actx, "slash/input-consume-token", { guard: segment.via === "menu" ? {
\t\t\t\t\tkind: "span",
\t\t\t\t\tspan: segment.span
\t\t\t\t} : {
\t\t\t\t\tkind: "bare-token",
\t\t\t\t\ttoken: segment.token
\t\t\t\t} }) === true;
\t\t\t}`

const RUN_DETACHED_ANCHOR = `\t\t\t/**
\t\t\t* Fire-and-forget execute for the internal ('handled') paths.`

const RUN_CLIENT_ACTION_V1 = `\t\t\t// ${LEGACY_MARKER}
\t\t\trunClientAction(name, ui, session) {
\t\t\t\tconst report = (error) => {
\t\t\t\t\tconst text = error instanceof Error ? error.message : String(error);
\t\t\t\t\tthis.noticeFor(session.sessionId, "error", text || \`/\${name} failed\`);
\t\t\t\t};
\t\t\t\ttry {
\t\t\t\t\tPromise.resolve(ui.run(session)).catch(report);
\t\t\t\t} catch (error) {
\t\t\t\t\treport(error);
\t\t\t\t}
\t\t\t}`

const RUN_CLIENT_ACTION_V2 = `\t\t\t// ${MARKER}
\t\t\trunClientAction(name, ui, session) {
\t\t\t\tconst report = (error) => {
\t\t\t\t\tconst text = error instanceof Error ? error.message : String(error);
\t\t\t\t\tthis.noticeFor(session.sessionId, "error", text || \`/\${name} failed\`);
\t\t\t\t};
\t\t\t\ttry {
\t\t\t\t\tPromise.resolve(ui.run(session)).catch(report);
\t\t\t\t} catch (error) {
\t\t\t\t\treport(error);
\t\t\t\t}
\t\t\t}`

// Export exact replacement strings so fixture tests can assert every state
// without duplicating runtime text in a second source of truth.
export const PATCH_TEXT = Object.freeze({
  markerV1: LEGACY_MARKER,
  markerV2: MARKER,
  dispatchBaseline: DISPATCH_BASELINE,
  dispatchActionV1: DISPATCH_V1,
  dispatchActionV2: DISPATCH_V2,
  dispatchAction: DISPATCH_V2,
  matchEnterBaseline: MATCH_ENTER_BASELINE,
  matchEnterActionV1: MATCH_ENTER_V1,
  matchEnterActionV2: MATCH_ENTER_V2,
  matchEnterAction: MATCH_ENTER_V2,
  consumeBaseline: CONSUME_BASELINE,
  consumeV2: CONSUME_V2,
  runDetachedAnchor: RUN_DETACHED_ANCHOR,
  runClientActionV1: RUN_CLIENT_ACTION_V1,
  runClientActionV2: RUN_CLIENT_ACTION_V2,
  runClientAction: RUN_CLIENT_ACTION_V2,
})

function countOccurrences(source, text) {
  return source.split(text).length - 1
}

function replaceExactly(source, oldText, newText, label) {
  const count = countOccurrences(source, oldText)
  if (count !== 1) throw new Error(`client command actions patch expected exactly one ${label}, found ${count}`)
  return source.replace(oldText, newText)
}

async function readRequired(file, label) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (error) {
    throw new Error(`client command actions patch ${label} is unavailable: ${file} (${error.code ?? error.message})`)
  }
}

function parseManifest(manifestText, file) {
  let manifest
  try {
    manifest = JSON.parse(manifestText)
  } catch (error) {
    throw new Error(`client command actions patch package manifest is not valid JSON: ${file} (${error.message})`)
  }
  if (manifest.name !== PACKAGE_NAME) throw new Error(`client command actions patch expected ${PACKAGE_NAME}, found ${String(manifest.name)}`)
  if (manifest.version !== SUPPORTED_VERSION) throw new Error(`client command actions patch supports only ${PACKAGE_NAME} ${SUPPORTED_VERSION}, found ${String(manifest.version)}`)
  return manifest
}

function assertBaselineShape(source) {
  if (source.includes(LEGACY_MARKER) || source.includes(MARKER)) throw new Error('client command actions patch found a marker in an unexpected baseline state; refusing to guess')
  const incompatibleFragments = [
    DISPATCH_V1,
    DISPATCH_V2,
    MATCH_ENTER_V1,
    MATCH_ENTER_V2,
    RUN_CLIENT_ACTION_V1,
    RUN_CLIENT_ACTION_V2,
    CONSUME_V2,
    'contribution.ui.kind === "action"',
    'runClientAction(',
  ].filter((text) => source.includes(text))
  if (incompatibleFragments.length > 0) throw new Error('client command actions patch found an incompatible or partial action shape; refusing to guess')
  if (countOccurrences(source, DISPATCH_BASELINE) !== 1) throw new Error('client command actions patch expected exactly one dispatch contribution anchor')
  if (countOccurrences(source, MATCH_ENTER_BASELINE) !== 1) throw new Error('client command actions patch expected exactly one matchEnter contribution anchor')
  if (countOccurrences(source, CONSUME_BASELINE) !== 1) throw new Error('client command actions patch expected exactly one consumeVia anchor')
  if (countOccurrences(source, RUN_DETACHED_ANCHOR) !== 1) throw new Error('client command actions patch expected exactly one runDetached anchor')
}

function assertV1Shape(source) {
  if (countOccurrences(source, LEGACY_MARKER) !== 1 || source.includes(MARKER)) throw new Error('client command actions patch found an ambiguous v1 marker state; refusing to guess')
  if (countOccurrences(source, DISPATCH_V1) !== 1 || countOccurrences(source, MATCH_ENTER_V1) !== 1 || countOccurrences(source, CONSUME_BASELINE) !== 1 || countOccurrences(source, RUN_CLIENT_ACTION_V1) !== 1 || countOccurrences(source, RUN_DETACHED_ANCHOR) !== 1) throw new Error('client command actions patch found a malformed v1 action shape; refusing to guess')
  if (source.includes(DISPATCH_V2) || source.includes(MATCH_ENTER_V2) || source.includes(CONSUME_V2) || source.includes(RUN_CLIENT_ACTION_V2)) throw new Error('client command actions patch found mixed v1/v2 action branches; refusing to guess')
}

function assertV2Shape(source) {
  if (countOccurrences(source, MARKER) !== 1 || source.includes(LEGACY_MARKER)) throw new Error('client command actions patch found an ambiguous v2 marker state; refusing to guess')
  if (countOccurrences(source, DISPATCH_V2) !== 1 || countOccurrences(source, MATCH_ENTER_V2) !== 1 || countOccurrences(source, CONSUME_V2) !== 1 || countOccurrences(source, RUN_CLIENT_ACTION_V2) !== 1 || countOccurrences(source, RUN_DETACHED_ANCHOR) !== 1) throw new Error('client command actions patch found a malformed v2 action shape; refusing to guess')
  if (source.includes(DISPATCH_V1) || source.includes(MATCH_ENTER_V1) || source.includes(CONSUME_BASELINE) || source.includes(RUN_CLIENT_ACTION_V1)) throw new Error('client command actions patch found mixed v1/v2 action branches; refusing to guess')
}

/** Replace the target bundle with a same-directory temporary file. */
export async function atomicReplaceFile(file, content, { fsApi = fs } = {}) {
  const temporary = `${file}.tmp-client-command-actions-${process.pid}-${randomUUID()}`
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

function applyV2FromBaseline(source) {
  let next = replaceExactly(source, DISPATCH_BASELINE, DISPATCH_V2, 'dispatch contribution anchor')
  next = replaceExactly(next, MATCH_ENTER_BASELINE, MATCH_ENTER_V2, 'matchEnter contribution anchor')
  next = replaceExactly(next, CONSUME_BASELINE, CONSUME_V2, 'consumeVia anchor')
  next = replaceExactly(next, RUN_DETACHED_ANCHOR, `${RUN_CLIENT_ACTION_V2}\n${RUN_DETACHED_ANCHOR}`, 'runDetached anchor')
  return next
}

function migrateV1ToV2(source) {
  let next = replaceExactly(source, DISPATCH_V1, DISPATCH_V2, 'v1 dispatch action branch')
  next = replaceExactly(next, MATCH_ENTER_V1, MATCH_ENTER_V2, 'v1 matchEnter action branch')
  next = replaceExactly(next, CONSUME_BASELINE, CONSUME_V2, 'v1 consumeVia anchor')
  next = replaceExactly(next, `${RUN_CLIENT_ACTION_V1}\n${RUN_DETACHED_ANCHOR}`, `${RUN_CLIENT_ACTION_V2}\n${RUN_DETACHED_ANCHOR}`, 'v1 runClientAction helper')
  return next
}

export async function patchClientCommandActions({ root = scriptRoot, fsApi = fs } = {}) {
  const normalizedRoot = path.resolve(root)
  const manifestPath = path.join(normalizedRoot, packageJsonRelativePath)
  const targetPath = path.join(normalizedRoot, TARGET_RELATIVE_PATH)
  const manifest = parseManifest(await readRequired(manifestPath, 'package manifest'), manifestPath)
  const source = await readRequired(targetPath, 'client runtime')

  let next
  let from
  if (source.includes(MARKER)) {
    assertV2Shape(source)
    return { changed: false, from: 'v2', to: 'v2', packageName: PACKAGE_NAME, version: manifest.version, root: normalizedRoot, target: targetPath }
  }
  if (source.includes(LEGACY_MARKER)) {
    assertV1Shape(source)
    next = migrateV1ToV2(source)
    from = 'v1'
  } else {
    assertBaselineShape(source)
    next = applyV2FromBaseline(source)
    from = 'baseline'
  }
  assertV2Shape(next)
  await atomicReplaceFile(targetPath, next, { fsApi })
  return { changed: true, from, to: 'v2', packageName: PACKAGE_NAME, version: manifest.version, root: normalizedRoot, target: targetPath }
}

function parseArgs(argv) {
  const args = { root: scriptRoot }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--root') {
      const value = argv[++index]
      if (!value) throw new Error('--root requires a path')
      args.root = value
    } else if (token === '--help' || token === '-h') {
      args.help = true
    } else {
      throw new Error(`unknown option ${token}`)
    }
  }
  return args
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) console.log('Usage: patch-client-command-actions.mjs [--root PATH]')
    else console.log(JSON.stringify(await patchClientCommandActions(args), null, 2))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }))
    process.exitCode = 1
  }
}
