#!/usr/bin/env python3
"""fp_keepouts: datasheet keep-out areas of a footprint as board rule areas (spec: registry/cad-assets/<C>/DATASHEET-KEEPOUTS.json).

  $PY tools/fp_keepouts.py apply  BOARD.kicad_pcb REF SPEC   replace the rule areas "<REF> KO <name>" with the spec areas
  $PY tools/fp_keepouts.py rip    BOARD.kicad_pcb REF        remove tracks / vias that touch those areas, then the
                                                             dangling track chains of the same nets (router input)
  $PY tools/fp_keepouts.py check  BOARD.kicad_pcb REF        copper (tracks, vias, zone fill, foreign pads) in the areas
  VENV/python tools/fp_keepouts.py gerber ZIP BOARD.kicad_pcb REF   copper area of the fab Gerbers in the areas
                                                             (gerbonara + shapely venv of tools/gerber_netcheck.py)

$PY = KiCad bundled Python (pcbnew). The areas follow the footprint pose (position, orientation; top side only)
when `apply` runs: run it again after the part moves. They are board rule areas, not footprint zones, so the shared
library footprint stays the JLC/EasyEDA bridge footprint (CLAUDE.md 1). apply / rip refill every zone, save the board and
put the .kicad_pro back (pcbnew rewrites it on save). Run them on the board in its project folder: the zone filler reads
the .kicad_dru next to it (a copy without it fills with the wrong clearances). One summary line: PASS|FAIL|DONE <counts>.
"""
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

PREFIX = '{ref} KO '


def areas_board(fp_pos_mm, fp_deg, spec):
    """Spec rectangles (footprint frame, mm) -> board polygons (mm), KiCad rotation (y down, positive = CCW on screen)."""
    th = math.radians(fp_deg)
    c, s = math.cos(th), math.sin(th)
    out = []
    for a in spec['areas_fp_mm']:
        x0, y0, x1, y1 = a['rect']
        pts = []
        for (x, y) in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
            pts.append((round(fp_pos_mm[0] + x * c + y * s, 6), round(fp_pos_mm[1] - x * s + y * c, 6)))
        out.append((a['name'], pts))
    return out


def save(pcbnew, b, path):
    """Refill every zone (the board's own project rules: run it on the board in its project folder) and save."""
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    d = os.path.dirname(os.path.abspath(path))
    pros = [os.path.join(d, f) for f in os.listdir(d) if f.endswith('.kicad_pro')]
    keep = {p: open(p, 'rb').read() for p in pros}
    pcbnew.SaveBoard(path, b)
    for p, data in keep.items():
        if open(p, 'rb').read() != data:
            open(p, 'wb').write(data)


def ko_zones(b, ref):
    pre = PREFIX.format(ref=ref)
    return [z for z in b.Zones() if z.GetIsRuleArea() and z.GetZoneName().startswith(pre)]


def zone_poly(pcbnew, z):
    sp = pcbnew.SHAPE_POLY_SET()
    sp.Append(z.Outline())
    return sp


def cmd_apply(pcbnew, path, ref, spec_path):
    spec = json.load(open(spec_path))
    b = pcbnew.LoadBoard(path)
    fp = b.FindFootprintByReference(ref)
    if fp is None or fp.IsFlipped():
        raise SystemExit(f'ERROR {ref}: missing or on the bottom side (spec areas are top-side)')
    old = ko_zones(b, ref)
    for z in old:
        b.Remove(z)
    pos = fp.GetPosition()
    deg = fp.GetOrientation().AsDegrees()
    rel = os.path.relpath(os.path.abspath(spec_path), os.path.dirname(os.path.abspath(__file__)) + '/..')
    for name, pts in areas_board((pcbnew.ToMM(pos.x), pcbnew.ToMM(pos.y)), deg, spec):
        z = pcbnew.ZONE(b)
        z.SetIsRuleArea(True)
        ls = pcbnew.LSET()
        for ln in spec['layers']:
            ls.AddLayer(b.GetLayerID(ln))
        z.SetLayerSet(ls)
        na = set(spec['not_allowed'])
        z.SetDoNotAllowTracks('tracks' in na)
        z.SetDoNotAllowVias('vias' in na)
        z.SetDoNotAllowZoneFills('pour' in na)
        z.SetDoNotAllowPads('pads' in na)
        z.SetDoNotAllowFootprints('footprints' in na)
        z.SetZoneName(PREFIX.format(ref=ref) + name)
        ol = z.Outline()
        ol.NewOutline()
        for (x, y) in pts:
            ol.Append(pcbnew.FromMM(x), pcbnew.FromMM(y))
        b.Add(z)
        print(f'  {z.GetZoneName()}: ' + ' '.join(f'({x:.3f},{y:.3f})' for x, y in pts))
    save(pcbnew, b, path)
    print(f'DONE apply {ref}: {len(spec["areas_fp_mm"])} areas ({len(old)} replaced), layers {",".join(spec["layers"])}, '
          f'not allowed {",".join(spec["not_allowed"])}; spec {rel}')


