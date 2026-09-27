"""KiCad board <-> placement problem (pcbnew; run with the KiCad bundled Python).

read_problem(board) -> problem dict (see cost.py)
  Units: a PCB group with footprints; else a block = a closed User.1 rectangle and the footprints
  whose anchor is inside it (the User.1 border and label move with it); else one footprint.
  Origin: the centre of the block border, else the centre of the courtyard boxes.
  Fixed: locked footprints, mounting holes (ref H<n> or a MountingHole footprint), connectors
  (J/P/CN) whose courtyard is within edge_dist of the outline, parts on B.Cu, refs in `fix`
  (fnmatch), and units whose origin is outside `free_box`. A unit with one fixed part is fixed.
  Rects: F.CrtYd box per footprint (else pads + 0.25 mm); spacing class 1.0 mm for IC and
  connector refs (U, J, P, CN, K, SW, Y, X), 0.5 mm for the rest (D-040). A block also has its
  border box as a rect of class 0 (its copper stays inside the border).
  Pads: every pad centre of the unit (pin RUDY). Pins: one box per (net, unit) of the pad centres. Nets matching `skip` (default GND) and nets
  inside one unit are left out.
  Keepouts: rule areas that do not allow footprints, and closed shapes on `keepout_layers`.
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
import math
import os
import re

import pcbnew

from . import cost

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
    if c.OutlineCount():
        bb = c.BBox()
        return (mm(bb.GetX()), mm(bb.GetY()), mm(bb.GetRight()), mm(bb.GetBottom()))
    xs, ys = [], []
    for p in fp.Pads():
        bb = p.GetBoundingBox()
        xs += [mm(bb.GetX()), mm(bb.GetRight())]
        ys += [mm(bb.GetY()), mm(bb.GetBottom())]
    if not xs:
        q = fp.GetPosition()
        xs, ys = [mm(q.x)], [mm(q.y)]
    return (min(xs) - .25, min(ys) - .25, max(xs) + .25, max(ys) + .25)


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


def read_problem(path, fix=(), skip=('GND',), edge_dist=1.5, keepout_layers=(), free_box=None,
                 region_refs=(), region_weight=1.0, region_box=None, spacing=(0.5, 1.0), tie=0.0):
    board = pcbnew.LoadBoard(path)
    outline, holes = outline_of(board)
    keepouts = [h for h in holes]
    for z in board.Zones():
        if z.GetIsRuleArea() and z.GetDoNotAllowFootprints() and z.Outline().OutlineCount():
            keepouts.append(poly_points(z.Outline().Outline(0)))
    lays = {board.GetLayerID(n) for n in keepout_layers}
    for d in board.GetDrawings():
        if d.GetLayer() in lays and d.GetClass() == 'PCB_SHAPE':
            poly = shape_polygon(d)
            if poly:
                keepouts.append(poly)
    edge = 1.0

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
            if fp.GetReference() not in member and inside_box(mm(q.x), mm(q.y), box) and share >= BLOCK_SHARE:
                inside.append(fp.GetReference())
        if len(inside) < 2:  # a block has 2 or more parts; a border around one part is stale
            continue
        key = 'B:%d' % k
        units[key] = {'name': label or 'BLOCK%d' % (k + 1), 'refs': [], 'borders': ids, 'box': list(box)}
        for r in inside:
            member[r] = key
    by_ref = {fp.GetReference(): fp for fp in fps}
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
        rects, fixed = [], False
        for r in u['refs']:
            fp = by_ref[r]
            rc = fp_rect(fp)
            clr = spacing[1] if ref_prefix(r) in IC_PREFIX else spacing[0]
            rects.append((rc, clr))
            if (fp.IsLocked() or is_mounting_hole(fp) or fp.GetLayer() != pcbnew.F_Cu
                    or any(fnmatch.fnmatchcase(r, p) for p in fix_pat)):
                fixed = True
            if ref_prefix(r) in ('J', 'P', 'CN'):
                g = edge_dist
                corners = [(rc[0] - g, rc[1] - g), (rc[2] + g, rc[1] - g), (rc[2] + g, rc[3] + g), (rc[0] - g, rc[3] + g)]
                if not all(cost.point_in_poly(_a(x), _a(y), outline)[0] for x, y in corners):
                    fixed = True
        if u['box']:
            b = u['box']
        else:
            b = (min(r[0][0] for r in rects), min(r[0][1] for r in rects),
                 max(r[0][2] for r in rects), max(r[0][3] for r in rects))
        ox, oy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        if free_box and not inside_box(ox, oy, free_box):
            fixed = True
        index[key] = len(out_units)
        if u['box']:  # block copper may leave the courtyards but stays inside the border
            rects.append((tuple(u['box']), 0.0))
        pads = [[round(mm(q.x) - ox, 6), round(mm(q.y) - oy, 6)]
                for r in u['refs'] for q in (p.GetPosition() for p in by_ref[r].Pads())]
        out_units.append({'name': u['name'], 'refs': sorted(u['refs']), 'fixed': fixed, 'x': ox, 'y': oy,
                          'rects': [[a - ox, c - oy, e - ox, f - oy, clr] for (a, c, e, f), clr in rects],
                          'pads': pads,
                          'borders': u['borders'], 'box': u['box'], 'group': u.get('group')})

    skip_pat = list(skip)
    region_refs = set(region_refs)
    pins = {}  # net -> {unit: [x0, y0, x1, y1]}
    region_nets = set()
    for fp in fps:
        ui = index[member[fp.GetReference()]]
        u = out_units[ui]
        for p in fp.Pads():
            n = p.GetNetname()
            if not n or n.startswith('unconnected-') or any(fnmatch.fnmatchcase(n, s) for s in skip_pat):
                continue
            q = p.GetPosition()
            x, y = mm(q.x) - u['x'], mm(q.y) - u['y']
            b = pins.setdefault(n, {}).setdefault(ui, [x, y, x, y])
            b[0], b[1], b[2], b[3] = min(b[0], x), min(b[1], y), max(b[2], x), max(b[3], y)
            if fp.GetReference() in region_refs:
                region_nets.add(n)
    nets = []
    for n in sorted(pins):
        us = pins[n]
        if len(us) < 2 or all(out_units[i]['fixed'] for i in us):
            continue
        nets.append({'name': n, 'weight': region_weight if n in region_nets else 1.0,
                     'pins': [[i] + [round(v, 6) for v in us[i]] for i in sorted(us)]})
    region = None
    if region_refs:
        if region_box is None:
            rs = [fp_rect(by_ref[r]) for r in region_refs if r in by_ref]
            region_box = [min(r[0] for r in rs) - 15, min(r[1] for r in rs) - 15,
                          max(r[2] for r in rs) + 15, max(r[3] for r in rs) + 15]
        region = {'box': list(region_box), 'weight': region_weight, 'refs': sorted(region_refs)}
    return {'board_file': os.path.abspath(path), 'units': out_units, 'nets': nets,
            'board': {'outline': outline, 'keepouts': keepouts, 'edge_clearance': edge}, 'region': region}


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


def write_board(path, pr, pose, out):
    if os.path.abspath(path) == os.path.abspath(out):
        raise ValueError('write_board writes a copy only: out must differ from the input board')
    board = pcbnew.LoadBoard(path)
    by_ref = {fp.GetReference(): fp for fp in board.GetFootprints()}
    by_id = {d.m_Uuid.AsString(): d for d in board.GetDrawings()}
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
    parent = {}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    free = [t for t in tracks if t.m_Uuid.AsString() not in internal]
    at = {}
    for k, t in enumerate(free):
        parent[k] = k
        pts = [t.GetPosition()] if t.GetClass() == 'PCB_VIA' else [t.GetStart(), t.GetEnd()]
        for p in pts:
            key = (t.GetNetCode(), _pt_key(p))
            if key in at:
                parent[find(k)] = find(at[key])
            else:
                at[key] = k
    hit = set()
    for k, t in enumerate(free):
        pads = moved_pads.get(t.GetNetname())
        if not pads:
            continue
        pts = [t.GetPosition()] if t.GetClass() == 'PCB_VIA' else [t.GetStart(), t.GetEnd()]
        if any(pad.HitTest(p) for p in pts for pad in pads):
            hit.add(find(k))
    remove = [t for k, t in enumerate(free) if find(k) in hit]

    for i, u, x, y, r in moved:
        o = _v(u['x'], u['y'])
        d = _v(x - u['x'], y - u['y'])
        ang = pcbnew.EDA_ANGLE(90.0 * r, pcbnew.DEGREES_T)
        items = [by_ref[ref] for ref in u['refs']] + [by_id[b] for b in u['borders'] if b in by_id]
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
    pcbnew.SaveBoard(out, board)
    return {'moved_units': len(moved), 'removed_tracks': len(remove),
            'removed_collisions': sum(1 for k in range(len(free)) if find(k) in clash),
            'moved_block_tracks': sum(1 for _ in internal)}
