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


class MoveBoxTest(unittest.TestCase):
    def test_region_mode_keeps_unit_origins_in_the_move_box(self):
        pr = chain()
        pr['move_box'] = [10, 10, 20, 20]
        for u in pr['units']:
            u['fixed'] = not (10 <= u['x'] <= 20 and 10 <= u['y'] <= 20)
        self.assertTrue(any(not u['fixed'] for u in pr['units']))
        ev = cost.Evaluator(pr, P)
        mv = anneal.Mover(pr, ev, P)
        rng = random.Random(2)
        for _ in range(3000):
            moves, _ = mv.propose(rng, window=15.0)
            for i, x, y, r in moves:
                self.assertTrue(10 - 1e-9 <= x <= 20 + 1e-9 and 10 - 1e-9 <= y <= 20 + 1e-9, (x, y))
            ev.propose(moves)
            ev.commit()


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


class RampTest(unittest.TestCase):
    def test_spacing_weights_grow_from_start_to_ramp_times(self):
        p = anneal.params_all({'w_ov': 20.0, 'w_oob': 10.0, 'ramp': 20.0})
        e0, e_last = anneal.epoch_params(p, 0, 5), anneal.epoch_params(p, 4, 5)
        self.assertAlmostEqual(e0['w_ov'], 20.0)
        self.assertAlmostEqual(e_last['w_ov'], 400.0)
        self.assertAlmostEqual(e_last['w_oob'], 200.0)
        self.assertAlmostEqual(anneal.epoch_params(p, 0, 1)['w_ov'], 400.0)
        self.assertEqual(e0['w_wl'], p['w_wl'])


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


class LegalizeCopperTest(unittest.TestCase):
    def test_unit_on_kept_copper_only_is_legal_and_stays(self):
        pr = two_units()
        pr['board']['copper'] = [['via', pr['units'][1]['x'], pr['units'][1]['y'], pr['units'][1]['x'],
                                  pr['units'][1]['y'], 0.6]]
        pr['units'][1]['pad_rects'] = [[-.2, -.2, .2, .2]]
        ev = cost.Evaluator(pr, P)
        self.assertGreater(ev.unit_penalty(1), 0)
        x, y = ev.X[1], ev.Y[1]
        self.assertEqual(anneal.legalize(ev, P), [])
        self.assertEqual((ev.X[1], ev.Y[1]), (x, y))


class LegalizeRetryTest(unittest.TestCase):
    def test_second_pass_doubles_the_radius(self):
        pr = two_units()
        # the courtyards meet: needs a 0.8 mm move; radius 0.5 is too small
        pr['units'][1]['x'], pr['units'][1]['y'] = 5.2, 5.0
        ev = cost.Evaluator(pr, P)
        self.assertEqual(anneal.legalize(ev, dict(P, legal_radius=0.5, legal_passes=1)), [1])
        ev = cost.Evaluator(pr, P)
        self.assertEqual(anneal.legalize(ev, dict(P, legal_radius=0.5, legal_passes=2)), [])
        self.assertAlmostEqual(ev.unit_penalty(1), 0.0)


class LegalizeTimeLimitTest(unittest.TestCase):
    def test_time_limit_fails_closed(self):
        pr = chain(10, seed=3)
        for u in pr['units']:
            u['x'], u['y'] = 15.0, 15.0  # all on one spot: much work for the legalizer
        ev = cost.Evaluator(pr, P)
        t = [0.0]

        def clock():  # fake clock: 0.01 s per call
            t[0] += 0.01
            return t[0]
        with self.assertRaises(anneal.LegalizeTimeout) as cm:
            anneal.legalize(ev, dict(P, legal_time=0.5), clock=clock)
        self.assertGreater(len(cm.exception.illegal), 0)
        for i in cm.exception.illegal:
            self.assertGreater(ev.unit_penalty(i), 0)
        self.assertLess(t[0], 0.5 + 0.2)
        self.assertIn('legalizer time limit', str(cm.exception))

    def test_optimize_marks_a_timed_out_candidate_illegal(self):
        pr = chain(10, seed=3)
        for u in pr['units']:
            u['x'], u['y'] = 15.0, 15.0
        res = anneal.optimize(pr, dict(P, legal_time=0.0), workers=1, epochs=1, steps=10, seed=1, top=1)
        c = res['candidates'][0]
        self.assertTrue(c['timeout'])
        self.assertGreater(len(c['illegal']), 0)


