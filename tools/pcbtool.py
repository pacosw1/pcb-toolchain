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
  $PY tools/pcbtool.py widen  BOARD NET W [--layer L] [--box X0 Y0 X1 Y1]  widen the net's thinner tracks, DRC
  $PY tools/pcbtool.py near   BOARD X Y [--r 0.3] [--within 1]  copper of all nets near a point, edge gap
  $PY tools/pcbtool.py drc    BOARD                           DRC --schematic-parity summary
  $PY tools/pcbtool.py widths BOARD [--limit N]              tracks thinner than the net class width (current)
  $PY tools/pcbtool.py paths  BOARD SPEC.json [--verbose]     widest copper path between power pads >= design current
  $PY tools/pcbtool.py render BOARD OUTDIR                    top + iso PNG
  $PY tools/pcbtool.py art    BOARD SPEC.json                 silkscreen art group (waves, circles, lines, texts)
  $PY tools/pcbtool.py colors BOARD OUTDIR [VARIANT ...]      JLC colour variant renders (board unchanged)
  $PY tools/pcbtool.py setcolors BOARD MASK SILK FINISH       write the stackup colours
  $PY tools/pcbtool.py snapshot BOARD OUT.json [--checker CMD]  before/after state
  $PY tools/pcbtool.py compare BEFORE.json AFTER.json         exit 1 on a regression

Place spec:  {"place": {"R1": [x, y, rot]}, "grids": [{"refs": [...], "origin": [x, y],
              "pitch": [dx, dy], "cols": n, "rot": 0}]}
Route spec:  {"clear": ["NET"], "routes": [{"net": "VBAT", "width": 1.5, "layer": "F.Cu",
              "path": [[x, y], [x, y], {"via": [x, y]}, [x, y]]}],
              "move_vias": [{"net": "GND", "from": [x, y], "to": [x, y]}]}
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


JLC_MASK = ('Green', 'Red', 'Yellow', 'Blue', 'White', 'Black', 'Purple')
JLC_SILK = ('White', 'Black')
JLC_FINISH = ('HAL lead-free', 'ENIG')
LAYER_RE = re.compile(r'^\s*\(layer "([^"]+)"')


# KiCad draws the named 'Black' mask semi-transparent (brown over FR4). For renders only, a near-opaque hex.
RENDER_COLOR = {'Black': '#0E0E10F5'}


def apply_colors(text, mask, silk, finish, render=False):
    """Set the stackup colours (KiCad render and fab notes). Only colours JLC makes."""
    if mask not in JLC_MASK or silk not in JLC_SILK or finish not in JLC_FINISH:
        raise ValueError(f'not a JLC option: mask {mask}, silk {silk}, finish {finish}')
    shown = RENDER_COLOR.get(mask, mask) if render else mask
    want = {'F.Mask': shown, 'B.Mask': shown, 'F.SilkS': silk, 'B.SilkS': silk}
    out, cur, inside = [], None, False
    for line in text.split('\n'):
        if line.strip().startswith('(stackup'):
            inside = True
        elif inside and line.strip().startswith('(copper_finish'):
            inside = False
        m = LAYER_RE.match(line)
        if m:
            cur = m.group(1)
        if not inside:
            cur = None
        if cur in want and line.strip().startswith('(color '):
            continue
        out.append(line)
        if cur in want and line.strip().startswith('(type '):
            indent = line[:len(line) - len(line.lstrip())]
            out.append(f'{indent}(color "{want[cur]}")')
    return re.sub(r'\(copper_finish "[^"]*"\)', f'(copper_finish "{finish}")', '\n'.join(out))


def width_report(segs, need, pads, neck_max=2.0):
    """Track segments narrower than the net class width (the current rule). A short neck (<= neck_max mm)
    is allowed only where it ends on a same-net pad that is itself narrower than the class width, and the
    neck is not narrower than that pad."""
    out = {}
    for sg in segs:
        w_need = need.get(sg['net'])
        if w_need is None:
            continue
        r = out.setdefault(sg['net'], {'need': w_need, 'min': sg['width'], 'necks': 0, 'under': []})
        r['min'] = min(r['min'], sg['width'])
        if sg['width'] >= w_need - 1e-6:
            continue
        length = round(math.dist(sg['start'], sg['end']), 3)
        neck = length <= neck_max and any(
            pd['net'] == sg['net'] and pd['minor'] < w_need and sg['width'] >= pd['minor'] - 1e-6
            and any(math.dist(pd['pos'], e) < 0.01 for e in (sg['start'], sg['end'])) for pd in pads)
        if neck:
            r['necks'] += 1
        else:
            r['under'].append((sg['width'], length, sg['start']))
    return out


def ipc_amps(width_mm, thick_mm=0.035, dT=10.0, inner=False):
    """IPC-2221 conductor current: I = k dT^0.44 A^0.725, A in mil^2; k 0.048 external, 0.024 inner."""
    area = (width_mm / 0.0254) * (thick_mm / 0.0254)
    return (0.024 if inner else 0.048) * dT ** 0.44 * area ** 0.725


def via_amps(drill_mm, plating_mm=0.018, dT=10.0):
    """Via barrel as an external IPC-2221 conductor of width pi x drill (JLC plating >= 18 um)."""
    return ipc_amps(math.pi * drill_mm, plating_mm, dT)


def project(a, c, q):
    """Point of segment a-c nearest to q (clamped to the segment), rounded to 1 um."""
    dx, dy = c[0] - a[0], c[1] - a[1]
    t = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / ((dx * dx + dy * dy) or 1)
    t = min(1.0, max(0.0, t))
    return (round(a[0] + t * dx, 3), round(a[1] + t * dy, 3))


