"""Mains path check: straight, L, 45-degree, Z or grid A* paths for the mains nets, with the .kicad_dru class gaps.
Used by the scripted mains router (the tier-1 pass of the tier routing driver) and by the placer as a placement check.

Core (pure, mm):
  Item(ref, net, cls, shape)   shape ('rect', cx, cy, w, h) for a pad or keepout, ('seg', x1, y1, x2, y2, w) for copper
  seg_dist(seg, shape)         distance from a segment centre line to the shape (0 when they touch)
  nodes(pads, jumpered)        pad groups to connect; the pads of a part in `jumpered` form one node
                               (internally connected twin terminals, for example G2RL 2-7, 3-6, 4-5)
  route_net(net, cls, pads, obstacles, width, gap, jumpered) -> {'paths', 'path', 'why', 'fault'}
     Nodes are joined nearest first (Prim). For each join, every pad pair of the two nodes and every candidate
     path (straight, two L, two 45-degree, then the two-bend Z paths of z_candidates) is tried, and then the grid A*
     of maze(); the shortest legal one wins (within TIE_MM of it: the one with the most margin). Legal: for each
     obstacle of another net, distance - width/2 - own half width of a copper segment >= gap(cls, obstacle cls).
     No legal path: path None, why names the least bad candidate and its blockers (gap shortfall). That is a
     placement fault for the placer. The same as data in 'fault': {net, least_bad: [(x, y), ...],
     blockers: [{ref, net, shortfall_mm}, worst first]}.
  board_gap(dru_rules, classes, edge) -> gap(a_cls, b_cls)
The result is a proposal: the DRC gate (--schematic-parity) decides.
"""
import math
from collections import namedtuple

Item = namedtuple('Item', 'ref net cls shape')


def _pt_seg(p, a, b):
    ax, ay = a
    dx, dy = b[0] - ax, b[1] - ay
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L))
    return math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy)