def touching(pcbnew, b, ref):
    """(item, area name) for every track / via whose copper on an area layer overlaps a KO area of REF."""
    hits = []
    for z in ko_zones(b, ref):
        zp = zone_poly(pcbnew, z)
        for t in b.GetTracks():
            for lid in z.GetLayerSet().Seq():
                if not t.IsOnLayer(lid):
                    continue
                if t.GetClass() == 'PCB_TRACK' and not z.GetDoNotAllowTracks():
                    continue
                if t.GetClass() == 'PCB_VIA' and not z.GetDoNotAllowVias():
                    continue
                sp = pcbnew.SHAPE_POLY_SET()
                t.TransformShapeToPolygon(sp, lid, 0, pcbnew.FromMM(0.001), pcbnew.ERROR_INSIDE)
                x = zp.CloneDropTriangulation()
                x.BooleanIntersection(sp)
                if x.Area() > 0:
                    hits.append((t, z.GetZoneName()))
                    break
    return hits


def describe(pcbnew, t):
    M = lambda v: round(pcbnew.ToMM(v), 3)
    if t.GetClass() == 'PCB_VIA':
        return f'via {t.GetNetname()} ({M(t.GetPosition().x)},{M(t.GetPosition().y)})'
    return (f'track {t.GetNetname()} {t.GetBoard().GetLayerName(t.GetLayer())} ({M(t.GetStart().x)},{M(t.GetStart().y)})->'
            f'({M(t.GetEnd().x)},{M(t.GetEnd().y)})')


def cmd_rip(pcbnew, path, ref):
    b = pcbnew.LoadBoard(path)
    hits = touching(pcbnew, b, ref)
    nets = sorted({t.GetNetname() for t, _ in hits})
    zone_nets = {z.GetNetname() for z in b.Zones() if not z.GetIsRuleArea()}  # their track ends anchor in the pour
    alive = list(b.GetTracks())  # one list of proxies: Tracks() fails after Remove() in the KiCad 10 bindings
    gone = set()

    def drop(t, why):
        k = t.m_Uuid.AsString()
        if k in gone:
            return False
        print(f'  {why} {describe(pcbnew, t)}')
        gone.add(k)
        b.Remove(t)
        return True

    for t, name in hits:
        drop(t, f'rip [{name}]')
    # dangling chains of the same nets (not zone nets): a track end that touches no pad, via or other track of its net
    pruned = 0
    while True:
        live = [t for t in alive if t.m_Uuid.AsString() not in gone]
        dang = [t for t in live if t.GetClass() == 'PCB_TRACK' and t.GetNetname() in nets and t.GetNetname() not in zone_nets
                and not all(anchored(pcbnew, b, live, t, e) for e in (t.GetStart(), t.GetEnd()))]
        # a via of such a net that joins copper on fewer than 2 layers and no pad is a stub end too (KiCad via_dangling)
        dang += [v for v in live if v.GetClass() == 'PCB_VIA' and v.GetNetname() in nets and v.GetNetname() not in zone_nets
                 and via_layers(pcbnew, b, live, v) < 2]
        if not dang:
            break
        for t in dang:
            pruned += drop(t, 'prune')
    save(pcbnew, b, path)
    print(f'DONE rip {ref}: {len(hits)} items in the areas, {pruned} dangling tracks, nets {",".join(nets) or "-"}')


