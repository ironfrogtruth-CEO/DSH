#!/usr/bin/env node
// CyberMarcus Web Bridge — Native Messaging Host (stdio ⇄ DSH HTTP queue)

import http from 'node:http'
import process from 'node:process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

export const PROTOCOL_VERSION = 2
export const MAX_NATIVE_FRAME_BYTES = 700 * 1024
export const MAX_EXTENSION_MESSAGE_BYTES = 64 * 1024 * 1024
export const MAX_COMMAND_CHUNKS = 256
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:3080'
export const DEFAULT_EXTENSION_ORIGIN = 'chrome-extension://kkohpnomjgdhbahkclbhhcfjkcgiinpe/'

function byteLength(value) {
  return Buffer.byteLength(String(value), 'utf8')
}

function frameByteLength(value) {
  try { return byteLength(JSON.stringify(value)) } catch { return Infinity }
}

function splitStringForFrames(value, makeFrame, maxBytes = MAX_NATIVE_FRAME_BYTES) {
  const text = String(value)
  if (!text.length) return ['']
  const chunks = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + maxBytes)
    let frame = makeFrame(text.slice(start, end))
    while (end > start + 1 && frameByteLength(frame) > maxBytes) {
      const excess = frameByteLength(frame) - maxBytes
      end -= Math.max(1, Math.ceil(excess / 2))
      frame = makeFrame(text.slice(start, end))
    }
    if (frameByteLength(frame) > maxBytes) throw new Error('native message frame cannot fit within limit')
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}

export class NativeMessageReader {
  constructor(maxBytes = MAX_EXTENSION_MESSAGE_BYTES) {
    this.maxBytes = maxBytes
    this.buffer = Buffer.alloc(0)
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)])
    const messages = []
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0)
      if (length > this.maxBytes) throw new Error(`extension message exceeds ${this.maxBytes} byte limit`)
      if (this.buffer.length < 4 + length) break
      const body = this.buffer.subarray(4, 4 + length).toString('utf8')
      this.buffer = this.buffer.subarray(4 + length)
      messages.push(JSON.parse(body))
    }
    return messages
  }
}

export async function writeNativeMessage(stream, message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  if (body.length > MAX_NATIVE_FRAME_BYTES) {
    throw new Error(`native host frame exceeds safe ${MAX_NATIVE_FRAME_BYTES} byte limit`)
  }
  const length = Buffer.alloc(4)
  length.writeUInt32LE(body.length, 0)
  if (!stream.write(Buffer.concat([length, body]))) await once(stream, 'drain')
}

export function encodeCommandMessages(job) {
  if (!job || job.cmdId === undefined) throw new Error('command is missing cmdId')
  if (frameByteLength(job) <= MAX_NATIVE_FRAME_BYTES) return [job]

  const fields = Object.entries(job)
    .filter(([, value]) => typeof value === 'string')
    .sort((a, b) => byteLength(b[1]) - byteLength(a[1]))
  const [selected] = fields
  if (!selected) throw new Error('oversized command has no splittable string field')
  const [field, value] = selected
  const cmdId = String(job.cmdId)
  const command = { ...job }
  delete command[field]
  const chunks = splitStringForFrames(value, (data) => ({
    type: 'command_chunk', protocol: PROTOCOL_VERSION, cmdId, field,
    index: MAX_COMMAND_CHUNKS - 1, total: MAX_COMMAND_CHUNKS, data,
  }))
  if (chunks.length > MAX_COMMAND_CHUNKS) throw new Error(`command needs more than ${MAX_COMMAND_CHUNKS} frames`)
  const total = chunks.length
  const messages = [
    { type: 'command_start', protocol: PROTOCOL_VERSION, cmdId, field, total, command },
    ...chunks.map((data, index) => ({
      type: 'command_chunk', protocol: PROTOCOL_VERSION, cmdId, field, index, total, data,
    })),
    { type: 'command_end', protocol: PROTOCOL_VERSION, cmdId, field, total },
  ]
  for (const message of messages) {
    if (frameByteLength(message) > MAX_NATIVE_FRAME_BYTES) {
      throw new Error(`encoded command frame exceeds ${MAX_NATIVE_FRAME_BYTES} bytes`)
    }
  }
  return messages
}

export class ResultRouter {
  constructor() {
    this.pending = new Map()
  }

  waitFor(cmdId, timeoutMs = 45000) {
    const key = String(cmdId)
    if (this.pending.has(key)) throw new Error(`duplicate pending cmdId ${key}`)
    return new Promise((resolve) => {
      const state = { resolve, chunks: null, received: 0, total: 0, bytes: 0, timer: null }
      state.timer = setTimeout(() => this.finish(key, { ok: false, error: 'extension timeout' }), timeoutMs)
      this.pending.set(key, state)
    })
  }

  finish(cmdId, result) {
    const key = String(cmdId)
    const state = this.pending.get(key)
    if (!state) return false
    this.pending.delete(key)
    clearTimeout(state.timer)
    state.resolve(result)
    return true
  }

