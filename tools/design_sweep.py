#!/usr/bin/env python3
"""Design sweep: which layer count does a board need? Start easy (many layers), then go down.

  $PY tools/design_sweep.py BOARD.kicad_pcb OUTDIR --board-dir hardware-design/boards/<BOARD>
        [--layers 6 4 2] [--plane-net NET] [--keep 'USB_*,VBUS'] [--read-args "..."] [--place existing anneal]
        [--budget 900] [--workers 12] [--epochs 6] [--steps 8000]

For each layer count (user rule 2026-10-03: start with low congestion, decrease only what still routes):
  1. A copy of the board without its tracks (--keep: fnmatch patterns of nets whose copper stays, for example the
     locked copper of a fixed block).
  2. tools/stackup_copy.py: 2, 4 or 6 layers; GND planes; --plane-net is the rail with a full plane (4 and 6 layers).
  3. existing: the placement of the board as it is, routed by tools/fastroute_job.py.
     anneal: tools/placer/compact_cli.py (real outline first, largest spacing that is legal, then smaller).
  A row passes when 0 signal connections are open and DRC has 0 errors. Plane-net opens are listed apart
  (a pad with no free via place, a thermal pad): they need a via fix, not a route.
Result: OUTDIR/sweep.json, OUTDIR/sweep.md (table) and one picture per row. All runs are on this computer.
Knobs: --layers, the spacing (annealer loop), --default-rule (rule fineness).
Not in this version: the board-size knob (the virtual outline does not move the edge connectors yet).
"""
import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = sys.executable
ROW = re.compile(r'UNROUTED (\d+) GND_OPEN (\d+) ERRORS (\d+) .*TRACK_MM (\d+) VIAS (\d+) SECONDS (\d+)')


