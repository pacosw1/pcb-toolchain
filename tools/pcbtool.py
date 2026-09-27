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
  $PY tools/pcbtool.py corridor BOARD NET [--margin 3] [--cell 0.25] [--pair N] [--box X1 Y1 X2 Y2]  unconnected pad pairs + ASCII free/blocked map
  $PY tools/pcbtool.py connect BOARD INTENT                 intent lines -> 0/45/90 tracks, class width/via, clearance check
  $PY tools/pcbtool.py suggest BOARD NET [--pair N] [--box X1 Y1 X2 Y2] [--layers F.Cu,B.Cu (+ In2.Cu mixed, slow nets)] [--via-cost 8] [--k 3] [--cell 0.1] [--verify]
                                                              A* proposals as connect lines (writes nothing)
  $PY tools/pcbtool.py stitch BOARD NET [--r 1.0] [--planes P]  ground via within r of each via of NET (RP-001)
  $PY tools/pcbtool.py netcheck BOARD NET                     DRC on a temp copy: one total line + this net only
  $PY tools/pcbtool.py widths BOARD [--limit N]              tracks thinner than the net class width (current)
  $PY tools/pcbtool.py paths  BOARD SPEC.json [--verbose]     widest copper path between power pads >= design current; every supply net listed or exempt
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
Intent line: NET REF.PAD -> REF.PAD [layer=F.Cu] [width=0.3|auto] [via=auto|0.6/0.3] [through x,y] [via x,y] ...
  Waypoints in order; `via x,y` changes the layer. Each leg: half straight, 45 degrees, half straight.
  A conflict with other-net copper (class clearance, board edge) writes nothing. '#' starts a comment.
--budget [N] on netcheck, paths, viapads, corridor, suggest: cut the output to N chars (default 2000); the last lines
  say what was cut. netcheck then lists all the net's items that fit (not 3).
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
            to = p.get('to') or OTHER.get(layer)
            if to is None or to == layer:
                raise ValueError(f"{r['net']}: via at {pt} from {layer} needs a target layer (via X,Y@LAYER)")
            layer = to
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


# JLC/EasyEDA bridge symbols have pin type "unspecified", so the pin name and the net name also mark a supply.
SUPPLY_PIN = re.compile(r'^([AD]?V(CC|DD|IN|BUS|BAT|P|S|SYS|OUT)\d*|\d+V\d+O?|IN|OUT)$')
SUPPLY_NET = re.compile(r'(^|[_/+])(\d+V\d*[A-Z]?|[AD]?V(CC|DD|IN|BUS|BAT|SYS)[A-Z0-9]*)(_|$)')


def supply_nets(netlist):
    """{net: reason} for the supply nets of a kicad-cli kicadsexpr netlist: a power_in/power_out pin, a net class
    with POWER or PWR in the name, a supply pin name (bridge style NAME_NUMBER) or a voltage/supply net name.
    Ground nets and unconnected-(...) pad nets are not supplies."""
    t = ' '.join(netlist.split())
    out = {}
    for body in t[t.index('(nets'):].split('(net (code')[1:]:
        name = re.search(r'\(name "([^"]*)"', body).group(1)
        leaf = name.rsplit('/', 1)[-1]
        if 'GND' in leaf.upper() or name.startswith('unconnected-'):
            continue
        cls = (re.search(r'\(class "([^"]*)"', body) or [None, ''])[1]
        types = set(re.findall(r'\(pintype "([a-z_]+)', body)) & {'power_in', 'power_out'}
        pins = sorted({f.rsplit('_', 1)[0] for f in re.findall(r'\(pinfunction "([^"]*)"', body) if SUPPLY_PIN.match(f.rsplit('_', 1)[0])})
        why = ([f'pin type {"/".join(sorted(types))}'] if types else []) + \
              ([f'class {cls}'] if 'POWER' in cls or 'PWR' in cls else []) + \
              ([f'pin {"/".join(pins)}'] if pins else []) + (['net name'] if SUPPLY_NET.search(leaf) else [])
        if why:
            out[name] = ', '.join(why)
    return out


def uncovered_supplies(supplies, spec):
    """[(net, reason)] of the supply nets that are not in spec['nets'] and not in spec['exempt'] (each with a reason)."""
    exempt = set()
    for x in spec.get('exempt', []):
        if not str(x.get('reason', '')).strip():
            raise ValueError(f"exempt net {x.get('net')} has no reason")
        exempt.add(x['net'])
    return sorted((n, r) for n, r in supplies.items() if n not in spec['nets'] and n not in exempt)


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


def fit_grid(box, cell, max_cols=80, max_rows=40):
    """(x0, y0, cell, cols, rows) over box. The cell grows in 0.05 mm steps to stay inside the cap."""
    w, h = box[2] - box[0], box[3] - box[1]
    need = max(cell, w / max_cols, h / max_rows)
    if need > cell:
        cell = round(math.ceil(need / 0.05 - 1e-9) * 0.05, 3)
    return (box[0], box[1], cell, max(1, math.ceil(w / cell - 1e-9)), max(1, math.ceil(h / cell - 1e-9)))


