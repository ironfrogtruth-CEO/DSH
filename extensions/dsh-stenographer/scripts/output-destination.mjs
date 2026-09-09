import { createHash, randomUUID } from 'node:crypto'
import { open, mkdir, stat, unlink, link, rmdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, extname, isAbsolute, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The final-output boundary is deliberately separate from the private
 * stenographer store. It copies only bytes that a caller has already marked
 * as a user-facing final artifact.
 */
export const OUTPUT_DESTINATION_SCHEMA = 'output_destination.v1'
export const DEFAULT_ICLOUD_OUTPUT_ROOT = join(
  process.env.HOME || '/Users/marcus',
  'Library',
  'Mobile Documents',
  'com~apple~CloudDocs',
  '大神',
)
export const DEFAULT_WORKSPACE_OUTPUT_ROOT = join(
  process.env.HOME || '/Users/marcus',
  'Desktop',
  '虾缸',
  'output',
  '大神',
)
export const ICLOUD_METADATA_READER = fileURLToPath(new URL('../scripts/read-icloud-metadata.swift', import.meta.url))

const ICLOUD_QUOTA_SYMBOLS = new Set([
  'NSUbiquitousFileNotUploadedDueToQuotaError',
  'NSFileProviderErrorInsufficientQuota',
])
const ICLOUD_QUOTA_DOMAINS = new Map([
  [4354, new Set(['NSCocoaErrorDomain'])],
  [-1003, new Set(['NSFileProviderErrorDomain'])],
])
const ICLOUD_UNREACHABLE_CODES = new Set([
  4355,
  -1004,
  '4355',
  '-1004',
  'NSUbiquitousFileNotUploadedDueToServerUnreachableError',
  'NSFileProviderErrorServerUnreachable',
])
const SPACE_CODES = new Set(['ENOSPC', 'EDQUOT'])
const SAFE_NAME_FALLBACK = '未命名成品'

export class OutputDestinationError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options)
    this.name = 'OutputDestinationError'
    this.code = code
    Object.assign(this, details)
  }
}

function stringValue(value) {
  return typeof value === 'string' ? value : String(value ?? '')
}

function trimControl(value) {
  return stringValue(value)
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** Clean one user-controlled path segment while retaining Chinese names. */
export function sanitizeOutputSegment(value, fallback = SAFE_NAME_FALLBACK) {
  const cleaned = trimControl(value)
    .replace(/[\\/:*?"<>|]/gu, '-')
    .replace(/^[. ]+|[. ]+$/gu, '')
    .replace(/-{2,}/gu, '-')
    .slice(0, 120)
    .trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback
  return cleaned
}

export function sanitizeOutputFilename(value, fallback = '成品.bin') {
  const source = trimControl(value) || fallback
  const parsed = parse(source)
  const base = sanitizeOutputSegment(parsed.name || fallback.replace(/\.[^.]+$/u, ''), '成品')
  const extension = extname(source).replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, '').slice(0, 20)
  const suffix = extension && extension !== '.' ? extension : extname(fallback) || '.bin'
  return `${base}${suffix}`
}

/**
 * Clean a caller-provided path relative to the delivery root.
 *
 * Final HTML/PPT deliveries may contain linked assets such as
 * ``images/foo.png``.  Flattening those names makes the HTML unusable, so
 * preserve the directory components while rejecting absolute and traversal
 * paths.  The resulting path is still sanitized component by component and
 * is safe to resolve beneath the destination root.
 */
export function sanitizeOutputRelativePath(value, fallback = '成品.bin') {
  const source = trimControl(value) || fallback
  const normalized = source.replace(/\\/gu, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)) {
    throw new OutputDestinationError('OUTPUT_RELATIVE_PATH_INVALID', '成品相对路径不能是绝对路径')
  }
  const parts = normalized.split('/')
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new OutputDestinationError('OUTPUT_RELATIVE_PATH_INVALID', '成品相对路径包含空目录或越界片段')
  }
  const filename = sanitizeOutputFilename(parts.pop(), fallback)
  const directories = parts.map((part) => sanitizeOutputSegment(part, '目录'))
  return [...directories, filename].join('/')
}

