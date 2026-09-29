"""Routability surrogate: predicts the Freerouting unrouted count of a placement in milliseconds, so the placer can
send only its best candidates to Freerouting (on Hetzner).

Input: features.rasterize (6 density channels, n x n) + features.scalars. Model: a small CNN (3 conv blocks, global
mean + max pool) joined with the scalars, then an MLP; target log1p(unrouted). Channel and scalar scales come
from the training set and are saved in the checkpoint. Torch on MPS (float32) or CPU.

API:
  m = Surrogate.load('model.pt', device='mps')
  m.score(pr, pose) -> predicted unrouted count; m.batch_score(pr, poses) -> list (one board, many candidates)
Command line (KiCad Python, torch in its user site):
  surrogate.py build OUT.npz CASES.json SAMPLES.jsonl...     features of generated samples (surrogate_gen.py)
      CASES.json: {case name: {"board": BOARD NAME, "prob": PROB.json}}
  surrogate.py train DATA.npz -o model.pt --holdout BOARD,BOARD [--device mps] [--epochs 80]
      prints Spearman and top-10 % recall (true best 10 % inside the predicted best 30 %) per held-out board
"""
import argparse
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import features  # noqa: E402

N = 64


def spearman(a, b):
    """Rank correlation; 0 when one side is constant (no order to compare)."""
    from placer import bench
    a, b = list(map(float, a)), list(map(float, b))
    return bench.spearman(a, b) if len(set(a)) > 1 and len(set(b)) > 1 else 0.0


def topk_recall(pred, true, k_true=0.1, k_pred=0.3):
    """Share of the true best k_true (lowest true values; all items tied with the cut value count) that are in the
    best k_pred of pred (at least 1 item each)."""
    pred, true = np.asarray(pred, float), np.asarray(true, float)
    n = len(true)
    cut = np.sort(true)[max(1, int(round(k_true * n))) - 1]
    best = np.flatnonzero(true <= cut)
    top = set(np.argsort(pred, kind='stable')[:max(1, int(round(k_pred * n)))].tolist())
    return sum(1 for i in best if i in top) / len(best)


def split(groups, holdout):
    """Index arrays (train, test): test = the items whose group is in holdout."""
    g = np.asarray(groups)
    te = np.isin(g, list(holdout))
    return np.flatnonzero(~te), np.flatnonzero(te)


def featurize(pr, pose, n=N):
    x, _ = features.rasterize(pr, pose, n)
    return x, np.asarray(features.scalars(pr, pose, x), np.float32)


def featurize_many(pr, poses, n=N):
    xs, ss = zip(*(featurize(pr, p, n) for p in poses))
    return np.stack(xs), np.stack(ss)


