#!/usr/bin/env python3
"""Validate the Jianshibao knowledge pack layout."""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path


REQUIRED_DIRS = [
    "00_总索引",
    "01_部门职责与组织权限",
    "02_产品与服务知识库",
    "03_企业健康报告与数据分类",
    "04_客户运营案例与服务SOP",
    "05_IT与合规支持",
    "06_方法论与模板",
    "07_售前材料规范与素材库",
    "90_来源追溯",
    "99_QA",
]

REQUIRED_FILES = [
    "README.md",
    "00_总索引/分类目录索引.md",
    "00_总索引/检索与引用规范.md",
    "00_总索引/知识库文件清单.csv",
    "00_总索引/知识调用架构.md",
    "00_总索引/实体索引.csv",
    "00_总索引/关系索引.csv",
    "01_部门职责与组织权限/岗位职责词典.md",
    "01_部门职责与组织权限/权限边界与协同关系.md",
    "02_产品与服务知识库/产品分类索引.md",
    "02_产品与服务知识库/企业健康管理服务方案详解.md",
    "03_企业健康报告与数据分类/报告数据索引.md",
    "04_客户运营案例与服务SOP/服务履约流程与时效标准.md",
]

SOURCE_GROUPS = [
    ("根目录图片知识库", 132),
    ("企业健康报告", 32),
    ("部门职责和权限", 20),
    ("新素材补充", 127),
]

NON_OCR_SOURCE_GROUPS = [
    ("售前材料", 10),
    ("品牌模板参考", 3),
]


def fail(message: str) -> None:
    print(f"[FAIL] {message}")
    raise SystemExit(1)


def count_ocr_files(path: Path) -> int:
    return len(list(path.glob("*.txt")))


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: check_knowledge_pack.py /path/to/知识库")
        return 2

    root = Path(sys.argv[1]).expanduser().resolve()
    if not root.exists():
        fail(f"knowledge root does not exist: {root}")

    for dirname in REQUIRED_DIRS:
        if not (root / dirname).is_dir():
            fail(f"missing directory: {dirname}")

    for filename in REQUIRED_FILES:
        if not (root / filename).is_file():
            fail(f"missing file: {filename}")

    registry = root / "00_总索引/知识库文件清单.csv"
    with registry.open(newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    missing = [row["path"] for row in rows if not (root / row["path"]).exists()]
    if missing:
        fail("registry paths missing: " + ", ".join(missing))

    for group, expected in SOURCE_GROUPS:
        group_dir = root / "90_来源追溯" / group
        manifest = group_dir / "source_manifest.json"
        ocr_dir = group_dir / "_source_ocr"
        if not manifest.is_file():
            fail(f"missing manifest: {group}")
        if not ocr_dir.is_dir():
            fail(f"missing OCR directory: {group}")
        data = json.loads(manifest.read_text(encoding="utf-8"))
        ocr_count = count_ocr_files(ocr_dir)
        if len(data) != expected:
            fail(f"{group} manifest count {len(data)} != expected {expected}")
        if ocr_count != expected:
            fail(f"{group} OCR count {ocr_count} != expected {expected}")

    for group, expected in NON_OCR_SOURCE_GROUPS:
        group_dir = root / "90_来源追溯" / group
        manifest = group_dir / "source_manifest.json"
        if not manifest.is_file():
            fail(f"missing manifest: {group}")
        data = json.loads(manifest.read_text(encoding="utf-8"))
        if len(data) != expected:
            fail(f"{group} manifest count {len(data)} != expected {expected}")

    print("[OK] knowledge pack is valid")
    print(f"[OK] registry rows: {len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
