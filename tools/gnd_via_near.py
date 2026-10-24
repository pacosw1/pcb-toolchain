#!/usr/bin/env python3
"""GND via next to each signal via that has none within R (kicad-happy RP-001), by a full grid search (2026-10-16).

  $PY tools/gnd_via_near.py BOARD.kicad_pcb [--nets N1,N2] [--r 1.0] [--grid 0.025] [--dry-run]

For each via of the nets (default: every via of a non-plane net) with no GND via within R: every grid cell within R of
it where a GND via is legal on F.Cu and B.Cu (tools/route_grid.py legality, one cell extra clearance, no via in an SMD
pad, board edge) is a candidate; the one nearest the via is taken. pcbtool stitch searches fixed rings only.
Last line: "GNDVIA added A, no room N: <via list>".
"""
import argparse
import math
import os
import sys

import numpy as np
import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import grid_finish  # noqa: E402
import route_grid  # noqa: E402

M = pcbnew.ToMM


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('board')
    ap.add_argument('--nets', default='')
    ap.add_argument('--r', type=float, default=1.0)
    ap.add_argument('--grid', type=float, default=0.025)
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    want = {n for n in a.nets.split(',') if n}
    b = pcbnew.LoadBoard(a.board)
    gnd = [(M(t.GetPosition().x), M(t.GetPosition().y)) for t in b.GetTracks()
           if t.GetClass() == 'PCB_VIA' and t.GetNetname() == 'GND']
    sig = [(t.GetNetname(), M(t.GetPosition().x), M(t.GetPosition().y)) for t in b.GetTracks()
           if t.GetClass() == 'PCB_VIA' and t.GetNetname() not in ('GND', 'VDD_3V3') and (not want or t.GetNetname() in want)]
    need = [s for s in sig if not any(math.dist(s[1:], g) <= a.r for g in gnd)]
    added, miss = [], []
    for net, x, y in need:
        if any(math.dist((x, y), g) <= a.r for g in gnd + added):
            continue
        ga = argparse.Namespace(board=a.board, grid=a.grid, block=[])
        bd = grid_finish.prep_board(ga, ['F.Cu', 'B.Cu'], 0.15)
        for gx, gy in added:   # vias added in this run are obstacles too
            bd.items.append(route_grid.Item('GND', 'via', {'F.Cu', 'B.Cu'}, 0.2, seg=(gx, gy, gx, gy), hw=0.3))
        bd.bbs = np.array([it.bb for it in bd.items])
        bd._idx = {id(it): k for k, it in enumerate(bd.items)}
        bd._cache.clear()
        win = bd.win(x - a.r - 0.5, y - a.r - 0.5, x + a.r + 0.5, y + a.r + 0.5)
        free, viaok, _ = bd.net_grids('GND', win)
        viaok = grid_finish.no_via_in_pads(bd, 'GND', win, viaok)
        px, py = bd.centres(*win)
        d = np.hypot(px - x, py - y)
        ok = viaok & (d <= a.r)
        if not ok.any():
            miss.append(f'{net}@({x:.2f},{y:.2f})')
            continue
        j, i = np.unravel_index(np.where(ok, d, np.inf).argmin(), d.shape)
        added.append((float(px[j, i]), float(py[j, i])))
    if added and not a.dry_run:
        b = pcbnew.LoadBoard(a.board)
        n = b.GetNetsByName()['GND']
        for gx, gy in added:
            v = pcbnew.PCB_VIA(b)
            v.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(gx), pcbnew.FromMM(gy)))
            v.SetWidth(pcbnew.FromMM(0.6))
            v.SetDrill(pcbnew.FromMM(0.3))
            v.SetNet(n)
            v.SetLocked(True)
            b.Add(v)
        pcbnew.SaveBoard(a.board, b)
    print(f'GNDVIA added {len(added)}, no room {len(miss)}: {" ".join(miss)}')


if __name__ == '__main__':
    main()
