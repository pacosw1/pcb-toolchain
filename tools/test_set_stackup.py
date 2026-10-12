#!/usr/bin/env python3
"""Tests of tools/set_stackup.py (--dielectrics, D-142 JLC06161H-7628). Run: python3 tools/test_set_stackup.py"""
import importlib.util
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('set_stackup', os.path.join(HERE, 'set_stackup.py'))
ss = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ss)
SIX = ['F.Cu', 'In1.Cu', 'In2.Cu', 'In3.Cu', 'In4.Cu', 'B.Cu']


class Dielectrics(unittest.TestCase):
    def test_jlc06161h(self):
        text, diel = ss.block(SIX, 0.2104, 1.6, [0.2104, 0.4, 0.2028, 0.4, 0.2104])
        self.assertEqual([d[0] for d in diel], [0.2104, 0.4, 0.2028, 0.4, 0.2104])
        self.assertEqual([d[1] for d in diel], ['prepreg', 'core', 'prepreg', 'core', 'prepreg'])
        self.assertEqual(re.findall(r'\(thickness ([\d.]+)\)', text)[1:12:2], ['0.035', '0.0152', '0.0152', '0.0152', '0.0152', '0.035'])
        total = sum(d[0] for d in diel) + 2 * 0.035 + 4 * 0.0152 + 0.02
        self.assertAlmostEqual(total, 1.5744, places=4)   # D-142 dielectrics + copper + mask; nominal 1.6 mm board

    def test_count_mismatch(self):
        with self.assertRaises(ValueError):
            ss.block(SIX, 0.2104, 1.6, [0.2, 0.4])

    def test_default_unchanged(self):
        text, diel = ss.block(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'], 0.2104, 1.6)
        self.assertEqual(diel[0][1], 'prepreg')
        self.assertEqual(len(diel), 3)


if __name__ == '__main__':
    unittest.main()
