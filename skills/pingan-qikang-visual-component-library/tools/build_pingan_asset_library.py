#!/usr/bin/env python3
"""Validate and summarize the Ping An Qikang visual component library.

The active component library lives under:
  素材库/视觉组件外挂库

This tool intentionally does not download external assets. Iconfont or other
third-party assets must pass authorization review before they are promoted into
the active registry.
"""

from __future__ import annotations

import csv
import json
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
LIB_ROOT = ROOT / "素材库" / "视觉组件外挂库"
REGISTRY_JSON = LIB_ROOT / "00_registry" / "visual_component_registry.json"
REGISTRY_CSV = LIB_ROOT / "00_registry" / "visual_component_registry.csv"
QA_REPORT = LIB_ROOT / "99_QA" / "视觉组件外挂库QA报告_2026-06-01.md"


REQUIRED_COMPONENTS = {
    "data_card.metric_card",
    "progress_bar.single",
    "product_focus.hero",
    "chart.ring",
    "chart.pie",
    "chart.bar",
    "ratio_bar.stacked",
}


def load_registry() -> list[dict[str, object]]:
    if not REGISTRY_JSON.exists():
        raise SystemExit(f"missing registry: {REGISTRY_JSON}")
    data = json.loads(REGISTRY_JSON.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise SystemExit("registry must be a list")
    return data


def validate_registry(rows: list[dict[str, object]]) -> list[str]:
    errors: list[str] = []
    ids = [str(row.get("id", "")) for row in rows]
    missing = REQUIRED_COMPONENTS - set(ids)
    if missing:
        errors.append("missing required components: " + ", ".join(sorted(missing)))

    duplicate_ids = [item for item, count in Counter(ids).items() if count > 1]
    if duplicate_ids:
        errors.append("duplicate ids: " + ", ".join(sorted(duplicate_ids)))

    for row in rows:
        item_id = str(row.get("id", ""))
        rel = str(row.get("path", ""))
        status = str(row.get("status", ""))
        license_status = str(row.get("license_status", ""))
        package_default = bool(row.get("package_default", False))
        if not rel:
            errors.append(f"{item_id}: missing path")
            continue
        if not (LIB_ROOT / rel).exists():
            errors.append(f"{item_id}: missing file {rel}")
        if package_default and status != "active":
            errors.append(f"{item_id}: package_default requires active status")
        if package_default and license_status not in {"self_generated"}:
            errors.append(f"{item_id}: package_default requires self_generated license")
    return errors


def write_csv(rows: list[dict[str, object]]) -> None:
    REGISTRY_CSV.parent.mkdir(parents=True, exist_ok=True)
    fields = ["id", "name", "type", "path", "status", "license_status", "package_default"]
    with REGISTRY_CSV.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in fields})


def write_report(rows: list[dict[str, object]], errors: list[str]) -> None:
    status_counts = Counter(str(row.get("status", "")) for row in rows)
    default_count = sum(1 for row in rows if bool(row.get("package_default", False)))
    inactive_iconfont = len(list((LIB_ROOT / "90_inactive" / "needs_license_review" / "iconfont").glob("*.svg")))
    state = "PASS" if not errors else "FAIL"
    lines = [
        "# 视觉组件外挂库 QA 报告",
        "",
        "日期：2026-06-01",
        "",
        "## QA Gate",
        "",
        f"状态：`{state}`",
        "",
        "## 统计",
        "",
        f"- 注册表条目：{len(rows)}",
        f"- active：{status_counts.get('active', 0)}",
        f"- internal_only：{status_counts.get('internal_only', 0)}",
        f"- 默认可打包条目：{default_count}",
        f"- iconfont 待授权复核 SVG：{inactive_iconfont}",
        "",
        "## 规则",
        "",
        "- 默认可打包条目必须是 active。",
        "- 默认可打包条目必须是 self_generated。",
        "- iconfont 未授权复核前不得进入 active 默认包。",
    ]
    if errors:
        lines.extend(["", "## 阻断项", ""])
        lines.extend(f"- {err}" for err in errors)
    QA_REPORT.parent.mkdir(parents=True, exist_ok=True)
    QA_REPORT.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    rows = load_registry()
    errors = validate_registry(rows)
    write_csv(rows)
    write_report(rows, errors)
    if errors:
        raise SystemExit("\n".join(errors))
    print(json.dumps({"library": str(LIB_ROOT), "items": len(rows), "status": "PASS"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
