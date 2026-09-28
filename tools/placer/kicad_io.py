"""KiCad board <-> placement problem (pcbnew; run with the KiCad bundled Python).

read_problem(board) -> problem dict (see cost.py)
  Units: a PCB group with footprints; else a block = a closed User.1 rectangle and the footprints
  whose anchor is inside it (the User.1 border and label move with it); else one footprint.
  Origin: the centre of the block border, else the centre of the courtyard boxes.
  Fixed: locked footprints, mounting holes (ref H<n> or a MountingHole footprint), connectors
  (J/P/CN) whose courtyard is within edge_dist of the outline (not wholly outside it: staged), parts on B.Cu, refs in `fix`
  (fnmatch), and units whose origin is outside `free_box`. A unit with one fixed part is fixed.
  Rects: F.CrtYd box per footprint (else pads + 0.25 mm); spacing class 1.0 mm for IC and
  connector refs (U, J, P, CN, K, SW, Y, X), 0.5 mm for the rest (D-040), or the largest net-class
  clearance of the part pads when that is larger (mains classes). A block also has its
  border box as a rect of class 0 (its copper stays inside the border).
  Pads: every pad centre of the unit (pin RUDY). Pins: one box per (net, unit) of the pad centres. Nets matching `skip` (default GND) and nets
  inside one unit are left out.
  Keepouts: rule areas that do not allow footprints or whose name matches `keepout_zones`, and closed shapes
  on `keepout_layers`. Rule areas named in `zone_refs` move with the unit of their ref (_edges_and_block_zones).
  Edge anchors: `edges` {ref: (sides, courtyard side)} (cost.edge_miss).
  Copper: the tracks and vias that stay whatever the movable units do (kept_copper); cost.py counts
  them as used routing capacity and (F.Cu, vias) as obstacles.
  Region: nets with a pad on `region_refs` get weight `region_weight`; RUDY cells in `region_box`
  (default: the courtyard box of the region refs grown by 15 mm) count region_weight times.

write_board(board, problem, pose, out) -> report dict
  Each moved unit turns by r * 90 deg about its origin, then moves to the new origin. Its
  footprints, its block border and label, and the tracks inside its block border move rigidly.
  Other tracks and vias: each copper cluster (connected by end points) that touches a pad of a
  moved unit is removed, and so is each cluster that now collides (own clearance rules) with a moved
  pad or moved block copper of another net. Zones stay (refill them in the DRC). The result goes to `out` only.
"""
import fnmatch
import json
import math
import os
import re

import pcbnew

from . import cost, dru

M = 1e6
IC_PREFIX = ('U', 'J', 'P', 'CN', 'K', 'SW', 'Y', 'X')
LABEL_DIST = 3.0   # a User.1 text this close to a block border is its label
BLOCK_SHARE = 0.6  # a part is in a block when its anchor and this share of its courtyard are inside


def mm(v):
    return v / M


def ref_prefix(ref):
    m = re.match(r'[A-Za-z_]+', ref)
    return m.group(0) if m else ''


def poly_points(chain):
    return [[mm(chain.CPoint(k).x), mm(chain.CPoint(k).y)] for k in range(chain.PointCount())]


def shape_polygon(sh):
    """Closed PCB_SHAPE -> polygon [[x, y], ...] or None."""
    kind = sh.GetShape()
    if kind in (pcbnew.SHAPE_T_RECT, getattr(pcbnew, 'SHAPE_T_RECTANGLE', -1)):
        a, b = sh.GetStart(), sh.GetEnd()
        x0, x1 = sorted((mm(a.x), mm(b.x)))
        y0, y1 = sorted((mm(a.y), mm(b.y)))
        return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    if kind == pcbnew.SHAPE_T_POLY:
        ps = sh.GetPolyShape()
        if ps.OutlineCount():
            return poly_points(ps.Outline(0))
    return None


def bbox_of(poly):
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    return (min(xs), min(ys), max(xs), max(ys))


def inside_box(x, y, b):
    return b[0] <= x <= b[2] and b[1] <= y <= b[3]


def fp_rect(fp):
    c = fp.GetCourtyard(pcbnew.F_CrtYd)
    if c.OutlineCount():  # the outline points: BBox() adds about 0.05 mm per side
        pts = [c.Outline(k).CPoint(j) for k in range(c.OutlineCount()) for j in range(c.Outline(k).PointCount())]
        return (mm(min(q.x for q in pts)), mm(min(q.y for q in pts)), mm(max(q.x for q in pts)), mm(max(q.y for q in pts)))
    xs, ys = [], []
    for p in fp.Pads():
        bb = p.GetBoundingBox()
        xs += [mm(bb.GetX()), mm(bb.GetRight())]
        ys += [mm(bb.GetY()), mm(bb.GetBottom())]
    if not xs:
        q = fp.GetPosition()
        xs, ys = [mm(q.x)], [mm(q.y)]
    return (min(xs) - .25, min(ys) - .25, max(xs) + .25, max(ys) + .25)


def _round_courtyard(fp):
    """(centre x, centre y, radius) when the courtyard is one circle (a test point), else None."""
    g = [d for d in fp.GraphicalItems() if d.GetLayer() == pcbnew.F_CrtYd]
    if len(g) == 1 and g[0].GetShape() == pcbnew.SHAPE_T_CIRCLE:
        c = g[0].GetCenter()
        return (mm(c.x), mm(c.y), round(mm(g[0].GetRadius()), 6))
    return None


