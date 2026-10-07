#!/usr/bin/env python3
"""Top render of a board and zoomed crops of board areas (for label reviews, 2026-10-07).

  $PY tools/render_zoom.py BOARD.kicad_pcb OUT_PREFIX [--area NAME x0 y0 x1 y1]... [--scale 40]   (KiCad python: PIL)

kicad-cli renders the top side (orthographic, IOT_LAB set for the 3D models) at --scale px/mm; the board is found in
the image (the solder mask pixels) and mapped to its Edge.Cuts box, then each area (board mm) is cut out:
OUT_PREFIX-top.png and OUT_PREFIX-<NAME>.png.
"""
import os
import subprocess
import sys

import pcbnew
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main(argv):
    pcb, prefix = argv[0], argv[1]
    scale = float(argv[argv.index('--scale') + 1]) if '--scale' in argv else 40.0
    areas, i = [], 2
    while i < len(argv):
        if argv[i] == '--area':
            areas.append((argv[i + 1], *map(float, argv[i + 2:i + 6])))
            i += 6
        else:
            i += 1
    b = pcbnew.LoadBoard(pcb)
    bb = b.GetBoardEdgesBoundingBox()
    ex0, ey0 = pcbnew.ToMM(bb.GetLeft()), pcbnew.ToMM(bb.GetTop())
    ew, eh = pcbnew.ToMM(bb.GetWidth()), pcbnew.ToMM(bb.GetHeight())
    w, h = int(ew * scale * 1.06), int(eh * scale * 1.06)
    top = f'{prefix}-top.png'
    env = dict(os.environ, IOT_LAB=os.environ.get('IOT_LAB', ROOT))
    cli = os.environ.get('KICAD_CLI', '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli')
    def render(zoom):
        subprocess.run([cli, 'pcb', 'render', '--side', 'top', '--quality', 'high', '--width', str(w), '--height', str(h),
                        '--background', 'opaque', '--zoom', f'{zoom:.3f}', '-o', top, pcb], check=True, env=env,
                       capture_output=True)
        im = Image.open(top).convert('RGB')
        px = im.load()
        W, H = im.size
        # the board: green solder mask pixels (G above B and R); the background gradient is blue-grey
        green = lambda c: c[1] > c[2] + 8 and c[1] >= c[0]
        cols = [x for x in range(W) if sum(1 for y in range(0, H, 4) if green(px[x, y])) > H / 40]
        rows = [y for y in range(H) if sum(1 for x in range(0, W, 4) if green(px[x, y])) > W / 40]
        return im, W, H, min(cols), max(cols) + 1, min(rows), max(rows) + 1
    im, W, H, bx0, bx1, by0, by1 = render(1.0)
    fill = min(W / (bx1 - bx0), H / (by1 - by0))
    if fill > 1.15:   # the camera fits the 3D models (plugs past the edge): zoom so that the board fills the image
        im, W, H, bx0, bx1, by0, by1 = render(fill / 1.06)
    sx, sy = (bx1 - bx0) / ew, (by1 - by0) / eh
    print(f'{top}: board at px ({bx0}, {by0})-({bx1}, {by1}), {sx:.1f} x {sy:.1f} px/mm')
    for name, x0, y0, x1, y1 in areas:
        box = (int(bx0 + (x0 - ex0) * sx), int(by0 + (y0 - ey0) * sy), int(bx0 + (x1 - ex0) * sx), int(by0 + (y1 - ey0) * sy))
        out = f'{prefix}-{name}.png'
        im.crop(box).save(out)
        print(f'{out}: ({x0}, {y0})-({x1}, {y1}) mm')


if __name__ == '__main__':
    main(sys.argv[1:])
