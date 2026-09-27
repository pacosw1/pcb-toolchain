#!/usr/bin/env python3
"""Refresh the courtyards of a board or block from the iot-lab footprint library (D-051).

  python3 tools/refresh_courtyards.py [--lib hardware-design/blocks/iot-lab.pretty] [--dry-run] BOARD.kicad_pcb

For each footprint "iot-lab:<C>" the F.CrtYd items are replaced by the courtyard box of <lib>/<C>.kicad_mod.
Nothing else changes: other footprints, pads, silk, fab, models and placement stay. Footprint graphics in
a .kicad_pcb are in footprint coordinates, so the library box applies as is. A bottom-side iot-lab
footprint or a missing library footprint stops the tool (exit 1) and the board is not written.
"""
import argparse
import importlib.util
import os
import re
import sys
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('fp_courtyard', os.path.join(HERE, 'fp_courtyard.py'))
fc = importlib.util.module_from_spec(spec); spec.loader.exec_module(fc)
LIB = os.path.join(os.path.dirname(HERE), 'hardware-design/blocks/iot-lab.pretty')


def _span(text, i):
    """End index (exclusive) of the s-expression that starts at text[i] == '('."""
    depth, q = 0, False
    for j in range(i, len(text)):
        c = text[j]
        if q:
            q = c != '"' or text[j - 1] == '\\'
        elif c == '"':
            q = True
        elif c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
            if depth == 0:
                return j + 1
    raise ValueError(f'unbalanced s-expression at {i}')


def refresh(text, lib=LIB):
    """(new text, [(reference, C-number, old box, new box)])."""
    rows, out, pos = [], [], 0
    for m in re.finditer(r'\(footprint "iot-lab:([^"]+)"', text):
        if m.start() < pos:
            continue
        end = _span(text, m.start()); fp = text[m.start():end]; c = m[1]
        ref = re.search(r'\(property "Reference" "([^"]*)"', fp)
        ref = ref[1] if ref else '?'
        if not re.match(r'\(footprint "[^"]+"\s+\(layer "F\.Cu"\)', fp):
            raise ValueError(f'{ref} ({c}): not on F.Cu; only top-side footprints are supported')
        f = os.path.join(lib, c + '.kicad_mod')
        if not os.path.isfile(f):
            raise ValueError(f'{ref} ({c}): no library footprint {f}')
        new = fc.old_courtyard(open(f).read())
        if new is None:
            raise ValueError(f'{ref} ({c}): {f} has no courtyard')
        fid = re.search(r'\(uuid "([^"]+)"\)', fp)
        uid = uuid.uuid5(uuid.NAMESPACE_URL, 'crtyd:' + (fid[1] if fid else ref))
        rows.append((ref, c, fc.old_courtyard(fp), new))
        out += [text[pos:m.start()], fc.set_courtyard(fp, new, uid)]
        pos = end
    return ''.join(out) + text[pos:], rows


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('board'); ap.add_argument('--lib', default=LIB); ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    t = open(a.board).read()
    try:
        n, rows = refresh(t, a.lib)
    except ValueError as e:
        sys.exit(f'{a.board}: {e}')
    for r in rows:
        print(f'{r[0]}\t{r[1]}\t{r[2]} -> {r[3]}')
    print(f'{len(rows)} footprints, {"changed" if n != t else "no change"}{" (dry run)" if a.dry_run else ""}')
    if n != t and not a.dry_run:
        open(a.board, 'w').write(n)


if __name__ == '__main__':
    main()
