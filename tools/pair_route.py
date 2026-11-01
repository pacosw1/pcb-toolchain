#!/usr/bin/env python3
"""Route differential pairs as one centreline, then offset it into the P and N tracks (2026-10-25, NET-NODE).

  $PY tools/pair_route.py BOARD.kicad_pcb OUT.kicad_pcb --pair BASE:WIDTH:GAP[:LAYER] [--pair ...] [--layer F.Cu]
      [--keepout NAME ...] [--space 0.5] [--space-exempt U101] [--barrier NETPREFIX:MM] [--grid 0.05]

Why: Fastroute has no coupled pairs, and KiCadRoutingTools route_diff ignores the copper of the pair's own nets
(it ran ETH_TXN over the J201 pad of ETH_TXP and crossed the polarity crossovers, NET-NODE 2026-10-25).

Each pair (nets BASE+'P' / BASE+'N') must end in two free stub tips per end, side by side at the pair pitch
(width + gap) and on one layer: tools/build-net-node-pcb.py pair_stubs makes them. The centreline runs on a grid from
the midpoint of one tip pair to the midpoint of the other, on one layer, 8 directions. A cell is free for the
centreline when a P or N track (pitch / 2 to each side, at WIDTH) there clears:
  - every pad, track and via of another net by the board clearance (0.15 mm), other-net tracks and vias of another
    net class by --space (.kicad_dru "MDI USB spacing to other signals"; GND and items touching a --space-exempt
    courtyard: 0.15 mm);
  - the pad / track / via copper of the pair's own nets (except the last stub segments into the tips) by 0.15 mm;
  - copper of nets that start with a --barrier prefix by its distance (PoE 3 mm);
  - every rule area named --keepout (no copper of this pair in it), and the board edge by 0.5 mm.
The path leaves each tip pair along its stub heading. P and N are the path offset by +-pitch/2 with mitred corners.
Prints one line per pair "PAIR base routed|FAILED length P/N skew" and "PAIRS routed R failed F".
No hand routing: this is a router; its result goes through DRC with parity like any router result.
"""
import argparse
import copy
import heapq
import math
import sys

import numpy as np
import wx

_app = wx.App(False)
import pcbnew  # noqa: E402

T = pcbnew.ToMM
CLEAR = 0.15
CORNER_PAD = 0.05
EDGE = 0.5
OWN_FREE = 1.2       # mm round each end midpoint where the pair's own copper does not block
FRONT = 1.0          # forced free run along the heading (build pair_stubs PAIR_FRONT)
MIN_SEG = 0.25       # shortest centreline segment kept (mm)


def v2(x, y):
    return pcbnew.VECTOR2I(pcbnew.FromMM(x), pcbnew.FromMM(y))


def seg_point_dist(px, py, ax, ay, bx, by):
    """Distance from points (arrays px, py) to segment ab."""
    dx, dy = bx - ax, by - ay
    ll = dx * dx + dy * dy
    t = np.zeros_like(px) if ll == 0 else np.clip(((px - ax) * dx + (py - ay) * dy) / ll, 0, 1)
    return np.hypot(px - ax - t * dx, py - ay - t * dy)


def box_point_dist(px, py, x0, y0, x1, y1):
    dx = np.maximum(np.maximum(x0 - px, 0), px - x1)
    dy = np.maximum(np.maximum(y0 - py, 0), py - y1)
    return np.hypot(dx, dy)