def _cross(a, b, c, d):
    def o(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    return o(a, b, c) * o(a, b, d) < 0 and o(c, d, a) * o(c, d, b) < 0


def _pt_rect(p, cx, cy, w, h):
    return math.hypot(max(abs(p[0] - cx) - w / 2, 0), max(abs(p[1] - cy) - h / 2, 0))


def seg_dist(seg, shape):
    a, b = seg
    if shape[0] == 'seg':
        _, x1, y1, x2, y2, _w = shape
        c, d = (x1, y1), (x2, y2)
        if _cross(a, b, c, d):
            return 0.0
        return min(_pt_seg(a, c, d), _pt_seg(b, c, d), _pt_seg(c, a, b), _pt_seg(d, a, b))
    _, cx, cy, w, h = shape
    if _pt_rect(a, cx, cy, w, h) == 0 or _pt_rect(b, cx, cy, w, h) == 0:
        return 0.0
    cs = [(cx - w / 2, cy - h / 2), (cx + w / 2, cy - h / 2), (cx + w / 2, cy + h / 2), (cx - w / 2, cy + h / 2)]
    if any(_cross(a, b, cs[i], cs[(i + 1) % 4]) for i in range(4)):
        return 0.0
    return min([_pt_rect(a, cx, cy, w, h), _pt_rect(b, cx, cy, w, h)] + [_pt_seg(c, a, b) for c in cs])


def _half(shape):
    return shape[5] / 2 if shape[0] == 'seg' else 0.0


def _centre(it):
    s = it.shape
    return (s[1], s[2]) if s[0] == 'rect' else ((s[1] + s[3]) / 2, (s[2] + s[4]) / 2)


def nodes(pads, jumpered):
    out, by = [], {}
    for p in pads:
        if p.ref in jumpered:
            by.setdefault(p.ref, []).append(p)
        else:
            out.append([p])
    return out + list(by.values())


def candidates(a, b):
    (ax, ay), (bx, by) = a, b
    dx, dy = bx - ax, by - ay
    if abs(dx) < 1e-9 or abs(dy) < 1e-9 or abs(abs(dx) - abs(dy)) < 1e-9:
        return [[a, b]]
    m = min(abs(dx), abs(dy))
    sx, sy = math.copysign(1, dx), math.copysign(1, dy)
    d1 = (ax + sx * m, ay + sy * m)
    d2 = (bx - sx * m, by - sy * m)
    return [[a, (bx, ay), b], [a, (ax, by), b], [a, d1, b], [a, d2, b]]


def z_candidates(a, b, step=0.25, span=12.0):
    """Two-bend paths through one channel coordinate c: [a, (c, ay), (c, by), b] and [a, (ax, c), (bx, c), b],
    c on a grid from min - span to max + span. Sorted by length (the shortest legal one is used)."""
    (ax, ay), (bx, by) = a, b
    out = []
    for lo, hi, mk in ((min(ax, bx), max(ax, bx), lambda c: [a, (c, ay), (c, by), b]),
                       (min(ay, by), max(ay, by), lambda c: [a, (ax, c), (bx, c), b])):
        n = int(round((hi - lo + 2 * span) / step))
        out += [mk(lo - span + i * step) for i in range(n + 1)]
    return sorted(out, key=_length)


def _length(path):
    return sum(math.dist(p, q) for p, q in zip(path, path[1:]))


def _margins(path, net, cls, obstacles, width, gap):
    """(d - need, obstacle) for each obstacle of another net; d - need < 0 is a violation."""
    out = []
    for o in obstacles:
        if o.net == net:
            continue
        need = gap(cls, o.cls)
        d = min(seg_dist(s, o.shape) for s in zip(path, path[1:])) - width / 2 - _half(o.shape)
        out.append((d - need, o))
    return out


def _blockers(path, net, cls, obstacles, width, gap):
    return [(m, o) for m, o in _margins(path, net, cls, obstacles, width, gap) if m < -1e-9]


TIE_MM = 0.1   # legal paths within this length of the shortest count as equal; the most margin wins. Below the 0.5 mm of the smallest Z jog


def _lazy(a, b, best):
    base = candidates(a, b)
    yield from base
    if best is None or best[0] > math.dist(a, b) + 1e-9:
        yield from z_candidates(a, b)


def _inflate(o, net, cls, width, gap):
    s = o.shape
    need = gap(cls, o.cls) + width / 2 + _half(s)
    if s[0] == 'rect':
        return (s[1] - s[3] / 2 - need, s[2] - s[4] / 2 - need, s[1] + s[3] / 2 + need, s[2] + s[4] / 2 + need)
    return (min(s[1], s[3]) - need, min(s[2], s[4]) - need, max(s[1], s[3]) + need, max(s[2], s[4]) + need)


def maze(a, targets, net, cls, obstacles, width, gap, step=0.5, margin=30.0, max_nodes=400000):
    """Grid A* (8 directions, grid anchored at a) from a to any grid point with a legal straight/L/45 finish
    to a target centre. Each move is checked exactly against the obstacles near it. -> path or None."""
    import heapq
    B = 5.0
    buckets = {}
    others = [o for o in obstacles if o.net != net]
    for o in others:
        x0, y0, x1, y1 = _inflate(o, net, cls, width, gap)
        for i in range(int(math.floor(x0 / B)), int(math.floor(x1 / B)) + 1):
            for j in range(int(math.floor(y0 / B)), int(math.floor(y1 / B)) + 1):
                buckets.setdefault((i, j), []).append(o)

    def near(p, q):  # the obstacles of every bucket under the segment's box
        out = set()
        for i in range(int(math.floor(min(p[0], q[0]) / B)), int(math.floor(max(p[0], q[0]) / B)) + 1):
            for j in range(int(math.floor(min(p[1], q[1]) / B)), int(math.floor(max(p[1], q[1]) / B)) + 1):
                out.update(buckets.get((i, j), ()))
        return out

    def ok(path):
        return not _blockers(path, net, cls, list(set().union(*[near(p, q) for p, q in zip(path, path[1:])])),
                             width, gap)
    xs = [a[0]] + [t[0] for t in targets]
    ys = [a[1]] + [t[1] for t in targets]
    lo = (min(xs) - margin, min(ys) - margin)
    hi = (max(xs) + margin, max(ys) + margin)

    def pt(k):
        return (round(a[0] + k[0] * step, 6), round(a[1] + k[1] * step, 6))

    def h(k):
        p = pt(k)
        return min(math.dist(p, t) for t in targets)
    dirs = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]
    start = (0, 0)
    g = {start: 0.0}
    prev = {}
    heap = [(h(start), 0.0, start, None)]
    seen = 0
    while heap and seen < max_nodes:
        _, gc, k, d = heapq.heappop(heap)
        if gc > g.get(k, 1e18) + 1e-12:
            continue
        seen += 1
        p = pt(k)
        for t in targets:
            for c in candidates(p, t):
                if ok(c):
                    path = [p]
                    kk = k
                    while kk in prev:
                        kk = prev[kk]
                        path.append(pt(kk))
                    return _simplify(path[::-1] + c[1:])
        for dd in dirs:
            nk = (k[0] + dd[0], k[1] + dd[1])
            q = pt(nk)
            if not (lo[0] <= q[0] <= hi[0] and lo[1] <= q[1] <= hi[1]):
                continue
            ng = gc + step * math.hypot(*dd) + (0.5 if d is not None and dd != d else 0.0)
            if ng < g.get(nk, 1e18) - 1e-12 and ok([p, q]):
                g[nk] = ng
                prev[nk] = k
                heapq.heappush(heap, (ng + h(nk), ng, nk, dd))
    return None


