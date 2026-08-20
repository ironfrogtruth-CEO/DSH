import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'

export class ArtifactPathError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ArtifactPathError'
    this.code = code
  }
}

function isInside(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep))
}

function existingAncestor(path) {
  let candidate = path
  while (!existsSync(candidate)) {
    const parent = dirname(candidate)
    if (parent === candidate) return null
    candidate = parent
  }
  return candidate
}

function canonicalExisting(path, label) {
  try {
    return realpathSync(path)
  } catch {
    throw new ArtifactPathError('ROOT_NOT_FOUND', `${label} does not exist: ${path}`)
  }
}

function normalizeAllowedRoots({ workspaceRoot, allowedRoot }) {
  const workspace = canonicalExisting(resolve(workspaceRoot), 'workspaceRoot')
  if (!statSync(workspace).isDirectory()) throw new ArtifactPathError('WORKSPACE_NOT_DIRECTORY', `workspaceRoot is not a directory: ${workspace}`)
  const output = resolve(workspace, 'output')
  const roots = []
  if (existsSync(output) && statSync(output).isDirectory()) roots.push({ root: canonicalExisting(output, 'workspace/output'), kind: 'workspace/output' })
  roots.push({ root: workspace, kind: 'workspace' })
  const explicit = Array.isArray(allowedRoot) ? allowedRoot : (allowedRoot ? [allowedRoot] : [])
  for (const value of explicit) {
    if (typeof value !== 'string' || !value.trim()) throw new ArtifactPathError('ALLOWED_ROOT_INVALID', 'allowedRoot entries must be non-empty strings')
    const candidate = resolve(value.startsWith('/') ? value : workspace, value)
    roots.push({ root: canonicalExisting(candidate, 'allowedRoot'), kind: 'allowedRoot' })
  }
  return { workspace, roots }
}

export function canonicalArtifactPath({ workspaceRoot, artifactPath, allowedRoot } = {}) {
  if (typeof artifactPath !== 'string' || !artifactPath.trim()) throw new ArtifactPathError('ARTIFACT_PATH_REQUIRED', 'artifactPath is required')
  if (artifactPath.includes('\0')) throw new ArtifactPathError('ARTIFACT_PATH_INVALID', 'artifactPath contains a null byte')
  const { workspace, roots } = normalizeAllowedRoots({ workspaceRoot, allowedRoot })
  const candidate = resolve(artifactPath.startsWith('/') ? artifactPath : workspace, artifactPath)
  const existing = existingAncestor(candidate)
  if (existing) {
    const canonicalParent = canonicalExisting(existing, 'artifact parent')
    if (!roots.some(({ root }) => isInside(root, canonicalParent) || isInside(root, candidate))) throw new ArtifactPathError('ARTIFACT_PATH_ESCAPE', `artifactPath escapes allowed roots: ${artifactPath}`)
    if (existsSync(candidate)) {
      try {
        const stat = lstatSync(candidate)
        const canonicalTarget = realpathSync(candidate)
        if (!roots.some(({ root }) => isInside(root, canonicalTarget))) throw new ArtifactPathError('ARTIFACT_PATH_ESCAPE', `artifactPath symlink escapes allowed roots: ${artifactPath}`)
        if (!stat.isFile()) throw new ArtifactPathError('ARTIFACT_NOT_FILE', `artifactPath is not a regular file: ${artifactPath}`)
      } catch (error) {
        if (error instanceof ArtifactPathError) throw error
        throw new ArtifactPathError('ARTIFACT_PATH_INVALID', `${artifactPath}: ${error.message}`)
      }
    }
  } else if (!roots.some(({ root }) => isInside(root, candidate))) {
    throw new ArtifactPathError('ARTIFACT_PATH_ESCAPE', `artifactPath escapes allowed roots: ${artifactPath}`)
  }
  const rootMatch = roots.find(({ root }) => isInside(root, existing ? (existsSync(candidate) ? realpathSync(candidate) : canonicalExisting(existing, 'artifact parent')) : candidate)) ?? roots[0]
  return {
    path: candidate,
    relativeToWorkspace: relative(workspace, candidate).split(sep).join('/'),
    rootKind: rootMatch.kind,
    workspaceRoot: workspace,
  }
}
