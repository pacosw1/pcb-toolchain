"""Unit tests of tools/router/model.py helpers. Needs the KiCad Python (model.py imports pcbnew):
  /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3 -m unittest test_model
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import model  # noqa: E402


class ViaCurrent(unittest.TestCase):
    def test_power_via_carries_the_net_current(self):
        # v8 (ESP32-CORE b4 paths_low: VIN_REG 2.1 A through one 0.3 mm via = 1.92 A at dT 20 K, plating 18 um)
        self.assertLess(model.pcbtool.via_amps(0.3, 0.018, 20), 2.1)
        dr, d = model.via_for_current(0.3, 0.6, 2.1, 0.018, 20)
        self.assertEqual((dr, d), (0.35, 0.65))
        self.assertGreaterEqual(model.pcbtool.via_amps(dr, 0.018, 20), 2.1)
        self.assertEqual(model.via_for_current(0.3, 0.6, 1.0, 0.018, 20), (0.3, 0.6))

    def test_plane_pad_of_a_high_current_chain_gets_a_larger_fanout_via(self):
        # v8b (ESP32-CORE c1 paths_low: GND J2.4 -> U3.6 2.1 A through the 0.3 mm fan-out via of U3.6)
        classes = {'Default': {'drill': 0.3, 'via': 0.6}}
        nets = {'GND': {'plane': True, 'class': 'Default', 'via': {'hole_size': 0.3, 'via_diameter': 0.6},
                        'power_chains': [{'pads': ['J2.4', 'U3.6'], 'amps': 2.1}, {'pads': ['C1.2', 'U1.1'], 'amps': 0.5}]},
                'VSYS': {'plane': False, 'class': 'Default', 'power_chains': [{'pads': ['J2.1', 'U2.3'], 'amps': 2.1}]}}
        self.assertEqual(model.plane_fanout_vias(nets, classes, 0.018, 20),
                         {'J2.4': (0.35, 0.65, 2.1), 'U3.6': (0.35, 0.65, 2.1)})

    def test_disallow_types(self):
        self.assertEqual(model.disallow_types(['constraint', 'disallow', 'track', 'via']), {'track', 'via'})
        self.assertEqual(model.disallow_types(['constraint', 'disallow', 'pad']), {'pad'})


if __name__ == '__main__':
    unittest.main()
