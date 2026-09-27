"""Placement cost: HPWL, RUDY congestion, courtyard spacing overlap and forbidden area.

Pure functions for a full evaluation, plus one incremental Evaluator for the search.
Units are mm, KiCad axes (y down). Rotation r in 0..3 is r * 90 deg in the KiCad sense:
r = 1 maps a local point (x, y) to (y, -x), as KiCad RotatePoint(+90 deg).

Problem (a dict, JSON-able; tools/placer/kicad_io.py writes it from a board):
  units:  [{name, refs, fixed, x, y, rects: [[x0, y0, x1, y1, clr], ...]}]
          x, y = unit origin on the board; rects = courtyard boxes relative to the origin at r = 0;
          clr = spacing class (D-040: 0.5 mm passive, 1.0 mm IC or connector).
  nets:   [{name, weight, pins: [[unit, x0, y0, x1, y1], ...]}]   pin boxes relative to the origin.
  board:  {outline: [[x, y], ...], keepouts: [[[x, y], ...], ...], edge_clearance}
  region: None or {box: [x0, y0, x1, y1], weight, refs}   RUDY cells in box count weight times.
  board['copper'] (optional): kept copper [[layer, x0, y0, x1, y1, width], ...]; layer 'via' = a via at
          (x0, y0) with diameter width. It uses RUDY capacity (fixed_grid) and F.Cu copper and vias are
          obstacles in the forbidden mask (grown by gap). Zones are not in it: a pour gives way to tracks.
Pose: [(x, y, r), ...] per unit.

Cost = w_wl * sum(weight * HPWL) + w_cong * RUDY overflow + w_ov * spacing overlap + w_oob * forbidden area.
RUDY (Spindler, DATE 2007): each net spreads its HPWL evenly over the cells of its box. Pin RUDY:
each pad (unit['pads'], local points) adds pin_demand mm of wire to its cell (pin escape and blockage).
Capacity per cell = cell area * layers / pitch; overflow = sum of (demand - limit * capacity) above the limit.
Spacing overlap of two courtyard boxes with classes ca, cb: g = max(ca, cb), penalty = the area of
the intersection of both boxes grown by g / 2 (0 when the gap is g or more). Boxes of the same unit
(rigid block layout) and pairs of two fixed units do not count.
Forbidden area = courtyard area on cells outside the outline shrunk by edge_clearance or inside a keepout.
"""
import math

import numpy as np

DEFAULTS = {'rudy_cell': 1.0, 'mask_cell': 0.1, 'layers': 2, 'pitch': 0.4, 'limit': 1.0, 'pin_demand': 0.0, 'gap': 0.2,
            'w_wl': 1.0, 'w_cong': 1.0, 'w_ov': 20.0, 'w_oob': 20.0}
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
    """Forbidden cells: outside the outline shrunk by edge_clearance, or inside a keepout."""

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
            out |= point_in_poly(gx, gy, poly)
        for layer, a0, b0, a1, b1, w in board.get('copper', []):
            if layer in OBSTACLE_LAYERS:
                self._segment(out, a0, b0, a1, b1, w / 2 + gap)
        self.forb = out
        self.s = sat(out.astype(np.int64))

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

    def rect_area(self, x0, y0, x1, y1):
        c = self.c
        a0, a1, i0, i1 = cell_range(x0, x1, self.x0, c, self.nx)
        b0, b1, j0, j1 = cell_range(y0, y1, self.y0, c, self.ny)
        total = (a1 - a0) * (b1 - b0)
        if i1 <= i0 or j1 <= j0:
            return total * c * c
        s = self.s
        inside = (i1 - i0) * (j1 - j0)
        bad = s[j1, i1] - s[j0, i1] - s[j1, i0] + s[j0, i0]
        return float(total - inside + bad) * c * c


def pair_penalty(a, b):
    """Spacing overlap of two courtyard box lists [[x0, y0, x1, y1, clr], ...]."""
    a = np.asarray(a, dtype=float).reshape(-1, 5)
    b = np.asarray(b, dtype=float).reshape(-1, 5)
    return _pen(a[:, :4], a[:, 4], b[:, :4], b[:, 4])


