#!/usr/bin/env python3
"""Tests for tools/pin_escape_flow.py on tiny synthetic boards built in pcbnew (W18, 2026-10-11).

  $PY tools/test_pin_escape_flow.py      ($PY = KiCad bundled Python)

Default class: track 0.2 mm + clearance 0.2 mm -> grid pitch 0.4 mm; via 0.6 mm.
"""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

import pcbnew

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pin_escape_flow as pef  # noqa: E402

MM = pcbnew.FromMM
PRO = {'net_settings': {'classes': [{'name': 'Default', 'track_width': 0.2, 'clearance': 0.2, 'via_diameter': 0.6}]},
       'board': {'design_settings': {'rules': {'min_copper_edge_clearance': 0.3, 'min_hole_clearance': 0.25,
                                                 'min_track_width': 0.15}}}}


def v(x, y):
    return pcbnew.VECTOR2I(MM(x), MM(y))


class Bd:
    def __init__(self):
        self.b = pcbnew.BOARD()
        self.nets = {}
        for x1, y1, x2, y2 in ((-6, -10, 30, -10), (30, -10, 30, 10), (30, 10, -6, 10), (-6, 10, -6, -10)):
            s = pcbnew.PCB_SHAPE(self.b)
            s.SetShape(pcbnew.SHAPE_T_SEGMENT)
            s.SetStart(v(x1, y1)); s.SetEnd(v(x2, y2))
            s.SetLayer(pcbnew.Edge_Cuts); s.SetWidth(MM(0.1))
            self.b.Add(s)

    def net(self, name):
        if name not in self.nets:
            ni = pcbnew.NETINFO_ITEM(self.b, name)
            self.b.Add(ni)
            self.nets[name] = ni
        return self.nets[name]

    def row(self, ref, x0, nets, pitch=1.0):
        fp = pcbnew.FOOTPRINT(self.b)
        fp.SetReference(ref)
        self.b.Add(fp)
        for i, n in enumerate(nets):
            p = pcbnew.PAD(fp)
            p.SetNumber(str(i + 1))
            p.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
            p.SetShape(pcbnew.PAD_SHAPE_RECT)
            p.SetSize(v(0.6, 1.2))
            p.SetLayerSet(p.SMDMask())
            p.SetPosition(v(x0 + i * pitch, 0))
            p.SetNet(self.net(n))
            fp.Add(p)

    def track(self, pts, net='WALL', w=0.2):
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            t = pcbnew.PCB_TRACK(self.b)
            t.SetStart(v(x1, y1)); t.SetEnd(v(x2, y2)); t.SetWidth(MM(w))
            t.SetLayer(pcbnew.F_Cu); t.SetNet(self.net(net))
            self.b.Add(t)

    def run(self, region, layers='F.Cu,B.Cu', extra=()):
        d = tempfile.mkdtemp(prefix='pef-')
        pcb = os.path.join(d, 't.kicad_pcb')
        pcbnew.SaveBoard(pcb, self.b)
        with open(os.path.join(d, 't.kicad_pro'), 'w') as fh:
            json.dump(PRO, fh)
        out = os.path.join(d, 'o.json')
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = pef.main([pcb, '--layers', layers, '--region=' + ','.join(map(str, region)), '--json', out] + list(extra))
        with open(out) as fh:
            r = json.load(fh)['regions'][0]
        return rc, r, buf.getvalue()


def nets(n):
    return [f'N{i + 1}' for i in range(n)]


