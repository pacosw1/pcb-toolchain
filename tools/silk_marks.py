#!/usr/bin/env python3
"""Add rating labels, cable mating labels and an isolation-barrier line to the top silkscreen of a board.

  $PY tools/silk_marks.py <BOARD> [--dry-run]        (KiCad python: pcbnew)

Reads hardware-design/boards/<BOARD>/silk-marks.json:
  {"texts": [{"text": "18-32V DC IN", "near": "J1", "size": 1.0}, ...],
   "barrier": {"classes": ["HOST", "HOST_PWR"], "gap": 4.0, "label": "ISOLATED",
               "label_near": [x, y], "label_angle": 90},          (label_near/label_angle optional: a dense barrier)
   "no_silk": [[x0, y0, x1, y1], ...]}
- texts: F.SilkS, stroke 0.15 mm (JLC minimum 0.153 mm is for lines; text 0.15 with 0.8 mm height prints, the
  repo standard), placed at the free spot nearest to the anchor footprint: the text box (+0.2 mm) is inside the
  board (1.0 mm from the edge), clear of every pad and hole (+0.25 mm), of all other silkscreen (+0.15 mm), of every
  footprint courtyard, and of the no_silk boxes. A text with no free spot within 8 mm stops the tool.
- barrier: the copper of the nets of these net classes (all copper layers: pads, tracks, vias, zone fills) grown by
  gap / 2 is the domain; its outline (the middle of the gap) is drawn as a dashed 0.15 mm F.SilkS line inside the
  board, broken where it would come within 0.3 mm of a pad or a hole, and the label is placed next to it.
- Everything goes in PCB_GROUP "silk-marks"; a rerun replaces it.
"""
import json
import math
import os
import sys

import pcbnew

MM = pcbnew.FromMM
T = pcbnew.ToMM
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GROUP = 'silk-marks'


def stackup_keep(path, fn):
    sys.path.insert(0, os.path.join(ROOT, 'tools'))
    from brand_mark import stackup_block, keep_stackup
    before = (stackup_block(open(path).read()) or (None,))[0]
    fn()
    keep_stackup(path, before)


