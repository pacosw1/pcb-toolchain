#!/usr/bin/env python3
"""Bounded actual KiCad export proof on isolated synthetic reviewed fixtures."""
import argparse
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import time
import xml.etree.ElementTree as ET

import lean_workflow as lean
import net_drivers
import pq_cadlib as cad
import schematic_contract as contract
from test_schematic_contract import make_functional_fixture


def export_observation(schematic,artifacts):
    """Native CI adapter coverage; deliberately does not evaluate part reviews."""
    artifacts.mkdir(parents=True,exist_ok=False)
    parsed,evidence,tools=contract.export_native(schematic,artifacts)
    if (parsed['pins'].get(('J1','1'),{}).get('net')!='/A'
            or parsed['pins'].get(('J3','1'),{}).get('net')!='/B'
            or parsed['fields']['J1'].get('Operating_Mode')!='low'):
        raise ValueError('actual native XML pins/operating-field parsing differs from source fixture')
    value,unit=contract.canonical_value(parsed['values']['J1'],'F')
    return dict(schema='iot-lab.schematic-native-export-observation.v1',status='observed',qualified=False,
        scope='actual native export and production parser/canonicalization only; no reviewed-part or functional-contract verdict',
        actual_nominal=dict(value=str(value),unit=unit),inputs=evidence,tool_inputs=tools,evidence_directory=str(artifacts))


def write_junit(output,result):
    cases=(('actual_native_export_is_parsed','actual_wrong_native_value_is_detected') if result['export_only'] else
           ('actual_native_export_passes_declared_assertions','actual_wrong_native_value_is_rejected'))
    rows={row['case']:row for row in result['cases']};failed=[name for name in cases if rows.get(name,{}).get('status')!='passed']
    if result['status']!='passed' and not failed:failed=[cases[-1]]
    suite=ET.Element('testsuite',dict(name='iot-lab.schematic-native-export',tests='2',failures=str(len(failed)),errors='0',skipped='0',time=str(result['elapsed_s'])))
    ET.SubElement(suite,'system-out').text=json.dumps(dict(scope=result['scope'],export_only=result['export_only'],qualified=False,
        runtime=result.get('runtime'),summary=str(output/'summary.json')),sort_keys=True)
    for name in cases:
        node=ET.SubElement(suite,'testcase',dict(classname='iot_lab.schematic_native_export',name=name))
        if name in failed:ET.SubElement(node,'failure',dict(message=result['cause'])).text='Required native observation failed or did not execute'
        ET.SubElement(node,'system-out').text=json.dumps(rows.get(name,dict(case=name,status='not_executed')),sort_keys=True)
    ET.ElementTree(suite).write(output/'junit.xml',encoding='utf-8',xml_declaration=True)


