import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const sourcePath = join(root, '大神.swift')
const plistPath = join(root, 'Info.plist')
const signingScriptPath = join(root, 'sign-dashen-local.sh')

test('native stenographer bridge covers source selection, lifecycle and bounded PCM uploads', async () => {
  const source = await readFile(sourcePath, 'utf8')
  const plist = await readFile(plistPath, 'utf8')

  assert.match(source, /userContentController\.add\(self, name: "stenographer"\)/)
  assert.match(source, /case "start"[\s\S]*case "pause", "resume", "stop"/)
  assert.match(source, /\["microphone", "system", "both"\]/)
  assert.match(source, /STENOGRAPHER_SAMPLE_RATE: Double = 16_000/)
  assert.match(source, /STENOGRAPHER_CHANNEL_COUNT: AVAudioChannelCount = 1/)
  assert.match(source, /pcmFormatInt16/)
  assert.match(source, /littleEndian/)
  assert.match(source, /AVAudioEngine/)
  assert.match(source, /ScreenCaptureKit/)
  assert.match(source, /SCStreamConfiguration/)
  assert.match(source, /capturesAudio = true/)
  assert.match(source, /sampleRate = Int\(STENOGRAPHER_SAMPLE_RATE\)/)
  assert.match(source, /X-Stenographer-Token/)
  assert.match(source, /url\.scheme == "http"/)
  assert.match(source, /url\.host == "127\.0\.0\.1"/)
  assert.match(source, /url\.port == PORT/)
  assert.match(source, /\/api\/stenographer\/sessions\/\\\(sessionId\)\/audio/)
  assert.match(source, /URLQueryItem\(name: "source"/)
  assert.match(source, /URLQueryItem\(name: "seq"/)
  assert.match(source, /URLQueryItem\(name: "capturedAtMs"/)
  assert.match(source, /STENOGRAPHER_MAX_PENDING_UPLOADS/)
  assert.match(source, /upload_queue_overflow/)
  assert.match(source, /func pause\(/)
  assert.match(source, /func resume\(/)
  assert.match(source, /func stop\(/)
  assert.match(source, /queue\?\.finish/)
  assert.match(source, /func interruptForTermination\(/)
  assert.match(source, /applicationWillTerminate[\s\S]*interruptForTermination\(\)/)
  assert.match(source, /windowShouldClose[\s\S]*orderOut\(nil\)[\s\S]*return false/)
  assert.match(source, /__dshStenographerNativeEvent/)
  assert.match(source, /microphone_permission_denied/)
  assert.match(source, /system_audio_unavailable/)
  assert.match(source, /upload_failed/)
  assert.match(source, /microphone_capture_error/)
  assert.match(plist, /NSScreenCaptureUsageDescription/)
  assert.match(plist, /NSAudioCaptureUsageDescription/)
})

test('native stenographer source compiles for arm64 macOS 13 with audio capture frameworks', async () => {
  const output = await mkdtemp(join(tmpdir(), 'dashen-stenographer-native-'))
  try {
    const result = spawnSync('swiftc', [
      '-O',
      '-target', 'arm64-apple-macos13.0',
      '-o', join(output, '大神'),
      sourcePath,
      '-framework', 'Cocoa',
      '-framework', 'WebKit',
      '-framework', 'Speech',
      '-framework', 'AVFoundation',
      '-framework', 'ScreenCaptureKit',
      '-framework', 'CoreMedia',
      '-framework', 'AudioToolbox'
    ], { encoding: 'utf8', timeout: 120_000 })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})

test('local app signing keeps a stable designated requirement for macOS permissions', async () => {
  const script = await readFile(signingScriptPath, 'utf8')
  assert.match(script, /CFBundleIdentifier/)
  assert.match(script, /bundle id=\$bundle_id/)
  assert.match(script, /--requirements "\$requirement"/)
  assert.match(script, /designated => identifier "local\.dsh\.dashen"/)
  assert.doesNotMatch(script, /tccutil/)
})
