#!/usr/bin/env python3
"""power_pour: DC power rails as pours (In2.Cu by default; --layer F.Cu or B.Cu for an outer-layer pour, W14 2026-10-11).
Each power pad gets a short stub to its vias; a pad on the pour layer touches the pour and gets none. The autorouter then
routes only the signals.

Run with the KiCad bundled Python (it has pcbnew):
  PY=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
  $PY tools/power_pour.py plan  BOARD     --nets N1 N2 ... --currents current-paths.json --fast FILE|none
  $PY tools/power_pour.py apply BOARD OUT --nets N1 N2 ... --currents current-paths.json --fast FILE|none
Nets: --nets N1 N2 ... (a name that starts with a dash, such as -15V, is a net too), --nets-file FILE (one net
per line, # comment), or both.
Options: --margin 1.5 (region grows this far around the pads), --gap 0.2 (pad edge to via ring), --connect
thermal|solid (THT pads in the pour), --grounds GND, --allow REF.PAD ... (via in that SMD pad is allowed),
--region NET=x0,y0,x1,y1 and --minus NET=x0,y0,x1,y1 (repeat them), --cut-margin 0.5, --layer In2.Cu|F.Cu|B.Cu.
plan prints the regions, the via plan per pad and the conflicts, and changes nothing. apply writes OUT (never the
input) with the zones, stubs and vias, after a refill. Exit 1 on any conflict; apply then writes nothing.

Rules (fail closed):
- A switch node (name token SW or LX), a net in the fast list (fnmatch patterns, {"fast": [...]}) or a ground is
  refused. In1.Cu stays solid GND; this tool writes zones on the --layer (In2.Cu, F.Cu or B.Cu; never In1.Cu), and
  stubs on the pad layer. The zone priority is one above the zones already on that layer (above an outer GND pour).
- One region per rail net: the convex hull of its pad corners and vias grown by the margin, clipped to the board box. Two
  regions closer than the plane clearance are a conflict (the placer must group the rail pads).
- Vias per pad: n = ceil(amps / pcbtool.via_amps(drill)), minimum 1. The amps of a pad are the largest chain through
  it in current-paths.json (the pcbtool paths spec); a pad that is not in the spec gets 1 via. THT pads get none.
  Each pad uses the via of its own net class; the regions of all nets are checked together.
- A pad whose own tracks already reach a via or a THT pad of its net is "already connected": no new via.
- Keep-out cuts (holes in the zone, grown by the clearance + --cut-margin): fast-net tracks on the pour layer and on
  the layer it is the reference of (In2.Cu pour: B.Cu and In2.Cu tracks keep In2 GND under them, D-124; an outer pour:
  its own layer), THT pads of another net with its own zone on the pour layer (their thermal), and the
  --minus boxes. A cut that cuts off a planned via, an anchor or a THT pad from the rest of the pour is a
  conflict ('isolated'). New vias keep out of the cuts.
- --region NET=x0,y0,x1,y1 limits a pour to a box: its pads outside the box (or in a --minus box) are listed as
  TRACKS (route with tracks) and are not in the hull.
- A via never touches an SMD pad unless --allow names REF.PAD; it keeps the class clearance to other-net copper and
  hole-to-hole to its own net, and it lies inside its region.
Coordinates: KiCad mm, Y down.
"""
import argparse
import collections
import fnmatch
import importlib.util
import itertools
import json
import math
import os
import re
import shutil
import sys

_spec = importlib.util.spec_from_file_location('pcbtool', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pcbtool.py'))
pt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pt)

SWITCH = re.compile(r'(^|[/_])(SW|LX)\d*($|_)')
DISK_N = 16
LAYERS = ('F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu')
EXTRA = (0, 0.25, 0.5, 1.0, 1.5)       # more distance from the pad when the first via spot is blocked (4 sides, then 4 corners)
REF_LAYER = 'B.Cu'                     # standard stackup: B.Cu uses In2.Cu as its reference plane
CUT_LAYERS = {'In2.Cu': (REF_LAYER, 'In2.Cu'), 'F.Cu': ('F.Cu',), 'B.Cu': ('B.Cu',)}   # fast tracks that cut a pour on the key layer
FILL_MIN = 0.25                        # zone min thickness; a via needs this much fill around it


# ---------- pure core ----------

def convex_hull(pts):
    pts = sorted(set((round(x, 6), round(y, 6)) for x, y in pts))
    if len(pts) < 3:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, hi = [], []
    for q in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], q) <= 0:
            lo.pop()
        lo.append(q)
    for q in reversed(pts):
        while len(hi) >= 2 and cross(hi[-2], hi[-1], q) <= 0:
            hi.pop()
        hi.append(q)
    return lo[:-1] + hi[:-1]


def grow(pts, margin):
    """Convex hull of the points grown by margin (each point as a 16-gon that holds the circle of radius margin)."""
    r = margin / math.cos(math.pi / DISK_N)
    return convex_hull([(x + r * math.cos(2 * math.pi * k / DISK_N), y + r * math.sin(2 * math.pi * k / DISK_N))
                        for x, y in pts for k in range(DISK_N)])


