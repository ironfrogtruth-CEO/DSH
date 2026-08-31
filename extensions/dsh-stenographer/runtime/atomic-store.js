import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { invalid, notFound } from './errors.js'

export const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
export const SAFE_MEDIA_ID_RE = /^m-[0-9a-f-]{16,80}$/
export const SAFE_SEQ_RE = /^(?:0|[1-9][0-9]{0,15})$/

export function assertSafeId(id, label = '会话 ID') {
  if (typeof id !== 'string' || !SAFE_ID_RE.test(id)) {
    throw invalid('INVALID_SESSION_ID', `${label}格式无效`)
  }
  return id
}

export function assertSafeMediaId(id) {
  if (typeof id !== 'string' || !SAFE_MEDIA_ID_RE.test(id)) {
    throw invalid('INVALID_MEDIA_ID', '媒体 ID 格式无效')
  }
  return id
}

export function safeJoin(root, ...parts) {
  if (!isAbsolute(root)) throw new Error('存储根目录必须是绝对路径')
  const resolvedRoot = resolve(root)
  const target = resolve(resolvedRoot, ...parts)
  const rel = relative(resolvedRoot, target)
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw invalid('PATH_OUTSIDE_STORAGE', '路径超出速记员存储目录')
  }
  return target
}

export async function ensurePrivateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`不是安全目录: ${path}`)
  await chmod(path, 0o700)
  return path
}

export async function ensurePrivateFile(path) {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`不是安全文件: ${path}`)
  await chmod(path, 0o600)
  return path
}

export async function readJson(path, { missing = false, maxBytes = 4 * 1024 * 1024 } = {}) {
  let raw
  try {
    raw = await readFile(path)
  } catch (error) {
    if (missing && error?.code === 'ENOENT') return null
    throw error
  }
  if (raw.byteLength > maxBytes) throw new Error(`JSON 文件超过 ${maxBytes} 字节`)
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`不是安全 JSON 文件: ${path}`)
  await chmod(path, 0o600)
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch (error) {
    error.code = 'INVALID_JSON_FILE'
    throw error
  }
}

export async function writeAtomic(path, data, { mode = 0o600 } = {}) {
  await ensurePrivateDir(dirname(path))
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
  let handle
  try {
    handle = await open(temp, 'wx', mode)
    await handle.writeFile(buffer)
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temp, path)
    await chmod(path, mode)
  } finally {
    try { await handle?.close() } catch { /* best effort */ }
    try {
      const info = await lstat(temp)
      if (info.isFile() && !info.isSymbolicLink()) {
        const { unlink } = await import('node:fs/promises')
        await unlink(temp)
      }
    } catch { /* no temp file remains */ }
  }
  return path
}

export async function writeJsonAtomic(path, value) {
  return writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

export async function writeTextAtomic(path, value) {
  return writeAtomic(path, value, { mode: 0o600 })
}

export async function appendBytes(path, buffer) {
  await ensurePrivateDir(dirname(path))
  let info
  try { info = await lstat(path) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  if (info && (info.isSymbolicLink() || !info.isFile())) throw new Error(`不是安全音频文件: ${path}`)
  const handle = await open(path, 'a', 0o600)
  try {
    await handle.writeFile(buffer)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(path, 0o600)
  return path
}

export async function appendLine(path, value) {
  return appendBytes(path, Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'))
}

export async function listPrivateDirectories(root) {
  await ensurePrivateDir(root)
  const entries = await readdir(root, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && SAFE_ID_RE.test(entry.name))
    .map((entry) => entry.name)
}

export async function fileSha256(path) {
  const data = await readFile(path)
  return createHash('sha256').update(data).digest('hex')
}

export function bytesToSha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

export async function pathExists(path) {
  try {
    const info = await lstat(path)
    return !info.isSymbolicLink()
  } catch { return false }
}

export async function requireSessionDir(root, id) {
  assertSafeId(id)
  const dir = safeJoin(root, id)
  let info
  try { info = await lstat(dir) } catch (error) {
    if (error?.code === 'ENOENT') throw notFound('SESSION_NOT_FOUND', '速记会话不存在')
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw notFound('SESSION_NOT_FOUND', '速记会话不存在')
  await chmod(dir, 0o700)
  return dir
}

export async function requireFile(path, message = '文件不存在') {
  let info
  try { info = await lstat(path) } catch (error) {
    if (error?.code === 'ENOENT') throw notFound('FILE_NOT_FOUND', message)
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink()) throw notFound('FILE_NOT_FOUND', message)
  await chmod(path, 0o600)
  return path
}

export async function fileStats(path) {
  const info = await stat(path)
  return { bytes: info.size, mtimeMs: info.mtimeMs }
}
