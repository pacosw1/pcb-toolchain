#!/usr/bin/env python3
"""Trace declared requirements to existing engineering verifiers, stage by stage.

A passed assessment means its explicit stage evidence is current. It never
qualifies hardware, proves an unmodeled function, or authorizes production.
"""
import argparse
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys

import part_evidence
import part_native
import lean_workflow as lean

SCHEMA = 'iot-lab.design-contract.v1'
REPORT = 'iot-lab.design-assessment.v1'
STAGES = ('requirements','architecture','parts','schematic','placement','routing','prototype','production')
KINDS = {'part_selection','part_use','schematic','placement','native_gate','release','bench','block_qualification'}
ROOT = Path(__file__).resolve().parent.parent  # tools/ sources
import project_root  # noqa: E402  (project root: --root/IOT_LAB/cwd; tools/project_root.py)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def fingerprint(value):
    return hashlib.sha256(part_native.encoded(value)).hexdigest()


def read(path):
    value = json.loads(Path(path).read_text())
    if not isinstance(value,dict):
        raise ValueError('expected JSON object: '+str(path))
    return value


def relative_file(root, name):
    return part_native.owned(Path(root).resolve(),name)


def source(root, descriptor, inputs=None):
    if not isinstance(descriptor,dict) or not isinstance(descriptor.get('sha256'),str):
        raise ValueError('source requires repository-relative path, actual SHA-256 and locator')
    path = relative_file(root,descriptor.get('path'))
    digest = sha(path)
    if digest != descriptor['sha256']:
        raise ValueError('stale source: '+descriptor['path'])
    if path.suffix.lower()=='.pdf':
        page = descriptor.get('page')
        if type(page) is not int or not 1<=page<=part_evidence.pdf_pages(path):
            raise ValueError('source PDF needs an actual one-based page')
    elif not isinstance(descriptor.get('section'),str) or not descriptor['section'].strip():
        raise ValueError('source requires a section/record locator')
    if inputs is not None:
        inputs[str(path)] = digest
    return path


def quantity_range(root, value, inputs=None):
    """Canonical finite range; units and conditions are never guessed/converted."""
    if not isinstance(value,dict) or not isinstance(value.get('unit'),str) or not value['unit'].strip():
        raise ValueError('quantity interval needs an explicit unit')
    if set(value)-{'kind','min','max','unit','source'} or value.get('kind','interval')!='interval':
        raise ValueError('unsupported quantity interval fields/conditions; explicit reviewed model required')
    if any(type(value.get(k)) not in (int,float) or not math.isfinite(value[k]) for k in ('min','max')) or value['min']>value['max']:
        raise ValueError('quantity interval needs finite ordered min/max')
    source(root,value.get('source'),inputs)
    return value


def _ids(rows, label):
    if not isinstance(rows,list) or any(not isinstance(r,dict) or not isinstance(r.get('id'),str)
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]*',r['id']) for r in rows):
        raise ValueError(label+' require explicit stable IDs')
    if len({r['id'] for r in rows})!=len(rows):
        raise ValueError(label+' IDs must be unique')
    return {r['id']:r for r in rows}


def _refs(row, requirements):
    refs = row.get('requirements')
    if not isinstance(refs,list) or not refs or len(set(refs))!=len(refs) or set(refs)-set(requirements):
        raise ValueError('exact named requirements required: '+str(row.get('id')))