def is_mounting_hole(fp):
    return bool(re.fullmatch(r'H\d+', fp.GetReference())) or 'mountinghole' in fp.GetFPIDAsString().lower()


def outline_of(board):
    ps = pcbnew.SHAPE_POLY_SET()
    if not board.GetBoardPolygonOutlines(ps, False) or not ps.OutlineCount():
        raise ValueError('no closed board outline on Edge.Cuts')
    holes = [poly_points(ps.Hole(0, h)) for h in range(ps.HoleCount(0))]
    return poly_points(ps.Outline(0)), holes


def block_borders(board):
    """User.1 closed shapes -> [(box, [uuid, ...])] with the User.1 texts inside each box."""
    lay = board.GetLayerID('User.1')
    shapes, texts = [], []
    for d in board.GetDrawings():
        if d.GetLayer() != lay:
            continue
        if d.GetClass() == 'PCB_SHAPE':
            poly = shape_polygon(d)
            if poly:
                shapes.append((bbox_of(poly), d))
        elif 'TEXT' in d.GetClass():
            texts.append(d)
    out = [(box, [d.m_Uuid.AsString()], None) for box, d in shapes]
    for t in texts:
        q = t.GetPosition()
        x, y = mm(q.x), mm(q.y)
        dist = [max(b[0] - x, x - b[2], b[1] - y, y - b[3], 0.0) for b, _, _ in out]
        if dist and min(dist) <= LABEL_DIST:
            k = dist.index(min(dist))
            out[k][1].append(t.m_Uuid.AsString())
            if out[k][2] is None:
                out[k] = (out[k][0], out[k][1], t.GetText())
    return out


def _tie(fps, member, tie, skip):
    """A loose part with <= 3 pads joins the unit of the nearest part with > 3 pads (an IC) that shares a
    net (not `skip`) and whose courtyard is within `tie` mm. Decoupling and support parts stay with their IC."""
    nets = {fp.GetReference(): {p.GetNetname() for p in fp.Pads() if p.GetNetname()
                                and not any(fnmatch.fnmatchcase(p.GetNetname(), s) for s in skip)} for fp in fps}
    ics = [fp for fp in fps if len(fp.Pads()) > 3]
    joins = {}
    for fp in fps:
        r = fp.GetReference()
        if r in member or len(fp.Pads()) > 3 or is_mounting_hole(fp) or fp.IsLocked():
            continue
        c = fp_rect(fp)
        best = None
        for ic in ics:
            q = fp_rect(ic)
            gap = max(q[0] - c[2], c[0] - q[2], q[1] - c[3], c[1] - q[3])
            if gap <= tie and nets[r] & nets[ic.GetReference()] and (best is None or gap < best[0]):
                best = (gap, ic.GetReference())
        if best:
            joins[r] = best[1]
    for r, ic in joins.items():
        member[r] = member.setdefault(ic, 'F:' + ic)


def is_test_point(ref):
    return ref_prefix(ref) == 'TP'


def pad_gap(a, b):
    """Edge-to-edge distance (mm) of the bounding boxes of two pads."""
    p, q = a.GetBoundingBox(), b.GetBoundingBox()
    dx = max(q.GetX() - p.GetRight(), p.GetX() - q.GetRight(), 0)
    dy = max(q.GetY() - p.GetBottom(), p.GetY() - q.GetBottom(), 0)
    return math.hypot(dx, dy) / M


def _join(member, r, anchor):
    """Part r joins the unit of anchor, if r has no unit yet."""
    if r not in member:
        member[r] = member.setdefault(anchor, 'F:' + anchor)


def _rigid(fps, member, patterns):
    """All parts on a net that matches a pattern and has an inductor pad (a buck switch node) join the unit of
    the part with the most pads."""
    nets = {}
    for fp in fps:
        if is_test_point(fp.GetReference()) or is_mounting_hole(fp):
            continue
        for p in fp.Pads():
            n = p.GetNetname()
            if n and any(fnmatch.fnmatchcase(n, pat) for pat in patterns):
                nets.setdefault(n, {})[fp.GetReference()] = fp
    for n in sorted(nets):
        if not any(ref_prefix(r) == 'L' for r in nets[n]):
            continue  # a switch node has an inductor (SWDIO/SWCLK match *SW* but are not one)
        parts = sorted(nets[n].values(), key=lambda f: (-len(f.Pads()), f.GetReference()))
        for fp in parts[1:]:
            _join(member, fp.GetReference(), parts[0].GetReference())


def _decaps(fps, member, dist):
    """A 2-pad capacitor with one pad on GND whose other pad is within `dist` mm (pad edge to pin) of a pin
    of the same net on an IC (U, > 3 pads) joins the unit of the nearest such IC (a hard tie).
    Returns [[cap, ic, gap], ...] for every such cap (also caps that already had a unit)."""
    ics = [f for f in fps if len(f.Pads()) > 3 and ref_prefix(f.GetReference()) == 'U']
    out = []
    for fp in fps:
        r = fp.GetReference()
        pads = list(fp.Pads())
        nets = [p.GetNetname() for p in pads]
        if ref_prefix(r) != 'C' or len(pads) != 2 or 'GND' not in nets or nets.count('GND') == 2:
            continue
        pw = [p for p in pads if p.GetNetname() != 'GND' and p.GetNetname()]
        best = None
        for ic in ics:
            for pin in ic.Pads():
                if pw and pin.GetNetname() == pw[0].GetNetname():
                    g = pad_gap(pw[0], pin)
                    if best is None or g < best[0]:
                        best = (g, ic.GetReference())
        if best and best[0] <= dist:
            out.append([r, best[1], round(best[0], 6)])
            _join(member, r, best[1])
    return out


