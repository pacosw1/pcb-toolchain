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


def astar(free, viaok, seeds, target, via_cost, turn_cost, lcost=None, goal=None, hw=0.95):
    """A* over (layer, row, col); the turn cost uses the move that reached a cell (not part of the state: near-optimal,
    8x less memory than a direction state)."""
    nl = len(free)
    ny, nx = free[0].shape
    tg = np.argwhere(np.any(np.stack(target), axis=0))
    if not len(tg):
        return None
    tj, ti = goal if goal is not None else tg.mean(axis=0)
    fr = [f.tolist() for f in free]
    vo = viaok.tolist()
    tgt = [t.tolist() for t in target]
    INF = float('inf')
    lcost = lcost or [1.0] * nl
    best, came, mv = {}, {}, {}
    heap = []
    for l in range(nl):
        for j, i in np.argwhere(seeds[l] & free[l]):
            s = (l, int(j), int(i))
            best[s] = 0.0
            mv[s] = -1
            heapq.heappush(heap, (math.hypot(j - tj, i - ti) * hw, 0.0, s))
    done = set()
    while heap:
        f, g, s = heapq.heappop(heap)
        if s in done:
            continue
        done.add(s)
        l, j, i = s
        if tgt[l][j][i]:
            path = [s]
            while path[-1] in came:
                path.append(came[path[-1]])
            return [(p[0], p[1], p[2], 0) for p in path[::-1]]
        d = mv.get(s, -1)
        row = fr[l]
        for k, (di, dj, c) in enumerate(MOVES):
            ii, jj = i + di, j + dj
            if not (0 <= ii < nx and 0 <= jj < ny) or not row[jj][ii]:
                continue
            if di and dj and not (row[j][ii] and row[jj][i]):
                continue
            ns = (l, jj, ii)
            if ns in done:
                continue
            ng = g + c * lcost[l] + (turn_cost if d not in (-1, k) else 0.0)
            if ng < best.get(ns, INF):
                best[ns], came[ns], mv[ns] = ng, s, k
                heapq.heappush(heap, (ng + math.hypot(jj - tj, ii - ti) * hw, ng, ns))
        if vo[j][i]:
            for m in range(nl):
                ns = (m, j, i)
                if m != l and fr[m][j][i] and ns not in done:
                    ng = g + via_cost
                    if ng < best.get(ns, INF):
                        best[ns], came[ns], mv[ns] = ng, s, -1
                        heapq.heappush(heap, (ng + math.hypot(j - tj, i - ti) * hw, ng, ns))
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


def write_items(path_board, net, items, w, layers, via_d, via_drill):
    b = pcbnew.LoadBoard(path_board)
    have = {(v.GetPosition().x, v.GetPosition().y) for v in b.GetTracks()
            if v.GetClass() == 'PCB_VIA' and v.GetNetname() == net}
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
            xy = (MM(it[1][0]), MM(it[1][1]))
            if any(abs(xy[0] - hx) < 1000 and abs(xy[1] - hy) < 1000 for hx, hy in have):
                continue
            have.add(xy)
            v = pcbnew.PCB_VIA(b)
            v.SetPosition(pcbnew.VECTOR2I(*xy))
            v.SetWidth(MM(via_d))
            v.SetDrill(MM(via_drill))
            v.SetNet(n)
            v.SetLocked(True)
            b.Add(v)
    pcbnew.SaveBoard(path_board, b)


