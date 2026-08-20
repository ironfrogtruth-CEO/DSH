import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

import { extractSymbolsAndImports, supportedLanguage } from './extractors.js'

export const DEFAULT_MAX_FILE_BYTES = 1_000_000
export const DEFAULT_EXTENSIONS = [
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java',
  '.kt', '.swift', '.rb', '.php', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs',
  '.vue', '.svelte', '.sql', '.sh', '.bash', '.zsh',
]

const SECRET_FILE = /^(?:\.env(?:\..*)?|\.npmrc|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx|jks))$/i
const SECRET_DIR = /^(?:\.aws|\.ssh|secrets?)$/i

export class CodeIndexError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CodeIndexError'
    this.code = code
  }
}

export function normalizeProjectId(projectId) {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new CodeIndexError('PROJECT_REQUIRED', 'projectId is required')
  const value = projectId.trim()
  if (value.length > 160 || /[\\/\0]/.test(value) || value === '.' || value === '..') throw new CodeIndexError('PROJECT_INVALID', 'projectId contains an invalid path component')
  return value
}

export function canonicalWorkspaceRoot(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) throw new CodeIndexError('WORKSPACE_REQUIRED', 'workspaceRoot is required; implicit cwd is disabled')
  const candidate = resolve(workspaceRoot)
  try {
    return realpathSync(candidate)
  } catch {
    throw new CodeIndexError('WORKSPACE_NOT_FOUND', `workspaceRoot does not exist: ${candidate}`)
  }
}

function isInside(root, target) {
  const rel = target === root ? '' : target.slice(root.length + 1)
  return target === root || (target.startsWith(`${root}${sep}`) && !rel.split(sep).includes('..'))
}

function git(root, args) {
  const result = spawnSync('/usr/bin/git', args, { cwd: root, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 })
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.toString('utf8').trim() || `git ${args.join(' ')} failed`
    throw new CodeIndexError('GIT_REQUIRED', detail)
  }
  return result.stdout
}

export function gitBranch(workspaceRoot) {
  const root = canonicalWorkspaceRoot(workspaceRoot)
  const branchResult = git(root, ['branch', '--show-current']).toString('utf8').trim()
  if (branchResult) return branchResult
  const commit = git(root, ['rev-parse', 'HEAD']).toString('utf8').trim()
  return `detached:${commit}`
}

function pathHasSecretSegment(path) {
  const parts = path.split(/[\\/]/)
  return parts.some((part, index) => index < parts.length - 1 && SECRET_DIR.test(part)) || SECRET_FILE.test(parts.at(-1) ?? '')
}

function allowedExtension(path, extensions) {
  const extension = extname(path).toLowerCase()
  return extensions.includes(extension)
}

function isBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  return sample.includes(0)
}

function fileRealPath(root, absolutePath) {
  const stat = lstatSync(absolutePath)
  if (!stat.isFile()) throw new CodeIndexError('NOT_REGULAR_FILE', `${absolutePath} is not a regular file`)
  const real = realpathSync(absolutePath)
  if (!isInside(root, real)) throw new CodeIndexError('WORKSPACE_ESCAPE', `workspace path resolves outside workspaceRoot: ${absolutePath}`)
  return real
}

export function scanWorkspace({ workspaceRoot, extensions = DEFAULT_EXTENSIONS, maxFileBytes = DEFAULT_MAX_FILE_BYTES }) {
  const root = canonicalWorkspaceRoot(workspaceRoot)
  const branch = gitBranch(root)
  const raw = git(root, ['ls-files', '-co', '--exclude-standard', '-z'])
  const paths = raw.toString('utf8').split('\0').filter(Boolean)
  const files = []
  const skipped = []
  for (const relativePath of paths) {
    const absolute = resolve(root, ...relativePath.split('/'))
    if (!isInside(root, absolute)) {
      skipped.push({ path: relativePath, reason: 'workspace-outside' })
      continue
    }
    if (!allowedExtension(relativePath, extensions)) {
      skipped.push({ path: relativePath, reason: 'extension' })
      continue
    }
    if (pathHasSecretSegment(relativePath)) {
      skipped.push({ path: relativePath, reason: 'secret-pattern' })
      continue
    }
    let real
    try {
      real = fileRealPath(root, absolute)
    } catch (error) {
      skipped.push({ path: relativePath, reason: error.code || 'not-file' })
      continue
    }
    let stat
    try {
      stat = statSync(real)
    } catch {
      skipped.push({ path: relativePath, reason: 'stat-failed' })
      continue
    }
    if (stat.size > maxFileBytes) {
      skipped.push({ path: relativePath, reason: 'large-file', bytes: stat.size })
      continue
    }
    let buffer
    try {
      buffer = readFileSync(real)
    } catch {
      skipped.push({ path: relativePath, reason: 'read-failed' })
      continue
    }
    if (isBinary(buffer)) {
      skipped.push({ path: relativePath, reason: 'binary' })
      continue
    }
    const contentHash = createHash('sha256').update(buffer).digest('hex')
    const content = buffer.toString('utf8')
    const extracted = extractSymbolsAndImports({ path: relativePath, content })
    files.push({
      path: relativePath,
      absolutePath: real,
      bytes: buffer.length,
      contentHash,
      content,
      language: extracted.language || supportedLanguage(relativePath),
      symbols: extracted.symbols,
      imports: extracted.imports,
      scope: 'workspace',
      untrusted: true,
      source: 'git-ls-files',
    })
  }
  return { root, branch, files, skipped, listed: paths.length, maxFileBytes, extensions }
}

export function assertRelativeWorkspacePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) throw new CodeIndexError('PATH_REQUIRED', 'relative path is required')
  const value = relativePath.trim().replaceAll('\\', '/')
  if (value.startsWith('/') || value.split('/').includes('..') || value.includes('\0')) throw new CodeIndexError('PATH_OUTSIDE_WORKSPACE', `path must remain workspace-relative: ${relativePath}`)
  return value
}
