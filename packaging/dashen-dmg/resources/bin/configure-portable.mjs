#!/usr/bin/env node
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [root, workspace, nodePath, hostScript, port, version] = process.argv.slice(2)
if (![root, workspace, nodePath, hostScript, port, version].every(Boolean)) {
  console.error('configure-portable: missing arguments')
  process.exit(64)
}

const replacements = new Map([
  ['__DASHEN_DSH_HOME__', root],
  ['__DASHEN_WORKSPACE__', workspace],
  ['__DASHEN_NODE__', nodePath],
  ['__DASHEN_HOST_SCRIPT__', hostScript],
  ['__DASHEN_PORT__', port],
  ['__DASHEN_USER_HOME__', homedir()],
])

function isText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  return !sample.includes(0)
}

function rewriteTree(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) continue
    if (entry.isDirectory()) { rewriteTree(path); continue }
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

rewriteTree(root)
for (const name of ['sessions', 'attachments', 'logs', 'output', 'storages', 'memories', 'cross-session', 'private']) {
  mkdirSync(join(root, name), { recursive: true })
}

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const runtimeFile = [
  `DASHEN_NODE=${shellQuote(nodePath)}`,
  `DASHEN_HOST_SCRIPT=${shellQuote(hostScript)}`,
  `DASHEN_PORT=${shellQuote(port)}`,
  `DSH_HOME=${shellQuote(root)}`,
  `DASHEN_WORKSPACE=${shellQuote(workspace)}`,
  '',
].join('\n')
writeFileSync(join(root, '.portable-runtime'), runtimeFile, { mode: 0o600 })
writeFileSync(join(root, '.portable-version'), `${version}\n`, { mode: 0o600 })

for (const relative of ['bin/dsh', 'scripts/start', 'scripts/stop', 'scripts/restart', 'scripts/status', 'scripts/enable-host', 'scripts/disable-host', 'scripts/ensure-web']) {
  const path = join(root, relative)
  if (existsSync(path)) chmodSync(path, 0o755)
}
