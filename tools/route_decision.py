#!/usr/bin/env python3
"""Source-bound routing diagnosis and one guarded local candidate operation.

Diagnosis never establishes native validity or joint routability. Candidate
acceptance belongs to the existing fresh native/configured board gates.
"""
import argparse
from decimal import Decimal
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

import lean_workflow as lean
from pcb_workflow import board_config, python_native, sha
from pcb_search.block_bindings import child, footprints
from pcb_search.native_candidate import copper_items
from pcb_search.native_conflicts import pad_anchors, select_repair
from pcb_search.native_eco import point, shift_via
from pcb_search.native_srj import geometry_digest, source_set
from placer.dru import _tree, _tokens

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = 'iot-lab.route-decision.v1'
IMPLEMENTATIONS = ('route_decision.py', 'pcb_search/native_conflicts.py', 'pcb_search/native_eco.py',
    'pcb_search/native_candidate.py', 'pcb_search/native_srj.py', 'pcb_search/block_bindings.py',
    'placer/dru.py', 'block_extract.py', 'pcb_search/contracts.py', 'pcb_workflow.py',
    'lean_workflow.py', 'lean_owned.py')
ESCAPE_POLICY_FILES = ('route_grid.py', 'route_features.py', 'route-features.json', 'placer/dru.py', 'placer/__init__.py')
ESCAPE_ENV = ('ROUTE_BOARD', 'ROUTE_FEATURES', 'ROUTE_FEATURES_FILE', 'PYTHONPATH', 'PYTHONHOME',
              'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH')


def escape_context(root, board):
    """Resolve the controlled screen policy without importing a native runtime."""
    root = Path(root).resolve()
    if os.environ.get('ROUTE_FEATURES_FILE') or os.environ.get('ROUTE_BOARD', board) not in ('', board):
        raise ValueError('external escape feature file or different ROUTE_BOARD is unsupported')
    folder, cfg, _ = board_config(root, board)
    defaults = read(root / 'tools/route-features.json')['features']['pin_escape_check']
    feature = dict(defaults, **cfg.get('route_features', {}).get('pin_escape_check', {}))
    switches = [item.split('=', 1) for item in os.environ.get('ROUTE_FEATURES', '').split(',') if '=' in item]
    for name, value in switches:
        if name.strip() == 'all':
            feature['on'] = value.strip() not in ('0', 'off', 'false', '')
    for name, value in switches:
        if name.strip() == 'pin_escape_check':
            feature['on'] = value.strip() not in ('0', 'off', 'false', '')
    params = dict(grid_mm=float(feature.get('grid_mm', .05)), reach_mm=float(feature.get('reach_mm', 2.)),
                  halo_hint_mm=float(feature.get('halo_hint_mm', .5)), pad_box_halo_mm=.3,
                  layers=['F.Cu', 'B.Cu'], skip_nets=[], net_filter=None,
                  width_model='native_design_minimum', clearance_model='native_item_and_net_maximum')
    if any(not math.isfinite(params[key]) or params[key] <= 0 for key in ('grid_mm', 'reach_mm', 'halo_hint_mm')):
        raise ValueError('escape resolution/reach/halo must be finite positive model parameters')
    launch = shutil.which(python_native())
    if not launch:
        raise ValueError('native escape Python launcher is missing')
    launch = Path(launch).resolve()
    return dict(schema='iot-lab.escape-context.v1',
                files={str(root/'tools'/name): sha(root/'tools'/name) for name in ESCAPE_POLICY_FILES},
                config_inputs={str(folder/'gate.json'): sha(folder/'gate.json')}, feature_config=feature,
                environment={name: os.environ.get(name) for name in ESCAPE_ENV},
                launcher=dict(path=str(launch), sha256=sha(launch)), model_parameters=params)


def escape_runtime_valid(runtime):
    """Hash the actual already-observed runtime; never launch a second KiCad probe."""
    roles = {'python', 'pcbnew', 'pcbnew_native', 'numpy', 'numpy_native'}
    if not isinstance(runtime, dict) or set(runtime.get('files', {})) != roles:
        raise ValueError('escape evidence lacks the actual native runtime closure')
    if any(not isinstance(runtime.get(key), str) or not runtime[key] for key in ('python_version', 'pcbnew_version', 'numpy_version')):
        raise ValueError('escape evidence lacks observed native runtime versions')
    for item in runtime['files'].values():
        path = Path(item['path'])
        if not path.is_absolute() or not path.is_file() or sha(path) != item['sha256']:
            raise ValueError('native escape runtime changed: ' + str(path))


def escape_root(contract, candidate):
    return next(base for base in Path(candidate).resolve().parents
        if (base/'hardware-design/boards'/contract['board']/'gate.json').is_file()
        and board_config(base, contract['board'])[2].with_suffix('.kicad_pcb') == Path(candidate).resolve())


def read(path):
    value = json.loads(Path(path).read_text())
    if not isinstance(value, dict):
        raise ValueError('expected a JSON object: ' + str(path))
    return value


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def implementations(root):
    return {name: sha(Path(root) / 'tools' / name) for name in IMPLEMENTATIONS}


def native_inputs(root, board):
    root = Path(root).resolve()
    folder, cfg, project = board_config(root, board)
    paths = [folder / 'gate.json', *(project.with_suffix(ext) for ext in
             ('.kicad_pcb', '.kicad_pro', '.kicad_dru', '.kicad_sch'))]
    return cfg, project.with_suffix('.kicad_pcb'), {str(p.relative_to(root)): sha(p) for p in paths}


def names(row):
    refs, nets = set(), set()
    for item in row.get('items', []):
        description = item.get('description', '')
        match = re.search(r'\bof\s+([^\s,]+)', description)
        if match:
            refs.add(match[1])
        match = re.search(r'\[([^\]]+)\]', description)
        if match:
            nets.add(match[1])
    return sorted(refs), sorted(nets)


