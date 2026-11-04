#!/usr/bin/env python3
"""rf_lines: RF trace rule gate (grounded coplanar waveguide), first used on CELLULAR (2026-10-09, D-120).

  $PY tools/rf_lines.py BOARD.kicad_pcb SPEC.json [--verbose]       (KiCad bundled Python: pcbnew)

SPEC (hardware-design/boards/<board>/rf-lines.json):
  {"nets": ["/RF_MOD", "/RF_ANT"], "layer": "F.Cu", "ref_layer": "In1.Cu", "ground": "GND",
   "width_mm": 0.38, "gap_mm": 0.20, "h_mm": 0.2104, "er": 4.4, "z_target": 50, "z_tol": 5,
   "width_tol_mm": 0.005, "gap_tol_mm": 0.03, "max_length_mm": 15, "fence_pitch_max_mm": 2.0, "fence_offset_max_mm": 1.0}
Checks (each one PASS or FAIL):
  1. Z of the spec width/gap (conductor-backed CPW, quasi-static, Wadell / Ghione-Naldi with exact elliptic integrals)
     within z_target +- z_tol.
  2. Every track of the nets is on `layer` with width_mm +- width_tol_mm.
  3. No via on the nets.
  4. Gap: at each sample (0.25 mm step, not within 0.8 mm of a pad of a part that has a pad on the nets) the points at W/2 + gap - tol on both
     sides touch no copper of another net on `layer`, and the points at W/2 + gap + tol + 0.05 are in `ground` copper
     (the coplanar ground is there).
  5. Reference: the sample is inside the filled `ground` zone on `ref_layer`.
  6. Length of all tracks of the nets <= max_length_mm (per line when the SPEC has "lines": [{"name", "nets"}]).
  7. Fence: at each sample, a `ground` via on each side within fence_offset_max_mm of the track edge and within
     fence_pitch_max_mm / 2 along the track.
The zones are filled in memory; the board is not saved. Prints "rf_lines: N PASS, M FAIL" (gate.mjs reads it).
"""
import argparse
import json
import math
import sys

import pcbnew

MM = pcbnew.FromMM
T = pcbnew.ToMM


def K(k):
    a, b = 1.0, math.sqrt(1 - k * k)
    for _ in range(40):
        a, b = (a + b) / 2, math.sqrt(a * b)
    return math.pi / (2 * a)