def clip_box(poly, box):
    """Sutherland-Hodgman clip of a polygon to box (x0, y0, x1, y1)."""
    edges = [(0, box[0], 1), (0, box[2], -1), (1, box[1], 1), (1, box[3], -1)]   # (axis, limit, keep side)
    out = list(poly)
    for ax, lim, s in edges:
        src, out = out, []
        for i, q in enumerate(src):
            prv = src[i - 1]
            qin, pin = (q[ax] - lim) * s >= 0, (prv[ax] - lim) * s >= 0
            if qin != pin:
                t = (lim - prv[ax]) / (q[ax] - prv[ax])
                out.append((prv[0] + t * (q[0] - prv[0]), prv[1] + t * (q[1] - prv[1])))
            if qin:
                out.append(q)
        if not out:
            break
    return out


def poly_gap(a, b):
    """Edge-to-edge gap of two polygons; 0 when they overlap or one holds the other."""
    if any(pt.in_poly(q, b) for q in a) or any(pt.in_poly(q, a) for q in b):
        return 0
    return min(pt.seg_seg_dist(p, q, r, s) for p, q in zip(a, a[1:] + a[:1]) for r, s in zip(b, b[1:] + b[:1]))


def regions(pads_by_net, box, margin, clearance, boxes=None):
    """({net: polygon}, [(net, net, gap)]): one In2 region per rail net, clipped to the board box and to the net's
    own box in boxes; a gap below clearance is a conflict."""
    boxes = boxes or {}
    reg = {n: clip_box(grow(pts, margin), box) for n, pts in sorted(pads_by_net.items())}
    reg = {n: clip_box(poly, boxes[n]) if n in boxes else poly for n, poly in reg.items()}
    conf = []
    for a, b in itertools.combinations(sorted(reg), 2):
        g = poly_gap(reg[a], reg[b])
        if g < clearance:
            conf.append((a, b, round(g, 3)))
    return reg, conf


def refused(net, fast, grounds):
    """The reason this net must not be poured, or None."""
    if net in grounds:
        return 'ground net (In1.Cu is the solid GND plane)'
    if any(fnmatch.fnmatchcase(net, f) for f in fast):
        return 'fast net (tier-1 list)'
    if SWITCH.search(net):
        return 'switch node'
    return None


def pad_currents(spec, net):
    """{REF.PAD: amps}: the largest chain current through each pad of net in a pcbtool paths spec."""
    out = {}
    n = spec['nets'].get(net)
    for ch in (n.get('chains', [n]) if n else []):
        for q in ch['pads']:
            out[q] = max(out.get(q, 0), ch['amps'])
    return out


def via_count(amps, via):
    return max(1, math.ceil(amps / pt.via_amps(via['drill'], via['plating'], via['dT']) - 1e-9))


def _unit(a):
    t = math.radians(a)
    return (math.cos(t), math.sin(t)), (-math.sin(t), math.cos(t))


def _spot_ok(p, vias, stub, via, rules, obstacles, smd, region, allow, taken):
    r = via['dia'] / 2
    for v in vias:
        if -pt.shape_dist(('poly', region), v) < r + FILL_MIN:
            return 'outside its region'
        for name, sp in smd:
            if name not in allow and pt.hole_in_pad((v[0], v[1], r), sp):
                return f'touches SMD pad {name}'
        for q, net, qr in taken:
            need = max(via['dia'], via['drill'] + rules['h2h']) if net == p['net'] else r + qr + rules['clr']
            if math.dist(v, q) < need - 1e-9:
                return f'near new via of {net}'
    segs = [(stub[0], stub[1], p['layer'], stub[2])] if stub else []
    return pt.first_conflict(segs, vias, via['dia'], obstacles)


