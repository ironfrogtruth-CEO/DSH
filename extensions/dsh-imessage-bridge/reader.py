#!/usr/bin/env python3
"""Read the minimum iMessage inbox projection needed by dsh-imessage-bridge.

The script deliberately owns SQLite access so the Node host never opens the
Messages database through a writable driver.  It emits JSON only; it never
prints message bodies in diagnostics.  attributedBody is inspected with the
private pytypedstream vendor using low-level events only.  No unarchiver,
pickle, dynamic import, or arbitrary object reconstruction is used.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import unicodedata
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parent
VENDOR = ROOT / "vendor" / "pytypedstream-0.1.0"
sys.path.insert(0, str(VENDOR))

try:
    from typedstream.stream import CString, Atom, Selector, SingleClass, TypedStreamReader
except Exception as exc:  # pragma: no cover - exercised by deployment doctor
    CString = Atom = Selector = SingleClass = TypedStreamReader = None
    _IMPORT_ERROR = str(exc)
else:
    _IMPORT_ERROR = ""


MAX_ATTRIBUTE_BYTES = 2 * 1024 * 1024
MAX_TEXT_CHARS = 8000
_RAW_TEXT = re.compile(rb"[\x20-\x7e\xc2-\xf4][\x20-\x7e\x80-\xbf]{1,}")
_CLASS_NAMES = {
    "NSObject",
    "NSAttributedString",
    "NSMutableAttributedString",
    "NSString",
    "NSMutableString",
    "NSDictionary",
    "NSMutableDictionary",
    "NSArray",
    "NSMutableArray",
    "NSParagraphStyle",
    "NSMutableParagraphStyle",
}


def emit(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def clean_text(value: str) -> str:
    value = unicodedata.normalize("NFC", value.replace("\x00", ""))
    value = "".join(ch for ch in value if ch in "\n\r\t" or unicodedata.category(ch)[0] != "C")
    return value.strip()[:MAX_TEXT_CHARS]


def plausible(value: str) -> bool:
    value = value.strip()
    if not value or value in _CLASS_NAMES or len(value) < 2:
        return False
    if not any(ch.isalnum() for ch in value):
        return False
    # Class/selector names and typedstream headers are never task text.
    if value.startswith("NS") and value.isascii() and re.fullmatch(r"[A-Za-z0-9_]+", value):
        return False
    return True


def bytes_to_text(raw: bytes) -> str:
    encodings = ["utf-8"]
    # UTF-16 is only plausible when the byte payload actually carries NUL
    # bytes.  Trying it against ASCII typedstream headers creates convincing
    # but false CJK text such as `瑳敲浡...`.
    if b"\x00" in raw:
        encodings.extend(("utf-16-le", "utf-16-be"))
    for encoding in encodings:
        try:
            text = clean_text(raw.decode(encoding))
        except UnicodeDecodeError:
            continue
        if plausible(text):
            return text
    return ""


def low_level_text_candidates(data: bytes) -> Iterable[str]:
    if TypedStreamReader is not None:
        try:
            with TypedStreamReader.from_data(data) as reader:
                for event in reader:
                    raw = None
                    if CString is not None and isinstance(event, CString):
                        raw = event.contents
                    elif Atom is not None and isinstance(event, Atom):
                        raw = event.contents
                    elif Selector is not None and isinstance(event, Selector):
                        raw = event.name
                    elif isinstance(event, bytes):
                        # Typed value groups (notably NSString's `+` payload)
                        # are emitted as plain bytes by pytypedstream.  Bytes
                        # are decoded as text only after strict UTF checks and
                        # control/class filtering below.
                        raw = event
                    # SingleClass is deliberately ignored: class names are not
                    # user content and could make a malformed body look valid.
                    if isinstance(raw, bytes):
                        text = bytes_to_text(raw)
                        if text:
                            yield text
            return
        except Exception:
            # Malformed or newer typedstreams are handled by the bounded raw
            # UTF fallback below. Never invoke a generic unarchiver.
            pass
    for match in _RAW_TEXT.finditer(data[:MAX_ATTRIBUTE_BYTES]):
        text = bytes_to_text(match.group(0))
        if text:
            yield text


def decode_attributed_body(value: bytes | bytearray | memoryview | None) -> str:
    if not value:
        return ""
    data = bytes(value)
    if len(data) > MAX_ATTRIBUTE_BYTES:
        data = data[:MAX_ATTRIBUTE_BYTES]
    candidates = []
    seen = set()
    for candidate in low_level_text_candidates(data):
        candidate = clean_text(candidate)
        if plausible(candidate) and candidate not in seen:
            seen.add(candidate)
            candidates.append(candidate)
    if not candidates:
        return ""
    # The longest plausible attributed string is the message in ordinary
    # Messages archives; class/attribute fragments are shorter and filtered.
    return max(candidates, key=lambda item: (len(item), any("\u4e00" <= c <= "\u9fff" for c in item)))


def connect_readonly(path: str) -> sqlite3.Connection:
    resolved = os.path.realpath(os.path.expanduser(path))
    if not os.path.isfile(resolved):
        raise FileNotFoundError(resolved)
    # URI mode=ro prevents accidental writes even if future query code changes.
    connection = sqlite3.connect(f"file:{resolved}?mode=ro", uri=True, timeout=2)
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA busy_timeout=2000")
    return connection


def first_watermark(path: str) -> int:
    with connect_readonly(path) as connection:
        row = connection.execute("SELECT COALESCE(MAX(rowid), 0) FROM message").fetchone()
        return int(row[0] or 0)


def read_messages(path: str, after_rowid: int) -> list[dict[str, Any]]:
    sql = """
        SELECT
          m.rowid AS rowid,
          m.guid AS guid,
          m.text AS text,
          m.attributedBody AS attributed_body,
          m.is_from_me AS is_from_me,
          m.service AS service,
          COALESCE(h.id, h.uncanonicalized_id, m.handle_id, '') AS sender,
          COALESCE(MIN(NULLIF(c.chat_identifier, '')), '') AS chat_identifier,
          CASE WHEN COUNT(c.rowid) > 0 AND MIN(CASE WHEN c.style = 45 THEN 1 ELSE 0 END) = 1 THEN 1 ELSE 0 END AS one_to_one,
          MIN(c.style) AS chat_style
        FROM message AS m
        LEFT JOIN handle AS h ON h.ROWID = m.handle_id
        LEFT JOIN chat_message_join AS cmj ON cmj.message_id = m.ROWID
        LEFT JOIN chat AS c ON c.ROWID = cmj.chat_id
        WHERE m.rowid > ?
        GROUP BY m.rowid
        ORDER BY m.rowid ASC
        LIMIT 200
    """
    with connect_readonly(path) as connection:
        connection.row_factory = sqlite3.Row
        rows = connection.execute(sql, (int(after_rowid),)).fetchall()
    output = []
    for row in rows:
        text = row["text"] if isinstance(row["text"], str) else ""
        if not text:
            text = decode_attributed_body(row["attributed_body"])
        output.append({
            "rowid": int(row["rowid"]),
            "guid": str(row["guid"] or ""),
            "text": clean_text(text),
            "is_from_me": int(row["is_from_me"] or 0),
            "service": str(row["service"] or ""),
            "sender": str(row["sender"] or ""),
            "chat_identifier": str(row["chat_identifier"] or ""),
            "one_to_one": bool(row["one_to_one"]),
            "chat_style": row["chat_style"],
        })
    return output


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--db", required=True)
    parser.add_argument("--first-watermark", action="store_true")
    parser.add_argument("--after-rowid", type=int, default=0)
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    try:
        if args.probe:
            with connect_readonly(args.db) as connection:
                connection.execute("SELECT 1 FROM message LIMIT 1").fetchone()
            emit({"ok": True, "probe": "read-only"})
        elif args.first_watermark:
            emit({"ok": True, "maxRowid": first_watermark(args.db)})
        else:
            emit({"ok": True, "messages": read_messages(args.db, args.after_rowid)})
        return 0
    except Exception as exc:
        # Error text is structural only; never include a message body.
        emit({"ok": False, "error": f"{type(exc).__name__}: {str(exc)[:300]}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
