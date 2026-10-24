"""JSON-RPC 2.0 core: one method registry shared by the WebSocket API and (later) the MCP server."""
from __future__ import annotations

import inspect
import json
from typing import Any, Awaitable, Callable

Handler = Callable[..., Any | Awaitable[Any]]

PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR = -32700, -32600, -32601, -32602, -32603


class Registry:
    def __init__(self) -> None:
        self._methods: dict[str, Handler] = {}

    def method(self, name: str) -> Callable[[Handler], Handler]:
        def deco(fn: Handler) -> Handler:
            if name in self._methods:
                raise ValueError(f'duplicate method {name}')
            self._methods[name] = fn
            return fn
        return deco

    def names(self) -> list[str]:
        return sorted(self._methods)

    async def call(self, name: str, params: Any) -> Any:
        fn = self._methods[name]
        if isinstance(params, dict):
            result = fn(**params)
        elif isinstance(params, list):
            result = fn(*params)
        else:
            result = fn()
        return await result if inspect.isawaitable(result) else result

    async def handle(self, raw: str) -> str | None:
        """One request text in, one response text out (None for a notification)."""
        try:
            req = json.loads(raw)
        except json.JSONDecodeError as e:
            return _error(None, PARSE_ERROR, f'parse error: {e}')
        if not isinstance(req, dict) or req.get('jsonrpc') != '2.0' or not isinstance(req.get('method'), str):
            return _error(req.get('id') if isinstance(req, dict) else None, INVALID_REQUEST, 'invalid request')
        rid, name, params = req.get('id'), req['method'], req.get('params')
        if name not in self._methods:
            return _error(rid, METHOD_NOT_FOUND, f'method not found: {name}')
        try:
            result = await self.call(name, params)
        except TypeError as e:
            return _error(rid, INVALID_PARAMS, str(e))
        except Exception as e:  # noqa: BLE001 - reported to the caller, never swallowed
            return _error(rid, INTERNAL_ERROR, f'{type(e).__name__}: {e}')
        if rid is None:
            return None
        return json.dumps({'jsonrpc': '2.0', 'id': rid, 'result': result})


def _error(rid: Any, code: int, message: str) -> str:
    return json.dumps({'jsonrpc': '2.0', 'id': rid, 'error': {'code': code, 'message': message}})