class Grid:
    def __init__(self, x0, y0, x1, y1, g):
        self.x0, self.y0, self.g = x0, y0, g
        self.nx, self.ny = int((x1 - x0) / g) + 1, int((y1 - y0) / g) + 1
        self.blocked = np.zeros((self.ny, self.nx), dtype=bool)

    def cell(self, x, y):
        return int(round((x - self.x0) / self.g)), int(round((y - self.y0) / self.g))

    def xy(self, i, j):
        return self.x0 + i * self.g, self.y0 + j * self.g

    def mark(self, bbox, dist_fn, r):
        """Block the cells whose centre is closer than r to an item (dist_fn on coordinate arrays)."""
        x0, y0, x1, y1 = bbox
        i0, j0 = self.cell(x0 - r, y0 - r)
        i1, j1 = self.cell(x1 + r, y1 + r)
        i0, j0, i1, j1 = max(i0, 0), max(j0, 0), min(i1, self.nx - 1), min(j1, self.ny - 1)
        if i1 < i0 or j1 < j0:
            return
        xs = self.x0 + np.arange(i0, i1 + 1) * self.g
        ys = self.y0 + np.arange(j0, j1 + 1) * self.g
        px, py = np.meshgrid(xs, ys)
        self.blocked[j0:j1 + 1, i0:i1 + 1] |= dist_fn(px, py) < r


def free_tips(board, net, layer):
    """Free ends of a net's tracks on layer: track ends that touch no other item of the net."""
    tracks = [t for t in board.GetTracks() if t.GetNetname() == net and t.GetClass() == 'PCB_TRACK']
    pts = []
    for t in tracks:
        for p, q in ((t.GetStart(), t.GetEnd()), (t.GetEnd(), t.GetStart())):
            pts.append(((T(p.x), T(p.y)), (T(p.x - q.x), T(p.y - q.y)), t))
    others = [(T(v.GetPosition().x), T(v.GetPosition().y)) for v in board.GetTracks()
              if v.GetNetname() == net and v.GetClass() == 'PCB_VIA']
    pads = [p for fp in board.GetFootprints() for p in fp.Pads() if p.GetNetname() == net and p.IsOnLayer(layer)]
    out = []
    for (x, y), d, t in pts:
        if t.GetLayer() != layer:
            continue
        touching = sum(1 for (x2, y2), _, t2 in pts if t2 is not t and math.hypot(x - x2, y - y2) < 0.01)
        if touching or any(math.hypot(x - a, y - b) < 0.01 for a, b in others):
            continue
        if any(p.HitTest(v2(x, y)) for p in pads):
            continue
        n = math.hypot(*d)
        out.append(((x, y), (d[0] / n, d[1] / n), t))
    return out


def astar(grid, start, goal, s_dir, g_dir, turn_cost=0.6):
    """8-direction A* from cell start to cell goal; the first move follows s_dir, the last arrives along -g_dir."""
    dirs = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]

    def dir_index(d):
        a = math.atan2(d[1], d[0])
        return int(round(a / (math.pi / 4))) % 8
    sd, gd = dir_index(s_dir), (dir_index(g_dir) + 4) % 8
    blocked = grid.blocked
    nx, ny = grid.nx, grid.ny
    oct_ = lambda i, j: max(abs(i - goal[0]), abs(j - goal[1])) + (math.sqrt(2) - 1) * min(abs(i - goal[0]), abs(j - goal[1]))
    best = {(start[0], start[1], sd): 0.0}
    came = {}
    heap = [(oct_(*start), 0.0, start[0], start[1], sd)]
    while heap:
        f, gcost, i, j, d = heapq.heappop(heap)
        if (i, j) == goal and abs((d - gd + 4) % 8 - 4) <= 2:     # arrive within 90 deg of the lead-in
            path = [(i, j)]
            key = (i, j, d)
            while key in came:
                key = came[key]
                path.append((key[0], key[1]))
            return path[::-1]
        if gcost > best.get((i, j, d), 1e18):
            continue
        for nd in (d, (d + 1) % 8, (d - 1) % 8, (d + 2) % 8, (d - 2) % 8):
            di, dj = dirs[nd]
            a, b = i + di, j + dj
            if not (0 <= a < nx and 0 <= b < ny) or blocked[b, a]:
                continue
            step = math.sqrt(2) if di and dj else 1.0
            turn = 0 if nd == d else (turn_cost if abs((nd - d + 4) % 8 - 4) == 1 else 3 * turn_cost)
            ng = gcost + step + turn
            key = (a, b, nd)
            if ng < best.get(key, 1e18):
                best[key] = ng
                came[key] = (i, j, d)
                heapq.heappush(heap, (ng + oct_(a, b), ng, a, b, nd))
    return None


