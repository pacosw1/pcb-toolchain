import asyncio
import json
import subprocess
import sys

import pytest
from websockets.asyncio.client import connect

from pcbstudio.api import registry


def call(raw):
    return asyncio.run(registry.handle(raw))


def test_ping_and_info():
    r = json.loads(call(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'engine.ping'})))
    assert r['id'] == 1 and r['result']['ok'] is True
    r = json.loads(call(json.dumps({'jsonrpc': '2.0', 'id': 2, 'method': 'engine.info'})))
    assert 'engine.ping' in r['result']['methods']


@pytest.mark.parametrize('raw,code', [
    ('{not json', -32700),
    (json.dumps({'id': 1, 'method': 'engine.ping'}), -32600),
    (json.dumps({'jsonrpc': '2.0', 'id': 3, 'method': 'nope'}), -32601),
    (json.dumps({'jsonrpc': '2.0', 'id': 4, 'method': 'engine.ping', 'params': {'x': 1}}), -32602),
])
def test_errors(raw, code):
    assert json.loads(call(raw))['error']['code'] == code


def test_notification_has_no_reply():
    assert call(json.dumps({'jsonrpc': '2.0', 'method': 'engine.ping'})) is None


def test_serve_end_to_end_and_exit_on_stdin_close():
    p = subprocess.Popen([sys.executable, '-m', 'pcbstudio', 'serve'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         text=True)
    try:
        line = p.stdout.readline()
        assert line.startswith('READY ')
        port = json.loads(line[6:])['port']

        async def go():
            async with connect(f'ws://127.0.0.1:{port}') as ws:
                await ws.send(json.dumps({'jsonrpc': '2.0', 'id': 7, 'method': 'engine.ping'}))
                return json.loads(await ws.recv())
        assert asyncio.run(go())['result']['ok'] is True
        p.stdin.close()
        assert p.wait(timeout=10) == 0
    finally:
        if p.poll() is None:
            p.kill()