/**
 * Validate a bundle path without changing it. Linked HTML/PPT assets refer to
 * the exact relative path, so silently sanitizing a segment would publish a
 * file that the source document can no longer find.
 */
export function validateOutputRelativePath(value) {
  if (typeof value !== 'string' || !value.length) {
    throw new OutputDestinationError('OUTPUT_BUNDLE_PATH_INVALID', '成品包相对路径不能为空')
  }
  if (/^[\u0000-\u001f\u007f]/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new OutputDestinationError('OUTPUT_BUNDLE_PATH_INVALID', '成品包相对路径不能包含控制字符')
  }
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(value)) {
    throw new OutputDestinationError('OUTPUT_BUNDLE_PATH_INVALID', '成品包相对路径不能是绝对路径')
  }
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new OutputDestinationError('OUTPUT_BUNDLE_PATH_INVALID', '成品包相对路径包含空目录或越界片段')
  }
  if (sanitizeOutputRelativePath(value) !== value) {
    throw new OutputDestinationError('OUTPUT_BUNDLE_PATH_INVALID', '成品包相对路径包含需要改名的字符，拒绝静默改名')
  }
  return value
}

function assertAbsoluteRoot(value, label) {
  const raw = stringValue(value)
  if (!raw || !isAbsolute(raw)) {
    throw new OutputDestinationError('OUTPUT_ROOT_INVALID', `${label}必须是绝对路径`)
  }
  return resolve(raw)
}

function safeOutputPath(root, theme, filename) {
  const rootResolved = assertAbsoluteRoot(root, '成品根目录')
  const target = resolve(rootResolved, sanitizeOutputSegment(theme, '默认'), sanitizeOutputRelativePath(filename))
  if (target !== rootResolved && !target.startsWith(`${rootResolved}/`)) {
    throw new OutputDestinationError('OUTPUT_PATH_OUTSIDE_ROOT', '成品路径超出根目录')
  }
  return target
}

function errorCode(error) {
  return error?.code ?? error?.errno ?? error?.cause?.code ?? error?.cause?.errno
}

function isSpaceError(error) {
  return SPACE_CODES.has(stringValue(errorCode(error)).toUpperCase())
}

function isPotentialICloudPath(path) {
  return /(?:^|\/)Mobile Documents\/com~apple~CloudDocs(?:\/|$)/u.test(resolve(stringValue(path)))
}

/** Read the exact NSURL resource values through the host's Foundation bridge. */
export async function readICloudSyncMetadata(path, { swiftBinary = 'swift', scriptPath = ICLOUD_METADATA_READER, timeoutMs = 5_000 } = {}) {
  if (process.platform !== 'darwin') return { readerStatus: 'unsupported_platform' }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(swiftBinary, [scriptPath, path], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('ICLOUD_METADATA_READER_TIMEOUT'))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      let payload
      try { payload = JSON.parse(stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1) || '{}') } catch {
        reject(new Error(`ICLOUD_METADATA_READER_INVALID:${stderr.slice(0, 200)}`))
        return
      }
      if (code !== 0) {
        reject(new Error(`ICLOUD_METADATA_READER_FAILED:${payload.errorCode ?? code}`))
        return
      }
      resolvePromise(payload)
    })
  })
}

function metadataCode(metadata) {
  if (!metadata || typeof metadata !== 'object') return undefined
  return metadata.errorCode
    ?? metadata.uploadingErrorCode
    ?? metadata.uploadingError
    ?? metadata.error?.code
    ?? metadata.error?.domainCode
    ?? metadata.error?.name
}

function metadataDomain(metadata) {
  if (!metadata || typeof metadata !== 'object') return undefined
  return metadata.errorDomain
    ?? metadata.domain
    ?? metadata.error?.domain
    ?? metadata.error?.errorDomain
}

function metadataSymbol(metadata) {
  if (!metadata || typeof metadata !== 'object') return undefined
  return metadata.errorName
    ?? metadata.errorSymbol
    ?? metadata.symbol
    ?? metadata.error?.name
    ?? metadata.error?.symbol
}

/**
 * Classify only the exact, documented iCloud/FileProvider quota errors.
 * Everything else remains unknown so sync delay or an unreachable server
 * cannot silently become a quota fallback.
 */
