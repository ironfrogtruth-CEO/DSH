#!/usr/bin/env python3
"""Sync the editable HTML skill into a portable package.

The portable package keeps the skill usable when copied to another runtime
such as Coze or WorkBuddy: the skill carries a compact knowledge layer and
the curated visual asset library with relative paths.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SKILL = ROOT / "skills" / "html_materials" / "skill"
SOURCE_ASSET_LIB = ROOT / "素材库" / "视觉组件外挂库"
SOURCE_KNOWLEDGE = ROOT / "知识库" / "07_售前材料规范与素材库"
RESOURCES = SKILL / "resources"
PORTABLE_ASSETS = RESOURCES / "visual-component-library"
PORTABLE_KNOWLEDGE = RESOURCES / "knowledge" / "presale"

KNOWLEDGE_FILES = [
    "README.md",
    "01_售前材料内容结构.md",
    "02_售前视觉VI与版式规范.md",
    "03_样式组件与页面模板.md",
    "04_精选图片素材索引.md",
    "05_产品场景与客户方案映射.md",
    "06_HTML编辑器调用规则.md",
    "QA_抽取与整合检查报告.md",
    "curated_assets.json",
    "curated_assets.csv",
]


def reset_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def copytree(src: Path, dest: Path) -> None:
    reset_dir(dest)
    shutil.copytree(src, dest, dirs_exist_ok=True, ignore=shutil.ignore_patterns(".DS_Store"))


def sync_knowledge() -> None:
    reset_dir(PORTABLE_KNOWLEDGE)
    for name in KNOWLEDGE_FILES:
        src = SOURCE_KNOWLEDGE / name
        if src.exists():
            shutil.copy2(src, PORTABLE_KNOWLEDGE / name)
    portable_rewrites = {
        "06_HTML编辑器调用规则.md": {
            "/Users/marcus/Desktop/平安企康/平安健康知识库&技能/知识库/07_售前材料规范与素材库": "resources/knowledge/presale",
            "/Users/marcus/Desktop/平安企康/平安健康知识库&技能/原始文件/知识库图片归档/知识库/90_来源追溯/售前材料/_page_renders/PRESALE###/p###.jpg": "本机完整知识库图片归档中的 `原始文件/知识库图片归档/知识库/90_来源追溯/售前材料/_page_renders/PRESALE###/p###.jpg`",
            "禁止删除 `90_来源追溯/售前材料/原始文件/` 下的源文件。": "禁止删除原始售前材料源文件；迁移环境中若无源文件，以本便携知识库和素材库为准。",
        },
        "README.md": {
            "本目录沉淀 `90_来源追溯/售前材料/原始文件` 中 10 份平安好医生售前交付材料的结构、视觉 VI、样式组件和可复用图片素材。": "本目录沉淀 10 份平安好医生售前交付材料的结构、视觉 VI、样式组件和可复用图片素材。",
            "源文件已归并到 `90_来源追溯/售前材料/原始文件/`。": "源文件未随便携包内置；迁移环境中若无源文件，以本便携知识库和 `resources/visual-component-library` 为准。",
        },
        "QA_抽取与整合检查报告.md": {
            "| 源目录 | `90_来源追溯/售前材料/原始文件/` |": "| 源目录 | 本机售前材料源目录；迁移环境中以便携知识库为准 |",
        },
    }
    for name, replacements in portable_rewrites.items():
        path = PORTABLE_KNOWLEDGE / name
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        for old, new in replacements.items():
            text = text.replace(old, new)
        path.write_text(text, encoding="utf-8")
    index = """# Portable Presale Knowledge

This folder is a compact, portable copy of the local Ping An Good Doctor
presale knowledge base. Use it first when the original local knowledge base is
not available.

Priority:
1. Read `01_售前材料内容结构.md` and `05_产品场景与客户方案映射.md` for outline and facts.
2. Read `02_售前视觉VI与版式规范.md` and `03_样式组件与页面模板.md` for visual decisions.
3. Read `curated_assets.json/csv` only for source traceability; visual assets
   should come from `../visual-component-library`.