def _simplify(path):
    out = [path[0]]
    for i in range(1, len(path) - 1):
        a, b, c = out[-1], path[i], path[i + 1]
        if abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) > 1e-9:
            out.append(b)
    out.append(path[-1])
    return out


def route_net(net, cls, pads, obstacles, width, gap, jumpered=frozenset(), check_only=False):
    """check_only: each join takes the first legal path, not the shortest (a yes/no check, as in faults()).
    The joins do not depend on each other (own-net copper is no obstacle), so the open nets are the same."""
    ns = nodes(pads, jumpered)
    if len(ns) < 2:
        return {'paths': [], 'path': [], 'why': '', 'fault': None}
    done, todo, paths = [ns[0]], ns[1:], []
    while todo:
        best, least, legal = None, None, []
        for i, node in enumerate(todo):
            for p in (x for d in done for x in d):
                for q in node:
                    for path in _lazy(_centre(p), _centre(q), best):
                        path = [tuple(round(v, 6) for v in pt) for pt in path]
                        ms = _margins(path, net, cls, obstacles, width, gap)
                        bad = [(m, o) for m, o in ms if m < -1e-9]
                        if bad:
                            worst = min(d for d, _ in bad)
                            if least is None or worst > least[0]:
                                least = (worst, path, bad)
                        else:
                            legal.append((_length(path), min((m for m, _ in ms), default=math.inf), i, path))
                            if best is None or _length(path) < best[0]:
                                best = (_length(path), i, path)
                        if check_only and legal:
                            break
                    if check_only and legal:
                        break
                if check_only and legal:
                    break
            if check_only and legal:
                break
        if legal:
            _, _, i, path = max((x for x in legal if x[0] <= best[0] + TIE_MM), key=lambda x: x[1])
            best = (best[0], i, path)
        if best is None:
            for i, node in enumerate(todo):
                for p in sorted((x for d in done for x in d), key=lambda x: min(math.dist(_centre(x), _centre(q)) for q in node)):
                    path = maze(_centre(p), [_centre(q) for q in node], net, cls, obstacles, width, gap)
                    if path and (best is None or _length(path) < best[0]):
                        best = (_length(path), i, path)
                    if best:
                        break
        if best is None:
            _, path, bad = least
            names = sorted({f'{o.ref} {o.net or o.cls} ({d:+.2f} mm)' for d, o in bad})
            worst = {}
            for d, o in bad:   # one row per blocking ref and net, its largest shortfall
                k = (o.ref, o.net or o.cls)
                worst[k] = max(worst.get(k, 0.0), round(-d, 3))
            fault = {'net': net, 'least_bad': path,
                     'blockers': [{'ref': r, 'net': n, 'shortfall_mm': v}
                                  for (r, n), v in sorted(worst.items(), key=lambda kv: (-kv[1], kv[0]))]}
            return {'paths': paths, 'path': None, 'fault': fault,
                    'why': f'{net}: no legal path; least bad {path}: ' + ', '.join(names)}
        _, i, path = best
        paths.append(path if path[0] <= path[-1] else path[::-1])
        done.append(todo.pop(i))
    return {'paths': paths, 'path': paths[0] if len(paths) == 1 else paths, 'why': '', 'fault': None}


