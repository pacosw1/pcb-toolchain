#!/usr/bin/env python3
"""Set the courtyard of a footprint: IPC-7351 nominal, pads + component body + margin (D-051).

  uv run --no-project --python 3.12 --with cadquery-ocp python tools/fp_courtyard.py \
      [--margin 0.25] [--bodies hardware-design/registry/courtyard-bodies.json] [--dry-run] FILE.kicad_mod ...

Courtyard = one F.CrtYd rectangle around the union of all pads and the body, plus --margin (0.25 mm).
Silk does not count (bridge parts draw silk outside the body). Every old F.CrtYd item is replaced.
Body source, first that applies:
  1. step: the xy bounding box of the STEP model, placed by the footprint (model offset, rotate z, scale).
     It must lie inside the pads + silk + fab box + 0.5 mm; else the model is misaligned and is not used.
  2. fab: the F.Fab outline (fp_line / fp_rect / fp_poly; circles and text are markers, not outline).
  3. datasheet: the --bodies JSON entry {"<C-number>": {"body": [x0, y0, x1, y1], "source": "..."}}.
No source: the file is not changed and the exit code is 1. STEP needs OCP (the cadquery-ocp wheel).
"""
import argparse
import json
import math
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOL = 0.5  # mm a placed STEP body may extend past the pads + silk box before it counts as misaligned
_PAD = re.compile(r'\(pad\s+\S+\s+\S+\s+\S+\s+\(at\s+([-\d.]+)\s+([-\d.]+)(?:\s+([-\d.]+))?\)\s+\(size\s+([-\d.]+)\s+([-\d.]+)\)')
_ITEM = re.compile(r'\((?:fp_line|fp_circle|fp_arc|fp_rect|fp_poly)\b(?:[^()]|\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))*\)')
_PT = re.compile(r'\((?:start|end|mid|center|xy)\s+([-\d.]+)\s+([-\d.]+)\)')
_XYZ = lambda key, t: tuple(float(v) for v in re.search(r'\(' + key + r'\s+\(xyz\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\)', t).groups())


def _bbox(pts):
    if not pts:
        return None
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return (min(xs), min(ys), max(xs), max(ys))