def escapes(a, layers):
    """--escape REF: route every signal pad of REF that has no copper yet from the pad to the first free cell outside the
    ring box (REF courtyard + --escape-ring mm), biased towards the nearest other pad of its net. The track end is left
    open for the autorouter (Codex sol 2026-10-16: settle the package escape topology first, then autoroute)."""
    skip = set(a.skip.split(',')) | set(x for x in a.escape_skip.split(',') if x)
    b = pcbnew.LoadBoard(a.board)
    M = pcbnew.ToMM
    fp = [f for f in b.GetFootprints() if f.GetReference() == a.escape][0]
    cy = fp.GetCourtyard(pcbnew.F_CrtYd).BBox()
    rx0, ry0, rx1, ry1 = M(cy.GetX()) - a.escape_ring, M(cy.GetY()) - a.escape_ring, M(cy.GetRight()) + a.escape_ring, M(cy.GetBottom()) + a.escape_ring
    cx, cyy = (rx0 + rx1) / 2, (ry0 + ry1) / 2
    touched = set()
    for t in b.GetTracks():
        for q in ((t.GetStart(),) if t.GetClass() == 'PCB_VIA' else (t.GetStart(), t.GetEnd())):
            touched.add((t.GetNetname(), round(M(q.x), 2), round(M(q.y), 2)))
    pads = []
    others = {}
    for f in b.GetFootprints():
        for p in f.Pads():
            others.setdefault(p.GetNetname(), []).append((f.GetReference(), M(p.GetPosition().x), M(p.GetPosition().y)))
    for p in fp.Pads():
        net = p.GetNetname()
        if not net or net in skip or net.startswith('unconnected'):
            continue
        x, y = M(p.GetPosition().x), M(p.GetPosition().y)
        bb = p.GetBoundingBox()
        if any(n == net and M(bb.GetX()) - 0.01 <= tx <= M(bb.GetRight()) + 0.01 and M(bb.GetY()) - 0.01 <= ty <= M(bb.GetBottom()) + 0.01
               for n, tx, ty in touched):
            continue   # already has copper (a hand route)
        dest = [o for o in others.get(net, []) if o[0] != a.escape]
        if not dest:
            continue
        dx, dy = min(((ox, oy) for _, ox, oy in dest), key=lambda q: math.hypot(q[0] - x, q[1] - y))
        pads.append((math.atan2(y - cyy, x - cx), p.GetNumber(), net, x, y, dx, dy))
    pads.sort()
    done = 0
    for _, num, net, x, y, dx, dy in pads:
        bd = route_grid.Board(a.board, layers, a.grid)
        for it in bd.items:
            it.clr += bd.g
        for k in list(bd.net_clr):
            bd.net_clr[k] += bd.g
        bd.edge_clr += bd.g
        bd._cache.clear()
        win = bd.win(rx0 - 3, ry0 - 3, rx1 + 3, ry1 + 3)
        bd.win_i, bd.win_j = win[0], win[2]
        free, viaok, _ = bd.net_grids(net, win)
        own = [it for (it, pp, ff) in bd.net_pads[net] if ff.GetReference() == a.escape and pp.GetNumber() == num]
        if not own:
            continue
        seeds = bd.item_seed(own[0], win)
        px, py = bd.centres(*win)
        outside = (px < rx0) | (px > rx1) | (py < ry0) | (py > ry1)
        target = [outside & f for f in free]
        goal = ((dy - bd.y0) / bd.g - win[2], (dx - bd.x0) / bd.g - win[0])
        lc = dict(z.split('=') for z in a.layer_cost)
        path = astar(free, viaok, seeds, target, a.via_cost / a.grid, a.turn_cost / a.grid,
                     [float(lc.get(l, 1.0)) for l in layers], goal=goal, hw=0.4)
        if path is None:
            print(f'NOPATH escape {a.escape}.{num} {net}')
            continue
        items = to_items(bd, path, bd.wmin)
        nv = sum(1 for it in items if it[0] == 'via')
        print(f'ESCAPE {a.escape}.{num} {net}: {len(items) - nv} segments, {nv} vias')
        if not a.dry_run:
            write_items(a.board, net, items, bd.wmin, layers, bd.net_via.get(net, 0.6), a.via_drill)
        done += 1
    print(f'FINISH escapes {done} of {len(pads)}')


