#!/usr/bin/env python3
"""Placement congestion estimate (RUDY) and ratsnest crossings, before routing.

  $PY tools/congestion.py BOARD [--cell 1.0] [--layers 3] [--pitch 0.4] [--exclude GND ...] [--limit 1.0]
                          [--move REF X Y DEG ...] [--png OUT.png] [--json OUT.json] [--top 15]

RUDY (Rectangular Uniform wire DensitY): each net spreads its ratsnest (MST) length evenly over
its pad bounding box. Demand per cell / capacity per cell = utilization. Capacity = cell area *
routing layers / track pitch. Pads and track keepouts reduce the capacity (SMD pad: 1 layer, THT pad: all layers).
Existing tracks are ignored: the score rates the placement, not the routing.
--move applies what-if moves in memory only (the board file is never written).
Score: overflow = sum of (util - limit) over the cells above the limit. Lower is better.
"""
import argparse
import json
import math
import sys


def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def mst(pts):
    """Prim minimum spanning tree: list of (a, b) edges."""
    if len(pts) < 2:
        return []
    inside = [pts[0]]
    rest = list(pts[1:])
    edges = []
    while rest:
        a, b = min(((p, q) for p in inside for q in rest), key=lambda e: dist(*e))
        edges.append((a, b))
        inside.append(b)
        rest.remove(b)
    return edges


