import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'

import {
  API_BASE_PATH,
  AUDIO_SOURCES,
  BYTES_PER_SAMPLE,
  CHANNELS,
  DEFAULT_MODEL_BINDING,
  IMAGE_MIME_TYPES,
  LIVE_WINDOW_BYTES,
  MAX_AUDIO_CHUNK_BYTES,
  MAX_CREATE_BODY_BYTES,
  MAX_DOCUMENT_BLOCKS,
  MAX_EXTRA_INSTRUCTIONS_CHARS,
  MAX_GENERATED_ARTIFACT_CHARS,
  MAX_HANDOFF_BODY_BYTES,
  MAX_JSON_BODY_BYTES,
  MAX_MEDIA_BODY_BYTES,
  MAX_MEDIA_BYTES,
  MAX_MEDIA_NAME_CHARS,
  MAX_SPEAKER_NAME_CHARS,
  MAX_STATE_BODY_BYTES,
  MAX_TEXT_CHARS,
  MODEL_ROOT,
  WRITER_API_URL,
  WRITER_GENERATION_TIMEOUT_MS,
  PURPOSES,
  SAMPLE_RATE,
  SESSION_SOURCES,
  SESSION_STATES,
  STORAGE_ROOT,
} from './constants.js'
import {
  appendBytes,
  appendLine,
  assertSafeId,
  assertSafeMediaId,
  bytesToSha256,
  ensurePrivateDir,
  fileSha256,
  listPrivateDirectories,
  readJson,
  requireFile,
  requireSessionDir,
  safeJoin,
  writeAtomic,
  writeJsonAtomic,
  writeTextAtomic,
} from './atomic-store.js'
import {
  cloneJson,
  defaultDocument,
  newBlockId,
  patchDocument,
  reconcileDocument,
  renderTranscriptMarkdown,
  validateDocument,
} from './document.js'
import { conflict, errorBody, invalid, notFound, StenographerError, tooLarge, unauthorized, unavailable } from './errors.js'
import { LocalModelBackend, ModelSupervisor } from './model-supervisor.js'
import { IncrementalSpeakerCluster, normalizeVector } from './speaker-cluster.js'

const SESSION_SCHEMA = 'stenographer_session.v1'
const MANIFEST_SCHEMA = 'stenographer_manifest.v1'
const EMBEDDINGS_FILE = 'embeddings.jsonl'
const MEDIA_META_FILE = 'media.json'
const MAX_EMBEDDINGS = 100_000
const ACTIVE_STATES = new Set(['created', 'loading', 'recording', 'paused', 'interrupted'])
const FINALIZABLE_STATES = new Set(['created', 'loading', 'recording', 'paused', 'stopped', 'interrupted', 'error'])
const VALID_NATIVE_STATES = new Set(['recording', 'paused', 'stopped', 'interrupted', 'error'])
const HEADER_NAME_RE = /^[^/\\\x00-\x1f\x7f]+$/

function nowIso(now = () => Date.now()) {
  return new Date(now()).toISOString()
}

function text(value) {
  return String(value ?? '')
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function randomToken() {
  return randomBytes(32).toString('base64url')
}

function header(req, name) {
  const headers = req?.headers || {}
  const value = headers[name.toLowerCase()] ?? headers[name]
  return Array.isArray(value) ? value[0] : value
}

function contentType(req) {
  return text(header(req, 'content-type')).split(';', 1)[0].trim().toLowerCase()
}

function isJsonMime(req) {
  return contentType(req) === 'application/json'
}

async function readRequestBody(req, maxBytes) {
  const declared = header(req, 'content-length')
  if (declared !== undefined && (!/^\d+$/.test(text(declared)) || Number(declared) > maxBytes)) {
    throw tooLarge('REQUEST_BODY_TOO_LARGE', '请求体超过速记员限制', { maxBytes })
  }
  if (req && Object.prototype.hasOwnProperty.call(req, 'body')) {
    const value = req.body
    if (Buffer.isBuffer(value)) {
      if (value.byteLength > maxBytes) throw tooLarge('REQUEST_BODY_TOO_LARGE', '请求体超过速记员限制', { maxBytes })
      return value
    }
    if (typeof value === 'string') {
      const result = Buffer.from(value, 'utf8')
      if (result.byteLength > maxBytes) throw tooLarge('REQUEST_BODY_TOO_LARGE', '请求体超过速记员限制', { maxBytes })
      return result
    }
    if (value === undefined || value === null) return Buffer.alloc(0)
    const result = Buffer.from(JSON.stringify(value), 'utf8')
    if (result.byteLength > maxBytes) throw tooLarge('REQUEST_BODY_TOO_LARGE', '请求体超过速记员限制', { maxBytes })
    return result
  }
  if (!req) return Buffer.alloc(0)
  if (typeof req[Symbol.asyncIterator] === 'function') {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += value.byteLength
      if (total > maxBytes) throw tooLarge('REQUEST_BODY_TOO_LARGE', '请求体超过速记员限制', { maxBytes })
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  }
  if (typeof req.on === 'function') {
    return new Promise((resolve, reject) => {
      const chunks = []
      let total = 0
      req.on('data', (chunk) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += value.byteLength
        if (total > maxBytes) {
          reject(tooLarge('REQUEST_BODY_TOO_LARGE', '请求体超过速记员限制', { maxBytes }))
          req.destroy?.()
          return
        }
        chunks.push(value)
      })
      req.on('error', reject)
      req.on('end', () => resolve(Buffer.concat(chunks)))
    })
  }
  return Buffer.alloc(0)
}

async function readJsonBody(req, maxBytes) {
  if (!isJsonMime(req)) throw invalid('INVALID_CONTENT_TYPE', 'JSON 请求必须使用 application/json')
  const body = await readRequestBody(req, maxBytes)
  if (body.byteLength === 0) throw invalid('INVALID_JSON_BODY', '请求体不能为空')
  let value
  try { value = JSON.parse(body.toString('utf8')) } catch { throw invalid('INVALID_JSON_BODY', '请求体不是有效 JSON') }
  if (!isObject(value)) throw invalid('INVALID_JSON_BODY', '请求体必须是 JSON 对象')
  return value
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value)
  if (typeof res?.writeHead === 'function') {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    })
  }
  res?.end?.(body)
}

function sendBinary(res, status, buffer, mime) {
  res.writeHead(status, {
    'Content-Type': mime,
    'Content-Length': String(buffer.byteLength),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(buffer)
}

function ok(payload = {}) {
  return { ok: true, ...payload }
}

function parsePath(req) {
  let url
  try { url = new URL(req?.url || '/', 'http://127.0.0.1') } catch { throw invalid('INVALID_PATH', '请求路径无效') }
  const raw = url.pathname
  const pieces = raw.split('/').filter(Boolean)
  const decoded = []
  for (const piece of pieces) {
    let value
    try { value = decodeURIComponent(piece) } catch { throw invalid('INVALID_PATH', '请求路径编码无效') }
    if (!value || value.includes('/') || value.includes('\\') || value.includes('\x00')) throw invalid('INVALID_PATH', '请求路径包含非法片段')
    decoded.push(value)
  }
  return { url, pieces: decoded }
}

function pathMatches(pieces, expected) {
  return pieces.length === expected.length && pieces.every((item, index) => item === expected[index])
}

function parseRevision(value, label = 'baseRevision') {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid('INVALID_REVISION', `${label} 必须是非负整数`)
  return value
}

function parseExpectedSpeakers(value) {
  if (value === undefined || value === 'auto') return 'auto'
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) throw invalid('INVALID_EXPECTED_SPEAKERS', '预计说话人数必须是 auto 或 1 至 64 的整数')
  return value
}

function validateTitle(value) {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > 180 || /[\x00-\x1f]/.test(value)) throw invalid('INVALID_TITLE', '标题格式无效')
  return value.trim()
}

function validateSource(value) {
  if (!SESSION_SOURCES.includes(value)) throw invalid('INVALID_SOURCE', '录音来源必须是 microphone、system 或 both')
  return value
}

function validateName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MEDIA_NAME_CHARS || !HEADER_NAME_RE.test(value) || value === '.' || value === '..') {
    throw invalid('INVALID_MEDIA_NAME', '媒体文件名格式无效')
  }
  return value
}

function validateCapturedAt(value) {
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) throw invalid('INVALID_CAPTURE_TIME', 'capturedAtMs 必须是毫秒整数')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw invalid('INVALID_CAPTURE_TIME', 'capturedAtMs 超出范围')
  return parsed
}

function parseAudioQuery(url) {
  const source = url.searchParams.get('source')
  const seqText = url.searchParams.get('seq')
  const capturedAtText = url.searchParams.get('capturedAtMs')
  if (!AUDIO_SOURCES.includes(source)) throw invalid('INVALID_AUDIO_SOURCE', '音频 source 无效')
  if (seqText === null || !/^(?:0|[1-9]\d{0,15})$/.test(seqText)) throw invalid('INVALID_AUDIO_SEQ', '音频 seq 必须是从 0 开始的整数')
  const seq = Number(seqText)
  if (!Number.isSafeInteger(seq)) throw invalid('INVALID_AUDIO_SEQ', '音频 seq 超出范围')
  const capturedAtMs = capturedAtText === null ? Date.now() : validateCapturedAt(capturedAtText)
  return { source, seq, capturedAtMs }
}

