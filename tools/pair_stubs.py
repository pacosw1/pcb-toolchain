#!/usr/bin/env python3
"""Draw the stub tips of differential pairs for tools/pair_route.py from a board spec (2026-10-26, KIOSK-CM4).
  $PY tools/pair_stubs.py BOARD.kicad_pcb OUT.kicad_pcb SPEC.json
tools/pair_route.py routes a pair as one centreline between two tip pairs: at each end the P and N tracks must end
side by side at the pair pitch (width + gap), on the pair layer, pointing along a common heading with 1 mm free in
front, and P must be on opposite sides of the two headings. tools/build-net-node-pcb.py pair_stubs did this for one
board; this tool reads a spec:
  {"pairs": [{"base": "MDI0_", "width": 0.2, "gap": 0.2, "layer": "F.Cu",
              "ends": [{"ref": "JP1", "p": "56", "n": "55", "dir": [0, 1]},
                       {"ref": "J5", "p": "P2", "n": "P3", "dir": [0, -1], "run": 1.5, "cross_ok": true}]}]}
An end: the P and N pads of one footprint, the heading dir (pointing out of the pads into the route) and an
optional run (mm straight out of the pads before the fan; default: the pad half size along dir + 0.35). An end may
name a "link": another footprint's pads joined to the end pads by straight tracks first (a flow-through ESD array
next to its connector: the connector pads link to the ESD pads, the tips start at the ESD pads).
Fan: P and N go straight along dir, then on 45 degree diagonals to the pair axis at +-pitch/2, then FRONT straight
to the tips. When P is on the same side of both headings, the end with cross_ok gets a crossover: both legs go
outward, then cross on diagonals (P on B.Cu between two vias, N on F.Cu), then come back to +-pitch/2.
Hand geometry only at the pads; the result goes through DRC with parity like any router result.
"""
import argparse
import json
import math

import pcbnew

MM, T = pcbnew.FromMM, pcbnew.ToMM
FRONT = 1.0        # pair_route FRONT: free straight run before the tip
RUN_MARGIN = 0.35  # straight run past the pad edge before the fan
CROSS_OUT = 0.35   # crossover: extra outward offset beyond the pad offset
VIA = (0.45, 0.2)


def v2(x, y):
    return pcbnew.VECTOR2I(MM(x), MM(y))


def track(board, a, b, w, net, layer):
    if math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-3:
        return
    t = pcbnew.PCB_TRACK(board)
    t.SetStart(v2(*a))
    t.SetEnd(v2(*b))
    t.SetWidth(MM(w))
    t.SetLayer(layer)
    t.SetNet(net)
    t.SetLocked(True)
    board.Add(t)


def via(board, p, net):
    v = pcbnew.PCB_VIA(board)
    v.SetPosition(v2(*p))
    v.SetWidth(MM(VIA[0]))
    v.SetDrill(MM(VIA[1]))
    v.SetViaType(pcbnew.VIATYPE_THROUGH)
    v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
    v.SetNet(net)
    v.SetLocked(True)
    board.Add(v)


def pad_of(board, ref, num):
    fp = board.FindFootprintByReference(ref)
    if fp is None:
        raise SystemExit(f'{ref}: not on the board')
    for p in fp.Pads():
        if p.GetNumber() == str(num):
            return p
    raise SystemExit(f'{ref} pad {num}: not found')


def centre(p):
    return (T(p.GetPosition().x), T(p.GetPosition().y))


def half_along(p, d):
    bb = p.GetBoundingBox()
    return abs(d[0]) * T(bb.GetWidth()) / 2 + abs(d[1]) * T(bb.GetHeight()) / 2


def unit(d):
    n = math.hypot(d[0], d[1])
    return (d[0] / n, d[1] / n)


def side(p, m, h):
    """'left' when p is left of heading h seen from m (y-down coordinates), else 'right'."""
    cx = h[0] * (p[1] - m[1]) - h[1] * (p[0] - m[0])
    return 'left' if cx < 0 else 'right'