"""
    (PORTABLE_KNOWLEDGE / "INDEX.md").write_text(index, encoding="utf-8")


def patch_asset_map() -> None:
    asset_map = PORTABLE_ASSETS / "99_索引与说明" / "html_asset_map.json"
    if not asset_map.exists():
        return
    data = json.loads(asset_map.read_text(encoding="utf-8"))
    data["library_root"] = "resources/visual-component-library"
    data["portable"] = True
    data["path_policy"] = "Join file_path with the active asset library root. Do not use absolute paths in generated HTML."
    asset_map.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    usage = PORTABLE_ASSETS / "99_索引与说明" / "素材使用说明.md"
    if usage.exists():
        text = usage.read_text(encoding="utf-8")
        text = text.replace("../素材库/", "resources/visual-component-library/")
        usage.write_text(text, encoding="utf-8")


def write_resource_manifest() -> None:
    manifest = {
        "name": "editable-html-report-deck",
        "brand": "平安好医生",
        "portable": True,
        "resource_roots": {
            "asset_library": "resources/visual-component-library",
            "presale_knowledge": "resources/knowledge/presale",
            "local_full_knowledge_fallback": "../../../知识库",
            "local_asset_library_fallback": "../../../素材库/视觉组件外挂库",
            "local_knowledge_fallback": "../../../知识库/07_售前材料规范与素材库",
        },
        "knowledge_resolution_order": [
            {
                "name": "full_knowledge_pack",
                "mode": "authoritative",
                "root_candidates": ["../知识库", "./知识库"],
                "required_indexes": [
                    "00_总索引/知识调用架构.md",
                    "00_总索引/分类目录索引.md",
                    "00_总索引/实体索引.csv",
                    "00_总索引/关系索引.csv",
                    "00_总索引/知识库文件清单.csv",
                    "00_总索引/检索与引用规范.md",
                ],
            },
            {
                "name": "portable_presale_subset",
                "mode": "portable_fallback",
                "root_candidates": ["resources/knowledge/presale"],
                "required_indexes": [
                    "INDEX.md",
                    "01_售前材料内容结构.md",
                    "05_产品场景与客户方案映射.md",
                ],
            },
        ],
        "required_runtime_files": [
            "assets/report-theme.css",
            "assets/editor-core.js",
            "templates/editable-report-template.html",
        ],
        "asset_indexes": [
            "resources/visual-component-library/00_registry/visual_component_registry.json",
        ],
        "knowledge_indexes": [
            "resources/knowledge/presale/INDEX.md",
            "resources/knowledge/presale/05_产品场景与客户方案映射.md",
            "resources/knowledge/presale/curated_assets.json",
        ],
        "full_knowledge_indexes": [
            "../知识库/00_总索引/知识调用架构.md",
            "../知识库/00_总索引/实体索引.csv",
            "../知识库/00_总索引/关系索引.csv",
            "../知识库/00_总索引/知识库文件清单.csv",
            "../知识库/00_总索引/检索与引用规范.md",
        ],
        "html_contract": {
            "slide_size": "1280x720",
            "editable_unit": ".widget",
            "asset_marker": ["data-asset-id", "data-replacement-group"],
            "print_rule": "Use @media print and EditableReportDeck.prepareForPrint() before PDF export.",
        },
    }
    (RESOURCES / "resource-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> int:
    if not SOURCE_ASSET_LIB.exists():
        raise SystemExit(f"Missing source asset library: {SOURCE_ASSET_LIB}")
    if not SOURCE_KNOWLEDGE.exists():
        raise SystemExit(f"Missing source knowledge base: {SOURCE_KNOWLEDGE}")
    RESOURCES.mkdir(parents=True, exist_ok=True)
    copytree(SOURCE_ASSET_LIB, PORTABLE_ASSETS)
    patch_asset_map()
    sync_knowledge()
    write_resource_manifest()
    print(json.dumps({"resources": str(RESOURCES), "asset_library": str(PORTABLE_ASSETS), "knowledge": str(PORTABLE_KNOWLEDGE)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
