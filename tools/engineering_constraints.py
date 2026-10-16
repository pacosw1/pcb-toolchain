#!/usr/bin/env python3
"""Source-bound engineering screens for actual native placement geometry.

These checks do not establish electrical, routing, enclosure or bench qualification.
Unsupported geometry/rules stop the reviewed workflow instead of disappearing.
"""
import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
import sys

from pcb_workflow import board_config, sha
from pcb_search.block_bindings import child, footprints, rotate, verify_binding
from pcb_search.contracts import fingerprint
from placer.dru import _tree, _tokens

SCHEMA = 'iot-lab.engineering-constraints.v1'
KINDS = {'fixed', 'rigid_group', 'pin_distance', 'clearance', 'connector_access', 'escape'}
_TRUSTED_CONTRACTS = {}
CORE_FIELDS = ('schema','root','board','manifest','native','inputs','rules','geometry','bindings')


def contract_digest(contract):
    return fingerprint({key:contract[key] for key in CORE_FIELDS})


def read(path):
    value = json.loads(Path(path).read_text())
    if not isinstance(value, dict):
        raise ValueError('expected JSON object: ' + str(path))
    return value


def numeric(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('finite numeric constraint required')
    return float(value)


def resolve(base, name):
    return (Path(base) / name).resolve()


def source_document(base, source):
    if not isinstance(source, dict) or not isinstance(source.get('page'), int) or isinstance(source['page'], bool) or source['page'] < 1:
        raise ValueError('constraint requires a reviewed document and one-based page')
    path = resolve(base, source['path'])
    if sha(path) != source.get('sha256'):
        raise ValueError('constraint source changed: ' + str(path))
    return path


def quarter(degrees):
    value = float(degrees) % 360
    if value not in (0, 90, 180, 270):
        raise ValueError('geometry requires quarter-turn native orientation')
    return int(value / 90)


def point(x, y, q, origin):
    if q in (0,1,2,3):
        a, b = rotate(float(x), float(y), int(q))
    else:
        angle = math.radians(q*90)
        a,b = float(x)*math.cos(angle)+float(y)*math.sin(angle), -float(x)*math.sin(angle)+float(y)*math.cos(angle)
    return [float(origin[0]) + a, float(origin[1]) + b]


def transformed_box(box, q, origin):
    x0, y0, x1, y1 = box
    corners = [point(x, y, q, origin) for x, y in ((x0,y0), (x1,y0), (x1,y1), (x0,y1))]
    return [min(p[0] for p in corners), min(p[1] for p in corners),
            max(p[0] for p in corners), max(p[1] for p in corners)]


def native_geometry(path):
    """Read exact pad centers; limited copper shapes and conservative courtyards."""
    native = _tree(_tokens(Path(path).read_text()))[0]
    refs = {}
    edge_points = []
    for form in native[1:]:
        if not isinstance(form, list) or not form:
            continue
        if form[0] in ('gr_line', 'gr_rect') and child(form, 'layer', [''])[0] == 'Edge.Cuts':
            edge_points += [list(map(float, child(form, key))) for key in ('start', 'end')]
    for fp in footprints(path):
        ref = fp['props'].get('Reference')
        if not ref or ref in refs:
            raise ValueError('missing or duplicate native reference')
        x,y,angle = map(float, fp['pose'])
        q = (angle%360)/90
        pads, courtyard = {}, []
        unsupported_courtyard = False
        for item in fp['form'][2:]:
            if not isinstance(item, list) or not item:
                continue
            if item[0] == 'pad':
                at = child(item, 'at', ['0','0'])
                size = child(item, 'size')
                if not size or len(size) != 2:
                    raise ValueError('missing native pad size: ' + ref)
                center = point(*map(float, at[:2]), q, (x,y))
                shape = item[3]
                pad_angle = float(at[2]) if len(at) == 3 else angle
                pq = (pad_angle%360)/90
                w,h = map(float,size)
                if w<=0 or h<=0:
                    raise ValueError('native pad size must be positive')
                if pq % 2:
                    w,h = h,w
                entry = dict(center=center, shape=shape, size=[w,h],axis_aligned=pq in (0,1,2,3),
                             layers=child(item,'layers',[]), kind=item[2])
                pads.setdefault(item[1], []).append(entry)
            elif child(item, 'layer', [''])[0] in ('F.CrtYd','B.CrtYd'):
                if item[0] in ('fp_line', 'fp_rect'):
                    courtyard += [point(*map(float,child(item,key)),q,(x,y)) for key in ('start','end')]
                elif item[0] == 'fp_circle':
                    a,b = child(item,'center'),child(item,'end')
                    radius = math.hypot(float(a[0])-float(b[0]),float(a[1])-float(b[1]))
                    c = point(*map(float,a),q,(x,y))
                    courtyard += [[c[0]-radius,c[1]-radius],[c[0]+radius,c[1]+radius]]
                else:
                    unsupported_courtyard = True
        body = ([min(p[0] for p in courtyard),min(p[1] for p in courtyard),
                 max(p[0] for p in courtyard),max(p[1] for p in courtyard)]
                if courtyard and not unsupported_courtyard else None)
        refs[ref] = dict(origin=[x,y], quarter=q, pads=pads, courtyard=body,
                         locked=('locked' in fp['form'] or child(fp['form'],'locked',['no']) != ['no']))
    bounds = ([min(p[0] for p in edge_points),min(p[1] for p in edge_points),
               max(p[0] for p in edge_points),max(p[1] for p in edge_points)] if edge_points else None)
    result = dict(refs=refs, bounds=bounds)
    json.dumps(result,allow_nan=False)  # Malformed native NaN/Inf cannot become a passing comparison.
    return result


def endpoint(geometry, selector):
    if not isinstance(selector,dict) or set(selector) != {'ref','pad'}:
        raise ValueError('pad endpoint requires exact ref and pad')
    rows = geometry['refs'][selector['ref']]['pads'].get(str(selector['pad']),[])
    if len(rows) != 1:
        raise ValueError('pad endpoint missing or ambiguous: ' + str(selector))
    return rows[0]


def rule_refs(rule):
    if rule['kind'] in ('fixed','rigid_group','escape'):
        return set(rule['refs'])
    if rule['kind'] == 'connector_access':
        return {rule['ref']}
    return {rule['a']['ref'], rule['b']['ref']}


def normalized_rules(root, envelope, geometry):
    if envelope.get('schema') != SCHEMA or not isinstance(envelope.get('rules'),list):
        raise ValueError('reviewed placement constraints schema missing')
    rules, sources, bindings = [], {}, []
    declared = {r.get('id'):r for r in envelope['rules'] if isinstance(r,dict)}
    seen = set()
    for original in envelope['rules']:
        rule = copy.deepcopy(original)
        if not isinstance(rule.get('id'),str) or not rule['id'] or rule['id'] in seen:
            raise ValueError('constraint needs a distinct reviewed ID')
        seen.add(rule['id'])
        if rule.get('kind') not in KINDS:
            raise ValueError('unsupported engineering constraint: ' + str(rule.get('kind')))
        fields = dict(fixed={'refs'},rigid_group={'refs','binding'},
                      pin_distance={'a','b','metric','min_mm','max_mm'},
                      clearance={'a','b','metric','min_mm'},
                      connector_access={'ref','metric','corridor_mm','exit_side'},
                      escape={'refs','pads','metric','layers','width_mm','clearance_mm','reach_mm','grid_mm'})
        unknown = set(rule)-{'id','kind','source'}-fields[rule['kind']]
        if unknown:
            raise ValueError('unsupported constraint fields: '+','.join(sorted(unknown)))
        path = source_document(root,rule['source'])
        sources[str(path)] = sha(path)
        refs = rule_refs(rule)
        if not refs or refs - set(geometry['refs']):
            raise ValueError('constraint references absent native parts: ' + rule['id'])
        kind = rule['kind']
        if kind in ('fixed','rigid_group','escape') and (not isinstance(rule['refs'],list) or len(refs) != len(rule['refs'])):
            raise ValueError('constraint needs distinct exact native refs')
        if kind == 'rigid_group':
            if len(refs) < 2:
                raise ValueError('rigid group requires at least two parts')
            if rule.get('binding'):
                descriptor = rule['binding']
                path = resolve(root,descriptor['path'])
                if sha(path) != descriptor.get('sha256'):
                    raise ValueError('block binding evidence changed')
                binding = verify_binding(read(path))
                if set(binding['refs'].values()) != refs:
                    raise ValueError('bound instance refs differ from rigid group')
                from block_reuse import read_block
                block = read_block(binding['source_directory'])
                mapping = descriptor.get('layout_rule_ids')
                if not isinstance(mapping,dict) or set(mapping)!={str(i) for i in range(len(block['layout_rules']))}:
                    raise ValueError('reviewed block layout-rule coverage missing: '+rule['id'])
                if any(not isinstance(ids,list) or not ids or set(ids)-set(declared) for ids in mapping.values()):
                    raise ValueError('reviewed block rule mapping needs exact sourced constraint IDs')
                boundary = descriptor.get('boundary_rule_ids')
                if not isinstance(boundary,list) or not boundary or set(boundary)-set(declared):
                    raise ValueError('reviewed block boundary constraints missing: '+rule['id'])
                for identity in boundary:
                    boundary_rule = declared[identity]
                    target_refs = rule_refs(boundary_rule)
                    if (boundary_rule.get('kind') not in ('clearance','connector_access','escape') or not target_refs&refs
                            or (boundary_rule['kind']=='clearance' and not target_refs-refs)):
                        raise ValueError('block boundary rule does not constrain actual external geometry: '+identity)
                sources[str(path)] = sha(path)
                source_pcb = Path(binding['source_directory']) / (binding['block_id'] + '.kicad_pcb')
                forms = _tree(_tokens(source_pcb.read_text()))[0]
                rule['retained_internal_copper'] = any(isinstance(f,list) and f and f[0] in ('segment','arc','via','zone') for f in forms)
                bindings.append(binding)
        elif kind in ('pin_distance','clearance'):
            a,b = endpoint(geometry,rule['a']),endpoint(geometry,rule['b'])
            required_metric = 'pad_center_euclidean' if kind == 'pin_distance' else 'copper_edge_2d'
            if rule.get('metric') != required_metric:
                raise ValueError('unsupported engineering metric: ' + str(rule.get('metric')))
            if not any(key in rule for key in ('min_mm','max_mm')) or (kind == 'clearance' and ('min_mm' not in rule or 'max_mm' in rule)):
                raise ValueError('sourced min/max distance required')
            for key in ('min_mm','max_mm'):
                if key in rule and numeric(rule[key]) < 0:
                    raise ValueError('negative sourced distance')
            if rule.get('min_mm',0) > rule.get('max_mm',math.inf):
                raise ValueError('contradictory sourced distances')
            if kind == 'clearance' and any(p['shape'] not in ('rect','circle') or p['kind'] == 'np_thru_hole' or not p['axis_aligned'] for p in (a,b)):
                raise ValueError('unsupported exact copper shape for clearance: ' + rule['id'])
        elif kind == 'connector_access':
            if rule.get('metric') != 'courtyard_corridor_2d' or rule.get('exit_side') not in ('L','R','T','B'):
                raise ValueError('unsupported connector access metric')
            box = rule.get('corridor_mm',[])
            if len(box) != 4 or any(not math.isfinite(numeric(v)) for v in box) or not (box[0] < box[2] and box[1] < box[3]):
                raise ValueError('connector corridor requires a nonempty local rectangle')
            if not (box[0] <= 0 <= box[2] and box[1] <= 0 <= box[3]):
                raise ValueError('connector corridor must include its native reference origin')
            if geometry['bounds'] is None or any(p['courtyard'] is None for p in geometry['refs'].values()):
                raise ValueError('connector access needs board edges and every footprint courtyard')
        elif kind == 'escape':
            if rule.get('metric')!='native_minimum_track_escape':
                raise ValueError('unsupported native escape metric')
            overrides = set(rule)&{'layers','width_mm','clearance_mm','reach_mm','grid_mm'}
            if overrides:
                raise ValueError('unsupported native escape overrides: '+','.join(sorted(overrides)))
            for selected in rule.get('pads',[]):
                endpoint(geometry,selected)
                if selected['ref'] not in refs:
                    raise ValueError('escape pad selector is outside reviewed refs')
        rules.append(rule)
    return rules,sources,bindings


def pad_gap(a,b):
    if not (set(a['layers']) & set(b['layers']) or '*.Cu' in a['layers'] or '*.Cu' in b['layers']):
        raise ValueError('clearance endpoints have no common modeled copper layer')
    (ax,ay),(bx,by) = a['center'],b['center']
    if a['shape'] == b['shape'] == 'circle':
        if a['size'][0] != a['size'][1] or b['size'][0] != b['size'][1]:
            raise ValueError('noncircular native circle pad')
        return math.hypot(ax-bx,ay-by)-(a['size'][0]+b['size'][0])/2
    if a['shape'] == 'circle':
        a,b = b,a
        (ax,ay),(bx,by) = a['center'],b['center']
    dx,dy = abs(ax-bx)-a['size'][0]/2,abs(ay-by)-a['size'][1]/2
    if b['shape'] == 'circle':
        if b['size'][0] != b['size'][1]:
            raise ValueError('noncircular native circle pad')
        return math.hypot(max(dx,0),max(dy,0))-b['size'][0]/2
    return math.hypot(max(dx-b['size'][0]/2,0),max(dy-b['size'][1]/2,0))


def evaluate(contract, geometry, refs=None):
    blockers,measurements = [],[]
    original = contract['geometry']
    for rule in contract['rules']:
        if refs is not None and not (rule_refs(rule) & refs) and rule['kind'] != 'connector_access':
            continue
        kind,miss,detail = rule['kind'],0.0,{}
        if kind == 'escape':
            continue  # Exact native evidence is checked separately, never a pose proxy.
        if kind in ('fixed','rigid_group'):
            transforms = []
            for ref in rule['refs']:
                a,b = original['refs'][ref],geometry['refs'][ref]
                q = (b['quarter']-a['quarter'])%4
                x,y = point(*a['origin'],q,(0,0))
                transforms.append((q,round(b['origin'][0]-x,6),round(b['origin'][1]-y,6)))
            frozen = kind == 'fixed' or rule.get('retained_internal_copper',False)
            bad = any(t != (0,0.0,0.0) for t in transforms) if frozen else len(set(transforms)) != 1
            miss = 1.0 if bad else 0.0
            detail = dict(transforms=transforms,policy='fixed_retained_copper' if rule.get('retained_internal_copper') else kind)
        elif kind in ('pin_distance','clearance'):
            a,b = endpoint(geometry,rule['a']),endpoint(geometry,rule['b'])
            measured = math.dist(a['center'],b['center']) if kind == 'pin_distance' else pad_gap(a,b)
            miss = max(rule.get('min_mm',0)-measured,0,measured-rule.get('max_mm',math.inf))
            detail = dict(measured_mm=measured,metric=rule['metric'],**{k:rule[k] for k in ('min_mm','max_mm') if k in rule})
        elif kind == 'connector_access':
            fp = geometry['refs'][rule['ref']]
            box = transformed_box(rule['corridor_mm'],fp['quarter'],fp['origin'])
            x0,y0,x1,y1 = geometry['bounds']
            exits = dict(L=box[0]<=x0,R=box[2]>=x1,T=box[1]<=y0,B=box[3]>=y1)
            clashes = []
            for ref,other in geometry['refs'].items():
                if ref == rule['ref']:
                    continue
                a,b,c,d = other['courtyard']
                if min(box[2],c)>max(box[0],a) and min(box[3],d)>max(box[1],b):
                    clashes.append(ref)
            miss = float(bool(clashes) or not exits[rule['exit_side']])
            detail = dict(corridor_world_mm=box,blocking_refs=clashes,reaches_requested_edge=exits[rule['exit_side']],
                          scope='conservative_2d_courtyard_screen; enclosure/harness/3d review remains required')
        measurements.append(dict(id=rule['id'],kind=kind,refs=sorted(rule_refs(rule)),**detail))
        if miss:
            blockers.append(dict(code='constraint_violation',id=rule['id'],kind=kind,refs=sorted(rule_refs(rule)),miss=miss,
                                 source=rule['source'],**detail))
    for ref,after in geometry['refs'].items():
        before = original['refs'][ref]
        if before['locked'] and (before['origin']!=after['origin'] or before['quarter']!=after['quarter']):
            blockers.append(dict(code='native_locked_part_moved',id='native-lock:'+ref,refs=[ref],miss=1.0,
                                 reference=ref,source=contract['native']))
    return blockers,measurements


def inputs_current(inputs):
    for name,expected in inputs.items():
        if sha(name) != expected:
            raise ValueError('engineering input changed: ' + name)


def reviewed_contract(root, board, manifest):
    from part_evidence import verify_manifest
    root,manifest = Path(root).resolve(),Path(manifest).resolve()
    report = verify_manifest(root,board,manifest)
    if report.get('status') != 'passed':
        raise ValueError('part engineering review is incomplete: ' + json.dumps(report.get('blockers',[])))
    _,_,project = board_config(root,board)
    native = project.with_suffix('.kicad_pcb')
    geometry = native_geometry(native)
    rules,sources,bindings = normalized_rules(root,report.get('constraints',{}),geometry)
    inputs = {str(manifest):sha(manifest),**sources}
    for key in ('inputs','native_inputs'):
        for name,value in report.get(key,{}).items():
            inputs[str(resolve(root,name))] = value
    for binding in bindings:
        if Path(binding['target']).resolve() != native:
            raise ValueError('reviewed block binding targets another native board')
        from block_reuse import read_block
        library = Path(binding['source_directory'])
        inputs.update({str(library/name):digest for name,digest in read_block(library)['files'].items()})
    inputs[str(native)] = sha(native)
    inputs_current(inputs)
    contract = dict(schema=SCHEMA,root=str(root),board=board,manifest=str(manifest),native=str(native),inputs=inputs,
                    rules=rules,geometry=geometry,bindings=bindings,qualified=False)
    contract['review_sha256'] = contract_digest(contract)
    _TRUSTED_CONTRACTS[(str(root),board,str(manifest))] = copy.deepcopy(contract)
    return contract


def escape_checks(contract, candidate, evidence):
    rules = [r for r in contract['rules'] if r['kind']=='escape']
    if not rules:
        return []
    if not evidence:
        return [dict(code='native_escape_evidence_missing',ids=[r['id'] for r in rules],
                     detail='provide exact native escape evidence before placement/routing')]
    from route_decision import verify_escape_evidence
    return verify_escape_evidence(contract,Path(candidate),Path(evidence))


def check_manifest(root, board, manifest, candidate=None, *, escape_evidence=None):
    report = dict(schema='iot-lab.engineering-placement-check.v1',board=board,qualified=False,
                  scope='reviewed_native_placement_screen',status='blocked',blockers=[],measurements=[],
                  unsupported=[],inputs={})
    try:
        contract = reviewed_contract(root,board,manifest)
        native = Path(candidate).resolve() if candidate else Path(contract['native'])
        geometry = native_geometry(native)
        if set(geometry['refs']) != set(contract['geometry']['refs']):
            raise ValueError('candidate native population differs from reviewed source')
        if candidate:
            from pcb_search.native_placement import footprint_signature
            baseline = {f['props']['Reference']:footprint_signature(f) for f in footprints(contract['native'])}
            actual = {f['props']['Reference']:footprint_signature(f) for f in footprints(native)}
            if actual != baseline:
                raise ValueError('candidate part identity, footprint geometry or pad nets changed')
        blockers,measurements = evaluate(contract,geometry)
        blockers += escape_checks(contract,native,escape_evidence)
        inputs_current(contract['inputs'])
        report.update(status='blocked' if blockers else 'passed',blockers=blockers,measurements=measurements,
                      inputs=contract['inputs'],native=str(native),candidate_sha256=sha(native),
                      contract_sha256=fingerprint(contract),rules=len(contract['rules']),
                      reuse=[dict(block_id=b['block_id'],instance_path=b['instance_path'],qualification_transferred=False) for b in contract['bindings']])
    except (OSError,ValueError,KeyError,TypeError,ImportError) as error:
        text = str(error)
        report['status'] = 'stale' if 'changed' in text or 'stale' in text else 'blocked'
        report['blockers'] = [dict(code='engineering_review_required',detail=text)]
        if 'unsupported' in text:
            report['unsupported'] = [text]
    return report


def model_anchor(problem):
    return fingerprint(dict(units=[{k:u.get(k) for k in ('name','refs','x','y','fixed')} for u in problem['units']],
                            outline=problem['board']['outline']))


def prepare_problem(root, board, manifest, problem):
    contract = reviewed_contract(root,board,manifest)
    if Path(problem['board_file']).resolve() != Path(contract['native']):
        raise ValueError('placement model belongs to another native source')
    out = copy.deepcopy(problem)
    where = {ref:i for i,u in enumerate(out['units']) for ref in u['refs']}
    if set(where)!=set(contract['geometry']['refs']) or sum(len(u['refs']) for u in out['units'])!=len(where):
        raise ValueError('placement model differs from exact reviewed native population')
    for rule in contract['rules']:
        if rule['kind']=='rigid_group' and len({where[r] for r in rule['refs']}) != 1:
            raise ValueError('reviewed rigid group must be read as one intact placement unit: '+rule['id'])
        if rule['kind']=='fixed' or rule.get('retained_internal_copper'):
            for ref in rule['refs']:
                out['units'][where[ref]]['fixed'] = True
    contract['where'] = where
    contract['model_anchor_sha256'] = model_anchor(out)
    out['engineering'] = contract
    # Geometric failures are precisely what a placement search may repair.
    # Invalid reviews/unsupported semantics already failed before this point.
    contract['initial_screen'] = check_problem(out)
    return out


def geometry_for_pose(problem, pose, refs=None):
    contract = problem['engineering']
    source = contract['geometry']
    out = dict(bounds=source['bounds'],refs={ref:copy.deepcopy(entry) for ref,entry in source['refs'].items()
                                           if refs is None or ref in refs})
    for ref,entry in out['refs'].items():
        i = contract['where'][ref]
        unit = problem['units'][i]
        x,y,q = pose[i]
        if q not in (0,1,2,3) or any(not math.isfinite(numeric(v)) for v in (x,y)):
            raise ValueError('invalid engineering placement pose')
        origin = (unit['x'],unit['y'])
        def at(p):
            return point(p[0]-origin[0],p[1]-origin[1],q,(x,y))
        entry['origin'] = at(entry['origin'])
        entry['quarter'] = (entry['quarter']+q)%4
        if entry['courtyard']:
            a,b,c,d = entry['courtyard']
            entry['courtyard'] = transformed_box([a-origin[0],b-origin[1],c-origin[0],d-origin[1]],q,(x,y))
        for rows in entry['pads'].values():
            for pad in rows:
                pad['center'] = at(pad['center'])
                if q%2:
                    pad['size'] = pad['size'][::-1]
    return out


def check_problem(problem, pose=None, verify_sources=True):
    contract = problem.get('engineering')
    if not contract:
        return dict(status='legacy_unreviewed',qualified=False,blockers=[],coverage='no reviewed engineering constraints attached')
    if contract_digest(contract)!=contract.get('review_sha256'):
        raise ValueError('reviewed engineering contract payload changed')
    if Path(problem['board_file']).resolve()!=Path(contract['native']):
        raise ValueError('engineering model source differs from the reviewed native board')
    if model_anchor(problem) != contract.get('model_anchor_sha256'):
        raise ValueError('engineering placement model anchors changed')
    where = {ref:i for i,u in enumerate(problem['units']) for ref in u['refs']}
    if where!=contract['where'] or sum(len(u['refs']) for u in problem['units'])!=len(where):
        raise ValueError('engineering model reference-to-unit mapping changed')
    if verify_sources:
        inputs_current(contract['inputs'])
        key = (contract['root'],contract['board'],contract['manifest'])
        trusted = _TRUSTED_CONTRACTS.get(key)
        if trusted is None:
            # A process loading a JSON model has no authority to trust the model's
            # self-supplied digest. Derive it from the real reviewed manifest.
            trusted = reviewed_contract(Path(contract['root']),contract['board'],Path(contract['manifest']))
        inputs_current(trusted['inputs'])
        if contract_digest(contract)!=trusted['review_sha256']:
            raise ValueError('engineering model differs from the actual reviewed source contract')
        for binding in contract.get('bindings',[]):
            verify_binding(binding)
    for rule in contract['rules']:
        if rule['kind']=='rigid_group' and len({where[r] for r in rule['refs']})!=1:
            raise ValueError('engineering rigid group was split before search/write')
    pose = pose or [[u['x'],u['y'],0] for u in problem['units']]
    if len(pose)!=len(problem['units']):
        raise ValueError('placement pose cardinality differs from reviewed model')
    blockers,measurements = evaluate(contract,geometry_for_pose(problem,pose))
    return dict(status='blocked' if blockers else 'passed',qualified=False,blockers=blockers,measurements=measurements)


def pose_miss(problem, pose, i):
    if not problem.get('engineering'):
        return 0.0
    mine = set(problem['units'][i]['refs'])
    contract = problem['engineering']
    rules = [r for r in contract['rules'] if rule_refs(r)&mine or r['kind']=='connector_access']
    needed = set().union(*(rule_refs(r) for r in rules))
    if any(r['kind']=='connector_access' for r in rules):
        needed = None
    blockers,_ = evaluate(dict(contract,rules=rules),geometry_for_pose(problem,pose,needed))
    return sum(row['miss'] for row in blockers)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['check'])
    parser.add_argument('board')
    parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--manifest',type=Path,required=True)
    parser.add_argument('--candidate',type=Path)
    parser.add_argument('--escape-evidence',type=Path)
    parser.add_argument('--output',type=Path)
    parser.add_argument('--json',action='store_true')
    args = parser.parse_args(argv)
    report = check_manifest(args.root,args.board,args.manifest,args.candidate,escape_evidence=args.escape_evidence)
    if args.output:
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report) if args.json else ('PASS' if report['status']=='passed' else 'STUCK')+': '+report['status']+'; '+json.dumps(report['blockers']))
    return 0 if report['status']=='passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
