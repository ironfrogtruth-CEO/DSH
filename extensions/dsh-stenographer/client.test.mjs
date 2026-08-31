import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

const sourcePath = new URL('./client.js', import.meta.url)
const source = await readFile(sourcePath, 'utf8')

function loadBundle() {
  const loaded = {}
  const window = {
    __ModuleLoader__: {
      load(payload) {
        loaded.exports = payload.factory((name) => {
          if (name === 'react') return { createElement: (...args) => ({ args }) }
          if (name === 'react-dom') return { createPortal: (child) => child }
          throw new Error(`unexpected dependency: ${name}`)
        })
      },
    },
  }
  const context = vm.createContext({ window, console, setTimeout, clearTimeout })
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.ok(loaded.exports, 'ModuleLoader should receive the bundle')
  return { exports: loaded.exports, window }
}

test('registers the independent @local/dsh-stenographer bundle and required contribution contract', () => {
  assert.match(source, /id:\s*['"]@local\/dsh-stenographer['"]/, 'bundle id must be stable')
  assert.match(source, /conversation\.session\.header\.utilities/, 'header utility slot must be used')
  assert.match(source, /ReactDOM\.createPortal\(panel, document\.body\)/, 'panel must escape transformed header ancestors')
  assert.match(source, /id:\s*['"]dsh-stenographer['"]/, 'utility id must be independent from shrimp-shell')
  assert.match(source, /id:\s*['"]dsh-stenographer['"], order:\s*3/, 'stenographer must render between process and trajectory(order 4)')
  assert.match(source, /shrimp-files-btn shrimp-heartbeat-btn dsh-steno-header-button/, 'header button must match heartbeat UI')
  assert.match(source, /width:min\(800px,calc\(100vw - 32px\)\)/, 'recording panel must use the expanded width')
  assert.match(source, /\.dsh-steno-overlay\{position:fixed!important;inset:0!important;/, 'header slot height rules must not collapse the panel layer')
  assert.deepEqual(Array.from(loadBundle().exports.inject), ['slots', 'sessions', 'conversation', 'modelDirectories'])
})

test('exposes every production state and Chinese status copy', () => {
  const { exports } = loadBundle()
  for (const phase of ['idle', 'model_preparing', 'permission', 'recording', 'paused', 'stopping', 'finalizing', 'ready', 'failed', 'interrupted']) {
    assert.equal(typeof exports.PHASE_LABELS[phase], 'string', `${phase} should have a visible status label`)
  }
  assert.equal(exports.PHASE_LABELS.recording, '正在录音')
  assert.equal(exports.PHASE_LABELS.interrupted, '需要恢复')
  assert.deepEqual(Array.from(exports.SOURCE_OPTIONS, (item) => item.value), ['microphone', 'system', 'both'])
  assert.deepEqual(Array.from(exports.PURPOSE_OPTIONS, (item) => item.value), ['meeting_minutes', 'report_email', 'requirements_document', 'custom'])
})

test('normalizes the v1 success response envelope and preserves session snapshot fields', () => {
  const { exports } = loadBundle()
  const snapshot = exports.normalizeSession({
    ok: true,
    session: {
      id: 'steno-1',
      state: 'recording',
      revision: 7,
      source: 'both',
      expectedSpeakers: 3,
      language: 'zh-CN',
      speakers: [{ id: 'speaker-1', name: '主持人' }],
      document: { blocks: [{ id: 'b1', type: 'transcript', speakerId: 'speaker-1', startMs: 1000, endMs: 2500, rawText: '你好', text: '你好', isFinal: false }] },
    },
  })
  assert.equal(snapshot.id, 'steno-1')
  assert.equal(snapshot.phase, 'recording')
  assert.equal(snapshot.revision, 7)
  assert.equal(snapshot.document.blocks[0].text, '你好')
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.document.speakers)), [{ id: 'speaker-1', name: '主持人' }])
})

test('normalizes list response and maps interrupted/ready sessions for history', () => {
  const { exports } = loadBundle()
  const list = exports.normalizeSessionList({ ok: true, sessions: [{ id: 'a', state: 'interrupted', title: '周会', durationMs: 60000 }, { id: 'b', state: 'ready', title: '访谈' }] })
  assert.equal(list.length, 2)
  assert.equal(list[0].phase, 'interrupted')
  assert.equal(list[1].phase, 'ready')
  assert.equal(list[0].title, '周会')
})

test('protects user-edited transcript and inline text/image order during polling reconciliation', () => {
  const { exports } = loadBundle()
  const local = exports.normalizeDocument({
    revision: 3,
    speakers: [{ id: 'speaker-1', name: '张三' }],
    blocks: [
      { id: 't1', type: 'transcript', speakerId: 'speaker-1', text: '用户已经改过的内容', rawText: '原始内容', userEdited: true },
      { id: 'note-1', type: 'text', text: '现场备注' },
      { id: 'img-1', type: 'image', mediaId: 'media-1', url: '/media/1.png', caption: '白板' },
    ],
  })
  const remote = exports.normalizeDocument({
    revision: 4,
    speakers: [{ id: 'speaker-1', name: 'Speaker 1' }],
    blocks: [
      { id: 't1', type: 'transcript', speakerId: 'speaker-1', text: '模型重新识别的内容', rawText: '模型重新识别的内容', userEdited: false },
      { id: 't2', type: 'transcript', speakerId: 'speaker-1', text: '新增的一段', rawText: '新增的一段' },
    ],
  })
  const merged = exports.mergeDocuments(remote, local, new Set(['t1', 'note-1', 'img-1']), new Set(['speaker-1']))
  assert.deepEqual(Array.from(merged.blocks, (block) => block.id), ['t1', 'note-1', 'img-1', 't2'])
  assert.equal(merged.blocks[0].text, '用户已经改过的内容')
  assert.equal(merged.blocks[0].userEdited, true)
  assert.equal(merged.speakers[0].name, '张三')
  assert.equal(merged.revision, 4, 'server revision remains authoritative after merge')
})

test('builds the exact revision-aware document PATCH payload', () => {
  const { exports } = loadBundle()
  const payload = exports.toDocumentPayload({ revision: 9, speakers: [{ id: 'speaker-1', name: '李四' }], blocks: [{ id: 't1', type: 'transcript', speakerId: 'speaker-1', text: '内容', userEdited: true }] }, 9)
  assert.equal(payload.baseRevision, 9)
  assert.deepEqual(JSON.parse(JSON.stringify(payload.speakerNames)), { 'speaker-1': '李四' })
  assert.equal(payload.blocks[0].userEdited, true)
})

test('recognizes native bridge availability and exposes the required native callback', () => {
  const { exports, window } = loadBundle()
  assert.equal(exports.hasNativeBridge(), false)
  const messages = []
  window.webkit = { messageHandlers: { stenographer: { postMessage: (payload) => messages.push(payload) } } }
  assert.equal(exports.hasNativeBridge(), true)
  assert.equal(typeof window.__dshStenographerNativeEvent, 'function')
  window.__dshStenographerNativeEvent({ sessionId: 'steno-1', state: 'recording' })
  assert.deepEqual(messages, [], 'native callback dispatch must not fabricate a start message')
})

test('returns GLM-5.3-Flash artifacts in-panel and uses official APIs only for optional continuation', () => {
  assert.match(source, /ctx\.sessions\.create\(\{ cwd: ['"]\/Users\/marcus\/Desktop['"] \}\)/)
  assert.match(source, /sessions\.open\(newSessionId\)/)
  assert.match(source, /directoryFor\(newSessionId\)/)
  assert.match(source, /directory\.select\(\{ provider: ['"]zhipu-glm['"], model: ['"]glm-5\.3-flash['"] \}\)/)
  assert.match(source, /input\.setDraft\(prompt\)/)
  assert.match(source, /input\.submit\(\)/)
  assert.match(source, /setArtifact\(generated\)/)
  assert.match(source, /if \(pendingDocument\) await persist\(pendingDocument\)/)
  assert.match(source, /baseRevision: revisionRef\.current/)
  assert.match(source, /artifact\.content/)
  assert.match(source, /navigator\?\.clipboard\?\.writeText/)
  assert.match(source, /复制全部/)
  assert.match(source, /在新会话中继续修改/)
  assert.doesNotMatch(source, /querySelector\s*\(/, 'must not inspect or mutate DOM controls to send')
  assert.doesNotMatch(source, /HTMLTextAreaElement|sendBtn|\.click\(\)/, 'must not use composer DOM hacks')
})

test('persists and sends the local control token for every write operation', () => {
  assert.match(source, /dsh-stenographer-control-token:/)
  assert.match(source, /rememberControlToken\(snapshot\.id, upload\.token\)/)
  assert.match(source, /'X-Stenographer-Token': token/)
  for (const operation of ['/state', '/document', '/media', '/finalize', '/handoff', "method: 'DELETE'"]) {
    assert.ok(source.includes(operation), `missing authenticated operation ${operation}`)
  }
})

test('waits for native upload flush before stopping and finalizes the latest revision', () => {
  assert.match(source, /waitForNativeStop = \(sessionId, timeoutMs = 30_000\)/)
  assert.match(source, /const nativeStopped = await stopped/)
  assert.match(source, /if \(!nativeStopped\) throw new Error/)
  assert.match(source, /const stoppedSnapshot = await updateState\(id, 'stopped'\)/)
  assert.match(source, /finalizeSession\(stoppedSnapshot\?\.revision\)/)
  assert.match(source, /baseRevision: explicitRevision \?\? revisionRef\.current/)
  assert.doesNotMatch(source, /\['recording', 'paused', 'stopping', 'failed'\]/)
  assert.match(source, /phase === 'stopping'.*继续最终校正/)
  assert.match(source, /phase === 'failed'.*重试最终校正/)
  assert.match(source, /'stopped', 'finalizing'/)
})

test('targets all v1 /sessions/:id operation endpoints and required handoff fields', () => {
  for (const operation of ['/sessions/${encodeURIComponent(id)}/document', '/sessions/${encodeURIComponent(id)}/media', '/sessions/${encodeURIComponent(id)}/finalize', '/sessions/${encodeURIComponent(id)}/handoff']) {
    assert.ok(source.includes(operation), `missing endpoint path: ${operation}`)
  }
  assert.match(source, /baseRevision/)
  assert.match(source, /customPurpose/)
  assert.match(source, /extraInstructions/)
  assert.match(source, /GLM-5\.3-Flash/)
  assert.match(source, /删除历史速记/)
  assert.match(source, /本机速记回收区/)
})
