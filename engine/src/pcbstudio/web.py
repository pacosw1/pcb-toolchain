"""Read-only web viewer server: the app's web build, JSON-RPC over WebSocket and project files, on one port.

Bind to 127.0.0.1 and publish with `tailscale serve` (HTTPS, tailnet only). Only viewing methods are allowed: no gate
runs, no adopt, no edits.

Access: a viewer token (random, kept in ~/Library/Application Support/pcbstudio/web-token, mode 600) is printed in the
start URL. A request with `?t=TOKEN` gets an HttpOnly SameSite=Strict cookie and a redirect without the token; every
other request needs the cookie (401 without). /rpc also refuses an Origin that is not this site.

Files: /files serves only PDFs, 3D models (.glb) and images from the open project and the 3D-model cache, and never
anything in a dot directory (.git, .gate, .env, ...). board.glb exports run one at a time; a second concurrent export
request is refused (busy) instead of queuing more KiCad 3D exports (kicad/cli.py).
"""
from __future__ import annotations

import asyncio
import hmac
import json
import mimetypes
import os
import secrets
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import WSMsgType, web

from . import api, events

READ_ONLY = {
    'engine.ping', 'engine.info', 'project.open', 'board.geometry', 'board.bom', 'board.glb', 'file.resolve',
    'run.list', 'run.get', 'run.findings', 'run.candidate', 'board.parts', 'part.get', 'parts.index',
}   # never op.build, op.route, run.adopt, gate.check or run.cancel

FILE_TYPES = {'.pdf', '.glb', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'}
COOKIE = 'pcbstudio_view'
DEFAULT_TOKEN_FILE = '~/Library/Application Support/pcbstudio/web-token'


def load_token(path: str | Path = DEFAULT_TOKEN_FILE) -> str:
    """The viewer token from its file; a new one (mode 600) when the file does not exist."""
    p = Path(path).expanduser()
    if p.is_file():
        tok = p.read_text().strip()
        if len(tok) >= 20:
            return tok
    p.parent.mkdir(parents=True, exist_ok=True)
    tok = secrets.token_urlsafe(32)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(tok + '\n')
    return tok


def allowed_file(path: Path, roots: tuple[Path, ...]) -> bool:
    """A resolved file inside one of the roots, of an allowed type, with no dot directory below that root."""
    for root in roots:
        if root in path.parents:
            rel = path.relative_to(root).parts
            return path.suffix.lower() in FILE_TYPES and not any(part.startswith('.') for part in rel)
    return False


def make_app(static_dir: Path, project_root: Path, glb_dir: Path, token: str) -> web.Application:
    project_root = project_root.resolve()
    glb_dir.mkdir(parents=True, exist_ok=True)
    glb_dir = glb_dir.resolve()
    api.project_open(str(project_root))           # the viewer serves one project
    glb_lock = asyncio.Lock()

    def https(request: web.Request) -> bool:
        return request.secure or request.headers.get('X-Forwarded-Proto', '') == 'https'

    @web.middleware
    async def auth(request: web.Request, handler):
        given = request.query.get('t')
        if given is not None and hmac.compare_digest(given.encode(), token.encode()):
            if request.path == '/rpc':
                return await handler(request)
            query = request.rel_url.query.copy()
            del query['t']
            resp = web.Response(status=302, headers={'Location': str(request.rel_url.with_query(query))})
            resp.set_cookie(COOKIE, token, httponly=True, samesite='Strict', secure=https(request), path='/',
                            max_age=30 * 86400)
            return resp
        if not hmac.compare_digest(request.cookies.get(COOKIE, '').encode(), token.encode()):
            return web.Response(status=401, text='viewer token required: open the URL the server printed at start\n')
        return await handler(request)

    async def rpc(request: web.Request) -> web.WebSocketResponse:
        origin = request.headers.get('Origin')
        if origin is not None:
            hosts = {request.host, request.headers.get('X-Forwarded-Host', '')}
            if urlsplit(origin).netloc not in hosts:
                raise web.HTTPForbidden(text='cross-site origin')
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        send = ws.send_str
        events.subscribe(send)
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    req = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue
                method = req.get('method') if isinstance(req, dict) else None
                if method not in READ_ONLY:
                    await ws.send_str(_error(req.get('id') if isinstance(req, dict) else None,
                                             f'{method}: not available in the web viewer'))
                    continue
                if method == 'project.open':                     # pinned project; ignore the client's root
                    req['params'] = {'root': str(project_root)}
                if method == 'board.glb':
                    req['params'] = {**(req.get('params') or {}), 'out_dir': str(glb_dir)}
                    if glb_lock.locked():
                        await ws.send_str(_error(req.get('id'), 'board.glb: another 3D export is running; retry later',
                                                 -32000))
                        continue
                    async with glb_lock:
                        reply = await api.registry.handle(json.dumps(req))
                else:
                    reply = await api.registry.handle(json.dumps(req))
                if reply is not None:
                    await ws.send_str(reply)
        finally:
            events.unsubscribe(send)
        return ws

    async def files(request: web.Request) -> web.StreamResponse:
        path = Path(request.query.get('path', '')).resolve()
        if not path.is_file() or not allowed_file(path, (project_root, glb_dir)):
            raise web.HTTPForbidden(text='not a viewer file of the open project')
        ctype = 'model/gltf-binary' if path.suffix == '.glb' else (mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
        headers = {'Content-Type': ctype, 'Cache-Control': 'private, max-age=600', 'X-Content-Type-Options': 'nosniff'}
        if path.suffix.lower() == '.svg':                        # an SVG can carry script: no script, no same origin
            headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
        return web.FileResponse(path, headers=headers)

    async def index(request: web.Request) -> web.FileResponse:
        return web.FileResponse(static_dir / 'index.html', headers={'Cache-Control': 'no-cache'})

    app = web.Application(middlewares=[auth])
    app.router.add_get('/rpc', rpc)
    app.router.add_get('/files', files)
    app.router.add_get('/', index)
    app.router.add_static('/', static_dir, show_index=False)
    return app


def _error(rid, message: str, code: int = -32601) -> str:
    return json.dumps({'jsonrpc': '2.0', 'id': rid, 'error': {'code': code, 'message': message}})


def serve(static_dir: str, project: str, glb_dir: str, host: str = '127.0.0.1', port: int = 8787,
          token_file: str = DEFAULT_TOKEN_FILE) -> None:
    sd = Path(static_dir).expanduser().resolve()
    if not (sd / 'index.html').is_file():
        raise SystemExit(f'no web build at {sd} (cd app && npm run build:web)')
    token = load_token(token_file)
    web.run_app(make_app(sd, Path(project).expanduser(), Path(glb_dir).expanduser(), token), host=host, port=port,
                print=lambda s: print(f'web viewer on http://{host}:{port}/?t={token} (project {project}; the token '
                                      f'is in {Path(token_file).expanduser()})', flush=True))
