"""Routability surrogate: predicts the Freerouting unrouted count of a placement in milliseconds, so the placer can
send only its best candidates to Freerouting (on Hetzner).

Input: features.rasterize (6 density channels, n x n) + features.scalars. Model: a small CNN (3 conv blocks, global
mean + max pool) joined with the scalars, then an MLP; target log1p(unrouted). A second head gives the probability
that each net stays open (mean of the block-2 features over the net pin box + net features). Loss: MSE + a
pairwise rank term inside a board + BCE of the net head. Optional D4 augmentation. Channel and scalar scales come
from the training set and are saved in the checkpoint. Torch on MPS (float32) or CPU.

API:
  m = Surrogate.load('model.pt', device='mps')
  m.score(pr, pose) -> predicted unrouted count; m.batch_score(pr, poses) -> list (one board, many candidates)
Command line (KiCad Python, torch in its user site):
  surrogate.py build OUT.npz CASES.json SAMPLES.jsonl...     features of generated samples (surrogate_gen.py)
      CASES.json: {case name: {"board": BOARD NAME, "prob": PROB.json}}
  surrogate.py train DATA.npz -o model.pt --holdout BOARD,BOARD [--device mps] [--epochs 80] [--aug]
      prints Spearman, top-10 % recall (true best 10 % inside the predicted best 30 %) and the per-net open AUC
      per board, for the training boards and the held-out boards
  surrogate.py eval model.pt DATA.npz      the same table for another data set
"""
import argparse
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import cost, features  # noqa: E402

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


def auc(score, label):
    """Area under the ROC curve (ties count half); NaN when one class is missing."""
    score, label = np.asarray(score, float), np.asarray(label) > 0.5
    pos, neg = score[label], score[~label]
    if not len(pos) or not len(neg):
        return float('nan')
    return float(((pos[:, None] > neg[None, :]).sum() + 0.5 * (pos[:, None] == neg[None, :]).sum())
                 / (len(pos) * len(neg)))


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


def d4(x, box, k):
    """Transform k (0..7) of the square symmetry group D4 on rasters x (..., n, n) and net boxes (M, 4) in grid
    fractions [x0, y0, x1, y1]: bit 4 = transpose, bit 1 = flip x (columns), bit 2 = flip y (rows). The copper
    layers stay as they are (the channels have no layer side)."""
    box = np.asarray(box, np.float32).reshape(-1, 4).copy()
    if k & 4:
        x = np.swapaxes(x, -1, -2)
        box = box[:, [1, 0, 3, 2]]
    if k & 1:
        x = x[..., ::-1]
        box[:, [0, 2]] = 1.0 - box[:, [2, 0]]
    if k & 2:
        x = x[..., ::-1, :]
        box[:, [1, 3]] = 1.0 - box[:, [3, 1]]
    return np.ascontiguousarray(x), box


def net_rows(pr, pose, g, open_nets):
    """Per problem net: pin box in grid fractions (M, 4), features [log1p(HPWL mm), pin count, track mm] (M, 3)
    and label 1.0 when the router left an open connection on it (open_nets: {net name: count})."""
    span = g['cell'] * g['n']
    box, feat, lab = [], [], []
    for net in pr['nets']:
        bx0, by0, bx1, by1 = cost.net_box(net, pose)
        box.append([(bx0 - g['x0']) / span, (by0 - g['y0']) / span, (bx1 - g['x0']) / span, (by1 - g['y0']) / span])
        feat.append([np.log1p((bx1 - bx0) + (by1 - by0)), len(net['pins']), net.get('track', 0.0)])
        lab.append(1.0 if open_nets.get(net['name'], 0) > 0 else 0.0)
    return np.array(box, np.float32).reshape(-1, 4), np.array(feat, np.float32).reshape(-1, 3), \
        np.array(lab, np.float32)


