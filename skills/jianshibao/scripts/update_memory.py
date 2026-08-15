#!/usr/bin/env python3
"""Append a lightweight Jianshibao memory event as JSONL."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--memory-file", required=True, help="JSONL file to append")
    parser.add_argument("--event", required=True, help="event type")
    parser.add_argument("--note", required=True, help="short memory note")
    parser.add_argument("--focus", default="", help="comma-separated focus tags")
    parser.add_argument("--style", default="", help="preferred response style")
    args = parser.parse_args()

    memory_path = Path(args.memory_file).expanduser()
    memory_path.parent.mkdir(parents=True, exist_ok=True)

    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event": args.event,
        "focus": [item.strip() for item in args.focus.split(",") if item.strip()],
        "style": args.style,
        "note": args.note,
    }

    with memory_path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")

    print(f"[OK] appended memory event to {memory_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
