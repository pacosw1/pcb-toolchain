"""WebSocket JSON-RPC server on 127.0.0.1. Prints one READY line with the port, then serves until stdin closes."""
from __future__ import annotations

import asyncio
import json
import sys

from websockets.asyncio.server import ServerConnection, serve

from . import events
from .api import registry


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
    async with serve(_session, '127.0.0.1', port) as server:
        bound = server.sockets[0].getsockname()[1]
        print('READY ' + json.dumps({'port': bound}), flush=True)
        if watch_stdin:
            await _stdin_closed()
        else:
            await asyncio.Future()
