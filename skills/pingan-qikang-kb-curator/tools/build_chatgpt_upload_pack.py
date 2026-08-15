#!/usr/bin/env python3
"""Build a ChatGPT-friendly upload pack from the canonical knowledge base."""

from __future__ import annotations

import csv
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
KB = ROOT / "知识库"
OUT = ROOT / "交付包_给ChatGPT" / "05_ChatGPT知识上传包"


MERGED_GROUPS = {
    "05_组织与权责.md": KB / "01_部门职责与组织权限",
    "06_产品与服务.md": KB / "02_产品与服务知识库",
    "07_报告与数据.md": KB / "03_企业健康报告与数据分类",
    "08_客户运营与服务SOP.md": KB / "04_客户运营案例与服务SOP",
    "09_IT与合规.md": KB / "05_IT与合规支持",
    "10_方法论与模板.md": KB / "06_方法论与模板",
    "11_售前规范与视觉.md": KB / "07_售前材料规范与素材库",
}

OCR_GROUPS = {
    "13_ROOT_OCR.txt": KB / "90_来源追溯" / "根目录图片知识库" / "_source_ocr",
    "14_REPORT_OCR.txt": KB / "90_来源追溯" / "企业健康报告" / "_source_ocr",
    "15_DEPT_OCR.txt": KB / "90_来源追溯" / "部门职责和权限" / "_source_ocr",
    "16_NEWMAT_OCR.txt": KB / "90_来源追溯" / "新素材补充" / "_source_ocr",
    "17_PRESALE_SOURCE_TEXT.txt": KB / "90_来源追溯" / "售前材料" / "_source_text",
}


def reset_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def merge_markdown_dir(src: Path, dest: Path) -> None:
    parts: list[str] = []
    for path in sorted(src.glob("*")):
        if path.suffix.lower() not in {".md", ".mmd"}:
            continue
        parts.append(f"\n\n# SOURCE FILE: {path.name}\n\n")
        parts.append(path.read_text(encoding="utf-8"))
    dest.write_text("".join(parts).strip() + "\n", encoding="utf-8")


def merge_text_dir(src: Path, dest: Path) -> None:
    parts: list[str] = []
    for path in sorted(src.glob("*.txt")):
        parts.append(f"\n\n# SOURCE FILE: {path.name}\n\n")
        parts.append(path.read_text(encoding="utf-8"))
    dest.write_text("".join(parts).strip() + "\n", encoding="utf-8")


def write_overview() -> None:
    overview_files = [
        KB / "00_总索引" / "知识库总览.md",
        KB / "00_总索引" / "分类目录索引.md",
        KB / "00_总索引" / "知识调用架构.md",
        KB / "00_总索引" / "检索与引用规范.md",
        KB / "00_总索引" / "目录归并与调用策略.md",
    ]
    parts = []
    for path in overview_files:
        parts.append(f"\n\n# SOURCE FILE: {path.name}\n\n")
        parts.append(path.read_text(encoding="utf-8"))
    (OUT / "01_总索引与调用规则.md").write_text("".join(parts).strip() + "\n", encoding="utf-8")


def copy_indexes() -> None:
    shutil.copy2(KB / "00_总索引" / "实体索引.csv", OUT / "02_实体索引.csv")
    shutil.copy2(KB / "00_总索引" / "关系索引.csv", OUT / "03_关系索引.csv")
    shutil.copy2(KB / "00_总索引" / "知识库文件清单.csv", OUT / "04_知识库文件清单.csv")


def build_source_registry() -> None:
    rows: list[dict[str, str]] = []
    source_groups = [
        ("ROOT", "根目录图片知识库"),
        ("REPORT", "企业健康报告"),
        ("DEPT", "部门职责和权限"),
        ("NEWMAT", "新素材补充"),
        ("PRESALE", "售前材料"),
        ("BRANDREF", "品牌模板参考"),
    ]
    for group_code, dirname in source_groups:
        manifest = KB / "90_来源追溯" / dirname / "source_manifest.csv"
        if not manifest.exists():
            continue
        with manifest.open(newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                rows.append(
                    {
                        "source_group": group_code,
                        "source_id": row.get("source_id", ""),
                        "filename": row.get("filename", ""),
                        "path": row.get("path", row.get("source_path", "")),
                        "ocr_file": row.get("ocr_file", ""),
                    }
                )
    with (OUT / "12_来源清单.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=["source_group", "source_id", "filename", "path", "ocr_file"])
        writer.writeheader()
        writer.writerows(rows)


def write_readme() -> None:
    text = """# ChatGPT 知识上传包

本目录用于把完整 `知识库/` 以少量、文本优先的文件形式上传到 ChatGPT。

## 使用原则

1. 先读 `01_总索引与调用规则.md`。
2. 用 `02_实体索引.csv` 和 `03_关系索引.csv` 做路由。
3. 用 `04_知识库文件清单.csv` 找主题文件。
4. 需要完整答案时，进入 `05` 至 `11` 的主题合并文档。
5. 需要真源追溯时，查 `12_来源清单.csv`，再查 `13` 至 `17` 的 OCR / 原始文本。

## 文件职责

- `01-04`：路由层。
- `05-11`：Wiki 正文层。
- `12-17`：来源追溯层。

## 边界

- 这是一套适合 ChatGPT 检索的文本包，不替代本地完整目录结构。
- HTML 生成与可编辑运行仍需 `skills/html_materials/skill/` 和 `素材库/`。
- 价格、医学口径、权益次数、等待期、服务范围等易变事实仍需按来源复核。
"""
    (OUT / "00_README.md").write_text(text, encoding="utf-8")


def main() -> int:
    reset_dir(OUT)
    write_readme()
    write_overview()
    copy_indexes()
    for filename, src in MERGED_GROUPS.items():
        merge_markdown_dir(src, OUT / filename)
    build_source_registry()
    for filename, src in OCR_GROUPS.items():
        merge_text_dir(src, OUT / filename)
    print(OUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
