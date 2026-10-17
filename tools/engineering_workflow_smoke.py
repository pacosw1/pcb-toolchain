#!/usr/bin/env python3
"""Replay one diagnosed routing repair on a real ENV copy through the unified CLI.

This records actual incomplete part-review scope, a failed native check, a
source-bound local repair, fresh configured/ENV gates, named-defect adoption and
an engineering cycle. It never writes shipping CAD or claims part/release approval.
"""
import argparse
from decimal import Decimal
import json
import math
import os
from pathlib import Path
import subprocess
import signal
import sys
import time
import xml.etree.ElementTree as ET

import lean_workflow as lean
import pcb_operations as operations
from pcb_workflow import board_config,sha
from pcb_search.native_candidate import copper_items
from pcb_search.native_eco import point
from pcb_search.native_srj import geometry_digest
from placer.dru import _tree,_tokens
from pcb_search.block_bindings import child
from real_board_regression import cancel_and_settle,native_contract
from route_decision import crossing_guard

ROOT=Path(__file__).resolve().parent.parent
BOARD='ENV-SENSE'
CASES=('native_part_review_scope_remains_blocked','detect_injected_native_gap','source_bound_routing_decision',
       'guarded_local_repair_fresh_configured_gates','adopt_only_in_isolated_checkout','engineering_cycle_links_actual_evidence','shipping_sources_unchanged')


def read(path):return json.loads(Path(path).read_text())


def terminal_summary(result,output):
    """Keep full source manifests in sealed evidence, never in terminal output."""
    path=Path(output).resolve()/'summary.json'
    return dict(schema=result['schema'],status=result['status'],board=result['board'],qualified=False,
        cause=result['cause'],elapsed_s=result.get('elapsed_s'),
        cases=[dict(case=row['case'],status=row['status']) for row in result.get('cases',[])],
        summary_json=str(path),summary_sha256=sha(path) if path.is_file() else None)


def write_junit(output,result):
    rows={row['case']:row for row in result.get('cases',[])}
    failed=[case for case in CASES if rows.get(case,{}).get('status')!='passed']
    if result.get('status')!='passed' and not failed:failed=[CASES[-1]]
    attrs=dict(name='iot-lab.engineering-workflow',tests=str(len(CASES)),failures=str(len(failed)),errors='0',skipped='0')
    if isinstance(result.get('elapsed_s'),(int,float)):attrs['time']=str(result['elapsed_s'])
    suite=ET.Element('testsuite',attrs)
    context=dict(scope=result['scope'],qualified=False,overall_status=result['status'],
        shipping_source_sha256=result.get('shipping_inputs',{}).get('sha256'),
        injection=result.get('injection'),cycle_id=result.get('cycle_id'),run_cleanup=result.get('run_cleanup'))
    ET.SubElement(suite,'system-out').text=json.dumps(context,sort_keys=True)
    for case in CASES:
        node=ET.SubElement(suite,'testcase',dict(classname='iot_lab.engineering_workflow',name=case))
        if case in failed:
            ET.SubElement(node,'failure',dict(message=result.get('cause','required case did not execute'))).text=(
                'Overall replay integrity failed' if case in rows else 'Required case did not execute after the upstream failure')
        ET.SubElement(node,'system-out').text=json.dumps(rows.get(case,dict(case=case,status='not_executed')),sort_keys=True)
    path=Path(output)/'junit.xml'
    ET.ElementTree(suite).write(path,encoding='utf-8',xml_declaration=True)
    return path


def gap_candidate(native):
    """Select one original interior 0/45/90-degree segment with exact neighbours."""
    text,items=copper_items(native)
    rows={uid:_tree(_tokens(text[slice(*row['span'])]))[0] for uid,row in items.items() if row['kind']=='segment'}
    candidates=[]
    for uid,form in rows.items():
        if 'locked' in form or child(form,'locked',['no'])!=['no']:continue
        a,b=point(form,'start'),point(form,'end')
        dx,dy=(abs(y-x) for x,y in zip(a,b))
        if (dx and dy and dx!=dy) or a==b:continue
        layer,width=child(form,'layer'),child(form,'width')
        neighbours=[]
        for endpoint in (a,b):
            hits=[key for key,value in rows.items() if key!=uid and items[key]['net']==items[uid]['net']
                  and child(value,'layer')==layer and child(value,'width')==width
                  and endpoint in (point(value,'start'),point(value,'end'))]
            if len(hits)!=1:break
            neighbours+=hits
        if len(neighbours)==2 and len(set(neighbours))==2:
            distance2=sum((x-y)**2 for x,y in zip(a,b))
            candidates.append((items[uid]['net']!='/V_GAS',items[uid]['net'],distance2,uid,neighbours))
    if not candidates:raise ValueError('real board has no supported exact interior segment-gap specimen')
    for _,net,_,uid,neighbours in sorted(candidates):
        form=rows[uid]
        try:crossing_guard(native,net,child(form,'layer')[0],point(form,'start'),point(form,'end'))
        except ValueError:continue
        start,end=items[uid]['span']
        return dict(removed_id=uid,net=net,endpoint_ids=neighbours,original_segment=text[start:end],
                    source_sha256=sha(native)),text[:start]+text[end:]
    raise ValueError('all interior segment specimens need unsupported native crossing reconciliation')