def gcpw_z(w, g, h, er):
    a, b = w / 2, w / 2 + g
    k = a / b
    k3 = math.tanh(math.pi * a / (2 * h)) / math.tanh(math.pi * b / (2 * h))
    q = K(k) / K(math.sqrt(1 - k * k))
    q3 = K(k3) / K(math.sqrt(1 - k3 * k3))
    eeff = (1 + er * q3 / q) / (1 + q3 / q)
    return 60 * math.pi / math.sqrt(eeff) / (q + q3), eeff


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('board')
    ap.add_argument('spec')
    ap.add_argument('--verbose', action='store_true')
    a = ap.parse_args()
    s = json.load(open(a.spec))
    b = pcbnew.LoadBoard(a.board)
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    layer = b.GetLayerID(s['layer'])
    ref = b.GetLayerID(s['ref_layer'])
    nets = set(s['nets'])
    w, g = s['width_mm'], s['gap_mm']
    res = []

    def check(ok, msg):
        res.append(ok)
        print(('PASS ' if ok else 'FAIL ') + msg)

    z, eeff = gcpw_z(w, g, s['h_mm'], s['er'])
    check(abs(z - s['z_target']) <= s['z_tol'], f'Z(W {w}, gap {g}, h {s["h_mm"]}, Er {s["er"]}) = {z:.1f} ohm (eeff {eeff:.2f}); '
          f'target {s["z_target"]} +- {s["z_tol"]}')
    tracks = [t for t in b.GetTracks() if t.GetNetname() in nets and t.GetClass() == 'PCB_TRACK']
    vias = [t for t in b.GetTracks() if t.GetNetname() in nets and t.GetClass() == 'PCB_VIA']
    badw = [(t.GetNetname(), round(T(t.GetWidth()), 3), b.GetLayerName(t.GetLayer())) for t in tracks
            if t.GetLayer() != layer or abs(T(t.GetWidth()) - w) > s['width_tol_mm']]
    check(bool(tracks) and not badw, f'{len(tracks)} RF tracks on {s["layer"]}, width {w} +- {s["width_tol_mm"]} mm; wrong {badw}')
    check(not vias, f'RF vias: {len(vias)}')
    segs = {(t.GetLayer(), *sorted([(t.GetStart().x, t.GetStart().y), (t.GetEnd().x, t.GetEnd().y)])): t for t in tracks}
    # Optional "lines": [{"name", "nets"}, ...]: a board with more than one RF line (CELLULAR rev B: LTE main + GNSS) checks
    # max_length_mm per line (the sum of the tracks of that line's nets). Without "lines": one line = all nets (as before).
    lines = s.get('lines') or [{'name': 'RF', 'nets': sorted(nets)}]
    named = sorted(n for ln in lines for n in ln['nets'])
    check(named == sorted(nets), f'lines must name each net once: {named} against nets {sorted(nets)}')   # none escapes its length check
    for ln in lines:
        length = sum(T(t.GetLength()) for t in segs.values() if t.GetNetname() in set(ln['nets']))   # duplicates once
        check(length <= s['max_length_mm'], f'{ln["name"]} track length {length:.2f} mm (max {s["max_length_mm"]})')
    # Samples near a pad of a part on the line (series R, shunt C, ESD, connector, module) are not line samples.
    rf_pads = [p for fp in b.GetFootprints() if any(q.GetNetname() in nets for q in fp.Pads()) for p in fp.Pads()]
    other_pads = [p for fp in b.GetFootprints() for p in fp.Pads() if p.GetNetname() not in nets and p.IsOnLayer(layer)]
    other_tracks = [t for t in b.GetTracks() if t.GetNetname() not in nets and (t.GetClass() == 'PCB_VIA' or t.GetLayer() == layer)]
    gnd_vias = [t for t in b.GetTracks() if t.GetClass() == 'PCB_VIA' and t.GetNetname() == s['ground']]
    fills, gnd_fill, ref_fill = [], [], []
    for zn in b.Zones():
        if zn.GetIsRuleArea():
            continue
        if zn.IsOnLayer(layer):
            (gnd_fill if zn.GetNetname() == s['ground'] else fills).append(zn.GetFilledPolysList(layer))
        if zn.IsOnLayer(ref) and zn.GetNetname() == s['ground']:
            ref_fill.append(zn.GetFilledPolysList(ref))

    def in_polys(polys, x, y):
        p = pcbnew.VECTOR2I(MM(x), MM(y))
        return any(ps.Contains(p) for ps in polys)

    def other_copper(x, y):
        p = pcbnew.VECTOR2I(MM(x), MM(y))
        return (any(q.HitTest(p, 0) for q in other_pads if q.GetNetname() != s['ground'])
                or any(t.HitTest(p, 0) for t in other_tracks if t.GetNetname() != s['ground'])
                or in_polys(fills, x, y))

    def gnd_copper(x, y):
        p = pcbnew.VECTOR2I(MM(x), MM(y))
        return in_polys(gnd_fill, x, y) or any(q.HitTest(p, 0) for q in other_pads if q.GetNetname() == s['ground'])

    gap_fail, gnd_miss, ref_miss, fence_miss, n = [], [], [], [], 0
    tol = s['gap_tol_mm']
    for t in tracks:
        sx, sy, ex, ey = T(t.GetStart().x), T(t.GetStart().y), T(t.GetEnd().x), T(t.GetEnd().y)
        L = math.hypot(ex - sx, ey - sy)
        if L < 1e-6:
            continue
        ux, uy = (ex - sx) / L, (ey - sy) / L
        steps = max(1, int(L / 0.25))
        for k in range(steps + 1):
            x, y = sx + ux * L * k / steps, sy + uy * L * k / steps
            if any(p.HitTest(pcbnew.VECTOR2I(MM(x), MM(y)), MM(0.8)) for p in rf_pads):
                continue
            n += 1
            here = f'{t.GetNetname()} ({x:.2f}, {y:.2f})'
            if not in_polys(ref_fill, x, y):
                ref_miss.append(here)
            for sgn in (1, -1):
                nx, ny = -uy * sgn, ux * sgn
                d_in, d_out = w / 2 + g - tol, w / 2 + g + tol + 0.05
                if other_copper(x + nx * d_in, y + ny * d_in) or gnd_copper(x + nx * d_in, y + ny * d_in):
                    gap_fail.append(here)
                if not gnd_copper(x + nx * d_out, y + ny * d_out):
                    gnd_miss.append(here)
                ok = False
                for v in gnd_vias:
                    vx, vy = T(v.GetPosition().x) - x, T(v.GetPosition().y) - y
                    along, across = vx * ux + vy * uy, vx * nx + vy * ny
                    if abs(along) <= s['fence_pitch_max_mm'] / 2 and 0 < across - w / 2 <= s['fence_offset_max_mm']:
                        ok = True
                        break
                if not ok:
                    fence_miss.append(here)
    show = (lambda l: l[:6]) if not a.verbose else (lambda l: l)
    check(n > 0 and not gap_fail, f'gap >= {g} - {tol} mm to all other copper: {n} samples, {len(gap_fail)} fail {show(gap_fail)}')
    check(not gnd_miss, f'coplanar {s["ground"]} within {g} + {tol} mm on both sides: {len(gnd_miss)} misses {show(gnd_miss)}')
    check(not ref_miss, f'solid {s["ground"]} on {s["ref_layer"]} under the line: {len(ref_miss)} misses {show(ref_miss)}')
    check(not fence_miss, f'ground via fence (pitch <= {s["fence_pitch_max_mm"]}, offset <= {s["fence_offset_max_mm"]} mm): '
          f'{len(fence_miss)} misses {show(fence_miss)}')
    npass, nfail = sum(res), len(res) - sum(res)
    print(f'rf_lines: {npass} PASS, {nfail} FAIL')
    sys.exit(1 if nfail else 0)


if __name__ == '__main__':
    main()
