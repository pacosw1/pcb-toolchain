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
import lean_resources as resources
os.environ.update({k: '1' for k in resources.NATIVE_KEYS})
from placer import anneal, cost  # noqa: E402


def cmd_read(a):
    from placer import kicad_io
    pr = kicad_io.read_problem(a.board, fix=a.fix, skip=[x for x in a.skip_net.split(',') if x], edge_dist=a.edge_dist,
                               keepout_layers=a.keepout_layer, free_box=a.free_box,
                               region_refs=a.region_ref, region_weight=a.region_weight, region_box=a.region_box,
                               tie=a.tie, rigid_nets=[x for x in a.rigid_net.split(',') if x], decap_tie=a.decap_tie,
                               keepout_zones=a.keepout_zone, edges=parse_edges(a.edge),
                               zone_refs=dict(x.split('=', 1) for x in a.zone_ref),
                               domains=parse_domains(a.domain) if a.domain else None, via_nets=a.via_net)
    json.dump(pr, open(a.o, 'w'))
    mov = [u for u in pr['units'] if not u['fixed']]
    print('units %d (movable %d, blocks %d), nets %d, keepouts %d' % (
        len(pr['units']), len(mov), sum(1 for u in pr['units'] if u['box']), len(pr['nets']),
        len(pr['board']['keepouts'])))
    if pr['dru_ignored']:
        print('NOT MODELLED .kicad_dru rules (check them after placement): %s' % ', '.join(pr['dru_ignored']))
    far = [d for d in pr['decaps'] if d[2] > 1.0]
    print('decaps %d tied, %d over 1.0 mm (D-040): %s' % (len(pr['decaps']), len(far),
                                                        ' '.join('%s-%s %.2f' % tuple(d) for d in far)))


def parse_domains(items):
    """['MAINS_K*:8:3'] -> [('MAINS_K*', 8.0, 3.0)]: pads of these net classes keep 8 mm to all other nets and
    3 mm to another class of the domain (the .kicad_dru rules)."""
    out = []
    for it in items:
        v = it.rsplit(':', 2)
        if len(v) != 3:
            raise SystemExit('bad --domain %s: use CLASS_PATTERN:GAP:CLASS_GAP' % it)
        out.append((v[0], float(v[1]), float(v[2])))
    return out


def parse_edges(items):
    """['J1=TB:S', ...] -> {'J1': ('TB', 'S')}: the S side of the J1 courtyard (as placed now) on the T or B edge."""
    out = {}
    for it in items:
        ref, v = it.split('=', 1)
        sides, side = v.split(':')
        if not sides or set(sides) - set('LRTB') or side not in ('N', 'S', 'E', 'W'):
            raise SystemExit('bad --edge %s: use REF=<sides from LRTB>:<N|S|E|W>' % it)
        out[ref] = (sides, side)
    return out


def parse_params(items):
    p = {}
    for it in items:
        k, v = it.split('=', 1)
        try:
            p[k] = float(v)
        except ValueError:  # a word (schedule=lam, init=spectral)
            p[k] = v
    return p


def cmd_run(a):
    pr = json.load(open(a.prob))
    with resources.reserve(a.workers, events=a.o + '.admission.jsonl', label='placement') as env:
        with resources.environment(env):
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
    if any(c['timeout'] for c in res['candidates']):
        print('LEGALIZE TIMEOUT: a candidate is not legal (legalizer time limit). Run more steps or raise legal_time.')
    if not res['candidates'] or res['candidates'][0]['illegal']:
        print('NO LEGAL CANDIDATE')
        sys.exit(3)


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


