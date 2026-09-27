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

    def test_legal_penalty_ignores_kept_copper_but_not_the_edge(self):
        # the writer rips up kept copper that a moved pad lands on: copper is a cost, not a legality rule
        b = square_board()
        b['copper'] = [['via', 5.0, 5.0, 5.0, 5.0, 0.6]]
        a = unit('A', 5, 5, [[-1, -1, 1, 1, .5]])
        a['pad_rects'] = [[-.5, -.5, .5, .5]]
        ev = cost.Evaluator(problem([a], [], board=b), P)
        self.assertGreater(ev.unit_penalty(0), 0)
        self.assertAlmostEqual(ev.legal_penalty(0), 0.0)
        self.assertAlmostEqual(ev.legal_penalty_at(0, 5, 5, 1), 0.0)
        self.assertGreater(ev.legal_penalty_at(0, 0.5, 5, 0), 0)


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
        # Hard: only rect 2 meets B (0.2 x 1 = 0.2); the rest of the D-040 halo is soft spacing.
        self.assertAlmostEqual(cost.overlap(pr, cost.initial_pose(pr)), 0.2)
        self.assertAlmostEqual(cost.spacing(pr, cost.initial_pose(pr)), 1.15)

    def test_fixed_pairs_do_not_count(self):
        pr = problem([unit('A', 0, 0, [[0, 0, 1, 1, .5]], fixed=True),
                      unit('B', 0, 0, [[0, 0, 1, 1, .5]], fixed=True)], [])
        self.assertAlmostEqual(cost.overlap(pr, cost.initial_pose(pr)), 0.0)