def via_plan(p, amps, via, rules, obstacles, smd, region, allow=(), taken=()):
    """Vias and one stub for an SMD power pad. p: {name, net, c, size (w, h), angle (deg, pcbtool hole_in_pad
    frame), fp_c (footprint centre), layer}. obstacles: {layer: [(shape, clearance, label)]} of other-net copper.
    smd: [(REF.PAD, (cx, cy, w, h, angle, corner_r))] of all SMD pads. The result has 'vias' and 'stub'
    ((a, b, width) or None), or 'error' when no spot is free (fail closed). A 'via' key in p (the pad's own class
    via) replaces the via argument. taken: [(point, net, radius)] of the new vias so far."""
    via = p.get('via', via)
    n = via_count(amps, via)
    c = tuple(p['c'])
    w, h = p['size']
    u, v = _unit(p['angle'])
    out = (c[0] - p['fp_c'][0], c[1] - p['fp_c'][1])
    dirs = sorted([(u, w / 2, h), ((-u[0], -u[1]), w / 2, h), (v, h / 2, w), ((-v[0], -v[1]), h / 2, w)],
                  key=lambda d: -(d[0][0] * out[0] + d[0][1] * out[1]))
    step = max(via['dia'] + rules['clr'], via['drill'] + rules['h2h'])
    tries = [(dirs[0][0], 0.0, min(dirs[0][2], via['dia']))] if p['name'] in allow else []
    tries += [(d, half + rules['gap'] + via['dia'] / 2 + e, min(perp, via['dia'])) for e in EXTRA for d, half, perp in dirs]
    # then the 4 corners: the first via at gap + radius (+ extra) from the pad corner, the row goes on diagonally
    for e in EXTRA:
        k = (rules['gap'] + via['dia'] / 2 + e) / math.sqrt(2)
        for su, sv in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
            q = (su * (w / 2 + k), sv * (h / 2 + k))
            dist = math.hypot(*q)
            d = ((su * u[0] * abs(q[0]) + sv * v[0] * abs(q[1])) / dist, (su * u[1] * abs(q[0]) + sv * v[1] * abs(q[1])) / dist)
            tries.append((d, dist, min(w, h, via['dia'])))
    why = None
    for d, d0, width in tries:
        vias = [(round(c[0] + d[0] * (d0 + k * step), 4), round(c[1] + d[1] * (d0 + k * step), 4)) for k in range(n)]
        stub = None if vias[-1] == c else (c, vias[-1], width)
        why = _spot_ok(p, vias, stub, via, rules, obstacles, smd, region, allow, taken)
        if why is None:
            return {'pad': p['name'], 'net': p['net'], 'n': n, 'amps': amps, 'vias': vias, 'stub': stub,
                    'via': (via['dia'], via['drill'])}
    return {'pad': p['name'], 'net': p['net'], 'n': n, 'amps': amps, 'error': f'no free spot for {n} via(s); last: {why}'}


def plan_all(pads, amps_by_pad, via, rules, obstacles_by_net, smd, regions_by_net, allow=()):
    """via_plan for each pad, in the pad order. The new vias and stubs of one net are obstacles for the others.
    A THT pad needs no via; a pad with an 'anchor' (its own copper already reaches a via or a THT pad of the net)
    is 'connected' and gets no new via; a pad on the pour layer ('direct') touches the pour and gets none."""
    out, new, taken = [], [], []
    for p in pads:
        if p.get('th') or p.get('anchor') or p.get('direct'):
            r = {'pad': p['name'], 'net': p['net'], 'n': 0, 'amps': amps_by_pad.get(p['name'], 0), 'vias': [], 'stub': None}
            if p.get('direct'):
                r['direct'] = True
            elif not p.get('th'):
                r['connected'] = tuple(p['anchor'])
            out.append(r)
            continue
        obs = {L: list(items) for L, items in obstacles_by_net[p['net']].items()}
        for net, L, shape in new:
            if net == p['net']:
                continue
            for lay in (obs if L is None else [L]):
                obs.setdefault(lay, []).append((shape, rules['clr'], f'new copper {net}'))
        r = via_plan(p, amps_by_pad.get(p['name'], 0), via, rules, obs, smd, regions_by_net[p['net']], allow, taken)
        out.append(r)
        if 'vias' in r:
            vr = r['via'][0] / 2
            taken += [(q, p['net'], vr) for q in r['vias']]
            new += [(p['net'], None, ('seg', q, q, vr)) for q in r['vias']]
            if r['stub']:
                a, b, w = r['stub']
                new.append((p['net'], p['layer'], ('seg', a, b, w / 2)))
    return out


def reached_anchor(p, tracks, vias, th):
    """The first via or THT pad of the net that the pad's own tracks reach, or None. tracks: [(a, b, width)] of the
    net on the pad layer; vias: [(centre, radius)]; th: [(REF.PAD, centre, (w, h), angle)]. Items connect when they
    touch: a track end in a pad, a track end on another track, a via on a track."""
    box = (*p['c'], *p['size'], p['angle'], 0)
    for c, r in vias:                            # via in the pad
        if pt.hole_in_pad((c[0], c[1], r), box):
            return tuple(c)
    seen = {i for i, (a, b, w) in enumerate(tracks) if any(pt.hole_in_pad((q[0], q[1], w / 2), box) for q in (a, b))}
    todo = list(seen)
    while todo:
        a, b, w = tracks[todo.pop()]
        for c, r in vias:
            if pt.seg_dist(c, a, b) <= r + 1e-6:
                return tuple(c)
        for _, c, (tw, th_), ang in th:
            if any(pt.hole_in_pad((q[0], q[1], w / 2), (c[0], c[1], tw, th_, ang, 0)) for q in (a, b)):
                return tuple(c)
        for j, (a2, b2, w2) in enumerate(tracks):
            if j not in seen and (min(pt.seg_dist(q, a, b) for q in (a2, b2)) <= w / 2 + 1e-6
                                  or min(pt.seg_dist(q, a2, b2) for q in (a, b)) <= w2 / 2 + 1e-6):
                seen.add(j)
                todo.append(j)
    return None