export function classifyICloudSyncMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return { syncStatus: 'unknown', cloudSyncConfirmed: false, quota: false }
  }
  const code = metadataCode(metadata)
  const domain = metadataDomain(metadata)
  const symbol = metadataSymbol(metadata)
  const numericCode = Number(code)
  const quotaBySymbol = ICLOUD_QUOTA_SYMBOLS.has(stringValue(symbol))
  const quotaByDomain = ICLOUD_QUOTA_DOMAINS.get(numericCode)?.has(stringValue(domain)) === true
  // A numeric error code is only meaningful together with the Foundation or
  // FileProvider domain that owns it. A bare -1003 is ambiguous because
  // NSURLErrorDomain uses it for host-not-found; a bare 4354 is likewise not
  // enough evidence for quota fallback. Named symbols are explicit evidence
  // even when a bridge omits the domain.
  if (quotaBySymbol || quotaByDomain || ICLOUD_QUOTA_SYMBOLS.has(stringValue(code))) {
    return { syncStatus: 'icloud_quota', cloudSyncConfirmed: false, quota: true, errorCode: code }
  }
  if (ICLOUD_UNREACHABLE_CODES.has(code) || ICLOUD_UNREACHABLE_CODES.has(numericCode)) {
    return { syncStatus: 'unknown', cloudSyncConfirmed: false, quota: false, errorCode: code }
  }
  if (metadata.isUploaded === true) {
    return { syncStatus: 'uploaded', cloudSyncConfirmed: true, quota: false }
  }
  // A false flag proves that the cloud state is not confirmed; it does not
  // identify the reason for failure.
  return { syncStatus: 'unknown', cloudSyncConfirmed: false, quota: false, errorCode: code }
}

async function syncDirectory(path, fsApi) {
  try {
    const handle = await fsApi.open(path, 'r')
    try { await handle.sync() } finally { await handle.close() }
  } catch {
    // Directory fsync is a durability enhancement. The file was already
    // atomically committed; metadata readback still determines cloud state.
  }
}

async function ensureDirectory(path, fsApi) {
  await fsApi.mkdir(path, { recursive: true, mode: 0o755 })
  const info = await fsApi.stat(path)
  if (!info.isDirectory()) throw new OutputDestinationError('OUTPUT_ROOT_NOT_DIRECTORY', `成品目录不是目录: ${path}`)
}

function nextCandidate(path, index) {
  if (index === 0) return path
  const parsed = parse(path)
  return join(parsed.dir, `${parsed.name}-${index + 1}${parsed.ext}`)
}

/**
 * Commit a temporary file without replacing an existing user file. APFS and
 * the local iCloud provider support hard-link publication; link() is atomic
 * and fails with EEXIST, allowing a deterministic -2/-3 name allocation.
 */
async function publishNoReplace(temp, initialTarget, fsApi) {
  for (let index = 0; index < 10_000; index += 1) {
    const target = nextCandidate(initialTarget, index)
    try {
      await fsApi.link(temp, target)
      await fsApi.unlink(temp)
      return target
    } catch (error) {
      if (stringValue(errorCode(error)).toUpperCase() === 'EEXIST') continue
      throw error
    }
  }
  throw new OutputDestinationError('OUTPUT_NAME_EXHAUSTED', '成品重名冲突过多，无法安全保存')
}