def _pen(A, ca, B, cb):
    g = np.maximum(ca[:, None], cb[None, :])
    dx = np.minimum(A[:, None, 2], B[None, :, 2]) - np.maximum(A[:, None, 0], B[None, :, 0]) + g
    dy = np.minimum(A[:, None, 3], B[None, :, 3]) - np.maximum(A[:, None, 1], B[None, :, 1]) + g
    return float((np.clip(dx, 0, None) * np.clip(dy, 0, None)).sum())


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
        g[s[0]:s[1], s[2]:s[3]] += wl / ((s[1] - s[0]) * (s[3] - s[2]))
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


def overlap(pr, pose):
    us = pr['units']
    w = [np.array(world_rects(u, pose[i]), dtype=float).reshape(-1, 5) for i, u in enumerate(us)]
    t = 0.0
    for i in range(len(us)):
        for j in range(i + 1, len(us)):
            if us[i]['fixed'] and us[j]['fixed']:
                continue
            t += _pen(w[i][:, :4], w[i][:, 4], w[j][:, :4], w[j][:, 4])
    return t


def forbidden(pr, pose, mask, i):
    return sum(mask.rect_area(*r[:4]) for r in world_rects(pr['units'][i], pose[i]))


def components(pr, pose, params):
    p = params_with_defaults(params)
    mask = Mask(pr['board'], p['mask_cell'], p['gap'])
    return {'hpwl': hpwl(pr, pose),
            'cong': overflow(rudy_grid(pr, pose, p), p, cell_weights(pr, p)),
            'overlap': overlap(pr, pose),
            'oob': sum(forbidden(pr, pose, mask, i) for i, u in enumerate(pr['units']) if not u['fixed'])}


