#!/usr/bin/env node
/** Verify an offline rollback archive and/or one extracted restore root. */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

function inside(root, target) {
  const rel = target.slice(root.length)
  return target === root || (target.startsWith(`${root}${sep}`) && !rel.includes(`${sep}..${sep}`))
}

async function sha256File(path) {
  const hash = createHash('sha256')
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('end', resolvePromise)
    stream.once('error', reject)
  })
  return hash.digest('hex')
}

export async function verifyExtractedRoot(manifest, root) {
  const normalizedRoot = resolve(root)
  const failures = []
  for (const expected of manifest.criticalFiles || []) {
    const file = resolve(normalizedRoot, expected.path)
    if (!inside(normalizedRoot, file) || !existsSync(file)) { failures.push(`${expected.path}: missing`); continue }
    const info = await stat(file)
    if (!info.isFile()) { failures.push(`${expected.path}: not a file`); continue }
    if (info.size !== expected.size) failures.push(`${expected.path}: size ${info.size} != ${expected.size}`)
    const actual = await sha256File(file)
    if (actual !== expected.sha256) failures.push(`${expected.path}: sha256 ${actual} != ${expected.sha256}`)
  }
  let installedVersion = null
  try { installedVersion = JSON.parse(await readFile(join(normalizedRoot, 'install/node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version } catch { /* already in failures */ }
  if (installedVersion !== manifest.baselineVersion) failures.push(`installed version ${installedVersion || 'missing'} != ${manifest.baselineVersion}`)
  return { ok: failures.length === 0, root: normalizedRoot, installedVersion, checked: manifest.criticalFiles?.length || 0, failures }
}

export async function verifyRollbackSnapshot({ manifestPath, extractTo = null, extractedRoot = null } = {}) {
  if (!manifestPath) throw new Error('manifestPath is required')
  const normalizedManifest = resolve(manifestPath)
  const manifest = JSON.parse(await readFile(normalizedManifest, 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'deepseek-harness-offline-rollback-snapshot') throw new Error('invalid rollback snapshot manifest')
  if (extractedRoot) return { mode: 'extracted-root', manifest: normalizedManifest, ...(await verifyExtractedRoot(manifest, extractedRoot)) }
  const archive = resolve(dirname(normalizedManifest), manifest.archive)
  if (!existsSync(archive)) throw new Error(`archive missing: ${archive}`)
  const actualArchiveHash = await sha256File(archive)
  if (actualArchiveHash !== manifest.archiveSha256) return { ok: false, mode: 'archive', manifest: normalizedManifest, archive, failures: [`archive sha256 ${actualArchiveHash} != ${manifest.archiveSha256}`] }
  const list = spawnSync('/usr/bin/tar', ['-tzf', archive], { encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024 })
  if (list.status !== 0) return { ok: false, mode: 'archive', manifest: normalizedManifest, archive, failures: [`tar list failed: ${list.stderr || list.stdout}`] }
  const entries = list.stdout.split(/\r?\n/).filter(Boolean)
  const forbidden = []
  for (const entry of entries) {
    const clean = entry.replace(/^\.\//, '').replace(/\/$/, '')
    const top = clean.split('/')[0]
    if ((manifest.forbiddenTopLevel || []).includes(top)) forbidden.push(clean)
    if (clean.startsWith('/') || clean.split('/').includes('..')) forbidden.push(clean)
  }
  if (forbidden.length) return { ok: false, mode: 'archive', manifest: normalizedManifest, archive, failures: [`forbidden archive entries: ${forbidden.slice(0, 20).join(', ')}`] }
  let temporary = false
  let target
  if (extractTo) {
    target = resolve(extractTo)
    if (existsSync(target)) throw new Error(`extractTo already exists: ${target}`)
    await mkdir(target, { recursive: false })
  } else {
    target = await mkdtemp(join(tmpdir(), 'dsh-rollback-verify-'))
    temporary = true
  }
  try {
    const extract = spawnSync('/usr/bin/tar', ['-xzf', archive, '-C', target], { encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024 })
    if (extract.status !== 0) return { ok: false, mode: 'archive', manifest: normalizedManifest, archive, extractedRoot: target, failures: [`tar extract failed: ${extract.stderr || extract.stdout}`] }
    const rootCheck = await verifyExtractedRoot(manifest, target)
    return { ok: rootCheck.ok, mode: 'archive', manifest: normalizedManifest, archive, archiveSha256: actualArchiveHash, entries: entries.length, extractedRoot: target, temporaryExtract: temporary, checked: rootCheck.checked, installedVersion: rootCheck.installedVersion, failures: rootCheck.failures }
  } finally {
    if (temporary) await rm(target, { recursive: true, force: true })
  }
}

function parseArgs(argv) {
  const args = { manifestPath: null, extractTo: null, extractedRoot: null }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--manifest') args.manifestPath = argv[++index]
    else if (token === '--extract-to') args.extractTo = argv[++index]
    else if (token === '--extracted-root') args.extractedRoot = argv[++index]
    else if (token === '--help' || token === '-h') args.help = true
    else throw new Error(`unknown option ${token}`)
  }
  if (args.extractTo && args.extractedRoot) throw new Error('--extract-to and --extracted-root are mutually exclusive')
  return args
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) process.stdout.write('Usage: verify-rollback-snapshot.mjs --manifest FILE [--extract-to DIR | --extracted-root DIR]\n')
    else {
      const result = await verifyRollbackSnapshot(args)
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      process.exitCode = result.ok ? 0 : 1
    }
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`)
    process.exitCode = 2
  }
}
