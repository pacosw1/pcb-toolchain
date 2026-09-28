"""Placement cost: HPWL, RUDY congestion, courtyard spacing overlap and forbidden area.

Pure functions for a full evaluation, plus one incremental Evaluator for the search.
Units are mm, KiCad axes (y down). Rotation r in 0..3 is r * 90 deg in the KiCad sense:
r = 1 maps a local point (x, y) to (y, -x), as KiCad RotatePoint(+90 deg).

Problem (a dict, JSON-able; tools/placer/kicad_io.py writes it from a board):
  units:  [{name, refs, fixed, x, y, rects: [[x0, y0, x1, y1, clr], ...]}]
          x, y = unit origin on the board; rects = courtyard boxes relative to the origin at r = 0;
          clr = spacing class (D-040: 0.5 mm passive, 1.0 mm IC or connector).
          ko (optional) = indices of rects that are copper-free rule areas (an antenna keepout): such a rect
          may overlap a board keepout or a ko rect of another unit; a courtyard or kept copper in it is illegal.
          dom (optional) = [[rect index, class id, gap to another class of the domain, net-class clearance]]:
          a pad of a domain (mains) whose rect clr is the gap to all other nets (.kicad_dru, for example 8 mm).
          Class id -1 = a hole with a .kicad_dru hole rule: the gap (third field) to domain pads only.
  class_gaps (optional): {names, gaps}: gaps[i][j] = the gap between two domain classes i != j (ids 1..n);
          without it, two classes keep the larger class gap field.
  domain_areas (optional): [{classes, gap}]: per .kicad_dru domain, the convex hull of its domain pads grown by gap
          (the mains area). A part with no domain pad in it is a hard overlap: its tracks would cross the area.
          mech (optional) = indices of rects that hold no pad of their own (a block border, the courtyard of a
          part whose pads have their own rects, a part with no net pads): a domain rect keeps only their own
          class to them, as to a keepout rect (a slot is the creepage barrier).
  nets:   [{name, weight, pins: [[unit, x0, y0, x1, y1], ...]}]   pin boxes relative to the origin.
  board:  {outline: [[x, y], ...], keepouts: [[[x, y], ...], ...], edge_clearance, keepout_gaps (optional):
          {class id: gap}: a domain pad of the class keeps the gap to each keepout (no-net creepage)}
  region: None or {box: [x0, y0, x1, y1], weight, refs}   RUDY cells in box count weight times.
  board['copper'] (optional): kept copper [[layer, x0, y0, x1, y1, width], ...]; layer 'via' = a via at
          (x0, y0) with diameter width. It uses RUDY capacity (fixed_grid) and F.Cu copper and vias are
          obstacles in the forbidden mask (grown by gap). Zones are not in it: a pour gives way to tracks.
Pose: [(x, y, r), ...] per unit.

Cost = w_wl * sum(weight * HPWL) + w_cong * RUDY overflow + w_ov * hard overlap + w_oob * forbidden area
       + w_sp * soft spacing.
Hard overlap (illegal) = what KiCad DRC enforces: courtyard over courtyard, and the gap of a rect in u['hard'] (a pad
with its net-class or .kicad_dru clearance), domain gaps and keepouts. The D-040 halo (clr of a courtyard) is the
soft spacing: the halo overlap beyond the hard overlap.
RUDY (Spindler, DATE 2007): each net spreads its HPWL evenly over the cells of its box, times its track factor
(net['track'] = net-class width + clearance, over pitch; 1 without). Pin RUDY:
each pad (unit['pads'], local points) adds pin_demand mm of wire to its cell (pin escape and blockage).
Capacity per cell = cell area * layers / pitch; overflow = sum of (demand - limit * capacity) above the limit.
Spacing overlap of two courtyard boxes with classes ca, cb: g = max(ca, cb), penalty = the area of
the intersection of both boxes grown by g / 2 (0 when the gap is g or more). Boxes of the same unit
(rigid block layout) and pairs of two fixed units do not count.
Forbidden area = courtyard area on cells outside the outline shrunk by edge_clearance or inside a keepout.
"""
import math

import numpy as np

# RUDY default: the old term (tracks 0, limit 0.1), the cost of P2 and P2R. Track RUDY (tracks 1) at 0.3 ranked the 9
# bench v5 poses best (Spearman 0.60), but its holdout P5 routed median 8 vs P2R 7; at 0.7 a search drove it to 0.
DEFAULTS = {'rudy_cell': 1.0, 'mask_cell': 0.1, 'layers': 2, 'pitch': 0.4, 'limit': 0.1, 'pin_demand': 0.0, 'gap': 0.2,
            'w_wl': 1.0, 'w_cong': 1.0, 'w_ov': 20.0, 'w_oob': 20.0, 'w_sp': 2.0,
            'via_d': 0.6, 'via_clr': 0.2, 'w_via': 10.0, 'w_x': 0.0, 'w_row': 0.0, 'row_pitch': 1.0, 'tracks': 0.0}  # via 0.6/0.3 mm, clearance 0.2 mm (default net class)
EPS = 1e-9
ROUTE_LAYERS = ('F.Cu', 'B.Cu')  # the `layers` routing layers; copper on other layers uses no RUDY capacity
OBSTACLE_LAYERS = ('F.Cu', 'via')  # kept copper that a top-side part must not cover


def params_with_defaults(params):
    p = dict(DEFAULTS)
    p.update(params or {})
    return p


def rot_pt(x, y, r):
    r %= 4
    if r == 0:
        return (x, y)
    if r == 1:
        return (y, -x)
    if r == 2:
        return (-x, -y)
    return (-y, x)


def rot_rect(rect, r):
    x0, y0, x1, y1 = rect[:4]
    r %= 4
    if r == 0:
        return (x0, y0, x1, y1)
    if r == 1:
        return (y0, -x1, y1, -x0)
    if r == 2:
        return (-x1, -y1, -x0, -y0)
    return (-y1, x0, -y0, x1)


def initial_pose(pr):
    return [(float(u['x']), float(u['y']), 0) for u in pr['units']]


def outline_box(board):
    pts = np.array(board['outline'], dtype=float)
    return (pts[:, 0].min(), pts[:, 1].min(), pts[:, 0].max(), pts[:, 1].max())


def cell_range(a0, a1, g0, c, n):
    """Cells [i0, i1) that a span [a0, a1] touches, clipped to 0..n. At least one cell before the clip."""
    i0 = math.floor((a0 - g0) / c + EPS)
    i1 = math.ceil((a1 - g0) / c - EPS)
    if i1 <= i0:
        i1 = i0 + 1
    return i0, i1, max(i0, 0), min(i1, n)


class Grid:
    """RUDY grid over the outline box."""

    def __init__(self, board, cell):
        x0, y0, x1, y1 = outline_box(board)
        self.x0, self.y0, self.c = x0, y0, cell
        self.nx = max(1, math.ceil((x1 - x0) / cell - EPS))
        self.ny = max(1, math.ceil((y1 - y0) / cell - EPS))

    def span(self, box):
        """(j0, j1, i0, i1) clipped cell slice of a box, or None when it is outside the grid."""
        _, _, i0, i1 = cell_range(box[0], box[2], self.x0, self.c, self.nx)
        _, _, j0, j1 = cell_range(box[1], box[3], self.y0, self.c, self.ny)
        if i1 <= i0 or j1 <= j0:
            return None
        return (j0, j1, i0, i1)


def point_in_poly(xs, ys, poly):
    """Even-odd test of points (arrays) in a polygon [[x, y], ...]."""
    inside = np.zeros(xs.shape, dtype=bool)
    n = len(poly)
    for k in range(n):
        ax, ay = poly[k]
        bx, by = poly[(k + 1) % n]
        if ay == by:
            continue
        cross = (ay > ys) != (by > ys)
        xint = ax + (ys - ay) * (bx - ax) / (by - ay)
        inside ^= cross & (xs < xint)
    return inside


def sat(a):
    s = np.zeros((a.shape[0] + 1, a.shape[1] + 1), dtype=np.int64)
    s[1:, 1:] = np.cumsum(np.cumsum(a, axis=0), axis=1)
    return s


