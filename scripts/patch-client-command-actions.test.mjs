import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  LEGACY_MARKER,
  MARKER,
  PACKAGE_RELATIVE_PATH,
  PATCH_TEXT,
  SUPPORTED_VERSION,
  TARGET_RELATIVE_PATH,
  patchClientCommandActions,
} from './patch-client-command-actions.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const packageRoot = join(repoRoot, PACKAGE_RELATIVE_PATH)
const sourceBundle = join(repoRoot, TARGET_RELATIVE_PATH)
// Independent v1 fixture contract captured from the previous exact patch.
// Keep this literal separate from the v2 patcher's exported constants so the
// migration test cannot pass by generating and accepting the same typo.
const EXACT_V1_RUN_CLIENT_ACTION = `\t\t\t// ${LEGACY_MARKER}
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

function replaceExactly(source, oldText, newText, label) {
  const count = source.split(oldText).length - 1
  assert.equal(count, 1, `${label} must occur exactly once in the fixture`)
  return source.replace(oldText, newText)
}

function baselineBundle() {
  let source = readFileSync(sourceBundle, 'utf8')
  if (source.includes(MARKER)) {
    source = replaceExactly(source, PATCH_TEXT.dispatchActionV2, PATCH_TEXT.dispatchBaseline, 'v2 dispatch')
    source = replaceExactly(source, PATCH_TEXT.matchEnterActionV2, PATCH_TEXT.matchEnterBaseline, 'v2 matchEnter')
    source = replaceExactly(source, PATCH_TEXT.consumeV2, PATCH_TEXT.consumeBaseline, 'v2 consumeVia')
    source = replaceExactly(source, `${PATCH_TEXT.runClientActionV2}\n${PATCH_TEXT.runDetachedAnchor}`, PATCH_TEXT.runDetachedAnchor, 'v2 helper')
  }
  if (source.includes(LEGACY_MARKER)) {
    source = replaceExactly(source, PATCH_TEXT.dispatchActionV1, PATCH_TEXT.dispatchBaseline, 'v1 dispatch')
    source = replaceExactly(source, PATCH_TEXT.matchEnterActionV1, PATCH_TEXT.matchEnterBaseline, 'v1 matchEnter')
    source = replaceExactly(source, `${EXACT_V1_RUN_CLIENT_ACTION}\n${PATCH_TEXT.runDetachedAnchor}`, PATCH_TEXT.runDetachedAnchor, 'v1 helper')
  }
  assert.equal(source.includes(MARKER) || source.includes(LEGACY_MARKER), false, 'fixture source must normalize to baseline')
  return source
}

function v1Bundle(source) {
  let next = replaceExactly(source, PATCH_TEXT.dispatchBaseline, PATCH_TEXT.dispatchActionV1, 'baseline dispatch')
  next = replaceExactly(next, PATCH_TEXT.matchEnterBaseline, PATCH_TEXT.matchEnterActionV1, 'baseline matchEnter')
  next = replaceExactly(next, PATCH_TEXT.runDetachedAnchor, `${EXACT_V1_RUN_CLIENT_ACTION}\n${PATCH_TEXT.runDetachedAnchor}`, 'baseline helper')
  return next
}

function v2Bundle(source) {
  let next = replaceExactly(source, PATCH_TEXT.dispatchBaseline, PATCH_TEXT.dispatchActionV2, 'baseline dispatch')
  next = replaceExactly(next, PATCH_TEXT.matchEnterBaseline, PATCH_TEXT.matchEnterActionV2, 'baseline matchEnter')
  next = replaceExactly(next, PATCH_TEXT.consumeBaseline, PATCH_TEXT.consumeV2, 'baseline consumeVia')
  next = replaceExactly(next, PATCH_TEXT.runDetachedAnchor, `${PATCH_TEXT.runClientActionV2}\n${PATCH_TEXT.runDetachedAnchor}`, 'baseline helper')
  return next
}

function fixture(version = SUPPORTED_VERSION, state = 'baseline') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-client-command-actions-'))
  const targetPackage = join(root, PACKAGE_RELATIVE_PATH)
  mkdirSync(join(targetPackage, 'lib'), { recursive: true })
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  manifest.version = version
  writeFileSync(join(targetPackage, 'package.json'), JSON.stringify(manifest), 'utf8')
  const baseline = baselineBundle()
  const source = state === 'baseline' ? baseline : state === 'v1' ? v1Bundle(baseline) : state === 'v2' ? v2Bundle(baseline) : (() => { throw new Error(`unknown fixture state ${state}`) })()
  writeFileSync(join(targetPackage, 'lib/client.js'), source, 'utf8')
  return root
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

test('fresh rc.2 baseline applies the v2 action branches and consume CAS contract', async () => {
  const root = fixture()
  try {
    const before = readFileSync(join(root, TARGET_RELATIVE_PATH), 'utf8')
    const result = await patchClientCommandActions({ root })
    const after = readFileSync(join(root, TARGET_RELATIVE_PATH), 'utf8')

    assert.equal(result.changed, true)
    assert.equal(result.from, 'baseline')
    assert.equal(result.to, 'v2')
    assert.notEqual(after, before)
    assert.equal(after.split(MARKER).length - 1, 1)
    assert.equal(after.split(LEGACY_MARKER).length - 1, 0)
    for (const text of [PATCH_TEXT.dispatchActionV2, PATCH_TEXT.matchEnterActionV2, PATCH_TEXT.consumeV2, PATCH_TEXT.runClientActionV2]) assert.equal(after.split(text).length - 1, 1)

    assert.match(PATCH_TEXT.consumeV2, /if \(actx === void 0\) return false;/)
    assert.match(PATCH_TEXT.consumeV2, /return actx\.bail\(actx, "slash\/input-consume-token"[\s\S]*\} \}\) === true;/)

    const dispatch = after.slice(after.indexOf('dispatch(pick) {'), after.indexOf('matchSpace(session, token) {'))
    const menuConsume = dispatch.indexOf('const consumed = this.consumeVia(pick.session.sessionId')
    const menuGuard = dispatch.indexOf('if (consumed) this.runClientAction(name, contribution.ui, pick.session)')
    const menuHandled = dispatch.indexOf('return "handled";', menuGuard)
    assert.ok(menuConsume >= 0 && menuConsume < menuGuard && menuGuard < menuHandled, 'menu must run only after a successful consume and still handle false')
    assert.match(dispatch, /this\.openPopup\(name, contribution\.ui, pick\.session, \{/)
    assert.match(dispatch, /this\.runDetached\(desc, pick\.session, `\/\$\{name\}`\)/)

    const enter = after.slice(after.indexOf('async matchEnter('), after.indexOf('/** Open the session\'s popup'))
    const enterConsume = enter.indexOf('const consumed = this.consumeVia(session.sessionId')
    const enterGuard = enter.indexOf('if (consumed) this.runClientAction(name, contribution.ui, session)')
    const enterHandled = enter.indexOf('return "handled";', enterGuard)
    assert.ok(enterConsume >= 0 && enterConsume < enterGuard && enterGuard < enterHandled, 'enter must run only after a successful consume and still handle false')
    assert.match(enter, /if \(!bare\) return void 0;/)
    assert.match(enter, /if \(envelope\.images > 0\) refuseImages\(\);/)
    assert.match(enter, /this\.openPopup\(name, contribution\.ui, session, \{/)

    assert.match(PATCH_TEXT.runClientActionV2, /try \{/)
    assert.match(PATCH_TEXT.runClientActionV2, /Promise\.resolve\(ui\.run\(session\)\)\.catch\(report\)/)
    assert.match(PATCH_TEXT.runClientActionV2, /catch \(error\) \{/)
    assert.match(PATCH_TEXT.runClientActionV2, /this\.noticeFor\(session\.sessionId, "error",/)
    assert.doesNotMatch(PATCH_TEXT.runClientActionV2, /command\.execute|notifyExecuted|runDetached/)
  } finally {
    cleanup(root)
  }
})

test('complete v1 live shape migrates exactly to v2, then is idempotent', async () => {
  const root = fixture(SUPPORTED_VERSION, 'v1')
  try {
    const before = readFileSync(join(root, TARGET_RELATIVE_PATH), 'utf8')
    assert.equal(before.split(LEGACY_MARKER).length - 1, 1)
    const result = await patchClientCommandActions({ root })
    const after = readFileSync(join(root, TARGET_RELATIVE_PATH), 'utf8')
    assert.equal(result.changed, true)
    assert.equal(result.from, 'v1')
    assert.equal(after.split(MARKER).length - 1, 1)
    assert.equal(after.split(LEGACY_MARKER).length - 1, 0)
    assert.equal(after.split(PATCH_TEXT.dispatchActionV2).length - 1, 1)
    assert.equal(after.split(PATCH_TEXT.matchEnterActionV2).length - 1, 1)
    assert.equal(after.split(PATCH_TEXT.consumeV2).length - 1, 1)
    assert.equal(after.split(PATCH_TEXT.runClientActionV2).length - 1, 1)
    const second = await patchClientCommandActions({ root })
    assert.equal(second.changed, false)
    assert.equal(second.from, 'v2')
    assert.equal(readFileSync(join(root, TARGET_RELATIVE_PATH), 'utf8'), after)
  } finally {
    cleanup(root)
  }
})

test('complete v2 shape is unchanged on repeated application', async () => {
  const root = fixture(SUPPORTED_VERSION, 'v2')
  try {
    const before = readFileSync(join(root, TARGET_RELATIVE_PATH), 'utf8')
    const result = await patchClientCommandActions({ root })
    assert.equal(result.changed, false)
    assert.equal(result.from, 'v2')
    assert.equal(readFileSync(join(root, TARGET_RELATIVE_PATH), 'utf8'), before)
  } finally {
    cleanup(root)
  }
})

test('fails closed on baseline, v1, and v2 drift or ambiguous state', async (t) => {
  await t.test('missing baseline anchor', async () => {
    const root = fixture()
    try {
      const target = join(root, TARGET_RELATIVE_PATH)
      const source = readFileSync(target, 'utf8')
      writeFileSync(target, source.replace(PATCH_TEXT.dispatchBaseline, PATCH_TEXT.dispatchBaseline.replace('pick.span', 'pick.spanChanged')), 'utf8')
      await assert.rejects(() => patchClientCommandActions({ root }), /dispatch contribution anchor/)
    } finally { cleanup(root) }
  })

  await t.test('ambiguous baseline anchor', async () => {
    const root = fixture()
    try {
      const target = join(root, TARGET_RELATIVE_PATH)
      const source = readFileSync(target, 'utf8')
      writeFileSync(target, `${source}\n${PATCH_TEXT.dispatchBaseline}`, 'utf8')
      await assert.rejects(() => patchClientCommandActions({ root }), /exactly one dispatch contribution anchor/)
    } finally { cleanup(root) }
  })

  await t.test('unknown native action fragment', async () => {
    const root = fixture()
    try {
      const target = join(root, TARGET_RELATIVE_PATH)
      const source = readFileSync(target, 'utf8')
      writeFileSync(target, source.replace(PATCH_TEXT.dispatchBaseline, `if (contribution.ui.kind === "action") { return "native"; }\n${PATCH_TEXT.dispatchBaseline}`), 'utf8')
      await assert.rejects(() => patchClientCommandActions({ root }), /incompatible or partial action shape/)
    } finally { cleanup(root) }
  })

  await t.test('partial v2 marker', async () => {
    const root = fixture()
    try {
      const target = join(root, TARGET_RELATIVE_PATH)
      const source = readFileSync(target, 'utf8')
      writeFileSync(target, source.replace(PATCH_TEXT.dispatchBaseline, `${MARKER}\n${PATCH_TEXT.dispatchBaseline}`), 'utf8')
      await assert.rejects(() => patchClientCommandActions({ root }), /malformed v2 action shape/)
    } finally { cleanup(root) }
  })

  await t.test('drifted v1 helper', async () => {
    const root = fixture(SUPPORTED_VERSION, 'v1')
    try {
      const target = join(root, TARGET_RELATIVE_PATH)
      const source = readFileSync(target, 'utf8')
      writeFileSync(target, source.replace('Promise.resolve(ui.run(session)).catch(report)', 'Promise.resolve(ui.run(session)).catch(reportChanged)'), 'utf8')
      await assert.rejects(() => patchClientCommandActions({ root }), /malformed v1 action shape/)
    } finally { cleanup(root) }
  })

  await t.test('drifted v2 consume contract', async () => {
    const root = fixture(SUPPORTED_VERSION, 'v2')
    try {
      const target = join(root, TARGET_RELATIVE_PATH)
      const source = readFileSync(target, 'utf8')
      writeFileSync(target, source.replace('return actx.bail(actx, "slash/input-consume-token"', 'return actx.bailChanged(actx, "slash/input-consume-token"'), 'utf8')
      await assert.rejects(() => patchClientCommandActions({ root }), /malformed v2 action shape/)
    } finally { cleanup(root) }
  })

  await t.test('mixed markers', async () => {
    const root = fixture(SUPPORTED_VERSION, 'v2')
    try {
      const target = join(root, TARGET_RELATIVE_PATH)
      const source = readFileSync(target, 'utf8')
      writeFileSync(target, source.replace(MARKER, `${MARKER} ${LEGACY_MARKER}`), 'utf8')
      await assert.rejects(() => patchClientCommandActions({ root }), /ambiguous v2 marker state/)
    } finally { cleanup(root) }
  })
})

test('rejects a package version outside the locked rc.2 baseline', async () => {
  const root = fixture('0.1.1-rc.3')
  try {
    await assert.rejects(() => patchClientCommandActions({ root }), /supports only .*0\.1\.1-rc\.2/)
  } finally { cleanup(root) }
})

test('formal live rc.2 bundle is valid after applying the v2 patcher', async () => {
  const result = await patchClientCommandActions({ root: repoRoot })
  const source = readFileSync(sourceBundle, 'utf8')
  assert.equal(result.version, SUPPORTED_VERSION)
  assert.equal(result.to, 'v2')
  assert.equal(source.split(MARKER).length - 1, 1)
  assert.equal(source.split(LEGACY_MARKER).length - 1, 0)
  assert.equal(source.split(PATCH_TEXT.dispatchActionV2).length - 1, 1)
  assert.equal(source.split(PATCH_TEXT.matchEnterActionV2).length - 1, 1)
  assert.equal(source.split(PATCH_TEXT.consumeV2).length - 1, 1)
  assert.equal(source.split(PATCH_TEXT.runClientActionV2).length - 1, 1)
})
