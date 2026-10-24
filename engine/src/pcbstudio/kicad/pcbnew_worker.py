"""KiCad's own pcbnew, isolated in a subprocess of KiCad's bundled Python.

Headless pcbnew can crash or assert. It never runs inside the engine: `PcbnewWorker` starts
`<kicad python> pcbnew_worker.py --serve` and talks one JSON object per line.

Request  {"id": n, "op": "...", ...params}
Reply    {"id": n, "ok": true, "result": ...} | {"id": n, "ok": false, "error": "..."}

Ops: ping, load {path} -> {board}, query {board, what}, move_footprint {board, ref, x, y, rot?},
save {board, path?}, close {board}, crash {how} (tests only). A crash, an exit or a timeout of the
subprocess raises `WorkerError` in the caller; the next call starts a fresh worker.

This file is also the server: it must run on KiCad's Python (3.9), so it uses no newer syntax at run
time and imports nothing from pcbstudio.
"""
from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import sys
import threading
from pathlib import Path

_MAC_PY = '/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3'


class WorkerError(RuntimeError):
    """The worker died, timed out or answered with an error."""


def find_kicad_python() -> str | None:
    """PCBSTUDIO_KICAD_PYTHON, then the macOS KiCad app, then a `python3` on PATH that can import pcbnew."""
    env = os.environ.get('PCBSTUDIO_KICAD_PYTHON')
    if env:
        return env if Path(env).is_file() else None
    if Path(_MAC_PY).is_file():
        return _MAC_PY
    for name in ('python3',):
        exe = shutil.which(name)
        if exe:
            try:
                r = subprocess.run([exe, '-c', 'import pcbnew'], capture_output=True, timeout=30)
                if r.returncode == 0:
                    return exe
            except (OSError, subprocess.TimeoutExpired):
                pass
    return None


