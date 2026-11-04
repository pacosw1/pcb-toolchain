"""Pixel-art silkscreen icons for the boards.

Bitmaps: tools/pixel-art/<name>.txt. '#' is a pixel, '.' is empty. A line that starts
with ';' is a comment. All pixel rows have the same length.

Usage (KiCad bundled Python for 'apply', any Python 3 for 'preview'):
  pixel-art.py preview [<name> ...]
      Write hardware-design/boards/_art/<name>.png (all bitmaps when no name is given).
  pixel-art.py apply <board.kicad_pcb> <name> --at <x_mm> <y_mm> [--layer B.SilkS|F.SilkS] [--pixel 0.5]
      Put the icon on the board, centred at (x, y) in board coordinates. The shapes go in
      one PCB_GROUP "pixel-art <name>". A rerun removes the old group and its shapes first.
      Also writes the PNG preview.

Each horizontal run of pixels is one filled rectangle. The rectangle has a SILK_W stroke
(JLC silkscreen minimum line 0.153 mm) and is inset by SILK_W / 2, so its outer edge is
the pixel edge and the runs of adjacent rows touch.
On B.SilkS the art is mirrored in x, so it reads correctly from the bottom side.
Check the result with tools/check_pixel_art.py.
"""
import argparse
import os
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ART_DIR = os.path.join(ROOT, 'tools', 'pixel-art')
import project_root  # noqa: E402  (project root: --root/IOT_LAB/cwd; tools/project_root.py)
PREVIEW_DIR = os.path.join(project_root.root_str(), 'hardware-design', 'boards', '_art')
PIXEL_MIN_MM = 0.4
SILK_W = 0.16
PREFIX = 'pixel-art '
LAYERS = ('B.SilkS', 'F.SilkS')

# Preview: solder mask green, silkscreen white, SCALE px per art pixel, a 2-pixel border.
BG, INK, SCALE, BORDER = (0x1e, 0x4d, 0x2b), (0xf4, 0xf4, 0xf0), 16, 2


def load(name):
    path = os.path.join(ART_DIR, f'{name}.txt')
    with open(path, encoding='utf8') as f:
        rows = [line.rstrip('\n') for line in f if line.strip() and not line.startswith(';')]
    if not rows:
        sys.exit(f'{path}: no pixel rows')
    if len({len(r) for r in rows}) != 1:
        sys.exit(f'{path}: rows have different lengths')
    bad = set(''.join(rows)) - set('#.')
    if bad:
        sys.exit(f'{path}: characters other than # and .: {sorted(bad)}')
    return rows


def runs(rows):
    """(row, first column, last column) for each horizontal run of '#'."""
    out = []
    for r, row in enumerate(rows):
        c = 0
        while c < len(row):
            if row[c] == '#':
                c0 = c
                while c + 1 < len(row) and row[c + 1] == '#':
                    c += 1
                out.append((r, c0, c))
            c += 1
    return out


def png(path, rows):
    w, h = len(rows[0]) + 2 * BORDER, len(rows) + 2 * BORDER
    raw = bytearray()
    for y in range(h * SCALE):
        raw.append(0)
        r = y // SCALE - BORDER
        for x in range(w * SCALE):
            c = x // SCALE - BORDER
            on = 0 <= r < len(rows) and 0 <= c < len(rows[0]) and rows[r][c] == '#'
            raw.extend(INK if on else BG)

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)

    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w * SCALE, h * SCALE, 8, 2, 0, 0, 0))
    data += chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b'')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)


def preview(names):
    names = names or sorted(n[:-4] for n in os.listdir(ART_DIR) if n.endswith('.txt'))
    for name in names:
        rows = load(name)
        path = os.path.join(PREVIEW_DIR, f'{name}.png')
        png(path, rows)
        print(f'{name}: {len(rows[0])} x {len(rows)} pixels, {len(runs(rows))} runs -> {os.path.relpath(path, ROOT)}')


def apply(board_path, name, x, y, layer, pixel):
    import pcbnew

    if layer not in LAYERS:
        sys.exit(f'layer must be one of {LAYERS}')
    if pixel < PIXEL_MIN_MM:
        sys.exit(f'pixel size {pixel} mm is less than the minimum {PIXEL_MIN_MM} mm')
    rows = load(name)
    board = pcbnew.LoadBoard(board_path)
    for g in list(board.Groups()):
        if g.GetName() == PREFIX + name:
            for item in list(g.GetItems()):
                g.RemoveItem(item)
                board.Remove(item)
            board.Remove(g)
    lid = pcbnew.B_SilkS if layer == 'B.SilkS' else pcbnew.F_SilkS
    mirror = layer == 'B.SilkS'
    cols = len(rows[0])
    x0, y0 = x - cols * pixel / 2, y - len(rows) * pixel / 2
    group = pcbnew.PCB_GROUP(board)
    group.SetName(PREFIX + name)
    board.Add(group)
    inset = SILK_W / 2
    cells = runs(rows)
    for r, c0, c1 in cells:
        a, b = (cols - 1 - c1, cols - c0) if mirror else (c0, c1 + 1)
        s = pcbnew.PCB_SHAPE(board)
        s.SetShape(pcbnew.SHAPE_T_RECTANGLE)
        s.SetStart(pcbnew.VECTOR2I(pcbnew.FromMM(x0 + a * pixel + inset), pcbnew.FromMM(y0 + r * pixel + inset)))
        s.SetEnd(pcbnew.VECTOR2I(pcbnew.FromMM(x0 + b * pixel - inset), pcbnew.FromMM(y0 + (r + 1) * pixel - inset)))
        s.SetLayer(lid)
        s.SetWidth(pcbnew.FromMM(SILK_W))
        s.SetFilled(True)
        board.Add(s)
        group.AddItem(s)
    pcbnew.SaveBoard(board_path, board)
    preview([name])
    print(f'{name}: {len(cells)} rectangles on {layer}, pixel {pixel} mm, '
          f'{cols * pixel:.2f} x {len(rows) * pixel:.2f} mm centred at ({x}, {y})')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('preview')
    p.add_argument('names', nargs='*')
    a = sub.add_parser('apply')
    a.add_argument('board')
    a.add_argument('name')
    a.add_argument('--at', nargs=2, type=float, required=True, metavar=('X', 'Y'))
    a.add_argument('--layer', default='B.SilkS', choices=LAYERS)
    a.add_argument('--pixel', type=float, default=0.5)
    args = ap.parse_args()
    if args.cmd == 'preview':
        preview(args.names)
    else:
        apply(args.board, args.name, args.at[0], args.at[1], args.layer, args.pixel)


if __name__ == '__main__':
    main()
