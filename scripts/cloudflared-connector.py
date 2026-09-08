#!/usr/bin/env python3
"""cloudflared tunnel supervisor for the dashen mobile gateway.

Rebuilt 2026-09-09 from the deployment records in
~/Desktop/output/remaining-upgrades-20260907/ after the original file was
lost from ~/.dsh/scripts/. Behavior contract (matches plan.v1 + observed logs):

- launchd job cn.yizhiwa.dashen.cloudflared runs this file with
  WorkingDirectory=/Users/marcus/.dsh/private/mobile-gateway.
- Token is read from tunnel.token via --token-file; it never appears in
  argv, environment, or logs.
- metrics endpoint on 127.0.0.1:20241.
- warn/error log events are reduced to allowlisted metadata only
  ({time, level, event}) in cloudflared-connector.warn.jsonl, rotated at
  1 MiB with 3 generations, mode 0600.
- pid file holds the supervisor pid; flock on the lock file prevents a
  second supervisor (a colliding start exits 0 quietly).
- The cloudflared exit code is propagated so launchd KeepAlive restarts.
"""

import errno
import fcntl
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

BASE = Path("/Users/marcus/.dsh/private/mobile-gateway")
CLOUDFLARED = "/Users/marcus/.dsh/tools/cloudflared/2026.8.3/cloudflared"
METRICS = "127.0.0.1:20241"
TOKEN_FILE = BASE / "tunnel.token"
PID_FILE = BASE / "cloudflared-connector.pid"
LOCK_FILE = BASE / "cloudflared-connector.lock"
WARN_LOG = BASE / "cloudflared-connector.warn.jsonl"
MAX_WARN_BYTES = 1024 * 1024
MAX_WARN_FILES = 3


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def classify_event(text: str) -> str:
    lowered = text.lower()
    if "connector" in lowered:
        return "connector_warning"
    if "connection" in lowered:
        return "connection_warning"
    return "tunnel_warning"


def rotate_warn_log() -> None:
    if not WARN_LOG.exists() or WARN_LOG.stat().st_size < MAX_WARN_BYTES:
        return
    oldest = WARN_LOG.with_name(WARN_LOG.name + f".{MAX_WARN_FILES}")
    if oldest.exists():
        oldest.unlink()
    for index in range(MAX_WARN_FILES - 1, 0, -1):
        src = WARN_LOG.with_name(WARN_LOG.name + f".{index}")
        dst = WARN_LOG.with_name(WARN_LOG.name + f".{index + 1}")
        if src.exists():
            src.rename(dst)
    WARN_LOG.rename(WARN_LOG.with_name(WARN_LOG.name + ".1"))


def append_warning(level: str, text: str) -> None:
    try:
        rotate_warn_log()
        record = {
            "time": utc_now_iso(),
            "level": level,
            "event": classify_event(text),
        }
        line = json.dumps(record, ensure_ascii=False) + "\n"
        fd = os.open(WARN_LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, line.encode("utf-8"))
        finally:
            os.close(fd)
    except OSError:
        # Logging must never take the tunnel down.
        pass


def parse_cloudflared_line(raw: str):
    """Return (level, text) for warn/error logfmt lines, else None.

    cloudflared stderr lines look like:
    2026-09-09T00:00:00Z ERR Connection terminated error="..."
    """
    parts = raw.strip().split(None, 2)
    if len(parts) < 3:
        return None
    stamp, token, text = parts
    if not stamp.endswith("Z"):
        return None
    level = {"ERR": "error", "WRN": "warning"}.get(token.upper())
    if level is None:
        return None
    return level, text


def main() -> int:
    BASE.mkdir(parents=True, exist_ok=True)
    if not TOKEN_FILE.exists():
        sys.stderr.write("cloudflared-connector: token file missing\n")
        return 1

    lock_fd = os.open(LOCK_FILE, os.O_WRONLY | os.O_CREAT, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        if exc.errno in (errno.EACCES, errno.EAGAIN):
            return 0
        raise
    os.ftruncate(lock_fd, 0)
    os.write(lock_fd, str(os.getpid()).encode("ascii"))

    # Replace any stale pid file from a previous supervisor generation.
    PID_FILE.write_text(str(os.getpid()) + "\n")

    argv = [
        CLOUDFLARED,
        "tunnel",
        "--metrics", METRICS,
        "run",
        "--token-file", str(TOKEN_FILE),
    ]

    child = subprocess.Popen(
        argv,
        cwd=str(BASE),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
        env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": os.environ.get("HOME", "/Users/marcus")},
    )

    stopping = {"flag": False}

    def forward(signum, _frame):
        stopping["flag"] = True
        try:
            child.send_signal(signum)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)

    assert child.stderr is not None
    for raw in child.stderr:
        parsed = parse_cloudflared_line(raw)
        if parsed is not None:
            level, text = parsed
            append_warning(level, text)

    code = child.wait()
    try:
        PID_FILE.unlink()
    except OSError:
        pass
    return code if not stopping["flag"] else 0


if __name__ == "__main__":
    sys.exit(main())
