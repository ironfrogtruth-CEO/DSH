import { randomUUID } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { access, readFile, stat } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  DEFAULT_MODEL_BINDING,
  FUNASR_PYTHON,
  MODEL_MANIFEST_PATH,
  MODEL_MANIFEST_SCHEMA,
  MODEL_ROOT,
  PRIMARY_STT_ARTIFACT,
  PRIMARY_STT_ARTIFACT_SHA256,
  PRIMARY_STT_MODEL_DIR,
  PRIMARY_STT_MODEL_ID,
  PRIMARY_STT_MODEL_REVISION,
  SPEAKER_ARTIFACT,
  SPEAKER_ARTIFACT_SHA256,
  SPEAKER_MODEL_ID,
  SPEAKER_MODEL_PATH,
  SPEAKER_MODEL_REVISION,
  STT_MODEL_ID,
  STT_MODEL_PATH,
  STT_MODEL_REVISION,
  STT_MODEL_SHA256,
  QWEN_PYTHON,
} from './constants.js'
import { unavailable } from './errors.js'
import { normalizeVector } from './speaker-cluster.js'

const PYTHON_STT_SCRIPT = new URL('../scripts/stt_worker.py', import.meta.url)
const PYTHON_PRIMARY_STT_SCRIPT = new URL('../scripts/paraformer_worker.py', import.meta.url)
const PYTHON_SPEAKER_SCRIPT = new URL('../scripts/speaker_worker.py', import.meta.url)

function text(value) {
  return String(value ?? '')
}

function commandLabel(command, args) {
  return [command, ...(args || [])].join(' ')
}

/** A small persistent JSON-lines worker used by the formal local backends. */
export class JsonLineWorker {
  constructor({ command, args = [], cwd = '/', env = {}, spawnImpl = nodeSpawn, name = 'worker', timeoutMs = 15 * 60_000 } = {}) {
    this.command = command
    this.args = [...args]
    this.cwd = cwd
    this.env = { ...env }
    this.spawnImpl = spawnImpl
    this.name = name
    this.timeoutMs = timeoutMs
    this.child = null
    this.readline = null
    this.pending = new Map()
    this.sequence = 0
    this.state = 'idle'
    this.lastError = null
  }