def read_problem(path, fix=(), skip=('GND',), edge_dist=1.5, keepout_layers=(), free_box=None,
                 region_refs=(), region_weight=1.0, region_box=None, spacing=(0.5, 1.0), tie=0.0,
                 rigid_nets=(), decap_tie=0.0, keepout_zones=(), edges=None, zone_refs=None, domains=None, via_nets=()):
    board = pcbnew.LoadBoard(path)
    holes, pairs, ignored = [], [], []
    if domains is None:  # single source: the board .kicad_dru
        dp = os.path.splitext(path)[0] + '.kicad_dru'
        r = dru.parse(open(dp).read()) if os.path.exists(dp) else {'domains': [], 'holes': [], 'pairs': [],
                                                                     'ignored': []}
        domains, holes, pairs, ignored = r['domains'], r['holes'], r['pairs'], r['ignored']
    rules = {'domains': domains, 'holes': holes, 'pairs': pairs}  # for the mains path check (mainspath.py)
    hole_gap = {ref: g for _, refs, g in holes for ref in refs}
    dom_ids = {}  # net class of a domain -> class id (1, 2, ...)
    outline, holes = outline_of(board)
    locked = [t for t in board.GetTracks() if t.IsLocked()]  # fixed copper: the writer never removes it
    keepouts = [h for h in holes]
    for z in board.Zones():
        if z.GetIsRuleArea() and z.Outline().OutlineCount() and (
                (z.GetDoNotAllowFootprints() and z.GetLayerSet().Contains(pcbnew.F_Cu))  # all parts are on top
                or any(fnmatch.fnmatchcase(z.GetZoneName(), p) for p in keepout_zones)):
            keepouts.append(poly_points(z.Outline().Outline(0)))
    via_keepouts = [poly_points(z.Outline().Outline(0)) for z in board.Zones()  # vias pass all layers
                    if z.GetIsRuleArea() and z.GetDoNotAllowVias() and z.Outline().OutlineCount()
                    and z.GetZoneName() not in (zone_refs or {})]
    lays = {board.GetLayerID(n) for n in keepout_layers}
    for d in board.GetDrawings():
        if d.GetLayer() in lays and d.GetClass() == 'PCB_SHAPE':
            poly = shape_polygon(d)
            if poly:
                keepouts.append(poly)
    edge = mm(board.GetDesignSettings().m_CopperEdgeClearance)  # DRC copper-to-edge: the band for pads

    fps = list(board.GetFootprints())
    member = {}  # ref -> unit key
    units = {}   # key -> dict
    for g in board.Groups():
        if g.GetParentGroup():
            continue
        refs = [it.GetReference() for it in g.GetItems() if it.GetClass() == 'FOOTPRINT']
        if refs:
            key = 'G:' + g.m_Uuid.AsString()
            units[key] = {'name': g.GetName() or refs[0], 'refs': [], 'borders': [], 'box': None,
                          'group': g.m_Uuid.AsString()}
            for r in refs:
                member[r] = key
    for k, (box, ids, label) in enumerate(block_borders(board)):
        inside = []
        for fp in fps:
            q = fp.GetPosition()
            c = fp_rect(fp)
            share = (max(0, min(c[2], box[2]) - max(c[0], box[0])) * max(0, min(c[3], box[3]) - max(c[1], box[1]))
                     / max((c[2] - c[0]) * (c[3] - c[1]), 1e-9))
            if (fp.GetReference() not in member and not is_test_point(fp.GetReference())
                    and inside_box(mm(q.x), mm(q.y), box) and share >= BLOCK_SHARE):
                inside.append(fp.GetReference())
        if len(inside) < 2:  # a block has 2 or more parts; a border around one part is stale
            continue
        key = 'B:%d' % k
        units[key] = {'name': label or 'BLOCK%d' % (k + 1), 'refs': [], 'borders': ids, 'box': list(box)}
        for r in inside:
            member[r] = key
    by_ref = {fp.GetReference(): fp for fp in fps}
    for fp in fps:  # test points: own unit, spacing 0, no pads or pins in the cost
        if is_test_point(fp.GetReference()):
            member[fp.GetReference()] = 'F:' + fp.GetReference()
    if rigid_nets:
        _rigid(fps, member, list(rigid_nets))
    decaps = _decaps(fps, member, decap_tie) if decap_tie > 0 else []
    if tie > 0:
        _tie(fps, member, tie, list(skip))
    for fp in fps:
        r = fp.GetReference()
        key = member.setdefault(r, 'F:' + r)
        if key not in units:
            units[key] = {'name': key[2:], 'refs': [], 'borders': [], 'box': None}
    for fp in fps:
        units[member[fp.GetReference()]]['refs'].append(fp.GetReference())

    fix_pat = list(fix)
    out_units, index = [], {}
    for key, u in units.items():
        if not u['refs']:
            continue
        rects, hv, dom, mech, rho, fixed = [], [], [], [], [], False
        for r in u['refs']:
            fp = by_ref[r]
            rc = fp_rect(fp)
            clr = 0.0 if is_test_point(r) else spacing[1] if ref_prefix(r) in IC_PREFIX else spacing[0]
            rr = _round_courtyard(fp)
            if rr:  # the circle, not its polygon
                rc = (rr[0] - rr[2], rr[1] - rr[2], rr[0] + rr[2], rr[1] + rr[2])
            rects.append((rc, clr))
            if rr:
                rho.append([len(rects) - 1, rr[2]])
            kinds = [(p, _domain(p, domains) or _pair_class(p, pairs)) for p in fp.Pads() if p.GetNetname()]
            if (domains or pairs) and not kinds:  # no net pad (a mounting hole): only its own class to a domain pad
                mech.append(len(rects) - 1)
                if r in hole_gap:  # a .kicad_dru hole rule: its gap to the domain pads
                    for p in fp.Pads():
                        bb = p.GetBoundingBox()
                        dom.append((len(hv), -1, hole_gap[r], 0.0))
                        hv.append(((mm(bb.GetX()), mm(bb.GetY()), mm(bb.GetRight()), mm(bb.GetBottom())), 0.0))
            elif any(d for _, d in kinds):  # every pad its own rect; the courtyard holds no pad
                mech.append(len(rects) - 1)
                for p, d in kinds:
                    bb = p.GetBoundingBox()
                    pb = (mm(bb.GetX()), mm(bb.GetY()), mm(bb.GetRight()), mm(bb.GetBottom()))
                    nc = mm(p.GetOwnClearance(pcbnew.F_Cu))
                    if d:
                        cid = dom_ids.setdefault(p.GetNetClassName(), len(dom_ids) + 1)
                        dom.append((len(hv), cid, d[2], nc))
                    hv.append((pb, d[1] if d and d[1] is not None else nc))
            elif clr:  # a pad of a net class with a larger clearance (mains) gets its own spacing rect
                for p in fp.Pads():
                    pc = mm(p.GetOwnClearance(pcbnew.F_Cu)) if p.GetNetname() else 0.0
                    if pc > clr:
                        bb = p.GetBoundingBox()
                        hv.append(((mm(bb.GetX()), mm(bb.GetY()), mm(bb.GetRight()), mm(bb.GetBottom())), pc))
            if (fp.IsLocked() or is_mounting_hole(fp) or fp.GetLayer() != pcbnew.F_Cu
                    or any(fnmatch.fnmatchcase(r, p) for p in fix_pat)):
                fixed = True
            if ref_prefix(r) in ('J', 'P', 'CN'):
                g = edge_dist
                corners = [(rc[0] - g, rc[1] - g), (rc[2] + g, rc[1] - g), (rc[2] + g, rc[3] + g), (rc[0] - g, rc[3] + g)]
                inside = sum(1 for x, y in corners if cost.point_in_poly(_a(x), _a(y), outline)[0])
                if 0 < inside < 4:  # at the edge; wholly outside = staged for placement, movable
                    fixed = True
        if u['box']:
            b = u['box']
        else:
            b = (min(r[0][0] for r in rects), min(r[0][1] for r in rects),
                 max(r[0][2] for r in rects), max(r[0][3] for r in rects))
        ox, oy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        if free_box and not inside_box(ox, oy, free_box):
            fixed = True
        if any(t.GetNetCode() == p.GetNetCode() and (t.HitTest(p.GetPosition()) or any(p.HitTest(q) for q in _ends(t)))
               for r in u['refs'] for p in by_ref[r].Pads() if p.GetNetname() for t in locked):
            fixed = True  # a locked track of its net meets its pad: the route is fixed
        index[key] = len(out_units)
        border = []
        if u['box']:  # block copper may leave the courtyards but stays inside the border
            rects.append((tuple(u['box']), 0.0))
            border = [len(rects) - 1]
            if dom:
                mech.append(len(rects) - 1)
        base = len(rects)
        rects += hv
        pads = [[round(mm(q.x) - ox, 6), round(mm(q.y) - oy, 6)]
                for r in u['refs'] if not is_test_point(r) for q in (p.GetPosition() for p in by_ref[r].Pads())]
        out_units.append({'name': u['name'], 'refs': sorted(u['refs']), 'fixed': fixed, 'x': ox, 'y': oy,
                          'rects': [[a - ox, c - oy, e - ox, f - oy, clr] for (a, c, e, f), clr in rects],
                          'pads': pads,
                          'borders': u['borders'], 'box': u['box'], 'group': u.get('group')})
        dk = {k for k, *_ in dom}
        if len(hv) > len(dk):  # pad rects with a net-class clearance: DRC enforces them
            out_units[-1]['hard'] = [base + k for k in range(len(hv)) if k not in dk]
        if dom:
            out_units[-1]['dom'] = [[base + k, c, g, nc] for k, c, g, nc in dom]
        if mech:
            out_units[-1]['mech'] = mech
        if all(p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH
               for r in u['refs'] for p in by_ref[r].Pads()):  # no copper pad (NPTH only): a keepout may cover it
            out_units[-1]['nocu'] = True
        if rho:  # a round courtyard: DRC measures to the circle
            out_units[-1]['rho'] = rho
        if border:  # DRC does not check a block border: its overlap is a soft cost
            out_units[-1]['border'] = border
        pad_boxes = [
            [round(mm(bb.GetX()) - ox, 6), round(mm(bb.GetY()) - oy, 6),
             round(mm(bb.GetRight()) - ox, 6), round(mm(bb.GetBottom()) - oy, 6)]
            for r in u['refs'] for bb in (p.GetBoundingBox() for p in by_ref[r].Pads())]
        out_units[-1]['cu'] = [box + [p.GetNetCode()] for box, p in
                               zip(pad_boxes, (p for r in u['refs'] for p in by_ref[r].Pads()))]
        kinds = {pcbnew.PAD_ATTRIB_PTH: 'pth', pcbnew.PAD_ATTRIB_NPTH: 'npth'}  # SMD and edge connector: 'smd'
        out_units[-1]['cu_pads'] = [[r, kinds.get(p.GetAttribute(), 'smd'), p.GetNumber()]
                                    for r in u['refs'] for p in by_ref[r].Pads()]
        if u['box']:  # a block: its pads are the copper for the edge band
            out_units[-1]['edge_pads'] = pad_boxes
        else:  # pads meet kept copper; a block also moves its tracks, so its courtyards stay the test
            out_units[-1]['pad_rects'] = pad_boxes

    _edges_and_block_zones(board, out_units, index, member, by_ref, edges or {}, zone_refs or {})
    keepouts = _block_cuts(board, out_units, keepouts)

    skip_pat = list(skip)
    region_refs = set(region_refs)
    pins = {}  # net -> {unit: [x0, y0, x1, y1]}
    ncls = {}  # net -> net class name
    region_nets = set()
    for fp in fps:
        if is_test_point(fp.GetReference()):
            continue
        ui = index[member[fp.GetReference()]]
        u = out_units[ui]
        for p in fp.Pads():
            n = p.GetNetname()
            if not n or n.startswith('unconnected-') or any(fnmatch.fnmatchcase(n, s) for s in skip_pat):
                continue
            q = p.GetPosition()
            x, y = mm(q.x) - u['x'], mm(q.y) - u['y']
            ncls[n] = p.GetNetClassName()
            b = pins.setdefault(n, {}).setdefault(ui, [x, y, x, y])
            b[0], b[1], b[2], b[3] = min(b[0], x), min(b[1], y), max(b[2], x), max(b[3], y)
            if fp.GetReference() in region_refs:
                region_nets.add(n)
    nets = []
    tracks = class_tracks(os.path.splitext(path)[0] + '.kicad_pro', domains)
    for n in sorted(pins):
        us = pins[n]
        if len(us) < 2 or all(out_units[i]['fixed'] for i in us):
            continue
        nets.append({'name': n, 'weight': region_weight if n in region_nets else 1.0,
                     'pins': [[i] + [round(v, 6) for v in us[i]] for i in sorted(us)],
                     'track': max(tracks.get(c, tracks['Default']) for c in ncls[n].split(','))})
    region = None
    if region_refs:
        if region_box is None:
            rs = [fp_rect(by_ref[r]) for r in region_refs if r in by_ref]
            region_box = [min(r[0] for r in rs) - 15, min(r[1] for r in rs) - 15,
                          max(r[2] for r in rs) + 15, max(r[3] for r in rs) + 15]
        region = {'box': list(region_box), 'weight': region_weight, 'refs': sorted(region_refs)}
    copper = kept_copper(board, out_units, by_ref)
    fixed_copper = [_copper_row(board, t) for t in locked]
    return {'board_file': os.path.abspath(path), 'units': out_units, 'nets': nets,
            'board': {'outline': outline, 'keepouts': keepouts, 'edge_clearance': edge, 'copper': copper,
                      'fixed_copper': fixed_copper, 'via_keepouts': via_keepouts},
            'region': region, 'move_box': list(free_box) if free_box else None, 'decaps': decaps,
            'dru_ignored': ignored, 'class_gaps': _class_gaps(dom_ids, domains, pairs) if dom_ids else None,
            'domain_areas': _domain_areas(dom_ids, domains),
            'route_rules': {'dru': rules, 'classes': class_rules(os.path.splitext(path)[0] + '.kicad_pro')},
            'cu_nets': {str(c): [n.GetNetname(), n.GetNetClassName()] for c in sorted(
                {q[4] for u in out_units for q in u.get('cu', ()) if q[4] > 0}) for n in [board.FindNet(c)]},
            'via_nets': sorted(n.GetNetCode() for name, n in board.GetNetsByName().items()
                               if any(fnmatch.fnmatchcase(str(name), q) for q in via_nets))}