def rudy(nets, box, cell):
    """nets: {name: [(x, y), ...]}; box: (x0, y0, x1, y1). Returns demand grid [row][col] in mm of wire."""
    x0, y0, x1, y1 = box
    cols, rows = math.ceil((x1 - x0) / cell), math.ceil((y1 - y0) / cell)
    g = [[0.0] * cols for _ in range(rows)]
    for pts in nets.values():
        L = sum(dist(a, b) for a, b in mst(pts))
        if L == 0:
            continue
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        bx0, bx1, by0, by1 = min(xs), max(xs), min(ys), max(ys)
        if bx1 - bx0 < cell:
            c = (bx0 + bx1) / 2; bx0, bx1 = c - cell / 2, c + cell / 2
        if by1 - by0 < cell:
            c = (by0 + by1) / 2; by0, by1 = c - cell / 2, c + cell / 2
        dens = L / ((bx1 - bx0) * (by1 - by0))
        for r in range(max(0, int((by0 - y0) // cell)), min(rows, int((by1 - y0) // cell) + 1)):
            oy = min(by1, y0 + (r + 1) * cell) - max(by0, y0 + r * cell)
            if oy <= 0:
                continue
            for c in range(max(0, int((bx0 - x0) // cell)), min(cols, int((bx1 - x0) // cell) + 1)):
                ox = min(bx1, x0 + (c + 1) * cell) - max(bx0, x0 + c * cell)
                if ox > 0:
                    g[r][c] += dens * ox * oy
    return g


def blockage(rects, box, cell, layers):
    """rects: [(x0, y0, x1, y1, n_layers_blocked)]. Returns blocked capacity fraction per cell (0..1)."""
    x0, y0, x1, y1 = box
    cols, rows = math.ceil((x1 - x0) / cell), math.ceil((y1 - y0) / cell)
    g = [[0.0] * cols for _ in range(rows)]
    for rx0, ry0, rx1, ry1, n in rects:
        for r in range(max(0, int((ry0 - y0) // cell)), min(rows, int((ry1 - y0) // cell) + 1)):
            oy = min(ry1, y0 + (r + 1) * cell) - max(ry0, y0 + r * cell)
            if oy <= 0:
                continue
            for c in range(max(0, int((rx0 - x0) // cell)), min(cols, int((rx1 - x0) // cell) + 1)):
                ox = min(rx1, x0 + (c + 1) * cell) - max(rx0, x0 + c * cell)
                if ox > 0:
                    g[r][c] += ox * oy * min(n, layers) / (cell * cell * layers)
    return [[min(1.0, v) for v in row] for row in g]


def capacity(cell, layers, pitch):
    """mm of track that fits in one cell."""
    return cell * cell * layers / pitch


def hotspots(util, origin, cell, limit):
    """[(util, x_center, y_center)] of cells above limit, highest first."""
    out = [(u, origin[0] + (c + 0.5) * cell, origin[1] + (r + 0.5) * cell)
           for r, row in enumerate(util) for c, u in enumerate(row) if u > limit]
    return sorted(out, reverse=True)


def _orient(a, b, c):
    v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    return (v > 1e-12) - (v < -1e-12)


def crossings(edges):
    """edges: {net: [(a, b), ...]}. Proper crossings between edges of different nets."""
    flat = [(n, e) for n, es in edges.items() for e in es]
    k = 0
    for i in range(len(flat)):
        n1, (a, b) = flat[i]
        for j in range(i + 1, len(flat)):
            n2, (c, d) = flat[j]
            if n1 == n2:
                continue
            if max(a[0], b[0]) < min(c[0], d[0]) or max(c[0], d[0]) < min(a[0], b[0]):
                continue
            if max(a[1], b[1]) < min(c[1], d[1]) or max(c[1], d[1]) < min(a[1], b[1]):
                continue
            if _orient(a, b, c) * _orient(a, b, d) < 0 and _orient(c, d, a) * _orient(c, d, b) < 0:
                k += 1
    return k


def score(nets, box, cell, layers, pitch, limit, block=()):
    g = rudy(nets, box, cell)
    cap = capacity(cell, layers, pitch)
    bl = blockage(block, box, cell, layers)
    util = [[d / max(cap * (1 - b), cap * 0.05) for d, b in zip(row, brow)] for row, brow in zip(g, bl)]
    cells = [u for row in util for u in row]
    return util, {
        'max_util': round(max(cells), 3),
        'cells_over_limit': sum(u > limit for u in cells),
        'overflow': round(sum(u - limit for u in cells if u > limit), 3),
        'crossings': crossings({n: mst(p) for n, p in nets.items()}),
    }


def load(board, exclude, moves):
    import pcbnew as p
    b = p.LoadBoard(board)
    for ref, x, y, deg in moves:
        fp = b.FindFootprintByReference(ref)
        if fp is None:
            sys.exit(f'congestion: no footprint {ref}')
        fp.SetPosition(p.VECTOR2I(p.FromMM(x), p.FromMM(y)))
        fp.SetOrientationDegrees(deg)
    nets = {}
    for pd in b.GetPads():
        n = pd.GetNetname()
        if not n or n in exclude or n.startswith('unconnected-'):
            continue
        q = pd.GetPosition()
        nets.setdefault(n, []).append((p.ToMM(q.x), p.ToMM(q.y)))
    bb = b.GetBoardEdgesBoundingBox()
    box = (p.ToMM(bb.GetX()), p.ToMM(bb.GetY()), p.ToMM(bb.GetRight()), p.ToMM(bb.GetBottom()))
    rl = [l for l in (p.F_Cu, p.In2_Cu, p.B_Cu) if b.GetEnabledLayers().Contains(l)]
    mm = p.ToMM
    rect = lambda r, n: (mm(r.GetX()), mm(r.GetY()), mm(r.GetRight()), mm(r.GetBottom()), n)
    block = [rect(pd.GetBoundingBox(), sum(pd.IsOnLayer(l) for l in rl)) for pd in b.GetPads()]
    for z in b.Zones():
        if z.GetIsRuleArea() and z.GetDoNotAllowTracks():
            r = z.GetBoundingBox()
            fill = z.Outline().Area() / max(1.0, float(r.GetWidth()) * float(r.GetHeight()))
            block.append(rect(r, sum(z.IsOnLayer(l) for l in rl) * fill))  # round keepout: area share only
    return {n: sorted(set(v)) for n, v in nets.items() if len(set(v)) > 1}, box, block


def plot(util, box, limit, out):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    x0, y0, x1, y1 = box
    fig, ax = plt.subplots(figsize=(12, 12 * (y1 - y0) / (x1 - x0)))
    im = ax.imshow(util, extent=(x0, x1, y1, y0), cmap='inferno', vmin=0, vmax=max(2 * limit, 0.01))
    fig.colorbar(im, ax=ax, label='RUDY utilization (1.0 = full)')
    ax.set_title('RUDY congestion (pads and keepouts subtracted)')
    fig.savefig(out, dpi=110, bbox_inches='tight')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('board')
    ap.add_argument('--cell', type=float, default=1.0)
    ap.add_argument('--layers', type=int, default=3, help='signal routing layers (BASE-PWR: F, In2, B)')
    ap.add_argument('--pitch', type=float, default=0.4, help='track width + clearance, mm')
    ap.add_argument('--exclude', nargs='*', default=['GND'], help='plane nets (not routed as tracks)')
    ap.add_argument('--limit', type=float, default=1.0)
    ap.add_argument('--move', nargs=4, action='append', default=[], metavar=('REF', 'X', 'Y', 'DEG'))
    ap.add_argument('--png'); ap.add_argument('--json'); ap.add_argument('--top', type=int, default=15)
    a = ap.parse_args()
    moves = [(r, float(x), float(y), float(d)) for r, x, y, d in a.move]
    nets, box, block = load(a.board, set(a.exclude), moves)
    util, s = score(nets, box, a.cell, a.layers, a.pitch, a.limit, block)
    hs = hotspots(util, box[:2], a.cell, a.limit)
    print(f"max_util {s['max_util']}  cells_over_limit {s['cells_over_limit']}  overflow {s['overflow']}  "
          f"crossings {s['crossings']}  nets {len(nets)}")
    for u, x, y in hs[:a.top]:
        print(f'  hot {u:.2f} at ({x:.1f}, {y:.1f})')
    if a.png:
        plot(util, box, a.limit, a.png)
    if a.json:
        json.dump(dict(s, hotspots=[list(h) for h in hs]), open(a.json, 'w'), indent=1)


if __name__ == '__main__':
    main()
