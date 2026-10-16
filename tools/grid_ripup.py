#!/usr/bin/env python3
"""Rip-up and re-route for the last open connections of a routed board (2026-10-16, H7-CORE).

  $PY tools/grid_ripup.py BOARD.kicad_pcb --net NET [--layers F.Cu,B.Cu] [--margin 30] [--via-cost 3]

For one open connection of NET (the first in the KiCad DRC report): find a path on the legality grid of
tools/route_grid.py with the unlocked copper of the other nets left out (locked copper, pads and rule areas stay
obstacles), rip the unlocked tracks and vias of other nets that the path needs (closer than their clearance), lay the
path (locked), then re-route every connection the rip opened with tools/grid_finish.py. The board is written only when
the open count (KiCad DRC, signal nets) after the repair is lower than before; else it is left as it was.
Last line: "RIPUP PASS|FAIL <net> opens A -> B ripped <nets>".
"""
import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys

import numpy as np
import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import grid_finish  # noqa: E402
import route_grid  # noqa: E402

MM = pcbnew.FromMM
SKIP = ('GND', 'VDD_3V3')


def opens(board):
    out = board + '.ripup-drc.json'
    subprocess.run([route_grid.KICAD_CLI, 'pcb', 'drc', '--format', 'json', '--units', 'mm', '-o', out, board],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    res = []
    for u in json.load(open(out)).get('unconnected_items', []):
        its = u.get('items', [])
        m = re.search(r'\[([^\]]*)\]', its[0]['description']) if len(its) == 2 else None
        if m and 'Zone' not in its[0]['description'] + its[1]['description'] and m.group(1) not in SKIP:
            res.append((m.group(1), its[0], its[1]))
    os.remove(out)
    return res


def seg_dist(p, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L))
    return math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy)


