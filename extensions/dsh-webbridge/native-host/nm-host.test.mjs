import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_NATIVE_FRAME_BYTES,
  NativeMessageReader,
  ResultRouter,
  encodeCommandMessages,
} from './nm-host.js'

function nativeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32LE(body.length, 0)
  return Buffer.concat([length, body])
}

test('NativeMessageReader preserves fragmented and consecutive frames', () => {
  const reader = new NativeMessageReader()
  const data = Buffer.concat([nativeFrame({ a: 1 }), nativeFrame({ text: '中文' })])
  assert.deepEqual(reader.push(data.subarray(0, 5)), [])
  assert.deepEqual(reader.push(data.subarray(5, 14)), [{ a: 1 }])
  assert.deepEqual(reader.push(data.subarray(14)), [{ text: '中文' }])
})

test('large Host commands are split below the Native Messaging limit and reassemble exactly', () => {
  const base64 = 'A'.repeat(1_600_000)
  const messages = encodeCommandMessages({ cmdId: 'upload-1', kind: 'upload', name: 'large.png', base64 })
  assert.equal(messages[0].type, 'command_start')
  assert.equal(messages.at(-1).type, 'command_end')
  const chunks = messages.filter((message) => message.type === 'command_chunk')
  assert.ok(chunks.length > 1)
  assert.equal(chunks.map((message) => message.data).join(''), base64)
  for (const message of messages) {
    assert.ok(Buffer.byteLength(JSON.stringify(message), 'utf8') <= MAX_NATIVE_FRAME_BYTES)
  }
})

test('ResultRouter retains all screenshot frames until result_end', async () => {
  const router = new ResultRouter()
  const result = router.waitFor('shot-1', 1000)
  assert.equal(router.accept({ type: 'result_chunk', protocol: 2, cmdId: 'shot-1', index: 0, total: 2, data: 'data:image/png;base64,' }), true)
  assert.equal(router.pending.has('shot-1'), true)
  assert.equal(router.accept({ type: 'result_chunk', protocol: 2, cmdId: 'shot-1', index: 1, total: 2, data: 'AAAA' }), true)
  assert.equal(router.accept({ type: 'result_end', protocol: 2, cmdId: 'shot-1', final: { ok: true, screenshotChunks: 2 } }), true)
  assert.deepEqual(await result, { ok: true, dataUrl: 'data:image/png;base64,AAAA' })
  assert.equal(router.pending.size, 0)
})

test('ResultRouter accepts direct small results', async () => {
  const router = new ResultRouter()
  const result = router.waitFor('status-1', 1000)
  assert.equal(router.accept({ cmdId: 'status-1', final: { ok: true, data: { connected: true } } }), true)
  assert.deepEqual(await result, { ok: true, data: { connected: true } })
})
