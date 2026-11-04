#!/usr/bin/env python3
"""Verify declared schematic functions against reviewed facts and native CAD.

This does not run ERC/DRC, simulate a circuit, select parts or prove firmware
operating state. Unstated requirements and unsupported quantities remain unknown.
"""
import argparse
import copy
import datetime as dt
from decimal import Decimal, InvalidOperation
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET

import lean_workflow as lean
import net_drivers
import part_evidence
import part_native
from placer.dru import _tree, _tokens

SCHEMA = 'iot-lab.schematic-contract.v1'
RESULT = 'iot-lab.schematic-contract-result.v1'
ROOT = Path(__file__).resolve().parent.parent
import project_root  # noqa: E402  (project root: --root/IOT_LAB/cwd; tools/project_root.py)
PREFIX = {'': Decimal(1), 'p': Decimal('1e-12'), 'n': Decimal('1e-9'), 'u': Decimal('1e-6'),
          'm': Decimal('1e-3'), 'k': Decimal('1e3'), 'M': Decimal('1e6'), 'G': Decimal('1e9')}
BASES = ('Ohm', 'F', 'H', 'V', 'A', 'W', 'Hz', 's', 'degC')


def sha(path):
    return part_evidence.sha(path)


def read(path):
    result = json.loads(Path(path).read_text())
    if not isinstance(result, dict):
        raise ValueError('expected JSON object: ' + str(path))
    return result


def keys(value, allowed, required=()):
    if not isinstance(value, dict) or set(value)-set(allowed) or set(required)-set(value):
        raise ValueError('unsupported or missing fields; expected ' + ', '.join(required))


