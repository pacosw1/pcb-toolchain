#!/usr/bin/env python3
"""Tests for the search (tools/placer/anneal.py): move legality, determinism, legalizer, end-to-end gain.

  $PY -m unittest discover -s tools/placer -p 'test_*.py'
"""
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import anneal, cost  # noqa: E402
from placer.test_cost import problem, square_board, unit  # noqa: E402

P = {'rudy_cell': 1.0, 'mask_cell': 0.25, 'layers': 2, 'pitch': 0.4, 'limit': 1.0, 'grid': 0.05}


def two_units():
    # A fixed 1 x 1 at (5, 5); B 1 x 1 far away; one net between the centers.
    # Optimum: B next to A at the 0.5 mm gap, HPWL 1.5.
    return problem([unit('A', 5, 5, [[-.5, -.5, .5, .5, .5]], fixed=True),
                    unit('B', 15, 15, [[-.5, -.5, .5, .5, .5]])],
                   [{'name': 'N', 'weight': 1.0, 'pins': [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]]}],
                   board=square_board(20, edge=1.0))


def chain(n=10, seed=1):
    """n units in a chain net topology, scattered at random on a 30 x 30 board."""
    rng = random.Random(seed)
    us = [unit('U%d' % i, rng.uniform(3, 27), rng.uniform(3, 27),
               [[-1, -.6, 1, .6, 1.0 if i % 4 == 0 else .5]]) for i in range(n)]
    nets = [{'name': 'N%d' % i, 'weight': 1.0, 'pins': [[i, .8, 0, .8, 0], [i + 1, -.8, 0, -.8, 0]]}
            for i in range(n - 1)]
    return problem(us, nets, board=square_board(30, edge=1.0))


class MoveTest(unittest.TestCase):
    def test_moves_are_legal(self):
        pr = chain()
        pr['units'][0]['fixed'] = True
        pr['units'][5]['rects'] = [[-3, -3, 3, 3, 1.0]]  # large: no swap partner
        ev = cost.Evaluator(pr, P)
        mv = anneal.Mover(pr, ev, P)
        rng = random.Random(5)
        kinds = set()
        for _ in range(2000):
            moves, kind = mv.propose(rng, window=5.0)
            kinds.add(kind)
            for i, x, y, r in moves:
                self.assertNotEqual(i, 0)
                self.assertIn(r, (0, 1, 2, 3))
                self.assertTrue(0 <= x <= 30 and 0 <= y <= 30)
                # offsets on the grid: footprints stay on their placement grid
                dx = (x - ev.X[i]) / 0.05
                self.assertAlmostEqual(dx, round(dx), places=6)
            if kind == 'swap':
                a, b = moves[0][0], moves[1][0]
                self.assertNotIn(5, (a, b))
                self.assertLessEqual(abs(moves[0][1] - ev.X[b]), 0.025 + 1e-9)
                self.assertLessEqual(abs(moves[0][2] - ev.Y[b]), 0.025 + 1e-9)
            if kind == 'translate':
                self.assertLessEqual(abs(moves[0][1] - ev.X[moves[0][0]]), 5.0 + 0.05)
        self.assertEqual(kinds, {'swap', 'rotate', 'translate'})


class DeterminismTest(unittest.TestCase):
    def test_same_seed_same_result_in_process(self):
        r1 = anneal.optimize(chain(), P, workers=1, epochs=3, steps=800, seed=11, top=1)
        r2 = anneal.optimize(chain(), P, workers=1, epochs=3, steps=800, seed=11, top=1)
        self.assertEqual(r1['candidates'][0]['pose'], r2['candidates'][0]['pose'])

    def test_same_seed_same_result_with_processes(self):
        r1 = anneal.optimize(chain(), P, workers=2, epochs=3, steps=500, seed=4, top=2)
        r2 = anneal.optimize(chain(), P, workers=2, epochs=3, steps=500, seed=4, top=2)
        self.assertEqual([c['pose'] for c in r1['candidates']], [c['pose'] for c in r2['candidates']])

    def test_other_seed_other_result(self):
        r1 = anneal.optimize(chain(), P, workers=1, epochs=2, steps=500, seed=1, top=1)
        r2 = anneal.optimize(chain(), P, workers=1, epochs=2, steps=500, seed=2, top=1)
        self.assertNotEqual(r1['candidates'][0]['pose'], r2['candidates'][0]['pose'])


class AnnealTest(unittest.TestCase):
    def test_returned_best_cost_matches_returned_pose(self):
        pr = chain(8, seed=4)
        for sd in range(3):
            ev = cost.Evaluator(pr, P)
            mv = anneal.Mover(pr, ev, P)
            best, pose = anneal.anneal(ev, mv, random.Random(sd), 1500, 50.0, 0.5, 10.0, 0.5)
            self.assertAlmostEqual(best, cost.total(pr, pose, P), places=5)
            self.assertLessEqual(best, ev.cost + 1e-9)


class LegalizeTest(unittest.TestCase):
    def test_overlapping_unit_moves_to_a_legal_spot(self):
        pr = two_units()
        pr['units'][1]['x'], pr['units'][1]['y'] = 5.2, 5.1
        ev = cost.Evaluator(pr, P)
        self.assertGreater(ev.unit_penalty(1), 0)
        bad = anneal.legalize(ev, P)
        self.assertEqual(bad, [])
        self.assertAlmostEqual(ev.unit_penalty(1), 0.0)
        self.assertAlmostEqual(ev.cost, cost.total(pr, ev.pose(), P), places=6)
        self.assertLess(ev.components()['hpwl'], 2.0)


class EndToEndTest(unittest.TestCase):
    def test_two_units_reach_the_known_optimum(self):
        res = anneal.optimize(two_units(), P, workers=1, epochs=4, steps=1500, seed=3, top=1)
        c = res['candidates'][0]
        self.assertEqual(c['illegal'], [])
        self.assertAlmostEqual(c['components']['overlap'], 0.0)
        self.assertLess(c['components']['hpwl'], 1.5 + 0.1)

    def test_beats_initial_and_random_placement(self):
        pr = chain(12, seed=2)
        res = anneal.optimize(pr, P, workers=2, epochs=4, steps=3000, seed=9, top=1)
        best = res['candidates'][0]
        self.assertEqual(best['illegal'], [])
        rng = random.Random(0)
        rand = []
        for _ in range(20):
            pose = [(rng.uniform(3, 27), rng.uniform(3, 27), rng.randrange(4)) for _ in pr['units']]
            rand.append(cost.total(pr, pose, P))
        self.assertLess(best['cost'], 0.5 * res['initial']['cost'])
        self.assertLess(best['cost'], 0.5 * min(rand))
        self.assertAlmostEqual(best['cost'], cost.total(pr, best['pose'], P), places=5)


if __name__ == '__main__':
    unittest.main()
