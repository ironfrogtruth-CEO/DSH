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


def access_log(kind: str, path: str, verdict: str, host: str) -> None:
    try:
        from datetime import datetime, timezone

        stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with open("/Users/marcus/.dsh/logs/mobile-gateway-edge-access.log", "a") as handle:
            handle.write(f"{stamp} {kind} {verdict} {path} {host}\n")
    except OSError:
        pass


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


def rewrite_headers(head: bytes, replacements: dict) -> bytes:
    lines = head.decode("latin-1").split("\r\n")
    lowered = {name.lower(): value for name, value in replacements.items()}
    for index, line in enumerate(lines[1:], start=1):
        colon = line.find(":")
        if colon <= 0:
            continue
        name = line[:colon].strip().lower()
        if name in lowered:
            lines[index] = f"{lines[index][:colon + 1]} {lowered[name]}"
    present = {line.split(":", 1)[0].strip().lower() for line in lines[1:] if ":" in line}
    boundary = lines.index("")
    for name, value in replacements.items():
        if name.lower() not in present:
            lines.insert(boundary, f"{name}: {value}")
            boundary += 1
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

    is_upgrade = b"upgrade: websocket" in head.lower()
    note = "ws" if is_upgrade else "http"
    if head_host(head) != PUBLIC_HOST:
        access_log(note, head_path(head), "403-badhost", head_host(head))
        client_writer.write(simple_response("403 Forbidden", body=b"forbidden"))
        await client_writer.drain()
        client_writer.close()
        return

    path = head_path(head)

    if path.startswith(AUTH_PATH_PREFIX):
        # Dial the local oauth2-proxy, but keep the public Host header so its
        # whitelist_domains/cookie domain checks match.
        dial_host, dial_port, header_authority = AUTH_HOST, AUTH_PORT, PUBLIC_HOST
        header_rewrite = {"Host": PUBLIC_HOST}
        access_log(note, path, "pass-oauth2", "")
    else:
        if not await authorized(head_cookie(head), path):
            access_log(note, path, "401-redirect", "")
            redirect = (
                f"Location: https://{PUBLIC_HOST}/oauth2/start?rd={quote(path, safe='')}\r\n"
            )
            client_writer.write(simple_response("302 Found", redirect))
            await client_writer.drain()
            client_writer.close()
            return
        access_log(note, path, "auth-ok", "")
        # Rewrite Host AND Origin to the trusted authority: the /api fence
        # checks both before admitting WebSocket event streams.
        dial_host, dial_port = APP_HOST, APP_PORT
        header_rewrite = {
            "Host": f"{APP_HOST}:{APP_PORT}",
            "Origin": f"http://{APP_HOST}:{APP_PORT}",
        }

    try:
        target_reader, target_writer = await asyncio.wait_for(
            asyncio.open_connection(dial_host, dial_port), timeout=5
        )
    except (asyncio.TimeoutError, OSError):
        client_writer.write(simple_response("502 Bad Gateway"))
        await client_writer.drain()
        client_writer.close()
        return

    # This proxy parses one HTTP request per connection. Keep-alive would
    # bypass auth/header rewriting on subsequent requests in the raw pump.
    # WebSocket upgrades remain persistent and retain their Upgrade headers.
    if not is_upgrade:
        header_rewrite["Connection"] = "close"
    target_writer.write(rewrite_headers(head, header_rewrite))
    await target_writer.drain()
    upstream_task = asyncio.create_task(pump(client_reader, target_writer))
    first_line = b""
    try:
        first_line = await asyncio.wait_for(target_reader.readline(), timeout=5)
    except (asyncio.TimeoutError, ConnectionError):
        pass
    access_log(
        "ws-status" if is_upgrade else "http-status",
        path,
        first_line.decode("latin-1", "replace").strip()[:44] or "no-response",
        "",
    )
    if first_line:
        client_writer.write(first_line)
    await asyncio.gather(
        upstream_task,
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