def cmd_pinswap(a):
    from placer import pinswap, pinswap_io
    ref = a.ref or json.load(open(a.pinmap)).get('ref', 'U1')
    nets, slots, fixed = pinswap_io.read_pins(a.board, a.pinmap, ref)
    res = pinswap.search(nets, slots, fixed, seed=a.seed, w_x=a.w_x, restarts=a.restarts, w_c=a.w_c)
    json.dump(res, open(a.o, 'w'), indent=1)
    print('swappable nets %d, slots %d, fixed rat lines %d' % (len(nets), len(slots), len(fixed)))
    for k in ('before', 'after'):
        print('%-6s HPWL %.1f mm, crossings %d' % (k, res[k]['hpwl'], res[k]['crossings']))
    for d in res['diff']:
        print('  %-12s %s (%s) -> %s (%s)' % (d['net'], d['from_pin'], d['from_name'], d['to_pin'], d['to_name']))
    if a.apply:
        print(json.dumps(pinswap_io.apply(a.board, res['diff'], a.apply, ref)))


def cmd_scramble(a):
    from placer import bench
    pr = json.load(open(a.prob))
    pose = bench.scramble(pr, a.seed, a.sigma)
    for u, (x, y, _) in zip(pr['units'], pose):
        u['x'], u['y'] = x, y
    json.dump(pr, open(a.o, 'w'))
    print('scrambled %d movable units (seed %d, sigma %s)' % (sum(1 for u in pr['units'] if not u['fixed']),
                                                              a.seed, a.sigma))


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
    r.add_argument("--rigid-net", default='*SW*', help="comma list (use '='): parts on these nets form one rigid unit")
    r.add_argument("--decap-tie", type=float, default=3.0,
                   help="join a GND decoupling cap to the IC pin of its net within this pad gap (mm); >1.0 mm is reported")
    r.add_argument('--keepout-zone', nargs='*', default=[], help='rule area names (fnmatch) that are keepouts')
    r.add_argument('--zone-ref', nargs='*', default=[], metavar='ZONE=REF',
                   help='rule area that moves with the unit of REF (antenna, mains keepout of a block)')
    r.add_argument('--domain', nargs='*', default=[], metavar='CLASS:GAP:CLASS_GAP',
                   help="override of the domain rules read from the board .kicad_dru, for example 'MAINS_K*:8:3'")
    r.add_argument('--edge', nargs='*', default=[], metavar='REF=SIDES:SIDE',
                   help='edge anchor: side N/S/E/W of the REF courtyard (as placed now) on a board edge in LRTB')
    r.add_argument('--via-net', nargs='*', default=[], metavar='NET',
                   help='nets (fnmatch) whose pads need a free via site nearby (via room cost), for example GND')
    r.set_defaults(f=cmd_read)
    r = sub.add_parser('run')
    r.add_argument('prob')
    r.add_argument('-o', required=True)
    r.add_argument('--workers', type=int, default=resources.default_cpu())
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
    r = sub.add_parser('pinswap', help='propose a pin-map diff for the swappable pins of one IC (never edits the schematic)')
    r.add_argument('board')
    r.add_argument('pinmap')
    r.add_argument('-o', required=True, help='proposal JSON (before, after, diff, assign)')
    r.add_argument('--ref', default=None)
    r.add_argument('--seed', type=int, default=0)
    r.add_argument('--w-x', type=float, default=10.0, help='cost of one rat-line crossing in mm of HPWL')
    r.add_argument('--restarts', type=int, default=5)
    r.add_argument('--w-c', type=float, default=5.0, help='cost of one changed pin in mm of HPWL (prefer few changes)')
    r.add_argument('--apply', metavar='OUT.kicad_pcb', help='write a board COPY with the swapped pad nets (benchmark only)')
    r.set_defaults(f=cmd_pinswap)
    r = sub.add_parser('scramble', help='problem copy with seeded random start positions (benchmarks); '
                                        'search it with --param w_wl=0 w_cong=0 for a legal random placement')
    r.add_argument('prob')
    r.add_argument('-o', required=True)
    r.add_argument('--seed', type=int, default=1)
    r.add_argument('--sigma', type=float, default=None, help='mm step from the current place (default: uniform)')
    r.set_defaults(f=cmd_scramble)
    r = sub.add_parser('drc')
    r.add_argument('boards', nargs='+')
    r.set_defaults(f=cmd_drc)
    a = ap.parse_args(argv)
    a.f(a)


if __name__ == '__main__':
    main()
