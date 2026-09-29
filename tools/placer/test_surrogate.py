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

    def test_auc(self):
        self.assertEqual(surrogate.auc([0.1, 0.9], [0, 1]), 1.0)
        self.assertEqual(surrogate.auc([0.9, 0.1], [0, 1]), 0.0)
        self.assertEqual(surrogate.auc([0.5, 0.5], [0, 1]), 0.5)
        self.assertTrue(np.isnan(surrogate.auc([0.1, 0.2], [1, 1])))

    def test_split_by_group(self):
        groups = ['A', 'B', 'A', 'C', 'B']
        tr, te = surrogate.split(groups, ['B'])
        self.assertEqual(list(tr), [0, 2, 3])
        self.assertEqual(list(te), [1, 4])


class Data(unittest.TestCase):
    def test_load_data_splits_the_nets_per_sample(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'd.npz')
            np.savez(path, x=np.zeros((3, 1, 2, 2)), s=np.zeros((3, 1)), y=np.array([1, 2, 3]), g=np.array(['a'] * 3),
                     net_i=np.array([0, 0, 2]), net_box=np.arange(12.0).reshape(3, 4),
                     net_feat=np.zeros((3, 3)), net_lab=np.array([1.0, 0.0, 1.0]))
            nets = surrogate.load_data(path)['nets']
        self.assertEqual([len(n[2]) for n in nets], [2, 0, 1])
        self.assertEqual(list(nets[2][0][0]), [8.0, 9.0, 10.0, 11.0])


class D4(unittest.TestCase):
    def test_boxes_follow_the_raster(self):
        x = np.zeros((1, 2, 8, 8), np.float32)
        x[0, 0, 1, 5] = 1.0                      # row 1 (y), column 5 (x)
        box = np.array([[4 / 8, 0 / 8, 7 / 8, 3 / 8]])  # x 4..7, y 0..3 (grid fractions) holds the hot cell
        seen = set()
        for k in range(8):
            xa, ba = surrogate.d4(x, box, k)
            j, i = np.argwhere(xa[0, 0] == 1.0)[0]
            x0, y0, x1, y1 = ba[0] * 8
            self.assertTrue(x0 <= i < x1 and y0 <= j < y1, k)
            self.assertEqual(xa[0, 1].sum(), 0.0)
            seen.add((int(j), int(i)))
        self.assertEqual(len(seen), 8)             # 8 distinct images of the cell

    def test_identity(self):
        x = np.arange(2 * 4 * 4, dtype=np.float32).reshape(1, 2, 4, 4)
        b = np.array([[0.1, 0.2, 0.3, 0.9]])
        xa, ba = surrogate.d4(x, b, 0)
        np.testing.assert_array_equal(xa, x)
        np.testing.assert_allclose(ba, b, rtol=1e-6)  # boxes come back as float32


class NetRows(unittest.TestCase):
    def test_boxes_features_and_labels(self):
        from placer import cost, features
        pr = square_problem()
        pose = cost.initial_pose(pr)
        g = features.grid_of(pr['board'], 20)
        box, feat, lab = surrogate.net_rows(pr, pose, g, {'B': 2, 'GND': 4})
        self.assertEqual(box.shape, (2, 4))
        np.testing.assert_allclose(box[0], [6.5 / 20, 5 / 20, 15 / 20, 15 / 20])  # net A pins (6.5, 5), (15, 15)
        self.assertEqual(list(lab), [0.0, 1.0])     # B has opens; GND is not a problem net
        self.assertAlmostEqual(feat[0][0], np.log1p(8.5 + 10), places=5)
        self.assertEqual(feat[0][1], 2)


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

    def test_net_head_learns_long_nets_fail(self):
        from placer import cost, features
        pr, poses, y = synthetic(160, 4)
        x, s = surrogate.featurize_many(pr, poses, n=16)
        g = features.grid_of(pr['board'], 16)
        nets = []
        for k, p in enumerate(poses):
            box, feat, _ = surrogate.net_rows(pr, p, g, {})
            lab = (np.exp(feat[:, 0]) - 1 > 9.0).astype(np.float32)  # a net longer than 9 mm fails
            nets.append((box, feat, lab))
        m = surrogate.train(x[:120], s[:120], y[:120], groups=['sq'] * 120, nets=nets[:120], epochs=80, seed=0,
                            device='cpu', aug=True)
        pn = np.concatenate(m.predict_nets(x[120:], s[120:], nets[120:]))
        lab = np.concatenate([n[2] for n in nets[120:]])
        self.assertGreater(np.mean((pn > 0.5) == (lab > 0.5)), 0.8)

    def test_seed_determinism(self):
        pr, poses, y = synthetic(30, 3)
        x, s = surrogate.featurize_many(pr, poses, n=16)
        a = surrogate.train(x, s, y, groups=['sq'] * 30, epochs=3, seed=7, device='cpu').predict(x, s)
        b = surrogate.train(x, s, y, groups=['sq'] * 30, epochs=3, seed=7, device='cpu').predict(x, s)
        np.testing.assert_allclose(a, b, rtol=1e-6)
        c = surrogate.train(x, s, y, groups=['sq'] * 30, epochs=3, seed=7, device='cpu', aug=True).predict(x, s)
        d = surrogate.train(x, s, y, groups=['sq'] * 30, epochs=3, seed=7, device='cpu', aug=True).predict(x, s)
        np.testing.assert_allclose(c, d, rtol=1e-6)

    def test_rank_only_loss_ignores_the_board_scale(self):
        # w_mse 0: only the order inside each board counts, so a per-board monotone change of y gives the same model
        pr, poses, y = synthetic(60, 4)
        x, s = surrogate.featurize_many(pr, poses, n=16)
        g = ['a'] * 30 + ['b'] * 30
        y2 = np.concatenate([y[:30], 10 * y[30:] + 50])
        a = surrogate.train(x, s, y, groups=g, epochs=3, seed=5, device='cpu', w_mse=0).predict(x, s)
        b = surrogate.train(x, s, y2, groups=g, epochs=3, seed=5, device='cpu', w_mse=0).predict(x, s)
        np.testing.assert_array_equal(np.argsort(a), np.argsort(b))
        c = surrogate.train(x, s, y2, groups=g, epochs=3, seed=5, device='cpu').predict(x, s)
        self.assertFalse(np.array_equal(np.argsort(a), np.argsort(c)))

    def test_rank_only_loss_learns_the_order(self):
        pr, poses, y = synthetic(240, 1)
        x, s = surrogate.featurize_many(pr, poses, n=16)
        m = surrogate.train(x[:200], s[:200], y[:200], groups=['sq'] * 200, epochs=60, seed=0, device='cpu', w_mse=0)
        self.assertGreater(surrogate.spearman(m.predict(x[200:], s[200:]), y[200:]), 0.8)


if __name__ == '__main__':
    unittest.main()
