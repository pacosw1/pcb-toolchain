#!/usr/bin/env python3
"""Unit tests for the pure core of tools/congestion.py (no pcbnew).

  python3 tools/test_congestion.py
"""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('congestion', os.path.join(HERE, 'congestion.py'))
cg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cg)


class MstTest(unittest.TestCase):
    def test_two_pins_one_edge(self):
        self.assertEqual(cg.mst([(0, 0), (3, 4)]), [((0, 0), (3, 4))])

    def test_square_three_edges_length_3(self):
        e = cg.mst([(0, 0), (1, 0), (0, 1), (1, 1)])
        self.assertEqual(len(e), 3)
        self.assertAlmostEqual(sum(cg.dist(a, b) for a, b in e), 3.0)

    def test_one_pin_no_edge(self):
        self.assertEqual(cg.mst([(5, 5)]), [])


class RudyTest(unittest.TestCase):
    def test_demand_total_is_mst_length(self):
        g = cg.rudy({'A': [(1, 1), (9, 1)], 'B': [(2, 2), (2, 8), (8, 8)]}, (0, 0, 10, 10), 1.0)
        self.assertAlmostEqual(sum(map(sum, g)), 8.0 + 12.0, places=6)

    def test_demand_only_inside_bbox(self):
        g = cg.rudy({'A': [(0.5, 0.5), (2.5, 2.5)]}, (0, 0, 10, 10), 1.0)
        self.assertEqual(g[5][5], 0)
        self.assertGreater(g[1][1], 0)

    def test_flat_net_gets_one_cell_height(self):
        g = cg.rudy({'A': [(0.5, 3.5), (4.5, 3.5)]}, (0, 0, 10, 10), 1.0)
        self.assertAlmostEqual(sum(g[3]), 4.0, places=6)
        self.assertEqual(sum(g[2]) + sum(g[4]), 0)


class UtilTest(unittest.TestCase):
    def test_capacity_from_layers_and_pitch(self):
        # 1 mm cell, 2 layers, 0.5 mm track pitch: 2 tracks of 1 mm per layer = 4 mm of wire
        self.assertAlmostEqual(cg.capacity(1.0, 2, 0.5), 4.0)

    def test_hotspots_sorted_above_limit(self):
        u = [[0.5, 1.5], [2.0, 0.9]]
        self.assertEqual(cg.hotspots(u, (0, 0), 1.0, 1.0), [(2.0, 0.5, 1.5), (1.5, 1.5, 0.5)])


class BlockageTest(unittest.TestCase):
    def test_smd_pad_blocks_its_layer_share(self):
        # a 1x1 mm pad on 1 of 3 layers fills one cell: one third of the capacity is blocked
        b = cg.blockage([(0, 0, 1, 1, 1)], (0, 0, 2, 2), 1.0, 3)
        self.assertAlmostEqual(b[0][0], 1 / 3)
        self.assertEqual(b[1][1], 0)

    def test_blockage_capped_at_one(self):
        b = cg.blockage([(0, 0, 1, 1, 3), (0, 0, 1, 1, 3)], (0, 0, 1, 1), 1.0, 3)
        self.assertAlmostEqual(b[0][0], 1.0)

    def test_blocked_cell_raises_utilization(self):
        _, free = cg.score({'A': [(0.5, 0.5), (1.5, 0.5)]}, (0, 0, 2, 1), 1.0, 1, 0.5, 1.0)
        _, half = cg.score({'A': [(0.5, 0.5), (1.5, 0.5)]}, (0, 0, 2, 1), 1.0, 1, 0.5, 1.0,
                           block=[(0, 0, 0.5, 1, 1)])
        self.assertGreater(half['max_util'], free['max_util'])


class CrossingTest(unittest.TestCase):
    def test_x_crossing_counts_once(self):
        self.assertEqual(cg.crossings({'A': [((0, 0), (2, 2))], 'B': [((0, 2), (2, 0))]}), 1)

    def test_parallel_no_crossing(self):
        self.assertEqual(cg.crossings({'A': [((0, 0), (2, 0))], 'B': [((0, 1), (2, 1))]}), 0)

    def test_same_net_not_counted(self):
        self.assertEqual(cg.crossings({'A': [((0, 0), (2, 2)), ((0, 2), (2, 0))]}), 0)

    def test_shared_end_point_not_a_crossing(self):
        self.assertEqual(cg.crossings({'A': [((0, 0), (1, 1))], 'B': [((1, 1), (2, 0))]}), 0)


if __name__ == '__main__':
    unittest.main()
