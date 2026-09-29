"""Features of a placement for the routability surrogate (surrogate.py). Pure NumPy.

rasterize(pr, pose, n) puts a placement on an n x n grid over the outline box (square cells, cell = the longer
box side / n; row = y). Each channel is a density per mm2, so boards of other sizes give the same scale:
  occ      part area (rects, turned with the pose), clipped to 1
  pins     pads per mm2 (u['pads'])
  rudy     RUDY: each net spreads (w + h) / (w * h) of wire over its pin box (w, h at least one cell)
  blocked  1 off the outline or in a keepout (cell centre test)
  vpins    pads of a via net (pr['via_nets'], u['cu'] net codes) per mm2: each needs a plane via
  copper   kept and fixed copper: track length per mm2 on the grid; a via counts as 1 mm
scalars(pr, pose) gives the global values in SCALARS order.
"""
import math

import numpy as np

from placer import cost

CHANNELS = ('occ', 'pins', 'rudy', 'blocked', 'vpins', 'copper')
SCALARS = ('log_hpwl', 'units', 'nets', 'pins', 'log_area', 'fill', 'rudy_p95')


def grid_of(board, n):
    x0, y0, x1, y1 = cost.outline_box(board)
    return {'x0': float(x0), 'y0': float(y0), 'cell': float(max(x1 - x0, y1 - y0)) / n, 'n': n}


def _overlap(a0, a1, g):
    """Length of [a0, a1] inside each of the n cells of one axis (grid origin 0, cell c)."""
    c, n = g['cell'], g['n']
    e = np.arange(n + 1) * c
    return np.clip(np.minimum(e[1:], a1) - np.maximum(e[:-1], a0), 0.0, None)


def _add_box(ch, g, x0, y0, x1, y1, v):
    """Add density v over a box, weighted by the exact overlap area of each cell (v * area in all)."""
    ox = _overlap(x0 - g['x0'], x1 - g['x0'], g)
    oy = _overlap(y0 - g['y0'], y1 - g['y0'], g)
    if ox.any() and oy.any():
        ch += v * np.outer(oy, ox) / g['cell'] ** 2


def _add_point(ch, g, x, y, v):
    i = math.floor((x - g['x0']) / g['cell'])
    j = math.floor((y - g['y0']) / g['cell'])
    if 0 <= i < g['n'] and 0 <= j < g['n']:
        ch[j, i] += v / g['cell'] ** 2


def _add_segment(ch, g, a0, b0, a1, b1, v):
    length = math.hypot(a1 - a0, b1 - b0)
    k = max(1, math.ceil(length / (g['cell'] / 4)))
    for s in range(k):
        f = (s + 0.5) / k
        _add_point(ch, g, a0 + f * (a1 - a0), b0 + f * (b1 - b0), v * length / k)


def rasterize(pr, pose, n=64):
    """(len(CHANNELS), n, n) float32 array and the grid {'x0', 'y0', 'cell', 'n'}."""
    g = grid_of(pr['board'], n)
    x = np.zeros((len(CHANNELS), n, n))
    occ, pins, rudy, blk, vpins, cu = x
    via_nets = set(pr.get('via_nets', ()))
    for u, (ux, uy, r) in zip(pr['units'], pose):
        for rc in cost.world_rects(u, (ux, uy, r)):
            _add_box(occ, g, rc[0], rc[1], rc[2], rc[3], 1.0)
        for q in u.get('pads', []):
            a, b = cost.rot_pt(q[0], q[1], r)
            _add_point(pins, g, a + ux, b + uy, 1.0)
        for q in u.get('cu', []):
            if q[4] in via_nets:
                a0, b0, a1, b1 = cost.rot_rect(q, r)
                _add_point(vpins, g, (a0 + a1) / 2 + ux, (b0 + b1) / 2 + uy, 1.0)
    np.clip(occ, 0.0, 1.0, out=occ)
    for net in pr['nets']:
        bx0, by0, bx1, by1 = cost.net_box(net, pose)
        w, h = bx1 - bx0, by1 - by0
        if w + h <= 0:
            continue
        cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
        w, h = max(w, g['cell']), max(h, g['cell'])
        _add_box(rudy, g, cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2,
                 net['weight'] * (bx1 - bx0 + by1 - by0) / (w * h))
    cs = g['x0'] + (np.arange(n) + 0.5) * g['cell']
    rs = g['y0'] + (np.arange(n) + 0.5) * g['cell']
    xs, ys = np.meshgrid(cs, rs)
    off = ~cost.point_in_poly(xs, ys, pr['board']['outline'])
    for poly in pr['board'].get('keepouts', []):
        off |= cost.point_in_poly(xs, ys, poly)
    blk[off] = 1.0
    for layer, a0, b0, a1, b1, _w in pr['board'].get('copper', []) + pr['board'].get('fixed_copper', []):
        if layer == 'via':
            _add_point(cu, g, a0, b0, 1.0)
        else:
            _add_segment(cu, g, a0, b0, a1, b1, 1.0)
    return x.astype(np.float32), g


def scalars(pr, pose, ras=None):
    """Global values in SCALARS order: log1p(HPWL mm), unit, net and net-pin counts, log1p(outline box mm2),
    part area / box area, and the 95th percentile of RUDY inside the board (ras = rasterize() output, else a
    64 x 64 grid)."""
    x0, y0, x1, y1 = cost.outline_box(pr['board'])
    area = float((x1 - x0) * (y1 - y0))
    parts = sum((rc[2] - rc[0]) * (rc[3] - rc[1]) for u in pr['units'] for rc in u['rects'])
    if ras is None:
        ras, _ = rasterize(pr, pose, 64)
    inside = ras[CHANNELS.index('blocked')] == 0
    rudy = ras[CHANNELS.index('rudy')][inside]
    return [float(np.log1p(cost.hpwl(pr, pose))), len(pr['units']), len(pr['nets']),
            sum(len(n['pins']) for n in pr['nets']), float(np.log1p(area)), parts / area,
            float(np.percentile(rudy, 95)) if rudy.size else 0.0]
