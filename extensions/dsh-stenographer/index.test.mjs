import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FakeModelBackend, LocalModelBackend, ModelSupervisor, StenographerService, apply } from './index.js'
import { reconcileDocument } from './runtime/document.js'
import { compactSpeechRegions } from './runtime/service.js'
import { IncrementalSpeakerCluster } from './runtime/speaker-cluster.js'

const JSON_HEADERS = { 'content-type': 'application/json' }

function speechPcm(seconds = 1, amplitude = 6_000) {
  const samples = Math.floor(16_000 * seconds)
  const buffer = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin(index / 9) * amplitude)
    buffer.writeInt16LE(value, index * 2)
  }
  return buffer
}

function request(method, url, body, headers = {}) {
  const bodyHeaders = body === undefined
    ? {}
    : Buffer.isBuffer(body) || body instanceof Uint8Array
      ? { 'content-type': 'application/octet-stream' }
      : JSON_HEADERS
  return {
    method,
    url,
    headers: { ...bodyHeaders, ...headers },
    ...(body === undefined ? {} : { body }),
  }
}

async function call(service, method, url, body, headers = {}) {
  let status = 0
  let responseHeaders = {}
  let responseBody = null
  const response = {
    writeHead(code, values) {
      status = code
      responseHeaders = values
    },
    end(value) {
      responseBody = value
    },
  }
  await service.handle(request(method, url, body, headers), response)
  const json = typeof responseBody === 'string' && responseHeaders['Content-Type']?.includes('json')
    ? JSON.parse(responseBody)
    : null
  return { status, headers: responseHeaders, body: responseBody, json }
}

async function makeService(options = {}) {
  const root = options.storageRoot || await mkdtemp(join(tmpdir(), 'dsh-stenographer-'))
  const fetchImpl = options.fetchImpl || (async () => new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '# 测试生成成品\n\n这是完整正文。' } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  const service = new StenographerService({
    storageRoot: root,
    port: 43123,
    backend: options.backend || new FakeModelBackend(options.backendOptions),
    fetchImpl,
    writerApiUrl: 'https://writer.test/chat/completions',
    apiKeyResolver: options.apiKeyResolver || (async () => ({ value: 'test-zhipu-key' })),
  })
  await service.ready()
  return { root, service }
}

async function create(service, source = 'both') {
  const result = await call(service, 'POST', '/api/stenographer/sessions', {
    source,
    expectedSpeakers: 'auto',
    language: 'zh-CN',
    title: '验收速记',
  })
  assert.equal(result.status, 201)
  assert.equal(result.json.ok, true)
  return { id: result.json.session.id, token: result.json.upload.token, session: result.json.session }
}

function auth(token) {
  return { 'x-stenographer-token': token }
}

async function waitFor(service, id, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await call(service, 'GET', '/api/stenographer/sessions/' + id)
    if (predicate(last.json?.session)) return last.json.session
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('等待速记状态超时: ' + JSON.stringify(last?.json))
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('等待条件超时')
}

test('speech regions compact nearby VAD fragments into bounded Whisper requests', () => {
  const compact = compactSpeechRegions([
    { startByte: 0, endByte: 10, startMs: 0, endMs: 500, rms: 0.1 },
    { startByte: 20, endByte: 30, startMs: 1_200, endMs: 2_000, rms: 0.2 },
    { startByte: 40, endByte: 50, startMs: 31_000, endMs: 32_000, rms: 0.3 },
  ])
  assert.deepEqual(compact.map((region) => [region.startMs, region.endMs, region.endByte]), [[0, 2_000, 30], [31_000, 32_000, 50]])
})

test('Chinese short-utterance calibration merges 0.5737 and separates 0.1614 cosine samples', () => {
  const base = [1, 0]
  const same = [0.5737, Math.sqrt(1 - 0.5737 ** 2)]
  const different = [0.1614, Math.sqrt(1 - 0.1614 ** 2)]
  const sameCluster = new IncrementalSpeakerCluster()
  assert.equal(sameCluster.assign(base).speakerId, sameCluster.assign(same).speakerId)
  const differentCluster = new IncrementalSpeakerCluster()
  assert.notEqual(differentCluster.assign(base).speakerId, differentCluster.assign(different).speakerId)
})

