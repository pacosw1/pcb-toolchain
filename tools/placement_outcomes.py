#!/usr/bin/env python3
"""Compare attributed placement/routing outcomes without tuning or running CAD.

Historical observations stay useful after canonical CAD changes. Comparative
readiness additionally needs equal recorded execution controls, paired trials
and a board-family holdout disjoint from development. No result qualifies CAD.
"""
import argparse
import collections
import datetime as dt
import json
import math
from pathlib import Path
import re
import sys

import lean_workflow as lean
from pcb_workflow import sha
from pcb_timing import union_seconds
from placer import placement_audit
import project_root  # noqa: E402

STUDY = 'iot-lab.placement-outcome-study.v1'
REPORT = 'iot-lab.placement-outcome-comparison.v1'
POLICY = 'iot-lab.placement-outcome-execution.v1'
ATTEMPT = 'iot-lab.verified-routing-execution-attempt.v1'
TERMINAL = {'passed','failed','error','timeout','cancelled'}


def identity(value):
    return placement_audit.identity(value)


def native_diagnostic_fingerprint(diagnostic):
    """Fingerprint native findings, independently of source/CAD identity.

    The caller supplies exactly the three diagnostic arrays from a bound native
    report. Report metadata/provenance remains separately bound by its receipt.
    Only UUID fields and finding/direct-item order are ignored. Extra semantic
    JSON fields are retained; arbitrary nested list order and numbers are exact.
    Unknown representations or malformed native findings have no fingerprint.
    """
    sections={'violations','unconnected_items','schematic_parity'}
    if not isinstance(diagnostic,dict) or set(diagnostic)!=sections:
        raise ValueError('native diagnostic requires exactly the three finding arrays')

    def normalized(value):
        if isinstance(value,dict):
            if any(not isinstance(key,str) for key in value):
                raise ValueError('native diagnostic keys must be strings')
            if 'uuid' in value and (not isinstance(value['uuid'],str) or not value['uuid']):
                raise ValueError('malformed native diagnostic UUID')
            return {key:normalized(item) for key,item in value.items() if key!='uuid'}
        if isinstance(value,list):return [normalized(item) for item in value]
        if value is None or isinstance(value,(str,bool,int)):return value
        if isinstance(value,float) and math.isfinite(value):return value
        raise ValueError('unknown or nonfinite native diagnostic value')

    canonical=lambda value:json.dumps(value,sort_keys=True,allow_nan=False,separators=(',',':'))
    result={}
    try:
        for section in sections:
            findings=diagnostic[section]
            if not isinstance(findings,list):raise ValueError('native diagnostic findings must be arrays')
            rows=[]
            for finding in findings:
                if (not isinstance(finding,dict) or finding.get('severity') not in ('error','warning','exclusion')
                        or any(not isinstance(finding.get(key),str) or not finding[key].strip()
                               for key in ('type','description'))
                        or not isinstance(finding.get('items'),list) or not finding['items']):
                    raise ValueError('malformed or unknown native diagnostic finding')
                for item in finding['items']:
                    if (not isinstance(item,dict) or not isinstance(item.get('description'),str)
                            or not item['description'].strip() or not isinstance(item.get('pos'),dict)
                            or set(item['pos'])!={'x','y'}
                            or any(not isinstance(value,(int,float)) or isinstance(value,bool)
                                   or not math.isfinite(value) for value in item['pos'].values())):
                        raise ValueError('malformed or unknown native diagnostic item position')
                row=normalized(finding)
                row['items']=sorted(row['items'],key=canonical)
                rows.append(row)
            result[section]=sorted(rows,key=canonical)
        return identity(result)
    except (OverflowError,RecursionError) as error:
        raise ValueError('unsupported native diagnostic value') from error


def loaded_tool_inputs():
    """Attribute the repository Python sources actually loaded by this observer."""
    tools=Path(__file__).resolve().parent
    paths={Path(module.__file__).resolve() for module in list(sys.modules.values())
           if getattr(module,'__file__',None) and str(module.__file__).endswith('.py')}
    return {str(path):sha(path) for path in sorted(paths) if path.is_relative_to(tools) and path.is_file()}


def finite(value):
    return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value) and value>=0


class Evidence:
    def __init__(self, root):
        self.root=Path(root).resolve();self.inputs={}

    def file(self, name, expected=None):
        path=(self.root/name).resolve()
        digest=sha(path)
        if expected is not None and digest!=expected:raise ValueError('evidence changed: '+str(path))
        if str(path) in self.inputs and self.inputs[str(path)]!=digest:raise ValueError('evidence changed during observation')
        self.inputs[str(path)]=digest
        return path

    def read(self, name, expected=None):
        path=self.file(name,expected);value=json.loads(path.read_text())
        if not isinstance(value,dict):raise ValueError('expected evidence JSON object: '+str(path))
        return value


def sealed_run(evidence, folder, expected):
    folder=(evidence.root/folder).resolve()
    terminal=evidence.read(folder/'result.json',expected)
    if terminal.get('status') not in TERMINAL or terminal.get('cleanup',{}).get('complete') is not True:
        raise ValueError('run is not terminal with confirmed owned cleanup')
    hashes=terminal.get('evidence_sha256',{})
    if not isinstance(hashes,dict) or 'run.json' not in hashes:raise ValueError('run has no terminal evidence seal')
    for name,digest in hashes.items():
        path=(folder/name).resolve()
        if not path.is_relative_to(folder):raise ValueError('sealed run path escapes its folder')
        evidence.file(path,digest)
    manifest=evidence.read(folder/'run.json')
    actual={'run.json'}
    for directory in ('operation','gate'):
        actual.update(str(p.relative_to(folder)) for p in (folder/directory).rglob('*') if p.is_file())
    operation=evidence.read(folder/'operation/result.json') if (folder/'operation/result.json').is_file() else {}
    candidate=None
    if operation.get('candidate'):
        old_workspace=Path(operation.get('workspace',str(Path(operation['candidate']).parent)))
        recorded=Path(operation['candidate'])
        if not recorded.is_relative_to(old_workspace):raise ValueError('candidate escapes recorded workspace')
        candidate=(folder/'workspace'/recorded.relative_to(old_workspace)).resolve()
        if not candidate.is_relative_to(folder/'workspace'):raise ValueError('candidate path escapes archived workspace')
        actual.add(str(candidate.relative_to(folder)))
        evidence.file(candidate,operation.get('candidate_sha256'))
    if set(hashes)!=actual:raise ValueError('run evidence inventory differs from its terminal seal')
    return folder,terminal,manifest,operation,candidate


