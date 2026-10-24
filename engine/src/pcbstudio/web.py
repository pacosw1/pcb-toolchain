"""Read-only web viewer server: the app's web build, JSON-RPC over WebSocket and project files, on one port.

Bind to 127.0.0.1 and publish with `tailscale serve` (HTTPS, tailnet only). Only viewing methods are allowed: no gate
runs, no adopt, no edits. Files are served only from the open project and the 3D-model cache.
"""
from __future__ import annotations

import json
import mimetypes
from pathlib import Path

from aiohttp import WSMsgType, web

from . import api, events

READ_ONLY = {
    'engine.ping', 'engine.info', 'project.open', 'board.geometry', 'board.bom', 'board.glb', 'file.resolve',
    'run.list', 'run.get', 'run.findings',
}


def make_app(static_dir: Path, project_root: Path, glb_dir: Path) -> web.Application:
    project_root = project_root.resolve()
    glb_dir.mkdir(parents=True, exist_ok=True)
    glb_dir = glb_dir.resolve()
    api.project_open(str(project_root))           # the viewer serves one project

    async def rpc(request: web.Request) -> web.WebSocketResponse:
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
                if method == 'project.open':                     # pinned project; ignore the client's root
                    req['params'] = {'root': str(project_root)}
                if method == 'board.glb':
                    req['params'] = {**(req.get('params') or {}), 'out_dir': str(glb_dir)}
                if method not in READ_ONLY:
                    await ws.send_str(json.dumps({'jsonrpc': '2.0', 'id': req.get('id'),
                                                  'error': {'code': -32601, 'message': f'{method}: not available in the web viewer'}}))
                    continue
                reply = await api.registry.handle(json.dumps(req))
                if reply is not None:
                    await ws.send_str(reply)
        finally:
            events.unsubscribe(send)
        return ws

    async def files(request: web.Request) -> web.StreamResponse:
        path = Path(request.query.get('path', '')).resolve()
        if not any(path == root or root in path.parents for root in (project_root, glb_dir)) or not path.is_file():
            raise web.HTTPForbidden(text='outside the open project')
        ctype = 'model/gltf-binary' if path.suffix == '.glb' else (mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
        return web.FileResponse(path, headers={'Content-Type': ctype, 'Cache-Control': 'private, max-age=600'})

    async def index(request: web.Request) -> web.FileResponse:
        return web.FileResponse(static_dir / 'index.html', headers={'Cache-Control': 'no-cache'})

    app = web.Application()
    app.router.add_get('/rpc', rpc)
    app.router.add_get('/files', files)
    app.router.add_get('/', index)
    app.router.add_static('/', static_dir, show_index=False)
    return app


def serve(static_dir: str, project: str, glb_dir: str, host: str = '127.0.0.1', port: int = 8787) -> None:
    sd = Path(static_dir).expanduser().resolve()
    if not (sd / 'index.html').is_file():
        raise SystemExit(f'no web build at {sd} (cd app && npm run build:web)')
    web.run_app(make_app(sd, Path(project).expanduser(), Path(glb_dir).expanduser()), host=host, port=port,
                print=lambda s: print(f'web viewer on http://{host}:{port} (project {project})', flush=True))
