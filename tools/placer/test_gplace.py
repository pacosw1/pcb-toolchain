#!/usr/bin/env python3
"""Tests for the analytic global placement (tools/placer/gplace.py): WA wirelength, electrostatic density,
Nesterov with a growing density weight.

  $PY -m unittest discover -s tools/placer -p 'test_*.py'
"""
import math
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

    def test_a_wide_track_net_adds_track_over_pitch_times_the_demand(self):
        pr = self.bundle()
        m = gplace.Model(pr, {'bins': 32, 'pitch': 0.4, 'tracks': 1.0})
        r1 = m.rudy(m.x0, m.y0)
        for n in pr['nets']:
            n['track'] = 0.7
        m = gplace.Model(pr, {'bins': 32, 'pitch': 0.4, 'tracks': 1.0})
        np.testing.assert_allclose(m.rudy(m.x0, m.y0), 1.75 * r1)

    def test_place_runs_the_inflation_rounds(self):
        res = gplace.place(self.bundle(), {'bins': 32, 'iters': 400, 'route_rounds': 2})
        self.assertEqual(sum(1 for h in res['history'] if h.get('inflated')), 2)


class ConvergeTest(unittest.TestCase):
    def test_two_clusters_converge(self):
        pr = clusters(seed=3)
        h0 = cost.hpwl(pr, cost.initial_pose(pr))
        runs = [gplace.place(pr, {'bins': 32, 'iters': 500, 'seed': s}) for s in range(1, 6)]
        self.assertLess(np.median([cost.hpwl(pr, r['pose']) for r in runs]), 0.45 * h0)  # median of 5 seeds
        spreads = []
        for res in runs:
            pose = res['pose']
            self.assertLess(res['history'][-1]['overflow'], 0.15)
            c = [np.mean([pose[i][:2] for i in g], axis=0) for g in (range(0, 4), range(4, 8))]
            spreads.append(max(np.hypot(pose[i][0] - c[k][0], pose[i][1] - c[k][1])
                               for k, g in enumerate((range(0, 4), range(4, 8))) for i in g))
        self.assertLess(np.median(spreads), 4.5)  # each group stays together


if __name__ == '__main__':
    unittest.main()


class SpectralSeedTest(unittest.TestCase):
    """NS-Place seed: x, y = the 2nd and 3rd eigenvectors of the clique-model Laplacian of the units, scaled to
    the outline box; of the 8 flips and turns, the one with the lowest HPWL (fixed units stay)."""

    def test_the_seed_separates_the_clusters(self):
        pr = clusters(seed=3)
        pose = gplace.spectral_pose(pr)
        c = [np.mean([pose[i][:2] for i in g], axis=0) for g in (range(0, 4), range(4, 8))]
        spread = max(np.hypot(pose[i][0] - c[k][0], pose[i][1] - c[k][1])
                     for k, g in enumerate((range(0, 4), range(4, 8))) for i in g)
        self.assertGreater(np.hypot(*(c[0] - c[1])), 3 * spread)

    def test_the_seed_keeps_the_best_of_the_8_orientations_and_the_fixed_units(self):
        pr = clusters(seed=3)
        pr['units'][0]['fixed'] = True
        pose, cands = gplace.spectral_pose(pr, all_orientations=True)
        self.assertEqual(len(cands), 8)
        self.assertEqual(cost.hpwl(pr, pose), min(cost.hpwl(pr, q) for q in cands))
        self.assertEqual(tuple(pose[0][:2]), (pr['units'][0]['x'], pr['units'][0]['y']))

    def test_place_can_start_from_the_seed(self):
        pr = clusters(seed=3)
        res = gplace.place(pr, {'bins': 32, 'iters': 500, 'init': 'spectral'})
        pose = res['pose']
        self.assertLess(res['history'][-1]['overflow'], 0.15)
        self.assertLess(cost.hpwl(pr, pose), 0.6 * cost.hpwl(pr, cost.initial_pose(pr)))
        xs = [[pose[i][0] for i in g] for g in (range(0, 4), range(4, 8))]
        self.assertTrue(max(xs[1]) < min(xs[0]) or max(xs[0]) < min(xs[1]))  # the seed keeps the groups apart


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