def load_evidence(root, board, evidence, _seen=None):
    """Require an original completed native receipt; a loose report is insufficient."""
    root, evidence = Path(root).resolve(), Path(evidence).resolve()
    seen=set() if _seen is None else set(_seen)
    if evidence in seen or len(seen)>=2:
        raise ValueError('recursive routing evidence is not an original native receipt')
    seen.add(evidence)
    _, native, _ = native_inputs(root, board)
    raw, artifacts = read(evidence), {str(evidence): sha(evidence)}
    diagnostics = {}
    if raw.get('schema') == 'iot-lab.route-evidence.v1':
        if raw.get('board') != board or raw.get('source_inputs') != source_set(native):
            raise ValueError('routing diagnostics do not match current native sources')
        for key, entry in raw.get('artifacts', {}).items():
            if key not in {'native', 'triage', 'escape', 'router', 'rules'} or not isinstance(entry, dict):
                raise ValueError('unknown diagnostic artifact')
            path = Path(entry['path']).resolve()
            if entry.get('sha256') != sha(path):
                raise ValueError('changed routing diagnostic artifact: ' + key)
            artifacts[str(path)] = sha(path)
            if key == 'native':
                continue
            diagnostics[key] = path.read_text() if key == 'rules' else read(path)
            if key != 'rules' and (diagnostics[key].get('source_inputs') != source_set(native)
                    or Path(diagnostics[key].get('board','')).resolve() != native):
                raise ValueError('diagnostic does not bind this exact native source: ' + key)
        if 'native' not in raw.get('artifacts', {}):
            raise ValueError('routing diagnostics require original native evidence')
        native_path = Path(raw['artifacts']['native']['path'])
        _, report, native_files = load_evidence(root, board, native_path,seen)
        artifacts.update(native_files)
        return diagnostics, report, artifacts
    if raw.get('schema') == 'iot-lab.native-export.v1':
        if (Path(raw['board']).resolve() != native or raw.get('source_mutated') is not False
                or raw.get('drc_returncode') != 0 or raw.get('inputs') != source_set(native)
                or not {'--schematic-parity', '--refill-zones', '--severity-all'} <= set(raw.get('drc_command', []))):
            raise ValueError('stale or incomplete native export evidence')
        path = evidence.parent / 'drc.json'
        if raw.get('drc_sha256') != sha(path):
            raise ValueError('native DRC report changed after export')
    elif isinstance(raw.get('provenance'), dict):
        if raw.get('changedDuringRun') is not False or raw.get('preflightErrors'):
            raise ValueError('native gate source/preflight is invalid')
        check = raw.get('checks', {}).get('drc', {})
        if check.get('status') not in {'passed', 'failed'} or not check.get('metrics') or any(v is None for v in check['metrics'].values()):
            raise ValueError('native DRC did not complete with valid metrics')
        bound = {}
        for entry in raw['provenance'].get('inputs', []):
            name, digest = entry['path'], entry['sha256']
            if name.startswith('external/'):
                continue  # Fresh configured gates reverify tools and external libraries.
            path = (root / name).resolve()
            if not path.is_relative_to(root):
                raise ValueError('gate input escapes repository')
            if digest is None:
                if path.exists():
                    raise ValueError('previously missing gate input now exists: ' + name)
            elif not path.is_file() or sha(path) != digest:
                raise ValueError('gate input changed: ' + name)
            bound[name] = digest
        if bound.get(str(native.relative_to(root))) != sha(native):
            raise ValueError('gate does not bind the configured native board')
        events = evidence.parent / 'events.jsonl'
        rows = [json.loads(line) for line in events.read_text().splitlines() if line]
        exits = [row for row in rows if row.get('type') == 'tool.exit' and row.get('stage') == 'drc']
        if len(exits) != 1 or exits[0].get('code') != 0:
            raise ValueError('native DRC process receipt is incomplete')
        artifacts[str(events)] = sha(events)
        path = evidence.parent / 'drc.json'
    else:
        raise ValueError('expected completed native gate/export receipt, not a loose diagnostic')
    report = read(path)
    if (report.get('source') != native.name or report.get('coordinate_units') != 'mm'
            or 'error' not in report.get('included_severities', [])
            or any(not isinstance(report.get(key), list) for key in ('violations', 'unconnected_items', 'schematic_parity'))):
        raise ValueError('native report lacks exact source, units, severities or required checks')
    artifacts[str(path)] = sha(path)
    return diagnostics, report, artifacts


