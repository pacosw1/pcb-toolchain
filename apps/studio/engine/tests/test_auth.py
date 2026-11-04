"""The engine socket refuses handshakes without the app's token and handshakes from browser pages (Origin)."""
import asyncio
import json
import os
import subprocess
import sys

from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

TOKEN = 'unit-test-token-0123456789'


def test_engine_socket_requires_token_and_refuses_browser_origins():
    p = subprocess.Popen([sys.executable, '-m', 'pcbstudio', 'serve'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         text=True, env={**os.environ, 'PCBSTUDIO_ENGINE_TOKEN': TOKEN})
    try:
        ready = json.loads(p.stdout.readline()[6:])
        assert 'token' not in ready                      # a token given by the app is never printed
        base = f'ws://127.0.0.1:{ready["port"]}'

        async def status(url, **kw):
            try:
                async with connect(url, **kw) as ws:
                    await ws.send(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'engine.ping'}))
                    return json.loads(await ws.recv())['result']['ok']
            except InvalidStatus as e:
                return e.response.status_code

        async def go():
            return [await status(base),
                    await status(base + '/?t=wrong'),
                    await status(f'{base}/?t={TOKEN}', origin='http://evil.example'),
                    await status(f'{base}/?t={TOKEN}'),
                    await status(base, additional_headers={'Authorization': f'Bearer {TOKEN}'})]
        assert asyncio.run(go()) == [401, 401, 403, True, True]
    finally:
        p.stdin.close()
        p.wait(timeout=10)
