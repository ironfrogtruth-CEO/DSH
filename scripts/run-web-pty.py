#!/usr/bin/env python3
"""Run the DSH rc.8 Host behind a private PTY.

rc.8 owns stdio MCP children and exits when a detached launcher gives it an
immediate stdin EOF.  This wrapper keeps the PTY master open, forwards output
to its own stdout (web.log), and exits with the Host.  It never opens a visible
Terminal window.
"""
from __future__ import annotations

import os
import pty
import select
import signal
import subprocess
import sys
from typing import Sequence


def run(command: Sequence[str]) -> int:
    if not command:
        raise ValueError("missing command")
    master_fd, slave_fd = pty.openpty()
    child = subprocess.Popen(
        list(command),
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
    )
    os.close(slave_fd)

    def forward(signum: int, _frame: object) -> None:
        if child.poll() is None:
            try:
                child.send_signal(signum)
            except ProcessLookupError:
                pass

    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, forward)

    try:
        while child.poll() is None:
            readable, _, _ = select.select([master_fd], [], [], 1.0)
            if not readable:
                continue
            try:
                data = os.read(master_fd, 65536)
            except OSError:
                break
            if data:
                os.write(sys.stdout.fileno(), data)
        # Drain the last buffered output after the child exits.
        while True:
            readable, _, _ = select.select([master_fd], [], [], 0)
            if not readable:
                break
            try:
                data = os.read(master_fd, 65536)
            except OSError:
                break
            if not data:
                break
            os.write(sys.stdout.fileno(), data)
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass
        if child.poll() is None:
            child.terminate()
        return int(child.wait())


def main() -> int:
    try:
        return run(sys.argv[1:])
    except (OSError, ValueError) as exc:
        print(f"run-web-pty: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
