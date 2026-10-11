#!/usr/bin/env python3
"""Live web view of routing jobs over Tailscale (W12, CIP #829); standard library only, read-only.

  python3 tools/route_live.py --serve [OUTDIR ...] [--port 8787]
      prints the URL http://localhost:8787/ and serves until Ctrl-C.
      Runs: every /tmp/w*/run* directory plus the OUTDIRs given. No launchd: run it in a terminal pane or with
      `nohup python3 tools/route_live.py --serve >/tmp/route_live.log 2>&1 &`.

Pages (GET only; no write endpoint, no secret, no directory listing outside the run roots):
  /                    index of active runs (progress.jsonl written in the last 60 s and no outcome.json) and recent ones
  /run/<id>            one run, refreshed every 3 s: the route_status line, stage, elapsed, open, best, vias, ETA, the
                       pass trend (inline SVG), the action log tail (tools/run_record.py, derived in memory, nothing
                       written), the latest board frame (OUTDIR/snapshots/latest.png from tools/board_frame.py; a
                       placeholder until the first one)
  /run/<id>/frame.png  the latest frame
The <id> is the run's path under /tmp (w12/run-1) or "x/<basename>" for a command-line OUTDIR; a request for a path
that is not in the current run list is a 404. The server binds the Tailscale address 100.64.0.1 only
(--bind accepts a 100.64.0.0/10 Tailscale address or 127.0.0.1 for tests; 0.0.0.0, :: and public addresses are refused).
Single column, large text: readable on an iPhone.
"""
import argparse
import glob
import html
import ipaddress
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_record  # noqa: E402

TS_ADDR = '100.64.0.1'
TS_HOST = 'localhost'
PORT = 8787
ROOTS = ('/tmp/w*/run*',)
ACTIVE_S = 60
REFRESH_S = 3
TAIL = 25

CSS = """body{font-family:-apple-system,Helvetica,sans-serif;font-size:20px;margin:12px;max-width:720px;background:#111;color:#eee}
h1{font-size:24px;margin:8px 0}h2{font-size:20px;margin:16px 0 6px;color:#9cf}a{color:#9cf;text-decoration:none}
.status{font-size:22px;font-weight:600;padding:8px;background:#222;border-radius:8px;word-break:break-word}
table{border-collapse:collapse;width:100%}td{padding:6px 4px;border-bottom:1px solid #333;vertical-align:top}
td.k{color:#aaa;width:38%}pre{font-size:14px;white-space:pre-wrap;word-break:break-word;background:#181818;padding:8px;border-radius:8px}
img,svg{width:100%;height:auto;border-radius:8px;background:#000}.dim{color:#888;font-size:16px}"""


def allowed_bind(addr):
    """True for a Tailscale (100.64.0.0/10) or loopback address; never 0.0.0.0, :: or a public address."""
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    return ip.is_loopback or ip in ipaddress.ip_network('100.64.0.0/10')


class Runs:
    """The run directories the server may show: the glob roots plus the explicit OUTDIRs."""

    def __init__(self, extra=(), roots=ROOTS):
        self.extra = [os.path.abspath(p) for p in extra]
        self.roots = roots

    def ids(self):
        out = {}
        for pat in self.roots:
            for d in sorted(glob.glob(pat)):
                if os.path.isdir(d) and d.startswith('/tmp/'):
                    out[os.path.relpath(d, '/tmp')] = d
        for d in self.extra:
            if os.path.isdir(d):
                out['x/' + os.path.basename(d)] = d
        return out

    def resolve(self, rid):
        return self.ids().get(rid)


def _rows(path):
    try:
        return [json.loads(l) for l in open(path) if l.strip()]
    except (OSError, ValueError):
        return []


