"""Batched cost and batched anneal (batch.py) against the scalar cost (cost.py), on real board problems.

Fixtures: testdata/relay4-prob.json (RELAY-4: mains domain area, keepout rects, round courtyards) and
testdata/io6x6-prob.json (IO-6X6: isolation class gaps, 539 rects), both `cli.py read` of the repo boards.
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import anneal, bench, cost  # noqa: E402

try:
    import torch
except ImportError:  # no torch: the batched path is not available
    torch = None
if torch is not None:
    from placer import batch  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
TERMS = ('hpwl', 'cong', 'overlap', 'oob', 'spacing')


def load(name):
    with open(os.path.join(HERE, 'testdata', name)) as f:
        return json.load(f)


def poses(pr):
    """Initial pose, 3 uniform scrambles (random turns) and 2 near scrambles (many overlaps)."""
    return ([cost.initial_pose(pr)] + [bench.scramble(pr, s) for s in (1, 2, 3)]
            + [bench.scramble(pr, s, 1.5) for s in (4, 5)])


def close(a, b, rel=1e-6, floor=1e-9):
    return abs(a - b) <= max(rel * max(abs(a), abs(b)), floor)


@unittest.skipIf(torch is None, 'torch not installed')
class TestBatchCost(unittest.TestCase):
    def check_board(self, name):
        pr = load(name)
        p = anneal.params_all({})
        ps = poses(pr)
        bc = batch.BatchCost(pr, p, device='cpu')
        comp = bc.components(ps)
        tot = bc.total(ps)
        for k, pose in enumerate(ps):
            ref = cost.components(pr, pose, p)
            for t in TERMS:
                self.assertTrue(close(float(comp[t][k]), ref[t]), '%s pose %d %s: batch %r scalar %r'
                                % (name, k, t, float(comp[t][k]), ref[t]))
            self.assertTrue(close(float(tot[k]), cost.weighted(ref, p)))

    def test_relay4_equals_scalar(self):
        self.check_board('relay4-prob.json')

    def test_io6x6_equals_scalar(self):
        self.check_board('io6x6-prob.json')

    def test_unsupported_terms_fail_closed(self):
        pr = load('relay4-prob.json')
        for extra in ({'w_x': 1.0}, {'w_row': 1.0}, {'pin_demand': 0.5}):
            with self.assertRaises(ValueError):
                batch.BatchCost(pr, anneal.params_all(extra), device='cpu')
        q = dict(pr, via_nets=[3])
        with self.assertRaises(ValueError):
            batch.BatchCost(q, anneal.params_all({}), device='cpu')

    @unittest.skipIf(torch is None or not torch.backends.mps.is_available(), 'no MPS')
    def test_mps_float32_near_scalar(self):
        pr = load('io6x6-prob.json')
        p = anneal.params_all({})
        ps = poses(pr)
        tot = batch.BatchCost(pr, p, device='mps').total(ps)
        for k, pose in enumerate(ps):
            ref = cost.total(pr, pose, p)
            self.assertTrue(close(float(tot[k]), ref, rel=1e-3), 'pose %d: mps %r scalar %r' % (k, float(tot[k]), ref))


@unittest.skipIf(torch is None, 'torch not installed')
class TestChains(unittest.TestCase):
    def run_chains(self, name, seed=3, steps=60, spec=1, hot=1e4):
        pr = load(name)
        p = anneal.params_all({})
        ch = batch.Chains(pr, p, bench.scramble(pr, 7), chains=6, seed=seed, device='cpu', spec=spec)
        bx0, by0, bx1, by1 = cost.outline_box(pr['board'])
        for s in range(steps):  # hot: most moves are accepted, so the state changes on each chain
            ch.step(hot if s % 2 else 1.0, max(bx1 - bx0, by1 - by0) / 2)
        return pr, p, ch

    def test_state_cost_equals_scalar_after_moves(self):
        for name in ('relay4-prob.json', 'io6x6-prob.json'):
            pr, p, ch = self.run_chains(name)
            self.assertGreater(ch.accepted, 0)
            for k, pose in enumerate(ch.poses()):
                ref = cost.total(pr, pose, p)
                self.assertTrue(close(float(ch.cost[k]), ref), '%s chain %d: state %r scalar %r'
                                % (name, k, float(ch.cost[k]), ref))
            for k, pose in enumerate(ch.best_poses()):
                self.assertTrue(close(float(ch.best[k]), cost.total(pr, pose, p)))

    def test_moves_keep_fixed_units_and_grid(self):
        pr, p, ch = self.run_chains('relay4-prob.json')
        start = bench.scramble(pr, 7)
        for pose in ch.poses():
            for i, u in enumerate(pr['units']):
                if u['fixed']:
                    self.assertEqual(tuple(pose[i]), tuple(start[i]))

    def test_speculative_state_equals_scalar(self):
        pr, p, ch = self.run_chains('relay4-prob.json', spec=4, hot=5.0)
        for k, pose in enumerate(ch.poses()):
            self.assertTrue(close(float(ch.cost[k]), cost.total(pr, pose, p)))
        # 60 steps x 6 chains x 4 proposals; each step uses 1 to 4 sequential moves per chain
        self.assertEqual(ch.evals, 60 * 6 * 4)
        self.assertTrue(ch.accepted <= 60 * 6 <= ch.moves <= ch.evals, (ch.accepted, ch.moves))
        self.assertGreater(ch.moves, 60 * 6)

    def test_same_seed_same_result(self):
        a = self.run_chains('relay4-prob.json', seed=5, steps=20)[2].poses()
        b = self.run_chains('relay4-prob.json', seed=5, steps=20)[2].poses()
        self.assertEqual(a, b)


@unittest.skipIf(torch is None, 'torch not installed')
class TestOptimizeBatch(unittest.TestCase):
    def test_batch_option_gives_legalized_candidates(self):
        pr = load('relay4-prob.json')
        res = anneal.optimize(pr, {'batch': 1, 'chains': 4, 'batch_device': 'cpu', 't0': 0.01, 'w0': 1.0},
                              epochs=2, steps=10, seed=1, top=2)
        self.assertEqual(len(res['candidates']), 2)
        for c in res['candidates']:
            self.assertEqual(c['illegal'], [])
            self.assertTrue(close(c['cost'], cost.total(pr, c['pose'], anneal.epoch_params(
                res['params'], 1, 2))))
        self.assertEqual(res['batch']['chains'], 4)

    def test_lam_schedule_not_supported(self):
        with self.assertRaises(ValueError):
            anneal.optimize(load('relay4-prob.json'), {'batch': 1, 'schedule': 'lam'}, epochs=1, steps=1)


if __name__ == '__main__':
    unittest.main()
