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
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import route_rule_coverage as rrc  # noqa: E402  (DRU s-expression parser + three-valued selector evaluation)
import pcbtool  # noqa: E402  (the power path gate: IPC formula and stackup copper thickness)

import pcbnew  # noqa: E402
import fnmatch  # noqa: E402
import math  # noqa: E402


def ipc_width(amps, thick, dT):
    """Smallest track width (mm, rounded up to 0.01 mm) whose IPC current (tools/pcbtool.py ipc_amps, the formula of
    the paths gate) is at least amps. 0 for no current."""
    if amps <= 0:
        return 0.0
    # ipc_amps = k dT^0.44 (w t / 0.0254^2)^0.725, solved for w; then checked with the gate function itself
    w = (amps / (pcbtool.IPC_K * dT ** 0.44)) ** (1 / 0.725) * 0.0254 ** 2 / thick
    w = math.ceil(w * 100 - 1e-9) / 100
    while pcbtool.ipc_amps(w, thick, dT) < amps:
        w += 0.01
    return round(w, 2)

T = pcbnew.ToMM
ROUTED_KINDS = {'clearance', 'track_width', 'via_count', 'length', 'disallow', 'hole_clearance', 'hole_to_hole'}
PAIR_KINDS = {'diff_pair_gap', 'diff_pair_uncoupled', 'skew'}
ZC_NAMES = {pcbnew.ZONE_CONNECTION_NONE: 'none', pcbnew.ZONE_CONNECTION_THERMAL: 'thermal',
            pcbnew.ZONE_CONNECTION_FULL: 'full', pcbnew.ZONE_CONNECTION_THT_THERMAL: 'tht_thermal'}
HOLE_KINDS = {'hole_clearance', 'hole_to_hole'}
PAD_SHAPES = {pcbnew.PAD_SHAPE_CIRCLE: 'circle', pcbnew.PAD_SHAPE_RECTANGLE: 'rect', pcbnew.PAD_SHAPE_OVAL: 'oval',
              pcbnew.PAD_SHAPE_ROUNDRECT: 'roundrect', pcbnew.PAD_SHAPE_CUSTOM: 'custom'}
TH = r"(?:A|B)\.Pad_Type\s*==\s*'Through-hole'"


