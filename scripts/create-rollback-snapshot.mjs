#!/usr/bin/env node
/** Create an offline rc.8 runtime/config rollback snapshot without user data. */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

export const DEFAULT_INCLUDED_PATHS = Object.freeze([
  'install',
  'profiles',
  'extensions',
  '.agent-presets',
  'apps',
  'custom-ui-patches',
  'skills',
  'scripts',
  'architecture',
  'bin',
  'container.manifest.yaml',
  'settings.yaml',
  '.gitignore',
  'output/deepseek-harness-evolution/ui-integrity/ui-baseline.sha256.json',
  'output/deepseek-harness-evolution/ui-integrity/current/home-1440x1000.png',
])

export const DEFAULT_CRITICAL_PATHS = Object.freeze([
  'container.manifest.yaml',
  'install/package.json',
  'install/node_modules/@deepseek-ai/dsh/package.json',
  'profiles/web/package.json',
  'profiles/web/cordis.patch.yml',
  'profiles/web-intelligence/package.json',
  'profiles/web-intelligence/cordis.patch.yml',
  '.agent-presets/reliable-development/agent.cordis.yml',
  'extensions/shrimp-shell/index.js',
  'extensions/dsh-intelligence/index.js',
  'extensions/dsh-compaction-v2/engine.js',
  'extensions/dsh-memory/index.js',
  'extensions/dsh-cross-session/index.js',
  'extensions/dsh-code-intelligence/index.js',
  'extensions/dsh-frontend-qa/index.js',
  'extensions/dsh-evals/index.js',
  'extensions/dsh-tool-policy/index.js',
  'architecture/upgrade-contract.json',
  'architecture/fitness-functions.json',
  'output/deepseek-harness-evolution/ui-integrity/ui-baseline.sha256.json',
])

export const FORBIDDEN_TOP_LEVEL = Object.freeze([
  '.credentials.yaml', 'sessions', 'memories', 'attachments', 'private', 'backups', 'vision-media', 'vision-results', 'zhipu-images', 'gzh-publisher-profile', '.git',
])

function inside(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep))
}

function assertRelativePath(value, label) {
  const path = String(value || '')
  if (!path || path.startsWith('/') || path.split('/').includes('..')) throw new Error(`${label} must be a safe root-relative path: ${path}`)
  return path
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

async function criticalRecords(root, criticalPaths) {
  const records = []
  for (const raw of criticalPaths) {
    const path = assertRelativePath(raw, 'critical path')
    const absolute = resolve(root, path)
    if (!inside(root, absolute) || !existsSync(absolute)) throw new Error(`critical file missing: ${path}`)
    const info = await stat(absolute)
    if (!info.isFile()) throw new Error(`critical path is not a file: ${path}`)
    records.push({ path, size: info.size, sha256: await sha256File(absolute) })
  }
  return records
}

function installedVersion(root) {
  const file = join(root, 'install/node_modules/@deepseek-ai/dsh/package.json')
  return JSON.parse(requireText(file)).version
}

function requireText(path) {
  try { return requireRead(path) } catch (error) { throw new Error(`cannot read ${path}: ${error.message}`) }
}

function requireRead(path) {
  return Buffer.from(spawnSync('/bin/cat', [path], { encoding: null }).stdout || []).toString('utf8')
}

export async function createRollbackSnapshot({
  root = process.cwd(),
  outputDir,
  name = `rc8-enhanced-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')}`,
  includedPaths = DEFAULT_INCLUDED_PATHS,
  criticalPaths = DEFAULT_CRITICAL_PATHS,
} = {}) {
  const normalizedRoot = resolve(root)
  if (!outputDir) throw new Error('outputDir is required')
  const normalizedOutput = resolve(outputDir)
  if (normalizedOutput === normalizedRoot || !inside(normalizedRoot, normalizedOutput)) throw new Error('outputDir must be a dedicated directory inside the DSH root')
  await mkdir(normalizedOutput, { recursive: true })
  const safeName = String(name).replace(/[^A-Za-z0-9._-]+/g, '-')
  const archive = join(normalizedOutput, `${safeName}.tar.gz`)
  const tempArchive = `${archive}.tmp-${process.pid}`
  const manifestPath = join(normalizedOutput, `${safeName}.snapshot.json`)
  for (const raw of includedPaths) {
    const path = assertRelativePath(raw, 'included path')
    if (FORBIDDEN_TOP_LEVEL.includes(path.split('/')[0])) throw new Error(`forbidden top-level path cannot be included: ${path}`)
    if (!existsSync(resolve(normalizedRoot, path))) throw new Error(`included path missing: ${path}`)
  }
  const version = installedVersion(normalizedRoot)
  if (version !== '0.1.0-rc.8') throw new Error(`rollback snapshot requires installed rc.8, got ${version}`)
  const criticalFiles = await criticalRecords(normalizedRoot, criticalPaths)
  const tar = spawnSync('/usr/bin/tar', ['-czf', tempArchive, '-C', normalizedRoot, '--', ...includedPaths], { encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024 })
  if (tar.status !== 0) {
    try { await unlink(tempArchive) } catch { /* no partial archive */ }
    throw new Error(`tar failed: ${tar.stderr || tar.stdout}`)
  }
  await rename(tempArchive, archive)
  const archiveInfo = await stat(archive)
  const archiveSha256 = await sha256File(archive)
  const manifest = {
    schemaVersion: 1,
    kind: 'deepseek-harness-offline-rollback-snapshot',
    createdAt: new Date().toISOString(),
    baselineVersion: version,
    archive: basename(archive),
    archiveSize: archiveInfo.size,
    archiveSha256,
    includedPaths: [...includedPaths],
    forbiddenTopLevel: [...FORBIDDEN_TOP_LEVEL],
    criticalFiles,
    dataPolicy: { credentialsIncluded: false, sessionsIncluded: false, memoriesIncluded: false, attachmentsIncluded: false, businessDataIncluded: false },
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { ok: true, archive, manifestPath, manifest }
}

function parseArgs(argv) {
  const args = { root: process.cwd(), outputDir: null, name: null }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--root') args.root = argv[++index]
    else if (token === '--output-dir') args.outputDir = argv[++index]
    else if (token === '--name') args.name = argv[++index]
    else if (token === '--help' || token === '-h') args.help = true
    else throw new Error(`unknown option ${token}`)
  }
  return args
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) process.stdout.write('Usage: create-rollback-snapshot.mjs --output-dir DIR [--root DIR] [--name NAME]\n')
    else {
      const result = await createRollbackSnapshot({ root: args.root, outputDir: args.outputDir, ...(args.name ? { name: args.name } : {}) })
      process.stdout.write(`${JSON.stringify({ ok: true, archive: result.archive, manifest: result.manifestPath, archiveSize: result.manifest.archiveSize, archiveSha256: result.manifest.archiveSha256 }, null, 2)}\n`)
    }
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`)
    process.exitCode = 1
  }
}
