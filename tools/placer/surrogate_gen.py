"""Scored placement samples for the routability surrogate (surrogate.py). Runs on the Hetzner box only.

Each sample: the original pose of a problem, a random fraction of the movable units moved by a normal step (and
turned), then anneal.legalize. A legal pose is written (kicad_io.write_board), routed once by Freerouting
(tools/freeroute.py, F.Cu + B.Cu, one fixed timeout for all samples) and counted from the kicad-cli DRC JSON.
An illegal pose is recorded without a route. One JSON line per sample goes to OUT/samples.jsonl:
  {case, seed, cfg, tries, pose, illegal, unrouted, errors, capped, wall_s}   (unrouted None: not routed)
  routed samples also: open_nets {net: open connections}, error_types, vias, track_mm, passes, route_s,
  timeout (the router used its whole limit with opens left: the count is an upper bound, not a low score)

  REMOTE_MEM=16g REMOTE_CPUS=15 REMOTE_TIMEOUT=560 tools/remote.sh <any board dir> \
      --in PROB.json --in B.kicad_pcb --in B.kicad_pro --in B.kicad_dru [...more cases] --in numpy-*.whl -- \
      python3 tools/placer/surrogate_gen.py --case NAME:in/PROB.json:in/B.kicad_pcb [...] \
      --seed S --workers 14 --budget 520 --timeout 00:01:30 -o out
The work files stay in work/ (not returned); only samples.jsonl and the log come back.

Data recipe (Mac, KiCad Python): `surrogate_gen.py prep OUT BOARD...` copies each repo board, removes all tracks
and vias except the ground plane nets (plane_nets), reads the problem (keepouts H*_KEEPOUT, BASE-PWR antenna
zone with U1) and writes OUT/cases.json {case: {board, prob, pcb, gnd, legal}}. GNDNET = the plane nets: each
routed sample first gets tools/gnd_pad_vias.py for each of them (the inner plane connects those pads).
"""
import argparse
import glob
import json
import os
import math
import random
import re
import shutil
import subprocess
import sys
import time
import zipfile

FRACS = (0.05, 0.1, 0.2, 0.4, 0.7)
SIGMAS = (0.5, 1.0, 2.0, 4.0, 8.0, 16.0)
TURNS = (0.0, 0.1, 0.3)
TRIES = 3  # legalizer tries per sample (retry_config between them)


def sample_config(rng):
    return {'frac': rng.choice(FRACS), 'sigma': rng.choice(SIGMAS), 'p_turn': rng.choice(TURNS)}


def case_rng(name, seed):
    """Seeded generator of one sample: other cases get other configs for the same seed."""
    return random.Random('%s:%d' % (name, seed))


def retry_config(cfg):
    """A smaller step for the next try when the legalizer fails: half the fraction, the step and the turn rate."""
    return {'frac': cfg['frac'] / 2, 'sigma': cfg['sigma'] / 2, 'p_turn': cfg['p_turn'] / 2}


def perturb(pr, rng, cfg):
    """Original pose with round(frac x movable) units (at least 1) moved by N(0, sigma) mm on each axis and turned
    by a random quarter with probability p_turn; clipped so the unit centre stays inside the outline box less
    the edge clearance and the unit radius (as bench.scramble). Fixed units stay."""
    xs = [p[0] for p in pr['board']['outline']]
    ys = [p[1] for p in pr['board']['outline']]
    e = pr['board'].get('edge_clearance', 0.0)
    box = pr.get('move_box') or [min(xs), min(ys), max(xs), max(ys)]
    pose = [(u['x'], u['y'], 0) for u in pr['units']]
    movable = [k for k, u in enumerate(pr['units']) if not u['fixed']]
    for k in rng.sample(movable, max(1, round(cfg['frac'] * len(movable)))):
        u = pr['units'][k]
        rad = max(max(abs(v) for v in r[:4]) for r in u['rects']) if u['rects'] else 0.0
        lo_x, hi_x = max(box[0], min(xs) + e + rad), min(box[2], max(xs) - e - rad)
        lo_y, hi_y = max(box[1], min(ys) + e + rad), min(box[3], max(ys) - e - rad)
        x, y = u['x'] + rng.gauss(0, cfg['sigma']), u['y'] + rng.gauss(0, cfg['sigma'])
        r = rng.randrange(1, 4) if rng.random() < cfg['p_turn'] else 0
        pose[k] = (min(max(x, lo_x), hi_x), min(max(y, lo_y), hi_y), r)
    return pose


PLANE = re.compile(r'^([A-Z0-9]+_)?[A-Z]?GND(_[A-Z0-9]+)?$')
ZONE_REFS = {'BASE-PWR': {'U1_ANTENNA': 'U1'}}  # as test_kicad_io: the WROOM antenna keepout moves with U1