def _net(nc, ns, width=32):
    import torch.nn as nn

    class Net(nn.Module):
        def __init__(self):
            super().__init__()
            w = width

            def block(a, b):
                return [nn.Conv2d(a, b, 3, padding=1), nn.GELU(), nn.Conv2d(b, b, 3, padding=1), nn.GELU(),
                        nn.AvgPool2d(2)]
            self.conv = nn.Sequential(*block(nc, w // 2), *block(w // 2, w), *block(w, 2 * w))
            self.head = nn.Sequential(nn.Linear(4 * w + ns, 64), nn.GELU(), nn.Linear(64, 1))

        def forward(self, x, s):
            import torch
            h = self.conv(x)
            h = torch.cat([h.mean((2, 3)), h.amax((2, 3)), s], 1)
            return self.head(h)[:, 0]
    return Net()


class Surrogate:
    def __init__(self, net, norm, n, device):
        self.net, self.norm, self.n, self.device = net, norm, n, device

    def _t(self, x, s):
        import torch
        xm, xs, sm, ss = (torch.as_tensor(self.norm[k], dtype=torch.float32, device=self.device)
                          for k in ('xm', 'xs', 'sm', 'ss'))
        x = (torch.as_tensor(np.asarray(x), dtype=torch.float32, device=self.device) - xm[:, None, None]) \
            / xs[:, None, None]
        s = (torch.as_tensor(np.asarray(s), dtype=torch.float32, device=self.device) - sm) / ss
        return x, s

    def predict(self, x, s, batch=256):
        """log1p(unrouted) predictions of feature arrays."""
        import torch
        self.net.eval()
        out = []
        with torch.no_grad():
            for k in range(0, len(x), batch):
                out.append(self.net(*self._t(x[k:k + batch], s[k:k + batch])).cpu().numpy())
        return np.concatenate(out) if out else np.zeros(0)

    def batch_score(self, pr, poses):
        x, s = featurize_many(pr, poses, self.n)
        return [float(v) for v in np.maximum(np.expm1(self.predict(x, s)), 0.0)]

    def score(self, pr, pose):
        return self.batch_score(pr, [pose])[0]

    def save(self, path):
        import torch
        torch.save({'state': {k: v.cpu() for k, v in self.net.state_dict().items()}, 'norm': self.norm,
                    'n': self.n, 'nc': len(self.norm['xm']), 'ns': len(self.norm['sm'])}, path)

    @classmethod
    def load(cls, path, device='cpu'):
        import torch
        ck = torch.load(path, map_location='cpu', weights_only=False)
        net = _net(ck['nc'], ck['ns'])
        net.load_state_dict(ck['state'])
        return cls(net.to(device), ck['norm'], ck['n'], device)


def train(x, s, y, groups, epochs=80, seed=0, device='cpu', lr=2e-3, batch=64, log=None):
    """Fit on feature arrays x (N, C, n, n), s (N, S) and unrouted counts y. Loss: MSE on log1p(y) plus a
    pairwise rank term inside each group (a board): the model must order the candidates of one board."""
    import torch
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    x, s = np.asarray(x, np.float32), np.asarray(s, np.float32)
    t = np.log1p(np.asarray(y, np.float64)).astype(np.float32)
    norm = {'xm': x.mean((0, 2, 3)), 'xs': np.maximum(x.std((0, 2, 3)), 0.05), 'sm': s.mean(0),
            'ss': np.maximum(s.std(0), 0.05)}  # a floor: a flat channel in training must not blow up later
    m = Surrogate(_net(x.shape[1], s.shape[1]).to(device), norm, x.shape[2], device)
    opt = torch.optim.AdamW(m.net.parameters(), lr=lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, epochs)
    g = np.unique(np.asarray(groups), return_inverse=True)[1]
    for ep in range(epochs):
        m.net.train()
        order = rng.permutation(len(x))
        tot = 0.0
        for k in range(0, len(order), batch):
            idx = order[k:k + batch]
            xb, sb = m._t(x[idx], s[idx])
            tb = torch.as_tensor(t[idx], device=device)
            gb = torch.as_tensor(g[idx], device=device)
            p = m.net(xb, sb)
            loss = torch.mean((p - tb) ** 2)
            same = (gb[:, None] == gb[None, :]) & (tb[:, None] < tb[None, :])
            if same.any():
                loss = loss + torch.nn.functional.softplus(p[:, None] - p[None, :])[same].mean()
            opt.zero_grad()
            loss.backward()
            opt.step()
            tot += loss.item() * len(idx)
        sched.step()
        if log:
            log('epoch %d loss %.4f' % (ep, tot / len(x)))
    return m


def cmd_build(a):
    cases = json.load(open(a.cases))
    probs = {c: json.load(open(v['prob'])) for c, v in cases.items()}
    xs, ss, ys, gs = [], [], [], []
    for path in a.samples:
        for line in open(path):
            r = json.loads(line)
            if r.get('unrouted') is None or r.get('capped') or r['case'] not in probs:
                continue
            x, s = featurize(probs[r['case']], [tuple(q) for q in r['pose']], a.n)
            xs.append(x)
            ss.append(s)
            ys.append(r['unrouted'])
            gs.append(cases[r['case']]['board'])
    np.savez_compressed(a.out, x=np.stack(xs), s=np.stack(ss), y=np.array(ys), g=np.array(gs))
    for b in sorted(set(gs)):
        v = [y for y, g in zip(ys, gs) if g == b]
        print('%-14s n %4d unrouted min %d median %d max %d' % (b, len(v), min(v), int(np.median(v)), max(v)))


def evaluate(m, x, s, y, g):
    rows = []
    for b in sorted(set(g)):
        i = np.flatnonzero(np.asarray(g) == b)
        p = m.predict(x[i], s[i])
        rows.append((b, len(i), spearman(p, y[i]), topk_recall(p, y[i], 0.1, 0.3)))
    return rows


def cmd_train(a):
    d = np.load(a.data)
    x, s, y, g = d['x'], d['s'], d['y'], d['g']
    tr, te = split(g, a.holdout.split(',') if a.holdout else [])
    t0 = time.time()
    m = train(x[tr], s[tr], y[tr], g[tr], epochs=a.epochs, seed=a.seed, device=a.device,
              log=lambda t: print(t, flush=True) if a.verbose else None)
    print('train n %d, %.0f s on %s' % (len(tr), time.time() - t0, a.device))
    m.save(a.o)
    for name, idx in (('train', tr), ('held-out', te)):
        if len(idx):
            for b, n, rho, rec in evaluate(m, x[idx], s[idx], y[idx], g[idx]):
                print('%-8s %-14s n %4d Spearman %.2f top-10%% recall %.2f' % (name, b, n, rho, rec))


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('build')
    r.add_argument('out')
    r.add_argument('cases')
    r.add_argument('samples', nargs='+')
    r.add_argument('--n', type=int, default=N)
    r = sub.add_parser('train')
    r.add_argument('data')
    r.add_argument('-o', required=True)
    r.add_argument('--holdout', default='')
    r.add_argument('--device', default='cpu')
    r.add_argument('--epochs', type=int, default=80)
    r.add_argument('--seed', type=int, default=0)
    r.add_argument('--verbose', action='store_true')
    a = ap.parse_args(argv)
    {'build': cmd_build, 'train': cmd_train}[a.cmd](a)


if __name__ == '__main__':
    main()