def run(cmd, log=None):
    p = subprocess.run(cmd, cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if log:
        open(log, 'w').write(p.stdout)
    return p.returncode, p.stdout


def result(text):
    m = ROW.findall(text)
    if not m:
        return None
    return dict(zip(('signal_open', 'plane_open', 'errors', 'track_mm', 'vias', 'seconds'), map(int, m[-1])))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('board')
    ap.add_argument('outdir')
    ap.add_argument('--board-dir', required=True)
    ap.add_argument('--layers', type=int, nargs='+', default=[6, 4, 2])
    ap.add_argument('--plane-net', default='GND')
    ap.add_argument('--keep', default='')
    ap.add_argument('--read-args', default='')
    ap.add_argument('--place', nargs='+', default=['existing', 'anneal'], choices=['existing', 'anneal'])
    ap.add_argument('--route-extra', default='', help='more arguments for tools/fastroute_job.py (one string)')
    ap.add_argument('--no-pairs', action='store_true', help='do not give diff-pairs.json to the router (the pair copper is kept with --keep)')
    ap.add_argument('--default-rule', default='', metavar='TRACK,CLEARANCE,VIA,DRILL', help='Default net class in mm for the '
                    'copies, for example 0.15,0.15,0.5,0.3 (a part with 0.5 mm pin pitch needs it); check the fab limits first')
    ap.add_argument('--budget', type=int, default=900)
    ap.add_argument('--workers', type=int, default=12)
    ap.add_argument('--epochs', type=int, default=6)
    ap.add_argument('--steps', type=int, default=8000)
    a = ap.parse_args()
    name = os.path.splitext(os.path.basename(a.board))[0]
    src = os.path.dirname(os.path.abspath(a.board))
    out = os.path.abspath(a.outdir)
    os.makedirs(out, exist_ok=True)
    pairs = os.path.join(REPO, a.board_dir, 'diff-pairs.json')
    rows = []

    def save():
        json.dump(rows, open(os.path.join(out, 'sweep.json'), 'w'), indent=1)
        lines = ['| Layers | Placement | Pass | Signal open | Plane-net open | DRC errors | Track mm | Vias | Note |',
                 '|---|---|---|---|---|---|---|---|---|']
        for r in rows:
            lines.append('| %s | %s | %s | %s | %s | %s | %s | %s | %s |' % tuple(r.get(k, '-') for k in (
                'layers', 'placement', 'pass', 'signal_open', 'plane_open', 'errors', 'track_mm', 'vias', 'note')))
        open(os.path.join(out, 'sweep.md'), 'w').write('\n'.join(lines) + '\n')

    for L in a.layers:
        d = os.path.join(out, 'L%d' % L)
        os.makedirs(d, exist_ok=True)
        board = os.path.join(d, name + '.kicad_pcb')
        for ext in ('.kicad_pro', '.kicad_dru'):
            if os.path.exists(os.path.join(src, name + ext)):
                shutil.copy(os.path.join(src, name + ext), d)
        if a.default_rule:
            # Rule knob: track, clearance, via diameter, via drill (mm) of the Default net class, in the copy only.
            tw, cl, vd, vh = (float(x) for x in a.default_rule.split(','))
            pro_path = os.path.join(d, name + '.kicad_pro')
            pro = json.load(open(pro_path))
            for c in pro['net_settings']['classes']:
                if c['name'] == 'Default':
                    c.update(track_width=tw, clearance=cl, via_diameter=vd, via_drill=vh)
            json.dump(pro, open(pro_path, 'w'), indent=2)
        stripped = os.path.join(d, 'stripped.kicad_pcb')
        run([PY, 'tools/placer/validate.py', 'strip', a.board, stripped, '--keep=' + a.keep])
        rc, text = run([PY, 'tools/stackup_copy.py', stripped, board, '--layers', str(L), '--plane-net', a.plane_net]
                       + (['--lock-tracks'] if a.keep else []),
                       os.path.join(d, 'stackup.log'))
        m = re.search(r'SIGNAL (\S+) PLANES (\S+)', text)
        if rc != 0 or not m:
            rows.append({'layers': L, 'placement': '-', 'pass': 'NO', 'note': 'stackup copy failed: ' + text.strip()[-120:]})
            save()
            continue
        via_args = []
        if a.default_rule:
            tw, cl, vd, vh = a.default_rule.split(',')
            via_args = ['--via', vd, vh, '--clearance', cl]
        if L >= 6:
            via_args.append('--in-pad')  # JLCPCB: filled and capped vias are standard on 6 layers and more
        route_args = ['--layers', m.group(1), '--plane-nets', m.group(2)] + shlex.split(a.route_extra) + (
            ['--via-args', ' '.join(via_args)] if via_args else []) + (
            ['--pairs-json', pairs] if os.path.exists(pairs) and not a.no_pairs else [])
        if 'existing' in a.place:
            rc, text = run([PY, 'tools/fastroute_job.py', board, os.path.join(d, 'existing'), '--render'] + route_args,
                           os.path.join(d, 'existing.log'))
            r = result(text) or {'note': 'router job failed'}
            r.update(layers=L, placement='existing', picture=os.path.join(d, 'existing', 'routed.png'))
            r['pass'] = 'yes' if r.get('signal_open') == 0 and r.get('errors') == 0 else 'NO'
            rows.append(r)
            print(r, flush=True)
            save()
        if 'anneal' in a.place:
            prob = os.path.join(d, 'prob.json')
            run([PY, 'tools/placer/cli.py', 'read', board, '-o', prob] + shlex.split(a.read_args), os.path.join(d, 'read.log'))
            bb = json.load(open(prob))['board']['outline']
            size = [max(p[0] for p in bb) - min(p[0] for p in bb), max(p[1] for p in bb) - min(p[1] for p in bb)]
            rc, text = run([PY, 'tools/placer/compact_cli.py', prob, board, '--board-dir', os.path.dirname(os.path.relpath(a.board, REPO)),
                            '--outdir', os.path.join(d, 'loop'), '--size', '%.1f' % size[0], '%.1f' % size[1],
                            '--workers', str(a.workers), '--epochs', str(a.epochs), '--steps', str(a.steps),
                            '--budget', str(a.budget), '--target', '0', '--route-args', ' '.join(shlex.quote(x) for x in route_args)],
                           os.path.join(d, 'loop.log'))
            verdict = (re.findall(r'^VERDICT (.*)$', text, re.M) or ['no verdict'])[-1]
            best = re.search(r'^BEST board .*?/step-(\d+)/', text, re.M)
            r = {'layers': L, 'placement': 'anneal', 'note': verdict[:90]}
            if best:
                step = os.path.join(d, 'loop', 'step-%s' % best.group(1))
                r.update(result(open(os.path.join(step, 'route-0.log')).read()) or {})
                r['picture'] = os.path.join(step, 'route-0', 'routed.png')
            r['pass'] = 'yes' if best and 'fits in' in verdict else 'NO'
            rows.append(r)
            print(r, flush=True)
            save()
    print(open(os.path.join(out, 'sweep.md')).read())


if __name__ == '__main__':
    main()
