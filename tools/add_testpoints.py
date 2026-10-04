#!/usr/bin/env python3
"""Add bring-up test points to a board: schematic symbols and placed footprints, linked for schematic parity.

  $PY tools/add_testpoints.py hardware-design/boards/<BOARD> [--dry-run]

Reads <board>/testpoints.json:
  {"about": "...", "project": "cad/X/X", "sheet_area": [x0, y0, x1, y1],
   "points": [{"ref": "TP12", "net": "VBUS", "kind": "smd" | "tht", "power": "power:VBUS" | null,
               "near": "J1.A4" | [x, y], "max_mm": 8, "label": "VBUS"}, ...]}
- label: a 0.8 mm F.Silkscreen text beside the pad. The reference stays on F.Fab, hidden (D-040: no reference on silk).
- kind smd: TestPoint:TestPoint_Pad_D1.5mm. kind tht: TestPoint:TestPoint_THTPad_D2.5mm_Drill1.2mm (a probe clip
  or a ground hook fits; on a plane net it connects through the inner plane, so it needs no route).
- power: a global net gets the power symbol of that name, its Value set to the net (as TP1-TP4 of BASE-PWR).
  null: a root-sheet net ("/NAME" on the board) gets a short wire and a local label (as TP10).
- The symbols go in a column grid inside sheet_area (an empty area of the root sheet; give it, the tool does not
  search). in_bom no, the Description is the one of the existing test points: a bare copper pad, not assembled.
- smd: first choice is a point on a F.Cu track of its own net (no route needed; not over a via or a pad).
- Else each footprint goes to the free grid point (0.25 mm) nearest to "near": courtyard box at least 0.5 mm from other
  courtyards (1.0 mm from U and J parts, D-040), clear of silk art and text (both sides for tht), its pad at least the class clearance + 0.1 mm from copper of other
  nets on its layers (all copper layers for tht), not in a rule area, 1.0 mm inside the board outline and away
  from each cut-out (the real outline polygon, not its bounding box).
  A point with no free place within max_mm stops the tool (nothing is written).
The routes come after this tool (tools/fastroute_job.py, existing copper kept). Then the gate.
"""
import argparse
import json
import math
import os
import re
import sys
import uuid

import pcbnew

MM = pcbnew.FromMM
FP_LIB = '/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints/TestPoint.pretty'
FP = {'smd': 'TestPoint_Pad_D1.5mm', 'tht': 'TestPoint_THTPad_D2.5mm_Drill1.2mm'}
DESC = 'Bring-up test point, bare copper pad, not assembled'


def u():
    return str(uuid.uuid4())


