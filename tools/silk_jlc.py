#!/usr/bin/env python3
"""silk_jlc: silkscreen texts and strokes up to the JLC legend minimums, and a silk-to-pad check on the fab Gerbers.

  $PY tools/silk_jlc.py check BOARD.kicad_pcb            list visible silk texts / strokes under the minimums
  $PY tools/silk_jlc.py apply BOARD.kicad_pcb            raise them (board texts, footprint fields and texts, strokes)
  VENV/python tools/silk_jlc.py pads GERBER.zip          silk within 0.15 mm of a mask opening (F and B), from the Gerbers
  $PY tools/silk_jlc.py clip BOARD.kicad_pcb             trim footprint silk strokes back to 0.15 mm from the mask openings

Source (registry/evidence/2026-11-03/jlcpcb-pcb-capabilities.html, "Legend Features"): minimum line width >= 0.15 mm;
minimum text height 40 mil (1.0 mm); character width to height ratio 1:6 preferred; pad to silkscreen 0.15 mm.
apply: a text under 1.0 mm is scaled to 1.0 mm high (width in proportion), its stroke = max(0.15, height / 6); a
stroke (line, arc, circle, rectangle, unfilled polygon) under 0.15 mm becomes 0.15 mm. Filled polygons keep their
outline (a fill has no stroke width). Positions are not changed. $PY = KiCad bundled Python. apply saves the board and
puts the .kicad_pro back. One summary line: PASS|FAIL|DONE <counts>.
"""
import os
import sys

MIN_H, MIN_W, PAD_CLR = 1.0, 0.15, 0.15


def items(pcbnew, b):
    """(kind, owner, item) for every visible silk text and stroke shape."""
    silk = (pcbnew.F_SilkS, pcbnew.B_SilkS)
    for d in b.GetDrawings():
        if d.GetLayer() in silk:
            yield ('text' if isinstance(d, pcbnew.PCB_TEXT) else 'shape'), 'board', d
    for fp in b.GetFootprints():
        for f in fp.GetFields():
            if f.GetLayer() in silk and f.IsVisible():
                yield 'text', fp.GetReference(), f
        for g in fp.GraphicalItems():
            if g.GetLayer() in silk:
                if isinstance(g, pcbnew.PCB_TEXT):
                    if g.IsVisible():
                        yield 'text', fp.GetReference(), g
                elif isinstance(g, pcbnew.PCB_SHAPE):
                    yield 'shape', fp.GetReference(), g


def low(pcbnew, kind, it):
    M = pcbnew.ToMM
    if kind == 'text':
        return M(it.GetTextHeight()) < MIN_H - 1e-6 or M(it.GetTextThickness()) < MIN_W - 1e-6
    if not isinstance(it, pcbnew.PCB_SHAPE):
        return False
    filled = it.IsSolidFill() if hasattr(it, 'IsSolidFill') else it.IsFilled()
    return not (filled and it.GetShape() == pcbnew.SHAPE_T_POLY) and M(it.GetWidth()) < MIN_W - 1e-6


def cmd(pcbnew, path, apply):
    b = pcbnew.LoadBoard(path)
    M, F = pcbnew.ToMM, pcbnew.FromMM
    n = {'text': 0, 'shape': 0}
    for kind, owner, it in items(pcbnew, b):
        if not low(pcbnew, kind, it):
            continue
        n[kind] += 1
        if kind == 'text':
            h, w, t = M(it.GetTextHeight()), M(it.GetTextWidth()), M(it.GetTextThickness())
            k = max(1.0, MIN_H / h)
            nh, nw = round(h * k, 4), round(w * k, 4)
            nt = round(max(MIN_W, t, nh / 6), 4)
            print(f'  text {owner} {b.GetLayerName(it.GetLayer())} "{it.GetText()}" {h}/{t} -> {nh}/{nt}')
            if apply:
                it.SetTextHeight(F(nh))
                it.SetTextWidth(F(nw))
                it.SetTextThickness(F(nt))
        else:
            print(f'  shape {owner} {b.GetLayerName(it.GetLayer())} {it.GetShapeStr()} {M(it.GetWidth())} -> {MIN_W}')
            if apply:
                it.SetWidth(F(MIN_W))
    if apply:
        d = os.path.dirname(os.path.abspath(path))
        keep = {os.path.join(d, f): open(os.path.join(d, f), 'rb').read() for f in os.listdir(d) if f.endswith('.kicad_pro')}
        pcbnew.SaveBoard(path, b)
        for p, data in keep.items():
            if open(p, 'rb').read() != data:
                open(p, 'wb').write(data)
        print(f'DONE apply: {n["text"]} texts, {n["shape"]} strokes raised to {MIN_H} mm / {MIN_W} mm')
        return 0
    ok = n['text'] == 0 and n['shape'] == 0
    print(f'{"PASS" if ok else "FAIL"} check: {n["text"]} texts, {n["shape"]} strokes under {MIN_H} mm / {MIN_W} mm')
    return 0 if ok else 1


