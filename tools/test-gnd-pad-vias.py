#!/usr/bin/env python3
"""Fixture for tools/gnd_pad_vias.py (D-126, F5): the new plane vias keep class clearance to every via of the board
and the JLC 0.45 mm hole to hole to a PTH pad.

Run with KiCad's bundled Python: $PY tools/test-gnd-pad-vias.py
Reproduces the BASE-PWR-B U19 pair (2026-10-11 route triage, F5): the U19 pads at their board places; the GND pads
4 and 5 (0.2 x 0.6 mm, 0.5 mm pitch) got vias 0.583 mm apart (copper gap -0.017 mm; the old 0.25 mm hole check
passed at 0.283 mm). Plus a PTH pad whose hole is within 0.45 mm of pad 12's first candidates.
PASS: every via of the output keeps >= 0.2 mm copper to every other via and >= 0.45 mm hole to hole to the PTH pad.
"""
import math
import os
import subprocess
import sys
import tempfile

import pcbnew

MM = pcbnew.FromMM
TOOL = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'gnd_pad_vias.py')


def pad(fp, num, x, y, w, h, net, drill=0):
    p = pcbnew.PAD(fp)
    p.SetNumber(num)
    p.SetShape(pcbnew.PAD_SHAPE_RECT)
    p.SetSize(pcbnew.VECTOR2I(MM(w), MM(h)))
    p.SetPosition(pcbnew.VECTOR2I(MM(x), MM(y)))
    if drill:
        p.SetAttribute(pcbnew.PAD_ATTRIB_PTH)
        p.SetDrillSize(pcbnew.VECTOR2I(MM(drill), MM(drill)))
        p.SetLayerSet(pcbnew.LSET.AllCuMask())
    else:
        p.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
        ls = pcbnew.LSET()
        ls.addLayer(pcbnew.F_Cu)
        p.SetLayerSet(ls)
    p.SetNet(net)
    fp.Add(p)
    return p


def main():
    d = tempfile.mkdtemp(prefix='gndvias-')
    b = pcbnew.BOARD()
    gnd = pcbnew.NETINFO_ITEM(b, 'GND')
    b.Add(gnd)
    sig = pcbnew.NETINFO_ITEM(b, 'SIG')
    b.Add(sig)
    for x0, y0, x1, y1 in ((0, 0, 20, 0), (20, 0, 20, 20), (20, 20, 0, 20), (0, 20, 0, 0)):
        s = pcbnew.PCB_SHAPE(b)
        s.SetShape(pcbnew.SHAPE_T_SEGMENT)
        s.SetStart(pcbnew.VECTOR2I(MM(x0), MM(y0)))
        s.SetEnd(pcbnew.VECTOR2I(MM(x1), MM(y1)))
        s.SetLayer(pcbnew.Edge_Cuts)
        b.Add(s)
    fp = pcbnew.FOOTPRINT(b)
    fp.SetReference('U19')
    b.Add(fp)
    # The U19 TPS2121 pads of the BASE-PWR-B board of 2026-10-11 (bridge footprint, rot 90; mm): the two GND pads 4/5
    # (0.2 x 0.6, 0.5 mm pitch) got their vias north of the row at 149.995/99.225 and 149.495/98.925 (0.583 mm apart:
    # copper gap -0.017 mm, hole gap 0.283 mm) with the old tool.
    nets = {'GND': gnd}
    for num, name, x, y, w, h in (('1', 'PRIMARY_5V_RAW', 150.415, 101.525, 1.05, 0.4), ('2', 'PRIMARY_5V_POE', 150.415, 100.825, 1.05, 0.4),
                                  ('3', '/PWR-24V/MUX_CP2', 150.495, 100.025, 0.2, 0.6), ('4', 'GND', 149.995, 100.025, 0.2, 0.6),
                                  ('5', 'GND', 149.495, 100.025, 0.2, 0.6), ('6', '/PWR-24V/MUX_PR1', 148.995, 100.025, 0.2, 0.6),
                                  ('7', '/PWR-24V/5V_24V', 149.065, 100.825, 1.05, 0.4), ('8', 'PRIMARY_5V_RAW', 149.065, 101.525, 1.05, 0.4),
                                  ('9', '/MUX_ST', 148.995, 102.325, 0.2, 0.6), ('10', '/PWR-24V/MUX_ILM', 149.495, 102.325, 0.2, 0.6),
                                  ('11', '/PWR-24V/MUX_SS', 149.995, 102.325, 0.2, 0.6), ('12', 'GND', 150.495, 102.325, 0.2, 0.6)):
        if name not in nets:
            nets[name] = pcbnew.NETINFO_ITEM(b, name)
            b.Add(nets[name])
        pad(fp, num, x - 140, y - 90, w, h, nets[name])
    # A PTH pad of another net (drill 0.5) north-west of pad 12: hole to hole < 0.45 mm for pad 12's first candidates.
    pad(fp, '13', 150.495 - 140 + 1.1, 102.325 - 90 - 0.9, 0.8, 0.8, sig, drill=0.5)
    src = os.path.join(d, 'in.kicad_pcb')
    out = os.path.join(d, 'out.kicad_pcb')
    pcbnew.SaveBoard(src, b)
    r = subprocess.run([sys.executable, TOOL, src, out, '--net', 'GND'], capture_output=True, text=True)
    print(r.stdout.strip().splitlines()[-2] if r.stdout.strip() else r.stderr[-300:])
    o = pcbnew.LoadBoard(out)
    vias = [t for t in o.GetTracks() if t.GetClass() == 'PCB_VIA']
    bad = []
    for i, p in enumerate(vias):
        for q in vias[i + 1:]:
            dist = math.hypot(p.GetPosition().x - q.GetPosition().x, p.GetPosition().y - q.GetPosition().y)
            gap = (dist - p.GetWidth(pcbnew.F_Cu) / 2 - q.GetWidth(pcbnew.F_Cu) / 2) / 1e6
            if gap < 0.2 - 1e-6:
                bad.append('via-via copper gap %.3f at %.3f/%.3f' % (gap, p.GetPosition().x / 1e6, p.GetPosition().y / 1e6))
        for q in o.GetPads():
            if q.GetAttribute() == pcbnew.PAD_ATTRIB_PTH:
                dist = math.hypot(p.GetPosition().x - q.GetPosition().x, p.GetPosition().y - q.GetPosition().y)
                hole = (dist - p.GetDrill() / 2 - q.GetDrillSize().x / 2) / 1e6
                if hole < 0.45 - 1e-6:
                    bad.append('via-PTH hole gap %.3f at %.3f/%.3f' % (hole, p.GetPosition().x / 1e6, p.GetPosition().y / 1e6))
    added = len(vias)
    for line in bad:
        print('  ' + line)
    if bad or added != 3:
        print(f'FAIL gnd_pad_vias fixture: {len(bad)} collisions, {added} vias added (want 3)')
        return 1
    print('PASS gnd_pad_vias fixture: 3 vias added, no via-via copper collision, PTH hole to hole >= 0.45 mm')
    return 0


if __name__ == '__main__':
    sys.exit(main())
