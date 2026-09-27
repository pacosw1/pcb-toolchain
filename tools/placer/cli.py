#!/usr/bin/env python3
"""Block placement optimizer: fast proxy cost (HPWL + RUDY + D-040 spacing) in parallel annealing.

Run with the KiCad bundled Python ($PY; it has numpy and pcbnew):
  $PY tools/placer/cli.py read  BOARD -o prob.json [--fix REF ...] [--skip-net=GND,+3V3,...] [--keepout-layer User.Comments]
                                 [--free-box X0 Y0 X1 Y1] [--region-ref U1 --region-weight 3 [--region-box ...]]
  $PY tools/placer/cli.py run   prob.json -o result.json [--workers 16 --epochs 20 --steps 20000 --seed 1 --top 3]
                                 [--param w_ov=20 ...]
  $PY tools/placer/cli.py write BOARD prob.json result.json --outdir DIR [--initial]
        DIR/candK/ = a copy of the board folder with candidate K placed (DIR/initial/ with --initial).
  $PY tools/placer/cli.py drc   DIR/candK/NAME.kicad_pcb ...
        kicad-cli pcb drc --schematic-parity --refill-zones; prints errors, parity, unconnected, courtyard.
The repo board is only read. Candidates are proposals: the board gates and a router decide.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import anneal, cost  # noqa: E402


def cmd_read(a):
    from placer import kicad_io
    pr = kicad_io.read_problem(a.board, fix=a.fix, skip=[x for x in a.skip_net.split(',') if x], edge_dist=a.edge_dist,
                               keepout_layers=a.keepout_layer, free_box=a.free_box,
                               region_refs=a.region_ref, region_weight=a.region_weight, region_box=a.region_box,
                               tie=a.tie)
    json.dump(pr, open(a.o, 'w'))
    mov = [u for u in pr['units'] if not u['fixed']]
    print('units %d (movable %d, blocks %d), nets %d, keepouts %d' % (
        len(pr['units']), len(mov), sum(1 for u in pr['units'] if u['box']), len(pr['nets']),
        len(pr['board']['keepouts'])))


def parse_params(items):
    p = {}
    for it in items:
        k, v = it.split('=', 1)
        p[k] = float(v)
    return p


def cmd_run(a):
    pr = json.load(open(a.prob))
    res = anneal.optimize(pr, parse_params(a.param), workers=a.workers, epochs=a.epochs, steps=a.steps,
                          seed=a.seed, top=a.top, log=lambda s: print(s, flush=True))
    json.dump(res, open(a.o, 'w'))
    fmt = lambda c: 'cost %.1f hpwl %.1f cong %.1f overlap %.3f oob %.3f' % (  # noqa: E731
        c['cost'], c['components']['hpwl'], c['components']['cong'], c['components']['overlap'],
        c['components']['oob'])
    print('initial   ' + fmt(res['initial']))
    for k, c in enumerate(res['candidates']):
        print('cand%d     %s illegal %d %s' % (k, fmt(c), len(c['illegal']), ' '.join(c['illegal'][:8])))
    print('wall %.0f s, %.0f moves/s per worker' % (res['wall_s'], res['moves_per_s_per_worker']))


def cmd_write(a):
    from placer import kicad_io
    pr = json.load(open(a.prob))
    res = json.load(open(a.result))
    jobs = [('cand%d' % k, c['pose']) for k, c in enumerate(res['candidates'])]
    if a.initial:
        jobs.insert(0, ('initial', cost.initial_pose(pr)))
    src = os.path.dirname(os.path.abspath(a.board))
    for name, pose in jobs:
        d = os.path.join(a.outdir, name)
        if os.path.exists(d):
            shutil.rmtree(d)
        shutil.copytree(src, d, ignore=shutil.ignore_patterns('*.kicad_prl', '*-backups', 'fp-info-cache'))
        out = os.path.join(d, os.path.basename(a.board))
        os.remove(out)
        rep = kicad_io.write_board(a.board, pr, [tuple(q) for q in pose], out)
        print(name, out, rep)


def drc_summary(board):
    out = os.path.splitext(board)[0] + '-drc.json'
    subprocess.run(['kicad-cli', 'pcb', 'drc', '--schematic-parity', '--refill-zones', '--format', 'json',
                    '-o', out, board], check=False, capture_output=True)
    d = json.load(open(out))
    errs = [v for v in d.get('violations', []) if v.get('severity') == 'error']
    kinds = {}
    for v in errs:
        kinds[v['type']] = kinds.get(v['type'], 0) + 1
    return {'errors': len(errs), 'parity': len(d.get('schematic_parity', [])),
            'unconnected': len(d.get('unconnected_items', [])), 'error_types': kinds}


def cmd_drc(a):
    for b in a.boards:
        print(b, json.dumps(drc_summary(b)))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('read')
    r.add_argument('board')
    r.add_argument('-o', required=True)
    r.add_argument('--fix', nargs='*', default=[])
    r.add_argument('--skip-net', default='GND', help='comma list of fnmatch patterns; use --skip-net=-15V,...')
    r.add_argument('--edge-dist', type=float, default=1.5)
    r.add_argument('--keepout-layer', nargs='*', default=[])
    r.add_argument('--free-box', nargs=4, type=float)
    r.add_argument('--region-ref', nargs='*', default=[])
    r.add_argument('--region-weight', type=float, default=1.0)
    r.add_argument('--region-box', nargs=4, type=float)
    r.add_argument("--tie", type=float, default=0.0, help="join <=3-pad parts within TIE mm to their IC unit")
    r.set_defaults(f=cmd_read)
    r = sub.add_parser('run')
    r.add_argument('prob')
    r.add_argument('-o', required=True)
    r.add_argument('--workers', type=int, default=os.cpu_count())
    r.add_argument('--epochs', type=int, default=20)
    r.add_argument('--steps', type=int, default=20000)
    r.add_argument('--seed', type=int, default=1)
    r.add_argument('--top', type=int, default=3)
    r.add_argument('--param', nargs='*', default=[])
    r.set_defaults(f=cmd_run)
    r = sub.add_parser('write')
    r.add_argument('board')
    r.add_argument('prob')
    r.add_argument('result')
    r.add_argument('--outdir', required=True)
    r.add_argument('--initial', action='store_true')
    r.set_defaults(f=cmd_write)
    r = sub.add_parser('drc')
    r.add_argument('boards', nargs='+')
    r.set_defaults(f=cmd_drc)
    a = ap.parse_args(argv)
    a.f(a)


if __name__ == '__main__':
    main()