class Mask:
    """Forbidden cells: outside the outline or inside a keepout (edge table, for courtyards and borders), outside
    the outline shrunk by edge_clearance (band table, for pads: DRC copper-to-edge), or on kept F.Cu copper /
    vias grown by gap (copper table). A unit with pad_rects tests only its pads against copper."""

    MARGIN = 2.0

    def __init__(self, board, cell, gap=0.2):
        x0, y0, x1, y1 = outline_box(board)
        m = self.MARGIN
        self.x0, self.y0, self.c = x0 - m, y0 - m, cell
        self.nx = math.ceil((x1 - x0 + 2 * m) / cell)
        self.ny = math.ceil((y1 - y0 + 2 * m) / cell)
        xs = self.x0 + (np.arange(self.nx) + 0.5) * cell
        ys = self.y0 + (np.arange(self.ny) + 0.5) * cell
        gx, gy = np.meshgrid(xs, ys)
        out = ~point_in_poly(gx, gy, board['outline'])
        out0 = out.copy()
        self.s_outl = sat(out.astype(np.int64))  # outside the outline only
        k = math.ceil(board.get('edge_clearance', 0.0) / cell - EPS)
        if k > 0:
            s = sat(out.astype(np.int64))
            jj = np.arange(self.ny)
            ii = np.arange(self.nx)
            j0 = np.clip(jj - k, 0, self.ny)[:, None]
            j1 = np.clip(jj + k + 1, 0, self.ny)[:, None]
            i0 = np.clip(ii - k, 0, self.nx)[None, :]
            i1 = np.clip(ii + k + 1, 0, self.nx)[None, :]
            out = (s[j1, i1] - s[j0, i1] - s[j1, i0] + s[j0, i0]) > 0
        for poly in board.get('keepouts', []):
            ko = point_in_poly(gx, gy, poly)
            out, out0 = out | ko, out0 | ko
        for layer, a0, b0, a1, b1, w in board.get('fixed_copper', []):  # locked: a pad over it is illegal
            if layer in OBSTACLE_LAYERS:
                self._segment(out, a0, b0, a1, b1, w / 2 + gap)
        cu = np.zeros_like(out)
        for layer, a0, b0, a1, b1, w in board.get('copper', []):
            if layer in OBSTACLE_LAYERS:
                self._segment(cu, a0, b0, a1, b1, w / 2 + gap)
        self.forb = out0 | cu
        self.s = sat(self.forb.astype(np.int64))
        self.s_edge = sat(out0.astype(np.int64))
        self.s_band = sat(out.astype(np.int64))
        self.s_cu = sat(cu.astype(np.int64))
        self.s_kog = {}  # class id -> keepouts grown by the no-net creepage of the class (board['keepout_gaps'])
        for c, g in board.get('keepout_gaps', {}).items():
            near = np.zeros_like(out)
            for poly in board.get('keepouts', []):
                near |= point_in_poly(gx, gy, poly) | (_poly_d2(gx, gy, poly) < g * g)
            self.s_kog[int(c)] = sat(near.astype(np.int64))

    def _segment(self, out, a0, b0, a1, b1, r):
        """Mark the cells whose centre is within r of the segment (a0, b0)-(a1, b1)."""
        c = self.c
        i0 = max(int((min(a0, a1) - r - self.x0) / c), 0)
        i1 = min(int((max(a0, a1) + r - self.x0) / c) + 2, self.nx)
        j0 = max(int((min(b0, b1) - r - self.y0) / c), 0)
        j1 = min(int((max(b0, b1) + r - self.y0) / c) + 2, self.ny)
        if i1 <= i0 or j1 <= j0:
            return
        xs = self.x0 + (np.arange(i0, i1) + 0.5) * c
        ys = self.y0 + (np.arange(j0, j1) + 0.5) * c
        px, py = np.meshgrid(xs, ys)
        dx, dy = a1 - a0, b1 - b0
        ll = dx * dx + dy * dy
        t = np.clip(((px - a0) * dx + (py - b0) * dy) / ll, 0, 1) if ll > 0 else 0.0
        d2 = (px - a0 - t * dx) ** 2 + (py - b0 - t * dy) ** 2
        out[j0:j1, i0:i1] |= d2 <= r * r

    def rect_area(self, x0, y0, x1, y1, s=None, outside=True):
        """Forbidden area in the rect (cells outside the grid count when `outside`)."""
        c = self.c
        a0, a1, i0, i1 = cell_range(x0, x1, self.x0, c, self.nx)
        b0, b1, j0, j1 = cell_range(y0, y1, self.y0, c, self.ny)
        total = (a1 - a0) * (b1 - b0) if outside else 0
        if i1 <= i0 or j1 <= j0:
            return total * c * c
        s = self.s if s is None else s
        inside = (i1 - i0) * (j1 - j0) if outside else 0
        bad = s[j1, i1] - s[j0, i1] - s[j1, i0] + s[j0, i0]
        return float(total - inside + bad) * c * c

    def overhang(self, rects, ko):
        """Outside-the-outline area of the rects that lies inside a keepout rect of the same unit (an antenna
        zone over an outline notch): legal, so it is taken off."""
        if not ko:
            return 0.0
        t = 0.0
        for k, r in enumerate(rects):
            if k in ko:
                continue
            for j in ko:
                q = rects[j]
                a, b, c, d = max(r[0], q[0]), max(r[1], q[1]), min(r[2], q[2]), min(r[3], q[3])
                if c > a and d > b:
                    t += self.rect_area(a, b, c, d, s=self.s_outl)
        return t

    def edge_area(self, rects, ko=(), epads=None):
        """Area of the rects outside the board or in a keepout (not the overhang into its own keepout), and of
        the pads (epads) in the copper-to-edge band; kept copper not counted. Keepout rects (indices ko) do not
        count."""
        return (sum(self.rect_area(*r[:4], s=self.s_edge) for k, r in enumerate(rects) if k not in ko)
                - self.overhang(rects, ko) + sum(self.rect_area(*r[:4], s=self.s_band) for r in epads or ()))

    def gap_area(self, rects, dom):
        """Area of the domain pad rects (u['dom']) within the keepout gap of their class."""
        return sum(self.rect_area(*rects[k][:4], s=self.s_kog[c], outside=False)
                   for k, c, *_ in dom if c in self.s_kog)

    def unit_area(self, rects, pads=None, ko=(), epads=None):
        """Forbidden area of a unit: courtyard rects against all, or (pads given) rects against the edge
        table and pads against the copper table; pads (epads) against the band. Keepout rects (indices ko)
        count only kept copper."""
        t = sum(self.rect_area(*r[:4], s=self.s_cu, outside=False) for k, r in enumerate(rects) if k in ko)
        t += sum(self.rect_area(*r[:4], s=self.s_band) for r in epads or ())
        if pads is None:
            return t + sum(self.rect_area(*r[:4]) for k, r in enumerate(rects) if k not in ko) - self.overhang(rects, ko)
        return (t + self.edge_area(rects, ko)
                + sum(self.rect_area(*r[:4], s=self.s_cu, outside=False) for r in pads))


def pair_penalty(a, b):
    """Spacing overlap of two courtyard box lists [[x0, y0, x1, y1, clr], ...]."""
    a = np.asarray(a, dtype=float).reshape(-1, 5)
    b = np.asarray(b, dtype=float).reshape(-1, 5)
    return _pen(a[:, :4], a[:, 4], b[:, :4], b[:, 4])


