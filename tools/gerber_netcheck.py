#!/usr/bin/env python3
"""Bare-board netlist test from the fab files: rebuild the copper connectivity from the Gerbers and drill files
that go to JLC, and compare it with the schematic netlist (opens and shorts), without KiCad's copper or net labels.

  <venv>/bin/python tools/gerber_netcheck.py <BOARD>        (venv with gerbonara + shapely; see below)

1. Copper: each copper Gerber of <board>/cad/fab/<BOARD>-gerber.zip (F, In1, In2, B) is drawn as shapely geometry
   from its flashes, lines, arcs and regions (dark and clear polarity in file order). The X2 net/pad attributes
   (.N, .P) in the files are NOT used.
2. Holes: the plated drill file (holes and G85 slots) joins the copper of all layers it passes through; a copper
   piece takes part in a hole when it overlaps the hole ring (the hole circle grown by 0.05 mm).
3. Expected nets: `kicad-cli sch export netlist` (schematic: ref.pin -> net). Pad positions and pad layers come
   from the board file (KiCad python, a separate step), as a point per pad; that is the only board data used.
4. Result: each net with two or more pads must have all its pads in one copper piece (else OPEN), and no copper
   piece may hold pads of two nets (else SHORT). Pads with no copper under them are listed (MISSING).
Exit 1 on any OPEN, SHORT or MISSING.

Setup once: python3 -m venv ~/.cache/iot-lab/gerbercheck/venv && ~/.cache/iot-lab/gerbercheck/venv/bin/pip install gerbonara shapely
"""
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile

from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union
from shapely import affinity
from gerbonara import GerberFile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KICAD_CLI = os.environ.get('KICAD_CLI', '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli')
KPY = os.environ.get('KICAD_PYTHON', os.environ.get('KICAD_PY', '/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3'))
LAYERS = ['F_Cu', 'In1_Cu', 'In2_Cu', 'In3_Cu', 'In4_Cu', 'B_Cu']
KLAYER = {'F_Cu': 'F.Cu', 'In1_Cu': 'In1.Cu', 'In2_Cu': 'In2.Cu', 'In3_Cu': 'In3.Cu', 'In4_Cu': 'In4.Cu', 'B_Cu': 'B.Cu'}

DUMP = r'''
import json, sys, pcbnew
b = pcbnew.LoadBoard(sys.argv[1]); T = pcbnew.ToMM
out = []
for f in b.GetFootprints():
    for p in f.Pads():
        if not p.GetNumber():
            continue
        lays = [b.GetLayerName(l) for l in p.GetLayerSet().CuStack()]
        q = p.GetPosition()
        out.append({'ref': f.GetReference(), 'pin': p.GetNumber(), 'x': T(q.x), 'y': -T(q.y), 'layers': lays,
                    'tht': p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH})
json.dump(out, open(sys.argv[2], 'w'))
'''


def prim_geom(p):
    n = type(p).__name__
    if n == 'Circle':
        return Point(p.x, p.y).buffer(p.r, 24)
    if n == 'Rectangle':
        g = box(p.x - p.w / 2, p.y - p.h / 2, p.x + p.w / 2, p.y + p.h / 2)
        return affinity.rotate(g, p.rotation, origin=(p.x, p.y), use_radians=True) if p.rotation else g
    if n == 'Line':
        w = p.width
        if (p.x1, p.y1) == (p.x2, p.y2):
            return Point(p.x1, p.y1).buffer(w / 2, 24)
        return LineString([(p.x1, p.y1), (p.x2, p.y2)]).buffer(w / 2, 24)
    if n == 'Arc':
        # sample the arc, then buffer
        cx, cy = p.cx + p.x1, p.cy + p.y1
        r = math.hypot(p.x1 - cx, p.y1 - cy)
        a1, a2 = math.atan2(p.y1 - cy, p.x1 - cx), math.atan2(p.y2 - cy, p.x2 - cx)
        if p.clockwise:
            while a2 >= a1:
                a2 -= 2 * math.pi
        else:
            while a2 <= a1:
                a2 += 2 * math.pi
        k = max(8, int(abs(a2 - a1) * r * 8))
        pts = [(cx + r * math.cos(a1 + (a2 - a1) * i / k), cy + r * math.sin(a1 + (a2 - a1) * i / k)) for i in range(k + 1)]
        return LineString(pts).buffer(p.width / 2, 24)
    if n in ('ArcPoly',):
        pts = [tuple(pt) for pt in p.outline]
        if len(pts) >= 3:
            g = Polygon(pts)
            return g if g.is_valid else g.buffer(0)
        return None
    raise ValueError('primitive ' + n)


def layer_geometry(path):
    f = GerberFile.open(path)
    dark, geom = [], None
    for o in f.objects:
        gs = []
        for p in o.to_primitives():
            g = prim_geom(p)
            if g is not None and not g.is_empty:
                gs.append(g)
        if not gs:
            continue
        u = unary_union(gs)
        if o.polarity_dark:
            dark.append(u)
        else:  # clear polarity: subtract from everything drawn so far
            geom = unary_union(([geom] if geom is not None else []) + dark)
            dark = []
            geom = geom.difference(u)
    return unary_union(([geom] if geom is not None else []) + dark)