def _load_contract(root, path):
    """Validate declaration/source integrity; no native or bench verdict implied.

    Raises ValueError/OSError for invalid or stale input. Missing future checker
    outputs are allowed: actual assessments require them only at their stage.
    """
    root,path = Path(root).resolve(),Path(path).resolve()
    value = read(path)
    allowed = {'schema','identity','current_stage','requirements','architecture','test_plans','failure_conditions','unknowns','checks','production'}
    if set(value)!=allowed or value.get('schema')!=SCHEMA or value.get('current_stage') not in STAGES:
        raise ValueError('unsupported design contract/schema/stage')
    identity = value.get('identity',{})
    if (not isinstance(identity,dict) or set(identity)!={'design_id','board','revision'}
            or not re.fullmatch(r'[A-Z0-9][A-Z0-9-]*',identity.get('design_id',''))
            or identity.get('board') is not None and not re.fullmatch(r'[A-Z0-9][A-Z0-9-]*',identity['board'])
            or not isinstance(identity.get('revision'),str) or not identity['revision'].strip()):
        raise ValueError('exact design identity, nullable board and revision required')
    requirements = _ids(value.get('requirements'),'requirements')
    if not requirements:
        raise ValueError('at least one sourced requirement required')
    for row in requirements.values():
        if set(row)!={'id','statement','source','verification_stage','acceptance'}:
            raise ValueError('unsupported requirement fields')
        if not isinstance(row.get('statement'),str) or not row['statement'].strip() or row.get('verification_stage') not in STAGES:
            raise ValueError('requirement needs statement and verification stage')
        source(root,row.get('source'))
        acceptance = row.get('acceptance',{})
        if acceptance.get('kind')=='interval':
            quantity_range(root,acceptance)
        elif acceptance.get('kind')=='review' and isinstance(acceptance.get('criterion'),str) and acceptance['criterion'].strip():
            if set(acceptance)!={'kind','criterion','source'}:raise ValueError('unsupported review acceptance fields')
            source(root,acceptance.get('source'))
        else:
            raise ValueError('explicit sourced interval/review acceptance required: '+row['id'])
    checks = _ids(value.get('checks',[]),'checks')
    for row in checks.values():
        if set(row)-{'id','stage','kind','requirements','path','references','constraint_ids','selectors','escape_evidence',
                'stock','orientation','boards','as-of','plan','library','block_id','binding','proof','bench'}:
            raise ValueError('unsupported verifier/check fields: '+row['id'])
        if row.get('kind') not in KINDS or row.get('stage') not in STAGES or not isinstance(row.get('path'),str):
            raise ValueError('unsupported verifier/check stage: '+row['id'])
        # Resolve declared paths without requiring not-yet-produced evidence.
        target = root/row['path']
        if Path(row['path']).is_absolute() or '\\' in row['path'] or '..' in Path(row['path']).parts or not target.resolve().is_relative_to(root):
            raise ValueError('checker path must remain inside project root')
        _refs(row,requirements)
    plans = _ids(value.get('test_plans',[]),'test plans')
    for row in plans.values():
        _refs(row,requirements)
        if row.get('stage') not in ('prototype','production') or not isinstance(row.get('method'),str) or not row['method'].strip():
            raise ValueError('test plan needs explicit method and prototype/production stage')
        for field in ('procedure','access','equipment','failure_conditions'):
            source(root,row.get(field))
        if not isinstance(row.get('signals'),list) or not row['signals'] or any(not isinstance(s,dict) or not s.get('net') for s in row['signals']):
            raise ValueError('test plan requires explicit signals and planned/native access')
        if row.get('check') is not None and row['check'] not in checks:
            raise ValueError('test plan names an unknown verifier')
    unknowns = _ids(value.get('unknowns',[]),'unknowns')
    for row in unknowns.values():
        if not row.get('question') or not row.get('owner') or row.get('blocking_stage') not in STAGES:
            raise ValueError('unknown needs question, owner and explicit blocking stage')
        source(root,row.get('source'))
        if row.get('resolution_check') is not None and row['resolution_check'] not in checks:
            raise ValueError('unknown resolution names an unknown verifier')
    failures = _ids(value.get('failure_conditions',[]),'failure conditions')
    for row in failures.values():
        _refs(row,requirements);source(root,row.get('source'))
        if not row.get('condition') or row.get('test_plan') not in plans:
            raise ValueError('failure condition needs explicit condition and named test plan')
    architecture = value.get('architecture')
    if architecture is not None:
        source(root,architecture.get('source'))
        for name in ('interfaces','decisions'):
            rows = _ids(architecture.get(name,[]),'architecture '+name)
            for row in rows.values():
                _refs(row,requirements);source(root,row.get('source'))
    production = value.get('production',{})
    if not isinstance(production,dict) or set(production)-{'assembly','test_coverage','substitutions','lot_yield'}:
        raise ValueError('unknown production control')
    for name,row in production.items():
        if not isinstance(row,dict) or type(row.get('required')) is not bool:
            raise ValueError('production control requires explicit required boolean')
        source(root,row.get('source'))
        if row['required'] and row.get('check') not in checks:
            raise ValueError('required production control needs actual verifier: '+name)
    return value


def load_contract(root, path):
    try:
        return _load_contract(root,path)
    except (KeyError,TypeError,AttributeError) as error:
        raise ValueError('malformed design contract field: '+str(error)) from None


def requirement(root, path, identifier):
    value = load_contract(root,path)
    rows = {r['id']:r for r in value['requirements']}
    if identifier not in rows:
        raise ValueError('unknown design requirement: '+str(identifier))
    return copy.deepcopy(rows[identifier])


