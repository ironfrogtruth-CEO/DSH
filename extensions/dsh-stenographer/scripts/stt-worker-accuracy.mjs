#!/usr/bin/env node
/**
 * Replay the local MLX Whisper worker against one or more WAV files.
 *
 * Usage:
 *   node scripts/stt-worker-accuracy.mjs --audio /absolute/file.wav
 *
 * This command is intentionally separate from the normal JS unit suite: it
 * loads the 1.5GB local model and is used for release/field replay only.
 */
import assert from 'node:assert/strict'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const worker = join(root, 'scripts', 'stt_worker.py')
const model = process.env.STENOGRAPHER_STT_MODEL || '/Users/marcus/.dsh/runtimes/stenographer/models/whisper-large-v3-turbo'
const python = process.env.STENOGRAPHER_STT_PYTHON || '/Users/marcus/Desktop/虾缸/MODEL/tts/运行环境/qwen-mlx/bin/python'
const audioArgs = []
for (let index = 0; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--audio' && process.argv[index + 1]) audioArgs.push(resolve(process.argv[++index]))
}

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

function callWorker(paths) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, [worker, '--model', model], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`worker exited ${code}: ${stderr.slice(-1000)}`))
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
      if (lines.length !== paths.length) return reject(new Error(`worker returned ${lines.length} responses for ${paths.length} requests`))
      try { resolvePromise(lines.map((line) => JSON.parse(line))) } catch (error) { reject(error) }
    })
    for (const [index, path] of paths.entries()) child.stdin.write(`${JSON.stringify({ id: String(index), op: 'transcribe', audioPath: path, language: 'zh' })}\n`)
    child.stdin.end()
  })
}

const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-stt-accuracy-'))
try {
  const silence = join(tempRoot, 'silence.wav')
  const pcm = Buffer.alloc(16_000 * 2 * 12)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16_000, 24)
  header.writeUInt32LE(32_000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  await writeFile(silence, Buffer.concat([header, pcm]), { mode: 0o600 })

  const paths = audioArgs.length ? audioArgs : [silence]
  for (const path of paths) assert.equal(await exists(path), true, `audio does not exist: ${path}`)
  const responses = await callWorker(paths)
  const report = responses.map((response, index) => {
    assert.equal(response.ok, true, JSON.stringify(response))
    const result = response.result || {}
    const segments = result.segments || []
    assert.ok(segments.every((segment) => Number(segment.endMs) >= Number(segment.startMs)), 'timestamps must be monotonic')
    if (paths[index] === silence) assert.equal(segments.length, 0, '12s digital silence must not fabricate text')
    return { audio: paths[index], text: result.text || '', segmentCount: segments.length, segments }
  })
  process.stdout.write(`${JSON.stringify({ ok: true, model, python, report }, null, 2)}\n`)
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
