#!/usr/bin/env python3
"""Board + our rule files -> RouteModel JSON for the in-house router (M0, tools/router/DESIGN.md).

  $PY tools/router/model.py BOARD_DIR [--pcb FILE] [--out model.json]

BOARD_DIR is hardware-design/boards/<BOARD> (gate.json or gate.pending.json names the project). Read natively, nothing
translated: pcbnew board (outline, pads, locked copper, zones), .kicad_pro net classes + board setup, .kicad_dru
(three-valued selector evaluation of tools/route_rule_coverage.py), diff-pairs.json, rp001-fast-nets.json,
reference-planes.json, current-paths.json, gate route_features deny_layers. Every DRU constraint ends in exactly one
of: applied (a per-net constraint the router enforces), stage (owned by a named stage, e.g. pairs), plane (plane
layers: no tracks), checked (left to KiCad DRC after routing, with the reason). Unknown selectors are reported, never
guessed. Prints one line: MODEL ok|FAIL nets N pads N rules applied/stage/plane/checked/unknown.
"""
import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import route_rule_coverage as rrc  # noqa: E402  (DRU s-expression parser + three-valued selector evaluation)

import pcbnew  # noqa: E402

T = pcbnew.ToMM
ROUTED_KINDS = {'clearance', 'track_width', 'via_count', 'length', 'disallow', 'hole_clearance', 'hole_to_hole'}
PAIR_KINDS = {'diff_pair_gap', 'diff_pair_uncoupled', 'skew'}


def load_cfg(bdir):
    for name in ('gate.json', 'gate.pending.json'):
        p = os.path.join(bdir, name)
        if os.path.exists(p):
            return json.load(open(p))
    raise SystemExit('no gate.json / gate.pending.json in ' + bdir)