def class_rules(pro):
    """{net class: [clearance, track width] (mm)} from the .kicad_pro net settings."""
    with open(pro) as f:
        return {c['name']: [c['clearance'], c['track_width']] for c in json.load(f)['net_settings']['classes']}


def class_tracks(pro, domains=()):
    """{net class: track width + clearance (mm)}: width and clearance from the .kicad_pro net settings; the
    clearance is at least the .kicad_dru gap between two classes of the class's domain (tracks of one domain run
    together). The domain gap to other nets is a placement spacing (domain rects), not a track pitch."""
    with open(pro) as f:
        cs = json.load(f)['net_settings']['classes']
    return {c['name']: c['track_width'] + max([c['clearance']] + [d[2] for d in domains
                                                                  if fnmatch.fnmatchcase(c['name'], d[0])])
            for c in cs}


def _domain(pad, domains):
    """(pattern, gap to other nets, gap to another class of the domain) of the first domain whose net-class
    pattern matches the pad, or None."""
    c = pad.GetNetClassName()
    return next((d for d in domains if any(fnmatch.fnmatchcase(x, d[0]) for x in c.split(','))), None)


def _pair_class(pad, pairs):
    """A pad of a net class in a .kicad_dru pair rule: a domain pad with the net clearance, no class gap."""
    c = pad.GetNetClassName().split(',')
    m = any(fnmatch.fnmatchcase(x, q) for a, b, _ in pairs for q in a + b for x in c)
    return ('', None, 0.0) if m else None


