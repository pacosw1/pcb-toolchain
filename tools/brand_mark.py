#!/usr/bin/env python3
"""Put the brand block on the bottom silkscreen of a board: the PITSA logo and "<NAME> rev <REV>".

  $PY tools/brand_mark.py BOARD.kicad_pcb --name BASE-PWR --rev A [--logo-mm 16] [--near X Y] [--dry-run]

User request 2026-10-04: each board shows its name, its revision and the PITSA logo. All parts are on the top side,
so the block goes on B.SilkS (mirrored, so it reads correctly from the bottom).
- Logo: hardware-design/boards/_art/pitsa-logo.png (see its .source.json). The dark pixels become filled silk
  rectangles: the image is resampled to a 0.1 mm pixel grid and each run of a row is one rectangle; equal runs of
  adjacent rows are joined. The smallest logo feature at 16 mm wide is about 0.3 mm (JLC silk minimum 0.153 mm).
- Text: "<NAME> rev <REV>", 1.2 mm high, 0.18 mm stroke, under the logo.
- Place: the block box (+ 0.5 mm) must be 1 mm inside the board outline (holes and cut-outs included), clear of
  each hole (vias, through-hole pads, NPTH) by 0.3 mm, of B.Cu pads, of rule areas on B.Cu, and of all B.SilkS
  items (board and footprint). The free place nearest to --near (default: the board centre) on a 0.5 mm grid.
- The shapes go in one PCB_GROUP "brand <NAME>". A rerun removes the old group first.
Prints the place. Exit 1 when no place fits (then try a smaller --logo-mm).
"""
import argparse
import math
import os
import sys

import pcbnew
from PIL import Image

MM = pcbnew.FromMM
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGO = os.path.join(ROOT, 'hardware-design', 'boards', '_art', 'pitsa-logo.png')
PIX = 0.1  # mm
SILK_W = 0.16  # mm, JLC silkscreen minimum line 0.153 mm


