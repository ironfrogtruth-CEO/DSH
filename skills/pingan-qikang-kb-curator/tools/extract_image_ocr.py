#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageEnhance, ImageOps


IMAGE_EXTS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ".bmp",
    ".tif",
    ".tiff",
    ".heic",
    ".heif",
}


@dataclass
class ImageItem:
    source: Path
    source_id: str


def natural_key(path: Path) -> list[object]:
    parts = re.split(r"(\d+)", path.name.lower())
    return [int(part) if part.isdigit() else part for part in parts]


def find_images(root: Path) -> list[ImageItem]:
    images = sorted(
        [p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in IMAGE_EXTS],
        key=natural_key,
    )
    return [ImageItem(source=p, source_id=f"S{i:03d}") for i, p in enumerate(images, 1)]


def run(cmd: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def thumbnail_for(item: ImageItem, thumb_dir: Path, root: Path) -> Path:
    thumb_dir.mkdir(parents=True, exist_ok=True)
    expected = thumb_dir / f"{item.source.name}.png"
    if expected.exists():
        return expected

    result = run(["qlmanage", "-t", "-s", "2400", "-o", str(thumb_dir), str(item.source)], cwd=root)
    if result.returncode != 0:
        raise RuntimeError(f"qlmanage failed for {item.source}: {result.stderr or result.stdout}")

    if expected.exists():
        return expected

    matches = sorted(thumb_dir.glob(f"{item.source.name}*.png"))
    if not matches:
        raise FileNotFoundError(f"thumbnail not found for {item.source}")
    return matches[0]


def preprocess(source_png: Path, processed_png: Path) -> None:
    img = Image.open(source_png)
    rotation = detect_pil_rotation(source_png)
    if rotation:
        img = img.rotate(rotation, expand=True)
    img = img.convert("L")
    img = ImageOps.autocontrast(img, cutoff=1)
    img = ImageEnhance.Contrast(img).enhance(1.65)
    img = ImageEnhance.Sharpness(img).enhance(1.35)
    processed_png.parent.mkdir(parents=True, exist_ok=True)
    img.save(processed_png)


def detect_pil_rotation(source_png: Path) -> int:
    result = run(["tesseract", str(source_png), "stdout", "--psm", "0"])
    text = (result.stdout or "") + "\n" + (result.stderr or "")
    match = re.search(r"Rotate:\s*(\d+)", text)
    if not match:
        return 0
    # Tesseract's rotation value is clockwise; Pillow rotates counter-clockwise.
    return (360 - int(match.group(1))) % 360


def clean_text(text: str) -> str:
    lines = []
    seen_blank = False
    for line in text.splitlines():
        line = line.strip()
        line = re.sub(r"\s+", " ", line)
        if not line:
            if not seen_blank:
                lines.append("")
            seen_blank = True
            continue
        seen_blank = False
        lines.append(line)
    return "\n".join(lines).strip()


def ocr(processed_png: Path) -> str:
    attempts = []
    for psm in ("6", "11"):
        result = run(
            [
                "tesseract",
                str(processed_png),
                "stdout",
                "-l",
                "chi_sim+eng",
                "--psm",
                psm,
                "--dpi",
                "220",
            ]
        )
        text = clean_text(result.stdout)
        attempts.append(text)
    return max(attempts, key=len)


def write_outputs(root: Path, items: list[ImageItem], tmp_root: Path, kb_root: Path) -> None:
    ocr_dir = kb_root / "_source_ocr"
    ocr_dir.mkdir(parents=True, exist_ok=True)

    thumb_dir = tmp_root / "thumbs"
    processed_dir = tmp_root / "processed"
    rows = []

    for item in items:
        rel = item.source.relative_to(root)
        print(f"[{item.source_id}] thumbnail {rel}", file=sys.stderr)
        thumb = thumbnail_for(item, thumb_dir, root)
        processed = processed_dir / f"{item.source_id}.png"
        preprocess(thumb, processed)
        text = ocr(processed)
        out = ocr_dir / f"{item.source_id}_{item.source.stem}.txt"
        out.write_text(text + "\n", encoding="utf-8")
        rows.append(
            {
                "source_id": item.source_id,
                "path": str(rel),
                "filename": item.source.name,
                "ocr_file": str(out.relative_to(kb_root)),
                "chars": len(text),
                "lines": len([line for line in text.splitlines() if line.strip()]),
            }
        )

    (kb_root / "source_manifest.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    with (kb_root / "source_manifest.csv").open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else [])
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd().resolve()
    kb_root = root / "knowledge_base"
    tmp_root = Path("/private/tmp/pingan_health_ocr")
    tmp_root.mkdir(parents=True, exist_ok=True)

    items = find_images(root)
    if not items:
        print("No images found.", file=sys.stderr)
        return 1
    write_outputs(root, items, tmp_root, kb_root)
    print(f"OCR completed: {len(items)} images", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
