#!/usr/bin/env python3
"""Deterministic post-decode tests for the local Whisper worker.

These tests do not touch a user's stenographer session.  They exercise the
worker's local audio gate and repetition handling; real-model replay is kept
as an explicit command because loading Whisper is intentionally expensive.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import stt_worker  # noqa: E402


class SttWorkerAccuracyTests(unittest.TestCase):
    def test_high_pass_removes_dc_without_changing_length(self):
        samples = np.full(16_000, 0.03, dtype=np.float32)
        filtered = stt_worker._high_pass(samples)
        self.assertEqual(filtered.shape, samples.shape)
        self.assertLess(float(np.sqrt(np.mean(filtered[-8_000:] ** 2))), 1e-3)

    def test_repetition_run_keeps_strongest_short_phrase(self):
        # The first candidate has the strongest acoustic evidence.  Three
        # identical short segments are a decoder loop, not three new notes.
        samples = np.zeros(16_000 * 5, dtype=np.float32)
        samples[320:640] = 0.2
        raw = [
            {"start": 0.0, "end": 1.0, "text": "哈喽", "avg_logprob": -0.3, "compression_ratio": 1.2},
            {"start": 1.0, "end": 2.0, "text": "哈喽", "avg_logprob": -0.3, "compression_ratio": 1.2},
            {"start": 2.0, "end": 3.0, "text": "哈喽", "avg_logprob": -0.3, "compression_ratio": 1.2},
        ]
        cleaned = stt_worker._clean_segments(raw, samples)
        self.assertEqual(len(cleaned), 1)
        self.assertEqual(cleaned[0]["text"], "哈喽")

    def test_high_compression_loop_is_removed(self):
        samples = np.zeros(16_000 * 8, dtype=np.float32)
        raw = [{"start": 0.0, "end": 1.0, "text": "我可以", "avg_logprob": -0.2, "compression_ratio": 11.7}]
        self.assertEqual(stt_worker._clean_segments(raw, samples), [])

    def test_long_low_energy_region_is_removed(self):
        samples = np.zeros(16_000 * 18, dtype=np.float32)
        # Stationary low-level microphone noise, matching the observed tail
        # shape; it must not become a subtitle/name hallucination.
        rng = np.random.default_rng(42)
        samples += rng.normal(0.0, 0.004, samples.shape).astype(np.float32)
        raw = [{"start": 0.0, "end": 18.0, "text": "中文字幕志愿者 李宗盛", "avg_logprob": -1.3, "compression_ratio": 0.7}]
        self.assertEqual(stt_worker._clean_segments(raw, samples), [])

    def test_in_span_repetition_is_collapsed(self):
        self.assertEqual(stt_worker._collapse_repeated_text("测试测试测试。"), "测试。")
        self.assertEqual(stt_worker._collapse_repeated_text("会议纪要测试"), "会议纪要测试")


if __name__ == "__main__":
    unittest.main(verbosity=2)
