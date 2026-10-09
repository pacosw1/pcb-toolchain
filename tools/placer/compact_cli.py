#!/usr/bin/env python3
"""Compaction driver: search and Freerouting on Hetzner (tools/remote.sh), writer on the Mac.

  $PY tools/placer/compact_cli.py PROB.json BOARD.kicad_pcb --board-dir hardware-design/boards/X/cad/X \
      --outdir DIR --size W H --wheel numpy-...whl [--s0 4] [--budget 2700] [--routes 3] [--target 0]

PROB.json comes from `cli.py read` on BOARD (a copy with the signal tracks removed). Each step writes
DIR/step-N/ (prob.json, search/, b/<board>.kicad_pcb, route-K/). DIR/run.json holds the problem, every
step (s, k, router runs, epoch history, pose) and the verdict, for the viewer (viewer.py).
"""
import argparse
import copy
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import math
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import bench, compact  # noqa: E402
import lean_workflow as lean

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NO_RESULT = 10 ** 6  # a router job without an UNROUTED line (transport error, timeout) never passes


def parse_unrouted(text):
    m = re.findall(r'^UNROUTED (\d+)', text, re.M)
    return int(m[-1]) if m else NO_RESULT


def route_cmd(name, gnd_vias):
    cmd = ['bash', 'tools/placer/fr_job.sh', name]
    return ['env', 'GNDVIAS=1'] + cmd if gnd_vias else cmd


def _remote(board_dir, ins, results, cmd, cpus, log_path):
    env = dict(os.environ, REMOTE_MEM='8g', REMOTE_CPUS=str(cpus))
    args = ['tools/remote.sh', board_dir] + [x for f in ins for x in ('--in', f)] + ['--results', results, '--'] + cmd
    with open(log_path, 'w') as fh:
        rc = subprocess.run(args, cwd=REPO, env=env, stdout=fh, stderr=subprocess.STDOUT).returncode
    return rc, open(log_path).read()


def parser():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('prob')
    ap.add_argument('board')
    ap.add_argument('--board-dir', required=True, help='repo board folder for tools/remote.sh (read only)')
    ap.add_argument('--outdir', required=True)
    ap.add_argument('--size', type=float, nargs=2, required=True, metavar=('W', 'H'))
    ap.add_argument('--search', choices=['local', 'remote'], default='local', help='local: the search runs here '
                    '(default). remote: Hetzner, needs --wheel')
    ap.add_argument('--wheel', default='', help='numpy cp313 manylinux wheel for the remote search')
    ap.add_argument('--s0', type=float, default=4.0)
    ap.add_argument('--budget', type=float, default=2700.0, help='seconds (default 45 min)')
    ap.add_argument('--target', type=int, default=0)
    ap.add_argument('--routes', type=int, default=3, help='parallel Freerouting runs per step (pass: best run <= target)')
    ap.add_argument('--workers', type=int, default=30)
    ap.add_argument('--epochs', type=int, default=20)
    ap.add_argument('--steps', type=int, default=12000)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--param', nargs='*', default=[])
    ap.add_argument('--scatter', type=int, metavar='SEED', help='start each search from seeded uniform places inside '
                    'the (virtual) board: for parts staged outside the outline')
    ap.add_argument('--gnd-vias', action='store_true', help='tools/gnd_pad_vias.py before Freerouting: Freerouting '
                    'leaves GND pads open when the GND plane is on an inner layer')
    ap.add_argument('--snapshots', metavar='DIR', help='after the run: viewer.html, frames.json, timelapse '
                    '(PNG frames, run.gif, run.mp4) and one routed render per step in DIR (scratch, not committed)')
    ap.add_argument('--router', choices=['freerouting', 'fastroute'], default='fastroute',
                    help='fastroute: tools/fastroute_job.py on this computer (default). freerouting: 2.1.0 on Hetzner '
                    '(its timed-out runs lost most of the result, 2026-10-03; kept for old benchmarks only)')
    ap.add_argument('--passes', type=int, default=40, help='router passes per step (fastroute)')
    ap.add_argument('--diagnostic-budget', type=float, default=None,
                    help='seconds reserved for virtual diagnostics after real-outline failures')
    ap.add_argument('--optimizer', choices=['always', 'off', 'if-routed'], default='always')
    ap.add_argument('--route-args', default='', help='more arguments for tools/fastroute_job.py, one string '
                    '(for example "--layers F.Cu,In2.Cu,B.Cu --plane-nets GND,+3V3")')
    ap.add_argument('--virtual-first', action='store_true', help='old order: virtual (scaled) board first. Default: '
                    'the real outline first, at the largest halo that fits; the halo decreases only after a pass')
    ap.add_argument('--shrink', type=float, default=0.85, help='halo scale factor after a pass')
    ap.add_argument('--tol', type=float, default=0.05, help='halo bisection stops at this relative gap')
    return ap


