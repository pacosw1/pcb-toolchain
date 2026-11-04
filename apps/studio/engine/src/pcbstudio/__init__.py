"""PCB Studio engine."""
from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

__version__ = '0.1.0'


def main() -> None:
    ap = argparse.ArgumentParser(prog='pcbstudio')
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('serve', help='WebSocket JSON-RPC server for the desktop app')
    s.add_argument('--port', type=int, default=0, help='0 = any free port (printed on the READY line)')
    s.add_argument('--no-stdin-watch', action='store_true', help='keep serving when stdin closes (manual runs)')
    w = sub.add_parser('web', help='read-only web viewer (publish with: tailscale serve --bg 8787)')
    w.add_argument('--project', required=True, help='hardware project folder to serve')
    w.add_argument('--static', default=str(Path(__file__).resolve().parents[3] / 'app' / 'out-web'),
                   help='web build folder (app: npm run build:web)')
    w.add_argument('--glb-dir', default='~/Library/Caches/pcbstudio/glb')
    w.add_argument('--host', default='127.0.0.1')
    w.add_argument('--port', type=int, default=8787)
    w.add_argument('--token-file', default='~/Library/Application Support/pcbstudio/web-token',
                   help='viewer token file (made with mode 600 when missing)')
    m = sub.add_parser('migrate', help='write board.yaml for every board (legacy registry + gate.json + folders)')
    m.add_argument('--project', required=True, help='hardware project folder (read only)')
    m.add_argument('--out', required=True, help='output folder: <BOARD-DIR>/board.yaml + migrate-report.json')
    a = ap.parse_args()
    if a.cmd == 'migrate':
        from .migrate import migrate
        r = migrate(a.project, a.out)
        print(f'migrate {"PASS" if r.round_trip else "FAIL"}: {r.boards} boards, {r.revisions} revisions, '
              f'{r.gates} gates, {len(r.conflicts)} conflicts, round trip {"same" if r.round_trip else "DIFFERS"} '
              f'(report {r.out}/migrate-report.json)')
        raise SystemExit(0 if r.round_trip else 1)
    if a.cmd == 'serve':
        from .server import run
        asyncio.run(run(a.port, watch_stdin=not a.no_stdin_watch))
    elif a.cmd == 'web':
        from .web import serve
        serve(a.static, a.project, a.glb_dir, a.host, a.port, a.token_file)
