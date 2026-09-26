#!/usr/bin/env python3
"""pcbtool: batch PCB edits from a JSON spec, then one compact DRC summary.

It replaces one-by-one edits. The agent writes the spec (every position, track point, width,
layer and via is still chosen by the agent: hand routing, no auto-router), runs one command,
reads the summary, tweaks the spec and runs again.

Run with the KiCad bundled Python (it has pcbnew):
  PY=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
  $PY tools/pcbtool.py pads   BOARD [REF ...] [--net NET]     pad positions and nets
  $PY tools/pcbtool.py place  BOARD SPEC.json                 set positions, then DRC summary
  $PY tools/pcbtool.py route  BOARD SPEC.json                 add tracks and vias, refill, DRC summary
  $PY tools/pcbtool.py unroute BOARD NET [NET ...]            remove the tracks and vias of nets
  $PY tools/pcbtool.py drc    BOARD                           DRC --schematic-parity summary
  $PY tools/pcbtool.py render BOARD OUTDIR                    top + iso PNG

Place spec:  {"place": {"R1": [x, y, rot]}, "grids": [{"refs": [...], "origin": [x, y],
              "pitch": [dx, dy], "cols": n, "rot": 0}]}
Route spec:  {"clear": ["NET"], "routes": [{"net": "VBAT", "width": 1.5, "layer": "F.Cu",
              "path": [[x, y], [x, y], {"via": [x, y]}, [x, y]]}]}
  A {"via": [x, y]} point adds a via and changes the layer (F.Cu <-> B.Cu).
  Segments must be 0/45/90 degrees unless the route has "any_angle": true.
Coordinates: KiCad mm, Y down.
"""
import argparse
import collections
import json
import math
import os
import re
import subprocess
import sys

KICAD_CLI = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
OTHER = {'F.Cu': 'B.Cu', 'B.Cu': 'F.Cu'}


# ---------------------------------------------------------------- pure core (tested)
def grid_positions(g):
    cols = g.get('cols') or len(g['refs'])
    dx, dy = g['pitch']
    x0, y0 = g['origin']
    rot = g.get('rot', 0)
    out = {}
    for i, ref in enumerate(g['refs']):
        c, r = i % cols, i // cols
        out[ref] = (round(x0 + c * dx, 4), round(y0 + r * dy, 4), rot)
    return out


def placements(spec):
    out = {ref: tuple(v) for ref, v in spec.get('place', {}).items()}
    for g in spec.get('grids', []):
        for ref, v in grid_positions(g).items():
            if ref in out:
                raise ValueError(f'{ref} is placed twice')
            out[ref] = v
    return out


def expand_route(r):
    path = r['path']
    if len(path) < 2:
        raise ValueError(f"{r['net']}: a path needs 2 or more points")
    layer = r['layer']
    segs, vias = [], []
    prev = None
    for p in path:
        if isinstance(p, dict):
            pt = tuple(p['via'])
            if prev is not None and pt != prev:
                segs.append((prev, pt, layer, r['width']))
            vias.append(pt)
            layer = OTHER[layer]
        else:
            pt = tuple(p)
            if prev is not None:
                segs.append((prev, pt, layer, r['width']))
        prev = pt
    for a, b, _, _ in segs:
        dx, dy = b[0] - a[0], b[1] - a[1]
        if abs(dx) < 1e-9 and abs(dy) < 1e-9:
            raise ValueError(f"{r['net']}: zero-length segment at {a}")
        if not r.get('any_angle') and not (abs(dx) < 1e-6 or abs(dy) < 1e-6 or abs(abs(dx) - abs(dy)) < 1e-6):
            raise ValueError(f"{r['net']}: segment {a}->{b} is not 0/45/90 degrees")
    return segs, vias


NET_RE = re.compile(r'\[([^\]]+)\]')


def summarize_drc(d):
    v = d.get('violations', [])
    errs = [x for x in v if x.get('severity') == 'error']
    unrouted = collections.Counter()
    for u in d.get('unconnected_items', []):
        m = NET_RE.search(u['items'][0]['description'])
        unrouted[m.group(1) if m else '?'] += 1
    return {
        'errors': len(errs),
        'warnings': len(v) - len(errs),
        'warning_types': dict(collections.Counter(x['type'] for x in v if x.get('severity') != 'error')),
        'unconnected': len(d.get('unconnected_items', [])),
        'parity': len(d.get('schematic_parity', [])),
        'error_lines': [f"{x['type']}: " + ' | '.join(i['description'] for i in x['items']) for x in errs],
        'unrouted': dict(unrouted),
    }


# ---------------------------------------------------------------- side effects (pcbnew, kicad-cli)
def pcb():
    import pcbnew
    return pcbnew


def v2(x, y):
    p = pcb()
    return p.VECTOR2I(p.FromMM(x), p.FromMM(y))