def pad_corners(p):
    """The 4 corners of the pad box (size, angle): the region margin counts from the pad edge."""
    (u, v), (w, h) = _unit(p['angle']), p['size']
    return [(p['c'][0] + su * u[0] * w / 2 + sv * v[0] * h / 2, p['c'][1] + su * u[1] * w / 2 + sv * v[1] * h / 2)
            for su in (1, -1) for sv in (1, -1)]


def rect(b):
    return [(b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3])]


def in_box(q, b):
    return b[0] <= q[0] <= b[2] and b[1] <= q[1] <= b[3]


def split_pads(pads_by_net, boxes, minus):
    """({net: pads in the pour}, [(net, REF.PAD) to route with tracks]). A net with a box keeps only the pads inside
    it and outside its minus boxes; an anchor outside the box does not reach the pour, so it is dropped."""
    inside, tracks = {}, []
    for n, ps in pads_by_net.items():
        keep = []
        for q in ps:
            if n in boxes and (not in_box(q['c'], boxes[n]) or any(in_box(q['c'], m) for m in minus.get(n, []))):
                tracks.append((n, q['name']))
                continue
            if n in boxes and q.get('anchor') and not in_box(q['anchor'], boxes[n]):
                q = {k: v for k, v in q.items() if k != 'anchor'}
            keep.append(q)
        inside[n] = keep
    return inside, tracks


def cut_seg(a, b, r):
    """Keep-out cut around a track a-b: every point within r of the segment (a stadium polygon)."""
    return grow([a, b], r)


def pour_islands(poly, holes, points, cell=0.25):
    """Indices of the points that the pour (poly minus holes, raster of cell mm) does not join: a point in no
    free cell, or in a piece other than the one that holds the most points. Sorted."""
    xs, ys = [q[0] for q in poly], [q[1] for q in poly]
    x0, y0 = min(xs), min(ys)
    nx, ny = int((max(xs) - x0) / cell) + 1, int((max(ys) - y0) / cell) + 1
    free = [[pt.in_poly((x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell), poly) for i in range(nx)] for j in range(ny)]
    for h in holes:
        bx = pt.shape_box(('poly', h))
        for j in range(max(0, int((bx[1] - y0) / cell) - 2), min(ny, int((bx[3] - y0) / cell) + 3)):
            for i in range(max(0, int((bx[0] - x0) / cell) - 2), min(nx, int((bx[2] - x0) / cell) + 3)):
                if free[j][i] and pt.shape_dist(('poly', h), (x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell)) < FILL_MIN / 2:
                    free[j][i] = False
    comp, label = {}, 0
    for j in range(ny):
        for i in range(nx):
            if free[j][i] and (i, j) not in comp:
                todo, comp[(i, j)] = [(i, j)], label
                while todo:
                    ci, cj = todo.pop()
                    for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        k = (ci + di, cj + dj)
                        if 0 <= k[0] < nx and 0 <= k[1] < ny and free[k[1]][k[0]] and k not in comp:
                            comp[k] = label
                            todo.append(k)
                label += 1
    of = [comp.get((int((q[0] - x0) / cell), int((q[1] - y0) / cell))) for q in points]
    counts = collections.Counter(c for c in of if c is not None)
    main = counts.most_common(1)[0][0] if counts else None
    return [k for k, c in enumerate(of) if c is None or c != main]


def plan_rails(pads_by_net, amps_by_pad, via, rules, obstacles_by_net, smd, box, margin, allow=(), boxes=None, cuts=None,
               layer='In2.Cu'):
    """(regions, conflicts, plans, holes). The vias are spotted first (inside the board box and the net box, out of
    the net's cuts); then each region grows by the margin around the pad edges and the vias of its net, so a via
    next to an edge pad is inside its pour. holes: {net: the cuts that touch its region} (keep-outs in the zone).
    A pad whose via, anchor or THT pad the holes cut off from the rest of the pour gets an 'isolated' error."""
    boxes, cuts = boxes or {}, cuts or {}
    board = rect(box)
    via_reg = {n: clip_box(rect(boxes[n]), box) if n in boxes else board for n in pads_by_net}
    obs = {}
    for n in pads_by_net:
        obs[n] = {L: list(v) for L, v in obstacles_by_net[n].items()}
        obs[n].setdefault(layer, [])
        obs[n][layer] += [(('poly', c), FILL_MIN, f'keep-out cut of {n}') for c in cuts.get(n, [])]
    order = [q for n in sorted(pads_by_net) for q in pads_by_net[n]]
    plans = plan_all(order, amps_by_pad, via, rules, obs, smd, via_reg, allow)
    pts = {n: [k for q in ps for k in pad_corners(q)] for n, ps in pads_by_net.items() if ps}
    for r in plans:
        pts[r['net']] += r.get('vias', []) + ([r['connected']] if 'connected' in r else [])
    reg, conf = regions(pts, box, margin, rules['clr'], boxes)
    holes = {n: [c for c in cuts.get(n, []) if poly_gap(c, poly) == 0] for n, poly in reg.items()}
    centre = {q['name']: tuple(q['c']) for ps in pads_by_net.values() for q in ps}
    for n, poly in reg.items():
        own = [r for r in plans if r['net'] == n and 'error' not in r]
        spots = [(r, q) for r in own for q in (r['vias'] or [r.get('connected', centre[r['pad']])])]
        for k in pour_islands(poly, holes[n], [q for _, q in spots]):
            r = spots[k][0]
            if 'error' not in r:
                r.pop('vias', None)
                r['error'] = 'isolated from the pour by a keep-out cut'
    return reg, conf, plans, holes