def union(a, b):
    return a if b is None else b if a is None else (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def pads_box(text):
    pts = []
    for m in _PAD.finditer(text):
        x, y, rot, w, h = float(m[1]), float(m[2]), float(m[3] or 0), float(m[4]), float(m[5])
        c, s = abs(math.cos(math.radians(rot))), abs(math.sin(math.radians(rot)))
        hw, hh = (w * c + h * s) / 2, (w * s + h * c) / 2
        pts += [(x - hw, y - hh), (x + hw, y + hh)]
    return _bbox(pts)


def _layer_items(text, layer, kinds=('fp_line', 'fp_circle', 'fp_arc', 'fp_rect', 'fp_poly')):
    for it in _ITEM.finditer(text):
        s = it.group(0)
        if s[1:].split(None, 1)[0] in kinds and re.search(r'\(layer\s+"?' + re.escape(layer) + r'"?\)', s):
            yield it


def _points_box(text, layer, kinds=('fp_line', 'fp_circle', 'fp_arc', 'fp_rect', 'fp_poly')):
    return _bbox([(float(p[1]), float(p[2])) for it in _layer_items(text, layer, kinds) for p in _PT.finditer(it.group(0))])


def fab_box(text):
    return _points_box(text, 'F.Fab', ('fp_line', 'fp_rect', 'fp_poly'))


def model(text, env=None):
    """(path, (offset x, y), scale, rotate z) of the first model. Only a uniform scale and a z rotation are allowed."""
    env = os.environ if env is None else env
    m = re.search(r'\(model\s+"([^"]+)"(.*?)\n\s*\)', text, re.S)
    if not m:
        return None
    path = re.sub(r'\$\{(\w+)\}', lambda v: env.get(v[1], ROOT if v[1] == 'IOT_LAB' else v[0]), m[1])
    off, sc, rot = _XYZ('offset', m[2]), _XYZ('scale', m[2]), _XYZ('rotate', m[2])
    if len(set(sc)) != 1 or rot[0] or rot[1]:
        raise ValueError(f'model scale {sc} / rotate {rot}: only a uniform scale and a z rotation are supported')
    return path, (off[0], off[1]), sc[0], rot[2]


def step_candidates(path):
    stem = os.path.splitext(path)[0]
    return list(dict.fromkeys([stem + '.step', stem + '.stp', path]))


def place(raw, offset, scale, rot):
    """STEP xy box (y up) -> footprint box (y down). KiCad: scale, rotate by -rot about z, add offset, flip y.
    For a rotation that is not a multiple of 90 the box of the rotated corners contains the true box."""
    a = math.radians(-rot)
    c, s = round(math.cos(a), 12), round(math.sin(a), 12)
    pts = []
    for x in (raw[0], raw[2]):
        for y in (raw[1], raw[3]):
            x3, y3 = scale * (x * c - y * s) + offset[0], scale * (x * s + y * c) + offset[1]
            pts.append((round(x3, 6) + 0.0, round(-y3, 6) + 0.0))
    return _bbox(pts)


def step_box(path):
    """Raw xy box (mm) of the first readable STEP file for this model path, or None. Needs OCP."""
    from OCP.STEPControl import STEPControl_Reader
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    for f in step_candidates(path):
        if not f.lower().endswith(('.step', '.stp')) or not os.path.isfile(f):
            continue
        r = STEPControl_Reader()
        if r.ReadFile(f) != IFSelect_RetDone or not r.TransferRoots():
            raise ValueError(f'{f}: STEP read failed')
        b = Bnd_Box()
        BRepBndLib.AddOptimal_s(r.OneShape(), b, False, False)
        p, q = b.CornerMin(), b.CornerMax()
        return (p.X(), p.Y(), q.X(), q.Y())
    return None


def aligned(body, text):
    ref = union(union(pads_box(text), _points_box(text, 'F.SilkS')), fab_box(text))
    return ref is not None and body[0] >= ref[0] - TOL and body[1] >= ref[1] - TOL and body[2] <= ref[2] + TOL and body[3] <= ref[3] + TOL


def body_box(text, step_box=step_box, bodies=None, key=None):
    """(body box, source) in footprint coordinates. ValueError when no source applies."""
    note = ''
    m = model(text)
    raw = step_box(m[0]) if m else None
    if raw is not None:
        body = place(raw, *m[1:])
        if aligned(body, text):
            return body, 'step'
        note = ' (step misaligned)'
    fab = fab_box(text)
    if fab is not None:
        return fab, 'fab' + note
    entry = (bodies or {}).get(key)
    if entry:
        return tuple(entry['body']), 'datasheet' + note
    raise ValueError('no body source' + note + ': add the datasheet body to --bodies')


def box(text, body, margin):
    b = union(pads_box(text), body)
    r = lambda v: round(v, 3) + 0.0
    return (r(b[0] - margin), r(b[1] - margin), r(b[2] + margin), r(b[3] + margin))


def set_courtyard(text, rect, uuid=None):
    x0, y0, x1, y1 = rect
    tail = f' (uuid "{uuid}")' if uuid else ''
    new = f'(fp_rect (start {x0:g} {y0:g}) (end {x1:g} {y1:g}) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"){tail})'
    spans = [it.span() for it in _layer_items(text, 'F.CrtYd')]
    i = spans[0][0] if spans else text.find('(model')
    i = i if i >= 0 else text.rstrip().rindex(')')
    at = text.rfind('\n', 0, i)
    indent = text[at + 1:i]
    for s, e in reversed(spans):  # remove each whole line: its indent and its newline
        text = text[:text.rfind('\n', 0, s)] + text[e:]
    return text[:at] + '\n' + indent + new + text[at:]


def old_courtyard(text):
    return _points_box(text, 'F.CrtYd')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('files', nargs='+')
    ap.add_argument('--margin', type=float, default=0.25)
    ap.add_argument('--bodies', default=os.path.join(ROOT, 'hardware-design/registry/courtyard-bodies.json'))
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    bodies = json.load(open(a.bodies)) if os.path.isfile(a.bodies) else {}
    bad = 0
    print('file\tsource\tbody\told\tnew\tgrown')
    for f in a.files:
        t = open(f).read()
        key = os.path.basename(os.path.dirname(os.path.dirname(os.path.abspath(f))))
        try:
            body, src = body_box(t, step_box, bodies, key)
        except ValueError as e:
            print(f'{f}\tERROR {e}', file=sys.stderr); bad += 1
            continue
        new = box(t, body, a.margin); old = old_courtyard(t)
        grown = old is not None and (new[2] - new[0] > old[2] - old[0] + 1e-6 or new[3] - new[1] > old[3] - old[1] + 1e-6)
        print(f'{f}\t{src}\t{tuple(round(v, 3) for v in body)}\t{old}\t{new}\t{"GROWN" if grown else ""}')
        n = set_courtyard(t, new)
        if n != t and not a.dry_run:
            open(f, 'w').write(n)
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
