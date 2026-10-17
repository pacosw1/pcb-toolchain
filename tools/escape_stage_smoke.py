#!/usr/bin/env python3
"""Bounded native escape-producer/cache proof on an isolated synthetic fixture.

No PDF/part review, ERC/DRC, routing, release or physical qualification is run.
"""
import argparse
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys

import lean_workflow as lean

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = 'iot-lab.escape-stage-smoke.v1'
PINNED_KICAD = '10.0.6'


def worker(output):
    import pcbnew
    import native_workflow_smoke
    import route_decision as route
    from engineering_constraints import native_geometry

    if pcbnew.Version() != PINNED_KICAD:
        raise ValueError('pinned pcbnew runtime required: '+PINNED_KICAD)
    project = output/'project'
    board = 'ESCAPE-STAGE-FIXTURE'
    folder = project/'hardware-design/boards'/board
    native_workflow_smoke.generate(folder)
    lean.atomic_json(folder/'gate.json', dict(project='fixture',checks=dict(erc=True,drc=True)))
    files = sorted(set(route.IMPLEMENTATIONS)|set(route.ESCAPE_POLICY_FILES))
    for name in files:
        target=project/'tools'/name;target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(ROOT/'tools'/name,target)
    native = folder/'fixture.kicad_pcb'
    before = route.source_set(native)
    inputs={str(native.with_suffix(Path(name).suffix)):digest for name,digest in before.items()}
    contract=dict(root=str(project),board=board,native=str(native),inputs=inputs,
        geometry=native_geometry(native),qualified=False,
        scope='synthetic cache integration policy; no reviewed production contract',
        rules=[dict(id='synthetic-escape',kind='escape',metric='native_minimum_track_escape',
                    refs=['J1'],pads=[dict(ref='J1',pad='1')])])
    events=[]
    def emit(stage):
        return lambda kind,**data:events.append(dict(stage=stage,kind=kind,**data))
    def verify(receipt):
        blockers=route.verify_escape_evidence(contract,native,receipt)
        if blockers:raise ValueError('actual native escape evidence blocked: '+json.dumps(blockers))
    pre=route.EscapeStageReceipts(emit('preflight'))
    first=pre.get(contract,native,output/'preflight.json')
    verify(first)
    requested=output/'duplicate-not-produced.json'
    reused=pre.get(contract,native,requested)
    if reused!=first or requested.exists() or (pre.generated,pre.hits)!=(1,1):
        raise ValueError('same-stage consumer did not reuse the original receipt exactly once')
    post=route.EscapeStageReceipts(emit('postcheck'))
    fresh=post.get(contract,native,output/'postcheck.json')
    if fresh==first or (post.generated,post.hits)!=(1,0):
        raise ValueError('post-stage consumer did not produce fresh evidence')
    verify(fresh)
    grids=[]
    for log in sorted(output.glob('*-artifacts/events.jsonl')):
        grids.extend(json.loads(line) for line in log.read_text().splitlines() if line)
    if len(grids)!=2 or any(row.get('stage')!='escape-grid' or row.get('status')!='complete' or row.get('returncode')!=0 for row in grids):
        raise ValueError('expected exactly two completed owned native grid producer calls')
    if route.source_set(native)!=before:raise ValueError('synthetic native inputs changed')
    for name,digest in inputs.items():
        if route.sha(name)!=digest:raise ValueError('native source changed: '+name)
    return dict(status='passed',producer_calls=2,cache_hits=1,native_mutations=0,
        source_inputs=inputs,events=events,grid_stages=grids,
        receipts=[dict(path=str(path),sha256=route.sha(path)) for path in (first,fresh)],
        runtime=route.read(first)['runtime'],pcbnew_version=pcbnew.Version())


def run(output,timeout=45):
    if not math.isfinite(timeout) or not 0<timeout<=45:
        raise ValueError('timeout must be positive and within the existing 45-second native smoke policy')
    import route_decision as route
    output=Path(output).resolve();output.mkdir(parents=True,exist_ok=False)
    names=set(route.IMPLEMENTATIONS)|set(route.ESCAPE_POLICY_FILES)|{
        'escape_stage_smoke.py','native_workflow_smoke.py','engineering_constraints.py','lean_owned_exec.py'}
    sources={str(ROOT/'tools'/name):lean.digest(ROOT/'tools'/name) for name in sorted(names)}
    result=dict(schema=SCHEMA,status='failed',scope='synthetic actual native grid producer and stage receipt reuse only',
        qualified=False,cad_verified=False,native_gate_run=False,part_review_run=False,
        source_inputs=sources,producer_calls=0,cache_hits=0,native_mutations=None)
    started=lean.now();deadline=lean.deadline_after(timeout)
    try:
        with (output/'worker.log').open('w') as log:
            completed=lean.run_stage([sys.executable,str(Path(__file__).resolve()),'_worker',str(output)],
                stage='native-escape-stage-proof',event_file=output/'events.jsonl',deadline=deadline,
                cwd=ROOT,env=dict(os.environ,KICAD_PYTHON=str(Path(sys.executable).resolve())),stdout=log,stderr=subprocess.STDOUT)
        if completed.returncode:raise ValueError('native worker failed; inspect '+str(output/'worker.log'))
        actual=json.loads((output/'worker-result.json').read_text())
        if actual.get('status')!='passed':raise ValueError('native worker did not pass')
        if any(lean.digest(name)!=digest for name,digest in sources.items()):raise ValueError('proof source changed during execution')
        result.update(actual);result['source_inputs']={**sources,**actual['source_inputs']}
    except (OSError,ValueError,RuntimeError,KeyError,TypeError,subprocess.SubprocessError) as error:
        result['cause']=str(error)
    result['elapsed_s']=round(lean.now()-started,3)
    result['artifacts']={str(path.relative_to(output)):lean.digest(path) for path in sorted(output.rglob('*')) if path.is_file()}
    lean.atomic_json(output/'summary.json',result)
    return result


def main(argv=None):
    argv=sys.argv[1:] if argv is None else argv
    if argv and argv[0]=='_worker':
        output=Path(argv[1]).resolve()
        lean.atomic_json(output/'worker-result.json',worker(output))
        return 0
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--timeout',type=float,default=45)
    args=parser.parse_args(argv)
    result=run(args.output,args.timeout)
    print(('PASS' if result['status']=='passed' else 'STUCK')+': native escape stage; '+
          str(result['producer_calls'])+' producers, '+str(result['cache_hits'])+' cache hits; '+str(args.output/'summary.json'))
    return 0 if result['status']=='passed' else 1


if __name__=='__main__':raise SystemExit(main())