def dependency_files(root, path, through=None):
    """Source/plan/check closure for isolated admission; never runs a verifier."""
    root,path = Path(root).resolve(),Path(path).resolve()
    value = load_contract(root,path)
    stage = through or value['current_stage']
    if stage not in STAGES:
        raise ValueError('unknown design stage')
    files = {path}
    def walk(item):
        if isinstance(item,dict):
            if isinstance(item.get('path'),str) and 'sha256' in item:
                if item.get('exists') is False and item['sha256'] is None:
                    return
                target=relative_file(root,item['path'])
                if sha(target)!=item['sha256']:raise ValueError('stale dependency: '+item['path'])
                files.add(target)
            for child in item.values():walk(child)
        elif isinstance(item,list):
            for child in item:walk(child)
    walk(value)
    for row in value.get('checks',[]):
        if STAGES.index(row['stage'])>STAGES.index(stage):continue
        target = (root/row['path']).resolve()
        for name in ('escape_evidence','plan','binding','proof','bench'):
            if row.get(name):
                extra=(root/row[name]).resolve()
                if extra.is_file():files.add(extra)
                if name=='escape_evidence' and extra.is_file():
                    for original in read(extra).get('inputs',{}):
                        original=(root/original).resolve()
                        if original.is_relative_to(root) and original.is_file():files.add(original)
        if not target.is_file():continue
        files.add(target)
        if row['kind'] in ('part_selection','part_use','placement'):
            files.update(root/name for name in part_evidence.dependency_files(root,target,include_native=row['kind']!='part_selection'))
        elif row['kind']=='schematic':
            # Source clauses of the actual schematic manifest, including its
            # exact design descriptor, travel with the candidate.
            walk(read(target))
        elif row['kind']=='native_gate':
            folder = target.parent
            from pcb_evidence import evidence_files
            files.update(folder/name for name in evidence_files(folder))
        elif row['kind']=='bench':
            plan=relative_file(root,row['plan']);files.add(plan);walk(read(plan))
            measured=read(target)
            for descriptor in [measured.get('raw_data')]+[i.get('calibration_evidence') for i in measured.get('instruments',[])]:
                if not isinstance(descriptor,dict):raise ValueError('bench artifact descriptor missing')
                artifact=(target.parent/descriptor['path']).resolve()
                if not artifact.is_relative_to(root) or sha(artifact)!=descriptor.get('sha256'):raise ValueError('stale bench artifact')
                files.add(artifact)
        elif row['kind']!='release':
            walk(read(target))
    result=[]
    for file in files:
        if not file.is_relative_to(root):
            raise ValueError('design dependency escapes project root: '+str(file))
        result.append(file.relative_to(root).as_posix())
    return sorted(result)


def _merge(report, root, result):
    for name in result.get('absent_inputs',[]):
        path=str((Path(root)/name).resolve())
        if Path(path).exists():raise ValueError('stale absent verifier input appeared: '+path)
        report['absent_inputs'].append(path)
    for field in ('inputs','native_inputs','tool_inputs','reader_inputs','source_inputs','evidence_inputs'):
        for name,digest in result.get(field,{}).items():
            if digest is None:
                report['absent_inputs'].append(str((Path(root)/name).resolve()))
                continue
            if not isinstance(digest,str) or not re.fullmatch('[a-f0-9]{64}',digest):
                raise ValueError('verifier returned malformed input hash')
            path = (Path(root)/name).resolve()
            old = report['inputs'].setdefault(str(path),digest)
            if old!=digest or not path.is_file() or sha(path)!=digest:
                raise ValueError('stale verifier input: '+str(path))


def design_binding(root, contract):
    """Stable facts+native identity; checker/result paths cannot form hash cycles."""
    board = contract['identity']['board']
    if not board:raise ValueError('physical test evidence requires a native board identity')
    from route_decision import native_inputs
    return fingerprint(dict(identity=contract['identity'],requirements=contract['requirements'],
                            test_plans=contract['test_plans'],native_inputs=native_inputs(root,board)[2]))


def _capture_tools(report):
    for module in tuple(sys.modules.values()):
        name=getattr(module,'__file__',None)
        if name and Path(name).is_file() and Path(name).resolve().is_relative_to(ROOT/'tools'):
            path=str(Path(name).resolve());digest=sha(name)
            previous=report.setdefault('tool_inputs',{}).setdefault(path,digest)
            if previous!=digest:raise ValueError('stale verifier implementation changed: '+path)


def _invoke(report, function, *args, **kwargs):
    _capture_tools(report)
    return function(*args,**kwargs)


def _gate_closure(root, board, report):
    """Ask the existing gate collector for actual library/source dependencies."""
    command=['node',str(Path(root)/'tools/pcb_snapshot_inputs.mjs'),str(root),board]
    run=lean.run_stage(command,stage='design-gate-inputs',deadline=lean.deadline_after(20),
        text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=dict(os.environ,IOT_LAB=str(root)))
    if run.returncode:raise ValueError('gate source closure unavailable: '+run.stderr)
    for name in json.loads(run.stdout):
        path=Path(name).resolve()
        if path.is_file():report['inputs'][str(path)]=sha(path)
        else:report['absent_inputs'].append(str(path))


