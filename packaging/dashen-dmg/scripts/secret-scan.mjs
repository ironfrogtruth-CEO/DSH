#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

const [sourceCredentials, payloadRoot] = process.argv.slice(2)
if (!payloadRoot) {
  console.error('secret-scan: sourceCredentials and payloadRoot are required')
  process.exit(64)
}

const forbiddenParts = new Set([
  '.credentials.yaml', '.env', 'private', 'sessions', 'attachments', 'logs', 'output',
  'backups', 'screen-memory', 'gzh-publisher-profile', 'xhs-publisher-profile',
])
const sourceText = sourceCredentials && existsSync(sourceCredentials) ? readFileSync(sourceCredentials, 'utf8') : ''
const secretValues = sourceText
  .split(/\r?\n/)
  .map((line) => line.match(/^\s{2}[A-Z][A-Z0-9_]+:\s*(.+?)\s*$/)?.[1]?.replace(/^['"]|['"]$/g, ''))
  .filter((value) => typeof value === 'string' && value.length >= 12)

const failures = []
let scannedFiles = 0
let scannedBytes = 0

function isText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  return !sample.includes(0)
}

function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const rel = relative(payloadRoot, path)
    const parts = rel.split('/')
    if (forbiddenParts.has(parts[0]) || parts.includes('.credentials.yaml')) failures.push(`forbidden-path:${rel}`)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path)
      if (isAbsolute(target)) failures.push(`absolute-symlink:${rel}`)
      if (!existsSync(path)) failures.push(`broken-symlink:${rel}`)
      continue
    }
    if (entry.isDirectory()) { scan(path); continue }
    if (!entry.isFile()) continue
    scannedFiles += 1
    scannedBytes += stat.size
    if (stat.size > 120 * 1024 * 1024) continue
    const data = readFileSync(path)
    if (!isText(data)) continue
    const text = data.toString('utf8')
    if (text.includes('/Users/marcus')) failures.push(`absolute-user-path:${rel}`)
    if (secretValues.some((value) => text.includes(value))) failures.push(`source-secret-value:${rel}`)
  }
}

scan(payloadRoot)
if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures: [...new Set(failures)].sort() }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, scannedFiles, scannedBytes, sourceSecretCount: secretValues.length }))
