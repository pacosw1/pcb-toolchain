#!/usr/bin/env python3
"""Placement benchmark at the real outline, judged by Fastroute (tools/fastroute_job.py). Runs on this computer.

  $PY tools/placer/bench_place.py PROB.json BOARD.kicad_pcb OUTDIR [--seeds 1 2 3] [--workers 12] [--epochs 6] [--steps 8000]

PROB.json: `cli.py read` of BOARD (a copy with the movable routes stripped). Variants:
  hand    the placement of BOARD as it is (one route)
  anneal  annealer from a seeded random start (bench.scatter)
  gp      analytic global placement (global=1) from the same start, then a short low-temperature anneal
  warm    short low-temperature anneal from the hand placement
Each candidate is written with kicad_io.write_board and routed once (Fastroute is deterministic).
Result: OUTDIR/results.json and a markdown table on stdout. Question: does an automatic placement route as
well as the hand placement on the same outline?
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import bench, kicad_io  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VARIANTS = {'anneal': (True, []), 'gp': (True, ['global=1', 't0=5', 'w0=5']), 'warm': (False, ['t0=5', 'w0=5'])}


def route(board, outdir):
    cmd = [sys.executable, os.path.join(REPO, 'tools', 'fastroute_job.py'), board, outdir, '--gnd-vias', '--render']
    p = subprocess.run(cmd, cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    m = re.search(r'UNROUTED (\d+) GND_OPEN (\d+) ERRORS (\d+) .*TRACK_MM (\d+) VIAS (\d+) SECONDS (\d+)', p.stdout)
    if p.returncode != 0 or not m:
        return {'failed': p.stdout[-300:]}
    return dict(zip(('unrouted', 'gnd_open', 'errors', 'track_mm', 'vias', 'seconds'), map(int, m.groups())))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('prob')
    ap.add_argument('board')
    ap.add_argument('outdir')
    ap.add_argument('--seeds', type=int, nargs='+', default=[1, 2, 3])
    ap.add_argument('--workers', type=int, default=12)
    ap.add_argument('--epochs', type=int, default=6)
    ap.add_argument('--steps', type=int, default=8000)
    ap.add_argument('--only', nargs='*', default=[])
    a = ap.parse_args()
    pr = json.load(open(a.prob))
    name = os.path.splitext(os.path.basename(a.board))[0]
    src = os.path.dirname(os.path.abspath(a.board))
    os.makedirs(a.outdir, exist_ok=True)
    rows = []
    if not a.only or 'hand' in a.only:
        rows.append({'variant': 'hand', 'seed': 0, **route(a.board, os.path.join(a.outdir, 'hand'))})
        print(rows[-1], flush=True)
    for variant, (scatter, params) in VARIANTS.items():
        if a.only and variant not in a.only:
            continue
        for seed in a.seeds:
            d = os.path.join(a.outdir, '%s-%d' % (variant, seed))
            os.makedirs(os.path.join(d, 'b'), exist_ok=True)
            q = bench.scatter(pr, seed) if scatter else pr
            json.dump(q, open(os.path.join(d, 'prob.json'), 'w'))
            res_path = os.path.join(d, 'res.json')
            cmd = [sys.executable, os.path.join(REPO, 'tools', 'placer', 'cli.py'), 'run', os.path.join(d, 'prob.json'),
                   '-o', res_path, '--workers', str(a.workers), '--epochs', str(a.epochs), '--steps', str(a.steps),
                   '--seed', str(seed), '--top', '1'] + (['--param'] + params if params else [])
            with open(os.path.join(d, 'search.log'), 'w') as fh:
                subprocess.run(cmd, cwd=REPO, stdout=fh, stderr=subprocess.STDOUT)
            row = {'variant': variant, 'seed': seed}
            if not os.path.exists(res_path):
                row['failed'] = 'no search result'
            else:
                res = json.load(open(res_path))
                c = res['candidates'][0]
                row.update(illegal=len(c['illegal']), hpwl=round(c['components']['hpwl']), search_s=round(res['wall_s']))
                for ext in ('.kicad_pro', '.kicad_dru'):
                    if os.path.exists(os.path.join(src, name + ext)):
                        shutil.copy(os.path.join(src, name + ext), os.path.join(d, 'b'))
                out = os.path.join(d, 'b', name + '.kicad_pcb')
                kicad_io.write_board(a.board, pr, [tuple(p) for p in c['pose']], out)
                row.update(route(out, os.path.join(d, 'route')))
            rows.append(row)
            print(row, flush=True)
            json.dump(rows, open(os.path.join(a.outdir, 'results.json'), 'w'), indent=1)
    json.dump(rows, open(os.path.join(a.outdir, 'results.json'), 'w'), indent=1)
    print('\n| Variant | Seed | Signal open | GND open | DRC errors | Track mm | Vias | Illegal units | HPWL | Search s |\n|---|---|---|---|---|---|---|---|---|---|')
    for r in rows:
        print('| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |' % tuple(r.get(k, '-') for k in (
            'variant', 'seed', 'unrouted', 'gnd_open', 'errors', 'track_mm', 'vias', 'illegal', 'hpwl', 'search_s')))


if __name__ == '__main__':
    main()
