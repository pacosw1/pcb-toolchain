#!/usr/bin/env python3
"""Speed benchmark of the anneal: cost evaluations per second and the final cost after a wall-clock budget.

  $PY tools/placer/bench_batch.py PROB.json --mode scalar --seconds 60 --seed 1
  $PY tools/placer/bench_batch.py PROB.json --mode batch --device mps --chains 256 [--spec 4] --seconds 60 --seed 1

Start = bench.scramble(problem, 7) (uniform, seeded). Schedule = geometric over the budget: T from the sampled t0
to t0 * t_ratio, window from half the board to w1. The final cost is the scalar cost.total of the best pose
(float64), so all modes compare on one scale. One JSON line per run on stdout.
"""
import argparse
import json
import os
import random
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import anneal, bench, cost  # noqa: E402


def run_scalar(pr, p, start, seconds, seed, clock=time.monotonic):
    ev = cost.Evaluator(pr, p, pose=start)
    mover = anneal.Mover(pr, ev, p)
    rng = random.Random(seed)
    bx0, by0, bx1, by1 = cost.outline_box(pr['board'])
    w0, w1 = max(bx1 - bx0, by1 - by0) / 2, p['w1']
    t0 = anneal.estimate_t0(ev, mover, rng, w0)
    t1 = t0 * p['t_ratio']
    best, best_pose = ev.cost, ev.pose()
    t_start = clock()
    n, chunk = 0, 200
    while True:
        f = min((clock() - t_start) / seconds, 1.0)
        if f >= 1.0:
            break
        T, w = t0 * (t1 / t0) ** f, w0 * (w1 / w0) ** f  # constant within one chunk
        b, bp = anneal.anneal(ev, mover, rng, chunk, T, T, w, w)
        n += chunk
        if b < best:
            best, best_pose = b, bp
    dt = clock() - t_start
    return {'evals': n, 'moves': n, 'seconds': dt, 'evals_per_s': n / dt, 'moves_per_s': n / dt, 'best_pose': best_pose}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('prob')
    ap.add_argument('--mode', choices=('scalar', 'batch'), default='scalar')
    ap.add_argument('--device', default='cpu')
    ap.add_argument('--chains', type=int, default=256)
    ap.add_argument('--spec', type=int, default=1, help='proposals per chain and step (batch)')
    ap.add_argument('--seconds', type=float, default=60.0)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--scramble', type=int, default=7)
    a = ap.parse_args(argv)
    pr = json.load(open(a.prob))
    p = anneal.params_all({})
    start = bench.scramble(pr, a.scramble)
    if a.mode == 'scalar':
        r = run_scalar(pr, p, start, a.seconds, a.seed)
    else:
        from placer import batch
        r = batch.anneal_budget(pr, p, start, a.seconds, a.seed, chains=a.chains, device=a.device, spec=a.spec)
    r['final_cost'] = cost.total(pr, r.pop('best_pose'), p)
    r.update(prob=os.path.basename(a.prob), mode=a.mode, device=a.device if a.mode == 'batch' else '-',
             chains=a.chains if a.mode == 'batch' else 1, spec=a.spec if a.mode == 'batch' else 1,
             seed=a.seed, budget_s=a.seconds)
    print(json.dumps(r))


if __name__ == '__main__':
    main()