def classify(report, diagnostics):
    rows = []
    def add(kind, reason, refs=(), nets=(), **details):
        rows.append(dict(classification=kind, reason=reason, refs=sorted(set(refs)), nets=sorted(set(nets)), **details))
    for index, row in enumerate(report['schematic_parity']):
        refs, nets = names(row)
        add('schematic_parity', 'Resolve schematic/native disagreement before copper work', refs, nets, native_index=index)
    for index, row in enumerate(report['violations']):
        if row.get('severity') == 'error':
            refs, nets = names(row)
            add('native_geometry', row.get('description', row.get('type', 'Native rule violation')), refs, nets,
                rule=row.get('type'), native_index=index)
    triage = diagnostics.get('triage', {})
    for row in triage.get('connections', []):
        kind = {'ENCLOSED': 'model_enclosed', 'ROUTER_MISS': 'router_miss'}.get(row.get('class'), 'constraints_unknown')
        add(kind, 'One connection is reachable in the diagnostic model; joint routability is unproven' if kind == 'router_miss'
            else 'Diagnostic grid enclosure requires exact/native reconciliation' if kind == 'model_enclosed'
            else 'Diagnostic could not resolve this connection', row.get('blocking_parts', []), [row['net']] if row.get('net') else [],
            blocking_nets=row.get('blocking_nets', []))
    if triage.get('not_checked', 0):
        add('constraints_unknown', 'Some native opens were outside the bounded grid diagnosis', not_checked=triage['not_checked'])
    for row in diagnostics.get('escape', {}).get('boxed_in', []):
        add('escape_failure', 'No escape in the bounded grid model; not proof of physical impossibility',
            [row['ref']] if row.get('ref') else [], [row['net']] if row.get('net') else [], pad=row.get('pad'))
    unknown = [line for line in diagnostics.get('rules', '').splitlines()
               if re.search(r'not compiled|not supported|not read|not model', line, re.I)]
    if unknown:
        add('constraints_unknown', 'Routing model did not represent named native rules', rules=unknown)
    opens = [dict(index=i, refs=names(row)[0], nets=names(row)[1]) for i, row in enumerate(report['unconnected_items'])]
    router = diagnostics.get('router', {})
    completed = router.get('completed_nets', [])
    contradicted = sorted({net for row in opens for net in row['nets'] if net in completed})
    if contradicted:
        add('native_router_disagreement', 'Router claimed these exact nets complete; fresh native connectivity has opens', nets=contradicted)
    if opens:
        add('native_open', 'Native connectivity remains incomplete',
            [ref for row in opens for ref in row['refs']], [net for row in opens for net in row['nets']], connections=len(opens))
    if not rows:
        add('no_routing_defect', 'Native report has no error, parity failure or open; no repair justified')
    return rows


def intersects(a, b, c, d):
    def cross(x, y, z):
        return (y[0]-x[0])*(z[1]-x[1])-(y[1]-x[1])*(z[0]-x[0])
    def on(x, y, z):
        return cross(x,y,z) == 0 and all(min(i,j) <= k <= max(i,j) for i,j,k in zip(x,y,z))
    p,q,r,s = cross(a,b,c),cross(a,b,d),cross(c,d,a),cross(c,d,b)
    return (p*q < 0 and r*s < 0) or any((value == 0 and on(x,y,z)) for value,x,y,z in
        ((p,a,b,c),(q,a,b,d),(r,c,d,a),(s,c,d,b)))


def crossing_guard(board, net, layer, a, b):
    text, items = copper_items(board)
    for uid, row in items.items():
        if row['net'] == net:
            continue
        form = _tree(_tokens(text[slice(*row['span'])]))[0]
        if row['kind'] == 'arc':
            raise ValueError('retained other-net arcs require exact native geometric reconciliation')
        if row['kind'] == 'segment' and child(form,'layer') == [layer] and intersects(a,b,point(form,'start'),point(form,'end')):
            raise ValueError('straight bridge crosses protected other-net copper: ' + uid)
        if row['kind'] == 'via':
            x,y = point(form,'at'); radius = Decimal(child(form,'size')[0])/2
            corners = [(x-radius,y-radius),(x+radius,y-radius),(x+radius,y+radius),(x-radius,y+radius)]
            if any(intersects(a,b,corners[i],corners[(i+1)%4]) for i in range(4)) or all(abs(a[i]-v)<=radius for i,v in enumerate((x,y))):
                raise ValueError('straight bridge crosses protected other-net via envelope: ' + uid)
    # Conservative pad envelopes only reject; native DRC decides actual clearance.
    pads = [(fp,pad) for fp in footprints(board) for pad in fp['form'] if isinstance(pad,list) and pad and pad[0]=='pad']
    anchors = pad_anchors(board,{child(pad,'uuid',[''])[0] for _,pad in pads})
    for fp,pad in pads:
        pad_net = child(pad,'net', [''])[-1]
        if pad_net == net or (layer not in child(pad,'layers',[]) and '*.Cu' not in child(pad,'layers',[])):
            continue
        uid = child(pad,'uuid',[''])[0]
        if uid not in anchors:
            raise ValueError('unresolved native pad envelope')
        size = child(pad,'size')
        if len(size or []) != 2:
            raise ValueError('unrepresented native pad shape')
        radius = sum(Decimal(v)**2 for v in size).sqrt()/2
        x,y = anchors[uid]
        corners = [(x-radius,y-radius),(x+radius,y-radius),(x+radius,y+radius),(x-radius,y+radius)]
        if any(intersects(a,b,corners[i],corners[(i+1)%4]) for i in range(4)) or all(abs(a[i]-v)<=radius for i,v in enumerate((x,y))):
            raise ValueError('straight bridge crosses other-net pad envelope: ' + fp['props'].get('Reference','?'))


