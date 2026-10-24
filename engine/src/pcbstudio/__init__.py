"""PCB Studio engine."""
from __future__ import annotations

import argparse
import asyncio

__version__ = '0.1.0'


def main() -> None:
    ap = argparse.ArgumentParser(prog='pcbstudio')
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('serve', help='WebSocket JSON-RPC server for the desktop app')
    s.add_argument('--port', type=int, default=0, help='0 = any free port (printed on the READY line)')
    s.add_argument('--no-stdin-watch', action='store_true', help='keep serving when stdin closes (manual runs)')
    a = ap.parse_args()
    if a.cmd == 'serve':
        from .server import run
        asyncio.run(run(a.port, watch_stdin=not a.no_stdin_watch))
