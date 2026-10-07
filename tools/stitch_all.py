#!/usr/bin/env python3
"""Ground stitching vias after routing, for each signal net that changes layer (kicad-happy RP-001: a ground via
within 1 mm of each signal via).

  $PY tools/stitch_all.py BOARD.kicad_pcb --planes <board>/reference-planes.json [--skip GND,+3V3]

For each net with a via (not a ground, not a --skip net): tools/pcbtool.py stitch BOARD NET --best-effort.
The board is changed in place (run it on the routed copy or on the board of a branch). Prints the vias added
and the signal vias with no room. Run DRC and the gate after it.
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
    a = ap.parse_args()
    import json
    grounds = set(json.load(open(a.planes)).get('grounds', ['GND']))
    skip = grounds | {s for s in a.skip.split(',') if s}
    b = pcbnew.LoadBoard(a.board)
    nets = sorted({t.GetNetname() for t in b.GetTracks() if t.GetClass() == 'PCB_VIA'} - skip - {''})
    added = no_room = 0
    for n in nets:
        p = subprocess.run([sys.executable, os.path.join(HERE, 'pcbtool.py'), 'stitch', a.board, n, '--best-effort',
                            '--planes', a.planes] + (['--via', a.via] if a.via else []), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        m = re.search(r'added (\d+) ', p.stdout)
        added += int(m.group(1)) if m else 0
        r = re.search(r'no room for a \S+ via within [\d.]+ mm of (.*?); best effort', p.stdout)
        no_room += r.group(1).count('(') if r else 0
    print(f'stitch_all: {len(nets)} nets, {added} ground vias added, {no_room} signal vias with no room')


if __name__ == '__main__':
    main()