def select_gap(board, report):
    """One exact same-layer track-end gap; source widths retained, never guessed."""
    text, items = copper_items(board)
    forms = {uid: _tree(_tokens(text[slice(*row['span'])]))[0] for uid,row in items.items()}
    def exposed(uid, net, layer, endpoint):
        # KiCad DRC item.pos is an item's display anchor, which can be the
        # opposite end of its missing connection. Use exact source topology.
        for other,row in items.items():
            if other == uid or row['net'] != net:
                continue
            form = forms[other]
            if row['kind'] == 'segment' and child(form,'layer') == [layer]:
                if intersects(endpoint,endpoint,point(form,'start'),point(form,'end')):
                    return False
            elif row['kind'] == 'via' and point(form,'at') == endpoint:
                return False
            elif row['kind'] == 'arc' and child(form,'layer') == [layer]:
                if endpoint in (point(form,'start'),point(form,'end')):
                    return False
        return True
    choices, rejected = [], []
    for index,row in enumerate(report['unconnected_items']):
        endpoints = row.get('items', [])
        if len(endpoints) != 2:
            continue
        tracks = []
        try:
            for item in endpoints:
                uid = item.get('uuid')
                if uid not in items or items[uid]['kind'] != 'segment':
                    raise ValueError('gap endpoints must identify two exact native straight tracks')
                form = forms[uid]
                pos = tuple(Decimal(str(item['pos'][k])) for k in ('x','y'))
                if pos not in (point(form,'start'),point(form,'end')):
                    raise ValueError('native diagnostic point is not an exact source track endpoint')
                if 'locked' in form or child(form,'locked',['no']) != ['no']:
                    raise ValueError('locked endpoint requires explicit design ownership')
                layer,net = child(form,'layer')[0],items[uid]['net']
                ends = [end for end in (point(form,'start'),point(form,'end')) if exposed(uid,net,layer,end)]
                tracks.append((uid,net,layer,Decimal(child(form,'width')[0]),ends))
            left,right = tracks
            if left[0] == right[0] or left[1:4] != right[1:4]:
                raise ValueError('gap must share exact source net, layer and width')
            pairs = sorted((sum((x-y)**2 for x,y in zip(a,b)),a,b) for a in left[4] for b in right[4] if a != b)
            if not pairs or len(pairs)>1 and pairs[0][0] == pairs[1][0]:
                raise ValueError('native source endpoints do not identify one unambiguous exposed gap')
            _,a,b = pairs[0]
            dx,dy = (abs(y-x) for x,y in zip(a,b))
            if dx != 0 and dy != 0 and dx != dy:
                raise ValueError('gap is not a single 0/45/90-degree source pattern')
            crossing_guard(board,left[1],left[2],a,b)
            choices.append(dict(strategy='straight_gap_bridge',native_open_index=index,net=left[1],layer=left[2],
                width_mm=str(left[3]), endpoint_ids=[left[0],right[0]],
                points_mm=[list(map(str,a)),list(map(str,b))]))
        except (ValueError,KeyError,TypeError) as error:
            rejected.append(dict(native_open_index=index,cause=str(error)))
    choices.sort(key=lambda row:(row['net'],row['layer'],row['endpoint_ids']))
    return (choices[0] if choices else None), rejected


def select_via(board, report):
    # Adapt an already validated gate report to the existing native-conflict
    # selector. Temporary JSON is evidence transport; no native CAD is changed.
    with tempfile.TemporaryDirectory(prefix='route-selection-') as folder:
        folder = Path(folder)
        lean.atomic_json(folder/'drc.json', report)
        lean.atomic_json(folder/'record.json',dict(schema='iot-lab.native-export.v1',board=str(board),
            status='reject',source_mutated=False,drc_returncode=0,inputs=source_set(board),
            drc_sha256=sha(folder/'drc.json'),drc_command=['--schematic-parity','--refill-zones','--severity-all']))
        result = select_repair(folder, fractions=[.25,.5,.75], budget_s=1)
        if result['status']!='candidate':return None
        return dict(strategy='via_shift_bridge',net=copper_items(board)[1][result['choice']['via_id']]['net'],**result['choice'])


def diagnose_evidence(root, board, evidence, plan_path=None):
    root, evidence = Path(root).resolve(), Path(evidence).resolve()
    cfg,native,sources = native_inputs(root,board)
    implementation = implementations(root)
    diagnostics,report,files = load_evidence(root,board,evidence)
    findings = classify(report,diagnostics)
    kinds = {row['classification'] for row in findings}
    action,choice,rejected = 'inspect_diagnostics',None,[]
    if 'schematic_parity' in kinds:
        action = 'resolve_schematic_parity'
    elif 'constraints_unknown' in kinds:
        action = 'resolve_constraint_coverage'
    elif 'native_geometry' in kinds:
        choice = select_via(native,report)
        action = 'apply_local_repair' if choice else 'inspect_native_geometry'
    elif 'native_open' in kinds:
        choice,rejected = select_gap(native,report)
        action = 'apply_local_repair' if choice else 'inspect_escape' if kinds & {'escape_failure','model_enclosed'} else 'diagnose_selected_connections'
    elif 'no_routing_defect' in kinds:
        action = 'run_remaining_configured_gates'
    refs = sorted({ref for row in findings for ref in row['refs']})
    nets = sorted({net for row in findings for net in row['nets']})
    plan_path = str(Path(plan_path).resolve()) if plan_path else None
    next_argv = (['tools/pcb','repair',board,'--plan',plan_path,'--follow'] if choice and plan_path else
                 ['tools/pcb','routing','--json','diagnose',board,'--evidence',str(evidence)])
    plan = dict(schema=SCHEMA,status='repairable' if choice else 'decision',qualified=False,root=str(root),board=board,
        native_project=str(native.relative_to(root)),source_inputs=sources,native_inputs=sources,
        inputs={**sources,**files},implementation_sha256=implementation,
        evidence=str(evidence),evidence_sha256=files,findings=findings,action=action,choice=choice,
        scope=dict(refs=refs,nets=[choice['net']] if choice and 'net' in choice else nets,
                   copper_policy='preserve all original tracks; only one explicitly selected via may move'),
        rejected_gap_patterns=rejected,attempt_policy=dict(max_proposals=1,retry_unchanged_inputs=False),
        plan_path=plan_path,next_action=dict(kind='local_repair' if choice and plan_path else action,argv=next_argv,cwd=str(root)),
        required_checks=sorted(key for key,value in cfg.get('checks',{}).items() if value),
        acceptance='fresh native ERC/DRC/refill/parity plus every configured and board-specific gate; explicit adoption',
        tools_and_external_libraries='fresh configured gate required; diagnosis does not certify runtime freshness')
    if sources != native_inputs(root,board)[2] or implementation != implementations(root) or any(sha(Path(p)) != h for p,h in files.items()):
        raise ValueError('source or diagnostic evidence changed during diagnosis')
    plan['plan_sha256'] = fingerprint(plan)
    return plan


