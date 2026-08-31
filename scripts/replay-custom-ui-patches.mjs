#!/usr/bin/env node
/**
 * Check or replay the reviewed CyberMarcus UI bundles for the locked DSH
 * baseline, including the rc.2 subagent lineage/archive snapshot. A different
 * upstream version is a compatibility-review boundary: this script refuses to
 * overwrite it.
 */
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

export const BASELINE_VERSION = '0.1.1-rc.2'
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const execFileAsync = promisify(execFile)

export const STUDIO_BRAND = Object.freeze({
  script: 'custom-ui-patches/dsh-idesign-ippt-studio/replay-brand.sh',
  template: Object.freeze({
    source: 'custom-ui-patches/dsh-idesign-ippt-studio/templates/deepseek-ippt/shrimptank.pptx-pingan-health',
    target: 'profiles/web/node_modules/deepseek-ippt/lib/templates/shrimptank.pptx-pingan-health',
    files: Object.freeze([
      'manifest.json',
      'design-tokens.css',
      'entry.html',
      'cover.png',
      'SOURCES.txt',
      'assets/cover-pafc.jpeg',
      'assets/service-mdt.jpg',
      'assets/case-checkup.jpg',
      'assets/service-online-doctor.jpg',
      'assets/closing-professionals.jpg',
    ]),
  }),
  catalog: Object.freeze({
    path: 'profiles/web/node_modules/deepseek-ippt/lib/index.js',
    marker: '"shrimptank.pptx-pingan-health"',
    coverCacheMarker: '"cache-control": "no-store"',
  }),
  templateLogos: Object.freeze({
    source: 'custom-ui-patches/dsh-idesign-ippt-studio/original/ipollowork-logo.svg',
    roots: Object.freeze([
      'profiles/web/node_modules/deepseek-idesign/lib/templates',
      'profiles/web/node_modules/deepseek-ippt/lib/templates',
      'custom-ui-patches/dsh-idesign-ippt-studio/modified/templates/deepseek-idesign',
      'custom-ui-patches/dsh-idesign-ippt-studio/modified/templates/deepseek-ippt',
    ]),
    cacheToken: 'v=20260831-logo-fix-1',
  }),
  packages: Object.freeze([
    Object.freeze({ packageName: 'deepseek-idesign', kind: 'design', title: 'HTML', previewRefreshMarker: 'setTimeout(()=>{const te=w.current;if(!te)return;const xe=te.getBoundingClientRect();E({width:xe.width,height:xe.height})},80)', coverVersionMarker: 'e.load(e.template.manifest.id,e.template.manifest.version)', coverRequestVersionMarker: 'templateId:s,version:r' }),
    Object.freeze({ packageName: 'deepseek-ippt', kind: 'slides', title: '皮皮虾', previewRefreshMarker: 'setTimeout(()=>{const te=w.current;if(!te)return;const xe=te.getBoundingClientRect();E({width:xe.width,height:xe.height})},80)', coverVersionMarker: 'e.load(e.template.manifest.id,e.template.manifest.version)', coverRequestVersionMarker: 'templateId:s,version:r' }),
  ]),
})

export const SUBAGENT_ARCHIVE_SNAPSHOT = Object.freeze({
  packageName: 'dsh-client-ui-subagent',
  source: 'custom-ui-patches/dsh-client-ui-subagent/client.js.rc2-archive.modified',
  target: 'install/node_modules/@deepseek-ai/dsh-client-ui-subagent/lib/client.js',
  lineage: '@deepseek-ai/dsh-client-ui-subagent@0.1.1-rc.2',
  purpose: 'reviewed-rc2-lineage-archive-lifecycle-bundle',
  expectedSha256: '530dc01da4afdc564391eaf4e532bdedc51933dcadc80988a45f6226f526988c',
})