def cmd_pads(zip_path):
    """Silk area within PAD_CLR of the solder-mask openings, per side, from the fab Gerbers."""
    import shutil
    import tempfile
    import zipfile
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import gerber_netcheck as gnc
    tmp = tempfile.mkdtemp()
    bad = 0.0
    try:
        zipfile.ZipFile(zip_path).extractall(tmp)
        names = os.listdir(tmp)
        for side in ('F', 'B'):
            silk = [f for f in names if f.endswith(f'-{side}_Silkscreen.gbr')]
            mask = [f for f in names if f.endswith(f'-{side}_Mask.gbr')]
            if len(silk) != 1 or len(mask) != 1:
                raise SystemExit(f'ERROR {side}: need one silkscreen and one mask Gerber, got {silk} {mask}')
            s = gnc.layer_geometry(os.path.join(tmp, silk[0]))
            m = gnc.layer_geometry(os.path.join(tmp, mask[0]))
            on = s.intersection(m).area
            near = s.intersection(m.buffer(PAD_CLR - 1e-4, 16)).area
            bad += near
            print(f'  {side}: silk on mask openings {on:.4f} mm2, silk within {PAD_CLR} mm of an opening {near:.4f} mm2')
    finally:
        shutil.rmtree(tmp)
    ok = bad < 1e-6
    print(f'{"PASS" if ok else "FAIL"} pads: silk within {PAD_CLR} mm of mask openings {bad:.4f} mm2')
    return 0 if ok else 1


