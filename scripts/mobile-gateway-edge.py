#!/usr/bin/env python3
"""dashen mobile gateway edge (127.0.0.1:3081).

Rebuilt 2026-09-09 (v2) after the original @local/dsh-mobile-gateway
package was lost from ~/.dsh/extensions/. Restores the public entry
contract:

- /oauth2/*        -> oauth2-proxy on 127.0.0.1:4180 (login/callback, Host
                      header kept as dashen.yizhiwa.cn for whitelist checks)
- everything else  -> require a valid oauth2 session (validated against
                      oauth2-proxy /oauth2/auth, X-Auth-Request mode), then
                      forward to the Host web server on 127.0.0.1:3080 with
                      the Host header rewritten to the trusted authority so
                      the /api browser-trust fence accepts the WebSocket
                      event streams (/api/events.mux, /api/events.host).
- Host header must be dashen.yizhiwa.cn; anything else is refused.

Auth failures get a 302 to /oauth2/start so the browser login flow works
end to end. Auth results are cached per cookie hash for 30s to keep the
per-request overhead negligible. WebSocket upgrades carry cookies and are
validated by the same check before being piped transparently.
"""

import asyncio
import hashlib
import sys
from urllib.parse import quote

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 3081
APP_HOST, APP_PORT = "127.0.0.1", 3080
AUTH_HOST, AUTH_PORT = "127.0.0.1", 4180
PUBLIC_HOST = "dashen.yizhiwa.cn"
AUTH_PATH_PREFIX = "/oauth2/"
AUTH_CHECK_PATH = "/oauth2/auth"
AUTH_CACHE_TTL = 30
HEAD_MAX = 64 * 1024
IDLE_TIMEOUT = 900
AUTH_TIMEOUT = 4

_AUTH_CACHE = {}


def head_host(head: bytes) -> str:
    try:
        for line in head.decode("latin-1").split("\r\n")[1:]:
            if line[:5].lower() == "host:":
                return line[5:].strip().lower()
    except (UnicodeDecodeError, IndexError):
        return ""
    return ""


def head_cookie(head: bytes) -> str:
    try:
        for line in head.decode("latin-1").split("\r\n")[1:]:
            if line[:7].lower() == "cookie:":
                return line[7:].strip()
    except (UnicodeDecodeError, IndexError):
        return ""
    return ""


def head_path(head: bytes) -> str:
    try:
        request_line = head.decode("latin-1").split("\r\n", 1)[0]
        parts = request_line.split(" ")
        return parts[1] if len(parts) >= 2 else "/"
    except (UnicodeDecodeError, IndexError):
        return "/"


def rewrite_host(head: bytes, authority: str) -> bytes:
    lines = head.decode("latin-1").split("\r\n")
    for index, line in enumerate(lines[1:], start=1):
        if line[:5].lower() == "host:":
            lines[index] = f"Host: {authority}"
            break
    return "\r\n".join(lines).encode("latin-1")


async def authorized(cookie: str, path: str) -> bool:
    """Validate the browser session against oauth2-proxy (X-Auth-Request)."""
    if not cookie:
        return False
    key = hashlib.sha256((cookie + "|" + path.split("?")[0]).encode()).hexdigest()[:32]
    now = asyncio.get_event_loop().time()
    cached = _AUTH_CACHE.get(key)
    if cached and now - cached < AUTH_CACHE_TTL:
        return True
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(AUTH_HOST, AUTH_PORT), timeout=AUTH_TIMEOUT
        )
        request = (
            f"GET {AUTH_CHECK_PATH} HTTP/1.1\r\n"
            f"Host: {PUBLIC_HOST}\r\n"
            f"Cookie: {cookie}\r\n"
            f"X-Forwarded-Uri: {path}\r\n"
            f"X-Forwarded-Proto: https\r\n"
            f"Connection: close\r\n\r\n"
        ).encode("latin-1")
        writer.write(request)
        await writer.drain()
        status_line = await asyncio.wait_for(reader.readline(), timeout=AUTH_TIMEOUT)
        writer.close()
        status = int(status_line.split()[1]) if len(status_line.split()) >= 2 else 0
        ok = 200 <= status < 300
    except (asyncio.TimeoutError, OSError, ValueError):
        ok = False
    if ok:
        _AUTH_CACHE[key] = now
    return ok


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


def simple_response(status: str, extra_headers: str = "", body: bytes = b"") -> bytes:
    return (
        f"HTTP/1.1 {status}\r\n"
        f"Content-Length: {len(body)}\r\n"
        f"Connection: close\r\n{extra_headers}\r\n"
    ).encode("latin-1") + body


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

    if head_host(head) != PUBLIC_HOST:
        client_writer.write(simple_response("403 Forbidden", body=b"forbidden"))
        await client_writer.drain()
        client_writer.close()
        return

    path = head_path(head)

    if path.startswith(AUTH_PATH_PREFIX):
        # Dial the local oauth2-proxy, but keep the public Host header so its
        # whitelist_domains/cookie domain checks match.
        dial_host, dial_port, header_authority = AUTH_HOST, AUTH_PORT, PUBLIC_HOST
    else:
        if not await authorized(head_cookie(head), path):
            redirect = (
                f"Location: https://{PUBLIC_HOST}/oauth2/start?rd={quote(path, safe='')}\r\n"
            )
            client_writer.write(simple_response("302 Found", redirect))
            await client_writer.drain()
            client_writer.close()
            return
        # Rewrite Host to the trusted authority so the /api browser-trust
        # fence accepts these requests (incl. WebSocket event streams).
        dial_host, dial_port, header_authority = APP_HOST, APP_PORT, f"{APP_HOST}:{APP_PORT}"

    try:
        target_reader, target_writer = await asyncio.wait_for(
            asyncio.open_connection(dial_host, dial_port), timeout=5
        )
    except (asyncio.TimeoutError, OSError):
        client_writer.write(simple_response("502 Bad Gateway"))
        await client_writer.drain()
        client_writer.close()
        return

    target_writer.write(rewrite_host(head, header_authority))
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
