#!/usr/bin/env python3
"""Finish the last open connections of a routed board with a grid A* router (2026-10-16, H7-CORE).

  $PY tools/grid_finish.py BOARD.kicad_pcb [--nets N1,N2] [--layers F.Cu,B.Cu] [--grid 0.05] [--width NET=MM ...]
                           [--via-cost 4] [--dry-run]

Uses the legality grid of tools/route_grid.py (a cell is free when a track centre of the given width there clears every
copper item of another net by the larger clearance, the board edge and the no-track rule areas; a via fits where a via
of the net class diameter is free on every layer). For each open connection of the KiCad DRC report (one at a time, in
report order) it runs A* over (layer, cell) with 8-neighbour moves (a diagonal step needs both orthogonal neighbours
free), a turn cost and a via cost, then writes the path as merged straight segments (and vias) on the board, locked.
The tracks and vias are new items only; nothing is moved or removed. Run KiCad DRC after it: the grid is half a cell
conservative, the DRC result is the evidence. Prints one line per connection and "FINISH routed R of N".
Fastroute (tools/fastroute_job.py) stays the router; this closes what it leaves (ROUTER_MISS in its open-triage.json).
"""
import argparse
import heapq
import json
import math
import os
import re
import subprocess
import sys

import numpy as np
import pcbnew

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import route_grid  # noqa: E402

MM = pcbnew.FromMM
SQ2 = math.sqrt(2.0)
MOVES = [(1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0), (1, 1, SQ2), (1, -1, SQ2), (-1, 1, SQ2), (-1, -1, SQ2)]


def astar(free, viaok, seeds, target, via_cost, turn_cost):
    nl = len(free)
    ny, nx = free[0].shape
    tg = np.argwhere(np.any(np.stack(target), axis=0))
    if not len(tg):
        return None
    tj, ti = tg.mean(axis=0)

    def h(j, i):
        return math.hypot(j - tj, i - ti) * 0.9

    INF = float('inf')
    best = {}
    heap = []
    for l in range(nl):
        for j, i in np.argwhere(seeds[l] & free[l]):
            s = (l, int(j), int(i), -1)
            best[s] = 0.0
            heapq.heappush(heap, (h(j, i), 0.0, s, None))
    prev = {}
    while heap:
        f, g, s, p = heapq.heappop(heap)
        if g > best.get(s, INF):
            continue
        if s in prev and prev[s] is not p and p is not None:
            pass
        prev.setdefault(s, p)
        l, j, i, d = s
        if target[l][j, i]:
            path = [s]
            while prev.get(path[-1]) is not None:
                path.append(prev[path[-1]])
            return path[::-1]
        for k, (di, dj, c) in enumerate(MOVES):
            ii, jj = i + di, j + dj
            if not (0 <= ii < nx and 0 <= jj < ny) or not free[l][jj, ii]:
                continue
            if di and dj and not (free[l][j, ii] and free[l][jj, i]):
                continue
            ng = g + c + (turn_cost if d not in (-1, k) else 0.0)
            ns = (l, jj, ii, k)
            if ng < best.get(ns, INF):
                best[ns] = ng
                prev[ns] = s
                heapq.heappush(heap, (ng + h(jj, ii), ng, ns, s))
        if viaok[j, i]:
            for m in range(nl):
                if m != l and free[m][j, i]:
                    ns = (m, j, i, -1)
                    ng = g + via_cost
                    if ng < best.get(ns, INF):
                        best[ns] = ng
                        prev[ns] = s
                        heapq.heappush(heap, (ng + h(j, i), ng, ns, s))
    return None


