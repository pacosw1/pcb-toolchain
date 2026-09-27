#!/usr/bin/env python3
"""Render a board with the mating plugs on its pluggable headers (render only).

Usage: python3 tools/render_with_plugs.py BOARD [OUT.png]

The tool never writes a board file. It copies BOARD.kicad_pcb and BOARD.kicad_pro to a
temporary folder, adds the plug STEP as a second 3D model to each header footprint in the
copy, and runs kicad-cli pcb render on the copy.

Header -> plug map, parsed live from the board sources (no stored map):
  - hardware-design/boards/BOARD/CANDIDATE-BOM.csv: rows "Mating plug(s) for J1[/J2]".
  - hardware-design/boards/BOARD/SPEC.md: a table cell "<header> C<n> ... plug ... C<m>".
A header footprint is "iot-lab:C<n>". The plug model and its mated height come from
hardware-design/registry/cad-assets/C<m>/MANIFEST.json (model_3d.file, mate.z_bottom).
A header with a plug in the map but no plug model stops the tool (fail closed).
"""
import csv
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'hardware-design/registry/cad-assets')
KCLI = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
RENDER = ['--side', 'top', '--quality', 'high', '--perspective', '--rotate', '-30,0,20',
          '--zoom', '0.9', '-w', '1600', '-h', '1100']
CRTYD_MARGIN = 0.25  # D-051: courtyard = body + 0.25 mm


def plugs_from_bom(text):
    """{header LCSC: plug LCSC} from the "Mating plug(s) for J.." rows of a CANDIDATE-BOM."""
    rows = list(csv.DictReader(io.StringIO(text)))
    by_ref = {}
    for r in rows:
        for ref in re.split(r'[,\s]+', r.get('Designator') or ''):
            if ref:
                by_ref[ref] = r
    out = {}
    for r in rows:
        m = re.search(r'\bplugs?\b.*?\bfor (J\d+(?:\s*/\s*J\d+)*)', r.get('Function') or '', re.I)
        if not m:
            continue
        for ref in re.split(r'\s*/\s*', m.group(1)):
            header = by_ref[ref]['LCSC']
            out = merge_maps(out, {header: r['LCSC']})
    return out


def plugs_from_spec(text):
    """{header LCSC: plug LCSC} from SPEC.md table cells "<header> C<n> ... plug ... C<m>"."""
    out = {}
    for line in text.splitlines():
        if not line.lstrip().startswith('|'):
            continue
        for cell in line.split('|'):
            m = re.search(r'\b(C\d{3,})\b.*?\bplugs?\b.*?\b(C\d{3,})\b', cell)
            if m:
                out = merge_maps(out, {m.group(1): m.group(2)})
    return out


def merge_maps(*maps):
    out = {}
    for m in maps:
        for k, v in m.items():
            if out.get(k, v) != v:
                raise ValueError(f'header {k}: two plugs {out[k]} and {v}')
            out[k] = v
    return out


def _block_end(text, start):
    depth = 0
    for i in range(start, len(text)):
        if text[i] == '(':
            depth += 1
        elif text[i] == ')':
            depth -= 1
            if depth == 0:
                return i
    raise ValueError('unbalanced footprint')


def footprints(text):
    """Yield the iot-lab:C<n> footprints: code, span (start, end index of the closing ")"),
    pad x list and the F.CrtYd box (x0, y0, x1, y1), all in the footprint frame."""
    for m in re.finditer(r'\(footprint "iot-lab:(C\d+)"', text):
        end = _block_end(text, m.start())
        body = text[m.start():end]
        pads = [float(x) for x in re.findall(r'\(pad "[^"]*"[^(]*\(at (-?[\d.]+) -?[\d.]+', body)]
        pts = []
        for g in re.finditer(r'\((?:fp_rect|fp_line|fp_poly)\b', body):
            gb = body[g.start():_block_end(body, g.start())]
            if '(layer "F.CrtYd")' in gb:
                pts += [(float(x), float(y)) for x, y in
                        re.findall(r'\((?:start|end|xy) (-?[\d.]+) (-?[\d.]+)\)', gb)]
        box = None
        if pts:
            box = (min(p[0] for p in pts), min(p[1] for p in pts),
                   max(p[0] for p in pts), max(p[1] for p in pts))
        yield {'code': m.group(1), 'span': (m.start(), end), 'pad_x': sorted(pads), 'courtyard': box}