def cmd_clip(pcbnew, path):
    """Trim footprint silk strokes back to PAD_CLR from every solder-mask opening of the same side (JLC legend rule).
    Lines, rectangles and unfilled polygons are cut into the free runs; arcs and circles into free arcs; filled polygons
    lose the keep-out area. Runs shorter than 0.2 mm go. Texts are not touched (a text near a pad is a FAIL for the user)."""
    b = pcbnew.LoadBoard(path)
    M, F = pcbnew.ToMM, pcbnew.FromMM
    STEP, MINRUN, ERR = 0.02, 0.2, F(0.005)
    sides = ((pcbnew.F_SilkS, pcbnew.F_Mask), (pcbnew.B_SilkS, pcbnew.B_Mask))
    keep = {}
    for silk, mask in sides:
        lst = []
        for fp in b.GetFootprints():
            for p in fp.Pads():
                if p.IsOnLayer(mask):
                    lst.append((p, p.GetSolderMaskExpansion(mask), p.GetBoundingBox()))
        keep[silk] = (mask, lst)

    def zones(silk, it):
        mask, lst = keep[silk]
        w = it.GetWidth() if not (it.GetShape() == pcbnew.SHAPE_T_POLY and it.IsSolidFill()) else 0
        bb = it.GetBoundingBox()
        reach = F(PAD_CLR + 0.05) + w
        bb.Inflate(reach + F(1.0))
        out = []
        for p, exp, pb in lst:
            if not bb.Intersects(pb):
                continue
            ps = pcbnew.SHAPE_POLY_SET()
            p.TransformShapeToPolygon(ps, mask, exp + F(PAD_CLR + 0.01) + w // 2, ERR, pcbnew.ERROR_OUTSIDE)
            out.append(ps)
        return out

    def bad(pt, zs):
        v = pcbnew.VECTOR2I(int(pt[0]), int(pt[1]))
        return any(z.Contains(v) for z in zs)

    def runs(pts, zs):
        """Free runs of consecutive sample points: list of (i0, i1)."""
        out, s = [], None
        for i, pt in enumerate(pts):
            if not bad(pt, zs):
                s = i if s is None else s
            elif s is not None:
                out.append((s, i - 1)); s = None
        if s is not None:
            out.append((s, len(pts) - 1))
        return out

    def seg_pts(a, c):
        n = max(2, int(M(int(((c[0] - a[0]) ** 2 + (c[1] - a[1]) ** 2) ** 0.5)) / STEP) + 1)
        return [(a[0] + (c[0] - a[0]) * k / (n - 1), a[1] + (c[1] - a[1]) * k / (n - 1)) for k in range(n)]

    def new_shape(fp, it, kind):
        s = pcbnew.PCB_SHAPE(fp); s.SetShape(kind); s.SetLayer(it.GetLayer()); s.SetWidth(it.GetWidth())
        return s

    def length(pts, i0, i1):
        return M(int(sum(((pts[k + 1][0] - pts[k][0]) ** 2 + (pts[k + 1][1] - pts[k][1]) ** 2) ** 0.5 for k in range(i0, i1))))

    n_cut, n_gone, n_new, n_poly = 0, 0, 0, 0
    for fp in b.GetFootprints():
        for it in list(fp.GraphicalItems()):
            if not isinstance(it, pcbnew.PCB_SHAPE) or it.GetLayer() not in keep:
                continue
            zs = zones(it.GetLayer(), it)
            if not zs:
                continue
            sh = it.GetShape()
            filled = sh == pcbnew.SHAPE_T_POLY and it.IsSolidFill()
            if filled:
                ps = it.GetPolyShape()
                hit = any(ps.Collide(z) if hasattr(ps, 'Collide') else True for z in zs)
                cut = pcbnew.SHAPE_POLY_SET(ps)
                for z in zs:
                    cut.BooleanSubtract(z)
                if abs(cut.Area() - ps.Area()) < 1e3:      # < 0.001 mm2: untouched
                    continue
                n_poly += 1
                if cut.OutlineCount() == 0:
                    fp.Remove(it); n_gone += 1
                else:
                    it.SetPolyShape(cut)
                continue
            if sh in (pcbnew.SHAPE_T_SEGMENT, pcbnew.SHAPE_T_RECT, pcbnew.SHAPE_T_POLY):
                if sh == pcbnew.SHAPE_T_SEGMENT:
                    edges = [((it.GetStart().x, it.GetStart().y), (it.GetEnd().x, it.GetEnd().y))]
                else:
                    c = [(v.x, v.y) for v in it.GetCorners()] if sh == pcbnew.SHAPE_T_RECT else \
                        [(it.GetPolyShape().COutline(0).CPoint(k).x, it.GetPolyShape().COutline(0).CPoint(k).y)
                         for k in range(it.GetPolyShape().COutline(0).PointCount())]
                    edges = [(c[k], c[(k + 1) % len(c)]) for k in range(len(c))]
                pieces, touched = [], False
                for a, c in edges:
                    pts = seg_pts(a, c)
                    rr = runs(pts, zs)
                    if rr != [(0, len(pts) - 1)]:
                        touched = True
                    pieces += [(pts[i0], pts[i1]) for i0, i1 in rr if length(pts, i0, i1) >= MINRUN]
                if not touched:
                    continue
                n_cut += 1
                fp.Remove(it)
                for a, c in pieces:
                    s = new_shape(fp, it, pcbnew.SHAPE_T_SEGMENT)
                    s.SetStart(pcbnew.VECTOR2I(int(a[0]), int(a[1]))); s.SetEnd(pcbnew.VECTOR2I(int(c[0]), int(c[1])))
                    fp.Add(s); n_new += 1
                if not pieces:
                    n_gone += 1
                continue
            if sh in (pcbnew.SHAPE_T_ARC, pcbnew.SHAPE_T_CIRCLE):
                import math
                cx, cy = it.GetCenter().x, it.GetCenter().y
                r = it.GetRadius()
                if sh == pcbnew.SHAPE_T_CIRCLE and M(r) <= 0.5:
                    # pin-1 / polarity dot: move it straight away from the nearest pad until it is clear (max 1.2 mm)
                    ring = lambda x, y: [(x + r * math.cos(k * math.pi / 8), y + r * math.sin(k * math.pi / 8)) for k in range(16)] + [(x, y)]
                    if not any(bad(q, zs) for q in ring(cx, cy)):
                        continue
                    near = min((pp for pp, _, _ in keep[it.GetLayer()][1]), key=lambda pp: (pp.GetPosition().x - cx) ** 2 + (pp.GetPosition().y - cy) ** 2)
                    dx, dy = cx - near.GetPosition().x, cy - near.GetPosition().y
                    dn = (dx * dx + dy * dy) ** 0.5 or 1.0
                    done = False
                    for k in range(1, 25):
                        nx, ny = cx + dx / dn * F(0.05 * k), cy + dy / dn * F(0.05 * k)
                        zz = zones(it.GetLayer(), it)
                        if not any(bad(q, zz) for q in ring(nx, ny)):
                            it.Move(pcbnew.VECTOR2I(int(nx - cx), int(ny - cy))); n_cut += 1; done = True
                            break
                    if not done:
                        fp.Remove(it); n_gone += 1
                    continue
                if sh == pcbnew.SHAPE_T_CIRCLE:
                    a0, sweep = 0.0, 360.0
                else:
                    st, md, en = it.GetStart(), it.GetArcMid(), it.GetEnd()
                    ang = lambda v: math.degrees(math.atan2(v.y - cy, v.x - cx))
                    a0 = ang(st)
                    ccw = (ang(en) - a0) % 360                 # sweep with increasing angle; the mid point picks the side
                    sweep = ccw if (ang(md) - a0) % 360 < ccw else -(360 - ccw)
                n = max(8, int(abs(sweep) * math.pi / 180 * M(r) / STEP))
                angs = [a0 + sweep * k / n for k in range(n + 1)]
                pts = [(cx + r * math.cos(math.radians(t)), cy + r * math.sin(math.radians(t))) for t in angs]
                rr = runs(pts, zs)
                if rr == [(0, len(pts) - 1)]:
                    continue
                if sh == pcbnew.SHAPE_T_CIRCLE and len(rr) > 1 and rr[0][0] == 0 and rr[-1][1] == len(pts) - 1:
                    first = rr.pop(0); last = rr.pop(); rr.append((last[0], first[1] + n))      # wrap round 0 deg
                    angs = angs + [a0 + sweep * (n + k) / n for k in range(1, n + 1)]
                n_cut += 1
                fp.Remove(it)
                kept = 0
                for i0, i1 in rr:
                    t0, t1 = angs[i0], angs[i1]
                    if abs(t1 - t0) * math.pi / 180 * M(r) < MINRUN:
                        continue
                    p = lambda t: pcbnew.VECTOR2I(int(cx + r * math.cos(math.radians(t))), int(cy + r * math.sin(math.radians(t))))
                    s = new_shape(fp, it, pcbnew.SHAPE_T_ARC)
                    s.SetArcGeometry(p(t0), p((t0 + t1) / 2), p(t1))
                    fp.Add(s); n_new += 1; kept += 1
                if not kept:
                    n_gone += 1
    d = os.path.dirname(os.path.abspath(path))
    pro = {os.path.join(d, f): open(os.path.join(d, f), 'rb').read() for f in os.listdir(d) if f.endswith('.kicad_pro')}
    pcbnew.SaveBoard(path, b)
    for p, data in pro.items():
        if open(p, 'rb').read() != data:
            open(p, 'wb').write(data)
    print(f'DONE clip: {n_cut} strokes cut into {n_new} pieces, {n_poly} filled polygons trimmed, {n_gone} items fully removed')
    return 0


def main(argv):
    if len(argv) != 3 or argv[1] not in ('check', 'apply', 'pads', 'clip'):
        raise SystemExit(__doc__)
    if argv[1] == 'pads':
        return cmd_pads(argv[2])
    import pcbnew
    if argv[1] == 'clip':
        return cmd_clip(pcbnew, argv[2])
    return cmd(pcbnew, argv[2], argv[1] == 'apply')


if __name__ == '__main__':
    sys.exit(main(sys.argv))
