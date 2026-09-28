#!/usr/bin/env python3
"""power_pour: DC power rails as In2.Cu pours. Each power pad gets a short stub to its vias; the autorouter then
routes only the signals.

Run with the KiCad bundled Python (it has pcbnew):
  PY=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
  $PY tools/power_pour.py plan  BOARD     --nets N1 N2 ... --currents current-paths.json --fast FILE|none
  $PY tools/power_pour.py apply BOARD OUT --nets N1 N2 ... --currents current-paths.json --fast FILE|none
Nets: --nets N1 N2 ... (a name that starts with a dash, such as -15V, is a net too), --nets-file FILE (one net
per line, # comment), or both.
Options: --margin 1.5 (region grows this far around the pads), --gap 0.2 (pad edge to via ring), --connect
thermal|solid (THT pads in the pour), --grounds GND, --allow REF.PAD ... (via in that SMD pad is allowed).
plan prints the regions, the via plan per pad and the conflicts, and changes nothing. apply writes OUT (never the
input) with the zones, stubs and vias, after a refill. Exit 1 on any conflict; apply then writes nothing.

Rules (fail closed):
- A switch node (name token SW or LX), a net in the fast list (fnmatch patterns, {"fast": [...]}) or a ground is
  refused. In1.Cu stays solid GND; this tool writes only In2.Cu zones, and stubs on the pad layer.
- One region per rail net: the convex hull of its pad corners and vias grown by the margin, clipped to the board box. Two
  regions closer than the plane clearance are a conflict (the placer must group the rail pads).
- Vias per pad: n = ceil(amps / pcbtool.via_amps(drill)), minimum 1. The amps of a pad are the largest chain through
  it in current-paths.json (the pcbtool paths spec); a pad that is not in the spec gets 1 via. THT pads get none.
  Each pad uses the via of its own net class; the regions of all nets are checked together.
- A pad whose own tracks already reach a via or a THT pad of its net is "already connected": no new via.
- A region over (or within the clearance of) a B.Cu or In2.Cu track of a fast net is a conflict: the fast net
  needs the In2 ground under it.
- A region that holds a THT pad of another net with In2.Cu copper (its own In2 zone) is a conflict: the
  higher-priority rail pour takes that In2 thermal (starved thermal). A via of that net passes (In2 antipad).
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


def regions(pads_by_net, box, margin, clearance):
    """({net: polygon}, [(net, net, gap)]): one In2 region per rail net; a gap below clearance is a conflict."""
    reg = {n: clip_box(grow(pts, margin), box) for n, pts in sorted(pads_by_net.items())}
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
    is 'connected' and gets no new via."""
    out, new, taken = [], [], []
    for p in pads:
        if p.get('th') or p.get('anchor'):
            r = {'pad': p['name'], 'net': p['net'], 'n': 0, 'amps': amps_by_pad.get(p['name'], 0), 'vias': [], 'stub': None}
            if not p.get('th'):
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


def fast_over(regions_by_net, segs, clearance):
    """[(rail, fast net, segments)]: fast-net segments on the layer that uses In2.Cu as reference (B.Cu), inside a
    rail region or nearer than clearance to it. A pour there takes the ground away from the fast net."""
    hits = collections.Counter()
    for rail, poly in regions_by_net.items():
        for net, a, b in segs:
            if pt.shape_seg_dist(('poly', poly), a, b) < clearance:
                hits[(rail, net)] += 1
    return [(r, n, k) for (r, n), k in sorted(hits.items())]


def foreign_in2(regions_by_net, items, in2_nets):
    """[(rail, net, count, first label)]: THT pads of another net with In2.Cu copper (its own In2 zone) inside a
    rail region. The rail pour (higher priority) takes their In2 thermal away (starved thermal). A via passes: it
    goes through In2 with an antipad and keeps its net on the other layers. items: [(label, net, point, kind)],
    kind 'tht' or 'via'."""
    hits = {}
    for rail, poly in regions_by_net.items():
        for label, net, q, kind in items:
            if kind == 'tht' and net != rail and net in in2_nets and pt.in_poly(q, poly):
                k = hits.setdefault((rail, net), [0, label])
                k[0] += 1
    return [(r, n, k, lab) for (r, n), (k, lab) in sorted(hits.items())]


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