NECK_MAX_MM = 1.0
THERMAL_SPOKES = 2


def is_neck(length, width, pad_minor, max_len=NECK_MAX_MM):
    """A short track into a pad, at least as wide as the pad: the pad (the part) is the limit, not the track."""
    return length <= max_len + 1e-6 and width >= pad_minor - 1e-3


def spec_pairs(spec, parallel=False):
    """(net, pad, pad, amps) for each consecutive pad pair. A net has 'amps' + 'pads', or 'chains' of them.
    parallel=True adds the 'parallel' flag of the chain (or of the net) as a fifth item."""
    out = []
    for net, n in spec['nets'].items():
        for ch in n.get('chains', [n]):
            flag = (bool(ch.get('parallel', n.get('parallel', False))),) if parallel else ()
            out += [(net, u, v, ch['amps'], *flag) for u, v in zip(ch['pads'], ch['pads'][1:])]
    return out


def select_tracks(tracks, net, width, layer=None, box=None):
    """Indexes of the net's tracks narrower than width, on layer (if given), with both ends in box (if given)."""
    def inside(q):
        return box[0] <= q[0] <= box[2] and box[1] <= q[1] <= box[3]
    return [i for i, t in enumerate(tracks) if t['net'] == net and t['width'] < width - 1e-6
            and (layer is None or t['layer'] == layer) and (box is None or (inside(t['start']) and inside(t['end'])))]


def find_point(points, q, tol=0.01):
    """Index of the one point within tol mm of q. None or several is an error."""
    hit = [i for i, pt_ in enumerate(points) if math.dist(pt_, q) <= tol]
    if len(hit) != 1:
        raise ValueError(f'{len(hit)} points within {tol} mm of {q}')
    return hit[0]


def copper_gap(c, r, a, b, w):
    """Edge-to-edge gap (mm) from a circle (centre c, radius r) to a track a-b of width w. Negative = overlap."""
    return round(math.dist(c, project(a, b, c)) - r - w / 2, 4)


def widest_path(edges, a, b):
    """Path from a to b with the highest bottleneck current. edges: (u, v, amps, label), undirected.
    Returns (amps, labels). Parallel paths do not add (conservative)."""
    import heapq
    adj = {}
    for u, v, amps, label in edges:
        adj.setdefault(u, []).append((v, amps, label))
        adj.setdefault(v, []).append((u, amps, label))
    best = {a: float('inf')}
    prev = {}
    heap = [(-float('inf'), 0, a)]
    k = 0
    while heap:
        neg, _, u = heapq.heappop(heap)
        if -neg < best.get(u, -1):
            continue
        if u == b:
            path = []
            while u != a:
                u, label = prev[u]
                path.append(label)
            return -neg, path[::-1]
        for v, amps, label in adj.get(u, []):
            c = min(-neg, amps)
            if c > best.get(v, -1):
                best[v] = c
                prev[v] = (u, label)
                k += 1
                heapq.heappush(heap, (-c, k, v))
    return 0.0, []


def max_flow(edges, a, b):
    """Max current from a to b with parallel paths added (Edmonds-Karp). edges: (u, v, amps, label), undirected.
    Returns (amps, labels of the min cut). A path of only unlimited edges gives (inf, [])."""
    adj, cap = {}, {}
    for u, v, amps, _ in edges:
        adj.setdefault(u, set()).add(v)
        adj.setdefault(v, set()).add(u)
    if a not in adj or b not in adj:
        return 0.0, []
    unlimited = {frozenset((u, v)) for u, v, amps, _ in edges if amps == float('inf')}
    if b in reach(adj, a, lambda u, v: frozenset((u, v)) in unlimited):
        return float('inf'), []
    big = sum(e[2] for e in edges if e[2] != float('inf')) + 1.0
    for u, v, amps, _ in edges:
        c = big if amps == float('inf') else amps
        cap[u, v] = cap.get((u, v), 0.0) + c
        cap[v, u] = cap.get((v, u), 0.0) + c
    total = 0.0
    while True:
        prev, queue = {a: None}, collections.deque([a])
        while queue and b not in prev:
            u = queue.popleft()
            for v in adj[u]:
                if v not in prev and cap[u, v] > 1e-12:
                    prev[v] = u
                    queue.append(v)
        if b not in prev:
            break
        path, v = [], b
        while prev[v] is not None:
            path.append((prev[v], v))
            v = prev[v]
        push = min(cap[e] for e in path)
        for u, v in path:
            cap[u, v] -= push
            cap[v, u] += push
        total += push
    side = reach(adj, a, lambda u, v: cap[u, v] > 1e-12)
    cut = sorted({e[3] for e in edges if (e[0] in side) != (e[1] in side)})
    return round(total, 9), cut


def reach(adj, a, ok):
    """Nodes reachable from a over the arcs u->v where ok(u, v)."""
    seen, stack = {a}, [a]
    while stack:
        u = stack.pop()
        for v in adj.get(u, ()):
            if v not in seen and ok(u, v):
                seen.add(v)
                stack.append(v)
    return seen


def pair_capacity(edges, a, b, parallel=False):
    """(amps, items): max flow and min cut when parallel, else the widest single path and its items."""
    return max_flow(edges, a, b) if parallel else widest_path(edges, a, b)