async function atomicBytesWrite(target, bytes, fsApi) {
  await ensureDirectory(dirname(target), fsApi)
  const temp = `${target}.tmp-${process.pid}-${randomUUID()}`
  let handle
  try {
    handle = await fsApi.open(temp, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = null
    const actual = await publishNoReplace(temp, target, fsApi)
    await syncDirectory(dirname(actual), fsApi)
    return actual
  } finally {
    try { await handle?.close() } catch { /* best effort */ }
    try { await fsApi.unlink(temp) } catch { /* no temp or already published */ }
  }
}

async function readSource({ bytes, sourcePath, fsApi }) {
  if (bytes !== undefined && sourcePath !== undefined) {
    throw new OutputDestinationError('OUTPUT_SOURCE_AMBIGUOUS', '成品只能提供 bytes 或 sourcePath 之一')
  }
  if (bytes !== undefined) return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (!sourcePath) throw new OutputDestinationError('OUTPUT_SOURCE_REQUIRED', '缺少成品 bytes 或 sourcePath')
  const source = resolve(stringValue(sourcePath))
  const info = await fsApi.stat(source)
  if (!info.isFile()) throw new OutputDestinationError('OUTPUT_SOURCE_NOT_FILE', '成品源不是文件')
  return fsApi.readFile(source)
}

function sourceDigest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function resultPayload({ preferredPath, actualPath, storageTier, fallbackReason, bytes, sync }) {
  return {
    schema: OUTPUT_DESTINATION_SCHEMA,
    preferred_path: preferredPath,
    actual_path: actualPath,
    storage_tier: storageTier,
    fallback_reason: fallbackReason,
    sync_status: sync.syncStatus,
    cloud_sync_confirmed: sync.cloudSyncConfirmed,
    sync_error_code: sync.errorCode ?? null,
    bytes: bytes.byteLength,
    content_checksum: sourceDigest(bytes),
  }
}

async function verifyWrittenBytes(path, expected, fsApi) {
  const actual = await fsApi.readFile(path)
  if (actual.byteLength !== expected.byteLength || !actual.equals(expected)) {
    throw new OutputDestinationError('OUTPUT_FALLBACK_VERIFY_FAILED', '工作区成品回读校验失败')
  }
}

/**
 * Route one final user-facing artifact. A quota metadata result after a
 * successful iCloud publication is treated as a failed cloud destination and
 * copied to the workspace; the just-created iCloud file is removed when
 * possible so the caller has one authoritative actual_path.
 */
export async function routeFinalOutput({
  bytes,
  sourcePath,
  fileName,
  theme = '默认',
  preferredRoot = process.env.DSH_OUTPUT_ICLOUD_ROOT || DEFAULT_ICLOUD_OUTPUT_ROOT,
  fallbackRoot = process.env.DSH_OUTPUT_FALLBACK_ROOT || DEFAULT_WORKSPACE_OUTPUT_ROOT,
  syncMetadataReader = null,
  fsApi = null,
} = {}) {
  const fs = fsApi || {
    open,
    mkdir,
    stat,
    readFile: (await import('node:fs/promises')).readFile,
    unlink,
    link,
    rmdir,
  }
  const data = await readSource({ bytes, sourcePath, fsApi: fs })
  if (!data.byteLength) throw new OutputDestinationError('OUTPUT_EMPTY', '成品内容为空，拒绝写入')
  const cleanTheme = sanitizeOutputSegment(theme, '默认')
  const cleanName = sanitizeOutputRelativePath(fileName)
  const preferredPath = safeOutputPath(preferredRoot, cleanTheme, cleanName)
  const fallbackPath = safeOutputPath(fallbackRoot, cleanTheme, cleanName)
  let actualPreferred
  let fallbackReason = null
  let sync = { syncStatus: 'unknown', cloudSyncConfirmed: false, quota: false }
  try {
    actualPreferred = await atomicBytesWrite(preferredPath, data, fs)
    const metadataReader = typeof syncMetadataReader === 'function'
      ? syncMetadataReader
      : isPotentialICloudPath(preferredRoot)
        ? readICloudSyncMetadata
        : null
    if (typeof metadataReader === 'function') {
      try {
        sync = classifyICloudSyncMetadata(await metadataReader(actualPreferred))
      } catch (error) {
        sync = { syncStatus: 'unknown', cloudSyncConfirmed: false, quota: false, errorCode: errorCode(error) }
      }
    }
    if (!sync.quota) {
      return resultPayload({ preferredPath: actualPreferred, actualPath: actualPreferred, storageTier: 'icloud', fallbackReason, bytes: data, sync })
    }
    fallbackReason = 'icloud_quota'
  } catch (error) {
    if (!isSpaceError(error)) throw new OutputDestinationError('OUTPUT_PREFERRED_WRITE_FAILED', '首选成品目录写入失败', { causeCode: errorCode(error), preferredPath }, { cause: error })
    fallbackReason = stringValue(errorCode(error)).toUpperCase() === 'EDQUOT' ? 'local_quota' : 'local_space'
  }

  try {
    const actualFallback = await atomicBytesWrite(fallbackPath, data, fs)
    // Verify the fallback before removing the copy created by this call. If
    // the workspace is full or the readback is corrupt, the iCloud copy and
    // the original source remain available for recovery.
    await verifyWrittenBytes(actualFallback, data, fs)
    if (actualPreferred) {
      try { await fs.unlink(actualPreferred) } catch { /* preserve the source; report the fallback path */ }
    }
    return resultPayload({
      preferredPath,
      actualPath: actualFallback,
      storageTier: 'workspace',
      fallbackReason,
      bytes: data,
      sync: fallbackReason === 'icloud_quota'
        ? { ...sync, syncStatus: 'icloud_quota', cloudSyncConfirmed: false, quota: true }
        : { syncStatus: 'not_applicable', cloudSyncConfirmed: false, quota: false },
    })
  } catch (error) {
    throw new OutputDestinationError('OUTPUT_FALLBACK_WRITE_FAILED', '首选目录失败后，工作区成品写入也失败', { causeCode: errorCode(error), fallbackPath, fallbackReason }, { cause: error })
  }
}

async function allocateBundleRoot(root, theme, bundleId, fsApi) {
  const rootResolved = assertAbsoluteRoot(root, '成品根目录')
  const themeRoot = resolve(rootResolved, sanitizeOutputSegment(theme, '默认'))
  await ensureDirectory(themeRoot, fsApi)
  const cleanBundleId = sanitizeOutputSegment(bundleId, `delivery-${randomUUID().slice(0, 12)}`)
  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index === 0 ? '' : `-${index + 1}`
    const candidate = join(themeRoot, `${cleanBundleId}${suffix}`)
    try {
      await fsApi.mkdir(candidate, { recursive: false, mode: 0o755 })
      return candidate
    } catch (error) {
      if (stringValue(errorCode(error)).toUpperCase() === 'EEXIST') continue
      throw error
    }
  }
  throw new OutputDestinationError('OUTPUT_BUNDLE_NAME_EXHAUSTED', '成品包重名冲突过多，无法安全保存')
}