# ---------- pcbnew edge ----------

def load_fast(arg):
    if arg == 'none':
        return []
    return json.load(open(arg))['fast']


def class_of(pro, net):
    name = pt.net_rules(pro, net)[0]
    return next(c for c in pro['net_settings']['classes'] if c['name'] == name)


def smd_pads(p, b):
    mm, out = p.ToMM, []
    for fp in b.GetFootprints():
        for pd in fp.Pads():
            if pd.GetAttribute() != p.PAD_ATTRIB_SMD or not pd.GetNumber():
                continue
            lay = p.F_Cu if pd.IsOnLayer(p.F_Cu) else p.B_Cu
            sh, size = pd.GetShape(lay), pd.GetSize(lay)
            w, h = mm(size.x), mm(size.y)
            cr = {p.PAD_SHAPE_RECT: 0, p.PAD_SHAPE_ROUNDRECT: mm(pd.GetRoundRectCornerRadius(lay))}.get(sh, min(w, h) / 2 if sh in (p.PAD_SHAPE_OVAL, p.PAD_SHAPE_CIRCLE) else 0)
            c = pd.GetPosition()
            out.append((f'{fp.GetReference()}.{pd.GetNumber()}', (mm(c.x), mm(c.y), w, h, -pd.GetOrientation().AsDegrees(), cr)))
    return out


def rail_pads(p, b, net):
    mm, out = p.ToMM, []
    for fp in b.GetFootprints():
        for pd in fp.Pads():
            if pd.GetNetname() != net or not pd.GetNumber():
                continue
            lay = p.F_Cu if pd.IsOnLayer(p.F_Cu) else p.B_Cu
            size = pd.GetSize(lay)
            out.append({'name': f'{fp.GetReference()}.{pd.GetNumber()}', 'net': net,
                        'c': (mm(pd.GetPosition().x), mm(pd.GetPosition().y)), 'size': (mm(size.x), mm(size.y)),
                        'angle': -pd.GetOrientation().AsDegrees(), 'fp_c': (mm(fp.GetPosition().x), mm(fp.GetPosition().y)),
                        'layer': b.GetLayerName(lay), 'th': pd.GetAttribute() == p.PAD_ATTRIB_PTH})
    return out


def make_plan(p, b, pro, a):
    """Everything plan and apply need: regions, conflicts, via plans, class data. Pure core does the decisions."""
    fast = load_fast(a.fast)
    spec = json.load(open(a.currents))
    rules_d = pro['board']['design_settings']['rules']
    bad = [(n, why) for n in a.nets for why in [refused(n, fast, a.grounds)] if why]
    bad += [(n, '--region/--minus net is not in --nets') for n in set(a.region) | set(a.minus) if n not in a.nets]
    missing = [n for n in a.nets if b.FindNet(n) is None]
    cls = {n: class_of(pro, n) for n in a.nets if n not in missing}
    clr = max([c['clearance'] for c in cls.values()] + [0.0])
    rules = {'clr': clr, 'h2h': rules_d.get('min_hole_to_hole', 0.25), 'gap': a.gap, 'edge': rules_d.get('min_copper_edge_clearance', 0.3)}
    bb = b.GetBoardEdgesBoundingBox()
    mm = p.ToMM
    e = rules['edge']
    box = (mm(bb.GetLeft()) + e, mm(bb.GetTop()) + e, mm(bb.GetRight()) - e, mm(bb.GetBottom()) - e)
    pads = {n: rail_pads(p, b, n) for n in cls}
    missing += [n for n, ps in pads.items() if not ps]   # a net with no pads is refused, not skipped
    pads = {n: ps for n, ps in pads.items() if ps}
    net_clr, obst = {}, {}
    for n in cls:
        obst[n] = {L: pt.copper_obstacles(p, b, pro, n, cls[n]['clearance'], b.GetLayerID(L), net_clr)[1] for L in LAYERS}
    vias = {n: {'dia': c['via_diameter'], 'drill': c['via_drill'], 'plating': spec.get('via_plating_mm', 0.018),
                'dT': spec.get('dT', 10.0)} for n, c in cls.items()}
    for n, ps in pads.items():   # each pad: the via of its own class, and the anchor its own copper already reaches
        cu = net_copper(p, b, n)
        for q in ps:
            q['via'] = vias[n]
            if not q['th'] and q['layer'] == a.layer:
                q['direct'] = True
            elif not q['th']:
                q['anchor'] = reached_anchor(q, cu['tracks'].get(q['layer'], []), cu['vias'], cu['th'])
    via = next(iter(vias.values()), None)
    amps = {}
    for n in cls:
        amps.update(pad_currents(spec, n))
    pads, tracks = split_pads(pads, a.region, a.minus)
    pads = {n: ps for n, ps in pads.items() if ps}
    cuts, kinds = make_cuts(p, b, fast, list(pads), a.region, a.minus, box, clr + a.cut_margin, a.layer)
    reg, conf, plans, holes = plan_rails(pads, amps, via, rules, obst, smd_pads(p, b), box, a.margin, a.allow,
                                         a.region, cuts, a.layer)
    in2 = in2_cuts(p, b, reg, a.layer)
    layer = {q['name']: q['layer'] for ps in pads.values() for q in ps}
    used = {n: collections.Counter(kinds[n][id(c)] for c in holes[n]) for n in holes}
    return {'bad': bad, 'missing': missing, 'regions': reg, 'conflicts': conf, 'plans': plans, 'rules': rules,
            'classes': cls, 'in2_other': in2, 'layer': layer, 'holes': holes, 'tracks': tracks, 'cut_kinds': used}