def _domain_areas(dom_ids, domains):
    """One area per .kicad_dru domain (not a pair rule): its class ids and its gap to other nets. Parts without
    domain pads stay out of the hull of its pads grown by the gap (cost.area_setup)."""
    out = []
    for p, g, _ in domains:
        cl = sorted(c for n, c in dom_ids.items() if any(fnmatch.fnmatchcase(x, p) for x in n.split(',')))
        if cl:
            out.append({'classes': cl, 'gap': g})
    return out


def _class_gaps(dom_ids, domains, pairs):
    """Gap table between domain classes (index = class id, 0 unused): the class gap inside one domain, else the
    larger gap to other nets of the two domains, and at least the gap of a pair rule between the two classes."""
    names = [''] + sorted(dom_ids, key=dom_ids.get)
    hit = lambda n, pats: any(fnmatch.fnmatchcase(x, q) for q in pats for x in n.split(','))
    dom = [next((d for d in domains if hit(n, [d[0]])), None) for n in names]
    gaps = [[0.0] * len(names) for _ in names]
    for i in range(1, len(names)):
        for j in range(1, len(names)):
            if i == j:
                continue
            a, b = dom[i], dom[j]
            g = a[2] if a and a is b else max(a[1] if a else 0.0, b[1] if b else 0.0)
            for pa, pb, pg in pairs:
                if (hit(names[i], pa) and hit(names[j], pb)) or (hit(names[i], pb) and hit(names[j], pa)):
                    g = max(g, pg)
            gaps[i][j] = g
    return {'names': names, 'gaps': gaps}


