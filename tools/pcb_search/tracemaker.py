"""Bounded native TraceMaker proposal for a frozen selected-net experiment.

Run inside an isolated worker with read-only inputs and networking disabled.
Only exact preserved native geometry plus new requested-net copper is admitted.
"""
import argparse
import json
import math
from pathlib import Path
import subprocess

import lean_workflow as lean
from .contracts import number
from .native_candidate import scope_native
from .native_srj import digest, frozen_srj, source_set


def command(binary, source, output, summary, srj, *, search_s, threads, priority_nets=()):
    number(search_s,'search_s',positive=True)
    if isinstance(threads,bool) or not isinstance(threads,int) or threads < 1:
        raise ValueError('positive worker thread count required')
    names={c['name'] for c in srj.get('connections',[])}
    if (len(set(priority_nets)) != len(priority_nets)
            or any(not isinstance(n,str) or n not in names or ',' in n for n in priority_nets)):
        raise ValueError('priority nets must uniquely name selected input connections without commas')
    # All native pads are exported as obstacles. Use a strict upper bound on
    # every envelope, so the upstream pad-width filter cannot permit via-in-pad.
    dimensions = [number(o[k],k,positive=True) for o in srj['obstacles'] for k in ('width','height')]
    if not dimensions:
        raise ValueError('native pad envelopes required for via-in-pad protection')
    bound = math.nextafter(max(dimensions),math.inf)
    args = [str(binary),'route',str(source),'-o',str(output),
            '--time',str(search_s),'--threads',str(threads),'--variants',str(threads),
            '--no-gpu','--no-kb','--soft-zones','--keep-vias-off-pads',
            '--vias-off-pads-below',str(bound),'--component-rules','off','--json',str(summary)]
    if priority_nets:
        args.append('--first-nets='+','.join(priority_nets))
    return args


def run(folder, out, *, binary, expected_sha256, search_s, wall_s, threads=1, priority_nets=()):
    number(wall_s,'wall_s',positive=True)
    number(search_s,'search_s',positive=True)
    if wall_s < search_s:
        raise ValueError('wall budget must cover the search budget')
    folder,out,binary = Path(folder).resolve(),Path(out).resolve(),Path(binary).resolve()
    if out.exists() or out == folder or folder in out.parents:
        raise ValueError('new output outside frozen input required')
    if digest(binary) != expected_sha256:
        raise ValueError('TraceMaker executable differs from approved fingerprint')
    manifest,srj = frozen_srj(folder)
    source = folder/'input.kicad_pcb'
    cmd = command(binary,source,out/'backend.kicad_pcb',out/'backend-summary.json',srj,
                  search_s=search_s,threads=threads,priority_nets=priority_nets)
    out.mkdir(parents=True,exist_ok=False)
    started = lean.now()
    record = dict(schema='iot-lab.tracemaker-run.v1',status='running',qualified=False,
                  executable_sha256=expected_sha256,input_files=manifest['input_files'],
                  srj_sha256=manifest['srj_sha256'],selected_nets=manifest['selected_nets'],
                  command=cmd,search_budget_s=search_s,wall_budget_s=wall_s,
                  priority_nets=list(priority_nets),
                  native_and_board_specific_gates_required=True)
    try:
        with (out/'backend.log').open('w') as log:
            proc = lean.run_stage(cmd,stage='tracemaker-native',event_file=out/'events.jsonl',
                                  deadline=lean.deadline_after(wall_s),cwd=out,
                                  stdout=log,stderr=subprocess.STDOUT)
        record['returncode'] = proc.returncode
        if source_set(source) != manifest['input_files'] or digest(binary) != expected_sha256:
            raise ValueError('input or executable changed during backend run')
        if frozen_srj(folder) != (manifest,srj):
            raise ValueError('frozen route model or manifest changed during backend run')
        if proc.returncode:
            record.update(status='backend_error',reason='backend did not complete; no candidate admitted')
        else:
            scoped = scope_native(source,out/'backend.kicad_pcb',out/'selected',manifest['selected_nets'])
            record.update(status='candidate',added=len(scoped['added_items']),
                          discarded=len(scoped['discarded_items']),
                          selected_record_sha256=digest(out/'selected/record.json'))
    except subprocess.TimeoutExpired:
        record.update(status='timeout',reason='owned backend wall deadline; no candidate admitted')
    except (ValueError,OSError,KeyError,TypeError,RuntimeError) as error:
        record.update(status='reject',reason=type(error).__name__+': '+str(error))
    except BaseException:
        record.update(status='cancelled',reason='interrupted; no candidate admitted')
        raise
    finally:
        record['elapsed_s'] = lean.now()-started
        record['artifacts'] = {str(p.relative_to(out)):digest(p) for p in sorted(out.rglob('*')) if p.is_file()}
        lean.atomic_json(out/'record.json',record)
    return record


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('input');ap.add_argument('output')
    ap.add_argument('--binary',required=True);ap.add_argument('--binary-sha256',required=True)
    ap.add_argument('--search-s',required=True,type=float);ap.add_argument('--wall-s',required=True,type=float)
    ap.add_argument('--threads',type=int,default=1)
    ap.add_argument('--priority-net',action='append',default=[],help='selected net to route first, based on diagnosed failures')
    args=ap.parse_args()
    try:
        r=run(args.input,args.output,binary=args.binary,expected_sha256=args.binary_sha256,
              search_s=args.search_s,wall_s=args.wall_s,threads=args.threads,priority_nets=args.priority_net)
        print(('PASS' if r['status']=='candidate' else 'STUCK')+': TraceMaker '+r['status']+
              '; '+r.get('reason','scoped proposal only; native gates required'))
        return 0 if r['status']=='candidate' else 3
    except (ValueError,OSError,KeyError,TypeError) as error:
        print('FAIL: '+str(error));return 2


if __name__=='__main__':
    raise SystemExit(main())