def no_via_in_pads(bd, net, win, viaok):
    """Clear the via sites over the net's own SMD pads (other nets' pads are obstacles already): a via in an SMD pad is
    a viapads gate failure (tools/pcbtool.py viapads)."""
    r = bd.net_via.get(net, 0.6) / 2 + 0.05
    i0, i1, j0, j1 = win
    for (it, p, fp) in bd.net_pads.get(net, []):
        if p.GetAttribute() != pcbnew.PAD_ATTRIB_SMD:
            continue
        (a0, a1, b0, b1), m = bd.item_mask(bd._idx[id(it)], r)
        if m is None:
            continue
        c0, c1, d0, d1 = max(a0, i0), min(a1, i1), max(b0, j0), min(b1, j1)
        if c1 > c0 and d1 > d0:
            viaok[d0 - j0:d1 - j0, c0 - i0:c1 - i0] &= ~m[d0 - b0:d1 - b0, c0 - a0:c1 - a0]
    return viaok


def prep_board(a, layers, w):
    bd = route_grid.Board(a.board, layers, a.grid)
    bd.wmin = w
    for k in a.block:
        x0, y0, x1, y1 = (float(v) for v in k.split(','))
        bd.items.append(route_grid.Item('', 'keepout:block', set(layers), 0.0, kind='keep_track',
                                        polys=[np.array([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])]))
    for it in bd.items:
        it.clr += bd.g
    for k in list(bd.net_clr):
        bd.net_clr[k] += bd.g
    bd.edge_clr += bd.g
    bd.bbs = np.array([it.bb for it in bd.items])
    bd._idx = {id(it): k for k, it in enumerate(bd.items)}
    bd._cache.clear()
    return bd


def in2_clear_of_b(bd, layers):
    """B.Cu tracks of all nets as In2.Cu obstacles (net '' blocks every net): an In2 track then never lies under one."""
    if 'In2.Cu' not in layers:
        return
    extra = [route_grid.Item('', 'keepout:b-over-in2', {'In2.Cu'}, 0.2, kind='cu', seg=it.seg, hw=it.hw)
             for it in bd.items if it.owner == 'track' and 'B.Cu' in it.layers and it.seg is not None]
    bd.items.extend(extra)
    bd.bbs = np.array([it.bb for it in bd.items])
    bd._idx = {id(it): k for k, it in enumerate(bd.items)}
    bd._cache.clear()


def island_seed(bd, it, win):
    """Seed cells of the end item plus all same-net copper joined to it (touching cells on a shared layer; a via joins
    its layers). 2026-10-16 H7-CORE v2: a seed of the DRC end item alone (a fan-out stub on F.Cu) made the router
    drop a second via 0.1-0.3 mm from the stub's own via."""
    seed = [s.copy() for s in bd.item_seed(it, win)]
    cand = [x for x in bd.items if x.net == it.net and x is not it and x.kind in ('cu', 'pad')]
    used = set()
    grown = True
    while grown:
        grown = False
        dil = []
        for s in seed:
            d = s.copy()
            d[1:, :] |= s[:-1, :]; d[:-1, :] |= s[1:, :]; d[:, 1:] |= s[:, :-1]; d[:, :-1] |= s[:, 1:]
            dil.append(d)
        for k, x in enumerate(cand):
            if k in used:
                continue
            xs = bd.item_seed(x, win)
            if any((xs[l] & dil[l]).any() for l in range(len(seed))):
                used.add(k)
                grown = True
                for l in range(len(seed)):
                    seed[l] |= xs[l]
    return seed