class ForbiddenTest(unittest.TestCase):
    def test_edge_clearance_and_keepout(self):
        a = unit('A', 0.5, 0.5, [[-.5, -.5, .5, .5, .5]])
        a['pad_rects'] = [[-.5, -.5, .5, .5]]  # the band is for copper (pads) only
        pr = problem([a,
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
        if i % 3 == 0:
            units[-1]['hard'] = [1]
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


class SoftSpacingTest(unittest.TestCase):
    """Hard (illegal) = what KiCad DRC enforces: courtyard overlap, and the gap of a rect in u['hard'] (a pad
    with its net-class or .kicad_dru clearance). The D-040 halo of a courtyard is a soft cost (w_sp)."""

    def pr(self, hard=False):
        a = unit('A', 5.0, 5.0, [[-1, -1, 1, 1, 0.5], [-0.5, -0.5, 0.5, 0.5, 1.5]])
        if hard:
            a['hard'] = [1]
        return problem([a, unit('B', 7.3, 5.0, [[-1, -1, 1, 1, 0.5]])], [], square_board(20.0))

    def test_d040_halo_is_soft_and_legal(self):
        pr = self.pr()
        c = cost.components(pr, cost.initial_pose(pr), P)
        self.assertAlmostEqual(c['overlap'], 0.0)
        self.assertGreater(c['spacing'], 0.0)
        ev = cost.Evaluator(pr, dict(P, w_sp=3.0))
        self.assertAlmostEqual(ev.legal_penalty(1), 0.0)
        self.assertAlmostEqual(ev.components()['spacing'], c['spacing'])
        self.assertAlmostEqual(ev.cost, cost.total(pr, ev.pose(), dict(P, w_sp=3.0)))

    def test_a_pad_clearance_rect_is_hard(self):
        pr = self.pr(hard=True)  # pad edge 5.5, B courtyard 6.3: 0.8 < 1.5
        self.assertGreater(cost.components(pr, cost.initial_pose(pr), P)['overlap'], 0.0)
        self.assertGreater(cost.Evaluator(pr, P).legal_penalty(1), 0.0)


class EvaluatorTest(unittest.TestCase):
    def test_incremental_equals_full_after_random_moves(self):
        rng = random.Random(7)
        pr = random_problem(rng)
        P = dict(globals()['P'], pin_demand=0.4, limit=0.05, w_sp=2.0)
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


class EdgeAnchorTest(unittest.TestCase):
    """A unit with 'edge' {'at': local point, 'sides': 'LRTB' subset, 'tol'} must have that point on one of
    the sides (inner edge line = outline box minus edge_clearance); the miss in mm counts as forbidden area."""

    def pr(self, x, sides='L'):
        u = unit('J', x, 10.0, [[-1, -1, 1, 1, 0.0]])
        u['edge'] = {'at': [-1.0, 0.0], 'sides': sides, 'tol': 0.5}
        return problem([u], [], square_board(20.0, edge=1.0))

    def test_anchor_on_an_allowed_side_is_free_and_a_miss_costs_its_distance(self):
        self.assertAlmostEqual(cost.components(self.pr(2.0), [(2.0, 10.0, 0)], P)['oob'], 0.0)
        self.assertAlmostEqual(cost.components(self.pr(5.0), [(5.0, 10.0, 0)], P)['oob'], 2.5)

    def test_turned_unit_moves_its_anchor(self):
        # r = 2 puts the anchor on the right of the unit: at x = 17 it touches the right line x = 19 ... 18
        self.assertAlmostEqual(cost.components(self.pr(18.0, 'R'), [(18.0, 10.0, 2)], P)['oob'], 0.0)
        self.assertAlmostEqual(cost.components(self.pr(18.0, 'L'), [(18.0, 10.0, 2)], P)['oob'], 17.5)

    def test_evaluator_and_legality_agree_with_the_full_cost(self):
        pr = self.pr(5.0)
        ev = cost.Evaluator(pr, P)
        self.assertAlmostEqual(ev.components()['oob'], 2.5)
        self.assertAlmostEqual(ev.legal_penalty(0), 2.5)
        self.assertAlmostEqual(ev.legal_penalty_at(0, 2.0, 10.0, 0), 0.0)
        d = ev.propose([(0, 2.0, 10.0, 0)])
        self.assertAlmostEqual(d, -2.5)


class KeepoutRectTest(unittest.TestCase):
    """u['ko'] = indices of rects that are copper-free rule areas (an antenna keepout). A keepout may overlap
    another keepout (a board keepout or a keepout rect of an other unit); a courtyard in it is illegal."""

    def pr(self, bx):
        # A: a part at (5, 5) plus a keepout rect to its right; B: a part at bx with its own keepout rect
        a = unit('A', 5.0, 5.0, [[-1, -1, 1, 1, 0.5], [1, -1, 4, 1, 0.0]])
        a['ko'] = [1]
        b = unit('B', bx, 5.0, [[-1, -1, 1, 1, 0.5], [-4, -1, -1, 1, 0.0]])
        b['ko'] = [1]
        return problem([a, b], [], square_board(30.0, keepouts=[[[7, 3], [9, 3], [9, 7], [7, 7]]]))

    def test_keepout_over_keepout_is_legal(self):
        pr = self.pr(12.0)  # A keepout 6..9 over the board keepout 7..9 and over B keepout 8..11
        pose = cost.initial_pose(pr)
        c = cost.components(pr, pose, P)
        self.assertAlmostEqual(c['overlap'], 0.0)
        self.assertAlmostEqual(c['oob'], 0.0)
        ev = cost.Evaluator(pr, P)
        self.assertAlmostEqual(ev.legal_penalty(0), 0.0)
        self.assertAlmostEqual(ev.unit_penalty(1), 0.0)

    def test_courtyard_in_a_keepout_rect_stays_illegal(self):
        pr = self.pr(9.5)  # B courtyard 8.5..10.5 is in A keepout 6..9
        ev = cost.Evaluator(pr, P)
        self.assertGreater(ev.legal_penalty(1), 0.0)
        self.assertGreater(cost.components(pr, cost.initial_pose(pr), P)['overlap'], 0.0)


class DomainRectTest(unittest.TestCase):
    """u['dom'] = [[rect index, class id, gap to another class of the domain, net-class clearance], ...]: a pad
    of a domain (mains) with rect clr = the gap to the other nets (8 mm, .kicad_dru). Two domain rects keep the
    other-class gap (3 mm) or, same class, the net-class clearance. A rect with no pad of its own (u['mech']: a
    block border, the courtyard of a part whose pads have their own rects, a part with no net pads) and a
    keepout rect (a slot: the creepage barrier) keep only their own class to a domain rect."""

    def mains(self, name, x, cls):
        u = unit(name, x, 20.0, [[-1, -1, 1, 1, 0.5], [-0.5, -0.5, 0.5, 0.5, 8.0]])
        u['dom'] = [[1, cls, 3.0, 0.5]]
        u['mech'] = [0]
        return u

    def overlap(self, units):
        pr = problem(units, [], square_board(60.0))
        return cost.components(pr, cost.initial_pose(pr), P)['overlap']

    def test_other_nets_keep_the_domain_gap(self):
        selv = lambda x: unit('R', x, 20.0, [[-1, -1, 1, 1, 0.5]])
        self.assertGreater(self.overlap([self.mains('K1', 10.0, 1), selv(10.0 + 0.5 + 6.7 + 1)]), 0.0)
        self.assertAlmostEqual(self.overlap([self.mains('K1', 10.0, 1), selv(10.0 + 0.5 + 8.1 + 1)]), 0.0)

    def test_two_domain_classes_keep_the_class_gap_and_one_class_the_net_clearance(self):
        # pad edges 4 mm apart; courtyards stay 2 mm apart
        self.assertAlmostEqual(self.overlap([self.mains('K1', 10.0, 1), self.mains('K2', 15.0, 2)]), 0.0)
        self.assertGreater(self.overlap([self.mains('K1', 10.0, 1), self.mains('K2', 12.8, 2)]), 0.0)
        self.assertAlmostEqual(self.overlap([self.mains('K1', 10.0, 1), self.mains('J1', 12.8, 1)]), 0.0)

    def test_a_block_border_rect_keeps_its_own_class_only(self):
        b = unit('B', 20.0, 20.0, [[-1, -1, 1, 1, 0.5], [-8, -2, 8, 2, 0.0]])  # its part 8.5 mm from the pad
        b['mech'] = [1]
        self.assertAlmostEqual(self.overlap([self.mains('K1', 10.0, 1), b]), 0.0)  # pad 1.5 mm from the border
        pr = problem([self.mains('K1', 10.0, 1), b], [], square_board(60.0))
        self.assertAlmostEqual(cost.Evaluator(pr, P).components()['overlap'], 0.0)
        b = unit('B', 19.6, 20.0, [[7, -1, 9, 1, 0.5], [-8, -2, 8, 2, 0.0]])  # border 1.1 mm from the pad
        b['mech'] = [1]
        self.assertAlmostEqual(self.overlap([self.mains('K1', 10.0, 1), b]), 0.0)

    def test_a_hole_rule_keeps_its_gap_to_domain_pads_only(self):
        h = unit('H', 20.0, 20.0, [[-2, -2, 2, 2, 0.0], [-1, -1, 1, 1, 0.0]], fixed=True)  # courtyard, NPTH hole
        h['dom'] = [[1, -1, 9.65, 0.0]]
        h['mech'] = [0]
        self.assertGreater(self.overlap([self.mains('K1', 10.0, 1), h]), 0.0)  # pad 8.5 mm from the hole
        self.assertAlmostEqual(self.overlap([self.mains('K1', 8.0, 1), h]), 0.0)  # 10.5 mm
        r = unit('R', 16.0, 20.0, [[-1, -1, 1, 1, 0.5]])
        self.assertAlmostEqual(self.overlap([r, h]), 0.0)  # other parts: courtyard rule only
        pr = problem([self.mains('K1', 10.0, 1), h], [], square_board(60.0))
        self.assertGreater(cost.Evaluator(pr, P).components()['overlap'], 0.0)  # the pair search sees 9.65 mm

    def test_a_slot_next_to_a_domain_pad_is_legal(self):
        s = unit('S', 12.6, 30.0, [[-1, -1, 1, 1, 0.5], [-1, -11, 1, -9, 0.0]])  # slot 1.1 mm from the pad
        s['ko'] = [1]
        self.assertAlmostEqual(self.overlap([self.mains('K1', 10.0, 1), s]), 0.0)


class OwnKeepoutOverhangTest(unittest.TestCase):
    """A courtyard may leave the outline only inside a keepout rect of its own unit (u['ko']: an antenna zone moved
    with --zone-ref, BASE-PWR U1_ANTENNA over the outline notch). Elsewhere the part outside is illegal."""

    def legal(self, ko_rect):
        u = unit('U1', 10.0, 18.0, [[-3, -3, 3, 3, 0.0]])  # 1 mm over the bottom edge (y 20)
        if ko_rect:
            u['rects'].append(ko_rect + [0.0])
            u['ko'] = [1]
        return cost.Evaluator(problem([u], [], square_board(20.0)), P).legal_penalty(0)

    def test_the_overhang_inside_its_own_keepout_is_legal(self):
        self.assertAlmostEqual(self.legal([-4, 1.5, 4, 6]), 0.0)

    def test_the_overhang_without_a_keepout_is_illegal(self):
        self.assertGreater(self.legal(None), 0.0)

    def test_the_overhang_beyond_its_keepout_is_illegal(self):
        self.assertGreater(self.legal([-1, 1.5, 1, 6]), 0.0)  # the keepout covers 2 of the 6 mm


class NoCopperPartTest(unittest.TestCase):
    """u['nocu']: a part with no copper pad (an NPTH mounting hole). A keepout rect of another unit may cover it
    (BASE-PWR H1 inside U1_ANTENNA: the rule area forbids copper, not footprints); a normal part may not."""

    def overlap(self, other_ko):
        a = unit('U1', 10.0, 10.0, [[-1, -1, 1, 1, 0.0], [-5, -5, 5, 5, 0.0]])
        a['ko'] = [1] if other_ko else []
        h = unit('H1', 13.0, 10.0, [[-1, -1, 1, 1, 0.0]], fixed=True)
        h['nocu'] = True
        return cost.Evaluator(problem([a, h], [], square_board(30.0)), P).legal_penalty(0)

    def test_a_keepout_over_a_no_copper_part_is_legal(self):
        self.assertAlmostEqual(self.overlap(True), 0.0)

    def test_a_courtyard_over_a_no_copper_part_is_illegal(self):
        self.assertGreater(self.overlap(False), 0.0)


class LockedCopperTest(unittest.TestCase):
    """board['fixed_copper']: locked tracks and vias. The writer never removes them, so a pad over one is illegal.
    A courtyard (no pad) over one is legal: a part body may cover a track."""

    def legal(self, pad_x):
        u = unit('A', 10.0, 10.0, [[-2, -1, 2, 1, 0.0]])
        u['pad_rects'] = [[pad_x - 10.25, -0.25, pad_x - 9.75, 0.25]]
        board = dict(square_board(20.0), fixed_copper=[['F.Cu', 11.5, 5.0, 11.5, 15.0, 0.2]])
        return cost.Evaluator(problem([u], [], board), P).legal_penalty(0)

    def test_a_pad_over_fixed_copper_is_illegal(self):
        self.assertGreater(self.legal(11.5), 0.0)

    def test_a_courtyard_over_fixed_copper_is_legal(self):
        self.assertAlmostEqual(self.legal(8.5), 0.0)


class RoundRectTest(unittest.TestCase):
    """u['rho'] = [[rect index, radius]]: a round courtyard (a test point) is its box with corners rounded by the
    radius (a circle when the box is square). The clearance is measured to the circle, as KiCad DRC."""

    def overlap(self, dx, dy):
        a = unit('A', 10.0, 10.0, [[-1.3, -1.3, 1.3, 1.3, 0.0]])
        b = unit('B', 10.0 + dx, 10.0 + dy, [[-1.8, -1.8, 1.8, 1.8, 0.0]])
        a['rho'], b['rho'] = [[0, 1.3]], [[0, 1.8]]
        pr = problem([a, b], [], square_board(40.0))
        return cost.components(pr, cost.initial_pose(pr), P)['overlap'], cost.Evaluator(pr, P).components()['overlap']

    def test_circles_apart_on_a_diagonal_are_legal(self):
        for v in self.overlap(1.0, 2.94):  # centres 3.105 apart, radii 3.1
            self.assertAlmostEqual(v, 0.0)

    def test_circles_that_meet_are_illegal(self):
        for v in self.overlap(1.0, 2.8):  # centres 2.97 apart
            self.assertGreater(v, 0.0)


class EdgeBandTest(unittest.TestCase):
    """The copper-to-edge clearance (edge_clearance) applies to pads only. A courtyard or a block border only
    stays inside the outline. A block has no pad_rects: its edge_pads are the copper for the edge test."""

    def legal(self, u):
        pr = problem([u], [], square_board(20.0, edge=0.5))
        return cost.Evaluator(pr, P).legal_penalty(0)

    def part(self, pad_x0, key='pad_rects'):  # courtyard 0.2 mm from the left edge
        u = unit('A', 5.0, 10.0, [[-4.8, -1, 1, 1, 0.0]])
        u[key] = [[pad_x0 - 5.0, -0.5, pad_x0 - 4.0, 0.5]]
        return u

    def test_a_courtyard_in_the_band_is_legal(self):
        self.assertAlmostEqual(self.legal(self.part(2.0)), 0.0)
        self.assertAlmostEqual(self.legal(self.part(2.0, 'edge_pads')), 0.0)

    def test_a_pad_in_the_band_is_illegal(self):
        self.assertGreater(self.legal(self.part(0.25)), 0.0)
        self.assertGreater(self.legal(self.part(0.25, 'edge_pads')), 0.0)

    def test_a_courtyard_outside_the_outline_is_illegal(self):
        u = self.part(2.0)
        u['x'] = 4.0
        self.assertGreater(self.legal(u), 0.0)


class CornerGapTest(unittest.TestCase):
    """KiCad DRC measures a clearance as the true distance. Two rects offset on both axes (a corner) are legal
    when that distance is at least the gap, even if the gap-inflated boxes overlap (INPUT-4D2A U14 to U3:
    dx 2.66, dy 3.20, distance 4.17 mm, barrier 4 mm)."""

    def overlap(self, dx, dy):
        a = unit('A', 10.0, 10.0, [[0, 0, 1, 1, 4.0]])
        b = unit('B', 11.0 + dx, 11.0 + dy, [[0, 0, 1, 1, 4.0]])
        a['hard'] = b['hard'] = [0]
        pr = problem([a, b], [], square_board(40.0))
        return cost.components(pr, cost.initial_pose(pr), P)['overlap'], cost.Evaluator(pr, P).components()['overlap']

    def test_a_corner_farther_than_the_gap_is_legal(self):
        for v in self.overlap(2.66, 3.20):
            self.assertAlmostEqual(v, 0.0)

    def test_a_corner_nearer_than_the_gap_is_illegal(self):
        for v in self.overlap(2.5, 2.8):  # distance 3.75
            self.assertGreater(v, 0.0)

    def test_one_axis_apart_keeps_the_box_penalty(self):
        for v in self.overlap(3.0, -0.5):
            self.assertAlmostEqual(v, 1.0 * 4.5)  # x: 4 - 3 mm, y: 0.5 mm overlap + 4 mm


class BorderSoftTest(unittest.TestCase):
    """A block border (u['border'], User.1) is not checked by KiCad DRC: border over border and border over a
    foreign part are a soft cost. Courtyard over courtyard stays hard."""

    def block(self, name, x):  # courtyard 2 x 2 mm inside a border 6 x 6 mm
        u = unit(name, x, 10.0, [[-1, -1, 1, 1, 0.0], [-3, -3, 3, 3, 0.0]])
        u['border'] = [1]
        return u

    def check(self, units, hard):
        pr = problem(units, [], square_board(40.0))
        c, ev = cost.components(pr, cost.initial_pose(pr), P), cost.Evaluator(pr, P)
        for comp in (c, ev.components()):
            (self.assertGreater if hard else self.assertAlmostEqual)(comp['overlap'], 0.0)
            self.assertGreater(comp['spacing'], 0.0)
        self.assertEqual(ev.legal_penalty(1) > 0, hard)

    def test_border_over_border_is_soft(self):
        self.check([self.block('A', 10.0), self.block('B', 14.0)], hard=False)

    def test_border_over_a_foreign_part_is_soft(self):
        self.check([self.block('A', 10.0), unit('R', 12.5, 10.0, [[-1, -1, 1, 1, 0.0]])], hard=False)

    def test_courtyard_over_courtyard_stays_hard(self):
        self.check([self.block('A', 10.0), unit('R', 11.5, 10.0, [[-1, -1, 1, 1, 0.0]])], hard=True)


class ClassGapTableTest(unittest.TestCase):
    """pr['class_gaps'] = {'names', 'gaps'}: the gap between two domain classes (ids 1..n) from the .kicad_dru, for
    example the IO-6X6 barrier FIELD/FIELD_PWR to HOST/HOST_PWR 4 mm. A pad of such a class keeps only its net-class
    clearance to other nets."""

    def pad(self, name, x, cls):
        u = unit(name, x, 20.0, [[-1, -1, 1, 1, 0.5], [-0.5, -0.5, 0.5, 0.5, 0.2]])
        u['dom'] = [[1, cls, 0.0, 0.2]]
        u['mech'] = [0]
        return u

    def overlap(self, units):
        pr = problem(units, [], square_board(60.0))
        pr['class_gaps'] = {'names': ['FIELD', 'HOST'], 'gaps': [[0, 0, 0], [0, 0, 4.0], [0, 4.0, 0]]}
        return cost.Evaluator(pr, P).components()['overlap']

    def test_the_two_sets_keep_the_barrier_gap(self):
        self.assertGreater(self.overlap([self.pad('A', 10.0, 1), self.pad('B', 14.0, 2)]), 0.0)  # pads 3 mm
        self.assertAlmostEqual(self.overlap([self.pad('A', 10.0, 1), self.pad('B', 15.2, 2)]), 0.0)  # 4.2 mm

    def test_one_set_to_other_nets_keeps_the_net_clearance(self):
        self.assertAlmostEqual(self.overlap([self.pad('A', 10.0, 1), unit('R', 12.3, 20.0, [[-1, -1, 1, 1, 0.5]])]),
                               0.0)
        self.assertAlmostEqual(self.overlap([self.pad('A', 10.0, 1), self.pad('C', 12.5, 1)]), 0.0)

    def test_two_classes_without_a_rule_keep_the_net_clearance(self):
        def edge_pad(name, x, cls):  # the pad fills the courtyard: only the pad gap is left
            u = unit(name, x, 20.0, [[-1, -1, 1, 1, 0.0], [-1, -1, 1, 1, 0.2]])
            u['dom'], u['mech'] = [[1, cls, 0.0, 0.2]], [0]
            return u
        pr = problem([edge_pad('A', 10.0, 1), edge_pad('B', 12.1, 3)], [], square_board(60.0))  # 0.1 mm apart
        pr['class_gaps'] = {'names': ['', 'FIELD', 'HOST', 'OTHER'], 'gaps': [[0.0] * 4 for _ in range(4)]}
        self.assertGreater(cost.Evaluator(pr, P).components()['overlap'], 0.0)


class ParseDomainTest(unittest.TestCase):
    def test_domain_option_gives_pattern_gap_and_class_gap(self):
        from placer import cli
        self.assertEqual(cli.parse_domains(['MAINS_K*:8:3']), [('MAINS_K*', 8.0, 3.0)])
        with self.assertRaises(SystemExit):
            cli.parse_domains(['MAINS_K*:8'])


if __name__ == '__main__':
    unittest.main()