def plan_dependencies(plan):
    """Exact files needed to transport an admitted plan to another executor."""
    plan = read(plan) if isinstance(plan,(str,Path)) else plan
    return dict(plan['evidence_sha256'])


def verify_copper_scope(source, candidate, choice, added_id):
    """Check the allowed via field and new bridge, not just omitted item IDs."""
    def forms(path):
        text,items=copper_items(path)
        return items,{uid:_tree(_tokens(text[slice(*row['span'])]))[0] for uid,row in items.items()}
    original,before=forms(source);changed,after=forms(candidate)
    if set(changed)-set(original)!={added_id} or set(original)-set(changed):
        raise ValueError('local repair added/deleted copper outside its single bridge scope')
    bridge=after[added_id]
    if changed[added_id]['net']!=choice['net'] or changed[added_id]['kind']!='segment':
        raise ValueError('local bridge has wrong source net or native shape')
    if choice['strategy']=='via_shift_bridge':
        uid=choice['via_id'];old,new=before[uid],after[uid]
        if [f for f in old if not isinstance(f,list) or f[0]!='at'] != [f for f in new if not isinstance(f,list) or f[0]!='at']:
            raise ValueError('local repair changed protected via geometry/net/layers')
        expected=tuple(Decimal(v) for v in choice['destination_mm'])
        if point(new,'at')!=expected:
            raise ValueError('via moved outside diagnosed destination')
        other=next(form for key,form in before.items() if key!=choice['along_trace_id'] and original[key]['kind']=='segment'
                   and original[key]['net']==choice['net'] and point(old,'at') in (point(form,'start'),point(form,'end')))
        endpoints={point(old,'at'),expected};layer=child(other,'layer');width=child(other,'width')
    else:
        endpoints={tuple(Decimal(v) for v in p) for p in choice['points_mm']};layer=[choice['layer']];width=[choice['width_mm']]
    if ({point(bridge,'start'),point(bridge,'end')}!=endpoints or child(bridge,'layer')!=layer
            or Decimal(child(bridge,'width')[0])!=Decimal(width[0])):
        raise ValueError('bridge endpoint, layer or width differs from exact source pattern')


def verify_escape_evidence(contract, candidate, evidence):
    """Check reviewed ref/pad coverage without treating a grid as physical proof."""
    try:
        candidate,evidence = Path(candidate).resolve(),Path(evidence).resolve()
        raw = read(evidence)
        if raw.get('status')=='blocked' and raw.get('cause'):
            raise ValueError('escape screen blocked: '+raw['cause'])
        if (raw.get('schema') != 'iot-lab.pin-escape-evidence.v1'
                or raw.get('qualified') is not False or raw.get('status') not in {'screened','blocked'}
                or Path(raw.get('board','')).resolve() != candidate
                or raw.get('source_inputs') != source_set(candidate)):
            raise ValueError('escape evidence does not bind exact candidate board/project/rules/schematic')
        context = escape_context(contract['root'] if contract.get('root') else escape_root(contract, candidate), contract['board'])
        if (raw.get('generator_context') != context or raw.get('generator_inputs') != context['files']
                or raw.get('feature_config') != context['feature_config']
                or raw.get('model_parameters') != context['model_parameters']):
            raise ValueError('escape generator, effective feature policy or model parameters changed')
        escape_runtime_valid(raw.get('runtime'))
        if raw.get('unsupported_constraints') or raw.get('not_checked'):
            raise ValueError('escape screen has unsupported constraints or unscreened endpoints')
        for path,digest in contract.get('inputs',{}).items():
            if sha(path) != digest:
                raise ValueError('reviewed source changed before escape decision: ' + path)
        screened = {(row['ref'],str(row['pad'])) for row in raw.get('screened_pads',[])}
        requested=set()
        for rule in contract['rules']:
            if rule['kind']!='escape':continue
            if rule.get('metric')!='native_minimum_track_escape' or any(key in rule for key in
                    ('width_mm','clearance_mm','reach_mm','grid_mm','layers')):
                raise ValueError('unsupported reviewed escape metric or parameter override')
            if rule.get('pads'):
                requested.update((row['ref'],str(row['pad'])) for row in rule['pads'])
            else:
                requested.update((ref,str(pad)) for ref in rule['refs'] for pad,rows in contract['geometry']['refs'][ref]['pads'].items()
                    if any(row.get('kind')=='smd' and any(layer.endswith('.Cu') for layer in row.get('layers',[])) for row in rows))
        if not requested or not requested <= screened:
            raise ValueError('reviewed escape pads were not all screened explicitly')
        if any(len(contract['geometry']['refs'][ref]['pads'].get(pad,[]))!=1 for ref,pad in requested):
            raise ValueError('reviewed escape pad identity is missing or ambiguous')
        if raw.get('native_preflight'):
            native = raw['native_preflight'];path = Path(native.get('path',''))
            if native.get('returncode') != 0 or not path.is_file() or native.get('sha256') != sha(path):
                raise ValueError('supplied native escape preflight is incomplete')
            report = read(path)
            if (report.get('source') != candidate.name or report.get('coordinate_units') != 'mm'
                    or 'error' not in report.get('included_severities',[])
                    or any(not isinstance(report.get(key),list) for key in ('violations','unconnected_items','schematic_parity'))
                    or report['schematic_parity'] or any(row.get('severity')=='error' for row in report['violations'])):
                raise ValueError('supplied native geometry/parity preflight failed or is incomplete')
        elif raw.get('native_validation')!='not_run; fresh parent configured gate required':
            raise ValueError('escape model omits its native validation status')
        blocked = [row for row in raw.get('boxed_in',[]) if (row.get('ref'),str(row.get('pad','').split('.')[-1])) in requested]
        if blocked:
            return [dict(code='escape_model_enclosure',detail='bounded native-polygon grid enclosure; not physical impossibility',
                         refs=sorted({row['ref'] for row in blocked}),pads=blocked,evidence=str(evidence))]
        return []
    except (OSError,ValueError,KeyError,TypeError,StopIteration) as error:
        return [dict(code='native_escape_evidence_invalid',detail=str(error),evidence=str(evidence))]