def _pen(A, ca, B, cb, ka=None, kb=None, skip=None, ra=None, rb=None):
    g = np.maximum(ca[:, None], cb[None, :])
    if ka is not None and ka[1] is not None and kb[1] is not None:
        g = _domain_gap(g, ca, cb, ka, kb)
    if ra is not None and (ra.any() or rb.any()):  # rounded corners: the inner box, gap + both radii
        A = A + ra[:, None] * np.array([1, 1, -1, -1])
        B = B + rb[:, None] * np.array([1, 1, -1, -1])
        g = g + ra[:, None] + rb[None, :]
    dx = np.minimum(A[:, None, 2], B[None, :, 2]) - np.maximum(A[:, None, 0], B[None, :, 0]) + g
    dy = np.minimum(A[:, None, 3], B[None, :, 3]) - np.maximum(A[:, None, 1], B[None, :, 1]) + g
    a = np.clip(dx, 0, None) * np.clip(dy, 0, None)
    sx, sy = g - dx, g - dy  # the free distance on each axis
    c = (sx > 0) & (sy > 0) & (a > 0)
    if c.any():  # a corner: DRC measures the true distance; scale down to 0 at distance = gap
        d = np.hypot(sx, sy)
        a = np.where(c, a * np.clip((g - d) / np.maximum(g - np.maximum(sx, sy), 1e-9), 0, 1), a)
    if ka is not None:
        a = a * ~(ka[0][:, None] & kb[0][None, :])  # keepout over keepout is legal
    if skip is not None:
        a = a * ~skip
    return float(a.sum())


def hard_clr(u):
    """Hard gap per rect: its clr when in u['hard'] or a domain rect, else 0 (a courtyard: no overlap only)."""
    h = np.zeros(len(u['rects']))
    for i in list(u.get('hard', [])) + [d[0] for d in u.get('dom', [])]:
        h[i] = u['rects'][i][4]
    return h


def _pen_hs(A, ca, ha, B, cb, hb, ka=None, kb=None, sa=None, sb=None, ra=None, rb=None):
    """(hard overlap, soft spacing) of two rect sets: ca/cb = full gaps (D-040 halo), ha/hb = hard gaps,
    sa/sb = soft-only rects (a block border: DRC does not check it), ra/rb = corner radius per rect."""
    skip = None if sa is None or not (sa.any() or sb.any()) else sa[:, None] | sb[None, :]
    hard = _pen(A, ha, B, hb, ka, kb, skip, ra, rb)
    return hard, _pen(A, ca, B, cb, ka, kb, None, ra, rb) - hard


def _domain_gap(g, ca, cb, ka, kb):
    (oa, da, sa, na, xa, T), (ob, db, sb, nb, xb, _) = ka, kb
    both = (da[:, None] > 0) & (db[None, :] > 0)
    if T is None:
        other = np.maximum(sa[:, None], sb[None, :])
    else:  # class gap table (.kicad_dru pair rules), at least the net clearance
        other = np.maximum(T[np.clip(da, 0, None)[:, None], np.clip(db, 0, None)[None, :]],
                           np.maximum(na[:, None], nb[None, :]))
    g = np.where(both, np.where(da[:, None] != db[None, :], other, np.maximum(na[:, None], nb[None, :])), g)
    g = np.where((da[:, None] > 0) & (xb | ob)[None, :], cb[None, :], g)  # no pad, no net: its own class
    g = np.where((xa | oa)[:, None] & (db[None, :] > 0), ca[:, None], g)
    g = np.where((da[:, None] > 0) & (db[None, :] < 0), sb[None, :], g)  # a hole rule (class -1): its gap
    return np.where((da[:, None] < 0) & (db[None, :] > 0), sa[:, None], g)


def radii(u):
    r = np.zeros(len(u['rects']))
    for i, v in u.get('rho', []):
        r[i] = v
    return r


def border_flags(u):
    b = np.zeros(len(u['rects']), dtype=bool)
    b[list(u.get('border', []))] = True
    return b


def class_table(pr):
    cg = pr.get('class_gaps')
    return None if not cg else np.array(cg['gaps'], dtype=float)


def ko_flags(u, T=None):
    """Rect kinds of a unit: (keepout flags, and None or (domain class, class gap, net clearance, mech flags,
    class gap table))."""
    n = len(u['rects'])
    k = np.zeros(n, dtype=bool)
    k[list(u.get('ko', []))] = True
    if u.get('nocu'):  # no copper pad (an NPTH hole): a keepout of another unit may cover it
        k[:] = True
    if not u.get('dom') and not u.get('mech') and not u.get('ko'):
        return (k, None)
    d, sg, nc, x = np.zeros(n, dtype=int), np.zeros(n), np.zeros(n), np.zeros(n, dtype=bool)
    for i, c, a, b in u.get('dom', []):
        d[i], sg[i], nc[i] = c, a, b
    x[list(u.get('mech', []))] = True
    return (k, d, sg, nc, x, T)


def hull(pts):
    """Convex hull of points (Andrew's monotone chain); fewer than 3 distinct points stay as they are."""
    pts = sorted(set(pts))
    if len(pts) < 3:
        return pts

    def half(ps):
        h = []
        for p in ps:
            while len(h) >= 2 and ((h[-1][0] - h[-2][0]) * (p[1] - h[-2][1])
                                   - (h[-1][1] - h[-2][1]) * (p[0] - h[-2][0])) <= 0:
                h.pop()
            h.append(p)
        return h
    return half(pts)[:-1] + half(pts[::-1])[:-1]


def area_pen(R, H, g):
    """Rects R (m x 4) against the convex polygon H (k x 2, k >= 1) grown by g: per rect g - distance when
    nearer than g, g + depth when they overlap (separating axes: x, y and the edge normals of H)."""
    if not len(R):
        return 0.0
    C = np.stack([R[:, [0, 1]], R[:, [2, 1]], R[:, [2, 3]], R[:, [0, 3]]], axis=1)  # m x 4 x 2
    E = np.roll(H, -1, axis=0) - H
    ok = np.hypot(E[:, 0], E[:, 1]) > EPS
    A, E = H[ok], E[ok]  # hull edges: start points and vectors (none for one point)
    axes = np.vstack([[[1.0, 0.0], [0.0, 1.0]], np.stack([-E[:, 1], E[:, 0]], axis=1)
                      / np.hypot(E[:, 0], E[:, 1])[:, None]])
    pc, ph = C @ axes.T, H @ axes.T  # m x 4 x a, k x a
    s = np.maximum(pc.min(axis=1) - ph.max(axis=0), ph.min(axis=0) - pc.max(axis=1)).max(axis=1)
    dx = np.maximum(np.maximum(R[:, 0:1] - H[:, 0], H[:, 0] - R[:, 2:3]), 0.0)  # hull vertices to rects
    dy = np.maximum(np.maximum(R[:, 1:2] - H[:, 1], H[:, 1] - R[:, 3:4]), 0.0)
    d = np.hypot(dx, dy).min(axis=1)
    if len(E):  # rect corners to hull edges
        t = np.clip(((C[:, :, None, :] - A) * E).sum(axis=3) / (E * E).sum(axis=1), 0.0, 1.0)
        q = A + t[..., None] * E - C[:, :, None, :]
        d = np.minimum(d, np.hypot(q[..., 0], q[..., 1]).min(axis=(1, 2)))
    return float(np.where(s < 0, g - s, np.clip(g - d, 0.0, None)).sum())


def area_setup(pr):
    """Domain areas (pr['domain_areas']): [(sources [(unit, domain rect indices)], gap, all sources fixed)], and per
    unit the rect indices that must stay out of them: None for a unit with domain pads; no keepout rect (a slot), no
    NPTH-only part and no block border."""
    areas = []
    for a in pr.get('domain_areas') or []:
        cl = set(a['classes'])
        src = [(i, [k for k, c, *_ in u.get('dom', []) if c in cl]) for i, u in enumerate(pr['units'])]
        src = [(i, ks) for i, ks in src if ks]
        if src:
            areas.append((src, float(a['gap']), all(pr['units'][i]['fixed'] for i, _ in src)))
    subj = []
    for u in pr['units']:
        skip = ko_flags(u)[0] | border_flags(u)
        idx = [k for k in range(len(u['rects'])) if not skip[k]]
        subj.append(None if u.get('dom') or not idx else idx)
    return areas, subj


