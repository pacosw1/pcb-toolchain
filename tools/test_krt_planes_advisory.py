#!/usr/bin/env python3
"""Tests for tools/krt_planes_advisory.py.

These tests cover only the pure parse/filter functions. They use a small
JSON fixture cut from a real KiCadRoutingTools check_impedance run, so they
need no KiCadRoutingTools clone and no PCB file.
Run with: python3 tools/test_krt_planes_advisory.py
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import krt_planes_advisory as krt

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def load_fixture(name):
    with open(os.path.join(FIXTURES, name)) as fh:
        return json.load(fh)


class VoidCrossingsTests(unittest.TestCase):
    def setUp(self):
        self.report = load_fixture("krt_impedance_sample.json")

    def test_keeps_only_void_crossings_at_or_above_threshold(self):
        crossings = krt.void_crossings(self.report, min_length_mm=1.0)
        self.assertEqual(len(crossings), 1)
        self.assertEqual(crossings[0]["net"], "SLOT_5V")
        self.assertEqual(crossings[0]["length_mm"], 1.0285)

    def test_drops_void_crossings_below_threshold(self):
        crossings = krt.void_crossings(self.report, min_length_mm=1.0)
        lengths = [c["length_mm"] for c in crossings]
        self.assertNotIn(0.6, lengths)

    def test_drops_split_crossings_even_when_long(self):
        crossings = krt.void_crossings(self.report, min_length_mm=1.0)
        nets = [c["net"] for c in crossings]
        # CHG_5V only has a 'split' crossing (an antipad, not a void); it must not appear
        self.assertNotIn("CHG_5V", nets)

    def test_custom_threshold(self):
        crossings = krt.void_crossings(self.report, min_length_mm=0.5)
        self.assertEqual(len(crossings), 2)

    def test_empty_report_yields_empty(self):
        self.assertEqual(krt.void_crossings({"nets": []}), [])

    def test_missing_nets_key_yields_empty(self):
        self.assertEqual(krt.void_crossings({}), [])


class FormatCrossingTests(unittest.TestCase):
    def test_formats_net_length_and_location(self):
        c = {
            "net": "SLOT_5V",
            "kind": "void",
            "layer": "F.Cu",
            "ref_layer": "In1.Cu",
            "x": 143.54,
            "y": 116.3685,
            "length_mm": 1.0285,
        }
        line = krt.format_crossing(c)
        self.assertIn("SLOT_5V", line)
        self.assertIn("1.028", line)
        self.assertIn("F.Cu", line)
        self.assertIn("In1.Cu", line)


if __name__ == "__main__":
    unittest.main()
