#!/usr/bin/env python3
"""Tests for the analytic global placement (tools/placer/gplace.py): WA wirelength, electrostatic density,
Nesterov with a growing density weight.

  $PY -m unittest discover -s tools/placer -p 'test_*.py'
"""
import os
import random
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import cost, gplace  # noqa: E402
from placer.test_cost import problem, random_problem, square_board, unit  # noqa: E402


def box_board(w, h):
    return {'outline': [[0, 0], [w, 0], [w, h], [0, h]], 'keepouts': [], 'edge_clearance': 0.0}


def clusters(seed=1, stacked=False):
    """Two groups of 4 units (2 x 2 mm); each group is a clique of heavy nets; one light net between them."""
    rng = random.Random(seed)
    us = []
    for i in range(8):
        x, y = (20.0, 10.0) if stacked else (rng.uniform(3, 37), rng.uniform(3, 17))
        us.append(unit('U%d' % i, x, y, [[-1, -1, 1, 1, 0.0]]))
    ns = []
    for g in (range(0, 4), range(4, 8)):
        g = list(g)
        for a in range(4):
            for b in range(a + 1, 4):
                ns.append({'name': 'N%d%d' % (g[a], g[b]), 'weight': 1.0,
                           'pins': [[g[a], -.1, -.1, .1, .1], [g[b], -.1, -.1, .1, .1]]})
    ns.append({'name': 'LINK', 'weight': 0.1, 'pins': [[0, -.1, -.1, .1, .1], [4, -.1, -.1, .1, .1]]})
    return problem(us, ns, board=box_board(40.0, 20.0))


class WirelengthTest(unittest.TestCase):
    def test_wa_gradient_equals_finite_difference(self):
        pr = random_problem(random.Random(4))
        m = gplace.Model(pr, {'gamma': 0.8})
        x, y = m.x0.copy(), m.y0.copy()
        v, gx, gy = m.wa(x, y)
        h = 1e-6
        for i in m.mov:
            for arr, g in ((x, gx), (y, gy)):
                arr[i] += h
                vp = m.wa(x, y)[0]
                arr[i] -= 2 * h
                vm = m.wa(x, y)[0]
                arr[i] += h
                self.assertAlmostEqual(g[i], (vp - vm) / (2 * h), places=4)
        self.assertTrue(np.all(gx[m.fix] == 0) and np.all(gy[m.fix] == 0))

    def test_wa_tends_to_hpwl_for_small_gamma(self):
        pr = random_problem(random.Random(5))
        m = gplace.Model(pr, {'gamma': 0.01})
        v = m.wa(m.x0, m.y0)[0]
        self.assertAlmostEqual(v, cost.hpwl(pr, cost.initial_pose(pr)), delta=0.05 * v)


class DensityTest(unittest.TestCase):
    def test_density_gradient_pushes_stacked_units_apart(self):
        pr = clusters(stacked=True)
        pr['units'][1]['x'] += 0.5  # U1 right of the stack centre
        m = gplace.Model(pr, {'bins': 32})
        e, gx, gy, ovf = m.density(m.x0, m.y0)
        self.assertGreater(ovf, 0.5)
        self.assertLess(gx[1], 0.0)  # descent (-gradient) moves U1 to the right, away from the stack

    def test_overflow_falls_over_the_iterations(self):
        res = gplace.place(clusters(stacked=True), {'bins': 32, 'iters': 400})
        ov = [h['overflow'] for h in res['history']]
        self.assertGreater(ov[0], 0.5)
        self.assertLess(ov[-1], 0.15)

    def test_fixed_units_and_the_board_edge_hold(self):
        pr = clusters()
        pr['units'][2]['fixed'] = True
        res = gplace.place(pr, {'bins': 32, 'iters': 300})
        self.assertEqual(tuple(res['pose'][2][:2]), (pr['units'][2]['x'], pr['units'][2]['y']))
        for (x, y, r), u in zip(res['pose'], pr['units']):
            self.assertTrue(1.0 - 1e-6 <= x <= 39.0 + 1e-6 and 1.0 - 1e-6 <= y <= 19.0 + 1e-6)
            self.assertEqual(r, 0)  # rotation is left to the annealer

    def test_an_edge_anchored_unit_ends_on_its_side(self):
        pr = clusters()
        pr['board']['edge_clearance'] = 0.5
        pr['units'][5]['edge'] = {'at': [0.0, 1.0], 'sides': 'B', 'tol': 0.5}  # its S side on the bottom edge
        res = gplace.place(pr, {'bins': 32, 'iters': 300})
        self.assertAlmostEqual(res['pose'][5][1] + 1.0, 20.0 - 0.5)