def compare(a, b):
    """Before/after harness: regressions (worse), progress (better), part changes."""
    reg, prog = [], []
    for key, label in (('errors', 'DRC errors'), ('parity', 'parity'), ('unconnected', 'unconnected')):
        x, y = a['drc'][key], b['drc'][key]
        if y > x:
            reg.append(f'{label} {x} -> {y}')
        elif y < x:
            prog.append(f'{label} {x} -> {y}')
    if a.get('checker') and b.get('checker'):
        (p0, n0), (p1, n1) = a['checker'], b['checker']
        if p1 < p0:
            reg.append(f'checker {p0}/{n0} -> {p1}/{n1}')
        elif p1 > p0:
            prog.append(f'checker {p0}/{n0} -> {p1}/{n1}')
    fmt = lambda v: '(' + ', '.join(str(i) for i in v) + ')'
    pa, pb = a['parts'], b['parts']
    moved = [f'{r} {fmt(pa[r])} -> {fmt(pb[r])}' for r in sorted(pa) if r in pb and list(pa[r]) != list(pb[r])]
    return {'regressions': reg, 'progress': prog, 'moved': moved,
            'added': sorted(set(pb) - set(pa)), 'removed': sorted(set(pa) - set(pb)),
            'tracks': (a.get('tracks'), b.get('tracks')), 'vias': (a.get('vias'), b.get('vias'))}


def seigaiha(box, r, rings=3, step_deg=4):
    """Japanese wave pattern (seigaiha) as visible arc spans ((cx, cy), radius, a0, a1), degrees.

    Scales of radius r, 2r apart, rows r/2 apart, odd rows shifted by r. A lower row is in
    front. Only upper halves are drawn (Y down: angles 180-360). Every scale fits in the box.
    """
    x0, y0, x1, y1 = box
    centres = []
    j = 0
    while y0 + r + j * r / 2 <= y1:
        cy = y0 + r + j * r / 2
        cx = x0 + r + (r if j % 2 else 0)
        while cx + r <= x1 + 1e-9:
            centres.append((cx, cy))
            cx += 2 * r
        j += 1
    arcs = []
    for c in centres:
        front = [f for f in centres if f[1] > c[1] + 1e-9 and abs(f[0] - c[0]) < 2 * r and f[1] - c[1] < 2 * r]
        for k in range(1, rings + 1):
            rad = r * k / rings
            span = None
            a = 180
            while a < 360:
                m = math.radians(a + step_deg / 2)
                px, py = c[0] + rad * math.cos(m), c[1] + rad * math.sin(m)
                hidden = any(math.hypot(px - f[0], py - f[1]) < r - 1e-6 for f in front)
                if not hidden:
                    span = (span[0], a + step_deg) if span else (a, a + step_deg)
                elif span:
                    arcs.append((c, rad, span[0], span[1]))
                    span = None
                a += step_deg
            if span:
                arcs.append((c, rad, span[0], span[1]))
    return arcs


# ---------------------------------------------------------------- side effects (pcbnew, kicad-cli)
NOISE = ('Fontconfig warning:', 'create wxApp before calling this', 'Adding duplicate image handler')


def drop_noise(text):
    return ''.join(l for l in text.splitlines(keepends=True) if not any(n in l for n in NOISE))


def pcb():
    # pcbnew writes a wx assert and many Fontconfig lines to fd 2 (C code). Catch fd 2 in a file and at exit
    # pass on only the other lines, so a real error still shows.
    if 'pcbnew' not in sys.modules:
        import atexit
        import tempfile
        cap = tempfile.TemporaryFile(mode='w+b')
        real = os.dup(2)
        os.dup2(cap.fileno(), 2)

        def restore():
            sys.stderr.flush()
            os.dup2(real, 2)
            cap.seek(0)
            sys.stderr.write(drop_noise(cap.read().decode(errors='replace')))
        atexit.register(restore)
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


def hole_in_pad(hole, pad):
    """True when a via hole (x, y, r) touches a pad (cx, cy, w, h, angle_deg, corner_r). All in mm."""
    x, y, r = hole
    cx, cy, w, h, ang, cr = pad
    t = math.radians(ang)
    dx, dy = x - cx, y - cy
    u, v = dx * math.cos(t) + dy * math.sin(t), -dx * math.sin(t) + dy * math.cos(t)
    cr = min(cr, w / 2, h / 2)
    qx, qy = max(abs(u) - (w / 2 - cr), 0), max(abs(v) - (h / 2 - cr), 0)
    return math.hypot(qx, qy) - cr < r


def drop_allowed(hits, allow):
    """Remove hits on allowed pads (REF.PAD). An allow entry that matches no hit is an error (stale)."""
    stale = [x for x in allow if not any(h.split()[0] == x for h in hits)]
    if stale:
        raise ValueError('allowed pad has no via in it: ' + ', '.join(stale))
    return [h for h in hits if h.split()[0] not in allow]