def native_thermal_controls(evidence, folder, trial, manifest, source, policy, candidate, placement_sha256):
    """Revalidate the sealed opt-in obligation before exposing a routing label."""
    spec=manifest.get('spec',{})
    requested=isinstance(spec,dict) and spec.get('thermal_verification')=='native-checkback'
    effort,controls=(policy.get(key,{}) for key in ('effort','controls'))
    if not isinstance(effort,dict) or not isinstance(controls,dict):
        raise ValueError('native thermal execution controls are malformed')
    declared=effort.get('thermal_verification')
    obligation=controls.get('native_thermal_obligations')
    if isinstance(spec,dict) and ('thermal_verification' in spec or spec.get('schema')=='iot-lab.routing-policy.v2') and not requested:
        raise ValueError('unknown native thermal route specification')
    if not requested:
        if (declared is not None or obligation is not None
                or isinstance(policy.get('command'),list) and '--native-thermal-checkback' in policy['command']):
            raise ValueError('native thermal execution was not explicitly selected by the route spec')
        return None
    if spec.get('schema')!='iot-lab.routing-policy.v2' or declared!='native-checkback':
        raise ValueError('native thermal route specification and execution policy differ')
    if not isinstance(obligation,dict) or obligation.get('status')!='passed':
        return 'native thermal obligation is pending, missing or unfulfilled'
    if candidate is None:
        raise ValueError('native thermal discharge has no exact configured-gate candidate')
    command=policy.get('command',[])
    if (not isinstance(command,list) or len(command)<4 or any(not isinstance(item,str) for item in command)
            or command.count('--native-thermal-checkback')!=1):
        raise ValueError('native thermal producer invocation is missing')
    recorded_router=Path(command[3])
    if not recorded_router.is_absolute():
        raise ValueError('native thermal router evidence owner is unresolved')
    router=folder/'operation/router'
    def record(key,name):
        descriptor=obligation.get(key,{})
        if (not isinstance(descriptor,dict) or descriptor.get('path')!='operation/router/'+name
                or not isinstance(descriptor.get('sha256'),str)
                or not re.fullmatch(r'[0-9a-f]{64}',descriptor['sha256'])):
            raise ValueError('native thermal '+key+' lacks an owned sealed binding')
        return evidence.read(router/name,descriptor['sha256'])
    initial=record('initial','native-thermal-initial.json')
    final=record('final','native-thermal-final.json')
    snapshot=record('source_snapshot','native-thermal-source.json')
    descriptor=obligation.get('candidate',{})
    if (not isinstance(descriptor,dict) or descriptor.get('path')!='operation/router/routed.kicad_pcb'
            or descriptor.get('sha256')!=sha(candidate)):
        raise ValueError('native thermal candidate differs from the configured gate candidate')
    evidence.file(router/'routed.kicad_pcb',descriptor['sha256'])
    relative='hardware-design/boards/'+manifest['board']+'/'+manifest['project']
    expected={extension:source.get('files',{}).get(relative+extension)
              for extension in ('.kicad_pcb','.kicad_pro','.kicad_dru','.kicad_sch')}
    # cli_observation resolves and seals a continued parent before this call.
    # source.json intentionally still describes the canonical CAD snapshot.
    expected['.kicad_pcb']=placement_sha256
    placement=trial.get('placement_input',{})
    if (any(not isinstance(digest,str) or not re.fullmatch(r'[0-9a-f]{64}',digest) for digest in expected.values())
            or not isinstance(placement,dict) or expected['.kicad_pcb']!=placement.get('sha256')):
        raise ValueError('native thermal source lacks the original four-file placement binding')
    captured=recorded_router/'native-thermal-source'/Path(relative+'.kicad_pcb').name
    original=Path(command[2])
    if (snapshot.get('schema')!='iot-lab.native-thermal-source.v1'
            or snapshot.get('original')!=dict(path=str(original),sha256=expected['.kicad_pcb'])
            or snapshot.get('captured')!=dict(path=str(captured),sha256=expected['.kicad_pcb'])
            or snapshot.get('original_files')!={str(original.with_suffix(ext)):digest for ext,digest in expected.items()}
            or snapshot.get('inputs')!={str(captured.with_suffix(ext)):digest for ext,digest in expected.items()}
            or initial.get('source')!=snapshot['captured']
            or not isinstance(initial.get('base'),dict)
            or initial['base'].get('path')!=str(recorded_router/'base.kicad_pcb')
            or final.get('candidate')!=dict(path=str(recorded_router/'routed.kicad_pcb'),sha256=descriptor['sha256'])):
        raise ValueError('native thermal captured source or candidate lineage differs from the actual trial')
    import route_native_thermals
    checked=route_native_thermals.discharge(initial,recorded_router/'routed.kicad_pcb',
        fill_receipt=recorded_router/'native-thermal-final-fill.json',
        drc_receipt=recorded_router/'native-thermal-final-drc.json')
    if checked!=final:
        raise ValueError('native thermal final receipt differs from independent raw-evidence validation')
    for name,digest in checked['inputs'].items():
        if digest is None:
            if Path(name).exists() or Path(name).is_symlink():
                raise ValueError('absent native thermal input appeared')
            evidence.inputs[name]=None
        else:
            evidence.file(name,digest)
    return None


