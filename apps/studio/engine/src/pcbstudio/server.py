"""WebSocket JSON-RPC server on 127.0.0.1. Prints one READY line with the port, then serves until stdin closes.

Authentication: the app generates a random token and gives it in the environment (PCBSTUDIO_ENGINE_TOKEN, not on the
command line, so `ps` does not show it). The server removes it from its own environment (tools/pcb children do not
inherit it) and refuses every WebSocket handshake that does not carry it as `?t=TOKEN` or `Authorization: Bearer
TOKEN`. A handshake with an Origin header comes from a browser page, never from the app's main process: refused.
Without the variable (manual runs, tests) the server makes a token and prints it on the READY line.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import os
import secrets
import sys
from http import HTTPStatus
from urllib.parse import parse_qs, urlsplit

from websockets.asyncio.server import ServerConnection, serve
from websockets.http11 import Request, Response

from . import events
from .api import registry

TOKEN_ENV = 'PCBSTUDIO_ENGINE_TOKEN'


def request_token(request: Request) -> str:
    """The token a handshake carries (query `t` or a Bearer header), or ''."""
    q = parse_qs(urlsplit(request.path).query).get('t')
    if q:
        return q[0]
    auth = request.headers.get('Authorization', '')
    return auth[7:] if auth.startswith('Bearer ') else ''


def make_authorizer(token: str):
    def process_request(connection: ServerConnection, request: Request) -> Response | None:
        if request.headers.get('Origin') is not None:
            return connection.respond(HTTPStatus.FORBIDDEN, 'browser origins are not allowed\n')
        if not hmac.compare_digest(request_token(request).encode(), token.encode()):
            return connection.respond(HTTPStatus.UNAUTHORIZED, 'engine token required\n')
        return None
    return process_request


async def _session(ws: ServerConnection) -> None:
    events.subscribe(ws.send)
    try:
        async for message in ws:
            # Each request runs as its own task so a slow method does not block notifications or other calls.
            asyncio.get_running_loop().create_task(_answer(ws, message))
    finally:
        events.unsubscribe(ws.send)


async def _answer(ws: ServerConnection, message: str | bytes) -> None:
    reply = await registry.handle(message if isinstance(message, str) else message.decode())
    if reply is not None:
        await ws.send(reply)


async def _stdin_closed() -> None:
    """The app owns the engine: when its pipe closes, the engine exits (no orphan processes)."""
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    while await reader.read(1024):
        pass


async def run(port: int = 0, watch_stdin: bool = True) -> None:
    given = os.environ.pop(TOKEN_ENV, '')
    token = given or secrets.token_urlsafe(32)
    async with serve(_session, '127.0.0.1', port, process_request=make_authorizer(token)) as server:
        bound = server.sockets[0].getsockname()[1]
        ready = {'port': bound} if given else {'port': bound, 'token': token}
        print('READY ' + json.dumps(ready), flush=True)
        if watch_stdin:
            await _stdin_closed()
        else:
            await asyncio.Future()
