"""Pixel-art silkscreen probe (run with the KiCad bundled Python, it needs pcbnew).

Usage: check_pixel_art.py <board.kicad_pcb> <art name> [<art name> ...]
tools/check-poe-candidate.mjs and tools/check-input-4d2a-pcb.mjs run this script and make
the pass/fail decisions. This script only measures. It prints one JSON line.

For each group "pixel-art <name>" (made by tools/pixel-art.py) it reports:
- the silk layers of the shapes,
- the shapes that are less than EDGE_MM inside the board outline,
- the obstacles that a shape (grown by CLEAR_MM) touches on the same board side:
  a pad (with its solder mask opening), a mask opening, a hole, a via that is not tented,
  a hole keepout rule area (H<n>_KEEPOUT) or a barrier rule area, a courtyard, the JLC order-number text,
  and any other visible silkscreen item (reference texts, logos, other pixel-art groups).
"""
import json
import re
import sys

import pcbnew

EDGE_MM = 0.5
CLEAR_MM = 0.2
PREFIX = 'pixel-art '

mm = pcbnew.ToMM
nm = pcbnew.FromMM


def rect_poly(box):
    p = pcbnew.SHAPE_POLY_SET()
    p.NewOutline()
    x0, y0, x1, y1 = box.GetLeft(), box.GetTop(), box.GetRight(), box.GetBottom()
    for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
        p.Append(x, y)
    return p


def area_of(a, b):
    """Area (mm^2) of the intersection of two SHAPE_POLY_SETs."""
    c = pcbnew.SHAPE_POLY_SET(a)
    c.BooleanIntersection(b)
    return c.Area() / 1e12


def grown(box, d_mm):
    b = pcbnew.BOX2I(box.GetPosition(), box.GetSize())
    b.Inflate(nm(d_mm))
    return b


def obstacles(board, side, skip=()):
    """Obstacles on one side ('F' or 'B'): list of (label, BOX2I or SHAPE_POLY_SET)."""
    cu = pcbnew.F_Cu if side == 'F' else pcbnew.B_Cu
    mask = pcbnew.F_Mask if side == 'F' else pcbnew.B_Mask
    silk = pcbnew.F_SilkS if side == 'F' else pcbnew.B_SilkS
    crt = pcbnew.F_CrtYd if side == 'F' else pcbnew.B_CrtYd
    out = []
    for fp in board.GetFootprints():
        ref = fp.GetReference()
        for pad in fp.Pads():
            has_hole = pad.GetDrillSize().x > 0
            if has_hole or pad.IsOnLayer(cu) or pad.IsOnLayer(mask):
                margin = max(0.0, mm(pad.GetSolderMaskExpansion(mask))) if pad.IsOnLayer(mask) else 0.0
                out.append((f'pad {ref}.{pad.GetNumber()}', grown(pad.GetBoundingBox(), margin)))
        for item in list(fp.GraphicalItems()) + [fp.Reference(), fp.Value()]:
            layer = item.GetLayer()
            if layer == crt:
                out.append((f'courtyard {ref}', item.GetBoundingBox()))
            elif layer == mask:
                out.append((f'mask opening {ref}', item.GetBoundingBox()))
            elif layer == silk and (not hasattr(item, 'IsVisible') or item.IsVisible()):
                out.append((f'silk {ref} {item.GetClass()}', item.GetBoundingBox()))
    for t in board.GetTracks():
        if t.GetClass() == 'PCB_VIA' and not t.IsTented(mask):
            out.append(('untented via', t.GetBoundingBox()))
    for z in board.Zones():
        name = z.GetZoneName()
        if z.GetIsRuleArea() and (re.fullmatch(r'H\d+_KEEPOUT', name) or 'BARRIER' in name.upper()):
            out.append((f'rule area {z.GetZoneName()}', pcbnew.SHAPE_POLY_SET(z.Outline())))
    for d in board.GetDrawings():
        if d.m_Uuid.AsString() in skip:
            continue
        layer = d.GetLayer()
        if layer == mask:
            out.append(('board mask opening', d.GetBoundingBox()))
        elif layer == silk:
            label = f'text "{d.GetText()}"' if d.GetClass() == 'PCB_TEXT' else 'board silk'
            g = d.GetParentGroup()
            if g is not None:
                label += f' (group "{g.GetName()}")'
            out.append((label, d.GetBoundingBox()))
    return out


def main(path, names):
    board = pcbnew.LoadBoard(path)
    outline = pcbnew.SHAPE_POLY_SET()
    board.GetBoardPolygonOutlines(outline, True)
    inner = pcbnew.SHAPE_POLY_SET(outline)
    inner.Deflate(nm(EDGE_MM), pcbnew.CORNER_STRATEGY_CHAMFER_ALL_CORNERS, nm(0.005))
    groups = {g.GetName(): g for g in board.Groups()}
    result = {}
    for name in names:
        g = groups.get(PREFIX + name)
        if g is None:
            result[name] = {'exists': False}
            continue
        shapes = [i for i in g.GetItems() if i.GetClass() == 'PCB_SHAPE']
        own = {s.m_Uuid.AsString() for s in shapes}
        names = {pcbnew.B_SilkS: 'B.SilkS', pcbnew.F_SilkS: 'F.SilkS'}
        ids = {s.GetLayer() for s in shapes}
        layers = sorted(names.get(i, board.GetLayerName(i)) for i in ids)
        side = 'B' if ids == {pcbnew.B_SilkS} else 'F'
        obs = obstacles(board, side, own)
        outside, hits = [], set()
        for s in shapes:
            box = s.GetBoundingBox()
            poly = rect_poly(box)
            rest = pcbnew.SHAPE_POLY_SET(poly)
            rest.BooleanSubtract(inner)
            if rest.Area() > 0:
                outside.append([round(mm(box.GetLeft()), 3), round(mm(box.GetTop()), 3)])
            gbox = grown(box, CLEAR_MM)
            for label, o in obs:
                if isinstance(o, pcbnew.BOX2I):
                    if gbox.Intersects(o):
                        hits.add(label)
                elif area_of(rect_poly(gbox), o) > 0:
                    hits.add(label)
        bb = g.GetBoundingBox()
        result[name] = {
            'exists': True, 'shapes': len(shapes), 'layers': layers,
            'bbox': [round(mm(v), 3) for v in (bb.GetLeft(), bb.GetTop(), bb.GetRight(), bb.GetBottom())],
            'outside': outside, 'hits': sorted(hits),
        }
    print(json.dumps({'edge_mm': EDGE_MM, 'clear_mm': CLEAR_MM, 'art': result}))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2:])