class PcbnewWorker:
    """Client. Thread safe (one request at a time). Use as a context manager or call close()."""

    def __init__(self, python: str | None = None, timeout_s: float = 300.0):
        self.python = python or find_kicad_python()
        if not self.python:
            raise WorkerError('KiCad Python with pcbnew not found (set PCBSTUDIO_KICAD_PYTHON)')
        self.timeout_s = timeout_s
        self._proc: subprocess.Popen | None = None
        self._lines: queue.Queue = queue.Queue()
        self._stderr: list[str] = []
        self._lock = threading.Lock()
        self._next = 0

    # ---------------------------------------------------------------- process
    def _start(self) -> None:
        self._lines = queue.Queue()
        self._stderr = []
        self._proc = subprocess.Popen([self.python, '-I', str(Path(__file__).resolve()), '--serve'],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      text=True, encoding='utf-8', bufsize=1)
        proc, lines, err = self._proc, self._lines, self._stderr

        def pump_out():
            for ln in proc.stdout:
                lines.put(ln)
            lines.put(None)

        def pump_err():
            for ln in proc.stderr:
                if 'Adding duplicate image handler' in ln:
                    continue
                err.append(ln.rstrip('\n'))
                del err[:-200]
        threading.Thread(target=pump_out, daemon=True).start()
        threading.Thread(target=pump_err, daemon=True).start()

    def _fail(self, msg: str) -> WorkerError:
        proc = self._proc
        self._proc = None
        code = None
        if proc is not None:
            if proc.poll() is None:
                proc.kill()
            try:
                code = proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
        tail = '\n'.join(self._stderr[-15:])
        return WorkerError(f'pcbnew worker {msg} (exit {code})' + (f':\n{tail}' if tail else ''))

    def call(self, op: str, timeout_s: float | None = None, **params):
        with self._lock:
            if self._proc is None or self._proc.poll() is not None:
                self._start()
            assert self._proc is not None and self._proc.stdin is not None
            self._next += 1
            rid = self._next
            try:
                self._proc.stdin.write(json.dumps({'id': rid, 'op': op, **params}) + '\n')
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError):
                raise self._fail('stopped before the request') from None
            while True:
                try:
                    ln = self._lines.get(timeout=timeout_s or self.timeout_s)
                except queue.Empty:
                    raise self._fail(f'timed out on {op!r}') from None
                if ln is None:
                    raise self._fail(f'stopped during {op!r}')
                try:
                    msg = json.loads(ln)
                except ValueError:
                    continue                       # not protocol (should not happen: fd 1 goes to stderr)
                if msg.get('id') == rid:
                    break
            if not msg.get('ok'):
                raise WorkerError(f'{op}: {msg.get("error")}')
            return msg.get('result')

    def close(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            proc.stdin.close()
            proc.wait(timeout=10)
        except Exception:
            proc.kill()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


# =================================================================== server (KiCad Python)
def _serve() -> None:
    proto = os.fdopen(os.dup(1), 'w', encoding='utf-8', buffering=1)
    os.dup2(2, 1)                                  # stray prints from pcbnew/wx go to stderr, not the protocol
    sys.stdout = sys.stderr
    import wx                                     # noqa: F401  (pcbnew needs an app object headless)
    app = wx.App(False)                            # noqa: F841
    import pcbnew

    boards = {}
    mm = pcbnew.ToMM

    def names(cls_prefix):
        return {getattr(pcbnew, k): k[len(cls_prefix):].lower() for k in dir(pcbnew) if k.startswith(cls_prefix)}
    pad_shapes = names('PAD_SHAPE_')
    pad_shapes[1] = 'rect'
    attrs = names('PAD_ATTRIB_')

    def board(p):
        b = boards.get(p.get('board'))
        if b is None:
            raise ValueError('unknown board %r' % p.get('board'))
        return b

    def poly_counts(ps):
        return [{'points': ps.Outline(i).PointCount(), 'holes': ps.HoleCount(i)} for i in range(ps.OutlineCount())]

    def q_pads(b):
        out = []
        for fp in b.GetFootprints():
            for pad in fp.Pads():
                pos, size = pad.GetPosition(), pad.GetSize(pcbnew.F_Cu)
                drill = pad.GetDrillSize()
                bb = pad.GetBoundingBox()
                out.append({'ref': fp.GetReference(), 'num': pad.GetNumber(),
                            'x': mm(pos.x), 'y': mm(pos.y), 'rot': pad.GetOrientationDegrees(),
                            'w': mm(size.x), 'h': mm(size.y),
                            'shape': pad_shapes.get(pad.GetShape(pcbnew.F_Cu), str(pad.GetShape(pcbnew.F_Cu))),
                            'type': attrs.get(pad.GetAttribute(), str(pad.GetAttribute())),
                            'drill': [mm(drill.x), mm(drill.y)] if pad.HasHole() else None,
                            'drill_shape': 'oval' if pad.GetDrillShape() == pcbnew.PAD_DRILL_SHAPE_OBLONG else 'circle',
                            'primitives': len(pad.GetPrimitives(pcbnew.F_Cu)),
                            'bbox': [mm(bb.GetX()), mm(bb.GetY()), mm(bb.GetRight()), mm(bb.GetBottom())]})
        return out

    def q_zones(b):
        out = []
        for z in b.Zones():
            filled = {}
            for layer in z.GetLayerSet().Seq():
                if z.HasFilledPolysForLayer(layer):
                    filled[b.GetLayerName(layer)] = z.GetFilledPolysList(layer).OutlineCount()
            item = {'name': z.GetZoneName(), 'net': z.GetNetname(), 'rule_area': bool(z.GetIsRuleArea()),
                    'layers': [b.GetLayerName(l) for l in z.GetLayerSet().Seq()],
                    'outline': poly_counts(z.Outline()), 'filled': filled}
            if z.GetIsRuleArea():
                item['keepout'] = {'tracks': not z.GetDoNotAllowTracks(), 'vias': not z.GetDoNotAllowVias(),
                                   'pads': not z.GetDoNotAllowPads(), 'copperpour': not z.GetDoNotAllowZoneFills(),
                                   'footprints': not z.GetDoNotAllowFootprints()}
            out.append(item)
        return out

    def q_outline(b):
        ps = pcbnew.SHAPE_POLY_SET()
        ok = b.GetBoardPolygonOutlines(ps, False)
        return {'ok': bool(ok), 'outlines': poly_counts(ps)}

    def q_counts(b):
        t = b.GetTracks()
        return {'footprints': len(b.GetFootprints()), 'zones': len(b.Zones()),
                'segments': sum(1 for x in t if x.GetClass() == 'PCB_TRACK'),
                'arcs': sum(1 for x in t if x.GetClass() == 'PCB_ARC'),
                'vias': sum(1 for x in t if x.GetClass() == 'PCB_VIA'),
                'pads': sum(len(fp.Pads()) for fp in b.GetFootprints())}

    queries = {'pads': q_pads, 'zones': q_zones, 'outline': q_outline, 'counts': q_counts}

    def handle(req):
        op = req.get('op')
        if op == 'ping':
            return {'pcbnew': pcbnew.Version(), 'python': sys.version.split()[0]}
        if op == 'load':
            b = pcbnew.LoadBoard(req['path'])
            if b is None:
                raise ValueError('LoadBoard returned nothing for %s' % req['path'])
            key = 'b%d' % (len(boards) + 1)
            boards[key] = b
            return {'board': key}
        if op == 'query':
            what = req.get('what', 'counts')
            if what not in queries:
                raise ValueError('unknown query %r (%s)' % (what, ', '.join(sorted(queries))))
            return queries[what](board(req))
        if op == 'move_footprint':
            b = board(req)
            fp = next((f for f in b.GetFootprints() if f.GetReference() == req['ref']), None)
            if fp is None:
                raise ValueError('no footprint %r' % req['ref'])
            fp.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(req['x']), pcbnew.FromMM(req['y'])))
            if req.get('rot') is not None:
                fp.SetOrientationDegrees(float(req['rot']))
            return {'ref': req['ref']}
        if op == 'save':
            b = board(req)
            path = req.get('path') or b.GetFileName()
            pcbnew.SaveBoard(path, b)
            return {'path': path}
        if op == 'close':
            boards.pop(req.get('board'), None)
            return {}
        if op == 'crash':
            if req.get('how') == 'exit':
                os._exit(3)
            os.abort()
        raise ValueError('unknown op %r' % op)

    for line in sys.stdin:
        if not line.strip():
            continue
        req = {}
        try:
            req = json.loads(line)
            reply = {'id': req.get('id'), 'ok': True, 'result': handle(req)}
        except Exception as e:                    # an op error is a reply, not a crash
            reply = {'id': req.get('id'), 'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}
        proto.write(json.dumps(reply) + '\n')
        proto.flush()


if __name__ == '__main__' and '--serve' in sys.argv:
    _serve()
