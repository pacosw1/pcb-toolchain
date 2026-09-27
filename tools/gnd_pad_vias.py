#!/usr/bin/env python3
"""Put a ground via next to each ground SMD pad (CLAUDE.md section 4, standard stackup).

Run with KiCad's bundled Python (pcbnew):
  $PY tools/gnd_pad_vias.py BOARD.kicad_pcb OUT.kicad_pcb [--net GND] [--skip U1,U10] [--r 1.0]

For each SMD pad of NET on F.Cu with no NET via within --r mm of its centre:
1. Try via places around the pad (4 sides, then 4 corners; 2 distances).
2. Keep the first place with class clearance to every other-net pad, track and via,
   0.25 mm hole to hole, 0.5 mm copper to the board edge (D-040), and not in a rule
   area that forbids vias.
3. Add the via (net class size) and a short F.Cu track from the pad centre.
A pad with no free place is listed; the router or a hand fix must connect it.
The result is a proposal: DRC with --schematic-parity decides.
"""
import argparse
import math

import pcbnew

MM = pcbnew.FromMM


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('board')
    ap.add_argument('out')
    ap.add_argument('--net', default='GND')
    ap.add_argument('--skip', default='', help='refs or REF.PAD to skip (pads with their own thermal vias)')
    ap.add_argument('--r', type=float, default=1.0)
    ap.add_argument('--width', type=float, default=0.4)
    ap.add_argument('--via', type=float, nargs=2, default=(0.6, 0.3), metavar=('DIA', 'DRILL'))
    ap.add_argument('--clearance', type=float, default=0.2)
    a = ap.parse_args()
    skip = set(filter(None, a.skip.split(',')))
    b = pcbnew.LoadBoard(a.board)
    ds = b.GetDesignSettings()
    net = b.GetNetsByName()[a.net]
    # Default net class of the boards: via 0.6/0.3 mm, clearance 0.2 mm.
    via_d, drill = MM(a.via[0]), MM(a.via[1])
    clr = max(MM(a.clearance), ds.m_MinClearance)
    edge_gap = MM(0.5)
    w = MM(a.width)

    others = []  # (shape, layer set) of other-net copper
    holes = []
    for fp in b.GetFootprints():
        for p in fp.Pads():
            if p.GetDrillSize().x:
                holes.append((p.GetPosition(), p.GetDrillSize().x // 2))
            if p.GetNetCode() != net.GetNetCode():
                others.append((p, None))
    vias = []
    for t in b.GetTracks():
        if t.GetClass() == 'PCB_VIA':
            holes.append((t.GetPosition(), t.GetDrill() // 2))
            if t.GetNetCode() == net.GetNetCode():
                vias.append(t.GetPosition())
        if t.GetNetCode() != net.GetNetCode():
            others.append((t, None))
    edges = [d for d in b.GetDrawings() if d.GetLayer() == pcbnew.Edge_Cuts]
    rules = [z for z in b.Zones() if z.GetIsRuleArea() and z.GetDoNotAllowVias()]
    for fp in b.GetFootprints():
        rules += [z for z in fp.Zones() if z.GetIsRuleArea() and z.GetDoNotAllowVias()]
    outline = pcbnew.SHAPE_POLY_SET()
    b.GetBoardPolygonOutlines(outline, False)

    def free(pt, rad, seg=None):
        if not outline.Contains(pt):
            return False
        for d in edges:
            if d.GetEffectiveShape().Collide(pt, rad + edge_gap):
                return False
        for z in rules:
            if z.Outline().Contains(pt) or z.Outline().Collide(pt, rad):
                return False
        for item, _ in others:
            for layer in (pcbnew.F_Cu, pcbnew.B_Cu, pcbnew.In1_Cu, pcbnew.In2_Cu):
                if not item.IsOnLayer(layer):
                    continue
                if item.GetEffectiveShape(layer).Collide(pt, rad + clr):
                    return False
                if seg is not None and layer == pcbnew.F_Cu and item.GetEffectiveShape(layer).Collide(seg, w // 2 + clr):
                    return False
        for hp, hr in holes:
            if math.hypot(hp.x - pt.x, hp.y - pt.y) < hr + drill // 2 + MM(0.25):
                return False
        return True

    added, failed = 0, []
    for fp in b.GetFootprints():
        if fp.GetReference() in skip:
            continue
        for p in fp.Pads():
            if f'{fp.GetReference()}.{p.GetNumber()}' in skip:
                continue
            if p.GetNetCode() != net.GetNetCode() or p.GetAttribute() != pcbnew.PAD_ATTRIB_SMD:
                continue
            if not p.IsOnLayer(pcbnew.F_Cu):
                continue
            c = p.GetPosition()
            if any(math.hypot(v.x - c.x, v.y - c.y) <= MM(a.r) for v in vias):
                continue
            bb = p.GetBoundingBox()
            hx, hy = bb.GetWidth() // 2, bb.GetHeight() // 2
            done = False
            for extra in (MM(0.2), MM(0.5)):
                cands = []
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, 1), (1, -1), (-1, -1)):
                    ox = dx * (hx + via_d // 2 + extra) if dx else 0
                    oy = dy * (hy + via_d // 2 + extra) if dy else 0
                    cands.append(pcbnew.VECTOR2I(c.x + ox, c.y + oy))
                for pt in cands:
                    seg = pcbnew.SEG(c, pt)
                    if free(pt, via_d // 2, seg):
                        v = pcbnew.PCB_VIA(b)
                        v.SetPosition(pt)
                        v.SetWidth(via_d)
                        v.SetDrill(drill)
                        v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
                        v.SetNet(net)
                        b.Add(v)
                        t = pcbnew.PCB_TRACK(b)
                        t.SetStart(c)
                        t.SetEnd(pt)
                        t.SetWidth(w)
                        t.SetLayer(pcbnew.F_Cu)
                        t.SetNet(net)
                        b.Add(t)
                        holes.append((pt, drill // 2))
                        vias.append(pt)
                        added += 1
                        done = True
                        break
                if done:
                    break
            if not done:
                failed.append(f'{fp.GetReference()}.{p.GetNumber()}')
    pcbnew.SaveBoard(a.out, b)
    print(f'{a.net} vias added: {added}; no free place: {len(failed)} {" ".join(failed)}')


if __name__ == '__main__':
    main()
