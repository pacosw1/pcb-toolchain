#!/usr/bin/env python3
"""2-D placement plot with the ratsnest (PNG, PIL), for a board before routing.

  $PY tools/placement_plot.py BOARD.kicad_pcb OUT.png [--scale 12] [--poe-class POE]

Draws: Edge.Cuts outline, rule areas (orange), courtyards (grey; locked parts darker), pads (red = net class
--poe-class, blue = other nets, grey = no net), references, User.1 block boxes (cyan) and User.2 component boxes
(magenta) with their labels, and the ratsnest: a minimum spanning tree per net over the pad centres (GND thin
grey, power class PWR orange, others green). kicad-cli has no ratsnest output; this is a review aid, not a gate.
Prints one line: nets, ratsnest edges, total ratsnest length.
"""
import argparse
import math
import sys

import pcbnew
from PIL import Image, ImageDraw, ImageFont


def T(v):
    return pcbnew.ToMM(v)


def mst(pts):
    if len(pts) < 2:
        return []
    done, edges = {0}, []
    best = {i: (math.dist(pts[0], pts[i]), 0) for i in range(1, len(pts))}
    while best:
        i = min(best, key=lambda k: best[k][0])
        d, j = best.pop(i)
        edges.append((pts[j], pts[i], d))
        done.add(i)
        for k in best:
            dk = math.dist(pts[i], pts[k])
            if dk < best[k][0]:
                best[k] = (dk, i)
    return edges


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('board')
    ap.add_argument('out')
    ap.add_argument('--scale', type=float, default=12.0)
    ap.add_argument('--poe-class', default='POE')
    a = ap.parse_args()
    b = pcbnew.LoadBoard(a.board)
    bb = b.GetBoardEdgesBoundingBox()
    x0, y0, x1, y1 = T(bb.GetLeft()) - 4, T(bb.GetTop()) - 6, T(bb.GetRight()) + 4, T(bb.GetBottom()) + 4
    s = a.scale
    img = Image.new('RGB', (int((x1 - x0) * s), int((y1 - y0) * s)), 'white')
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', int(s * 0.9))
        big = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Bold.ttf', int(s * 1.4))
    except OSError:
        font = big = ImageFont.load_default()

    def P(x, y):
        return ((x - x0) * s, (y - y0) * s)

    def poly(sh, **kw):
        for i in range(sh.OutlineCount()):
            o = sh.Outline(i)
            pts = [P(T(o.CPoint(k).x), T(o.CPoint(k).y)) for k in range(o.PointCount())]
            if len(pts) > 2:
                d.polygon(pts, **kw)

    for z in b.Zones():
        if z.GetIsRuleArea():
            poly(z.Outline(), outline=(230, 120, 0), fill=(255, 235, 210))
            q = z.Outline().BBox()
            d.text(P(T(q.GetLeft()) + 0.3, T(q.GetTop()) + 0.2), z.GetZoneName(), fill=(200, 90, 0), font=font)
    for dr in b.GetDrawings():
        if dr.GetLayer() == pcbnew.Edge_Cuts and isinstance(dr, pcbnew.PCB_SHAPE):
            d.line([P(T(dr.GetStart().x), T(dr.GetStart().y)), P(T(dr.GetEnd().x), T(dr.GetEnd().y))], fill='black', width=3)
    poe = a.poe_class
    for fp in b.GetFootprints():
        c = fp.GetCourtyard(pcbnew.F_CrtYd)
        if c.OutlineCount():
            poly(c, outline=(90, 90, 90) if fp.IsLocked() else (150, 150, 150), fill=(238, 238, 238))
        for p in fp.Pads():
            q = p.GetBoundingBox()
            nc = p.GetNetClassName() if p.GetNetname() else ''
            col = (220, 30, 30) if poe in nc.split(',') else (60, 90, 200) if p.GetNetname() else (160, 160, 160)
            d.rectangle([P(T(q.GetLeft()), T(q.GetTop())), P(T(q.GetRight()), T(q.GetBottom()))], fill=col)
    nets = {}
    for fp in b.GetFootprints():
        for p in fp.Pads():
            n = p.GetNetname()
            if n and not n.startswith('unconnected-'):
                nets.setdefault(n, []).append((T(p.GetPosition().x), T(p.GetPosition().y), p.GetNetClassName()))
    total, count = 0.0, 0
    for n, pts in nets.items():
        cls = pts[0][2]
        col, w = ((175, 175, 175), 1) if n == 'GND' else ((240, 140, 0), 2) if 'PWR' in cls else \
            ((220, 30, 30), 2) if poe in cls else ((20, 160, 60), 1)
        for pa, pb, dist in mst([(x, y) for x, y, _ in pts]):
            d.line([P(*pa), P(*pb)], fill=col, width=w)
            if n != 'GND':
                total += dist
            count += 1
    for fp in b.GetFootprints():
        q = fp.GetBoundingBox(False, False)
        d.text(P(T(q.GetCenter().x), T(q.GetCenter().y)), fp.GetReference(), fill='black', font=font, anchor='mm')
    for dr in b.GetDrawings():
        if dr.GetLayer() in (pcbnew.User_1, pcbnew.User_2):
            col = (0, 170, 200) if dr.GetLayer() == pcbnew.User_1 else (200, 0, 200)
            if isinstance(dr, pcbnew.PCB_TEXT):
                d.text(P(T(dr.GetPosition().x), T(dr.GetPosition().y)), dr.GetText(), fill=col,
                       font=big if dr.GetLayer() == pcbnew.User_2 else font, anchor='ld')
            elif isinstance(dr, pcbnew.PCB_SHAPE):
                d.line([P(T(dr.GetStart().x), T(dr.GetStart().y)), P(T(dr.GetEnd().x), T(dr.GetEnd().y))], fill=col, width=2)
    d.text((8, 4), f'{b.GetFileName().split("/")[-1]}  ratsnest (MST per net): {count} edges, {total:.0f} mm without GND',
           fill='black', font=big)
    img.save(a.out)
    print(f'nets {len(nets)} ratsnest edges {count} length {total:.0f} mm (no GND) -> {a.out}')


if __name__ == '__main__':
    sys.exit(main())