async function removeBundleFiles(bundleRoot, paths, fsApi) {
  for (const path of paths) {
    try { await fsApi.unlink(path) } catch { /* best effort; source remains authoritative */ }
  }
  const directories = [...new Set(paths.flatMap((path) => {
    const values = []
    let current = dirname(path)
    while (current && current !== bundleRoot && current.startsWith(`${bundleRoot}/`)) {
      values.push(current)
      current = dirname(current)
    }
    return values
  }))].sort((left, right) => right.length - left.length)
  for (const directory of directories) {
    try { await fsApi.rmdir(directory) } catch { /* non-empty/race; preserve for recovery */ }
  }
  try { await fsApi.rmdir(bundleRoot) } catch { /* non-empty/race; preserve for recovery */ }
}

function bundleResultPayload({ preferredPath, actualPath, storageTier, fallbackReason, bytes, sync, bundleId, bundleRoot, relativePath }) {
  return {
    ...resultPayload({ preferredPath, actualPath, storageTier, fallbackReason, bytes, sync }),
    bundle_id: bundleId,
    bundle_root: bundleRoot,
    relative_path: relativePath,
  }
}

/**
 * Route a linked multi-file final package as one unit.
 *
 * A fresh child directory under ``theme`` is allocated before any file is
 * published.  If any preferred write or exact iCloud quota readback fails,
 * every file is written and verified under the matching fallback child; the
 * preferred files from this call are removed only after the full fallback is
 * readable.  This keeps HTML/PPT assets together and avoids per-file ``-2``
 * names that would break relative links.
 */
