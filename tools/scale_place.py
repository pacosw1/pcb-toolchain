#!/usr/bin/env python3
"""Spread (or shrink) a placement about the board center, for a route-then-shrink search.

  $PY tools/scale_place.py BOARD OUT --factor 1.3 [--skip GND] [--link 8] [--edge 3]

1. Groups: a part with <= 3 pads joins the nearest part with > 3 pads that shares a net
   (--skip nets do not count) and is within --link mm. Decoupling caps, pull-ups and
   feedback parts stay with their IC; each group moves as one block (offsets kept).
2. Edge parts (courtyard within --edge mm of the outline box) keep their distance to their edge.
3. Other group anchors scale about the outline center by --factor.
4. Edge.Cuts and copper zone outlines scale about the center. A keepout (rule area) moves with
   the footprint whose courtyard overlaps it most.
5. All tracks and vias are removed. OUT is a proposal for Freerouting; the Mac gates decide.
"""
import argparse
import math


def scale_pt(p, c, f):
    return (c[0] + f * (p[0] - c[0]), c[1] + f * (p[1] - c[1]))


def groups(parts, skip, link):
    """parts: {ref: {'pos', 'pads', 'nets'}}. Returns {ref: anchor_ref}."""
    out = {}
    for r, p in parts.items():
        best = None
        if p['pads'] <= 3:
            for a, q in parts.items():
                if q['pads'] <= 3 or not (p['nets'] & q['nets']) - skip:
                    continue
                d = math.dist(p['pos'], q['pos'])
                if d <= link and (best is None or d < best[0]):
                    best = (d, a)
        out[r] = best[1] if best else r
    return out


def new_positions(parts, grp, box, f, edge):
    x0, y0, x1, y1 = box
    c = ((x0 + x1) / 2, (y0 + y1) / 2)
    moved = {}
    for a in set(grp.values()) | set(edge):
        x, y = parts[a]['pos']
        if a in edge:
            side = min(((x - x0, (x0, y)), (x1 - x, (x1, y)), (y - y0, (x, y0)), (y1 - y, (x, y1))))[1]
            moved[a] = (x + (f - 1) * (side[0] - c[0]), y + (f - 1) * (side[1] - c[1]))
        else:
            moved[a] = scale_pt((x, y), c, f)
    out = {}
    for r, p in parts.items():
        a = r if r in edge else grp[r]
        ax, ay = parts[a]['pos']
        out[r] = (moved[a][0] + p['pos'][0] - ax, moved[a][1] + p['pos'][1] - ay)
    return out


def main():
    import pcbnew as pn
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('board'); ap.add_argument('out')
    ap.add_argument('--factor', type=float, required=True)
    ap.add_argument('--skip', nargs='*', default=['GND'])
    ap.add_argument('--link', type=float, default=8.0)
    ap.add_argument('--edge', type=float, default=3.0)
    a = ap.parse_args()
    mm, F = pn.ToMM, pn.FromMM
    b = pn.LoadBoard(a.board)
    eb = b.GetBoardEdgesBoundingBox()
    box = (mm(eb.GetX()), mm(eb.GetY()), mm(eb.GetRight()), mm(eb.GetBottom()))
    c = ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
    fps = {fp.GetReference(): fp for fp in b.GetFootprints()}
    parts = {r: {'pos': (mm(fp.GetPosition().x), mm(fp.GetPosition().y)), 'pads': len(fp.Pads()),
                 'nets': {d.GetNetname() for d in fp.Pads() if d.GetNetname()}} for r, fp in fps.items()}
    edge = set()
    for r, fp in fps.items():
        cb = fp.GetCourtyard(pn.F_Cu).BBox() if fp.GetCourtyard(pn.F_Cu).OutlineCount() else fp.GetBoundingBox()
        if min(mm(cb.GetX()) - box[0], box[2] - mm(cb.GetRight()), mm(cb.GetY()) - box[1], box[3] - mm(cb.GetBottom())) <= a.edge:
            edge.add(r)
    grp = groups(parts, set(a.skip), a.link)
    new = new_positions(parts, grp, box, a.factor, edge)
    # keepouts follow the footprint that overlaps them most (before the move)
    follow = {}
    for z in b.Zones():
        if not z.GetIsRuleArea():
            continue
        zb = z.GetBoundingBox()
        def overlap(fp):
            i = pn.BOX2I(zb.GetPosition(), zb.GetSize())
            cb = fp.GetBoundingBox(False)
            return max(0, min(i.GetRight(), cb.GetRight()) - max(i.GetX(), cb.GetX())) * \
                max(0, min(i.GetBottom(), cb.GetBottom()) - max(i.GetY(), cb.GetY()))
        follow[z.m_Uuid.AsString()] = max(fps, key=lambda r: overlap(fps[r]))
    for r, fp in fps.items():
        fp.SetPosition(pn.VECTOR2I(F(new[r][0]), F(new[r][1])))
    sp = lambda v: pn.VECTOR2I(*[F(t) for t in scale_pt((mm(v.x), mm(v.y)), c, a.factor)])
    for d in b.GetDrawings():
        if d.GetLayer() != pn.Edge_Cuts:
            continue
        if d.GetShape() == pn.SHAPE_T_ARC:
            d.SetArcGeometry(sp(d.GetStart()), sp(d.GetArcMid()), sp(d.GetEnd()))
        else:
            s, e = sp(d.GetStart()), sp(d.GetEnd()); d.SetStart(s); d.SetEnd(e)
    for z in b.Zones():
        if z.m_Uuid.AsString() in follow:
            r = follow[z.m_Uuid.AsString()]; old = parts[r]['pos']
            z.Move(pn.VECTOR2I(F(new[r][0] - old[0]), F(new[r][1] - old[1])))
        else:
            o = z.Outline()
            for i in range(o.TotalVertices()):
                o.SetVertex(i, sp(o.CVertex(i)))
    for t in list(b.GetTracks()):
        b.Remove(t)
    b.Save(a.out)
    print(f'scale_place: factor {a.factor} outline {a.factor * (box[2] - box[0]):.1f} x {a.factor * (box[3] - box[1]):.1f} mm, '
          f'{len(set(grp.values()))} groups, {len(edge)} edge parts, {len(follow)} keepouts moved -> {a.out}')


if __name__ == '__main__':
    main()