def _adapter(root, contract, row, report, *, candidate=None, escape_evidence=None):
    board = contract['identity']['board']
    kind = row['kind']
    if not board and kind!='part_selection':raise ValueError('this verifier requires configured native CAD')
    path = relative_file(root,row['path']);report['inputs'][str(path)] = sha(path)
    requirements={r['id']:r for r in contract['requirements']}
    for identifier in row['requirements']:
        req=requirements[identifier]
        if req['verification_stage']==row['stage'] and row['stage'] in ('prototype','production'):
            if kind!='bench' or req['acceptance']['kind']!='interval':
                raise ValueError('unsupported physical acceptance: CAD/review status cannot establish measured requirement '+identifier)
    if kind not in ('schematic','placement','bench') and any(requirements[i]['acceptance']['kind']=='interval'
            and requirements[i]['verification_stage']==row['stage'] for i in row['requirements']):
        raise ValueError('this verifier cannot establish numeric functional acceptance; use sourced schematic/placement/raw bench evidence')
    if kind=='part_selection':
        planned_board = board or contract['identity']['design_id']
        if read(path).get('revision')!=contract['identity']['revision']:
            raise ValueError('part selection must bind this exact design revision')
        result = _invoke(report,part_evidence.verify_selection,root,planned_board,path)
        refs = set(row.get('references',[]))
        if not refs or refs-set(result.get('selections',{})):raise ValueError('part selection needs exact reviewed planned references')
    elif kind=='part_use':
        result = _invoke(report,part_evidence.verify_manifest,root,board,path)
        refs = set(row.get('references',[]))
        if not refs or refs-set(result.get('bindings',{})):raise ValueError('part check needs exact reviewed native references')
    elif kind=='schematic':
        from schematic_contract import check_contract
        result = _invoke(report,check_contract,root,board,path)
        descriptor=read(path).get('design_contract',{})
        expected=(Path(root)/descriptor.get('path','')).resolve()
        if expected!=Path(report['contract']) or descriptor.get('sha256')!=report['contract_sha256']:
            raise ValueError('schematic checker does not bind this exact design contract')
        report['schematic_contracts'].append(row['path'])
        for identifier in row['requirements']:
            if result.get('requirement_results',{}).get(identifier,{}).get('status')!='passed':
                raise ValueError('schematic evidence lacks passing requirement coverage: '+identifier)
    elif kind=='placement':
        from engineering_constraints import check_manifest
        escape=Path(escape_evidence).resolve() if escape_evidence is not None else (root/row['escape_evidence'] if row.get('escape_evidence') else None)
        result = _invoke(report,check_manifest,root,board,path,candidate=candidate,
            escape_evidence=escape)
        if result.get('status')!='passed':
            _merge(report,root,result)
            raise ValueError('actual placement verifier blocked: '+json.dumps(result.get('blockers',[])))
        if escape is not None:
            report['inputs'][str(escape)]=sha(escape)
            screen=read(escape)
            # source_set uses basenames beside the actual screened PCB;
            # they are not paths relative to the canonical project root.
            native_parent=Path(result['native']).parent
            screen.setdefault('inputs',{}).update({str(native_parent/name):digest
                for name,digest in screen.pop('source_inputs',{}).items()})
            _merge(report,root,screen)
        ids = {m['id'] for m in result.get('measurements',[])}
        requested = row.get('constraint_ids',[])
        if not requested or set(requested)-ids:raise ValueError('placement check lacks exact measured rule IDs')
        measurements={m['id']:m for m in result.get('measurements',[])}
        for identifier in row['requirements']:
            selected=row.get('selectors',{}).get(identifier)
            if selected not in requested:raise ValueError('placement requirement lacks exact constraint selector: '+identifier)
            acceptance=requirements[identifier]['acceptance'];measured=measurements[selected]
            if acceptance['kind']=='interval' and requirements[identifier]['verification_stage']==row['stage'] and (acceptance['unit']!='mm' or type(measured.get('measured_mm')) not in (int,float)
                    or not acceptance['min']<=measured['measured_mm']<=acceptance['max']):
                raise ValueError('actual native placement measurement misses requirement interval: '+identifier)
    elif kind=='native_gate':
        from pcb_evidence import verify
        from pcb_next import required_gate_evidence,verify_current_inputs
        run = path.parent;manifest=read(path);result=verify(run)
        operation=manifest.get('operation','check')
        actual_root = run/'workspace' if operation in ('build','edit','route','repair') else Path(manifest['root'])
        if manifest['board']!=board or actual_root.resolve()!=Path(root).resolve():
            raise ValueError('native run belongs to another board/workspace')
        raw = required_gate_evidence(run,run/'gate',result)
        verify_current_inputs(root,board,run/'gate')
        _gate_closure(root,board,report)
        from pcb_workflow import board_config
        _,cfg,_=board_config(root,board)
        required = {'erc'} if row['stage']=='schematic' else {k for k,v in cfg['checks'].items() if v is not False and v is not None}
        if any(raw.get('checks',{}).get(name,{}).get('status')!='passed' for name in required):
            raise ValueError('native stage evidence is missing or failed: '+','.join(sorted(required)))
        for name in result['evidence_sha256']:report['inputs'][str(run/name)]=sha(run/name)
        result=dict(status='passed',inputs={str(Path(root)/i['path']):i['sha256'] for i in raw['provenance']['inputs'] if not i['path'].startswith('external/')})
    elif kind=='release':
        # Existing readiness does actual fab/native/selection/stock/orientation
        # verification; a saved self-declared readiness result is insufficient.
        from pcb_next import verify_current_inputs
        verify_current_inputs(root,board,path.parent/'gate')
        _gate_closure(root,board,report)
        command=['node',str(Path(root)/'tools/check-release-readiness.mjs'),board,str(path.parent)]
        for name in ('stock','orientation','boards','as-of'):
            if name in row:command += ['--'+name,str((root/row[name]).resolve()) if name in ('stock','orientation') else str(row[name])]
        run=lean.run_stage(command,stage='design-release-readiness',deadline=lean.deadline_after(90),
            text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=dict(os.environ,IOT_LAB=str(root)))
        result=json.loads(run.stdout)
        if run.returncode or result.get('status')!='ready_for_user_review':
            raise ValueError('existing release-readiness checks blocked: '+json.dumps(result.get('findings',result)))
        report.setdefault('temporal_context',[]).append(dict(check=row['id'],order_day_utc=result['order_day_utc'],
            requires_current_day='as-of' not in row,scope='order_preparation_observation'))
        # Retain all original candidate and order-review sources, not only its
        # top-level passed result.
        for target in [path.parent]+[(root/row[k]).resolve() for k in ('stock','orientation') if k in row]:
            for file in ([target] if target.is_file() else target.rglob('*')):
                if file.is_file():report['inputs'][str(file.resolve())]=sha(file)
        result['status']='passed'
    elif kind=='block_qualification':
        from block_qualification import qualify
        required=('library','block_id','binding','proof','bench')
        if any(not row.get(k) for k in required):raise ValueError('block qualification needs original binding/proof/raw bench inputs, not a declared receipt status')
        result=_invoke(report,qualify,root/row['library'],row['block_id'],relative_file(root,row['binding']),relative_file(root,row['proof']),root,
                       bench=relative_file(root,row['bench']))
        if result.get('level')!=2:raise ValueError('actual original block bench verification incomplete')
        result['status']='passed'
    else:
        from block_qualification import Evidence,verify_bench
        measured=read(path);plan_path=relative_file(root,row['plan']);plan=read(plan_path)
        binding=design_binding(root,contract)
        if plan.get('binding_sha256')!=binding:raise ValueError('bench plan does not bind exact design/native facts')
        tests={t['id']:t for t in plan.get('tests',[])}
        for identifier in row['requirements']:
            requirement_row=next(r for r in contract['requirements'] if r['id']==identifier)
            acceptance=requirement_row['acceptance']
            selected=[t for t in tests.values() if t.get('requirement')==identifier]
            if acceptance['kind']!='interval' or not selected or any(
                    any(t.get(k)!=acceptance[k] for k in ('min','max','unit'))
                    or any(t.get('source',{}).get(k)!=acceptance['source'][k] for k in ('path','sha256')) for t in selected):
                raise ValueError('raw bench tests must match exact sourced requirement interval: '+identifier)
        evidence=Evidence()
        proof={'bench_plan':{'path':str(plan_path),'sha256':sha(plan_path)}}
        tested=_invoke(report,verify_bench,path,proof,binding,evidence,root)
        result=dict(status='passed',evidence_inputs=evidence.files,bench=tested)
    _merge(report,root,result)
    if result.get('status')!='passed':
        raise ValueError('actual '+kind+' verifier blocked: '+json.dumps(result.get('blockers',[])))
    checked = dict(status='passed',kind=kind,path=row['path'],requirements=row['requirements'],
                   scope=('current_raw_measurements' if kind in ('bench','block_qualification') else 'current_'+kind+'_evidence'))
    if kind=='part_selection':
        checked.update(native_verified=False,cad_verified=False,stock_current=False)
    return checked


