#!/usr/bin/env python3
"""Check each assembled part of a board against JLC's own EasyEDA data for its LCSC part (no network).

  $PY tools/easyeda_audit.py <BOARD> [--json OUT]        (KiCad python: needs pcbnew)

JLC places a part from the CPL with its own library footprint, which is the EasyEDA footprint of the C-number
(hardware-design/registry/cad-assets/<C>/easyeda-bridge-source.json: the symbol and the footprint, as LCSC serves them).
For each line of <board>/cad/fab/<BOARD>-BOM-JLC.csv and each designator on it:

1. Footprint frame. The pads of the board footprint (footprint frame, rotation 0) must be the EasyEDA pads: the same
   pad numbers at the same places (tolerance 0.05 mm) about the same origin. Then the CPL point and rotation from
   KiCad are the JLC point and rotation. Result FRAME_OK, or ROTATED <deg> (the KiCad footprint is the EasyEDA one
   turned: the CPL needs that correction), OFFSET <dx,dy> (origin moved: the part lands off its pads), NUMBERING
   (the pad numbers are at other places: pin 1 of the part is not on pad 1 of the board), or NO_SOURCE.
2. Pin names. The schematic symbol pin names per pin number (kicad-cli netlist) against the EasyEDA symbol pin names
   per pin number. A diode or LED with K and A swapped is a NAME_SWAP. Two-pin parts with no pin names (R, C, L,
   ferrite, fuse) are skipped. Names that only differ in spelling are listed as NAME_DIFF for a person to read.

Exit 1 when any part is NUMBERING, OFFSET, ROTATED, NAME_SWAP or NO_SOURCE. NAME_DIFF does not fail; read each one.
"""
import argparse
import csv
import json
import math
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

import pcbnew

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'hardware-design', 'registry', 'cad-assets')
KICAD_CLI = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
U = 0.254  # EasyEDA unit (10 mil) in mm
TOL = 0.05


def easyeda(code):
    p = os.path.join(ASSETS, code, 'easyeda-bridge-source.json')
    if not os.path.exists(p):
        return None
    return json.load(open(p))['result']


def ee_pads(r):
    """{number: [(x, y), ...]} in mm about the footprint origin (EasyEDA y is down, as KiCad)."""
    fp = r['packageDetail']['dataStr']
    ox, oy = float(fp['head']['x']), float(fp['head']['y'])
    pads = {}
    for s in fp['shape']:
        if not s.startswith('PAD~'):
            continue
        f = s.split('~')
        pads.setdefault(f[8], []).append(((float(f[2]) - ox) * U, (float(f[3]) - oy) * U))
    return pads


def ee_pins(r):
    """{pin number: pin name} of the EasyEDA symbol (all sub-parts)."""
    out = {}
    docs = [r['dataStr']] + [sp.get('dataStr', {}) for sp in (r.get('subparts') or [])]
    for d in docs:
        for s in d.get('shape', []):
            if not s.startswith('P~'):
                continue
            # P~show~electric~spice_no~x~y~rot~id^^dot^^path^^name segment^^number segment^^...: the pin number is the
            # text of the number segment (the spice number can differ, e.g. 43 for pin 4)
            segs = s.split('^^')
            f3 = segs[3].split('~') if len(segs) > 3 else []
            f4 = segs[4].split('~') if len(segs) > 4 else []
            num = f4[4] if len(f4) > 4 and f4[4] else segs[0].split('~')[3]
            name = f3[4] if len(f3) > 4 else ''
            out[num] = name
    return out


def kc_pads(fp):
    pads = {}
    for p in fp.Pads():
        if not p.GetNumber():
            continue
        q = p.GetFPRelativePosition()
        pads.setdefault(p.GetNumber(), []).append((pcbnew.ToMM(q.x), pcbnew.ToMM(q.y)))
    return pads


def rot(pt, deg):
    a = math.radians(deg)
    x, y = pt
    # KiCad: positive rotation is counter-clockwise on screen with y down
    return (x * math.cos(a) + y * math.sin(a), -x * math.sin(a) + y * math.cos(a))


def match(ee, kc, deg, shift=(0.0, 0.0)):
    """Largest distance between same-number pads after turning the EasyEDA pads by deg and moving them by shift.
    The board may have more pads of one number than EasyEDA (thermal vias in an exposed pad): each EasyEDA pad must
    still land on a board pad of its number."""
    if set(ee) != set(kc) or any(len(ee[n]) > len(kc[n]) for n in ee):
        return None
    worst = 0.0
    for n in ee:
        a = sorted((round(x + shift[0], 3), round(y + shift[1], 3)) for x, y in (rot(p, deg) for p in ee[n]))
        b = sorted((round(x, 3), round(y, 3)) for x, y in kc[n])
        left = list(b)
        for p in a:
            d, j = min((math.hypot(p[0] - q[0], p[1] - q[1]), j) for j, q in enumerate(left))
            worst = max(worst, d)
            left.pop(j)
    return worst