def run(output,timeout=45,export_only=False):
    output=Path(output).resolve();output.mkdir(parents=True,exist_ok=False)
    started=time.monotonic();deadline=lean.deadline_after(timeout)
    result=dict(schema='iot-lab.schematic-contract-smoke.v1',status='failed',qualified=False,
        scope=('synthetic native export/parser/canonicalization only; no PDF, part-review or complete functional-contract verdict'
               if export_only else 'synthetic native schematic export/functional assertions; no shipping CAD, ERC/DRC, routing or production selection'),
        export_only=export_only,cases=[])
    try:
        cli=shutil.which(net_drivers.KICAD_CLI)
        if not cli:raise ValueError('native KiCad executable unavailable')
        with (output/'version.log').open('w') as log:
            version=lean.run_stage([cli,'--version'],stage='schematic-proof-version',event_file=output/'events.jsonl',
                deadline=deadline,stdout=log,stderr=subprocess.STDOUT)
        actual=(output/'version.log').read_text().strip()
        if version.returncode or actual!='10.0.6':raise ValueError('proof requires actual KiCad10.0.6; observed '+actual)
        result['runtime']=dict(kicad_version=actual,cli=str(Path(cli).resolve()),cli_sha256=contract.sha(Path(cli).resolve()))
        fixture=make_functional_fixture(output/'source')
        original={str(path.relative_to(output/'source')):contract.sha(path) for path in (output/'source').rglob('*') if path.is_file()}
        baseline=(export_observation(fixture['schematic'],output/'baseline-native') if export_only else
                  contract.check_contract(output/'source',fixture['board'],fixture['contract'],output/'baseline.json'))
        lean.atomic_json(output/'baseline.json',baseline)
        if export_only:
            if contract.number(baseline['actual_nominal']['value'])!=contract.number('0.000001'):
                raise ValueError('actual native baseline nominal is not the authored1uF fixture')
        elif baseline['status']!='passed':raise ValueError('native baseline blocked: '+json.dumps(baseline['blockers']))
        result['cases'].append(dict(case='actual_native_export_is_parsed' if export_only else 'actual_native_export_passes_declared_assertions',status='passed',
            report='baseline.json',assertions=3 if export_only else len(baseline['assertions']),xml=str(Path(baseline['evidence_directory'])/'native-netlist.xml')))
        if lean.remaining(deadline)<=0:raise ValueError('proof budget exhausted after native baseline')
        negative=output/'wrong-value-source';shutil.copytree(output/'source',negative)
        for name,kind in (('fixture.kicad_sch','symbol'),('fixture.kicad_pcb','footprint')):
            path=negative/'hardware-design/boards/PART-FIXTURE'/name;tree=cad.parse(path.read_text())
            row=next(row for row in cad.items(tree,kind) if any(p[1:3]==['Reference','J1'] for p in cad.items(row,'property')))
            next(p for p in cad.items(row,'property') if p[1]=='Value')[2]='10uF';path.write_text(cad.dump(tree))
        manifest=negative/fixture['contract'].relative_to(output/'source')
        wrong=(export_observation(negative/fixture['schematic'].relative_to(output/'source'),output/'wrong-value-native') if export_only else
               contract.check_contract(negative,fixture['board'],manifest,output/'wrong-value.json'))
        lean.atomic_json(output/'wrong-value.json',wrong)
        if export_only:
            if (contract.number(wrong['actual_nominal']['value'])!=contract.number('0.00001')
                    or wrong['actual_nominal']==baseline['actual_nominal']):
                raise ValueError('production canonicalizer did not distinguish the actual changed native nominal')
            failure=dict(cause='production native parser/canonicalizer detects1uF→10uF; part review not evaluated')
        else:
            failure=next((row for row in wrong['assertions'] if row['id']=='NOMINAL'),{})
            if wrong['status']!='blocked' or failure.get('status')!='blocked' or 'outside sourced interval' not in failure.get('cause',''):
                raise ValueError('wrong native nominal value did not fail the independent functional assertion')
        xml=Path(wrong['evidence_directory'])/'native-netlist.xml'
        if '<value>10uF</value>' not in xml.read_text():raise ValueError('negative assertion did not use actual mutated native export')
        result['cases'].append(dict(case='actual_wrong_native_value_is_detected' if export_only else 'actual_wrong_native_value_is_rejected',status='passed',report='wrong-value.json',xml=str(xml),
            assertion='NOMINAL',cause=failure['cause']))
        if any(contract.sha(output/'source'/name)!=digest for name,digest in original.items()):
            raise ValueError('original synthetic native source changed during the proof')
        result.update(status='passed',cause=('actual native export/parser/canonicalization detects an isolated changed value; part review not evaluated'
            if export_only else 'actual native export feeds passing assertions and rejects an isolated wrong value'),source_inputs=original)
    except (OSError,ValueError,KeyError,TypeError,RuntimeError,subprocess.SubprocessError) as error:
        result['cause']=str(error)
    result['elapsed_s']=round(time.monotonic()-started,3)
    write_junit(output,result)
    result['artifacts']={str(path.relative_to(output)):contract.sha(path) for path in output.rglob('*')
                         if path.is_file() and path.suffix in ('.xml','.log','.jsonl','.json')}
    lean.atomic_json(output/'summary.json',result)
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--timeout',type=float,default=45);parser.add_argument('--export-only',action='store_true');args=parser.parse_args()
    if not math.isfinite(args.timeout) or args.timeout<=0:parser.error('finite positive timeout required')
    # Command-local workaround for the already diagnosed global third-party
    # directory scan; original global library tables remain in use.
    third_party=args.output.resolve().parent/(args.output.name+'-empty-third-party')
    third_party.mkdir(parents=True,exist_ok=False)
    os.environ['KICAD10_3RD_PARTY']=str(third_party)
    os.environ['IOT_LEAN_DEADLINE']=lean.encode_deadline(lean.deadline_after(args.timeout))
    result=run(args.output,args.timeout,args.export_only)
    print(json.dumps(dict(status=result['status'],cause=result['cause'],elapsed_s=result['elapsed_s'],
        cases=result['cases'],summary=str(args.output.resolve()/'summary.json'),qualified=False)))
    return 0 if result['status']=='passed' else 1


if __name__=='__main__':raise SystemExit(main())