def run_drc(board, out=None):
    out = out or os.path.join(os.path.dirname(os.path.abspath(board)), '.pcbtool-drc.json')
    subprocess.run([KICAD_CLI, 'pcb', 'drc', '--schematic-parity', '--format', 'json', '-o', out, board],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    with open(out) as f:
        d = json.load(f)
    os.remove(out)
    return summarize_drc(d)


def print_drc(s, limit=25):
    print(f"DRC: {s['errors']} errors, {s['warnings']} warnings {s['warning_types']}, "
          f"{s['unconnected']} unconnected, {s['parity']} parity")
    for line in s['error_lines'][:limit]:
        print('  E ' + line[:200])
    if s['unrouted']:
        print('  unrouted: ' + ', '.join(f'{n} {c}' for n, c in sorted(s['unrouted'].items(), key=lambda t: -t[1])))


def cmd_pads(a):
    p = pcb()
    b = p.LoadBoard(a.board)
    refs = set(a.refs)
    for fp in b.GetFootprints():
        for pad in fp.Pads():
            if not pad.GetNumber():
                continue
            if (refs and fp.GetReference() not in refs) or (a.net and pad.GetNetname() != a.net):
                continue
            q = pad.GetPosition()
            sz = pad.GetSize(p.F_Cu) if pad.IsOnLayer(p.F_Cu) else pad.GetSize(p.B_Cu)
            side = 'THT' if pad.GetAttribute() == p.PAD_ATTRIB_PTH else ('F' if pad.IsOnLayer(p.F_Cu) else 'B')
            print(f'{fp.GetReference()}.{pad.GetNumber()} {pad.GetNetname()} ({p.ToMM(q.x):.3f}, {p.ToMM(q.y):.3f}) '
                  f'{p.ToMM(sz.x):.2f}x{p.ToMM(sz.y):.2f} {side} rot {fp.GetOrientationDegrees():g}')


def cmd_place(a):
    p = pcb()
    spec = json.load(open(a.spec))
    pl = placements(spec)
    b = p.LoadBoard(a.board)
    missing = [r for r in pl if b.FindFootprintByReference(r) is None]
    if missing:
        sys.exit(f'not on the board: {missing}')
    for ref, (x, y, rot) in pl.items():
        fp = b.FindFootprintByReference(ref)
        fp.SetOrientationDegrees(rot)
        fp.SetPosition(v2(x, y))
    p.ZONE_FILLER(b).Fill(b.Zones())
    b.Save(a.board)
    print(f'placed {len(pl)} parts')
    print_drc(run_drc(a.board))


def delete_nets(b, nets):
    n = 0
    for t in list(b.GetTracks()):
        if t.GetNetname() in nets:
            b.Delete(t)
            n += 1
    return n


def cmd_unroute(a):
    p = pcb()
    b = p.LoadBoard(a.board)
    n = delete_nets(b, set(a.nets))
    p.ZONE_FILLER(b).Fill(b.Zones())
    b.Save(a.board)
    print(f'removed {n} track items')
    print_drc(run_drc(a.board))


def cmd_route(a):
    p = pcb()
    spec = json.load(open(a.spec))
    plan = [(r, *expand_route(r)) for r in spec['routes']]  # validate all before any change
    b = p.LoadBoard(a.board)
    removed = delete_nets(b, set(spec.get('clear', [])))
    via_d = spec.get('via', {'size': 0.6, 'drill': 0.3})
    nseg = nvia = 0
    for r, segs, vias in plan:
        net = b.FindNet(r['net'])
        if net is None:
            sys.exit(f"no net {r['net']} on the board")
        for (x0, y0), (x1, y1), layer, w in segs:
            t = p.PCB_TRACK(b)
            t.SetStart(v2(x0, y0))
            t.SetEnd(v2(x1, y1))
            t.SetLayer(b.GetLayerID(layer))
            t.SetWidth(p.FromMM(w))
            t.SetNet(net)
            b.Add(t)
            nseg += 1
        for x, y in vias:
            v = p.PCB_VIA(b)
            v.SetPosition(v2(x, y))
            v.SetWidth(p.FromMM(r.get('via_size', via_d['size'])))
            v.SetDrill(p.FromMM(r.get('via_drill', via_d['drill'])))
            v.SetNet(net)
            b.Add(v)
            nvia += 1
    # endpoint check: each route end must land on a pad of the same net (or on its own via)
    pads = [pd for fp in b.GetFootprints() for pd in fp.Pads() if pd.GetNumber()]
    for r, segs, vias in plan:
        for end in (r['path'][0], r['path'][-1]):
            if isinstance(end, dict):
                continue
            q = v2(*end)
            if not any(pd.GetNetname() == r['net'] and pd.HitTest(q) for pd in pads):
                others = [t for t in b.GetTracks() if t.GetNetname() == r['net'] and t.HitTest(q)]
                if len(others) < 2:
                    print(f"  W {r['net']}: end {end} is not on a pad of the net")
    p.ZONE_FILLER(b).Fill(b.Zones())
    b.Save(a.board)
    print(f'removed {removed}, added {nseg} segments and {nvia} vias')
    print_drc(run_drc(a.board))


def cmd_drc(a):
    print_drc(run_drc(a.board), limit=60)


def cmd_render(a):
    os.makedirs(a.outdir, exist_ok=True)
    base = os.path.join(a.outdir, os.path.splitext(os.path.basename(a.board))[0])
    jobs = [['--side', 'top', '--width', '1600', '--height', '2000', '-o', base + '-top.png'],
            ['--width', '1800', '--height', '1400', '--rotate', '-40,0,30', '--zoom', '0.9', '-o', base + '-iso.png']]
    for j in jobs:
        subprocess.run([KICAD_CLI, 'pcb', 'render', '--quality', 'high', *j, a.board],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        print(j[-1])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest='cmd', required=True)
    s = sp.add_parser('pads'); s.add_argument('board'); s.add_argument('refs', nargs='*'); s.add_argument('--net')
    s.set_defaults(f=cmd_pads)
    for name, f in (('place', cmd_place), ('route', cmd_route)):
        s = sp.add_parser(name); s.add_argument('board'); s.add_argument('spec'); s.set_defaults(f=f)
    s = sp.add_parser('unroute'); s.add_argument('board'); s.add_argument('nets', nargs='+'); s.set_defaults(f=cmd_unroute)
    s = sp.add_parser('drc'); s.add_argument('board'); s.set_defaults(f=cmd_drc)
    s = sp.add_parser('render'); s.add_argument('board'); s.add_argument('outdir'); s.set_defaults(f=cmd_render)
    a = ap.parse_args()
    a.f(a)


if __name__ == '__main__':
    main()