def frame(ee, kc):
    if not ee:
        return 'NO_SOURCE', ''
    if set(ee) != set(kc):
        return 'NUMBERING', f'pad numbers board {sorted(kc)} EasyEDA {sorted(ee)}'
    for deg in (0, 90, 180, 270):
        w = match(ee, kc, deg)
        if w is not None and w <= TOL:
            extra = {n: len(kc[n]) - len(ee[n]) for n in ee if len(kc[n]) > len(ee[n])}
            note = f'max {w:.3f} mm' + (f'; extra board pads (thermal vias) {extra}' if extra else '')
            return ('FRAME_OK', note) if deg == 0 else ('ROTATED', f'{deg} deg ({note})')
    # same shape about another origin?
    for deg in (0, 90, 180, 270):
        n0 = sorted(ee)[0]
        e0, k0 = rot(ee[n0][0], deg), kc[n0][0]
        sh = (k0[0] - e0[0], k0[1] - e0[1])
        w = match(ee, kc, deg, sh)
        if w is not None and w <= TOL:
            return 'OFFSET', f'rot {deg}, origin moved by ({sh[0]:.3f}, {sh[1]:.3f}) mm'
    # best rotation error, for the report
    best = min((match(ee, kc, d) or 99, d) for d in (0, 90, 180, 270))
    return 'NUMBERING', f'pads do not line up: best rot {best[1]} max {best[0]:.3f} mm'


def norm(s):
    return re.sub(r'[^A-Z0-9]', '', (s or '').upper())


def sch_pins(board, sch):
    os.makedirs('/tmp/easyeda_audit', exist_ok=True)
    out = f'/tmp/easyeda_audit/{board}.xml'
    subprocess.run([KICAD_CLI, 'sch', 'export', 'netlist', '--format', 'kicadxml', '-o', out, sch],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    x = ET.parse(out).getroot()
    lib = {}
    for lp in x.iter('libpart'):
        lib[(lp.get('lib'), lp.get('part'))] = {p.get('num'): p.get('name') for p in lp.iter('pin')}
    comps = {}
    for c in x.iter('comp'):
        ls = c.find('libsource')
        comps[c.get('ref')] = (lib.get((ls.get('lib'), ls.get('part')), {}), f"{ls.get('lib')}:{ls.get('part')}")
    return comps


def pin_check(ref, ours, theirs):
    if not ours or not theirs:
        return 'PINS_SKIP', 'no pin list'
    named = {n: v for n, v in ours.items() if norm(v) and norm(v) != norm(n) and norm(v) not in ('~',)}
    their_named = {n: v for n, v in theirs.items() if norm(v) and norm(v) != norm(n)}
    if len(ours) <= 2 and (not named or not their_named):
        return 'PINS_SKIP', 'two-pin part without pin names'
    diff = [(n, ours.get(n), theirs.get(n)) for n in sorted(set(ours) | set(theirs), key=lambda s: (len(s), s))
            if norm(ours.get(n)) != norm(theirs.get(n))]
    if not diff:
        return 'PINS_OK', ''
    on = {norm(v): n for n, v in ours.items()}
    tn = {norm(v): n for n, v in theirs.items()}
    for a, b in (('K', 'A'), ('CATHODE', 'ANODE'), ('C', 'A')):
        if a in on and b in on and a in tn and b in tn and on[a] == tn[b] and on[b] == tn[a]:
            return 'NAME_SWAP', f'{a}/{b} swapped: board {a}=pin {on[a]}, EasyEDA {a}=pin {tn[a]}'
    return 'NAME_DIFF', '; '.join(f'pin {n}: board "{a}" EasyEDA "{b}"' for n, a, b in diff[:8]) + \
        (f' (+{len(diff) - 8})' if len(diff) > 8 else '')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('board')
    ap.add_argument('--json')
    a = ap.parse_args()
    bd = os.path.join(ROOT, 'hardware-design', 'boards', a.board)
    gate = json.load(open(os.path.join(bd, 'gate.json')))
    stem = os.path.join(bd, gate['project'])
    name = os.path.basename(stem)
    b = pcbnew.LoadBoard(stem + '.kicad_pcb')
    pins = sch_pins(a.board, stem + '.kicad_sch')
    rows = list(csv.DictReader(open(os.path.join(bd, 'cad', 'fab', f'{name}-BOM-JLC.csv'))))
    res, bad = [], 0
    for r in rows:
        code = r['LCSC Part #'].strip()
        src = easyeda(code)
        eep = ee_pads(src) if src else None
        eepin = ee_pins(src) if src else {}
        for ref in [x.strip() for x in r['Designator'].split(',') if x.strip()]:
            fp = b.FindFootprintByReference(ref)
            if fp is None:
                res.append({'ref': ref, 'code': code, 'frame': 'MISSING', 'frame_note': 'not on the board'})
                bad += 1
                continue
            fr, fn = frame(eep, kc_pads(fp))
            ours, sym = pins.get(ref, ({}, ''))
            pc, pn = pin_check(ref, ours, eepin)
            item = {'ref': ref, 'code': code, 'value': r['Comment'], 'footprint': fp.GetFPIDAsString(), 'symbol': sym,
                    'rotation': fp.GetOrientationDegrees(), 'frame': fr, 'frame_note': fn, 'pins': pc, 'pins_note': pn}
            res.append(item)
            if fr != 'FRAME_OK' or pc == 'NAME_SWAP':
                bad += 1
    counts = {}
    for x in res:
        counts[x['frame']] = counts.get(x['frame'], 0) + 1
        counts[x.get('pins', '-')] = counts.get(x.get('pins', '-'), 0) + 1
    print(f'easyeda_audit {a.board}: {len(res)} parts; ' + ', '.join(f'{k} {v}' for k, v in sorted(counts.items())))
    for x in res:
        if x['frame'] != 'FRAME_OK' or x.get('pins') in ('NAME_SWAP', 'NAME_DIFF'):
            print(f"  {x['ref']:6} {x['code']:10} {x.get('value', '')[:22]:22} {x['frame']} {x['frame_note']} | "
                  f"{x.get('pins')} {x.get('pins_note', '')}")
    if a.json:
        json.dump(res, open(a.json, 'w'), indent=1)
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