def generate_escape(root,board,output,timeout=30,*,candidate=None):
    """Produce exact-source explicit-pad feasibility evidence; parent owns DRC."""
    root,output=Path(root).resolve(),Path(output).resolve()
    _,native,_=native_inputs(root,board)
    if candidate is not None:native=Path(candidate).resolve()
    before=source_set(native)
    context=escape_context(root,board)
    if output.exists():raise ValueError('new escape evidence file required')
    work=output.parent/(output.stem+'-artifacts')
    work.mkdir(parents=True,exist_ok=False)
    deadline=lean.deadline_after(timeout)
    with (work/'grid.log').open('w') as log:
        grid=lean.run_stage([python_native(),str(root/'tools/route_grid.py'),'escape',str(native),'--skip','',
            '--layers','F.Cu,B.Cu','--out',str(work/'grid.json')],stage='escape-grid',event_file=work/'events.jsonl',
            deadline=deadline,cwd=root,env=dict(os.environ,ROUTE_BOARD=board),stdout=log,stderr=subprocess.STDOUT)
    if grid.returncode:raise ValueError('native grid runtime/screen failed; evidence='+str(work/'grid.log'))
    result=read(work/'grid.json')
    if source_set(native)!=before or result.get('source_inputs')!=before:
        raise ValueError('native inputs changed during escape screen')
    if (escape_context(root,board)!=context or result.get('generator_inputs')!=context['files']
            or result.get('feature_config')!=context['feature_config']
            or result.get('model_parameters')!=context['model_parameters']):
        raise ValueError('native escape generator, effective policy or parameters changed during screen')
    escape_runtime_valid(result.get('runtime'))
    result.update(status='blocked' if result.get('unsupported_constraints') or result.get('boxed_in') else 'screened',
        generator_context=context,
        qualified=False,inputs={str(native.with_suffix(ext)):digest for ext,digest in
            ((Path(name).suffix,value) for name,value in before.items())},
        native_validation='not_run; fresh parent configured gate required',
        scope='bounded native-polygon/minimum-width escape model; no physical routability proof')
    result['inputs'].update(context['files']);result['inputs'].update(context['config_inputs'])
    result['inputs'][context['launcher']['path']]=context['launcher']['sha256']
    result['inputs'].update({item['path']:item['sha256'] for item in result['runtime']['files'].values()})
    lean.atomic_json(output,result)
    return result


def generate_escape_evidence(contract,candidate,output):
    """Engineering-check adapter for an exact configured candidate snapshot."""
    candidate,output=Path(candidate).resolve(),Path(output).resolve()
    try:
        root=Path(contract['root']).resolve() if contract.get('root') else escape_root(contract,candidate)
        return generate_escape(root,contract['board'],output,candidate=candidate)
    except (OSError,ValueError,RuntimeError,KeyError,TypeError,StopIteration,subprocess.SubprocessError) as error:
        result=dict(schema='iot-lab.pin-escape-evidence.v1',status='blocked',qualified=False,
                    board=str(candidate),cause=str(error),screened_pads=[],not_checked=None)
        if not output.exists():lean.atomic_json(output,result)
        return result


class EscapeStageReceipts:
    """Share sealed screens within one caller-owned stage, never across writers.

    Every consumer still verifies its coverage and the observed runtime files.
    This bounded runtime record does not certify every possible loader library.
    """
    def __init__(self, emit=None):
        self.entries = {}
        self.emit = emit
        self.hits = 0
        self.generated = 0

    def key(self, contract, candidate):
        root = Path(contract['root']).resolve() if contract.get('root') else escape_root(contract,candidate)
        return fingerprint(dict(candidate=str(candidate),sources=source_set(candidate),contract=contract,
            context=escape_context(root,contract['board']),implementations=implementations(root),
            adapter_sha256=sha(Path(__file__).resolve()),
            environment_sha256=fingerprint(dict(os.environ,ROUTE_BOARD=contract['board']))))

    def get(self, contract, candidate, output):
        candidate,output = Path(candidate).resolve(),Path(output).resolve()
        for name,digest in contract.get('inputs',{}).items():
            if sha(name)!=digest:raise ValueError('reviewed escape input changed before screen: '+name)
        key = self.key(contract,candidate)
        previous = self.entries.get(key)
        if previous:
            receipt = previous['path']
            if not receipt.is_file() or sha(receipt)!=previous['sha256']:
                raise ValueError('sealed stage escape receipt changed; inspect '+str(receipt))
            raw = read(receipt)
            if raw.get('cause'):
                raise ValueError('same stage escape screen already failed: '+raw['cause'])
            # A changed observed runtime needs a new screen. Corrupt evidence
            # stays a hard failure instead of silently triggering more work.
            try:
                escape_runtime_valid(raw.get('runtime'))
            except (OSError,ValueError,KeyError,TypeError):
                previous = None
            if previous:
                blockers = verify_escape_evidence(contract,candidate,receipt)
                if any(row['code']=='native_escape_evidence_invalid' for row in blockers):
                    raise ValueError('stage escape receipt no longer verifies: '+str(blockers))
                for name,digest in raw.get('inputs',{}).items():
                    if sha(name)!=digest:raise ValueError('stage escape input changed: '+name)
                if self.key(contract,candidate)!=key:raise ValueError('stage escape inputs changed during reuse')
                if sha(receipt)!=previous['sha256']:raise ValueError('sealed stage escape receipt changed during reuse')
                self.hits += 1
                if self.emit:self.emit('cache.hit',check='escape',evidence=str(receipt),key=key)
                return receipt
        if output.exists():raise ValueError('new stage escape evidence file required')
        self.generated += 1
        if self.emit:self.emit('cache.miss',check='escape',evidence=str(output),key=key)
        generate_escape_evidence(contract,candidate,output)
        if self.key(contract,candidate)!=key:raise ValueError('stage escape inputs changed during generation')
        if not output.is_file():raise ValueError('stage escape producer omitted its receipt')
        self.entries[key] = dict(path=output,sha256=sha(output))
        return output