def cmd_viapads(a):
    """Via holes inside SMD pads (via-in-pad). Exit 1 when any is found: solder flows into an open via."""
    p = pcb()
    b = p.LoadBoard(a.board)
    if b is None:
        sys.exit(f'cannot load {a.board}')
    mm = p.ToMM
    hits = []
    for v in (t for t in b.GetTracks() if isinstance(t, p.PCB_VIA)):
        hole = (mm(v.GetPosition().x), mm(v.GetPosition().y), mm(v.GetDrillValue()) / 2)
        for fp in b.GetFootprints():
            for pd in fp.Pads():
                if pd.GetAttribute() != p.PAD_ATTRIB_SMD or not pd.GetNumber():   # no number: a paste/mask opening
                    continue
                lay = p.F_Cu if pd.IsOnLayer(p.F_Cu) else p.B_Cu
                sh = pd.GetShape(lay)
                size = pd.GetSize(lay)
                w, h = mm(size.x), mm(size.y)
                if sh in (p.PAD_SHAPE_RECT, p.PAD_SHAPE_ROUNDRECT, p.PAD_SHAPE_OVAL, p.PAD_SHAPE_CIRCLE):
                    cr = {p.PAD_SHAPE_RECT: 0, p.PAD_SHAPE_ROUNDRECT: pd.GetRoundRectCornerRadius(lay) and mm(pd.GetRoundRectCornerRadius(lay))}.get(sh, min(w, h) / 2)
                    c = pd.GetPosition()
                    hit = hole_in_pad(hole, (mm(c.x), mm(c.y), w, h, -pd.GetOrientation().AsDegrees(), cr))
                else:   # custom or trapezoid pad: use the KiCad shape
                    hit = pd.GetEffectiveShape(lay).Collide(p.SHAPE_CIRCLE(v.GetPosition(), v.GetDrillValue() // 2))
                if hit:
                    hits.append(f'{fp.GetReference()}.{pd.GetNumber()} {pd.GetNetname()} via at ({hole[0]:.3f}, {hole[1]:.3f})')
    try:
        hits = drop_allowed(hits, a.allow)
    except ValueError as e:
        print(f'FAIL {e}')
        sys.exit(2)
    for line in sorted(hits):
        print('FAIL via in pad', line)
    print(f'{len(hits)} vias in SMD pads')
    sys.exit(1 if hits else 0)


def cmd_near(a):
    """Copper of every net near a point: tracks, vias and pads per layer, with the edge gap to a circle of radius r."""
    p = pcb()
    b = p.LoadBoard(a.board)
    if b is None:
        sys.exit(f'cannot load {a.board}')
    mm = p.ToMM
    c = (a.x, a.y)
    rows = []
    for t in b.GetTracks():
        if isinstance(t, p.PCB_VIA):
            q = (mm(t.GetPosition().x), mm(t.GetPosition().y))
            rows.append((round(math.dist(c, q) - a.r - mm(t.GetWidth(p.F_Cu)) / 2, 3), 'via', t.GetNetname(), f'at ({q[0]:.3f}, {q[1]:.3f})'))
        else:
            s_, e_ = (mm(t.GetStart().x), mm(t.GetStart().y)), (mm(t.GetEnd().x), mm(t.GetEnd().y))
            rows.append((copper_gap(c, a.r, s_, e_, mm(t.GetWidth())), t.GetLayerName(), t.GetNetname(),
                         f'{mm(t.GetWidth()):.2f} mm ({s_[0]:.3f}, {s_[1]:.3f})-({e_[0]:.3f}, {e_[1]:.3f})'))
    for fp in b.GetFootprints():
        for pd in fp.Pads():
            q = (mm(pd.GetPosition().x), mm(pd.GetPosition().y))
            size = pd.GetSize(p.F_Cu)
            side = 'pad THT' if pd.GetAttribute() in (p.PAD_ATTRIB_PTH, p.PAD_ATTRIB_NPTH) else ('pad B' if pd.IsOnLayer(p.B_Cu) else 'pad F')
            rows.append((round(math.dist(c, q) - a.r - mm(max(size.x, size.y)) / 2, 3), side, pd.GetNetname(),
                         f'{fp.GetReference()}.{pd.GetNumber()} at ({q[0]:.3f}, {q[1]:.3f}) (gap to the long side, low bound)'))
    for gap, layer, net, what in sorted(r for r in rows if r[0] < a.within):
        print(f'{gap:7.3f}  {layer:7} {net:14} {what}')


def cmd_widen(a):
    p = pcb()
    b = p.LoadBoard(a.board)
    if b is None:
        sys.exit(f'cannot load {a.board}')
    mm = p.ToMM
    items = [t for t in b.GetTracks() if not isinstance(t, p.PCB_VIA)]
    rows = [{'net': t.GetNetname(), 'layer': t.GetLayerName(), 'width': round(mm(t.GetWidth()), 4),
             'start': (mm(t.GetStart().x), mm(t.GetStart().y)), 'end': (mm(t.GetEnd().x), mm(t.GetEnd().y))} for t in items]
    pick = select_tracks(rows, a.net, a.width, a.layer, tuple(a.box) if a.box else None)
    if not pick:
        sys.exit(f'no {a.net} track narrower than {a.width} mm matches')
    for i in pick:
        items[i].SetWidth(p.FromMM(a.width))
    p.ZONE_FILLER(b).Fill(b.Zones())
    b.Save(a.board)
    print(f'widened {len(pick)} {a.net} segments to {a.width} mm')
    print_drc(run_drc(a.board))


def cmd_unroute(a):
    p = pcb()
    b = p.LoadBoard(a.board)
    n = delete_nets(b, set(a.nets))
    p.ZONE_FILLER(b).Fill(b.Zones())
    b.Save(a.board)
    print(f'removed {n} track items')
    print_drc(run_drc(a.board))


def remove_temp_project(tmp):
    """Save and LoadBoard make a .kicad_pro/.kicad_prl for the temporary board. Remove them."""
    for ext in ('.kicad_pro', '.kicad_prl'):
        if os.path.exists(tmp[:-len('.kicad_pcb')] + ext):
            os.remove(tmp[:-len('.kicad_pcb')] + ext)


def cmd_route(a):
    p = pcb()
    spec = json.load(open(a.spec))
    plan = [(r, *expand_route(r)) for r in spec['routes']]  # validate all before any change
    b = p.LoadBoard(a.board)
    moves = []  # validate all via moves before any change
    for m in spec.get('move_vias', []):
        vias_ = [t for t in b.GetTracks() if isinstance(t, p.PCB_VIA) and t.GetNetname() == m['net']]
        try:
            i = find_point([(p.ToMM(t.GetPosition().x), p.ToMM(t.GetPosition().y)) for t in vias_], tuple(m['from']))
        except ValueError as e:
            sys.exit(f"move_vias {m['net']} {m['from']}: {e}")
        moves.append((vias_[i], m['to']))
    removed = delete_nets(b, set(spec.get('clear', [])))
    for v, to in moves:
        v.SetPosition(v2(*to))
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
    # KiCad gives a via the net of the copper it touches, and it shows only in the saved file.
    # Save to a temporary file, reload, check the moved vias, then replace the board.
    tmp = os.path.join(os.path.dirname(os.path.abspath(a.board)), '.pcbtool-route.kicad_pcb')
    b.Save(tmp)
    if moves:
        c = p.LoadBoard(tmp)
        got = {(round(p.ToMM(t.GetPosition().x), 3), round(p.ToMM(t.GetPosition().y), 3)): t.GetNetname()
               for t in c.GetTracks() if isinstance(t, p.PCB_VIA)}
        renet = [f"{m['net']} {m['to']} -> {got.get((round(m['to'][0], 3), round(m['to'][1], 3)))}"
                 for m in spec['move_vias'] if got.get((round(m['to'][0], 3), round(m['to'][1], 3))) != m['net']]
        if renet:
            remove_temp_project(tmp)
            os.remove(tmp)
            sys.exit('moved via touches copper of another net, board not changed: ' + '; '.join(renet))
    remove_temp_project(tmp)
    os.replace(tmp, a.board)
    print(f'removed {removed}, moved {len(moves)} vias, added {nseg} segments and {nvia} vias')
    print_drc(run_drc(a.board))


def class_widths(board):
    """Net -> class track width from the .kicad_pro next to the board (classes wider than Default only)."""
    import fnmatch
    pro = json.load(open(os.path.splitext(board)[0] + '.kicad_pro'))['net_settings']
    width = {c['name']: c['track_width'] for c in pro['classes']}
    base = width.get('Default', 0.2)
    pats = [(x['pattern'], width[x['netclass']]) for x in pro.get('netclass_patterns') or [] if width.get(x['netclass'], 0) > base]
    return lambda net: next((w for pat, w in pats if fnmatch.fnmatchcase(net, pat)), None)


def cmd_widths(a):
    p = pcb()
    b = p.LoadBoard(a.board)
    if b is None:
        sys.exit(f'cannot load {a.board}')
    cls = class_widths(a.board)
    mm = p.ToMM
    segs, need = [], {}
    for t in b.GetTracks():
        if isinstance(t, p.PCB_VIA):
            continue
        n = t.GetNetname()
        w = cls(n)
        if w is not None:
            need[n] = w
            segs.append({'net': n, 'width': round(mm(t.GetWidth()), 4), 'layer': t.GetLayerName(),
                         'start': (round(mm(t.GetStart().x), 3), round(mm(t.GetStart().y), 3)),
                         'end': (round(mm(t.GetEnd().x), 3), round(mm(t.GetEnd().y), 3))})
    pads = [{'net': pd.GetNetname(), 'pos': (round(mm(pd.GetPosition().x), 3), round(mm(pd.GetPosition().y), 3)),
             'minor': round(mm(min(pd.GetSize(p.F_Cu).x, pd.GetSize(p.F_Cu).y)), 3)}
            for fp in b.GetFootprints() for pd in fp.Pads() if pd.GetNumber()]
    rep = width_report(segs, need, pads)
    bad = 0
    for n in sorted(rep, key=lambda n: -sum(u[1] for u in rep[n]['under'])):
        r = rep[n]
        tot = sum(u[1] for u in r['under'])
        bad += len(r['under'])
        flag = 'OK ' if not r['under'] else 'LOW'
        print(f"{flag} {n}: need {r['need']} mm, min {r['min']} mm, {len(r['under'])} thin segments ({tot:.1f} mm), {r['necks']} pad necks")
        for w, length, st in sorted(r['under'], key=lambda u: u[0])[:a.limit]:
            print(f'      {w} mm x {length} mm at {st}')
    print(f'{bad} thin segments on {sum(1 for r in rep.values() if r["under"])} nets')
    sys.exit(1 if bad else 0)


def copper_thickness(board):
    text = open(board).read()
    return {m[0]: float(m[1]) for m in re.findall(r'\(layer "([^"]+\.Cu)"\s+\(type "copper"\)\s+\(thickness ([0-9.]+)\)', text)}


def net_graph(p, b, net, thick, dT, plating):
    """Copper graph of one net: tracks (IPC capacity), vias (barrel), filled zone islands (planes), pads."""
    mm, inf = p.ToMM, float('inf')
    pt_ = lambda v: (round(mm(v.x), 3), round(mm(v.y), 3))
    tracks = [t for t in b.GetTracks() if t.GetNetname() == net]
    segs = [t for t in tracks if not isinstance(t, p.PCB_VIA)]
    vias = [t for t in tracks if isinstance(t, p.PCB_VIA)]
    ends = [(t.GetLayerName(), pt_(e)) for t in segs for e in (t.GetStart(), t.GetEnd())]
    net_pads = [pd for fp in b.GetFootprints() for pd in fp.Pads() if pd.GetNumber() and pd.GetNetname() == net]
    edges, nodes_extra = [], []
    for t in segs:
        L = t.GetLayerName()
        a, c = pt_(t.GetStart()), pt_(t.GetEnd())
        w = round(mm(t.GetWidth()), 3)
        # T junction: another end on this segment splits it
        cuts = {e for l2, e in ends if l2 == L and e not in (a, c) and t.HitTest(p.VECTOR2I(p.FromMM(e[0]), p.FromMM(e[1])))}
        # a pad or via that the track passes through (not at an end) also splits it
        for o in [pd for pd in net_pads if pd.IsOnLayer(t.GetLayer())] + vias:
            q = project(a, c, pt_(o.GetPosition()))
            if q not in (a, c) and o.HitTest(p.VECTOR2I(p.FromMM(q[0]), p.FromMM(q[1]))):
                cuts.add(q)
        cuts = sorted(cuts, key=lambda e: math.dist(a, e))
        nodes_extra.extend((L, e) for e in cuts)
        amps = ipc_amps(w, thick.get(L, 0.035), dT, inner=L.startswith('In'))
        chain = [a, *cuts, c]
        for u, v in zip(chain, chain[1:]):
            neck = any(is_neck(math.dist(u, v), w, round(mm(min(pd.GetSize(t.GetLayer()).x, pd.GetSize(t.GetLayer()).y)), 3))
                       for pd in net_pads if pd.IsOnLayer(t.GetLayer())
                       and any(pd.HitTest(p.VECTOR2I(p.FromMM(e[0]), p.FromMM(e[1]))) for e in (u, v)))
            edges.append(((L, u), (L, v), inf if neck else amps, f'{L} {w} mm {u}-{v}' + (' (pad neck)' if neck else '')))
    nodes = {(L, e) for L, e in ends} | set(nodes_extra)
    pads = {f'{fp.GetReference()}.{pd.GetNumber()}': pd for fp in b.GetFootprints() for pd in fp.Pads()
            if pd.GetNumber() and pd.GetNetname() == net}
    for lab, pd in pads.items():
        for L, e in nodes:
            if pd.IsOnLayer(b.GetLayerID(L)) and pd.HitTest(p.VECTOR2I(p.FromMM(e[0]), p.FromMM(e[1]))):
                edges.append((lab, (L, e), inf, 'pad'))
    for i, v in enumerate(vias):
        c = pt_(v.GetPosition())
        va = via_amps(mm(v.GetDrillValue()), plating, dT)
        for L, e in nodes:
            if v.HitTest(p.VECTOR2I(p.FromMM(e[0]), p.FromMM(e[1]))):
                edges.append((('via', i), (L, e), va, f'via drill {mm(v.GetDrillValue()):.2f} at {c}'))
        for lab, pd in pads.items():
            if pd.HitTest(v.GetPosition()):
                edges.append((('via', i), lab, va, f'via drill {mm(v.GetDrillValue()):.2f} at {c}'))
    for zi, z in enumerate(b.Zones()):
        if z.GetIsRuleArea() or z.GetNetname() != net:
            continue
        for lid in z.GetLayerSet().Seq():
            L = b.GetLayerName(lid)
            polys = z.GetFilledPolysList(lid)
            for k in range(polys.OutlineCount()):
                isl = ('zone', zi, L, k)
                one = p.SHAPE_POLY_SET()  # this island with its holes (thermal gaps)
                one.AddOutline(polys.Outline(k))
                for h in range(polys.HoleCount(k)):
                    one.AddHole(polys.Hole(k, h))
                inside = lambda q: one.Contains(q)
                touches = lambda item: one.Collide(item.GetEffectiveShape(lid), 0)
                for L2, e in nodes:
                    if L2 == L and inside(p.VECTOR2I(p.FromMM(e[0]), p.FromMM(e[1]))):
                        edges.append((isl, (L2, e), inf, 'zone'))
                for lab, pd in pads.items():
                    if pd.IsOnLayer(lid) and touches(pd):
                        conn = pd.GetLocalZoneConnection()
                        if conn == p.ZONE_CONNECTION_INHERITED:
                            conn = z.GetPadConnection()
                        solid = conn == p.ZONE_CONNECTION_FULL or (conn == p.ZONE_CONNECTION_THT_THERMAL and pd.GetAttribute() == p.PAD_ATTRIB_SMD)
                        sw = round(mm(z.GetThermalReliefSpokeWidth()), 3)
                        # thermal: 2 spokes (the KiCad default minimum), each an IPC conductor of the spoke width
                        edges.append((isl, lab, inf if solid else THERMAL_SPOKES * ipc_amps(sw, thick.get(L, 0.035), dT, inner=L.startswith('In')),
                                      f'zone {L} ' + ('solid' if solid else f'thermal {THERMAL_SPOKES} x {sw} mm spokes to {lab}')))
                for i, v in enumerate(vias):
                    if v.IsOnLayer(lid) and touches(v):
                        edges.append((isl, ('via', i), via_amps(mm(v.GetDrillValue()), plating, dT), f'via drill {mm(v.GetDrillValue()):.2f} at {pt_(v.GetPosition())}'))
    return edges, set(pads)


def cmd_paths(a):
    spec = json.load(open(a.spec))
    p = pcb()
    b = p.LoadBoard(a.board)
    if b is None:
        sys.exit(f'cannot load {a.board}')
    thick = copper_thickness(a.board)
    dT, plating = spec.get('dT', 10.0), spec.get('via_plating_mm', 0.018)
    bad, graphs = 0, {}
    for net, u, v, need, par in spec_pairs(spec, parallel=True):
        if net not in graphs:
            graphs[net] = net_graph(p, b, net, thick, dT, plating)
        edges, have = graphs[net]
        missing = [x for x in (u, v) if x not in have]
        if missing:
            print(f'LOW {net} {u}->{v}: pads not on this net: {missing}')
            bad += 1
            continue
        amps, path = pair_capacity(edges, u, v, par)
        tag = ' (parallel)' if par else ''
        if amps >= need:
            if a.verbose:
                print(f"OK  {net} {u}->{v}{tag}: " + ('pour' if amps == float('inf') else f'{amps:.2f} A') + f' >= {need} A')
            continue
        bad += 1
        if not path:
            print(f'LOW {net} {u}->{v}{tag}: no copper path (need {need} A)')
            continue
        if par:  # the min cut: these items together carry all the current
            print(f'LOW {net} {u}->{v}{tag}: {amps:.2f} A < {need} A; {len(path)} cut items: ' + '; '.join(path[:a.limit]))
            continue
        thin = sorted({e[3] for e in edges if e[3] in path and e[2] < need})
        print(f'LOW {net} {u}->{v}: {amps:.2f} A < {need} A; {len(thin)} items under: ' + '; '.join(thin[:a.limit]))
    print(f'{bad} power-path pairs below the design current')
    sys.exit(1 if bad else 0)


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


def cmd_art(a):
    """Silkscreen art from a spec, in one PCB_GROUP. A rerun replaces the group."""
    p = pcb()
    spec = json.load(open(a.spec))
    b = p.LoadBoard(a.board)
    name = spec.get('group', 'art')
    for g in list(b.Groups()):
        if g.GetName() == name or g.GetName() in spec.get('remove_groups', []):
            for it in list(g.GetItems()):
                b.Delete(it)
            b.Delete(g)
    layer = b.GetLayerID(spec.get('layer', 'B.SilkS'))
    mirror = spec.get('layer', 'B.SilkS').startswith('B.')
    grp = p.PCB_GROUP(b)
    grp.SetName(name)
    b.Add(grp)
    items = []
    faces = {}  # text uuid -> TrueType face; pcbnew does not save SetUnresolvedFontName, so it is written after Save

    def arc(c, rad, a0, a1, w):
        sh = p.PCB_SHAPE(b, p.SHAPE_T_ARC)
        pts = [v2(c[0] + rad * math.cos(math.radians(t)), c[1] + rad * math.sin(math.radians(t))) for t in (a0, (a0 + a1) / 2, a1)]
        sh.SetArcGeometry(*pts)
        sh.SetWidth(p.FromMM(w))
        sh.SetLayer(layer)
        items.append(sh)

    for wv in spec.get('waves', []):
        for c, rad, a0, a1 in seigaiha(wv['box'], wv['r'], wv.get('rings', 3)):
            arc(c, rad, a0, a1, wv.get('width', 0.18))
    for c in spec.get('circles', []):
        sh = p.PCB_SHAPE(b, p.SHAPE_T_CIRCLE)
        sh.SetCenter(v2(*c['c']))
        sh.SetEnd(v2(c['c'][0] + c['r'], c['c'][1]))
        sh.SetWidth(p.FromMM(c.get('width', 0.2)))
        sh.SetFilled(bool(c.get('fill')))
        sh.SetLayer(layer)
        items.append(sh)
    for ln in spec.get('lines', []):
        sh = p.PCB_SHAPE(b, p.SHAPE_T_SEGMENT)
        sh.SetStart(v2(*ln['a']))
        sh.SetEnd(v2(*ln['b']))
        sh.SetWidth(p.FromMM(ln.get('width', 0.2)))
        sh.SetLayer(layer)
        items.append(sh)
    for t in spec.get('texts', []):
        chars = list(t['text']) if t.get('vertical') else [t['text']]
        for i, ch in enumerate(chars):
            tx = p.PCB_TEXT(b)
            tx.SetText(ch)
            x, y = t['at']
            tx.SetPosition(v2(x, y + i * t['size'] * t.get('line', 1.1)))
            tx.SetLayer(layer)
            tx.SetTextSize(v2(t['size'], t['size']))
            tx.SetTextThickness(p.FromMM(t.get('thickness', t['size'] * 0.15)))
            tx.SetBold(bool(t.get('bold')))
            tx.SetTextAngleDegrees(t.get('angle', 0))
            tx.SetMirrored(mirror)
            if t.get('font'):
                faces[tx.m_Uuid.AsString()] = t['font']
            items.append(tx)
    for it in items:
        b.Add(it)
        grp.AddItem(it)
    b.Save(a.board)
    if faces:
        with open(a.board) as f:
            txt = f.read()
        for uid, face in faces.items():
            txt, n = re.subn(r'(\(uuid "%s"\)\s*\(effects\s*\(font\n)(\s*)' % re.escape(uid),
                             lambda m: f'{m.group(1)}{m.group(2)}(face "{face}")\n{m.group(2)}', txt, count=1)
            if n != 1:
                sys.exit(f'font face not written for text {uid}')
        with open(a.board, 'w') as f:
            f.write(txt)
    print(f'{name}: {len(items)} items on {spec.get("layer", "B.SilkS")}')
    print_drc(run_drc(a.board))


VARIANTS = {
    'black-enig': ('Black', 'White', 'ENIG'), 'white-enig': ('White', 'Black', 'ENIG'),
    'blue-enig': ('Blue', 'White', 'ENIG'), 'purple-enig': ('Purple', 'White', 'ENIG'),
    'red-enig': ('Red', 'White', 'ENIG'), 'green-hasl': ('Green', 'White', 'HAL lead-free'),
}


def cmd_colors(a):
    """Render colour variants from a temporary copy next to the board (KIPRJMOD stays valid)."""
    os.makedirs(a.outdir, exist_ok=True)
    src = open(a.board).read()
    d = os.path.dirname(os.path.abspath(a.board))
    for name in (a.variants or VARIANTS):
        tmp = os.path.join(d, f'.pcbtool-{name}.kicad_pcb')
        with open(tmp, 'w') as f:
            f.write(apply_colors(src, *VARIANTS[name], render=True))
        try:
            for side, extra in (('iso', ['--rotate', '-40,0,30', '--zoom', '0.9']), ('bottom', ['--side', 'bottom'])):
                out = os.path.join(a.outdir, f'{name}-{side}.png')
                subprocess.run([KICAD_CLI, 'pcb', 'render', '--quality', 'high', '--width', '1600', '--height', '1300',
                                '--background', 'opaque', *extra, '-o', out, tmp],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
                print(out)
        finally:
            for f in (tmp, tmp[:-len('.kicad_pcb')] + '.kicad_prl'):  # kicad-cli writes a .kicad_prl
                if os.path.exists(f):
                    os.remove(f)


def cmd_setcolors(a):
    with open(a.board) as f:
        s = f.read()
    with open(a.board, 'w') as f:
        f.write(apply_colors(s, a.mask, a.silk, a.finish))
    print(f'stackup: mask {a.mask}, silk {a.silk}, finish {a.finish}')


def cmd_snapshot(a):
    p = pcb()
    b = p.LoadBoard(a.board)
    snap = {'drc': run_drc(a.board),
            'parts': {fp.GetReference(): [round(p.ToMM(fp.GetPosition().x), 3), round(p.ToMM(fp.GetPosition().y), 3),
                                          round(fp.GetOrientationDegrees(), 1), 'B' if fp.IsFlipped() else 'F']
                      for fp in b.GetFootprints()},
            'tracks': sum(1 for t in b.GetTracks() if not isinstance(t, p.PCB_VIA)),
            'vias': sum(1 for t in b.GetTracks() if isinstance(t, p.PCB_VIA))}
    if a.checker:
        out = subprocess.run(a.checker, shell=True, capture_output=True, text=True).stdout
        m = re.search(r'(\d+)/(\d+) checks pass', out)
        snap['checker'] = [int(m.group(1)), int(m.group(2))] if m else None
    with open(a.out, 'w') as f:
        json.dump(snap, f, indent=1)
    c = snap.get('checker')
    print(f"snapshot {a.out}: {snap['drc']['errors']} errors, {snap['drc']['unconnected']} unconnected, "
          f"{snap['drc']['parity']} parity, {snap['tracks']} tracks, {snap['vias']} vias" + (f', checker {c[0]}/{c[1]}' if c else ''))


def cmd_compare(a):
    r = compare(json.load(open(a.before)), json.load(open(a.after)))
    for k in ('regressions', 'progress'):
        print(f"{k}: {', '.join(r[k]) or '-'}")
    print(f"tracks {r['tracks'][0]} -> {r['tracks'][1]}, vias {r['vias'][0]} -> {r['vias'][1]}")
    for k in ('added', 'removed'):
        if r[k]:
            print(f"{k}: {', '.join(r[k])}")
    for m in r['moved'][:40]:
        print('  moved ' + m)
    sys.exit(1 if r['regressions'] else 0)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest='cmd', required=True)
    s = sp.add_parser('pads'); s.add_argument('board'); s.add_argument('refs', nargs='*'); s.add_argument('--net')
    s.set_defaults(f=cmd_pads)
    for name, f in (('place', cmd_place), ('route', cmd_route)):
        s = sp.add_parser(name); s.add_argument('board'); s.add_argument('spec'); s.set_defaults(f=f)
    s = sp.add_parser('unroute'); s.add_argument('board'); s.add_argument('nets', nargs='+'); s.set_defaults(f=cmd_unroute)
    s = sp.add_parser('near'); s.add_argument('board'); s.add_argument('x', type=float); s.add_argument('y', type=float)
    s.add_argument('--r', type=float, default=0.3); s.add_argument('--within', type=float, default=1.0); s.set_defaults(f=cmd_near)
    s = sp.add_parser('widen'); s.add_argument('board'); s.add_argument('net'); s.add_argument('width', type=float)
    s.add_argument('--layer'); s.add_argument('--box', type=float, nargs=4); s.set_defaults(f=cmd_widen)
    s = sp.add_parser('drc'); s.add_argument('board'); s.set_defaults(f=cmd_drc)
    s = sp.add_parser('paths'); s.add_argument('board'); s.add_argument('spec'); s.add_argument('--limit', type=int, default=4)
    s.add_argument('--verbose', action='store_true'); s.set_defaults(f=cmd_paths)
    s = sp.add_parser('viapads'); s.add_argument('board')
    s.add_argument('--allow', nargs='*', default=[], help='REF.PAD with a datasheet-required via (tented), e.g. U1.9')
    s.set_defaults(f=cmd_viapads)
    s = sp.add_parser('widths'); s.add_argument('board'); s.add_argument('--limit', type=int, default=4); s.set_defaults(f=cmd_widths)
    s = sp.add_parser('render'); s.add_argument('board'); s.add_argument('outdir'); s.set_defaults(f=cmd_render)
    s = sp.add_parser('art'); s.add_argument('board'); s.add_argument('spec'); s.set_defaults(f=cmd_art)
    s = sp.add_parser('colors'); s.add_argument('board'); s.add_argument('outdir'); s.add_argument('variants', nargs='*')
    s.set_defaults(f=cmd_colors)
    s = sp.add_parser('setcolors'); s.add_argument('board'); s.add_argument('mask'); s.add_argument('silk'); s.add_argument('finish')
    s.set_defaults(f=cmd_setcolors)
    s = sp.add_parser('snapshot'); s.add_argument('board'); s.add_argument('out'); s.add_argument('--checker')
    s.set_defaults(f=cmd_snapshot)
    s = sp.add_parser('compare'); s.add_argument('before'); s.add_argument('after'); s.set_defaults(f=cmd_compare)
    a = ap.parse_args()
    a.f(a)


if __name__ == '__main__':
    from hard_exit import hard_exit
    hard_exit(main)