export async function routeFinalBundle({
  files = [],
  theme = '默认',
  bundleId = '',
  preferredRoot = process.env.DSH_OUTPUT_ICLOUD_ROOT || DEFAULT_ICLOUD_OUTPUT_ROOT,
  fallbackRoot = process.env.DSH_OUTPUT_FALLBACK_ROOT || DEFAULT_WORKSPACE_OUTPUT_ROOT,
  syncMetadataReader = null,
  fsApi = null,
} = {}) {
  if (!Array.isArray(files) || !files.length) {
    throw new OutputDestinationError('OUTPUT_BUNDLE_FILES_REQUIRED', '成品包至少需要一个文件')
  }
  const fs = fsApi || {
    open,
    mkdir,
    stat,
    readFile: (await import('node:fs/promises')).readFile,
    unlink,
    link,
    rmdir,
  }
  const prepared = []
  const seenRelativePaths = new Set()
  for (const file of files) {
    if (!file || typeof file !== 'object') {
      throw new OutputDestinationError('OUTPUT_BUNDLE_FILE_INVALID', '成品包文件项无效')
    }
    const relativePath = validateOutputRelativePath(file.relativePath ?? file.fileName ?? file.name)
    if (seenRelativePaths.has(relativePath)) {
      throw new OutputDestinationError('OUTPUT_BUNDLE_PATH_DUPLICATE', `成品包存在重复相对路径: ${relativePath}`)
    }
    seenRelativePaths.add(relativePath)
    const bytes = await readSource({
      bytes: file.bytes,
      sourcePath: file.sourcePath ?? file.source_path,
      fsApi: fs,
    })
    if (!bytes.byteLength) throw new OutputDestinationError('OUTPUT_EMPTY', `成品内容为空: ${relativePath}`)
    prepared.push({
      bytes,
      relativePath,
      sourcePath: file.sourcePath ?? file.source_path,
    })
  }

  const cleanTheme = sanitizeOutputSegment(theme, '默认')
  const requestedBundleId = String(bundleId || `delivery-${randomUUID().slice(0, 12)}`)
  let preferredBundleRoot
  let fallbackBundleRoot
  let preferredAllocationError = null
  try {
    preferredBundleRoot = await allocateBundleRoot(preferredRoot, cleanTheme, requestedBundleId, fs)
  } catch (error) {
    if (!isSpaceError(error)) {
      throw new OutputDestinationError('OUTPUT_PREFERRED_WRITE_FAILED', '首选成品包目录创建失败', { causeCode: errorCode(error) }, { cause: error })
    }
    preferredAllocationError = error
    preferredBundleRoot = null
  }

  const preferredPaths = []
  const preferredRecords = []
  let fallbackReason = null
  let preferredSync = []
  let quotaSync = null
  try {
    if (!preferredBundleRoot) {
      const code = String(errorCode(preferredAllocationError) || 'ENOSPC').toUpperCase()
      fallbackReason = code === 'EDQUOT' ? 'local_quota' : 'local_space'
      throw Object.assign(new Error('preferred bundle root unavailable'), { code })
    }
    for (const item of prepared) {
      const target = resolve(preferredBundleRoot, item.relativePath)
      if (target !== preferredBundleRoot && !target.startsWith(`${preferredBundleRoot}/`)) {
        throw new OutputDestinationError('OUTPUT_PATH_OUTSIDE_ROOT', '成品包路径超出根目录')
      }
      const actual = await atomicBytesWrite(target, item.bytes, fs)
      if (actual !== target) {
        throw new OutputDestinationError('OUTPUT_BUNDLE_CONFLICT', '成品包文件发生重名冲突，已阻断逐文件改名')
      }
      preferredPaths.push(actual)
      preferredRecords.push({ ...item, preferredPath: actual })
    }
    const metadataReader = typeof syncMetadataReader === 'function'
      ? syncMetadataReader
      : isPotentialICloudPath(preferredRoot)
        ? readICloudSyncMetadata
        : null
    preferredSync = []
    if (typeof metadataReader === 'function') {
      for (const record of preferredRecords) {
        let sync
        try {
          sync = classifyICloudSyncMetadata(await metadataReader(record.preferredPath))
        } catch (error) {
          sync = { syncStatus: 'unknown', cloudSyncConfirmed: false, quota: false, errorCode: errorCode(error) }
        }
        preferredSync.push(sync)
        if (sync.quota) {
          fallbackReason = 'icloud_quota'
          quotaSync = sync
          throw Object.assign(new Error('exact iCloud quota metadata'), { code: 'ICLOUD_QUOTA' })
        }
      }
    } else {
      preferredSync = prepared.map(() => ({ syncStatus: 'unknown', cloudSyncConfirmed: false, quota: false }))
    }
  } catch (error) {
    if (!fallbackReason && !isSpaceError(error) && error?.code !== 'ICLOUD_QUOTA') throw error
    if (!fallbackReason) fallbackReason = String(errorCode(error)).toUpperCase() === 'EDQUOT' ? 'local_quota' : 'local_space'
  }

  if (!fallbackReason) {
    const bundleIdActual = parse(preferredBundleRoot).base
    return preferredRecords.map((record, index) => bundleResultPayload({
      preferredPath: record.preferredPath,
      actualPath: record.preferredPath,
      storageTier: 'icloud',
      fallbackReason: null,
      bytes: record.bytes,
      sync: preferredSync[index] || { syncStatus: 'unknown', cloudSyncConfirmed: false, quota: false },
      bundleId: bundleIdActual,
      bundleRoot: preferredBundleRoot,
      relativePath: record.relativePath,
    }))
  }

  try {
    fallbackBundleRoot = await allocateBundleRoot(fallbackRoot, cleanTheme, requestedBundleId, fs)
    const fallbackRecords = []
    for (const item of prepared) {
      const target = resolve(fallbackBundleRoot, item.relativePath)
      if (target !== fallbackBundleRoot && !target.startsWith(`${fallbackBundleRoot}/`)) {
        throw new OutputDestinationError('OUTPUT_PATH_OUTSIDE_ROOT', '回退成品包路径超出根目录')
      }
      const actual = await atomicBytesWrite(target, item.bytes, fs)
      if (actual !== target) {
        throw new OutputDestinationError('OUTPUT_BUNDLE_CONFLICT', '回退成品包文件发生重名冲突，已阻断逐文件改名')
      }
      fallbackRecords.push({ ...item, actualPath: actual })
    }
    for (const record of fallbackRecords) await verifyWrittenBytes(record.actualPath, record.bytes, fs)
    if (preferredBundleRoot && preferredPaths.length) await removeBundleFiles(preferredBundleRoot, preferredPaths, fs)
    const bundleIdActual = parse(fallbackBundleRoot).base
    const preferredReceiptRoot = preferredBundleRoot || resolve(
      assertAbsoluteRoot(preferredRoot, '成品根目录'),
      cleanTheme,
      sanitizeOutputSegment(requestedBundleId, `delivery-${randomUUID().slice(0, 12)}`),
    )
    return fallbackRecords.map((record) => bundleResultPayload({
      preferredPath: resolve(preferredReceiptRoot, record.relativePath),
      actualPath: record.actualPath,
      storageTier: 'workspace',
      fallbackReason,
      bytes: record.bytes,
      sync: fallbackReason === 'icloud_quota'
        ? { syncStatus: 'icloud_quota', cloudSyncConfirmed: false, quota: true, errorCode: quotaSync?.errorCode }
        : { syncStatus: 'not_applicable', cloudSyncConfirmed: false, quota: false },
      bundleId: bundleIdActual,
      bundleRoot: fallbackBundleRoot,
      relativePath: record.relativePath,
    }))
  } catch (error) {
    throw new OutputDestinationError(
      'OUTPUT_FALLBACK_WRITE_FAILED',
      '首选目录失败后，工作区成品包写入也失败',
      { causeCode: errorCode(error), fallbackReason },
      { cause: error },
    )
  }
}

export function outputDestinationConfig({ preferredRoot, fallbackRoot } = {}) {
  return {
    schema: OUTPUT_DESTINATION_SCHEMA,
    preferred_root: assertAbsoluteRoot(preferredRoot || process.env.DSH_OUTPUT_ICLOUD_ROOT || DEFAULT_ICLOUD_OUTPUT_ROOT, 'iCloud 成品根目录'),
    fallback_root: assertAbsoluteRoot(fallbackRoot || process.env.DSH_OUTPUT_FALLBACK_ROOT || DEFAULT_WORKSPACE_OUTPUT_ROOT, '工作区成品根目录'),
    quota_codes: [4354, -1003],
    server_unreachable_codes: [4355, -1004],
  }
}