test('final reconciliation drops unedited provisional leftovers and preserves repaired text', () => {
  const current = {
    schema: 'stenographer_document.v1', revision: 4, updatedAt: new Date().toISOString(), speakerNames: {}, speakerLineage: {},
    blocks: [
      { type: 'transcript', id: 'old-1', speakerId: 'speaker-1', startMs: 0, endMs: 500, rawText: '临时一', text: '临时一', isFinal: false, userEdited: false, confidence: 0.4, source: 'system', lineage: 'speaker-1' },
      { type: 'text', id: 'note-1', text: '保留备注' },
      { type: 'transcript', id: 'old-2', speakerId: 'speaker-1', startMs: 500, endMs: 900, rawText: '临时二', text: '用户修订', isFinal: false, userEdited: true, confidence: 0.4, source: 'system', lineage: 'speaker-1' },
      { type: 'transcript', id: 'old-3', speakerId: 'speaker-1', startMs: 900, endMs: 1_100, rawText: 'BY', text: 'BY', isFinal: false, userEdited: false, confidence: 0, source: 'system', lineage: 'speaker-1' },
    ],
  }
  const fresh = [{ type: 'transcript', id: 'final-1', speakerId: 'speaker-1', startMs: 0, endMs: 1_000, rawText: '最终内容', text: '最终内容', isFinal: true, userEdited: false, confidence: 0.9, source: 'system', lineage: 'speaker-1' }]
  const reconciled = reconcileDocument(current, fresh)
  assert.deepEqual(reconciled.blocks.map((block) => [block.id, block.text]), [['old-1', '最终内容'], ['note-1', '保留备注'], ['old-2', '用户修订']])
  assert.equal(reconciled.blocks.some((block) => block.text === 'BY'), false)
})

test('Host registers one independent prefix route and disposes it', () => {
  const routes = []
  const ctx = {
    webServer: {
      port: 3080,
      host: '127.0.0.1',
      register(route) {
        routes.push(route)
        return () => routes.splice(routes.indexOf(route), 1)
      },
    },
    effect(factory) { this.dispose = factory() },
  }
  const service = apply(ctx, {
    storageRoot: join(tmpdir(), 'dsh-stenographer-apply-' + Date.now()),
    backend: new FakeModelBackend(),
  })
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/api/stenographer')
  ctx.dispose()
  assert.equal(routes.length, 0)
  return service.close()
})