def logo_rects(width_mm):
    """Rectangles (x0, y0, x1, y1) in mm, origin at the logo top left, for the dark pixels of the logo."""
    im = Image.open(LOGO).convert('RGBA')
    bg = Image.new('RGBA', im.size, (255, 255, 255, 255))
    im = Image.alpha_composite(bg, im).convert('L')
    bbox = im.point(lambda v: 255 if v < 128 else 0).getbbox()
    im = im.crop(bbox)
    cols = max(1, int(round(width_mm / PIX)))
    rows = max(1, int(round(cols * im.size[1] / im.size[0])))
    im = im.resize((cols, rows), Image.LANCZOS)
    px = im.load()
    runs = []
    for y in range(rows):
        x = 0
        row = []
        while x < cols:
            if px[x, y] < 128:
                x0 = x
                while x < cols and px[x, y] < 128:
                    x += 1
                row.append((x0, x))
            else:
                x += 1
        runs.append(row)
    # join equal runs of adjacent rows into taller rectangles
    rects, open_ = [], {}
    for y, row in enumerate(runs + [[]]):
        cur = set(row)
        for key in list(open_):
            if key not in cur:
                y0 = open_.pop(key)
                rects.append((key[0] * PIX, y0 * PIX, key[1] * PIX, y * PIX))
        for key in row:
            open_.setdefault(key, y)
    return rects, cols * PIX, rows * PIX


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('board')
    ap.add_argument('--name', required=True)
    ap.add_argument('--rev', required=True)
    ap.add_argument('--logo-mm', type=float, default=16.0)
    ap.add_argument('--near', type=float, nargs=2)
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    stackup_before = (stackup_block(open(a.board).read()) or (None,))[0]
    b = pcbnew.LoadBoard(a.board)
    gname = f'brand {a.name}'
    for g in list(b.Groups()):
        if g.GetName() == gname:
            for it in list(g.GetItems()):
                b.Delete(it)
            b.Delete(g)

    rects, lw, lh = logo_rects(a.logo_mm)
    text = f'{a.name} rev {a.rev}'
    th, tt = 1.2, 0.18
    t = pcbnew.PCB_TEXT(b)
    t.SetText(text)
    t.SetLayer(pcbnew.B_SilkS)
    t.SetMirrored(True)
    t.SetTextSize(pcbnew.VECTOR2I(MM(th), MM(th)))
    t.SetTextThickness(MM(tt))
    tw = pcbnew.ToMM(t.GetBoundingBox().GetWidth())
    gap = 0.6
    bw, bh = max(lw, tw), lh + gap + th

    outline = pcbnew.SHAPE_POLY_SET()
    b.GetBoardPolygonOutlines(outline, False)
    holes = [(t2.GetPosition(), t2.GetDrillValue() // 2) for t2 in b.GetTracks() if t2.GetClass() == 'PCB_VIA']
    pads_b = []
    for f in b.GetFootprints():
        for p in f.Pads():
            if p.GetDrillSize().x:
                holes.append((p.GetPosition(), max(p.GetDrillSize().x, p.GetDrillSize().y) // 2))
            if p.IsOnLayer(pcbnew.B_Cu) or p.IsOnLayer(pcbnew.B_Mask):
                pads_b.append(p.GetBoundingBox())
    keep = [z.GetBoundingBox() for z in b.Zones() if z.GetIsRuleArea() and z.IsOnLayer(pcbnew.B_Cu)]
    silk = [d.GetBoundingBox() for d in b.GetDrawings() if d.GetLayer() == pcbnew.B_SilkS]
    silk += [g.GetBoundingBox() for f in b.GetFootprints() for g in list(f.GraphicalItems()) + [f.Reference(), f.Value()]
             if g.GetLayer() == pcbnew.B_SilkS and (g.GetClass() != 'PCB_FIELD' or g.IsVisible())]

    def free(cx, cy):
        x0, y0, x1, y1 = cx - bw / 2 - 0.5, cy - bh / 2 - 0.5, cx + bw / 2 + 0.5, cy + bh / 2 + 0.5
        for k in range(0, 21):  # the box edge, 1 mm inside the outline
            for (px, py) in ((x0 + (x1 - x0) * k / 20, y0 - 1), (x0 + (x1 - x0) * k / 20, y1 + 1),
                             (x0 - 1, y0 + (y1 - y0) * k / 20), (x1 + 1, y0 + (y1 - y0) * k / 20)):
                if not outline.Contains(pcbnew.VECTOR2I(MM(px), MM(py))):
                    return False
        box = pcbnew.BOX2I(pcbnew.VECTOR2I(MM(x0), MM(y0)), pcbnew.VECTOR2L(MM(x1 - x0), MM(y1 - y0)))
        for pos, r in holes:
            if box.GetLeft() - r - MM(0.3) < pos.x < box.GetRight() + r + MM(0.3) and \
                    box.GetTop() - r - MM(0.3) < pos.y < box.GetBottom() + r + MM(0.3):
                return False
        return not any(box.Intersects(o) for o in pads_b + keep + silk)

    bb = b.GetBoardEdgesBoundingBox()
    nx, ny = (a.near if a.near else (pcbnew.ToMM(bb.GetCenter().x), pcbnew.ToMM(bb.GetCenter().y)))
    best = None
    for gx in range(int(pcbnew.ToMM(bb.GetLeft())), int(pcbnew.ToMM(bb.GetRight())) + 1):
        for gy2 in range(int(pcbnew.ToMM(bb.GetTop())) * 2, int(pcbnew.ToMM(bb.GetBottom())) * 2 + 1):
            for cx in (gx, gx + 0.5):
                cy = gy2 / 2
                d = math.hypot(cx - nx, cy - ny)
                if (best is None or d < best[0]) and free(cx, cy):
                    best = (d, cx, cy)
    if not best:
        sys.exit(f'brand_mark: no free place on B.SilkS for a {bw:.1f} x {bh:.1f} mm block (try --logo-mm smaller)')
    _, cx, cy = best
    print(f'brand_mark: {a.name}: block {bw:.1f} x {bh:.1f} mm at ({cx:.1f}, {cy:.1f}) on B.SilkS, '
          f'{len(rects)} logo rectangles, text "{text}"')
    if a.dry_run:
        return
    g = pcbnew.PCB_GROUP(b)
    g.SetName(gname)
    b.Add(g)
    lx0, ly0 = cx - lw / 2, cy - bh / 2
    for (x0, y0, x1, y1) in rects:
        # mirror in x about the block centre: the logo reads correctly from the bottom side
        r = pcbnew.PCB_SHAPE(b)
        r.SetShape(pcbnew.SHAPE_T_RECT)
        r.SetLayer(pcbnew.B_SilkS)
        r.SetFilled(True)
        # A SILK_W stroke inset by SILK_W / 2 (as tools/pixel-art.py): the outer edge is the pixel edge, and each line
        # meets the JLC silk minimum (0.153 mm). A run thinner than SILK_W becomes a SILK_W line.
        r.SetWidth(MM(SILK_W))
        xa, xb = cx + (cx - (lx0 + x1)), cx + (cx - (lx0 + x0))
        ya, yb = ly0 + y0, ly0 + y1
        ix, iy = min(SILK_W / 2, (xb - xa) / 2), min(SILK_W / 2, (yb - ya) / 2)
        r.SetStart(pcbnew.VECTOR2I(MM(xa + ix), MM(ya + iy)))
        r.SetEnd(pcbnew.VECTOR2I(MM(xb - ix), MM(yb - iy)))
        b.Add(r)
        g.AddItem(r)
    t.SetPosition(pcbnew.VECTOR2I(MM(cx), MM(cy + bh / 2 - th / 2)))
    b.Add(t)
    g.AddItem(t)
    pcbnew.SaveBoard(a.board, b)
    keep_stackup(a.board, stackup_before)


def stackup_block(text):
    """The (stackup ...) block of a board file: (text, start, end), or None."""
    i = text.find('(stackup')
    if i < 0:
        return None
    depth = 0
    for j in range(i, len(text)):
        depth += text[j] == '('
        depth -= text[j] == ')'
        if depth == 0:
            return text[i:j + 1], i, j + 1


def keep_stackup(path, before):
    """pcbnew can write a default stackup (a 6-layer board came back with a 4-layer one, 2026-10-04). Put the stackup
    the file had (written by tools/set_stackup.py) back."""
    text = open(path).read()
    now = stackup_block(text)
    if before is None or now is None or now[0] == before:
        return
    open(path, 'w').write(text[:now[1]] + before + text[now[2]:])
    print('brand_mark: kept the stackup of the board file (pcbnew wrote another one)')


if __name__ == '__main__':
    main()