export const SUBAGENT_ARCHIVE_MARKERS = Object.freeze([
  'window.__ModuleLoader__.load({',
  'id: "@deepseek-ai/dsh-client-ui-subagent"',
  'SubagentHeaderLineage',
  'archiveSubagent',
  '"archive.button": "归档"',
  '"archive.running": "中断并归档"',
  '"archive.button": "Archive"',
  '"archive.running": "Interrupt & archive"',
])

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
})).concat(Object.freeze({
  packageName: 'shrimp-shell',
  source: 'custom-ui-patches/shrimp-shell/client.js.modified',
  target: 'extensions/shrimp-shell/client.js',
}), SUBAGENT_ARCHIVE_SNAPSHOT))

export function validateSubagentArchiveSnapshot(content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content)
  const missing = SUBAGENT_ARCHIVE_MARKERS.filter((marker) => !text.includes(marker))
  return { ok: missing.length === 0, missing }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function inspectStudioBrand(root) {
  const rows = []
  for (const spec of STUDIO_BRAND.packages) {
    const dist = join(root, 'profiles/web/node_modules', spec.packageName, 'studio/dist')
    const htmlPath = join(dist, 'index.html')
    if (!await exists(htmlPath)) return { available: false, ok: true, packages: [] }
    const html = await readFile(htmlPath, 'utf8')
    const match = html.match(/src="\.\/assets\/(index-[^"?]+\.js)/)
    if (!match) {
      rows.push({ ...spec, ok: false, code: 'STUDIO_BUNDLE_REFERENCE_MISSING', htmlPath })
      continue
    }
    const bundlePath = join(dist, 'assets', match[1])
    if (!await exists(bundlePath)) {
      rows.push({ ...spec, ok: false, code: 'STUDIO_BUNDLE_MISSING', htmlPath, bundlePath })
      continue
    }
    const bundle = await readFile(bundlePath, 'utf8')
    const brandingOk = bundle.includes(`branding:{kind:"${spec.kind}",title:"${spec.title}",byline:"by ShrimpTank"`)
    const previewRefreshOk = bundle.includes(spec.previewRefreshMarker)
    const coverVersionOk = bundle.includes(spec.coverVersionMarker) && bundle.includes(spec.coverRequestVersionMarker)
    let syntaxOk = true
    let syntaxError = null
    try {
      await execFileAsync(process.execPath, ['--check', bundlePath], { maxBuffer: 2 * 1024 * 1024 })
    } catch (error) {
      syntaxOk = false
      syntaxError = String(error?.stderr || error?.message || error)
    }
    rows.push({ ...spec, ok: brandingOk && previewRefreshOk && coverVersionOk && syntaxOk, brandingOk, previewRefreshOk, coverVersionOk, syntaxOk, syntaxError, htmlPath, bundlePath })
  }
  const templateFiles = []
  for (const file of STUDIO_BRAND.template.files) {
    const sourcePath = join(root, STUDIO_BRAND.template.source, file)
    const targetPath = join(root, STUDIO_BRAND.template.target, file)
    const sourceAvailable = await exists(sourcePath)
    const targetAvailable = await exists(targetPath)
    const source = sourceAvailable ? await readFile(sourcePath) : null
    const target = targetAvailable ? await readFile(targetPath) : null
    templateFiles.push({
      file,
      ok: Boolean(source && target && source.equals(target)),
      sourceAvailable,
      targetAvailable,
      sourceSha256: source ? sha256(source) : null,
      targetSha256: target ? sha256(target) : null,
    })
  }
  const template = { ok: templateFiles.every((file) => file.ok), files: templateFiles }
  const logoSourcePath = join(root, STUDIO_BRAND.templateLogos.source)
  const logoSourceAvailable = await exists(logoSourcePath)
  const logoSource = logoSourceAvailable ? await readFile(logoSourcePath) : null
  const logoFiles = []
  for (const relativeRoot of STUDIO_BRAND.templateLogos.roots) {
    const templatesRoot = join(root, relativeRoot)
    if (!await exists(templatesRoot)) continue
    for (const entry of await readdir(templatesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const logoPath = join(templatesRoot, entry.name, 'assets/ipollowork-logo.svg')
      if (!await exists(logoPath)) continue
      const entryPath = join(templatesRoot, entry.name, 'entry.html')
      const logo = await readFile(logoPath)
      const html = await exists(entryPath) ? await readFile(entryPath, 'utf8') : ''
      logoFiles.push({
        template: entry.name,
        logoPath,
        logoMatches: Boolean(logoSource && logo.equals(logoSource)),
        cacheVersionOk: html.includes(`ipollowork-logo.svg?${STUDIO_BRAND.templateLogos.cacheToken}`),
      })
    }
  }
  const templateLogos = {
    ok: logoSourceAvailable && logoFiles.length > 0 && logoFiles.every((file) => file.logoMatches && file.cacheVersionOk),
    sourceAvailable: logoSourceAvailable,
    sourcePath: logoSourcePath,
    files: logoFiles,
  }
  const catalogPath = join(root, STUDIO_BRAND.catalog.path)
  const catalogAvailable = await exists(catalogPath)
  const catalogContent = catalogAvailable ? await readFile(catalogPath, 'utf8') : ''
  const catalog = {
    ok: catalogAvailable && catalogContent.includes(STUDIO_BRAND.catalog.marker) && catalogContent.includes(STUDIO_BRAND.catalog.coverCacheMarker),
    available: catalogAvailable,
    path: catalogPath,
  }
  return {
    available: true,
    ok: rows.length === STUDIO_BRAND.packages.length && rows.every((row) => row.ok) && template.ok && templateLogos.ok && catalog.ok,
    packages: rows,
    template,
    templateLogos,
    catalog,
  }
}

