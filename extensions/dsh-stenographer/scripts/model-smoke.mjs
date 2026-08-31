#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { LocalModelBackend } from '../runtime/model-supervisor.js'
import { IncrementalSpeakerCluster, cosineSimilarity } from '../runtime/speaker-cluster.js'

const modelRoot = '/Users/marcus/.dsh/runtimes/stenographer/models'
const examples = join(modelRoot, 'speech_eres2netv2_sv_zh-cn_16k-common', 'examples')
const audioIndex = process.argv.indexOf('--audio')
const audioPath = audioIndex >= 0 ? process.argv[audioIndex + 1] : ''
const backend = new LocalModelBackend({ modelRoot })

try {
  const health = await backend.health()
  assert.equal(health.ready, true, JSON.stringify(health.errors || health, null, 2))
  const speaker1a = (await backend.embed({ audioPath: join(examples, 'speaker1_a_cn_16k.wav') })).vector
  const speaker1b = (await backend.embed({ audioPath: join(examples, 'speaker1_b_cn_16k.wav') })).vector
  const speaker2a = (await backend.embed({ audioPath: join(examples, 'speaker2_a_cn_16k.wav') })).vector
  const same = cosineSimilarity(speaker1a, speaker1b)
  const different = cosineSimilarity(speaker1a, speaker2a)
  assert.ok(same >= 0.62, `同一说话人相似度过低: ${same}`)
  assert.ok(different < 0.62, `不同说话人相似度过高: ${different}`)
  const cluster = new IncrementalSpeakerCluster()
  const first = cluster.assign(speaker1a)
  const second = cluster.assign(speaker1b)
  const third = cluster.assign(speaker2a)
  assert.equal(first.speakerId, second.speakerId, '同一说话人必须保持稳定 ID')
  assert.notEqual(first.speakerId, third.speakerId, '不同说话人必须分配不同 ID')

  let transcription = null
  if (audioPath) {
    assert.ok(existsSync(audioPath), `STT 验收音频不存在: ${audioPath}`)
    transcription = await backend.transcribe({ audioPath, language: 'zh' })
    assert.ok(String(transcription.text || '').trim(), 'Whisper 没有返回文字')
    assert.ok(Array.isArray(transcription.segments) && transcription.segments.length > 0, 'Whisper 没有返回时间戳段落')
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    health: { stt: health.stt.modelId, speaker: health.speaker.modelId, device: health.speaker.device },
    speaker: { sameCosine: same, differentCosine: different, ids: [first.speakerId, second.speakerId, third.speakerId] },
    transcription: transcription && { text: transcription.text, segments: transcription.segments.length },
  }, null, 2)}\n`)
} finally {
  await backend.close()
}