def connect(a, layers, widths):
    """--connect: route each named pad pair; the seeds are the pad and the copper already joined to it on its net is
    not used (a direct pad-to-pad track, for power chains whose order matters: current-paths.json)."""
    done = 0
    for spec in a.connect:
        pa, pb = spec.split(':')
        ra, na = pa.split('.', 1)
        rb, nb = pb.split('.', 1)
        b = pcbnew.LoadBoard(a.board)
        fa = [f for f in b.GetFootprints() if f.GetReference() == ra][0]
        net = [p for p in fa.Pads() if p.GetNumber() == na][0].GetNetname()
        w = widths.get(net, 0.15)
        bd = prep_board(a, layers, w)
        if a.in2_clear_of_b:
            in2_clear_of_b(bd, layers)
        A = [it for (it, pp, ff) in bd.net_pads[net] if ff.GetReference() == ra and pp.GetNumber() == na]
        Bp = [it for (it, pp, ff) in bd.net_pads[net] if ff.GetReference() == rb and pp.GetNumber() == nb]
        if not A or not Bp:
            print(f'SKIP {spec}: pad not on net {net}')
            continue
        xs = [A[0].bb[0], A[0].bb[2], Bp[0].bb[0], Bp[0].bb[2]]
        ys = [A[0].bb[1], A[0].bb[3], Bp[0].bb[1], Bp[0].bb[3]]
        win = bd.win(min(xs) - a.margin, min(ys) - a.margin, max(xs) + a.margin, max(ys) + a.margin)
        bd.win_i, bd.win_j = win[0], win[2]
        real_via = bd.net_via.get(net, 0.6)
        if a.via_halo:
            bd.net_via[net] = a.via_halo
        free, viaok, _ = bd.net_grids(net, win)
        bd.net_via[net] = real_via
        viaok = no_via_in_pads(bd, net, win, viaok)
        lc = dict(z.split('=') for z in a.layer_cost)
        path = astar(free, viaok, bd.item_seed(A[0], win), bd.item_seed(Bp[0], win), a.via_cost / a.grid,
                     a.turn_cost / a.grid, [float(lc.get(l, 1.0)) for l in layers])
        if path is None:
            print(f'NOPATH {net}: {spec}')
            continue
        items = to_items(bd, path, w)
        nv = sum(1 for it in items if it[0] == 'via')
        L = sum(math.dist(it[2], it[3]) for it in items if it[0] == 'seg')
        print(f'ROUTED {net}: {spec} {len(items) - nv} segments, {nv} vias, {L:.2f} mm, width {w:.2f}')
        if not a.dry_run:
            write_items(a.board, net, items, w, layers, bd.net_via.get(net, 0.6), a.via_drill)
        done += 1
    print(f'FINISH routed {done} of {len(a.connect)}')


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
    ap.add_argument('--layer-cost', action='append', default=[], metavar='LAYER=X', help='move cost factor on a layer (default 1)')
    ap.add_argument('--via-drill', type=float, default=0.3)
    ap.add_argument('--in2-clear-of-b', action='store_true', help='In2.Cu tracks may not run under a B.Cu track of another net (the In2 slot would be under it: planes gate); B.Cu tracks become In2 obstacles with half width + 0.2 mm zone clearance')
    ap.add_argument('--via-halo', type=float, default=0.0, help='via sites need room for a via of this diameter (mm); the via is written at its class size (RP-001 room for a GND via)')
    ap.add_argument('--skip', default='GND,VDD_3V3', help='nets left to the planes / pours (comma list)')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--connect', action='append', default=[], metavar='REF.PAD:REF.PAD',
                    help='route these pad pairs (same net) in place of the DRC open list')
    ap.add_argument('--block', action='append', default=[], metavar='X0,Y0,X1,Y1',
                    help='temporary no-track box on every job layer, for this call only (keeps a corridor free)')
    ap.add_argument('--escape', default='', help='REF: route the pad escapes of this part (see escapes())')
    ap.add_argument('--escape-ring', type=float, default=3.0)
    ap.add_argument('--escape-skip', default='', help='more nets with no escape (power pins on planes)')
    a = ap.parse_args()
    layers = a.layers.split(',')
    if a.escape:
        return escapes(a, layers)
    widths = {k: float(v) for k, v in (x.split('=') for x in a.width)}
    nets = set(n for n in a.nets.split(',') if n)
    if a.connect:
        return connect(a, layers, widths)
    drc = os.path.splitext(a.board)[0] + '-finish-drc.json'
    subprocess.run([route_grid.KICAD_CLI, 'pcb', 'drc', '--format', 'json', '--units', 'mm', '-o', drc, a.board],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    opens = []
    for u in json.load(open(drc)).get('unconnected_items', []):
        its = u.get('items', [])
        m = re.search(r'\[([^\]]*)\]', its[0]['description']) if len(its) == 2 else None
        if m and 'Zone' not in its[0]['description'] + its[1]['description'] and (not nets or m.group(1) in nets) \
                and m.group(1) not in a.skip.split(','):
            opens.append((m.group(1), its[0], its[1]))
    os.remove(drc)
    routed = 0
    added = []
    for net, ia, ib in opens:
        bd = route_grid.Board(a.board, layers, a.grid)
        w = widths.get(net, bd.wmin)
        bd.wmin = w
        for k in a.block:
            x0, y0, x1, y1 = (float(v) for v in k.split(','))
            bd.items.append(route_grid.Item('', 'keepout:block', set(layers), 0.0, kind='keep_track',
                                            polys=[np.array([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])]))
        if a.block:
            bd.bbs = np.array([it.bb for it in bd.items])
            bd._idx = {id(it): k for k, it in enumerate(bd.items)}
        # route_grid shrinks obstacles by half a cell (right for triage: no false ENCLOSED). A router must not: one
        # grid cell more on every clearance makes each kept cell clear by at least the rule plus half a cell.
        for it in bd.items:
            it.clr += bd.g
        for k in list(bd.net_clr):
            bd.net_clr[k] += bd.g
        bd.edge_clr += bd.g
        bd._cache.clear()
        if a.in2_clear_of_b:
            in2_clear_of_b(bd, layers)
        by_uuid = {p.m_Uuid.AsString(): x for lst in bd.net_pads.values() for (x, p, fp) in lst}
        A = route_grid.item_for(bd, ia['description'], ia['pos'], ia.get('uuid', ''), by_uuid)
        B = route_grid.item_for(bd, ib['description'], ib['pos'], ib.get('uuid', ''), by_uuid)
        if A is None or B is None:
            print(f'SKIP {net}: an end item was not found')
            continue
        xs = [ia['pos']['x'], ib['pos']['x']]
        ys = [ia['pos']['y'], ib['pos']['y']]
        path = None
        for mg in [m for m in (4.0, 12.0, a.margin) if m <= a.margin] or [a.margin]:   # small windows first
            win = bd.win(min(xs) - mg, min(ys) - mg, max(xs) + mg, max(ys) + mg)
            bd.win_i, bd.win_j = win[0], win[2]
            real_via = bd.net_via.get(net, 0.6)
            if a.via_halo:
                bd.net_via[net] = a.via_halo
            free, viaok, _ = bd.net_grids(net, win)
            bd.net_via[net] = real_via
            viaok = no_via_in_pads(bd, net, win, viaok)
            sa, sb = island_seed(bd, A, win), island_seed(bd, B, win)
            lc = dict(x.split('=') for x in a.layer_cost)
            path = astar(free, viaok, sa, sb, a.via_cost / a.grid, a.turn_cost / a.grid, [float(lc.get(l, 1.0)) for l in layers])
            if path is not None:
                break
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
        have = {(v.GetPosition().x, v.GetPosition().y) for v in b.GetTracks()
                if v.GetClass() == 'PCB_VIA' and v.GetNetname() == net}   # a via already there is reused, not doubled
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
                xy = (MM(it[1][0]), MM(it[1][1]))
                if any(abs(xy[0] - hx) < 1000 and abs(xy[1] - hy) < 1000 for hx, hy in have):
                    continue
                have.add(xy)
                v = pcbnew.PCB_VIA(b)
                v.SetPosition(pcbnew.VECTOR2I(*xy))
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
