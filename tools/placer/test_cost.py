#!/usr/bin/env python3
"""Unit tests for the placement cost (tools/placer/cost.py). Needs numpy, no pcbnew.

  $PY -m unittest discover -s tools/placer -p 'test_*.py'
  ($PY = the KiCad bundled Python; it has numpy and pcbnew.)
"""
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import cost  # noqa: E402


def unit(name, x, y, rects, fixed=False):
    return {'name': name, 'refs': [name], 'fixed': fixed, 'x': x, 'y': y, 'rects': rects}


def square_board(size=10.0, edge=0.0, keepouts=()):
    return {'outline': [[0, 0], [size, 0], [size, size], [0, size]],
            'keepouts': [list(k) for k in keepouts], 'edge_clearance': edge}


def problem(units, nets, board=None, region=None):
    return {'units': units, 'nets': nets, 'board': board or square_board(), 'region': region}


P = {'rudy_cell': 1.0, 'mask_cell': 0.25, 'layers': 1, 'pitch': 1.0, 'limit': 0.5,
     'w_wl': 1.0, 'w_cong': 1.0, 'w_ov': 1.0, 'w_oob': 1.0}


class RotationTest(unittest.TestCase):
    def test_r1_is_kicad_plus_90(self):
        # KiCad RotatePoint(+90 deg), y axis down: (x, y) -> (y, -x).
        self.assertEqual(cost.rot_pt(1.0, 0.0, 1), (0.0, -1.0))
        self.assertEqual(cost.rot_pt(1.0, 2.0, 2), (-1.0, -2.0))
        self.assertEqual(cost.rot_pt(1.0, 2.0, 3), (-2.0, 1.0))

    def test_rect_rotation_keeps_size_and_swaps_sides(self):
        self.assertEqual(cost.rot_rect((0, 0, 2, 1), 1), (0, -2, 1, 0))
        self.assertEqual(cost.rot_rect((0, 0, 2, 1), 2), (-2, -1, 0, 0))
        self.assertEqual(cost.rot_rect((0, 0, 2, 1), 3), (-1, 0, 0, 2))


class HpwlTest(unittest.TestCase):
    def test_two_points_is_dx_plus_dy(self):
        pr = problem([unit('A', 0, 0, [[-.5, -.5, .5, .5, .5]]), unit('B', 3, 4, [[-.5, -.5, .5, .5, .5]])],
                     [{'name': 'N', 'weight': 1.0, 'pins': [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]]}])
        pose = cost.initial_pose(pr)
        self.assertAlmostEqual(cost.hpwl(pr, pose), 7.0)

    def test_rotation_moves_pin(self):
        # Pin at local (1, 0); r = 1 puts it at (0, -1). Other pin at (0, 1): HPWL 0 + 2.
        pr = problem([unit('A', 0, 0, [[-1, -1, 1, 1, .5]]), unit('B', 0, 1, [[-.5, -.5, .5, .5, .5]])],
                     [{'name': 'N', 'weight': 1.0, 'pins': [[0, 1, 0, 1, 0], [1, 0, 0, 0, 0]]}])
        pose = cost.initial_pose(pr)
        pose[0] = (0.0, 0.0, 1)
        self.assertAlmostEqual(cost.hpwl(pr, pose), 2.0)

    def test_net_weight_scales(self):
        pr = problem([unit('A', 0, 0, [[0, 0, 1, 1, .5]]), unit('B', 2, 0, [[0, 0, 1, 1, .5]])],
                     [{'name': 'N', 'weight': 3.0, 'pins': [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]]}])
        self.assertAlmostEqual(cost.hpwl(pr, cost.initial_pose(pr)), 6.0)