def plane_nets(names):
    """Ground plane nets (GND, FIELD_GND, PGND_ISO, ...; the last path part is tested), sorted."""
    return sorted(n for n in names if n and PLANE.match(n.split('/')[-1]))


def prep(out, boards, repo):
    """Stripped board copies + problems + cases.json (see the module text)."""
    import pcbnew
    from placer import cost, kicad_io, validate
    cases = {}
    for name in boards:
        src = os.path.join(repo, 'hardware-design', 'boards', name, 'cad', name, name)
        d = os.path.join(out, name)
        os.makedirs(d, exist_ok=True)
        pcb = os.path.join(d, name + '.kicad_pcb')
        for ext in ('.kicad_pro', '.kicad_dru'):
            if os.path.exists(src + ext):
                shutil.copy(src + ext, os.path.join(d, name + ext))
        nets = [str(n) for n in pcbnew.LoadBoard(src + '.kicad_pcb').GetNetsByName().keys()]
        gnd = plane_nets(nets)
        validate.strip_tracks(src + '.kicad_pcb', pcb, keep=gnd)
        pr = kicad_io.read_problem(pcb, skip=gnd, keepout_zones=['H*_KEEPOUT'], zone_refs=ZONE_REFS.get(name),
                                   via_nets=gnd)
        prob = os.path.join(d, name + '-prob.json')
        json.dump(pr, open(prob, 'w'))
        ev = cost.Evaluator(pr, {})
        bad = [u['name'] for i, u in enumerate(pr['units']) if not u['fixed'] and ev.legal_penalty(i) > 0]
        cases[name] = {'board': name, 'prob': prob, 'pcb': pcb, 'gnd': ','.join(gnd), 'legal': not bad}
        print('%-14s units %3d nets %3d plane %s original illegal %d %s' % (
            name, len(pr['units']), len(pr['nets']), ','.join(gnd), len(bad), ' '.join(bad[:6])), flush=True)
    json.dump(cases, open(os.path.join(out, 'cases.json'), 'w'), indent=1)


def drc_row(drc, rich=False):
    """Open count, error count and the 499 cap flag; rich adds the open connections per net and the errors per type."""
    from placer import validate
    c = validate.count_drc(drc)
    row = {'unrouted': c['unconnected'], 'errors': c['errors'], 'capped': c['capped']}
    if rich:
        row.update(open_nets=c['open_nets'], error_types=c['error_types'])
    return row


SEG = re.compile(r'\(segment\s*\(start ([-\d.]+) ([-\d.]+)\)\s*\(end ([-\d.]+) ([-\d.]+)\)')


def copper_stats(text):
    """Via count and total track length (mm) of a .kicad_pcb text."""
    length = sum(math.hypot(float(c) - float(a), float(d) - float(b)) for a, b, c, d in SEG.findall(text))
    return {'vias': len(re.findall(r'\(via\b', text)), 'track_mm': round(length, 3)}


def router_passes(log):
    """Auto-router passes that Freerouting completed (its freerouting.log)."""
    return len(re.findall(r'Auto-router pass #\d+', log))


def timed_out(route_s, limit_s, unrouted):
    """The router used its whole time limit and left opens: the count is an upper bound, not a low score."""
    return unrouted > 0 and route_s >= limit_s - 2


_W = {}


def _init(cases, timeout, budget_end, gnd):
    from placer import anneal, cost
    _W.update(cases=cases, timeout=timeout, end=budget_end, gnd=gnd, ev={})
    for name, (prob, _board) in cases.items():
        pr = json.load(open(prob))
        p = anneal.params_all({'legal_time': 15.0})
        _W['ev'][name] = (pr, p, cost.Mask(pr['board'], p['mask_cell'], p['gap']))


