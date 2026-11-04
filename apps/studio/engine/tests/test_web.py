"""Web viewer access: token -> cookie, 401 without, /files allowlist (no dot directories, viewer file types only)."""
import asyncio
import json

from aiohttp.test_utils import TestClient, TestServer

from pcbstudio import web


def _setup(tmp_path):
    root = tmp_path / 'proj'
    (root / 'hardware-design/boards/DEMO').mkdir(parents=True)
    (root / '.git').mkdir()
    (root / '.git/config').write_text('[core]\n')
    (root / '.git/x.pdf').write_bytes(b'%PDF-1.4 hidden')
    (root / 'ds.pdf').write_bytes(b'%PDF-1.4 datasheet')
    (root / 'notes.txt').write_text('secret')
    static = tmp_path / 'static'
    static.mkdir()
    (static / 'index.html').write_text('<!doctype html><title>viewer</title>')
    tok = web.load_token(tmp_path / 'cfg/web-token')
    assert (tmp_path / 'cfg/web-token').stat().st_mode & 0o777 == 0o600
    assert web.load_token(tmp_path / 'cfg/web-token') == tok          # stable across restarts
    return web.make_app(static, root, tmp_path / 'glb', tok), root, tok


def test_viewer_token_cookie_and_files(tmp_path):
    app, root, tok = _setup(tmp_path)

    async def go():
        async with TestClient(TestServer(app)) as c:
            assert (await c.get('/')).status == 401
            assert (await c.get('/files', params={'path': str(root / 'ds.pdf')})).status == 401
            assert (await c.get('/', params={'t': 'wrong'})).status == 401
            r = await c.get('/', params={'t': tok}, allow_redirects=False)
            assert r.status == 302 and 't=' not in r.headers['Location']
            assert 'HttpOnly' in r.headers['Set-Cookie'] and 'SameSite=Strict' in r.headers['Set-Cookie']
            assert (await c.get('/')).status == 200                       # the cookie now authenticates
            ok = await c.get('/files', params={'path': str(root / 'ds.pdf')})
            assert ok.status == 200 and ok.headers['Content-Type'] == 'application/pdf'
            for bad in (root / '.git/config', root / '.git/x.pdf', root / 'notes.txt', tmp_path / 'static/index.html',
                        root / 'hardware-design/../.git/config'):
                assert (await c.get('/files', params={'path': str(bad)})).status == 403, bad
            ws = await c.ws_connect('/rpc')
            await ws.send_str(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'run.adopt', 'params': {'id': 'x'}}))
            assert 'not available' in json.loads((await ws.receive()).data)['error']['message']
            await ws.send_str(json.dumps({'jsonrpc': '2.0', 'id': 2, 'method': 'engine.ping'}))
            assert json.loads((await ws.receive()).data)['result']['ok'] is True
            await ws.close()
            r = await c.get('/rpc', headers={'Origin': 'http://evil.example', 'Connection': 'Upgrade',
                                            'Upgrade': 'websocket', 'Sec-WebSocket-Version': '13',
                                            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ=='})
            assert r.status == 403
        async with TestClient(TestServer(app)) as fresh:                    # no cookie: the socket is refused
            assert (await fresh.get('/rpc')).status == 401
    asyncio.run(go())