def main(argv=None):
    a = parser().parse_args(argv)
    from placer import kicad_io
    if not math.isfinite(a.budget) or a.budget <= 0:
        raise ValueError('budget must be positive')
    if a.diagnostic_budget is not None and (not math.isfinite(a.diagnostic_budget) or a.diagnostic_budget < 0):
        raise ValueError('diagnostic budget must be finite and nonnegative')
    deadline = time.monotonic() + a.budget
    inherited = os.environ.get('IOT_LEAN_DEADLINE')
    if inherited:
        deadline = min(deadline, float(inherited))
    pr = json.load(open(a.prob))
    if os.path.isdir(a.outdir) and os.listdir(a.outdir):
        raise ValueError('compaction output directory must be fresh')
    os.makedirs(a.outdir, exist_ok=True)
    events = os.path.join(a.outdir, 'stages.jsonl')
    lean.atomic_json(os.path.join(a.outdir, 'input-manifest.json'),
                     dict(board=os.path.abspath(a.board), board_sha256=lean.digest(a.board),
                          problem_sha256=lean.digest(a.prob), configuration=vars(a), qualified=False,
                          note='run attribution only; no cached result reuse or release qualification'))
    def run_stage(cmd, stage, **kwargs):
        return lean.run_stage(cmd, stage=stage, event_file=events, deadline=deadline, **kwargs)
    name = os.path.splitext(os.path.basename(a.board))[0]
    src = os.path.dirname(os.path.abspath(a.board))
    wheel = os.path.abspath(a.wheel) if a.wheel else ''

    def sdir(n):
        d = os.path.join(os.path.abspath(a.outdir), 'step-%d' % n)
        os.makedirs(d, exist_ok=True)
        return d

    # Route feature pin_escape_check (tools/route-features.json): the parts with boxed-in pins of the last routed
    # step (route-0/pin-escape.json of tools/fastroute_job.py) get halo_hint_mm more spacing in the next search.
    escape_hint = {}

    def search(q, n):
        nonlocal deadline
        # Virtual input changes the outline; use it only as a bounded diagnostic.
        outline = q['board']['outline']
        xs, ys = [v[0] for v in outline], [v[1] for v in outline]
        virtual = max(xs)-min(xs) > a.size[0]+1e-6 or max(ys)-min(ys) > a.size[1]+1e-6
        if virtual and a.diagnostic_budget is not None and not getattr(search, 'diagnostic_started', False):
            deadline = min(deadline, time.monotonic()+a.diagnostic_budget)
            search.diagnostic_started = True
        d = sdir(n)
        if escape_hint:
            q = copy.deepcopy(q)
            for u in q['units']:
                names = set(u.get('refs', [])) | {u.get('name', ''), u.get('ref', '')}
                extra = max([escape_hint.get(r, 0.0) for r in names] + [0.0])
                if extra:
                    for r in u['rects']:
                        r[4] += extra
        if a.scatter is not None:
            q = bench.scatter(q, a.scatter)
        json.dump(q, open(os.path.join(d, 'prob.json'), 'w'))
        if a.search == 'local':
            # The search uses a.workers processes: a many-core job, so it runs here (KiCad Python has numpy).
            res_path = os.path.join(d, 'search', 'res.json')
            os.makedirs(os.path.dirname(res_path), exist_ok=True)
            cmd = [sys.executable, os.path.join(REPO, 'tools', 'placer', 'cli.py'), 'run', os.path.join(d, 'prob.json'),
                   '-o', res_path, '--workers', str(a.workers), '--epochs', str(a.epochs), '--steps', str(a.steps),
                   '--seed', str(a.seed), '--top', '1'] + (['--param'] + a.param if a.param else [])
            with open(os.path.join(d, 'search.log'), 'w') as fh:
                rc = run_stage(cmd, 'placement', cwd=REPO, stdout=fh, stderr=subprocess.STDOUT).returncode
            if not os.path.exists(res_path):
                print('search step %d: no result (rc %d), see %s' % (n, rc, os.path.join(d, 'search.log')), flush=True)
                return None
            return json.load(open(res_path))
        cmd = ['bash', 'tools/placer/remote_run.sh', 'run', 'in/prob.json', '-o', 'out/res.json',
               '--workers', str(a.workers), '--epochs', str(a.epochs), '--steps', str(a.steps),
               '--seed', str(a.seed), '--top', '1'] + (['--param'] + a.param if a.param else [])
        rc, _ = _remote(a.board_dir, [os.path.join(d, 'prob.json'), wheel], os.path.join(d, 'search'), cmd,
                        a.workers, os.path.join(d, 'search.log'))
        res_path = os.path.join(d, 'search', 'res.json')
        if not os.path.exists(res_path):
            print('search step %d: no result (rc %d), see %s' % (n, rc, os.path.join(d, 'search.log')), flush=True)
            return None
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

        if a.router == 'fastroute':
            # Fastroute runs here (many cores, user rule 2026-10-03); it is deterministic, so one run per step.
            # The count is the KiCad DRC unconnected count of the verified result (tools/fastroute_job.py).
            cmd = [sys.executable, os.path.join(REPO, 'tools', 'fastroute_job.py'), path, os.path.join(d, 'route-0'),
                   '--passes', str(a.passes), '--optimizer', a.optimizer, '--render'] + (['--gnd-vias'] if a.gnd_vias else []) + shlex.split(a.route_args)
            p = run_stage(cmd, 'routing', cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            open(os.path.join(d, 'route-0.log'), 'w').write(p.stdout)
            pe = os.path.join(d, 'route-0', 'pin-escape.json')
            if os.path.isfile(pe):
                for r, mm in json.load(open(pe)).get('halo_hint', {}).items():
                    escape_hint[r] = escape_hint.get(r, 0.0) + mm
            if p.returncode != 0:
                return [NO_RESULT]
            # A step passes on 0 open signal connections and 0 DRC errors (the plane-net opens are counted apart).
            m = re.findall(r'^UNROUTED (\d+) GND_OPEN \d+ ERRORS (\d+)', p.stdout, re.M)
            return [int(m[-1][0]) + int(m[-1][1])] if m else [NO_RESULT]

        def one(r):
            rc, text = _remote(a.board_dir, ins, os.path.join(d, 'route-%d' % r),
                               route_cmd(name, a.gnd_vias), 4, os.path.join(d, 'route-%d.log' % r))
            return parse_unrouted(text)
        with ThreadPoolExecutor(a.routes) as ex:
            return list(ex.map(one, range(a.routes)))

    run = compact.run_loop(pr, tuple(a.size), search, write, route, s0=a.s0,
                           budget=max(0., deadline-time.monotonic()), target=a.target,
                           shrink=a.shrink, tol=a.tol, log=lambda s: print(s, flush=True),
                           real_first=not a.virtual_first, diagnostic_budget=a.diagnostic_budget)
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