def make_cuts(p, b, fast, nets, boxes, minus, board, r, layer='In2.Cu'):
    """({net: [cut polygons]}, {net: {id(cut): kind}}) in the net box (or the board box): fast-net tracks on the
    CUT_LAYERS of the pour layer grown by r + half width, THT pads of other nets that have a zone on the pour layer
    grown by r (In2.Cu pour only: their thermal; an outer-layer pour keeps the class clearance in the fill), and the
    minus boxes."""
    mm = p.ToMM
    lay2 = b.GetLayerID(layer)
    in2_nets = {z.GetNetname() for z in b.Zones() if z.IsOnLayer(lay2) and not z.GetIsRuleArea() and z.GetNetname()}
    segs = [((mm(t.GetStart().x), mm(t.GetStart().y)), (mm(t.GetEnd().x), mm(t.GetEnd().y)), mm(t.GetWidth()))
            for t in b.GetTracks() if t.GetLayerName() in CUT_LAYERS[layer] and not isinstance(t, p.PCB_VIA)
            and any(fnmatch.fnmatchcase(t.GetNetname(), f) for f in fast)]
    tht = [(pd.GetNetname(), (mm(pd.GetPosition().x), mm(pd.GetPosition().y)), (mm(pd.GetSize(p.F_Cu).x), mm(pd.GetSize(p.F_Cu).y)),
            -pd.GetOrientation().AsDegrees()) for fp in b.GetFootprints() for pd in fp.Pads()
           if pd.GetAttribute() == p.PAD_ATTRIB_PTH and pd.GetNetname() in in2_nets]
    cuts, kinds = {}, {}
    for n in nets:
        area = boxes.get(n, board)
        near = (area[0] - r - 1, area[1] - r - 1, area[2] + r + 1, area[3] + r + 1)
        cs = [('fast track', cut_seg(a, e, w / 2 + r)) for a, e, w in segs if in_box(a, near) or in_box(e, near)]
        cs += [('THT pad', grow(pad_corners({'c': c, 'size': sz, 'angle': ang}), r)) for net, c, sz, ang in tht
               if net != n and in_box(c, near) and layer == 'In2.Cu']   # an outer pour keeps the class clearance itself
        cs += [('minus box', rect(m)) for m in minus.get(n, [])]
        cuts[n] = [c for _, c in cs]
        kinds[n] = {id(c): k for k, c in cs}
    return cuts, kinds


def net_copper(p, b, net):
    """{'tracks': {layer: [(a, b, width)]}, 'vias': [(centre, radius)], 'th': [(REF.PAD, centre, (w, h), angle)]}."""
    mm = p.ToMM
    out = {'tracks': collections.defaultdict(list), 'vias': [], 'th': []}
    for t in b.GetTracks():
        if t.GetNetname() != net:
            continue
        if isinstance(t, p.PCB_VIA):
            out['vias'].append(((mm(t.GetPosition().x), mm(t.GetPosition().y)), mm(t.GetWidth(p.F_Cu)) / 2))
        else:
            out['tracks'][t.GetLayerName()].append(((mm(t.GetStart().x), mm(t.GetStart().y)), (mm(t.GetEnd().x), mm(t.GetEnd().y)), mm(t.GetWidth())))
    for q in rail_pads(p, b, net):
        if q['th']:
            out['th'].append((q['name'], q['c'], q['size'], q['angle']))
    return out