def via_layers(pcbnew, b, live, v):
    """Copper layers on which a track end of the via's net or a pad of the net touches the via (a pad counts as 2)."""
    lays = set()
    me = v.m_Uuid.AsString()
    for o in live:
        if o.m_Uuid.AsString() == me or o.GetClass() != 'PCB_TRACK' or o.GetNetname() != v.GetNetname():
            continue
        r = v.GetWidth(o.GetLayer()) // 2
        if any((e - v.GetPosition()).EuclideanNorm() <= r for e in (o.GetStart(), o.GetEnd())):
            lays.add(o.GetLayer())
    for fp in b.GetFootprints():
        for p in fp.Pads():
            if p.GetNetname() == v.GetNetname() and p.HitTest(v.GetPosition()):
                return 2
    return len(lays)


def anchored(pcbnew, b, live, t, e):
    lay = t.GetLayer()
    me = t.m_Uuid.AsString()
    for o in live:
        if o.m_Uuid.AsString() == me or o.GetNetname() != t.GetNetname():
            continue
        if o.GetClass() == 'PCB_VIA':
            if o.IsOnLayer(lay) and (o.GetPosition() - e).EuclideanNorm() <= o.GetWidth(lay) // 2:
                return True
        elif o.GetLayer() == lay and (o.GetStart() == e or o.GetEnd() == e or o.HitTest(e, 0)):
            return True
    for fp in b.GetFootprints():
        for p in fp.Pads():
            if p.GetNetname() == t.GetNetname() and p.IsOnLayer(lay) and p.HitTest(e):
                return True
    return False


def cmd_check(pcbnew, path, ref):
    b = pcbnew.LoadBoard(path)
    zs = ko_zones(b, ref)
    n = 0
    for t, name in touching(pcbnew, b, ref):
        print(f'  {name}: {describe(pcbnew, t)}')
        n += 1
    fill = 0.0
    for z in zs:
        if not z.GetDoNotAllowZoneFills():
            continue
        zp = zone_poly(pcbnew, z)
        for cz in b.Zones():
            if cz.GetIsRuleArea():
                continue
            for lid in z.GetLayerSet().Seq():
                if not cz.IsOnLayer(lid) or not cz.HasFilledPolysForLayer(lid):
                    continue
                x = zp.CloneDropTriangulation()
                x.BooleanIntersection(cz.GetFilledPolysList(lid))
                if x.Area() > 0:
                    a = x.Area() / 1e12
                    fill += a
                    print(f'  {z.GetZoneName()}: zone fill {cz.GetNetname()} {b.GetLayerName(lid)} {a:.4f} mm2')
    pads = 0
    for z in zs:
        if not z.GetDoNotAllowPads():
            continue
        zp = zone_poly(pcbnew, z)
        for fp in b.GetFootprints():
            for p in fp.Pads():
                for lid in z.GetLayerSet().Seq():
                    if not p.IsOnLayer(lid):
                        continue
                    sp = pcbnew.SHAPE_POLY_SET()
                    p.TransformShapeToPolygon(sp, lid, 0, pcbnew.FromMM(0.001), pcbnew.ERROR_INSIDE)
                    x = zp.CloneDropTriangulation()
                    x.BooleanIntersection(sp)
                    if x.Area() > 1e6:  # > 1e-6 mm2: an own pad edge that only touches the area is not inside it
                        pads += 1
                        print(f'  {z.GetZoneName()}: pad {fp.GetReference()}.{p.GetNumber()} {x.Area() / 1e12:.4f} mm2')
    ok = len(zs) > 0 and n == 0 and fill == 0 and pads == 0
    print(f'{"PASS" if ok else "FAIL"} check {ref}: areas {len(zs)}, tracks+vias {n}, zone fill {fill:.4f} mm2, pads {pads}')
    return 0 if ok else 1