def board_gap(dru_rules, classes, edge):
    """gap(a_cls, b_cls) from the parsed .kicad_dru (tools/placer/dru.py) and the net class clearances.
    Special classes: 'EDGE' (board edge, copper-to-edge clearance), 'KEEPOUT' (rule area outline, 0),
    'HOLE:<ref>' (NPTH hole, the dru hole rule for that ref, else the class clearance)."""
    import fnmatch

    def gap(a, b):
        if b == 'EDGE':
            return edge
        if b == 'KEEPOUT':
            return 0.0
        base = max(classes.get(a, 0.0), classes.get(b, 0.0) if not b.startswith('HOLE:') else 0.0)
        if b.startswith('HOLE:'):
            ref = b[5:]
            return max([base] + [g for pat, refs, g in dru_rules['holes'] if fnmatch.fnmatch(a, pat) and ref in refs])
        for pat, other, between in dru_rules['domains']:
            am, bm = fnmatch.fnmatch(a, pat), fnmatch.fnmatch(b, pat)
            if am != bm:
                base = max(base, other)
            elif am and bm and a != b:
                base = max(base, between)
        for ap, bp, g in dru_rules['pairs']:
            if (any(fnmatch.fnmatch(a, p) for p in ap) and any(fnmatch.fnmatch(b, p) for p in bp)) or \
               (any(fnmatch.fnmatch(b, p) for p in ap) and any(fnmatch.fnmatch(a, p) for p in bp)):
                base = max(base, g)
        return base
    return gap


def faults(pr, pose, nets, jumpered=frozenset(), layers=('F.Cu', 'B.Cu')):
    """Mains path check of a placer pose -> [fault record of each net in `nets` with no legal path], [] when all
    have one. pr needs units[].cu/cu_pads, cu_nets, route_rules and board.outline/edge_clearance (kicad_io).
    Obstacles: the pads of all units (SMD pads on F.Cu only; NPTH pads are HOLE:<ref> on every layer) and the
    board outline (EDGE). Not modelled: board keepouts (the problem does not tell no-footprint rule areas, which
    allow tracks, from outline cutouts) and locked tracks (no net in the problem). A net is a fault when no layer
    that holds all its pads has a legal path; the record is the one of the last layer tried, as in route_board."""
    try:
        from .cost import rot_rect
    except ImportError:
        from cost import rot_rect
    rules = pr['route_rules']
    classes = {c: v[0] for c, v in rules['classes'].items()}
    width = {c: v[1] for c, v in rules['classes'].items()}
    gap = board_gap(rules['dru'], classes, pr['board']['edge_clearance'])
    member = {(ref, num): pat for pat, ref, num in rules['dru'].get('members', ())}  # no-net pads of a domain
    pads = []  # (Item, kind)
    for u, (x, y, r) in zip(pr['units'], pose):
        for q, (ref, kind, *num) in zip(u.get('cu', ()), u.get('cu_pads', ())):
            x0, y0, x1, y1 = rot_rect(q, r)
            shape = ('rect', x + (x0 + x1) / 2, y + (y0 + y1) / 2, x1 - x0, y1 - y0)
            if kind == 'npth':
                pads.append((Item(ref, '', 'HOLE:' + ref, shape), kind))
            else:
                name, cls = pr['cu_nets'].get(str(q[4]), ('', 'Default'))
                if not name and num and (ref, num[0]) in member:
                    cls = member[(ref, num[0])]
                pads.append((Item(ref, name, cls, shape), kind))
    ol = pr['board']['outline']
    edge = [Item('edge', '', 'EDGE', ('seg', a[0], a[1], b[0], b[1], 0)) for a, b in zip(ol, ol[1:] + ol[:1])]
    out = []
    for net in nets:
        mine_all = [p for p, _ in pads if p.net == net]
        if not mine_all:
            continue
        cls = mine_all[0].cls
        res = None
        for ln in layers:
            items = [p for p, k in pads if ln == 'F.Cu' or k != 'smd'] + edge
            mine = [i for i in items if i.net == net]
            if len(mine) < len(mine_all):  # the layer lacks pads of the net: no route here
                continue
            res = route_net(net, cls, mine, items, width.get(cls, width.get('Default', 0.2)), gap, set(jumpered),
                            check_only=True)
            if res['path'] is not None:
                break
        if res is None:
            out.append({'net': net, 'least_bad': None, 'blockers': []})
        elif res['path'] is None:
            out.append(res['fault'])
    return out


def domain_nets(pr):
    """The nets of the .kicad_dru domain classes (for RELAY-4: MAINS_K*, the tier-1 mains nets), sorted."""
    import fnmatch
    pats = [d[0] for d in pr['route_rules']['dru']['domains']]
    return sorted(n for n, c in pr['cu_nets'].values() if any(fnmatch.fnmatchcase(c, q) for q in pats))
