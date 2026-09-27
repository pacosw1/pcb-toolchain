#!/usr/bin/env python3
"""Compaction driver: search and Freerouting on Hetzner (tools/remote.sh), writer on the Mac.

  $PY tools/placer/compact_cli.py PROB.json BOARD.kicad_pcb --board-dir hardware-design/boards/X/cad/X \
      --outdir DIR --size W H --wheel numpy-...whl [--s0 4] [--budget 2700] [--routes 2] [--target 0]

PROB.json comes from `cli.py read` on BOARD (a copy with the signal tracks removed). Each step writes
DIR/step-N/ (prob.json, search/, b/<board>.kicad_pcb, route-K/). DIR/run.json holds the problem, every
step (s, k, router runs, epoch history, pose) and the verdict, for the viewer (viewer.py).
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import bench, compact  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NO_RESULT = 10 ** 6  # a router job without an UNROUTED line (transport error, timeout) never passes


def parse_unrouted(text):
    m = re.findall(r'^UNROUTED (\d+)', text, re.M)
    return int(m[-1]) if m else NO_RESULT


def _remote(board_dir, ins, results, cmd, cpus, log_path):
    env = dict(os.environ, REMOTE_MEM='8g', REMOTE_CPUS=str(cpus))
    args = ['tools/remote.sh', board_dir] + [x for f in ins for x in ('--in', f)] + ['--results', results, '--'] + cmd
    with open(log_path, 'w') as fh:
        rc = subprocess.run(args, cwd=REPO, env=env, stdout=fh, stderr=subprocess.STDOUT).returncode
    return rc, open(log_path).read()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('prob')
    ap.add_argument('board')
    ap.add_argument('--board-dir', required=True, help='repo board folder for tools/remote.sh (read only)')
    ap.add_argument('--outdir', required=True)
    ap.add_argument('--size', type=float, nargs=2, required=True, metavar=('W', 'H'))
    ap.add_argument('--wheel', required=True, help='numpy cp313 manylinux wheel for the remote search')
    ap.add_argument('--s0', type=float, default=4.0)
    ap.add_argument('--budget', type=float, default=2700.0, help='seconds (default 45 min)')
    ap.add_argument('--target', type=int, default=0)
    ap.add_argument('--routes', type=int, default=2, help='parallel Freerouting runs per step (best counts)')
    ap.add_argument('--workers', type=int, default=30)
    ap.add_argument('--epochs', type=int, default=20)
    ap.add_argument('--steps', type=int, default=12000)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--param', nargs='*', default=[])
    ap.add_argument('--scatter', type=int, metavar='SEED', help='start each search from seeded uniform places inside '
                    'the (virtual) board: for parts staged outside the outline')
    ap.add_argument('--snapshots', metavar='DIR', help='after the run: viewer.html, frames.json, timelapse '
                    '(PNG frames, run.gif, run.mp4) and one routed render per step in DIR (scratch, not committed)')
    a = ap.parse_args(argv)
    from placer import kicad_io
    pr = json.load(open(a.prob))
    os.makedirs(a.outdir, exist_ok=True)
    name = os.path.splitext(os.path.basename(a.board))[0]
    src = os.path.dirname(os.path.abspath(a.board))
    wheel = os.path.abspath(a.wheel)

    def sdir(n):
        d = os.path.join(os.path.abspath(a.outdir), 'step-%d' % n)
        os.makedirs(d, exist_ok=True)
        return d

    def search(q, n):
        d = sdir(n)
        if a.scatter is not None:
            q = bench.scatter(q, a.scatter)
        json.dump(q, open(os.path.join(d, 'prob.json'), 'w'))
        cmd = ['bash', 'tools/placer/remote_run.sh', 'run', 'in/prob.json', '-o', 'out/res.json',
               '--workers', str(a.workers), '--epochs', str(a.epochs), '--steps', str(a.steps),
               '--seed', str(a.seed), '--top', '1'] + (['--param'] + a.param if a.param else [])
        rc, _ = _remote(a.board_dir, [os.path.join(d, 'prob.json'), wheel], os.path.join(d, 'search'), cmd,
                        a.workers, os.path.join(d, 'search.log'))
        res_path = os.path.join(d, 'search', 'res.json')
        if not os.path.exists(res_path):
            raise RuntimeError('search step %d failed (rc %d), see %s' % (n, rc, os.path.join(d, 'search.log')))
        return json.load(open(res_path))

    def write(q, pose, k, n):
        b = os.path.join(sdir(n), 'b')
        os.makedirs(b, exist_ok=True)
        for ext in ('.kicad_pro', '.kicad_dru'):
            if os.path.exists(os.path.join(src, name + ext)):
                shutil.copy(os.path.join(src, name + ext), b)
        out = os.path.join(b, name + '.kicad_pcb')
        kicad_io.write_board(a.board, q, [tuple(p) for p in pose], out, outline_scale=k)
        return out

    def route(path, n):
        d = sdir(n)
        b = os.path.dirname(path)
        ins = [os.path.join(b, name + ext) for ext in ('.kicad_pcb', '.kicad_pro', '.kicad_dru')
               if os.path.exists(os.path.join(b, name + ext))]

        def one(r):
            rc, text = _remote(a.board_dir, ins, os.path.join(d, 'route-%d' % r),
                               ['bash', 'tools/placer/fr_job.sh', name], 4, os.path.join(d, 'route-%d.log' % r))
            return parse_unrouted(text)
        with ThreadPoolExecutor(a.routes) as ex:
            return list(ex.map(one, range(a.routes)))

    run = compact.run_loop(pr, tuple(a.size), search, write, route, s0=a.s0, budget=a.budget, target=a.target,
                           log=lambda s: print(s, flush=True))
    run['problem'] = pr
    run['size'] = list(a.size)
    json.dump(run, open(os.path.join(a.outdir, 'run.json'), 'w'))
    print('VERDICT', run['verdict'])
    print('STOP', run['stop'])
    if run['best']:
        print('BEST board %s s %.3f k %.3f unrouted %d' % (run['best']['board'], run['best']['s'], run['best']['k'],
                                                          run['best']['unrouted']))
    if a.snapshots:
        from placer import movie, viewer
        rj = os.path.join(a.outdir, 'run.json')
        os.makedirs(a.snapshots, exist_ok=True)
        viewer.main([rj, os.path.join(a.snapshots, 'viewer.html'), '--frames-json',
                     os.path.join(a.snapshots, 'frames.json')])
        movie.main([rj, a.snapshots, '--routed', a.outdir])


if __name__ == '__main__':
    main()