def flood(grid, c):
    """Free cells reachable from cell c (8-connected)."""
    seen = np.zeros_like(grid.blocked)
    stack = [c]
    while stack:
        i, j = stack.pop()
        if not (0 <= i < grid.nx and 0 <= j < grid.ny) or seen[j, i] or grid.blocked[j, i]:
            continue
        seen[j, i] = True
        stack.extend((i + di, j + dj) for di in (-1, 0, 1) for dj in (-1, 0, 1) if di or dj)
    return seen


def dump(grid, reach, path):
    """Grey image of the grid: blocked black, free grey, reached from end 1 / 2 lighter (debug)."""
    img = np.where(grid.blocked, 0, 110).astype(np.uint8)
    img[reach[0]] = 200
    img[reach[1]] = 255
    with open(path, 'wb') as f:
        f.write(f'P5 {grid.nx} {grid.ny} 255\n'.encode())
        f.write(img.tobytes())


def simplify_pts(poly):
    """Drop collinear points of a float polyline."""
    out = [poly[0]]
    for k in range(1, len(poly) - 1):
        a, b, c = out[-1], poly[k], poly[k + 1]
        if abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) > 1e-6:
            out.append(b)
    out.append(poly[-1])
    return out


def simplify(path):
    out = [path[0]]
    for k in range(1, len(path) - 1):
        a, b, c = out[-1], path[k], path[k + 1]
        if (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) != 0:
            out.append(b)
    out.append(path[-1])
    return out


def offset(poly, d):
    """Polyline offset by d to the left (mitred corners)."""
    out = []
    for k, (x, y) in enumerate(poly):
        ns = []
        for a, b in ((poly[k - 1], poly[k]) if k else (None, None), (poly[k], poly[k + 1]) if k + 1 < len(poly) else (None, None)):
            if a is None:
                continue
            dx, dy = b[0] - a[0], b[1] - a[1]
            n = math.hypot(dx, dy)
            ns.append((-dy / n, dx / n))
        if len(ns) == 1:
            nx_, ny_ = ns[0]
            out.append((x + nx_ * d, y + ny_ * d))
        else:
            bx, by = ns[0][0] + ns[1][0], ns[0][1] + ns[1][1]
            bl = math.hypot(bx, by)
            bx, by = bx / bl, by / bl
            cos_half = bx * ns[0][0] + by * ns[0][1]
            out.append((x + bx * d / cos_half, y + by * d / cos_half))
    return out


def length(poly):
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(poly, poly[1:]))


def net_length(board, net):
    return sum(T(t.GetLength()) for t in board.GetTracks() if t.GetNetname() == net and t.GetClass() == 'PCB_TRACK')


