#!/bin/bash
# Install the pinned, free local models used by dsh-stenographer.
# This script is intentionally never run during bundle installation. The
# integrator invokes it explicitly after reviewing the network/download step.
set -euo pipefail

MODEL_ROOT="/Users/marcus/.dsh/runtimes/stenographer/models"
STT_SOURCE="/Users/marcus/Desktop/虾缸/MODEL/tts/语音识别模型/whisper-large-v3-turbo"
STT_DEST="$MODEL_ROOT/whisper-large-v3-turbo"
SPEAKER_ID="iic/speech_eres2netv2_sv_zh-cn_16k-common"
SPEAKER_REVISION="v1.0.1"
SPEAKER_DEST="$MODEL_ROOT/speech_eres2netv2_sv_zh-cn_16k-common"
SPEAKER_ARTIFACT="pretrained_eres2netv2.ckpt"
SPEAKER_ARTIFACT_SHA256="0eb4057106b2573dd7b132cf0c36273ab29afd192c1610f80baa9c556dbb963c"
STT_SHA256="5de18eed9776b69b42d4191b7edc9aca24c67265ce2121806e089cf66093079f"
STT_REVISION="mlx-community/whisper-large-v3-turbo@$STT_SHA256"
PRIMARY_STT_ID="iic/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
PRIMARY_STT_REVISION="v2.0.5"
PRIMARY_STT_DEST="$MODEL_ROOT/paraformer-large-vad-punc"
PRIMARY_STT_ARTIFACT="model.pt"
PRIMARY_STT_ARTIFACT_SHA256="fd7c1c6fa7f499377d238b3f3790eb2f6f16318a0e33e33ae50936725f4d8388"
FUNASR_PYTHON="/Users/marcus/Desktop/虾缸/MODEL/tts/运行环境/voxcpm2/bin/python"

if [[ ! -x "$FUNASR_PYTHON" ]]; then
  echo "缺少 FunASR Python 运行时: $FUNASR_PYTHON" >&2
  exit 1
fi
if [[ ! -d "$STT_SOURCE" ]]; then
  echo "缺少已验证的 MLX Whisper 源模型: $STT_SOURCE" >&2
  exit 1
fi
if ! command -v rsync >/dev/null 2>&1; then
  echo "需要 rsync 以原子复制本地 Whisper 模型" >&2
  exit 1
fi

umask 077
mkdir -p "$MODEL_ROOT" "$STT_DEST" "$PRIMARY_STT_DEST" "$SPEAKER_DEST"
chmod 700 "$MODEL_ROOT" "$STT_DEST" "$PRIMARY_STT_DEST" "$SPEAKER_DEST"
rsync -a --delete --exclude '.DS_Store' "$STT_SOURCE/" "$STT_DEST/"

# Download exactly the ModelScope revision that owns the checked-in SHA-256
# lock. ModelScope is used only for this free local model; no cloud inference
# endpoint is contacted.
"$FUNASR_PYTHON" - "$SPEAKER_ID" "$SPEAKER_REVISION" "$SPEAKER_DEST" <<'PY'
import pathlib
import sys
from modelscope import snapshot_download

model_id, revision, target = sys.argv[1:4]
pathlib.Path(target).mkdir(parents=True, exist_ok=True)
result = snapshot_download(
    model_id=model_id,
    revision=revision,
    local_dir=target,
    local_files_only=False,
)
if pathlib.Path(result).resolve() != pathlib.Path(target).resolve():
    raise SystemExit(f"ModelScope returned an unexpected directory: {result}")
PY

"$FUNASR_PYTHON" - "$PRIMARY_STT_ID" "$PRIMARY_STT_REVISION" "$PRIMARY_STT_DEST" <<'PY'
import pathlib
import sys
from modelscope import snapshot_download

model_id, revision, target = sys.argv[1:4]
pathlib.Path(target).mkdir(parents=True, exist_ok=True)
result = snapshot_download(model_id=model_id, revision=revision, local_dir=target, local_files_only=False)
if pathlib.Path(result).resolve() != pathlib.Path(target).resolve():
    raise SystemExit(f"ModelScope returned an unexpected directory: {result}")
PY

if [[ ! -f "$SPEAKER_DEST/$SPEAKER_ARTIFACT" ]]; then
  echo "ERes2NetV2 权重下载后不存在: $SPEAKER_DEST/$SPEAKER_ARTIFACT" >&2
  exit 1
fi
actual_speaker_sha="$(shasum -a 256 "$SPEAKER_DEST/$SPEAKER_ARTIFACT" | awk '{print $1}')"
if [[ "$actual_speaker_sha" != "$SPEAKER_ARTIFACT_SHA256" ]]; then
  echo "ERes2NetV2 权重 SHA-256 不匹配: $actual_speaker_sha" >&2
  exit 1
