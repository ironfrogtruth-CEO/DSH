#!/usr/bin/env python3
"""Persistent FunASR ERes2NetV2 worker.

Weights are loaded only from the explicitly supplied local model directory.
No ModelScope/HuggingFace download is attempted by this process.
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback


class SpeakerRuntime:
    def __init__(self, model_path: str, requested_device: str) -> None:
        from pathlib import Path
        import torch
        from funasr.models.eres2net.model import ERes2NetV2SV

        self.torch = torch
        if requested_device == "mps" and torch.backends.mps.is_available():
            self.device = "mps"
        else:
            self.device = "cpu"
        root = Path(model_path)
        checkpoint = root / "pretrained_eres2netv2.ckpt"
        if not checkpoint.is_file():
            raise RuntimeError(f"ERes2NetV2 权重不存在: {checkpoint}")
        # ModelScope's speaker-verification snapshot uses configuration.json,
        # while FunASR AutoModel expects a training config.yaml for arbitrary
        # local paths. Instantiate the registered local class directly so the
        # worker never falls back to a hub lookup.
        self.model = ERes2NetV2SV(
            model_path=str(root),
            init_param=str(checkpoint),
        ).to(self.device).eval()

    def embed(self, audio_path: str) -> list[float]:
        with self.torch.no_grad():
            result, _ = self.model.inference([audio_path], device=self.device)
        if not result:
            raise RuntimeError("ERes2NetV2 未返回声纹向量")
        value = result[0].get("spk_embedding") if isinstance(result[0], dict) else None
        if value is None:
            raise RuntimeError("ERes2NetV2 返回结果缺少 spk_embedding")
        if hasattr(value, "detach"):
            value = value.detach().cpu().reshape(-1).tolist()
        return [float(item) for item in value]

    def cluster(self, vectors: list[list[float]], oracle_num=None) -> dict:
        import numpy as np
        import torch
        from funasr.models.campplus.cluster_backend import ClusterBackend

        matrix = torch.as_tensor(np.asarray(vectors, dtype=np.float32), dtype=torch.float32)
        backend = ClusterBackend(merge_thr=0.78).to(self.device)
        labels = backend(matrix, oracle_num=oracle_num)
        if hasattr(labels, "tolist"):
            labels = labels.tolist()
        labels = [int(item) for item in labels]
        centers = []
        for label in sorted(set(labels)):
            selected = [vectors[index] for index, item in enumerate(labels) if item == label]
            width = len(selected[0])
            center = [sum(vector[column] for vector in selected) / len(selected) for column in range(width)]
            norm = sum(value * value for value in center) ** 0.5
            centers.append([value / norm for value in center] if norm else center)
        return {"labels": labels, "centers": centers, "device": self.device}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", default="mps")
    args = parser.parse_args()
    runtime = None
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        request_id = None
        try:
            request = json.loads(raw)
            request_id = request.get("id")
            if runtime is None:
                runtime = SpeakerRuntime(args.model, args.device)
            op = request.get("op")
            if op == "embed":
                result = {"vector": runtime.embed(str(request["audioPath"])), "device": runtime.device}
            elif op == "cluster":
                result = runtime.cluster(request.get("vectors") or [], request.get("oracleNum"))
            else:
                raise ValueError("unsupported operation")
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