test('create/read use the response envelope and keep the upload secret out of snapshots', async () => {
  const { root, service } = await makeService()
  try {
    const created = await create(service, 'microphone')
    const read = await call(service, 'GET', '/api/stenographer/sessions/' + created.id)
    assert.equal(read.status, 200)
    assert.equal(read.json.ok, true)
    assert.equal(read.json.session.id, created.id)
    assert.equal(JSON.stringify(read.json).includes(created.token), false)
    const listed = await call(service, 'GET', '/api/stenographer/sessions')
    assert.deepEqual(listed.json.sessions.map((item) => item.id), [created.id])
    const health = await call(service, 'GET', '/api/stenographer/health')
    assert.equal(health.json.ok, true)
    assert.equal(health.json.offlineOnly, false)
    assert.equal(health.json.audioOfflineOnly, true)
    assert.equal(health.json.writer.model, 'glm-5.3-flash')
    assert.equal(health.json.paidApiFallback, false)
    assert.equal(health.json.models.provider, 'fake-local-test-only')
    assert.equal((await stat(join(root, created.id))).mode & 0o777, 0o700)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('history deletion is authenticated, blocks active recordings and moves data to recoverable trash', async () => {
  const { root, service } = await makeService()
  try {
    const active = await create(service, 'microphone')
    await call(service, 'POST', '/api/stenographer/sessions/' + active.id + '/state', { state: 'recording' }, auth(active.token))
    const blocked = await call(service, 'DELETE', '/api/stenographer/sessions/' + active.id, undefined, auth(active.token))
    assert.equal(blocked.status, 409)
    assert.equal(blocked.json.error.code, 'SESSION_DELETE_ACTIVE')

    const removable = await create(service, 'microphone')
    const denied = await call(service, 'DELETE', '/api/stenographer/sessions/' + removable.id)
    assert.equal(denied.status, 401)
    const deleted = await call(service, 'DELETE', '/api/stenographer/sessions/' + removable.id, undefined, auth(removable.token))
    assert.equal(deleted.status, 200)
    assert.equal(deleted.json.deleted, true)
    assert.equal(deleted.json.recoverable, true)
    await assert.rejects(() => stat(join(root, removable.id)), { code: 'ENOENT' })
    assert.equal((await readdir(join(root, '.trash'))).some((name) => name.startsWith(removable.id + '-')), true)
    const listed = await call(service, 'GET', '/api/stenographer/sessions')
    assert.equal(listed.json.sessions.some((item) => item.id === removable.id), false)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('method, path, content type and upload-token validation fail closed', async () => {
  const { root, service } = await makeService()
  try {
    const created = await create(service, 'microphone')
    const missingToken = await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/state', { state: 'recording' })
    assert.equal(missingToken.status, 401)
    assert.equal(missingToken.json.error.code, 'UPLOAD_TOKEN_REQUIRED')
    const wrongPath = await call(service, 'GET', '/api/stenographer/sessions/../outside')
    assert.ok([400, 404].includes(wrongPath.status))
    const wrongMethod = await call(service, 'PATCH', '/api/stenographer/sessions/' + created.id)
    assert.equal(wrongMethod.status, 405)
    const wrongMime = await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/audio?source=microphone&seq=0&capturedAtMs=1', Buffer.from([0, 0]), { ...auth(created.token), 'content-type': 'audio/wav' })
    assert.equal(wrongMime.status, 400)
    assert.equal(wrongMime.json.error.code, 'INVALID_CONTENT_TYPE')
    const encodedSlash = await call(service, 'GET', '/api/stenographer/sessions/' + encodeURIComponent('../x'))
    assert.equal(encodedSlash.status, 400)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('audio append enforces PCM16, strict per-source ordering and duplicate rejection', async () => {
  const { root, service } = await makeService()
  try {
    const created = await create(service, 'both')
    const base = '/api/stenographer/sessions/' + created.id + '/audio'
    const bytes = Buffer.from([0, 0, 1, 0])
    const outOfOrder = await call(service, 'POST', base + '?source=system&seq=1&capturedAtMs=1000', bytes, auth(created.token))
    assert.equal(outOfOrder.status, 409)
    assert.equal(outOfOrder.json.error.code, 'AUDIO_SEQ_OUT_OF_ORDER')
    const accepted = await call(service, 'POST', base + '?source=system&seq=0&capturedAtMs=1000', bytes, auth(created.token))
    assert.equal(accepted.status, 200)
    assert.equal(accepted.json.accepted, true)
    const duplicate = await call(service, 'POST', base + '?source=system&seq=0&capturedAtMs=1000', bytes, auth(created.token))
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.json.error.code, 'AUDIO_SEQ_DUPLICATE')
    assert.equal(duplicate.json.error.details.expectedSeq, 1)
    const mic = await call(service, 'POST', base + '?source=microphone&seq=0&capturedAtMs=1001', bytes, auth(created.token))
    assert.equal(mic.status, 200)
    assert.equal((await stat(join(root, created.id, 'session.json'))).mode & 0o777, 0o600)
    assert.equal((await stat(join(root, created.id, 'audio', 'system.pcm'))).mode & 0o777, 0o600)
    assert.equal((await stat(join(root, created.id, 'audio', 'system.pcm'))).size, bytes.byteLength)
    const events = await readFile(join(root, created.id, 'events.jsonl'), 'utf8')
    assert.equal(events.includes('audio_appended'), true)
    assert.equal((await readdir(join(root, created.id))).some((name) => name.includes('.tmp-')), false)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('revision conflict and media/document ordering protect user edits', async () => {
  const { root, service } = await makeService()
  try {
    const created = await create(service, 'microphone')
    const media = await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/media', {
      name: '截图.png',
      mimeType: 'image/png',
      dataBase64: Buffer.from('image').toString('base64'),
    }, auth(created.token))
    assert.equal(media.status, 201)
    const first = await call(service, 'PATCH', '/api/stenographer/sessions/' + created.id + '/document', {
      baseRevision: created.session.revision,
      blocks: [
        { type: 'text', id: 'note-1', text: '会中备注' },
        { type: 'image', id: 'image-1', mediaId: media.json.media.id, caption: '现场截图' },
        { type: 'transcript', id: 'transcript-1', speakerId: 'speaker-local', startMs: 0, endMs: 1000, rawText: '原始识别', text: '用户已修订', isFinal: false, userEdited: true, confidence: 0.4, source: 'microphone', lineage: 'speaker-local' },
      ],
      speakerNames: { 'speaker-local': '我' },
    }, auth(created.token))
    assert.equal(first.status, 200)
    const conflictResult = await call(service, 'PATCH', '/api/stenographer/sessions/' + created.id + '/document', {
      baseRevision: created.session.revision,
      blocks: [],
    }, auth(created.token))
    assert.equal(conflictResult.status, 409)
    assert.equal(conflictResult.json.error.code, 'REVISION_CONFLICT')
    const stored = JSON.parse(await readFile(join(root, created.id, 'document.json'), 'utf8'))
    assert.deepEqual(stored.blocks.map((block) => block.type), ['text', 'image', 'transcript'])
    assert.equal(stored.blocks[2].userEdited, true)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Host restart recovers recording as interrupted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-stenographer-restart-'))
  const first = new StenographerService({ storageRoot: root, backend: new FakeModelBackend() })
  await first.ready()
  const created = await create(first, 'microphone')
  const started = await call(first, 'POST', '/api/stenographer/sessions/' + created.id + '/state', { state: 'recording' }, auth(created.token))
  assert.equal(started.json.session.state, 'recording')
  await first.close()
  const second = new StenographerService({ storageRoot: root, backend: new FakeModelBackend() })
  try {
    const recovered = await call(second, 'GET', '/api/stenographer/sessions/' + created.id)
    assert.equal(recovered.json.session.state, 'interrupted')
    assert.equal(recovered.json.session.error.code, 'HOST_RESTART_INTERRUPTED')
    assert.equal((await readFile(join(root, created.id, 'events.jsonl'), 'utf8')).includes('host_restart_recovery'), true)
  } finally {
    await second.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('finalize is idempotent and GLM-5.3-Flash returns a persisted full artifact', async () => {
  class SlowBackend extends FakeModelBackend {
    async transcribe(input) {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return super.transcribe(input)
    }
  }
  const writerRequests = []
  const fetchImpl = async (url, options) => {
    writerRequests.push({ url, headers: options.headers, body: JSON.parse(options.body) })
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '# 完整会议纪要\n\n这是完整正文。' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const { root, service } = await makeService({ backend: new SlowBackend({ segments: [{ startMs: 0, endMs: 1000, text: '最终内容', confidence: 0.9 }] }), fetchImpl })
  try {
    const created = await create(service, 'microphone')
    await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/state', { state: 'recording' }, auth(created.token))
    await call(service, 'POST', 'http://127.0.0.1:43123/api/stenographer/sessions/' + created.id + '/audio?source=microphone&seq=0&capturedAtMs=1', speechPcm(1), auth(created.token))
    const stopped = await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/state', { state: 'stopped' }, auth(created.token))
    const baseRevision = stopped.json.session.revision
    const onePromise = call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/finalize', { baseRevision }, auth(created.token))
    const twoPromise = call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/finalize', { baseRevision }, auth(created.token))
    const one = await onePromise
    const two = await twoPromise
    assert.equal(one.status, 202)
    assert.equal(two.status, 202)
    assert.equal(one.json.session.progress.operationId, two.json.session.progress.operationId)
    const ready = await waitFor(service, created.id, (session) => session.state === 'ready')
    assert.equal(ready.document.blocks.some((block) => block.type === 'transcript'), true)
    assert.equal(ready.document.blocks.find((block) => block.type === 'transcript').speakerId, 'speaker-local')
    const transcriptPath = join(root, created.id, 'transcript.md')
    const manifestPath = join(root, created.id, 'manifest.json')
    assert.equal((await stat(transcriptPath)).mode & 0o777, 0o600)
    assert.equal((await stat(manifestPath)).mode & 0o777, 0o600)
    const handoff = await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/handoff', {
      baseRevision: ready.revision,
      purpose: 'meeting_minutes',
      extraInstructions: '请列出待办。',
    }, auth(created.token))
    assert.equal(handoff.status, 201)
    assert.equal(handoff.json.handoff.provider, 'zhipu-glm')
    assert.equal(handoff.json.handoff.model, 'glm-5.3-flash')
    assert.equal(handoff.json.handoff.paidApiFallback, false)
    assert.equal(handoff.json.handoff.snapshotRevision, ready.revision)
    assert.match(handoff.json.handoff.sha256, /^[0-9a-f]{64}$/)
    assert.equal(handoff.json.handoff.transcriptPath, transcriptPath)
    assert.equal(handoff.json.handoff.manifestPath, manifestPath)
    assert.match(handoff.json.handoff.prompt, /最终内容/)
    assert.equal(handoff.json.artifact.status, 'ready')
    assert.match(handoff.json.artifact.content, /完整正文/)
    assert.equal(handoff.json.artifact.provider, 'zhipu-glm')
    assert.equal(handoff.json.artifact.model, 'glm-5.3-flash')
    assert.equal(handoff.json.session.artifacts.at(-1).id, handoff.json.artifact.id)
    assert.equal(writerRequests.length, 1)
    assert.equal(writerRequests[0].url, 'https://writer.test/chat/completions')
    assert.equal(writerRequests[0].body.model, 'glm-5.3-flash')
    assert.deepEqual(writerRequests[0].body.thinking, { type: 'enabled' })
    assert.equal(writerRequests[0].body.reasoning_effort, 'high')
    assert.match(writerRequests[0].body.messages.at(-1).content, /最终内容/)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('dual-track finalization uses one timeline and preserves the local microphone speaker', async () => {
  const { root, service } = await makeService()
  try {
    const created = await create(service, 'both')
    await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/state', { state: 'recording' }, auth(created.token))
    const oneSecond = speechPcm(1)
    const base = '/api/stenographer/sessions/' + created.id + '/audio'
    assert.equal((await call(service, 'POST', base + '?source=microphone&seq=0&capturedAtMs=1000', oneSecond, auth(created.token))).status, 200)
    assert.equal((await call(service, 'POST', base + '?source=system&seq=0&capturedAtMs=1500', oneSecond, auth(created.token))).status, 200)
    const stopped = await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/state', { state: 'stopped' }, auth(created.token))
    await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/finalize', { baseRevision: stopped.json.session.revision }, auth(created.token))
    const ready = await waitFor(service, created.id, (session) => session.state === 'ready')
    const transcript = ready.document.blocks.filter((block) => block.type === 'transcript')
    assert.equal(ready.durationMs, 1000, 'dual-track duration is max(track), not the sum')
    assert.deepEqual(transcript.map((block) => [block.source, block.startMs]), [['microphone', 0], ['system', 500]])
    assert.equal(transcript[0].speakerId, 'speaker-local')
    assert.notEqual(transcript[1].speakerId, 'speaker-local')
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('live inference appends transcripts without duplicating user text or image blocks', async () => {
  const { root, service } = await makeService()
  try {
    const created = await create(service, 'microphone')
    const patched = await call(service, 'PATCH', '/api/stenographer/sessions/' + created.id + '/document', {
      baseRevision: created.session.revision,
      blocks: [{ type: 'text', id: 'note-live', text: '只保留一份', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
      speakerNames: {},
    }, auth(created.token))
    assert.equal(patched.status, 200)
    await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/state', { state: 'recording' }, auth(created.token))
    const twoSeconds = speechPcm(2)
    await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/audio?source=microphone&seq=0&capturedAtMs=1000', twoSeconds, auth(created.token))
    const updated = await waitFor(service, created.id, (session) => session.document.blocks.some((block) => block.type === 'transcript'))
    assert.equal(updated.document.blocks.filter((block) => block.id === 'note-live').length, 1)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('live inference rejects tiny zero-confidence repetition fragments', async () => {
  const backend = new FakeModelBackend({
    segments: [
      { startMs: 0, endMs: 20, text: 'BY', confidence: 0 },
      { startMs: 20, endMs: 120, text: 'BY', confidence: 0 },
    ],
  })
  const { root, service } = await makeService({ backend })
  try {
    const created = await create(service, 'microphone')
    await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/state', { state: 'recording' }, auth(created.token))
    await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/audio?source=microphone&seq=0&capturedAtMs=1000', speechPcm(2), auth(created.token))
    await waitUntil(() => backend.calls.some((entry) => entry.method === 'transcribe'))
    const current = await call(service, 'GET', '/api/stenographer/sessions/' + created.id)
    assert.deepEqual(current.json.session.document.blocks, [])
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a large admitted PCM chunk drains every complete live window without backlog growth', async () => {
  const backend = new FakeModelBackend()
  const { root, service } = await makeService({ backend })
  try {
    const created = await create(service, 'microphone')
    await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/state', { state: 'recording' }, auth(created.token))
    const admitted = speechPcm(32)
    assert.ok(admitted.byteLength <= 1_048_576)
    await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/audio?source=microphone&seq=0&capturedAtMs=1', admitted, auth(created.token))
    await waitFor(service, created.id, (session) => session.document.blocks.filter((block) => block.type === 'transcript').length >= 16, 5_000)
    assert.equal(backend.calls.filter((call) => call.method === 'transcribe').length, 16)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('worker failure becomes a persisted error without paid fallback', async () => {
  const { root, service } = await makeService({ backend: new FakeModelBackend({ fail: 'transcribe' }) })
  try {
    const created = await create(service, 'microphone')
    await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/audio?source=microphone&seq=0&capturedAtMs=1', speechPcm(1), auth(created.token))
    await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/state', { state: 'stopped' }, auth(created.token))
    const stopped = await call(service, 'GET', '/api/stenographer/sessions/' + created.id)
    await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/finalize', { baseRevision: stopped.json.session.revision }, auth(created.token))
    const failed = await waitFor(service, created.id, (session) => session.state === 'error')
    assert.match(failed.error.code, /FINALIZE|INTERNAL|MODEL/)
    assert.equal(failed.models.paidApiFallback, false)
    assert.equal(JSON.parse(await readFile(join(root, created.id, 'session.json'))).state, 'error')
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('known microphone speaker and tiny remote segments do not fail finalization', async () => {
  const backend = new FakeModelBackend({
    segments: [{ startMs: 0, endMs: 200, text: '短句', confidence: 0.8 }],
    fail: 'embed',
  })
  const { root, service } = await makeService({ backend })
  try {
    const created = await create(service, 'microphone')
    await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/state', { state: 'recording' }, auth(created.token))
    await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/audio?source=microphone&seq=0&capturedAtMs=1', speechPcm(0.5), auth(created.token))
    const stopped = await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/state', { state: 'stopped' }, auth(created.token))
    await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/finalize', { baseRevision: stopped.json.session.revision }, auth(created.token))
    const ready = await waitFor(service, created.id, (session) => session.state === 'ready')
    assert.equal(ready.document.blocks.find((block) => block.type === 'transcript').speakerId, 'speaker-local')
    assert.equal(backend.calls.some((call) => call.method === 'embed'), false)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('silence completes without fabricated transcript blocks', async () => {
  const { root, service } = await makeService()
  try {
    const created = await create(service, 'microphone')
    await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/audio?source=microphone&seq=0&capturedAtMs=1', Buffer.alloc(16_000 * 2), auth(created.token))
    const stopped = await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/state', { state: 'stopped' }, auth(created.token))
    await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/finalize', { baseRevision: stopped.json.session.revision }, auth(created.token))
    const ready = await waitFor(service, created.id, (session) => session.state === 'ready')
    assert.deepEqual(ready.document.blocks, [])
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed finalization can be retried after the local model recovers', async () => {
  const backend = new FakeModelBackend({ fail: 'transcribe' })
  const { root, service } = await makeService({ backend })
  try {
    const created = await create(service, 'microphone')
    await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/audio?source=microphone&seq=0&capturedAtMs=1', speechPcm(0.5), auth(created.token))
    const stopped = await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/state', { state: 'stopped' }, auth(created.token))
    await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/finalize', { baseRevision: stopped.json.session.revision }, auth(created.token))
    const failed = await waitFor(service, created.id, (session) => session.state === 'error')
    backend.fail = null
    const retried = await call(service, 'POST', '/api/stenographer/sessions/' + created.id + '/finalize', { baseRevision: failed.revision }, auth(created.token))
    assert.equal(retried.status, 202)
    const ready = await waitFor(service, created.id, (session) => session.state === 'ready')
    assert.equal(ready.error, null)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('formal local model health is not_ready until pinned manifest and weights exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-stenographer-models-'))
  try {
    const backend = new LocalModelBackend({
      modelRoot: root,
      sttPython: join(root, 'missing-python'),
      speakerPython: join(root, 'missing-speaker-python'),
    })
    const health = await backend.health()
    assert.equal(health.ready, false)
    assert.equal(health.paidApiFallback, false)
    assert.equal(health.stt.ready, false)
    assert.equal(health.speaker.ready, false)
    assert.equal(health.stt.errors.some((item) => item.code === 'MODEL_MANIFEST_MISSING'), true)
    assert.equal(health.speaker.errors.some((item) => item.code === 'MODEL_MANIFEST_MISSING'), true)
    await backend.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('model supervisor exposes worker failure state', async () => {
  const backend = new FakeModelBackend({ fail: 'embed' })
  const supervisor = new ModelSupervisor({ backend })
  try {
    await assert.rejects(() => supervisor.embed({ source: 'system' }), /fake speaker failure/)
    const health = await supervisor.health()
    assert.equal(health.supervisor.state, 'failed')
    assert.equal(backend.calls.length, 1)
  } finally {
    await supervisor.close()
  }
})