def jload(bdir, name, default):
    p = os.path.join(bdir, name)
    return json.load(open(p)) if os.path.exists(p) else default


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('board_dir')
    ap.add_argument('--pcb')
    ap.add_argument('--out')
    a = ap.parse_args()
    bdir = os.path.abspath(a.board_dir)
    cfg = load_cfg(bdir)
    proj = os.path.join(bdir, cfg['project'])
    pcb = a.pcb or proj + '.kicad_pcb'
    b = pcbnew.LoadBoard(pcb)
    cu = [b.GetLayerName(l) for l in b.GetEnabledLayers().CuStack()]
    lid = {b.GetLayerName(l): l for l in b.GetEnabledLayers().CuStack()}
    pro = json.load(open(proj + '.kicad_pro'))
    ns = pro['net_settings']
    classes = {c['name']: {'width': c.get('track_width'), 'clearance': c.get('clearance'), 'via': c.get('via_diameter'),
                           'drill': c.get('via_drill')} for c in ns['classes']}
    rules_setup = pro['board']['design_settings']['rules']
    planes = jload(bdir, 'reference-planes.json', {})
    fast = set(jload(bdir, 'rp001-fast-nets.json', {}).get('fast', []))
    pairs = jload(bdir, 'diff-pairs.json', {}).get('pairs', [])
    paths = jload(bdir, 'current-paths.json', {}).get('nets', {})
    deny = []
    for e in (cfg.get('route_features', {}).get('rule_compiler', {}) or {}).get('extra', []) if isinstance(cfg.get('route_features', {}).get('rule_compiler'), dict) else []:
        deny.append(e)
    plane_layers = set(planes.get('plane_layers', []))
    plane_nets = set(planes.get('grounds', [])) | set(planes.get('alt_refs', {}))

    nets = {}
    for n in b.GetNetsByName().values():
        name = n.GetNetname()
        if not name or name.startswith('unconnected-('):
            continue
        cls = n.GetNetClassName() if hasattr(n, 'GetNetClassName') else 'Default'
        nets[name] = {'class': cls, 'pins': [], 'fast': name in fast, 'plane': name in plane_nets,
                      'layers': [l for l in cu if l not in plane_layers], 'width': None, 'clearance': None,
                      'limits': {}}
    for e in deny:
        for name in e.get('nets', []):
            if name in nets:
                nets[name]['layers'] = [l for l in nets[name]['layers'] if l not in e.get('deny_layers', [])]
        for name, info in nets.items():
            if info['class'] in e.get('classes', []):
                info['layers'] = [l for l in info['layers'] if l not in e.get('deny_layers', [])]
    pads = []
    for fp in b.GetFootprints():
        for p in fp.Pads():
            bb = p.GetBoundingBox()
            d = {'ref': fp.GetReference(), 'num': p.GetNumber(), 'net': p.GetNetname(),
                 'x': T(p.GetPosition().x), 'y': T(p.GetPosition().y),
                 'bbox': [T(bb.GetLeft()), T(bb.GetTop()), T(bb.GetRight()), T(bb.GetBottom())],
                 'layers': [l for l in cu if p.IsOnLayer(lid[l])],
                 'drill': T(p.GetDrillSize().x) if p.GetDrillSize().x else 0.0}
            pads.append(d)
            if d['net'] in nets:
                nets[d['net']]['pins'].append(f"{d['ref']}.{d['num']}")
    copper = []
    for t in b.GetTracks():
        if t.GetClass() == 'PCB_VIA':
            copper.append({'kind': 'via', 'net': t.GetNetname(), 'x': T(t.GetPosition().x), 'y': T(t.GetPosition().y),
                           'd': T(t.GetWidth()), 'drill': T(t.GetDrill())})
        else:
            copper.append({'kind': 'track', 'net': t.GetNetname(), 'layer': b.GetLayerName(t.GetLayer()),
                           'a': [T(t.GetStart().x), T(t.GetStart().y)], 'b': [T(t.GetEnd().x), T(t.GetEnd().y)],
                           'w': T(t.GetWidth())})
    for name, info in nets.items():
        c = classes.get(info['class']) or classes['Default']
        info['width'], info['clearance'] = c['width'], c['clearance']

    # DRU: every constraint -> applied | stage | plane | checked | unknown
    dru_path = proj + '.kicad_dru'
    report = []
    pair_nets = {p['p'] for p in pairs} | {p['n'] for p in pairs}
    for form in rrc._forms(open(dru_path).read()) if os.path.exists(dru_path) else []:
        if form == ['version', '1']:
            continue
        rule = form[1]
        cond = (rrc._children(form, 'condition') or [[None, 'True']])[0][1]
        layer = (rrc._children(form, 'layer') or [[None, None]])[0][1]
        for con in rrc._children(form, 'constraint'):
            kind = con[1]
            hits, unknown = [], False
            for name, info in nets.items():
                for typ in ('Track', 'Via'):
                    v = rrc._condition(cond, {'NetName': name, 'NetClass': info['class'], 'Type': typ, 'Pad_Type': ''}, {})
                    if v is rrc.UNKNOWN:
                        unknown = True
                    elif v:
                        hits.append(name)
            hits = sorted(set(hits))
            if kind in ('hole_size', 'via_diameter', 'annular_width'):
                vals = {c[0]: c[1] for c in con[2:] if isinstance(c, list) and len(c) == 2}
                state, why = 'applied', 'router via geometry'
                for name in hits:
                    v = nets[name].setdefault('via', {})
                    if 'min' in vals:
                        v[kind] = max(v.get(kind, 0), float(rrc._number(vals['min'])))
                report.append({'rule': rule, 'constraint': kind, 'state': state, 'nets': hits[:8] + (['...'] if len(hits) > 8 else []), 'why': why})
                continue
            if not hits and unknown and 'inDiffPair' in str(cond) and 'intersectsArea' in str(cond):
                state, why = 'stage', 'pairs stage: pad-field gap window (spatial selector, rule areas around the pad fields)'
            elif layer in plane_layers:
                state, why = 'plane', f'{layer} is a plane layer: no tracks'
            elif hits and set(hits) <= pair_nets and kind in PAIR_KINDS | {'track_width', 'clearance', 'via_count'}:
                state, why = 'stage', 'pairs stage (centerline at width + gap)'
            elif kind in ('hole_clearance', 'hole_to_hole') or kind == 'clearance' and not hits and unknown:
                state, why = 'checked', 'pad / zone geometry rule: KiCad DRC after routing'
            elif unknown and not hits:
                state, why = 'unknown', 'selector not evaluable for any net'
            elif kind in ROUTED_KINDS:
                state, why = 'applied', ''
                vals = {c[0]: c[1] for c in con[2:] if isinstance(c, list) and len(c) == 2}
                for name in hits:
                    lim = nets[name]['limits']
                    if kind == 'track_width' and 'opt' in vals:
                        nets[name]['width'] = float(rrc._number(vals['opt']))
                    elif kind == 'clearance' and 'min' in vals:
                        nets[name]['clearance'] = max(nets[name]['clearance'] or 0, float(rrc._number(vals['min'])))
                    elif kind in ('via_count', 'length') and 'max' in vals:
                        lim[kind] = float(rrc._number(vals['max']))
                    elif kind == 'disallow' and layer:
                        nets[name]['layers'] = [l for l in nets[name]['layers'] if l != layer]
            else:
                state, why = 'checked', f'{kind}: KiCad DRC after routing'
            report.append({'rule': rule, 'constraint': kind, 'state': state, 'nets': hits[:8] + (['...'] if len(hits) > 8 else []), 'why': why})
    for name, chain in paths.items():
        if name in nets:
            amps = max([c.get('amps', 0) for c in chain.get('chains', [])] + [chain.get('amps', 0)])
            nets[name]['limits']['amps'] = amps
    o = b.GetBoardEdgesBoundingBox()
    model = {'schema': 'iot-lab.route-model.v0', 'board': os.path.basename(bdir), 'pcb': pcb, 'copper_layers': cu,
             'plane_layers': sorted(plane_layers), 'outline_bbox': [T(o.GetLeft()), T(o.GetTop()), T(o.GetRight()), T(o.GetBottom())],
             'setup': {'min_via': rules_setup.get('min_via_diameter'), 'min_drill': rules_setup.get('min_through_hole_diameter'),
                       'min_clearance': rules_setup.get('min_clearance'), 'edge_clearance': rules_setup.get('min_copper_edge_clearance')},
             'classes': classes, 'nets': nets, 'pairs': pairs, 'pads': pads, 'copper': copper, 'rules': report}
    states = {}
    for r in report:
        states[r['state']] = states.get(r['state'], 0) + 1
    out = a.out or os.path.join(bdir, '.router', 'model.json')
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    json.dump(model, open(out, 'w'), indent=1)
    ok = not states.get('unknown')
    print(f"MODEL {'ok' if ok else 'FAIL'} nets {len(nets)} pads {len(pads)} copper {len(copper)} rules "
          + ' '.join(f'{k} {v}' for k, v in sorted(states.items())) + f' -> {out}')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