def excellon_holes(path):
    """[(x1, y1, x2, y2, d)]: holes (x1 == x2, y1 == y2) and G85 slots, in mm."""
    tools, cur, out, metric = {}, None, [], True
    num = lambda s: float(s)
    for line in open(path):
        line = line.strip()
        if line.startswith('INCH'):
            metric = False
        m = re.match(r'^T(\d+)C([\d.]+)', line)
        if m:
            tools[m.group(1)] = float(m.group(2))
            continue
        m = re.match(r'^T(\d+)$', line)
        if m:
            cur = tools.get(m.group(1))
            continue
        m = re.match(r'^X([-\d.]+)Y([-\d.]+)G85X([-\d.]+)Y([-\d.]+)', line)
        if m:
            out.append((num(m.group(1)), num(m.group(2)), num(m.group(3)), num(m.group(4)), cur))
            continue
        m = re.match(r'^X([-\d.]+)Y([-\d.]+)$', line)
        if m and cur:
            x, y = num(m.group(1)), num(m.group(2))
            out.append((x, y, x, y, cur))
    if not metric:
        raise SystemExit('inch drill file not handled')
    return out


class DSU:
    def __init__(self):
        self.p = {}

    def find(self, a):
        self.p.setdefault(a, a)
        while self.p[a] != a:
            self.p[a] = self.p[self.p[a]]
            a = self.p[a]
        return a

    def union(self, a, b):
        self.p[self.find(a)] = self.find(b)


def main():
    board = sys.argv[1]
    bd = os.path.join(ROOT, 'hardware-design', 'boards', board)
    stem = os.path.join(bd, json.load(open(os.path.join(bd, 'gate.json')))['project'])
    name = os.path.basename(stem)
    tmp = tempfile.mkdtemp(prefix='gnc-')
    zipfile.ZipFile(os.environ.get('GNC_ZIP') or os.path.join(bd, 'cad', 'fab', f'{name}-gerber.zip')).extractall(tmp)  # GNC_ZIP: test a modified copy
    # expected nets from the schematic
    xml = os.path.join(tmp, 'net.xml')
    subprocess.run([KICAD_CLI, 'sch', 'export', 'netlist', '--format', 'kicadxml', '-o', xml, stem + '.kicad_sch'],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    pin_net = {}
    for net in ET.parse(xml).getroot().iter('net'):
        for node in net.iter('node'):
            pin_net[(node.get('ref'), node.get('pin'))] = net.get('name')
    # pad positions from the board
    pj = os.path.join(tmp, 'pads.json')
    subprocess.run([KPY, '-c', DUMP, stem + '.kicad_pcb', pj], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    pads = json.load(open(pj))
    # copper per layer, split into pieces
    pieces = {}
    for L in LAYERS:
        f = os.path.join(tmp, f'{name}-{L}.gbr')
        if not os.path.exists(f):
            continue
        g = layer_geometry(f)
        parts = list(g.geoms) if hasattr(g, 'geoms') else [g]
        pieces[L] = parts
        print(f'{L}: {len(parts)} copper pieces')
    dsu = DSU()
    from shapely.strtree import STRtree
    trees = {L: STRtree(ps) for L, ps in pieces.items()}

    def hits(L, geom):
        idx = trees[L].query(geom)
        return [int(i) for i in idx if pieces[L][int(i)].intersects(geom)]
    holes = excellon_holes(os.path.join(tmp, f'{name}-PTH.drl'))
    for (x1, y1, x2, y2, d) in holes:
        ring = (LineString([(x1, y1), (x2, y2)]) if (x1, y1) != (x2, y2) else Point(x1, y1)).buffer(d / 2 + 0.05, 16)
        ids = [(L, i) for L in pieces for i in hits(L, ring)]
        for a in ids[1:]:
            dsu.union(ids[0], a)
    # pads onto copper pieces
    comp_nets, missing, pad_comp = {}, [], {}
    for p in pads:
        net = pin_net.get((p['ref'], p['pin']))
        pt = Point(p['x'], p['y'])
        ids = []
        for L in pieces:
            if KLAYER[L] in p['layers']:
                ids += [(L, i) for i in hits(L, pt)]
        if not ids:
            missing.append(f"{p['ref']}.{p['pin']} ({net})")
            continue
        for a in ids[1:]:
            dsu.union(ids[0], a)
        pad_comp[(p['ref'], p['pin'])] = ids[0]
    for k, c in pad_comp.items():
        net = pin_net.get(k)
        if net is None or net.startswith('unconnected-'):
            continue
        comp_nets.setdefault(dsu.find(c), {}).setdefault(net, []).append(f'{k[0]}.{k[1]}')
    shorts = [v for v in comp_nets.values() if len(v) > 1]
    net_comps = {}
    for comp, nets in comp_nets.items():
        for net, pins in nets.items():
            net_comps.setdefault(net, []).append(pins)
    opens = {n: c for n, c in net_comps.items() if len(c) > 1}
    nets_checked = sum(1 for n, c in net_comps.items() if sum(len(x) for x in c) > 1)
    print(f'gerber_netcheck {board}: {len(pads)} pads, {len(holes)} plated holes, {len(net_comps)} nets '
          f'({nets_checked} with 2+ pads); OPEN {len(opens)}, SHORT {len(shorts)}, MISSING {len(missing)}')
    for n, c in list(opens.items())[:20]:
        print(f'  OPEN {n}: ' + ' | '.join(', '.join(x[:6]) for x in c))
    for s in shorts[:20]:
        print('  SHORT ' + ' + '.join(f'{n} ({", ".join(p[:3])})' for n, p in s.items()))
    for m in missing[:20]:
        print('  MISSING copper under pad ' + m)
    sys.exit(1 if opens or shorts or missing else 0)


if __name__ == '__main__':
    main()
