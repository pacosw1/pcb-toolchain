"""Wire-length term (wirelen.py): MST of the net pad centres, its Evaluator integration and the reader fields."""
import math
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import anneal, batch_capabilities, cost, wirelen  # noqa: E402

try:
    import pcbnew  # noqa: F401
    HAVE_PCBNEW = True
except ImportError:
    HAVE_PCBNEW = False


def unit(name, x, y, fixed=False):
    return {'name': name, 'refs': [name], 'fixed': fixed, 'x': x, 'y': y, 'rects': [[-1.0, -0.5, 1.0, 0.5, 0.5]]}


def net(name, pins, pts=None):
    """pins: [(unit, local x, local y)] -> one pin box per unit (the box of its points)."""
    by = {}
    for u, x, y in pins:
        by.setdefault(u, []).append((x, y))
    n = {'name': name, 'weight': 1.0, 'track': 0.3,
         'pins': [[u, min(p[0] for p in q), min(p[1] for p in q), max(p[0] for p in q), max(p[1] for p in q)]
                  for u, q in sorted(by.items())]}
    if pts is not False:
        n['pts'] = [[list(p) for p in by[u]] for u in sorted(by)]
    return n


def problem():
    units = [unit('U1', 10.0, 10.0, fixed=True), unit('R1', 14.0, 10.0), unit('R2', 10.0, 14.0), unit('TP1', 20.0, 20.0)]
    nets = [net('A', [(0, 0.5, 0.0), (1, -0.5, 0.0)]),
            net('B', [(0, -0.5, 0.0), (0, 0.5, 0.3), (2, 0.5, 0.0), (3, 0.0, 0.0)]),
            net('P', [(1, 0.5, 0.0), (2, -0.5, 0.0)]),  # a plane net
            {'name': '~comp:x', 'weight': 1.0, 'track': 0.0, 'cohesion': True,
             'pins': [[1, -1, -0.5, 1, 0.5], [2, -1, -0.5, 1, 0.5]]}]
    return {'units': units, 'nets': nets, 'plane_nets': ['P'],
            'board': {'outline': [[0, 0], [40, 0], [40, 40], [0, 40]], 'keepouts': [], 'edge_clearance': 0.5}}


class MstTest(unittest.TestCase):
    def test_known_lengths(self):
        self.assertEqual(wirelen.mst_length([]), 0.0)
        self.assertEqual(wirelen.mst_length([(1, 1)]), 0.0)
        self.assertAlmostEqual(wirelen.mst_length([(0, 0), (3, 4)]), 5.0)
        # unit square: 3 sides; a star of 4 points round a centre: 4 spokes
        self.assertAlmostEqual(wirelen.mst_length([(0, 0), (1, 0), (1, 1), (0, 1)]), 3.0)
        self.assertAlmostEqual(wirelen.mst_length([(0, 0), (2, 0), (-2, 0), (0, 2), (0, -2)]), 8.0)

    def test_against_brute_force(self):
        rng = random.Random(3)
        for _ in range(30):
            pts = [(rng.uniform(0, 10), rng.uniform(0, 10)) for _ in range(rng.randint(2, 7))]
            # Kruskal for the reference
            edges = sorted((math.dist(pts[a], pts[b]), a, b) for a in range(len(pts)) for b in range(a))
            par = list(range(len(pts)))

            def find(a):
                while par[a] != a:
                    a = par[a]
                return a
            ref = 0.0
            for d, a, b in edges:
                ra, rb = find(a), find(b)
                if ra != rb:
                    par[ra] = rb
                    ref += d
            self.assertAlmostEqual(wirelen.mst_length(pts), ref, places=9)


class ModelTest(unittest.TestCase):
    def test_nets_and_points(self):
        pr = problem()
        m = wirelen.Model(pr)
        self.assertEqual(m.nets, [0, 1])  # no plane net, no cohesion net
        total, per = wirelen.wirelen(pr, cost.initial_pose(pr))
        self.assertAlmostEqual(per['A'], 3.0)  # (10.5, 10) - (13.5, 10)
        pts = [(9.5, 10.0), (10.5, 10.3), (10.5, 14.0), (20.0, 20.0)]
        self.assertAlmostEqual(per['B'], wirelen.mst_length(pts))
        self.assertAlmostEqual(total, per['A'] + per['B'])

    def test_turn(self):
        pr = problem()
        pose = cost.initial_pose(pr)
        pose[1] = (14.0, 10.0, 2)  # R1 turned 180 deg: its A pad goes to (14.5, 10)
        self.assertAlmostEqual(wirelen.wirelen(pr, pose)[1]['A'], 4.0)

    def test_old_problem_uses_box_centres(self):
        pr = problem()
        for n in pr['nets']:
            n.pop('pts', None)
        per = wirelen.wirelen(pr, cost.initial_pose(pr))[1]
        self.assertAlmostEqual(per['A'], 3.0)
        # U1 B pins merge to one box centre (10, 10.15)
        self.assertAlmostEqual(per['B'], wirelen.mst_length([(10.0, 10.15), (10.5, 14.0), (20.0, 20.0)]))