class EndToEndTest(unittest.TestCase):
    def test_two_units_reach_the_known_optimum(self):
        res = anneal.optimize(two_units(), P, workers=1, epochs=4, steps=1500, seed=3, top=1)
        c = res['candidates'][0]
        self.assertEqual(c['illegal'], [])
        self.assertAlmostEqual(c['components']['overlap'], 0.0)
        self.assertLess(c['components']['hpwl'], 1.5 + 0.1)

    def test_history_keeps_the_best_pose_and_cost_parts_of_each_epoch(self):
        pr = two_units()
        res = anneal.optimize(pr, P, workers=1, epochs=3, steps=500, seed=3, top=1)
        h = res['history']
        self.assertEqual([x['epoch'] for x in h], [1, 2, 3])
        for x in h:
            self.assertEqual(len(x['pose']), len(pr['units']))
            self.assertEqual(set(x['components']), {'hpwl', 'cong', 'overlap', 'oob', 'spacing', 'via', 'crossing'})
            self.assertAlmostEqual(x['components']['hpwl'], cost.hpwl(pr, x['pose']), places=6)

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



class LamScheduleTest(unittest.TestCase):
    """Modified Lam schedule (SA_PCB): the target acceptance decays from 1 to base_lam over the first 15 %
    of the moves, holds to 65 %, then falls; every lam_window moves T *= lam_rate when the acceptance EMA is
    above the target, else T /= lam_rate."""

    def test_target_shape(self):
        t = anneal.lam_target
        self.assertAlmostEqual(t(0.0, 0.44), 1.0)
        self.assertAlmostEqual(t(0.15, 0.44), 0.44, delta=0.002)
        self.assertAlmostEqual(t(0.40, 0.44), 0.44)
        self.assertAlmostEqual(t(0.65, 0.44), 0.44)
        self.assertLess(t(1.0, 0.44), 0.44 / 100)
        self.assertTrue(all(t(a / 100, 0.133) >= t((a + 1) / 100, 0.133) for a in range(100)))

    def test_controller_cools_on_high_acceptance_and_heats_on_low(self):
        c = anneal.Lam(t=10.0, base=0.44, rate=0.885, window=500)
        for _ in range(500):
            c.step(True, 0.5)  # 100 % acceptance vs target 0.44
        self.assertAlmostEqual(c.t, 10.0 * 0.885)
        c = anneal.Lam(t=10.0, base=0.44, rate=0.885, window=500, ema=0.0)
        for _ in range(500):
            c.step(False, 0.5)
        self.assertAlmostEqual(c.t, 10.0 / 0.885)

    def test_optimize_with_the_lam_schedule(self):
        pr = chain(12, seed=2)
        q = dict(P, schedule='lam', base_lam=0.44, lam_window=100)  # short run: faster feedback
        r1 = anneal.optimize(pr, q, workers=1, epochs=4, steps=3000, seed=9, top=1)
        r2 = anneal.optimize(pr, q, workers=1, epochs=4, steps=3000, seed=9, top=1)
        self.assertEqual(r1['candidates'][0]['pose'], r2['candidates'][0]['pose'])
        best = r1['candidates'][0]
        self.assertEqual(best['illegal'], [])
        self.assertLess(best['cost'], 0.5 * r1['initial']['cost'])
        self.assertIn('lam', r1)  # the acceptance and T of each epoch, to check the schedule
        acc = [e['accept'] for e in r1['lam']]
        self.assertGreater(acc[0], acc[-1])


if __name__ == '__main__':
    unittest.main()