class PinEscapeFlow(unittest.TestCase):
    def test_open_row_pass(self):
        b = Bd(); b.row('U1', 0, nets(4)); b.row('U2', 20, nets(4))
        rc, r, out = b.run((-2, -2, 5, 3), 'F.Cu')
        self.assertEqual((rc, r['verdict'], r['demand'], r['flow']), (0, 'PASS', 4, 4), out)
        self.assertEqual(r['pitch_mm'], 0.4)
        self.assertIn('PIN_ESCAPE PASS', out)

    def test_walled_row_one_gap_two_nets_fail(self):
        b = Bd(); b.row('U1', 0, nets(2)); b.row('U2', 20, nets(2))
        # U wall round the 2-pad row, top side closed except one gap that fits exactly one track
        b.track([(0.15, -1.4), (-1.2, -1.4), (-1.2, 1.4), (2.2, 1.4), (2.2, -1.4), (1.05, -1.4)])
        rc, r, out = b.run((-2, -2, 5, 3), 'F.Cu')
        self.assertEqual((rc, r['verdict'], r['demand'], r['flow']), (1, 'FAIL', 2, 1), out)
        self.assertEqual(len(r['unescaped']), 1)
        self.assertIn(r['unescaped'][0], ('N1', 'N2'))
        self.assertEqual(sorted(r['contested']), ['N1', 'N2'])
        self.assertIsNotNone(r['cut'])
        self.assertIn('track WALL', r['cut']['near'])

    def test_closed_wall_second_layer_opens_path(self):
        b = Bd(); b.row('U1', 0, nets(2)); b.row('U2', 20, nets(2))
        b.track([(-2.4, -2.4), (3.4, -2.4), (3.4, 2.4), (-2.4, 2.4), (-2.4, -2.4)])
        rc, r, out = b.run((-4, -4, 7, 5), 'F.Cu,B.Cu')
        self.assertEqual((rc, r['verdict'], r['flow']), (0, 'PASS', 2), out)
        rc, r, out = b.run((-4, -4, 7, 5), 'F.Cu')
        self.assertEqual((rc, r['verdict'], r['flow']), (1, 'FAIL', 0), out)
        self.assertEqual(sorted(r['unescaped']), ['N1', 'N2'])

    def test_neck_near_pad_only(self):
        # one net walled in on F.Cu; the gap (wall end centres 0.39 mm either side of a cell column) clears a 0.15 mm
        # neck (0.39 - 0.1 >= 0.2 + 0.075) but not a 0.2 mm track (< 0.2 + 0.1)
        def walled(top):
            b = Bd(); b.row('U1', 0, ['N1']); b.row('U2', 20, ['N1'])
            b.track([(0.2 - 0.39, top), (-1.2, top), (-1.2, 1.4), (1.2, 1.4), (1.2, top), (0.2 + 0.39, top)])
            return b
        near = walled(-1.4)    # gap 0.8 mm from the pad: inside the pad long dimension (1.2 mm)
        rc, r, out = near.run((-2, -2, 4, 3), 'F.Cu')
        self.assertEqual((rc, r['verdict'], r['neck_mm']), (0, 'PASS', 0.15), out)
        rc, r, out = near.run((-2, -2, 4, 3), 'F.Cu', ['--neck-mm', '0'])
        self.assertEqual((rc, r['verdict']), (1, 'FAIL'), out)
        far = walled(-2.2)     # gap 1.6 mm from the pad: class width applies
        rc, r, out = far.run((-2, -2.8, 4, 3), 'F.Cu')
        self.assertEqual((rc, r['verdict']), (1, 'FAIL'), out)

    def test_parts_mode_uses_part_pads_only(self):
        b = Bd(); b.row('U1', 0, nets(4)); b.row('U2', 20, nets(4))
        d = tempfile.mkdtemp(prefix='pef-')
        pcb = os.path.join(d, 't.kicad_pcb')
        pcbnew.SaveBoard(pcb, b.b)
        with open(os.path.join(d, 't.kicad_pro'), 'w') as fh:
            json.dump(PRO, fh)
        out = os.path.join(d, 'o.json')
        with redirect_stdout(io.StringIO()):
            rc = pef.main([pcb, '--layers', 'F.Cu', '--parts', 'U1', '--json', out])
        with open(out) as fh:
            regs = json.load(fh)['regions']
        self.assertEqual((rc, [r['region'] for r in regs], regs[0]['demand']), (0, ['U1'], 4))


if __name__ == '__main__':
    unittest.main(verbosity=2)