def plan_rails(pads_by_net, amps_by_pad, via, rules, obstacles_by_net, smd, box, margin, allow=()):
    """(regions, conflicts, plans). The vias are spotted first (inside the board box); then each region grows by
    the margin around the pad edges and the vias of its net, so a via next to an edge pad is inside its pour."""
    x0, y0, x1, y1 = box
    board = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    order = [q for n in sorted(pads_by_net) for q in pads_by_net[n]]
    plans = plan_all(order, amps_by_pad, via, rules, obstacles_by_net, smd, {n: board for n in pads_by_net}, allow)
    pts = {n: [k for q in ps for k in pad_corners(q)] for n, ps in pads_by_net.items() if ps}
    for r in plans:
        pts[r['net']] += r.get('vias', []) + ([r['connected']] if 'connected' in r else [])
    reg, conf = regions(pts, box, margin, rules['clr'])
    return reg, conf, plans


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
            if not q['th']:
                q['anchor'] = reached_anchor(q, cu['tracks'].get(q['layer'], []), cu['vias'], cu['th'])
    via = next(iter(vias.values()), None)
    amps = {}
    for n in cls:
        amps.update(pad_currents(spec, n))
    reg, conf, plans = plan_rails(pads, amps, via, rules, obst, smd_pads(p, b), box, a.margin, a.allow)
    in2 = in2_cuts(p, b, reg)
    ref = [(t.GetNetname(), (mm(t.GetStart().x), mm(t.GetStart().y)), (mm(t.GetEnd().x), mm(t.GetEnd().y)))
           for t in b.GetTracks() if t.GetLayerName() in (REF_LAYER, 'In2.Cu') and not isinstance(t, p.PCB_VIA)
           and any(fnmatch.fnmatchcase(t.GetNetname(), f) for f in fast)]
    fast_hits = fast_over(reg, ref, clr)
    lay2 = b.GetLayerID('In2.Cu')
    in2_nets = {z.GetNetname() for z in b.Zones() if z.IsOnLayer(lay2) and not z.GetIsRuleArea() and z.GetNetname()}
    items = [(f'PTH pad {fp.GetReference()}.{pd.GetNumber()}', pd.GetNetname(), (mm(pd.GetPosition().x), mm(pd.GetPosition().y)), 'tht')
             for fp in b.GetFootprints() for pd in fp.Pads() if pd.GetAttribute() == p.PAD_ATTRIB_PTH]
    foreign = foreign_in2(reg, items, in2_nets)
    layer = {q['name']: q['layer'] for ps in pads.values() for q in ps}
    return {'bad': bad, 'missing': missing, 'regions': reg, 'conflicts': conf, 'plans': plans, 'rules': rules,
            'classes': cls, 'in2_other': in2, 'layer': layer,
            'fast_over': fast_hits, 'foreign': foreign}


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


def in2_cuts(p, b, reg):
    """{net: count of other-net In2.Cu track segments with an end inside its region} (they cut the pour)."""
    mm, out = p.ToMM, {}
    lay = b.GetLayerID('In2.Cu')
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
              f"{sum(1 for r in ps if r['n'] == 0 and 'connected' not in r)} THT, {pl['in2_other'][n]} other-net In2 track ends inside")
    for a, b, g in pl['conflicts']:
        print(f'CONFLICT regions {a} / {b}: gap {g} mm < {pl["rules"]["clr"]} mm')
    for rail, net, k in pl['fast_over']:
        print(f'CONFLICT region {rail} lies over {k} {REF_LAYER}/In2.Cu segments of fast net {net} (In2 GND is its reference)')
    for rail, net, k, lab in pl['foreign']:
        print(f'CONFLICT region {rail} holds {k} THT pads of {net}, which has In2.Cu copper (first: {lab}); '
              'the pour takes their In2 connection')
    for r in pl['plans']:
        if 'error' in r:
            print(f"CONFLICT via {r['net']} {r['pad']} ({r['amps']} A, {r['n']} via): {r['error']}")
        elif verbose and 'connected' in r:
            print(f"  {r['net']} {r['pad']} already connected: own copper reaches ({r['connected'][0]:.3f}, {r['connected'][1]:.3f})")
        elif verbose and r['n']:
            print(f"  {r['net']} {r['pad']} {r['amps']} A -> {r['n']} via at " + ' '.join(f'({x:.3f}, {y:.3f})' for x, y in r['vias'])
                  + (f" stub w {r['stub'][2]:.2f}" if r['stub'] else ' in pad'))
    nbad = len(pl['bad']) + len(pl['missing']) + len(pl['conflicts']) + len(pl['fast_over']) + len(pl['foreign']) + sum(1 for r in pl['plans'] if 'error' in r)
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
    lay = b.GetLayerID('In2.Cu')
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
    print(f"wrote {a.out}: {len(pl['regions'])} In2.Cu zones (priority {prio}), {ns} stubs, {nv} vias")


def nets_argv(argv):
    """Each token after --nets (up to the next --option) becomes --nets=TOKEN, so a net such as -15V is a value."""
    out, in_nets = [], False
    for t in argv:
        if t == '--nets':
            in_nets = True
        elif t.startswith('--'):
            in_nets = False
            out.append(t)
        elif in_nets:
            out.append('--nets=' + t)
        else:
            out.append(t)
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
    return a


def main():
    a = parse_args(sys.argv[1:])
    {'plan': cmd_plan, 'apply': cmd_apply}[a.cmd](a)


if __name__ == '__main__':
    main()