def execution_policy(evidence, folder, trial, manifest, source, gate, candidate=None, placement_sha256=None,
                     *, _verify_acceptance=True):
    name=trial.get('execution_policy')
    if not name:return None,'execution policy/runtime/resource evidence is absent'
    path=(folder/name).resolve()
    if not path.is_relative_to(folder/'operation'):raise ValueError('execution policy must belong to sealed operation evidence')
    value=evidence.read(path)
    if value.get('schema')!=POLICY:raise ValueError('unsupported execution policy receipt')
    runtime,resources,effort=(value.get(key,{}) for key in ('runtime','resources','effort'))
    if (not re.fullmatch(r'sha256:[0-9a-f]{64}',runtime.get('image_id',''))
            or not isinstance(runtime.get('tools'),dict) or not runtime['tools']
            or any(not re.fullmatch(r'[0-9a-f]{64}',v.get('sha256','')) or not v.get('version') for v in runtime['tools'].values())
            or any(not finite(resources.get(k)) or resources[k]<=0 for k in ('cpus','memory_bytes','threads'))
            or any(not finite(effort.get(k)) or effort[k]<=0 for k in ('timeout_s','passes'))
            or not finite(effort.get('max_repairs')) or not effort.get('optimizer')):
        raise ValueError('execution policy lacks actual runtime/resource/effort controls')
    if manifest.get('router')=='fastroute':
        controls=value.get('controls',{})
        if controls.get('effective_configuration_verified') is not True:
            return None,'solver effective execution controls are incomplete or unverified'
        context=value.get('execution_context',{})
        retained=(folder/context.get('path','')).resolve()
        configurations=controls.get('effective_configurations')
        if (not retained.is_relative_to(folder/'operation')
                or not re.fullmatch(r'[0-9a-f]{64}',context.get('sha256',''))
                or not re.fullmatch(r'[0-9a-f]{64}',controls.get('input_manifest_sha256',''))
                or not isinstance(configurations,dict) or not configurations):
            raise ValueError('solver controls lack sealed execution context or effective configuration bindings')
        evidence.file(retained,context['sha256'])
        evidence.file(folder/'operation/router/input-manifest.json',controls['input_manifest_sha256'])
        for name,digest in configurations.items():
            if (not isinstance(name,str) or Path(name).name!=name
                    or not re.fullmatch(r'[0-9a-f]{64}',digest)):
                raise ValueError('solver effective configuration binding is malformed')
            evidence.file(folder/'operation/router'/name,digest)
        if _verify_acceptance:
            missing=native_thermal_controls(evidence,folder,trial,manifest,source,value,candidate,placement_sha256)
            if missing:return None,missing
    events=folder/'operation/events.jsonl'
    starts=[json.loads(line) for line in evidence.file(events).read_text().splitlines() if line.strip()]
    if not any(row.get('type')=='tool.start' and row.get('command')==value.get('command') for row in starts):
        raise ValueError('execution policy command differs from the recorded actual invocation')
    # The claimed budget cannot hide a different actual route spec or tool
    # implementation. Placement poses differ; routing policy must not.
    actual=dict(operation=manifest.get('operation'),kind=manifest.get('kind'),router=manifest.get('router','explicit'),spec=manifest.get('spec'),
        repair_strategy=manifest.get('plan',{}).get('content',{}).get('choice',{}).get('strategy'),
        source_tools={name:digest for name,digest in source.get('files',{}).items() if name.startswith('tools/')},
        gate_tools=gate.get('provenance',{}).get('tools'),gate_policy=manifest.get('gate_config_sha256'),
        configured_checks=sorted(gate.get('checks',{})))
    if (not actual['source_tools'] or not actual['gate_policy'] or (gate and not actual['gate_tools'])):
        return None,'actual source-tool, gate policy or native-tool identities are absent'
    return identity(dict(runtime=runtime,resources=resources,effort=effort,actual=actual)),None


