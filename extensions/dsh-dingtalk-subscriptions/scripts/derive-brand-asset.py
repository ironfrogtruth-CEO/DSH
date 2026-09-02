#!/usr/bin/env python3
"""Derive the DingTalk subscriber avatar from the ShrimpTank mark.

The source mark is copied without recolouring or compositing.  It is placed
on a transparent 512x512 canvas, centered vertically, so no background,
border, shadow, or text can be introduced by the provisioning path.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image


DEFAULT_SOURCE = Path("/Users/marcus/Desktop/虾缸/assets/brand/shrimp-tank/optimized/mark-dark.png")
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "assets" / "dashen-bot-avatar.png"
DEFAULT_MANIFEST = Path(__file__).resolve().parents[1] / "assets" / "brand-manifest.json"
DEFAULT_HASH = Path(__file__).resolve().parents[1] / "assets" / "dashen-bot-avatar.sha256"


def derive(source: Path, output: Path, manifest: Path, hash_file: Path) -> dict:
    image = Image.open(source).convert("RGBA")
    canvas = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    x = (512 - image.width) // 2
    y = (512 - image.height) // 2
    canvas.alpha_composite(image, (x, y))
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, format="PNG", optimize=False, compress_level=9)

    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    alpha = canvas.getchannel("A")
    bbox = alpha.getbbox()
    manifest_value = {
        "name": "大神",
        "description": "大神｜Visible Workflow. Reliable Intelligence.",
        "source": str(source),
        "output": str(output),
        "width": 512,
        "height": 512,
        "mode": "RGBA",
        "transparentBackground": True,
        "borderless": True,
        "shadow": False,
        "text": False,
        "alphaBoundingBox": list(bbox) if bbox else None,
        "sha256": digest,
    }
    manifest.write_text(json.dumps(manifest_value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    hash_file.write_text(f"{digest}  {output.name}\n", encoding="utf-8")
    return manifest_value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--hash-file", type=Path, default=DEFAULT_HASH)
    args = parser.parse_args()
    print(json.dumps(derive(args.source, args.output, args.manifest, args.hash_file), ensure_ascii=False))


if __name__ == "__main__":
    main()
