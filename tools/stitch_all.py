#!/usr/bin/env python3
"""Ground stitching vias after routing, for each signal net that changes layer (kicad-happy RP-001: a ground via
within 1 mm of each signal via).

  $PY tools/stitch_all.py BOARD.kicad_pcb --planes <board>/reference-planes.json [--skip GND,+3V3]

For each net with a via (not a ground, not a --skip net): tools/pcbtool.py stitch BOARD NET --best-effort.
The board is changed in place (run it on the routed copy or on the board of a branch). Prints the vias added
and the signal vias with no room. Run DRC and the gate after it.
Route feature via_halo (tools/route-features.json, learn_noroom): the nets with no room are added to
<board>/.gate/halo-nets.json; the next tools/fastroute_job.py run gives their vias the halo padstack.
"""
import argparse
import os
import re
import subprocess
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('board')
    ap.add_argument('--planes', required=True)
    ap.add_argument('--skip', default='')
    ap.add_argument('--via', default='', help='D,DRILL of the ground vias (pcbtool stitch --via); default: net class')
    ap.add_argument('--clearance', default='', help='pcbtool stitch --clearance (scoped ground-via clearance, mm)')
    ap.add_argument('--through-pours', default='', help='pcbtool stitch --through-pours (inner plane pours of these nets)')
    a = ap.parse_args()
    import json
    grounds = set(json.load(open(a.planes)).get('grounds', ['GND']))
    skip = grounds | {s for s in a.skip.split(',') if s}
    b = pcbnew.LoadBoard(a.board)
    nets = sorted({t.GetNetname() for t in b.GetTracks() if t.GetClass() == 'PCB_VIA'} - skip - {''})
    added = no_room = 0
    noroom_nets = []
    for n in nets:
        p = subprocess.run([sys.executable, os.path.join(HERE, 'pcbtool.py'), 'stitch', a.board, n, '--best-effort',
                            '--planes', a.planes] + (['--via', a.via] if a.via else []) + \
                           (['--through-pours', a.through_pours] if a.through_pours else []) + \
                           (['--clearance', a.clearance] if a.clearance else []), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        m = re.search(r'added (\d+) ', p.stdout)
        added += int(m.group(1)) if m else 0
        r = re.search(r'no room for a \S+ via within [\d.]+ mm of (.*?); best effort', p.stdout)
        no_room += r.group(1).count('(') if r else 0
        if r:
            noroom_nets.append(n)
            print(f'NOROOM {n}')   # tools/cell_route.py re-routes these nets (repair loop)
    print(f'stitch_all: {len(nets)} nets, {added} ground vias added, {no_room} signal vias with no room')
    sys.path.insert(0, HERE)
    import route_features
    feat = route_features.load(a.board)
    bd = feat['_board_dir']
    if route_features.on(feat, 'via_halo') and feat['via_halo'].get('learn_noroom') and bd and noroom_nets:
        f = os.path.join(bd, '.gate', 'halo-nets.json')
        os.makedirs(os.path.dirname(f), exist_ok=True)
        old = json.load(open(f)).get('nets', []) if os.path.isfile(f) else []
        json.dump({'nets': sorted(set(old) | set(noroom_nets))}, open(f, 'w'), indent=1)
        print(f'stitch_all: via_halo learns {len(noroom_nets)} nets -> {f}')


if __name__ == '__main__':
    main()
