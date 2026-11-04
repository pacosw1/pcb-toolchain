"""Select a bounded local via repair from attributed native DRC evidence.

Moving away from conflicting pad anchors is a proposal-ranking heuristic, not
a clearance proof. Native and board-specific gates still decide acceptance.
"""
import argparse
from decimal import Decimal
import json
import math
from pathlib import Path
import time

from placer.dru import _tree, _tokens
from .block_bindings import child, footprints, rotate
from .contracts import number
from .native_candidate import copper_items
from .native_eco import point, prepare_shift, shift_via
from .native_srj import digest, source_set


def native_evidence(folder):
    folder=Path(folder).resolve();manifest=folder/'record.json';report=folder/'drc.json'
    record=json.loads(manifest.read_text());board=Path(record['board']).resolve()
    if (record.get('schema')!='iot-lab.native-export.v1'
            or record.get('status') not in ('reject','candidate','needs_native_check','model_rejected')
            or record.get('source_mutated') is not False or record.get('drc_returncode')!=0
            or record['inputs']!=source_set(board) or record.get('drc_sha256')!=digest(report)
            or not {'--schematic-parity','--refill-zones','--severity-all'}<=set(record.get('drc_command',[]))):
        raise ValueError('stale, incomplete or unattributed native DRC evidence')
    drc=json.loads(report.read_text())
    if (drc.get('source')!=board.name or drc.get('coordinate_units')!='mm'
            or 'error' not in drc.get('included_severities',[])
            or any(not isinstance(drc.get(k),list) for k in ('violations','unconnected_items','schematic_parity'))):
        raise ValueError('incomplete native DRC report')
    if drc['schematic_parity']:
        raise ValueError('schematic parity must be resolved before copper repair')
    files={str(p):digest(p) for p in (manifest,report)}
    return board,record,drc,files


def pad_anchors(board, wanted):
    result={}
    for fp in footprints(board):
        x,y,degrees=fp['pose']
        for pad in fp['form']:
            if not isinstance(pad,list) or pad[0]!='pad':continue
            uid=child(pad,'uuid',[''])[0]
            if uid not in wanted:continue
            if uid in result:raise ValueError('duplicate native pad identity')
            at=child(pad,'at')
            if not at or len(at) not in (2,3):raise ValueError('missing native pad origin')
            px,py=map(Decimal,at[:2])
            if not px.is_finite() or not py.is_finite():raise ValueError('nonfinite native pad origin')
            if degrees%90==0:
                px,py=rotate(px,py,int((degrees%360+360)%360/90))
            else:
                # Only a ranking heuristic; exact native clearance remains the gate.
                angle=math.radians(float(degrees));c,s=Decimal(str(math.cos(angle))),Decimal(str(math.sin(angle)))
                px,py=c*px+s*py,-s*px+c*py
            result[uid]=(x+px,y+py)
    return result