def production_controls(contract):
    """Manufacturing facts require applicable verifiers, not CAD/voltage reuse."""
    blockers=[]
    for name in ('assembly','test_coverage','substitutions','lot_yield'):
        row=contract.get('production',{}).get(name)
        if row is None:
            blockers.append(dict(code='production_scope',detail='Explicit sourced required/not-required control needed: '+name,stage='production',control=name))
        elif row['required']:
            blockers.append(dict(code='unsupported_production_control',detail='No supported original manufactured-population/control verifier for '+name+
                '; CAD/fab readiness, selected native parts or unrelated raw bench values cannot establish this control',stage='production',control=name,check=row.get('check')))
    return blockers


def _dft_access(root, contract, report):
    blockers=[];plans=contract['test_plans'];board=contract['identity']['board']
    needed={r['id'] for r in contract['requirements'] if r['verification_stage'] in ('prototype','production')}
    covered={r for plan in plans for r in plan['requirements']}
    if not plans or needed-covered:
        blockers.append(dict(code='dft_coverage',detail='DFT plans must cover future physical acceptance before layout',stage='placement',requirements=sorted(needed-covered)))
    if not board:
        return blockers+[dict(code='native_design_missing',detail='Native CAD and physical test access required before placement',stage='placement')]
    native=part_native.read_board(root,board);_merge(report,root,native)
    for plan in plans:
        for signal in plan['signals']:
            if native['parts'].get(signal.get('ref'),{}).get('pad_net_map',{}).get(str(signal.get('pad')))!=signal['net']:
                blockers.append(dict(code='dft_native_access',detail='DFT signal requires exact actual native pad/net endpoint',stage='placement',test_plan=plan['id'],signal=signal))
    return blockers


