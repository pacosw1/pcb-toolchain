"""Server-to-client notifications (JSON-RPC 2.0 notifications without id). The server subscribes each connection."""
from __future__ import annotations

import asyncio
import json
from typing import Awaitable, Callable

Sender = Callable[[str], Awaitable[None]]
_subscribers: set[Sender] = set()


def subscribe(send: Sender) -> None:
    _subscribers.add(send)


def unsubscribe(send: Sender) -> None:
    _subscribers.discard(send)


def publish(method: str, params: dict) -> None:
    """Fire and forget to every connected client; a closed client is dropped."""
    text = json.dumps({'jsonrpc': '2.0', 'method': method, 'params': params})
    for send in list(_subscribers):
        task = asyncio.get_running_loop().create_task(send(text))
        task.add_done_callback(lambda t, s=send: unsubscribe(s) if t.exception() else None)