class RoutabilityTest(unittest.TestCase):
    """RePlAce: a unit in bins where RUDY is above the routing capacity (cost limit * layers / pitch mm of
    track per mm2) grows by the ratio, at most max_infl in area; a unit in free bins keeps its size."""

    def bundle(self):
        us = [unit('F1', 2, 10, [[-1, -1, 1, 1, 0.0]], fixed=True), unit('F2', 38, 10, [[-1, -1, 1, 1, 0.0]], fixed=True),
              unit('A', 20, 10, [[-1, -1, 1, 1, 0.0]]), unit('B', 20, 17, [[-1, -1, 1, 1, 0.0]])]
        ns = [{'name': 'N%d' % k, 'weight': 1.0, 'pins': [[0, -.1, -1.1, .1, -.9], [1, -.1, .9, .1, 1.1]]}
              for k in range(20)]
        return problem(us, ns, board=box_board(40.0, 20.0))

    def test_units_under_congestion_grow_and_free_units_do_not(self):
        m = gplace.Model(self.bundle(), {'bins': 32, 'max_infl': 2.0})
        f = m.inflate(m.x0, m.y0)
        self.assertAlmostEqual(f[2], 2.0)
        self.assertAlmostEqual(f[3], 1.0)
        self.assertAlmostEqual(m.area[2], 2.0 * 4.0)
        self.assertAlmostEqual(m.area[3], 4.0)

    def test_place_runs_the_inflation_rounds(self):
        res = gplace.place(self.bundle(), {'bins': 32, 'iters': 400, 'route_rounds': 2})
        self.assertEqual(sum(1 for h in res['history'] if h.get('inflated')), 2)


class ConvergeTest(unittest.TestCase):
    def test_two_clusters_converge(self):
        pr = clusters(seed=3)
        h0 = cost.hpwl(pr, cost.initial_pose(pr))
        res = gplace.place(pr, {'bins': 32, 'iters': 500})
        pose = res['pose']
        self.assertLess(cost.hpwl(pr, pose), 0.4 * h0)
        self.assertLess(res['history'][-1]['overflow'], 0.15)
        c = [np.mean([pose[i][:2] for i in g], axis=0) for g in (range(0, 4), range(4, 8))]
        spread = [max(np.hypot(pose[i][0] - c[k][0], pose[i][1] - c[k][1]) for i in g)
                  for k, g in enumerate((range(0, 4), range(4, 8)))]
        self.assertLess(max(spread), 4.0)  # each group stays together


if __name__ == '__main__':
    unittest.main()


class PipelineTest(unittest.TestCase):
    def test_optimize_with_global_starts_the_annealer_from_the_global_placement(self):
        from placer import anneal
        pr = clusters(seed=3)
        prm = {'global': 1, 'bins': 32, 'iters': 500, 'rudy_cell': 1.0, 'mask_cell': 0.25}
        g = gplace.place(pr, anneal.params_all(prm))
        res = anneal.optimize(pr, prm, workers=1, epochs=2, steps=300, seed=1, top=1)
        self.assertEqual([tuple(q) for q in res['initial']['pose']], [tuple(q) for q in g['pose']])
        self.assertEqual(res['global']['iters'], len(g['history']))
        self.assertLess(res['candidates'][0]['components']['hpwl'], cost.hpwl(pr, cost.initial_pose(pr)))