def route_pair(board, base, w, gap, layer, a, single=False):
    pn, nn = (base, base) if single else (base + 'P', base + 'N')
    s = 0.0 if single else w + gap
    lid = board.GetLayerID(layer)
    # sorted by position: board.GetTracks() follows the file order, which changes with the random uuids of new
    # tracks; the first end is the A* start, so an unsorted order gave a different equal-cost route on each build
    # (KIOSK-CM4 MDI, 2026-10-26)
    tp, tn = sorted(free_tips(board, pn, lid), key=lambda t: t[0]), sorted(free_tips(board, nn, lid), key=lambda t: t[0])
    if len(tp) != 2 or len(tn) != 2:
        return f'PAIR {base} FAILED tips P {len(tp)} N {len(tn)} on {layer}'
    ends = []
    for p in (tp if not single else []):
        q = min(tn, key=lambda q: math.hypot(q[0][0] - p[0][0], q[0][1] - p[0][1]))
        if abs(math.hypot(q[0][0] - p[0][0], q[0][1] - p[0][1]) - s) > 0.05:
            return f'PAIR {base} FAILED tips {p[0]} / {q[0]} not at the pitch {s:.2f}'
        # heading: perpendicular to the tip pair (pair_stubs puts the tips side by side across it), away from the stubs
        tx, ty = q[0][0] - p[0][0], q[0][1] - p[0][1]
        hx, hy = -ty, tx
        if hx * (p[1][0] + q[1][0]) + hy * (p[1][1] + q[1][1]) < 0:
            hx, hy = -hx, -hy
        h = math.hypot(hx, hy)
        ends.append(dict(p=p, n=q, m=((p[0][0] + q[0][0]) / 2, (p[0][1] + q[0][1]) / 2), h=(hx / h, hy / h)))
    if single:                         # one track: each free tip is an end, its heading the tip direction
        ends = [dict(p=t_, n=t_, m=t_[0], h=t_[1]) for t_ in tp]
    xs = [e['m'][0] for e in ends]
    ys = [e['m'][1] for e in ends]
    margin = a.margin
    grid = Grid(min(xs) - margin, min(ys) - margin, max(xs) + margin, max(ys) + margin, a.grid)
    half = s / 2 + w / 2              # centreline to the outer track edge
    exempt = []
    for ref in a.space_exempt:
        fp = board.FindFootprintByReference(ref)
        fp.BuildCourtyardCaches()
        cy = fp.GetCourtyard(pcbnew.F_CrtYd)
        bb = cy.BBox() if cy.OutlineCount() else fp.GetBoundingBox(False)
        exempt.append((T(bb.GetX()), T(bb.GetY()), T(bb.GetRight()), T(bb.GetBottom())))
    for z in board.Zones():            # named rule areas exempt the spacing rules too (U102_FANOUT, PAIR_BREAKOUT)
        if z.GetIsRuleArea() and z.GetZoneName() in a.space_exempt_area:
            bb = z.Outline().BBox()
            exempt.append((T(bb.GetX()), T(bb.GetY()), T(bb.GetRight()), T(bb.GetBottom())))
    barrier = [(p, float(v)) for p, v in (b.split(':') for b in a.barrier)]
    last = {e['p'][2].m_Uuid.AsString() for e in ends} | {e['n'][2].m_Uuid.AsString() for e in ends}
    # the pair's own pads and stubs block like other copper, except near the two ends: there the centreline starts
    # between them (OWN_FREE)
    own = copy.copy(grid)
    own.blocked = np.zeros_like(grid.blocked)

    nets_by_name = board.GetNetsByName()
    cls_of = lambda net: nets_by_name[net].GetNetClassName() if net in nets_by_name else ''
    pair_cls = cls_of(pn)

    guard = set(a.guard_class)

    def need(net, is_track):
        for pre, v in barrier:
            if net.startswith(pre):
                return v
        if single:
            # one track: same-class tracks by --same-class-space (.kicad_dru FSPI spacing), guarded classes (the
            # routed MDI / USB pairs) by --space; everything else and every pad by the board clearance
            if is_track and net != pn and cls_of(net) == pair_cls:
                return a.same_class_space
            if is_track and cls_of(net) in guard:
                return a.space
            return CLEAR
        if not is_track and net not in (pn, nn) and net != 'GND' and cls_of(net) != pair_cls:
            return a.pad_room          # other-class pads: room for their own track beside the pair guard
        if net in (pn, nn) or net == 'GND' or not is_track or cls_of(net) == pair_cls:
            return CLEAR                # the spacing rule holds between net classes (B.NetClass != A.NetClass)
        return a.space
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            if not pad.IsOnLayer(lid):
                continue
            bb = pad.GetBoundingBox()
            box = (T(bb.GetX()), T(bb.GetY()), T(bb.GetRight()), T(bb.GetBottom()))
            rr_ = need(pad.GetNetname(), False)
            if rr_ == a.pad_room and any(not (box[2] < e[0] or box[0] > e[2] or box[3] < e[1] or box[1] > e[3]) for e in exempt):
                rr_ = CLEAR                # pin fields (exempt courtyards): the board clearance
            r = half + rr_
            (own if pad.GetNetname() in (pn, nn) else grid).mark(box, lambda px, py, b=box: box_point_dist(px, py, *b), r)
            if pad.GetDrillSize().x > 0:          # holes block every layer
                pass
    for t in board.GetTracks():
        is_via = t.GetClass() == 'PCB_VIA'
        if not is_via and t.GetLayer() != lid:
            continue
        if t.m_Uuid.AsString() in last:
            continue
        ax, ay, bx, by = T(t.GetStart().x), T(t.GetStart().y), T(t.GetEnd().x), T(t.GetEnd().y)
        hw = T(t.GetWidth(pcbnew.F_Cu) if is_via else t.GetWidth()) / 2
        n = t.GetNetname()
        rr = need(n, True)
        if rr in (a.space, a.same_class_space) and rr != CLEAR and any(not (max(ax, bx) < e[0] or min(ax, bx) > e[2] or max(ay, by) < e[1] or min(ay, by) > e[3])
                                 for e in exempt):
            rr = CLEAR
        # CORNER_PAD: a mitred corner puts the offset leg d / cos(22.5 deg) from the centreline vertex, and a
        # diagonal run between 0.05 mm cell centres passes closer than the cells show (NET-NODE TXN-RXN 0.106 mm)
        r = half + hw + rr + (CORNER_PAD if n not in (pn, nn) else 0.0)
        grid.mark((min(ax, bx), min(ay, by), max(ax, bx), max(ay, by)),   # own tracks / vias block too (a crossover via)
                  lambda px, py, s_=(ax, ay, bx, by): seg_point_dist(px, py, *s_), r)
    for z in board.Zones():
        if z.GetIsRuleArea() and z.GetZoneName() in a.keepout:
            o = z.Outline()
            ys_, xs_ = np.nonzero(~grid.blocked | grid.blocked)      # all cells
            bb = o.BBox()
            box = (T(bb.GetX()), T(bb.GetY()), T(bb.GetRight()), T(bb.GetBottom()))
            i0, j0 = grid.cell(box[0] - half, box[1] - half)
            i1, j1 = grid.cell(box[2] + half, box[3] + half)
            for j in range(max(j0, 0), min(j1, grid.ny - 1) + 1):
                for i in range(max(i0, 0), min(i1, grid.nx - 1) + 1):
                    x, y = grid.xy(i, j)
                    if o.Contains(v2(x, y)) or o.SquaredDistance(v2(x, y)) < pcbnew.FromMM(half) ** 2:
                        grid.blocked[j, i] = True
    gx_, gy_ = np.meshgrid(grid.x0 + np.arange(grid.nx) * grid.g, grid.y0 + np.arange(grid.ny) * grid.g)
    # Radial channel (--channel REF:HALF:LATERAL): inside the square of half-size HALF round REF's centre, an end of
    # this route that starts there may only run straight out along its heading, within LATERAL of that line. The
    # pins beside the pair reach their ring parts through the same ring (NET-NODE 2026-10-26: SOC_ETH_EXTR /
    # AVDD3V3 next to the MDI TX pins were cut off by the pair turning inside the SoC ring).
    for spec in a.channel:
        ref, half_sq, lat = spec.split(':')
        half_sq, lat = float(half_sq), float(lat)
        fp = board.FindFootprintByReference(ref)
        cx, cy = T(fp.GetPosition().x), T(fp.GetPosition().y)
        inside_sq = (np.abs(gx_ - cx) < half_sq) & (np.abs(gy_ - cy) < half_sq)
        allowed = np.zeros_like(inside_sq)
        for e in ends:
            if abs(e['m'][0] - cx) < half_sq and abs(e['m'][1] - cy) < half_sq:
                ux, uy = e['h']
                along = (gx_ - e['m'][0]) * ux + (gy_ - e['m'][1]) * uy
                lateral = np.abs(-(gx_ - e['m'][0]) * uy + (gy_ - e['m'][1]) * ux)
                allowed |= (along > -0.5) & (lateral <= lat)
        grid.blocked |= inside_sq & ~allowed
    for e in ends:
        own.blocked &= np.hypot(gx_ - e['m'][0], gy_ - e['m'][1]) > OWN_FREE
    grid.blocked |= own.blocked
    edge = board.GetBoardEdgesBoundingBox()
    ex0, ey0, ex1, ey1 = T(edge.GetX()), T(edge.GetY()), T(edge.GetRight()), T(edge.GetBottom())
    px_, py_ = np.meshgrid(grid.x0 + np.arange(grid.nx) * grid.g, grid.y0 + np.arange(grid.ny) * grid.g)
    grid.blocked |= (px_ < ex0 + EDGE + half) | (px_ > ex1 - EDGE - half) | (py_ < ey0 + EDGE + half) | (py_ > ey1 - EDGE - half)
    # leave each end along its heading: the first cells are free by construction (pair_stubs PAIR_FRONT)
    cells = []
    for e in ends:
        c = grid.cell(*e['m'])
        for k in range(0, int(FRONT / grid.g) + 1):
            x, y = e['m'][0] + e['h'][0] * k * grid.g, e['m'][1] + e['h'][1] * k * grid.g
            i, j = grid.cell(x, y)
            grid.blocked[j, i] = False
        cells.append(c)
    # lead-in points: FRONT along each heading (free by construction); A* runs between them
    leads = [(e['m'][0] + e['h'][0] * FRONT, e['m'][1] + e['h'][1] * FRONT) for e in ends]
    path = astar(grid, grid.cell(*leads[0]), grid.cell(*leads[1]), ends[0]['h'], ends[1]['h'])
    if path is None:
        reach = [flood(grid, c) for c in cells]
        for e in ends:
            probe = []
            for dmm in (0.5, 1.0, 1.5, 2.0, 3.0, 4.0):
                i, j = grid.cell(e['m'][0] + e['h'][0] * dmm, e['m'][1] + e['h'][1] * dmm)
                probe.append(f'{dmm}:{"X" if grid.blocked[j, i] else "."}')
            print(f'  end {e["m"][0]:.2f},{e["m"][1]:.2f} heading {e["h"][0]:+.2f},{e["h"][1]:+.2f} {" ".join(probe)}')
        if a.debug:
            dump(grid, reach, f'{a.debug}/{base.replace("/", "_")}.pgm')
        return (f'PAIR {base} FAILED no centreline path on {layer} (free cells reached from the ends: '
                f'{int(reach[0].sum())} / {int(reach[1].sum())})')
    poly = [grid.xy(i, j) for i, j in simplify(path)]
    poly[0], poly[-1] = leads[0], leads[1]
    poly = [ends[0]['m']] + poly + [ends[1]['m']]
    # drop points that make a segment shorter than MIN_SEG (the grid snap next to a lead-in): their mitred offsets
    # pinch P and N (ETH_TX at J201, 2026-10-26: gap 0.134 mm)
    kept = [poly[0]]
    for k, q in enumerate(poly[1:], 1):
        if k < len(poly) - 1 and math.hypot(q[0] - kept[-1][0], q[1] - kept[-1][1]) < MIN_SEG:
            continue
        if k == len(poly) - 1 and len(kept) > 1 and math.hypot(q[0] - kept[-1][0], q[1] - kept[-1][1]) < MIN_SEG:
            kept.pop()
        kept.append(q)
    poly = simplify_pts(kept)
    if single:
        poly[0], poly[-1] = ends[0]['m'], ends[1]['m']
        nets = board.GetNetsByName()
        for a_, b_ in zip(poly, poly[1:]):
            t = pcbnew.PCB_TRACK(board)
            t.SetStart(v2(*a_))
            t.SetEnd(v2(*b_))
            t.SetWidth(pcbnew.FromMM(w))
            t.SetLayer(lid)
            t.SetNet(nets[pn])
            board.Add(t)
        return f'PAIR {base} routed on {layer} single track {length(poly):.1f} mm, net {net_length(board, pn):.2f} mm'
    # P on the side of its tip at the start
    e0 = ends[0]
    dx, dy = poly[1][0] - poly[0][0], poly[1][1] - poly[0][1]
    left = (e0['p'][0][0] - e0['m'][0]) * -dy + (e0['p'][0][1] - e0['m'][1]) * dx > 0
    pp, np_ = offset(poly, s / 2 if left else -s / 2), offset(poly, -s / 2 if left else s / 2)
    # the offset ends must be the tips (straight start / end along the heading)
    e1 = ends[1]
    if math.hypot(pp[-1][0] - e1['p'][0][0], pp[-1][1] - e1['p'][0][1]) > 0.06:
        return f'PAIR {base} FAILED polarity or heading mismatch at the far end ({pp[-1]} vs {e1["p"][0]})'
    pp[0], np_[0] = e0['p'][0], e0['n'][0]
    pp[-1], np_[-1] = e1['p'][0], e1['n'][0]
    nets = board.GetNetsByName()
    for poly_, net in ((pp, pn), (np_, nn)):
        for a_, b_ in zip(poly_, poly_[1:]):
            t = pcbnew.PCB_TRACK(board)
            t.SetStart(v2(*a_))
            t.SetEnd(v2(*b_))
            t.SetWidth(pcbnew.FromMM(w))
            t.SetLayer(lid)
            t.SetNet(nets[net])
            board.Add(t)
    lp, ln_ = net_length(board, pn), net_length(board, nn)
    return f'PAIR {base} routed on {layer} centreline {length(poly):.1f} mm P {lp:.2f} N {ln_:.2f} skew {lp - ln_:+.2f} mm'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('board')
    ap.add_argument('out')
    ap.add_argument('--pair', action='append', default=[], help='BASE:WIDTH:GAP[:LAYER]')
    ap.add_argument('--net', action='append', default=[], help='NET:WIDTH[:LAYER] one track between its two free tips')
    ap.add_argument('--same-class-space', type=float, default=CLEAR, help='single tracks: to tracks of the same class')
    ap.add_argument('--guard-class', action='append', default=[], help='single tracks: keep --space from these classes')
    ap.add_argument('--space-exempt-area', action='append', default=[], help='rule area names exempt from the spacings')
    ap.add_argument('--channel', action='append', default=[], help='REF:HALF:LATERAL radial channel near a part (see route_pair)')
    ap.add_argument('--layer', default='F.Cu')
    ap.add_argument('--keepout', action='append', default=[])
    ap.add_argument('--space', type=float, default=0.5)
    ap.add_argument('--pad-room', type=float, default=CLEAR, help='distance from the pair edge to other-class pads outside the exempt courtyards (room for their own tracks)')
    ap.add_argument('--space-exempt', action='append', default=[])
    ap.add_argument('--barrier', action='append', default=[], help='NETPREFIX:MM')
    ap.add_argument('--grid', type=float, default=0.05)
    ap.add_argument('--margin', type=float, default=15.0)
    ap.add_argument('--debug', default='', help='folder for a grid image of each failed pair (PGM)')
    a = ap.parse_args()
    order = list(a.pair) + ['NET=' + n for n in a.net]
    for attempt in range(len(order)):
        board = pcbnew.LoadBoard(a.board)
        lines, failed = route_all(board, order, a)
        if not failed:
            break
        # a pair blocked by one routed before it: route it first next time
        print(f'ORDER attempt {attempt + 1}: failed {failed}; retry with them first', flush=True)
        order = [p for p in order if p in failed] + [p for p in order if p not in failed]
    for line in lines:
        print(line, flush=True)
    pcbnew.SaveBoard(a.out, board)
    ok = sum(1 for line in lines if ' routed ' in line)
    print(f'PAIRS routed {ok} failed {len(lines) - ok}')
    sys.exit(0 if ok == len(lines) else 1)


def route_all(board, order, a):
    lines, failed = [], []
    for spec in order:
        single = spec.startswith('NET=')
        parts = (spec[4:] if single else spec).split(':')
        lay = a.layer
        if parts[-1].endswith('.Cu'):
            lay = parts.pop()
        if single:
            base, w, gap = ':'.join(parts[:-1]), parts[-1], '0'
        else:
            base, w, gap = ':'.join(parts[:-2]), parts[-2], parts[-1]
        line = route_pair(board, base, float(w), float(gap), lay, a, single=single)
        lines.append(line)
        if ' routed ' not in line:
            failed.append(spec)
    return lines, failed


if __name__ == '__main__':
    main()