def verified_failed_attempt(evidence, folder, trial, terminal, manifest, source, operation, placement_sha256):
    """Verify an unsuccessful execution, without asserting native acceptance.

    Only finalized controlled Fastroute failures qualify. Prepared, prelaunch,
    cancelled and ambiguous runs remain unknown. The legacy accepted-policy
    fingerprint and all native/quality postconditions are independent.
    """
    result=dict(schema=ATTEMPT,status='unknown',fingerprint=None,qualified=False)
    if terminal.get('status')!='failed' or manifest.get('router')!='fastroute':
        return dict(result,cause='not a finalized failed controlled routing attempt')
    try:
        if (not placement_sha256 or terminal.get('source_unchanged') is not True
                or operation.get('status')!='failed' or terminal.get('cleanup',{}).get('complete') is not True):
            raise ValueError('failed attempt lacks intact source, terminal failure or confirmed cleanup')
        _,missing=execution_policy(evidence,folder,trial,manifest,source,{},
                                  placement_sha256=placement_sha256,_verify_acceptance=False)
        if missing:raise ValueError(missing)
        policy=evidence.read(folder/trial['execution_policy'])
        controls=policy.get('controls',{});effort=policy['effort'];runtime=policy['runtime'];resources=policy['resources']
        code=controls.get('tool_exit');command=policy.get('command')
        if (controls.get('status')!='observed' or type(code) is not int or code==0
                or operation.get('tool_exit')!=code or not isinstance(command,list) or len(command)<4
                or type(operation.get('exit_code')) is not int or operation['exit_code']==0
                or terminal.get('exit_code')!=operation['exit_code']
                or any(not isinstance(item,str) for item in command)):
            raise ValueError('failed attempt lacks finalized observed controls and a matching nonzero tool exit')
        native,recorded_router=Path(command[2]),Path(command[3])
        if not native.is_absolute() or not recorded_router.is_absolute():
            raise ValueError('failed attempt evidence owners are unresolved')
        router=folder/'operation/router'
        def owned(name,expected=None):
            path=Path(name)
            if not path.is_relative_to(recorded_router):raise ValueError('execution evidence escapes its router owner')
            local=(router/path.relative_to(recorded_router)).resolve()
            if not local.is_relative_to(router.resolve()):raise ValueError('execution evidence escapes its archive')
            return evidence.file(local,expected)
        def recorded(name):return str(recorded_router/name)
        spec=manifest.get('spec',{});budget=manifest.get('timeout_s')
        if (not isinstance(spec,dict) or spec.get('schema') not in ('iot-lab.routing-policy.v1','iot-lab.routing-policy.v2')
                or not finite(budget) or budget<=0 or effort.get('timeout_s')!=budget
                or not finite(terminal.get('elapsed_s'))
                or any(spec.get(key)!=effort.get(key) for key in ('passes','max_repairs','optimizer'))
                or spec.get('threads')!=resources['threads'] or spec.get('timeout_s')!=effort.get('router_timeout_s')
                or any(not isinstance(spec.get(key),list) or not spec[key]
                       or any(not isinstance(item,str) or not item for item in spec[key]) for key in ('layers','only_nets'))):
            raise ValueError('failed attempt budget/specification differs from its observed controls')
        relative='hardware-design/boards/'+manifest['board']+'/'+manifest['project']
        inputs=policy.get('inputs',{});files=source.get('files',{})
        expected_files={str(native.with_suffix(ext)):(placement_sha256 if ext=='.kicad_pcb' else files.get(relative+ext))
                        for ext in ('.kicad_pcb','.kicad_sch','.kicad_pro','.kicad_dru')}
        if (any(not isinstance(digest,str) or not re.fullmatch(r'[0-9a-f]{64}',digest)
                or inputs.get(name)!=digest for name,digest in expected_files.items())
                or inputs.get(command[1])!=files.get('tools/fastroute_job.py')
                or not files.get('tools/fastroute_job.py')
                or files.get('hardware-design/boards/'+manifest['board']+'/gate.json')!=manifest.get('gate_config_sha256')):
            raise ValueError('failed attempt source/tool/gate-policy binding differs from the original input')
        context=json.loads(evidence.file(folder/policy['execution_context']['path'],policy['execution_context']['sha256']).read_text())
        if isinstance(context,list) and len(context)==1:context=context[0]
        if not isinstance(context,dict):raise ValueError('failed attempt execution context is ambiguous')
        if isinstance(context.get('HostConfig'),dict):
            host=context['HostConfig']
        else:raise ValueError('failed attempt lacks the original container resource receipt')
        if (context.get('Image')!=runtime['image_id'] or context.get('Id')!=policy['execution_context'].get('container_id')
                or host.get('NetworkMode')!='none' or host.get('Memory')!=resources['memory_bytes']
                or host.get('NanoCpus')!=resources['cpus']*1000000000):
            raise ValueError('failed attempt runtime/resources differ from the retained execution context')
        events=[json.loads(line) for line in evidence.file(folder/'operation/events.jsonl').read_text().splitlines() if line.strip()]
        starts=[row for row in events if row.get('type')=='tool.start' and row.get('command')==command]
        if len(starts)!=1 or not starts[0].get('span_id'):raise ValueError('failed attempt actual launch is missing or ambiguous')
        exits=[row for row in events if row.get('type')=='tool.exit' and row.get('span_id')==starts[0]['span_id']]
        start=starts[0].get('started_unix_s');end=exits[0].get('ended_unix_s') if len(exits)==1 else None
        created=dt.datetime.fromisoformat(manifest['created_at'].replace('Z','+00:00'))
        if (len(exits)!=1 or exits[0].get('code')!=code or exits[0].get('status')!='failed'
                or not created.tzinfo or not finite(start) or not finite(end) or end<start
                or not finite(terminal.get('ended_unix_s')) or not created.timestamp()<=start<=end<=terminal['ended_unix_s']):
            raise ValueError('failed attempt termination is missing, ambiguous or outside its owned run')
        actual=evidence.read(router/'input-manifest.json',controls['input_manifest_sha256'])
        expected=dict(board=str(native),outdir=str(recorded_router),passes=spec['passes'],layers=','.join(spec['layers']),
            only_nets=','.join(spec['only_nets']),threads=spec['threads'],max_time=spec['timeout_s'],optimizer=spec['optimizer'],
            preflight=True,skip_net='',plane_nets='',gnd_vias=False,route_planes=False,unlock_nets='',set=[],neck_um=0)
        thermal=spec.get('thermal_verification')=='native-checkback'
        expected['native_thermal_checkback']=thermal
        backend=effort.get('backend_policy',{})
        if (actual.get('board_sha256')!=placement_sha256 or actual.get('router_sha256')!=runtime['tools'].get('router',{}).get('sha256')
                or backend.get('binary_sha256')!=actual.get('router_sha256')
                or not backend or any(actual.get('configuration',{}).get(key,False if key=='native_thermal_checkback' else None)!=value
                                      for key,value in expected.items())
                or {key:value for key,value in actual.get('features',{}).items() if key!='_board_dir'}!=effort.get('feature_policy')):
            raise ValueError('failed attempt effective input/backend configuration differs from its policy')
        backend_receipt=evidence.read(router/'backend-policy.json')
        if any(backend_receipt.get(key)!=value for key,value in backend.items()):
            raise ValueError('failed attempt backend algorithm differs from its policy')
        stages=[json.loads(line) for line in evidence.file(router/'stages.jsonl').read_text().splitlines() if line.strip()]
        configured=[]
        for name,digest in controls['effective_configurations'].items():
            effective=evidence.read(router/name,digest);cfg=effective.get('configuration',{});worker=effective.get('backend_resources',{})
            if (any(cfg.get(key,False if key=='native_thermal_checkback' else None)!=value for key,value in expected.items())
                    or any(effective.get('backend_policy',{}).get(key)!=value for key,value in backend.items())
                    or any(worker.get(key)!=spec['threads'] for key in ('global_rayon_threads','autorouter_workers','optimizer_workers'))):
                raise ValueError('failed attempt backend stage changed its effective controls')
            invocation=effective.get('command');binding=effective.get('rule_coverage',{})
            coverage=json.loads(owned(binding.get('path',''),binding.get('sha256')).read_text())
            pending=coverage.get('status')=='pending_native'
            if (coverage.get('solver_launch_allowed') is not True
                    or not (coverage.get('status')=='passed' or thermal and pending)
                    or coverage.get('active_nets')!=spec['only_nets'] or coverage.get('job_layers')!=spec['layers']
                    or coverage.get('backend_command')!=invocation
                    or coverage.get('backend_command_sha256')!=identity_command(invocation)):
                raise ValueError('failed attempt backend stage lacks exact rule admission')
            if pending:
                initial=evidence.read(router/'native-thermal-initial.json')
                import route_native_thermals
                checked=route_native_thermals.validate_capability(initial,owned(initial['source']['path']),
                    owned(initial['base']['path']),selected_nets=spec['only_nets'])
                for name,digest in checked['inputs'].items():
                    if digest is None:
                        if Path(name).exists() or Path(name).is_symlink():raise ValueError('absent native admission input appeared')
                        evidence.inputs[name]=None
                    else:evidence.file(name,digest)
                if (initial.get('schema')!='iot-lab.native-thermal-capability.v1' or initial.get('status')!='pending_native'
                        or initial.get('selected_nets')!=sorted(spec['only_nets'])
                        or coverage.get('native_thermal_capability')!=initial or coverage.get('model_status')!='partial'
                        or initial.get('source',{}).get('sha256')!=placement_sha256
                        or coverage.get('native_postconditions')!=[dict(constraint='min_resolved_spokes',
                            required_count=str(initial.get('required_count')),capability_sha256=initial.get('content_sha256'))]):
                    raise ValueError('failed attempt pending rule admission lacks its original native capability')
            dsn=coverage.get('dsn',{})
            owned(dsn.get('path',''),dsn.get('sha256'))
            if (effective.get('dsn_sha256')!=dsn.get('sha256') or not isinstance(invocation,list)
                    or invocation.count('-de')!=1 or invocation.index('-de')+1>=len(invocation)
                    or invocation[invocation.index('-de')+1]!=dsn.get('path')):
                raise ValueError('failed attempt backend did not use its admitted DSN')
            binary=policy.get('environment',{}).get('FASTROUTE_BIN')
            if (not invocation or invocation[0]!=binary or inputs.get(binary)!=actual['router_sha256']
                    or invocation.count('--quality-first')!=int(backend.get('mode')=='quality-first')):
                raise ValueError('failed attempt actual backend executable differs from its recorded runtime')
            def option(key):
                values=[invocation[index+1] for index,item in enumerate(invocation[:-1]) if item==key]
                values.extend(item[len(key)+1:] for item in invocation if item.startswith(key+'='))
                if len(values)!=1:raise ValueError('failed attempt backend option is missing or ambiguous: '+key)
                return values[0]
            if (int(option('-mp'))!=spec['passes'] or float(option('--max-time'))!=spec['timeout_s']
                    or any(int(option(key))!=spec['threads'] for key in
                           ('--router.autorouter.max_threads','--router.optimizer.max_threads'))
                    or spec['optimizer']=='off' and option('--router.optimizer.enabled')!='false'):
                raise ValueError('failed attempt actual backend argv differs from its effort/worker budget')
            configured.append(invocation)
            ran=[row for row in stages if row.get('command')==invocation]
            if (len(ran)!=1 or ran[0].get('status')!='complete' or type(ran[0].get('returncode')) is not int
                    or ran[0].get('cleanup',{}).get('complete') is not True):
                raise ValueError('failed attempt backend launch/termination/cleanup is unconfirmed')
        actual_commands=[row.get('command') for row in stages
            if str(row.get('stage','')).startswith('router') or
            (isinstance(row.get('command'),list) and row['command'] and row['command'][0]==binary
             and row['command']!=[binary,'--help'])]
        if (len(actual_commands)!=len(configured) or
                sorted(map(identity_command,actual_commands))!=sorted(map(identity_command,configured))):
            raise ValueError('failed attempt has unconfigured or duplicate actual backend stages')
        fingerprint=identity(dict(schema=ATTEMPT,runtime=runtime,resources=resources,effort=effort,
            operation=manifest.get('operation'),router=manifest['router'],spec=spec,
            source_tools={name:digest for name,digest in files.items() if name.startswith('tools/')},
            gate_policy=manifest['gate_config_sha256']))
        return dict(result,status='verified',fingerprint=fingerprint,
                    cause='verified execution terminated unsuccessfully; native acceptance remains unproved')
    except (OSError,ValueError,KeyError,TypeError,IndexError,AttributeError,OverflowError) as error:
        return dict(result,cause=str(error))


