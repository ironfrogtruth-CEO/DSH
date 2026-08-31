#!/usr/bin/env python3
from __future__ import annotations

import sys
import tempfile
import unittest
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import paraformer_worker as worker  # noqa: E402


class ParaformerWorkerTests(unittest.TestCase):
    def test_joins_chinese_without_character_spaces(self):
        self.assertEqual(worker._join_tokens(["他", "想", "陪", "上", "门"]), "他想陪上门")
        self.assertEqual(worker._join_tokens(["hello", "world", "测", "试"]), "hello world测试")

    def test_collapses_observed_greeting_and_test_loops(self):
        value = worker._collapse_short_repetitions("hello hello hello哈喽哈喽测试测试测试测试")
        self.assertEqual(value, "hello哈喽测试")

    def test_result_uses_timestamps_and_removes_fillers(self):
        result = worker._clean_result([{
            "text": "嗯 今 天 下 午 三 点 开 会",
            "timestamp": [[0, 100], [100, 200], [200, 300], [300, 400], [400, 500], [500, 600], [600, 700], [700, 800], [800, 900]],
        }])
        self.assertEqual(result["text"], "今天下午三点开会。")
        self.assertEqual(result["segments"][0]["startMs"], 100)
        self.assertEqual(result["segments"][0]["endMs"], 900)

    def test_simplifies_common_traditional_characters(self):
        self.assertEqual(worker._simplify("會議內容與寵物服務"), "会议内容与宠物服务")

    def test_digital_silence_returns_empty_without_loading_model(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "silence.wav"
            with wave.open(str(path), "wb") as handle:
                handle.setnchannels(1)
                handle.setsampwidth(2)
                handle.setframerate(16_000)
                handle.writeframes(bytes(16_000 * 2))
            backend = worker.ParaformerBackend("/definitely/missing")
            self.assertEqual(backend.transcribe(str(path)), {"text": "", "segments": [], "language": "zh"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