def hole_scope(cond):
    """Which item pairs a hole rule covers, from its condition text: 'all' (no condition), 'either_th' (A or B is a
    through-hole pad), 'both_th' (A and B are), or None (not recognised: reported, never guessed)."""
    c = ' '.join(str(cond or '').split())
    if c in ('', 'True'):
        return 'all'
    if re.fullmatch(TH.replace('(?:A|B)', 'A') + r'\s*\|\|\s*' + TH.replace('(?:A|B)', 'B'), c):
        return 'either_th'
    if re.fullmatch(TH.replace('(?:A|B)', 'A') + r'\s*&&\s*' + TH.replace('(?:A|B)', 'B'), c):
        return 'both_th'
    return None


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
    pcb_text = None
    for fp in b.GetFootprints():
        for p in fp.Pads():
            bb = p.GetBoundingBox()
            d = {'ref': fp.GetReference(), 'num': p.GetNumber(), 'net': p.GetNetname(),
                 'x': T(p.GetPosition().x), 'y': T(p.GetPosition().y),
                 'bbox': [T(bb.GetLeft()), T(bb.GetTop()), T(bb.GetRight()), T(bb.GetBottom())],
                 'layers': [l for l in cu if p.IsOnLayer(lid[l])],
                 'drill': T(p.GetDrillSize().x) if p.GetDrillSize().x else 0.0}
            if p.GetLocalZoneConnection() != pcbnew.ZONE_CONNECTION_INHERITED:
                d['zone_conn'] = ZC_NAMES.get(p.GetLocalZoneConnection(), 'unknown')
            # pour model (v5): KiCad spoke directions = pad orientation + thermal spoke angle + k x 90 degrees
            d['shape'] = PAD_SHAPES.get(p.GetShape(pcbnew.F_Cu), 'other')
            d['spoke_deg'] = round((p.GetOrientationDegrees() + p.GetThermalSpokeAngleDegrees()) % 360.0, 3)
            if d['shape'] == 'custom':
                # KiCad starved_thermal: a custom pad needs as many spokes as it has proxy segment primitives (0 = none)
                # (SWIG gives no access to the primitives: count the proxy segments, written as gr_vector, in the pad's
                # block of the board file, found by the pad uuid)
                if pcb_text is None:
                    pcb_text = open(pcb).read()
                u = pcb_text.find('(uuid "%s")' % p.m_Uuid.AsString())
                block = pcb_text[pcb_text.rfind('(pad ', 0, u):u] if u >= 0 else ''
                d['proxy_spokes'] = block.count('(gr_vector')
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
    hole_rules = {}
    zone_clr_rules = []  # (rule, condition, min) of DRU clearance rules that name a zone: the pour model of the core
    pair_nets ={p['p'] for p in pairs} | {p['n'] for p in pairs}
    for form in rrc._forms(open(dru_path).read()) if os.path.exists(dru_path) else []:
        if form == ['version', '1']:
            continue
        rule = form[1]
        cond = (rrc._children(form, 'condition') or [[None, 'True']])[0][1]
        layer = (rrc._children(form, 'layer') or [[None, None]])[0][1]
        for con in rrc._children(form, 'constraint'):
            kind = con[1]
            if kind == 'clearance' and 'Zone' in str(cond):
                vals = {c[0]: c[1] for c in con[2:] if isinstance(c, list) and len(c) == 2}
                if 'min' in vals:
                    zone_clr_rules.append((rule, cond, float(rrc._number(vals['min']))))
            hits, unknown = [], False
            for name, info in nets.items():
                for typ in ('Track', 'Via'):
                    v = rrc._condition(cond, {'NetName': name, 'NetClass': info['class'], 'Type': typ, 'Pad_Type': ''}, {})
                    if v is rrc.UNKNOWN:
                        unknown = True
                    elif v:
                        hits.append(name)
            hits = sorted(set(hits))
            if kind in HOLE_KINDS:
                vals = {c[0]: c[1] for c in con[2:] if isinstance(c, list) and len(c) == 2}
                scope = hole_scope(cond)
                if scope is None or 'min' not in vals:
                    report.append({'rule': rule, 'constraint': kind, 'state': 'unknown', 'nets': [],
                                   'why': f'hole rule condition not recognised: {cond}'})
                    continue
                hole_rules.setdefault(kind, []).append({'rule': rule, 'min': float(rrc._number(vals['min'])), 'scope': scope})
                report.append({'rule': rule, 'constraint': kind, 'state': 'applied', 'nets': [],
                               'why': f'router hole rule (scope {scope}; the core applies it to every drilled item, a superset)'})
                continue
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
    zones = []
    for z in b.Zones():
        if z.GetIsRuleArea():
            continue
        zb = z.GetBoundingBox()
        for l in z.GetLayerSet().CuStack():
            zones.append({'net': z.GetNetname(), 'layer': b.GetLayerName(l),
                          'clearance': T(z.GetLocalClearance() or 0),
                          'thermal_gap': T(z.GetThermalReliefGap()), 'spoke_width': T(z.GetThermalReliefSpokeWidth()),
                          'pad_connection': ZC_NAMES.get(z.GetPadConnection(), 'inherited'),
                          'min_thickness': T(z.GetMinThickness()),
                          'island_removal_mode': int(z.GetIslandRemovalMode()),
                          'min_island_area_mm2': z.GetMinIslandArea() / 1e12,
                          'bbox': [T(zb.GetLeft()), T(zb.GetTop()), T(zb.GetRight()), T(zb.GetBottom())]})
            # DRU clearance of an item to this zone (rules with B.Type == 'Zone', both rule orders): per net and item
            # type, only where a rule is true (an unknown selector is left to KiCad DRC, as in the rule report)
            zc = {}
            zctx = {'Type': 'Zone', 'NetName': z.GetNetname(), 'NetClass': 'Default', 'Pad_Type': ''}
            for rule, cond, mn in zone_clr_rules:
                for name, info in nets.items():
                    for typ in ('Track', 'Via', 'Pad'):
                        item = {'NetName': name, 'NetClass': info['class'], 'Type': typ, 'Pad_Type': ''}
                        if rrc._condition(cond, item, zctx) is True or rrc._condition(cond, zctx, item) is True:
                            e = zc.setdefault(name, {})
                            e[typ.lower()] = max(e.get(typ.lower(), 0.0), mn)
            zones[-1]['net_clearance'] = zc
    plane_clr = max([z['clearance'] for z in zones if z['layer'] in plane_layers and z['net']] or [0.0])
    hole_rules['plane_clearance'] = {'min': plane_clr, 'source': 'max local clearance of the zones on ' + ', '.join(sorted(plane_layers))}
    hole_rules['board_min'] = {'hole_clearance': rules_setup.get('min_hole_clearance'), 'hole_to_hole': rules_setup.get('min_hole_to_hole')}
    # current-paths.json: the width each power pin pair needs, by the formula of the gate (tools/pcbtool.py paths:
    # IPC-2221 external k on every layer, dT and copper thickness of the board stackup). The gate gives a neck credit
    # only from end evidence (a same-net plane or a wider track) and a pin escape only from tools/pin-ratings.json,
    # so the router routes every piece of the net at the IPC width (no neck credit is assumed).
    dT = float(jload(bdir, 'current-paths.json', {}).get('dT', 10.0))
    thick = pcbtool.copper_thickness(pcb)
    for name, chain in paths.items():
        if name not in nets:
            continue
        chains = []
        for c in chain.get('chains', [chain]):
            need = 0.0
            for l in nets[name]['layers']:
                need = max(need, ipc_width(c.get('amps', 0), thick.get(l, 0.035), dT))
            chains.append({'pads': c.get('pads', []), 'amps': c.get('amps', 0), 'min_width': need})
        nets[name]['limits']['amps'] = max([c['amps'] for c in chains] + [0])
        nets[name]['power_chains'] = chains
        nets[name]['min_width'] = max([c['min_width'] for c in chains] + [0.0])
    # si_planes (D-124c screen): a checked net (not a ground, not exempt, not power) on a layer of 'adjacent' must run
    # over the copper of its reference plane: the router keeps it off the plane voids (antipads of foreign drilled items)
    pwr_pats = list(planes.get('power') or []) + [q for m in (planes.get('mixed_layers') or {}).values() for q in m.get('power', [])]
    exempt_nets = set((planes.get('exempt') or {}).get('nets', {}))
    for name, info in nets.items():
        info['plane_ref'] = (name not in set(planes.get('grounds', [])) and name not in exempt_nets
                             and not any(fnmatch.fnmatchcase(name, q) for q in pwr_pats))
    # locked input vias of each net: they count in the DRU via_count of the net (KiCad too_many_vias)
    for c in copper:
        if c['kind'] == 'via' and c['net'] in nets:
            nets[c['net']]['input_vias'] = nets[c['net']].get('input_vias', 0) + 1
    o = b.GetBoardEdgesBoundingBox()
    model = {'schema': 'iot-lab.route-model.v0', 'board': os.path.basename(bdir), 'pcb': pcb, 'copper_layers': cu,
             'plane_layers': sorted(plane_layers), 'adjacent': planes.get('adjacent', {}),
             'grounds': planes.get('grounds', []), 'current_dT': dT, 'copper_thickness': thick, 'outline_bbox': [T(o.GetLeft()), T(o.GetTop()), T(o.GetRight()), T(o.GetBottom())],
             'setup': {'min_via': rules_setup.get('min_via_diameter'), 'min_drill': rules_setup.get('min_through_hole_diameter'),
                       'min_clearance': rules_setup.get('min_clearance'), 'min_track': rules_setup.get('min_track_width'), 'edge_clearance': rules_setup.get('min_copper_edge_clearance'),
                       'min_spokes': rules_setup.get('min_resolved_spokes', 2)},
             'classes': classes, 'nets': nets, 'pairs': pairs, 'zones': zones, 'hole_rules': hole_rules, 'pads': pads, 'copper': copper, 'rules': report}
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