def generate_escape_for_candidate(root,board,candidate,output,timeout=30):
    """Screen a compact-loop copy using the reviewed owner's unchanged policy."""
    return generate_escape(root,board,output,timeout,candidate=candidate)


def apply_plan(root, board, plan, output):
    """Apply once within an already isolated workspace; caller owns fresh gates.

    Root's unified candidate operation provides that isolation and adoption
    policy. The standalone CLI below creates the same existing snapshot first.
    """
    root,output = Path(root).resolve(),Path(output).resolve()
    plan = read(plan) if isinstance(plan,(str,Path)) else plan
    body = {k:v for k,v in plan.items() if k != 'plan_sha256'}
    if plan.get('schema') != SCHEMA or plan.get('board') != board or fingerprint(body) != plan.get('plan_sha256'):
        raise ValueError('invalid or edited routing decision')
    origin = Path(plan['root']).resolve()
    if root == origin:
        raise ValueError('repair requires an isolated candidate workspace, never the original checkout')
    if output.exists() or any(output.is_relative_to(base/name) for base in (root,origin) for name in ('hardware-design','tools')):
        raise ValueError('repair evidence must be new and outside original/candidate CAD')
    if native_inputs(root,board)[2] != plan['source_inputs'] or implementations(root) != plan['implementation_sha256']:
        raise ValueError('candidate source or repair implementation changed since diagnosis')
    current = diagnose_evidence(origin,board,plan['evidence'],plan.get('plan_path'))
    if current != plan or plan.get('status') != 'repairable':
        raise ValueError('routing decision is stale, unsupported or does not justify a local repair')
    output.mkdir(parents=True,exist_ok=False)
    _,native,_ = native_inputs(root,board)
    before,choice = source_set(native),plan['choice']
    original = native.read_bytes()
    if choice['strategy'] == 'via_shift_bridge':
        receipt = shift_via(native,choice['via_id'],choice['along_trace_id'],output/'proposal',fraction=choice['fraction'])
        candidate = output/'proposal/proposal.kicad_pcb'
        before_omit,after_omit = [choice['via_id']],[choice['via_id'],receipt['added_bridge_id']]
    elif choice['strategy'] == 'straight_gap_bridge':
        selected,rejected = select_gap(native,load_evidence(origin,board,plan['evidence'])[1])
        if selected != choice:
            raise ValueError('native endpoint pattern or protected-copper crossing screen changed')
        import uuid
        uid = str(uuid.uuid5(uuid.NAMESPACE_URL,plan['plan_sha256']))
        text,items = copper_items(native)
        if uid in items:
            raise ValueError('same local repair was already applied')
        a,b = choice['points_mm']
        left=items[choice['endpoint_ids'][0]]
        source_form=_tree(_tokens(text[slice(*left['span'])]))[0]
        net_field=next(f for f in source_form if isinstance(f,list) and f[0]=='net')
        raw_net=' '.join(json.dumps(v) if not v.isdecimal() else v for v in net_field[1:])
        segment = '\n(segment (start '+' '.join(a)+') (end '+' '.join(b)+') (width '+choice['width_mm']+') (layer '+json.dumps(choice['layer'])+') (net '+raw_net+') (uuid '+json.dumps(uid)+'))\n'
        pos = text.rfind(')')
        candidate = output/'proposal.kicad_pcb'
        candidate.write_text(text[:pos]+segment+text[pos:])
        before_omit,after_omit = [],[uid]
        receipt = dict(added_bridge_id=uid)
    else:
        raise ValueError('unsupported local repair strategy')
    protected = geometry_digest(native,before_omit)
    verify_copper_scope(native,candidate,choice,receipt['added_bridge_id'])
    if protected != geometry_digest(candidate,after_omit) or source_set(native) != before:
        raise ValueError('local repair changed protected geometry or source concurrently')
    # Commit only the guarded proposal to this isolated workspace. Shipping CAD
    # is never the target. Parent validates the complete candidate before adoption.
    if native.read_bytes() != original:
        raise ValueError('candidate source changed before local repair write')
    lean.atomic_json(output/'guard.json',dict(schema='iot-lab.local-routing-guard.v1',status='proposed',qualified=False,
        board=board,plan_sha256=plan['plan_sha256'],strategy=choice['strategy'],source_inputs=before,
        protected_geometry_sha256=protected,allowed_original_edits=before_omit,added_items=[receipt['added_bridge_id']],
        candidate_sha256=sha(candidate),candidate=str(native),full_configured_gates_required=True))
    fd,name = tempfile.mkstemp(prefix='.route-repair-',dir=native.parent)
    try:
        with os.fdopen(fd,'wb') as stream:
            stream.write(candidate.read_bytes());stream.flush();os.fsync(stream.fileno())
        if native.read_bytes() != original:
            raise ValueError('candidate source changed before atomic local repair')
        os.replace(name,native)
    finally:
        Path(name).unlink(missing_ok=True)
    return read(output/'guard.json')