def identity_command(command):
    # The producer's argv hash uses ordered JSON, unlike object identities.
    import hashlib
    return hashlib.sha256(json.dumps(command,separators=(',',':'),ensure_ascii=True).encode()).hexdigest()


def native_observation(evidence, folder, gate, candidate):
    path=folder/'gate/drc.json'
    if not path.is_file():return None
    raw=evidence.read(path)
    if (candidate is None or raw.get('source')!=candidate.name or raw.get('coordinate_units')!='mm'
            or 'error' not in raw.get('included_severities',[])
            or any(not isinstance(raw.get(k),list) for k in ('violations','unconnected_items','schematic_parity'))
            or any(row.get('severity') not in ('error','warning','exclusion') for row in raw['violations'])
            or gate.get('checks',{}).get('drc',{}).get('status') not in ('passed','failed')):
        raise ValueError('native report is incomplete, unknown or bound to another candidate')
    provenance=gate.get('provenance',{}).get('inputs',[])
    bound=[row for row in provenance if Path(row.get('path','')).name==candidate.name and row.get('sha256')==sha(candidate)]
    if len(bound)!=1:raise ValueError('native gate does not bind exact routed candidate bytes')
    result=dict(errors=sum(row['severity']=='error' for row in raw['violations']),
        warnings=sum(row['severity']=='warning' for row in raw['violations']),
        opens=len(raw['unconnected_items']),parity=len(raw['schematic_parity']))
    for key,metric in (('errors','drc_errors'),('opens','drc_unconnected'),('parity','drc_parity')):
        if gate.get('metrics',{}).get(metric)!=result[key]:raise ValueError('native counts disagree with completed gate metrics')
    return result


def retained_copper(forms):
    """Keep the exact authored copper multiset; zone fill geometry is a cache."""
    copper=[[item for item in form if not (isinstance(item,list) and item
                and item[0] in ('filled_polygon','fill_segments'))] if form[0]=='zone' else form
            for form in forms[1:] if isinstance(form,list) and form
            and form[0] in ('segment','arc','via','zone')]
    # KiCad may reorder standalone items on save. Sort only top-level forms;
    # preserve every authored value, UUID, nested order and duplicate item.
    return sorted(copper,key=lambda form:json.dumps(form,separators=(',',':')))


