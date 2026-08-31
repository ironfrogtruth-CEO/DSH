#!/usr/bin/env python3
"""Persistent local Whisper worker for dsh-stenographer.

The worker intentionally uses mlx_whisper's segment API.  The broken
``mlx_audio --stream`` character-delta path is not used here; each request
returns complete segment text and timestamps, which the Host can reconcile.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import traceback
import wave


SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2
FRAME_MS = 20
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1_000


def _read_audio(audio_path: str):
    """Read a PCM WAV into mono float32 without changing the source file.

    The Host writes 16 kHz/mono PCM WAV files.  Keeping this small stdlib-only
    reader here makes the worker usable with the bundled Python runtime and
    lets us apply deterministic local preprocessing before Whisper sees a
    request.
    """
    import numpy as np

    with wave.open(audio_path, "rb") as handle:
        channels = handle.getnchannels()
        sample_rate = handle.getframerate()
        sample_width = handle.getsampwidth()
        frames = handle.getnframes()
        raw = handle.readframes(frames)
    if sample_width != BYTES_PER_SAMPLE:
        raise ValueError(f"unsupported WAV sample width: {sample_width}")
    if not raw:
        return np.zeros(0, dtype=np.float32), sample_rate
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples[: len(samples) - (len(samples) % channels)]
        samples = samples.reshape(-1, channels).mean(axis=1)
    if sample_rate != SAMPLE_RATE:
        # The recorder is fixed at 16 kHz.  This defensive path avoids silently
        # assigning wrong timestamps if an externally supplied WAV differs.
        target = max(1, int(round(len(samples) * SAMPLE_RATE / sample_rate)))
        old_x = np.linspace(0.0, 1.0, num=len(samples), endpoint=False)
        new_x = np.linspace(0.0, 1.0, num=target, endpoint=False)
        samples = np.interp(new_x, old_x, samples).astype(np.float32)
        sample_rate = SAMPLE_RATE
    return samples.astype(np.float32), sample_rate


def _high_pass(samples, sample_rate: int = SAMPLE_RATE, cutoff_hz: float = 80.0):
    """Remove low-frequency room/desk hum while preserving voice fundamentals."""
    import numpy as np

    if not len(samples):
        return samples
    alpha = math.exp(-2.0 * math.pi * cutoff_hz / sample_rate)
    output = np.empty_like(samples, dtype=np.float32)
    previous_input = 0.0
    previous_output = 0.0
    for index, value in enumerate(samples):
        previous_output = alpha * (previous_output + float(value) - previous_input)
        previous_input = float(value)
        output[index] = previous_output
    return output


def _frame_rms(samples):
    """Return 20ms RMS values used only for conservative post-decode QA."""
    import numpy as np

    frame_count = len(samples) // FRAME_SAMPLES
    if frame_count <= 0:
        return np.zeros(0, dtype=np.float32)
    frames = samples[: frame_count * FRAME_SAMPLES].reshape(frame_count, FRAME_SAMPLES)
    return np.sqrt(np.mean(frames * frames, axis=1)).astype(np.float32)


def _audio_activity(samples, start_ms: int, end_ms: int):
    """Score whether a decoded segment has enough local acoustic evidence.

    Whisper's no_speech_prob can be extremely low for a stationary microphone
    noise floor.  This independent energy gate is deliberately conservative:
    it only rejects long, weak segments or uses its score to select the best
    item from a repetition run; normal speech is not re-decoded or rewritten.
    """
    import numpy as np

    levels = _frame_rms(samples)
    if not len(levels):
        return {"activeRatio": 0.0, "p95": 0.0, "rms": 0.0}
    noise_floor = float(np.percentile(levels, 20))
    # The floor is estimated from the lower quintile, not from a fixed global
    # threshold, so a quiet close microphone remains usable.  The cap keeps a
    # loud recording from classifying every frame as active.
    threshold = max(0.018, min(0.032, noise_floor * 1.8 + 0.006))
    left = max(0, int(start_ms // FRAME_MS))
    right = min(len(levels), max(left + 1, int(math.ceil(end_ms / FRAME_MS))))
    if left >= len(levels) or right <= left:
        return {"activeRatio": 0.0, "p95": 0.0, "rms": 0.0}
    window = levels[left:right]
    return {
        "activeRatio": float(np.mean(window >= threshold)),
        "p95": float(np.percentile(window, 95)),
        "rms": float(np.sqrt(np.mean(window * window))),
    }


def _repeat_key(value: str) -> str:
    return re.sub(r"[\s，。！？、,.!?;；:：'\"“”‘’（）()\[\]【】]", "", value).lower()


def _collapse_repeated_text(value: str) -> str:
    """Collapse a single short token repeated three or more times in one span."""
    compact = _repeat_key(value)
    if len(compact) < 2 or len(compact) > 12:
        return value
    for unit_length in range(1, min(6, len(compact)) + 1):
        if len(compact) % unit_length:
            continue
        repeats = len(compact) // unit_length
        if repeats >= 3 and compact == compact[:unit_length] * repeats:
            unit = compact[:unit_length]
            # Preserve a Chinese full stop when the source had one; text is
            # intentionally normalized only for pathological repeated spans.
            return unit + ("。" if value.rstrip().endswith(("。", ".")) else "")
    return value


def _clean_segments(raw_segments, samples):
    """Remove empty/low-evidence hallucinations and merge repetition loops."""
    cleaned = []
    audio_duration_ms = len(samples) / SAMPLE_RATE * 1_000
    for item in raw_segments or []:
        text = " ".join(str(item.get("text") or "").split()).strip()
        if not text:
            continue
        start_ms = max(0, int(round(float(item.get("start", 0)) * 1000)))
        end_ms = max(start_ms, int(round(float(item.get("end", start_ms / 1000)) * 1000)))
        if start_ms >= audio_duration_ms:
            continue
        end_ms = min(end_ms, int(round(audio_duration_ms)))
        duration_ms = end_ms - start_ms
        activity = _audio_activity(samples, start_ms, end_ms)
        compression_ratio = item.get("compression_ratio")
        try:
            compression_ratio = float(compression_ratio)
        except (TypeError, ValueError):
            compression_ratio = None
        try:
            avg_logprob = float(item.get("avg_logprob"))
        except (TypeError, ValueError):
            avg_logprob = None

        # A high compression ratio is Whisper's own repetition alarm.  The
        # previous worker allowed such output through when the model's
        # no-speech probability was spuriously near zero.
        if compression_ratio is not None and compression_ratio > 2.4:
            continue
        # Long, quiet spans are the exact shape of the observed “中文字幕志
        # 愿者/李宗盛” hallucination.  Short real utterances remain eligible
        # even when the room noise floor is relatively high.
        if duration_ms >= 8_000 and activity["activeRatio"] < 0.15 and activity["p95"] < 0.04:
            continue
        if duration_ms >= 1_000 and avg_logprob is not None and avg_logprob < -1.2 and activity["activeRatio"] < 0.2:
            continue
        text = _collapse_repeated_text(text)
        cleaned.append({"item": item, "text": text, "startMs": start_ms, "endMs": end_ms, "activity": activity})

    # A short phrase repeated over a silent/low-energy tail is another common
    # Whisper failure mode.  Keep the acoustically strongest candidate for a
    # run of three or more identical short phrases; this does not merge
    # unrelated adjacent sentences.
    deduped = []
    index = 0
    while index < len(cleaned):
        current = cleaned[index]
        key = _repeat_key(current["text"])
        run = [current]
        next_index = index + 1
        while next_index < len(cleaned):
            candidate = cleaned[next_index]
            gap = candidate["startMs"] - run[-1]["endMs"]
            candidate_key = _repeat_key(candidate["text"])
            if key and key == candidate_key and len(key) <= 8 and gap <= 3_000:
                run.append(candidate)
                next_index += 1
            else:
                break
        if len(run) >= 3:
            deduped.append(max(run, key=lambda entry: (entry["activity"]["activeRatio"], entry["activity"]["p95"])))
        else:
            deduped.extend(run)
        index = next_index
    return deduped


def transcribe(audio_path: str, model_path: str, language: str = "zh") -> dict:
    import mlx_whisper

    samples, sample_rate = _read_audio(audio_path)
    if not len(samples):
        return {"text": "", "segments": [], "language": language}
    # A light high-pass is safer than aggressive spectral subtraction for
    # meeting speech: it removes the stationary low-frequency component that
    # triggered the observed tail hallucinations while retaining quiet Chinese
    # consonants and male voice fundamentals.
    samples = _high_pass(samples, sample_rate)
    # Do not spend a decode on a long region that is effectively a stationary
    # noise floor. The service VAD can join nearby fragments for context, so a
    # second, worker-local gate is needed for the observed 18–19s tail/noise
    # regions. Short live windows are intentionally left untouched.
    duration_ms = len(samples) / sample_rate * 1_000
    if duration_ms >= 5_000:
        global_activity = _audio_activity(samples, 0, int(round(duration_ms)))
        if global_activity["activeRatio"] < 0.06 and global_activity["p95"] < 0.035:
            return {"text": "", "segments": [], "language": language}
    result = mlx_whisper.transcribe(
        samples,
        path_or_hf_repo=model_path,
        language=language,
        # Keep only a language/style hint. The former “会议记录，简体中文。”
        # transcript template was copied into low-information audio and
        # caused repeated “会议记录/中文字幕志愿者” output.
        initial_prompt="请使用简体中文。",
        # Segment timestamps are sufficient for the editor. Word timestamps
        # make noisy meeting audio many times slower and are not exposed by the
        # stenographer document contract.
        word_timestamps=False,
        condition_on_previous_text=False,
        task="transcribe",
        temperature=0.0,
        compression_ratio_threshold=2.4,
        logprob_threshold=-1.0,
        no_speech_threshold=0.6,
        suppress_blank=True,
        verbose=False,
        fp16=True,
    )
    accepted = _clean_segments(result.get("segments", []) or [], samples)
    segments = []
    for entry in accepted:
        item = entry["item"]
        text = entry["text"]
        start_ms = entry["startMs"]
        end_ms = entry["endMs"]
        no_speech = item.get("no_speech_prob")
        avg_logprob = item.get("avg_logprob")
        confidence = 0.75
        if isinstance(no_speech, (int, float)) and math.isfinite(float(no_speech)):
            confidence = max(0.0, min(1.0, 1.0 - float(no_speech)))
        if isinstance(avg_logprob, (int, float)) and math.isfinite(float(avg_logprob)):
            confidence = max(0.0, min(confidence, min(1.0, max(0.0, 1.0 + float(avg_logprob) / 2.0))))
        segments.append({
            "startMs": start_ms,
            "endMs": end_ms,
            "text": text,
            "confidence": confidence,
            "compressionRatio": item.get("compression_ratio"),
            "noSpeechProbability": item.get("no_speech_prob"),
            "words": item.get("words") or [],
        })
    return {
        "text": "".join(item["text"] for item in segments).strip(),
        "segments": segments,
        "language": result.get("language") or language,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        request_id = None
        try:
            request = json.loads(raw)
            request_id = request.get("id")
            if request.get("op") != "transcribe":
                raise ValueError("unsupported operation")
            result = transcribe(str(request["audioPath"]), args.model, str(request.get("language") or "zh"))
            print(json.dumps({"id": request_id, "ok": True, "result": result}, ensure_ascii=False), flush=True)
        except Exception as exc:  # propagate structured failure to the Host
            print(json.dumps({
                "id": request_id,
                "ok": False,
                "error": {"type": type(exc).__name__, "message": str(exc), "trace": traceback.format_exc(limit=3)},
            }, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