class RudyTest(unittest.TestCase):
    def test_net_spreads_hpwl_over_its_box(self):
        # Pins at (1, 1) and (3, 3): box 2 x 2 mm = 4 cells, HPWL 4 -> 1 mm of wire per cell.
        pr = problem([unit('A', 1, 1, [[-.1, -.1, .1, .1, .5]]), unit('B', 3, 3, [[-.1, -.1, .1, .1, .5]])],
                     [{'name': 'N', 'weight': 1.0, 'pins': [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]]}])
        g = cost.rudy_grid(pr, cost.initial_pose(pr), P)
        self.assertAlmostEqual(float(g.sum()), 4.0)
        self.assertAlmostEqual(float(g[1:3, 1:3].sum()), 4.0)
        self.assertAlmostEqual(float(g.max()), 1.0)

    def test_overflow_above_limit(self):
        # Capacity per cell = 1 mm2 * 1 layer / 1 mm pitch = 1; limit 0.5 -> 0.5 over in each of 4 cells.
        pr = problem([unit('A', 1, 1, [[-.1, -.1, .1, .1, .5]]), unit('B', 3, 3, [[-.1, -.1, .1, .1, .5]])],
                     [{'name': 'N', 'weight': 1.0, 'pins': [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]]}])
        g = cost.rudy_grid(pr, cost.initial_pose(pr), P)
        self.assertAlmostEqual(cost.overflow(g, P, None), 2.0)

    def test_region_weight_multiplies_overflow_inside_box(self):
        pr = problem([unit('A', 1, 1, [[-.1, -.1, .1, .1, .5]]), unit('B', 3, 3, [[-.1, -.1, .1, .1, .5]])],
                     [{'name': 'N', 'weight': 1.0, 'pins': [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]]}],
                     region={'box': [1, 1, 2, 2], 'weight': 5.0, 'refs': []})
        g = cost.rudy_grid(pr, cost.initial_pose(pr), P)
        cw = cost.cell_weights(pr, P)
        self.assertAlmostEqual(cost.overflow(g, P, cw), 0.5 * 5 + 3 * 0.5)


class PinDemandTest(unittest.TestCase):
    def test_each_pad_adds_pin_demand_in_its_cell(self):
        a = unit('A', 1, 1, [[-.5, -.5, .5, .5, .5]])
        a['pads'] = [[.5, .5], [.5, .6], [-.5, -.5]]
        pr = problem([a], [])
        g = cost.rudy_grid(pr, cost.initial_pose(pr), dict(P, pin_demand=0.3))
        self.assertAlmostEqual(float(g[1, 1]), 0.6)
        self.assertAlmostEqual(float(g[0, 0]), 0.3)
        self.assertAlmostEqual(float(g.sum()), 0.9)

    def test_pads_turn_with_the_unit(self):
        a = unit('A', 5, 5, [[-.5, -.5, .5, .5, .5]])
        a['pads'] = [[1.5, 0.2]]
        pr = problem([a], [])
        g = cost.rudy_grid(pr, [(5.0, 5.0, 1)], dict(P, pin_demand=1.0))
        self.assertAlmostEqual(float(g[3, 5]), 1.0)  # (0.2, -1.5) + (5, 5) = (5.2, 3.5)


