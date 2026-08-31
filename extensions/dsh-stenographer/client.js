// @local/dsh-stenographer — 本地速记员面板（浏览器 ModuleLoader 格式）
//
// 这是一层纯客户端 UI：音频采集由大神原生 bridge 完成，转写/声纹/持久化
// 由 /api/stenographer 提供。面板不伪造录音，不通过 DOM 点击提交会话。
window.__ModuleLoader__.load({
  id: '@local/dsh-stenographer',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const inject = ['slots', 'sessions', 'conversation', 'modelDirectories']
    const API_ROOT = '/api/stenographer'
    const SAMPLE_RATE = 16000
    const MAX_IMAGE_BYTES = 10 * 1024 * 1024
    const POLL_MS = 1000
    const SESSION_LIST_MS = 5000
    // handoff_contract: 写作固定交给 zhipu-glm/glm-5.3-flash，失败不静默切换模型。

    const SOURCE_OPTIONS = [
      { value: 'microphone', label: '麦克风', hint: '只记录本机麦克风' },
      { value: 'system', label: '系统声音', hint: '记录会议软件播放的声音' },
      { value: 'both', label: '麦克风 + 系统声音', hint: '双轨记录，优先推荐线上会议' },
    ]
    const SPEAKER_OPTIONS = [
      { value: 'auto', label: '自动识别' },
      { value: '2', label: '2 人' },
      { value: '3', label: '3 人' },
      { value: '4', label: '4 人' },
      { value: '5', label: '5 人' },
    ]
    const PURPOSE_OPTIONS = [
      { value: 'meeting_minutes', label: '整理会议纪要', description: '提炼讨论结论、决定和待办' },
      { value: 'report_email', label: '编写汇报邮件', description: '整理成可以直接发送的汇报邮件' },
      { value: 'requirements_document', label: '编写需求文档', description: '整理成结构化需求和验收标准' },
      { value: 'custom', label: '自定义用途', description: '填写这份速记接下来要怎么用' },
    ]
    const PHASES = new Set(['idle', 'model_preparing', 'permission', 'recording', 'paused', 'stopping', 'finalizing', 'ready', 'failed', 'interrupted'])
    const PHASE_LABELS = {
      idle: '尚未开始',
      model_preparing: '模型准备',
      permission: '请求权限',
      recording: '正在录音',
      paused: '已暂停',
      stopping: '停止处理中',
      finalizing: '最终校正',
      ready: '已就绪',
      failed: '失败',
      interrupted: '需要恢复',
    }
    const PHASE_STATUS = {
      idle: 'idle',
      model_preparing: 'processing',
      permission: 'processing',
      recording: 'recording',
      paused: 'paused',
      stopping: 'processing',
      finalizing: 'processing',
      ready: 'ready',
      failed: 'error',
      interrupted: 'interrupted',
    }
    const REMOTE_PHASE = {
      created: 'idle',
      loading: 'model_preparing',
      recording: 'recording',
      paused: 'paused',
      stopped: 'stopping',
      interrupted: 'interrupted',
      finalizing: 'finalizing',
      ready: 'ready',
      error: 'failed',
    }

    const text = (value) => value == null ? '' : typeof value === 'string' ? value : String(value)
    const numberOr = (value, fallback = 0) => {
      const result = Number(value)
      return Number.isFinite(result) ? result : fallback
    }
    const first = (...values) => {
      for (const value of values) {
        const result = text(value).trim()
        if (result) return result
      }
      return ''
    }
    const errorMessage = (error, fallback = '请求失败') => first(error?.message, error?.error?.message, error?.error, fallback)
    const safeJson = (value) => value && typeof value === 'object' ? value : {}

    // Host 统一返回 { ok: true, ...payload } / { ok: false, error }；同时兼容
    // DSH 同源代理可能使用的 api_envelope.v1 包装，方便独立 bundle 单测。
    const unwrapApi = (value) => {
      let current = value
      for (let index = 0; index < 3; index += 1) {
        if (!current || typeof current !== 'object') return current
        if (current.ok === false) {
          const failure = safeJson(current.error)
          const error = new Error(first(failure.message, current.message, current.error, '速记服务请求失败'))
          error.code = first(failure.code, current.code)
          error.status = current.status
          throw error
        }
        if (current.schema === 'api_envelope.v1' && current.data && typeof current.data === 'object') {
          current = current.data
          continue
        }
        if (current.data && typeof current.data === 'object' && Object.keys(current).every((key) => ['ok', 'data', 'error', 'message', 'code', 'status'].includes(key))) {
          current = current.data
          continue
        }
        return current
      }
      return current
    }

    const normalizePhase = (value) => {
      const raw = text(value).trim().toLowerCase().replace(/[\s-]+/g, '_')
      if (PHASES.has(raw)) return raw
      if (raw === 'running' || raw === 'capturing' || raw === 'record') return 'recording'
      if (raw === 'prepare' || raw === 'preparing' || raw === 'loading') return 'model_preparing'
      if (raw === 'permission_request' || raw === 'requesting_permission') return 'permission'
      if (raw === 'stopped' || raw === 'stop') return 'stopping'
      if (raw === 'processing' || raw === 'reconciling') return 'finalizing'
      if (raw === 'error' || raw === 'failure' || raw === 'failed') return 'failed'
      return 'idle'
    }

    const normalizeBlock = (value, index = 0) => {
      const block = safeJson(value)
      const type = ['transcript', 'text', 'image'].includes(block.type) ? block.type : 'text'
      const id = first(block.id, `${type}-${index + 1}`)
      if (type === 'transcript') {
        return {
          ...block,
          id,
          type,
          speakerId: first(block.speakerId, block.speaker_id, 'speaker-1'),
          startMs: numberOr(block.startMs ?? block.start_ms, 0),
          endMs: numberOr(block.endMs ?? block.end_ms, numberOr(block.startMs ?? block.start_ms, 0)),
          rawText: text(block.rawText ?? block.raw_text ?? block.text),
          text: text(block.text ?? block.rawText ?? block.raw_text),
          isFinal: Boolean(block.isFinal ?? block.is_final),
          userEdited: Boolean(block.userEdited ?? block.user_edited),
          confidence: block.confidence == null ? null : numberOr(block.confidence, null),
          source: first(block.source, 'microphone'),
          lineage: block.lineage || {},
        }
      }
      if (type === 'image') {
        return {
          ...block,
          id,
          type,
          mediaId: first(block.mediaId, block.media_id),
          url: first(block.url, block.previewUrl, block.preview_url),
          caption: text(block.caption),
          createdAt: first(block.createdAt, block.created_at, new Date().toISOString()),
        }
      }
      return {
        ...block,
        id,
        type: 'text',
        text: text(block.text),
        createdAt: first(block.createdAt, block.created_at, new Date().toISOString()),
        updatedAt: first(block.updatedAt, block.updated_at, new Date().toISOString()),
      }
    }

    const normalizeDocument = (value) => {
      const document = safeJson(value)
      const blocks = Array.isArray(document.blocks) ? document.blocks.map(normalizeBlock) : []
      const speakerValues = Array.isArray(document.speakers)
        ? document.speakers
        : document.speakerNames && typeof document.speakerNames === 'object'
          ? Object.entries(document.speakerNames).map(([id, name]) => ({ id, name }))
          : []
      const speakers = speakerValues.map((speaker, index) => {
        const item = safeJson(speaker)
        const id = first(item.id, item.speakerId, `speaker-${index + 1}`)
        return { ...item, id, name: first(item.name, item.displayName, `说话人${index + 1}`) }
      })
      return { ...document, schema: document.schema || 'stenographer_document.v1', revision: numberOr(document.revision, 0), blocks, speakers }
    }

    const normalizeSession = (value) => {
      const root = unwrapApi(value)
      const session = root && root.session && typeof root.session === 'object' ? root.session : safeJson(root)
      const phase = normalizePhase(REMOTE_PHASE[text(session.state).trim().toLowerCase()] || session.state)
      const sessionSpeakers = Array.isArray(session.speakers) ? session.speakers : []
      const document = normalizeDocument(session.document)
      if (document.speakers.length === 0 && sessionSpeakers.length > 0) document.speakers = normalizeDocument({ speakers: sessionSpeakers }).speakers
      return {
        ...session,
        id: first(session.id, session.sessionId, session.session_id),
        title: first(session.title, '未命名速记'),
        state: text(session.state || 'created').toLowerCase(),
        phase,
        revision: numberOr(session.revision, numberOr(session.document?.revision, 0)),
        source: first(session.source, 'both'),
        expectedSpeakers: session.expectedSpeakers ?? session.expected_speakers ?? 'auto',
        language: first(session.language, 'zh-CN'),
        startedAt: session.startedAt || session.started_at || null,
        updatedAt: session.updatedAt || session.updated_at || null,
        endedAt: session.endedAt || session.ended_at || null,
        durationMs: numberOr(session.durationMs ?? session.duration_ms, 0),
        progress: session.progress == null ? null : numberOr(session.progress, null),
        error: session.error || null,
        nativeState: session.nativeState || session.native_state || null,
        models: session.models || {},
        speakers: sessionSpeakers,
        artifacts: Array.isArray(session.artifacts) ? session.artifacts : [],
        document,
      }
    }

    const normalizeSessionList = (value) => {
      const root = unwrapApi(value)
      const items = Array.isArray(root) ? root : Array.isArray(root?.sessions) ? root.sessions : Array.isArray(root?.items) ? root.items : []
      return items.map((item) => {
        const value = safeJson(item)
        const state = text(value.state || value.status || 'created').toLowerCase()
        return {
          ...value,
          id: first(value.id, value.sessionId, value.session_id),
          title: first(value.title, '未命名速记'),
          state,
          phase: normalizePhase(REMOTE_PHASE[state] || state),
          revision: numberOr(value.revision, 0),
          source: first(value.source, 'both'),
          durationMs: numberOr(value.durationMs ?? value.duration_ms, 0),
          updatedAt: value.updatedAt || value.updated_at || value.startedAt || value.started_at || null,
        }
      }).filter((item) => item.id)
    }

    // 轮询和原生事件都不依赖 DOM。原生回调只做事件分发，组件负责状态和请求。
    const nativeSubscribers = new Set()
    const nativeStopResolvers = new Map()
    const subscribeNative = (listener) => {
      nativeSubscribers.add(listener)
      return () => nativeSubscribers.delete(listener)
    }
    const dispatchNativeEvent = (payload) => {
      const value = payload && typeof payload === 'object' ? payload : { state: payload }
      const sessionId = first(value.sessionId, value.session_id, value.id)
      const state = normalizePhase(value.state || value.event || value.action)
      if (sessionId && ['stopping', 'ready'].includes(state)) {
        const resolve = nativeStopResolvers.get(sessionId)
        if (resolve) {
          nativeStopResolvers.delete(sessionId)
          resolve(value)
        }
      }
      for (const listener of [...nativeSubscribers]) {
        try { listener({ ...value, sessionId, phase: state }) } catch { /* 一个订阅者失败不影响其他面板 */ }
      }
    }
    const installNativeCallback = () => {
      if (typeof window === 'undefined') return
      const current = window.__dshStenographerNativeEvent
      if (current && current.__dshStenographerDispatcher) return
      const previous = typeof current === 'function' ? current : null
      const callback = (payload) => {
        try { previous?.(payload) } catch { /* preserve existing bridge callback */ }
        dispatchNativeEvent(payload)
      }
      callback.__dshStenographerDispatcher = true
      window.__dshStenographerNativeEvent = callback
    }
    installNativeCallback()

    const hasNativeBridge = () => Boolean(typeof window !== 'undefined' && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.stenographer && typeof window.webkit.messageHandlers.stenographer.postMessage === 'function')
    const nativeBridge = () => hasNativeBridge() ? window.webkit.messageHandlers.stenographer : null
    const postNative = (payload) => {
      const bridge = nativeBridge()
      if (!bridge) throw new Error('仅大神 App 可用：当前浏览器没有速记员原生录音桥接')
      bridge.postMessage(payload)
    }
    const waitForNativeStop = (sessionId, timeoutMs = 30_000) => new Promise((resolve) => {
      const timer = setTimeout(() => {
        nativeStopResolvers.delete(sessionId)
        resolve(null)
      }, timeoutMs)
      nativeStopResolvers.set(sessionId, (event) => {
        clearTimeout(timer)
        resolve(event)
      })
    })

    const request = async (path, options = {}) => {
      const response = await fetch(`${API_ROOT}${path}`, {
        cache: 'no-store',
        ...options,
        headers: { Accept: 'application/json', ...(options.body instanceof ArrayBuffer ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) },
      })
      const contentType = response.headers?.get?.('content-type') || ''
      let value
      if (contentType.includes('json')) value = await response.json()
      else value = await response.text()
      if (!response.ok) {
        const root = safeJson(value)
        const failure = safeJson(root.error)
        const error = new Error(first(failure.message, root.message, root.error, `速记服务请求失败（${response.status}）`))
        error.code = first(failure.code, root.code)
        error.status = response.status
        throw error
      }
      return unwrapApi(value)
    }

    const tokenStorageKey = (id) => `dsh-stenographer-control-token:${text(id)}`
    const rememberControlToken = (id, token) => {
      if (!id || !token) return
      try { window.localStorage.setItem(tokenStorageKey(id), token) } catch { /* private mode still works for this process */ }
    }
    const forgetControlToken = (id) => {
      if (!id) return
      try { window.localStorage.removeItem(tokenStorageKey(id)) } catch { /* best effort */ }
    }
    const persistedControlToken = (id) => {
      if (!id) return ''
      try { return text(window.localStorage.getItem(tokenStorageKey(id))) } catch { return '' }
    }

    const toDocumentPayload = (document, baseRevision) => {
      const value = normalizeDocument(document)
      return {
        baseRevision: numberOr(baseRevision, numberOr(value.revision, 0)),
        blocks: value.blocks,
        speakerNames: Object.fromEntries((value.speakers || []).map((speaker) => [speaker.id, speaker.name])),
      }
    }

    const mergeDocuments = (remoteValue, localValue, dirtyIds = new Set(), dirtySpeakers = new Set()) => {
      const remote = normalizeDocument(remoteValue)
      const local = normalizeDocument(localValue)
      const remoteById = new Map(remote.blocks.map((block) => [block.id, block]))
      const localIds = new Set(local.blocks.map((block) => block.id))
      const blocks = []
      // Use the local order as the anchor. This protects inserted text/image blocks
      // while allowing new server transcript blocks to append in timestamp order.
      for (const localBlock of local.blocks) {
        const remoteBlock = remoteById.get(localBlock.id)
        if (!remoteBlock) {
          blocks.push(localBlock)
          continue
        }
        if (dirtyIds.has(localBlock.id) || (localBlock.type === 'transcript' && localBlock.userEdited)) {
          blocks.push({ ...remoteBlock, ...localBlock, userEdited: localBlock.type === 'transcript' ? true : localBlock.userEdited })
        } else {
          blocks.push(remoteBlock)
        }
      }
      for (const remoteBlock of remote.blocks) if (!localIds.has(remoteBlock.id)) blocks.push(remoteBlock)
      const localSpeakers = new Map(local.speakers.map((speaker) => [speaker.id, speaker]))
      const speakers = remote.speakers.map((speaker) => {
        const localSpeaker = localSpeakers.get(speaker.id)
        return localSpeaker && dirtySpeakers.has(speaker.id) ? { ...speaker, ...localSpeaker } : speaker
      })
      for (const speaker of local.speakers) if (!speakers.some((item) => item.id === speaker.id)) speakers.push(speaker)
      return { ...remote, ...local, revision: remote.revision, blocks, speakers, schema: 'stenographer_document.v1' }
    }

    const formatTime = (ms) => {
      const value = Math.max(0, numberOr(ms, 0))
      const seconds = Math.floor(value / 1000)
      const minutes = Math.floor(seconds / 60)
      const rest = seconds % 60
      return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    }
    const formatDuration = (value) => {
      const ms = numberOr(value, 0)
      if (ms <= 0) return '00:00'
      return formatTime(ms)
    }
    const formatDate = (value) => {
      if (!value) return '时间未知'
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    }
    const statusTone = (phase) => PHASE_STATUS[normalizePhase(phase)] || 'idle'

    const icon = (kind, props = {}) => {
      const common = { viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': true, ...props }
      if (kind === 'mic') return h('svg', common, h('rect', { x: '7', y: '2.5', width: '6', height: '10', rx: '3', fill: 'currentColor' }), h('path', { d: 'M4.5 10.5v.5a5.5 5.5 0 0 0 11 0v-.5M10 16.5v2M7.5 18.5h5', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round' }))
      if (kind === 'pause') return h('svg', common, h('rect', { x: '5', y: '4', width: '3', height: '12', rx: '1', fill: 'currentColor' }), h('rect', { x: '12', y: '4', width: '3', height: '12', rx: '1', fill: 'currentColor' }))
      if (kind === 'play') return h('svg', common, h('path', { d: 'm7 4 8 6-8 6V4Z', fill: 'currentColor' }))
      if (kind === 'stop') return h('svg', common, h('rect', { x: '4.5', y: '4.5', width: '11', height: '11', rx: '2', fill: 'currentColor' }))
      if (kind === 'image') return h('svg', common, h('rect', { x: '2.5', y: '3.5', width: '15', height: '13', rx: '2', stroke: 'currentColor', strokeWidth: '1.4' }), h('circle', { cx: '7', cy: '7.5', r: '1.3', fill: 'currentColor' }), h('path', { d: 'm4.5 14 3.5-3.5 2.5 2 2-2.5 3 4', stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round', strokeLinejoin: 'round' }))
      if (kind === 'text') return h('svg', common, h('path', { d: 'M4 5h12M4 9h8M4 13h12M4 17h7', stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round' }))
      if (kind === 'history') return h('svg', common, h('path', { d: 'M4 7a6 6 0 1 1-.6 5.4M4 3v4h4', stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round', strokeLinejoin: 'round' }), h('path', { d: 'M10 7v3l2 1.5', stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round' }))
      if (kind === 'close') return h('svg', common, h('path', { d: 'm5 5 10 10M15 5 5 15', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round' }))
      if (kind === 'plus') return h('svg', common, h('path', { d: 'M10 4v12M4 10h12', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round' }))
      if (kind === 'refresh') return h('svg', common, h('path', { d: 'M15.5 6.5A6 6 0 1 0 16 12', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round' }), h('path', { d: 'M15.5 3v3.5H12', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round' }))
      if (kind === 'trash') return h('svg', common, h('path', { d: 'M4.5 6h11M8 3.5h4M6.5 6l.7 10h5.6l.7-10M9 9v4M11 9v4', stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round', strokeLinejoin: 'round' }))
      if (kind === 'copy') return h('svg', common, h('rect', { x: '6.5', y: '6.5', width: '9', height: '10', rx: '2', stroke: 'currentColor', strokeWidth: '1.4' }), h('path', { d: 'M4.5 13.5h-1a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1', stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round' }))
      return h('svg', common, h('circle', { cx: '10', cy: '10', r: '7', stroke: 'currentColor', strokeWidth: '1.4' }))
    }

    function StatusLamp({ phase, label }) {
      const normalized = normalizePhase(phase)
      return h('span', { className: `dsh-steno-lamp is-${statusTone(normalized)}`, 'aria-label': label || PHASE_LABELS[normalized], role: 'img' }, h('span', { className: 'dsh-steno-lamp-dot', 'aria-hidden': true }), h('span', null, label || PHASE_LABELS[normalized]))
    }

    function SourcePicker({ value, onChange, disabled }) {
      return h('fieldset', { className: 'dsh-steno-fieldset', disabled, 'aria-label': '录音来源' },
        h('legend', null, '录音来源'),
        h('div', { className: 'dsh-steno-source-grid' }, SOURCE_OPTIONS.map((option) => h('label', { key: option.value, className: `dsh-steno-source-card${value === option.value ? ' is-selected' : ''}` },
          h('input', { type: 'radio', name: 'stenographer-source', value: option.value, checked: value === option.value, onChange: () => onChange(option.value) }),
          h('span', { className: 'dsh-steno-source-icon', 'aria-hidden': true }, icon(option.value === 'microphone' ? 'mic' : option.value === 'system' ? 'text' : 'mic')),
          h('span', { className: 'dsh-steno-source-copy' }, h('strong', null, option.label), h('small', null, option.hint)),
        )))
      )
    }

    function SpeakerPicker({ value, onChange, disabled }) {
      return h('label', { className: 'dsh-steno-select-row' }, h('span', null, '预计人数'), h('select', { value, onChange: (event) => onChange(event.target.value), disabled, 'aria-label': '预计人数' }, SPEAKER_OPTIONS.map((option) => h('option', { key: option.value, value: option.value }, option.label))))
    }

    function BlockEditor({ document, selectedBlockId, onSelect, onEditText, onRenameSpeaker, onInsertText, onInsertImage, disabled }) {
      const speakers = new Map((document?.speakers || []).map((speaker) => [speaker.id, speaker.name]))
      const blocks = Array.isArray(document?.blocks) ? document.blocks : []
      return h('section', { className: 'dsh-steno-editor', 'aria-label': '速记内容编辑器' },
        h('div', { className: 'dsh-steno-editor-head' }, h('div', null, h('h2', null, '实时记录'), h('p', null, blocks.length ? `${blocks.length} 个记录块 · 自动保存` : '说话后会在这里出现记录')), h('div', { className: 'dsh-steno-editor-tools' },
          h('button', { type: 'button', className: 'dsh-steno-tool-button', onClick: onInsertText, disabled, title: '在当前选中块后插入文字', 'aria-label': '插入文字' }, icon('text'), '文字'),
          h('label', { className: 'dsh-steno-tool-button', title: '在当前选中块后插入图片', 'aria-label': '插入图片' }, icon('image'), '图片', h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, disabled, onChange: (event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onInsertImage(file) } })),
        )),
        blocks.length === 0 ? h('div', { className: 'dsh-steno-editor-empty' }, h('span', { className: 'dsh-steno-empty-mark', 'aria-hidden': true }, icon('mic')), h('strong', null, '等待语音'), h('p', null, '点击“开始速记”后，这里会实时显示带说话人的记录。')) : null,
        h('div', { className: 'dsh-steno-block-list', role: 'list' }, blocks.map((block) => {
          const selected = selectedBlockId === block.id
          if (block.type === 'image') return h('article', { key: block.id, className: `dsh-steno-block dsh-steno-image-block${selected ? ' is-selected' : ''}`, role: 'listitem', tabIndex: 0, onClick: () => onSelect(block.id), onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(block.id) } } },
            block.url ? h('img', { src: block.url, alt: block.caption || '插入的图片' }) : h('div', { className: 'dsh-steno-image-placeholder' }, icon('image'), h('span', null, block.mediaId ? '图片已保存' : '图片上传中')),
            h('input', { className: 'dsh-steno-caption-input', value: block.caption || '', placeholder: '添加图片说明（可选）', disabled, onChange: (event) => onEditText(block.id, event.target.value, 'caption'), onClick: (event) => event.stopPropagation(), 'aria-label': '图片说明' }),
          )
          const speaker = block.type === 'transcript' ? first(speakers.get(block.speakerId), block.speakerId, '说话人') : ''
          return h('article', { key: block.id, className: `dsh-steno-block dsh-steno-${block.type}-block${selected ? ' is-selected' : ''}`, role: 'listitem', tabIndex: 0, onClick: () => onSelect(block.id), onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(block.id) } } },
            block.type === 'transcript' ? h('div', { className: 'dsh-steno-block-meta' }, h('label', { className: 'dsh-steno-speaker' }, h('span', { className: 'dsh-steno-speaker-dot', 'aria-hidden': true }), h('input', { value: speaker, disabled, 'aria-label': '说话人名称', onClick: (event) => event.stopPropagation(), onChange: (event) => onRenameSpeaker(block.speakerId, event.target.value), onBlur: (event) => onRenameSpeaker(block.speakerId, event.target.value) })), h('span', { className: 'dsh-steno-block-time' }, `${formatTime(block.startMs)} – ${formatTime(block.endMs)}`), block.isFinal ? h('span', { className: 'dsh-steno-block-badge is-final' }, '最终') : h('span', { className: 'dsh-steno-block-badge is-live' }, '临时'), block.uncertain || block.speakerUncertain ? h('span', { className: 'dsh-steno-block-badge is-uncertain' }, '不确定') : null) : h('div', { className: 'dsh-steno-block-meta' }, h('span', { className: 'dsh-steno-block-badge is-note' }, '文字备注')),
            h('textarea', { value: block.text || '', rows: Math.max(2, Math.min(7, Math.ceil((block.text || '').length / 34))), disabled, 'aria-label': block.type === 'transcript' ? `${speaker} 的语音转写` : '文字备注', onClick: (event) => event.stopPropagation(), onChange: (event) => onEditText(block.id, event.target.value, 'text') }),
            block.type === 'transcript' && block.userEdited ? h('span', { className: 'dsh-steno-edited-note' }, '已手动修改，后续校正不会覆盖') : null,
          )
        })),
      )
    }

    function HistoryList({ items, selectedId, onSelect, onDelete, loading, onRefresh }) {
      return h('section', { className: 'dsh-steno-history', 'aria-label': '历史速记' },
        h('div', { className: 'dsh-steno-section-title' }, h('div', null, h('h2', null, '历史速记'), h('p', null, '可重新打开已就绪或中断的记录')), h('button', { type: 'button', className: 'dsh-steno-icon-button', onClick: onRefresh, disabled: loading, title: '刷新历史速记', 'aria-label': '刷新历史速记' }, icon('refresh'))),
        loading ? h('p', { className: 'dsh-steno-muted' }, '正在读取历史…') : items.length === 0 ? h('p', { className: 'dsh-steno-muted' }, '还没有历史速记') : h('ul', { className: 'dsh-steno-history-list' }, items.map((item) => h('li', { key: item.id, className: 'dsh-steno-history-row' },
          h('button', { type: 'button', className: `dsh-steno-history-item${item.id === selectedId ? ' is-selected' : ''}`, onClick: () => onSelect(item.id), 'aria-current': item.id === selectedId ? 'true' : undefined }, h('span', { className: `dsh-steno-history-state is-${statusTone(item.phase)}`, 'aria-hidden': true }), h('span', { className: 'dsh-steno-history-copy' }, h('strong', null, item.title), h('small', null, `${PHASE_LABELS[item.phase] || item.state} · ${formatDuration(item.durationMs)} · ${formatDate(item.updatedAt)}`)), h('span', { className: 'dsh-steno-history-arrow', 'aria-hidden': true }, '›')),
          h('button', { type: 'button', className: 'dsh-steno-history-delete', onClick: () => onDelete(item.id), disabled: ['recording', 'paused', 'finalizing', 'model_preparing'].includes(item.phase), title: '删除这条历史速记', 'aria-label': `删除历史速记：${item.title}` }, icon('trash')),
        ))),
      )
    }

    function HandoffSection({ purpose, setPurpose, customPurpose, setCustomPurpose, extraInstructions, setExtraInstructions, onSubmit, onCopy, onContinue, artifact, copyNotice, busy, disabled, error, notice }) {
      const customMissing = purpose === 'custom' && !customPurpose.trim()
      const actionLabel = { meeting_minutes: '生成会议纪要', report_email: '生成汇报邮件', requirements_document: '生成需求文档', custom: '生成加工结果' }[purpose]
      return h('section', { className: 'dsh-steno-handoff', 'aria-label': '接下来要做什么' },
        h('div', { className: 'dsh-steno-section-title' }, h('div', null, h('h2', null, '接下来要做什么'), h('p', null, 'GLM-5.3-Flash 会读取完整速记，并把成品直接返回这里')), h('span', { className: 'dsh-steno-local-badge' }, 'GLM-5.3-Flash')),
        h('div', { className: 'dsh-steno-purpose-grid' }, PURPOSE_OPTIONS.map((option) => h('label', { key: option.value, className: `dsh-steno-purpose-card${purpose === option.value ? ' is-selected' : ''}` }, h('input', { type: 'radio', name: 'stenographer-purpose', value: option.value, checked: purpose === option.value, disabled, onChange: () => setPurpose(option.value) }), h('span', null, h('strong', null, option.label), h('small', null, option.description))))),
        purpose === 'custom' ? h('label', { className: 'dsh-steno-input-label' }, '自定义用途（必填）', h('input', { value: customPurpose, disabled, placeholder: '例如：提取产品风险和负责人', onChange: (event) => setCustomPurpose(event.target.value), 'aria-required': 'true' })) : null,
        h('label', { className: 'dsh-steno-input-label' }, '补充要求（可选）', h('textarea', { value: extraInstructions, disabled, rows: 3, placeholder: '例如：保留原话中的数字；按负责人和截止时间列出待办', onChange: (event) => setExtraInstructions(event.target.value) })),
        error ? h('p', { className: 'dsh-steno-inline-error', role: 'alert' }, error) : null,
        notice ? h('p', { className: 'dsh-steno-inline-notice', role: 'status' }, notice) : null,
        artifact?.content ? h('div', { className: 'dsh-steno-artifact', 'aria-label': '生成结果' },
          h('div', { className: 'dsh-steno-artifact-head' }, h('strong', null, artifact.title || '生成结果'), h('button', { type: 'button', className: 'dsh-steno-secondary-button dsh-steno-copy-button', onClick: onCopy }, icon('copy'), copyNotice || '复制全部')),
          h('pre', { className: 'dsh-steno-artifact-content' }, artifact.content),
          h('button', { type: 'button', className: 'dsh-steno-secondary-button dsh-steno-continue-button', disabled: busy, onClick: onContinue }, '在新会话中继续修改'),
        ) : null,
        h('button', { type: 'button', className: 'dsh-steno-primary-button dsh-steno-handoff-button', disabled: disabled || busy || customMissing, onClick: onSubmit }, busy ? 'GLM-5.3-Flash 正在生成…' : artifact?.content ? `重新${actionLabel}` : actionLabel),
      )
    }

    function StenographerPanel({ state, actions }) {
      const { open, session, document, phase, source, expectedSpeakers, selectedBlockId, history, historyLoading, purpose, customPurpose, extraInstructions, artifact, copyNotice, busy, error, handoffError, handoffNotice, bridgeAvailable } = state
      if (!open) return null
      const currentId = session?.id || ''
      const canEdit = Boolean(currentId) && !['stopping', 'finalizing'].includes(phase)
      const canStart = ['idle', 'ready', 'failed', 'interrupted'].includes(phase) && !currentId
      const isRecording = phase === 'recording'
      const isPaused = phase === 'paused'
      const isFinal = phase === 'ready'
      const recordingControls = h('div', { className: 'dsh-steno-recording-controls' },
        isRecording ? h('button', { type: 'button', className: 'dsh-steno-secondary-button', disabled: busy, onClick: actions.pauseRecording }, icon('pause'), '暂停') : null,
        isPaused ? h('button', { type: 'button', className: 'dsh-steno-secondary-button', disabled: busy, onClick: actions.resumeRecording }, icon('play'), '继续') : null,
        ['recording', 'paused'].includes(phase) ? h('button', { type: 'button', className: 'dsh-steno-stop-button', disabled: busy, onClick: actions.stopRecording }, icon('stop'), '结束速记') : null,
        phase === 'stopping' ? h('button', { type: 'button', className: 'dsh-steno-primary-button', disabled: busy, onClick: actions.finalizeSession }, '继续最终校正') : null,
        phase === 'failed' && currentId ? h('button', { type: 'button', className: 'dsh-steno-primary-button', disabled: busy, onClick: actions.finalizeSession }, '重试最终校正') : null,
        phase === 'interrupted' ? h('button', { type: 'button', className: 'dsh-steno-primary-button', disabled: busy || !bridgeAvailable, onClick: actions.resumeInterrupted }, icon('play'), '安全恢复') : null,
        phase === 'interrupted' ? h('button', { type: 'button', className: 'dsh-steno-secondary-button', disabled: busy, onClick: actions.finalizeSession }, '结束并校正') : null,
      )
      const currentContent = currentId
        ? h(React.Fragment, null,
          h(BlockEditor, { document, selectedBlockId, onSelect: actions.setSelectedBlockId, onEditText: actions.editBlock, onRenameSpeaker: actions.renameSpeaker, onInsertText: actions.insertText, onInsertImage: actions.insertImage, disabled: !canEdit || busy }),
          recordingControls,
          isFinal ? h(HandoffSection, { purpose, setPurpose: actions.setPurpose, customPurpose, setCustomPurpose: actions.setCustomPurpose, extraInstructions, setExtraInstructions: actions.setExtraInstructions, onSubmit: actions.handoff, onCopy: actions.copyArtifact, onContinue: actions.continueArtifact, artifact, copyNotice, busy, disabled: busy, error: handoffError, notice: handoffNotice }) : null,
          phase === 'failed' ? h('div', { className: 'dsh-steno-error-card', role: 'alert' }, h('strong', null, '速记没有正常完成'), h('p', null, error || errorMessage(session?.error, '请检查权限、模型服务和本地磁盘后重试。')), h('button', { type: 'button', className: 'dsh-steno-secondary-button', onClick: actions.reloadCurrent }, icon('refresh'), '重新读取')) : null,
        )
        : null
      const startContent = !currentId
        ? h('section', { className: 'dsh-steno-start-section' },
          h('div', { className: 'dsh-steno-section-title' }, h('div', null, h('h2', null, '开始一场速记'), h('p', null, '录音会在本机保存，面板关闭不会停止'))),
          h(SourcePicker, { value: source, onChange: actions.setSource, disabled: busy }),
          h(SpeakerPicker, { value: expectedSpeakers, onChange: actions.setExpectedSpeakers, disabled: busy }),
          !bridgeAvailable ? h('p', { className: 'dsh-steno-bridge-warning', role: 'alert' }, '仅大神 App 可用：当前环境没有原生录音桥，点击开始不会伪造录音。') : null,
          h('button', { type: 'button', className: 'dsh-steno-primary-button', disabled: !canStart || busy, onClick: actions.startRecording }, busy && phase === 'model_preparing' ? '正在准备模型…' : '开始速记'),
        )
        : null
      return h('div', { className: 'dsh-steno-overlay', role: 'presentation' },
        h('div', { className: 'dsh-steno-backdrop', 'aria-hidden': true, onClick: actions.closePanel }),
        h('aside', { className: 'dsh-steno-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': '速记员', onKeyDown: (event) => { if (event.key === 'Escape') { event.preventDefault(); actions.closePanel() } } },
          h('header', { className: 'dsh-steno-panel-header' }, h('div', { className: 'dsh-steno-panel-heading' }, h('span', { className: 'dsh-steno-panel-mark', 'aria-hidden': true }, icon('mic')), h('div', null, h('h1', null, '速记员'), h('p', null, currentId ? (session?.title || '当前速记') : '一眼看清录音、保存和说话人'))), h('div', { className: 'dsh-steno-panel-header-actions' }, ['ready', 'failed'].includes(phase) ? h('button', { type: 'button', className: 'dsh-steno-secondary-button dsh-steno-new-button', onClick: actions.newRecording, title: '保留当前记录并新建一场速记' }, icon('plus'), '新建') : null, h('button', { type: 'button', className: 'dsh-steno-close-button', onClick: actions.closePanel, title: '关闭面板（不会停止录音）', 'aria-label': '关闭速记员面板，不停止录音' }, icon('close')))),
          h('div', { className: 'dsh-steno-status-bar', 'data-tone': statusTone(phase) }, h(StatusLamp, { phase, label: PHASE_LABELS[phase] }), h('span', { className: 'dsh-steno-status-detail' }, actions.statusDetail()), currentId ? h('span', { className: 'dsh-steno-save-state', role: 'status' }, state.saving ? '保存中…' : state.savedAt ? `已保存 ${formatDate(state.savedAt)}` : '等待保存') : null),
          h('main', { className: 'dsh-steno-panel-body' },
            startContent,
            currentContent,
            h(HistoryList, { items: history, selectedId: currentId, onSelect: actions.selectSession, onDelete: actions.deleteSession, loading: historyLoading, onRefresh: actions.loadHistory }),
          ),
          h('footer', { className: 'dsh-steno-panel-footer' }, h('span', null, currentId ? `记录 ID：${currentId.slice(0, 12)}` : '录音和转写均留在本机'), currentId && session?.models ? h('span', null, first(session.models?.stt?.modelId, session.models?.speaker?.modelId ? 'Whisper + FunASR' : '', '本地模型')) : null),
        ),
      )
    }

    function StenographerUtility(props) {
      const ctx = props?.__dshContext || {}
      const conversationSessionId = first(props?.sessionId, props?.session?.sessionId, props?.session?.id)
      const [open, setOpen] = React.useState(false)
      const [session, setSession] = React.useState(null)
      const [document, setDocument] = React.useState(normalizeDocument(null))
      const [phase, setPhase] = React.useState('idle')
      const [source, setSource] = React.useState('both')
      const [expectedSpeakers, setExpectedSpeakers] = React.useState('auto')
      const [selectedBlockId, setSelectedBlockId] = React.useState('')
      const [history, setHistory] = React.useState([])
      const [historyLoading, setHistoryLoading] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [savedAt, setSavedAt] = React.useState(null)
      const [error, setError] = React.useState('')
      const [purpose, setPurpose] = React.useState('meeting_minutes')
      const [customPurpose, setCustomPurpose] = React.useState('')
      const [extraInstructions, setExtraInstructions] = React.useState('')
      const [handoffError, setHandoffError] = React.useState('')
      const [handoffNotice, setHandoffNotice] = React.useState('')
      const [artifact, setArtifact] = React.useState(null)
      const [copyNotice, setCopyNotice] = React.useState('')
      const localDocumentRef = React.useRef(normalizeDocument(null))
      const dirtyIdsRef = React.useRef(new Set())
      const dirtySpeakersRef = React.useRef(new Set())
      const activeSessionRef = React.useRef('')
      const generationRef = React.useRef(0)
      const pollBusyRef = React.useRef(false)
      const handoffBusyRef = React.useRef(false)
      const lastHandoffRef = React.useRef(null)
      // Reuse a target session when model selection or draft admission fails.
      // Retrying the same handoff must not create blank duplicate sessions.
      const handoffTargetRef = React.useRef(new Map())
      const controlTokensRef = React.useRef(new Map())
      const audioSeqRef = React.useRef({ microphone: 0, system: 0 })
      const revisionRef = React.useRef(0)
      const saveQueueRef = React.useRef(Promise.resolve())
      const saveTimerRef = React.useRef(null)
      const pendingSaveRef = React.useRef(null)
      const bridgeAvailable = hasNativeBridge()
      const tokenForSession = React.useCallback((id) => {
        const token = text(controlTokensRef.current.get(id) || persistedControlToken(id))
        if (token) controlTokensRef.current.set(id, token)
        return token
      }, [])
      const authorizedRequest = React.useCallback((path, options = {}, id = activeSessionRef.current) => {
        const token = tokenForSession(id)
        if (!token) throw new Error('这份速记的本地控制凭证不可用，无法执行写入；请重新开始一场速记。')
        return request(path, { ...options, headers: { ...(options.headers || {}), 'X-Stenographer-Token': token } })
      }, [tokenForSession])

      React.useEffect(() => () => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
        pendingSaveRef.current = null
      }, [])

      const replaceDocument = React.useCallback((nextDocument, { preserveDirty = true } = {}) => {
        const normalized = normalizeDocument(nextDocument)
        const merged = preserveDirty
          ? mergeDocuments(normalized, localDocumentRef.current, dirtyIdsRef.current, dirtySpeakersRef.current)
          : normalized
        localDocumentRef.current = merged
        setDocument(merged)
        setSelectedBlockId((current) => merged.blocks.some((block) => block.id === current) ? current : merged.blocks[0]?.id || '')
        return merged
      }, [])

      const applySnapshot = React.useCallback((snapshot, { preserveDirty = true } = {}) => {
        const normalized = normalizeSession(snapshot)
        if (!normalized.id) return null
        const current = localDocumentRef.current
        const merged = preserveDirty ? mergeDocuments(normalized.document, current, dirtyIdsRef.current, dirtySpeakersRef.current) : normalized.document
        localDocumentRef.current = merged
        setDocument(merged)
        setSession((old) => ({ ...old, ...normalized, document: merged }))
        const latestArtifact = [...(normalized.artifacts || [])].reverse().find((item) => item?.status === 'ready' && item?.content)
        setArtifact(latestArtifact || null)
        setCopyNotice('')
        revisionRef.current = normalized.revision
        setPhase((old) => {
          // Local optimistic preparation/stop state wins over an old snapshot.
          if (old === 'permission' && normalized.phase === 'idle') return old
          if (old === 'recording' && ['idle', 'model_preparing', 'permission'].includes(normalized.phase)) return old
          if (old === 'paused' && ['idle', 'model_preparing', 'permission', 'recording'].includes(normalized.phase)) return old
          if (old === 'stopping' && ['idle', 'recording', 'paused'].includes(normalized.phase)) return old
          return normalized.phase
        })
        setSource(normalized.source || 'both')
        setExpectedSpeakers(text(normalized.expectedSpeakers || 'auto'))
        if (normalized.error) setError(errorMessage(normalized.error, '速记服务返回错误'))
        return normalized
      }, [])

      const readSession = React.useCallback(async (id = activeSessionRef.current) => {
        if (!id) return null
        const generation = generationRef.current
        const value = await request(`/sessions/${encodeURIComponent(id)}`)
        if (generation !== generationRef.current) return null
        return applySnapshot(value)
      }, [applySnapshot])

      const loadHistory = React.useCallback(async () => {
        setHistoryLoading(true)
        try {
          const value = await request('/sessions')
          setHistory(normalizeSessionList(value).sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0)))
        } catch (cause) {
          setError(errorMessage(cause, '历史速记读取失败'))
        } finally {
          setHistoryLoading(false)
        }
      }, [])

      const selectSession = React.useCallback(async (id) => {
        const value = text(id).trim()
        if (!value) return
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
        pendingSaveRef.current = null
        generationRef.current += 1
        activeSessionRef.current = value
        dirtyIdsRef.current = new Set()
        dirtySpeakersRef.current = new Set()
        localDocumentRef.current = normalizeDocument(null)
        revisionRef.current = 0
        setSession(null)
        setDocument(normalizeDocument(null))
        setArtifact(null)
        setCopyNotice('')
        setPhase('model_preparing')
        setError('')
        try {
          await readSession(value)
        } catch (cause) {
          setPhase('failed')
          setError(errorMessage(cause, '速记读取失败'))
        }
      }, [readSession])

      const discoverCurrent = React.useCallback(async () => {
        try {
          const value = await request('/sessions')
          const items = normalizeSessionList(value)
          setHistory(items.sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0)))
          if (!activeSessionRef.current && conversationSessionId) {
            // API v1 没有把对话 ID写进 recording session；优先恢复最近的未结束记录，
            // 但不自动恢复录音，只把它显示为“需要恢复”。
            const candidate = items.find((item) => ['interrupted', 'recording', 'paused', 'stopped', 'finalizing'].includes(item.state))
            if (candidate) {
              activeSessionRef.current = candidate.id
              await readSession(candidate.id)
            }
          }
        } catch (cause) {
          if (open) setError(errorMessage(cause, '速记服务暂不可用'))
        }
      }, [conversationSessionId, open, readSession])

      React.useEffect(() => {
        installNativeCallback()
        const unsubscribe = subscribeNative((event) => {
          const active = activeSessionRef.current
          if (!active || (event.sessionId && event.sessionId !== active)) return
          const eventPhase = normalizePhase(event.phase || event.state || event.event)
          if (eventPhase !== 'idle') setPhase(eventPhase)
          if (event.error) setError(errorMessage(event.error, '原生录音失败'))
          const chunk = event.audioChunk || event.audio_chunk || event.chunk
          if (chunk && typeof chunk === 'object') void uploadAudioChunk(active, chunk).catch((cause) => setError(errorMessage(cause, '音频片段保存失败')))
          // `stopRecording` owns the stopped -> finalize transaction. Posting a
          // second stopped state here advances the Host revision before the
          // finalizer reads it and can leave the panel waiting for a manual
          // "继续最终校正" click.
          if (['recording', 'paused', 'failed'].includes(eventPhase)) void authorizedRequest(`/sessions/${encodeURIComponent(active)}/state`, { method: 'POST', body: JSON.stringify({ state: eventPhase === 'failed' ? 'error' : eventPhase, error: event.error || undefined }) }, active).catch((cause) => setError(errorMessage(cause, '录音状态保存失败')))
          if (eventPhase === 'ready') void readSession(active).catch(() => {})
        })
        return unsubscribe
      }, [authorizedRequest, readSession])

      const uploadAudioChunk = async (id, chunk) => {
        const sourceName = ['microphone', 'system'].includes(text(chunk.source)) ? text(chunk.source) : 'microphone'
        const seq = Number.isFinite(Number(chunk.seq)) ? Number(chunk.seq) : audioSeqRef.current[sourceName] + 1
        audioSeqRef.current[sourceName] = Math.max(audioSeqRef.current[sourceName] || 0, seq)
        const base64 = first(chunk.dataBase64, chunk.base64, chunk.data)
        if (!base64) return
        const binary = typeof atob === 'function' ? atob(base64.replace(/^data:[^;]+;base64,/, '')) : ''
        if (!binary) return
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
        if (bytes.byteLength > 1048576) throw new Error('音频片段超过 1 MiB 限制')
        await authorizedRequest(`/sessions/${encodeURIComponent(id)}/audio?source=${encodeURIComponent(sourceName)}&seq=${encodeURIComponent(seq)}&capturedAtMs=${encodeURIComponent(numberOr(chunk.capturedAtMs ?? chunk.captured_at_ms, Date.now()))}`, { method: 'POST', body: bytes.buffer, headers: { 'Content-Type': 'application/octet-stream' } }, id)
      }

      React.useEffect(() => {
        if (!open) return undefined
        void loadHistory()
        const timer = setInterval(() => { void loadHistory() }, SESSION_LIST_MS)
        return () => clearInterval(timer)
      }, [open, loadHistory])

      React.useEffect(() => {
        if (!activeSessionRef.current) {
          void discoverCurrent()
          return undefined
        }
        let alive = true
        const poll = async () => {
          if (!alive || pollBusyRef.current) return
          const active = activeSessionRef.current
          if (!active) return
          pollBusyRef.current = true
          try { await readSession(active) } catch (cause) { if (alive && phase !== 'recording') setError(errorMessage(cause, '速记状态读取失败')) } finally { pollBusyRef.current = false }
        }
        void poll()
        const timer = setInterval(poll, POLL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [activeSessionRef.current, open, phase, readSession, discoverCurrent])

      React.useEffect(() => {
        if (!conversationSessionId) return undefined
        // 切换会话时只切换面板上下文；原生录音和 activeSessionRef 不会被关闭。
        return undefined
      }, [conversationSessionId])

      const persist = React.useCallback(async (nextDocument = localDocumentRef.current) => {
        const id = activeSessionRef.current
        if (!id) return
        const save = async () => {
          setSaving(true)
          try {
            const value = await authorizedRequest(`/sessions/${encodeURIComponent(id)}/document`, { method: 'PATCH', body: JSON.stringify(toDocumentPayload(nextDocument, revisionRef.current ?? nextDocument.revision)) }, id)
            const normalized = applySnapshot(value)
            revisionRef.current = numberOr(normalized?.revision, revisionRef.current)
            setSavedAt(Date.now())
            if (normalized?.revision != null) setSession((old) => old ? { ...old, revision: normalized.revision } : old)
          } catch (cause) {
            if (cause.code === 'REVISION_CONFLICT') {
              setError('记录版本发生变化，已保留你的编辑；请稍后重试保存。')
            } else setError(errorMessage(cause, '编辑保存失败'))
            throw cause
          } finally {
            setSaving(false)
          }
        }
        // Serialize PATCH requests so fast typing cannot send multiple stale
        // baseRevision values concurrently. A failed request does not break the
        // queue; the next user edit may still try again.
        const queued = saveQueueRef.current.catch(() => {}).then(save)
        saveQueueRef.current = queued.catch(() => {})
        return queued
      }, [applySnapshot])

      const schedulePersist = React.useCallback((nextDocument) => {
        pendingSaveRef.current = nextDocument
        if (saveTimerRef.current) return
        saveTimerRef.current = setTimeout(() => {
          saveTimerRef.current = null
          const pending = pendingSaveRef.current
          pendingSaveRef.current = null
          if (pending) void persist(pending).catch(() => {})
        }, 260)
      }, [persist])

      const markAndPersist = React.useCallback((nextDocument, id, speakerId) => {
        if (id) dirtyIdsRef.current.add(id)
        if (speakerId) dirtySpeakersRef.current.add(speakerId)
        localDocumentRef.current = nextDocument
        setDocument(nextDocument)
        schedulePersist(nextDocument)
      }, [schedulePersist])

      const editBlock = React.useCallback((id, value, field = 'text') => {
        const next = normalizeDocument({ ...localDocumentRef.current, blocks: localDocumentRef.current.blocks.map((block) => block.id === id ? { ...block, [field]: value, ...(block.type === 'transcript' ? { userEdited: true } : {}), updatedAt: new Date().toISOString() } : block) })
        markAndPersist(next, id)
      }, [markAndPersist])

      const renameSpeaker = React.useCallback((speakerId, value) => {
        if (!speakerId) return
        const known = localDocumentRef.current.speakers.some((speaker) => speaker.id === speakerId)
        const speakers = known
          ? localDocumentRef.current.speakers.map((speaker) => speaker.id === speakerId ? { ...speaker, name: value } : speaker)
          : [...localDocumentRef.current.speakers, { id: speakerId, name: value || speakerId }]
        const next = normalizeDocument({ ...localDocumentRef.current, speakers })
        markAndPersist(next, null, speakerId)
      }, [markAndPersist])

      const insertText = React.useCallback(() => {
        const id = `text-${Date.now()}-${Math.random().toString(16).slice(2)}`
        const blocks = localDocumentRef.current.blocks
        const index = Math.max(-1, blocks.findIndex((block) => block.id === selectedBlockId))
        const block = normalizeBlock({ id, type: 'text', text: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, index + 1)
        const next = normalizeDocument({ ...localDocumentRef.current, blocks: [...blocks.slice(0, index + 1), block, ...blocks.slice(index + 1)] })
        dirtyIdsRef.current.add(id)
        localDocumentRef.current = next
        setDocument(next)
        setSelectedBlockId(id)
        schedulePersist(next)
      }, [schedulePersist, selectedBlockId])

      const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
        if (file.size > MAX_IMAGE_BYTES) { reject(new Error('单张图片不能超过 10 MiB')); return }
        if (typeof FileReader !== 'function') { reject(new Error('当前环境无法读取图片')); return }
        const reader = new FileReader()
        reader.onload = () => resolve(text(reader.result))
        reader.onerror = () => reject(new Error('图片读取失败'))
        reader.readAsDataURL(file)
      })

      const insertImage = React.useCallback(async (file) => {
        const id = activeSessionRef.current
        if (!id) return
        const mimeType = text(file.type).toLowerCase()
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)) { setError('仅支持 PNG、JPEG、WebP、GIF 图片'); return }
        setBusy(true)
        setError('')
        try {
          const dataUrl = await readFileAsDataUrl(file)
          const dataBase64 = dataUrl.split(',', 2)[1] || ''
          const value = await authorizedRequest(`/sessions/${encodeURIComponent(id)}/media`, { method: 'POST', body: JSON.stringify({ name: file.name || 'image', mimeType, dataBase64 }) }, id)
          const root = unwrapApi(value)
          const media = safeJson(root?.media || root)
          const block = normalizeBlock({ id: `image-${Date.now()}-${Math.random().toString(16).slice(2)}`, type: 'image', mediaId: media.id, url: media.url, caption: '', createdAt: new Date().toISOString() }, 0)
          const blocks = localDocumentRef.current.blocks
          const index = Math.max(-1, blocks.findIndex((item) => item.id === selectedBlockId))
          const next = normalizeDocument({ ...localDocumentRef.current, blocks: [...blocks.slice(0, index + 1), block, ...blocks.slice(index + 1)] })
          dirtyIdsRef.current.add(block.id)
          localDocumentRef.current = next
          setDocument(next)
          setSelectedBlockId(block.id)
          // Flush an edit waiting behind the debounce before image insertion
          // so the persisted order matches the visible order.
          if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; pendingSaveRef.current = null }
          await persist(next)
        } catch (cause) {
          setError(errorMessage(cause, '图片保存失败'))
        } finally {
          setBusy(false)
        }
      }, [persist, selectedBlockId])

      const startRecording = React.useCallback(async () => {
        if (!hasNativeBridge()) { setPhase('failed'); setError('仅大神 App 可用：当前浏览器没有原生录音桥接，未开始录音。'); return }
        setBusy(true)
        setError('')
        setPhase('model_preparing')
        try {
          const healthValue = await request('/health')
          const health = unwrapApi(healthValue)
          if (health && health.ok === false) throw new Error(errorMessage(health.error, '本地模型未就绪'))
          const created = await request('/sessions', { method: 'POST', body: JSON.stringify({ source, expectedSpeakers: expectedSpeakers === 'auto' ? 'auto' : Number(expectedSpeakers), language: 'zh-CN', title: `大神速记 · ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}` }) })
          const root = unwrapApi(created)
          const snapshot = normalizeSession(root)
          const upload = safeJson(root?.upload)
          if (!snapshot.id || !upload.url || !upload.token) throw new Error('速记服务没有返回完整录音凭据，未开始录音。')
          controlTokensRef.current.set(snapshot.id, upload.token)
          rememberControlToken(snapshot.id, upload.token)
          generationRef.current += 1
          activeSessionRef.current = snapshot.id
          dirtyIdsRef.current = new Set()
          dirtySpeakersRef.current = new Set()
          localDocumentRef.current = snapshot.document
          revisionRef.current = snapshot.revision
          setSession(snapshot)
          setDocument(snapshot.document)
          setSelectedBlockId(snapshot.document.blocks[0]?.id || '')
          setPhase('permission')
          postNative({ action: 'start', sessionId: snapshot.id, source, uploadUrl: upload.url, uploadToken: upload.token, sampleRate: numberOr(upload.sampleRate, SAMPLE_RATE) })
          await authorizedRequest(`/sessions/${encodeURIComponent(snapshot.id)}/state`, { method: 'POST', body: JSON.stringify({ state: 'recording' }) }, snapshot.id)
          setPhase('recording')
        } catch (cause) {
          setPhase('failed')
          setError(errorMessage(cause, '无法开始速记'))
        } finally {
          setBusy(false)
        }
      }, [authorizedRequest, expectedSpeakers, source])

      const updateState = React.useCallback(async (id, nextState) => {
        const value = await authorizedRequest(`/sessions/${encodeURIComponent(id)}/state`, { method: 'POST', body: JSON.stringify({ state: nextState }) }, id)
        return applySnapshot(value)
      }, [applySnapshot, authorizedRequest])

      const pauseRecording = React.useCallback(() => {
        const id = activeSessionRef.current
        if (!id) return
        setBusy(true)
        try { postNative({ action: 'pause', sessionId: id }); setPhase('paused'); void updateState(id, 'paused').catch(() => {}) } catch (cause) { setError(errorMessage(cause, '暂停失败')) } finally { setBusy(false) }
      }, [updateState])

      const resumeRecording = React.useCallback(() => {
        const id = activeSessionRef.current
        if (!id) return
        setBusy(true)
        try { postNative({ action: 'resume', sessionId: id }); setPhase('recording'); void updateState(id, 'recording').catch(() => {}) } catch (cause) { setError(errorMessage(cause, '继续失败')) } finally { setBusy(false) }
      }, [updateState])

      const finalizeSession = React.useCallback(async (requestedRevision) => {
        const id = activeSessionRef.current
        if (!id) return
        const explicitRevision = Number.isSafeInteger(requestedRevision) ? requestedRevision : null
        setBusy(true)
        setPhase('finalizing')
        setError('')
        try {
          const value = await authorizedRequest(`/sessions/${encodeURIComponent(id)}/finalize`, { method: 'POST', body: JSON.stringify({ baseRevision: explicitRevision ?? revisionRef.current ?? localDocumentRef.current.revision }) }, id)
          const normalized = applySnapshot(value)
          if (normalized?.phase === 'ready') setPhase('ready')
        } catch (cause) {
          setPhase('failed')
          setError(errorMessage(cause, '最终校正失败'))
        } finally {
          setBusy(false)
        }
      }, [applySnapshot, authorizedRequest, session?.revision])

      const stopRecording = React.useCallback(async () => {
        const id = activeSessionRef.current
        if (!id || !['recording', 'paused'].includes(phase)) return
        setBusy(true)
        setPhase('stopping')
        setError('')
        try {
          const stopped = waitForNativeStop(id)
          postNative({ action: 'stop', sessionId: id })
          const nativeStopped = await stopped
          if (!nativeStopped) throw new Error('原生录音仍在刷新音频，请稍后再次结束，避免丢失最后一段。')
          const stoppedSnapshot = await updateState(id, 'stopped')
          await finalizeSession(stoppedSnapshot?.revision)
        } catch (cause) {
          setPhase('failed')
          setError(errorMessage(cause, '停止录音失败'))
          setBusy(false)
        }
      }, [finalizeSession, phase, updateState])

      const resumeInterrupted = React.useCallback(() => {
        const id = activeSessionRef.current
        if (!id) return
        try { postNative({ action: 'resume', sessionId: id }); setPhase('recording'); void updateState(id, 'recording').catch(() => {}) } catch (cause) { setError(errorMessage(cause, '无法恢复录音')) }
      }, [updateState])

      const newRecording = React.useCallback(() => {
        if (!['ready', 'failed'].includes(phase)) return
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
        pendingSaveRef.current = null
        generationRef.current += 1
        activeSessionRef.current = ''
        revisionRef.current = 0
        localDocumentRef.current = normalizeDocument(null)
        dirtyIdsRef.current = new Set()
        dirtySpeakersRef.current = new Set()
        setSession(null)
        setDocument(normalizeDocument(null))
        setSelectedBlockId('')
        setPhase('idle')
        setError('')
        setHandoffError('')
        setHandoffNotice('')
        setArtifact(null)
        setCopyNotice('')
        lastHandoffRef.current = null
      }, [phase])

      const handoff = React.useCallback(async () => {
        const id = activeSessionRef.current
        if (!id || phase !== 'ready' || handoffBusyRef.current) return
        if (purpose === 'custom' && !customPurpose.trim()) { setHandoffError('请先填写自定义用途。'); return }
        handoffBusyRef.current = true
        setBusy(true)
        setHandoffError('')
        setHandoffNotice('')
        setCopyNotice('')
        try {
          if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
          const pendingDocument = pendingSaveRef.current
          pendingSaveRef.current = null
          if (pendingDocument) await persist(pendingDocument)
          await saveQueueRef.current.catch(() => {})
          const response = await authorizedRequest(`/sessions/${encodeURIComponent(id)}/handoff`, { method: 'POST', body: JSON.stringify({ baseRevision: revisionRef.current ?? localDocumentRef.current.revision, purpose, ...(purpose === 'custom' ? { customPurpose: customPurpose.trim() } : {}), ...(extraInstructions.trim() ? { extraInstructions: extraInstructions.trim() } : {}) }) }, id)
          const root = unwrapApi(response)
          const packet = safeJson(root?.handoff || root)
          const generated = safeJson(root?.artifact)
          if (!generated.content) throw new Error('本地模型没有返回完整成品。')
          lastHandoffRef.current = packet
          setArtifact(generated)
          if (root?.session) applySnapshot(root.session)
          setHandoffNotice('GLM-5.3-Flash 已生成完整成品，可直接复制或继续修改。')
        } catch (cause) {
          setHandoffError(errorMessage(cause, '生成失败：GLM-5.3-Flash 没有返回成品'))
        } finally {
          handoffBusyRef.current = false
          setBusy(false)
        }
      }, [applySnapshot, authorizedRequest, customPurpose, extraInstructions, persist, phase, purpose])

      const copyArtifact = React.useCallback(async () => {
        const content = text(artifact?.content)
        if (!content) return
        try {
          if (window.navigator?.clipboard?.writeText) await window.navigator.clipboard.writeText(content)
          else {
            const field = window.document.createElement('textarea')
            field.value = content
            field.setAttribute('readonly', '')
            field.style.position = 'fixed'
            field.style.opacity = '0'
            window.document.body.appendChild(field)
            field.select()
            const copied = window.document.execCommand('copy')
            field.remove()
            if (!copied) throw new Error('复制命令失败')
          }
          setCopyNotice('已复制')
        } catch (cause) {
          setCopyNotice('复制失败')
          setHandoffError(errorMessage(cause, '复制失败，请手动选择正文'))
        }
      }, [artifact?.content])

      const continueArtifact = React.useCallback(async () => {
        const currentArtifact = artifact
        const prompt = first(currentArtifact?.conversationPrompt, lastHandoffRef.current?.conversationPrompt)
        if (!currentArtifact?.content || !prompt || handoffBusyRef.current) { setHandoffError('当前成品缺少可继续加工的上下文。'); return }
        handoffBusyRef.current = true
        setBusy(true)
        setHandoffError('')
        try {
          if (!ctx.sessions || typeof ctx.sessions.create !== 'function' || typeof ctx.sessions.open !== 'function') throw new Error('大神官方会话接口暂不可用。')
          let newSessionId = text(handoffTargetRef.current.get(currentArtifact.id))
          if (!newSessionId) {
            const newSession = await ctx.sessions.create({ cwd: '/Users/marcus/Desktop' })
            newSessionId = text(newSession?.sessionId || newSession?.id || newSession)
            if (newSessionId) handoffTargetRef.current.set(currentArtifact.id, newSessionId)
          }
          if (!newSessionId) throw new Error('大神没有返回新会话 ID。')
          await Promise.resolve(ctx.sessions.open(newSessionId))
          const directories = ctx.modelDirectories || (typeof ctx.get === 'function' ? ctx.get('modelDirectories') : null)
          const directory = directories && typeof directories.directoryFor === 'function' ? directories.directoryFor(newSessionId) : null
          if (!directory || typeof directory.select !== 'function') throw new Error('本地模型目录接口暂不可用。')
          await directory.select({ provider: 'zhipu-glm', model: 'glm-5.3-flash' })
          const scope = typeof ctx.sessions.scope === 'function' ? ctx.sessions.scope(newSessionId) : null
          const conversation = scope && typeof scope.get === 'function' ? scope.get('conversation') : (typeof ctx.get === 'function' ? ctx.get('conversation') : null)
          const input = conversation && conversation.input && typeof conversation.input.for === 'function' ? conversation.input.for(scope) : null
          if (!input || typeof input.setDraft !== 'function' || typeof input.submit !== 'function') throw new Error('官方会话输入接口暂不可用。')
          await input.setDraft(prompt)
          await input.submit()
          setHandoffNotice('成品和速记原文已载入新会话，可继续修改。')
        } catch (cause) {
          setHandoffError(errorMessage(cause, '无法在新会话中继续'))
        } finally {
          handoffBusyRef.current = false
          setBusy(false)
        }
      }, [artifact, ctx])

      const deleteSession = React.useCallback(async (id) => {
        const value = text(id).trim()
        const item = history.find((entry) => entry.id === value)
        if (!value || !item || ['recording', 'paused', 'finalizing', 'model_preparing'].includes(item.phase)) return
        if (typeof window.confirm === 'function' && !window.confirm(`确定删除“${item.title}”吗？\n记录会移入本机速记回收区，可人工恢复。`)) return
        setBusy(true)
        setError('')
        try {
          await authorizedRequest(`/sessions/${encodeURIComponent(value)}`, { method: 'DELETE' }, value)
          controlTokensRef.current.delete(value)
          forgetControlToken(value)
          setHistory((items) => items.filter((entry) => entry.id !== value))
          if (activeSessionRef.current === value) {
            generationRef.current += 1
            activeSessionRef.current = ''
            revisionRef.current = 0
            localDocumentRef.current = normalizeDocument(null)
            dirtyIdsRef.current = new Set()
            dirtySpeakersRef.current = new Set()
            setSession(null)
            setDocument(normalizeDocument(null))
            setArtifact(null)
            setPhase('idle')
          }
          setHandoffNotice('历史速记已删除并移入本机回收区。')
        } catch (cause) {
          setError(errorMessage(cause, '历史速记删除失败'))
        } finally {
          setBusy(false)
        }
      }, [authorizedRequest, history])

      const statusDetail = () => {
        if (phase === 'recording') return `${formatDuration(session?.durationMs)} · ${document.blocks.length} 段 · ${document.speakers.length || 1} 位说话人`
        if (phase === 'paused') return `已保存 ${document.blocks.length} 段，可继续记录`
        if (phase === 'finalizing') return session?.progress == null ? '正在重新转写并校正说话人…' : `正在校正… ${Math.round(session.progress)}%`
        if (phase === 'ready') return `${document.blocks.length} 个记录块 · 可编辑和继续加工`
        if (phase === 'interrupted') return '上次录音中断，尚未自动恢复'
        if (phase === 'failed') return error || '请检查本地模型、权限和磁盘空间'
        return bridgeAvailable ? '录音、转写和声纹均在本机运行' : '仅大神 App 可用'
      }

      const actions = {
        closePanel: () => setOpen(false),
        setSource: (value) => setSource(value),
        setExpectedSpeakers: (value) => setExpectedSpeakers(value),
        setSelectedBlockId,
        setPurpose,
        setCustomPurpose,
        setExtraInstructions,
        startRecording,
        pauseRecording,
        resumeRecording,
        stopRecording,
        resumeInterrupted,
        newRecording,
        finalizeSession,
        reloadCurrent: () => { if (activeSessionRef.current) void readSession(activeSessionRef.current) },
        selectSession,
        loadHistory,
        editBlock,
        renameSpeaker,
        insertText,
        insertImage,
        handoff,
        copyArtifact,
        continueArtifact,
        deleteSession,
        statusDetail,
      }

      const hasActive = ['recording', 'paused', 'stopping', 'finalizing', 'interrupted'].includes(phase)
      const panel = h(StenographerPanel, { state: { open, session, document, phase, source, expectedSpeakers, selectedBlockId, history, historyLoading, purpose, customPurpose, extraInstructions, artifact, copyNotice, busy, saving, savedAt, error, handoffError, handoffNotice, bridgeAvailable }, actions })
      const panelLayer = open && typeof document !== 'undefined' && document.body
        ? ReactDOM.createPortal(panel, document.body)
        : panel
      return h(React.Fragment, null,
        h('button', { type: 'button', className: `shrimp-files-btn shrimp-heartbeat-btn dsh-steno-header-button${hasActive ? ' is-active' : ''}`, 'data-state': phase, title: hasActive ? `速记员：${PHASE_LABELS[phase]}，关闭面板不会停止` : '打开速记员', 'aria-label': hasActive ? `速记员，${PHASE_LABELS[phase]}` : '打开速记员', onClick: () => setOpen(true) }, icon('mic'), h('span', null, '速记员')),
        panelLayer,
      )
    }

    function apply(ctx) {
      const slots = ctx.slots
      const styleId = 'dsh-stenographer-styles'
      if (typeof document !== 'undefined') {
        document.getElementById(styleId)?.remove()
        const style = document.createElement('style')
        style.id = styleId
        style.dataset.plugin = '@local/dsh-stenographer'
        style.textContent = `
          .dsh-steno-header-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:7px;height:36px;min-height:36px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:9px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.04));color:var(--dsw-alias-label-secondary,#68717c);font:500 12px/1 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;white-space:nowrap;transition:background .15s ease,border-color .15s ease,color .15s ease,box-shadow .15s ease}.dsh-steno-header-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.11));color:var(--dsw-alias-label-primary,#1f2329)}.dsh-steno-header-button:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#5b8ff9);outline-offset:2px}.dsh-steno-header-button svg{width:16px;height:16px;flex:none}.dsh-steno-header-button.is-active{border-color:color-mix(in srgb,#e5484d 48%,var(--dsw-alias-border-l2));background:color-mix(in srgb,#e5484d 10%,transparent);color:#d63f47}.dsh-steno-header-button[data-state="recording"] svg{animation:dsh-steno-pulse 1.5s ease-in-out infinite}@keyframes dsh-steno-pulse{0%,100%{opacity:.55}50%{opacity:1}}
          .dsh-steno-overlay{position:fixed;inset:0;z-index:10020;pointer-events:none}.dsh-steno-backdrop{position:absolute;inset:0;background:rgba(20,24,31,.16);backdrop-filter:blur(1px);pointer-events:auto}.dsh-steno-panel{position:absolute;top:8px;right:8px;bottom:8px;display:flex;flex-direction:column;width:min(660px,calc(100vw - 32px));min-width:0;overflow:hidden;pointer-events:auto;border:1px solid var(--dsw-alias-border-l2,rgba(31,35,41,.14));border-radius:18px;background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 97%,#f4f6f8);color:var(--dsw-alias-label-primary,#1f2329);box-shadow:0 22px 70px rgba(24,31,40,.24),0 4px 16px rgba(24,31,40,.1);font:13px/1.45 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;animation:dsh-steno-in .2s cubic-bezier(.2,.8,.2,1) both}@keyframes dsh-steno-in{from{opacity:0;transform:translateX(18px) scale(.987)}to{opacity:1;transform:none}}body[data-ds-dark-theme] .dsh-steno-panel{background:color-mix(in srgb,var(--dsw-alias-bg-base,#151618) 95%,#24272b);color:var(--dsw-alias-label-primary,#f5f6f7);border-color:rgba(255,255,255,.12);box-shadow:0 24px 80px rgba(0,0,0,.55)}body[data-ds-dark-theme] .dsh-steno-backdrop{background:rgba(0,0,0,.38)}
          .dsh-steno-panel-header{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:70px;padding:0 18px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.17));background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 91%,transparent);flex:none;position:sticky;top:0;z-index:2}.dsh-steno-panel-heading{display:flex;align-items:center;gap:11px;min-width:0}.dsh-steno-panel-mark{display:grid;place-items:center;width:36px;height:36px;flex:none;border-radius:11px;background:color-mix(in srgb,#e5484d 12%,transparent);color:#d94249}.dsh-steno-panel-mark svg{width:19px;height:19px}.dsh-steno-panel-heading h1{margin:0;font-size:17px;line-height:23px;font-weight:650;letter-spacing:-.01em}.dsh-steno-panel-heading p{margin:1px 0 0;color:var(--dsw-alias-label-secondary,#7a8089);font-size:11.5px;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsh-steno-close-button,.dsh-steno-icon-button{display:grid;place-items:center;width:32px;height:32px;flex:none;padding:0;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary,#747b84);cursor:pointer}.dsh-steno-close-button:hover,.dsh-steno-icon-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.11));color:var(--dsw-alias-label-primary,#1f2329)}.dsh-steno-close-button:focus-visible,.dsh-steno-icon-button:focus-visible,.dsh-steno-tool-button:focus-visible,.dsh-steno-primary-button:focus-visible,.dsh-steno-secondary-button:focus-visible,.dsh-steno-stop-button:focus-visible,.dsh-steno-history-item:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#5b8ff9);outline-offset:2px}.dsh-steno-close-button svg{width:17px;height:17px}
          .dsh-steno-status-bar{display:flex;align-items:center;gap:10px;min-height:42px;padding:0 18px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.13));background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 72%,transparent);flex:none}.dsh-steno-status-detail{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#747b84);font-size:11.5px}.dsh-steno-save-state{margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:10.5px;white-space:nowrap}.dsh-steno-lamp{display:inline-flex;align-items:center;gap:7px;flex:none;color:var(--dsw-alias-label-primary,#1f2329);font-size:12px;font-weight:620;white-space:nowrap}.dsh-steno-lamp-dot{width:8px;height:8px;flex:none;border-radius:50%;background:#9aa0a8}.dsh-steno-lamp.is-recording .dsh-steno-lamp-dot{background:#e5484d;box-shadow:0 0 0 3px rgba(229,72,77,.16),0 0 10px rgba(229,72,77,.35);animation:dsh-steno-pulse 1.5s ease-in-out infinite}.dsh-steno-lamp.is-processing .dsh-steno-lamp-dot{background:#3d83e6;box-shadow:0 0 0 3px rgba(61,131,230,.14)}.dsh-steno-lamp.is-ready .dsh-steno-lamp-dot{background:#2c9a68;box-shadow:0 0 0 3px rgba(44,154,104,.14)}.dsh-steno-lamp.is-error .dsh-steno-lamp-dot,.dsh-steno-lamp.is-interrupted .dsh-steno-lamp-dot{background:#d84b50;box-shadow:0 0 0 3px rgba(216,75,80,.13)}
          .dsh-steno-panel-body{flex:1;min-height:0;overflow:auto;padding:16px 18px 26px;scrollbar-gutter:stable}.dsh-steno-panel-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:38px;padding:0 18px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.14));color:var(--dsw-alias-label-tertiary,#9399a2);font-size:10.5px;flex:none}.dsh-steno-section-title{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin:0 0 13px}.dsh-steno-section-title h2,.dsh-steno-editor-head h2{margin:0;font-size:14px;line-height:21px;font-weight:650}.dsh-steno-section-title p,.dsh-steno-editor-head p{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#9399a2);font-size:11px;line-height:17px}.dsh-steno-start-section{padding:15px 15px 16px;margin-bottom:15px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.17));border-radius:14px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#f7f8fa) 80%,transparent)}.dsh-steno-fieldset{min-width:0;padding:0;margin:0 0 12px;border:0}.dsh-steno-fieldset legend{padding:0;margin:0 0 8px;color:var(--dsw-alias-label-secondary,#737982);font-size:11px}.dsh-steno-source-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.dsh-steno-source-card,.dsh-steno-purpose-card{position:relative;display:flex;align-items:flex-start;gap:8px;min-width:0;padding:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.17));border-radius:10px;background:var(--dsw-alias-bg-base,#fff);cursor:pointer;transition:border-color .15s ease,background .15s ease,box-shadow .15s ease}.dsh-steno-source-card input,.dsh-steno-purpose-card input{position:absolute;opacity:0;pointer-events:none}.dsh-steno-source-card:hover,.dsh-steno-purpose-card:hover{border-color:color-mix(in srgb,#3d83e6 44%,var(--dsw-alias-border-l2))}.dsh-steno-source-card.is-selected,.dsh-steno-purpose-card.is-selected{border-color:#3d83e6;background:color-mix(in srgb,#3d83e6 9%,var(--dsw-alias-bg-base,#fff));box-shadow:0 0 0 1px rgba(61,131,230,.18)}.dsh-steno-source-icon{display:grid;place-items:center;width:25px;height:25px;flex:none;border-radius:7px;background:color-mix(in srgb,#3d83e6 10%,transparent);color:#3d83e6}.dsh-steno-source-icon svg{width:15px;height:15px}.dsh-steno-source-copy,.dsh-steno-purpose-card>span{display:flex;flex-direction:column;min-width:0;gap:2px}.dsh-steno-source-copy strong,.dsh-steno-purpose-card strong{font-size:12px;line-height:17px;font-weight:620}.dsh-steno-source-copy small,.dsh-steno-purpose-card small{color:var(--dsw-alias-label-tertiary,#9399a2);font-size:10.5px;line-height:15px}.dsh-steno-select-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 14px;color:var(--dsw-alias-label-secondary,#737982);font-size:11px}.dsh-steno-select-row select{min-width:112px;height:32px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2329);font:inherit}.dsh-steno-primary-button,.dsh-steno-secondary-button,.dsh-steno-stop-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:34px;padding:0 13px;border-radius:9px;font:600 12px/1 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;transition:background .15s ease,border-color .15s ease,opacity .15s ease}.dsh-steno-primary-button{border:1px solid #e5484d;background:#e5484d;color:#fff;box-shadow:0 3px 9px rgba(229,72,77,.2)}.dsh-steno-primary-button:hover{background:#d83e45;border-color:#d83e45}.dsh-steno-secondary-button{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06));color:var(--dsw-alias-label-primary,#1f2329)}.dsh-steno-secondary-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.11))}.dsh-steno-stop-button{border:1px solid color-mix(in srgb,#e5484d 48%,var(--dsw-alias-border-l2));background:color-mix(in srgb,#e5484d 10%,transparent);color:#d63f47}.dsh-steno-stop-button:hover{background:color-mix(in srgb,#e5484d 16%,transparent)}.dsh-steno-primary-button:disabled,.dsh-steno-secondary-button:disabled,.dsh-steno-stop-button:disabled,.dsh-steno-tool-button:disabled,.dsh-steno-close-button:disabled{opacity:.48;cursor:not-allowed;box-shadow:none}.dsh-steno-recording-controls{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin:13px 0 15px}.dsh-steno-bridge-warning,.dsh-steno-inline-error,.dsh-steno-error-card{padding:9px 11px;margin:0 0 12px;border-radius:9px;background:color-mix(in srgb,#e5484d 9%,transparent);color:#cb4850;font-size:11px;line-height:17px}.dsh-steno-error-card{margin:0 0 15px}.dsh-steno-error-card strong{display:block;font-size:12px}.dsh-steno-error-card p{margin:4px 0 9px}.dsh-steno-local-badge{flex:none;padding:3px 7px;border:1px solid color-mix(in srgb,#2c9a68 38%,transparent);border-radius:999px;color:#2c9a68;background:color-mix(in srgb,#2c9a68 9%,transparent);font-size:10px;line-height:15px}.dsh-steno-handoff,.dsh-steno-history,.dsh-steno-editor{padding:15px;margin:0 0 15px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.17));border-radius:14px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#f7f8fa) 76%,transparent)}.dsh-steno-handoff-button{width:100%;margin-top:3px}.dsh-steno-purpose-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:13px}.dsh-steno-purpose-card{min-height:60px}.dsh-steno-input-label{display:flex;flex-direction:column;gap:5px;margin:0 0 11px;color:var(--dsw-alias-label-secondary,#737982);font-size:11px}.dsh-steno-input-label input,.dsh-steno-input-label textarea,.dsh-steno-block textarea,.dsh-steno-caption-input{box-sizing:border-box;width:100%;padding:8px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:8px;outline:none;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2329);font:12px/18px ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;resize:vertical}.dsh-steno-input-label input:focus,.dsh-steno-input-label textarea:focus,.dsh-steno-block textarea:focus,.dsh-steno-caption-input:focus{border-color:#5b8ff9;box-shadow:0 0 0 2px rgba(91,143,249,.16)}.dsh-steno-editor{padding:0;overflow:hidden}.dsh-steno-editor-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.15));background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 74%,transparent)}.dsh-steno-editor-tools{display:flex;gap:5px;flex:none}.dsh-steno-tool-button{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#737982);font:500 11px/1 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}.dsh-steno-tool-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));color:var(--dsw-alias-label-primary,#1f2329)}.dsh-steno-tool-button svg{width:14px;height:14px}.dsh-steno-editor-empty{display:flex;align-items:center;flex-direction:column;gap:5px;padding:31px 18px 34px;text-align:center;color:var(--dsw-alias-label-secondary,#7d848d)}.dsh-steno-empty-mark{display:grid;place-items:center;width:36px;height:36px;margin-bottom:3px;border-radius:10px;background:color-mix(in srgb,#3d83e6 10%,transparent);color:#3d83e6}.dsh-steno-empty-mark svg{width:18px;height:18px}.dsh-steno-editor-empty strong{font-size:13px;color:var(--dsw-alias-label-primary,#1f2329)}.dsh-steno-editor-empty p{margin:0;font-size:11px;line-height:17px}.dsh-steno-block-list{display:flex;flex-direction:column;gap:8px;padding:10px 12px 13px}.dsh-steno-block{min-width:0;padding:10px 11px;border:1px solid transparent;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 78%,transparent);transition:border-color .15s ease,background .15s ease,box-shadow .15s ease}.dsh-steno-block:hover{border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.24))}.dsh-steno-block:focus-visible{outline:2px solid #5b8ff9;outline-offset:2px}.dsh-steno-block.is-selected{border-color:color-mix(in srgb,#3d83e6 62%,var(--dsw-alias-border-l2));box-shadow:0 0 0 2px rgba(61,131,230,.1)}.dsh-steno-block-meta{display:flex;align-items:center;gap:7px;min-width:0;margin-bottom:6px}.dsh-steno-speaker{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:190px}.dsh-steno-speaker-dot{width:7px;height:7px;flex:none;border-radius:50%;background:#7c83b5}.dsh-steno-speaker input{min-width:0;max-width:155px;padding:1px 3px;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--dsw-alias-label-primary,#1f2329);font:600 11px/17px ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.dsh-steno-speaker input:hover,.dsh-steno-speaker input:focus{border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.24));outline:none;background:var(--dsw-alias-bg-base,#fff)}.dsh-steno-block-time{color:var(--dsw-alias-label-tertiary,#9399a2);font-size:10px;font-variant-numeric:tabular-nums;white-space:nowrap}.dsh-steno-block-badge{padding:2px 6px;border-radius:5px;font-size:9px;line-height:14px;white-space:nowrap}.dsh-steno-block-badge.is-final{color:#2c9a68;background:color-mix(in srgb,#2c9a68 10%,transparent)}.dsh-steno-block-badge.is-live{color:#3d83e6;background:color-mix(in srgb,#3d83e6 10%,transparent)}.dsh-steno-block-badge.is-uncertain{color:#d28a2b;background:color-mix(in srgb,#d28a2b 12%,transparent)}.dsh-steno-block-badge.is-note{color:#7c6aad;background:color-mix(in srgb,#7c6aad 10%,transparent)}.dsh-steno-block textarea{display:block;min-height:45px;resize:vertical}.dsh-steno-edited-note{display:block;margin-top:5px;color:#b57826;font-size:10px;line-height:15px}.dsh-steno-image-block{display:flex;flex-direction:column;gap:7px}.dsh-steno-image-block img{display:block;max-width:100%;max-height:210px;object-fit:contain;border-radius:7px;background:var(--dsw-alias-bg-layer-1,#f3f4f6)}.dsh-steno-image-placeholder{display:flex;align-items:center;gap:7px;min-height:54px;padding:0 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#f3f4f6);color:var(--dsw-alias-label-secondary,#7d848d);font-size:11px}.dsh-steno-image-placeholder svg{width:18px;height:18px}.dsh-steno-caption-input{font-size:11px;line-height:16px}.dsh-steno-history{padding:13px 14px}.dsh-steno-history .dsh-steno-section-title{margin-bottom:7px}.dsh-steno-history-list{display:flex;flex-direction:column;gap:3px;margin:0;padding:0;list-style:none}.dsh-steno-history-item{display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:8px 5px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#1f2329);text-align:left;cursor:pointer}.dsh-steno-history-item:hover,.dsh-steno-history-item.is-selected{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}.dsh-steno-history-state{width:7px;height:7px;flex:none;border-radius:50%;background:#9aa0a8}.dsh-steno-history-state.is-recording{background:#e5484d;box-shadow:0 0 0 3px rgba(229,72,77,.13)}.dsh-steno-history-state.is-processing{background:#3d83e6}.dsh-steno-history-state.is-ready{background:#2c9a68}.dsh-steno-history-state.is-error,.dsh-steno-history-state.is-interrupted{background:#d84b50}.dsh-steno-history-copy{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px}.dsh-steno-history-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;line-height:17px;font-weight:600}.dsh-steno-history-copy small{color:var(--dsw-alias-label-tertiary,#9399a2);font-size:10px;line-height:15px}.dsh-steno-history-arrow{color:var(--dsw-alias-label-tertiary,#9399a2);font-size:18px;line-height:1}.dsh-steno-muted{margin:5px 0;color:var(--dsw-alias-label-tertiary,#9399a2);font-size:11px;line-height:17px}
          @media(max-width:1100px){.dsh-steno-panel{top:0;right:0;bottom:0;width:min(660px,100vw);border-radius:0;border-width:0}.dsh-steno-backdrop{display:none}}@media(max-width:640px){.dsh-steno-source-grid{grid-template-columns:1fr}.dsh-steno-purpose-grid{grid-template-columns:1fr}.dsh-steno-panel-body{padding-left:12px;padding-right:12px}.dsh-steno-panel-header,.dsh-steno-status-bar{padding-left:13px;padding-right:13px}.dsh-steno-save-state{display:none}}@media(prefers-reduced-motion:reduce){.dsh-steno-panel,.dsh-steno-lamp.is-recording .dsh-steno-lamp-dot,.dsh-steno-header-button[data-state="recording"] svg{animation:none}}
        `
        style.textContent += '[data-dsh-header-utilities] > [data-slot="conversation.session.header.utilities"] > .dsh-steno-overlay{position:fixed!important;inset:0!important;display:block!important;width:100vw!important;min-width:100vw!important;max-width:none!important;height:100vh!important;min-height:100vh!important;max-height:none!important;align-self:auto!important;flex:none!important}.dsh-steno-panel{width:min(800px,calc(100vw - 32px))}.dsh-steno-inline-notice{padding:9px 11px;margin:0 0 12px;border-radius:9px;background:color-mix(in srgb,#2c9a68 9%,transparent);color:#2c9a68;font-size:11px;line-height:17px}.dsh-steno-status-bar{position:sticky;top:0;z-index:3}.dsh-steno-panel-footer{position:sticky;bottom:0;z-index:3;background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 96%,transparent)}.dsh-steno-panel-header-actions{display:flex;align-items:center;gap:6px;flex:none}.dsh-steno-new-button{min-height:30px;padding:0 9px;font-size:11px}.dsh-steno-new-button svg{width:14px;height:14px}'
        style.textContent += '.dsh-steno-history-row{display:flex;align-items:center;gap:3px}.dsh-steno-history-row .dsh-steno-history-item{flex:1}.dsh-steno-history-delete{display:grid;place-items:center;width:30px;height:30px;flex:none;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary,#9399a2);cursor:pointer}.dsh-steno-history-delete:hover{background:color-mix(in srgb,#e5484d 10%,transparent);color:#d84b50}.dsh-steno-history-delete:disabled{opacity:.35;cursor:not-allowed}.dsh-steno-history-delete svg{width:15px;height:15px}.dsh-steno-artifact{margin:12px 0;padding:12px;border:1px solid color-mix(in srgb,#3d83e6 35%,var(--dsw-alias-border-l2));border-radius:11px;background:var(--dsw-alias-bg-base,#fff)}.dsh-steno-artifact-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}.dsh-steno-artifact-head strong{font-size:13px}.dsh-steno-copy-button{min-height:30px;padding:0 9px;font-size:11px}.dsh-steno-copy-button svg{width:14px;height:14px}.dsh-steno-artifact-content{max-height:420px;overflow:auto;margin:0;padding:11px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06));color:var(--dsw-alias-label-primary,#1f2329);font:12px/1.7 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:pre-wrap;overflow-wrap:anywhere}.dsh-steno-continue-button{width:100%;margin-top:9px}'
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-stenographer: styles')
      }

      ctx.effect(() => slots.inject('conversation.session.header.utilities', () => slots.register(
        { name: 'conversation.session.header.utilities', id: 'dsh-stenographer', order: 3, label: '速记员' },
        (props) => h(StenographerUtility, { ...(props || {}), __dshContext: ctx }),
      )), 'dsh-stenographer: header utility')
    }

    exports.apply = apply
    exports.inject = inject
    exports.normalizePhase = normalizePhase
    exports.normalizeBlock = normalizeBlock
    exports.normalizeDocument = normalizeDocument
    exports.normalizeSession = normalizeSession
    exports.normalizeSessionList = normalizeSessionList
    exports.mergeDocuments = mergeDocuments
    exports.toDocumentPayload = toDocumentPayload
    exports.hasNativeBridge = hasNativeBridge
    exports.PHASE_LABELS = PHASE_LABELS
    exports.PURPOSE_OPTIONS = PURPOSE_OPTIONS
    exports.SOURCE_OPTIONS = SOURCE_OPTIONS
    return module.exports
  },
})