  async start() {
    if (this.child && this.state === 'running') return
    if (this.state === 'failed') this.state = 'idle'
    let child
    try {
      child = this.spawnImpl(this.command, this.args, {
        cwd: this.cwd,
        env: { ...process.env, ...this.env, PYTHONUNBUFFERED: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      this.state = 'failed'
      this.lastError = error
      throw unavailable('MODEL_WORKER_START_FAILED', `${this.name} 启动失败`, { message: text(error?.message || error) })
    }
    this.child = child
    this.state = 'running'
    this.lastError = null
    if (child.stdout) {
      this.readline = createInterface({ input: child.stdout })
      this.readline.on('line', (line) => this.#onLine(line))
    }
    child.stderr?.on('data', (chunk) => {
      this.lastError = new Error(text(chunk).trim().slice(-2_000))
    })
    child.on?.('error', (error) => this.#onExit(error))
    child.on?.('close', (code, signal) => this.#onExit(new Error(`${this.name} exited (${code ?? 'null'}${signal ? `/${signal}` : ''})`)))
  }

  async call(payload, { timeoutMs = this.timeoutMs } = {}) {
    await this.start()
    if (!this.child?.stdin || this.state !== 'running') throw unavailable('MODEL_WORKER_NOT_RUNNING', `${this.name} 未运行`)
    const id = `${this.name}-${++this.sequence}-${randomUUID()}`
    const request = { ...payload, id }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(unavailable('MODEL_WORKER_TIMEOUT', `${this.name} 处理超时`, { timeoutMs }))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child.stdin.write(`${JSON.stringify(request)}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(unavailable('MODEL_WORKER_WRITE_FAILED', `${this.name} 写入失败`, { message: text(error?.message || error) }))
      }
    })
  }

  async stop() {
    this.readline?.close()
    this.readline = null
    const child = this.child
    this.child = null
    this.state = 'idle'
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(unavailable('MODEL_WORKER_STOPPED', `${this.name} 已停止`))
    }
    this.pending.clear()
    if (child && typeof child.kill === 'function') child.kill('SIGTERM')
  }

  #onLine(line) {
    let response
    try { response = JSON.parse(line) } catch { return }
    const pending = response && this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    clearTimeout(pending.timer)
    if (response.ok) pending.resolve(response.result || {})
    else pending.reject(unavailable('MODEL_WORKER_REQUEST_FAILED', `${this.name} 处理失败`, response.error || {}))
  }

  #onExit(error) {
    if (this.state === 'idle') return
    this.state = 'failed'
    this.lastError = error
    this.child = null
    this.readline?.close()
    this.readline = null
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(unavailable('MODEL_WORKER_EXITED', `${this.name} 已退出`, { message: text(error?.message || error) }))
    }
    this.pending.clear()
  }

  descriptor() {
    return {
      name: this.name,
      command: commandLabel(this.command, this.args),
      state: this.state,
      error: this.lastError ? text(this.lastError.message).slice(0, 500) : null,
    }
  }
}

async function executable(path) {
  try {
    await access(path, fsConstants.X_OK)
    return true
  } catch { return false }
}

async function directory(path) {
  try { return (await stat(path)).isDirectory() } catch { return false }
}

async function file(path) {
  try { return (await stat(path)).isFile() } catch { return false }
}

export function expectedModelManifest() {
  return {
    schema: MODEL_MANIFEST_SCHEMA,
    models: {
      sttPrimary: {
        id: PRIMARY_STT_MODEL_ID,
        path: join(MODEL_ROOT, PRIMARY_STT_MODEL_DIR),
        revision: PRIMARY_STT_MODEL_REVISION,
        artifact: PRIMARY_STT_ARTIFACT,
        artifactSha256: PRIMARY_STT_ARTIFACT_SHA256,
        verification: 'artifact-sha256',
      },
      stt: {
        id: STT_MODEL_ID,
        path: STT_MODEL_PATH,
        revision: STT_MODEL_REVISION,
        sha256: STT_MODEL_SHA256,
        verification: 'directory-sha256',
      },
      speaker: {
        id: SPEAKER_MODEL_ID,
        path: SPEAKER_MODEL_PATH,
        revision: SPEAKER_MODEL_REVISION,
        artifact: SPEAKER_ARTIFACT,
        artifactSha256: SPEAKER_ARTIFACT_SHA256,
        verification: 'artifact-sha256',
      },
    },
    runtime: {
      sttPython: QWEN_PYTHON,
      speakerPython: FUNASR_PYTHON,
      preferredDevice: 'mps',
      fallbackDevice: 'cpu',
    },
    paidApiFallback: false,
  }
}

export class LocalModelBackend {
  constructor({
    modelRoot = MODEL_ROOT,
    manifestPath = join(modelRoot, 'manifest.json'),
    sttPython = QWEN_PYTHON,
    primarySttPython = FUNASR_PYTHON,
    speakerPython = FUNASR_PYTHON,
    sttModelPath = join(modelRoot, STT_MODEL_ID),
    primarySttModelPath = join(modelRoot, PRIMARY_STT_MODEL_DIR),
    speakerModelPath = join(modelRoot, 'speech_eres2netv2_sv_zh-cn_16k-common'),
    spawnImpl = nodeSpawn,
  } = {}) {
    this.modelRoot = modelRoot
    this.manifestPath = manifestPath
    this.sttPython = sttPython
    this.primarySttPython = primarySttPython
    this.speakerPython = speakerPython
    this.sttModelPath = sttModelPath
    this.primarySttModelPath = primarySttModelPath
    this.speakerModelPath = speakerModelPath
    this.spawnImpl = spawnImpl
    this.sttWorker = null
    this.whisperWorker = null
    this.speakerWorker = null
  }

  async health() {
    const errors = []
    const expected = expectedModelManifest()
    let manifest = null
    try {
      manifest = JSON.parse(await readFile(this.manifestPath, 'utf8'))
    } catch (error) {
      errors.push({ code: 'MODEL_MANIFEST_MISSING', message: `模型清单不可用：${text(error?.message || error).slice(0, 240)}` })
    }
    if (!manifest || manifest.schema !== MODEL_MANIFEST_SCHEMA) {
      errors.push({ code: 'MODEL_MANIFEST_INVALID', message: '模型清单 schema 无效' })
    } else {
      const primaryStt = manifest.models?.sttPrimary || {}
      const stt = manifest.models?.stt || {}
      const speaker = manifest.models?.speaker || {}
      if (primaryStt.id !== expected.models.sttPrimary.id || primaryStt.revision !== expected.models.sttPrimary.revision || primaryStt.artifactSha256 !== expected.models.sttPrimary.artifactSha256) {
        errors.push({ code: 'PRIMARY_STT_MODEL_LOCK_MISMATCH', message: 'Paraformer 模型 revision/hash 不匹配' })
      }
      if (stt.id !== expected.models.stt.id || stt.revision !== expected.models.stt.revision || stt.sha256 !== expected.models.stt.sha256) {
        errors.push({ code: 'STT_MODEL_LOCK_MISMATCH', message: 'Whisper 模型 revision/hash 不匹配' })
      }
      if (speaker.id !== expected.models.speaker.id || speaker.revision !== expected.models.speaker.revision || speaker.artifactSha256 !== expected.models.speaker.artifactSha256) {
        errors.push({ code: 'SPEAKER_MODEL_LOCK_MISMATCH', message: 'ERes2NetV2 模型 revision/hash 不匹配' })
      }
    }
    const [sttPythonReady, primarySttPythonReady, speakerPythonReady, sttReady, primarySttReady, primarySttArtifactReady, speakerReady, speakerArtifactReady] = await Promise.all([
      executable(this.sttPython), executable(this.primarySttPython), executable(this.speakerPython), directory(this.sttModelPath), directory(this.primarySttModelPath), file(join(this.primarySttModelPath, PRIMARY_STT_ARTIFACT)), directory(this.speakerModelPath), file(join(this.speakerModelPath, SPEAKER_ARTIFACT)),
    ])
    if (!sttPythonReady) errors.push({ code: 'STT_PYTHON_MISSING', message: 'qwen-mlx Python 运行时不存在' })
    if (!primarySttPythonReady) errors.push({ code: 'PRIMARY_STT_PYTHON_MISSING', message: 'FunASR 中文转写 Python 运行时不存在' })
    if (!speakerPythonReady) errors.push({ code: 'SPEAKER_PYTHON_MISSING', message: 'FunASR Python 运行时不存在' })
    if (!sttReady) errors.push({ code: 'STT_MODEL_MISSING', message: `Whisper 模型目录不存在：${this.sttModelPath}` })
    if (!primarySttReady || !primarySttArtifactReady) errors.push({ code: 'PRIMARY_STT_MODEL_MISSING', message: `Paraformer 模型目录或权重不存在：${this.primarySttModelPath}` })
    if (!speakerReady || !speakerArtifactReady) errors.push({ code: 'SPEAKER_MODEL_MISSING', message: `ERes2NetV2 模型目录或权重不存在：${this.speakerModelPath}` })
    const sttErrors = errors.filter((item) => item.code.startsWith('STT_') || item.code.startsWith('PRIMARY_STT_') || item.code.startsWith('MODEL_'))
    const speakerErrors = errors.filter((item) => item.code.startsWith('SPEAKER_') || item.code.startsWith('MODEL_'))
    return {
      provider: 'local-only',
      ready: errors.length === 0,
      paidApiFallback: false,
      modelRoot: this.modelRoot,
      manifestPath: this.manifestPath,
      stt: {
        ready: sttErrors.length === 0,
        backend: 'funasr-paraformer',
        modelId: PRIMARY_STT_MODEL_ID,
        modelPath: this.primarySttModelPath,
        revision: PRIMARY_STT_MODEL_REVISION,
        command: [this.primarySttPython, fileURLToPathSafe(PYTHON_PRIMARY_STT_SCRIPT)],
        fallback: { backend: 'mlx-whisper', modelId: STT_MODEL_ID, modelPath: this.sttModelPath, revision: STT_MODEL_REVISION },
        errors: sttErrors,
      },
      speaker: {
        ready: speakerErrors.length === 0,
        backend: 'funasr-eres2netv2',
        modelId: SPEAKER_MODEL_ID,
        modelPath: this.speakerModelPath,
        revision: SPEAKER_MODEL_REVISION,
        device: process.platform === 'darwin' ? 'mps-preferred/cpu-fallback' : 'cpu',
        command: [this.speakerPython, 'speaker_worker.py'],
        errors: speakerErrors,
      },
      workers: {
        stt: this.sttWorker?.descriptor() || { name: 'stt', state: 'idle', command: `${this.primarySttPython} ${fileURLToPathSafe(PYTHON_PRIMARY_STT_SCRIPT)}`, error: null },
        sttFallback: this.whisperWorker?.descriptor() || { name: 'stt-fallback', state: 'idle', command: `${this.sttPython} ${fileURLToPathSafe(PYTHON_STT_SCRIPT)}`, error: null },
        speaker: this.speakerWorker?.descriptor() || { name: 'speaker', state: 'idle', command: `${this.speakerPython} ${fileURLToPathSafe(PYTHON_SPEAKER_SCRIPT)}`, error: null },
      },
    }
  }

  async transcribe({ audioPath, language = 'zh' } = {}) {
    const health = await this.health()
    if (!health.stt.ready) throw unavailable('MODEL_NOT_READY', '本地中文转写模型尚未就绪', { component: 'stt', errors: health.stt.errors })
    if (!this.sttWorker) {
      this.sttWorker = new JsonLineWorker({
        command: this.primarySttPython,
        args: [fileURLToPathSafe(PYTHON_PRIMARY_STT_SCRIPT), '--model', this.primarySttModelPath],
        cwd: dirname(this.primarySttModelPath),
        spawnImpl: this.spawnImpl,
        name: 'paraformer-worker',
      })
    }
    try {
      const result = await this.sttWorker.call({ op: 'transcribe', audioPath, language })
      return { ...result, backend: 'funasr-paraformer' }
    } catch (primaryError) {
      if (!this.whisperWorker) {
        this.whisperWorker = new JsonLineWorker({
          command: this.sttPython,
          args: [fileURLToPathSafe(PYTHON_STT_SCRIPT), '--model', this.sttModelPath],
          cwd: dirname(this.sttModelPath),
          spawnImpl: this.spawnImpl,
          name: 'whisper-fallback-worker',
        })
      }
      const result = await this.whisperWorker.call({ op: 'transcribe', audioPath, language })
      return { ...result, backend: 'mlx-whisper-fallback', fallbackReason: text(primaryError?.message || primaryError).slice(0, 300) }
    }
  }

  async embed({ audioPath } = {}) {
    const health = await this.health()
    if (!health.speaker.ready) throw unavailable('MODEL_NOT_READY', '本地 ERes2NetV2 模型尚未就绪', { component: 'speaker', errors: health.speaker.errors })
    if (!this.speakerWorker) {
      this.speakerWorker = new JsonLineWorker({
        command: this.speakerPython,
        args: [fileURLToPathSafe(PYTHON_SPEAKER_SCRIPT), '--model', this.speakerModelPath, '--device', 'mps'],
        cwd: dirname(this.speakerModelPath),
        spawnImpl: this.spawnImpl,
        name: 'speaker-worker',
      })
    }
    return this.speakerWorker.call({ op: 'embed', audioPath })
  }

  async cluster({ vectors, oracleNum = null } = {}) {
    const health = await this.health()
    if (!health.speaker.ready) throw unavailable('MODEL_NOT_READY', '本地 ERes2NetV2 模型尚未就绪', { component: 'speaker', errors: health.speaker.errors })
    if (!Array.isArray(vectors) || vectors.length === 0) return { labels: [], centers: [] }
    if (!this.speakerWorker) {
      this.speakerWorker = new JsonLineWorker({
        command: this.speakerPython,
        args: [fileURLToPathSafe(PYTHON_SPEAKER_SCRIPT), '--model', this.speakerModelPath, '--device', 'mps'],
        cwd: dirname(this.speakerModelPath),
        spawnImpl: this.spawnImpl,
        name: 'speaker-worker',
      })
    }
    return this.speakerWorker.call({ op: 'cluster', vectors, oracleNum })
  }

  async close() {
    await Promise.all([this.sttWorker?.stop(), this.whisperWorker?.stop(), this.speakerWorker?.stop()])
    this.sttWorker = null
    this.whisperWorker = null
    this.speakerWorker = null
  }

  binding() {
    return {
      ...DEFAULT_MODEL_BINDING,
      stt: { provider: 'funasr', model: PRIMARY_STT_MODEL_ID, revision: PRIMARY_STT_MODEL_REVISION, fallback: { provider: 'mlx-whisper', model: STT_MODEL_ID, revision: STT_MODEL_REVISION } },
      speaker: { provider: 'funasr', model: SPEAKER_MODEL_ID, revision: SPEAKER_MODEL_REVISION },
    }
  }
}

function fileURLToPathSafe(url) {
  return decodeURIComponent(url.pathname)
}

export class FakeModelBackend {
  constructor({ segments = null, fail = null, speakerVectors = null } = {}) {
    this.segments = segments
    this.fail = fail
    this.speakerVectors = speakerVectors
    this.calls = []
  }

  async health() {
    return {
      provider: 'fake-local-test-only',
      ready: true,
      paidApiFallback: false,
      stt: { ready: true, backend: 'fake', modelId: 'fake-stt', errors: [] },
      speaker: { ready: true, backend: 'fake', modelId: 'fake-speaker', device: 'cpu', errors: [] },
      workers: { stt: { state: 'idle' }, speaker: { state: 'idle' } },
    }
  }

  async transcribe(input = {}) {
    this.calls.push({ method: 'transcribe', input })
    if (this.fail === 'transcribe') throw new Error('fake transcribe failure')
    const source = input.source || 'system'
    if (Array.isArray(this.segments)) return { segments: this.segments.map((item) => ({ ...item, source: item.source || source })) }
    return {
      text: '测试速记内容',
      segments: [{ startMs: 0, endMs: 1_000, text: '测试速记内容', confidence: 0.99, source }],
    }
  }

  async embed(input = {}) {
    this.calls.push({ method: 'embed', input })
    if (this.fail === 'embed') throw new Error('fake speaker failure')
    if (Array.isArray(this.speakerVectors)) return { vector: [...this.speakerVectors], device: 'cpu' }
    const hint = text(input.speakerHint || input.source || 'system')
    return { vector: hint.includes('microphone') || hint.includes('local') ? [1, 0, 0] : [0, 1, 0], device: 'cpu' }
  }

  async cluster({ vectors = [] } = {}) {
    this.calls.push({ method: 'cluster', input: { vectors } })
    if (this.fail === 'cluster') throw new Error('fake cluster failure')
    const labels = vectors.map((vector) => (Number(vector?.[0] || 0) >= Number(vector?.[1] || 0) ? 0 : 1))
    return { labels, centers: [[1, 0, 0], [0, 1, 0]].slice(0, Math.max(0, ...labels) + 1) }
  }

  binding() {
    return { provider: 'fake-local-test-only', model: 'fake', paidApiFallback: false }
  }

  async close() {}
}

export class ModelSupervisor {
  constructor({ backend = new LocalModelBackend() } = {}) {
    this.backend = backend
    this.queue = Promise.resolve()
    this.state = 'idle'
    this.lastError = null
  }

  async health() {
    const value = await this.backend.health()
    return { ...value, supervisor: { state: this.state, error: this.lastError ? text(this.lastError.message || this.lastError).slice(0, 500) : null } }
  }

  #run(method, input) {
    const task = this.queue.then(async () => {
      this.state = 'running'
      this.lastError = null
      try { return await this.backend[method](input) } catch (error) {
        this.state = 'failed'
        this.lastError = error
        throw error
      } finally {
        if (this.state === 'running') this.state = 'idle'
      }
    })
    this.queue = task.catch(() => {})
    return task
  }

  transcribe(input) { return this.#run('transcribe', input) }
  embed(input) { return this.#run('embed', input) }
  cluster(input) { return this.#run('cluster', input) }

  binding() {
    return typeof this.backend.binding === 'function' ? this.backend.binding() : { ...DEFAULT_MODEL_BINDING }
  }

  async close() {
    await this.queue.catch(() => {})
    await this.backend.close?.()
    this.state = 'idle'
  }
}