def area_hulls(areas, world):
    """[(hull k x 2, gap, all sources fixed)] of the areas; world(i) = the world rects (n x 4+) of unit i."""
    out = []
    for src, g, fx in areas:
        pts = [(float(x), float(y)) for i, ks in src for r in np.asarray(world(i))[ks]
               for x, y in ((r[0], r[1]), (r[2], r[1]), (r[2], r[3]), (r[0], r[3]))]
        out.append((np.array(hull(pts), dtype=float), g, fx))
    return out


def unit_area_pen(R, idx, fixed, hulls):
    """Area penalty of one unit: its rects R[idx] against each hull; a fixed unit and an area of fixed parts: 0."""
    if idx is None:
        return 0.0
    R = np.asarray(R, dtype=float)[idx, :4]
    b = (R[:, 0].min(), R[:, 1].min(), R[:, 2].max(), R[:, 3].max())
    return sum(area_pen(R, H, g) for H, g, fx in hulls if not (fixed and fx)  # box test first (speed)
               and b[0] < H[:, 0].max() + g and b[2] > H[:, 0].min() - g
               and b[1] < H[:, 1].max() + g and b[3] > H[:, 1].min() - g)


def domain_area(pr, pose):
    """Hard penalty of the parts without domain pads in the domain areas (0 = legal)."""
    areas, subj = area_setup(pr)
    if not areas:
        return 0.0
    us = pr['units']
    hs = area_hulls(areas, lambda i: world_rects(us[i], pose[i]))
    return sum(unit_area_pen(world_rects(u, pose[i]), subj[i], u['fixed'], hs) for i, u in enumerate(us))


def world_rects(u, pose_u):
    x, y, r = pose_u
    return [[a + x, b + y, c + x, d + y, rc[4]] for rc in u['rects'] for (a, b, c, d) in [rot_rect(rc, r)]]


def net_box(net, pose):
    xs0, ys0, xs1, ys1 = [], [], [], []
    for p in net['pins']:
        x, y, r = pose[p[0]]
        a, b, c, d = rot_rect(p[1:5], r)
        xs0.append(a + x)
        ys0.append(b + y)
        xs1.append(c + x)
        ys1.append(d + y)
    return (min(xs0), min(ys0), max(xs1), max(ys1))


def hpwl(pr, pose):
    t = 0.0
    for n in pr['nets']:
        b = net_box(n, pose)
        t += n['weight'] * ((b[2] - b[0]) + (b[3] - b[1]))
    return t


def fixed_grid(pr, params):
    """RUDY demand of the kept copper (mm of wire per cell). A track on a routing layer uses its length *
    (width + gap) / pitch; a via uses (diameter + gap)^2 / pitch on each of the `layers` routing layers."""
    p = params_with_defaults(params)
    grid = Grid(pr['board'], p['rudy_cell'])
    g = np.zeros((grid.ny, grid.nx))
    c, pitch, gap = grid.c, p['pitch'], p['gap']

    def add(x, y, v):
        i = math.floor((x - grid.x0) / c)
        j = math.floor((y - grid.y0) / c)
        if 0 <= i < grid.nx and 0 <= j < grid.ny:
            g[j, i] += v
    for layer, a0, b0, a1, b1, w in pr['board'].get('copper', []):
        if layer == 'via':
            add(a0, b0, (w + gap) ** 2 / pitch * p['layers'])
        elif layer in ROUTE_LAYERS:
            length = math.hypot(a1 - a0, b1 - b0)
            n = max(1, math.ceil(length / (c / 4)))
            for k in range(n):
                f = (k + 0.5) / n
                add(a0 + f * (a1 - a0), b0 + f * (b1 - b0), length / n * (w + gap) / pitch)
    return g


def track_factor(net, p):
    """RUDY demand factor of a net: with params tracks = 1, its track (net-class width + clearance) over the
    routing pitch; 1 without a track or with tracks = 0 (the default)."""
    return net['track'] / p['pitch'] if p.get('tracks') and 'track' in net else 1.0


def rudy_grid(pr, pose, params):
    p = params_with_defaults(params)
    grid = Grid(pr['board'], p['rudy_cell'])
    g = fixed_grid(pr, p)
    for n in pr['nets']:
        b = net_box(n, pose)
        s = grid.span(b)
        wl = (b[2] - b[0]) + (b[3] - b[1])
        if s is None or wl <= 0:
            continue
        g[s[0]:s[1], s[2]:s[3]] += track_factor(n, p) * wl / ((s[1] - s[0]) * (s[3] - s[2]))
    if p['pin_demand']:
        for u, (x, y, r) in zip(pr['units'], pose):
            for q in u.get('pads', []):
                a, b = rot_pt(q[0], q[1], r)
                i = math.floor((a + x - grid.x0) / grid.c)
                j = math.floor((b + y - grid.y0) / grid.c)
                if 0 <= i < grid.nx and 0 <= j < grid.ny:
                    g[j, i] += p['pin_demand']
    return g


def cell_weights(pr, params):
    reg = pr.get('region')
    if not reg or not reg.get('box'):
        return None
    p = params_with_defaults(params)
    grid = Grid(pr['board'], p['rudy_cell'])
    xs = grid.x0 + (np.arange(grid.nx) + 0.5) * grid.c
    ys = grid.y0 + (np.arange(grid.ny) + 0.5) * grid.c
    x0, y0, x1, y1 = reg['box']
    w = np.ones((grid.ny, grid.nx))
    w[np.ix_((ys >= y0) & (ys <= y1), (xs >= x0) & (xs <= x1))] = reg['weight']
    return w


def threshold(params):
    p = params_with_defaults(params)
    return p['limit'] * p['rudy_cell'] ** 2 * p['layers'] / p['pitch']


def overflow(g, params, cw):
    ex = np.clip(g - threshold(params), 0, None)
    return float((ex * cw).sum() if cw is not None else ex.sum())


def _overlaps(pr, pose):
    us = pr['units']
    T = class_table(pr)
    w = [np.array(world_rects(u, pose[i]), dtype=float).reshape(-1, 5) for i, u in enumerate(us)]
    h, s = 0.0, 0.0
    for i in range(len(us)):
        for j in range(i + 1, len(us)):
            if us[i]['fixed'] and us[j]['fixed']:
                continue
            a, b = _pen_hs(w[i][:, :4], w[i][:, 4], hard_clr(us[i]), w[j][:, :4], w[j][:, 4], hard_clr(us[j]),
                           ko_flags(us[i], T), ko_flags(us[j], T), border_flags(us[i]), border_flags(us[j]),
                           radii(us[i]), radii(us[j]))
            h, s = h + a, s + b
    return h + domain_area(pr, pose), s


def overlap(pr, pose):
    """Hard overlap (0 = legal)."""
    return _overlaps(pr, pose)[0]


def spacing(pr, pose):
    """Soft D-040 spacing overlap."""
    return _overlaps(pr, pose)[1]


def world_pads(u, pose_u, key='pad_rects'):
    """World pad boxes of a unit, or None when the unit has no pad_rects."""
    if key not in u:
        return None
    x, y, r = pose_u
    return [[a + x, b + y, c + x, d + y] for rc in u[key] for (a, b, c, d) in [rot_rect(rc, r)]]


def edge_pads(u, pose_u):
    """World copper boxes for the edge band: pad_rects, else edge_pads (a block)."""
    return world_pads(u, pose_u) or world_pads(u, pose_u, 'edge_pads')


def edge_miss(u, pose_u, board, box=None):
    """Edge anchor: u['edge'] = {'at': local point, 'sides': subset of 'LRTB', 'tol'} must lie on one of the
    sides (inner line = outline box minus edge_clearance; T = smaller y). Returns the miss in mm beyond tol."""
    e = u.get('edge')
    if not e:
        return 0.0
    x0, y0, x1, y1 = box or outline_box(board)
    c = board.get('edge_clearance', 0.0)
    ax, ay = rot_pt(e['at'][0], e['at'][1], pose_u[2])
    ax, ay = ax + pose_u[0], ay + pose_u[1]
    d = {'L': abs(ax - x0 - c), 'R': abs(x1 - c - ax), 'T': abs(ay - y0 - c), 'B': abs(y1 - c - ay)}
    return max(0.0, min(d[s] for s in e['sides']) - e.get('tol', 0.5))


