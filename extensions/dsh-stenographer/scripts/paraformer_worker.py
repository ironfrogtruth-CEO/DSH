#!/usr/bin/env python3
"""Persistent offline FunASR Paraformer worker for the stenographer.

The model is deliberately a fixed local path.  ``check_latest=False`` and
``vad_model/punc_model=None`` keep worker requests offline: the Host already
segments recordings before invoking this process and Paraformer supplies the
acoustic recognition only.  A single AutoModel instance is reused for all
JSONL requests so a meeting does not repeatedly load the 874 MB checkpoint.
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import math
import os
import re
import sys
import traceback
import unicodedata
import wave
from typing import Any, Iterable


MODEL_PATH = "/Users/marcus/.dsh/runtimes/stenographer/models/paraformer-large-vad-punc"
SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2
FRAME_MS = 20
MAX_SEGMENT_MS = 8_000
SPEECH_GAP_MS = 500
SILENCE_PEAK = 1e-4

# The acoustic model occasionally emits traditional characters even with a
# Chinese language hint.  This compact map covers the common chars observed in
# the real replay while keeping the worker dependency-free.  It is applied
# after decoding, never to the input audio.
TRADITIONAL_TO_SIMPLIFIED = str.maketrans({
    "萬": "万", "與": "与", "專": "专", "業": "业", "東": "东", "個": "个", "議": "议", "內": "内", "務": "务",
    "們": "们", "兩": "两", "中": "中", "為": "为", "喂": "喂", "國": "国",
    "園": "园", "圖": "图", "場": "场", "報": "报", "學": "学", "實": "实",
    "寶": "宝", "對": "对", "導": "导", "屬": "属", "師": "师", "幫": "帮",
    "帶": "带", "幹": "干", "廣": "广", "廠": "厂", "後": "后", "從": "从",
    "復": "复", "總": "总", "戶": "户", "應": "应", "懷": "怀", "愛": "爱",
    "慮": "虑", "應": "应", "憑": "凭", "憶": "忆", "戲": "戏", "戶": "户",
    "報": "报", "擇": "择", "數": "数", "斷": "断", "時": "时", "會": "会",
    "東": "东", "條": "条", "業": "业", "機": "机", "樹": "树", "歡": "欢",
    "歷": "历", "歸": "归", "準": "准", "漢": "汉", "為": "为", "無": "无",
    "現": "现", "產": "产", "發": "发", "確": "确", "碼": "码", "研": "研",
    "稱": "称", "積": "积", "窩": "窝", "競": "竞", "簡": "简", "約": "约",
    "級": "级", "經": "经", "結": "结", "統": "统", "給": "给", "維": "维",
    "緊": "紧", "線": "线", "編": "编", "縣": "县", "繫": "系", "繼": "继",
    "續": "续", "績": "绩", "總": "总", "與": "与", "臺": "台",
    "號": "号", "華": "华", "著": "著", "萬": "万", "見": "见", "規": "规",
    "覺": "觉", "觀": "观", "計": "计", "訂": "订", "認": "认", "評": "评",
    "該": "该", "誌": "志", "試": "试", "話": "话", "說": "说", "請": "请",
    "讀": "读", "課": "课", "誰": "谁", "調": "调", "談": "谈", "謂": "谓",
    "豐": "丰", "貓": "猫", "貝": "贝", "責": "责", "貴": "贵", "費": "费",
    "賴": "赖", "贊": "赞", "車": "车", "軍": "军", "輕": "轻", "轉": "转",
    "辦": "办", "边": "边", "這": "这", "通": "通", "過": "过", "還": "还",
    "進": "进", "選": "选", "醫": "医", "錯": "错", "長": "长", "門": "门",
    "間": "间", "陽": "阳", "陰": "阴", "際": "际", "難": "难", "雲": "云",
    "電": "电", "靈": "灵", "頁": "页", "頂": "顶", "預": "预", "頭": "头",
    "類": "类", "風": "风", "飛": "飞", "養": "养", "體": "体", "題": "题",
    "額": "额", "顧": "顾", "餘": "余", "館": "馆", "駛": "驶", "驗": "验",
    "髮": "发", "鬥": "斗", "魚": "鱼", "鳥": "鸟", "麵": "面", "黃": "黄",
    "點": "点", "黨": "党", "鼕": "冬", "審": "审", "開": "开", "產": "产",
    "評": "评", "員": "员", "雙": "双", "寵": "宠", "裡": "里", "夠": "够",
    "連": "连", "絡": "络", "協": "协", "護": "护", "環": "环", "態": "态",
    "動": "动", "層": "层", "來": "来", "麗": "丽", "還": "还", "將": "将",
    "確": "确", "真": "真", "傳": "传", "訊": "讯", "關": "关", "鍵": "键",
})

FILLER_TOKENS = frozenset({"呃", "嗯", "呃呃", "嗯嗯", "呃嗯", "嗯呃"})


def _simplify(value: str) -> str:
    return unicodedata.normalize("NFKC", value).translate(TRADITIONAL_TO_SIMPLIFIED)


def _read_wave(audio_path: str):
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
        target = max(1, int(round(len(samples) * SAMPLE_RATE / sample_rate)))
        old_x = np.linspace(0.0, 1.0, num=len(samples), endpoint=False)
        new_x = np.linspace(0.0, 1.0, num=target, endpoint=False)
        samples = np.interp(new_x, old_x, samples).astype(np.float32)
        sample_rate = SAMPLE_RATE
    return samples.astype(np.float32), sample_rate


def _is_digital_silence(samples) -> bool:
    if not len(samples):
        return True
    import numpy as np

    return float(np.max(np.abs(samples))) < SILENCE_PEAK


def _repeat_key(value: str) -> str:
    return re.sub(r"[\s，。！？、,.!?;；:：'\"“”‘’（）()\[\]【】]", "", value).casefold()


def _collapse_repeated_text(value: str) -> str:
    """Collapse a span made solely from one short repeated phrase."""
    compact = _repeat_key(value)
    if len(compact) < 2 or len(compact) > 24:
        return value
    for unit_length in range(1, min(8, len(compact)) + 1):
        if len(compact) % unit_length:
            continue
        repeats = len(compact) // unit_length
        if repeats >= 3 and compact == compact[:unit_length] * repeats:
            unit = compact[:unit_length]
            return unit + ("。" if value.rstrip().endswith(("。", ".")) else "")
    return value


def _collapse_short_repetitions(value: str) -> str:
    """Remove decoder loops for greetings/tests without rewriting sentences."""
    text = value
    text = re.sub(r"(?i)\bhello(?:\s+hello){1,}", "hello", text)
    # Paraformer emits Chinese characters without word boundaries, so these
    # two high-frequency test phrases need an explicit no-space pass.
    for phrase in ("哈喽", "测试", "你好"):
        text = re.sub(rf"(?:{re.escape(phrase)}){{2,}}", phrase, text)
    return _collapse_repeated_text(text)


def _join_tokens(tokens: Iterable[str]) -> str:
    output = ""
    for token in tokens:
        token = _simplify(str(token or "")).strip()
        if not token:
            continue
        if output and output[-1].isascii() and output[-1].isalnum() and token[0].isascii() and token[0].isalnum():
            output += " "
        output += token
    return output.strip()


def _units_from_result(item: dict) -> list[dict[str, Any]]:
    raw_tokens = str(item.get("text") or "").split()
    raw_timestamps = item.get("timestamp") or []
    units = []
    if len(raw_tokens) == len(raw_timestamps):
        for token, timestamp in zip(raw_tokens, raw_timestamps):
            if not isinstance(timestamp, (list, tuple)) or len(timestamp) < 2:
                continue
            token = _simplify(token).strip()
            if not token or token in FILLER_TOKENS:
                continue
            try:
                start_ms = max(0, int(round(float(timestamp[0]))))
                end_ms = max(start_ms, int(round(float(timestamp[1]))))
            except (TypeError, ValueError):
                continue
            units.append({"text": token, "startMs": start_ms, "endMs": end_ms})
    else:
        # Defensive fallback for a backend version that emits no per-token
        # timestamps: retain the text as one bounded segment.
        text = _join_tokens(raw_tokens)
        if text:
            duration = max((int(ts[1]) for ts in raw_timestamps if isinstance(ts, (list, tuple)) and len(ts) >= 2), default=0)
            units.append({"text": text, "startMs": 0, "endMs": max(0, duration)})
    return units


def _group_units(units: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups = []
    current: list[dict[str, Any]] = []
    for unit in units:
        if not current:
            current = [unit]
            continue
        gap = int(unit["startMs"]) - int(current[-1]["endMs"])
        span = int(unit["endMs"]) - int(current[0]["startMs"])
        previous_text = str(current[-1]["text"])
        should_split = gap > SPEECH_GAP_MS or span > MAX_SEGMENT_MS
        if previous_text and previous_text[-1:] in "。！？；.!?;":
            should_split = True
        if should_split:
            groups.append(current)
            current = [unit]
        else:
            current.append(unit)
    if current:
        groups.append(current)
    return groups


def _clean_group(group: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not group:
        return None
    tokens = [str(unit["text"]) for unit in group if str(unit["text"]).strip()]
    text = _join_tokens(tokens)
    if not text:
        return None
    text = _collapse_short_repetitions(text)
    # The common “hello hello hello” loop is tokenized as separate English
    # words, so handle it explicitly without touching normal mixed sentences.
    if re.fullmatch(r"(?:hello\s+){2,}hello[。.]?", text, flags=re.IGNORECASE):
        text = "hello。" if text.rstrip().endswith(("。", ".")) else "hello"
    if text and text[-1] not in "。！？；.!?;":
        text += "。"
    start_ms = max(0, int(group[0]["startMs"]))
    end_ms = max(start_ms, int(group[-1]["endMs"]))
    return {
        "startMs": start_ms,
        "endMs": end_ms,
        "text": text,
        # Paraformer does not expose a calibrated segment confidence.  A
        # stable conservative value is preferable to fabricating model scores.
        "confidence": 0.86 if len(_repeat_key(text)) >= 4 else 0.78,
    }


def _clean_result(result: Any) -> dict:
    if not isinstance(result, list) or not result:
        return {"text": "", "segments": [], "language": "zh"}
    item = result[0] if isinstance(result[0], dict) else {}
    units = _units_from_result(item)
    segments = []
    for group in _group_units(units):
        cleaned = _clean_group(group)
        if cleaned:
            segments.append(cleaned)
    # The model can place two repeated short utterances in separate groups
    # when the pause is longer than the local grouping gap.  Remove only a
    # repeated greeting/test at the next boundary; an ordinary sentence is
    # never matched by these exact short phrases.
    boundary_cleaned = []
    for segment in segments:
        current = dict(segment)
        if boundary_cleaned:
            previous = boundary_cleaned[-1]
            gap = current["startMs"] - previous["endMs"]
            if gap <= 6_000:
                text = current["text"]
                for phrase in ("hello", "哈喽", "测试", "你好"):
                    previous_text = str(previous["text"]).rstrip("。.!！")
                    if not previous_text.casefold().endswith(phrase.casefold()):
                        continue
                    if text.casefold() == phrase.casefold() or text.casefold().startswith(phrase.casefold()):
                        text = text[len(phrase):].lstrip(" ，,。.!！")
                        current["text"] = text
                        break
        if current["text"]:
            boundary_cleaned.append(current)
    segments = boundary_cleaned
    # Collapse identical short segments across a group boundary only when the
    # decoder produced a run of at least three.  Normal sentences stay intact.
    compacted = []
    index = 0
    while index < len(segments):
        run = [segments[index]]
        key = _repeat_key(segments[index]["text"])
        cursor = index + 1
        while cursor < len(segments) and key and _repeat_key(segments[cursor]["text"]) == key and len(key) <= 8:
            if segments[cursor]["startMs"] - run[-1]["endMs"] > 3_000:
                break
            run.append(segments[cursor])
            cursor += 1
        compacted.append(max(run, key=lambda value: value["endMs"] - value["startMs"]) if len(run) >= 3 else run[0])
        if len(run) < 3:
            compacted.extend(run[1:])
        index = cursor
    return {
        "text": "".join(segment["text"] for segment in compacted).strip(),
        "segments": compacted,
        "language": "zh",
    }


class ParaformerBackend:
    def __init__(self, model_path: str = MODEL_PATH):
        self.model_path = model_path
        self.model = None

    def _load(self):
        if self.model is not None:
            return self.model
        if not os.path.isfile(os.path.join(self.model_path, "model.pt")):
            raise FileNotFoundError(f"Paraformer 模型不存在：{self.model_path}")
        from funasr import AutoModel

        # FunASR prints a version line during construction in some releases;
        # route that diagnostic away from the JSONL stdout channel.
        with contextlib.redirect_stdout(sys.stderr):
            self.model = AutoModel(
                model=self.model_path,
                device="cpu",
                disable_update=True,
                disable_pbar=True,
                check_latest=False,
                log_level="WARNING",
                vad_model=None,
                punc_model=None,
            )
        return self.model

    def transcribe(self, audio_path: str, language: str = "zh") -> dict:
        try:
            samples, _ = _read_wave(audio_path)
            if _is_digital_silence(samples):
                return {"text": "", "segments": [], "language": "zh"}
        except (FileNotFoundError, OSError, EOFError, wave.Error):
            # Let FunASR report a useful error for non-WAV input rather than
            # making the silence preflight a format restriction.
            pass
        model = self._load()
        with contextlib.redirect_stdout(sys.stderr):
            result = model.generate(
                input=audio_path,
                batch_size_s=300,
                hotword="",
                sentence_timestamp=True,
            )
        return _clean_result(result)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=MODEL_PATH, help=argparse.SUPPRESS)
    args = parser.parse_args()
    backend = ParaformerBackend(args.model)
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
            result = backend.transcribe(str(request["audioPath"]), str(request.get("language") or "zh"))
            print(json.dumps({"id": request_id, "ok": True, "result": result}, ensure_ascii=False), flush=True)
        except Exception as exc:
            print(json.dumps({
                "id": request_id,
                "ok": False,
                "error": {"type": type(exc).__name__, "message": str(exc), "trace": traceback.format_exc(limit=3)},
            }, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
