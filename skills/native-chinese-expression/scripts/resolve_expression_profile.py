#!/usr/bin/env python3
"""Resolve a qualitative lexical profile from carrier, audience, and clause role."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


PROFILE_PATH = Path(__file__).resolve().parent.parent / "references" / "pos-routing-profiles.json"


def _ordered_unique(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))


def load_profiles() -> dict:
    return json.loads(PROFILE_PATH.read_text(encoding="utf-8"))


def resolve_profile(carrier: str, audience: str, clause_role: str) -> dict:
    data = load_profiles()
    selected = []
    for section, key in (
        ("carriers", carrier),
        ("audiences", audience),
        ("clause_roles", clause_role),
    ):
        if key not in data[section]:
            allowed = ", ".join(sorted(data[section]))
            raise ValueError(f"unknown {section[:-1]}={key!r}; allowed: {allowed}")
        selected.append(data[section][key])

    prioritize = _ordered_unique([item for profile in reversed(selected) for item in profile.get("prioritize", [])])
    control = _ordered_unique([item for profile in selected for item in profile.get("control", []) if item not in prioritize])
    avoid = _ordered_unique([item for profile in selected for item in profile.get("avoid_by_default", []) if item not in prioritize])
    skeletons = _ordered_unique([item for profile in reversed(selected) for item in profile.get("skeletons", [])])
    notes = _ordered_unique([item for profile in selected for item in profile.get("notes", [])])

    return {
        "skill_id": "native-chinese-expression",
        "contract_version": data["contract_version"],
        "carrier_type": carrier,
        "audience": audience,
        "clause_role": clause_role,
        "profile_type": "qualitative_not_ratio",
        "prioritize": prioritize,
        "control": control,
        "avoid_by_default": avoid,
        "skeletons": skeletons,
        "notes": notes,
        "facts_override_profile": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="生成受众、载体和句子任务对应的词性表达配置。")
    parser.add_argument("--carrier", required=True)
    parser.add_argument("--audience", required=True)
    parser.add_argument("--clause-role", required=True)
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    try:
        result = resolve_profile(args.carrier, args.audience, args.clause_role)
    except ValueError as exc:
        print(json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
