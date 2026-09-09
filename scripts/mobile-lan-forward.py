#!/usr/bin/env python3
"""LAN forwarder for the dashen mobile shell (added 2026-09-09).

The Host only binds 127.0.0.1:3080, so when the Mac shares a phone hotspot
the phone cannot reach it over the carrier-blocked public domain
(dashen.yizhiwa.cn is SNI-filtered on that egress).  This forwarder exposes
a plain TCP bridge on all LAN interfaces (port 8081) back to 127.0.0.1:3080
so the phone can open http://<mac-local-name>.local:8081 inside the hotspot
LAN, bypassing the carrier entirely.

Scope note: this bypasses the oauth2 gateway, so it grants full (not
read-only) GUI access to anyone on the same LAN.  Intended for the user's
personal hotspot only; stop the LaunchAgent to disable.
"""

import asyncio
import sys

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 8081
TARGET_HOST = "127.0.0.1"
TARGET_PORT = 3080
IDLE_TIMEOUT = 600


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
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


async def handle(client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter) -> None:
    try:
        target_reader, target_writer = await asyncio.wait_for(
            asyncio.open_connection(TARGET_HOST, TARGET_PORT), timeout=5
        )
    except (asyncio.TimeoutError, OSError):
        client_writer.close()
        return
    await asyncio.gather(
        pipe(client_reader, target_writer),
        pipe(target_reader, client_writer),
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