def evaluate_candidate_layout(root, path, candidate=None, evidence_directory=None, *, escape_screens=None):
    """Replay canonical reviewed layout/DFT against optional candidate geometry.

    Canonical root/path retain original fixed/rigid poses. An edited workspace
    cannot become its own original baseline. No old stage run is reevaluated.
    """
    root,path=Path(root).resolve(),Path(path).resolve()
    report=dict(schema='iot-lab.design-candidate-layout.v1',scope='candidate_declared_layout_and_dft_only',status='blocked',
        design_id=None,board=None,qualified=False,production_approved=False,release_approved=False,
        inputs={},tool_inputs={},absent_inputs=[],blockers=[],check_results={},schematic_contracts=[],generated_evidence=[],reused_evidence=[])
    try:
        initial=sha(path);report.update(contract=str(path),contract_sha256=initial)
        report['inputs'][str(path)]=initial
        if candidate is not None:
            candidate=Path(candidate).resolve();report['inputs'][str(candidate)]=sha(candidate)
        value=load_contract(root,path);report.update(identity=value['identity'],design_id=value['identity']['design_id'],board=value['identity']['board'])
        _capture_tools(report)
        for name in dependency_files(root,path,'architecture'):report['inputs'][str(root/name)]=sha(root/name)
        report['inputs'][str(path)]=initial
        checks=[row for row in value['checks'] if row['kind']=='placement']
        if not checks:report['blockers'].append(dict(code='candidate_layout_contract_missing',detail='No declared placement verifier for the candidate',stage='placement'))
        report['blockers'].extend(_dft_access(root,value,report))
        if not report['blockers']:
            owned=None
            for row in checks:
                escape=None
                if candidate is not None:
                    from engineering_constraints import reviewed_contract
                    policy=_invoke(report,reviewed_contract,root,value['identity']['board'],relative_file(root,row['path']))
                    _merge(report,root,policy)
                    if any(rule['kind']=='escape' for rule in policy['rules']):
                        if evidence_directory is None:
                            raise ValueError('candidate escape checks require an explicit new owned evidence_directory')
                        if owned is None:
                            owned=Path(evidence_directory).resolve()
                            if owned==root or any(owned.is_relative_to(root/name) for name in ('hardware-design','tools','registry')):
                                raise ValueError('candidate escape evidence must be outside canonical CAD/tools/registry')
                            owned.mkdir(parents=True,exist_ok=False)
                        escape=owned/(row['id']+'-escape.json')
                        from route_decision import generate_escape_evidence
                        if escape_screens is None:
                            _invoke(report,generate_escape_evidence,policy,candidate,escape)
                            report['generated_evidence'].append(str(escape))
                        else:
                            requested=escape
                            escape=_invoke(report,escape_screens.get,policy,candidate,requested)
                            report['generated_evidence' if escape==requested else 'reused_evidence'].append(str(escape))
                report['check_results'][row['id']]=_adapter(root,value,row,report,candidate=candidate,escape_evidence=escape)
        if any(sha(name)!=digest for name,digest in report['inputs'].items()):raise ValueError('stale candidate design source changed during layout evaluation')
        _capture_tools(report)
        report['status']='blocked' if report['blockers'] else 'passed'
    except (OSError,ValueError,KeyError,TypeError,RuntimeError,ImportError,subprocess.SubprocessError) as error:
        report['blockers'].append(dict(code='candidate_layout_evidence',detail=str(error),stage='placement'))
        report['status']='stale' if 'stale' in str(error) or 'changed' in str(error) else 'blocked'
    return report


