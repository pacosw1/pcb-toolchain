"""Wire-length term: the sum of the Euclidean minimum spanning tree (MST) of the pad centres of each net.

Why (README "Wire-length term"): on NET-CORE the HPWL term of the search did not rank the routed length of the
compaction steps. The MST of all pad centres of a signal net (test-point pads included) ranked it better; see the
README for the data (Spearman per metric, router v8).

Nets: the problem nets (not the cohesion nets), without the plane nets (pr['plane_nets']: nets with a copper zone;
the router connects their pads to the plane with a via, so their track length does not follow the net span).
Points: net['pts'] = per pin the pad centres of the net on that unit (kicad_io.read_problem), relative to the unit
origin; an old problem without 'pts' uses the centre of each pin box. Test-point pads are pins only when the problem
was read with tp_pins (cli.py read --tp-pins).
Cost: w_mst * sum of MST lengths (mm). Parameter w_mst (default 0: not computed).
"""
import math


def mst_length(pts):
    """Euclidean MST length of a list of (x, y) points (Prim, O(n^2); nets have tens of pads at most)."""
    n = len(pts)
    if n < 2:
        return 0.0
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    inf = math.inf
    best = [inf] * n
    used = [False] * n
    used[0] = True
    x0, y0 = xs[0], ys[0]
    for j in range(1, n):
        best[j] = math.hypot(xs[j] - x0, ys[j] - y0)
    total = 0.0
    for _ in range(n - 1):
        j, d = -1, inf
        for k in range(n):
            if not used[k] and best[k] < d:
                j, d = k, best[k]
        used[j] = True
        total += d
        xj, yj = xs[j], ys[j]
        for k in range(n):
            if not used[k]:
                e = math.hypot(xs[k] - xj, ys[k] - yj)
                if e < best[k]:
                    best[k] = e
    return total


class Model:
    """Per-net local points for the 4 turns; value(k, X, Y, R) = MST length of net k at the pose."""

    def __init__(self, pr):
        from .cost import rot_pt  # cost imports this module: a late import
        planes = set(pr.get('plane_nets') or ())
        self.nets = []  # problem net indices in the term
        self.lpts = {}  # k -> [(unit, [[(x, y) per point] per turn r])]
        for k, n in enumerate(pr['nets']):
            if n.get('cohesion') or n['name'] in planes:
                continue
            rows = []
            pts = n.get('pts')
            for i, q in enumerate(n['pins']):
                if pts is not None:
                    loc = [tuple(p) for p in pts[i]]
                else:
                    loc = [((q[1] + q[3]) / 2, (q[2] + q[4]) / 2)]
                rows.append((q[0], [[rot_pt(a, b, r) for a, b in loc] for r in range(4)]))
            if sum(len(t[1][0]) for t in rows) < 2:
                continue
            self.nets.append(k)
            self.lpts[k] = rows
        self.member = set(self.nets)

    def value(self, k, X, Y, R):
        pts = []
        for u, rp in self.lpts[k]:
            x, y = X[u], Y[u]
            pts += [(a + x, b + y) for a, b in rp[R[u]]]
        return mst_length(pts)


def wirelen(pr, pose, model=None):
    """Full evaluation: (sum of MST lengths, {net name: MST length})."""
    m = model or Model(pr)
    X = [q[0] for q in pose]
    Y = [q[1] for q in pose]
    R = [int(q[2]) % 4 for q in pose]
    per = {pr['nets'][k]['name']: m.value(k, X, Y, R) for k in m.nets}
    return sum(per.values()), per