def status(outdir):
    """{'line', 'stage', 'elapsed_s', 'open', 'best', 'vias', 'eta_s', 'state', 'passes': [(elapsed, open)]}."""
    rows = _rows(os.path.join(outdir, 'progress.jsonl'))
    last = rows[-1] if rows else {}
    f = lambda v: '-' if v is None else v
    line = (f"{last['stage']} {last.get('elapsed_s')}s open={f(last.get('open'))} best={f(last.get('best_open'))} "
            f"vias={f(last.get('vias'))} eta={f(last.get('eta_s'))}") if last else 'no progress yet'
    outcome = None
    try:
        outcome = json.load(open(os.path.join(outdir, 'outcome.json')))
    except (OSError, ValueError):
        pass
    try:
        age = time.time() - os.path.getmtime(os.path.join(outdir, 'progress.jsonl'))
    except OSError:
        age = None
    state = (outcome.get('status', 'ended').upper() if outcome else
             'ACTIVE' if age is not None and age < ACTIVE_S else 'STALE' if age is not None else 'NO PROGRESS')
    return dict(line=line, stage=last.get('stage', '-'), elapsed_s=last.get('elapsed_s'), open=last.get('open'),
                best=last.get('best_open'), vias=last.get('vias'), eta_s=last.get('eta_s'), state=state, age_s=age,
                passes=[(r.get('elapsed_s') or 0, r['open']) for r in rows if r.get('pass') is not None and r.get('open') is not None])


def trend_svg(passes, w=680, h=160):
    """Open connections per pass as a polyline; the last point labelled."""
    if len(passes) < 2:
        return '<svg viewBox="0 0 %d %d"><text x="10" y="30" fill="#888" font-size="18">no passes yet</text></svg>' % (w, h)
    xs = [p[0] for p in passes]
    ys = [p[1] for p in passes]
    x0, x1 = min(xs), max(xs) or 1
    y1 = max(ys) or 1
    pad = 24
    sx = lambda x: pad + (x - x0) / (x1 - x0 or 1) * (w - 2 * pad)
    sy = lambda y: h - pad - y / y1 * (h - 2 * pad)
    pts = ' '.join(f'{sx(x):.1f},{sy(y):.1f}' for x, y in passes)
    lx, ly = sx(xs[-1]), sy(ys[-1])
    return (f'<svg viewBox="0 0 {w} {h}" preserveAspectRatio="none"><rect width="{w}" height="{h}" fill="#000"/>'
            f'<polyline points="{pts}" fill="none" stroke="#9cf" stroke-width="3"/>'
            f'<circle cx="{lx:.1f}" cy="{ly:.1f}" r="5" fill="#f66"/>'
            f'<text x="{pad}" y="18" fill="#888" font-size="14">open per pass (max {y1})</text>'
            f'<text x="{min(lx, w - 60):.1f}" y="{max(ly - 10, 16):.1f}" fill="#f66" font-size="16">{ys[-1]}</text></svg>')


def log_tail(outdir, n=TAIL):
    recs = run_record.ordered(run_record.view(outdir))
    return [run_record.fmt(r) for r in recs[-n:]]


def latest_frame(outdir):
    p = os.path.join(outdir, 'snapshots', 'latest.png')
    if os.path.isfile(p):
        return p
    frames = sorted(glob.glob(os.path.join(outdir, 'snapshots', '*.png')))
    return frames[-1] if frames else None


PLACEHOLDER = ('<svg viewBox="0 0 600 300"><rect width="600" height="300" fill="#000"/>'
               '<text x="300" y="150" fill="#666" font-size="24" text-anchor="middle">no board frame yet</text></svg>')


def page(title, body, refresh=None):
    meta = f'<meta http-equiv="refresh" content="{refresh}">' if refresh else ''
    return (f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'{meta}<title>{html.escape(title)}</title><style>{CSS}</style></head><body>{body}</body></html>')