def in2_cuts(p, b, reg, layer='In2.Cu'):
    """{net: count of other-net track segments on the pour layer with an end inside its region} (they cut the pour)."""
    mm, out = p.ToMM, {}
    lay = b.GetLayerID(layer)
    segs = [(t.GetNetname(), (mm(t.GetStart().x), mm(t.GetStart().y)), (mm(t.GetEnd().x), mm(t.GetEnd().y)))
            for t in b.GetTracks() if t.GetLayer() == lay and not isinstance(t, p.PCB_VIA)]
    for n, poly in reg.items():
        out[n] = sum(1 for m, s, e in segs if m != n and (pt.in_poly(s, poly) or pt.in_poly(e, poly)))
    return out


def print_plan(pl, verbose):
    for n, why in pl['bad']:
        print(f'REFUSED {n}: {why}')
    for n in pl['missing']:
        print(f'REFUSED {n}: no such net or no pads on the board')
    for n, poly in pl['regions'].items():
        xs, ys = [q[0] for q in poly], [q[1] for q in poly]
        area = abs(sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(poly, poly[1:] + poly[:1]))) / 2
        ps = [r for r in pl['plans'] if r['net'] == n]
        print(f'REGION {n}: box ({min(xs):.1f}, {min(ys):.1f})-({max(xs):.1f}, {max(ys):.1f}), {area:.0f} mm2, '
              f"{len(ps)} pads, {sum(len(r.get('vias', [])) for r in ps)} vias, "
              f"{sum(1 for r in ps if 'connected' in r)} already connected, "
              f"{sum(1 for r in ps if r['n'] == 0 and 'connected' not in r and 'direct' not in r)} THT, "
              f"{sum(1 for r in ps if 'direct' in r)} on the pour layer, {pl['in2_other'][n]} other-net track ends inside")
    for a, b, g in pl['conflicts']:
        print(f'CONFLICT regions {a} / {b}: gap {g} mm < {pl["rules"]["clr"]} mm')
    for n, k in pl['cut_kinds'].items():
        if k:
            print(f'CUTS {n}: ' + ', '.join(f'{v} {kind}' for kind, v in sorted(k.items())) + ' (keep-outs in the zone)')
    for n in sorted({n for n, _ in pl['tracks']}):
        names = [q for m, q in pl['tracks'] if m == n]
        print(f'TRACKS {n}: {len(names)} pads outside the pour, route with tracks: ' + ' '.join(names))
    for r in pl['plans']:
        if 'error' in r:
            print(f"CONFLICT via {r['net']} {r['pad']} ({r['amps']} A, {r['n']} via): {r['error']}")
        elif verbose and 'connected' in r:
            print(f"  {r['net']} {r['pad']} already connected: own copper reaches ({r['connected'][0]:.3f}, {r['connected'][1]:.3f})")
        elif verbose and r['n']:
            print(f"  {r['net']} {r['pad']} {r['amps']} A -> {r['n']} via at " + ' '.join(f'({x:.3f}, {y:.3f})' for x, y in r['vias'])
                  + (f" stub w {r['stub'][2]:.2f}" if r['stub'] else ' in pad'))
    nbad = len(pl['bad']) + len(pl['missing']) + len(pl['conflicts']) + sum(1 for r in pl['plans'] if 'error' in r)
    print(f'{nbad} conflicts')
    return nbad


def cmd_plan(a):
    p = pt.pcb()
    b = p.LoadBoard(a.board)
    if b is None:
        sys.exit(f'cannot load {a.board}')
    pro = json.load(open(os.path.splitext(a.board)[0] + '.kicad_pro'))
    pl = make_plan(p, b, pro, a)
    sys.exit(1 if print_plan(pl, a.verbose) else 0)


