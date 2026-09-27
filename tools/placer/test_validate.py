#!/usr/bin/env python3
"""Tests for tools/placer/validate.py (DRC JSON counts; track strip on a board copy).

  $PY -m unittest discover -s tools/placer -p 'test_*.py'
"""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import validate  # noqa: E402

try:
    import pcbnew
except ImportError:
    pcbnew = None

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def item(net):
    return {'items': [{'description': 'Pad 1 [%s] of R1 on F.Cu' % net}, {'description': 'Pad 2 [%s] of R2' % net}]}


class CountTest(unittest.TestCase):
    def test_unconnected_total_and_subset(self):
        drc = {'unconnected_items': [item('/MCU/A'), item('/MCU/A'), item('/MCU/B'), item('C')],
               'violations': [{'severity': 'error', 'type': 'clearance'}, {'severity': 'warning', 'type': 'silk'}],
               'schematic_parity': []}
        c = validate.count_drc(drc, {'/MCU/A', 'C'})
        self.assertEqual(c['unconnected'], 4)
        self.assertEqual(c['subset_unconnected'], 3)
        self.assertEqual(c['errors'], 1)
        self.assertEqual(c['open_nets'], {'/MCU/A': 2, '/MCU/B': 1, 'C': 1})


@unittest.skipUnless(pcbnew, 'needs pcbnew (KiCad bundled Python)')
class StripTest(unittest.TestCase):
    def test_strip_removes_tracks_except_kept_nets(self):
        tmp = tempfile.mkdtemp(prefix='placer-strip-')
        try:
            src = os.path.join(REPO, 'hardware-design/boards/PWR-24V-5V/cad/PWR-24V-5V/PWR-24V-5V.kicad_pcb')
            out = os.path.join(tmp, 'o.kicad_pcb')
            b0 = pcbnew.LoadBoard(src)
            keep = {t.GetNetname() for t in b0.GetTracks()}
            keep = sorted(keep)[:1]
            n = validate.strip_tracks(src, out, keep)
            b1 = pcbnew.LoadBoard(out)
            self.assertEqual(n, sum(1 for t in b0.GetTracks() if t.GetNetname() not in keep))
            self.assertEqual({t.GetNetname() for t in b1.GetTracks()}, set(keep))
            self.assertEqual(len(list(b1.Zones())), len(list(b0.Zones())))
        finally:
            shutil.rmtree(tmp)

    def test_strip_only_removes_the_tracks_of_the_listed_nets(self):
        tmp = tempfile.mkdtemp(prefix='placer-strip-')
        try:
            src = os.path.join(REPO, 'hardware-design/boards/PWR-24V-5V/cad/PWR-24V-5V/PWR-24V-5V.kicad_pcb')
            out = os.path.join(tmp, 'o.kicad_pcb')
            b0 = pcbnew.LoadBoard(src)
            only = sorted({t.GetNetname() for t in b0.GetTracks()})[:2]
            n = validate.strip_tracks(src, out, only=only)
            b1 = pcbnew.LoadBoard(out)
            self.assertEqual(n, sum(1 for t in b0.GetTracks() if t.GetNetname() in only))
            self.assertGreater(n, 0)
            self.assertEqual(sorted(t.GetNetname() for t in b1.GetTracks()),
                             sorted(t.GetNetname() for t in b0.GetTracks() if t.GetNetname() not in only))
        finally:
            shutil.rmtree(tmp)


if __name__ == '__main__':
    unittest.main()