def _block_cuts(board, units, keepouts):
    """A board hole (slot) wholly inside a block border is part of the block (a creepage slot under a relay):
    its Edge.Cuts shapes move with the block (u['cuts']) and it is a keepout rect of the block, not a board
    keepout. Returns the other keepouts."""
    def inside(bb, box):
        t = 0.2  # mm: an Edge.Cuts shape box includes its line width
        return box[0] - t <= bb[0] and box[1] - t <= bb[1] and bb[2] <= box[2] + t and bb[3] <= box[3] + t
    cuts = [(d, (mm(bb.GetX()), mm(bb.GetY()), mm(bb.GetRight()), mm(bb.GetBottom())))
            for d in board.GetDrawings() if d.GetLayer() == pcbnew.Edge_Cuts for bb in [d.GetBoundingBox()]]
    rest = []
    for k in keepouts:
        hb = bbox_of(k)
        u = next((u for u in units if u['box'] and inside(hb, u['box'])), None)
        if u is None:
            rest.append(k)
            continue
        u.setdefault('ko', []).append(len(u['rects']))
        u['rects'].append([hb[0] - u['x'], hb[1] - u['y'], hb[2] - u['x'], hb[3] - u['y'], 0.0])
        u.setdefault('cuts', []).extend(d.m_Uuid.AsString() for d, bb in cuts if inside(bb, hb))
    return rest


def _edges_and_block_zones(board, units, index, member, by_ref, edges, zone_refs):
    """Edge anchors: edges[ref] = (sides 'LRTB', courtyard side 'N'/'S'/'E'/'W' of ref, board frame now; in a
    block the point is on that side of the border).
    zone_refs {rule area name: ref}: the area goes with the unit of ref (an antenna or mains keepout of a block):
    it moves with it and is a keepout rect (u['ko']) of class 0, cut at the anchor line when the unit has an
    anchor (the part beyond lies off the board). Other rule areas stay where they are."""
    cut = {}
    for ref, (sides, side) in edges.items():
        i = index[member[ref]]
        u = units[i]
        rc = fp_rect(by_ref[ref])
        mx, my = (rc[0] + rc[2]) / 2, (rc[1] + rc[3]) / 2
        if u['box']:  # block copper ends at the border: the anchor goes onto the border, in line with the part
            rc = u['box']
        ax, ay = {'N': (mx, rc[1]), 'S': (mx, rc[3]), 'W': (rc[0], my), 'E': (rc[2], my)}[side]
        u['edge'] = {'at': [ax - u['x'], ay - u['y']], 'sides': sides, 'tol': 0.5}
        cut[i] = (side, ax, ay)
    for z in board.Zones():
        if not z.GetIsRuleArea() or z.GetZoneName() not in zone_refs:
            continue
        bb = z.GetBoundingBox()
        r = [mm(bb.GetX()), mm(bb.GetY()), mm(bb.GetRight()), mm(bb.GetBottom())]
        i = index[member[zone_refs[z.GetZoneName()]]]
        u = units[i]
        if i in cut:
            side, ax, ay = cut[i]
            if side == 'S':
                r[3] = min(r[3], ay)
            elif side == 'N':
                r[1] = max(r[1], ay)
            elif side == 'E':
                r[2] = min(r[2], ax)
            else:
                r[0] = max(r[0], ax)
        u.setdefault('ko', []).append(len(u['rects']))
        u['rects'].append([r[0] - u['x'], r[1] - u['y'], r[2] - u['x'], r[3] - u['y'], 0.0])
        u.setdefault('zones', []).append(z.m_Uuid.AsString())
        if z.GetDoNotAllowVias():  # net code -1: a no-via area for the via room cost
            u['cu'].append([r[0] - u['x'], r[1] - u['y'], r[2] - u['x'], r[3] - u['y'], -1])