def cmd_apply(a):
    if os.path.realpath(a.out) == os.path.realpath(a.board):
        sys.exit('OUT is the input board: refused (write a copy)')
    p = pt.pcb()
    b = p.LoadBoard(a.board)
    if b is None:
        sys.exit(f'cannot load {a.board}')
    pro = json.load(open(os.path.splitext(a.board)[0] + '.kicad_pro'))
    pl = make_plan(p, b, pro, a)
    if print_plan(pl, a.verbose):
        print('nothing written')
        sys.exit(1)
    lay = b.GetLayerID(a.layer)
    prio = max([z.GetAssignedPriority() for z in b.Zones() if z.IsOnLayer(lay) and not z.GetIsRuleArea()] + [-1]) + 1
    for n, poly in pl['regions'].items():
        z = p.ZONE(b)
        z.SetLayer(lay)
        z.SetNet(b.FindNet(n))
        z.SetZoneName('PWR_' + re.sub(r'[^A-Za-z0-9]+', '_', n).strip('_'))
        z.SetAssignedPriority(prio)
        z.SetLocalClearance(p.FromMM(pl['classes'][n]['clearance']))
        z.SetMinThickness(p.FromMM(FILL_MIN))
        z.SetPadConnection(p.ZONE_CONNECTION_FULL if a.connect == 'solid' else p.ZONE_CONNECTION_THERMAL)
        z.Outline().NewOutline()
        for x, y in poly:
            z.Outline().Append(p.FromMM(x), p.FromMM(y))
        if pl['holes'][n]:
            cut = p.SHAPE_POLY_SET()
            for h in pl['holes'][n]:
                cut.NewOutline()
                for x, y in h:
                    cut.Append(p.FromMM(x), p.FromMM(y))
            cut.Simplify()
            z.Outline().BooleanSubtract(cut)
            if z.Outline().OutlineCount() != 1:
                sys.exit(f'zone {n}: the cuts split the outline into {z.Outline().OutlineCount()} pieces; nothing written')
        b.Add(z)
    nv = ns = 0
    for r in pl['plans']:
        net = b.FindNet(r['net'])
        if r['stub']:
            (x0, y0), (x1, y1), w = r['stub']
            t = p.PCB_TRACK(b)
            t.SetStart(pt.v2(x0, y0))
            t.SetEnd(pt.v2(x1, y1))
            t.SetLayer(b.GetLayerID(pl['layer'][r['pad']]))
            t.SetWidth(p.FromMM(w))
            t.SetNet(net)
            b.Add(t)
            ns += 1
        for x, y in r['vias']:
            v = p.PCB_VIA(b)
            v.SetPosition(pt.v2(x, y))
            v.SetWidth(p.FromMM(r['via'][0]))
            v.SetDrill(p.FromMM(r['via'][1]))
            v.SetNet(net)
            b.Add(v)
            nv += 1
    p.ZONE_FILLER(b).Fill(b.Zones())
    src, dst = os.path.splitext(a.board)[0], os.path.splitext(a.out)[0]
    for ext in ('.kicad_pro', '.kicad_dru'):   # the gates need the rules next to the copy
        if os.path.exists(src + ext) and not os.path.exists(dst + ext):
            shutil.copyfile(src + ext, dst + ext)
    b.Save(a.out)
    print(f"wrote {a.out}: {len(pl['regions'])} {a.layer} zones (priority {prio}), {ns} stubs, {nv} vias")


LIST_OPTS = ('--nets', '--region', '--minus')


def nets_argv(argv):
    """Each token after --nets, --region or --minus (up to the next --option) becomes --OPT=TOKEN, so a net such as
    -15V is a value."""
    out, opt = [], None
    for t in argv:
        if t in LIST_OPTS:
            opt = t
        elif t.startswith('--'):
            opt = None
            out.append(t)
        elif opt:
            out.append(f'{opt}={t}')
        else:
            out.append(t)
    return out


def net_boxes(items, ap, name):
    """[NET=x0,y0,x1,y1, ...] -> [(net, box)]; a bad item is an argument error."""
    out = []
    for it in items:
        net, _, val = it.rpartition('=')
        try:
            box = tuple(float(v) for v in val.split(','))
        except ValueError:
            box = ()
        if not net or len(box) != 4 or box[0] >= box[2] or box[1] >= box[3]:
            ap.error(f'{name} {it!r}: give NET=x0,y0,x1,y1 with x0 < x1 and y0 < y1')
        out.append((net, box))
    return out


def parse_args(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    for name in ('plan', 'apply'):
        s = sub.add_parser(name)
        s.add_argument('board')
        if name == 'apply':
            s.add_argument('out')
        s.add_argument('--nets', action='append', default=[], help='net names; repeat or list them')
        s.add_argument('--nets-file', help='one net per line; # starts a comment')
        s.add_argument('--region', action='append', default=[], help='NET=x0,y0,x1,y1: the pour box of the net')
        s.add_argument('--minus', action='append', default=[], help='NET=x0,y0,x1,y1: a keep-out box in that pour')
        s.add_argument('--cut-margin', type=float, default=0.5, help='keep-out cut margin around fast tracks and THT pads')
        s.add_argument('--layer', choices=sorted(CUT_LAYERS), default='In2.Cu', help='the pour layer (never In1.Cu)')
        s.add_argument('--currents', required=True)
        s.add_argument('--fast', required=True, help='fast-net file {"fast": [patterns]}, or none')
        s.add_argument('--grounds', nargs='+', default=['GND'])
        s.add_argument('--margin', type=float, default=1.5)
        s.add_argument('--gap', type=float, default=0.2)
        s.add_argument('--connect', choices=('thermal', 'solid'), default='thermal')
        s.add_argument('--allow', nargs='*', default=[])
        s.add_argument('--verbose', action='store_true')
    a = ap.parse_args(nets_argv(argv))
    if a.nets_file:
        a.nets += [x.split('#')[0].strip() for x in open(a.nets_file) if x.split('#')[0].strip()]
    if not a.nets:
        ap.error('no nets: give --nets or --nets-file')
    a.region = dict(net_boxes(a.region, ap, '--region'))
    minus = {}
    for n, bx in net_boxes(a.minus, ap, '--minus'):
        minus.setdefault(n, []).append(bx)
    a.minus = minus
    return a


def main():
    a = parse_args(sys.argv[1:])
    {'plan': cmd_plan, 'apply': cmd_apply}[a.cmd](a)


if __name__ == '__main__':
    main()