def evaluate_contract(root, path, through=None):
    root,path=Path(root).resolve(),Path(path).resolve()
    report=dict(schema=REPORT,scope='declared_design_stage_evidence',status='blocked',design_id=None,board=None,
        qualified=False,release_approved=False,production_approved=False,functional_qualification=False,
        blockers=[],inputs={},tool_inputs={str(Path(__file__).resolve()):sha(__file__)},absent_inputs=[],
        stages={},check_results={},requirement_results={},schematic_contracts=[],temporal_context=[],through=through,
        limits=['Only declared requirements/evidence are evaluated. Plan completeness and recorded review are not functional or bench correctness. No production or procurement approval.'])
    def block(code,detail,stage,**extra):
        report['blockers'].append(dict(code=code,detail=detail,stage=stage,**extra))
    try:
        initial_hash=sha(path)
        report.update(root=str(root),contract=str(path),contract_sha256=initial_hash)
        report['inputs'][str(path)]=initial_hash
        raw=read(path)
        report['through']=through or raw.get('current_stage')
        declared=raw.get('identity',{})
        if isinstance(declared,dict):report.update(identity=declared,design_id=declared.get('design_id'),board=declared.get('board'))
        value=load_contract(root,path);report['identity']=value['identity']
        _capture_tools(report)
        report.update(design_id=value['identity']['design_id'],board=value['identity']['board'],contract=str(path),contract_sha256=initial_hash)
        stage=through or value['current_stage']
        if stage not in STAGES:raise ValueError('unknown assessment stage')
        report['through']=stage
        for name in dependency_files(root,path,stage):report['inputs'][str(root/name)]=sha(root/name)
        report['inputs'][str(path)]=initial_hash
        cutoff=STAGES.index(stage)
        checks={r['id']:r for r in value['checks']};requirements={r['id']:r for r in value['requirements']}
        for check in checks.values():
            if STAGES.index(check['stage'])<=cutoff:
                for key in ('path','escape_evidence','plan','binding','proof','bench'):
                    if check.get(key):
                        target=(root/check[key]).resolve()
                        if not target.is_file():report['absent_inputs'].append(str(target))
        for index,name in enumerate(STAGES):
            if index>cutoff:
                report['stages'][name]=dict(status='blocked',required_now=False,readiness='future_evidence_not_requested');continue
            if any(row.get('required_now') and row['status']!='passed' for row in report['stages'].values()):
                report['stages'][name]=dict(status='blocked',required_now=True,readiness='upstream_stage_blocked');continue
            start=len(report['blockers'])
            if name=='production':report['blockers'].extend(production_controls(value))
            for unknown in value['unknowns']:
                if unknown['blocking_stage']==name and not unknown.get('resolution_check'):
                    block('unresolved_unknown',unknown['question'],name,unknown=unknown['id'],owner=unknown['owner'])
            if name=='architecture':
                architecture=value.get('architecture')
                if not architecture or not architecture.get('interfaces') or not architecture.get('decisions') or not value['failure_conditions']:
                    block('architecture_plan','Explicit interfaces, decisions and failure-condition test links required',name)
            if name=='placement':
                report['blockers'].extend(_dft_access(root,value,report))
            required_kind={'parts':'part_use','schematic':'schematic','placement':'placement','routing':'native_gate','prototype':'bench'}
            if name in required_kind:
                kinds={r['kind'] for r in checks.values() if r['stage']==name}
                allowed={required_kind[name]}|({'part_selection'} if name=='parts' else {'block_qualification'} if name=='prototype' else set())
                if not kinds&allowed:
                    expected='part_selection or part_use' if name=='parts' else required_kind[name]
                    block('stage_evidence_missing','Stage requires actual '+expected+' evidence',name)
                if name=='schematic' and 'native_gate' not in kinds:
                    block('stage_evidence_missing','Schematic stage also requires actual successful native ERC evidence',name)
            for check in checks.values():
                if check['stage']!=name:continue
                if len(report['blockers'])>start:
                    report['check_results'][check['id']]=dict(status='blocked',kind=check['kind'],path=check['path'],scope='stage_plan_blocked_before_verifier');continue
                try:report['check_results'][check['id']]=_adapter(root,value,check,report)
                except (OSError,ValueError,KeyError,TypeError,RuntimeError,ImportError,subprocess.SubprocessError) as error:
                    report['check_results'][check['id']]=dict(status='stale' if 'stale' in str(error) or 'changed' in str(error) else 'blocked',kind=check['kind'],path=check['path'])
                    block('check_evidence',str(error),name,check=check['id'])
            for req in requirements.values():
                if req['verification_stage']!=name:continue
                relevant=[r for r in checks.values() if req['id'] in r['requirements'] and r['stage']==name]
                passed=[r['id'] for r in relevant if report['check_results'].get(r['id'],{}).get('status')=='passed']
                planning=name in ('requirements','architecture') and req['acceptance']['kind']=='review'
                report['requirement_results'][req['id']]=dict(status='passed' if passed or planning else 'blocked',checks=passed,
                    scope='documented_acceptance_plan_only' if planning and not passed else 'actual_verifier_coverage')
                if not passed and not planning:block('requirement_unverified','No actual verifier covers required acceptance',name,requirement=req['id'])
            for unknown in value['unknowns']:
                if unknown['blocking_stage']==name and unknown.get('resolution_check') and report['check_results'].get(unknown['resolution_check'],{}).get('status')!='passed':
                    block('unresolved_unknown',unknown['question'],name,unknown=unknown['id'],owner=unknown['owner'])
            rows=report['blockers'][start:]
            report['stages'][name]=dict(status='stale' if any('stale' in r['detail'] or 'changed' in r['detail'] for r in rows) else 'blocked' if rows else 'passed',
                required_now=True,readiness='acceptance_plan_recorded' if index<2 else 'declared_stage_evidence_evaluated')
        for name,digest in report['inputs'].items():
            if not Path(name).is_file() or sha(name)!=digest:raise ValueError('stale input changed during assessment: '+name)
        _capture_tools(report)
        if any(Path(name).exists() or Path(name).is_symlink() for name in report['absent_inputs']):raise ValueError('stale absent input appeared during assessment')
        for req in requirements.values():
            if req['id'] not in report['requirement_results']:
                required_now=STAGES.index(req['verification_stage'])<=cutoff
                report['requirement_results'][req['id']]=dict(status='blocked',required_now=required_now,
                    scope='upstream_stage_not_evaluated' if required_now else 'future_verification_not_requested',verification_stage=req['verification_stage'])
        report['status']='stale' if any(r['status']=='stale' for r in report['stages'].values() if r['required_now']) else 'blocked' if report['blockers'] else 'passed'
    except (OSError,ValueError,KeyError,TypeError,RuntimeError,ImportError,subprocess.SubprocessError) as error:
        block('contract_input',str(error),through or 'requirements')
        report['status']='stale' if 'stale' in str(error) or 'changed' in str(error) else 'blocked'
    if report.get('through') in STAGES:
        index=STAGES.index(report['through']);report['next_stage']=STAGES[index+1] if index+1<len(STAGES) else None
    first=next(iter(report['blockers']),None)
    report['next_action']=dict(kind='resolve_declared_blocker' if first else 'review_next_stage_plan',
        cause=first['detail'] if first else 'Current declared stage evidence assessed; later physical evidence remains separate',
        stage=first['stage'] if first else report.get('next_stage'),requirement_id=first.get('requirement') if first else None,
        check=first.get('check') if first else None)
    return report


