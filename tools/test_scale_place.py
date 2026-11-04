#!/usr/bin/env python3
"""Unit tests for the pure core of tools/scale_place.py (no pcbnew).

  python3 tools/test_scale_place.py
"""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('scale_place', os.path.join(HERE, 'scale_place.py'))
sp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sp)


def part(x, y, pads, nets):
    return {'pos': (x, y), 'pads': pads, 'nets': set(nets)}


class ScalePointTest(unittest.TestCase):
    def test_point_moves_away_from_center(self):
        self.assertEqual(sp.scale_pt((2, 1), (0, 1), 1.5), (3, 1))

    def test_center_stays(self):
        self.assertEqual(sp.scale_pt((5, 5), (5, 5), 2.0), (5, 5))


class GroupTest(unittest.TestCase):
    def test_cap_joins_near_ic_on_shared_net(self):
        parts = {'U1': part(10, 10, 20, ['VDD', 'GND']), 'C1': part(12, 10, 2, ['VDD', 'GND'])}
        self.assertEqual(sp.groups(parts, {'GND'}, 8.0), {'U1': 'U1', 'C1': 'U1'})

    def test_shared_ground_only_is_not_a_link(self):
        parts = {'U1': part(10, 10, 20, ['A', 'GND']), 'C1': part(12, 10, 2, ['B', 'GND'])}
        self.assertEqual(sp.groups(parts, {'GND'}, 8.0)['C1'], 'C1')

    def test_far_ic_is_not_an_anchor(self):
        parts = {'U1': part(10, 10, 20, ['VDD']), 'C1': part(30, 10, 2, ['VDD'])}
        self.assertEqual(sp.groups(parts, set(), 8.0)['C1'], 'C1')

    def test_nearest_of_two_ics(self):
        parts = {'U1': part(0, 0, 8, ['S']), 'U2': part(6, 0, 8, ['S']), 'R1': part(5, 0, 2, ['S'])}
        self.assertEqual(sp.groups(parts, set(), 8.0)['R1'], 'U2')


class PlaceTest(unittest.TestCase):
    def test_edge_part_keeps_distance_to_its_edge(self):
        # box 0..10, center 5,5; part 1 mm in from the left edge; x2 puts the left edge at -5
        new = sp.new_positions({'J1': part(1, 5, 4, [])}, {'J1': 'J1'}, (0, 0, 10, 10), 2.0, {'J1'})
        self.assertEqual(new['J1'], (-4, 5))

    def test_inner_anchor_scales(self):
        new = sp.new_positions({'U1': part(7, 5, 8, [])}, {'U1': 'U1'}, (0, 0, 10, 10), 2.0, set())
        self.assertEqual(new['U1'], (9, 5))

    def test_member_keeps_offset_to_anchor(self):
        parts = {'U1': part(7, 5, 8, ['V']), 'C1': part(8, 6, 2, ['V'])}
        new = sp.new_positions(parts, {'U1': 'U1', 'C1': 'U1'}, (0, 0, 10, 10), 2.0, set())
        self.assertEqual(new['C1'], (10, 6))


if __name__ == '__main__':
    unittest.main()