def plug_transform(courtyard, pad_x, z_bottom):
    """KiCad model offset (mm, model frame, Y up) and Z rotation of the plug model.

    Pins are on footprint y 0. The mating opening is the courtyard side farther from the
    pins; the header front face is that edge minus the courtyard margin. The plug model
    has its shoulder at y 0 and its wires to model +y, so an opening on footprint +y
    (model -y) turns the plug 180 degrees."""
    x0, y0, x1, y1 = courtyard
    if abs(y1) >= abs(y0):
        front, rot = y1 - CRTYD_MARGIN, 180
    else:
        front, rot = y0 + CRTYD_MARGIN, 0
    xc = (min(pad_x) + max(pad_x)) / 2
    return (round(xc, 4) + 0.0, round(-front, 4) + 0.0, float(z_bottom)), rot


def _num(v):
    return f'{v:g}'


def add_model(text, fp, path, offset, rot):
    """Return text with one more (model ...) at the end of footprint fp."""
    end = fp['span'][1]
    model = (f'\t(model "{path}" (offset (xyz {" ".join(_num(v) for v in offset)})) '
             f'(scale (xyz 1 1 1)) (rotate (xyz 0 0 {_num(rot)})))\n\t')
    head = text[:end].rstrip()
    return head + '\n\t' + model + text[end:]


def board_plug_map(board):
    d = os.path.join(ROOT, 'hardware-design/boards', board)
    maps = []
    for name, parse in (('CANDIDATE-BOM.csv', plugs_from_bom), ('SPEC.md', plugs_from_spec)):
        p = os.path.join(d, name)
        if os.path.exists(p):
            with open(p, encoding='utf-8') as f:
                maps.append(parse(f.read()))
    return merge_maps(*maps)


def plug_model(code):
    with open(os.path.join(ASSETS, code, 'MANIFEST.json')) as f:
        m = json.load(f)
    model = os.path.join(ASSETS, code, m['model_3d']['file'])
    if not os.path.exists(model) or 'mate' not in m:
        raise FileNotFoundError(f'{code}: no plug model or mate data')
    return model, m['mate']['z_bottom']


def render(board, out):
    cad = os.path.join(ROOT, 'hardware-design/boards', board, 'cad', board)
    plugs = board_plug_map(board)
    with tempfile.TemporaryDirectory() as tmp:
        for ext in ('.kicad_pcb', '.kicad_pro'):
            shutil.copy(os.path.join(cad, board + ext), os.path.join(tmp, board + ext))
        pcb = os.path.join(tmp, board + '.kicad_pcb')
        with open(pcb, encoding='utf-8') as f:
            text = f.read()
        placed, skipped = [], []
        for fp in reversed(list(footprints(text))):   # from the end: spans stay valid
            plug = plugs.get(fp['code'])
            if not plug:
                continue
            if not fp['courtyard'] or not fp['pad_x']:
                raise ValueError(f'{fp["code"]}: footprint has no courtyard or pads')
            model, z_bottom = plug_model(plug)
            offset, rot = plug_transform(fp['courtyard'], fp['pad_x'], z_bottom)
            text = add_model(text, fp, model, offset, rot)
            placed.append((fp['code'], plug, offset, rot))
        with open(pcb, 'w', encoding='utf-8') as f:
            f.write(text)
        env = dict(os.environ, IOT_LAB=ROOT)
        run = subprocess.run([KCLI, 'pcb', 'render', *RENDER, '-o', os.path.abspath(out), pcb],
                             env=env, capture_output=True, text=True)
        if run.returncode or not os.path.exists(out):
            raise RuntimeError(run.stderr[-800:] or run.stdout[-800:])
    return placed


if __name__ == '__main__':
    board = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else f'{board}-plugs.png'
    for code, plug, offset, rot in reversed(render(board, out)):
        print(json.dumps({'header': code, 'plug': plug, 'offset': offset, 'rotate_z': rot}))
    print(out)
