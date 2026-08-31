#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const API = 'http://127.0.0.1:3080/api/stenographer'
const argument = (name, fallback = '') => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const pcmPath = argument('--pcm')
const source = argument('--source', 'system')
if (!pcmPath) throw new Error('usage: e2e-smoke.mjs --pcm /absolute/audio.pcm [--source system|microphone]')
if (!['system', 'microphone'].includes(source)) throw new Error('source must be system or microphone')
const pcm = await readFile(pcmPath)
assert.ok(pcm.byteLength > 0 && pcm.byteLength % 2 === 0, 'PCM16 input is invalid')

async function request(path, { method = 'GET', body, token, contentType = 'application/json' } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': contentType }),
      ...(token ? { 'X-Stenographer-Token': token } : {}),
    },
    body,
  })
  const value = await response.json()
  if (!response.ok || value.ok === false) throw new Error(`${response.status} ${JSON.stringify(value)}`)
  return value
}

const created = await request('/sessions', {
  method: 'POST',
  body: JSON.stringify({ source, expectedSpeakers: 'auto', language: 'zh-CN', title: `模型验收 · ${new Date().toISOString()}` }),
})
const { id } = created.session
const token = created.upload.token
await request(`/sessions/${id}/state`, { method: 'POST', token, body: JSON.stringify({ state: 'recording' }) })
const chunkBytes = 16_000
let seq = 0
for (let offset = 0; offset < pcm.byteLength; offset += chunkBytes) {
  const chunk = pcm.subarray(offset, Math.min(pcm.byteLength, offset + chunkBytes))
  await request(`/sessions/${id}/audio?source=${source}&seq=${seq}&capturedAtMs=${Date.now() + seq * 500}`, {
    method: 'POST', token, body: chunk, contentType: 'application/octet-stream',
  })
  seq += 1
}
const stopped = await request(`/sessions/${id}/state`, { method: 'POST', token, body: JSON.stringify({ state: 'stopped' }) })
await request(`/sessions/${id}/finalize`, { method: 'POST', token, body: JSON.stringify({ baseRevision: stopped.session.revision }) })

const deadline = Date.now() + 120_000
let session
while (Date.now() < deadline) {
  session = (await request(`/sessions/${id}`)).session
  if (session.state === 'ready' || session.state === 'error') break
  await new Promise((resolve) => setTimeout(resolve, 500))
}
assert.equal(session?.state, 'ready', JSON.stringify(session?.error || session?.progress))
const transcripts = session.document.blocks.filter((block) => block.type === 'transcript')
assert.ok(transcripts.length > 0, 'real local models produced no transcript blocks')
assert.ok(transcripts.every((block) => block.isFinal), 'final transcript contains provisional blocks')
if (source === 'system') assert.ok(transcripts.some((block) => block.speakerId && block.speakerId !== 'speaker-local'), 'system track did not receive a remote speaker label')
process.stdout.write(`${JSON.stringify({
  ok: true,
  sessionId: id,
  source,
  durationMs: session.durationMs,
  speakers: session.speakers,
  transcript: transcripts.map((block) => ({ speakerId: block.speakerId, startMs: block.startMs, endMs: block.endMs, text: block.text, confidence: block.confidence })),
}, null, 2)}\n`)