def cmd_gerber(zip_path, pcb, ref):
    """Copper of the fab Gerbers (each layer of the KO areas) inside the areas; pcbnew is read in a child process."""
    import zipfile
    from shapely.geometry import Polygon
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import gerber_netcheck as gnc
    kpy = os.environ.get('KICAD_PYTHON', '/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3')
    code = ('import json,sys,pcbnew\nb=pcbnew.LoadBoard(sys.argv[1])\nout=[]\nfor z in b.Zones():\n'
            '  if z.GetIsRuleArea() and z.GetZoneName().startswith(sys.argv[2]):\n'
            '    o=z.Outline().Outline(0)\n'
            '    out.append([z.GetZoneName(),[b.GetLayerName(l) for l in z.GetLayerSet().Seq()],'
            '[[pcbnew.ToMM(o.CPoint(i).x),pcbnew.ToMM(o.CPoint(i).y)] for i in range(o.PointCount())],'
            '[bool(z.GetDoNotAllowTracks()),bool(z.GetDoNotAllowZoneFills()),bool(z.GetDoNotAllowVias())]])\n'
            'print(json.dumps(out))\n')
    r = subprocess.run([kpy, '-c', code, pcb, PREFIX.format(ref=ref)], capture_output=True, text=True, check=True)
    areas = json.loads(r.stdout.strip().splitlines()[-1])
    tmp = tempfile.mkdtemp()
    try:
        zipfile.ZipFile(zip_path).extractall(tmp)
        total = 0.0
        from shapely.geometry import Point
        drl = [g for g in os.listdir(tmp) if g.endswith('-PTH.drl')]
        holes = gnc.excellon_holes(os.path.join(tmp, drl[0])) if len(drl) == 1 else None
        for name, layers, pts, (no_tr, no_po, no_vi) in areas:
            poly = Polygon([(x, -y) for x, y in pts])  # Gerber y up
            if no_vi:  # a round plated hole (via) whose drill touches the area; G85 slots are pad holes
                if holes is None:
                    raise SystemExit(f'ERROR no unique PTH drill file in {zip_path}: {drl}')
                hit = [h for h in holes if (h[0], h[1]) == (h[2], h[3]) and Point(h[0], h[1]).buffer(h[4] / 2, 16).intersects(poly)]
                total += len(hit)
                print(f'  {name}: round plated holes touching the area {len(hit)} {[(h[0], h[1], h[4]) for h in hit]}')
            if not (no_tr and no_po):
                continue  # pads / pour / tracks are allowed in this area: only the via rule applies
            for ln in layers:
                f = [g for g in os.listdir(tmp) if g.endswith('-' + ln.replace('.', '_') + '.gbr')]
                if len(f) != 1:
                    raise SystemExit(f'ERROR no unique Gerber for {ln} in {zip_path}: {f}')
                cu = gnc.layer_geometry(os.path.join(tmp, f[0]))
                a = cu.intersection(poly).area
                total += a
                print(f'  {name} {ln} ({f[0]}): copper {a:.6f} mm2 of {poly.area:.3f} mm2')
    finally:
        shutil.rmtree(tmp)
    ok = bool(areas) and total < 1e-6
    print(f'{"PASS" if ok else "FAIL"} gerber {ref}: areas {len(areas)}, copper mm2 + via holes in the areas {total:.6f}')
    return 0 if ok else 1


def main(argv):
    if len(argv) < 4:
        raise SystemExit(__doc__)
    cmd = argv[1]
    if cmd == 'gerber':
        return cmd_gerber(argv[2], argv[3], argv[4])
    import pcbnew
    if cmd == 'apply':
        return cmd_apply(pcbnew, argv[2], argv[3], argv[4]) or 0
    if cmd == 'rip':
        return cmd_rip(pcbnew, argv[2], argv[3]) or 0
    if cmd == 'check':
        return cmd_check(pcbnew, argv[2], argv[3])
    raise SystemExit(__doc__)


if __name__ == '__main__':
    sys.exit(main(sys.argv))