def to_items(bd, path, w):
    """Path of (layer, j, i, dir) -> [('seg', layer, (x1, y1), (x2, y2)) | ('via', (x, y))] with collinear runs merged."""
    pts = [(l, bd.x0 + (i0 + bd.win_i + 0.5) * bd.g, bd.y0 + (j0 + bd.win_j + 0.5) * bd.g) for l, j0, i0, _ in path]
    out, run = [], [pts[0]]
    for p in pts[1:]:
        if p[0] != run[-1][0]:
            if len(run) > 1:
                out.append(('seg', run[0][0], run[0][1:], run[-1][1:]))
            out.append(('via', p[1:]))
            run = [p]
            continue
        if len(run) >= 2:
            (_, x1, y1), (_, x2, y2) = run[-2], run[-1]
            if abs((x2 - x1) * (p[2] - y2) - (y2 - y1) * (p[1] - x2)) < 1e-9:
                run[-1] = p
                continue
            out.append(('seg', run[0][0], run[0][1:], run[-1][1:]))
            run = [run[-1], p]
        else:
            run.append(p)
    if len(run) > 1:
        out.append(('seg', run[0][0], run[0][1:], run[-1][1:]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('board')
    ap.add_argument('--nets', default='')
    ap.add_argument('--layers', default='F.Cu,B.Cu')
    ap.add_argument('--grid', type=float, default=0.05)
    ap.add_argument('--width', action='append', default=[], metavar='NET=MM')
    ap.add_argument('--via-cost', type=float, default=4.0, help='in mm of track')
    ap.add_argument('--turn-cost', type=float, default=0.3, help='in mm of track')
    ap.add_argument('--margin', type=float, default=10.0, help='search window around the two ends, mm')
    ap.add_argument('--via-drill', type=float, default=0.3)
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    layers = a.layers.split(',')
    widths = {k: float(v) for k, v in (x.split('=') for x in a.width)}
    nets = set(n for n in a.nets.split(',') if n)
    drc = os.path.splitext(a.board)[0] + '-finish-drc.json'
    subprocess.run([route_grid.KICAD_CLI, 'pcb', 'drc', '--format', 'json', '--units', 'mm', '-o', drc, a.board],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    opens = []
    for u in json.load(open(drc)).get('unconnected_items', []):
        its = u.get('items', [])
        m = re.search(r'\[([^\]]*)\]', its[0]['description']) if len(its) == 2 else None
        if m and 'Zone' not in its[0]['description'] + its[1]['description'] and (not nets or m.group(1) in nets):
            opens.append((m.group(1), its[0], its[1]))
    os.remove(drc)
    routed = 0
    added = []
    for net, ia, ib in opens:
        bd = route_grid.Board(a.board, layers, a.grid)
        w = widths.get(net, bd.wmin)
        bd.wmin = w
        # route_grid shrinks obstacles by half a cell (right for triage: no false ENCLOSED). A router must not: one
        # grid cell more on every clearance makes each kept cell clear by at least the rule plus half a cell.
        for it in bd.items:
            it.clr += bd.g
        for k in list(bd.net_clr):
            bd.net_clr[k] += bd.g
        bd.edge_clr += bd.g
        bd._cache.clear()
        by_uuid = {p.m_Uuid.AsString(): x for lst in bd.net_pads.values() for (x, p, fp) in lst}
        A = route_grid.item_for(bd, ia['description'], ia['pos'], ia.get('uuid', ''), by_uuid)
        B = route_grid.item_for(bd, ib['description'], ib['pos'], ib.get('uuid', ''), by_uuid)
        if A is None or B is None:
            print(f'SKIP {net}: an end item was not found')
            continue
        xs = [ia['pos']['x'], ib['pos']['x']]
        ys = [ia['pos']['y'], ib['pos']['y']]
        win = bd.win(min(xs) - a.margin, min(ys) - a.margin, max(xs) + a.margin, max(ys) + a.margin)
        bd.win_i, bd.win_j = win[0], win[2]
        free, viaok, _ = bd.net_grids(net, win)
        sa, sb = bd.item_seed(A, win), bd.item_seed(B, win)
        path = astar(free, viaok, sa, sb, a.via_cost / a.grid, a.turn_cost / a.grid)
        if path is None:
            print(f'NOPATH {net}: {ia["description"][:40]} -> {ib["description"][:40]}')
            continue
        items = to_items(bd, path, w)
        nv = sum(1 for it in items if it[0] == 'via')
        L = sum(math.dist(it[2], it[3]) for it in items if it[0] == 'seg')
        print(f'ROUTED {net}: {len(items) - nv} segments, {nv} vias, {L:.2f} mm, width {w:.2f}')
        routed += 1
        if a.dry_run:
            continue
        vd = MM(bd.net_via.get(net, 0.6))   # route_grid read the class via size (GetNetClass breaks after a
        vh = MM(a.via_drill)                 # board edit in this pcbnew build, so it is read once there)
        b = pcbnew.LoadBoard(a.board)
        n = b.GetNetsByName()[net]
        for it in items:
            if it[0] == 'seg':
                t = pcbnew.PCB_TRACK(b)
                t.SetStart(pcbnew.VECTOR2I(MM(it[2][0]), MM(it[2][1])))
                t.SetEnd(pcbnew.VECTOR2I(MM(it[3][0]), MM(it[3][1])))
                t.SetWidth(MM(w))
                t.SetLayer(b.GetLayerID(layers[it[1]]))
                t.SetNet(n)
                t.SetLocked(True)
                b.Add(t)
            else:
                v = pcbnew.PCB_VIA(b)
                v.SetPosition(pcbnew.VECTOR2I(MM(it[1][0]), MM(it[1][1])))
                v.SetWidth(vd)
                v.SetDrill(vh)
                v.SetNet(n)
                v.SetLocked(True)
                b.Add(v)
        pcbnew.SaveBoard(a.board, b)
        added.append(net)
    print(f'FINISH routed {routed} of {len(opens)}')


if __name__ == '__main__':
    main()