def forbidden(pr, pose, mask, i):
    u = pr['units'][i]
    w = world_rects(u, pose[i])
    return (mask.unit_area(w, world_pads(u, pose[i]), set(u.get('ko', [])), edge_pads(u, pose[i]))
            + mask.gap_area(w, u.get('dom', [])) + edge_miss(u, pose[i], pr['board']))


VIA_EXTRA = (0.2, 0.5)  # via site distance beyond the pad edge + via radius (tools/gnd_pad_vias.py)
VIA_DIRS = ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, 1), (1, -1), (-1, -1))


def _poly_d2(gx, gy, poly):
    """Squared distance of the points to the polygon edges."""
    d2 = np.full(gx.shape, np.inf)
    for k in range(len(poly)):
        (a0, b0), (a1, b1) = poly[k], poly[(k + 1) % len(poly)]
        dx, dy = a1 - a0, b1 - b0
        ll = dx * dx + dy * dy
        t = np.clip(((gx - a0) * dx + (gy - b0) * dy) / ll, 0, 1) if ll > 0 else 0.0
        d2 = np.minimum(d2, (gx - a0 - t * dx) ** 2 + (gy - b0 - t * dy) ** 2)
    return d2


class ViaSites:
    """Via centres the board allows: inside the outline, edge_clearance + via radius from it, and not inside or
    within the via radius of a no-via rule area of the board (board['via_keepouts'] polygons)."""

    def __init__(self, board, r, cell=0.1):
        x0, y0, x1, y1 = outline_box(board)
        self.x0, self.y0, self.c = x0, y0, cell
        self.nx, self.ny = math.ceil((x1 - x0) / cell) + 1, math.ceil((y1 - y0) / cell) + 1
        gx, gy = np.meshgrid(x0 + np.arange(self.nx) * cell, y0 + np.arange(self.ny) * cell)
        poly = board['outline']
        g = board.get('edge_clearance', 0.0) + r
        self.ok = point_in_poly(gx, gy, poly) & (_poly_d2(gx, gy, poly) >= g * g - EPS)
        for ko in board.get('via_keepouts', ()):
            self.ok &= ~point_in_poly(gx, gy, ko) & (_poly_d2(gx, gy, ko) >= r * r - EPS)

    def test(self, xs, ys):
        i = np.rint((xs - self.x0) / self.c).astype(int)
        j = np.rint((ys - self.y0) / self.c).astype(int)
        inside = (i >= 0) & (i < self.nx) & (j >= 0) & (j < self.ny)
        out = np.zeros(xs.shape, dtype=bool)
        out[inside] = self.ok[j[inside], i[inside]]
        return out


def world_cu(u, pose_u):
    """(N, 5) world copper pad boxes of a unit with their net code (u['cu'])."""
    x, y, r = pose_u
    return np.array([[a + x, b + y, c + x, d + y, q[4]] for q in u.get('cu', ()) for (a, b, c, d) in [rot_rect(q, r)]],
                    dtype=float).reshape(-1, 5)


def via_reach(p):
    """Distance beyond a pad box within which copper can block its via sites."""
    return max(VIA_EXTRA) + p['via_d'] + p['via_clr']


def via_blocked(vp, obs, sites, p):
    """Count of via-net pads vp (M, 5) with no free via site: each of the 16 sites is off the board (sites)
    or within via radius + clearance of copper of another net in obs (K, 5). Net code -1 in obs = a no-via
    rule area of a unit: it blocks within the via radius."""
    if not len(vp):
        return 0
    rv = p['via_d'] / 2
    g = rv + p['via_clr']
    cx, cy = (vp[:, 0] + vp[:, 2]) / 2, (vp[:, 1] + vp[:, 3]) / 2
    hx, hy = (vp[:, 2] - vp[:, 0]) / 2, (vp[:, 3] - vp[:, 1]) / 2
    sx = np.stack([cx + dx * (hx + rv + e) for e in VIA_EXTRA for dx, dy in VIA_DIRS], axis=1)
    sy = np.stack([cy + dy * (hy + rv + e) for e in VIA_EXTRA for dx, dy in VIA_DIRS], axis=1)
    free = sites.test(sx, sy)
    if len(obs):
        ddx = np.maximum(np.maximum(obs[:, 0] - sx[..., None], sx[..., None] - obs[:, 2]), 0.0)
        ddy = np.maximum(np.maximum(obs[:, 1] - sy[..., None], sy[..., None] - obs[:, 3]), 0.0)
        other = (obs[:, 4][None, :] != vp[:, 4][:, None])[:, None, :]
        gg = np.where(obs[:, 4] == -1, rv, g) ** 2 - EPS
        free &= ~((ddx * ddx + ddy * ddy < gg) & other).any(axis=2)
    return int((~free.any(axis=1)).sum())


def via_room(pr, pose, params):
    """Count of pads on a via net (pr['via_nets']) with no free via site (see via_blocked)."""
    p = params_with_defaults(params)
    vn = list(pr.get('via_nets') or ())
    if not vn:
        return 0
    sites = ViaSites(pr['board'], p['via_d'] / 2)
    W = [world_cu(u, pose[i]) for i, u in enumerate(pr['units'])]
    obs = np.concatenate(W) if W else np.zeros((0, 5))
    return sum(via_blocked(w[np.isin(w[:, 4], vn)], obs, sites, p) for w in W)


def bump(x):
    """Cypress crossing bump: 1 - 2x^2 for |x| <= 0.5, 2 (1 - |x|)^2 for |x| <= 1, else 0."""
    a = np.abs(x)
    return np.where(a <= 0.5, 1 - 2 * a * a, np.where(a <= 1.0, 2 * (1 - a) ** 2, 0.0))


def cross_matrix(A, na, B, nb):
    """Crossing penalty of each segment in A (m, 4) with each in B (k, 4); 0 for the same net."""
    r = A[:, None, 2:] - A[:, None, :2]
    s_ = B[None, :, 2:] - B[None, :, :2]
    qp = B[None, :, :2] - A[:, None, :2]
    den = r[..., 0] * s_[..., 1] - r[..., 1] * s_[..., 0]
    ok = (np.abs(den) > EPS) & (na[:, None] != nb[None, :])
    d = np.where(ok, den, 1.0)
    t = (qp[..., 0] * s_[..., 1] - qp[..., 1] * s_[..., 0]) / d
    u = (qp[..., 0] * r[..., 1] - qp[..., 1] * r[..., 0]) / d
    return np.where(ok, bump(t - 0.5) * bump(u - 0.5), 0.0)


def star_segments(pr, pose):
    """Star model of each net: a segment from each pin centre to the mean of the net pin centres."""
    seg, sn = [], []
    for k, n in enumerate(pr['nets']):
        pts = []
        for q in n['pins']:
            a, b, c, d = rot_rect(q[1:5], pose[q[0]][2])
            pts.append(((a + c) / 2 + pose[q[0]][0], (b + d) / 2 + pose[q[0]][1]))
        cx, cy = sum(x for x, _ in pts) / len(pts), sum(y for _, y in pts) / len(pts)
        seg += [(x, y, cx, cy) for x, y in pts]
        sn += [k] * len(pts)
    return np.array(seg, dtype=float).reshape(-1, 4), np.array(sn, dtype=int)


def crossings(pr, pose):
    """Smooth count of net crossings (star segments of different nets, Cypress bump)."""
    S, sn = star_segments(pr, pose)
    return float(cross_matrix(S, sn, S, sn).sum() / 2) if len(S) else 0.0


ROW_TOL = 0.2  # mm: rect sizes of one block kind may differ by this much (footprint rounding)