def routed_quality(evidence, candidate):
    """Measure the already accepted, source-bound final native PCB in millimetres.

    This is the whole candidate's track centreline length and via count, not
    newly routed copper, pad/zone copper, vertical via length or electrical merit.
    Unsupported track geometry invalidates length independently of via count.
    """
    from placer.dru import _tree,_tokens
    path=evidence.file(candidate);expected=evidence.inputs[str(path)]
    result=dict(routed_track_length_mm=None,routed_via_count=None,
                candidate=dict(path=str(path),sha256=expected),
                scope='entire final native candidate; retained copper included; pad/zone and vertical via length excluded',
                units=dict(routed_track_length_mm='mm',routed_via_count='count'),unknowns={})
    names=('routed_track_length_mm','routed_via_count')
    try:
        tokens=_tokens(path.read_text());depth=0
        for token in tokens:
            depth+=(token=='(')-(token==')')
            if depth<0:raise ValueError('unbalanced native PCB')
        if depth:raise ValueError('unbalanced native PCB')
        roots=_tree(tokens)
        if len(roots)!=1 or not roots[0] or roots[0][0]!='kicad_pcb':
            raise ValueError('expected one native PCB')
        forms=roots[0][1:]
        if any(not isinstance(form,list) or not form or not isinstance(form[0],str) for form in forms):
            raise ValueError('malformed native PCB form')
    except (ValueError,IndexError,TypeError) as error:
        result['unknowns']={name:str(error) for name in names}
    else:
        def field(form,key,count):
            values=[item[1:] for item in form[1:] if isinstance(item,list) and item and item[0]==key]
            if len(values)!=1 or len(values[0])!=count or any(not isinstance(value,str) for value in values[0]):
                raise ValueError('missing or malformed '+form[0]+'.'+key)
            return values[0]

        def number(value):
            if not re.fullmatch(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?',value):
                raise ValueError('invalid native numeric coordinate or dimension')
            value=float(value)
            if not math.isfinite(value):raise ValueError('nonfinite native coordinate or dimension')
            return value

        def positive(form,key):
            value=number(field(form,key,1)[0])
            if value<=0:raise ValueError('nonpositive '+form[0]+'.'+key)
            return value

        def point(form,key):return [number(value) for value in field(form,key,2)]
        def copper_layer(value):return bool(re.fullmatch(r'(?:F|B|In[1-9]\d*)\.Cu',value))

        try:
            lengths=[]
            for form in forms:
                if form[0]=='arc':raise ValueError('copper arc centreline measurement is unsupported')
                if form[0]!='segment':continue
                start,end=point(form,'start'),point(form,'end')
                positive(form,'width')
                if not copper_layer(field(form,'layer',1)[0]):raise ValueError('unsupported segment copper layer')
                length=math.hypot(end[0]-start[0],end[1]-start[1])
                if not math.isfinite(length):raise ValueError('nonfinite segment length')
                lengths.append(length)
            length=math.fsum(lengths)
            if not math.isfinite(length):raise ValueError('nonfinite total track length')
            result['routed_track_length_mm']=length
        except (ValueError,OverflowError) as error:
            result['unknowns'][names[0]]=str(error)
        try:
            count=0
            for form in forms:
                if form[0]!='via':continue
                point(form,'at');diameter=positive(form,'size');drill=positive(form,'drill')
                if drill>diameter:raise ValueError('via drill exceeds diameter')
                layers=field(form,'layers',2)
                if layers[0]==layers[1] or not all(copper_layer(value) for value in layers):
                    raise ValueError('unsupported via copper layers')
                count+=1
            result['routed_via_count']=count
        except (ValueError,OverflowError) as error:
            result['unknowns'][names[1]]=str(error)
    # Mutated sealed input is an evidence failure, never merely an unknown metric.
    evidence.file(path,expected)
    return result


def cli_observation(evidence, trial):
    folder,terminal,manifest,operation,candidate=sealed_run(evidence,trial['path'],trial['sha256'])
    if manifest.get('operation') not in ('route','repair') and not (manifest.get('operation')=='edit' and manifest.get('kind')=='route'):
        raise ValueError('trial must measure actual routing/repair, not a proxy or check-only run')
    gate=evidence.read(folder/'gate/result.json') if (folder/'gate/result.json').is_file() else {}
    native=native_observation(evidence,folder,gate,candidate)
    checks=gate.get('checks',{})
    full=bool(terminal['status']=='passed' and operation.get('candidate_verified') is True
        and operation.get('identity_preserved') is True and operation.get('source_unchanged') is True
        and not operation.get('protected_source_changes') and gate.get('exit')==0
        and gate.get('changedDuringRun') is False and not gate.get('preflightErrors')
        and native and all(native[k]==0 for k in ('errors','opens','parity'))
        and checks and all(row.get('status')=='passed' and not row.get('cached') for row in checks.values()))
    if terminal['status']=='passed' and not full:raise ValueError('passed run lacks complete fresh native/configured acceptance')
    source=evidence.read(folder/'operation/source.json') if (folder/'operation/source.json').is_file() else {}
    input_ref=trial.get('placement_input');case_fingerprint=None;unknowns=[]
    input_sha256=None;pose_fingerprint=None
    if input_ref:
        input_path=evidence.file(input_ref['path'],input_ref['sha256'])
        input_sha256=evidence.inputs[str(input_path)]
        relative='hardware-design/boards/'+manifest['board']+'/'+manifest['project']+'.kicad_pcb'
        expected=source.get('files',{}).get(relative)
        if manifest.get('from_run'):
            parent=trial.get('parent_run')
            if not parent:raise ValueError('continued run needs its original sealed placement parent')
            _,_,_,parent_operation,parent_candidate=sealed_run(evidence,parent['path'],parent['sha256'])
            if parent['sha256']!=manifest['from_run']['result_sha256']:raise ValueError('continued input parent differs from the admitted run')
            expected=parent_operation.get('candidate_sha256')
        if expected!=input_sha256:raise ValueError('placement input differs from the original route input')
        from pcb_operations import pcb_identity
        from pcb_search.block_bindings import footprints
        from placer.dru import _tree,_tokens
        copper=retained_copper(_tree(_tokens(input_path.read_text()))[0])
        sidecars={ext:source.get('files',{}).get(relative[:-len('.kicad_pcb')]+ext) for ext in ('.kicad_sch','.kicad_pro','.kicad_dru')}
        if any(not digest for digest in sidecars.values()):unknowns.append('original native sidecar identities are incomplete')
        case_fingerprint=identity(dict(identity=pcb_identity(input_path),retained_copper=copper,sidecars=sidecars))
        canonical=lambda value:str(value.normalize()) if value else '0'
        pose_fingerprint=identity({fp['props']['Reference']:[canonical(fp['pose'][0]),canonical(fp['pose'][1]),
            canonical((fp['pose'][2]%360+360)%360)] for fp in footprints(input_path)})
    else:unknowns.append('original placement input artifact is absent')
    policy,missing=execution_policy(evidence,folder,trial,manifest,source,gate,candidate,input_sha256)
    attempt=verified_failed_attempt(evidence,folder,trial,terminal,manifest,source,operation,
                                   input_sha256 if not unknowns else None)
    acceptance_unknowns=[]
    if missing:
        if attempt['status']=='verified':acceptance_unknowns.append(missing)
        else:
            unknowns.append(missing)
            if terminal['status']=='failed':unknowns.append('failed attempt execution is unverified: '+attempt['cause'])
    quality=(routed_quality(evidence,candidate) if full and policy else
             dict(routed_track_length_mm=None,routed_via_count=None,
                  unknowns={name:'complete fresh native acceptance and verified execution controls are required'
                            for name in ('routed_track_length_mm','routed_via_count')}))
    status=terminal['status'];cause=terminal.get('cause') or operation.get('cause')
    interval=None
    try:
        start=dt.datetime.fromisoformat(manifest['created_at'].replace('Z','+00:00'))
        end=terminal.get('ended_unix_s')
        if start.tzinfo and finite(end) and end>=start.timestamp():interval=[start.timestamp(),end]
    except (KeyError,ValueError,TypeError):pass
    failure=('timeout' if status=='timeout' else 'cancelled' if status=='cancelled' else 'native_errors' if native and native['errors']
             else 'native_parity' if native and native['parity'] else 'routing_opens' if native and native['opens']
             else 'configured_or_electrical_check' if status=='failed' and checks else 'tool_or_preflight' if status!='passed' else None)
    return dict(status=status,evidence_valid=True,board=manifest['board'],run_id=manifest['run_id'],
        evidence_directory=str(folder),failed_checks=sorted(name for name,check in checks.items() if check.get('status')!='passed'),
        full_gate_success=full,native=native,electrical_metrics=gate.get('metrics') or None,routed_quality=quality,
        elapsed_s=terminal.get('elapsed_s') if finite(terminal.get('elapsed_s')) else None,
        observed_interval_unix_s=interval,
        timing_scope='owned route/repair and verification run; unrecorded engineering effort unknown',
        timing=terminal.get('timing'),failure_class=failure,cause=cause,case_fingerprint=case_fingerprint,
        placement_input_sha256=input_sha256,placement_pose_fingerprint=pose_fingerprint,
        policy_fingerprint=policy,execution_attempt=attempt,acceptance_unknowns=acceptance_unknowns,
        unknowns=unknowns,qualified=False)


def archive_observations(evidence, trial):
    folder=(evidence.root/trial['path']).resolve()
    value=placement_audit.archive(folder,trial['sha256'])
    evidence.file(folder/'run.json',trial['sha256'])
    rows=[]
    for row in value['candidates']:
        for name,digest in row['attribution'].items():evidence.file(folder/name,digest)
        rows.append(dict(status='observed',evidence_valid=True,step=row['step'],real_outline=row['real'],native=dict(errors=row['native_errors'],
            opens=row['native_open'],parity=None,warnings=None),full_gate_success=False,elapsed_s=None,
            components=row['components'],proxy_cost=row['cost'],failure_class='native_errors' if row['native_errors'] else 'routing_opens' if row['native_open'] else None,
            case_fingerprint=None,policy_fingerprint=None,unknowns=['legacy archive lacks equal execution controls, full configured acceptance and held-out repetition'],qualified=False))
    return rows


def evaluate_study(root, manifest, study_id=None):
    evidence=Evidence(root);path=(evidence.root/manifest).resolve();blockers=[];rows=[]
    value=evidence.read(path);study_id=study_id or value.get('study_id')
    if value.get('schema')!=STUDY or value.get('study_id')!=study_id:raise ValueError('unknown study schema or identity')
    arms=value.get('arms',[])
    if not isinstance(arms,list) or len(arms)!=2 or len(set(arms))!=2:raise ValueError('study needs distinct baseline/proposal arms')
    development,holdout=(set(value.get(k,[])) for k in ('development_families','holdout_families'))
    if not development or not holdout or development&holdout:blockers.append(dict(code='holdout_not_disjoint',detail='declare nonempty board-family development/holdout sets with no overlap'))
    ids=set();pairs=collections.defaultdict(dict);used_runs=set()
    for trial in value.get('trials',[]):
        base={k:trial.get(k) for k in ('id','arm','split','family','case','replicate')}
        try:
            if (not base['id'] or base['id'] in ids or base['arm'] not in arms or base['split'] not in ('development','holdout')
                    or base['family'] not in (development if base['split']=='development' else holdout)
                    or not base['case'] or not isinstance(base['replicate'],int) or isinstance(base['replicate'],bool) or base['replicate']<1):
                raise ValueError('trial identity, partition or repetition is invalid')
            ids.add(base['id'])
            run_keys=set()
            if trial.get('kind')=='cli_run':
                folder=(evidence.root/trial['path']).resolve()
                run_keys={('folder',str(folder)),('result',trial['sha256'])}
                if run_keys&used_runs:raise ValueError('same sealed run reused as an independent trial')
            observations=(archive_observations(evidence,trial) if trial.get('kind')=='placement_archive'
                          else [cli_observation(evidence,trial)] if trial.get('kind')=='cli_run' else [])
            if not observations:raise ValueError('unknown observation adapter')
            for observation in observations:
                row=dict(base,**observation)
                if trial.get('kind')=='placement_archive':
                    row['id']=str(base['id'])+':step-'+str(row['step'])
                    rows.append(row)
                    blockers.append(dict(code='legacy_observational_only',trial=row['id'],detail='; '.join(row['unknowns'])))
                    continue  # Legacy rows are observations, never controlled paired trials.
                run_keys.add(('manifest',evidence.inputs[str(folder/'run.json')]))
                if run_keys&used_runs:raise ValueError('same sealed run reused as an independent trial')
                key=(base['split'],base['family'],base['case'],base['replicate'])
                if base['arm'] in pairs[key]:raise ValueError('duplicate arm within paired repetition')
                pairs[key][base['arm']]=row
                used_runs.update(run_keys);rows.append(row)
                if row['unknowns']:blockers.append(dict(code='trial_controls_unknown',trial=base['id'],detail='; '.join(row['unknowns'])))
        except (OSError,ValueError,KeyError,TypeError) as error:
            rows.append(dict(base,status='unknown',evidence_valid=False,full_gate_success=False,elapsed_s=None,failure_class='evidence_invalid',cause=str(error),unknowns=[str(error)]))
            blockers.append(dict(code='trial_evidence_invalid',trial=base['id'],detail=str(error)))
    if not rows:blockers.append(dict(code='no_observations',detail='provide actual archived routing/native outcomes'))
    for key,pair in pairs.items():
        if set(pair)!=set(arms):blockers.append(dict(code='unpaired_trial',detail=str(key)))
        elif (not pair[arms[0]].get('case_fingerprint') or pair[arms[0]]['case_fingerprint']!=pair[arms[1]].get('case_fingerprint')
              or not pair[arms[0]].get('policy_fingerprint') or pair[arms[0]]['policy_fingerprint']!=pair[arms[1]].get('policy_fingerprint')):
            blockers.append(dict(code='unequal_case_or_execution',detail=str(key)))
    for split in ('development','holdout'):
        samples=[key for key in pairs if key[0]==split]
        if not samples or any(len({key[3] for key in samples if key[1:3]==case})<2 for case in {key[1:3] for key in samples}):
            blockers.append(dict(code='repetition_missing',detail=split+': paired repeated measurements are absent'))
    fingerprints={split:{r.get('case_fingerprint') for r in rows if r['split']==split and r.get('case_fingerprint')} for split in ('development','holdout')}
    if fingerprints['development']&fingerprints['holdout']:blockers.append(dict(code='holdout_input_overlap',detail='identical electrical/copper source case appears in both partitions'))
    summary={}
    for arm in arms:
        group=[r for r in rows if r['arm']==arm];durations=[r['elapsed_s'] for r in group if finite(r.get('elapsed_s'))]
        summary[arm]=dict(trials=len(group),full_gate_successes=sum(r['full_gate_success'] for r in group),
            unknown_outcomes=sum(not r['evidence_valid'] for r in group),failure_classes=dict(collections.Counter(r['failure_class'] for r in group if r.get('failure_class'))),
            observed_owned_elapsed_s=sum(durations) if durations else None,total_owned_elapsed_s=sum(durations) if len(durations)==len(group) and group else None,
            recorded_run_coverage_s=union_seconds([r['observed_interval_unix_s'] for r in group if r.get('observed_interval_unix_s')]),
            total_recorded_run_coverage_s=(union_seconds([r['observed_interval_unix_s'] for r in group])
                if group and all(r.get('observed_interval_unix_s') for r in group) else None),
            unknown_duration_count=len(group)-len(durations))
    for name,digest in evidence.inputs.items():
        changed=(Path(name).exists() or Path(name).is_symlink()) if digest is None else sha(name)!=digest
        if changed:raise ValueError('study evidence changed during evaluation')
    ready=not blockers
    next_kind=('diagnose_failed_heldout_trials' if ready and any(r['split']=='holdout' and not r['full_gate_success'] for r in rows)
               else 'review_controlled_outcomes' if ready else 'complete_comparison_evidence')
    next_argv=['tools/pcb','outcomes','--json','evaluate',study_id,'--manifest',str(path)]
    if next_kind=='diagnose_failed_heldout_trials':
        failed=next(r for r in rows if r['split']=='holdout' and not r['full_gate_success'])
        next_argv=['tools/pcb','explain','--runs-dir',str(Path(failed['evidence_directory']).parent),failed['run_id'],'--json']
    return dict(schema=REPORT,study_id=study_id,status='passed' if ready else 'blocked',qualified=False,adopt_weights=False,
        observational_ready=any(r['evidence_valid'] for r in rows),comparative_readiness=ready,
        scope='declared historical routing trials only; omitted attempts, current CAD validity and unrecorded engineering effort are unknown',
        holdout_scope='disjoint declared board families and native case identities; unrecorded model-selection access is unknown',
        observations=rows,arms=summary,blockers=blockers,inputs=evidence.inputs,tool_inputs=loaded_tool_inputs(),
        next_action=dict(kind=next_kind,reason=('Diagnose the recorded held-out failures before considering any policy change' if next_kind=='diagnose_failed_heldout_trials'
            else 'Review paired complete native/electrical outcomes before any separate policy decision' if ready else blockers[0]['detail']),
            argv=next_argv))


def study_dependencies(root, manifest):
    report=evaluate_study(root,manifest)
    return {**report['inputs'],**report['tool_inputs']}


def terminal_summary(result, output):
    path=Path(output).resolve()
    return dict(schema=result['schema'],status=result['status'],study_id=result['study_id'],qualified=False,
        observational_ready=result.get('observational_ready',False),comparative_readiness=result.get('comparative_readiness',False),
        adopt_weights=False,blockers=len(result.get('blockers',[])),next_action=result.get('next_action'),
        report=dict(path=str(path),sha256=sha(path)))


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['evaluate']);parser.add_argument('study_id')
    parser.add_argument('--manifest',type=Path,required=True);parser.add_argument('--root',type=Path,default=project_root.root().resolve())
    parser.add_argument('--output',type=Path);parser.add_argument('--json',action='store_true');args=parser.parse_args(argv)
    try:result=evaluate_study(args.root,args.manifest,args.study_id)
    except (OSError,ValueError,KeyError,TypeError) as error:
        result=dict(schema=REPORT,study_id=args.study_id,status='blocked',qualified=False,adopt_weights=False,observational_ready=False,
            comparative_readiness=False,blockers=[dict(code='study_evidence_invalid',detail=str(error))],inputs={},
            next_action=dict(kind='repair_study_evidence',reason=str(error),argv=['tools/pcb','outcomes','--json','evaluate',args.study_id,'--manifest',str(args.manifest)]))
    if args.output:lean.atomic_json(args.output,result)
    shown=terminal_summary(result,args.output) if args.output else result
    print(json.dumps(shown) if args.json else ('PASS' if result['status']=='passed' else 'STUCK')+': '+result['next_action']['reason'])
    return 0 if result['status']=='passed' else 1


if __name__=='__main__':raise SystemExit(main())