function normalizeStateError(value) {
  if (value === undefined) return null
  if (!isObject(value)) throw invalid('INVALID_STATE_ERROR', '录音错误必须是对象')
  const code = text(value.code || 'NATIVE_ERROR').slice(0, 120)
  const message = text(value.message || '原生录音错误').slice(0, 500)
  return { code, message }
}

function durationFromAudio(session) {
  const durations = Object.values(session.audio?.sources || {}).map((item) => (
    Math.floor(Number(item.bytes || 0) / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE) * 1000)
  ))
  return durations.length ? Math.max(...durations) : 0
}

function sourceDurationFromAudio(session, source) {
  const bytes = Number(session.audio?.sources?.[source]?.bytes || 0)
  return Math.floor(bytes / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE) * 1000)
}

function statusError(error, fallbackCode = 'INTERNAL_ERROR') {
  const code = text(error?.code || fallbackCode).replace(/[^A-Za-z0-9_:-]/g, '_').slice(0, 80) || fallbackCode
  return { code, message: text(error?.message || error || '速记员处理失败').slice(0, 500) }
}

function wavHeader(dataBytes, sampleRate = SAMPLE_RATE, channels = CHANNELS, bits = 16) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * bits / 8, 28)
  header.writeUInt16LE(channels * bits / 8, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  return header
}

function asWav(pcm) {
  return Buffer.concat([wavHeader(pcm.byteLength), pcm])
}

function pcmRms(pcm, start = 0, end = pcm.byteLength) {
  let sum = 0
  let count = 0
  for (let offset = Math.max(0, start); offset + 1 < Math.min(end, pcm.byteLength); offset += BYTES_PER_SAMPLE) {
    const value = pcm.readInt16LE(offset) / 32768
    sum += value * value
    count += 1
  }
  return Math.sqrt(sum / Math.max(1, count))
}

// Deterministic local VAD for the production Whisper path. It derives an
// adaptive threshold from the recording noise floor, joins short pauses and
// adds context padding. This prevents silence hallucinations without a cloud
// service or another runtime dependency.
function detectSpeechRegions(pcm) {
  const frameMs = 20
  const frameBytes = Math.floor(SAMPLE_RATE * frameMs / 1000) * BYTES_PER_SAMPLE
  if (pcm.byteLength < frameBytes) return []
  const levels = []
  for (let start = 0; start + frameBytes <= pcm.byteLength; start += frameBytes) levels.push(pcmRms(pcm, start, start + frameBytes))
  if (!levels.length) return []
  const sorted = [...levels].sort((left, right) => left - right)
  const noiseFloor = sorted[Math.floor((sorted.length - 1) * 0.3)] || 0
  // A recording that starts immediately with speech has no clean noise-only
  // frames; cap the adaptive threshold so real speech is not mistaken for a
  // uniformly loud noise floor.
  const threshold = Math.max(0.0045, Math.min(0.02, noiseFloor * 2.5))
  const active = levels.map((value) => value >= threshold)
  const maxGapFrames = Math.round(500 / frameMs)
  const padFrames = Math.round(200 / frameMs)
  const minFrames = Math.round(300 / frameMs)
  const groups = []
  let start = -1
  let lastActive = -1
  for (let index = 0; index < active.length; index += 1) {
    if (active[index]) {
      if (start < 0) start = index
      lastActive = index
    } else if (start >= 0 && index - lastActive > maxGapFrames) {
      groups.push([start, lastActive + 1])
      start = -1
      lastActive = -1
    }
  }
  if (start >= 0) groups.push([start, lastActive + 1])
  return groups
    .map(([left, right]) => [Math.max(0, left - padFrames), Math.min(levels.length, right + padFrames)])
    .filter(([left, right]) => right - left >= minFrames)
    .map(([left, right]) => {
      const startByte = left * frameBytes
      const endByte = Math.min(pcm.byteLength, right * frameBytes)
      return {
        startByte,
        endByte,
        startMs: left * frameMs,
        endMs: Math.floor(endByte / (SAMPLE_RATE * BYTES_PER_SAMPLE) * 1000),
        rms: pcmRms(pcm, startByte, endByte),
      }
    })
}

export function compactSpeechRegions(regions, { maxGapMs = 5_000, maxSpanMs = 30_000 } = {}) {
  const compact = []
  for (const input of regions || []) {
    const region = { ...input }
    const last = compact[compact.length - 1]
    if (last && region.startMs - last.endMs <= maxGapMs && region.endMs - last.startMs <= maxSpanMs) {
      last.endByte = Math.max(last.endByte, region.endByte)
      last.endMs = Math.max(last.endMs, region.endMs)
      last.rms = Math.max(Number(last.rms || 0), Number(region.rms || 0))
    } else compact.push(region)
  }
  return compact
}