def _net(nc, ns, width=32, nf=3):
    import torch
    import torch.nn as nn

    class Net(nn.Module):
        def __init__(self):
            super().__init__()
            w = width

            def block(a, b):
                return [nn.Conv2d(a, b, 3, padding=1), nn.GELU(), nn.Conv2d(b, b, 3, padding=1), nn.GELU(),
                        nn.AvgPool2d(2)]
            self.c12 = nn.Sequential(*block(nc, w // 2), *block(w // 2, w))
            self.c3 = nn.Sequential(*block(w, 2 * w))
            self.head = nn.Sequential(nn.Linear(4 * w + ns, 64), nn.GELU(), nn.Linear(64, 1))
            self.nhead = nn.Sequential(nn.Linear(w + nf, 32), nn.GELU(), nn.Linear(32, 1))

        def forward(self, x, s, nets=None):
            """nets = (sample index (M,), boxes (M, 4) in grid fractions, features (M, nf)) -> net logits too."""
            f = self.c12(x)
            h = self.c3(f)
            y = self.head(torch.cat([h.mean((2, 3)), h.amax((2, 3)), s], 1))[:, 0]
            if nets is None:
                return y, None
            idx, box, nf_ = nets
            m = f.shape[-1]
            c = (torch.arange(m, device=f.device, dtype=f.dtype) + 0.5) / m
            half = 0.5 / m
            mx = (c[None, :] >= box[:, 0:1] - half) & (c[None, :] <= box[:, 2:3] + half)
            my = (c[None, :] >= box[:, 1:2] - half) & (c[None, :] <= box[:, 3:4] + half)
            mask = (my[:, :, None] & mx[:, None, :]).to(f.dtype)
            mask = mask / mask.sum((1, 2), keepdim=True).clamp(min=1.0)
            pooled = torch.einsum('nhw,nchw->nc', mask, f[idx])
            return y, self.nhead(torch.cat([pooled, nf_], 1))[:, 0]
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

    def _nets(self, rows, boxes=None):
        """Torch net inputs of a batch: rows = [(box, feat, lab) per sample]; boxes replaces the boxes (D4)."""
        import torch
        idx = np.concatenate([np.full(len(r[1]), k) for k, r in enumerate(rows)]).astype(np.int64)
        box = np.concatenate([r[0] for r in rows]) if boxes is None else boxes
        feat = (np.concatenate([r[1] for r in rows]) - self.norm['nm']) / self.norm['nsd']
        dev = self.device
        return (torch.as_tensor(idx, device=dev), torch.as_tensor(box, dtype=torch.float32, device=dev),
                torch.as_tensor(feat, dtype=torch.float32, device=dev))

    def predict(self, x, s, batch=256):
        """log1p(unrouted) predictions of feature arrays."""
        import torch
        self.net.eval()
        out = []
        with torch.no_grad():
            for k in range(0, len(x), batch):
                out.append(self.net(*self._t(x[k:k + batch], s[k:k + batch]))[0].cpu().numpy())
        return np.concatenate(out) if out else np.zeros(0)

    def predict_nets(self, x, s, rows):
        """Per sample: the probability that the router leaves each net open (rows as in train)."""
        import torch
        self.net.eval()
        out = []
        with torch.no_grad():
            for k in range(len(x)):
                _, z = self.net(*self._t(x[k:k + 1], s[k:k + 1]), self._nets(rows[k:k + 1]))
                out.append(torch.sigmoid(z).cpu().numpy())
        return out

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


def train(x, s, y, groups, nets=None, epochs=80, seed=0, device='cpu', lr=2e-3, batch=64, aug=False, w_net=0.5,
          log=None):
    """Fit on feature arrays x (N, C, n, n), s (N, S) and unrouted counts y. Loss: MSE on log1p(y) plus a
    pairwise rank term inside each group (a board): the model must order the candidates of one board.
    nets: per sample (boxes, features, labels) from net_rows: adds w_net x the BCE of the per-net open head.
    aug: each batch gets one random D4 transform (d4) of the rasters and the net boxes."""
    import torch
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    x, s = np.asarray(x, np.float32), np.asarray(s, np.float32)
    t = np.log1p(np.asarray(y, np.float64)).astype(np.float32)
    nf = np.concatenate([r[1] for r in nets]) if nets else np.zeros((1, 3), np.float32)
    norm = {'xm': x.mean((0, 2, 3)), 'xs': np.maximum(x.std((0, 2, 3)), 0.05), 'sm': s.mean(0),
            'ss': np.maximum(s.std(0), 0.05),  # a floor: a flat channel in training must not blow up later
            'nm': nf.mean(0), 'nsd': np.maximum(nf.std(0), 0.05)}
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
            rows = [nets[i] for i in idx] if nets else None
            xk = x[idx]
            boxes = np.concatenate([r[0] for r in rows]) if rows else np.zeros((0, 4), np.float32)
            if aug:
                xk, boxes = d4(xk, boxes, int(rng.integers(8)))
            xb, sb = m._t(xk, s[idx])
            tb = torch.as_tensor(t[idx], device=device)
            gb = torch.as_tensor(g[idx], device=device)
            p, z = m.net(xb, sb, m._nets(rows, boxes) if rows else None)
            loss = torch.mean((p - tb) ** 2)
            same = (gb[:, None] == gb[None, :]) & (tb[:, None] < tb[None, :])
            if same.any():
                loss = loss + torch.nn.functional.softplus(p[:, None] - p[None, :])[same].mean()
            if z is not None and len(z):
                lab = torch.as_tensor(np.concatenate([r[2] for r in rows]), device=device)
                loss = loss + w_net * torch.nn.functional.binary_cross_entropy_with_logits(z, lab)
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
    xs, ss, ys, gs, tos, ni, nb, nf, nl = [], [], [], [], [], [], [], [], []
    for path in a.samples:
        for line in open(path):
            r = json.loads(line)
            if r.get('unrouted') is None or r.get('capped') or r['case'] not in probs:
                continue
            pr, pose = probs[r['case']], [tuple(q) for q in r['pose']]
            x, s = featurize(pr, pose, a.n)
            box, feat, lab = net_rows(pr, pose, features.grid_of(pr['board'], a.n), r.get('open_nets', {}))
            ni.append(np.full(len(lab), len(xs)))
            nb.append(box)
            nf.append(feat)
            nl.append(lab)
            xs.append(x)
            ss.append(s)
            ys.append(r['unrouted'])
            gs.append(cases[r['case']]['board'])
            tos.append(bool(r.get('timeout')))
    np.savez_compressed(a.out, x=np.stack(xs), s=np.stack(ss), y=np.array(ys), g=np.array(gs), timeout=np.array(tos),
                        net_i=np.concatenate(ni), net_box=np.concatenate(nb), net_feat=np.concatenate(nf),
                        net_lab=np.concatenate(nl))
    for b in sorted(set(gs)):
        v = [y for y, g in zip(ys, gs) if g == b]
        t = sum(1 for o, g in zip(tos, gs) if o and g == b)
        print('%-14s n %4d timeouts %4d unrouted min %d median %d max %d' % (
            b, len(v), t, min(v), int(np.median(v)), max(v)))


def load_data(path):
    """npz from build -> dict with x, s, y, g and nets = [(boxes, features, labels) per sample] (None if absent)."""
    d = dict(np.load(path))
    if 'net_i' in d:
        cut = np.searchsorted(d['net_i'], np.arange(len(d['y']) + 1))
        d['nets'] = [(d['net_box'][a:b], d['net_feat'][a:b], d['net_lab'][a:b]) for a, b in zip(cut[:-1], cut[1:])]
    else:
        d['nets'] = None
    return d


def evaluate(m, d, idx):
    """Per board of the items idx: (board, n, Spearman, top-10 % recall, net AUC or NaN)."""
    rows = []
    g = d['g'][idx]
    for b in sorted(set(g)):
        i = idx[g == b]
        p = m.predict(d['x'][i], d['s'][i])
        a = float('nan')
        if d['nets'] is not None:
            rs = [d['nets'][k] for k in i]
            a = auc(np.concatenate(m.predict_nets(d['x'][i], d['s'][i], rs)), np.concatenate([r[2] for r in rs]))
        rows.append((b, len(i), spearman(p, d['y'][i]), topk_recall(p, d['y'][i], 0.1, 0.3), a))
    return rows


def _print_rows(name, rows):
    for b, n, rho, rec, a in rows:
        print('%-8s %-14s n %4d Spearman %5.2f top-10%% recall %.2f net AUC %.2f' % (name, b, n, rho, rec, a))


def cmd_train(a):
    d = load_data(a.data)
    tr, te = split(d['g'], a.holdout.split(',') if a.holdout else [])
    t0 = time.time()
    m = train(d['x'][tr], d['s'][tr], d['y'][tr], d['g'][tr], nets=[d['nets'][k] for k in tr] if d['nets'] else None,
              epochs=a.epochs, seed=a.seed, device=a.device, aug=a.aug,
              log=lambda t: print(t, flush=True) if a.verbose else None)
    print('train n %d, %.0f s on %s, aug %s' % (len(tr), time.time() - t0, a.device, a.aug))
    m.save(a.o)
    _print_rows('train', evaluate(m, d, tr))
    if len(te):
        _print_rows('held-out', evaluate(m, d, te))


def cmd_eval(a):
    m = Surrogate.load(a.model, device=a.device)
    d = load_data(a.data)
    _print_rows('eval', evaluate(m, d, np.arange(len(d['y']))))


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
    r.add_argument('--aug', action='store_true', help='D4 augmentation (flip and turn the whole raster)')
    r.add_argument('--verbose', action='store_true')
    r = sub.add_parser('eval')
    r.add_argument('model')
    r.add_argument('data')
    r.add_argument('--device', default='cpu')
    a = ap.parse_args(argv)
    {'build': cmd_build, 'train': cmd_train, 'eval': cmd_eval}[a.cmd](a)


if __name__ == '__main__':
    main()
