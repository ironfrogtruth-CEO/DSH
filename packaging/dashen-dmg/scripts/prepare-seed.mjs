#!/usr/bin/env node
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

const [sourceRoot, destinationRoot, portableSeedRoot] = process.argv.slice(2)
if (![sourceRoot, destinationRoot, portableSeedRoot].every(Boolean)) {
  console.error('prepare-seed: sourceRoot destinationRoot portableSeedRoot are required')
  process.exit(64)
}

const allowlist = [
  '.agent-presets',
  'AGENTS.md',
  'architecture',
  'bin',
  'custom-ui-patches',
  'extensions',
  'install',
  'mcp-servers',
  'plugins',
  'profiles',
  'scripts',
  'settings.yaml',
  'skills',
]

const forbiddenNames = new Set([
  '.credentials.yaml', '.env', '.DS_Store', '.git', '.pytest_cache', '.playwright-cli',
  'private', 'sessions', 'attachments', 'logs', 'output', 'backups', 'screen-memory',
  'vision-media', 'vision-results', 'zhipu-images', 'storages', 'memories', 'cross-session',
  'goal-first-state', 'llm-deepseek', 'gzh-publisher-profile', 'xhs-publisher-profile',
])

function filter(source) {
  const name = basename(source)
  const rel = relative(sourceRoot, source)
  const topLevel = rel.split('/')[0]
  if (forbiddenNames.has(topLevel)) return false
  if (name === '.credentials.yaml' || name === '.env') return false
  if (/\.bak(?:-|$)|\.tmp$|\.log$|__pycache__/.test(name)) return false
  return true
}

rmSync(destinationRoot, { recursive: true, force: true })
mkdirSync(destinationRoot, { recursive: true })
for (const item of allowlist) {
  const source = join(sourceRoot, item)
  if (!existsSync(source)) continue
  cpSync(source, join(destinationRoot, item), { recursive: true, dereference: false, filter })
}

for (const subdir of ['bin', 'scripts']) {
  const from = join(portableSeedRoot, subdir)
  if (!existsSync(from)) continue
  cpSync(from, join(destinationRoot, subdir), { recursive: true, dereference: false, force: true })
}

const symlinkActions = []
function repairSymlinks(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path)
      if (isAbsolute(target)) {
        unlinkSync(path)
        if (target === sourceRoot || target.startsWith(`${sourceRoot}/`)) {
          const mappedTarget = join(destinationRoot, relative(sourceRoot, target))
          symlinkSync(relative(dirname(path), mappedTarget), path)
          symlinkActions.push({ action: 'relocated', path: relative(destinationRoot, path) })
        } else {
          symlinkActions.push({ action: 'removed-external', path: relative(destinationRoot, path) })
        }
      }
      continue
    }
    if (entry.isDirectory()) repairSymlinks(path)
  }
}
repairSymlinks(destinationRoot)

function removeBrokenSymlinks(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      if (!existsSync(path)) {
        unlinkSync(path)
        symlinkActions.push({ action: 'removed-broken', path: relative(destinationRoot, path) })
      }
      continue
    }
    if (entry.isDirectory()) removeBrokenSymlinks(path)
  }
}
removeBrokenSymlinks(destinationRoot)

const replacements = new Map([
  ['/Users/marcus/.dsh', '__DASHEN_DSH_HOME__'],
  ['/Users/marcus/Desktop', '__DASHEN_WORKSPACE__'],
  ['/usr/local/bin/node', '__DASHEN_NODE__'],
  ['/Users/marcus', '__DASHEN_USER_HOME__'],
])

function isText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  return !sample.includes(0)
}

function rewriteTextTree(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) continue
    if (entry.isDirectory()) { rewriteTextTree(path); continue }
    if (!entry.isFile() || stat.size > 100 * 1024 * 1024) continue
    const data = readFileSync(path)
    if (!isText(data)) continue
    let text = data.toString('utf8')
    let changed = false
    for (const [from, to] of replacements) {
      if (text.includes(from)) {
        text = text.split(from).join(to)
        changed = true
      }
    }
    if (changed) writeFileSync(path, text)
  }
}

rewriteTextTree(destinationRoot)

for (const profile of ['web', 'headless', 'web-intelligence']) {
  const packagePath = join(destinationRoot, 'profiles', profile, 'package.json')
  if (!existsSync(packagePath)) continue
  const json = JSON.parse(readFileSync(packagePath, 'utf8'))
  for (const [name, value] of Object.entries(json.dependencies ?? {})) {
    if (typeof value === 'string' && value.startsWith('link:__DASHEN_DSH_HOME__/extensions/')) {
      json.dependencies[name] = value.replace('link:__DASHEN_DSH_HOME__/extensions/', 'link:../../extensions/')
    }
  }
  writeFileSync(packagePath, `${JSON.stringify(json, null, 2)}\n`)
}

let fileCount = 0
let byteCount = 0
function measure(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) continue
    if (entry.isDirectory()) measure(path)
    else if (entry.isFile()) { fileCount += 1; byteCount += stat.size }
  }
}
measure(destinationRoot)
writeFileSync(join(destinationRoot, 'portable-seed-manifest.json'), `${JSON.stringify({
  schema: 'dashen-portable-seed.v1',
  source: 'local-dsh-allowlist',
  allowlist,
  forbiddenNames: [...forbiddenNames].sort(),
  fileCount,
  byteCount,
  symlinkActions,
  generatedAt: new Date().toISOString(),
}, null, 2)}\n`)

console.log(JSON.stringify({ fileCount, byteCount, relative: relative(sourceRoot, destinationRoot) }))