  accept(message) {
    if (!message || message.cmdId === undefined) return false
    const key = String(message.cmdId)
    const state = this.pending.get(key)
    if (!state) return false

    if (message.type === 'result_chunk') {
      if (message.protocol !== PROTOCOL_VERSION || typeof message.data !== 'string') {
        return this.finish(key, { ok: false, error: 'invalid result chunk' })
      }
      const index = Number(message.index)
      const total = Number(message.total)
      if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || total > MAX_COMMAND_CHUNKS || index < 0 || index >= total) {
        return this.finish(key, { ok: false, error: 'invalid result chunk index' })
      }
      if (state.chunks === null) {
        state.total = total
        state.chunks = new Array(total)
      }
      if (state.total !== total) return this.finish(key, { ok: false, error: 'result chunk total changed' })
      if (state.chunks[index] === undefined) {
        state.chunks[index] = message.data
        state.received += 1
        state.bytes += byteLength(message.data)
        if (state.bytes > MAX_EXTENSION_MESSAGE_BYTES) {
          return this.finish(key, { ok: false, error: 'result exceeds 64MB limit' })
        }
      } else if (state.chunks[index] !== message.data) {
        return this.finish(key, { ok: false, error: 'conflicting duplicate result chunk' })
      }
      return true
    }

    if (message.type === 'result_end') {
      if (message.protocol !== PROTOCOL_VERSION || state.chunks === null || state.received !== state.total || state.chunks.some((item) => item === undefined)) {
        return this.finish(key, { ok: false, error: 'incomplete result frames' })
      }
      // Keep non-payload result metadata (capture_method, activation_reason,
      // browser_focus) alongside the reassembled data URL. The extension puts
      // this evidence on result_end because the image itself is sent in
      // separate native frames.
      const final = message.final && typeof message.final === 'object' ? message.final : {}
      const { dataUrl: _ignoredDataUrl, ...metadata } = final
      return this.finish(key, { ...metadata, ok: final.ok !== false, dataUrl: state.chunks.join('') })
    }

    if (Object.hasOwn(message, 'final')) {
      return this.finish(key, message.final || { ok: false, error: 'empty result' })
    }
    return false
  }

  close(error = 'native host closed') {
    for (const key of [...this.pending.keys()]) this.finish(key, { ok: false, error })
  }
}

export function httpJson(method, path, body, options = {}) {
  const bridge = options.bridge || process.env.CM_BRIDGE_URL || DEFAULT_BRIDGE_URL
  const maxResponseBytes = options.maxResponseBytes || 70 * 1024 * 1024
  return new Promise((resolve, reject) => {
    const url = new URL(bridge.replace(/\/$/, '') + path)
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const request = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {},
    }, (response) => {
      const chunks = []
      let bytes = 0
      response.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > maxResponseBytes) {
          request.destroy(new Error('bridge response exceeds size limit'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if ((response.statusCode || 500) >= 400) {
          reject(new Error(`bridge HTTP ${response.statusCode}: ${text.slice(0, 300)}`))
          return
        }
        try { resolve(JSON.parse(text)) } catch { reject(new Error('bridge returned invalid JSON')) }
      })
    })
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

function createInbox(stream, router) {
  const reader = new NativeMessageReader()
  const queued = []
  const waiters = []
  stream.on('data', (chunk) => {
    try {
      for (const message of reader.push(chunk)) {
        if (router.accept(message)) continue
        const waiter = waiters.shift()
        if (waiter) waiter(message)
        else queued.push(message)
      }
    } catch (error) {
      process.stderr.write(`native input error: ${error.message}\n`)
      stream.destroy(error)
    }
  })
  return function receive(timeoutMs = 5000) {
    if (queued.length) return Promise.resolve(queued.shift())
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('extension handshake timeout')), timeoutMs)
      waiters.push((message) => { clearTimeout(timer); resolve(message) })
    })
  }
}

export async function main() {
  const expectedOrigin = process.env.CM_EXTENSION_ORIGIN || DEFAULT_EXTENSION_ORIGIN
  const callerOrigin = process.argv[2]
  if (callerOrigin !== expectedOrigin) {
    process.stderr.write(`native host refused origin ${JSON.stringify(callerOrigin || null)}\n`)
    process.exitCode = 1
    return
  }

  const router = new ResultRouter()
  const receive = createInbox(process.stdin, router)
  process.stdin.on('end', () => { router.close(); process.exit(0) })
  process.stdin.on('error', (error) => { router.close(error.message) })

  const hello = await receive(5000)
  if (!hello || hello.type !== 'hello' || hello.protocol !== PROTOCOL_VERSION) {
    await writeNativeMessage(process.stdout, { type: 'hello_ack', protocol: PROTOCOL_VERSION, ok: false })
    process.exitCode = 1
    return
  }
  await writeNativeMessage(process.stdout, { type: 'hello_ack', protocol: PROTOCOL_VERSION, ok: true })

  while (true) {
    try {
      const job = await httpJson('POST', '/api/webbridge/next', { protocol: PROTOCOL_VERSION })
      if (!job || !job.cmdId) {
        await new Promise((resolve) => setTimeout(resolve, 400))
        continue
      }
      const cmdId = String(job.cmdId)
      const messages = encodeCommandMessages(job)
      const resultPromise = router.waitFor(cmdId, 90000)
      for (const message of messages) await writeNativeMessage(process.stdout, message)
      const result = await resultPromise
      await httpJson('POST', '/api/webbridge/result', { protocol: PROTOCOL_VERSION, cmdId, result })
    } catch (error) {
      process.stderr.write(`nm loop error: ${error.message}\n`)
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`native host fatal: ${error.stack || error.message}\n`)
    process.exitCode = 1
  })
}