def run(args):
    output=args.output.resolve()
    if output==ROOT or output in ROOT.parents or any(output.is_relative_to(ROOT/name) for name in ('tools','hardware-design')):
        raise ValueError('new evidence directory must not overlap shipping source inputs')
    output.mkdir(parents=True,exist_ok=False)
    started=time.monotonic();deadline=lean.deadline_after(args.timeout,{})
    workspace=output/'checkout';runs=workspace/'.gate/cli';canonical=None;sequence=0;cycle=None
    result=dict(schema='iot-lab.engineering-workflow-smoke.v1',status='failed',board=BOARD,qualified=False,
        scope='real-board engineering workflow replay; no part selection, shipping edit, release or bench qualification',
        expected_cases=list(CASES),cases=[],skipped=0)

    def record(case,**evidence):
        result['cases'].append(dict(case=case,status='passed',**evidence))
        print('PASS: '+case,file=sys.stderr,flush=True)

    def invoke(arguments,expected=0,link=False):
        nonlocal sequence
        sequence+=1;label=arguments[0];log=output/('%02d-%s.log'%(sequence,label))
        command=[args.python,str(workspace/'tools/pcb_cli.py'),label,'--runs-dir',str(runs),'--json']
        if label in ('check','parts','routing','repair'):
            command+=['--timeout',str(max(1,lean.remaining(deadline)-10))]
            if link:command+=['--cycle',cycle]
        command+=arguments[1:]
        print('START: '+' '.join(arguments[:3]),file=sys.stderr,flush=True)
        with log.open('w') as stream:
            proc=lean.run_stage(command,stage='engineering-'+label,event_file=output/'stages.jsonl',
                deadline=deadline,cwd=workspace,env=dict(os.environ,IOT_LAB=str(workspace)),stdout=stream,stderr=subprocess.STDOUT)
        if proc.returncode!=expected:
            raise ValueError('%s expected exit%d got%d; evidence=%s'%(label,expected,proc.returncode,log))
        return json.loads(log.read_text().splitlines()[-1])

    try:
        canonical=operations.source_state(ROOT,BOARD)
        result['shipping_inputs']=canonical
        operations.snapshot(ROOT,workspace,BOARD)
        _,_,project=board_config(workspace,BOARD);native=project.with_suffix('.kicad_pcb')
        original=native.read_bytes();injection,changed=gap_candidate(native)
        native.write_text(changed);lean.atomic_json(output/'injection.json',injection)
        injected=native.read_bytes()
        result['injection']=dict(injection,injected_sha256=sha(native))
        cycle=invoke(['cycle','start',BOARD,'--owner','engineering-workflow-smoke'])['cycle_id']
        result['cycle_id']=cycle
        parts=invoke(['parts','status',BOARD],1,True);parts_folder=runs/parts['run_id']
        part_report=read(parts_folder/'operation/report.json')
        if part_report.get('status')!='blocked' or not part_report.get('native_inputs') or not part_report.get('blockers') or part_report.get('qualified') is not False:
            raise ValueError('actual native part-review gaps were not retained as unqualified blockers')
        record(CASES[0],run_id=parts['run_id'],blocker_codes=sorted({row['code'] for row in part_report['blockers']}))
        failed=invoke(['check',BOARD,'--fresh'],1,True);failed_folder=runs/failed['run_id']
        _,raw,findings=native_contract(failed_folder,'failed')
        if raw['metrics']['drc_errors']!=0 or raw['metrics']['drc_parity']!=0 or raw['metrics']['drc_unconnected']<1:
            raise ValueError('injected interior gap did not produce an isolated native connectivity defect')
        defect=next((row for row in findings['findings'] if row['stage']=='drc' and row.get('evidence',{}).get('pointer','').startswith('/unconnected_items/')),None)
        if not defect or defect.get('severity')!='error':
            raise ValueError('native connectivity finding lacks an adoptable exact defect identity')
        record(CASES[1],run_id=failed['run_id'],defect=defect['id'],native_opens=raw['metrics']['drc_unconnected'])
        diagnosis=invoke(['routing','diagnose',BOARD,'--evidence',str(failed_folder/'gate/result.json')],0,True)
        diagnosis_folder=runs/diagnosis['run_id'];plan=diagnosis_folder/'operation/report.json';decision=read(plan)
        if decision.get('status')!='repairable' or decision.get('choice',{}).get('strategy')!='straight_gap_bridge' or decision['choice']['net']!=injection['net']:
            raise ValueError('source-bound diagnosis did not select the injected one-gap repair: '+json.dumps(decision.get('rejected_gap_patterns')))
        record(CASES[2],run_id=diagnosis['run_id'],plan_sha256=sha(plan),scope=decision['scope'],strategy=decision['choice']['strategy'])
        repaired=invoke(['repair',BOARD,'--plan',str(plan)],0,True);candidate_folder=runs/repaired['run_id']
        _,repaired_gate,_=native_contract(candidate_folder,'passed')
        operation=read(candidate_folder/'operation/result.json');candidate=Path(operation['candidate'])
        guard=read(candidate_folder/'operation/repair-guard.json')
        if native.read_bytes()!=injected or not operation.get('candidate_verified') or not operation.get('identity_preserved'):
            raise ValueError('repair escaped isolation or lacks complete candidate verification')
        if len(guard.get('added_items',[]))!=1 or guard.get('allowed_original_edits'):
            raise ValueError('gap repair exceeded its one additive segment scope')
        pristine=output/'original.kicad_pcb';pristine.write_bytes(original)
        if geometry_digest(pristine,[injection['removed_id']])!=geometry_digest(candidate,guard['added_items']):
            raise ValueError('repair changed original placement, rules, copper or other native forms')
        for name in ('board-semantic-0.log','board-semantic-1.log','board-check.json'):
            if not (candidate_folder/'operation'/name).is_file():raise ValueError('missing ENV semantic evidence: '+name)
        record(CASES[3],run_id=repaired['run_id'],guard_sha256=sha(candidate_folder/'operation/repair-guard.json'),
               candidate_sha256=guard['candidate_sha256'],protected_geometry_sha256=guard['protected_geometry_sha256'],metrics=repaired_gate['metrics'])
        adopted=invoke(['adopt',repaired['run_id'],'--baseline',failed['run_id'],'--defect',defect['id']])
        if sha(native)!=guard['candidate_sha256'] or (candidate_folder/'backup'/native.name).read_bytes()!=injected:
            raise ValueError('isolated adoption did not retain exact candidate/backup bytes')
        record(CASES[4],adoption=adopted)
        summary=invoke(['cycle','finish',cycle])
        if summary.get('status')!='recorded' or summary.get('qualified') is not False or summary.get('evidence_issues') or len(summary.get('runs',[]))!=4:
            raise ValueError('engineering cycle did not bind all four real terminal runs')
        if not all(row.get('evidence_verified') for row in summary['runs']):raise ValueError('cycle contains an unverified run')
        record(CASES[5],cycle_id=cycle,runs=[row['run_id'] for row in summary['runs']],covered_elapsed_s=summary.get('covered_elapsed_s'))
        if operations.source_state(ROOT,BOARD)!=canonical:raise ValueError('shipping sources changed during replay')
        record(CASES[6],source_sha256=canonical['sha256'])
        result.update(status='passed',cause='all real native engineering replay cases passed; shipping source unchanged')
    except (OSError,ValueError,RuntimeError,KeyError,TypeError,subprocess.SubprocessError,KeyboardInterrupt) as error:
        result['cause']=str(error)
    finally:
        handlers={sig:signal.signal(sig,signal.SIG_IGN) for sig in (signal.SIGTERM,signal.SIGINT)}
        try:
            result['run_cleanup']=cancel_and_settle(runs,workspace)
            if not result['run_cleanup']['complete']:
                result.update(status='failed',cause='owned CLI cleanup unconfirmed: '+'; '.join(result['run_cleanup']['errors']))
            result['elapsed_s']=round(time.monotonic()-started,3)
            try:result['shipping_sources_unchanged']=canonical is not None and operations.source_state(ROOT,BOARD)==canonical
            except (OSError,ValueError,RuntimeError,subprocess.SubprocessError) as error:
                result.update(shipping_sources_unchanged=False,source_check_error=str(error))
            if not result['shipping_sources_unchanged']:result.update(status='failed',cause='shipping source could not be verified unchanged')
            result['artifacts']={str(p.relative_to(output)):sha(p) for p in output.glob('*') if p.is_file()}
            result['artifacts']['junit.xml']=sha(write_junit(output,result))
            lean.atomic_json(output/'summary.json',result)
        finally:
            for sig,handler in handlers.items():signal.signal(sig,handler)
    return result


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--timeout',type=float,default=180);parser.add_argument('--python',default=os.environ.get('KICAD_PYTHON',sys.executable));parser.add_argument('--json',action='store_true')
    args=parser.parse_args(argv)
    if not math.isfinite(args.timeout) or args.timeout<=0:parser.error('finite positive timeout required')
    def interrupted(signum,frame):raise lean.StageCancelled(signum)
    handlers={sig:signal.signal(sig,interrupted) for sig in (signal.SIGTERM,signal.SIGINT)}
    try:
        try:result=run(args)
        except (OSError,ValueError) as error:
            print('FAIL: '+str(error));return 2
    finally:
        for sig,handler in handlers.items():signal.signal(sig,handler)
    print(json.dumps(terminal_summary(result,args.output)) if args.json else
          ('PASS: ' if result['status']=='passed' else 'FAIL: ')+result['cause']+'; evidence='+str(args.output.resolve()/'summary.json'))
    return 0 if result['status']=='passed' else 1


if __name__=='__main__':raise SystemExit(main())