class FixedCopperTest(unittest.TestCase):
    # board['copper']: [layer, x0, y0, x1, y1, width]; layer 'via' = a via at (x0, y0), width = diameter.
    def test_track_on_a_routing_layer_uses_capacity(self):
        b = square_board()
        b['copper'] = [['F.Cu', 2.0, 5.5, 5.0, 5.5, 0.2]]
        pr = problem([], [], board=b)
        g = cost.fixed_grid(pr, dict(P, pitch=0.4, gap=0.2))
        # 3 mm of a 0.2 mm track + 0.2 mm gap = 3 * 0.4 / 0.4 = 3 mm of wire, in row 5, cells 2..4
        self.assertAlmostEqual(float(g.sum()), 3.0, places=2)
        self.assertAlmostEqual(float(g[5, 2:5].sum()), 3.0, places=2)

    def test_inner_layer_track_is_not_routing_capacity(self):
        b = square_board()
        b['copper'] = [['In1.Cu', 2.0, 5.5, 5.0, 5.5, 0.2]]
        self.assertAlmostEqual(float(cost.fixed_grid(problem([], [], board=b), P).sum()), 0.0)

    def test_via_uses_capacity_on_each_routing_layer(self):
        b = square_board()
        b['copper'] = [['via', 5.5, 5.5, 5.5, 5.5, 0.6]]
        g = cost.fixed_grid(problem([], [], board=b), dict(P, pitch=0.4, gap=0.2, layers=2))
        # (0.6 + 0.2)^2 / 0.4 per layer, 2 layers
        self.assertAlmostEqual(float(g[5, 5]), 2 * 0.64 / 0.4, places=6)

    def test_fixed_copper_counts_in_overflow_of_the_evaluator(self):
        b = square_board()
        b['copper'] = [['F.Cu', 0.0, 5.5, 10.0, 5.5, 0.2]]
        pr = problem([unit('A', 1, 1, [[-.1, -.1, .1, .1, .5]])], [], board=b)
        q = dict(P, pitch=0.4, gap=0.2, layers=1, limit=0.1)
        ev = cost.Evaluator(pr, q)
        self.assertGreater(ev.components()['cong'], 0)
        self.assertAlmostEqual(ev.cost, cost.total(pr, ev.pose(), q), places=6)

    def test_front_copper_and_vias_are_obstacles_back_copper_is_not(self):
        b = square_board()
        b['copper'] = [['F.Cu', 2.0, 5.0, 8.0, 5.0, 0.2], ['B.Cu', 2.0, 3.0, 8.0, 3.0, 0.2],
                       ['via', 5.0, 8.0, 5.0, 8.0, 0.6]]
        pr = problem([unit('A', 5, 5, [[-.5, -.5, .5, .5, .5]]), unit('B', 5, 3, [[-.5, -.5, .5, .5, .5]]),
                      unit('C', 5, 8, [[-.5, -.5, .5, .5, .5]]), unit('D', 5, 1.5, [[-.2, -.2, .2, .2, .5]])], [],
                     board=b)
        m = cost.Mask(pr['board'], 0.1, gap=0.2)
        pose = cost.initial_pose(pr)
        self.assertGreater(cost.forbidden(pr, pose, m, 0), 0)
        self.assertAlmostEqual(cost.forbidden(pr, pose, m, 1), 0.0)
        self.assertGreater(cost.forbidden(pr, pose, m, 2), 0)
        self.assertAlmostEqual(cost.forbidden(pr, pose, m, 3), 0.0)

    def test_copper_under_the_body_between_pads_is_no_obstacle_with_pad_rects(self):
        # a via under the body of a part, clear of its pads (as under an LQFP), is legal when pad_rects are known
        b = square_board()
        b['copper'] = [['via', 5.0, 5.0, 5.0, 5.0, 0.6]]
        a = unit('A', 5, 5, [[-2, -2, 2, 2, .5]])
        a['pad_rects'] = [[-2, -2, -1.5, 2], [1.5, -2, 2, 2]]
        pr = problem([a], [], board=b)
        m = cost.Mask(pr['board'], 0.1, gap=0.2)
        pose = cost.initial_pose(pr)
        self.assertAlmostEqual(cost.forbidden(pr, pose, m, 0), 0.0)
        self.assertAlmostEqual(cost.Evaluator(pr, P, mask=m).unit_penalty(0), 0.0)
        # a pad on the via is an obstacle, also after a turn of the unit
        a['pad_rects'] = [[-.5, -.5, .5, .5]]
        self.assertGreater(cost.forbidden(pr, pose, m, 0), 0)
        self.assertGreater(cost.Evaluator(pr, P, mask=m).penalty_at(0, 5, 5, 1), 0)
        # the courtyard still counts against the board edge
        a['pad_rects'] = []
        self.assertGreater(cost.Evaluator(pr, P, mask=m).penalty_at(0, 1, 5, 0), 0)
        self.assertAlmostEqual(cost.Evaluator(pr, P, mask=m).penalty_at(0, 5, 5, 0), 0.0)


class OverlapTest(unittest.TestCase):
    def test_pair_penalty_below_gap(self):
        a = [[0, 0, 1, 1, .5]]
        b = [[1.3, 0, 2.3, 1, .5]]
        # x: 1 - 1.3 + 0.5 = 0.2; y: 1 - 0 + 0.5 = 1.5 -> 0.3
        self.assertAlmostEqual(cost.pair_penalty(a, b), 0.3)
        self.assertAlmostEqual(cost.pair_penalty(a, [[1.6, 0, 2.6, 1, .5]]), 0.0)

    def test_ic_class_needs_larger_gap(self):
        self.assertAlmostEqual(cost.pair_penalty([[0, 0, 1, 1, 1.0]], [[1.6, 0, 2.6, 1, .5]]), 0.4 * 2.0)

    def test_overlap_total_counts_each_pair_once_and_skips_same_unit(self):
        pr = problem([unit('A', 0, 0, [[0, 0, 1, 1, .5], [0.5, 0, 1.5, 1, .5]]),
                      unit('B', 1.3, 0, [[0, 0, 1, 1, .5]])], [])
        # A-B: rect 1 x term 0.2 -> 0.3; rect 2: 1.5 - 1.3 + 0.5 = 0.7 -> 1.05. Inside A: not counted.
        self.assertAlmostEqual(cost.overlap(pr, cost.initial_pose(pr)), 1.35)

    def test_fixed_pairs_do_not_count(self):
        pr = problem([unit('A', 0, 0, [[0, 0, 1, 1, .5]], fixed=True),
                      unit('B', 0, 0, [[0, 0, 1, 1, .5]], fixed=True)], [])
        self.assertAlmostEqual(cost.overlap(pr, cost.initial_pose(pr)), 0.0)