def sym_block(ref, value, fpname, x, y, power, net):
    font = '(effects\n\t\t\t\t(font (size 1.27 1.27))\n\t\t\t\t(hide yes)\n\t\t\t)'

    def prop(name, val, dx=0.0, dy=0.0, hide=True, justify=None):
        eff = '(effects\n\t\t\t\t(font (size 1.27 1.27))' + (f'\n\t\t\t\t(justify {justify})' if justify else '') + \
              ('\n\t\t\t\t(hide yes)' if hide else '') + '\n\t\t\t)'
        return f'\t\t(property "{name}" "{val}"\n\t\t\t(at {x + dx:.2f} {y + dy:.2f} 0)\n\t\t\t{eff}\n\t\t)'
    tp_uuid = u()
    out = [f'\t(symbol\n\t\t(lib_id "AUTO:TP")\n\t\t(at {x:.2f} {y:.2f} 0)\n\t\t(unit 1)\n\t\t(exclude_from_sim no)\n'
           f'\t\t(in_bom no)\n\t\t(on_board yes)\n\t\t(dnp no)\n\t\t(fields_autoplaced yes)\n\t\t(uuid "{tp_uuid}")',
           prop('Reference', ref, 0, -5.934, False, 'bottom'), prop('Value', value, 0, 1.27, True, 'top'),
           prop('Footprint', f'TestPoint:{fpname}'), prop('Datasheet', ''), prop('Description', DESC),
           f'\t\t(pin "1" (uuid "{u()}"))\n\t)']
    if power:
        out.append(f'\t(symbol\n\t\t(lib_id "{power}")\n\t\t(at {x:.2f} {y:.2f} 180)\n\t\t(unit 1)\n\t\t(exclude_from_sim no)\n'
                   f'\t\t(in_bom yes)\n\t\t(on_board yes)\n\t\t(dnp no)\n\t\t(uuid "{u()}")\n'
                   + prop('Reference', '#PWR_' + ref) + '\n' + prop('Value', net, 0, 3.81) + '\n'
                   + prop('Footprint', '') + '\n' + prop('Datasheet', '') + '\n' + prop('Description', '') +
                   f'\n\t\t(pin "1" (uuid "{u()}"))\n\t)')
    else:
        label = net.lstrip('/')
        out.append(f'\t(wire\n\t\t(pts\n\t\t\t(xy {x:.2f} {y:.2f}) (xy {x:.2f} {y + 2.54:.2f})\n\t\t)\n'
                   f'\t\t(stroke\n\t\t\t(width 0)\n\t\t\t(type default)\n\t\t)\n\t\t(uuid "{u()}")\n\t)')
        out.append(f'\t(label "{label}"\n\t\t(at {x:.2f} {y + 2.54:.2f} 0)\n\t\t(effects\n\t\t\t(font (size 1.27 1.27))\n'
                   f'\t\t\t(justify left bottom)\n\t\t)\n\t\t(uuid "{u()}")\n\t)')
    return '\n'.join(out), tp_uuid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('board_dir')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    spec = json.load(open(os.path.join(a.board_dir, 'testpoints.json')))
    stem = os.path.join(a.board_dir, spec['project'])
    sch_path, pcb_path = stem + '.kicad_sch', stem + '.kicad_pcb'
    b = pcbnew.LoadBoard(pcb_path)
    have = {f.GetReference() for f in b.GetFootprints()}
    sch = open(sch_path).read()
    for p in spec['points']:
        if p['ref'] in have or f'"Reference" "{p["ref"]}"' in sch:
            sys.exit(f'add_testpoints: {p["ref"]} is already on the board or in the schematic')
        if b.FindNet(p['net']) is None:
            sys.exit(f'add_testpoints: no net {p["net"]} on the board')
        if p.get('power') and f'(symbol "{p["power"]}"' not in sch:
            sys.exit(f'add_testpoints: the schematic has no embedded symbol {p["power"]}')

    edge = b.GetBoardEdgesBoundingBox()
    outline = pcbnew.SHAPE_POLY_SET()
    b.GetBoardPolygonOutlines(outline, False)  # with the holes and cut-outs (BASE-PWR has a window)
    keep = [z for z in b.Zones() if z.GetIsRuleArea()] + [z for f in b.GetFootprints() for z in f.Zones() if z.GetIsRuleArea()]
    court = []
    for f in b.GetFootprints():
        c = f.GetCourtyard(pcbnew.F_CrtYd).BBox()
        if c.GetWidth() == 0:
            c = f.GetBoundingBox(False, False)
        court.append((c, f.GetReference()))
    copper = [t for t in b.GetTracks()] + [p for f in b.GetFootprints() for p in f.Pads()]
    silk_layers = {pcbnew.F_SilkS: 'F', pcbnew.B_SilkS: 'B'}
    silk = [d for d in b.GetDrawings() if d.GetLayer() in silk_layers]  # pixel art, labels, frames
    fp_silk = [g for f in b.GetFootprints() for g in f.GraphicalItems() if g.GetLayer() == pcbnew.F_SilkS]
    layers_all = [l for l in range(pcbnew.PCB_LAYER_ID_COUNT) if pcbnew.IsCopperLayer(l) and b.IsLayerEnabled(l)]

    def pad_at(near):
        if isinstance(near, list):
            return pcbnew.VECTOR2I(MM(near[0]), MM(near[1]))
        ref, num = near.split('.')
        return next(q for q in b.FindFootprintByReference(ref).Pads() if q.GetNumber() == num).GetPosition()

    placed, blocks, labels = [], [], []
    cols = 8
    x0, y0, x1, y1 = spec['sheet_area']
    for k, p in enumerate(spec['points']):
        fp = pcbnew.FootprintLoad(FP_LIB, FP[p['kind']])
        fp.SetFPID(pcbnew.LIB_ID('TestPoint', FP[p['kind']]))
        fp.SetReference(p['ref'])
        for fld in fp.GetFields():
            if fld.GetName() == 'Description':
                fld.SetText(DESC)  # schematic parity compares this field
        fp.SetValue(p['net'].lstrip('/'))
        net = b.FindNet(p['net'])
        pad = list(fp.Pads())[0]
        pad.SetNet(net)
        if p['kind'] == 'tht':
            pad.SetLocalZoneConnection(pcbnew.ZONE_CONNECTION_FULL)  # a test pad is not soldered: solid to the planes
        lay = layers_all if p['kind'] == 'tht' else [pcbnew.F_Cu]
        target = pad_at(p['near'])
        cyd = fp.GetCourtyard(pcbnew.F_CrtYd).BBox()
        cyd = cyd if cyd.GetWidth() else fp.GetBoundingBox(False, False)
        hw, hh = cyd.GetWidth() // 2, cyd.GetHeight() // 2
        rad = pad.GetSizeX() // 2
        clr = max(net.GetNetClass().GetClearance() if hasattr(net.GetNetClass(), 'GetClearance') else MM(0.2), MM(0.2)) + MM(0.1)

        def ok(cx, cy):
            if cx - hw < edge.GetLeft() + MM(1) or cx + hw > edge.GetRight() - MM(1) or \
                    cy - hh < edge.GetTop() + MM(1) or cy + hh > edge.GetBottom() - MM(1):
                return False
            for c, ref in court:
                g = MM(1.0) if ref[0] in 'UJ' else MM(0.5)
                if cx - hw - g < c.GetRight() and cx + hw + g > c.GetLeft() and cy - hh - g < c.GetBottom() and cy + hh + g > c.GetTop():
                    return False
            pt = pcbnew.VECTOR2I(int(cx), int(cy))
            ring = max(hw, hh) + MM(1)
            if not all(outline.Contains(pcbnew.VECTOR2I(int(cx + ring * math.cos(t * math.pi / 8)), int(cy + ring * math.sin(t * math.pi / 8))))
                       for t in range(16)) or not outline.Contains(pt):
                return False
            sides = ('F', 'B') if p['kind'] == 'tht' else ('F',)
            for d in silk:
                bb = d.GetBoundingBox()
                if silk_layers[d.GetLayer()] in sides and bb.GetLeft() - rad - MM(0.3) < cx < bb.GetRight() + rad + MM(0.3) and \
                        bb.GetTop() - rad - MM(0.3) < cy < bb.GetBottom() + rad + MM(0.3) and d.GetClass() != 'PCB_SHAPE' or \
                        (d.GetClass() == 'PCB_SHAPE' and silk_layers[d.GetLayer()] in sides and d.GetEffectiveShape().Collide(pt, rad + MM(0.3))):
                    return False
            for z in keep:
                if any(z.IsOnLayer(l) for l in lay) and (z.Outline().Contains(pt) or z.Outline().Collide(pt, rad)):
                    return False
            for item in copper:
                if item.GetNetCode() == net.GetNetCode():
                    continue
                for l in lay:
                    if item.IsOnLayer(l) and item.GetEffectiveShape(l).Collide(pt, rad + clr):
                        return False
            return True
        step, best = MM(0.25), None
        n = int(MM(p.get('max_mm', 8)) // step)
        if p['kind'] == 'smd':
            # First choice: the pad sits on a F.Cu track of its own net (a test point on the trace): no new route.
            # The pad may not cover a via (via in an SMD pad) or a pad of a part.
            vias = [t for t in copper if t.GetClass() == 'PCB_VIA']
            pads = [q for q in copper if q.GetClass() == 'PAD']
            for t in copper:
                if t.GetClass() != 'PCB_TRACK' or t.GetNetCode() != net.GetNetCode() or t.GetLayer() != pcbnew.F_Cu:
                    continue
                if t.GetWidth() > 2 * rad:
                    continue
                s0, e0 = t.GetStart(), t.GetEnd()
                steps = max(1, int(t.GetLength() // step))
                for i in range(steps + 1):
                    cx = s0.x + (e0.x - s0.x) * i / steps
                    cy = s0.y + (e0.y - s0.y) * i / steps
                    d = math.hypot(cx - target.x, cy - target.y) / step
                    if d > n or (best and d >= best[0]):
                        continue
                    pt = pcbnew.VECTOR2I(int(cx), int(cy))
                    if any(v.GetEffectiveShape(pcbnew.F_Cu).Collide(pt, rad) for v in vias):
                        continue
                    if any(q.IsOnLayer(pcbnew.F_Cu) and q.GetEffectiveShape(pcbnew.F_Cu).Collide(pt, rad + MM(0.2)) for q in pads):
                        continue
                    if ok(cx, cy):
                        best = (d, cx, cy)
            if best:
                p['_on_track'] = True
        for ix in range(-n, n + 1) if not best else []:
            for iy in range(-n, n + 1):
                d = math.hypot(ix, iy)
                if d > n or (best and d >= best[0]):
                    continue
                cx, cy = target.x + ix * step, target.y + iy * step
                if ok(cx, cy):
                    best = (d, cx, cy)
        if not best:
            sys.exit(f'add_testpoints: no free place for {p["ref"]} ({p["net"]}) within {p.get("max_mm", 8)} mm of {p["near"]}')
        fp.SetPosition(pcbnew.VECTOR2I(int(best[1]), int(best[2])))
        g = 2.54  # schematic grid: endpoint_off_grid in ERC otherwise
        sx, sy = round((x0 + (k % cols) * 20.32) / g) * g, round((y0 + (k // cols) * 15.24) / g) * g
        if sy > y1:
            sys.exit('add_testpoints: sheet_area is too small')
        block, sym_uuid = sym_block(p['ref'], p['net'].lstrip('/'), FP[p['kind']], sx, sy, p.get('power'), p['net'])
        fp.SetPath(pcbnew.KIID_PATH('/' + sym_uuid))
        fp.SetExcludedFromBOM(True)
        fp.SetExcludedFromPosFiles(True)  # not assembled: not in the CPL either
        ref = fp.Reference()
        ref.SetLayer(pcbnew.F_Fab)
        ref.SetVisible(False)
        val = fp.Value()
        val.SetLayer(pcbnew.F_Fab)
        blocks.append(block)
        placed.append(fp)
        texts = p.get('label') or []
        texts = [texts] if isinstance(texts, str) else texts  # a list: the first text that fits (a short form last)
        rect = lambda bb: pcbnew.SHAPE_RECT(pcbnew.VECTOR2I(bb.GetX(), bb.GetY()), int(bb.GetWidth()), int(bb.GetHeight()))
        done_label = False
        for text in texts:
            # A 0.8 mm silk label beside the pad (as the existing test points): the first place that is clear of pads,
            # vias, silk text, footprint silk and board silk shapes, other new labels, and 0.35 mm inside the outline.
            pos = fp.GetPosition()
            for k2 in (1.0, 1.6, 2.4):
                for ux, uy in ((0, -1), (0, 1), (-1, 0), (1, 0), (-1, -1), (1, -1), (-1, 1), (1, 1)):
                    t = pcbnew.PCB_TEXT(b)
                    t.SetText(text)
                    t.SetLayer(pcbnew.F_SilkS)
                    t.SetTextSize(pcbnew.VECTOR2I(MM(0.8), MM(0.8)))
                    t.SetTextThickness(MM(0.15))
                    t.SetPosition(pcbnew.VECTOR2I(pos.x + int(ux * (rad + MM(1.2 + k2))), pos.y + int(uy * (rad + MM(k2)))))
                    tb = t.GetBoundingBox()
                    tb.Inflate(MM(0.15))
                    clash = any(q.IsOnLayer(pcbnew.F_Cu) and q.GetBoundingBox().Intersects(tb) for q in copper if q.GetClass() in ('PAD', 'PCB_VIA')) \
                        or any(d.GetClass() == 'PCB_TEXT' and d.GetBoundingBox().Intersects(tb) for d in silk) \
                        or any(g.GetBoundingBox().Intersects(tb) and g.GetEffectiveShape().Collide(rect(tb), 0) for g in fp_silk) \
                        or any(d.GetClass() == 'PCB_SHAPE' and d.GetLayer() == pcbnew.F_SilkS and d.GetBoundingBox().Intersects(tb)
                               and d.GetEffectiveShape().Collide(rect(tb), 0) for d in silk) \
                        or any(lb.GetBoundingBox().Intersects(tb) for lb in labels) \
                        or not all(outline.Contains(pcbnew.VECTOR2I(x, y)) for x in (tb.GetLeft() - MM(0.35), tb.GetRight() + MM(0.35))
                                   for y in (tb.GetTop() - MM(0.35), tb.GetBottom() + MM(0.35)))  # silk_edge_clearance
                    if not clash:
                        labels.append(t)
                        done_label = True
                        break
                if done_label:
                    break
            if done_label:
                break
        if texts and not done_label:
            print(f'{p["ref"]}: no clear place for a silk label {texts}')
        c = fp.GetCourtyard(pcbnew.F_CrtYd).BBox()
        court.append((c if c.GetWidth() else fp.GetBoundingBox(False, False), p['ref']))
        copper.append(pad)
        print(f'{p["ref"]} {p["net"]}: ({best[1] / 1e6:.2f}, {best[2] / 1e6:.2f}), {best[0] * 0.25:.2f} mm from {p["near"]}'
              + (', on a F.Cu track of its net' if p.get('_on_track') else ', needs a route')
              + (f', label {labels[-1].GetText()}' if done_label else ''))
    if a.dry_run:
        print('dry run: nothing written')
        return
    i = sch.index('\n\t(sheet_instances')
    sch = sch[:i] + '\n' + '\n'.join(blocks) + sch[i:]
    open(sch_path, 'w').write(sch)
    for fp in placed:
        b.Add(fp)
    for t in labels:
        b.Add(t)
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    pcbnew.SaveBoard(pcb_path, b)
    print(f'add_testpoints: {len(placed)} test points added to {sch_path} and {pcb_path}')


if __name__ == '__main__':
    main()