def _hms(s):
    h, m = divmod(int(s), 3600)
    return '%02d:%02d:%02d' % (h, m // 60, m % 60)


def one(task):
    """Make, legalize, write, route and count one sample. None when the budget has no room for a route."""
    from placer import anneal, cost, kicad_io
    name, seed = task
    rt = sum(int(v) * 60 ** k for k, v in enumerate(reversed(_W['timeout'].split(':'))))
    if time.time() + rt + 120 > _W['end']:  # write + GND vias + DRC take up to about 120 s more
        return None
    t0 = time.time()
    pr, p, mask = _W['ev'][name]
    rng = case_rng(name, seed)
    cfg = sample_config(rng)
    for tries in range(1, TRIES + 1):
        ev = cost.Evaluator(pr, p, pose=perturb(pr, rng, cfg), mask=mask)
        try:
            bad = anneal.legalize(ev, p)
        except anneal.LegalizeTimeout as e:
            bad = e.illegal
        if not bad:
            break
        cfg = retry_config(cfg)
    row = {'case': name, 'seed': seed, 'cfg': cfg, 'tries': tries, 'pose': [list(q) for q in ev.pose()],
           'illegal': len(bad), 'unrouted': None, 'errors': None, 'capped': None}
    if not bad:
        board = _W['cases'][name][1]
        stem = os.path.splitext(os.path.basename(board))[0]
        d = os.path.abspath('work/%s-%d' % (name, seed))
        os.makedirs(d, exist_ok=True)
        pcb = os.path.join(d, stem + '.kicad_pcb')
        kicad_io.write_board(board, pr, [tuple(q) for q in ev.pose()], pcb)
        for ext in ('.kicad_pro', '.kicad_dru'):
            src = os.path.splitext(board)[0] + ext
            if os.path.exists(src):
                shutil.copy(src, os.path.join(d, stem + ext))
                shutil.copy(src, os.path.join(d, stem + '-r' + ext))
        log = open(os.path.join(d, 'job.log'), 'w')
        for net in filter(None, _W['gnd'].get(name, '').split(',')):
            subprocess.run([sys.executable, 'tools/gnd_pad_vias.py', pcb, pcb, '--net', net],
                           stdout=log, stderr=subprocess.STDOUT)
        routed = os.path.join(d, stem + '-r.kicad_pcb')
        t1 = time.time()
        subprocess.run([sys.executable, 'tools/freeroute.py', pcb, routed, '--no-live', '--timeout', _W['timeout']],
                       stdout=log, stderr=subprocess.STDOUT, env=dict(os.environ, TMPDIR=d))
        route_s = time.time() - t1
        drc = os.path.join(d, 'drc.json')
        subprocess.run(['kicad-cli', 'pcb', 'drc', '--format', 'json', '-o', drc, routed],
                       stdout=log, stderr=subprocess.STDOUT)
        if os.path.exists(drc) and os.path.exists(routed):
            row.update(drc_row(json.load(open(drc)), rich=True))
            row.update(copper_stats(open(routed, errors='ignore').read()))
            flog = glob.glob(os.path.join(d, 'freeroute-*', 'freerouting.log'))
            row['passes'] = router_passes(open(flog[0], errors='ignore').read()) if flog else None
            row['route_s'] = round(route_s, 1)
            row['timeout'] = timed_out(route_s, rt, row['unrouted'])
        shutil.rmtree(d, ignore_errors=True)
    row['wall_s'] = round(time.time() - t0, 1)
    return row


def _numpy_from_wheel():
    try:
        import numpy  # noqa: F401
    except ImportError:
        whl = glob.glob('in/numpy-*.whl')
        if not whl:
            sys.exit('surrogate_gen: no numpy and no in/numpy-*.whl')
        zipfile.ZipFile(whl[0]).extractall('py')
        sys.path.insert(0, os.path.abspath('py'))


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ['prep']:
        return prep(argv[1], argv[2:], os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    ap = argparse.ArgumentParser()
    ap.add_argument('--case', action='append', required=True, help='NAME:PROB.json:BOARD.kicad_pcb[:GNDNET,...]')
    ap.add_argument('--seed', type=int, required=True, help='first sample seed; sample k of a case uses seed + k')
    ap.add_argument('--n', type=int, default=100000, help='samples per case (the budget usually stops first)')
    ap.add_argument('--workers', type=int, default=14)
    ap.add_argument('--budget', type=float, default=520.0, help='seconds; no new route starts after the end')
    ap.add_argument('--timeout', default='00:01:30', help='Freerouting timeout per sample')
    ap.add_argument('-o', default='out')
    a = ap.parse_args(argv)
    _numpy_from_wheel()
    sys.path.insert(0, os.path.join(os.getcwd(), 'tools'))
    import multiprocessing as mp
    cases, gnd = {}, {}
    for c in a.case:
        f = c.split(':')
        cases[f[0]] = (f[1], f[2])
        if len(f) > 3:
            gnd[f[0]] = f[3]
    tasks = [(name, a.seed + k) for k in range(a.n) for name in cases]
    end = time.time() + a.budget
    os.makedirs(a.o, exist_ok=True)
    n = routed = 0
    with open(os.path.join(a.o, 'samples.jsonl'), 'a') as fh, \
            mp.get_context('fork').Pool(a.workers, _init, (cases, a.timeout, end, gnd)) as pool:
        for row in pool.imap_unordered(one, tasks):
            if row is None:
                if time.time() > end:
                    pool.terminate()
                    break
                continue
            fh.write(json.dumps(row) + '\n')
            fh.flush()
            n += 1
            routed += row['unrouted'] is not None
            print('sample %s %d illegal %d unrouted %s wall %.0f' % (row['case'], row['seed'], row['illegal'],
                                                                   row['unrouted'], row['wall_s']), flush=True)
    print('DONE samples %d routed %d' % (n, routed))


if __name__ == '__main__':
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    main()