class ForbiddenTest(unittest.TestCase):
    def test_edge_clearance_and_keepout(self):
        pr = problem([unit('A', 0.5, 0.5, [[-.5, -.5, .5, .5, .5]]),
                      unit('B', 2.5, 2.5, [[-.5, -.5, .5, .5, .5]]),
                      unit('C', 5.5, 5.5, [[-.5, -.5, .5, .5, .5]])], [],
                     board=square_board(10, edge=1.0, keepouts=[[[5, 5], [7, 5], [7, 7], [5, 7]]]))
        m = cost.Mask(pr['board'], P['mask_cell'])
        pose = cost.initial_pose(pr)
        self.assertAlmostEqual(cost.forbidden(pr, pose, m, 0), 1.0)
        self.assertAlmostEqual(cost.forbidden(pr, pose, m, 1), 0.0)
        self.assertAlmostEqual(cost.forbidden(pr, pose, m, 2), 1.0)

    def test_outside_the_grid_counts(self):
        pr = problem([unit('A', -20, -20, [[-.5, -.5, .5, .5, .5]])], [])
        m = cost.Mask(pr['board'], P['mask_cell'])
        self.assertAlmostEqual(cost.forbidden(pr, cost.initial_pose(pr), m, 0), 1.0)


def random_problem(rng, n=8, nets=10):
    units = []
    for i in range(n):
        w, h = rng.uniform(.5, 3), rng.uniform(.5, 3)
        rects = [[-w / 2, -h / 2, w / 2, h / 2, rng.choice([.5, 1.0])]]
        if i % 3 == 0:
            rects.append([w / 2, -h / 2, w / 2 + 1, h / 2, .5])
        units.append(unit('U%d' % i, rng.uniform(0, 20), rng.uniform(0, 20), rects, fixed=(i == 0)))
        units[-1]['pads'] = [[rng.uniform(-w / 2, w / 2), rng.uniform(-h / 2, h / 2)] for _ in range(rng.randint(0, 6))]
    ns = []
    for j in range(nets):
        us = rng.sample(range(n), rng.randint(2, 4))
        ns.append({'name': 'N%d' % j, 'weight': rng.choice([1.0, 2.0]),
                   'pins': [[u, rng.uniform(-1, 1), rng.uniform(-1, 1), 0, 0] for u in us]})
        for p in ns[-1]['pins']:
            p[3], p[4] = p[1] + .2, p[2] + .1
    return problem(units, ns, board=square_board(20, edge=1.0, keepouts=[[[8, 8], [12, 8], [12, 12], [8, 12]]]),
                   region={'box': [0, 0, 10, 10], 'weight': 2.0, 'refs': []})


class EvaluatorTest(unittest.TestCase):
    def test_incremental_equals_full_after_random_moves(self):
        rng = random.Random(7)
        pr = random_problem(rng)
        P = dict(globals()['P'], pin_demand=0.4, limit=0.05)
        ev = cost.Evaluator(pr, P)
        self.assertAlmostEqual(ev.cost, cost.total(pr, ev.pose(), P), places=6)
        for k in range(300):
            if k % 5 == 4:
                a, b = rng.sample(range(1, 8), 2)
                moves = [(a, ev.X[b], ev.Y[b], ev.R[a]), (b, ev.X[a], ev.Y[a], ev.R[b])]
            else:
                u = rng.randrange(1, 8)
                moves = [(u, rng.uniform(-2, 22), rng.uniform(-2, 22), rng.randrange(4))]
            ev.propose(moves)
            if rng.random() < .5:
                ev.commit()
            else:
                ev.revert()
            self.assertAlmostEqual(ev.cost, cost.total(pr, ev.pose(), P), places=5)

    def test_revert_restores_cost_and_pose(self):
        pr = random_problem(random.Random(3))
        ev = cost.Evaluator(pr, P)
        c0, p0 = ev.cost, ev.pose()
        ev.propose([(2, 1.0, 1.0, 3)])
        ev.revert()
        self.assertEqual(ev.pose(), p0)
        self.assertAlmostEqual(ev.cost, c0)

    def test_fixed_unit_move_is_rejected(self):
        pr = random_problem(random.Random(3))
        ev = cost.Evaluator(pr, P)
        with self.assertRaises(ValueError):
            ev.propose([(0, 1.0, 1.0, 0)])


if __name__ == '__main__':
    unittest.main()