def facing_away():
    """A fixed unit F at the left; the movable unit B has its only pin on its +x end (away from F).
    A 180 degree turn puts the pin next to F."""
    us = [unit('F', 3, 10, [[-1, -1, 1, 1, 0.0]], fixed=True), unit('B', 20, 10, [[-4, -1, 4, 1, 0.0]])]
    ns = [{'name': 'N%d' % k, 'weight': 1.0, 'pins': [[0, .9, -.1, 1.1, .1], [1, 3.8, -.1, 4.0, .1]]}
          for k in range(3)]
    return problem(us, ns, board=box_board(40.0, 20.0))


class KnownLayoutTest(unittest.TestCase):
    """Density on a 8 x 8 mm board with 4 x 4 bins of 2 x 2 mm (target 0.9: room 3.6 mm2 per bin)."""

    def layout(self, x, y):
        return problem([unit('A', x, y, [[-1, -1, 1, 1, 0.0]])], [], board=square_board(8.0))

    def test_a_unit_on_one_bin_overflows_by_its_area_over_the_room(self):
        m = gplace.Model(self.layout(3.0, 3.0), {'bins': 4})
        self.assertAlmostEqual(m.density(m.x0, m.y0)[3], (4.0 - 3.6) / 4.0)

    def test_a_unit_on_the_corner_of_4_bins_does_not_overflow(self):
        m = gplace.Model(self.layout(4.0, 4.0), {'bins': 4})
        self.assertAlmostEqual(m.density(m.x0, m.y0)[3], 0.0)

    def test_the_potential_and_the_field_solve_the_poisson_equation(self):
        # rho = 1 + cos(pi x / W) + cos(pi x / W) cos(pi y / H): the potential of each cosine mode is the mode over
        # (wu^2 + wv^2) (the constant has none), and the field is minus its gradient (DCT on bin centres: exact).
        m = gplace.Model(clusters(seed=2), {'bins': 16})
        W, H = m.bb[2] - m.bb[0], m.bb[3] - m.bb[1]
        xc, yc = (m.ex[:-1] + m.ex[1:]) / 2 - m.bb[0], (m.ey[:-1] + m.ey[1:]) / 2 - m.bb[1]
        X, Y = np.meshgrid(xc, yc, indexing='ij')
        ku, kv = math.pi / W, math.pi / H
        cx, sx, cy, sy = np.cos(ku * X), np.sin(ku * X), np.cos(kv * Y), np.sin(kv * Y)
        psi, ex, ey = m.potential(1.0 + cx + cx * cy)
        k1, k2 = ku ** 2, ku ** 2 + kv ** 2
        np.testing.assert_allclose(psi, cx / k1 + cx * cy / k2, atol=1e-9)
        np.testing.assert_allclose(ex, ku * sx / k1 + ku * sx * cy / k2, atol=1e-9)
        np.testing.assert_allclose(ey, kv * cx * sy / k2, atol=1e-9)


class SeedTest(unittest.TestCase):
    def test_one_seed_gives_one_result(self):
        a = gplace.place(clusters(seed=3), {'bins': 32, 'iters': 300, 'seed': 5})
        b = gplace.place(clusters(seed=3), {'bins': 32, 'iters': 300, 'seed': 5})
        c = gplace.place(clusters(seed=3), {'bins': 32, 'iters': 300, 'seed': 6})
        self.assertEqual(a['pose'], b['pose'])
        self.assertNotEqual(a['pose'], c['pose'])