def number(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise ValueError('finite numeric value required; booleans are not quantities')
    try:
        result = Decimal(str(value))
    except InvalidOperation:
        raise ValueError('invalid exact numeric value') from None
    if not result.is_finite():
        raise ValueError('nonfinite quantity')
    return result


def unit(value):
    if not isinstance(value, str):
        raise ValueError('explicit supported physical unit required')
    value = value.replace('µ', 'u').replace('μ', 'u').replace('Ω', 'Ohm')
    for base in BASES:
        if value == base:
            return base, Decimal(1)
        if value.endswith(base) and value[:-len(base)] in PREFIX and base != 'degC':
            return base, PREFIX[value[:-len(base)]]
    raise ValueError('unsupported physical unit: ' + value)


def canonical_value(value, expected_unit):
    """Parse nominal CAD values; tolerances always come from a sourced interval."""
    base, _ = unit(expected_unit)
    if not isinstance(value, str) or not value.strip():
        raise ValueError('native component value is absent')
    text = value.strip().replace(' ', '').replace('µ', 'u').replace('μ', 'u').replace('Ω', 'Ohm')
    # IEC resistor shorthand is unambiguous only for a resistance assertion.
    if base == 'Ohm':
        match = re.fullmatch(r'([0-9]+)([RrKkMm])([0-9]*)', text)
        if match:
            marker = {'R': '', 'r': '', 'K': 'k', 'k': 'k', 'M': 'M', 'm': 'm'}[match[2]]
            return number(match[1] + ('.' + match[3] if match[3] else '')) * PREFIX[marker], base
    match = re.fullmatch(r'([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)(.*)', text)
    if not match:
        raise ValueError('unsupported native value notation: ' + value)
    amount, suffix = number(match[1]), match[2]
    if suffix in PREFIX:
        # A suffix-only prefix or bare number uses the dimension explicitly
        # declared by the reviewed assertion, never an inferred reference type.
        return amount * PREFIX[suffix], base
    actual_base, scale = unit(suffix)
    if actual_base != base:
        raise ValueError('native value has a different physical dimension')
    return amount * scale, base


def parse_export(raw):
    parsed = net_drivers.parse_netlist(raw)
    document = ET.fromstring(raw)
    refs = [node.get('ref') for node in document.iter('comp')]
    if not all(refs) or len(refs) != len(set(refs)):
        raise ValueError('native export has duplicate/missing component references')
    net_names = [node.get('name') for node in document.iter('net')]
    if not all(net_names) or len(net_names) != len(set(net_names)):
        raise ValueError('native export has duplicate/missing net names')
    fields = {}
    for node in document.iter('comp'):
        rows = list(node.iter('field')); names = [row.get('name') for row in rows]
        if not all(names) or len(names) != len(set(names)):
            raise ValueError('native export has duplicate/missing component fields')
        fields[node.get('ref')] = {row.get('name'): (row.text or '').strip() for row in rows}
    pins = {}
    for net, rows in parsed['nets'].items():
        if not isinstance(net, str) or not net:
            raise ValueError('native export has an unnamed net')
        for ref, pin, name in rows:
            selector = (ref, pin)
            if not ref or not pin or selector in pins:
                raise ValueError('native export pin appears more than once')
            pins[selector] = dict(net=net, name=name)
    parsed.update(fields=fields, pins=pins)
    return parsed


def export_native(schematic, artifacts):
    launcher = shutil.which(net_drivers.KICAD_CLI)
    if not launcher:
        raise RuntimeError('native KiCad netlist exporter is unavailable')
    launcher = Path(launcher).resolve()
    tools = {str(launcher): sha(launcher), str(Path(net_drivers.__file__).resolve()): sha(net_drivers.__file__)}
    output = artifacts / 'native-netlist.xml'
    with (artifacts / 'export.log').open('w') as log:
        result = lean.run_stage([str(launcher), 'sch', 'export', 'netlist', '--format', 'kicadxml', '-o', str(output), str(schematic)],
            stage='schematic-functional-netlist', event_file=artifacts/'events.jsonl', deadline=lean.deadline_after(30),
            stdout=log, stderr=subprocess.STDOUT)
    if result.returncode or not output.is_file():
        raise RuntimeError('native schematic export failed; evidence=' + str(artifacts/'export.log'))
    parsed = parse_export(output.read_text())
    if any(sha(name) != digest for name, digest in tools.items()):
        raise ValueError('native exporter changed during schematic inspection')
    return parsed, {str(output): sha(output)}, tools


def dependency_files(root, contract_path):
    root, path = Path(root).resolve(), Path(contract_path).resolve()
    value = read(path); found = {str(path.relative_to(root))}
    def walk(item):
        if isinstance(item, dict):
            if isinstance(item.get('path'), str) and item.get('sha256') is not None:
                found.add(str(part_native.owned(root, item['path']).relative_to(root)))
            for child in item.values(): walk(child)
        elif isinstance(item, list):
            for child in item: walk(child)
    walk(value)
    import design_contract
    found.update(design_contract.dependency_files(root, part_native.owned(root, value['design_contract']['path'])))
    found.update(part_evidence.dependency_files(root, part_native.owned(root, value['part_review']['path'])))
    return sorted(found)


def check_contract(root, board, contract_path, output=None):
    root, path = Path(root).resolve(), Path(contract_path).resolve()
    report = dict(schema=RESULT, scope='declared_schematic_functions', board=board, status='blocked', qualified=False,
        release_approved=False, stock_current=False, assertions=[], requirement_results={}, blockers=[],
        inputs={}, absent_inputs=[], native_inputs={}, tool_inputs={str(Path(__file__).resolve()): sha(__file__)},
        native_export_cache=dict(status='fresh_export_required',hit=False,reusable=False,
            reason='complete external library/project-variable closure is not certified for receipt reuse'),
        limits=['Declared assertions only; simulation, firmware behavior, ERC/DRC and bench qualification remain separate.'])
    pages = {}
    def source(descriptor):
        keys(descriptor, ('path','sha256','page','section'), ('path','sha256'))
        target = part_native.owned(root, descriptor['path'])
        if not re.fullmatch(r'[a-f0-9]{64}', descriptor['sha256']) or sha(target) != descriptor['sha256']:
            raise ValueError('stale source: ' + descriptor['path'])
        report['inputs'][str(target)] = descriptor['sha256']
        if target.suffix.lower() == '.pdf':
            if descriptor['sha256'] not in pages: pages[descriptor['sha256']] = part_evidence.pdf_pages(target)
            page = descriptor.get('page')
            if isinstance(page,bool) or not isinstance(page,int) or not 1 <= page <= pages[descriptor['sha256']]:
                raise ValueError('source requires an actual one-based PDF page')
        elif not isinstance(descriptor.get('section'),str) or not descriptor['section'].strip():
            raise ValueError('source requires a record/section locator')
        return target
    def bound_file(descriptor):
        keys(descriptor, ('path','sha256'), ('path','sha256'))
        target = part_native.owned(root, descriptor['path'])
        if not isinstance(descriptor['sha256'],str) or not re.fullmatch(r'[a-f0-9]{64}',descriptor['sha256']) or sha(target) != descriptor['sha256']:
            raise ValueError('stale reviewed contract: ' + descriptor['path'])
        report['inputs'][str(target)] = descriptor['sha256']
        return target
    def interval(value):
        keys(value, ('min','max','unit','source'), ('min','max','unit','source'))
        source(value['source']); base,scale = unit(value['unit'])
        if any(isinstance(value[key],(str,bool)) or not isinstance(value[key],(int,float)) for key in ('min','max')):
            raise ValueError('quantity intervals require finite JSON numbers')
        lo,hi = number(value['min'])*scale,number(value['max'])*scale
        if lo > hi: raise ValueError('quantity interval is reversed')
        return lo,hi,base
    def need(ok, detail):
        if not ok: raise ValueError(detail)
    try:
        path.relative_to(root)
        value = read(path); report['inputs'][str(path)] = sha(path)
        keys(value, ('schema','board','project','review','design_contract','part_review','population_source','assertions'),
                   ('schema','board','project','review','design_contract','part_review','population_source','assertions'))
        need(value['schema'] == SCHEMA and value['board'] == board, 'functional contract schema/board mismatch')
        review = value['review']
        keys(review, ('verdict','reviewer','reviewed_at_utc','facts_sha256','evidence'),
                    ('verdict','reviewer','reviewed_at_utc','facts_sha256','evidence'))
        need(review['verdict'] == 'passed' and isinstance(review['reviewer'],str) and review['reviewer'].strip(), 'functional review is pending')
        need(dt.datetime.fromisoformat(review['reviewed_at_utc'].replace('Z','+00:00')).utcoffset() is not None, 'review timestamp needs a timezone')
        need(review['facts_sha256'] == part_evidence.facts_digest(value), 'review does not bind these functional assertions')
        source(review['evidence'])
        design_path, part_path = bound_file(value['design_contract']), bound_file(value['part_review'])
        import design_contract
        design=design_contract.load_contract(root,design_path)
        need(design['identity']['board']==board,'design requirements do not name this actual native board')
        part_review = part_evidence.verify_manifest(root, board, part_path)
        report['native_inputs'] = part_review.get('native_inputs',{})
        report['inputs'].update({str(root/name):digest for name,digest in part_review['inputs'].items()})
        report['inputs'].update({str(root/name):digest for name,digest in part_review['native_inputs'].items()})
        report['tool_inputs'].update(part_review.get('tool_inputs',{}))
        need(part_review.get('status') == 'passed', 'native part evidence is incomplete: '+json.dumps(part_review.get('blockers',[])))
        native = part_review['bindings']
        reviewed_parts=read(part_path)
        def reviewed_demand(selector,ref,net):
            keys(selector,('budget','rating'))
            need(len(selector)==1 and all(isinstance(v,str) and v for v in selector.values()),'load requires one exact reviewed demand selector')
            if 'budget' in selector:
                budgets=[row for row in reviewed_parts.get('budgets',[]) if row['id']==selector['budget']]
                need(len(budgets)==1 and budgets[0]['net']==net,'reviewed budget ID/net does not match this actual load')
                loads=[row for row in budgets[0]['loads'] if row['reference']==ref]
                need(len(loads)==1,'reviewed budget does not contain this exact native load')
                return loads[0]['required'],dict(reference=ref,budget=selector['budget'],net=net,conditions=[])
            parts=[row for row in reviewed_parts['parts'] if row['reference']==ref]
            need(len(parts)==1,'reviewed rating requires this exact native part')
            part=parts[0]
            profile=read(bound_file(part['profile'])) if part.get('profile') else part
            ratings=[row for row in profile['ratings'] if row['id']==selector['rating']]
            need(len(ratings)==1,'reviewed part/profile rating ID is absent or ambiguous')
            rating=ratings[0]
            if part.get('profile'):
                demand=part['use']['required'][rating['id']]
                context=[dict(quantity=row['quantity'],required=part['use']['conditions'][rating['id']][row['quantity']]) for row in rating['conditions']]
            else:
                demand=rating['required'];context=[dict(quantity=row['quantity'],required=row['required']) for row in rating['conditions']]
            return demand,dict(reference=ref,rating=rating['id'],quantity=rating['quantity'],conditions=context)
        def scoped_demands(ref,net):
            return [(row['id'],interval(load['required'])) for row in reviewed_parts.get('budgets',[]) if row['net']==net
                    for load in row['loads'] if load['reference']==ref and number(load['required']['max'])>0]
        from pcb_workflow import board_config
        _,_,project = board_config(root,board)
        need(value['project'] == str(project.relative_to(root)), 'functional contract targets another native project')
        if project.with_suffix('.kicad_pro').is_file():
            report['inputs'][str(project.with_suffix('.kicad_pro'))]=sha(project.with_suffix('.kicad_pro'))
        population = copy.deepcopy(value['population_source'])
        keys(population, ('path','exists','sha256'), ('path','exists','sha256'))
        name=population['path']; need(name=='hardware-design/boards/'+board+'/variants.json', 'variant policy must name this exact board owner')
        population['path']=str(root/name)
        part_evidence.verify_population_source(dict(board=board,population_source=population))
        report['population_source']=population
        if population['exists']:
            variants=read(population['path']); names=variants['variants']; fits=variants['fit']
            need(isinstance(names,list) and names and len(set(names))==len(names) and all(isinstance(n,str) and n for n in names), 'invalid variant names')
            need(isinstance(fits,dict) and set(fits)==set(native), 'variant fit does not cover exact native parts')
            for ref,rows in fits.items():
                need(isinstance(rows,list) and len(set(rows))==len(rows) and all(n in names for n in rows), 'invalid fit list for '+ref)
            report['inputs'][population['path']]=population['sha256']
        else:
            names=['DEFAULT']; fits={ref:['DEFAULT'] if part['required'] else [] for ref,part in native.items()}
            report['absent_inputs'].append(population['path'])
        assertions=value['assertions']
        need(isinstance(assertions,list) and assertions, 'explicit functional assertions required')
        ids=[row.get('id') for row in assertions if isinstance(row,dict)]
        need(len(ids)==len(assertions) and all(isinstance(i,str) and i for i in ids) and len(ids)==len(set(ids)), 'assertion IDs must be unique nonempty strings')
        requirements={}
        design_requirements={row['id']:row for row in design['requirements']}
        for row in assertions:
            requirement=row.get('requirement')
            need(isinstance(requirement,str) and requirement, 'assertion requires an exact design requirement ID')
            need(requirement in design_requirements,'unknown design requirement: '+requirement)
            # load_contract already validated the complete requirement set.
            # Do not repeat every PDF/source validation once per assertion.
            requirements[requirement]=copy.deepcopy(design_requirements[requirement])
            need(requirements[requirement]['verification_stage']=='schematic', 'requirement belongs to another verification stage')
        for name in design_contract.dependency_files(root,design_path):
            target=part_native.owned(root,name);report['inputs'][str(target)]=sha(target)
        if getattr(design_contract,'__file__',None):
            report['tool_inputs'][str(Path(design_contract.__file__).resolve())]=sha(design_contract.__file__)
        if output is None:
            base=root/'.gate/schematic';base.mkdir(parents=True,exist_ok=True)
            artifacts=Path(tempfile.mkdtemp(prefix='check-',dir=base))
        else:
            artifacts=Path(output).resolve().with_suffix('');artifacts=artifacts.with_name(artifacts.name+'-native')
            artifacts.mkdir(parents=True,exist_ok=False)
        exported, evidence, tools=export_native(project.with_suffix('.kicad_sch'),artifacts)
        report['inputs'].update(evidence);report['tool_inputs'].update(tools);report['evidence_directory']=str(artifacts)
        pcb_forms=_tree(_tokens(project.with_suffix('.kicad_pcb').read_text()))
        pcb={part_native.properties(form)['Reference']:part_native.properties(form) for form in part_native.children(pcb_forms[0],'footprint')}
        for ref,part in native.items():
            need(ref in exported['comps'] and exported['comps'][ref]==part['mpn'], 'native export part identity differs: '+ref)
            for pin in part['pin_map']:
                net=part['pad_net_map'].get(pin)
                if net and not net.startswith('unconnected-'):
                    need(exported['pins'].get((ref,pin),{}).get('net')==net,'actual schematic/PCB connected pin differs: '+ref+'.'+pin)
        observed={}
        for row in sorted(assertions,key=lambda a:0 if a.get('kind')=='mode' else 2 if a.get('kind')=='budget' else 1):
            outcome=dict(id=row['id'],kind=row.get('kind'),requirement=row['requirement'],status='blocked')
            try:
                common=('id','kind','requirement','source');kind=row.get('kind');source(row.get('source'))
                if kind=='value':
                    keys(row,common+('reference','mpn','expected','conditions'),common+('reference','mpn','expected','conditions'))
                    ref=row['reference'];need(ref in native and native[ref]['mpn']==row['mpn'],'value assertion MPN differs from actual native part')
                    lo,hi,base=interval(row['expected'])
                    schem,dim=canonical_value(exported['values'][ref],base);board_value,_=canonical_value(pcb[ref].get('Value'),base)
                    need(schem==board_value,'schematic/PCB nominal value differs: '+ref)
                    need(lo<=schem<=hi,'native value outside sourced interval: '+ref)
                    outcome.update(actual=dict(value=str(schem),unit=dim),expected=dict(min=str(lo),max=str(hi),unit=base))
                elif kind=='pin_net':
                    keys(row,common+('reference','pin','net','pin_name'),common+('reference','pin','net'))
                    ref,pin=row['reference'],row['pin'];need(ref in native and isinstance(pin,str) and pin in native[ref]['pin_map'],'unknown native symbol pin')
                    actual=exported['pins'].get((ref,pin),{}).get('net');board_net=native[ref]['pad_net_map'].get(pin) or None
                    need(actual==board_net==row['net'],'schematic/PCB pin connectivity differs from required net')
                    if 'pin_name' in row:need(native[ref]['pin_map'][pin]['name']==row['pin_name'],'native pin function/name differs')
                    outcome.update(actual=dict(reference=ref,pin=pin,net=actual))
                elif kind=='population':
                    keys(row,common+('reference','dnp','in_bom','fits'),common+('reference','dnp','in_bom','fits'))
                    ref=row['reference'];need(ref in native and type(row['dnp']) is bool and type(row['in_bom']) is bool,'native population selector/boolean invalid')
                    need(isinstance(row['fits'],list) and len(set(row['fits']))==len(row['fits']) and all(n in names for n in row['fits']),'unknown/duplicate required variant')
                    actual=dict(dnp=native[ref]['dnp'],in_bom=native[ref]['in_bom'],fits=sorted(fits[ref]))
                    need(actual==dict(dnp=row['dnp'],in_bom=row['in_bom'],fits=sorted(row['fits'])),'native DNP/BOM/variant population differs')
                    outcome.update(actual=actual)
                elif kind=='mode':
                    keys(row,common+('reference','field','allowed','variant'),common+('reference','field','allowed','variant'))
                    ref=row['reference'];need(ref in native and row['variant'] in names and row['variant'] in fits[ref],'mode part is not fitted in its declared variant')
                    need(isinstance(row['field'],str) and row['field'] not in ('MPN','LCSC','Reference','Value','Footprint'),'mode requires an explicit operating-state field')
                    allowed=row['allowed'];need(isinstance(allowed,list) and allowed and all(isinstance(v,str) and v for v in allowed) and len(set(allowed))==len(allowed),'mode states require explicit unique strings')
                    actual=exported['fields'][ref].get(row['field']);need(actual in allowed,'declared native operating mode is absent or disallowed')
                    outcome.update(actual=actual,variant=row['variant'],mode_scope='schematic declaration; firmware/runtime state unproved')
                elif kind=='budget':
                    keys(row,common+('net','variant','limit','loads','exclusions','conditions'),common+('net','variant','limit','loads','exclusions','conditions'))
                    need(row['variant'] in names and isinstance(row['net'],str) and row['net'],'budget requires exact native net and variant')
                    lo,hi,base=interval(row['limit']);need(base in ('A','W') and lo>=0,'budget needs nonnegative current or power interval')
                    connected={ref for ref,part in native.items() if part['in_bom'] and row['variant'] in fits[ref] and row['net'] in part['pad_net_map'].values()}
                    loads=set();excluded=set();total_lo=Decimal(0);total_hi=Decimal(0);bindings=[]
                    for load in row['loads']:
                        keys(load,('reference','demand','conditions','reviewed_demand'),('reference','conditions','reviewed_demand'))
                        ref=load['reference'];need(ref in connected and ref not in loads,'budget load is absent, unfitted, unconnected or duplicated')
                        original,binding=reviewed_demand(load['reviewed_demand'],ref,row['net'])
                        required=interval(original)
                        low,high,dim=interval(load['demand']) if 'demand' in load else required
                        need(dim==base and low>=0,'budget load physical units/range differ')
                        need((low,high,dim)==required,'schematic load demand differs from exact reviewed part-use demand')
                        scoped=scoped_demands(ref,row['net'])
                        need(all(dim==units and low<=required_lo and required_hi<=high for _,(required_lo,required_hi,units) in scoped),
                             'load would understate another scoped reviewed net demand')
                        binding['scoped_budgets']=[identifier for identifier,_ in scoped]
                        bindings.append(binding)
                        conditions(load['conditions'],observed,row['variant']);loads.add(ref);total_lo+=low;total_hi+=high
                    for exclusion in row['exclusions']:
                        keys(exclusion,('reference','reason','source'),('reference','reason','source'));source(exclusion['source'])
                        ref=exclusion['reference'];need(ref in connected and ref not in excluded and isinstance(exclusion['reason'],str) and exclusion['reason'].strip(),'budget classification requires exact native identity and sourced rationale')
                        need(not scoped_demands(ref,row['net']),'positive reviewed load cannot be classified as a non-load')
                        excluded.add(ref)
                    need(bool(connected) and not loads&excluded and loads|excluded==connected,'budget lacks complete fitted native net load/classification coverage')
                    conditions(row['conditions'],observed,row['variant'])
                    need(lo<=total_lo and total_hi<=hi,'summed worst-case demands exceed sourced operating budget')
                    outcome.update(actual=dict(min=str(total_lo),max=str(total_hi),unit=base),covered_references=sorted(connected),
                                   variant=row['variant'],reviewed_demand_bindings=bindings)
                else:
                    raise ValueError('unsupported functional assertion kind: '+str(kind))
                if kind=='value':conditions(row['conditions'],observed,None)
                acceptance=requirements[row['requirement']]['acceptance']
                if acceptance['kind']=='interval':
                    need(kind in ('value','budget'),'numeric requirement needs an actual value or budget measurement')
                    required_lo,required_hi,required_unit=interval({k:acceptance[k] for k in ('min','max','unit','source')})
                    actual=outcome['actual'];need(actual['unit']==required_unit,'design requirement and measured physical units differ')
                    actual_lo=number(actual.get('min',actual.get('value')));actual_hi=number(actual.get('max',actual.get('value')))
                    need(required_lo<=actual_lo<=actual_hi<=required_hi,'actual result does not meet the named design requirement acceptance')
                outcome['status']='passed'
            except (OSError,ValueError,KeyError,TypeError) as error:
                outcome['cause']=str(error);report['blockers'].append(dict(code='functional_assertion',assertion=row['id'],detail=str(error)))
            observed[row['id']]=outcome;report['assertions'].append(outcome)
        for requirement in requirements:
            rows=[row for row in report['assertions'] if row['requirement']==requirement]
            report['requirement_results'][requirement]=dict(status='passed' if rows and all(r['status']=='passed' for r in rows) else 'blocked',assertions=[r['id'] for r in rows])
        part_evidence.verify_population_source(dict(board=board,population_source=population))
        for name,digest in {**report['inputs'],**report['tool_inputs']}.items():
            need(sha(name)==digest,'functional input changed during verification: '+name)
        report.update(status='blocked' if report['blockers'] else 'passed',
            coverage=dict(declared_assertions=len(assertions),passed_assertions=sum(r['status']=='passed' for r in report['assertions']),
                referenced_requirements=len(requirements),unknown_requirements='not declared here; evaluate the design contract for stage coverage'))
    except (OSError,ValueError,KeyError,TypeError,RuntimeError,ET.ParseError,subprocess.SubprocessError) as error:
        report['blockers'].append(dict(code='invalid_functional_contract',detail=str(error)))
    return report


def conditions(rows,observed,variant):
    if not isinstance(rows,list):raise ValueError('explicit operating conditions list required')
    used=set()
    for row in rows:
        keys(row,('mode','value'),('mode','value'))
        if row['mode'] in used:raise ValueError('duplicate operating condition')
        used.add(row['mode']);actual=observed.get(row['mode'])
        if (not actual or actual['kind']!='mode' or actual['status']!='passed' or actual['actual']!=row['value']
                or variant is not None and actual['variant']!=variant):
            raise ValueError('operating-mode applicability is missing, failed or different')


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('command',choices=['check']);parser.add_argument('board')
    parser.add_argument('--contract',type=Path,required=True);parser.add_argument('--root',type=Path,default=project_root.root())
    parser.add_argument('--output',type=Path);parser.add_argument('--json',action='store_true');args=parser.parse_args(argv)
    report=check_contract(args.root,args.board,args.contract,args.output)
    payload=report
    if args.output:
        lean.atomic_json(args.output,report)
        payload=dict(schema=report['schema'],status=report['status'],board=report['board'],qualified=False,
                     blockers=len(report['blockers']),report=dict(path=str(args.output.resolve()),sha256=sha(args.output)))
    print(json.dumps(payload,allow_nan=False) if args.json else ('PASS' if report['status']=='passed' else 'FAIL')+': schematic functional contract; '+
          ('all declared assertions passed' if report['status']=='passed' else report['blockers'][0]['detail']))
    return 0 if report['status']=='passed' else 1


if __name__=='__main__':raise SystemExit(main())