def segs_dist(a1, a2, b1, b2):
    def cross(o, p, q):
        return (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
    d1, d2 = cross(b1, b2, a1), cross(b1, b2, a2)
    d3, d4 = cross(a1, a2, b1), cross(a1, a2, b2)
    if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)):
        return 0.0   # the segments cross (2026-10-16: the endpoint distances missed a crossing, DRC tracks_crossing)
    return min(seg_dist(a1, b1, b2), seg_dist(a2, b1, b2), seg_dist(b1, a1, a2), seg_dist(b2, a1, a2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('board')
    ap.add_argument('--net', required=True)
    ap.add_argument('--layers', default='F.Cu,B.Cu')
    ap.add_argument('--margin', type=float, default=30.0)
    ap.add_argument('--via-cost', type=float, default=3.0)
    ap.add_argument('--grid', type=float, default=0.05)
    ap.add_argument('--width', type=float, default=0.15)
    a = ap.parse_args()
    layers = a.layers.split(',')
    B = os.path.abspath(a.board)
    before = opens(B)
    mine = [o for o in before if o[0] == a.net]
    if not mine:
        print(f'RIPUP PASS {a.net} not open')
        return
    net, ia, ib = mine[0]
    # 1. the path on a copy without the other nets' unlocked copper
    tmp = B.replace('.kicad_pcb', '.ripup-tmp.kicad_pcb')
    b = pcbnew.LoadBoard(B)
    keep = [t for t in b.GetTracks() if t.IsLocked() or t.GetNetname() == net or t.GetNetname() in SKIP]
    gone = [t for t in b.GetTracks() if t not in keep]
    for t in gone:
        b.Remove(t)
    pcbnew.SaveBoard(tmp, b)
    for ext in ('.kicad_pro', '.kicad_dru'):
        src = B.replace('.kicad_pcb', ext)
        if os.path.isfile(src):
            shutil.copy(src, tmp.replace('.kicad_pcb', ext))
    ga = argparse.Namespace(board=tmp, grid=a.grid, block=[])
    bd = grid_finish.prep_board(ga, layers, a.width)
    by_uuid = {p.m_Uuid.AsString(): x for lst in bd.net_pads.values() for (x, p, fp) in lst}
    A = route_grid.item_for(bd, ia['description'], ia['pos'], ia.get('uuid', ''), by_uuid)
    Bi = route_grid.item_for(bd, ib['description'], ib['pos'], ib.get('uuid', ''), by_uuid)
    if A is None or Bi is None:
        print(f'RIPUP FAIL {net}: end item not found')
        sys.exit(1)
    xs = [ia['pos']['x'], ib['pos']['x']]
    ys = [ia['pos']['y'], ib['pos']['y']]
    win = bd.win(min(xs) - a.margin, min(ys) - a.margin, max(xs) + a.margin, max(ys) + a.margin)
    bd.win_i, bd.win_j = win[0], win[2]
    free, viaok, _ = bd.net_grids(net, win)
    viaok = grid_finish.no_via_in_pads(bd, net, win, viaok)
    path = grid_finish.astar(free, viaok, bd.item_seed(A, win), bd.item_seed(Bi, win), a.via_cost / a.grid,
                             0.3 / a.grid)
    for ext in ('.kicad_pcb', '.kicad_pro', '.kicad_dru'):
        f = tmp.replace('.kicad_pcb', ext)
        if os.path.isfile(f):
            os.remove(f)
    if path is None:
        print(f'RIPUP FAIL {net}: no path even with the other unlocked copper removed')
        sys.exit(1)
    items = grid_finish.to_items(bd, path, a.width)
    # 2. rip what the path needs, lay the path
    backup = B + '.ripup-backup'
    shutil.copy(B, backup)
    b = pcbnew.LoadBoard(B)
    clr = 0.2 + a.width / 2
    rip, ripped = [], set()
    for t in b.GetTracks():
        if t.IsLocked() or t.GetNetname() in (net,) + SKIP:
            continue
        if t.GetClass() == 'PCB_VIA':
            q = (pcbnew.ToMM(t.GetPosition().x), pcbnew.ToMM(t.GetPosition().y))
            r = pcbnew.ToMM(t.GetWidth(pcbnew.F_Cu)) / 2
            hit = any(seg_dist(q, it[2], it[3]) < r + clr for it in items if it[0] == 'seg') or \
                any(math.dist(q, it[1]) < r + 0.3 + 0.2 for it in items if it[0] == 'via')
        else:
            p1 = (pcbnew.ToMM(t.GetStart().x), pcbnew.ToMM(t.GetStart().y))
            p2 = (pcbnew.ToMM(t.GetEnd().x), pcbnew.ToMM(t.GetEnd().y))
            hw = pcbnew.ToMM(t.GetWidth()) / 2
            hit = any(it[0] == 'seg' and layers[it[1]] == t.GetLayerName() and segs_dist(p1, p2, it[2], it[3]) < hw + clr
                      for it in items) or any(it[0] == 'via' and min(seg_dist(it[1], p1, p2), 9) < hw + 0.3 + 0.2
                                              for it in items)
        if hit:
            rip.append(t)
            ripped.add(t.GetNetname())
    for t in rip:
        b.Remove(t)
    pcbnew.SaveBoard(B, b)
    grid_finish.write_items(B, net, items, a.width, layers, bd.net_via.get(net, 0.6), 0.3)
    # 3. re-route the ripped nets
    if ripped:
        subprocess.run([sys.executable, os.path.join(HERE, 'grid_finish.py'), B, '--nets', ','.join(sorted(ripped)),
                        '--margin', str(a.margin), '--via-cost', str(a.via_cost)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    after = opens(B)
    if len(after) < len(before):
        os.remove(backup)
        print(f'RIPUP PASS {net} opens {len(before)} -> {len(after)} ripped {",".join(sorted(ripped)) or "-"}')
    else:
        shutil.move(backup, B)
        left = sorted({o[0] for o in after})
        print(f'RIPUP FAIL {net} opens {len(before)} -> {len(after)} (board restored) ripped {",".join(sorted(ripped))}; '
              f'open after: {",".join(left)}')
        sys.exit(1)


if __name__ == '__main__':
    main()
