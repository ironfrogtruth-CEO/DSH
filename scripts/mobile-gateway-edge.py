#!/usr/bin/env python3
"""dashen mobile gateway edge (127.0.0.1:3081 -> 127.0.0.1:3080).

Rebuilt 2026-09-09 after the original @local/dsh-mobile-gateway package was
lost from ~/.dsh/extensions/ (same deletion pattern as the morning's
connector/netwatch scripts). The Cloudflare remote ingress points
dashen.yizhiwa.cn at http://127.0.0.1:3081; this service restores that
listener as a standalone KeepAlive LaunchAgent so Host restarts can no
longer take the public entry down.

Contract (from cloudflare-activation-contract.json): validate the request
head before proxying, then forward transparently. A raw TCP bridge keeps
HTTP, WebSocket upgrade and SSE intact. Validation rules:

- The Host header must be exactly dashen.yizhiwa.cn (cloudflared sets it
  via originRequest.httpHostHeader). Anything else is refused with 403.
- Only loopback can connect (listening on 127.0.0.1 enforces this).
"""

import asyncio
import sys

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 3081
TARGET_HOST = "127.0.0.1"
TARGET_PORT = 3080
ALLOWED_HOSTS = {"dashen.yizhiwa.cn"}
HEAD_MAX = 64 * 1024
IDLE_TIMEOUT = 900


def head_host(head: bytes) -> str:
    try:
        head_text = head.decode("latin-1")
        for line in head_text.split("\r\n")[1:]:
            if line[:5].lower() == "host:":
                return line[5:].strip().lower()
    except (UnicodeDecodeError, IndexError):
        return ""
    return ""


async def pump(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while True:
            data = await asyncio.wait_for(reader.read(65536), timeout=IDLE_TIMEOUT)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (asyncio.TimeoutError, ConnectionError, asyncio.IncompleteReadError):
        pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except (ConnectionError, OSError):
            pass


def refuse_403() -> bytes:
    return (
        b"HTTP/1.1 403 Forbidden\r\n"
        b"Content-Type: text/plain; charset=utf-8\r\n"
        b"Content-Length: 9\r\n"
        b"Connection: close\r\n"
        b"\r\n"
        b"forbidden"
    )


async def handle(client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter) -> None:
    head = b""
    while b"\r\n\r\n" not in head:
        try:
            chunk = await asyncio.wait_for(client_reader.read(4096), timeout=15)
        except (asyncio.TimeoutError, ConnectionError):
            return
        if not chunk:
            return
        head += chunk
        if len(head) > HEAD_MAX:
            return
    if head_host(head) not in ALLOWED_HOSTS:
        client_writer.write(refuse_403())
        await client_writer.drain()
        client_writer.close()
        return
    try:
        target_reader, target_writer = await asyncio.wait_for(
            asyncio.open_connection(TARGET_HOST, TARGET_PORT), timeout=5
        )
    except (asyncio.TimeoutError, OSError):
        client_writer.write(
            b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
        await client_writer.drain()
        client_writer.close()
        return
    target_writer.write(head)
    await asyncio.gather(
        pump(client_reader, target_writer),
        pump(target_reader, client_writer),
    )


async def main() -> None:
    server = await asyncio.start_server(handle, LISTEN_HOST, LISTEN_PORT)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