def end_geom(board, end):
    d = unit(end['dir'])
    n_ = (-d[1], d[0])
    pp, pn = pad_of(board, end['ref'], end['p']), pad_of(board, end['ref'], end['n'])
    cp, cn = centre(pp), centre(pn)
    m = ((cp[0] + cn[0]) / 2, (cp[1] + cn[1]) / 2)
    op = (cp[0] - m[0]) * n_[0] + (cp[1] - m[1]) * n_[1]     # P offset from the axis along n_ (N is -op)
    return d, n_, pp, pn, cp, cn, m, op


def polyline(board, pts, w, net, layer):
    """Points [x, y] or [x, y, "B.Cu"]: a via where the layer changes."""
    cur_layer = layer
    prev = None
    for p in pts:
        lay = board.GetLayerID(p[2]) if len(p) > 2 else cur_layer
        q = (p[0], p[1])
        if prev is not None:
            if lay != cur_layer:
                via(board, prev, net)
            track(board, prev, q, w, net, lay)
        prev, cur_layer = q, lay


def fan(board, end, pitch, w, layer, nets, report, cross):
    d, n_, pp, pn, cp, cn, m, op = end_geom(board, end)
    netp, netn = nets[pp.GetNetname()], nets[pn.GetNetname()]
    if 'fan_layer' in end:                 # SMD pads of an end whose pair runs on another layer: fan here, then drop
        layer = board.GetLayerID(end['fan_layer'])
    # straight-through ESD: the linked pads feed the entry pads, a straight track joins entry and end pads
    tp, tn = cp, cn
    if 'through' in end:
        th = end['through']
        tp, tn = centre(pad_of(board, end['ref'], th['p'])), centre(pad_of(board, end['ref'], th['n']))
        track(board, tp, cp, w, netp, layer)
        track(board, tn, cn, w, netn, layer)
    if 'link' in end:
        lk = end['link']
        if 'paths' in lk:                  # explicit escape polylines from the linked pads to the entry pads
            polyline(board, [list(centre(pad_of(board, lk['ref'], lk['p'])))] + lk['paths']['P'] + [list(tp)], w, netp, layer)
            polyline(board, [list(centre(pad_of(board, lk['ref'], lk['n'])))] + lk['paths']['N'] + [list(tn)], w, netn, layer)
        else:                              # straight out of the linked pads along dir by link run, then straight to the entry pads
            lr = lk.get('run', 0.0)
            for pad, c, net in ((pad_of(board, lk['ref'], lk['p']), tp, netp), (pad_of(board, lk['ref'], lk['n']), tn, netn)):
                a = centre(pad)
                b = (round(a[0] + d[0] * lr, 4), round(a[1] + d[1] * lr, 4))
                track(board, a, b, w, net, layer)
                track(board, b, c, w, net, layer)
    run = end.get('run', max(half_along(pp, d), half_along(pn, d)) + RUN_MARGIN)
    s = 1 if op >= 0 else -1
    o = abs(op)
    drop = end.get('drop')                 # "B.Cu": the tips are on this layer, staggered vias after the fan

    def pt(c, along, lat):
        return (round(c[0] + d[0] * along + n_[0] * lat, 4), round(c[1] + d[1] * along + n_[1] * lat, 4))

    if not cross:
        diag = max(o - pitch / 2, 0.0)
        for k, (c, sg, net) in enumerate(((cp, s, netp), (cn, -s, netn))):
            a = pt(m, run, sg * o)
            b = pt(m, run + diag, sg * pitch / 2)
            track(board, c, a, w, net, layer)
            track(board, a, b, w, net, layer)
            if drop:
                # diverge to +-DROP_OUT, staggered vias (0.6 mm along), B.Cu back to +-pitch/2, then FRONT; equal lengths
                DROP_OUT = 0.45          # via at +-0.45: 0.55 mm from a neighbour pair's leg 1.2 mm away (0.475 needed)
                dv = DROP_OUT - pitch / 2
                c1 = pt(m, run + diag + dv, sg * DROP_OUT)
                v = pt(m, run + diag + dv + 0.6 * k, sg * DROP_OUT)
                track(board, b, c1, w, net, layer)
                track(board, c1, v, w, net, layer)
                via(board, v, net)
                blay = board.GetLayerID(drop)
                v2_ = pt(m, run + diag + dv + 0.6, sg * DROP_OUT)
                track(board, v, v2_, w, net, blay)
                c2 = pt(m, run + diag + dv + 0.6 + dv, sg * pitch / 2)
                track(board, v2_, c2, w, net, blay)
                e = pt(m, run + diag + dv + 0.6 + dv + FRONT, sg * pitch / 2)
                track(board, c2, e, w, net, blay)
            else:
                e = pt(m, run + diag + FRONT, sg * pitch / 2)
                track(board, b, e, w, net, layer)
        tip_p = pt(m, run + diag + FRONT, s * pitch / 2)
    else:
        O = o + CROSS_OUT
        l1, l2, l3 = O - o, 2 * O, O - pitch / 2
        L = run + l1 + l2 + l3
        for k, (c, sg, net, hop) in enumerate(((cp, s, netp, True), (cn, -s, netn, False))):
            a = pt(m, run, sg * o)
            a1 = pt(m, run + l1, sg * O)
            a2 = pt(m, run + l1 + l2, -sg * O)
            a3 = pt(m, L, -sg * pitch / 2)
            track(board, c, a, w, net, layer)
            track(board, a, a1, w, net, layer)
            if hop:
                via(board, a1, net)
                track(board, a1, a2, w, net, pcbnew.B_Cu)
                via(board, a2, net)
            else:
                track(board, a1, a2, w, net, layer)
            track(board, a2, a3, w, net, layer)
            if drop:                       # as the plain fan: diverge, staggered vias, back on the drop layer, FRONT
                DROP_OUT = 0.45
                dv = DROP_OUT - pitch / 2
                c1 = pt(m, L + dv, -sg * DROP_OUT)
                v = pt(m, L + dv + 0.6 * k, -sg * DROP_OUT)
                track(board, a3, c1, w, net, layer)
                track(board, c1, v, w, net, layer)
                via(board, v, net)
                blay = board.GetLayerID(drop)
                v2_ = pt(m, L + dv + 0.6, -sg * DROP_OUT)
                track(board, v, v2_, w, net, blay)
                c2 = pt(m, L + 2 * dv + 0.6, -sg * pitch / 2)
                track(board, v2_, c2, w, net, blay)
                e = pt(m, L + 2 * dv + 0.6 + FRONT, -sg * pitch / 2)
                track(board, c2, e, w, net, blay)
            else:
                e = pt(m, L + FRONT, -sg * pitch / 2)
                track(board, a3, e, w, net, layer)
        tip_p = pt(m, L + FRONT, -s * pitch / 2)
    ps = side(tip_p, m, d)
    report.append(f'  end {end["ref"]} {end["p"]}/{end["n"]} dir {d[0]:+.0f},{d[1]:+.0f} run {run:.2f} P {ps}'
                  + (' CROSSOVER' if cross else ''))
    return ps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('board')
    ap.add_argument('out')
    ap.add_argument('spec')
    a = ap.parse_args()
    board = pcbnew.LoadBoard(a.board)
    spec = json.load(open(a.spec))
    nets = board.GetNetsByName()
    report = []
    for pr in spec['pairs']:
        w, gap = pr['width'], pr['gap']
        layer = board.GetLayerID(pr.get('layer', 'F.Cu'))
        report.append(f'PAIR {pr["base"]} w {w} gap {gap} pitch {w + gap}')
        ends = pr['ends']
        sides = []
        for end in ends:
            d, n_, pp, pn, cp, cn, m, op = end_geom(board, end)
            sides.append(side(cp, m, d))
        cross = [False] * len(ends)
        if len(ends) == 2 and sides[0] == sides[1]:
            k = next((i for i, e in enumerate(ends) if e.get('cross_ok')), None)
            if k is None:
                report.append('  WARN P on the same side of both headings and no cross_ok end: pair_route will fail polarity')
            else:
                cross[k] = True
        for i, end in enumerate(ends):
            fan(board, end, w + gap, w, layer, nets, report, cross[i])
    pcbnew.SaveBoard(a.out, board)
    print('\n'.join(report))


if __name__ == '__main__':
    main()