def weighted(comp, params):
    p = params_with_defaults(params)
    return (p['w_wl'] * comp['hpwl'] + p['w_cong'] * comp['cong'] + p['w_ov'] * comp['overlap']
            + p['w_oob'] * comp['oob'])


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
        self.lbox = [[(lr[:, 0].min(), lr[:, 1].min(), lr[:, 2].max(), lr[:, 3].max()) for lr in self.lrect[i]]
                     for i in range(self.n)]
        self.grow = [float(c.max()) if len(c) else 0.0 for c in self.clr]
        self.area = [float(((lr[0][:, 2] - lr[0][:, 0]) * (lr[0][:, 3] - lr[0][:, 1])).sum()) for lr in self.lrect]
        pose = pose or initial_pose(pr)
        self.X = [float(q[0]) for q in pose]
        self.Y = [float(q[1]) for q in pose]
        self.R = [int(q[2]) % 4 for q in pose]
        self.UB = np.zeros((self.n, 4))
        for i in range(self.n):
            self._set_ub(i)
        self.mask = mask or Mask(pr['board'], p['mask_cell'], p['gap'])
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
        for k in range(len(self.nw)):
            b = self._net_box(k)
            self.nbox.append(b)
            self.nlen.append((b[2] - b[0]) + (b[3] - b[1]))
            rd = self._rudy(b)
            self.nrudy.append(rd)
            if rd:
                self.G[rd[0]:rd[1], rd[2]:rd[3]] += rd[4]
        self.comp = [sum(w * ln for w, ln in zip(self.nw, self.nlen)),
                     self._excess((0, self.grid.ny, 0, self.grid.nx)),
                     self._overlap_all(),
                     sum(self.forb)]
        self.cost = self._weighted(self.comp)
        self.pending = None

    # helpers
    def _weighted(self, c):
        p = self.p
        return p['w_wl'] * c[0] + p['w_cong'] * c[1] + p['w_ov'] * c[2] + p['w_oob'] * c[3]

    def _set_ub(self, i):
        b = self.lbox[i][self.R[i]]
        g = self.grow[i]
        self.UB[i] = (b[0] + self.X[i] - g, b[1] + self.Y[i] - g, b[2] + self.X[i] + g, b[3] + self.Y[i] + g)

    def _world(self, i):
        return self.lrect[i][self.R[i]] + (self.X[i], self.Y[i], self.X[i], self.Y[i])

    def _forb(self, i):
        m = self.mask
        return sum(m.rect_area(*r) for r in self._world(i).tolist())

    def _pen(self, i, j):
        return _pen(self._world(i), self.clr[i], self._world(j), self.clr[j])

    def _unit_overlap(self, i, skip):
        b = self.UB[i]
        U = self.UB
        cand = np.nonzero((U[:, 0] < b[2]) & (U[:, 2] > b[0]) & (U[:, 1] < b[3]) & (U[:, 3] > b[1]))[0]
        return sum(self._pen(i, int(j)) for j in cand if j != i and j not in skip)

    def _overlap_all(self):
        t = 0.0
        for i in range(self.n):
            if self.fixed[i]:
                continue
            # count movable-movable pairs once (j > i) and movable-fixed pairs always
            skip = {j for j in range(self.n) if (j < i and not self.fixed[j])}
            t += self._unit_overlap(i, skip)
        return t

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

    def _rudy(self, b):
        wl = (b[2] - b[0]) + (b[3] - b[1])
        s = self.grid.span(b)
        if s is None or wl <= 0:
            return None
        return (s[0], s[1], s[2], s[3], wl / ((s[1] - s[0]) * (s[3] - s[2])))

    def _excess(self, s):
        g = self.G[s[0]:s[1], s[2]:s[3]]
        ex = np.clip(g - self.thr, 0, None)
        if self.cw is not None:
            ex = ex * self.cw[s[0]:s[1], s[2]:s[3]]
        return float(ex.sum())

    # public
    def pose(self):
        return [(self.X[i], self.Y[i], self.R[i]) for i in range(self.n)]

    def components(self):
        return {'hpwl': self.comp[0], 'cong': self.comp[1], 'overlap': self.comp[2], 'oob': self.comp[3]}

    def unit_penalty(self, i):
        """Spacing overlap + forbidden area of one unit (0 = legal)."""
        return self._unit_overlap(i, set()) + self.forb[i]

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
        ov0 = sum(self._unit_overlap(i, Ms) for i in M)
        ov0 += sum(self._pen(M[a], M[b]) for a in range(len(M)) for b in range(a + 1, len(M)))
        fb0 = sum(self.forb[i] for i in M)
        for i, x, y, r in moves:
            self.X[i], self.Y[i], self.R[i] = float(x), float(y), int(r) % 4
            self._set_ub(i)
        ov1 = sum(self._unit_overlap(i, Ms) for i in M)
        ov1 += sum(self._pen(M[a], M[b]) for a in range(len(M)) for b in range(a + 1, len(M)))
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
            new_r.append(self._rudy(b))
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
        d = [dwl, dcong, ov1 - ov0, fb1 - fb0]
        delta = self._weighted(d)
        self.pending = (old_pose, old_forb, old_nets, saved, list(self.comp), self.cost)
        self.last_old = [(i, x, y, r) for i, x, y, r in old_pose]
        for a in range(4):
            self.comp[a] += d[a]
        self.cost += delta
        return delta

    def commit(self):
        self.pending = None

    def revert(self):
        old_pose, old_forb, old_nets, saved, comp, c = self.pending
        for i, x, y, r in old_pose:
            self.X[i], self.Y[i], self.R[i] = x, y, r
            self._set_ub(i)
        for i, f in old_forb:
            self.forb[i] = f
        for k, b, ln, rd in old_nets:
            self.nbox[k], self.nlen[k], self.nrudy[k] = b, ln, rd
        if saved:
            reg, g = saved
            self.G[reg[0]:reg[1], reg[2]:reg[3]] = g
        self.comp, self.cost = comp, c
        self.pending = None