async function replayStudioBrand(root) {
  await execFileAsync('/bin/bash', [join(root, STUDIO_BRAND.script), root], { maxBuffer: 8 * 1024 * 1024 })
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

export async function replayCustomUiPatches({ root = scriptRoot, apply = false, writer = atomicWrite, studioRunner = replayStudioBrand } = {}) {
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
  const archiveSourcePath = join(normalizedRoot, SUBAGENT_ARCHIVE_SNAPSHOT.source)
  const archiveSource = await readFile(archiveSourcePath)
  const archiveValidation = validateSubagentArchiveSnapshot(archiveSource)
  const archiveSourceSha256 = sha256(archiveSource)
  const archiveHashMatches = archiveSourceSha256 === SUBAGENT_ARCHIVE_SNAPSHOT.expectedSha256
  if (!archiveValidation.ok || !archiveHashMatches) {
    return {
      ok: false,
      status: 'blocked',
      code: 'SUBAGENT_ARCHIVE_SNAPSHOT_INVALID',
      baselineVersion: BASELINE_VERSION,
      installedVersion: version,
      apply: false,
      patches: [],
      archiveSnapshot: {
        ...SUBAGENT_ARCHIVE_SNAPSHOT,
        sourceSha256: archiveSourceSha256,
        missingMarkers: archiveValidation.missing,
        hashMatches: archiveHashMatches,
      },
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
        archiveSnapshot: {
          ...SUBAGENT_ARCHIVE_SNAPSHOT,
          sourceSha256: archiveSourceSha256,
          missingMarkers: [],
          hashMatches: true,
        },
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
  let studioBrand = await inspectStudioBrand(normalizedRoot)
  let studioApplied = false
  if (apply && studioBrand.available && !studioBrand.ok) {
    try {
      await studioRunner(normalizedRoot)
      studioBrand = await inspectStudioBrand(normalizedRoot)
      studioApplied = studioBrand.ok
    } catch (error) {
      return {
        ok: false,
        status: 'failed',
        code: 'STUDIO_BRAND_REPLAY_FAILED',
        error: String(error?.message || error),
        baselineVersion: BASELINE_VERSION,
        installedVersion: version,
        apply: true,
        patches: rows,
        studioBrand,
      }
    }
  }
  const clean = rows.every((row) => row.matches) && studioBrand.ok
  return {
    ok: clean,
    status: clean ? (rows.some((row) => row.applied) || studioApplied ? 'applied' : 'clean') : 'drift',
    baselineVersion: BASELINE_VERSION,
    installedVersion: version,
    apply,
    patches: rows,
    archiveSnapshot: {
      ...SUBAGENT_ARCHIVE_SNAPSHOT,
      sourceSha256: archiveSourceSha256,
      missingMarkers: [],
      hashMatches: true,
    },
    studioBrand,
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