def row_groups(pr):
    """Repeated blocks: movable units of 2 or more parts with the same part count and pad count and rect sizes
    within ROW_TOL; groups of 2 or more (unit indices)."""
    groups = []  # [(part count, pad count, sorted rect sizes), [unit indices]]
    for i, u in enumerate(pr['units']):
        if u['fixed'] or len(u.get('refs', [])) < 2:
            continue
        sig = (len(u['refs']), len(u.get('pads', [])), sorted((r[2] - r[0], r[3] - r[1]) for r in u['rects']))
        for g in groups:
            s = g[0]
            if s[:2] == sig[:2] and len(s[2]) == len(sig[2]) and all(
                    abs(a[0] - b[0]) <= ROW_TOL and abs(a[1] - b[1]) <= ROW_TOL for a, b in zip(s[2], sig[2])):
                g[1].append(i)
                break
        else:
            groups.append((sig, [i]))
    return [g for _, g in groups if len(g) >= 2]


def row_cost(pts, pitch=1.0):
    """Row term of one group of points: sum |minor coordinate - median| on the axis with the smaller spread,
    + pitch * sum |gap - mean gap| along the other axis."""
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]

    def dev(v):
        m = float(np.median(v))
        return sum(abs(a - m) for a in v)
    dx, dy = dev(xs), dev(ys)
    minor, major = (dy, xs) if dy <= dx else (dx, ys)
    s = sorted(major)
    gaps = [b - a for a, b in zip(s, s[1:])]
    mg = sum(gaps) / len(gaps)
    return minor + pitch * sum(abs(g - mg) for g in gaps)


def rows(pr, pose, pitch=1.0):
    """Row term: repeated blocks out of a common row or column, or at an unequal pitch (row_cost per group)."""
    return sum(row_cost([pose[i][:2] for i in g], pitch) for g in row_groups(pr))


def components(pr, pose, params):
    p = params_with_defaults(params)
    mask = Mask(pr['board'], p['mask_cell'], p['gap'])
    return {'hpwl': hpwl(pr, pose),
            'cong': overflow(rudy_grid(pr, pose, p), p, cell_weights(pr, p)),
            'overlap': overlap(pr, pose),
            'oob': sum(forbidden(pr, pose, mask, i) for i, u in enumerate(pr['units']) if not u['fixed']),
            'spacing': spacing(pr, pose),
            'via': via_room(pr, pose, p),
            'crossing': crossings(pr, pose) if p['w_x'] else 0.0,  # not computed at weight 0 (speed)
            'row': rows(pr, pose, p['row_pitch']) if p['w_row'] else 0.0}


def weighted(comp, params):
    p = params_with_defaults(params)
    return (p['w_wl'] * comp['hpwl'] + p['w_cong'] * comp['cong'] + p['w_ov'] * comp['overlap']
            + p['w_oob'] * comp['oob'] + p['w_sp'] * comp.get('spacing', 0.0) + p['w_via'] * comp.get('via', 0)
            + p['w_x'] * comp.get('crossing', 0.0) + p['w_row'] * comp.get('row', 0.0))


def total(pr, pose, params):
    return weighted(components(pr, pose, params), params)