def select_repair(folder, *, fractions, budget_s, clock=time.monotonic):
    budget_s=number(budget_s,'budget_s',positive=True);started=clock()
    if (not fractions or len(fractions)!=len(set(fractions))
            or any(not 0<number(f,'fraction',positive=True)<1 for f in fractions)):
        raise ValueError('unique fractions strictly inside a source segment required')
    board,record,drc,files=native_evidence(folder)
    text,items=copper_items(board)
    errors=[r for r in drc['violations'] if r.get('severity')=='error']
    groups={};unsupported=[]
    for i,row in enumerate(errors):
        ids=[item.get('uuid') for item in row.get('items',[])]
        vias=[uid for uid in ids if uid in items and items[uid]['kind']=='via']
        if row.get('type') not in ('clearance','hole_clearance') or len(ids)!=2 or len(set(ids))!=2 or len(vias)!=1:
            unsupported.append(i);continue
        via=vias[0];other=next(uid for uid in ids if uid!=via)
        g=groups.setdefault(via,dict(pads=set(),errors=[]));g['pads'].add(other);g['errors'].append(i)
    anchors=pad_anchors(board,{p for g in groups.values() for p in g['pads']})
    forms={uid:_tree(_tokens(text[a:b]))[0] for uid,row in items.items() for a,b in [row['span']]}
    best=None;reasons={};evaluated=0;timed_out=False
    for via,g in sorted(groups.items()):
        if not g['pads']<=anchors.keys():
            reasons[via]='conflict is not a represented native pad';continue
        origin=point(forms[via],'at')
        incident=[uid for uid,row in items.items() if row['kind']=='segment' and row['net']==items[via]['net']
                  and origin in (point(forms[uid],'start'),point(forms[uid],'end'))]
        for along in sorted(incident):
            for fraction in fractions:
                if clock()-started>=budget_s:timed_out=True;break
                try:
                    prepared=prepare_shift(board,via,along,fraction=fraction)
                except (ValueError,KeyError,TypeError) as error:
                    reasons[via]=str(error);continue
                evaluated+=1;destination=prepared[-1]
                vector=tuple(b-a for a,b in zip(origin,destination))
                if any(sum(d*(a-c) for d,a,c in zip(vector,origin,anchors[p]))<=0 for p in g['pads']):
                    reasons[via]='an incident-direction candidate approaches a conflicting pad anchor';continue
                displacement2=sum(d*d for d in vector)
                score=(-len(g['errors']),displacement2,via,along,fraction)
                choice=dict(via_id=via,along_trace_id=along,fraction=fraction,
                    conflict_error_indices=g['errors'],pad_ids=sorted(g['pads']),
                    destination_mm=list(map(str,destination)),bridge_length_mm=float(displacement2.sqrt()))
                if best is None or score<best[0]:best=(score,choice)
            if timed_out:break
        if timed_out:break
        if not incident:reasons[via]='no incident straight trace'
    elapsed=clock()-started
    status='timeout' if timed_out or elapsed>=budget_s else 'candidate' if best else 'unsupported'
    if record['inputs']!=source_set(board) or any(digest(Path(p))!=h for p,h in files.items()):
        raise ValueError('native evidence changed during diagnosis')
    choice=best[1] if status=='candidate' else None
    addressed=set(choice['conflict_error_indices']) if choice else set()
    return dict(schema='iot-lab.native-conflict-selection.v1',status=status,qualified=False,
        source_board=str(board),sources=record['inputs'],evidence_files=files,
        fractions=fractions,budget_s=budget_s,elapsed_s=elapsed,evaluated=evaluated,choice=choice,
        input_error_count=len(errors),input_open_count=len(drc['unconnected_items']),
        untargeted_error_indices=[i for i in range(len(errors)) if i not in addressed],
        unsupported_error_indices=unsupported,diagnostic_reasons=reasons,
        ranking='Most reported conflicts targeted, then shortest bridge; move initially away from every conflicting pad anchor',
        native_and_board_specific_gates_required=True)


def propose(folder,out,*,fractions,budget_s):
    out=Path(out).resolve()
    if out.exists():raise ValueError('new separate output directory required')
    plan=select_repair(folder,fractions=fractions,budget_s=budget_s)
    if plan['status']!='candidate':
        out.mkdir(parents=True,exist_ok=False)
        (out/'record.json').write_text(json.dumps(plan,indent=2))
        return plan
    source=Path(plan['source_board'])
    if source_set(source)!=plan['sources']:
        raise ValueError('source changed before local repair')
    c=plan['choice']
    result=shift_via(source,c['via_id'],c['along_trace_id'],out,fraction=c['fraction'])
    result['conflict_selection']=plan
    (out/'record.json').write_text(json.dumps(result,indent=2))
    return result


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('native_export');ap.add_argument('out')
    ap.add_argument('--fraction',type=float,action='append',required=True)
    ap.add_argument('--budget-s',type=float,required=True,help='diagnosis deadline; no native solve is run')
    args=ap.parse_args()
    try:
        result=propose(args.native_export,args.out,fractions=args.fraction,budget_s=args.budget_s)
        if result['status']!='candidate':
            print('STUCK: local repair '+result['status']+'; '+json.dumps(result['diagnostic_reasons']));return 3
        print('PASS: native conflicts select one local via repair; original tracks retained; native gates required')
        return 0
    except (ValueError,KeyError,TypeError,OSError) as error:
        print('STUCK: '+str(error));return 3


if __name__=='__main__':raise SystemExit(main())
