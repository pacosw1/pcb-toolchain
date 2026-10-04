#!/usr/bin/env python3
"""Make each narrow track of a power net as wide as its place allows (after the autorouter).

  $PY tools/widen_power.py IN.kicad_pcb OUT.kicad_pcb --paths <board>/current-paths.json [--min-amps 0.2]

The router narrows a power track at a pin and, on a retry, along a run. For each net of current-paths.json with a
design current of --min-amps or more, each track narrower than its net-class width gets the largest width of
(class width, then steps of 0.1 mm down) that keeps the clearance to all copper of other nets on its layer
(the larger of the two class clearances). A track that has no room stays as it is. Zones are refilled.
The power-path gate (pcbtool.py paths) decides if the result carries the current. OUT may not be IN.
"""
import argparse
import json

import pcbnew

MM = pcbnew.FromMM


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('out')
    ap.add_argument('--paths', required=True)
    ap.add_argument('--min-amps', type=float, default=0.2)
    a = ap.parse_args()
    spec = json.load(open(a.paths))['nets']
    nets = {n for n, v in spec.items() if (v.get('amps') or max(c['amps'] for c in v.get('chains', [{'amps': 0}]))) >= a.min_amps}
    b = pcbnew.LoadBoard(a.src)
    pro = json.load(open(a.src.rsplit('.', 1)[0] + '.kicad_pro'))
    classes = {c['name']: c for c in pro['net_settings']['classes']}
    tracks = [t for t in b.GetTracks()]
    pads = [p for fp in b.GetFootprints() for p in fp.Pads()]
    keepouts = [z for z in b.Zones() if z.GetIsRuleArea() and z.GetDoNotAllowTracks()]
    widened = same = 0
    for t in tracks:
        if t.GetClass() == 'PCB_VIA' or t.GetNetname() not in nets:
            continue
        cls = classes.get(t.GetNetClassName(), classes['Default'])
        target = MM(cls['track_width'])
        if t.GetWidth() >= target:
            continue
        layer = t.GetLayer()
        seg = pcbnew.SEG(t.GetStart(), t.GetEnd())
        own = t.GetOwnClearance(layer)
        others = [(o, max(own, o.GetOwnClearance(layer))) for o in tracks + pads
                  if o.GetNetCode() != t.GetNetCode() and o.IsOnLayer(layer)]
        best, w = None, target
        while w > t.GetWidth():
            if all(not o.GetEffectiveShape(layer).Collide(seg, w // 2 + c) for o, c in others) and \
                    not any(z.IsOnLayer(layer) and z.Outline().Collide(seg, w // 2) for z in keepouts):
                best = w
                break
            w -= MM(0.1)
        if best:
            t.SetWidth(best)
            widened += 1
        else:
            same += 1
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    pcbnew.SaveBoard(a.out, b)
    print(f'widen_power: {widened} tracks widened, {same} with no room, nets {len(nets)}')


if __name__ == '__main__':
    main()