def observe_route(source_board, route_dir):
    """Bounded read-only decision for the existing compaction failed-route loop."""
    source_board,folder = Path(source_board),Path(route_dir)
    artifacts = {p.name:sha(p) for p in (folder/name for name in
                 ('input-manifest.json','outcome.json','drc.json','open-triage.json','pin-escape.json','report.json','rules.log')) if p.is_file()}
    result = dict(schema='iot-lab.route-observation.v1',qualified=False,artifacts=artifacts,
                  source_board_sha256=sha(source_board),findings=[],stop_unchanged_retry=True)
    try:
        manifest,outcome = read(folder/'input-manifest.json'),read(folder/'outcome.json')
        routed = folder/'routed.kicad_pcb'
        if manifest.get('board_sha256') != sha(source_board) or outcome.get('board_sha256') != sha(routed) or outcome.get('status') not in {'stuck','complete'}:
            raise ValueError('route inputs/result are stale or incomplete')
        report = read(folder/'drc.json')
        if any(not isinstance(report.get(key),list) for key in ('violations','unconnected_items','schematic_parity')):
            raise ValueError('native route report lacks required checks')
        diagnostics = {key:read(folder/name) for key,name in [('triage','open-triage.json'),('escape','pin-escape.json')] if (folder/name).is_file()}
        if (folder/'rules.log').exists():diagnostics['rules']=(folder/'rules.log').read_text()
        result['findings'] = classify(report,diagnostics)
        kinds = {row['classification'] for row in result['findings']}
        result.update(status='diagnosed',action='inspect_escape' if kinds & {'escape_failure','model_enclosed'} else
                      'resolve_constraint_coverage' if 'constraints_unknown' in kinds else
                      'inspect_native_geometry' if 'native_geometry' in kinds else
                      'diagnose_selected_connections' if 'native_open' in kinds else 'continue_native_validation',
                      reason='Diagnostic next step; no physical impossibility or joint-routability claim',
                      no_electrical_rule_relaxation=True)
    except (OSError,ValueError,KeyError,TypeError) as error:
        result.update(status='unverified',action='inspect_evidence',reason=str(error))
    return result


def retry_key(source_board,configuration):
    """Same-run failed-attempt identity, including missing native sidecars."""
    board=Path(source_board).resolve()
    files={ext:sha(board.with_suffix(ext)) if board.with_suffix(ext).is_file() else None
           for ext in ('.kicad_pcb','.kicad_pro','.kicad_dru','.kicad_sch')}
    tools=Path(__file__).resolve().parent
    policy={name:sha(tools/name) for name in ('route_decision.py','fastroute_job.py','route_grid.py',
        'route_features.py','route-features.json','routing_rules.py','lean_workflow.py')}
    for name in ('ROUTE_FEATURES_FILE','FASTROUTE_BIN','KICAD_CLI'):
        path=Path(os.environ.get(name,'/nonexistent-route-policy'))
        if path.is_file():policy[str(path)]=sha(path)
    return fingerprint(dict(inputs=files,configuration=configuration,policy=policy,
        environment={key:value for key,value in os.environ.items() if key.startswith(('ROUTE_','FASTR','KICAD','IOT_LEAN'))}))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='mode',required=True)
    for name in ('diagnose','repair','escape'):
        p=sub.add_parser(name);p.add_argument('board');p.add_argument('--json',action='store_true');p.add_argument('--output',type=Path)
        p.add_argument('--root',type=Path,default=ROOT)
        if name!='escape':p.add_argument('--evidence' if name=='diagnose' else '--plan',type=Path,required=True)
        if name in ('repair','escape'):p.add_argument('--timeout',type=float,default=120 if name=='repair' else 30)
    args=parser.parse_args(argv)
    try:
        if args.mode=='diagnose':
            result=diagnose_evidence(args.root,args.board,args.evidence,args.output)
            if args.output:
                if args.output.exists():raise ValueError('decision output already exists')
                lean.atomic_json(args.output,result)
            code=0
        elif args.mode=='escape':
            if not args.output:raise ValueError('--output evidence file required')
            result=generate_escape(args.root,args.board,args.output,args.timeout)
            code=0 if result['status']=='screened' else 3
        else:
            if not args.output or args.output.exists():raise ValueError('new --output directory required')
            if not math.isfinite(args.timeout) or args.timeout<=0:raise ValueError('finite positive timeout required')
            from pcb_operations import snapshot
            args.output.mkdir(parents=True)
            workspace=args.output/'workspace';snapshot(args.root,workspace,args.board)
            guard=apply_plan(workspace,args.board,args.plan,args.output/'repair')
            deadline=lean.deadline_after(args.timeout)
            env=dict(os.environ,IOT_LAB=str(workspace))
            with (args.output/'gate.log').open('w') as log:
                proc=lean.run_stage([os.environ.get('NODE','node'),str(workspace/'tools/gate.mjs'),args.board,'--fresh','--evidence-dir',str(args.output/'gate')],
                    stage='repair-native-gate',event_file=args.output/'events.jsonl',deadline=deadline,cwd=workspace,env=env,stdout=log,stderr=subprocess.STDOUT)
            result=dict(status='candidate' if proc.returncode==0 else 'rejected',qualified=False,guard=guard,
                configured_gate_exit=proc.returncode,board_specific_and_adoption_checks_required=True)
            lean.atomic_json(args.output/'result.json',result);code=0 if proc.returncode==0 else 3
        print(json.dumps(result) if args.json else ('PASS: ' if code==0 else 'STUCK: ')+result.get('action',result['status']))
        return code
    except (OSError,ValueError,RuntimeError,KeyError,TypeError,subprocess.SubprocessError) as error:
        result=dict(schema=SCHEMA,status='blocked',qualified=False,cause=str(error))
        if args.output and not args.output.exists():lean.atomic_json(args.output,result)
        print(json.dumps(result) if args.json else 'STUCK: '+str(error));return 3


if __name__=='__main__':raise SystemExit(main())
