#!/usr/bin/env python3
"""Add a courtyard to a footprint that has none (EasyEDA bridge conversions have none).

  python3 tools/fp_courtyard.py [--margin 0.25] FILE.kicad_mod ...

Courtyard = bounding box of all pads and all F.Fab geometry, plus --margin (IPC-7351 nominal 0.25 mm).
A footprint that already has an F.CrtYd item is left unchanged.
"""
import argparse
import math
import re

_PAD = re.compile(r'\(pad\s+\S+\s+\S+\s+\S+\s+\(at\s+([-\d.]+)\s+([-\d.]+)(?:\s+([-\d.]+))?\)\s+\(size\s+([-\d.]+)\s+([-\d.]+)\)')
_ITEM = re.compile(r'\((?:fp_line|fp_circle|fp_arc|fp_rect|fp_poly)\b(?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)')
_PT = re.compile(r'\((?:start|end|mid|center|xy)\s+([-\d.]+)\s+([-\d.]+)\)')


def box(text, margin):
    xs, ys = [], []
    for m in _PAD.finditer(text):
        x, y, rot, w, h = float(m[1]), float(m[2]), float(m[3] or 0), float(m[4]), float(m[5])
        c, s = abs(math.cos(math.radians(rot))), abs(math.sin(math.radians(rot)))
        hw, hh = (w * c + h * s) / 2, (w * s + h * c) / 2
        xs += [x - hw, x + hw]; ys += [y - hh, y + hh]
    for it in _ITEM.finditer(text):
        if re.search(r'\(layer\s+"?F\.Fab"?\)', it.group(0)):
            for p in _PT.finditer(it.group(0)):
                xs.append(float(p[1])); ys.append(float(p[2]))
    r = lambda v: round(v, 3)
    return (r(min(xs) - margin), r(min(ys) - margin), r(max(xs) + margin), r(max(ys) + margin))


def add(text, margin):
    if re.search(r'"?F\.CrtYd"?\)', text):
        return text
    x0, y0, x1, y1 = box(text, margin)
    rect = f'(fp_rect (start {x0:g} {y0:g}) (end {x1:g} {y1:g}) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))'
    i = text.find('(model')
    i = i if i >= 0 else text.rstrip().rindex(')')
    return text[:i] + rect + '\n  ' + text[i:]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('files', nargs='+'); ap.add_argument('--margin', type=float, default=0.25)
    a = ap.parse_args()
    for f in a.files:
        t = open(f).read(); n = add(t, a.margin)
        if n != t:
            open(f, 'w').write(n)
        print(f'{f}: courtyard {box(n, a.margin) if n == t else box(t, a.margin)}{"" if n != t else " (kept)"}')


if __name__ == '__main__':
    main()