def _a(v):
    import numpy as np
    return np.array([v], dtype=float)


def _v(x, y):
    return pcbnew.VECTOR2I(int(round(x * M)), int(round(y * M)))


def _pt_key(p):
    return (p.x, p.y)


COPPER = ('F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu')


def collide(a, b, clearance=None):
    """True when copper items a and b are closer than the clearance (nm; default: their own rules) on a shared layer."""
    for name in COPPER:
        lay = getattr(pcbnew, name.replace('.', '_'))
        if a.IsOnLayer(lay) and b.IsOnLayer(lay):
            c = clearance if clearance is not None else max(a.GetOwnClearance(lay), b.GetOwnClearance(lay))
            if a.GetEffectiveShape(lay).Collide(b.GetEffectiveShape(lay), int(c)):
                return True
    return False


def _box(it, grow):
    bb = it.GetBoundingBox()
    return (bb.GetX() - grow, bb.GetY() - grow, bb.GetRight() + grow, bb.GetBottom() + grow)


def _meet(a, b):
    return a[0] <= b[2] and b[0] <= a[2] and a[1] <= b[3] and b[1] <= a[3]


def _ends(t):
    return [t.GetPosition()] if t.GetClass() == 'PCB_VIA' else [t.GetStart(), t.GetEnd()]


