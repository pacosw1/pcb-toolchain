import os
import random
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import surrogate  # noqa: E402
from placer.test_surrogate_features import square_problem  # noqa: E402

try:
    import torch  # noqa: F401
    HAVE_TORCH = True
except ImportError:
    HAVE_TORCH = False


class Metrics(unittest.TestCase):
    def test_topk_recall(self):
        true = np.arange(10.0)            # the best 10 % (lowest unrouted) is item 0
        self.assertEqual(surrogate.topk_recall(true, true, 0.1, 0.3), 1.0)
        pred = true[::-1].copy()          # item 0 predicted worst
        self.assertEqual(surrogate.topk_recall(pred, true, 0.1, 0.3), 0.0)
        pred = np.array([2.5, 0, 1, 2, 4, 5, 6, 7, 8, 9.0])  # item 0 is 4th: outside the top 3
        self.assertEqual(surrogate.topk_recall(pred, true, 0.1, 0.3), 0.0)
        pred = np.array([1.5, 0, 1, 2, 4, 5, 6, 7, 8, 9.0])  # item 0 is 3rd
        self.assertEqual(surrogate.topk_recall(pred, true, 0.1, 0.3), 1.0)

    def test_topk_recall_ties_in_truth(self):
        true = np.array([0, 0, 5, 5, 5, 5, 5, 5, 5, 5.0])   # two items share the best value: both are in the best set
        pred = np.array([0, 9, 1, 2, 3, 4, 5, 6, 7, 8.0])
        self.assertEqual(surrogate.topk_recall(pred, true, 0.1, 0.3), 0.5)

    def test_spearman_of_a_constant_is_zero(self):
        self.assertEqual(surrogate.spearman([1, 1, 1], [1, 2, 3]), 0.0)
        self.assertAlmostEqual(surrogate.spearman([1, 2, 3], [10, 20, 40]), 1.0)

    def test_split_by_group(self):
        groups = ['A', 'B', 'A', 'C', 'B']
        tr, te = surrogate.split(groups, ['B'])
        self.assertEqual(list(tr), [0, 2, 3])
        self.assertEqual(list(te), [1, 4])


def synthetic(n, seed):
    """Placements of the square problem with U1 at random places; target = HPWL (a smooth function of the pose)."""
    from placer import cost
    pr = square_problem()
    rng = random.Random(seed)
    poses = [[(rng.uniform(3, 17), rng.uniform(3, 17), rng.randrange(4)), (15.0, 15.0, 0)] for _ in range(n)]
    y = [cost.hpwl(pr, p) for p in poses]
    return pr, poses, np.array(y)


@unittest.skipUnless(HAVE_TORCH, 'no torch')
class Model(unittest.TestCase):
    def test_learns_a_pose_function(self):
        pr, poses, y = synthetic(240, 1)
        x, s = surrogate.featurize_many(pr, poses, n=16)
        m = surrogate.train(x[:200], s[:200], y[:200], groups=['sq'] * 200, epochs=60, seed=0, device='cpu')
        pred = m.predict(x[200:], s[200:])
        self.assertGreater(surrogate.spearman(pred, y[200:]), 0.8)

    def test_save_load_and_batch(self):
        pr, poses, y = synthetic(40, 2)
        x, s = surrogate.featurize_many(pr, poses, n=16)
        m = surrogate.train(x, s, y, groups=['sq'] * 40, epochs=2, seed=0, device='cpu')
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'm.pt')
            m.save(path)
            m2 = surrogate.Surrogate.load(path, device='cpu')
        b = m2.batch_score(pr, poses[:5])
        one = [m2.score(pr, p) for p in poses[:5]]
        np.testing.assert_allclose(b, one, rtol=1e-5)
        np.testing.assert_allclose(b, m.batch_score(pr, poses[:5]), rtol=1e-5)
        self.assertTrue(all(v >= 0 for v in b))  # an unrouted count

    def test_seed_determinism(self):
        pr, poses, y = synthetic(30, 3)
        x, s = surrogate.featurize_many(pr, poses, n=16)
        a = surrogate.train(x, s, y, groups=['sq'] * 30, epochs=3, seed=7, device='cpu').predict(x, s)
        b = surrogate.train(x, s, y, groups=['sq'] * 30, epochs=3, seed=7, device='cpu').predict(x, s)
        np.testing.assert_allclose(a, b, rtol=1e-6)


if __name__ == '__main__':
    unittest.main()