class EvaluatorTest(unittest.TestCase):
    def test_off_by_default(self):
        ev = cost.Evaluator(problem(), {})
        self.assertIsNone(ev.wl)
        self.assertEqual(ev.components()['wirelen'], 0.0)
        self.assertEqual(cost.components(problem(), cost.initial_pose(problem()), {})['wirelen'], 0.0)

    def test_incremental_equals_full(self):
        pr = problem()
        p = anneal.params_all({'w_mst': 2.0})
        ev = cost.Evaluator(pr, p)
        rng = random.Random(1)
        mv = [i for i in range(ev.n) if not ev.fixed[i]]
        for _ in range(300):
            moves = [(i, rng.uniform(3, 37), rng.uniform(3, 37), rng.randrange(4)) for i in rng.sample(mv, rng.randint(1, 2))]
            ev.propose(moves)
            ev.commit() if rng.random() < 0.5 else ev.revert()
        full = cost.components(pr, ev.pose(), p)
        self.assertAlmostEqual(ev.components()['wirelen'], full['wirelen'], places=9)
        self.assertAlmostEqual(ev.cost, cost.weighted(full, p), places=6)

    def test_delta_and_revert(self):
        pr = problem()
        ev = cost.Evaluator(pr, {'w_mst': 1.0, 'w_wl': 0.0, 'w_cong': 0.0})
        w0, c0 = ev.comp[9], ev.cost
        d = ev.propose([(3, 11.0, 15.0, 0)])  # the test point next to R2: net B gets shorter
        self.assertLess(ev.comp[9], w0)
        self.assertAlmostEqual(d, ev.cost - c0, places=9)
        self.assertLess(d, 0.0)
        ev.revert()
        self.assertEqual(ev.comp[9], w0)
        self.assertEqual(ev.cost, c0)

    def test_batch_rejects_the_term(self):
        with self.assertRaises(ValueError):
            batch_capabilities.check_cost({}, {'w_mst': 1.0})


@unittest.skipUnless(HAVE_PCBNEW, 'kicad_io needs pcbnew (KiCad Python)')
class ReaderTest(unittest.TestCase):
    BOARD = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                         'hardware-design', 'boards', 'NET-CORE', 'cad', 'NET-CORE', 'NET-CORE.kicad_pcb')

    @unittest.skipUnless(os.path.exists(BOARD), 'NET-CORE board not in this checkout')
    def test_tp_pins_and_plane_nets(self):
        from placer import kicad_io
        import re
        import shutil
        import tempfile
        d = tempfile.mkdtemp()
        base = os.path.splitext(self.BOARD)[0]
        for ext in ('kicad_pro', 'kicad_dru'):
            shutil.copy(base + '.' + ext, d)
        # unlocked copy: every footprint of the committed board is locked (all nets would be fixed-only)
        with open(self.BOARD) as f:
            txt = re.sub(r'\n\s*\(locked yes\)', '', f.read())
        path = os.path.join(d, 'NET-CORE.kicad_pcb')
        with open(path, 'w') as f:
            f.write(txt)
        a = kicad_io.read_problem(path)
        b = kicad_io.read_problem(path, tp_pins=True)
        self.assertEqual(a['plane_nets'], ['GND', 'VDD_3V3'])
        tp = {i for i, u in enumerate(b['units']) if u['refs'][0].startswith('TP')}

        def tp_pins(pr):
            return sum(1 for n in pr['nets'] for q in n['pins'] if q[0] in tp)
        self.assertEqual(tp_pins(a), 0)
        self.assertGreaterEqual(tp_pins(b), 6)  # 10 test points, 2 on GND (skipped net)
        for n in b['nets']:
            self.assertEqual(len(n['pts']), len(n['pins']))
            for q, ps in zip(n['pins'], n['pts']):
                for x, y in ps:  # every point is inside its pin box
                    self.assertTrue(q[1] - 1e-6 <= x <= q[3] + 1e-6 and q[2] - 1e-6 <= y <= q[4] + 1e-6)


if __name__ == '__main__':
    unittest.main()
