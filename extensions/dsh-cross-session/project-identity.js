// Pure project identity helpers. No git command, session read, or implicit
// current-project lookup happens here.
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, normalize, resolve } from 'node:path'

function clean(value, fallback = '') {
  return String(value ?? fallback).trim().replace(/\\/g, '/')
}

export function canonicalCwd(value) {
  const raw = clean(value)
  if (!raw) throw new Error('cwd is required for project identity')
  return normalize(isAbsolute(raw) ? raw : resolve(raw)).replace(/\\/g, '/')
}

export function canonicalRepoIdentity(remote = '') {
  const raw = clean(remote).replace(/\.git(?:\/)?$/i, '').replace(/\/$/, '')
  if (!raw) return ''
  // SSH scp syntax: git@github.com:org/repo -> github.com/org/repo.
  const scp = raw.match(/^[^@]+@([^:]+):(.+)$/)
  if (scp) return `${scp[1].toLowerCase()}/${scp[2].replace(/^\/+/, '')}`.replace(/\.git$/i, '')
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`)
    return `${url.host.toLowerCase()}${url.pathname.replace(/\/+/g, '/').replace(/\.git$/i, '')}`
  } catch {
    return raw.toLowerCase().replace(/\/+/g, '/')
  }
}

export function buildProjectIdentity({ cwd, gitRemote = '', repoIdentity = '', branch = '', worktree = '' } = {}) {
  const canonical = canonicalCwd(cwd)
  const repo = canonicalRepoIdentity(repoIdentity || gitRemote)
  const branchValue = clean(branch)
  const worktreeValue = clean(worktree)
  // Project identity is repository-level when a remote/repo identity exists;
  // branch/worktree belong to a workspace identity and must not split one
  // repository into multiple projects. Without a remote, canonical cwd is
  // the stable project fallback.
  const projectBasis = repo ? { repo } : { cwd: canonical }
  const workspaceBasis = { cwd: canonical, branch: branchValue || null, worktree: worktreeValue || null }
  const fingerprint = JSON.stringify(projectBasis)
  const workspaceFingerprint = JSON.stringify(workspaceBasis)
  const digest = createHash('sha256').update(fingerprint, 'utf8').digest('hex').slice(0, 32)
  const workspaceDigest = createHash('sha256').update(workspaceFingerprint, 'utf8').digest('hex').slice(0, 32)
  return {
    projectId: `project:${digest}`,
    workspaceId: `workspace:${workspaceDigest}`,
    canonicalCwd: canonical,
    repoIdentity: repo || null,
    branch: branchValue || null,
    worktree: worktreeValue || null,
    remotePresent: Boolean(repo),
    stable: true,
    fingerprint,
    workspaceFingerprint,
  }
}

export function resolveProjectIdentity(input = {}) {
  const requested = canonicalCwd(input.cwd)
  let canonical = requested
  try { canonical = realpathSync(requested).replace(/\\/g, '/') } catch { /* missing cwd stays deterministic */ }
  return buildProjectIdentity({ ...input, cwd: canonical })
}

export function assertProjectMatch(projectId, identity) {
  if (!projectId || !identity || projectId !== identity.projectId) {
    const error = new Error(`projectId does not match canonical project identity (${identity?.projectId || 'unknown'})`)
    error.code = 'PROJECT_ID_MISMATCH'
    throw error
  }
  return identity
}
