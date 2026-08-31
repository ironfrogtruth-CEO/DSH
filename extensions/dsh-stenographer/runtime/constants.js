import { join } from 'node:path'

export const API_BASE_PATH = '/api/stenographer'
export const STORAGE_ROOT = '/Users/marcus/.dsh/private/stenographer'
export const MODEL_ROOT = '/Users/marcus/.dsh/runtimes/stenographer/models'

// The runtime paths below are the already-provisioned local Python environments.
// Model weights are deliberately kept separate under MODEL_ROOT so installation
// and health checks can be audited without touching the source checkout.
export const QWEN_PYTHON = '/Users/marcus/Desktop/虾缸/MODEL/tts/运行环境/qwen-mlx/bin/python'
export const FUNASR_PYTHON = '/Users/marcus/Desktop/虾缸/MODEL/tts/运行环境/voxcpm2/bin/python'

export const STT_MODEL_ID = 'whisper-large-v3-turbo'
export const STT_MODEL_PATH = join(MODEL_ROOT, STT_MODEL_ID)
export const STT_MODEL_REVISION = 'mlx-community/whisper-large-v3-turbo@5de18eed9776b69b42d4191b7edc9aca24c67265ce2121806e089cf66093079f'
export const STT_MODEL_SHA256 = '5de18eed9776b69b42d4191b7edc9aca24c67265ce2121806e089cf66093079f'

export const PRIMARY_STT_MODEL_ID = 'iic/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch'
export const PRIMARY_STT_MODEL_DIR = 'paraformer-large-vad-punc'
export const PRIMARY_STT_MODEL_PATH = join(MODEL_ROOT, PRIMARY_STT_MODEL_DIR)
export const PRIMARY_STT_MODEL_REVISION = 'v2.0.5'
export const PRIMARY_STT_ARTIFACT = 'model.pt'
export const PRIMARY_STT_ARTIFACT_SHA256 = 'fd7c1c6fa7f499377d238b3f3790eb2f6f16318a0e33e33ae50936725f4d8388'

export const SPEAKER_MODEL_ID = 'iic/speech_eres2netv2_sv_zh-cn_16k-common'
export const SPEAKER_MODEL_DIR = 'speech_eres2netv2_sv_zh-cn_16k-common'
export const SPEAKER_MODEL_PATH = join(MODEL_ROOT, SPEAKER_MODEL_DIR)
export const SPEAKER_MODEL_REVISION = 'v1.0.1'
export const SPEAKER_ARTIFACT = 'pretrained_eres2netv2.ckpt'
export const SPEAKER_ARTIFACT_SHA256 = '0eb4057106b2573dd7b132cf0c36273ab29afd192c1610f80baa9c556dbb963c'

export const MODEL_MANIFEST_PATH = join(MODEL_ROOT, 'manifest.json')
export const MODEL_MANIFEST_SCHEMA = 'stenographer_model_manifest.v1'

export const SAMPLE_RATE = 16_000
export const CHANNELS = 1
export const BYTES_PER_SAMPLE = 2
export const MAX_AUDIO_CHUNK_BYTES = 1_048_576
export const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024
export const MAX_CREATE_BODY_BYTES = 64 * 1024
export const MAX_STATE_BODY_BYTES = 64 * 1024
export const MAX_HANDOFF_BODY_BYTES = 128 * 1024
export const MAX_GENERATED_ARTIFACT_CHARS = 120_000
export const WRITER_GENERATION_TIMEOUT_MS = 10 * 60_000
export const WRITER_API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
export const MAX_MEDIA_BODY_BYTES = 12 * 1024 * 1024
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024
export const MAX_DOCUMENT_BLOCKS = 50_000
export const MAX_TEXT_CHARS = 200_000
export const MAX_TITLE_CHARS = 180
export const MAX_EXTRA_INSTRUCTIONS_CHARS = 8_000
export const MAX_SPEAKER_NAME_CHARS = 120
export const MAX_MEDIA_NAME_CHARS = 180
export const MAX_SESSION_ID_CHARS = 64

export const PURPOSES = Object.freeze([
  'meeting_minutes',
  'report_email',
  'requirements_document',
  'custom',
])

export const AUDIO_SOURCES = Object.freeze(['microphone', 'system'])
export const SESSION_SOURCES = Object.freeze(['microphone', 'system', 'both'])
export const SESSION_STATES = Object.freeze([
  'created',
  'loading',
  'recording',
  'paused',
  'stopped',
  'interrupted',
  'finalizing',
  'ready',
  'error',
])

export const IMAGE_MIME_TYPES = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
})

export const LIVE_WINDOW_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * 2
// Short meeting utterances are less stable than full enrollment clips. Real
// Chinese acceptance measured 0.5737 for two adjacent segments from the same
// speaker while different speakers stayed at or below 0.1614.
export const SPEAKER_INCREMENTAL_THRESHOLD = 0.55
// Accepted matches below this confidence remain visibly uncertain until more
// speaker evidence is available.
export const SPEAKER_UNCERTAIN_THRESHOLD = 0.56
export const SPEAKER_RECLUSTER_EMBEDDINGS = 20

export const DEFAULT_MODEL_BINDING = Object.freeze({
  provider: 'zhipu-glm',
  model: 'glm-5.3-flash',
  paidApiFallback: false,
})