fi
if [[ ! -f "$PRIMARY_STT_DEST/$PRIMARY_STT_ARTIFACT" ]]; then
  echo "Paraformer 权重下载后不存在: $PRIMARY_STT_DEST/$PRIMARY_STT_ARTIFACT" >&2
  exit 1
fi
actual_primary_stt_sha="$(shasum -a 256 "$PRIMARY_STT_DEST/$PRIMARY_STT_ARTIFACT" | awk '{print $1}')"
if [[ "$actual_primary_stt_sha" != "$PRIMARY_STT_ARTIFACT_SHA256" ]]; then
  echo "Paraformer 权重 SHA-256 不匹配: $actual_primary_stt_sha" >&2
  exit 1
fi

actual_stt_sha="$("$FUNASR_PYTHON" - "$STT_DEST" <<'PY'
import hashlib
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
digest = hashlib.sha256()
for path in sorted(p for p in root.rglob('*') if p.is_file() and p.name != '.DS_Store'):
    digest.update(path.relative_to(root).as_posix().encode())
    digest.update(b'\0')
    digest.update(hashlib.sha256(path.read_bytes()).hexdigest().encode())
    digest.update(b'\n')
print(digest.hexdigest())
PY
)"
if [[ "$actual_stt_sha" != "$STT_SHA256" ]]; then
  echo "Whisper 模型目录 SHA-256 不匹配: $actual_stt_sha" >&2
  exit 1
fi

"$FUNASR_PYTHON" - "$MODEL_ROOT/manifest.json" "$STT_DEST" "$PRIMARY_STT_DEST" "$SPEAKER_DEST" <<'PY'
import hashlib
import json
import pathlib
import sys
from datetime import datetime, timezone

manifest_path = pathlib.Path(sys.argv[1])
stt_path = pathlib.Path(sys.argv[2])
primary_stt_path = pathlib.Path(sys.argv[3])
speaker_path = pathlib.Path(sys.argv[4])
stt_sha = hashlib.sha256()
for path in sorted(p for p in stt_path.rglob('*') if p.is_file() and p.name != '.DS_Store'):
    stt_sha.update(path.relative_to(stt_path).as_posix().encode())
    stt_sha.update(b'\0')
    stt_sha.update(hashlib.sha256(path.read_bytes()).hexdigest().encode())
    stt_sha.update(b'\n')
speaker_sha = hashlib.sha256((speaker_path / 'pretrained_eres2netv2.ckpt').read_bytes()).hexdigest()
manifest = {
    'schema': 'stenographer_model_manifest.v1',
    'generatedAt': datetime.now(timezone.utc).isoformat(),
    'models': {
        'sttPrimary': {
            'id': 'iic/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch',
            'path': str(primary_stt_path),
            'revision': 'v2.0.5',
            'artifact': 'model.pt',
            'artifactSha256': hashlib.sha256((primary_stt_path / 'model.pt').read_bytes()).hexdigest(),
            'verification': 'artifact-sha256',
        },
        'stt': {
            'id': 'whisper-large-v3-turbo',
            'path': str(stt_path),
            'revision': 'mlx-community/whisper-large-v3-turbo@5de18eed9776b69b42d4191b7edc9aca24c67265ce2121806e089cf66093079f',
            'sha256': stt_sha.hexdigest(),
            'verification': 'directory-sha256',
        },
        'speaker': {
            'id': 'iic/speech_eres2netv2_sv_zh-cn_16k-common',
            'path': str(speaker_path),
            'revision': 'v1.0.1',
            'artifact': 'pretrained_eres2netv2.ckpt',
            'artifactSha256': speaker_sha,
            'verification': 'artifact-sha256',
        },
    },
    'runtime': {
        'sttPython': '/Users/marcus/Desktop/虾缸/MODEL/tts/运行环境/qwen-mlx/bin/python',
        'primarySttPython': '/Users/marcus/Desktop/虾缸/MODEL/tts/运行环境/voxcpm2/bin/python',
        'speakerPython': '/Users/marcus/Desktop/虾缸/MODEL/tts/运行环境/voxcpm2/bin/python',
        'preferredDevice': 'mps',
        'fallbackDevice': 'cpu',
    },
    'paidApiFallback': False,
}
temp = manifest_path.with_name(f'.{manifest_path.name}.tmp')
temp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
temp.chmod(0o600)
temp.replace(manifest_path)
manifest_path.chmod(0o600)
PY

echo "本地模型安装完成: $MODEL_ROOT"