def main():
    board = sys.argv[1]
    dry = '--dry-run' in sys.argv
    bd = os.path.join(ROOT, 'hardware-design', 'boards', board)
    spec = json.load(open(os.path.join(bd, 'silk-marks.json')))
    pcb = os.path.join(bd, json.load(open(os.path.join(bd, 'gate.json')))['project'] + '.kicad_pcb')
    b = pcbnew.LoadBoard(pcb)
    for g in list(b.Groups()):
        if g.GetName() == GROUP:
            for it in list(g.GetItems()):
                b.Delete(it)
            b.Delete(g)

    outline = pcbnew.SHAPE_POLY_SET()
    b.GetBoardPolygonOutlines(outline, False)
    inner = pcbnew.SHAPE_POLY_SET(outline)
    inner.Deflate(MM(1.0), pcbnew.CORNER_STRATEGY_ROUND_ALL_CORNERS, MM(0.05))
    pads = [p for f in b.GetFootprints() for p in f.Pads()]
    holes = [p for p in pads if p.GetDrillSize().x > 0] + [t for t in b.GetTracks() if t.GetClass() == 'PCB_VIA']
    silk = [d for d in b.GetDrawings() if d.GetLayer() == pcbnew.F_SilkS]
    silk += [g for f in b.GetFootprints() for g in list(f.GraphicalItems()) + [f.Reference(), f.Value()]
             if g.GetLayer() == pcbnew.F_SilkS and (g.GetClass() != 'PCB_FIELD' or g.IsVisible())]
    courts = []
    for f in b.GetFootprints():
        c = f.GetCourtyard(pcbnew.F_CrtYd)
        courts.append((f.GetReference(), c.BBox() if not c.IsEmpty() else f.GetBoundingBox(False)))
    no_silk = [pcbnew.BOX2I(pcbnew.VECTOR2I(MM(x0), MM(y0)), pcbnew.VECTOR2L(MM(x1 - x0), MM(y1 - y0)))
               for x0, y0, x1, y1 in spec.get('no_silk', [])]
    group = pcbnew.PCB_GROUP(b)
    group.SetName(GROUP)
    added = []

    def grow(box, mm):
        bb = pcbnew.BOX2I(box.GetPosition(), box.GetSize())
        bb.Inflate(MM(mm))
        return bb

    def box_free(bb, own=None):
        for k in range(0, 9):  # box corners and edge midpoints inside the inset outline
            x = bb.GetLeft() + bb.GetWidth() * (k % 3) // 2
            y = bb.GetTop() + bb.GetHeight() * (k // 3) // 2
            if not inner.Contains(pcbnew.VECTOR2I(x, y)):
                return False
        if any(bb.Intersects(grow(p.GetBoundingBox(), 0.25)) for p in pads):
            return False
        if any(bb.Intersects(grow(v.GetBoundingBox(), 0.1)) for v in holes):  # vias too: text over vias reads badly
            return False
        if any(bb.Intersects(grow(s.GetBoundingBox(), 0.15)) for s in silk):
            return False
        if any(bb.Intersects(c) for ref, c in courts):
            return False
        return not any(bb.Intersects(z) for z in no_silk)

    def place_text(text, near, size, angle=0):
        t = pcbnew.PCB_TEXT(b)
        t.SetText(text)
        t.SetLayer(pcbnew.F_SilkS)
        t.SetTextSize(pcbnew.VECTOR2I(MM(size), MM(size)))
        t.SetTextThickness(MM(0.15 if size <= 1.0 else 0.18))
        t.SetTextAngleDegrees(angle)
        if isinstance(near, str):
            f = b.FindFootprintByReference(near)
            anchor = [c for r, c in courts if r == near][0]
        else:
            anchor = pcbnew.BOX2I(pcbnew.VECTOR2I(MM(near[0]), MM(near[1])), pcbnew.VECTOR2L(0, 0))
        cx, cy = anchor.GetCenter().x, anchor.GetCenter().y
        best = None
        step = MM(0.25)
        rx, ry = anchor.GetWidth() // 2, anchor.GetHeight() // 2
        for ring in range(0, int(MM(8) / step)):
            d = ring * step
            pts = []
            n = max(16, ring * 4)
            for i in range(n):
                a = 2 * math.pi * i / n
                pts.append((int(cx + math.cos(a) * (rx + d + MM(size))), int(cy + math.sin(a) * (ry + d + MM(size) / 2))))
            for (x, y) in pts:
                t.SetPosition(pcbnew.VECTOR2I(x, y))
                bb = grow(t.GetBoundingBox(), 0.2)
                if box_free(bb):
                    dist = math.hypot(x - cx, y - cy)
                    if best is None or dist < best[0]:
                        best = (dist, x, y)
            if best:
                break
        if not best:
            raise SystemExit(f'silk_marks {board}: no free place for "{text}" (angle {angle}) near {near}')
        t.SetPosition(pcbnew.VECTOR2I(best[1], best[2]))
        silk.append(t)
        added.append(t)
        print(f'  text "{text}" at ({T(best[1]):.2f}, {T(best[2]):.2f}) angle {angle} near {near}')
        return t

    def place_any(tx):
        # text: a string or a list of fallbacks (longest first); each is tried at angle 0, then 90
        opts = tx['text'] if isinstance(tx['text'], list) else [tx['text']]
        for o in opts:
            for ang in (tx.get('angle', 0), 90):
                try:
                    return place_text(o, tx['near'], tx.get('size', 0.8), ang)
                except SystemExit as e:
                    last = e
        raise last

    for tx in spec.get('texts', []):
        place_any(tx)

    br = spec.get('barrier')
    if br:
        nets = {n.GetNetCode() for n in b.GetNetInfo().NetsByNetcode().values() if n.GetNetClassName() in br['classes']}
        region = pcbnew.SHAPE_POLY_SET()
        cu = [pcbnew.F_Cu, pcbnew.B_Cu] + [getattr(pcbnew, f'In{i}_Cu') for i in range(1, 5)]
        for it in list(b.GetTracks()) + pads:
            if it.GetNetCode() in nets:
                for L in cu:
                    if it.IsOnLayer(L):
                        it.TransformShapeToPolygon(region, L, 0, MM(0.02), pcbnew.ERROR_INSIDE)
        for z in b.Zones():
            if not z.GetIsRuleArea() and z.GetNetCode() in nets:
                for L in cu:
                    if z.IsOnLayer(L) and z.HasFilledPolysForLayer(L):
                        region.BooleanAdd(z.GetFilledPolysList(L))
        region.Simplify()
        region.Inflate(MM(br['gap'] / 2), pcbnew.CORNER_STRATEGY_ROUND_ALL_CORNERS, MM(0.05))
        region.Simplify()
        keep = [p.GetBoundingBox() for p in pads] + [h.GetBoundingBox() for h in holes]
        segs = 0
        dash = pcbnew.LINE_STYLE_DASH if hasattr(pcbnew, 'LINE_STYLE_DASH') else None
        mids = []
        for i in range(region.OutlineCount()):
            ol = region.Outline(i)
            n = ol.PointCount()
            for k in range(n):
                a, c = ol.CPoint(k), ol.CPoint((k + 1) % n)
                L = math.hypot(c.x - a.x, c.y - a.y)
                parts = max(1, int(L // MM(0.5)))
                for j in range(parts):  # short pieces, so a break near a pad removes little
                    p0 = pcbnew.VECTOR2I(int(a.x + (c.x - a.x) * j / parts), int(a.y + (c.y - a.y) * j / parts))
                    p1 = pcbnew.VECTOR2I(int(a.x + (c.x - a.x) * (j + 1) / parts), int(a.y + (c.y - a.y) * (j + 1) / parts))
                    if not (inner.Contains(p0) and inner.Contains(p1)):
                        continue
                    sb = pcbnew.BOX2I(pcbnew.VECTOR2I(min(p0.x, p1.x), min(p0.y, p1.y)),
                                      pcbnew.VECTOR2L(abs(p1.x - p0.x) + 1, abs(p1.y - p0.y) + 1))
                    if any(grow(sb, 0.3).Intersects(kb) for kb in keep) or any(sb.Intersects(z) for z in no_silk):
                        continue
                    if any(grow(sb, 0.15).Intersects(sl.GetBoundingBox()) for sl in silk):  # no silk on silk
                        continue
                    s = pcbnew.PCB_SHAPE(b)
                    s.SetShape(pcbnew.SHAPE_T_SEGMENT)
                    s.SetLayer(pcbnew.F_SilkS)
                    s.SetStart(p0)
                    s.SetEnd(p1)
                    s.SetWidth(MM(0.15))
                    if dash is not None:
                        st = s.GetStroke(); st.SetLineStyle(dash); s.SetStroke(st)
                    added.append(s)
                    mids.append(((p0.x + p1.x) // 2, (p0.y + p1.y) // 2))
                    segs += 1
        print(f'  barrier: {segs} silk pieces along the {br["gap"]} mm gap of classes {br["classes"]}')
        silk.extend(added[-segs:] if segs else [])  # the label must not sit on the line (added after the line is drawn)
        if br.get('label') and mids:
            mx = sum(x for x, y in mids) // len(mids)
            my = sum(y for x, y in mids) // len(mids)
            near = min(mids, key=lambda p: (p[0] - mx) ** 2 + (p[1] - my) ** 2)
            near = [T(near[0]), T(near[1])]
            place_text(br['label'], br.get('label_near', near), 0.8, br.get('label_angle', 0))
    if dry:
        print(f'silk_marks {board}: dry run, {len(added)} items')
        return
    for it in added:
        b.Add(it)
        group.AddItem(it)
    b.Add(group)
    stackup_keep(pcb, lambda: pcbnew.SaveBoard(pcb, b))
    print(f'silk_marks {board}: {len(added)} items in group "{GROUP}"')


if __name__ == '__main__':
    main()