def seg_dist(q, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    t = min(1.0, max(0.0, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / ((dx * dx + dy * dy) or 1)))
    return math.dist(q, (a[0] + t * dx, a[1] + t * dy))


def in_poly(q, pts):
    inside = False
    for (ax, ay), (bx, by) in zip(pts, pts[1:] + pts[:1]):
        if (ay > q[1]) != (by > q[1]) and q[0] < ax + (q[1] - ay) * (bx - ax) / (by - ay):
            inside = not inside
    return inside


def shape_dist(shape, q):
    """Distance from q to a shape edge; <= 0 inside. ('seg', a, b, half_width) or ('poly', [points])."""
    if shape[0] == 'seg':
        return seg_dist(q, shape[1], shape[2]) - shape[3]
    pts = shape[1]
    d = min(seg_dist(q, a, b) for a, b in zip(pts, pts[1:] + pts[:1]))
    return -d if in_poly(q, pts) else d


def shape_box(shape):
    pts = [shape[1], shape[2]] if shape[0] == 'seg' else shape[1]
    r = shape[3] if shape[0] == 'seg' else 0
    return (min(q[0] for q in pts) - r, min(q[1] for q in pts) - r, max(q[0] for q in pts) + r, max(q[1] for q in pts) + r)


def parse_intent(line):
    """One connect intent line: NET REF.PAD -> REF.PAD [layer=L] [width=W] [via=auto|D/DRILL] [through x,y] [via x,y[@L]] ...
    through = waypoint on the current layer, via = via at the point and a layer change (to L; without @L F.Cu <-> B.Cu).
    Missing options are None (auto)."""
    tok = line.split()
    if len(tok) < 4 or tok[2] != '->':
        raise ValueError(f'expected "NET REF.PAD -> REF.PAD ...": {line}')

    def pad(t):
        ref, dot, num = t.partition('.')
        if not (ref and dot and num):
            raise ValueError(f'expected REF.PAD, got {t}')
        return ref, num
    it = {'net': tok[0], 'a': pad(tok[1]), 'b': pad(tok[3]), 'layer': None, 'width': None, 'via': None, 'points': []}
    rest = tok[4:]
    while rest:
        t = rest.pop(0)
        if t in ('through', 'via'):
            try:
                q, at, to = rest.pop(0).partition('@')
                x, y = q.split(',')
                if at and (t != 'via' or not to):
                    raise ValueError
                it['points'].append((t, (float(x), float(y))) + ((to,) if to else ()))
            except (IndexError, ValueError):
                raise ValueError(f'{t} needs x,y (via: x,y or x,y@LAYER): {line}') from None
        elif t.startswith('layer='):
            it['layer'] = t[6:]
        elif t.startswith('width='):
            it['width'] = None if t[6:] == 'auto' else float(t[6:])
        elif t.startswith('via='):
            it['via'] = None if t[4:] == 'auto' else tuple(float(v) for v in t[4:].split('/'))
        else:
            raise ValueError(f'unknown option {t}: {line}')
    return it


def leg(a, b):
    """Points from a to b (a not included) as 0/90 and 45 degree segments: half the straight part, the diagonal,
    the other half. So every pad and waypoint is entered and left straight."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    d = min(abs(dx), abs(dy))
    s = max(abs(dx), abs(dy)) - d
    if d < 1e-9 or s < 1e-9:
        return [b]
    sx, sy = math.copysign(1, dx), math.copysign(1, dy)
    h = (sx * s / 2, 0) if abs(dx) > abs(dy) else (0, sy * s / 2)
    p1 = (a[0] + h[0], a[1] + h[1])
    p2 = (p1[0] + sx * d, p1[1] + sy * d)
    return [p1, p2, b]


def intent_route(it, start, end, layer, width, via):
    """A route spec entry (see Route spec) from an intent, the pad centres, the start layer, width and via (size, drill)."""
    path, cur = [start], start
    for kind, q, *to in it['points'] + [('end', end)]:
        pts = leg(cur, q)
        path.extend(pts[:-1])
        path.append(({'via': q, 'to': to[0]} if to else {'via': q}) if kind == 'via' else q)
        cur = q
    return {'net': it['net'], 'width': width, 'layer': layer, 'via_size': via[0], 'via_drill': via[1], 'path': path}


def seg_seg_dist(a, b, c, d):
    """Smallest distance between segments a-b and c-d (0 when they cross)."""
    def side(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    d1, d2, d3, d4 = side(c, d, a), side(c, d, b), side(a, b, c), side(a, b, d)
    if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)) and 0 not in (d1, d2, d3, d4):
        return 0
    return min(seg_dist(a, c, d), seg_dist(b, c, d), seg_dist(c, a, b), seg_dist(d, a, b))


def shape_seg_dist(shape, a, b):
    """Distance from segment a-b to a shape edge; 0 when the segment is inside or crosses a polygon."""
    if shape[0] == 'seg':
        return seg_seg_dist(a, b, shape[1], shape[2]) - shape[3]
    pts = shape[1]
    if in_poly(a, pts):
        return 0
    return min(seg_seg_dist(a, b, p, q) for p, q in zip(pts, pts[1:] + pts[:1]))


def first_conflict(segs, vias, via_size, obstacles):
    """First new copper item closer than its clearance to other-net copper, as one line, or None.
    segs: expand_route segments; obstacles: {layer: [(shape, clearance, label)]}; a via is on every layer given."""
    items = [(L, 'track', a, b, w) for a, b, L, w in segs] + [(L, 'via', q, q, via_size) for q in vias for L in obstacles]
    for L, kind, a, b, w in items:
        for shape, clr, label in obstacles.get(L, []):
            gap = shape_seg_dist(shape, a, b) - w / 2
            if gap < clr - 1e-6:
                where = f'({a[0]:.3f}, {a[1]:.3f})' + ('' if kind == 'via' else f'-({b[0]:.3f}, {b[1]:.3f})')
                return f'{L} {kind} {where} w {w:g}: gap {gap:.3f} < {clr:g} to {label}'
    return None


def corridor_map(grid, outline, edge_gap, own, others, marks):
    """ASCII rows: '.' free for a track centre, '#' blocked (other copper + keep, board edge), '+' own copper,
    letters = marks. others: [(shape, keep)]; outline: board polygons (None = no edge)."""
    x0, y0, cell, cols, rows = grid
    g = [['.'] * cols for _ in range(rows)]

    def cells(shape, keep):  # only the cells near the shape (fast on a large board)
        bx0, by0, bx1, by1 = shape_box(shape)
        for r in range(max(0, int((by0 - keep - y0) // cell)), min(rows, int((by1 + keep - y0) // cell) + 1)):
            for c in range(max(0, int((bx0 - keep - x0) // cell)), min(cols, int((bx1 + keep - x0) // cell) + 1)):
                yield r, c, (x0 + (c + 0.5) * cell, y0 + (r + 0.5) * cell)

    if outline is not None:
        for r in range(rows):
            for c in range(cols):
                q = (x0 + (c + 0.5) * cell, y0 + (r + 0.5) * cell)
                if not any(in_poly(q, pts) and -shape_dist(('poly', pts), q) >= edge_gap for pts in outline):
                    g[r][c] = '#'
    for s, keep in others:
        for r, c, q in cells(s, keep):
            if shape_dist(s, q) < keep:
                g[r][c] = '#'
    for s in own:
        for r, c, q in cells(s, 0):
            if shape_dist(s, q) <= 0:
                g[r][c] = '+'
    for ch, (x, y) in marks:
        c, r = int((x - x0) // cell), int((y - y0) // cell)
        if 0 <= r < rows and 0 <= c < cols:
            g[r][c] = ch
    return [''.join(row) for row in g]


def mst_pairs(islands):
    """Ratsnest: join the islands of a net (lists of (name, (x, y))) by the nearest pad pairs (Prim)."""
    done, pairs = [0], []
    while len(done) < len(islands):
        d, a, j, b = min((math.dist(pa, pb), na, j, nb) for i in done for na, pa in islands[i]
                         for j in range(len(islands)) if j not in done for nb, pb in islands[j])
        done.append(j)
        pairs.append((a, b))
    return pairs


def net_rules(pro, net):
    """(class, track width, clearance) of a net from the .kicad_pro dict (first matching pattern, else Default)."""
    import fnmatch
    ns = pro['net_settings']
    cls = {c['name']: c for c in ns['classes']}
    name = next((x['netclass'] for x in ns.get('netclass_patterns') or [] if fnmatch.fnmatchcase(net, x['pattern'])), 'Default')
    return name, cls[name]['track_width'], cls[name]['clearance']


def dru_mentions(text, names):
    """Names of the .kicad_dru rules whose text quotes one of names (net name or class)."""
    out = []
    for block in text.split('(rule "')[1:]:
        if any(f"'{n}'" in block for n in names):
            out.append(block.split('"', 1)[0])
    return out


def net_check(d, net, limit=3):
    """(text, ok): one DRC total line, then up to limit short lines for the net (None: all). ok = no violation, no unconnected."""
    limit = len(d.get('violations', [])) + len(d.get('unconnected_items', [])) if limit is None else limit
    tag = f'[{net}]'
    s = summarize_drc(d)
    viol = [x for x in d.get('violations', []) if any(tag in i['description'] for i in x['items'])]
    unc = [u for u in d.get('unconnected_items', []) if any(tag in i['description'] for i in u['items'])]
    lines = [f"DRC total: {s['errors']} errors, {s['unconnected']} unconnected, {s['parity']} parity | "
             f"{net}: {len(viol)} violations, {len(unc)} unconnected"]
    for x in viol[:limit]:
        text = ' | '.join(i['description'] for i in x['items'])
        lines.append(f"  {x.get('severity', '?')[0].upper()} {x['type']}: {text}"[:170])
    for u in unc[:max(0, limit - len(viol))]:
        lines.append('  U ' + ' | '.join(i['description'] + (' ({x:.3f}, {y:.3f})'.format(**i['pos']) if 'pos' in i else '')
                                        for i in u['items'])[:160])
    return '\n'.join(lines), not viol and not unc


def budget_cut(lines, budget, kind, keep_last=False):
    """The lines that fit in budget chars (newlines counted). When lines are cut, one line names what was cut, so
    "not shown" never reads as "not present". kind(line) -> (label, net) or (None, None). keep_last keeps a total line."""
    if sum(len(l) + 1 for l in lines) <= budget:
        return lines
    tail = lines[-1:] if keep_last else []
    body = lines[:-1] if keep_last else lines
    for n in range(len(body), -1, -1):
        counts, nets = collections.Counter(), set()
        for l in body[n:]:
            k, net = kind(l)
            counts[k or 'lines'] += 1
            if net:
                nets.add(net)
        parts = [f'{c} more {k}' if i == 0 else f'{c} {k}' for i, (k, c) in enumerate(counts.items())]
        note = '... ' + ', '.join(parts + ([f'{len(nets)} nets'] if nets else []) + ['not shown'])
        out = body[:n] + [note] + tail
        if n == 0 or sum(len(l) + 1 for l in out) <= budget:
            return out


BUDGET_KINDS = {  # command -> (kind(line), keep the last line)
    'netcheck': (lambda l: ('violations', None) if l[:4] in ('  E ', '  W ') else ('unconnected', None) if l.startswith('  U ')
                 else (None, None), False),
    'paths': (lambda l: ('pairs below current', l.split()[1]) if l.startswith('LOW ') else ('OK pairs', l.split()[1])
              if l.startswith('OK ') else ('supply nets not covered', l.split()[1]) if l.startswith('MISSING ')
              else (None, None), True),
    'viapads': (lambda l: ('vias in pads', l.split()[5]) if l.startswith('FAIL via in pad') and len(l.split()) > 5
                else (None, None), True),
    'suggest': (lambda l: ('alternatives', None) if re.match(r'\d+\) ', l) else (None, None), False),
    'corridor': (lambda l: ('maps', None) if l.startswith('map ') else ('map rows', None) if re.match(r'\s*\d', l)
                 else ('pairs', None) if re.match(r'  [A-Za-z?] ', l) else (None, None), False),
}


# ---------------------------------------------------------------- suggest: A* path proposals as connect lines
MOVES = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]
BEND_COST = {1: 0.05, 2: 0.2}   # mm-equivalent cost of a 45 / 90 degree turn; sharper turns are not allowed
ESCAPE_MM = 2.5                 # pad escape: grid nodes this near a pad may end the path with an exact leg
POUR_EXTRA = 2.0                # extra cost per mm in the own-domain ground pour (x3 length); other pours are blocked


def astar(dims, free, via_ok, extra, s, s_layers, t, t_layers, via_cost, s_cost=None, t_cost=None):
    """Cheapest node path on a node grid (dims = cols, rows, cell) with 8 moves per layer and vias between layers.
    free[layer]: bytearray, 1 = a track centre may be on the node; via_ok: bytearray; extra[layer][node]: extra cost per mm.
    Cost = length * (1 + extra) + BEND_COST per turn + via_cost per via. No via on the start node or right after a via.
    s_cost / t_cost {(node, layer): cost}: start / goal states with a cost added (the exact leg to the pad centre), in
    place of s, s_layers / t, t_layers. Returns ([(node, layer)], cost), or (None, set of reached nodes)."""
    import heapq
    cols, rows, cell = dims
    tc, tr = t % cols, t // cols
    diag = math.sqrt(2)
    s_cost = s_cost or {(s, L): 0.0 for L in s_layers}
    t_cost = t_cost or {(t, L): 0.0 for L in t_layers}

    def octile(i):
        dx, dy = abs(i % cols - tc), abs(i // cols - tr)
        return cell * (max(dx, dy) + (diag - 1) * min(dx, dy))
    slack = max(octile(i) for i, _ in t_cost)

    def h(i):
        return max(0.0, octile(i) - slack)
    best, prev, heap, n = {}, {}, [], 0
    for (i, L), c in s_cost.items():
        best[(i, L, 8)] = c
        heap.append((c + h(i), c, n, (i, L, 8)))
        n += 1
    heapq.heapify(heap)
    reached = set()
    while heap:
        _, g, _, st = heapq.heappop(heap)
        if g > best.get(st, math.inf):
            continue
        if st[0] == 'end':
            st = prev[st]
            path = [(st[0], st[1])]
            while st in prev:
                st = prev[st]
                if (st[0], st[1]) != path[-1]:
                    path.append((st[0], st[1]))
            return path[::-1], g
        i, L, d = st
        reached.add(i)
        if (i, L) in t_cost:
            end = ('end', i, L)
            if g + t_cost[(i, L)] < best.get(end, math.inf) - 1e-12:
                best[end], prev[end] = g + t_cost[(i, L)], st
                heapq.heappush(heap, (best[end], best[end], n, end))
                n += 1
        c, r = i % cols, i // cols
        nxt = []
        for k, (dc, dr) in enumerate(MOVES):
            turn = 0 if d == 8 else min(abs(k - d), 8 - abs(k - d))
            if turn > 2 or not (0 <= c + dc < cols and 0 <= r + dr < rows):
                continue
            j = i + dr * cols + dc
            if free[L][j]:
                step = cell * (diag if dc and dr else 1)
                nxt.append(((j, L, k), g + step * (1 + (extra[L][i] + extra[L][j]) / 2) + BEND_COST.get(turn, 0)))
        if d != 8 and via_ok[i]:
            nxt += [((i, L2, 8), g + via_cost) for L2 in range(len(free)) if L2 != L and free[L2][i]]
        for st2, g2 in nxt:
            if g2 < best.get(st2, math.inf) - 1e-12:
                best[st2], prev[st2] = g2, st
                heapq.heappush(heap, (g2 + h(st2[0]), g2, n, st2))
                n += 1
    return None, reached


def node_corners(path, cols):
    """Waypoints of a node path [(node, layer)]: ('through', node) at each turn, ('via', node) at each layer change.
    The two ends are not included."""
    out = []
    for k in range(1, len(path) - 1):
        (i0, l0), (i1, l1), (i2, l2) = path[k - 1:k + 2]
        if i1 == i2:
            out.append(('via', i1))
        elif l0 == l1 and (i1 % cols - i0 % cols, i1 // cols - i0 // cols) != (i2 % cols - i1 % cols, i2 // cols - i1 // cols):
            out.append(('through', i1))
    return out


def path_points(sa, sb, first, corners, last):
    """[(kind, (x, y))] from pad centre sa to pad centre sb: the first and last grid node of the path as 'through' when
    they are off the pad centre and not already the neighbouring corner (a via on the goal node), then the corners."""
    pts = [('end', sa)] + ([('through', first)] if math.dist(first, sa) > 1e-6 else []) + list(corners)
    if math.dist(last, sb) > 1e-6 and math.dist(last, pts[-1][1]) > 1e-6:
        pts.append(('through', last))
    return pts + [('end', sb)]

def drop_jogs(pts, layer, ok):
    """Remove 'through' waypoints while ok(a, b, c, layer) says the direct leg a -> c may replace a -> b -> c.
    A direct 0/45/90 leg is never longer, so this removes jogs and extra bends. pts: [(kind, (x, y))], the two pad
    centres first and last; a 'via' changes the layer (to its third item, else F.Cu <-> B.Cu)."""
    pts = list(pts)
    k = 1
    while k < len(pts) - 1:
        L = layer
        for kind, _, *to in pts[1:k]:
            L = (to[0] if to else OTHER[L]) if kind == 'via' else L
        if pts[k][0] == 'through' and ok(pts[k - 1][1], pts[k][1], pts[k + 1][1], L):
            del pts[k]
            k = max(1, k - 1)
        else:
            k += 1
    return pts


def via_layers(path):
    """The layer after each via of a node path [(node, layer)], in path order (as node_corners lists the vias)."""
    return [l2 for (i1, _), (i2, l2) in zip(path, path[1:]) if i1 == i2]


def via_token(q, cur, to):
    """The connect line text of a via at q from layer cur to layer to: '@to' only when it is not F.Cu <-> B.Cu."""
    return f' via {fmt_mm(q[0])},{fmt_mm(q[1])}' + ('' if OTHER.get(cur) == to else f'@{to}')


def layers_error(net, layers, mixed):
    """None when net may use every layer in layers, else the reason. mixed: {mixed plane layer: kind of the net}.
    F.Cu and B.Cu are always allowed; a mixed layer (reference-planes.json mixed_layers) only for a slow net."""
    for L in layers:
        if L in OTHER:
            continue
        if L not in mixed:
            return f'{L} is not a routing layer (F.Cu, B.Cu, or a mixed layer of reference-planes.json)'
        if mixed[L] != 'slow':
            return f'{net} is a {mixed[L]} net: {L} is for slow nets only (reference-planes.json mixed_layers)'
    return None


def load_si_planes():
    import importlib.util
    spec = importlib.util.spec_from_file_location('si_planes', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'si_planes.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def mixed_kinds(net, planes, pro):
    """{mixed layer: 'fast' | 'power' | 'slow'} of a net from reference-planes.json (si_planes rules; a net of the
    POWER class is power too). No spec file = no mixed layer. A bad spec or a missing fast file exits (fail closed)."""
    if not planes or not os.path.exists(planes):
        return {}
    sp = load_si_planes()
    try:
        s = sp.load_spec(json.load(open(planes)))
        sp.load_fast(s, os.path.dirname(os.path.abspath(planes)))
    except (sp.SpecError, ValueError, OSError) as e:
        sys.exit(f'{planes}: {e}')
    out = {}
    for L, m in s['mixed_layers'].items():
        k = sp.net_kind(net, m, s)
        out[L] = 'power' if k == 'slow' and net_rules(pro, net)[0] == 'POWER' else k
    return out


def reference_obstacles(net, kind, layers, mixed, under, fast_tracks, mixed_tracks, clr):
    """{layer: [(shape, clearance, label)]} that keep ground fill of the mixed layer under every fast-net track on the
    outer layer `under` (si_planes fast-unreferenced). A net routed on the mixed layer keeps clr from the fast tracks
    on `under`; a fast net routed on `under` keeps clr from the other nets' tracks on the mixed layer.
    fast_tracks / mixed_tracks: [(net, shape)]; clr: the fill clearance of the ground zone."""
    out = {}
    if mixed in layers:
        got = [(sh, clr, f'fast ref {under} {n}') for n, sh in fast_tracks if n != net]
        if got:
            out[mixed] = got
    if kind == 'fast' and under in layers:
        got = [(sh, clr, f'{mixed} track {n}') for n, sh in mixed_tracks if n != net]
        if got:
            out[under] = got
    return out


def verify_verdict(base, cand, net):
    """(ok, reason) of a candidate DRC report against the baseline report: no new error type count,
    fewer unconnected items on the net, no more on any other net."""
    def counts(d):
        unc = collections.Counter(n for x in d.get('unconnected_items', [])
                                  for n in {m.group(1) for i in x['items'] for m in [NET_RE.search(i['description'])] if m})
        err = collections.Counter(x['type'] for x in d.get('violations', []) if x.get('severity') == 'error')
        return unc, err
    (bu, be), (cu, ce) = counts(base), counts(cand)
    for t in sorted(ce):
        if ce[t] > be[t]:
            return False, f'+{ce[t] - be[t]} {t}'
    if cu[net] >= bu[net]:
        return False, f'{net} unconnected {bu[net]} -> {cu[net]}'
    for n in sorted(cu):
        if n != net and cu[n] > bu[n]:
            return False, f'{n} unconnected {bu[n]} -> {cu[n]}'
    return True, ''


def ground_spec(path):
    """(grounds, domain patterns) of a reference-planes.json (tools/si_planes.py); (['GND'], {}) when there is no file."""
    if not os.path.exists(path):
        return ['GND'], {}
    s = json.load(open(path))
    return list(s['grounds']), dict(s.get('domains') or {})


def net_domain(net, pad_grounds, grounds, patterns):
    """Ground domain of a net as si_planes.py finds it: a ground is its own domain, then a spec pattern, then the ground
    whose zone outline holds most of its pads. With one ground that ground is the fallback; else a tie gives None."""
    import fnmatch
    if net in grounds:
        return net
    for g, pats in patterns.items():
        if any(fnmatch.fnmatchcase(net, q) for q in pats):
            return g
    top = collections.Counter(g for g in pad_grounds if g).most_common(2)
    if top and (len(top) == 1 or top[0][1] > top[1][1]):
        return top[0][0]
    return grounds[0] if len(grounds) == 1 else None


def pour_rule(zone_net, domain):
    """'cost' for a pour of the net's own ground domain, else 'block' (other nets, a ground of another domain:
    the isolation barrier; every ground when the domain is unknown)."""
    return 'cost' if domain is not None and zone_net == domain else 'block'


def spoke_segments(c, hx, hy, orient_deg, spoke_deg, reach, round_pad=False):
    """The 4 thermal spoke centre lines of a pad at c (half sizes hx, hy; a round pad uses hx as radius): from the pad
    edge out by reach, at spoke_deg + k x 90 in the pad frame, turned by the pad orientation (KiCad, Y down)."""
    out = []
    for k in range(4):
        a = math.radians(spoke_deg + 90 * k)
        ca, sa = math.cos(a), math.sin(a)
        edge = hx if round_pad else min(hx / abs(ca) if abs(ca) > 1e-9 else math.inf, hy / abs(sa) if abs(sa) > 1e-9 else math.inf)
        t = math.radians(orient_deg)
        d = (ca * math.cos(t) + sa * math.sin(t), -ca * math.sin(t) + sa * math.cos(t))
        out.append(((c[0] + d[0] * edge, c[1] + d[1] * edge), (c[0] + d[0] * (edge + reach), c[1] + d[1] * (edge + reach))))
    return out


def stitch_spots(q, r, rings=(0.97, 0.9, 0.8, 0.7), n=36):
    """Candidate ground via centres around a signal via q: rings at r x rings, n points each, outer ring first."""
    for f in rings:
        for k in range(n):
            a = 2 * math.pi * k / n
            yield (round(q[0] + f * r * math.cos(a), 4), round(q[1] + f * r * math.sin(a), 4))


def needs_stitch(q, ground_vias, r):
    """True when no ground via is within r mm of the via q (kicad-happy RP-001)."""
    return not any(math.dist(q, g) <= r for g in ground_vias)


def mark_near(grid, shape, keep, free, lab, li):
    """Block (free = 0, lab = li) the nodes closer than keep to a shape. grid = (x0, y0, cell, cols, rows); nodes at x0 + c * cell."""
    x0, y0, cell, cols, rows = grid
    bx0, by0, bx1, by1 = shape_box(shape)
    for r in range(max(0, math.ceil((by0 - keep - y0) / cell)), min(rows, math.floor((by1 + keep - y0) / cell) + 1)):
        for c in range(max(0, math.ceil((bx0 - keep - x0) / cell)), min(cols, math.floor((bx1 + keep - x0) / cell) + 1)):
            i = r * cols + c
            if free[i] and shape_dist(shape, (x0 + c * cell, y0 + r * cell)) < keep:
                free[i], lab[i] = 0, li


def poly_nodes(grid, rings):
    """Nodes inside the rings (even-odd, so a hole ring cuts out), by scanline."""
    x0, y0, cell, cols, rows = grid
    edges = [(a, b) for ring in rings for a, b in zip(ring, ring[1:] + ring[:1]) if a[1] != b[1]]
    out = []
    for r in range(rows):
        y = y0 + r * cell
        xs = sorted(ax + (y - ay) * (bx - ax) / (by - ay) for (ax, ay), (bx, by) in edges if (ay > y) != (by > y))
        for xa, xb in zip(xs[::2], xs[1::2]):
            out += [r * cols + c for c in range(max(0, math.ceil((xa - x0) / cell)), min(cols, math.floor((xb - x0) / cell) + 1))]
    return out


def clear_margin(segs, vias, via_size, obstacles, window=1.0):
    """(smallest gap minus clearance, label) of new tracks and vias to other-net copper; negative = conflict.
    Copper farther than window is not measured, so the margin is at most window."""
    items = [(L, a, b, w) for a, b, L, w in segs] + [(L, q, q, via_size) for q in vias for L in obstacles]
    best = (window, '')
    for L, a, b, w in items:
        lo = (min(a[0], b[0]) - w / 2 - window, min(a[1], b[1]) - w / 2 - window)
        hi = (max(a[0], b[0]) + w / 2 + window, max(a[1], b[1]) + w / 2 + window)
        for shape, clr, label in obstacles.get(L, []):
            bx = shape_box(shape)
            if bx[0] - clr > hi[0] or bx[2] + clr < lo[0] or bx[1] - clr > hi[1] or bx[3] + clr < lo[1]:
                continue
            m = shape_seg_dist(shape, a, b) - w / 2 - clr
            if m < best[0]:
                best = (m, label)
    return best


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
    if not a.no_drc:
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
    miss = uncovered_supplies(supply_nets(sch_netlist(a.board)), spec)
    for net, why in miss:
        print(f'MISSING {net} ({why}): supply net not in the spec nets or exempt list')
    print(f'{len(miss)} supply nets not covered')
    sys.exit(1 if bad or miss else 0)


def sch_netlist(board):
    """kicadsexpr netlist text of the .kicad_sch next to board (kicad-cli). A failed export stops the gate."""
    import tempfile
    sch = os.path.splitext(board)[0] + '.kicad_sch'
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, 'n.net')
        r = subprocess.run([KICAD_CLI, 'sch', 'export', 'netlist', '--format', 'kicadsexpr', '-o', out, sch],
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, check=False)
        if r.returncode or not os.path.exists(out):
            sys.exit(f'netlist export of {sch} failed (exit {r.returncode}): {r.stderr.strip()[:200]}')
        return open(out).read()


def cmd_drc(a):
    print_drc(run_drc(a.board), limit=60)


def poly_points(p, chain):
    return [(p.ToMM(chain.CPoint(i).x), p.ToMM(chain.CPoint(i).y)) for i in range(chain.PointCount())]


def cmd_corridor(a):
    """Unconnected pad pairs of one net and a small free/blocked ASCII map per outer layer around them."""
    p = pcb()
    b = p.LoadBoard(a.board)
    if b is None:
        sys.exit(f'cannot load {a.board}')
    if b.FindNet(a.net) is None:
        sys.exit(f'no net {a.net} on the board')
    mm = p.ToMM
    pro = json.load(open(os.path.splitext(a.board)[0] + '.kicad_pro'))
    cls, width, clr = net_rules(pro, a.net)
    head = f'net {a.net}: class {cls}, width {width:g}, clearance {clr:g}'
    dru = os.path.splitext(a.board)[0] + '.kicad_dru'
    if os.path.exists(dru):
        names = dru_mentions(open(dru).read(), [a.net, cls])
        head += f"; dru rules on it: {', '.join(names) or 'none'} (map uses class clearances only, check .kicad_dru)"
    print(head)
    b.BuildConnectivity()
    conn = b.GetConnectivity()
    pads = [pd for fp in b.GetFootprints() for pd in fp.Pads() if pd.GetNetname() == a.net and pd.GetNumber()]
    name = {pd.m_Uuid.AsString(): f'{pd.GetParentFootprint().GetReference()}.{pd.GetNumber()}' for pd in pads}
    pos = {pd.m_Uuid.AsString(): (mm(pd.GetPosition().x), mm(pd.GetPosition().y)) for pd in pads}
    side = {pd.m_Uuid.AsString(): 'THT' if pd.GetAttribute() == p.PAD_ATTRIB_PTH else ('F' if pd.IsOnLayer(p.F_Cu) else 'B')
            for pd in pads}
    root = {k: k for k in name}

    def find(k):
        while root[k] != k:
            k = root[k]
        return k
    for pd in pads:
        for it in conn.GetConnectedItems(pd):
            k = it.m_Uuid.AsString()
            if k in root:
                root[find(k)] = find(pd.m_Uuid.AsString())
    groups = collections.defaultdict(list)
    for k in name:
        groups[find(k)].append((k, pos[k]))
    pairs = mst_pairs(sorted(groups.values(), key=lambda g: sorted(name[k] for k, _ in g)))
    if not pairs:
        print('unconnected: none')
        return
    letters = {}
    for k in (k for pr in pairs for k in pr):
        letters.setdefault(k, (string_letters[len(letters)] if len(letters) < len(string_letters) else '?'))
    print(f'unconnected: {len(pairs)} pairs')
    for u, v in pairs[:12]:
        print('  ' + '  -  '.join(f'{letters[k]} {name[k]} ({pos[k][0]:.3f}, {pos[k][1]:.3f}) {side[k]}' for k in (u, v)))
    if len(pairs) > 12:
        print(f'  ... {len(pairs) - 12} more pairs (not in the map)')
    if a.pair and not 1 <= a.pair <= len(pairs):
        sys.exit(f'--pair {a.pair}: the net has {len(pairs)} pairs')
    shown = [k for pr in ([pairs[a.pair - 1]] if a.pair else pairs[:12]) for k in pr]
    xs, ys = [pos[k][0] for k in shown], [pos[k][1] for k in shown]
    if a.box:
        bx = (min(a.box[0], a.box[2]), min(a.box[1], a.box[3]), max(a.box[0], a.box[2]), max(a.box[1], a.box[3]))
    else:
        bx = (min(xs) - a.margin, min(ys) - a.margin, max(xs) + a.margin, max(ys) + a.margin)
    grid = fit_grid(bx, a.cell)
    x0, y0, cell, cols, rows = grid
    if a.box and cell > a.cell:
        print(f'box larger than 80x40 cells: cell grown from {a.cell:g} to {cell:g}')
    ds = b.GetDesignSettings()
    o = p.SHAPE_POLY_SET()
    b.GetBoardPolygonOutlines(o, True)
    outline = [poly_points(p, o.Outline(i)) for i in range(o.OutlineCount())]
    edge_gap = mm(ds.m_CopperEdgeClearance) + width / 2
    holes = [(('poly', poly_points(p, o.Hole(i, h))), edge_gap) for i in range(o.OutlineCount()) for h in range(o.HoleCount(i))]
    print(f'grid x0={x0:.3f} y0={y0:.3f} cell={cell:g} cols={cols} rows={rows}: cell (c, r) centre = '
          f'(x0 + (c + 0.5) * cell, y0 + (r + 0.5) * cell). Legend: . free for a {width:g} mm track centre, '
          f'# blocked (other copper + clearance, edge, keepout), + own copper, letters = pads above. '
          f'Pours of other nets are not shown.')
    ruler = '   ' + ''.join(str(c // 10 % 10) if c % 10 == 0 else ' ' for c in range(cols))
    net_clr = {}
    for layer in (p.F_Cu, p.B_Cu):
        own, obs = copper_obstacles(p, b, pro, a.net, clr, layer, net_clr)
        others = list(holes) + [(s, c + width / 2) for s, c, _ in obs]
        box = (x0 - 5, y0 - 5, x0 + cols * cell + 5, y0 + rows * cell + 5)  # drop far items (keep < 5 mm)

        def near(s):
            bx = shape_box(s)
            return bx[0] < box[2] and bx[2] > box[0] and bx[1] < box[3] and bx[3] > box[1]
        rows_ = corridor_map(grid, outline, edge_gap, [s for s in own if near(s)], [(s, k) for s, k in others if near(s)],
                             [(ch, pos[k]) for k, ch in letters.items() if k in shown and pd_on(side[k], layer, p)])
        print(f'map {b.GetLayerName(layer)}')
        print(ruler)
        for r, line in enumerate(rows_):
            print(f'{r:2d} {line}')


def copper_obstacles(p, b, pro, net, clr, layer, net_clr):
    """(own shapes, [(shape, clearance, label)]) on one copper layer: tracks, vias, pads, NPTH holes, track keepouts.
    clearance = max(clr, the other net's class clearance); 0 for a keepout. net_clr caches the class clearances."""
    mm = p.ToMM

    def keep(n):
        if n not in net_clr:
            net_clr[n] = max(clr, net_rules(pro, n)[2] if n else 0)
        return net_clr[n]
    own, others = [], []
    for t in b.GetTracks():
        if not t.IsOnLayer(layer):
            continue
        if isinstance(t, p.PCB_VIA):
            c = (mm(t.GetPosition().x), mm(t.GetPosition().y))
            s, kind = ('seg', c, c, mm(t.GetWidth(p.F_Cu)) / 2), 'via'
        else:
            s, kind = ('seg', (mm(t.GetStart().x), mm(t.GetStart().y)), (mm(t.GetEnd().x), mm(t.GetEnd().y)), mm(t.GetWidth()) / 2), 'track'
        (own.append(s) if t.GetNetname() == net else others.append((s, keep(t.GetNetname()), f'{kind} {t.GetNetname()}')))
    for fp in b.GetFootprints():
        for pd in fp.Pads():
            if not pd.IsOnLayer(layer) and pd.GetAttribute() != p.PAD_ATTRIB_NPTH:
                continue
            name = f'{fp.GetReference()}.{pd.GetNumber()}'
            if pd.GetAttribute() == p.PAD_ATTRIB_NPTH:
                c = (mm(pd.GetPosition().x), mm(pd.GetPosition().y))
                others.append((('seg', c, c, mm(pd.GetDrillSize().x) / 2), keep(''), f'NPTH hole {name}'))
                continue
            poly = pd.GetEffectivePolygon(layer)
            s = ('poly', poly_points(p, poly.Outline(0)))
            (own.append(s) if pd.GetNetname() == net else others.append((s, keep(pd.GetNetname()), f'pad {name} {pd.GetNetname()}')))
    for z in b.Zones():
        if z.GetIsRuleArea() and z.GetDoNotAllowTracks() and z.IsOnLayer(layer):
            others.append((('poly', poly_points(p, z.Outline().Outline(0))), 0, 'track keepout'))
    return own, others


def thermal_spokes(p, b, pro, net, clr, net_clr):
    """{layer name: [(shape, clearance, label)]}: thermal spokes of the pads in a pour of their own net (not `net`).
    A track through a spoke starves the thermal (DRC starved_thermal). A filled zone keeps only the spokes that its fill
    holds (at half the gap from the pad edge); an unfilled zone keeps all 4 (conservative)."""
    mm = p.ToMM
    out = collections.defaultdict(list)
    opt = lambda v, d: d if v is None or v == 0 else v
    for z in b.Zones():
        zn = z.GetNetname()
        if z.GetIsRuleArea() or not zn or zn == net:
            continue
        c_ = net_clr.setdefault(zn, max(clr, net_rules(pro, zn)[2]))
        for fp in b.GetFootprints():
            for pd in fp.Pads():
                if pd.GetNetname() != zn or not z.Outline().Contains(pd.GetPosition()):
                    continue
                conn = pd.GetLocalZoneConnection()
                conn = z.GetPadConnection() if conn == p.ZONE_CONNECTION_INHERITED else conn
                tht = pd.GetAttribute() == p.PAD_ATTRIB_PTH
                if not (conn == p.ZONE_CONNECTION_THERMAL or (conn == p.ZONE_CONNECTION_THT_THERMAL and tht)):
                    continue
                w = mm(opt(pd.GetLocalThermalSpokeWidthOverride(), z.GetThermalReliefSpokeWidth()))
                gap = mm(opt(pd.GetLocalThermalGapOverride(), z.GetThermalReliefGap()))
                for L in z.GetLayerSet().CuStack():
                    if not pd.IsOnLayer(L):
                        continue
                    sz = pd.GetSize(L)
                    pos = (mm(pd.GetPosition().x), mm(pd.GetPosition().y))
                    segs = spoke_segments(pos, mm(sz.x) / 2, mm(sz.y) / 2, pd.GetOrientationDegrees(),
                                          pd.GetThermalSpokeAngleDegrees(), gap + w,
                                          round_pad=pd.GetShape(L) == p.PAD_SHAPE_CIRCLE)
                    if z.IsFilled():             # KiCad drops a spoke that the fill does not reach
                        fill = z.GetFilledPolysList(L)
                        segs = [(u, v) for u, v in segs if fill.Contains(p.VECTOR2I(
                            p.FromMM(u[0] + (v[0] - u[0]) * (gap / 2) / (gap + w)), p.FromMM(u[1] + (v[1] - u[1]) * (gap / 2) / (gap + w))))]
                    out[b.GetLayerName(L)] += [(('seg', u, v, w / 2), c_, f'thermal spoke {fp.GetReference()}.{pd.GetNumber()}')
                                               for u, v in segs]
    return out


def cmd_connect(a):
    """Intent lines -> tracks and vias. The agent chooses the path (waypoints, vias); the code makes the 0/45/90 geometry,
    takes the class width and via, checks clearance to other-net copper, then writes with the route command.
    On a conflict nothing is written. Pours of other nets are not checked (they refill)."""
    import tempfile
    text = open(a.spec).read() if os.path.exists(a.spec) else a.spec
    lines = [l.split('#', 1)[0].strip() for l in text.splitlines()]
    try:
        intents = [parse_intent(l) for l in lines if l]
    except ValueError as e:
        sys.exit(str(e))
    if not intents:
        sys.exit('no intent lines')
    p = pcb()
    b = p.LoadBoard(a.board)
    if b is None:
        sys.exit(f'cannot load {a.board}')
    mm = p.ToMM
    pro = json.load(open(os.path.splitext(a.board)[0] + '.kicad_pro'))
    planes = a.planes or os.path.join(os.path.dirname(os.path.abspath(a.board)), '..', '..', 'reference-planes.json')
    classes = {c['name']: c for c in pro['net_settings']['classes']}
    copper = [b.GetLayerName(l) for l in b.GetEnabledLayers().CuStack()]
    o = p.SHAPE_POLY_SET()
    b.GetBoardPolygonOutlines(o, True)
    edge_clr = mm(b.GetDesignSettings().m_CopperEdgeClearance)
    edges = []
    for i in range(o.OutlineCount()):
        for pts in [poly_points(p, o.Outline(i))] + [poly_points(p, o.Hole(i, h)) for h in range(o.HoleCount(i))]:
            edges += [(('seg', u, v, 0), edge_clr, 'board edge') for u, v in zip(pts, pts[1:] + pts[:1])]
    routes, new = [], []
    for it in intents:
        net = it['net']
        if b.FindNet(net) is None:
            sys.exit(f'no net {net} on the board')
        ends = []
        for ref, num in (it['a'], it['b']):
            fp = b.FindFootprintByReference(ref)
            pd = fp and next((q for q in fp.Pads() if q.GetNumber() == num), None)
            if pd is None:
                sys.exit(f'no pad {ref}.{num}')
            if pd.GetNetname() != net:
                sys.exit(f'pad {ref}.{num} is on net {pd.GetNetname()}, not {net}')
            ends.append(((mm(pd.GetPosition().x), mm(pd.GetPosition().y)), pd))
        cls_name, cls_w, clr = net_rules(pro, net)
        cls = classes[cls_name]
        (start, pa), (end, pb) = ends
        layer = it['layer'] or ('B.Cu' if pa.GetAttribute() == p.PAD_ATTRIB_SMD and pa.IsOnLayer(p.B_Cu) else 'F.Cu')
        via = it['via'] or (cls['via_diameter'], cls['via_drill'])
        r = intent_route(it, start, end, layer, it['width'] or cls_w, via)
        try:
            segs, vias = expand_route(r)
        except ValueError as e:
            sys.exit(str(e))
        used = sorted({L for _, _, L, _ in segs})
        err = layers_error(net, used, mixed_kinds(net, planes, pro) if any(L not in OTHER for L in used) else {})
        if err:
            sys.exit(err)
        for pd, L, what in ((pa, segs[0][2], 'start'), (pb, segs[-1][2], 'end')):
            if not pd.IsOnLayer(b.GetLayerID(L)):
                sys.exit(f'{net}: the {what} pad is not on {L}; add or remove a via')
        net_clr = {}
        obstacles = {L: copper_obstacles(p, b, pro, net, clr, b.GetLayerID(L), net_clr)[1] + edges for L in copper}
        for n2, s2, v2_, vs2 in new:  # the other nets of this spec
            if n2 != net:
                for L in copper:
                    obstacles[L] += [(('seg', u, v, w / 2), clr, f'new track {n2}') for u, v, L2, w in s2 if L2 == L]
                    obstacles[L] += [(('seg', q, q, vs2 / 2), clr, f'new via {n2}') for q in v2_]
        hit = first_conflict(segs, vias, via[0], obstacles)
        if hit:
            print(f'conflict: {net} {hit}; nothing written')
            sys.exit(1)
        new.append((net, segs, vias, via[0]))
        routes.append(r)
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
        json.dump({'routes': routes}, f)
    try:
        cmd_route(argparse.Namespace(board=a.board, spec=f.name))
    finally:
        os.remove(f.name)


def net_pad_pairs(p, b, net):
    """Unconnected pad pairs of a net (ratsnest, as corridor): [((name, (x, y), pad), (name, (x, y), pad))]."""
    mm = p.ToMM
    b.BuildConnectivity()
    conn = b.GetConnectivity()
    pads = {pd.m_Uuid.AsString(): pd for fp in b.GetFootprints() for pd in fp.Pads() if pd.GetNetname() == net and pd.GetNumber()}
    info = {k: (f'{pd.GetParentFootprint().GetReference()}.{pd.GetNumber()}', (mm(pd.GetPosition().x), mm(pd.GetPosition().y)), pd)
            for k, pd in pads.items()}
    root = {k: k for k in pads}

    def find(k):
        while root[k] != k:
            k = root[k]
        return k
    for k, pd in pads.items():
        for it in conn.GetConnectedItems(pd):
            if it.m_Uuid.AsString() in root:
                root[find(it.m_Uuid.AsString())] = find(k)
    groups = collections.defaultdict(list)
    for k in pads:
        groups[find(k)].append((k, info[k][1]))
    pairs = mst_pairs(sorted(groups.values(), key=lambda g: sorted(info[k][0] for k, _ in g)))
    return [(info[u], info[v]) for u, v in pairs]


def board_pad_grounds(p, b, net, grounds):
    """Per pad of the net: the ground whose (non rule area) zone outline holds the pad centre, else None."""
    zones = [(z.GetNetname(), z.Outline()) for z in b.Zones() if not z.GetIsRuleArea() and z.GetNetname() in grounds]
    return [next((n for n, o in zones if o.Contains(pd.GetPosition())), None)
            for fp in b.GetFootprints() for pd in fp.Pads() if pd.GetNetname() == net]


def fmt_mm(v):
    return f'{v:.6f}'.rstrip('0').rstrip('.')


def cmd_suggest(a):
    """A* path proposals for one unconnected pad pair, as connect lines. Reads the board, writes nothing.
    Blocked for a track centre: other-net copper + clearance + width/2, board edge, track keepouts, pours of other nets
    (a pour of the net's own ground domain, --planes, is not blocked but costs POUR_EXTRA per mm, so the path goes
    around it when it can; a ground pour of another domain blocks: isolation barrier), and the thermal spokes of pads
    in their own pour (starved_thermal).
    Blocked for a via: other-net copper on every copper layer, via keepouts, and SMD pads of any net (via-in-pad)."""
    p = pcb()
    b = p.LoadBoard(a.board)
    if b is None:
        sys.exit(f'cannot load {a.board}')
    if b.FindNet(a.net) is None:
        sys.exit(f'no net {a.net} on the board')
    mm = p.ToMM
    layers = a.layers.split(',')
    pro = json.load(open(os.path.splitext(a.board)[0] + '.kicad_pro'))
    planes = a.planes or os.path.join(os.path.dirname(os.path.abspath(a.board)), '..', '..', 'reference-planes.json')
    mixed = mixed_kinds(a.net, planes, pro)
    err = layers_error(a.net, layers, mixed)
    if not layers or err or len(set(layers)) != len(layers):
        sys.exit(f'--layers: {err or "no layer or a layer twice"}')
    lid = [b.GetLayerID(L) for L in layers]
    grounds, patterns = ground_spec(planes)
    domain = net_domain(a.net, board_pad_grounds(p, b, a.net, grounds), grounds, patterns)
    cls_name, width, clr = net_rules(pro, a.net)
    cls = {c['name']: c for c in pro['net_settings']['classes']}[cls_name]
    via_d, via_drill = cls['via_diameter'], cls['via_drill']
    pairs = net_pad_pairs(p, b, a.net)
    if not pairs:
        print(f'{a.net}: unconnected: none')
        return
    n = a.pair or 1
    if not 1 <= n <= len(pairs):
        sys.exit(f'--pair {n}: the net has {len(pairs)} pairs')
    (na, sa, pa), (nb, sb, pb) = pairs[n - 1]

    def pad_layers(pd):
        if pd.GetAttribute() in (p.PAD_ATTRIB_PTH, p.PAD_ATTRIB_NPTH):
            return {i for i, L in enumerate(lid)}
        return {i for i, L in enumerate(lid) if pd.IsOnLayer(L)}
    s_layers, t_layers = pad_layers(pa), pad_layers(pb)
    if not s_layers or not t_layers:
        sys.exit(f'{na if not s_layers else nb} is not on --layers {a.layers}')
    if a.box:
        bx = (min(a.box[0], a.box[2]), min(a.box[1], a.box[3]), max(a.box[0], a.box[2]), max(a.box[1], a.box[3]))
        if not all(bx[0] <= q[0] <= bx[2] and bx[1] <= q[1] <= bx[3] for q in (sa, sb)):
            sys.exit(f'--box must hold both pads {na} {sa} and {nb} {sb}')
    else:
        bx = (min(sa[0], sb[0]) - a.margin, min(sa[1], sb[1]) - a.margin, max(sa[0], sb[0]) + a.margin, max(sa[1], sb[1]) + a.margin)
    cell = max(a.cell, math.sqrt((bx[2] - bx[0]) * (bx[3] - bx[1]) / 250000))
    cell = round(math.ceil(cell / 0.05 - 1e-9) * 0.05, 3) if cell > a.cell else cell
    cs, rs = math.floor((sa[0] - bx[0]) / cell), math.floor((sa[1] - bx[1]) / cell)
    x0, y0 = sa[0] - cs * cell, sa[1] - rs * cell   # the start pad centre is a node
    cols, rows = math.floor((bx[2] - x0) / cell) + 1, math.floor((bx[3] - y0) / cell) + 1
    grid = (x0, y0, cell, cols, rows)
    N = cols * rows
    xy = lambda i: (x0 + (i % cols) * cell, y0 + (i // cols) * cell)
    s = rs * cols + cs
    t = min(max(0, round((sb[1] - y0) / cell)), rows - 1) * cols + min(max(0, round((sb[0] - x0) / cell)), cols - 1)
    m = 0.71 * cell                                  # a step between two free nodes then keeps the full clearance
    near = lambda sh: (lambda q: q[0] < bx[2] + 5 and q[2] > bx[0] - 5 and q[1] < bx[3] + 5 and q[3] > bx[1] - 5)(shape_box(sh))
    labels = []

    def lab_id(text):
        labels.append(text)
        return len(labels) - 1
    ds = b.GetDesignSettings()
    edge_clr = mm(ds.m_CopperEdgeClearance)
    o = p.SHAPE_POLY_SET()
    b.GetBoardPolygonOutlines(o, True)
    rings = []
    for i in range(o.OutlineCount()):
        rings += [poly_points(p, o.Outline(i))] + [poly_points(p, o.Hole(i, h)) for h in range(o.HoleCount(i))]
    edges = [(('seg', u, v, 0), edge_clr, 'board edge') for ring in rings for u, v in zip(ring, ring[1:] + ring[:1])]
    inside = bytearray(N)
    for i in poly_nodes(grid, rings):
        inside[i] = 1
    net_clr, obstacles = {}, {}
    for L in b.GetEnabledLayers().CuStack():
        obstacles[b.GetLayerName(L)] = copper_obstacles(p, b, pro, a.net, clr, L, net_clr)[1] + edges
    for name, sp in thermal_spokes(p, b, pro, a.net, clr, net_clr).items():
        obstacles[name] += sp
    ref_vias = []                                    # (shape, clearance, label): no via antipad under a fast track
    if mixed:
        adj = json.load(open(planes))['adjacent']
        kinds = {}
        kind_of = lambda n: kinds[n] if n in kinds else kinds.setdefault(n, mixed_kinds(n, planes, pro))
        for M in mixed:
            under = next((o for o, r in adj.items() if r == M), None)
            gz = [z for z in b.Zones() if not z.GetIsRuleArea() and z.IsOnLayer(b.GetLayerID(M)) and z.GetNetname() in grounds]
            if under is None or not gz:
                continue
            zc = max([clr] + [mm(z.GetLocalClearance() or 0) for z in gz])
            fast_t, mixed_t = [], []
            for tr in b.GetTracks():
                if isinstance(tr, p.PCB_VIA) or not tr.GetNetname():
                    continue
                sh = ('seg', (mm(tr.GetStart().x), mm(tr.GetStart().y)), (mm(tr.GetEnd().x), mm(tr.GetEnd().y)), mm(tr.GetWidth()) / 2)
                Ln = b.GetLayerName(tr.GetLayer())
                if Ln == under and kind_of(tr.GetNetname()).get(M) == 'fast':
                    fast_t.append((tr.GetNetname(), sh))
                elif Ln == M:
                    mixed_t.append((tr.GetNetname(), sh))
            for name, obs in reference_obstacles(a.net, mixed[M], layers, M, under, fast_t, mixed_t, zc).items():
                obstacles[name] += obs
            ref_vias += [(sh, zc, f'fast ref {under} {n}') for n, sh in fast_t if n != a.net]
    free, lab, extra = [], [], []
    for L, name in zip(lid, layers):
        f, lb, ex = bytearray(inside), [-1] * N, [0.0] * N
        for sh, c, label in obstacles[name]:
            if near(sh):
                mark_near(grid, sh, c + width / 2 + m, f, lb, lab_id(label))
        for z in b.Zones():
            if z.GetIsRuleArea() or not z.IsOnLayer(L) or z.GetNetname() == a.net:
                continue
            ol = z.Outline()
            zr = [poly_points(p, ol.Outline(k)) for k in range(ol.OutlineCount())]
            zr += [poly_points(p, ol.Hole(k, h)) for k in range(ol.OutlineCount()) for h in range(ol.HoleCount(k))]
            gnd = pour_rule(z.GetNetname(), domain) == 'cost'
            li = lab_id(f'pour {z.GetNetname() or "(no net)"}')
            for i in poly_nodes(grid, zr):
                if gnd:
                    ex[i] = POUR_EXTRA
                elif f[i]:
                    f[i], lb[i] = 0, li
        free.append(f), lab.append(lb), extra.append(ex)
    via_ok, via_lab = bytearray(inside), [-1] * N
    for name, obs in obstacles.items():
        for sh, c, label in obs:
            if near(sh):
                mark_near(grid, sh, c + via_d / 2, via_ok, via_lab, lab_id(label))  # a via sits on a node: no inflation
    for sh, c, label in ref_vias:
        if near(sh):
            mark_near(grid, sh, c + via_d / 2, via_ok, via_lab, lab_id(label))
    for z in b.Zones():
        if z.GetIsRuleArea() and z.GetDoNotAllowVias():
            mark_near(grid, ('poly', poly_points(p, z.Outline().Outline(0))), m, via_ok, via_lab, lab_id('via keepout'))
    for fp in b.GetFootprints():
        for pd in fp.Pads():
            if pd.GetAttribute() == p.PAD_ATTRIB_SMD:
                L = p.F_Cu if pd.IsOnLayer(p.F_Cu) else p.B_Cu
                sh = ('poly', poly_points(p, pd.GetEffectivePolygon(L).Outline(0)))
                if near(sh):
                    mark_near(grid, sh, via_drill / 2, via_ok, via_lab, lab_id(f'via-in-pad {fp.GetReference()}.{pd.GetNumber()}'))
    for f in free:
        f[s] = f[t] = 1

    def node(q):
        c, r = round((q[0] - x0) / cell), round((q[1] - y0) / cell)
        return r * cols + c if 0 <= c < cols and 0 <= r < rows else None

    def samples(u, v):
        n = max(1, math.ceil(math.dist(u, v) / (cell / 2)))
        return [(u[0] + (v[0] - u[0]) * j / n, u[1] + (v[1] - u[1]) * j / n) for j in range(n + 1)]

    def pour_len(segs):
        """mm of the segments in another net's GND pour (sampled at half a cell)."""
        out = 0.0
        for u, v, L, _ in segs:
            li = layers.index(L)
            q = samples(u, v)
            out += sum(math.dist(p1, p2) for p1, p2 in zip(q, q[1:]) if (lambda i: i is not None and base[li][i])(node(p1)))
        return out

    def leg_segs(u, v, L):
        q = [u] + leg(u, v)
        return [(p1, p2, L, width) for p1, p2 in zip(q, q[1:])]

    def leg_ok(u, w, v, L):
        """The direct leg u -> v may replace u -> w -> v: free on the grid (pours), clear of copper, no more GND pour."""
        new, li = leg_segs(u, v, L), layers.index(L)
        if any(node(q) is None or not free[li][node(q)] for p1, p2, _, _ in new for q in samples(p1, p2)):
            return False
        if clear_margin(new, [], via_d, {L: obstacles[L]})[0] < -1e-6:
            return False
        return pour_len(new) <= pour_len(leg_segs(u, w, L) + leg_segs(w, v, L)) + 1e-6

    def end_nodes(q, layers_i, at_start, reach=ESCAPE_MM):
        """{(node, layer): leg length} of free nodes near a pad centre q whose exact leg to q (connect geometry) is clear
        of copper at the real clearance and crosses no blocked pour. The inflated grid can close the last gap at a pad."""
        out, k = {}, math.ceil(reach / cell)
        qc, qr = round((q[0] - x0) / cell), round((q[1] - y0) / cell)
        near_obs = {}
        for li in layers_i:
            L = layers[li]
            near_obs[L] = [o for o in obstacles[L] if (lambda bx: bx[0] < q[0] + reach + 2 and bx[2] > q[0] - reach - 2 and
                                                        bx[1] < q[1] + reach + 2 and bx[3] > q[1] - reach - 2)(shape_box(o[0]))]
            for r in range(max(0, qr - k), min(rows, qr + k + 1)):
                for c in range(max(0, qc - k), min(cols, qc + k + 1)):
                    i = r * cols + c
                    u = xy(i)
                    if not free[li][i] or math.dist(u, q) > reach:
                        continue
                    segs = leg_segs(q, u, L) if at_start else leg_segs(u, q, L)
                    if not segs:
                        out[(i, li)] = 0.0
                        continue
                    if any(j is not None and lab[li][j] >= 0 and labels[lab[li][j]].startswith('pour ')
                           for p1, p2, _, _ in segs for j in map(node, samples(p1, p2))):
                        continue
                    if clear_margin(segs, [], via_d, {L: near_obs[L]})[0] >= -1e-6:
                        out[(i, li)] = sum(math.dist(p1, p2) for p1, p2, _, _ in segs)
        return out
    head = (f'pair {n} of {len(pairs)}: {na} -> {nb}; class {cls_name} w {width:g} clr {clr:g} via {via_d:g}/{via_drill:g}; '
            f'cell {cell:g} box {bx[0]:.1f},{bx[1]:.1f}..{bx[2]:.1f},{bx[3]:.1f}; {domain} pour x3 cost, other pours blocked; '
            f'.kicad_dru not used')
    print(head)
    base = [list(e) for e in extra]
    s_cost = {**end_nodes(sa, s_layers, True), **{(s, L): 0.0 for L in s_layers}}
    t_cost = {**end_nodes(sb, t_layers, False), **{(t, L): math.dist(xy(t), sb) for L in t_layers}}
    band = max(3, round(0.5 / cell))
    found, seen = [], set()
    for _ in range(a.k * 2):
        if len(found) >= a.k:
            break
        path, cost = astar((cols, rows, cell), free, via_ok, extra, s, s_layers, t, t_layers, a.via_cost, s_cost, t_cost)
        if path is None:
            if found:
                break
            far = min(cost, key=lambda i: math.dist(xy(i), sb))
            fx, fy = xy(far)
            near_labels = collections.Counter()
            for lb in lab + [via_lab]:
                for dr in range(-band * 2, band * 2 + 1):
                    for dc in range(-band * 2, band * 2 + 1):
                        c, r = far % cols + dc, far // cols + dr
                        if 0 <= c < cols and 0 <= r < rows and lb[r * cols + c] >= 0:
                            near_labels[labels[lb[r * cols + c]]] += 1
            what = ', '.join(k for k, _ in near_labels.most_common(3)) or 'box edge'
            print(f'no path: closest reach ({fx:.3f}, {fy:.3f}) is {math.dist((fx, fy), sb):.2f} mm from {nb}; '
                  f'blocked there by {what}. Try a larger --box, --layers F.Cu,B.Cu or a lower --via-cost.')
            sys.exit(1)
        L0 = layers[path[0][1]]
        vl = iter(via_layers(path))
        corners = [(k, xy(i)) + ((layers[next(vl)],) if k == 'via' else ()) for k, i in node_corners(path, cols)]
        pts = drop_jogs(path_points(sa, sb, xy(path[0][0]), corners, xy(path[-1][0])), L0, leg_ok)
        line, cur = f'{a.net} {na} -> {nb} layer={L0}', L0
        for k, q, *to in pts[1:-1]:
            if k == 'via':
                line += via_token(q, cur, to[0])
                cur = to[0]
            else:
                line += f' {k} {fmt_mm(q[0])},{fmt_mm(q[1])}'
        for (i, L) in path:                          # push the next search away from this one (a band around it)
            for dr in range(-band, band + 1):
                for dc in range(-band, band + 1):
                    c, r = i % cols + dc, i // cols + dr
                    if 0 <= c < cols and 0 <= r < rows:
                        extra[L][r * cols + c] += 1.0
        if line in seen:
            continue
        seen.add(line)
        segs, vias = expand_route(intent_route(parse_intent(line), sa, sb, L0, width, (via_d, via_drill)))
        length = sum(math.dist(u, v) for u, v, _, _ in segs)
        bends = sum(1 for (u, v, L, _), (u2, v2, L2, _) in zip(segs, segs[1:]) if L == L2 and
                    abs((v[0] - u[0]) * (v2[1] - u2[1]) - (v[1] - u[1]) * (v2[0] - u2[0])) > 1e-9)
        margin, why = clear_margin(segs, vias, via_d, obstacles)
        found.append((len(found) + 1, length, len(vias), bends, margin, why, pour_len(segs), line))
    verdicts = (verify_candidates(a.board, a.net, [f[-1] for f in found], apply=lambda bd, ln: connect_line(bd, ln, planes))
                if a.verify else [(True, '')] * len(found))
    shown = 0
    for (k, length, nv, bends, margin, why, pour, line), (ok, reason) in zip(found, verdicts):
        if not ok:
            continue
        shown += 1
        flag = f' CONFLICT to {why}' if margin < -1e-6 else ''
        mark = 'verified ' if a.verify else ''
        print(f'{shown}) {mark}len {length:.2f} vias {nv} bends {bends} margin {margin:+.3f} pour {pour:.1f}{flag}')
        print(line)
    if a.verify and shown < len(found):
        print('rejected by DRC: ' + '; '.join(f'len {f[1]:.2f} vias {f[2]}: {v[1]}' for f, v in zip(found, verdicts) if not v[0]))
    if not shown:
        sys.exit(1)


def check_drc_report(code, out):
    """The DRC report dict of a kicad-cli run with exit code `code` and report file `out`, or RuntimeError.
    Fail closed: a killed or failed run, a missing, broken or incomplete report is never read as a clean DRC."""
    if code != 0:
        raise RuntimeError(f'kicad-cli pcb drc exit {code}')
    if not os.path.exists(out):
        raise RuntimeError('kicad-cli pcb drc wrote no report')
    try:
        with open(out) as f:
            d = json.load(f)
    except ValueError:
        raise RuntimeError('kicad-cli pcb drc report is not valid JSON') from None
    if not isinstance(d, dict) or not isinstance(d.get('violations'), list) or not isinstance(d.get('unconnected_items'), list):
        raise RuntimeError('kicad-cli pcb drc report has no violations / unconnected_items lists')
    return d


def drc_refill(board):
    """DRC report dict (--refill-zones) of a board, or RuntimeError (check_drc_report)."""
    out = os.path.join(os.path.dirname(board), 'suggest-drc.json')
    r = subprocess.run([KICAD_CLI, 'pcb', 'drc', '--refill-zones', '--format', 'json', '-o', out, board],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    return check_drc_report(r.returncode, out)


def connect_line(board, line, planes=None):
    """Apply one connect line to a board with this tool, or RuntimeError."""
    r = subprocess.run([sys.executable, os.path.abspath(__file__), 'connect', board, line,
                        *(['--planes', os.path.abspath(planes)] if planes else [])], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError('connect: ' + ((r.stdout + r.stderr).strip().splitlines() or ['failed'])[-1][:120])


def verify_candidates(board, net, lines, drc=drc_refill, apply=connect_line):
    """[(ok, reason)] per connect line: DRC with the line applied, on temp copies of the project folder, against the DRC
    of an unchanged copy (verify_verdict). Up to 8 in parallel. The board is not changed. Fail closed: a failed baseline
    DRC exits non-zero; a failed apply or candidate DRC rejects that candidate."""
    import concurrent.futures
    import shutil
    import tempfile
    board = os.path.abspath(board)
    src = os.path.dirname(board)

    def run(line):
        with tempfile.TemporaryDirectory() as d:
            proj = os.path.join(d, os.path.basename(src))
            shutil.copytree(src, proj, ignore=shutil.ignore_patterns('*.lck', '*.step', '*.stp', '*.wrl', '*-backups'))
            bd = os.path.join(proj, os.path.basename(board))
            try:
                if line is not None:
                    apply(bd, line)
                return drc(bd), ''
            except Exception as e:
                return None, str(e) or type(e).__name__
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(lines) + 1)) as ex:
        res = list(ex.map(run, [None] + lines))
    if res[0][0] is None:
        sys.exit(f'baseline DRC failed: {res[0][1]}; no candidate is verified')
    return [verify_verdict(res[0][0], d, net) if d is not None else (False, why) for d, why in res[1:]]


string_letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'


def cmd_stitch(a):
    """A ground via (class size) within --r mm of each via of NET that has none (kicad-happy RP-001). The ground is the
    net's domain (--planes). Each spot is clearance-checked like suggest: other-net copper on every layer, board edge,
    via keepouts, SMD pads, other-net pours, other ground vias. A via without room: nothing is written, exit 1
    (--best-effort: the other vias are written, exit 0)."""
    p = pcb()
    b = p.LoadBoard(a.board)
    if b is None or b.FindNet(a.net) is None:
        sys.exit(f'cannot load {a.board} or no net {a.net}')
    mm = p.ToMM
    pro = json.load(open(os.path.splitext(a.board)[0] + '.kicad_pro'))
    grounds, patterns = ground_spec(a.planes or os.path.join(os.path.dirname(os.path.abspath(a.board)), '..', '..',
                                                             'reference-planes.json'))
    gnd = net_domain(a.net, board_pad_grounds(p, b, a.net, grounds), grounds, patterns)
    if gnd is None or gnd == a.net:
        sys.exit(f'{a.net}: no single ground domain; set "domains" in the planes spec')
    cls_name, _, clr = net_rules(pro, gnd)
    cls = {c['name']: c for c in pro['net_settings']['classes']}[cls_name]
    via_d, via_drill = cls['via_diameter'], cls['via_drill']
    o = p.SHAPE_POLY_SET()
    b.GetBoardPolygonOutlines(o, True)
    edge_clr = mm(b.GetDesignSettings().m_CopperEdgeClearance)
    edges = []
    for i in range(o.OutlineCount()):
        for pts in [poly_points(p, o.Outline(i))] + [poly_points(p, o.Hole(i, h)) for h in range(o.HoleCount(i))]:
            edges += [(('seg', u, v, 0), edge_clr, 'board edge') for u, v in zip(pts, pts[1:] + pts[:1])]
    net_clr = {}
    obstacles = {b.GetLayerName(L): copper_obstacles(p, b, pro, gnd, clr, L, net_clr)[1] + edges
                 for L in b.GetEnabledLayers().CuStack()}
    keepouts = [z.Outline() for z in b.Zones() if z.GetIsRuleArea() and z.GetDoNotAllowVias()]
    pours = [z.Outline() for z in b.Zones() if not z.GetIsRuleArea() and z.GetNetname() != gnd]
    vias = [(t.GetNetname(), (mm(t.GetPosition().x), mm(t.GetPosition().y))) for t in b.GetTracks() if isinstance(t, p.PCB_VIA)]
    gv = [q for n, q in vias if n == gnd]
    pt_ = lambda q: p.VECTOR2I(p.FromMM(q[0]), p.FromMM(q[1]))

    def room(q):
        if any(k.Contains(pt_(q)) or k.Distance(pt_(q)) < p.FromMM(via_d / 2) for k in keepouts):
            return False
        if any(z.Contains(pt_(q)) for z in pours):
            return False
        if any(math.dist(q, g) < via_d + clr for g in gv):
            return False
        return clear_margin([], [q], via_d, obstacles)[0] >= -1e-6
    added, miss = [], []
    for n, q in vias:
        if n != a.net or not needs_stitch(q, gv, a.r):
            continue
        spot = next((c for c in stitch_spots(q, a.r) if room(c)), None)
        if spot is None:
            miss.append(q)
            continue
        added.append(spot)
        gv.append(spot)
    if miss:
        print(f'{a.net}: no room for a {gnd} via within {a.r:g} mm of ' + ', '.join(f'({x:.3f}, {y:.3f})' for x, y in miss) +
              ('; best effort: the others are placed' if a.best_effort else '; nothing written'))
        if not a.best_effort:
            sys.exit(1)
    for q in added:
        v = p.PCB_VIA(b)
        v.SetPosition(pt_(q))
        v.SetWidth(p.FromMM(via_d))
        v.SetDrill(p.FromMM(via_drill))
        v.SetNet(b.FindNet(gnd))
        b.Add(v)
    if added:
        p.ZONE_FILLER(b).Fill(b.Zones())
        b.Save(a.board)
    print(f'{a.net}: added {len(added)} {gnd} vias {via_d:g}/{via_drill:g}' + ''.join(f' ({x:.3f}, {y:.3f})' for x, y in added))


def pd_on(side, layer, p):
    return side == 'THT' or (side == 'F') == (layer == p.F_Cu)


def cmd_netcheck(a):
    """DRC (--schematic-parity --refill-zones) on a temp copy of the project folder; one line + the net's items."""
    import shutil
    import tempfile
    board = os.path.abspath(a.board)
    if f'"{a.net}"' not in open(board).read():
        sys.exit(f'no net {a.net} on the board')
    src = os.path.dirname(board)
    with tempfile.TemporaryDirectory() as d:
        proj = os.path.join(d, os.path.basename(src))
        shutil.copytree(src, proj, ignore=shutil.ignore_patterns('*.lck', '*.step', '*.stp', '*.wrl', '*-backups'))
        out = os.path.join(d, 'drc.json')
        subprocess.run([KICAD_CLI, 'pcb', 'drc', '--schematic-parity', '--refill-zones', '--format', 'json', '-o', out,
                        os.path.join(proj, os.path.basename(board))],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        if not os.path.exists(out):
            sys.exit('kicad-cli pcb drc wrote no report')
        with open(out) as f:
            text, ok = net_check(json.load(f), a.net, None if a.budget else 3)
    print(text)
    sys.exit(0 if ok else 1)


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
    s = sp.add_parser('unroute'); s.add_argument('board'); s.add_argument('nets', nargs='+')
    s.add_argument('--no-drc', action='store_true', help='no DRC summary after the removal'); s.set_defaults(f=cmd_unroute)
    s = sp.add_parser('near'); s.add_argument('board'); s.add_argument('x', type=float); s.add_argument('y', type=float)
    s.add_argument('--r', type=float, default=0.3); s.add_argument('--within', type=float, default=1.0); s.set_defaults(f=cmd_near)
    s = sp.add_parser('widen'); s.add_argument('board'); s.add_argument('net'); s.add_argument('width', type=float)
    s.add_argument('--layer'); s.add_argument('--box', type=float, nargs=4); s.set_defaults(f=cmd_widen)
    s = sp.add_parser('drc'); s.add_argument('board'); s.set_defaults(f=cmd_drc)
    s = sp.add_parser('corridor'); s.add_argument('board'); s.add_argument('net')
    s.add_argument('--margin', type=float, default=3.0); s.add_argument('--cell', type=float, default=0.25)
    s.add_argument('--pair', type=int, help='map only this pair (1 = first listed)')
    s.add_argument('--box', type=float, nargs=4, metavar=('X1', 'Y1', 'X2', 'Y2'), help='map only this window')
    s.set_defaults(f=cmd_corridor)
    s = sp.add_parser('connect'); s.add_argument('board'); s.add_argument('spec', help='intent file, or one intent line')
    s.add_argument('--planes', help='reference-planes.json: mixed layers (default: two folders above the board)')
    s.set_defaults(f=cmd_connect)
    s = sp.add_parser('suggest'); s.add_argument('board'); s.add_argument('net')
    s.add_argument('--pair', type=int, help='pad pair as corridor lists it (default 1)')
    s.add_argument('--box', type=float, nargs=4, metavar=('X1', 'Y1', 'X2', 'Y2'), help='search only this window')
    s.add_argument('--layers', default='F.Cu,B.Cu', help='F.Cu, B.Cu and mixed layers of --planes (slow nets only)'); s.add_argument('--via-cost', type=float, default=8.0, help='mm of track')
    s.add_argument('--k', type=int, default=3); s.add_argument('--margin', type=float, default=3.0)
    s.add_argument('--cell', type=float, default=0.1)
    s.add_argument('--verify', action='store_true', help='DRC each candidate on a temp copy; print only the clean ones')
    s.add_argument('--planes', help='reference-planes.json: grounds and domains (default: two folders above the board; '
                                    'no file = GND only). Own-domain ground pour costs, other pours block')
    s.set_defaults(f=cmd_suggest)
    s = sp.add_parser('stitch'); s.add_argument('board'); s.add_argument('net')
    s.add_argument('--r', type=float, default=1.0, help='max mm from a signal via to a ground via')
    s.add_argument('--best-effort', action='store_true', help='place the vias that fit; a via without room is not an error')
    s.add_argument('--planes', help='reference-planes.json (default: two folders above the board; no file = GND)')
    s.set_defaults(f=cmd_stitch)
    s = sp.add_parser('netcheck'); s.add_argument('board'); s.add_argument('net'); s.set_defaults(f=cmd_netcheck)
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
    for name in BUDGET_KINDS:
        sp.choices[name].add_argument('--budget', type=int, nargs='?', const=2000, metavar='N',
                                      help='cut the output to N chars (default 2000) and name what was cut')
    a = ap.parse_args()
    if not getattr(a, 'budget', None):
        return a.f(a)
    import contextlib
    import io
    buf, code = io.StringIO(), None
    try:
        with contextlib.redirect_stdout(buf):
            a.f(a)
    except SystemExit as e:
        code = e
    kind, keep_last = BUDGET_KINDS[a.cmd]
    lines = buf.getvalue().splitlines()
    if lines:
        print('\n'.join(budget_cut(lines, a.budget, kind, keep_last)))
    if code is not None:
        raise code


if __name__ == '__main__':
    from hard_exit import hard_exit
    hard_exit(main)