class Evaluator:
    """Incremental cost. propose() applies a move and returns the cost delta; then commit() or revert()."""

    def __init__(self, pr, params, pose=None, mask=None):
        p = self.p = params_with_defaults(params)
        us = pr['units']
        self.n = len(us)
        self.fixed = [bool(u['fixed']) for u in us]
        self.lrect = [[np.array([rot_rect(rc, r) for rc in u['rects']], dtype=float).reshape(-1, 4)
                       for r in range(4)] for u in us]
        self.clr = [np.array([rc[4] for rc in u['rects']], dtype=float) for u in us]
        self.ko = [ko_flags(u, class_table(pr)) for u in us]  # rect kinds
        self.hclr = [hard_clr(u) for u in us]
        self.bd = [border_flags(u) for u in us]
        self.rho = [radii(u) for u in us]
        self.kos = [set(u.get('ko', [])) for u in us]
        self.lbox = [[(lr[:, 0].min(), lr[:, 1].min(), lr[:, 2].max(), lr[:, 3].max()) for lr in self.lrect[i]]
                     for i in range(self.n)]
        T = class_table(pr)
        tg = float(T.max()) if T is not None else 0.0
        # pair search box: the largest gap of the unit, incl. hole and class-table gaps of its domain rects
        self.grow = [max([float(c.max()) if len(c) else 0.0] + [max(d[2], tg) for d in u.get('dom', [])])
                     for c, u in zip(self.clr, us)]
        self.area = [float(((lr[0][:, 2] - lr[0][:, 0]) * (lr[0][:, 3] - lr[0][:, 1])).sum()) for lr in self.lrect]
        pose = pose or initial_pose(pr)
        self.X = [float(q[0]) for q in pose]
        self.Y = [float(q[1]) for q in pose]
        self.R = [int(q[2]) % 4 for q in pose]
        self.UB = np.zeros((self.n, 4))
        for i in range(self.n):
            self._set_ub(i)
        self.lpad = [None if 'pad_rects' not in u else
                     [np.array([rot_rect(rc, r) for rc in u['pad_rects']], dtype=float).reshape(-1, 4) for r in range(4)]
                     for u in us]
        self.lepad = [lp if lp is not None or 'edge_pads' not in u else
                      [np.array([rot_rect(rc, r) for rc in u['edge_pads']], dtype=float).reshape(-1, 4) for r in range(4)]
                      for lp, u in zip(self.lpad, us)]
        self.mask = mask or Mask(pr['board'], p['mask_cell'], p['gap'])
        self.units, self.board, self.obox = us, pr['board'], outline_box(pr['board'])
        self.forb = [0.0 if self.fixed[i] else self._forb(i) for i in range(self.n)]
        # nets
        self.nw = [float(n['weight']) for n in pr['nets']]
        self.npins = [[(q[0], [rot_rect(q[1:5], r) for r in range(4)]) for q in n['pins']] for n in pr['nets']]
        un = [set() for _ in range(self.n)]
        for k, n in enumerate(pr['nets']):
            for q in n['pins']:
                un[q[0]].add(k)
        self.unit_nets = [sorted(s) for s in un]
        self.grid = Grid(pr['board'], p['rudy_cell'])
        self.G = fixed_grid(pr, p)
        self.pd = p['pin_demand']
        self.pads = []
        for u in us:
            q = np.array(u.get('pads', []) if self.pd else [], dtype=float).reshape(-1, 2)
            self.pads.append([np.array([rot_pt(a, b, r) for a, b in q.tolist()], dtype=float).reshape(-1, 2)
                              for r in range(4)])
        for i in range(self.n):
            self._stamp(i, 1.0)
        self.thr = threshold(p)
        self.cw = cell_weights(pr, p)
        self.nbox, self.nlen, self.nrudy = [], [], []
        self.ntf = [track_factor(n, p) for n in pr['nets']]
        for k in range(len(self.nw)):
            b = self._net_box(k)
            self.nbox.append(b)
            self.nlen.append((b[2] - b[0]) + (b[3] - b[1]))
            rd = self._rudy(b, self.ntf[k])
            self.nrudy.append(rd)
            if rd:
                self.G[rd[0]:rd[1], rd[2]:rd[3]] += rd[4]
        self.comp = [sum(w * ln for w, ln in zip(self.nw, self.nlen)),
                     self._excess((0, self.grid.ny, 0, self.grid.nx)),
                     0.0,
                     sum(self.forb),
                     0.0]
        self.comp[2], self.comp[4] = self._overlap_all()
        # domain areas (mains): the hulls move with the domain parts
        self.areas, self.subj = area_setup(pr)
        self.adom = {i for src, *_ in self.areas for i, _ in src}
        self.hulls = area_hulls(self.areas, self._world)
        self.apen = [self._apen(i, self.hulls) for i in range(self.n)]
        self.comp[2] += sum(self.apen)
        # via room: via-net pads (lvia) and the copper box of each unit (CB)
        self.vn = list(pr.get('via_nets') or ())
        self.vsites = ViaSites(pr['board'], p['via_d'] / 2) if self.vn else None
        self.vreach = via_reach(p)
        self.lcu = [[world_cu(u, (0.0, 0.0, r)) for r in range(4)] for u in us]
        self.lvia = [np.isin(c[0][:, 4], self.vn) for c in self.lcu]
        self.CB = np.zeros((self.n, 4))
        for i in range(self.n):
            self._set_cb(i)
        self.vb = [self._vcount(i) for i in range(self.n)]
        self.comp.append(sum(self.vb))
        # net crossings: star segments, contiguous per net (soff[k]:soff[k + 1])
        self.S, self.sn = star_segments(pr, self.pose())
        self.soff = np.concatenate([[0], np.cumsum([len(n['pins']) for n in pr['nets']])]).astype(int)
        if not p['w_x']:  # weight 0: not computed (speed)
            self.S = self.S[:0]
        self.comp.append(float(cross_matrix(self.S, self.sn, self.S, self.sn).sum() / 2) if len(self.S) else 0.0)
        # repeated-block rows (not computed at weight 0)
        self.rg = row_groups(pr) if p['w_row'] else []
        self.unit_rg = {i: k for k, g in enumerate(self.rg) for i in g}
        self.rv = [row_cost([(self.X[i], self.Y[i]) for i in g], p['row_pitch']) for g in self.rg]
        self.comp.append(sum(self.rv))
        self.cost = self._weighted(self.comp)
        self.pending = None

    # helpers
    def _weighted(self, c):
        p = self.p
        return (p['w_wl'] * c[0] + p['w_cong'] * c[1] + p['w_ov'] * c[2] + p['w_oob'] * c[3] + p['w_sp'] * c[4]
                + p['w_via'] * c[5] + p['w_x'] * c[6] + p['w_row'] * c[7])

    def _cu(self, i):
        return self.lcu[i][self.R[i]] + (self.X[i], self.Y[i], self.X[i], self.Y[i], 0.0)

    def _set_cb(self, i):
        c = self.lcu[i][self.R[i]]
        if not len(c):
            self.CB[i] = (math.inf, math.inf, -math.inf, -math.inf)  # meets nothing
            return
        self.CB[i] = (c[:, 0].min() + self.X[i], c[:, 1].min() + self.Y[i],
                      c[:, 2].max() + self.X[i], c[:, 3].max() + self.Y[i])

    def _cb_near(self, b, g):
        """Units whose copper box meets box b grown by g."""
        C = self.CB
        return np.nonzero((C[:, 0] < b[2] + g) & (C[:, 2] > b[0] - g) & (C[:, 1] < b[3] + g) & (C[:, 3] > b[1] - g))[0]

    def _vcount(self, i):
        if self.vsites is None or not self.lvia[i].any():
            return 0
        obs = np.concatenate([self._cu(int(k)) for k in self._cb_near(self.CB[i], self.vreach)])
        return via_blocked(self._cu(i)[self.lvia[i]], obs, self.vsites, self.p)

    def _net_star(self, k):
        pts = np.array([((b[0] + b[2]) / 2 + self.X[u], (b[1] + b[3]) / 2 + self.Y[u])
                        for u, rb in self.npins[k] for b in [rb[self.R[u]]]], dtype=float)
        c = pts.mean(axis=0)
        return np.hstack([pts, np.broadcast_to(c, pts.shape)])

    def _cross_part(self, C):
        """Crossings of the segments C with all segments, pairs inside C counted once."""
        m = cross_matrix(self.S[C], self.sn[C], self.S, self.sn)
        return float(m.sum() - 0.5 * m[:, C].sum())

    def _via_units(self, M):
        """Units with via pads whose count can depend on the copper of the units M (at their current pose)."""
        return {int(j) for i in M for j in self._cb_near(self.CB[i], self.vreach) if self.lvia[j].any()}

    def _set_ub(self, i):
        b = self.lbox[i][self.R[i]]
        g = self.grow[i]
        self.UB[i] = (b[0] + self.X[i] - g, b[1] + self.Y[i] - g, b[2] + self.X[i] + g, b[3] + self.Y[i] + g)

    def _world(self, i):
        return self.lrect[i][self.R[i]] + (self.X[i], self.Y[i], self.X[i], self.Y[i])

    def _epads(self, i):
        lp = self.lepad[i]
        return None if lp is None else (lp[self.R[i]] + (self.X[i], self.Y[i], self.X[i], self.Y[i])).tolist()

    def _forb(self, i):
        lp = self.lpad[i]
        pads = None if lp is None else (lp[self.R[i]] + (self.X[i], self.Y[i], self.X[i], self.Y[i])).tolist()
        w = self._world(i).tolist()
        return (self.mask.unit_area(w, pads, self.kos[i], self._epads(i)) + self.mask.gap_area(w, self.units[i].get('dom', []))
                + edge_miss(self.units[i], (self.X[i], self.Y[i], self.R[i]), self.board, self.obox))

    def _pen(self, i, j):
        """(hard, soft) of units i and j."""
        return _pen_hs(self._world(i), self.clr[i], self.hclr[i], self._world(j), self.clr[j], self.hclr[j],
                       self.ko[i], self.ko[j], self.bd[i], self.bd[j], self.rho[i], self.rho[j])

    def _unit_pairs(self, i, skip):
        b = self.UB[i]
        U = self.UB
        cand = np.nonzero((U[:, 0] < b[2]) & (U[:, 2] > b[0]) & (U[:, 1] < b[3]) & (U[:, 3] > b[1]))[0]
        h, s = 0.0, 0.0
        for j in cand:
            if j != i and j not in skip:
                a, c = self._pen(i, int(j))
                h, s = h + a, s + c
        return h, s

    def _apen(self, i, hulls):
        return unit_area_pen(self._world(i), self.subj[i], self.fixed[i], hulls) if hulls else 0.0

    def _unit_overlap(self, i, skip):
        a = 0.0
        if self.areas:  # a domain part: the area of all others at its pose; another part: its own
            hs = area_hulls(self.areas, self._world) if i in self.adom else self.hulls
            a = sum(self._apen(j, hs) for j in range(self.n)) if i in self.adom else self._apen(i, hs)
        return self._unit_pairs(i, skip)[0] + a

    def _overlap_all(self):
        h, s = 0.0, 0.0
        for i in range(self.n):
            if self.fixed[i]:
                continue
            # count movable-movable pairs once (j > i) and movable-fixed pairs always
            skip = {j for j in range(self.n) if (j < i and not self.fixed[j])}
            a, b = self._unit_pairs(i, skip)
            h, s = h + a, s + b
        return h, s

    def _net_box(self, k):
        x0 = y0 = math.inf
        x1 = y1 = -math.inf
        X, Y, R = self.X, self.Y, self.R
        for u, rb in self.npins[k]:
            a, b, c, d = rb[R[u]]
            x, y = X[u], Y[u]
            if a + x < x0:
                x0 = a + x
            if b + y < y0:
                y0 = b + y
            if c + x > x1:
                x1 = c + x
            if d + y > y1:
                y1 = d + y
        return (x0, y0, x1, y1)

    def _pad_cells(self, i):
        q = self.pads[i][self.R[i]]
        if not len(q):
            return None
        g = self.grid
        ii = np.floor((q[:, 0] + self.X[i] - g.x0) / g.c).astype(int)
        jj = np.floor((q[:, 1] + self.Y[i] - g.y0) / g.c).astype(int)
        ok = (ii >= 0) & (ii < g.nx) & (jj >= 0) & (jj < g.ny)
        if not ok.any():
            return None
        return jj[ok], ii[ok]

    def _stamp(self, i, sign):
        c = self._pad_cells(i)
        if c is not None:
            np.add.at(self.G, c, sign * self.pd)

    def _pad_span(self, i):
        c = self._pad_cells(i)
        if c is None:
            return None
        return (int(c[0].min()), int(c[0].max()) + 1, int(c[1].min()), int(c[1].max()) + 1)

    def _rudy(self, b, f):
        wl = (b[2] - b[0]) + (b[3] - b[1])
        s = self.grid.span(b)
        if s is None or wl <= 0:
            return None
        return (s[0], s[1], s[2], s[3], f * wl / ((s[1] - s[0]) * (s[3] - s[2])))

    def _excess(self, s):
        g = self.G[s[0]:s[1], s[2]:s[3]]
        ex = np.clip(g - self.thr, 0, None)
        if self.cw is not None:
            ex = ex * self.cw[s[0]:s[1], s[2]:s[3]]
        return float(ex.sum())

    def _moved_pairs(self, M, Ms):
        h, s = 0.0, 0.0
        for i in M:
            a, b = self._unit_pairs(i, Ms)
            h, s = h + a, s + b
        for a in range(len(M)):
            for b in range(a + 1, len(M)):
                x, y = self._pen(M[a], M[b])
                h, s = h + x, s + y
        return h, s

    # public
    def pose(self):
        return [(self.X[i], self.Y[i], self.R[i]) for i in range(self.n)]

    def components(self):
        return {'hpwl': self.comp[0], 'cong': self.comp[1], 'overlap': self.comp[2], 'oob': self.comp[3],
                'spacing': self.comp[4], 'via': self.comp[5], 'crossing': self.comp[6], 'row': self.comp[7]}

    def unit_penalty(self, i):
        """Spacing overlap + forbidden area of one unit (0 = legal)."""
        return self._unit_overlap(i, set()) + self.forb[i]

    def legal_penalty(self, i):
        """Spacing overlap + edge/keepout area (0 = legal). Kept copper is a cost only: the writer rips up
        the copper that a moved pad lands on."""
        w = self._world(i).tolist()
        return (self._unit_overlap(i, set()) + self.mask.edge_area(w, self.kos[i], self._epads(i))
                + self.mask.gap_area(w, self.units[i].get('dom', []))
                + edge_miss(self.units[i], (self.X[i], self.Y[i], self.R[i]), self.board, self.obox))

    def legal_penalty_at(self, i, x, y, r):
        old = (self.X[i], self.Y[i], self.R[i])
        self.X[i], self.Y[i], self.R[i] = x, y, r % 4
        self._set_ub(i)
        pen = self.legal_penalty(i)
        self.X[i], self.Y[i], self.R[i] = old
        self._set_ub(i)
        return pen

    def penalty_at(self, i, x, y, r):
        """unit_penalty(i) with unit i at (x, y, r); the state does not change."""
        old = (self.X[i], self.Y[i], self.R[i])
        self.X[i], self.Y[i], self.R[i] = x, y, r % 4
        self._set_ub(i)
        pen = self._unit_overlap(i, set()) + self._forb(i)
        self.X[i], self.Y[i], self.R[i] = old
        self._set_ub(i)
        return pen

    def propose(self, moves):
        if self.pending is not None:
            raise RuntimeError('propose() before commit()/revert()')
        M = [m[0] for m in moves]
        Ms = set(M)
        for i in M:
            if self.fixed[i]:
                raise ValueError('unit %d is fixed' % i)
        old_pose = [(i, self.X[i], self.Y[i], self.R[i]) for i in M]
        pad_spans = [self._pad_span(i) for i in M] if self.pd else []
        pad_old = [(i, self._pad_cells(i)) for i in M] if self.pd else []
        ov0, sp0 = self._moved_pairs(M, Ms)
        fb0 = sum(self.forb[i] for i in M)
        va = self._via_units(M) if self.vsites is not None else set()
        for i, x, y, r in moves:
            self.X[i], self.Y[i], self.R[i] = float(x), float(y), int(r) % 4
            self._set_ub(i)
            self._set_cb(i)
        ov1, sp1 = self._moved_pairs(M, Ms)
        old_area = (self.hulls, self.apen)
        if self.areas:
            if Ms & self.adom:
                self.hulls = area_hulls(self.areas, self._world)
                self.apen = [self._apen(j, self.hulls) for j in range(self.n)]
            else:
                self.apen = list(self.apen)
                for i in M:
                    self.apen[i] = self._apen(i, self.hulls)
            ov1 += sum(self.apen) - sum(old_area[1])
        old_vb = []
        if self.vsites is not None:
            va |= self._via_units(M)
            old_vb = [(j, self.vb[j]) for j in va]
            for j in va:
                self.vb[j] = self._vcount(j)
        dvia = sum(self.vb[j] - v for j, v in old_vb)
        old_forb = [(i, self.forb[i]) for i in M]
        for i in M:
            self.forb[i] = self._forb(i)
        fb1 = sum(self.forb[i] for i in M)
        nets = sorted(set(k for i in M for k in self.unit_nets[i]))
        old_nets = []
        dwl = 0.0
        new_r = []
        for k in nets:
            b = self._net_box(k)
            ln = (b[2] - b[0]) + (b[3] - b[1])
            old_nets.append((k, self.nbox[k], self.nlen[k], self.nrudy[k]))
            dwl += self.nw[k] * (ln - self.nlen[k])
            self.nbox[k], self.nlen[k] = b, ln
            new_r.append(self._rudy(b, self.ntf[k]))
        dx_, old_seg = 0.0, None
        if nets and len(self.S):
            C = np.concatenate([np.arange(self.soff[k], self.soff[k + 1]) for k in nets])
            x0_ = self._cross_part(C)
            old_seg = (C, self.S[C].copy())
            for k in nets:
                self.S[self.soff[k]:self.soff[k + 1]] = self._net_star(k)
            dx_ = self._cross_part(C) - x0_
        pad_new = [(i, self._pad_cells(i)) for i in M] if self.pd else []
        pad_spans += [self._pad_span(i) for i in M] if self.pd else []
        spans = [q[3] for q in old_nets if q[3]] + [q for q in new_r if q] + [q for q in pad_spans if q]
        dcong, saved = 0.0, None
        if spans:
            reg = (min(q[0] for q in spans), max(q[1] for q in spans), min(q[2] for q in spans), max(q[3] for q in spans))
            e0 = self._excess(reg)
            saved = (reg, self.G[reg[0]:reg[1], reg[2]:reg[3]].copy())
            for (k, _, _, rd), nr in zip(old_nets, new_r):
                if rd:
                    self.G[rd[0]:rd[1], rd[2]:rd[3]] -= rd[4]
                if nr:
                    self.G[nr[0]:nr[1], nr[2]:nr[3]] += nr[4]
                self.nrudy[k] = nr
            for (_, c0), (_, c1) in zip(pad_old, pad_new):
                if c0 is not None:
                    np.add.at(self.G, c0, -self.pd)
                if c1 is not None:
                    np.add.at(self.G, c1, self.pd)
            dcong = self._excess(reg) - e0
        old_rv = [(k, self.rv[k]) for k in sorted({self.unit_rg[i] for i, *_ in old_pose if i in self.unit_rg})]
        drow = 0.0
        for k, v in old_rv:
            self.rv[k] = row_cost([(self.X[i], self.Y[i]) for i in self.rg[k]], self.p['row_pitch'])
            drow += self.rv[k] - v
        d = [dwl, dcong, ov1 - ov0, fb1 - fb0, sp1 - sp0, dvia, dx_, drow]
        delta = self._weighted(d)
        self.pending = (old_pose, old_forb, old_nets, saved, list(self.comp), self.cost, old_vb, old_seg, old_rv, old_area)
        self.last_old = [(i, x, y, r) for i, x, y, r in old_pose]
        for a in range(8):
            self.comp[a] += d[a]
        self.cost += delta
        return delta

    def commit(self):
        self.pending = None

    def revert(self):
        old_pose, old_forb, old_nets, saved, comp, c, old_vb, old_seg, old_rv, old_area = self.pending
        self.hulls, self.apen = old_area
        for k, v in old_rv:
            self.rv[k] = v
        if old_seg is not None:
            self.S[old_seg[0]] = old_seg[1]
        for i, x, y, r in old_pose:
            self.X[i], self.Y[i], self.R[i] = x, y, r
            self._set_ub(i)
            self._set_cb(i)
        for j, v in old_vb:
            self.vb[j] = v
        for i, f in old_forb:
            self.forb[i] = f
        for k, b, ln, rd in old_nets:
            self.nbox[k], self.nlen[k], self.nrudy[k] = b, ln, rd
        if saved:
            reg, g = saved
            self.G[reg[0]:reg[1], reg[2]:reg[3]] = g
        self.comp, self.cost = comp, c
        self.pending = None
