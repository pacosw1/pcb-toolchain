import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import cost, features  # noqa: E402


def square_problem():
    """20 x 20 mm board at (0, 0), one 8 x 8 mm keepout in the top-right corner, two units, two nets."""
    board = {'outline': [[0, 0], [20, 0], [20, 20], [0, 20]],
             'keepouts': [[[12, 0], [20, 0], [20, 8], [12, 8]]], 'edge_clearance': 0.5,
             'copper': [], 'fixed_copper': []}
    u0 = {'name': 'U1', 'refs': ['U1'], 'fixed': False, 'x': 5.0, 'y': 5.0,
          'rects': [[-2.0, -1.0, 2.0, 1.0, 0.5]], 'pads': [[-1.5, 0.0], [1.5, 0.0]]}
    u1 = {'name': 'R1', 'refs': ['R1'], 'fixed': True, 'x': 15.0, 'y': 15.0,
          'rects': [[-1.0, -1.0, 1.0, 1.0, 0.5]], 'pads': [[0.0, 0.0]]}
    nets = [{'name': 'A', 'weight': 1.0, 'pins': [[0, 1.5, 0.0, 1.5, 0.0], [1, 0.0, 0.0, 0.0, 0.0]]},
            {'name': 'B', 'weight': 1.0, 'pins': [[0, -1.5, 0.0, -1.5, 0.0], [1, 0.0, 0.0, 0.0, 0.0]]}]
    return {'units': [u0, u1], 'nets': nets, 'board': board}


class Rasterize(unittest.TestCase):
    def setUp(self):
        self.pr = square_problem()
        self.pose = cost.initial_pose(self.pr)

    def test_shape_and_grid(self):
        x, g = features.rasterize(self.pr, self.pose, n=20)
        self.assertEqual(x.shape, (len(features.CHANNELS), 20, 20))
        self.assertEqual(x.dtype, np.float32)
        self.assertAlmostEqual(g['cell'], 1.0)

    def test_occupancy_is_exact_area_fraction(self):
        x, g = features.rasterize(self.pr, self.pose, n=40)  # cell 0.5 mm
        occ = x[features.CHANNELS.index('occ')]
        self.assertAlmostEqual(float(occ.sum()) * g['cell'] ** 2, 8.0 + 4.0, places=5)
        self.assertEqual(float(occ.max()), 1.0)
        # U1 covers x 3..7, y 4..6: cell (row 9, col 6) = x 3.0-3.5, y 4.5-5.0 is full; col 5 is empty
        self.assertEqual(float(occ[9, 6]), 1.0)
        self.assertEqual(float(occ[9, 5]), 0.0)

    def test_rotation_turns_the_rects(self):
        pose = [(5.0, 5.0, 1), self.pose[1]]
        x, g = features.rasterize(self.pr, pose, n=20)
        occ = x[features.CHANNELS.index('occ')]
        # turned U1 covers x 4..6, y 3..7
        self.assertEqual(float(occ[3:7, 4:6].sum()), 8.0)
        self.assertEqual(float(occ[3:7, 3].sum()), 0.0)

    def test_pins_count(self):
        x, g = features.rasterize(self.pr, self.pose, n=20)
        pins = x[features.CHANNELS.index('pins')]
        self.assertAlmostEqual(float(pins.sum()) * g['cell'] ** 2, 3.0, places=5)
        self.assertAlmostEqual(float(pins[15, 15]), 1.0)  # R1 pad at (15, 15); row = y

    def test_rudy_integrates_to_net_length(self):
        x, g = features.rasterize(self.pr, self.pose, n=20)
        rudy = x[features.CHANNELS.index('rudy')]
        wl = cost.hpwl(self.pr, self.pose)
        self.assertAlmostEqual(float(rudy.sum()) * g['cell'] ** 2, wl, places=3)

    def test_rudy_splits_into_horizontal_and_vertical_wire(self):
        x, g = features.rasterize(self.pr, self.pose, n=20)
        c = features.CHANNELS
        h, v = x[c.index('rudy_h')], x[c.index('rudy_v')]
        wh = sum(n['weight'] * (b[2] - b[0]) for n in self.pr['nets'] for b in [cost.net_box(n, self.pose)])
        wv = sum(n['weight'] * (b[3] - b[1]) for n in self.pr['nets'] for b in [cost.net_box(n, self.pose)])
        self.assertAlmostEqual(float(h.sum()) * g['cell'] ** 2, wh, places=3)
        self.assertAlmostEqual(float(v.sum()) * g['cell'] ** 2, wv, places=3)
        self.assertTrue(np.allclose(h + v, x[c.index('rudy')], atol=1e-5))
        self.assertGreater(wh, 0)
        self.assertGreater(wv, 0)

    def test_blocked_is_outline_and_keepouts(self):
        pr = square_problem()
        pr['board']['outline'] = [[0, 0], [20, 0], [20, 10], [0, 10]]  # 20 x 10: lower grid half is off board
        x, g = features.rasterize(pr, self.pose, n=20)
        blk = x[features.CHANNELS.index('blocked')]
        self.assertEqual(float(blk[15, 2]), 1.0)  # y 15: off board
        self.assertEqual(float(blk[2, 15]), 1.0)  # keepout x 12..20, y 0..8
        self.assertEqual(float(blk[9, 2]), 0.0)

    def test_via_net_pins(self):
        pr = square_problem()
        pr['units'][0]['cu'] = [[-2.0, -0.5, -1.0, 0.5, 7], [1.0, -0.5, 2.0, 0.5, 3]]
        pr['via_nets'] = [7]
        x, g = features.rasterize(pr, self.pose, n=20)
        vp = x[features.CHANNELS.index('vpins')]
        self.assertAlmostEqual(float(vp.sum()) * g['cell'] ** 2, 1.0, places=5)
        self.assertEqual(float(vp[5, 3]), 1.0)  # pad centre (3.5, 5.0)

    def test_fixed_copper_length(self):
        pr = square_problem()
        pr['board']['copper'] = [['F.Cu', 1.0, 18.5, 9.0, 18.5, 0.3], ['via', 2.5, 2.5, 0, 0, 0.6]]
        x, g = features.rasterize(pr, self.pose, n=20)
        cu = x[features.CHANNELS.index('copper')]
        self.assertAlmostEqual(float(cu[18, 1:9].sum()), 8.0, places=5)  # 8 mm of track in row 18
        self.assertGreater(float(cu[2, 2]), 0.0)  # a via counts
        self.assertEqual(float(cu[10, 10]), 0.0)

    def test_scalars(self):
        s = features.scalars(self.pr, self.pose)
        self.assertEqual(len(s), len(features.SCALARS))
        d = dict(zip(features.SCALARS, s))
        self.assertAlmostEqual(d['log_hpwl'], np.log1p(cost.hpwl(self.pr, self.pose)))
        self.assertEqual(d['units'], 2)
        self.assertEqual(d['nets'], 2)
        self.assertEqual(d['pins'], 4)

    def test_deterministic(self):
        a, _ = features.rasterize(self.pr, self.pose, n=16)
        b, _ = features.rasterize(self.pr, self.pose, n=16)
        self.assertTrue(np.array_equal(a, b))


if __name__ == '__main__':
    unittest.main()