def current_assessment(report):
    """Cheap freshness observation for next/cycle; never rerun a verifier."""
    import datetime as dt
    try:
        if report.get('schema')!=REPORT or not report.get('inputs'):
            return False
        for field in ('inputs','tool_inputs'):
            for name,digest in report.get(field,{}).items():
                path=Path(name)
                if not path.is_absolute() or not path.is_file() or sha(path)!=digest:return False
        if any(Path(name).exists() or Path(name).is_symlink() for name in report.get('absent_inputs',[])):
            return False
        today=dt.datetime.now(dt.timezone.utc).date().isoformat()
        if any(row.get('requires_current_day') and row.get('order_day_utc')!=today for row in report.get('temporal_context',[])):
            return False
        return True
    except (OSError,TypeError,ValueError,AttributeError):
        return False


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('command',choices=['check'])
    parser.add_argument('design_id');parser.add_argument('--contract',required=True,type=Path)
    parser.add_argument('--root',type=Path,default=project_root.root())
    parser.add_argument('--through',choices=STAGES);parser.add_argument('--json',action='store_true');parser.add_argument('--output',type=Path)
    args=parser.parse_args(argv);result=evaluate_contract(args.root,args.contract,args.through)
    if result.get('design_id')!=args.design_id:
        result['status']='blocked';result['blockers'].append(dict(code='design_identity',detail='CLI target differs from contract design_id',stage=args.through or 'requirements'))
    if args.output:part_evidence.atomic_json(args.output,result)
    if args.json:
        summary=result
        if args.output:
            summary=dict(schema=result['schema'],status=result['status'],design_id=result.get('design_id'),
                through=result.get('through'),qualified=False,blockers=len(result['blockers']),
                next_action=result.get('next_action'),report=dict(path=str(args.output.resolve()),sha256=sha(args.output)))
        print(json.dumps(summary))
    else:
        print(('PASS' if result['status']=='passed' else 'STUCK')+': design '+args.design_id+'; '+str(len(result['blockers']))+' blockers')
    return 0 if result['status']=='passed' else 1


if __name__=='__main__':raise SystemExit(main())