class RotateTest(unittest.TestCase):
    """Discrete rotation (params rotate=1): every rot_every iterations and at the end, each movable unit takes
    the turn (0/90/180/270) with the lowest WA + lambda * density energy, one unit at a time."""

    def test_the_unit_turns_its_pin_to_the_fixed_unit(self):
        pr = facing_away()
        off = gplace.place(pr, {'bins': 32, 'iters': 300})
        on = gplace.place(pr, {'bins': 32, 'iters': 300, 'rotate': 1})
        self.assertEqual(off['pose'][1][2], 0)
        self.assertEqual(on['pose'][1][2], 2)
        self.assertLess(cost.hpwl(pr, on['pose']), cost.hpwl(pr, off['pose']) - 5.0)

    def test_fixed_units_and_no_rotate_units_keep_their_turn(self):
        pr = facing_away()
        pr['units'][1]['rotate'] = False
        res = gplace.place(pr, {'bins': 32, 'iters': 300, 'rotate': 1})
        self.assertEqual([q[2] for q in res['pose']], [0, 0])
        self.assertEqual(tuple(res['pose'][0][:2]), (3, 10))

    def test_a_turned_unit_stays_inside_the_outline(self):
        pr = facing_away()
        pr['units'][1]['rects'] = [[-1, -6, 1, 6, 0.0]]  # 2 x 12 mm; turned it is 12 x 2 mm
        pr['nets'] = [{'name': 'N', 'weight': 1.0, 'pins': [[0, .9, -.1, 1.1, .1], [1, -.1, 5.8, .1, 6.0]]}]
        pr['board'] = box_board(40.0, 8.0)
        pr['units'][1]['y'] = 4.0
        pr['units'][0]['y'] = 4.0
        res = gplace.place(pr, {'bins': 32, 'iters': 300, 'rotate': 1})
        x, y, r = res['pose'][1]
        self.assertIn(r, (1, 3))
        b = gplace._box(pr['units'][1], r)
        self.assertTrue(x + b[0] >= -1e-6 and x + b[2] <= 40 + 1e-6 and y + b[1] >= -1e-6 and y + b[3] <= 8 + 1e-6)

    def test_optimize_starts_the_annealer_from_the_turned_pose(self):
        from placer import anneal
        pr = facing_away()
        prm = {'global': 1, 'rotate': 1, 'bins': 32, 'iters': 300, 'rudy_cell': 1.0, 'mask_cell': 0.25}
        g = gplace.place(pr, anneal.params_all(prm))
        res = anneal.optimize(pr, prm, workers=1, epochs=1, steps=10, seed=1, top=1)
        self.assertEqual([tuple(q) for q in res['initial']['pose']], [tuple(q) for q in g['pose']])


try:
    import torch
except ImportError:
    torch = None


@unittest.skipIf(torch is None, 'no torch')
class TorchBackendTest(unittest.TestCase):
    """params backend='torch' (device params['device'], default mps when available, else cpu): the same WA and
    density math on torch tensors."""

    def test_torch_cpu_gives_the_numpy_values(self):
        pr = random_problem(random.Random(4))
        a = gplace.Model(pr, {'gamma': 0.8, 'bins': 16})
        b = gplace.make_model(pr, {'gamma': 0.8, 'bins': 16, 'backend': 'torch', 'device': 'cpu'})
        x, y = a.x0 + 0.3, a.y0 - 0.2
        for fa, fb in zip(a.wa(x, y), b.wa(x, y)):
            np.testing.assert_allclose(fb, fa, rtol=1e-9, atol=1e-9)
        for fa, fb in zip(a.density(x, y), b.density(x, y)):
            np.testing.assert_allclose(fb, fa, rtol=1e-9, atol=1e-9)

    @unittest.skipUnless(torch is not None and torch.backends.mps.is_available(), 'no mps')
    def test_mps_float32_is_near_the_numpy_values(self):
        pr = random_problem(random.Random(4))
        a = gplace.Model(pr, {'gamma': 0.8, 'bins': 16})
        b = gplace.make_model(pr, {'gamma': 0.8, 'bins': 16, 'backend': 'torch', 'device': 'mps'})
        for fa, fb in zip(a.wa(a.x0, a.y0) + a.density(a.x0, a.y0), b.wa(a.x0, a.y0) + b.density(a.x0, a.y0)):
            np.testing.assert_allclose(fb, fa, rtol=1e-3, atol=1e-3)

    def test_torch_cpu_place_gives_the_numpy_place(self):
        a = gplace.place(clusters(seed=3), {'bins': 32, 'iters': 300, 'rotate': 1})
        b = gplace.place(clusters(seed=3), {'bins': 32, 'iters': 300, 'rotate': 1, 'backend': 'torch', 'device': 'cpu'})
        self.assertEqual([q[2] for q in b['pose']], [q[2] for q in a['pose']])
        np.testing.assert_allclose(np.array(b['pose']), np.array(a['pose']), atol=1e-4)  # 0.1 um: roundoff
