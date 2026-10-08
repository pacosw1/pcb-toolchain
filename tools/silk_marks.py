#!/usr/bin/env python3
"""Add rating labels, cable mating labels and an isolation-barrier line to the top silkscreen of a board.

  $PY tools/silk_marks.py <BOARD> [--dry-run] [--pcb PATH]   (KiCad python: pcbnew; --pcb: a scratch copy)

Reads hardware-design/boards/<BOARD>/silk-marks.json:
  {"texts": [{"text": "18-32V DC IN", "near": "J1", "size": 1.0}, ...],
   "barrier": {"classes": ["HOST", "HOST_PWR"], "gap": 4.0, "label": "ISOLATED",
               "label_near": [x, y], "label_angle": 90},          (label_near/label_angle optional: a dense barrier)
   "no_silk": [[x0, y0, x1, y1], ...],
   "refs": {"keep": ["J*", "TP*", ...], "skip_values": ["*CA"], "size": 0.8, "max_mm": 2.5,
            "inside_span": false (true: a reference stays inside the x / y span of its own courtyard)}}
                                                   (references kept on F.SilkS; skip_values: no polarity, e.g. bidirectional TVS)
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
    if '--pcb' in sys.argv:   # a scratch copy of the board
        pcb = sys.argv[sys.argv.index('--pcb') + 1]
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

    bodies = []
    for ref, c in courts:   # the part body: the courtyard less its 0.25 mm margin (D-051)
        bb = pcbnew.BOX2I(c.GetPosition(), c.GetSize())
        bb.Inflate(-MM(0.25))
        bodies.append((ref, bb))

    def box_free(bb, own=None, body_only=False):
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
        if any(bb.Intersects(c) for ref, c in (bodies if body_only else courts)):
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
    # Reference designators kept on F.SilkS (2026-10-07): connectors, test points and parts with a polarity or a pin 1
    # (tools/silk_refs.py moved all references to F.Fab first). Each goes to the free place nearest to its courtyard
    # (0.25 mm steps, up to max_mm, angle 0 then 90); a reference with no free place stays on F.Fab and is listed.
    rs = spec.get('refs')
    no_place = []
    if rs:
        import fnmatch
        size = rs.get('size', 0.8)
        def tup(bb, mm):
            g = MM(mm)
            return (bb.GetLeft() - g, bb.GetTop() - g, bb.GetRight() + g, bb.GetBottom() + g)
        # tented vias do not stop a reference (silk prints on the solder mask over them); pads and holes do
        obs = [tup(p.GetBoundingBox(), 0.25) for p in pads] + \
              [tup(v.GetBoundingBox(), 0.1) for v in holes if v.GetClass() != 'PCB_VIA'] + \
              [tup(c, 0.0) for _, c in bodies] + [tup(z, 0.0) for z in no_silk]
        silk_t = [tup(x.GetBoundingBox(), 0.15) for x in silk]
        ib = inner.BBox()
        targets = [f for f in b.GetFootprints() if any(fnmatch.fnmatchcase(f.GetReference(), pat) for pat in rs['keep'])
                   and not any(fnmatch.fnmatchcase(f.GetValue(), pat) for pat in rs.get('skip_values', []))]

        def crowd(f):   # the parts in crowded places first: they have the fewest free places
            c = [cb for r, cb in courts if r == f.GetReference()][0]
            w = MM(3)
            return -sum(1 for o in obs if o[0] < c.GetRight() + w and c.GetLeft() - w < o[2] and
                        o[1] < c.GetBottom() + w and c.GetTop() - w < o[3])
        for f in sorted(targets, key=lambda f: (crowd(f), f.GetReference())):
            ref = f.GetReference()
            fld = f.Reference()
            fld.SetLayer(pcbnew.F_SilkS)
            fld.SetVisible(True)
            fld.SetTextSize(pcbnew.VECTOR2I(MM(size), MM(size)))
            fld.SetTextThickness(MM(0.15))
            fld.SetHorizJustify(pcbnew.GR_TEXT_H_ALIGN_CENTER)
            fld.SetVertJustify(pcbnew.GR_TEXT_V_ALIGN_CENTER)
            c = [cb for r, cb in courts if r == ref][0]
            cx, cy = c.GetCenter().x, c.GetCenter().y
            reach = MM(rs.get('max_mm', 2.5) + 4)
            win = (c.GetLeft() - reach, c.GetTop() - reach, c.GetRight() + reach, c.GetBottom() + reach)
            near = lambda o: o[0] < win[2] and win[0] < o[2] and o[1] < win[3] and win[1] < o[3]
            local = [o for o in obs + silk_t if near(o)]
            best = None
            for ang in (0, 90):
                fld.SetTextAngleDegrees(ang)
                fld.SetPosition(pcbnew.VECTOR2I(cx, cy))
                tb = tup(fld.GetBoundingBox(), 0.1)
                dx0, dy0, dx1, dy1 = tb[0] - cx, tb[1] - cy, tb[2] - cx, tb[3] - cy
                tw, th = tb[2] - tb[0], tb[3] - tb[1]
                for k in range(0, int(rs.get('max_mm', 2.5) / 0.25) + 1):
                    g = MM(0.1 + 0.25 * k)
                    xs = [c.GetLeft() - g - tw // 2, c.GetRight() + g + tw // 2]
                    ys = [c.GetTop() - g - th // 2, c.GetBottom() + g + th // 2]
                    hw, hh = c.GetWidth() // 2 + tw // 2, c.GetHeight() // 2 + th // 2
                    if rs.get('inside_span'):   # the text stays inside the span of its own part (no reading as a neighbour's)
                        hw, hh = max(c.GetWidth() // 2 - tw // 2, 0), max(c.GetHeight() // 2 - th // 2, 0)
                    cands = [(cx + dx, y) for dx in range(-hw, hw + 1, MM(0.25)) for y in ys] + \
                            [(x, cy + dy) for dy in range(-hh, hh + 1, MM(0.25)) for x in xs]
                    cands.sort(key=lambda q: math.hypot(q[0] - cx, q[1] - cy))
                    for x, y in cands:
                        r = (x + dx0, y + dy0, x + dx1, y + dy1)
                        if r[0] < ib.GetLeft() or r[1] < ib.GetTop() or r[2] > ib.GetRight() or r[3] > ib.GetBottom():
                            continue
                        if any(r[0] < o[2] and o[0] < r[2] and r[1] < o[3] and o[1] < r[3] for o in local):
                            continue
                        best = (int(x), int(y), ang)
                        break
                    if best:
                        break
                if best:
                    break
            if best is None:
                fld.SetLayer(pcbnew.F_Fab)
                no_place.append(ref)
                continue
            fld.SetTextAngleDegrees(best[2])
            fld.SetPosition(pcbnew.VECTOR2I(best[0], best[1]))
            silk.append(fld)
            silk_t.append(tup(fld.GetBoundingBox(), 0.15))
        print(f'  references on F.SilkS: {sum(1 for f in b.GetFootprints() if f.Reference().GetLayer() == pcbnew.F_SilkS)}'
              + (f'; no free place (left on F.Fab): {", ".join(no_place)}' if no_place else ''))
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