def index_html(runs):
    ids = runs.ids()
    rows = []
    for rid, d in ids.items():
        s = status(d)
        try:
            mt = os.path.getmtime(os.path.join(d, 'progress.jsonl'))
        except OSError:
            mt = 0
        rows.append((s['state'] != 'ACTIVE', -mt, rid, s))
    rows.sort()
    items = ''.join(f'<tr><td class="k"><a href="/run/{html.escape(rid)}">{html.escape(rid)}</a><br><span class="dim">{s["state"]}</span></td>'
                    f'<td>{html.escape(s["line"])}</td></tr>' for _, _, rid, s in rows) or '<tr><td>no runs</td></tr>'
    return page('routing runs', f'<h1>Routing runs</h1><table>{items}</table><p class="dim">refreshes every {REFRESH_S} s</p>', REFRESH_S)


def run_html(rid, d):
    s = status(d)
    kv = (('state', s['state']), ('stage', s['stage']), ('elapsed', f"{s['elapsed_s']} s" if s['elapsed_s'] is not None else '-'),
          ('open', s['open']), ('best', s['best']), ('vias', s['vias']), ('ETA', f"{s['eta_s']} s" if s['eta_s'] is not None else '-'),
          ('passes', len(s['passes'])))
    table = ''.join(f'<tr><td class="k">{k}</td><td>{html.escape(str("-" if v is None else v))}</td></tr>' for k, v in kv)
    frame = f'<img src="/run/{html.escape(rid)}/frame.png?t={int(time.time())}" alt="board">' if latest_frame(d) else PLACEHOLDER
    tail = html.escape('\n'.join(log_tail(d)) or 'no actions yet')
    body = (f'<h1><a href="/">runs</a> / {html.escape(rid)}</h1><div class="status">{html.escape(s["line"])}</div>'
            f'<h2>Board</h2>{frame}<h2>Status</h2><table>{table}</table><h2>Pass trend</h2>{trend_svg(s["passes"])}'
            f'<h2>Action log (last {TAIL})</h2><pre>{tail}</pre><p class="dim">{html.escape(d)} · refreshes every {REFRESH_S} s</p>')
    return page(rid, body, REFRESH_S)


class Handler(BaseHTTPRequestHandler):
    runs = Runs()
    server_version = 'route_live/1'

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype='text/html; charset=utf-8'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/':
            return self._send(200, index_html(self.runs).encode())
        if path.startswith('/run/'):
            rest = path[5:]
            want_frame = rest.endswith('/frame.png')
            rid = rest[:-len('/frame.png')] if want_frame else rest
            d = self.runs.resolve(rid) if rid and '..' not in rid else None
            if not d:
                return self._send(404, b'no such run', 'text/plain')
            if want_frame:
                f = latest_frame(d)
                if not f:
                    return self._send(404, b'no frame yet', 'text/plain')
                return self._send(200, open(f, 'rb').read(), 'image/png')
            return self._send(200, run_html(rid, d).encode())
        return self._send(404, b'not found', 'text/plain')

    def do_POST(self):
        self._send(405, b'read-only', 'text/plain')

    do_PUT = do_DELETE = do_PATCH = do_POST


def serve(bind=TS_ADDR, port=PORT, extra=()):
    if not allowed_bind(bind):
        raise SystemExit(f'route_live: refusing to bind {bind}: only the Tailscale address ({TS_ADDR}) or 127.0.0.1')
    Handler.runs = Runs(extra)
    srv = ThreadingHTTPServer((bind, port), Handler)
    host = TS_HOST if bind == TS_ADDR else bind
    print(f'route_live: http://{host}:{srv.server_address[1]}/  (bound to {bind} only; GET only; Ctrl-C stops)', flush=True)
    return srv


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('outdirs', nargs='*', help='extra run directories to show')
    ap.add_argument('--serve', action='store_true')
    ap.add_argument('--bind', default=TS_ADDR)
    ap.add_argument('--port', type=int, default=PORT)
    a = ap.parse_args(argv)
    if not a.serve:
        ap.print_help()
        return 2
    srv = serve(a.bind, a.port, a.outdirs)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