function degenerateTranscriptText(value) {
  const normalized = text(value).replace(/[\s，。！？、,.!?;；:：'"“”‘’（）()\[\]【】]/g, '')
  if (normalized.length < 12) return false
  if (/(.)\1{7,}/u.test(normalized)) return true
  const uniqueRatio = new Set([...normalized]).size / [...normalized].length
  return normalized.length >= 24 && uniqueRatio < 0.18
}

function canonicalJson(value) {
  return JSON.stringify(value)
}

function purposePrompt(purpose, customPurpose, extraInstructions) {
  const base = {
    meeting_minutes: '请根据这份本地速记整理会议纪要，保留议题、结论、分歧和待办事项，并标注负责人和截止时间（没有依据时不要臆造）。',
    report_email: '请根据这份本地速记编写一封正式、简洁的汇报邮件，先写结论，再写关键事实和需要上级决策的事项。',
    requirements_document: '请根据这份本地速记编写需求文档，明确背景、目标、用户、范围、流程、验收标准和待确认问题。',
    custom: `请根据这份本地速记完成以下用途：${customPurpose}`,
  }[purpose]
  return extraInstructions ? `${base}\n补充要求：${extraInstructions}` : base
}

function artifactTitle(purpose) {
  return {
    meeting_minutes: '会议纪要',
    report_email: '汇报邮件',
    requirements_document: '需求文档',
    custom: '速记加工结果',
  }[purpose] || '速记加工结果'
}

function generationPrompt(instruction, transcript) {
  return [
    '请直接输出可交付的完整成品，不要询问用户，不要解释任务，不要回复“已收到”或“请提供材料”。',
    '只允许使用速记原文中明确出现的事实；没有依据的负责人、截止时间、数字、结论和背景不得臆造。',
    instruction,
    '',
    '## 速记原文',
    transcript,
  ].join('\n')
}

function splitTranscript(value, maxChars = 30_000) {
  const source = text(value).trim()
  if (source.length <= maxChars) return [source]
  const chunks = []
  let offset = 0
  while (offset < source.length) {
    let end = Math.min(source.length, offset + maxChars)
    if (end < source.length) {
      const boundary = source.lastIndexOf('\n\n', end)
      if (boundary > offset + Math.floor(maxChars * 0.55)) end = boundary
    }
    chunks.push(source.slice(offset, end).trim())
    offset = end
  }
  return chunks.filter(Boolean)
}

export class StenographerService {
  constructor({
    storageRoot = STORAGE_ROOT,
    modelRoot = MODEL_ROOT,
    supervisor = null,
    backend = null,
    now = () => Date.now(),
    port = 3080,
    host = '127.0.0.1',
    logger = null,
    fetchImpl = globalThis.fetch,
    writerApiUrl = WRITER_API_URL,
    apiKeyResolver = null,
  } = {}) {
    this.storageRoot = storageRoot
    this.modelRoot = modelRoot
    this.now = now
    this.port = port
    this.host = host
    this.logger = logger
    this.fetchImpl = fetchImpl
    this.writerApiUrl = text(writerApiUrl || WRITER_API_URL)
    this.apiKeyResolver = apiKeyResolver
    this.supervisor = supervisor || new ModelSupervisor({ backend: backend || new LocalModelBackend({ modelRoot }) })
    this.sessions = new Map()
    this.locks = new Map()
    this.finalizeOperations = new Map()
    this.liveQueues = new Map()
    this.liveBuffers = new Map()
    this.readyPromise = null
    this.closed = false
  }

  async ready() {
    if (!this.readyPromise) this.readyPromise = this.#load()
    return this.readyPromise
  }

  async #load() {
    await ensurePrivateDir(this.storageRoot)
    const ids = await listPrivateDirectories(this.storageRoot)
    for (const id of ids) {
      const dir = safeJoin(this.storageRoot, id)
      try {
        const session = await readJson(safeJoin(dir, 'session.json'), { maxBytes: MAX_JSON_BODY_BYTES })
        if (!isObject(session) || session.schema !== SESSION_SCHEMA) continue
        const document = await readJson(safeJoin(dir, 'document.json'), { maxBytes: MAX_JSON_BODY_BYTES })
        session.id = id
        session.document = validateDocument(document || defaultDocument(nowIso(this.now)), { now: nowIso(this.now) })
        session.audio = session.audio || this.#emptyAudio()
        session.artifacts = Array.isArray(session.artifacts) ? session.artifacts : []
        session.audio.sources = session.audio.sources || {}
        for (const source of AUDIO_SOURCES) session.audio.sources[source] = session.audio.sources[source] || this.#emptyAudioSource()
        await this.#reconcileAudioIndex(session, dir)
        const documentRevision = Number(session.document.revision || 0)
        if (documentRevision > Number(session.revision || 0)) session.revision = documentRevision
        session.revision = Number.isSafeInteger(session.revision) && session.revision >= 0 ? session.revision : 0
        session.speakerCluster = new IncrementalSpeakerCluster({ centers: session.speakerCenters || [] })
        const embeddingRecords = await this.#readEmbeddings(dir)
        for (const record of embeddingRecords) session.speakerCluster.addPersistedSpeaker(record.speakerId, record.vector, 1)
        if (['recording', 'paused', 'loading', 'finalizing'].includes(session.state)) {
          session.state = 'interrupted'
          session.nativeState = 'interrupted'
          session.error = { code: 'HOST_RESTART_INTERRUPTED', message: '大神 Host 重启，未结束的速记已恢复为中断状态' }
          session.progress = { phase: 'interrupted', percent: 0, message: '等待继续录音或结束速记' }
          await this.#commit(session, { type: 'host_restart_recovery' })
        }
        this.sessions.set(id, session)
      } catch (error) {
        this.logger?.warn?.(`stenographer: ignore invalid session ${id}: ${text(error?.message || error)}`)
      }
    }
  }

  #emptyAudioSource() {
    return { nextSeq: 0, chunks: 0, bytes: 0, firstCapturedAtMs: null, lastCapturedAtMs: null }
  }

  #emptyAudio() {
    return { sampleRate: SAMPLE_RATE, channels: CHANNELS, format: 'pcm16le', sources: { microphone: this.#emptyAudioSource(), system: this.#emptyAudioSource() } }
  }

  async #reconcileAudioIndex(session, dir) {
    for (const source of AUDIO_SOURCES) {
      const chunkDir = safeJoin(dir, 'audio', source, 'chunks')
      await ensurePrivateDir(chunkDir)
      const entries = await readdir(chunkDir, { withFileTypes: true })
      const chunks = entries
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /^(?:0|[1-9]\d{0,15})\.pcm$/.test(entry.name))
        .map((entry) => Number(entry.name.slice(0, -4)))
        .sort((a, b) => a - b)
      let nextSeq = 0
      let bytes = 0
      for (const seq of chunks) {
        if (seq !== nextSeq) break
        const path = safeJoin(chunkDir, `${seq}.pcm`)
        const data = await readFile(path)
        bytes += data.byteLength
        nextSeq += 1
      }
      const info = session.audio.sources[source]
      if (info.nextSeq !== nextSeq || info.bytes !== bytes || info.chunks !== nextSeq) {
        info.nextSeq = nextSeq
        info.bytes = bytes
        info.chunks = nextSeq
        await writeJsonAtomic(safeJoin(dir, 'session.json'), this.#serializableSession(session))
      }
      const aggregatePath = safeJoin(dir, 'audio', `${source}.pcm`)
      let aggregate = Buffer.alloc(0)
      try { aggregate = await readFile(aggregatePath) } catch (error) { if (error?.code !== 'ENOENT') throw error }
      if (aggregate.byteLength !== bytes) {
        const pieces = []
        for (let seq = 0; seq < nextSeq; seq += 1) pieces.push(await readFile(safeJoin(chunkDir, `${seq}.pcm`)))
        await writeAtomic(aggregatePath, Buffer.concat(pieces), { mode: 0o600 })
      }
    }
  }

  #sessionDir(id) {
    assertSafeId(id)
    return safeJoin(this.storageRoot, id)
  }

  async #getSession(id) {
    await this.ready()
    const safeId = assertSafeId(id)
    const session = this.sessions.get(safeId)
    if (!session) throw notFound('SESSION_NOT_FOUND', '速记会话不存在')
    return session
  }

  async #waitForCommittedState(id) {
    const pending = this.locks.get(id)
    if (pending) await pending.catch(() => {})
  }

  #withLock(id, task) {
    const previous = this.locks.get(id) || Promise.resolve()
    const current = previous.catch(() => {}).then(task)
    const tracked = current.catch(() => {}).finally(() => {
      if (this.locks.get(id) === tracked) this.locks.delete(id)
    })
    this.locks.set(id, tracked)
    return current
  }

  async #commit(session, event, { revision = true } = {}) {
    if (revision) session.revision = Number(session.revision || 0) + 1
    session.updatedAt = nowIso(this.now)
    session.document.revision = Math.max(Number(session.document.revision || 0), Number(session.revision || 0))
    session.document.updatedAt = session.updatedAt
    const dir = this.#sessionDir(session.id)
    await writeJsonAtomic(safeJoin(dir, 'document.json'), session.document)
    await writeJsonAtomic(safeJoin(dir, 'session.json'), this.#serializableSession(session))
    await appendLine(safeJoin(dir, 'events.jsonl'), { revision: session.revision, at: session.updatedAt, ...event })
  }

  #serializableSession(session) {
    const out = { ...session }
    delete out.document
    delete out.speakerCluster
    return deepClone(out)
  }

  #authToken(req, session) {
    const bearer = text(header(req, 'authorization'))
    const supplied = text(header(req, 'x-stenographer-token'))
      || text(header(req, 'x-stenographer-upload-token'))
      || (bearer.startsWith('Bearer ') ? bearer.slice(7).trim() : '')
    if (!supplied) throw unauthorized('UPLOAD_TOKEN_REQUIRED', '缺少速记员上传凭证')
    const expected = Buffer.from(text(session.uploadTokenHash || ''), 'hex')
    const actual = Buffer.from(tokenHash(supplied), 'hex')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw unauthorized('UPLOAD_TOKEN_INVALID')
  }

  async #snapshot(session) {
    const durationMs = durationFromAudio(session)
    const health = await this.supervisor.health()
    const speakerNames = session.document.speakerNames || {}
    const speakers = session.speakerCluster?.speakerSummary(speakerNames) || []
    return {
      id: session.id,
      title: session.title,
      state: session.state,
      revision: session.revision,
      source: session.source,
      expectedSpeakers: session.expectedSpeakers,
      language: session.language,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      endedAt: session.endedAt,
      durationMs,
      progress: deepClone(session.progress || { phase: 'idle', percent: 0 }),
      error: deepClone(session.error || null),
      nativeState: session.nativeState,
      models: deepClone(health),
      speakers,
      document: deepClone(session.document),
      artifacts: deepClone(Array.isArray(session.artifacts) ? session.artifacts : []),
    }
  }

  async #summary(session) {
    const snapshot = await this.#snapshot(session)
    return {
      id: snapshot.id,
      title: snapshot.title,
      state: snapshot.state,
      revision: snapshot.revision,
      source: snapshot.source,
      expectedSpeakers: snapshot.expectedSpeakers,
      language: snapshot.language,
      startedAt: snapshot.startedAt,
      updatedAt: snapshot.updatedAt,
      endedAt: snapshot.endedAt,
      durationMs: snapshot.durationMs,
      progress: snapshot.progress,
      error: snapshot.error,
      speakers: snapshot.speakers,
    }
  }

  async health() {
    try {
      await this.ready()
      const models = await this.supervisor.health()
      return ok({
        service: 'dsh-stenographer',
        storageRoot: this.storageRoot,
        modelRoot: this.modelRoot,
        offlineOnly: false,
        audioOfflineOnly: true,
        writer: { provider: DEFAULT_MODEL_BINDING.provider, model: DEFAULT_MODEL_BINDING.model, transcriptTextOnly: true },
        paidApiFallback: false,
        models,
        binding: this.supervisor.binding?.() || { ...DEFAULT_MODEL_BINDING },
      })
    } catch (error) {
      return ok({ service: 'dsh-stenographer', offlineOnly: false, audioOfflineOnly: true, writer: { provider: DEFAULT_MODEL_BINDING.provider, model: DEFAULT_MODEL_BINDING.model, transcriptTextOnly: true }, paidApiFallback: false, ready: false, error: statusError(error) })
    }
  }

  async listSessions() {
    await this.ready()
    const values = []
    for (const session of this.sessions.values()) {
      await this.#waitForCommittedState(session.id)
      values.push(await this.#summary(session))
    }
    values.sort((a, b) => text(b.updatedAt).localeCompare(text(a.updatedAt)) || a.id.localeCompare(b.id))
    return ok({ sessions: values })
  }

  async createSession(req) {
    const body = await readJsonBody(req, MAX_CREATE_BODY_BYTES)
    const source = validateSource(body.source)
    const expectedSpeakers = parseExpectedSpeakers(body.expectedSpeakers)
    const language = body.language === undefined ? 'zh-CN' : body.language
    if (language !== 'zh-CN') throw invalid('INVALID_LANGUAGE', '速记员当前只支持 zh-CN')
    const title = validateTitle(body.title)
    await this.ready()
    let id
    do { id = `st-${Date.now().toString(36)}-${randomUUID().replaceAll('-', '').slice(0, 16)}` } while (this.sessions.has(id))
    const dir = this.#sessionDir(id)
    await ensurePrivateDir(dir)
    for (const sub of ['audio/microphone/chunks', 'audio/system/chunks', 'media', 'handoff', 'artifacts']) await ensurePrivateDir(safeJoin(dir, sub))
    const token = randomToken()
    const at = nowIso(this.now)
    const session = {
      schema: SESSION_SCHEMA,
      id,
      title,
      state: 'created',
      revision: 0,
      source,
      expectedSpeakers,
      language,
      startedAt: null,
      updatedAt: at,
      endedAt: null,
      nativeState: 'created',
      progress: { phase: 'created', percent: 0 },
      error: null,
      models: await this.supervisor.health(),
      audio: this.#emptyAudio(),
      uploadTokenHash: tokenHash(token),
      speakerCenters: [],
      artifacts: [],
      document: defaultDocument(at),
    }
    session.speakerCluster = new IncrementalSpeakerCluster()
    await writeJsonAtomic(safeJoin(dir, 'document.json'), session.document)
    await writeJsonAtomic(safeJoin(dir, 'session.json'), this.#serializableSession(session))
    await writeJsonAtomic(safeJoin(dir, 'manifest.json'), this.#initialManifest(session))
    await writeAtomic(safeJoin(dir, EMBEDDINGS_FILE), '', { mode: 0o600 })
    await appendLine(safeJoin(dir, 'events.jsonl'), { revision: 0, at, type: 'session_created', source, expectedSpeakers, language })
    this.sessions.set(id, session)
    const snapshot = await this.#snapshot(session)
    return { status: 201, payload: ok({
      session: snapshot,
      upload: {
        url: `http://127.0.0.1:${Number(this.port) || 3080}${API_BASE_PATH}/sessions/${encodeURIComponent(id)}/audio`,
        token,
        sampleRate: SAMPLE_RATE,
      },
    }) }
  }

  #initialManifest(session) {
    const dir = this.#sessionDir(session.id)
    return {
      schema: MANIFEST_SCHEMA,
      sessionId: session.id,
      state: session.state,
      revision: session.revision,
      createdAt: session.updatedAt,
      storageRoot: dir,
      modelBinding: session.models,
      audio: { sampleRate: SAMPLE_RATE, channels: CHANNELS, format: 'pcm16le', sources: {} },
      documentPath: safeJoin(dir, 'document.json'),
      transcriptPath: safeJoin(dir, 'transcript.md'),
      manifestPath: safeJoin(dir, 'manifest.json'),
      handoffs: [],
      paidApiFallback: false,
    }
  }

  async readSession(id) {
    await this.#waitForCommittedState(id)
    const session = await this.#getSession(id)
    return ok({ session: await this.#snapshot(session) })
  }

  async patchDocument(req, id) {
    const session = await this.#getSession(id)
    this.#authToken(req, session)
    const body = await readJsonBody(req, MAX_JSON_BODY_BYTES)
    const baseRevision = parseRevision(body.baseRevision)
    return this.#withLock(session.id, async () => {
      if (baseRevision !== session.revision) throw conflict('REVISION_CONFLICT', '文档已被其他操作更新，请重新读取后再保存', { currentRevision: session.revision })
      const nextDocument = patchDocument(session.document, body, { now: nowIso(this.now) })
      if (nextDocument.blocks.length > MAX_DOCUMENT_BLOCKS) throw invalid('INVALID_DOCUMENT', '文档块数量超过限制')
      for (const block of nextDocument.blocks) {
        if (block.type === 'image') await this.#requireMedia(session, block.mediaId)
      }
      session.document = nextDocument
      await this.#commit(session, { type: 'document_patched', blockCount: nextDocument.blocks.length })
      return ok({ session: await this.#snapshot(session) })
    })
  }

  async #requireMedia(session, mediaId) {
    assertSafeMediaId(mediaId)
    const dir = this.#sessionDir(session.id)
    const metadata = await readJson(safeJoin(dir, 'media', `${mediaId}.json`), { maxBytes: 32 * 1024, missing: true })
    if (!metadata || metadata.id !== mediaId || !Object.prototype.hasOwnProperty.call(IMAGE_MIME_TYPES, metadata.mimeType)) throw invalid('MEDIA_NOT_FOUND', '图片媒体不存在或不属于当前速记')
    // Never trust a path supplied by a persisted metadata file. Reconstruct it
    // from the validated media id and MIME suffix so corrupted metadata cannot
    // turn the preview route into a file read outside this session.
    const expectedPath = safeJoin(dir, 'media', `${mediaId}.${IMAGE_MIME_TYPES[metadata.mimeType]}`)
    return { ...metadata, path: expectedPath }
  }

  async uploadMedia(req, id) {
    const session = await this.#getSession(id)
    this.#authToken(req, session)
    const body = await readJsonBody(req, MAX_MEDIA_BODY_BYTES)
    const name = validateName(body.name)
    const mimeType = body.mimeType
    if (!Object.prototype.hasOwnProperty.call(IMAGE_MIME_TYPES, mimeType)) throw invalid('INVALID_MEDIA_MIME', '图片 MIME 类型不受支持')
    if (typeof body.dataBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.dataBase64)) throw invalid('INVALID_MEDIA_DATA', '图片数据必须是标准 base64')
    const buffer = Buffer.from(body.dataBase64, 'base64')
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_MEDIA_BYTES) throw tooLarge('MEDIA_TOO_LARGE', '图片超过 8 MB 限制', { maxBytes: MAX_MEDIA_BYTES })
    const mediaId = `m-${randomUUID()}`
    const dir = this.#sessionDir(session.id)
    const ext = IMAGE_MIME_TYPES[mimeType]
    const path = safeJoin(dir, 'media', `${mediaId}.${ext}`)
    await writeAtomic(path, buffer, { mode: 0o600 })
    const metadata = { id: mediaId, name, mimeType, size: buffer.byteLength, path, createdAt: nowIso(this.now) }
    await writeJsonAtomic(safeJoin(dir, 'media', `${mediaId}.json`), metadata)
    await appendLine(safeJoin(dir, 'events.jsonl'), { revision: session.revision, at: metadata.createdAt, type: 'media_uploaded', mediaId, size: buffer.byteLength })
    return ok({ media: { id: mediaId, url: `http://127.0.0.1:${Number(this.port) || 3080}${API_BASE_PATH}/sessions/${encodeURIComponent(session.id)}/media/${encodeURIComponent(mediaId)}`, name, mimeType, size: buffer.byteLength } })
  }

  async readMedia(res, id, mediaId) {
    const session = await this.#getSession(id)
    const metadata = await this.#requireMedia(session, mediaId)
    const path = await requireFile(metadata.path, '图片媒体不存在')
    const data = await readFile(path)
    sendBinary(res, 200, data, metadata.mimeType)
    return null
  }

  async appendAudio(req, id, url) {
    const session = await this.#getSession(id)
    this.#authToken(req, session)
    if (!['application/octet-stream'].includes(contentType(req))) throw invalid('INVALID_CONTENT_TYPE', '音频必须使用 application/octet-stream')
    const query = parseAudioQuery(url)
    if ((session.source === 'microphone' && query.source !== 'microphone') || (session.source === 'system' && query.source !== 'system')) throw conflict('SOURCE_NOT_ENABLED', '当前速记没有启用该音频来源')
    const body = await readRequestBody(req, MAX_AUDIO_CHUNK_BYTES)
    if (body.byteLength === 0 || body.byteLength % (BYTES_PER_SAMPLE * CHANNELS) !== 0) throw invalid('INVALID_AUDIO_PCM', '音频必须是非空、偶数字节的 PCM16')
    const result = await this.#withLock(session.id, async () => {
      if (!ACTIVE_STATES.has(session.state)) throw conflict('AUDIO_NOT_ACCEPTED', `当前状态 ${session.state} 不接受音频`)
      const sourceInfo = session.audio.sources[query.source] || this.#emptyAudioSource()
      const expected = Number(sourceInfo.nextSeq || 0)
      if (query.seq < expected) throw conflict('AUDIO_SEQ_DUPLICATE', '音频 seq 已经写入，重复块被拒绝', { source: query.source, seq: query.seq, expectedSeq: expected })
      if (query.seq > expected) throw conflict('AUDIO_SEQ_OUT_OF_ORDER', '音频 seq 乱序，缺少前置块', { source: query.source, seq: query.seq, expectedSeq: expected })
      const dir = this.#sessionDir(session.id)
      const chunkPath = safeJoin(dir, 'audio', query.source, 'chunks', `${query.seq}.pcm`)
      let exists = false
      try { await readFile(chunkPath); exists = true } catch (error) { if (error?.code !== 'ENOENT') throw error }
      if (exists) throw conflict('AUDIO_SEQ_DUPLICATE', '音频 seq 已经写入，重复块被拒绝', { source: query.source, seq: query.seq, expectedSeq: expected })
      await writeAtomic(chunkPath, body, { mode: 0o600 })
      await appendBytes(safeJoin(dir, 'audio', `${query.source}.pcm`), body)
      sourceInfo.nextSeq = query.seq + 1
      sourceInfo.chunks = Number(sourceInfo.chunks || 0) + 1
      sourceInfo.bytes = Number(sourceInfo.bytes || 0) + body.byteLength
      sourceInfo.firstCapturedAtMs ??= query.capturedAtMs
      sourceInfo.lastCapturedAtMs = query.capturedAtMs
      session.audio.sources[query.source] = sourceInfo
      await this.#commit(session, { type: 'audio_appended', source: query.source, seq: query.seq, bytes: body.byteLength, capturedAtMs: query.capturedAtMs })
      return ok({ accepted: true, source: query.source, seq: query.seq, revision: session.revision })
    })
    this.#scheduleLive(session.id, query.source, body).catch((error) => this.logger?.warn?.(`stenographer live inference: ${text(error?.message || error)}`))
    return result
  }

  #scheduleLive(sessionId, source, body) {
    const key = `${sessionId}:${source}`
    const prior = this.liveQueues.get(key) || Promise.resolve()
    const next = prior.catch(() => {}).then(async () => {
      const existing = this.liveBuffers.get(key) || Buffer.alloc(0)
      const combined = Buffer.concat([existing, body])
      let offset = 0
      while (combined.byteLength - offset >= LIVE_WINDOW_BYTES) {
        const window = combined.subarray(offset, offset + LIVE_WINDOW_BYTES)
        await this.#processLiveWindow(sessionId, source, window)
        offset += LIVE_WINDOW_BYTES
      }
      this.liveBuffers.set(key, combined.subarray(offset))
    })
    this.liveQueues.set(key, next.finally(() => {
      if (this.liveQueues.get(key) === next) this.liveQueues.delete(key)
    }))
    return next
  }

  async #processLiveWindow(sessionId, source, pcm) {
    const session = await this.#getSession(sessionId)
    if (!ACTIVE_STATES.has(session.state)) return
    if (!detectSpeechRegions(pcm).length) return
    const dir = this.#sessionDir(session.id)
    const liveDir = safeJoin(dir, 'audio', 'live')
    await ensurePrivateDir(liveDir)
    const wavPath = safeJoin(liveDir, `${source}-${Date.now()}-${randomUUID()}.wav`)
    await writeAtomic(wavPath, asWav(pcm), { mode: 0o600 })
    try {
      const result = await this.supervisor.transcribe({ audioPath: wavPath, language: 'zh', source })
      const segments = this.#normalizeSegments(result, source, pcm.byteLength / (SAMPLE_RATE * BYTES_PER_SAMPLE) * 1000)
        .filter((segment) => segment.endMs - segment.startMs >= 180 && segment.confidence >= 0.08)
      if (!segments.length) return
      let vectors = []
      for (const segment of segments) {
        let vector = null
        if (source !== 'microphone') {
          try {
            const vectorResult = await this.supervisor.embed({ audioPath: wavPath, source, speakerHint: source })
            vector = normalizeVector(vectorResult?.vector || vectorResult)
          } catch (error) {
            this.logger?.warn?.(`stenographer live speaker inference: ${text(error?.message || error)}`)
          }
        }
        vectors.push(vector)
      }
      await this.#withLock(session.id, async () => {
        if (!ACTIVE_STATES.has(session.state)) return
        const audioDuration = sourceDurationFromAudio(session, source)
        const offset = Math.max(0, audioDuration - Math.floor(pcm.byteLength / (SAMPLE_RATE * BYTES_PER_SAMPLE) * 1000))
        const fresh = []
        const records = []
        for (let index = 0; index < segments.length; index += 1) {
          const segment = segments[index]
          const assigned = source === 'microphone'
            ? session.speakerCluster.assign(vectors[index], { forceSpeakerId: 'speaker-local' })
            : session.speakerCluster.assign(vectors[index], { source })
          const startMs = offset + segment.startMs
          const endMs = offset + segment.endMs
          const block = {
            type: 'transcript', id: newBlockId('t'), speakerId: assigned.speakerId,
            startMs, endMs, rawText: segment.text, text: segment.text, isFinal: false,
            userEdited: false, confidence: Math.min(segment.confidence, assigned.confidence), source,
            lineage: assigned.lineage, uncertain: assigned.uncertain,
          }
          fresh.push(block)
          records.push({ id: `emb-${randomUUID()}`, source, startMs, endMs, vector: vectors[index], speakerId: assigned.speakerId, lineage: assigned.lineage, confidence: assigned.confidence, createdAt: nowIso(this.now) })
        }
        // Live inference only appends new transcript blocks. Passing the whole
        // existing document into reconcileDocument would treat user text/image
        // blocks as fresh model segments and duplicate them on every window.
        session.document = validateDocument({
          ...session.document,
          blocks: [...session.document.blocks, ...fresh],
          updatedAt: nowIso(this.now),
        }, { now: nowIso(this.now) })
        await this.#writeEmbeddings(session, records)
        session.speakerCenters = session.speakerCluster.stableCenters()
        session.progress = { phase: 'recording', percent: 0, message: '正在实时转写' }
        await this.#commit(session, { type: 'live_transcript', count: fresh.length })
      })
    } finally {
      try { await unlink(wavPath) } catch { /* live scratch is disposable */ }
    }
  }

  #normalizeSegments(result, source, durationMs) {
    const raw = Array.isArray(result?.segments) ? result.segments : []
    return raw.map((item) => {
      const startMs = Math.max(0, Math.min(durationMs, Number.isFinite(item.startMs) ? Math.floor(item.startMs) : 0))
      const endMs = Math.max(startMs, Math.min(durationMs, Number.isFinite(item.endMs) ? Math.floor(item.endMs) : durationMs))
      const segmentText = text(item.text).trim().slice(0, MAX_TEXT_CHARS)
      const confidence = Number.isFinite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : 0.5
      return { ...item, source, startMs, endMs, text: segmentText, confidence }
    }).filter((item) => item.text && !degenerateTranscriptText(item.text) && !(Number.isFinite(item.compressionRatio) && item.compressionRatio > 2.4))
  }

  async #writeEmbeddings(session, records, { replace = false } = {}) {
    const dir = this.#sessionDir(session.id)
    const current = replace ? [] : await this.#readEmbeddings(dir)
    const merged = [...current, ...(records || [])].slice(-MAX_EMBEDDINGS)
    await writeTextAtomic(safeJoin(dir, EMBEDDINGS_FILE), `${merged.map((item) => JSON.stringify(item)).join('\n')}${merged.length ? '\n' : ''}`)
  }

  async #readEmbeddings(dir) {
    let raw
    try { raw = await readFile(safeJoin(dir, EMBEDDINGS_FILE), 'utf8') } catch (error) { if (error?.code === 'ENOENT') return []; throw error }
    const records = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const item = JSON.parse(line)
        if (isObject(item) && normalizeVector(item.vector)) records.push(item)
      } catch { /* retain session, ignore one corrupt journal line */ }
    }
    return records.slice(-MAX_EMBEDDINGS)
  }

  async updateState(req, id) {
    const session = await this.#getSession(id)
    this.#authToken(req, session)
    const body = await readJsonBody(req, MAX_STATE_BODY_BYTES)
    if (!VALID_NATIVE_STATES.has(body.state)) throw invalid('INVALID_NATIVE_STATE', '录音状态无效')
    const nativeError = normalizeStateError(body.error)
    return this.#withLock(session.id, async () => {
      if (session.nativeState === body.state && (body.state !== 'error' || JSON.stringify(session.error) === JSON.stringify(nativeError))) return ok({ session: await this.#snapshot(session) })
      if (body.state === 'recording') {
        if (!ACTIVE_STATES.has(session.state) && session.state !== 'stopped') throw conflict('STATE_TRANSITION_INVALID', `当前状态 ${session.state} 不能继续录音`)
        session.state = 'recording'
        session.startedAt ||= nowIso(this.now)
        session.error = null
      } else if (body.state === 'paused') {
        if (!ACTIVE_STATES.has(session.state)) throw conflict('STATE_TRANSITION_INVALID', `当前状态 ${session.state} 不能暂停`)
        session.state = 'paused'
      } else if (body.state === 'stopped') {
        if (!FINALIZABLE_STATES.has(session.state) && session.state !== 'stopped') throw conflict('STATE_TRANSITION_INVALID', `当前状态 ${session.state} 不能结束`)
        session.state = 'stopped'
        session.endedAt ||= nowIso(this.now)
      } else if (body.state === 'interrupted') {
        session.state = 'interrupted'
      } else if (body.state === 'error') {
        session.state = 'error'
        session.error = nativeError || { code: 'NATIVE_ERROR', message: '原生录音发生错误' }
      }
      session.nativeState = body.state
      await this.#commit(session, { type: 'native_state', state: body.state, error: session.error })
      return ok({ session: await this.#snapshot(session) })
    })
  }

  async finalize(req, id) {
    const session = await this.#getSession(id)
    this.#authToken(req, session)
    const body = await (isJsonMime(req) ? readJsonBody(req, MAX_STATE_BODY_BYTES) : Promise.resolve({}))
    if (body.baseRevision !== undefined) parseRevision(body.baseRevision)
    const result = await this.#withLock(session.id, async () => {
      if (session.state === 'ready') return { status: 200, payload: ok({ session: await this.#snapshot(session) }) }
      if (session.state === 'finalizing' && session.finalizeOperationId) return { status: 202, payload: ok({ session: await this.#snapshot(session) }) }
      if (body.baseRevision !== undefined && body.baseRevision !== session.revision) throw conflict('REVISION_CONFLICT', '速记内容已更新，请重新读取后再结束', { currentRevision: session.revision })
      if (!FINALIZABLE_STATES.has(session.state)) throw conflict('FINALIZE_NOT_ALLOWED', `当前状态 ${session.state} 不能结束速记`)
      const operationId = `fin-${randomUUID()}`
      session.state = 'finalizing'
      session.nativeState = 'stopped'
      session.endedAt ||= nowIso(this.now)
      session.finalizeOperationId = operationId
      session.progress = { phase: 'queued', percent: 0, operationId, message: '已排队进行最终转写' }
      session.error = null
      await this.#commit(session, { type: 'finalize_started', operationId })
      return { status: 202, payload: ok({ session: await this.#snapshot(session) }), operationId }
    })
    if (result.operationId && !this.finalizeOperations.has(session.id)) {
      const task = this.#performFinalize(session.id, result.operationId).catch((error) => this.#finalizeFailure(session.id, result.operationId, error))
      const operation = task.finally(() => {
        if (this.finalizeOperations.get(session.id) === operation) this.finalizeOperations.delete(session.id)
      })
      this.finalizeOperations.set(session.id, operation)
    }
    return result
  }

  async #performFinalize(sessionId, operationId) {
    const session = await this.#getSession(sessionId)
    const dir = this.#sessionDir(session.id)
    await this.#withLock(session.id, async () => {
      session.progress = { phase: 'reconciling_audio', percent: 5, operationId, message: '正在整理音频轨道' }
      await this.#commit(session, { type: 'finalize_progress', phase: 'reconciling_audio' })
      await this.#reconcileAudioIndex(session, dir)
    })
    const tracks = []
    for (const source of AUDIO_SOURCES) {
      const path = safeJoin(dir, 'audio', `${source}.pcm`)
      let pcm
      try { pcm = await readFile(path) } catch (error) { if (error?.code === 'ENOENT') continue; throw error }
      if (!pcm.byteLength) continue
      const wavPath = safeJoin(dir, 'audio', `final-${source}.wav`)
      await writeAtomic(wavPath, asWav(pcm), { mode: 0o600 })
      tracks.push({
        source,
        pcm,
        wavPath,
        durationMs: Math.floor(pcm.byteLength / (SAMPLE_RATE * BYTES_PER_SAMPLE) * 1000),
        firstCapturedAtMs: Number(session.audio.sources[source]?.firstCapturedAtMs || 0),
      })
    }
    const firstCaptureCandidates = tracks.map((track) => track.firstCapturedAtMs).filter((value) => value > 0)
    const sessionCaptureOriginMs = firstCaptureCandidates.length ? Math.min(...firstCaptureCandidates) : 0
    const fresh = []
    const embeddingRecords = []
    const allVectors = []
    const allAssignments = []
    for (const track of tracks) {
      await this.#withLock(session.id, async () => {
        session.progress = { phase: 'transcribing', percent: 10 + Math.floor(fresh.length / Math.max(1, tracks.length) * 45), operationId, message: `正在转写 ${track.source}` }
        await this.#commit(session, { type: 'finalize_progress', phase: 'transcribing', source: track.source })
      })
      const segments = []
      const regions = compactSpeechRegions(detectSpeechRegions(track.pcm))
      for (let regionIndex = 0; regionIndex < regions.length; regionIndex += 1) {
        const region = regions[regionIndex]
        const regionWavPath = safeJoin(dir, 'audio', `final-${track.source}-speech-${regionIndex}.wav`)
        await writeAtomic(regionWavPath, asWav(track.pcm.subarray(region.startByte, region.endByte)), { mode: 0o600 })
        const result = await this.supervisor.transcribe({ audioPath: regionWavPath, language: 'zh', source: track.source })
        const normalized = this.#normalizeSegments(result, track.source, region.endMs - region.startMs)
        for (const segment of normalized) {
          if (segment.endMs - segment.startMs < 180 || segment.confidence < 0.08) continue
          segments.push({ ...segment, startMs: region.startMs + segment.startMs, endMs: region.startMs + segment.endMs })
        }
      }
      for (const segment of segments) {
        const trackOffsetMs = sessionCaptureOriginMs && track.firstCapturedAtMs
          ? Math.max(0, track.firstCapturedAtMs - sessionCaptureOriginMs)
          : 0
        const segmentStart = Math.min(track.pcm.byteLength, Math.floor(segment.startMs / 1000 * SAMPLE_RATE) * BYTES_PER_SAMPLE)
        const segmentEnd = Math.min(track.pcm.byteLength, Math.max(segmentStart + BYTES_PER_SAMPLE, Math.floor(segment.endMs / 1000 * SAMPLE_RATE) * BYTES_PER_SAMPLE))
        const segmentWavPath = safeJoin(dir, 'audio', `final-${track.source}-${fresh.length}.wav`)
        await writeAtomic(segmentWavPath, asWav(track.pcm.subarray(segmentStart, segmentEnd)), { mode: 0o600 })
        let vector = null
        if (track.source !== 'microphone' && segment.endMs - segment.startMs >= 500) {
          try {
            const speakerResult = await this.supervisor.embed({ audioPath: segmentWavPath, source: track.source, speakerHint: track.source })
            vector = normalizeVector(speakerResult?.vector || speakerResult)
          } catch (error) {
            this.logger?.warn?.(`stenographer final speaker inference: ${text(error?.message || error)}`)
          }
        }
        const cluster = session.speakerCluster || new IncrementalSpeakerCluster()
        const assigned = track.source === 'microphone'
          ? cluster.assign(vector, { forceSpeakerId: 'speaker-local' })
          : cluster.assign(vector, { source: track.source })
        session.speakerCluster = cluster
        const block = {
          type: 'transcript', id: newBlockId('t'), speakerId: assigned.speakerId,
          startMs: trackOffsetMs + segment.startMs, endMs: trackOffsetMs + segment.endMs, rawText: segment.text, text: segment.text,
          isFinal: true, userEdited: false, confidence: Math.min(segment.confidence, assigned.confidence), source: track.source,
          lineage: assigned.lineage, uncertain: assigned.uncertain,
        }
        fresh.push(block)
        allVectors.push(vector || [])
        allAssignments.push({ block, vector, source: track.source })
        embeddingRecords.push({ id: `emb-${randomUUID()}`, source: track.source, startMs: trackOffsetMs + segment.startMs, endMs: trackOffsetMs + segment.endMs, vector, speakerId: assigned.speakerId, lineage: assigned.lineage, confidence: assigned.confidence, createdAt: nowIso(this.now) })
      }
    }
    const remoteVectorIndexes = allVectors
      .map((vector, index) => (vector?.length && allAssignments[index]?.source === 'system' ? index : -1))
      .filter((index) => index >= 0)
    if (remoteVectorIndexes.length >= 20) {
      await this.#withLock(session.id, async () => { session.progress = { phase: 'clustering', percent: 70, operationId, message: '正在重聚类说话人' }; await this.#commit(session, { type: 'finalize_progress', phase: 'clustering' }) })
      const validIndexes = remoteVectorIndexes
      const clusterResult = await this.supervisor.cluster({ vectors: validIndexes.map((index) => allVectors[index]) })
      const labels = clusterResult?.labels || []
      const centers = clusterResult?.centers || []
      const records = validIndexes.map((index) => ({ ...allAssignments[index], vector: allVectors[index] }))
      const reconciled = session.speakerCluster.reconcile(records, labels, centers)
      for (let index = 0; index < validIndexes.length; index += 1) {
        const sourceIndex = validIndexes[index]
        const assignment = reconciled[index]
        fresh[sourceIndex].speakerId = assignment.speakerId
        fresh[sourceIndex].lineage = assignment.lineage
        fresh[sourceIndex].uncertain = assignment.uncertain
        embeddingRecords[sourceIndex].speakerId = assignment.speakerId
        embeddingRecords[sourceIndex].lineage = assignment.lineage
      }
    }
    await this.#withLock(session.id, async () => {
      fresh.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.source.localeCompare(right.source))
      session.document = reconcileDocument(session.document, fresh, { now: nowIso(this.now) })
      session.speakerCenters = session.speakerCluster.stableCenters()
      await this.#writeEmbeddings(session, embeddingRecords, { replace: true })
      const mediaPaths = new Map()
      for (const block of session.document.blocks.filter((item) => item.type === 'image')) {
        try { const metadata = await this.#requireMedia(session, block.mediaId); mediaPaths.set(block.mediaId, metadata.path) } catch { /* keep media id in markdown */ }
      }
      const transcriptPath = safeJoin(dir, 'transcript.md')
      const manifestPath = safeJoin(dir, 'manifest.json')
      const transcript = renderTranscriptMarkdown(session.document, { mediaPaths, speakerNames: session.document.speakerNames })
      await writeTextAtomic(transcriptPath, transcript)
      const audioManifest = {}
      for (const source of AUDIO_SOURCES) {
        const audioPath = safeJoin(dir, 'audio', `${source}.pcm`)
        try {
          const sourceInfo = session.audio.sources[source]
          audioManifest[source] = { path: audioPath, bytes: sourceInfo.bytes, chunks: sourceInfo.chunks, sha256: await fileSha256(audioPath) }
        } catch { /* source may not be enabled or empty */ }
      }
      const finalRevision = session.revision + 1
      const manifest = {
        schema: MANIFEST_SCHEMA,
        sessionId: session.id,
        state: 'ready',
        revision: finalRevision,
        createdAt: session.updatedAt,
        finalizedAt: nowIso(this.now),
        storageRoot: dir,
        modelBinding: this.supervisor.binding?.() || { ...DEFAULT_MODEL_BINDING },
        models: await this.supervisor.health(),
        audio: { sampleRate: SAMPLE_RATE, channels: CHANNELS, format: 'pcm16le', sources: audioManifest },
        documentPath: safeJoin(dir, 'document.json'),
        transcriptPath,
        manifestPath,
        embeddingsPath: safeJoin(dir, EMBEDDINGS_FILE),
        handoffs: [],
        paidApiFallback: false,
      }
      session.state = 'ready'
      session.progress = { phase: 'complete', percent: 100, operationId, message: '速记已完成最终转写和说话人校正' }
      session.error = null
      session.finalizeOperationId = null
      session.endedAt ||= nowIso(this.now)
      session.document.revision = finalRevision
      session.document.updatedAt = nowIso(this.now)
      session.revision = finalRevision
      session.updatedAt = session.document.updatedAt
      await writeJsonAtomic(safeJoin(dir, 'document.json'), session.document)
      await writeJsonAtomic(safeJoin(dir, 'session.json'), this.#serializableSession(session))
      await writeJsonAtomic(manifestPath, manifest)
      await appendLine(safeJoin(dir, 'events.jsonl'), { revision: finalRevision, at: session.updatedAt, type: 'finalize_completed', operationId, transcriptPath, manifestPath })
    })
  }

  async #finalizeFailure(sessionId, operationId, error) {
    try {
      const session = await this.#getSession(sessionId)
      await this.#withLock(sessionId, async () => {
        // Persist a detached candidate before publishing the terminal state to
        // readers. A GET must never observe "error" while session.json still
        // contains the pre-failure "finalizing" state.
        const candidate = {
          ...session,
          document: deepClone(session.document),
          speakerCluster: session.speakerCluster,
          state: 'error',
          error: statusError(error, 'FINALIZE_FAILED'),
          finalizeOperationId: null,
        }
        candidate.progress = { phase: 'error', percent: 0, operationId, message: candidate.error.message }
        await this.#commit(candidate, { type: 'finalize_failed', operationId, error: candidate.error })
        Object.assign(session, candidate)
      })
    } catch (secondary) {
      this.logger?.error?.(`stenographer finalize failure persistence: ${text(secondary?.message || secondary)}`)
    }
  }

  async #callWriter(messages, { numPredict = 4_096 } = {}) {
    if (typeof this.fetchImpl !== 'function') throw unavailable('WRITER_UNAVAILABLE', 'GLM-5.3-Flash 接口不可用')
    const resolvedKey = typeof this.apiKeyResolver === 'function' ? await this.apiKeyResolver() : ''
    const storedValue = isObject(resolvedKey) ? resolvedKey.value : resolvedKey
    const apiKey = text(storedValue || process.env.ZHIPU_API_KEY).trim()
    if (!apiKey) throw unavailable('WRITER_CREDENTIAL_MISSING', '大神没有可用的 GLM-5.3-Flash 凭证')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WRITER_GENERATION_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(this.writerApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
        body: JSON.stringify({
          model: DEFAULT_MODEL_BINDING.model,
          stream: false,
          messages,
          thinking: { type: 'enabled' },
          reasoning_effort: 'high',
          temperature: 0.2,
          max_tokens: numPredict,
        }),
      })
      const raw = await response.text()
      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${raw.slice(0, 500)}`)
      let payload
      try { payload = JSON.parse(raw) } catch { throw new Error('本地模型返回了无效 JSON') }
      const content = text(payload?.choices?.[0]?.message?.content).trim()
      if (!content) throw new Error('GLM-5.3-Flash 没有返回正文')
      if (content.length > MAX_GENERATED_ARTIFACT_CHARS) throw new Error('GLM-5.3-Flash 返回正文超过长度限制')
      if (/^(?:i am ready|please provide|请提供|已准备好|请告诉我)/i.test(content)) throw new Error('GLM-5.3-Flash 没有执行加工任务')
      return content
    } catch (error) {
      if (error instanceof StenographerError) throw error
      if (error?.name === 'AbortError') throw unavailable('WRITER_TIMEOUT', 'GLM-5.3-Flash 生成超时，请稍后重试')
      throw unavailable('WRITER_FAILED', `GLM-5.3-Flash 生成失败：${text(error?.message || error).slice(0, 400)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  async #generateArtifact(instruction, transcript) {
    const chunks = splitTranscript(transcript)
    if (!chunks.length) throw invalid('EMPTY_TRANSCRIPT', '速记正文为空，无法生成产物')
    const system = '你是中文会议材料编辑。收到材料后直接输出完整成品，使用简体中文，忠于原文，不臆造。'
    if (chunks.length === 1) {
      const content = await this.#callWriter([
        { role: 'system', content: system },
        { role: 'user', content: generationPrompt(instruction, chunks[0]) },
      ])
      return { content, sourceMode: 'full_transcript', sourceChunks: 1 }
    }
    const summaries = []
    for (let index = 0; index < chunks.length; index += 1) {
      summaries.push(await this.#callWriter([
        { role: 'system', content: '你负责忠实提取会议事实。只提取原文明确出现的议题、观点、结论、分歧、行动项、负责人、截止时间和数字；不得补写。' },
        { role: 'user', content: `这是速记第 ${index + 1}/${chunks.length} 段。请输出结构化事实清单，不要写最终稿。\n\n${chunks[index]}` },
      ], { numPredict: 2_048 }))
    }
    const content = await this.#callWriter([
      { role: 'system', content: system },
      { role: 'user', content: generationPrompt(instruction, `以下为按原文分段提取的事实清单：\n\n${summaries.join('\n\n---\n\n')}`) },
    ])
    return { content, sourceMode: 'chunked_transcript', sourceChunks: chunks.length }
  }

  async deleteSession(req, id) {
    const session = await this.#getSession(id)
    this.#authToken(req, session)
    return this.#withLock(session.id, async () => {
      if (['loading', 'recording', 'paused', 'finalizing'].includes(session.state)) {
        throw conflict('SESSION_DELETE_ACTIVE', '正在录音或处理的速记不能删除，请先结束当前任务')
      }
      const trashRoot = safeJoin(this.storageRoot, '.trash')
      await ensurePrivateDir(trashRoot)
      const trashedAt = nowIso(this.now)
      const trashRef = `${session.id}-${Date.now()}-${randomUUID().slice(0, 8)}`
      await rename(this.#sessionDir(session.id), safeJoin(trashRoot, trashRef))
      this.sessions.delete(session.id)
      return ok({ deleted: true, id: session.id, recoverable: true, trashRef, trashedAt })
    })
  }

  async handoff(req, id) {
    const session = await this.#getSession(id)
    this.#authToken(req, session)
    const body = await readJsonBody(req, MAX_HANDOFF_BODY_BYTES)
    const baseRevision = parseRevision(body.baseRevision)
    if (!PURPOSES.includes(body.purpose)) throw invalid('INVALID_HANDOFF_PURPOSE', '加工用途无效')
    if (body.purpose === 'custom' && (typeof body.customPurpose !== 'string' || body.customPurpose.trim().length === 0 || body.customPurpose.length > MAX_TEXT_CHARS)) throw invalid('CUSTOM_PURPOSE_REQUIRED', 'custom 用途必须填写具体目的')
    const extraInstructions = body.extraInstructions === undefined ? '' : body.extraInstructions
    if (typeof extraInstructions !== 'string' || extraInstructions.length > MAX_EXTRA_INSTRUCTIONS_CHARS) throw invalid('INVALID_EXTRA_INSTRUCTIONS', '补充要求格式无效')
    return this.#withLock(session.id, async () => {
      if (baseRevision !== session.revision) throw conflict('REVISION_CONFLICT', '速记内容已更新，请重新读取后再交接', { currentRevision: session.revision })
      if (session.state !== 'ready') throw conflict('HANDOFF_NOT_READY', '速记尚未完成最终整理，暂不能交接')
      const dir = this.#sessionDir(session.id)
      const manifestPath = safeJoin(dir, 'manifest.json')
      const transcriptPath = safeJoin(dir, 'transcript.md')
      await requireFile(manifestPath, '最终 manifest 不存在')
      await requireFile(transcriptPath, '最终 transcript 不存在')
      const transcript = await readFile(transcriptPath, 'utf8')
      const snapshotRevision = session.revision
      const handoffId = `handoff-${randomUUID()}`
      const artifactId = `artifact-${randomUUID()}`
      const snapshotPath = safeJoin(dir, 'handoff', `${handoffId}.json`)
      const snapshot = {
        schema: 'stenographer_handoff_snapshot.v1',
        sessionId: session.id,
        snapshotRevision,
        purpose: body.purpose,
        customPurpose: body.customPurpose || null,
        document: cloneJson(session.document),
        transcriptPath,
        manifestPath,
        modelBinding: this.supervisor.binding?.() || { ...DEFAULT_MODEL_BINDING },
        createdAt: nowIso(this.now),
      }
      const snapshotJson = canonicalJson(snapshot)
      const sha256 = bytesToSha256(snapshotJson)
      await writeAtomic(snapshotPath, `${snapshotJson}\n`, { mode: 0o600 })
      let generated
      try {
        generated = await this.#generateArtifact(purposePrompt(body.purpose, body.customPurpose || '', extraInstructions), transcript)
      } catch (error) {
        await writeJsonAtomic(safeJoin(dir, 'artifacts', `${artifactId}.json`), {
          schema: 'stenographer_artifact.v1', id: artifactId, sessionId: session.id, purpose: body.purpose,
          title: artifactTitle(body.purpose), status: 'error', content: '', error: statusError(error), createdAt: snapshot.createdAt,
        })
        await appendLine(safeJoin(dir, 'events.jsonl'), { revision: session.revision, at: nowIso(this.now), type: 'artifact_failed', artifactId, purpose: body.purpose, error: statusError(error) })
        throw error
      }
      const artifact = {
        schema: 'stenographer_artifact.v1',
        id: artifactId,
        sessionId: session.id,
        snapshotRevision,
        purpose: body.purpose,
        title: artifactTitle(body.purpose),
        status: 'ready',
        content: generated.content,
        sourceMode: generated.sourceMode,
        sourceChunks: generated.sourceChunks,
        provider: DEFAULT_MODEL_BINDING.provider,
        model: DEFAULT_MODEL_BINDING.model,
        paidApiFallback: false,
        createdAt: snapshot.createdAt,
      }
      const conversationPrompt = [
        '以下是一份本地速记及已经生成的成品。请把它们作为后续修改的上下文；除非用户提出新要求，否则不要重新生成。',
        '', '## 已生成成品', generated.content.slice(0, 60_000),
        '', '## 速记原文', transcript.slice(0, 40_000),
      ].join('\n')
      artifact.conversationPrompt = conversationPrompt
      const handoff = {
        schema: 'stenographer_handoff.v1',
        sessionId: session.id,
        snapshotRevision,
        purpose: body.purpose,
        prompt: generationPrompt(purposePrompt(body.purpose, body.customPurpose || '', extraInstructions), transcript),
        conversationPrompt,
        artifactId,
        transcriptPath,
        manifestPath,
        sha256,
        snapshotPath,
        provider: DEFAULT_MODEL_BINDING.provider,
        model: DEFAULT_MODEL_BINDING.model,
        paidApiFallback: false,
        createdAt: snapshot.createdAt,
      }
      await writeJsonAtomic(safeJoin(dir, 'artifacts', `${artifactId}.json`), artifact)
      await writeJsonAtomic(safeJoin(dir, 'handoff', `${handoffId}.manifest.json`), handoff)
      session.artifacts = [...(Array.isArray(session.artifacts) ? session.artifacts : []), artifact].slice(-20)
      await this.#commit(session, { type: 'artifact_generated', handoffId, artifactId, purpose: body.purpose, snapshotRevision, sha256 })
      return ok({ handoff, artifact, session: await this.#snapshot(session) })
    })
  }

  async handle(req, res) {
    try {
      const { url, pieces } = parsePath(req)
      const method = text(req?.method || 'GET').toUpperCase()
      await this.ready()
      if (pathMatches(pieces, ['api', 'stenographer', 'health'])) {
        if (method !== 'GET') return sendJson(res, 405, errorBody(new StenographerError('METHOD_NOT_ALLOWED', '该接口只允许 GET', { status: 405 })), { Allow: 'GET' })
        return sendJson(res, 200, await this.health())
      }
      if (pathMatches(pieces, ['api', 'stenographer', 'sessions'])) {
        if (method === 'GET') return sendJson(res, 200, await this.listSessions())
        if (method === 'POST') {
          const result = await this.createSession(req)
          return sendJson(res, result.status, result.payload)
        }
        return sendJson(res, 405, errorBody(new StenographerError('METHOD_NOT_ALLOWED', '该接口只允许 GET 或 POST', { status: 405 })), { Allow: 'GET, POST' })
      }
      if (pieces.length >= 4 && pieces[0] === 'api' && pieces[1] === 'stenographer' && pieces[2] === 'sessions') {
        const id = assertSafeId(pieces[3])
        if (pieces.length === 4) {
          if (method === 'GET') return sendJson(res, 200, await this.readSession(id))
          if (method === 'DELETE') return sendJson(res, 200, await this.deleteSession(req, id))
          return sendJson(res, 405, errorBody(new StenographerError('METHOD_NOT_ALLOWED', '该接口只允许 GET 或 DELETE', { status: 405 })), { Allow: 'GET, DELETE' })
        }
        if (pieces.length === 6 && pieces[4] === 'media') {
          const mediaId = assertSafeMediaId(pieces[5])
          if (method !== 'GET') return sendJson(res, 405, errorBody(new StenographerError('METHOD_NOT_ALLOWED', '媒体预览只允许 GET', { status: 405 })), { Allow: 'GET' })
          return this.readMedia(res, id, mediaId)
        }
        if (pieces.length !== 5) throw notFound('ROUTE_NOT_FOUND', '速记员接口不存在')
        const operation = pieces[4]
        if (operation === 'document' && method === 'PATCH') return sendJson(res, 200, await this.patchDocument(req, id))
        if (operation === 'media' && method === 'POST') return sendJson(res, 201, await this.uploadMedia(req, id))
        if (operation === 'audio' && method === 'POST') return sendJson(res, 200, await this.appendAudio(req, id, url))
        if (operation === 'state' && method === 'POST') return sendJson(res, 200, await this.updateState(req, id))
        if (operation === 'finalize' && method === 'POST') {
          const result = await this.finalize(req, id)
          return sendJson(res, result.status, result.payload)
        }
        if (operation === 'handoff' && method === 'POST') return sendJson(res, 201, await this.handoff(req, id))
        const allow = operation === 'document' ? 'PATCH' : operation === 'media' ? 'POST, GET' : 'POST'
        return sendJson(res, 405, errorBody(new StenographerError('METHOD_NOT_ALLOWED', '请求方法不支持', { status: 405 })), { Allow: allow })
      }
      return sendJson(res, 404, errorBody(notFound('ROUTE_NOT_FOUND', '速记员接口不存在')))
    } catch (error) {
      const normalized = error instanceof StenographerError ? error : new StenographerError('INTERNAL_ERROR', text(error?.message || error), { status: 500, cause: error })
      return sendJson(res, normalized.status || 500, errorBody(normalized))
    }
  }

  async close() {
    this.closed = true
    await Promise.all([...this.finalizeOperations.values()].map((task) => task.catch(() => {})))
    await this.supervisor.close()
  }
}

export { readJsonBody, readRequestBody, sendJson }
