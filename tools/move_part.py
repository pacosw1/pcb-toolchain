#!/usr/bin/env python3
"""Move one part to the nearest free place next to a pad (for example a test point next to its MCU pin).

  $PY tools/move_part.py IN.kicad_pcb OUT.kicad_pcb REF --near REF.PAD [--gap 0.5] [--max 15]

The part goes to the grid point (0.25 mm) nearest to the pad where its courtyard box, grown by --gap, meets no
other courtyard box, no pad of another part and no rule area, and stays 1 mm inside the board box. The tracks
and vias on the pads of the moved part are removed (they are routed again). OUT is never IN.
"""
import argparse
import math
import sys

import pcbnew

MM = pcbnew.FromMM


def box(fp):
    bb = fp.GetCourtyard(pcbnew.F_CrtYd).BBox()
    if bb.GetWidth() == 0:
        bb = fp.GetBoundingBox(False, False)
    return bb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('out')
    ap.add_argument('ref')
    ap.add_argument('--near', required=True)
    ap.add_argument('--gap', type=float, default=0.5)
    ap.add_argument('--max', type=float, default=15.0)
    a = ap.parse_args()
    b = pcbnew.LoadBoard(a.src)
    fp = b.FindFootprintByReference(a.ref)
    tref, tpad = a.near.split('.')
    target = next(p for p in b.FindFootprintByReference(tref).Pads() if p.GetNumber() == tpad).GetPosition()
    mine = box(fp)
    hw, hh = mine.GetWidth() // 2 + MM(a.gap), mine.GetHeight() // 2 + MM(a.gap)
    off = mine.GetCenter() - fp.GetPosition()
    blocks = [box(f) for f in b.GetFootprints() if f.GetReference() != a.ref]
    blocks += [z.GetBoundingBox() for z in b.Zones() if z.GetIsRuleArea()]
    edge = b.GetBoardEdgesBoundingBox()
    nets = {p.GetNetCode() for p in fp.Pads()}
    old_pads = [p.GetPosition() for p in fp.Pads()]

    def ok(cx, cy):
        if cx - hw < edge.GetLeft() + MM(1) or cx + hw > edge.GetRight() - MM(1) or cy - hh < edge.GetTop() + MM(1) or cy + hh > edge.GetBottom() - MM(1):
            return False
        return not any(cx - hw < o.GetRight() and cx + hw > o.GetLeft() and cy - hh < o.GetBottom() and cy + hh > o.GetTop() for o in blocks)

    step, best = MM(0.25), None
    n = int(MM(a.max) // step)
    for ix in range(-n, n + 1):
        for iy in range(-n, n + 1):
            cx, cy = target.x + ix * step, target.y + iy * step
            d = math.hypot(ix, iy)
            if (best is None or d < best[0]) and ok(cx, cy):
                best = (d, cx, cy)
    if best is None:
        sys.exit(f'move_part: no free place for {a.ref} within {a.max} mm of {a.near}')
    for t in list(b.GetTracks()):
        ends = [t.GetPosition()] if t.GetClass() == 'PCB_VIA' else [t.GetStart(), t.GetEnd()]
        if t.GetNetCode() in nets and any(math.hypot(e.x - q.x, e.y - q.y) < MM(0.05) for e in ends for q in old_pads):
            b.Remove(t)
    fp.SetPosition(pcbnew.VECTOR2I(int(best[1] - off.x), int(best[2] - off.y)))
    pcbnew.SaveBoard(a.out, b)
    print(f'move_part: {a.ref} to ({best[1] / 1e6:.2f}, {best[2] / 1e6:.2f}), {best[0] * 0.25:.2f} mm from {a.near}')


if __name__ == '__main__':
    main()
