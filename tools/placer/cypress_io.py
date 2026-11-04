"""Convert a placer problem (cli.py read) to Bookshelf for NVlabs Cypress, and a Cypress .pl back to a pose.

  python3 tools/placer/cypress_io.py to-bs PROB START OUTDIR [--name N] [--scale 10]
  python3 tools/placer/cypress_io.py from-bs PROB OUTDIR/N.aux RESULT.pl -o res.json

Evaluation only (tools/placer/cypress-eval.md). One node per unit: the box of all its rects (courtyards,
pad clearance rects, unit keepout rects), at rotation 0. A fixed unit and each board keepout box are
terminals. The board is the outline box. Pins are the pin-box centres of cli.py read, relative to the node
centre. Coordinates: mm * scale from the outline box corner; y keeps the KiCad direction.
res.json has the placer result form ({'candidates': [{'pose': ...}]}), so `cli.py write` makes the board copy.
"""
import argparse
import json
import math
import os
import sys


def outline_box(board):
    xs = [p[0] for p in board['outline']]
    ys = [p[1] for p in board['outline']]
    return min(xs), min(ys), max(xs), max(ys)


def unit_box(u):
    r = u['rects']
    return (min(q[0] for q in r), min(q[1] for q in r), max(q[2] for q in r), max(q[3] for q in r))


def to_bookshelf(pr, start, outdir, name, s):
    x0, y0, x1, y1 = outline_box(pr['board'])
    W, H = int(math.ceil((x1 - x0) * s)), int(math.ceil((y1 - y0) * s))
    nodes, pl = [], []
    geo = []
    for i, (u, v) in enumerate(zip(pr['units'], start['units'])):
        a, b, c, d = unit_box(u)
        w, h = max(1, int(math.ceil((c - a) * s))), max(1, int(math.ceil((d - b) * s)))
        cx, cy = (a + c) / 2, (b + d) / 2
        geo.append((cx, cy))
        term = ' terminal' if u['fixed'] else ''
        nodes.append('U%d %d %d%s' % (i, w, h, term))
        x = (v['x'] + cx - x0) * s - w / 2
        y = (v['y'] + cy - y0) * s - h / 2
        pl.append('U%d %.3f %.3f : N%s' % (i, x, y, ' /FIXED' if u['fixed'] else ''))
    for k, poly in enumerate(pr['board'].get('keepouts', [])):
        a = max(x0, min(p[0] for p in poly)); c = min(x1, max(p[0] for p in poly))
        b = max(y0, min(p[1] for p in poly)); d = min(y1, max(p[1] for p in poly))
        if c <= a or d <= b:
            continue
        w, h = max(1, int(math.ceil((c - a) * s))), max(1, int(math.ceil((d - b) * s)))
        nodes.append('KO%d %d %d terminal' % (k, w, h))
        pl.append('KO%d %.3f %.3f : N /FIXED' % (k, (a - x0) * s, (b - y0) * s))
    nets, npins = [], 0
    for k, n in enumerate(pr['nets']):
        pins = []
        for q in n['pins']:
            i = q[0]
            px, py = (q[1] + q[3]) / 2 - geo[i][0], (q[2] + q[4]) / 2 - geo[i][1]
            pins.append('\tU%d B : %.3f %.3f' % (i, px * s, py * s))
        if len({p.split()[0] for p in pins}) < 2:
            continue
        nets.append('NetDegree : %d N%d' % (len(pins), k))  # the Bookshelf lexer rejects '/' in a name
        nets.extend(pins)
        npins += len(pins)
    nterm = sum(1 for n in nodes if n.endswith('terminal'))
    os.makedirs(outdir, exist_ok=True)
    wr = lambda ext, text: open(os.path.join(outdir, name + ext), 'w').write(text)
    wr('.nodes', 'UCLA nodes 1.0\n\nNumNodes : %d\nNumTerminals : %d\n\n%s\n' % (len(nodes), nterm, '\n'.join(nodes)))
    wr('.nets', 'UCLA nets 1.0\n\nNumNets : %d\nNumPins : %d\n\n%s\n'
       % (sum(1 for l in nets if l.startswith('NetDegree')), npins, '\n'.join(nets)))
    wr('.pl', 'UCLA pl 1.0\n\n%s\n' % '\n'.join(pl))
    rows = ''.join('CoreRow Horizontal\n  Coordinate : %d\n  Height : 1\n  Sitewidth : 1\n  Sitespacing : 1\n'
                   '  Siteorient : 1\n  Sitesymmetry : 1\n  SubrowOrigin : 0 NumSites : %d\nEnd\n' % (r, W)
                   for r in range(H))
    wr('.scl', 'UCLA scl 1.0\n\nNumRows : %d\n\n%s' % (H, rows))
    wr('.aux', 'RowBasedPlacement : %s.nodes %s.nets %s.pl %s.scl\n' % (name, name, name, name))
    return len(nodes), nterm, W, H


def from_bookshelf(pr, aux, plfile, s):
    x0, y0 = outline_box(pr['board'])[:2]
    d = os.path.dirname(aux)
    sizes = {}
    for line in open(os.path.join(d, os.path.basename(aux).replace('.aux', '.nodes'))):
        t = line.split()
        if len(t) >= 3 and t[0][:1] == 'U' and t[0][1:].isdigit():
            sizes[t[0]] = (float(t[1]), float(t[2]))
    got = {}
    for line in open(plfile):
        t = line.split()
        if t and t[0] in sizes:
            got[t[0]] = (float(t[1]), float(t[2]), t[4] if len(t) > 4 else 'N')
    pose, orients = [], {}
    for i, u in enumerate(pr['units']):
        a, b, c, e = unit_box(u)
        cx, cy = (a + c) / 2, (b + e) / 2
        if u['fixed']:
            pose.append((u['x'], u['y'], 0))
            continue
        w, h = sizes['U%d' % i]
        x, y, o = got['U%d' % i]
        orients[o] = orients.get(o, 0) + 1
        pose.append(((x + w / 2) / s + x0 - cx, (y + h / 2) / s + y0 - cy, 0))
    return pose, orients


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    a = sub.add_parser('to-bs')
    a.add_argument('prob')
    a.add_argument('start', help='problem with the start positions (cli.py scramble output)')
    a.add_argument('outdir')
    a.add_argument('--name', default='board')
    a.add_argument('--scale', type=float, default=10.0, help='Bookshelf units per mm')
    b = sub.add_parser('from-bs')
    b.add_argument('prob')
    b.add_argument('aux')
    b.add_argument('pl')
    b.add_argument('-o', required=True)
    b.add_argument('--scale', type=float, default=10.0)
    a = ap.parse_args(argv)
    pr = json.load(open(a.prob))
    if a.cmd == 'to-bs':
        n, t, W, H = to_bookshelf(pr, json.load(open(a.start)), a.outdir, a.name, a.scale)
        print('nodes %d (terminals %d), die %d x %d' % (n, t, W, H))
    else:
        pose, orients = from_bookshelf(pr, a.aux, a.pl, a.scale)
        if set(orients) - {'N'}:
            sys.exit('rotated nodes %s: not converted (the CPU build does not rotate pins)' % orients)
        json.dump({'candidates': [{'pose': pose}]}, open(a.o, 'w'))
        print('units %d, orients %s' % (len(pose), orients))


if __name__ == '__main__':
    main()