def _clusters(free):
    """Union-find over tracks and vias of one net that share an end point. Returns find(k)."""
    parent = list(range(len(free)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    at = {}
    for k, t in enumerate(free):
        for p in _ends(t):
            key = (t.GetNetCode(), _pt_key(p))
            if key in at:
                parent[find(k)] = find(at[key])
            else:
                at[key] = k
    return find


def _hit(free, find, pads_by_net):
    """Cluster ids with an end point on a pad in pads_by_net {net: [pad, ...]}."""
    hit = set()
    for k, t in enumerate(free):
        pads = pads_by_net.get(t.GetNetname())
        if pads and any(pad.HitTest(p) for p in _ends(t) for pad in pads):
            hit.add(find(k))
    return hit


def _owned(free, find, rects=None):
    """Cluster ids made of vias only (stitching vias, no track) that all lie inside one of the courtyard rects
    (rects None: anywhere). Under a part they belong to it and go when it moves."""
    tracked, inside = set(), {}
    for k, t in enumerate(free):
        c = find(k)
        if t.GetClass() != 'PCB_VIA':
            tracked.add(c)
            continue
        q = t.GetPosition()
        ok = rects is None or any(inside_box(mm(q.x), mm(q.y), r) for r in rects)
        inside[c] = inside.get(c, True) and ok
    return {c for c, ok in inside.items() if ok and c not in tracked}


def kept_copper(board, units, by_ref):
    """Copper that stays whatever the movable units do: clusters with no end point on a pad of a movable
    unit, not inside the border of a movable block, and not a lone (via-only) stitching via. [[layer, x0, y0, x1, y1, width], ...]"""
    tracks = [t for t in board.GetTracks() if not t.IsLocked()]  # locked: fixed_copper
    pads, boxes = {}, []
    for u in units:
        if u['fixed']:
            continue
        if u['box']:
            boxes.append(u['box'])
        for r in u['refs']:
            for p in by_ref[r].Pads():
                if p.GetNetname():
                    pads.setdefault(p.GetNetname(), []).append(p)
    free = [t for t in tracks
            if not any(all(inside_box(mm(p.x), mm(p.y), b) for p in _ends(t)) for b in boxes)]
    find = _clusters(free)
    # lone stitching vias are no obstacle: the writer removes those that a moved part lands on
    hit = _hit(free, find, pads) | _owned(free, find)
    out = []
    for k, t in enumerate(free):
        if find(k) in hit:
            continue
        out.append(_copper_row(board, t))
    return out


def _copper_row(board, t):
    if t.GetClass() == 'PCB_VIA':
        q = t.GetPosition()
        return ['via', mm(q.x), mm(q.y), mm(q.x), mm(q.y), mm(t.GetWidth(pcbnew.F_Cu))]
    a, b = t.GetStart(), t.GetEnd()
    return [board.GetLayerName(t.GetLayer()), mm(a.x), mm(a.y), mm(b.x), mm(b.y), mm(t.GetWidth())]


def _virtual_outline(board, outline, k, keep=()):
    """Replace the Edge.Cuts shapes (not the block slots in keep) by the bounding box of `outline` scaled by k
    about its centre."""
    xs, ys = [p[0] for p in outline], [p[1] for p in outline]
    cx, cy, hw, hh = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (max(xs) - min(xs)) * k / 2, (max(ys) - min(ys)) * k / 2
    for d in [d for d in board.GetDrawings()
              if d.GetLayer() == pcbnew.Edge_Cuts and d.m_Uuid.AsString() not in keep]:
        board.Delete(d)
    r = pcbnew.PCB_SHAPE(board)
    r.SetShape(pcbnew.SHAPE_T_RECT)
    r.SetLayer(pcbnew.Edge_Cuts)
    r.SetStart(_v(cx - hw, cy - hh))
    r.SetEnd(_v(cx + hw, cy + hh))
    r.SetWidth(int(0.1 * M))
    board.Add(r)
    # a zone that covers the whole outline (a ground pour) grows to the virtual box, so the refill
    # still reaches the parts placed outside the real outline; a local zone keeps its outline
    w0, h0 = max(xs) - min(xs), max(ys) - min(ys)
    for z in board.Zones():
        bb = z.GetBoundingBox()
        if bb.GetWidth() / M >= 0.9 * w0 and bb.GetHeight() / M >= 0.9 * h0:
            o = z.Outline()
            o.RemoveAllContours()
            o.NewOutline()
            for x, y in ((cx - hw, cy - hh), (cx + hw, cy - hh), (cx + hw, cy + hh), (cx - hw, cy + hh)):
                o.Append(_v(x, y))


def write_board(path, pr, pose, out, outline_scale=1.0):
    if os.path.abspath(path) == os.path.abspath(out):
        raise ValueError('write_board writes a copy only: out must differ from the input board')
    board = pcbnew.LoadBoard(path)
    by_ref = {fp.GetReference(): fp for fp in board.GetFootprints()}
    by_id = {d.m_Uuid.AsString(): d for d in board.GetDrawings()}
    by_zone = {z.m_Uuid.AsString(): z for z in board.Zones()}
    moved = []
    for i, u in enumerate(pr['units']):
        x, y, r = pose[i]
        if abs(x - u['x']) > 1e-6 or abs(y - u['y']) > 1e-6 or int(r) % 4:
            if u['fixed']:
                raise ValueError('fixed unit %s moved' % u['name'])
            moved.append((i, u, float(x), float(y), int(r) % 4))

    tracks = list(board.GetTracks())
    internal = {}
    for i, u, *_ in moved:
        if u['box']:
            b = u['box']
            for t in tracks:
                pts = [t.GetPosition()] if t.GetClass() == 'PCB_VIA' else [t.GetStart(), t.GetEnd()]
                if all(inside_box(mm(p.x), mm(p.y), b) for p in pts):
                    internal[t.m_Uuid.AsString()] = i
    moved_pads = {}
    for i, u, *_ in moved:
        for r in u['refs']:
            for p in by_ref[r].Pads():
                if p.GetNetname():
                    moved_pads.setdefault(p.GetNetname(), []).append(p)

    # copper clusters per net (end points and vias), not counting the rigid block copper
    free = [t for t in tracks if t.m_Uuid.AsString() not in internal and not t.IsLocked()]  # locked: stays
    find = _clusters(free)
    rects = [fp_rect(by_ref[r]) for i, u, *_ in moved for r in u['refs']]
    hit = _hit(free, find, moved_pads) | _owned(free, find, rects)
    remove = [t for k, t in enumerate(free) if find(k) in hit]

    for i, u, x, y, r in moved:
        o = _v(u['x'], u['y'])
        d = _v(x - u['x'], y - u['y'])
        ang = pcbnew.EDA_ANGLE(90.0 * r, pcbnew.DEGREES_T)
        items = [by_ref[ref] for ref in u['refs']] + [by_id[b] for b in u['borders'] if b in by_id]
        items += [by_zone[z] for z in u.get('zones', []) if z in by_zone]
        items += [by_id[c] for c in u.get('cuts', []) if c in by_id]
        items += [t for t in tracks if internal.get(t.m_Uuid.AsString()) == i]
        for it in items:
            if r:
                it.Rotate(o, ang)
            it.Move(d)
    # kept copper that now touches a moved pad or moved block copper of another net goes too (whole cluster)
    moved_items = [p for i, u, *_ in moved for r in u['refs'] for p in by_ref[r].Pads()]
    moved_items += [t for t in tracks if t.m_Uuid.AsString() in internal]
    grow = 500000
    mboxes = [(_box(it, grow), it) for it in moved_items]
    removed = {find(k) for k in hit}
    clash = set()
    for k, t in enumerate(free):
        c = find(k)
        if c in removed or c in clash:
            continue
        tb = _box(t, 0)
        for mb, it in mboxes:
            if _meet(tb, mb) and it.GetNetCode() != t.GetNetCode() and collide(t, it):
                clash.add(c)
                break
    remove += [t for k, t in enumerate(free) if find(k) in clash]
    for t in remove:
        board.Delete(t)  # Remove() leaves freed tracks that break later LoadBoard() calls
    if outline_scale != 1.0:
        _virtual_outline(board, pr['board']['outline'], outline_scale,
                         {c for u in pr['units'] for c in u.get('cuts', [])})
    pcbnew.SaveBoard(out, board)
    return {'moved_units': len(moved), 'removed_tracks': len(remove),
            'removed_collisions': sum(1 for k in range(len(free)) if find(k) in clash),
            'moved_block_tracks': sum(1 for _ in internal)}
