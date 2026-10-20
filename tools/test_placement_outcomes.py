"""Evidence mutations, honest unknowns and controlled partition checks; no CAD jobs."""
import copy
import contextlib
import datetime as dt
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock

import placement_outcomes as outcomes
import test_route_native_thermals as thermal_fixtures
from pcb_workflow import sha
from test_engineering_constraints import fp


def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value)+'\n')


class NativeDiagnosticTests(unittest.TestCase):
    def diagnostic(self):
        return dict(violations=[
            dict(type='creepage',severity='error',
                 description="Creepage violation (rule 'PoE isolation' creepage 3.0000 mm; actual 0.4730 mm)",
                 items=[dict(description='Track [/LED_LINK_K] on F.Cu, length 5.2932 mm',
                             pos=dict(x=115.8143,y=127.2951),uuid='first-track'),
                        dict(description='PTH pad 10 [/POE_V2N] of J1',
                             pos=dict(x=117.147333,y=122.715),uuid='fixed-pad')]),
            dict(type='clearance',severity='error',
                 description="Clearance violation (rule 'PoE isolation inside J1' clearance 1.2500 mm; actual 0.4730 mm)",
                 items=[dict(description='PTH pad 10 [/POE_V2N] of J1',
                             pos=dict(x=117.147333,y=122.715),uuid='fixed-pad'),
                        dict(description='Track [/LED_LINK_K] on F.Cu, length 5.2932 mm',
                             pos=dict(x=115.8143,y=127.2951),uuid='first-track')])],
            unconnected_items=[],schematic_parity=[])

    def test_generated_uuids_and_finding_item_order_do_not_change_native_diagnostic(self):
        first=self.diagnostic();original=copy.deepcopy(first);second=copy.deepcopy(first)
        second['violations'].reverse()
        for finding in second['violations']:
            finding['items'].reverse()
            for item in finding['items']:item['uuid']='new-generated-'+item['uuid']
        self.assertEqual(outcomes.native_diagnostic_fingerprint(first),outcomes.native_diagnostic_fingerprint(second))
        self.assertEqual(first,original) # Source objects/CAD identity are never normalized in place.
        for section in ('unconnected_items','schematic_parity'):
            a=self.diagnostic();a[section]=copy.deepcopy(a['violations'])
            b=copy.deepcopy(a);b[section].reverse();b[section][0]['items'].reverse()
            self.assertEqual(outcomes.native_diagnostic_fingerprint(a),outcomes.native_diagnostic_fingerprint(b))

    def test_semantic_numbers_nets_rules_and_meaningful_list_order_remain_distinct(self):
        original=self.diagnostic();base=outcomes.native_diagnostic_fingerprint(original)
        numeric=copy.deepcopy(original);numeric['violations'][0]['items'][0]['pos']['x']+=0.000000000001
        net=copy.deepcopy(original);net['violations'][0]['items'][0]['description']=net['violations'][0]['items'][0]['description'].replace('/LED_LINK_K','/OTHER')
        rule=copy.deepcopy(original);rule['violations'][0]['description']=rule['violations'][0]['description'].replace('PoE isolation','another rule')
        threshold=copy.deepcopy(original);threshold['violations'][0]['description']=threshold['violations'][0]['description'].replace('3.0000','3.0001')
        severity=copy.deepcopy(original);severity['violations'][0]['severity']='warning'
        duplicate=copy.deepcopy(original);duplicate['violations'].append(copy.deepcopy(duplicate['violations'][0]))
        removed=copy.deepcopy(original);removed['violations'].pop()
        section=copy.deepcopy(original);section['schematic_parity'].append(section['violations'].pop())
        for name,value in (('coordinate',numeric),('net',net),('rule',rule),('threshold',threshold),
                           ('severity',severity),('duplicate',duplicate),('removed',removed),('section',section)):
            with self.subTest(change=name):self.assertNotEqual(base,outcomes.native_diagnostic_fingerprint(value))
        nested=self.diagnostic()
        nested['violations'][0]['items'][0]['geometry']={'ordered_path':[dict(x=1,y=2),dict(x=3,y=4)]}
        reversed_path=copy.deepcopy(nested)
        reversed_path['violations'][0]['items'][0]['geometry']['ordered_path'].reverse()
        self.assertNotEqual(outcomes.native_diagnostic_fingerprint(nested),outcomes.native_diagnostic_fingerprint(reversed_path))

    def test_malformed_or_unknown_diagnostic_data_has_no_fallback_fingerprint(self):
        invalid=[None,[],{},dict(self.diagnostic(),extra='unbound report metadata')]
        for section in ('violations','unconnected_items','schematic_parity'):
            value=self.diagnostic();value[section]=None;invalid.append(value)
        for field,value in (('severity','unknown'),('type',None),('description',''),('items',[None]),('items',[])):
            bad=self.diagnostic();bad['violations'][0][field]=value;invalid.append(bad)
        for position in ({'x':True,'y':1},{'x':float('nan'),'y':1},{'x':1,'y':float('inf')},
                         {'x':'unknown','y':1},{'x':1},{'x':1,'y':2,'z':3}):
            bad=self.diagnostic();bad['violations'][0]['items'][0]['pos']=position;invalid.append(bad)
        for value in (123, None):
            bad=self.diagnostic();bad['violations'][0]['items'][0]['uuid']=value;invalid.append(bad)
        for value in (object(),{1:'non-string key'},float('nan'),{'not-a-JSON-set'}):
            bad=self.diagnostic();bad['violations'][0]['metadata']=value;invalid.append(bad)
        circular=self.diagnostic();circular['violations'][0]['metadata']=circular;invalid.append(circular)
        for index,value in enumerate(invalid):
            with self.subTest(case=index),self.assertRaises(ValueError):outcomes.native_diagnostic_fingerprint(value)


class OutcomeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()
        self.study=dict(schema=outcomes.STUDY,study_id='placement-review',arms=['baseline','proposal'],
            development_families=['DEV'],holdout_families=['HOLD'],trials=[])
        self.manifest=self.root/'study.json'

    def run_fixture(self,split,family,arm,replicate,status='passed',controlled=True):
        name=f'{split}-{arm}-{replicate}';folder=self.root/name
        project='native';native_rel=f'hardware-design/boards/{family}/{project}.kicad_pcb'
        native=folder/'workspace'/native_rel
        original=self.root/'inputs'/name/'native.kicad_pcb';original.parent.mkdir(parents=True)
        # Families differ in actual native definition, not merely a dataset label.
        text='(kicad_pcb (version 20260101) '+fp('U1',10 if family=='DEV' else 20,10)+f'(property "family" "{family}"))'
        original.write_text(text);native.parent.mkdir(parents=True);native.write_text(text)
        files={native_rel:sha(original),'tools/pcbtool.py':'c'*64}
        for ext in ('.kicad_sch','.kicad_pro','.kicad_dru'):
            path=native.with_suffix(ext);path.write_text('original '+ext)
            files[native_rel[:-len('.kicad_pcb')]+ext]=sha(path)
        command=['python3','tools/pcbtool.py','route',native_rel,'spec.json']
        manifest=dict(root='/historical/checkout',board=family,project=project,run_id=name,operation='route',
            created_at='2026-10-16T00:00:00Z',spec=dict(route={}),gate_config_sha256='d'*64)
        write(folder/'run.json',manifest)
        write(folder/'operation/source.json',dict(files=files))
        operation=dict(candidate='/historical/checkout/.gate/cli/'+name+'/workspace/'+native_rel,
            workspace='/historical/checkout/.gate/cli/'+name+'/workspace',candidate_sha256=sha(native),
            candidate_verified=status=='passed',identity_preserved=True,source_unchanged=True,
            protected_source_changes=[],status=status,cause='fixture outcome')
        write(folder/'operation/result.json',operation)
        write(folder/'operation/events.jsonl',dict(type='tool.start',command=command))
        errors=1 if status=='failed' else 0
        raw=dict(source=native.name,coordinate_units='mm',included_severities=['error','warning','exclusion'],
            violations=[dict(severity='error')]*errors,schematic_parity=[],unconnected_items=[])
        write(folder/'gate/drc.json',raw)
        metrics=dict(drc_errors=errors,drc_unconnected=0,drc_parity=0,paths_low=0)
        gate=dict(exit=0 if status=='passed' else 1,changedDuringRun=False,preflightErrors=[],metrics=metrics,
            checks=dict(drc=dict(status='passed' if not errors else 'failed',cached=False),paths=dict(status='passed',cached=False)),
            provenance=dict(inputs=[dict(path=native_rel,sha256=sha(native))],tools=dict(kicad='10.0.6')))
        write(folder/'gate/result.json',gate)
        trial=dict(id=name,kind='cli_run',path=str(folder),arm=arm,split=split,family=family,case='fixed-case',replicate=replicate,
            placement_input=dict(path=str(original),sha256=sha(original)))
        if controlled:
            policy=dict(schema=outcomes.POLICY,command=command,
                runtime=dict(image_id='sha256:'+'a'*64,tools=dict(router=dict(sha256='b'*64,version='test fixture'))),
                resources=dict(cpus=2,memory_bytes=2147483648,threads=1),
                effort=dict(timeout_s=30,passes=40,max_repairs=0,optimizer='if-routed'))
            write(folder/'operation/execution-policy.json',policy);trial['execution_policy']='operation/execution-policy.json'
        self.reseal(folder,status)
        trial['sha256']=sha(folder/'result.json');self.study['trials'].append(trial)
        return folder,trial

    def reseal(self,folder,status='passed'):
        operation=json.loads((folder/'operation/result.json').read_text())
        paths=[folder/'run.json']+[p for directory in ('operation','gate') for p in (folder/directory).rglob('*') if p.is_file()]
        if operation.get('candidate'):
            paths.append(folder/'workspace'/Path(operation['candidate']).relative_to(operation['workspace']))
        write(folder/'result.json',dict(status=status,cleanup=dict(complete=True),elapsed_s=2.0,ended_unix_s=1792108802.0,
            cause='fixture '+status,evidence_sha256={str(p.relative_to(folder)):sha(p) for p in paths}))

    def failed_execution_fixture(self,arm='baseline'):
        """Finalized v2 failure before a configured candidate gate; no programs run."""
        folder,trial=self.run_fixture('development','DEV',arm,1,status='failed')
        shutil.rmtree(folder/'gate')
        write(folder/'operation/result.json',dict(status='failed',exit_code=1,tool_exit=1,source_unchanged=True))
        original=Path(trial['placement_input']['path']);router=folder/'operation/router'
        router.mkdir();script='/recorded/tools/fastroute_job.py'
        source=json.loads((folder/'operation/source.json').read_text())
        original.write_text(original.read_text().replace('(kicad_pcb',
            '(kicad_pcb (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 1 "N") '
            '(gr_rect (start 0 0) (end 30 20) (layer "Edge.Cuts"))',1))
        source['files']['hardware-design/boards/DEV/native.kicad_pcb']=sha(original)
        trial['placement_input']['sha256']=sha(original)
        fixture=thermal_fixtures.NativeThermalTests();fixture.root=router
        fixture.source=router/'native-thermal-source/native.kicad_pcb';fixture.source.parent.mkdir()
        fixture.base=router/'base.kicad_pcb'
        fixture.python=router/'recorded-python';fixture.cli=router/'recorded-kicad-cli'
        fixture.python.write_text('synthetic recorded Python identity');fixture.cli.write_text('synthetic recorded KiCad identity')
        for ext in ('.kicad_pcb','.kicad_sch','.kicad_pro','.kicad_dru'):
            if ext=='.kicad_pcb':content=original.read_bytes()
            elif ext=='.kicad_pro':content=json.dumps(dict(board=dict(design_settings=dict(rules=dict(min_resolved_spokes=2),
                    rule_severities=dict(starved_thermal='error'),drc_exclusions=[])))).encode()
            elif ext=='.kicad_dru':content=b'(version 1)\n'
            else:content=b'original schematic\n'
            for target in (original,fixture.source,fixture.base):target.with_suffix(ext).write_bytes(content)
            source['files']['hardware-design/boards/DEV/native'+ext]=sha(original.with_suffix(ext))
        source['files']['tools/fastroute_job.py']='e'*64
        source['files']['hardware-design/boards/DEV/gate.json']='d'*64
        write(folder/'operation/source.json',source)
        run=json.loads((folder/'run.json').read_text())
        spec=dict(schema='iot-lab.routing-policy.v2',layers=['F.Cu'],only_nets=['N'],passes=40,
                  threads=1,timeout_s=30,optimizer='off',max_repairs=0,thermal_verification='native-checkback')
        run.update(router='fastroute',timeout_s=120,spec=spec);write(folder/'run.json',run)
        policy=json.loads((folder/trial['execution_policy']).read_text())
        backend=dict(mode='quality-first',binary_sha256='b'*64,manifest_sha256='f'*64,patch_sha256='1'*64,upstream_commit='2'*40)
        policy.update(command=['/recorded/python',script,str(original),str(router),'--native-thermal-checkback'],
            effort=dict(timeout_s=120,router_timeout_s=30,passes=40,max_repairs=0,optimizer='off',
                        thermal_verification='native-checkback',backend_policy=backend,feature_policy={}),
            inputs={str(original.with_suffix(ext)):digest for ext,digest in
                    [(ext,source['files']['hardware-design/boards/DEV/native'+ext])
                     for ext in ('.kicad_pcb','.kicad_sch','.kicad_pro','.kicad_dru')]})
        policy['inputs'][script]='e'*64
        policy['environment']=dict(FASTROUTE_BIN='/recorded/fastroute')
        policy['inputs']['/recorded/fastroute']='b'*64
        context=folder/'operation/execution-context.json'
        write(context,dict(Id='3'*64,Image=policy['runtime']['image_id'],
            HostConfig=dict(NetworkMode='none',Memory=policy['resources']['memory_bytes'],NanoCpus=2000000000)))
        policy['execution_context']=dict(path='operation/execution-context.json',sha256=sha(context),container_id='3'*64)
        config=dict(board=str(original),outdir=str(router),passes=40,layers='F.Cu',only_nets='N',threads=1,max_time=30,
            optimizer='off',preflight=True,skip_net='',plane_nets='',gnd_vias=False,route_planes=False,
            unlock_nets='',set=[],neck_um=0,native_thermal_checkback=True)
        actual=router/'input-manifest.json'
        write(actual,dict(board_sha256=sha(original),router_sha256='b'*64,configuration=config,features={'_board_dir':'ignored owner path'}))
        dsn=router/'router-model.dsn';dsn.write_text('synthetic source-bound DSN\n')
        invocation=['/recorded/fastroute','-de',str(dsn),'-mp','40','--quality-first','--max-time=30',
            '--router.autorouter.max_threads=1','--router.optimizer.max_threads=1','--router.optimizer.enabled=false']
        fixture.initial_fill,fixture.initial_drc,_=fixture.evidence(fixture.base,'native-thermal-initial',opens=False)
        capability=fixture.admit(selected_nets=['N'])
        write(router/'native-thermal-initial.json',capability)
        coverage=router/'rule-coverage.json'
        write(coverage,dict(status='pending_native',solver_launch_allowed=True,active_nets=['N'],job_layers=['F.Cu'],
            model_status='partial',native_thermal_capability=capability,
            native_postconditions=[dict(constraint='min_resolved_spokes',required_count='2',capability_sha256=capability['content_sha256'])],
            backend_command=invocation,backend_command_sha256=outcomes.identity_command(invocation),
            dsn=dict(path=str(dsn),sha256=sha(dsn))))
        effective=router/'effective-configuration.json'
        write(effective,dict(configuration=config,backend_policy=backend,
            backend_resources=dict(global_rayon_threads=1,autorouter_workers=1,optimizer_workers=1),command=invocation,
            dsn_sha256=sha(dsn),rule_coverage=dict(path=str(coverage),sha256=sha(coverage))))
        write(router/'backend-policy.json',backend)
        write(router/'stages.jsonl',dict(stage='router-screen',command=invocation,status='complete',returncode=0,cleanup=dict(complete=True)))
        policy['controls']=dict(status='observed',effective_configuration_verified=True,tool_exit=1,
            effective_configurations={effective.name:sha(effective)},input_manifest_sha256=sha(actual),
            native_thermal_obligations=dict(status='unfulfilled',cause='native candidate still has an open'))
        write(folder/trial['execution_policy'],policy)
        start=dt.datetime.fromisoformat(run['created_at'].replace('Z','+00:00')).timestamp()
        events=[dict(type='tool.start',span_id='route',command=policy['command'],started_unix_s=start),
                dict(type='tool.exit',span_id='route',code=1,status='failed',ended_unix_s=start+1)]
        (folder/'operation/events.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in events))
        self.reseal_failure(folder,trial)
        return folder,trial

    def reseal_failure(self,folder,trial):
        self.reseal(folder,'failed')
        terminal=json.loads((folder/'result.json').read_text());terminal['source_unchanged']=True
        terminal['exit_code']=1
        write(folder/'result.json',terminal);trial['sha256']=sha(folder/'result.json')

    def test_verified_failed_attempt_separates_execution_from_native_acceptance(self):
        folder,trial=self.failed_execution_fixture()
        with mock.patch.object(outcomes,'routed_quality') as quality:
            row=outcomes.cli_observation(outcomes.Evidence(self.root),trial)
        self.assertEqual(row['execution_attempt']['schema'],outcomes.ATTEMPT)
        self.assertEqual(row['execution_attempt']['status'],'verified')
        self.assertIsNotNone(row['execution_attempt']['fingerprint'])
        self.assertIsNone(row['policy_fingerprint']);self.assertFalse(row['full_gate_success'])
        self.assertIsNone(row['native']);self.assertEqual(row['unknowns'],[])
        self.assertIn('unfulfilled',row['acceptance_unknowns'][0]);quality.assert_not_called()

    def test_failed_execution_control_mutations_remain_unknown(self):
        mutations={
            'unfinalized':('operation/execution-policy.json',lambda v:v['controls'].update(status='prepared')),
            'budget':('operation/execution-policy.json',lambda v:v['effort'].update(timeout_s=119)),
            'runtime':('operation/execution-context.json',lambda v:v.update(Image='sha256:'+'0'*64)),
            'backend':('operation/router/backend-policy.json',lambda v:v.update(binary_sha256='0'*64)),
            'input':('operation/router/input-manifest.json',lambda v:v.update(board_sha256='0'*64)),
            'effective':('operation/router/effective-configuration.json',lambda v:v['configuration'].update(only_nets='OTHER')),
            'admission':('operation/router/rule-coverage.json',lambda v:v.update(solver_launch_allowed=False)),
            'dsn':('operation/router/router-model.dsn',None),
            'launch':('operation/events.jsonl',lambda v:v.update(span_id='unrelated')),
            'prelaunch':('operation/router/stages.jsonl',lambda v:v.update(command=['never launched'])),
            'cleanup':('operation/router/stages.jsonl',lambda v:v.update(cleanup=dict(complete=False))),
            'ambiguous':('operation/router/stages.jsonl',lambda v:v.update(status='running')),
            'extra_stage':('operation/router/stages.jsonl',None),
            'capability':('operation/router/native-thermal-initial.json',None),
            'actual_budget':('operation/router/effective-configuration.json',None),
        }
        for name,(relative,mutate) in mutations.items():
            with self.subTest(change=name):
                folder,trial=self.failed_execution_fixture(arm=name);path=folder/relative
                if name=='dsn':path.write_text('changed DSN\n')
                elif name=='extra_stage':
                    value=json.loads(path.read_text());extra=dict(value,stage='router-extra',command=['/recorded/fastroute','unconfigured'])
                    path.write_text(json.dumps(value)+'\n'+json.dumps(extra)+'\n')
                elif name=='capability':
                    value=json.loads(path.read_text());value['implementation']['roles']['helper']['sha256']='0'*64
                    value['content_sha256']=thermal_fixtures.thermal._identity({k:v for k,v in value.items() if k!='content_sha256'})
                    write(path,value)
                    coverage_path=folder/'operation/router/rule-coverage.json';coverage=json.loads(coverage_path.read_text())
                    coverage['native_thermal_capability']=value
                    coverage['native_postconditions'][0]['capability_sha256']=value['content_sha256'];write(coverage_path,coverage)
                elif name=='actual_budget':
                    value=json.loads(path.read_text());value['command']=[item.replace('--max-time=30','--max-time=60') for item in value['command']]
                    write(path,value)
                    coverage_path=folder/'operation/router/rule-coverage.json';coverage=json.loads(coverage_path.read_text())
                    coverage['backend_command']=value['command'];coverage['backend_command_sha256']=outcomes.identity_command(value['command'])
                    write(coverage_path,coverage)
                    stage_path=folder/'operation/router/stages.jsonl';stage=json.loads(stage_path.read_text())
                    stage['command']=value['command'];write(stage_path,stage)
                elif name=='launch':
                    rows=[json.loads(line) for line in path.read_text().splitlines()]
                    mutate(rows[-1]);path.write_text(''.join(json.dumps(row)+'\n' for row in rows))
                else:
                    value=json.loads(path.read_text());mutate(value);write(path,value)
                # Refresh outer hashes so the semantic guard, not a stale seal,
                # rejects mutations to declared execution controls.
                policy=json.loads((folder/trial['execution_policy']).read_text())
                for control,key in [('operation/router/input-manifest.json','input_manifest_sha256')]:
                    policy['controls'][key]=sha(folder/control)
                policy['execution_context']['sha256']=sha(folder/'operation/execution-context.json')
                policy['controls']['effective_configurations']['effective-configuration.json']=sha(folder/'operation/router/effective-configuration.json')
                effective=json.loads((folder/'operation/router/effective-configuration.json').read_text())
                effective['rule_coverage']['sha256']=sha(folder/'operation/router/rule-coverage.json')
                write(folder/'operation/router/effective-configuration.json',effective)
                policy['controls']['effective_configurations']['effective-configuration.json']=sha(folder/'operation/router/effective-configuration.json')
                write(folder/trial['execution_policy'],policy);self.reseal_failure(folder,trial)
                row=outcomes.cli_observation(outcomes.Evidence(self.root),trial)
                self.assertEqual(row['execution_attempt']['status'],'unknown')
                self.assertIsNone(row['execution_attempt']['fingerprint'])

    def test_failed_execution_does_not_relax_passed_or_missing_source_cleanup(self):
        for name in ('passed','source','cleanup','cancelled','terminal_exit','operation_exit'):
            with self.subTest(change=name):
                folder,trial=self.failed_execution_fixture(arm=name)
                terminal=json.loads((folder/'result.json').read_text())
                if name in ('passed','cancelled'):terminal['status']=name
                elif name=='source':terminal['source_unchanged']=False
                elif name=='cleanup':terminal['cleanup']['complete']=False
                elif name=='terminal_exit':terminal['exit_code']=0
                else:
                    path=folder/'operation/result.json';operation=json.loads(path.read_text());operation['exit_code']=2
                    write(path,operation);self.reseal_failure(folder,trial)
                    terminal=json.loads((folder/'result.json').read_text())
                write(folder/'result.json',terminal);trial['sha256']=sha(folder/'result.json')
                if name in ('passed','cleanup'):
                    with self.assertRaises(ValueError):outcomes.cli_observation(outcomes.Evidence(self.root),trial)
                else:
                    row=outcomes.cli_observation(outcomes.Evidence(self.root),trial)
                    self.assertEqual(row['execution_attempt']['status'],'unknown')

    def thermal_fixture(self,from_parent=False):
        """Synthetic receipts exercise the real consumer; no CAD executable runs."""
        folder,trial=self.run_fixture('development','DEV','baseline',1)
        manifest=json.loads((folder/'run.json').read_text())
        manifest.update(router='fastroute',spec=dict(schema='iot-lab.routing-policy.v2',thermal_verification='native-checkback'))
        write(folder/'run.json',manifest)
        source=json.loads((folder/'operation/source.json').read_text())
        relative='hardware-design/boards/DEV/native'
        original=folder/'workspace'/(relative+'.kicad_pcb')
        if from_parent:
            parent,parent_trial=self.run_fixture('development','DEV','proposal',2)
            text=Path(trial['placement_input']['path']).read_text().replace('(at 10 10)','(at 11 10)',1)
            self.update_native(parent,parent_trial,text)
            Path(trial['placement_input']['path']).write_text(text)
            trial['placement_input']['sha256']=sha(Path(trial['placement_input']['path']))
            original.write_text(text)
            manifest['from_run']=dict(result_sha256=parent_trial['sha256'])
            trial['parent_run']=dict(path=str(parent),sha256=parent_trial['sha256'])
            write(folder/'run.json',manifest)
        router=folder/'operation/router';router.mkdir(parents=True)
        fixture=thermal_fixtures.NativeThermalTests()
        fixture.root=router
        fixture.source=router/'native-thermal-source/native.kicad_pcb'
        fixture.source.parent.mkdir()
        fixture.base=router/'base.kicad_pcb';fixture.final=router/'routed.kicad_pcb'
        fixture.python=router/'recorded-python';fixture.cli=router/'recorded-kicad-cli'
        fixture.python.write_text('synthetic recorded Python binary identity')
        fixture.cli.write_text('synthetic recorded KiCad binary identity')
        write(original.with_suffix('.kicad_pro'),dict(board=dict(design_settings=dict(
            rules=dict(min_resolved_spokes=2),rule_severities=dict(starved_thermal='error'),drc_exclusions=[]))))
        original.with_suffix('.kicad_dru').write_text('(version 1)\n')
        extensions=('.kicad_pcb','.kicad_pro','.kicad_dru','.kicad_sch')
        for extension in extensions:
            if not from_parent or extension!='.kicad_pcb':
                source['files'][relative+extension]=sha(original.with_suffix(extension))
            for path in (fixture.source,fixture.base,fixture.final):
                path.with_suffix(extension).write_bytes(original.with_suffix(extension).read_bytes())
        # The workspace input is promoted after producer finalization. The
        # immutable captured source, not that now-changed alias, owns admission.
        fixture.final.write_text(fixture.final.read_text()+'\n')
        fixture.initial_fill,fixture.initial_drc,_=fixture.evidence(fixture.base,'native-thermal-initial',opens=False)
        fixture.final_fill,fixture.final_drc,fixture.final_report=fixture.evidence(fixture.final,'native-thermal-final',opens=False)
        for receipt in (fixture.initial_fill,fixture.final_fill):
            value=json.loads(receipt.read_text());value['inputs'][str(router/'absent-optional-input')]=None
            write(receipt,value)
        initial=fixture.admit(selected_nets=['N']);final=fixture.discharge(initial)
        write(router/'native-thermal-initial.json',initial)
        write(router/'native-thermal-final.json',final)
        write(router/'native-thermal-source.json',dict(schema='iot-lab.native-thermal-source.v1',qualified=False,
            original=dict(path=str(original),sha256=trial['placement_input']['sha256']),captured=fixture.descriptor(fixture.source),
            original_files={str(original.with_suffix(ext)):sha(fixture.source.with_suffix(ext)) for ext in extensions},
            inputs={str(fixture.source.with_suffix(ext)):sha(fixture.source.with_suffix(ext)) for ext in extensions}))
        original.write_bytes(fixture.final.read_bytes())
        operation=json.loads((folder/'operation/result.json').read_text());operation['candidate_sha256']=sha(original)
        write(folder/'operation/result.json',operation)
        gate=json.loads((folder/'gate/result.json').read_text());gate['provenance']['inputs'][0]['sha256']=sha(original)
        write(folder/'gate/result.json',gate);write(folder/'operation/source.json',source)
        context=folder/'operation/execution-context.json';write(context,dict(fixture='archived host context'))
        effective=router/'effective-configuration.json';write(effective,dict(fixture='observed controls'))
        actual=router/'input-manifest.json';write(actual,dict(fixture='observed input'))
        policy=json.loads((folder/trial['execution_policy']).read_text())
        policy['effort']['thermal_verification']='native-checkback'
        policy['command']=['python3','/recorded/tools/fastroute_job.py',str(original),str(router),'--native-thermal-checkback']
        policy['execution_context']=dict(path='operation/execution-context.json',sha256=sha(context))
        retained=lambda path:dict(path=str(path.relative_to(folder)),sha256=sha(path))
        policy['controls']=dict(effective_configuration_verified=True,
            effective_configurations={effective.name:sha(effective)},input_manifest_sha256=sha(actual),
            native_thermal_obligations=dict(status='passed',initial=retained(router/'native-thermal-initial.json'),
                final=retained(router/'native-thermal-final.json'),source_snapshot=retained(router/'native-thermal-source.json'),
                candidate=retained(fixture.final)))
        write(folder/trial['execution_policy'],policy)
        write(folder/'operation/events.jsonl',dict(type='tool.start',command=policy['command']))
        self.reseal(folder);trial['sha256']=sha(folder/'result.json')
        return folder,trial,fixture,policy

    def test_native_thermal_consumer_reopens_raw_proof_after_workspace_promotion(self):
        folder,trial,fixture,policy=self.thermal_fixture()
        with mock.patch.object(outcomes,'routed_quality',return_value=dict(routed_track_length_mm=1.0,routed_via_count=0)):
            report=self.evaluate();observed=report['observations'][0]
        self.assertTrue(observed['evidence_valid']);self.assertTrue(observed['full_gate_success'])
        self.assertIsNotNone(observed['policy_fingerprint']);self.assertEqual(observed['unknowns'],[])
        self.assertNotEqual(sha(Path(policy['command'][2])),trial['placement_input']['sha256'])
        for path in (fixture.source,fixture.base,fixture.final,fixture.final_report,fixture.cli,fixture.python):
            self.assertEqual(report['inputs'][str(path)],sha(path))
        self.assertIsNone(report['inputs'][str(fixture.root/'absent-optional-input')])

    def test_pending_native_thermal_obligation_cannot_expose_quality_labels(self):
        folder,trial,fixture,policy=self.thermal_fixture()
        policy['controls']['native_thermal_obligations']['status']='pending_native'
        write(folder/trial['execution_policy'],policy);self.reseal(folder);trial['sha256']=sha(folder/'result.json')
        with mock.patch.object(outcomes,'routed_quality') as quality:
            row=outcomes.cli_observation(outcomes.Evidence(self.root),trial)
        quality.assert_not_called();self.assertIsNone(row['policy_fingerprint'])
        self.assertIsNone(row['routed_quality']['routed_track_length_mm'])
        self.assertIn('unfulfilled',row['unknowns'][0])

    def test_native_thermal_continued_placement_binds_the_sealed_parent_not_canonical_cad(self):
        folder,trial,fixture,policy=self.thermal_fixture(from_parent=True)
        source=json.loads((folder/'operation/source.json').read_text())
        self.assertNotEqual(source['files']['hardware-design/boards/DEV/native.kicad_pcb'],trial['placement_input']['sha256'])
        with mock.patch.object(outcomes,'routed_quality',return_value=dict(routed_track_length_mm=1.0,routed_via_count=0)):
            row=outcomes.cli_observation(outcomes.Evidence(self.root),trial)
        self.assertIsNotNone(row['policy_fingerprint']);self.assertEqual(row['unknowns'],[])

    def test_native_thermal_raw_error_is_rejected_even_with_a_resealed_pass_receipt(self):
        folder,trial,fixture,policy=self.thermal_fixture()
        fixture.report_mutation(fixture.final_report,fixture.final_drc,
            lambda raw:raw.update(violations=[dict(type='starved_thermal',severity='error')]))
        self.reseal(folder);trial['sha256']=sha(folder/'result.json')
        report=self.evaluate();row=report['observations'][0]
        self.assertFalse(row['evidence_valid']);self.assertIn('thermal',row['cause'])

    def test_native_thermal_malformed_or_mismatched_bindings_fail_closed(self):
        folder,trial,fixture,original=self.thermal_fixture()
        bad=[]
        for key,value in (('candidate',[]),('initial',dict(path='operation/router/native-thermal-initial.json',sha256=123))):
            policy=copy.deepcopy(original);policy['controls']['native_thermal_obligations'][key]=value;bad.append(policy)
        missing_flag=copy.deepcopy(original);missing_flag['command'].remove('--native-thermal-checkback');bad.append(missing_flag)
        wrong_candidate=copy.deepcopy(original);wrong_candidate['controls']['native_thermal_obligations']['candidate']['sha256']='a'*64;bad.append(wrong_candidate)
        for index,policy in enumerate(bad):
            with self.subTest(case=index):
                write(folder/trial['execution_policy'],policy)
                self.reseal(folder);trial['sha256']=sha(folder/'result.json')
                row=self.evaluate()['observations'][0]
                self.assertFalse(row['evidence_valid']);self.assertFalse(row['full_gate_success'])
        write(folder/trial['execution_policy'],original)
        path=folder/'run.json';manifest=json.loads(path.read_text());manifest['spec']['schema']='iot-lab.routing-policy.v1'
        write(path,manifest);self.reseal(folder);trial['sha256']=sha(folder/'result.json')
        self.assertIn('specification',self.evaluate()['observations'][0]['cause'])
        manifest['spec'].pop('thermal_verification');write(path,manifest)
        hidden=copy.deepcopy(original);hidden['effort'].pop('thermal_verification')
        hidden['controls'].pop('native_thermal_obligations')
        write(folder/trial['execution_policy'],hidden);self.reseal(folder);trial['sha256']=sha(folder/'result.json')
        self.assertIn('explicitly selected',self.evaluate()['observations'][0]['cause'])

    def evaluate(self):
        write(self.manifest,self.study)
        return outcomes.evaluate_study(self.root,self.manifest)

    def controlled_study(self):
        for split,family in (('development','DEV'),('holdout','HOLD')):
            for arm in self.study['arms']:
                for rep in (1,2):self.run_fixture(split,family,arm,rep)

    def update_native(self,folder,trial,text):
        original=Path(trial['placement_input']['path']);original.write_text(text)
        trial['placement_input']['sha256']=sha(original)
        operation_path=folder/'operation/result.json';operation=json.loads(operation_path.read_text())
        relative=Path(operation['candidate']).relative_to(operation['workspace'])
        candidate=folder/'workspace'/relative;candidate.write_text(text)
        operation['candidate_sha256']=sha(candidate);write(operation_path,operation)
        source_path=folder/'operation/source.json';source=json.loads(source_path.read_text())
        source['files'][str(relative)]=sha(original);write(source_path,source)
        gate_path=folder/'gate/result.json';gate=json.loads(gate_path.read_text())
        gate['provenance']['inputs'][0]['sha256']=sha(candidate);write(gate_path,gate)
        self.reseal(folder);trial['sha256']=sha(folder/'result.json')

    def test_zone_fill_cache_does_not_split_the_same_authored_routing_case(self):
        first,a=self.run_fixture('development','DEV','baseline',1)
        second,b=self.run_fixture('development','DEV','proposal',1)
        base=Path(a['placement_input']['path']).read_text()[:-1]
        zone='''(zone (net 1) (net_name "N") (layer "F.Cu") (uuid "zone-1")
            (connect_pads (clearance 0.2)) (fill yes (thermal_gap 0.3))
            (polygon (pts (xy 0 0) (xy 5 0) (xy 5 5) (xy 0 5)))
            CACHE)'''
        self.update_native(first,a,base+zone.replace('CACHE','''
            (filled_polygon (layer "F.Cu") (pts (xy 0 0) (xy 4 0) (xy 4 4)))
            (fill_segments (layer "F.Cu") (pts (xy 0 0) (xy 1 1)))''')+')')
        self.update_native(second,b,base+zone.replace('CACHE','''
            (filled_polygon (layer "F.Cu") (pts (xy 0.1 0) (xy 3 0) (xy 3 3)))''')+')')
        rows=self.evaluate()['observations']
        self.assertTrue(all(row['evidence_valid'] for row in rows))
        self.assertNotEqual(rows[0]['placement_input_sha256'],rows[1]['placement_input_sha256'])
        self.assertEqual(rows[0]['case_fingerprint'],rows[1]['case_fingerprint'])

    def test_authored_zone_and_retained_copper_changes_still_change_case_identity(self):
        first,a=self.run_fixture('development','DEV','baseline',1)
        second,b=self.run_fixture('development','DEV','proposal',1)
        base=Path(a['placement_input']['path']).read_text()[:-1]+'''
            (zone (net 1) (net_name "N") (layer "F.Cu") (uuid "zone-1")
                (connect_pads (clearance 0.2)) (fill yes (thermal_gap 0.3))
                (polygon (pts (xy 0 0) (xy 5 0) (xy 5 5) (xy 0 5))))
            (segment (start 0 0) (end 1 0) (width 0.2) (layer "F.Cu") (net 1))
            (arc (start 1 0) (mid 2 1) (end 3 0) (width 0.2) (layer "F.Cu") (net 1))
            (via (at 1 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1)))'''
        self.update_native(first,a,base)
        for old,new in (('(net 1)','(net 2)'),('zone-1','zone-2'),
                        ('clearance 0.2','clearance 0.3'),('thermal_gap 0.3','thermal_gap 0.4'),
                        ('xy 5 5','xy 5 6'),('(start 0 0)','(start 0.1 0)'),
                        ('(mid 2 1)','(mid 2 2)'),('(at 1 0)','(at 1 0.1)')):
            with self.subTest(changed=old):
                self.update_native(second,b,base.replace(old,new,1))
                rows=self.evaluate()['observations']
                self.assertTrue(all(row['evidence_valid'] for row in rows))
                self.assertNotEqual(rows[0]['case_fingerprint'],rows[1]['case_fingerprint'])

    def test_retained_copper_order_is_irrelevant_but_exact_multiset_is_preserved(self):
        first,a=self.run_fixture('development','DEV','baseline',1)
        second,b=self.run_fixture('development','DEV','proposal',1)
        base=Path(a['placement_input']['path']).read_text()[:-1]
        copper=[
            '(segment (start 0 0) (end 1 0) (width 0.2) (layer "F.Cu") (net 1) (uuid "segment-1"))',
            '(arc (start 1 0) (mid 2 1) (end 3 0) (width 0.2) (layer "F.Cu") (net 1) (uuid "arc-1"))',
            '(via (at 1 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "via-1"))',
            '(via (at 3 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "via-2"))',
        ]
        self.update_native(first,a,base+' '.join(copper)+')')
        self.update_native(second,b,base+' '.join(reversed(copper))+')')
        rows=self.evaluate()['observations']
        self.assertTrue(all(row['evidence_valid'] for row in rows))
        self.assertNotEqual(rows[0]['placement_input_sha256'],rows[1]['placement_input_sha256'])
        self.assertEqual(rows[0]['case_fingerprint'],rows[1]['case_fingerprint'])
        changes={
            'duplicate':copper+[copper[-1]],
            'added':copper+[copper[-1].replace('via-2','via-3')],
            'removed':copper[:-1],
            'uuid_changed':copper[:-1]+[copper[-1].replace('via-2','via-3')],
            'coordinate_changed':copper[:-1]+[copper[-1].replace('(at 3 0)','(at 3.000001 0)')],
            'nested_order_changed':[copper[0].replace('(start 0 0) (end 1 0)','(end 1 0) (start 0 0)')]+copper[1:],
        }
        for name,changed in changes.items():
            with self.subTest(change=name):
                self.update_native(second,b,base+' '.join(changed)+')')
                rows=self.evaluate()['observations']
                self.assertTrue(all(row['evidence_valid'] for row in rows))
                self.assertNotEqual(rows[0]['case_fingerprint'],rows[1]['case_fingerprint'])

    def test_equal_paired_disjoint_trials_allow_review_but_never_weight_adoption(self):
        self.controlled_study();report=self.evaluate()
        self.assertEqual(report['status'],'passed');self.assertTrue(report['comparative_readiness'])
        self.assertFalse(report['qualified']);self.assertFalse(report['adopt_weights'])
        self.assertEqual(report['arms']['baseline']['full_gate_successes'],4)
        self.assertEqual(report['arms']['baseline']['observed_owned_elapsed_s'],8)
        self.assertEqual(report['arms']['baseline']['recorded_run_coverage_s'],2) # Concurrent observations are not summed as wall time.
        self.assertTrue(report['inputs'])
        self.assertEqual(report['tool_inputs'][str(Path(outcomes.__file__).resolve())],sha(outcomes.__file__))

    def test_absent_controls_stay_observational_and_timeout_is_in_denominator(self):
        _,trial=self.run_fixture('development','DEV','baseline',1,status='timeout',controlled=False)
        report=self.evaluate();row=report['observations'][0]
        self.assertTrue(report['observational_ready']);self.assertFalse(report['comparative_readiness'])
        self.assertEqual(row['status'],'timeout');self.assertEqual(row['failure_class'],'timeout')
        self.assertEqual(report['arms']['baseline']['trials'],1)
        self.assertEqual(report['arms']['baseline']['full_gate_successes'],0)
        self.assertIn('trial_controls_unknown',{b['code'] for b in report['blockers']})

    def test_prepared_solver_policy_stays_unknown_and_retains_the_failed_trial(self):
        folder,trial=self.run_fixture('development','DEV','baseline',1,status='timeout')
        manifest=json.loads((folder/'run.json').read_text());manifest['router']='fastroute';write(folder/'run.json',manifest)
        path=folder/trial['execution_policy'];policy=json.loads(path.read_text())
        policy['controls']=dict(status='prepared',effective_configuration_verified=False);write(path,policy)
        self.reseal(folder,'timeout');trial['sha256']=sha(folder/'result.json')
        report=self.evaluate();row=report['observations'][0]
        self.assertTrue(row['evidence_valid']);self.assertEqual(row['failure_class'],'timeout')
        self.assertIsNone(row['policy_fingerprint']);self.assertFalse(report['comparative_readiness'])
        self.assertEqual(report['arms']['baseline']['trials'],1)
        self.assertIn('trial_controls_unknown',{value['code'] for value in report['blockers']})
        context=folder/'operation/execution-context.json';write(context,dict(fixture='archived host context'))
        effective=folder/'operation/router/effective-configuration.json';write(effective,dict(fixture='observed controls'))
        actual=folder/'operation/router/input-manifest.json';write(actual,dict(fixture='observed input'))
        policy['execution_context']=dict(path='operation/execution-context.json',sha256=sha(context))
        policy['controls'].update(effective_configuration_verified=True,
            effective_configurations={effective.name:sha(effective)},input_manifest_sha256=sha(actual))
        write(path,policy);self.reseal(folder,'timeout');trial['sha256']=sha(folder/'result.json')
        self.assertIsNotNone(self.evaluate()['observations'][0]['policy_fingerprint'])
        write(context,dict(fixture='changed host context'))
        self.reseal(folder,'timeout');trial['sha256']=sha(folder/'result.json')
        report=self.evaluate()
        self.assertFalse(report['observations'][0]['evidence_valid'])
        self.assertIn('evidence changed',report['observations'][0]['cause'])

    def test_aliases_and_reformatted_archive_copies_cannot_supply_independent_trials(self):
        folder,original=self.run_fixture('development','DEV','baseline',1)
        alias=self.root/'run-alias';alias.symlink_to(folder,target_is_directory=True)
        archived=self.root/'copied-run';shutil.copytree(folder,archived)
        # Formatting changes its result hash, but not the identity of the
        # original sealed run admission represented by run.json.
        result=archived/'result.json'
        result.write_text(json.dumps(json.loads(result.read_text()),indent=2)+'\n')
        self.assertNotEqual(sha(result),original['sha256'])
        for change in (dict(id='reused-arm',arm='proposal',path=str(alias)),
                       dict(id='reused-replicate',replicate=2,path=str(alias)),
                       dict(id='reformatted-copy',arm='proposal',path=str(archived),sha256=sha(archived/'result.json'))):
            with self.subTest(trial=change['id']):
                duplicate=dict(copy.deepcopy(original),**change)
                self.study['trials']=[original,duplicate]
                report=self.evaluate()
                self.assertFalse(report['comparative_readiness'])
                self.assertEqual(len(report['observations']),2)
                self.assertEqual(sum(row['full_gate_success'] for row in report['observations']),1)
                invalid=report['observations'][1]
                self.assertFalse(invalid['evidence_valid'])
                self.assertEqual(invalid['failure_class'],'evidence_invalid')
                self.assertIn('same sealed run reused',invalid['cause'])
                self.assertEqual(sum(arm['full_gate_successes'] for arm in report['arms'].values()),1)

    def test_distinct_attributed_poses_share_case_identity_without_claiming_comparative_readiness(self):
        _,baseline=self.run_fixture('development','DEV','baseline',1)
        folder,proposal=self.run_fixture('development','DEV','proposal',1)
        original=Path(proposal['placement_input']['path'])
        original.write_text(original.read_text().replace('(at 10 10)','(at 11 10)',1))
        source_path=folder/'operation/source.json';source=json.loads(source_path.read_text())
        relative='hardware-design/boards/DEV/native.kicad_pcb'
        source['files'][relative]=sha(original);write(source_path,source)
        candidate=folder/'workspace'/relative;candidate.write_bytes(original.read_bytes())
        operation_path=folder/'operation/result.json';operation=json.loads(operation_path.read_text())
        operation['candidate_sha256']=sha(candidate);write(operation_path,operation)
        gate_path=folder/'gate/result.json';gate=json.loads(gate_path.read_text())
        gate['provenance']['inputs'][0]['sha256']=sha(candidate);write(gate_path,gate)
        self.reseal(folder);proposal['sha256']=sha(folder/'result.json')
        proposal['placement_input']['sha256']=sha(original)
        report=self.evaluate();a,b=report['observations']
        self.assertTrue(a['evidence_valid']);self.assertTrue(b['evidence_valid'])
        self.assertEqual(a['placement_input_sha256'],baseline['placement_input']['sha256'])
        self.assertEqual(b['placement_input_sha256'],proposal['placement_input']['sha256'])
        self.assertNotEqual(a['placement_input_sha256'],b['placement_input_sha256'])
        self.assertNotEqual(a['placement_pose_fingerprint'],b['placement_pose_fingerprint'])
        self.assertEqual(a['case_fingerprint'],b['case_fingerprint'])
        self.assertEqual(a['policy_fingerprint'],b['policy_fingerprint'])
        self.assertTrue(report['observational_ready']);self.assertFalse(report['comparative_readiness'])
        self.assertFalse(report['adopt_weights']);self.assertFalse(report['qualified'])
        self.assertEqual({row['code'] for row in report['blockers']},{'repetition_missing'})

    def test_rehashed_trial_pointer_does_not_hide_a_tampered_native_report(self):
        folder,trial=self.run_fixture('development','DEV','baseline',1)
        path=folder/'gate/drc.json';raw=json.loads(path.read_text());raw['unconnected_items']=[dict(type='open')];write(path,raw)
        trial['sha256']=sha(folder/'result.json')
        report=self.evaluate()
        self.assertEqual(report['observations'][0]['failure_class'],'evidence_invalid')
        self.assertFalse(report['comparative_readiness'])

    def test_policy_mismatch_and_holdout_leakage_block_comparison(self):
        self.controlled_study();trial=self.study['trials'][-1];folder=Path(trial['path'])
        path=folder/trial['execution_policy'];policy=json.loads(path.read_text());policy['resources']['threads']=8;write(path,policy)
        self.reseal(folder);trial['sha256']=sha(folder/'result.json')
        report=self.evaluate();self.assertIn('unequal_case_or_execution',{b['code'] for b in report['blockers']})
        self.study['holdout_families']=['DEV']
        report=self.evaluate();self.assertIn('holdout_not_disjoint',{b['code'] for b in report['blockers']})

    def test_equal_claimed_policy_cannot_hide_different_actual_route_spec(self):
        self.controlled_study();trial=self.study['trials'][-1];folder=Path(trial['path'])
        path=folder/'run.json';original=json.loads(path.read_text());manifest=copy.deepcopy(original)
        manifest['spec']['route']['passes']=900;write(path,manifest)
        self.reseal(folder);trial['sha256']=sha(folder/'result.json')
        self.assertIn('unequal_case_or_execution',{b['code'] for b in self.evaluate()['blockers']})
        original['router']='fastroute';write(path,original)
        self.reseal(folder);trial['sha256']=sha(folder/'result.json')
        self.assertIn('unequal_case_or_execution',{b['code'] for b in self.evaluate()['blockers']})

    def test_failed_heldout_trials_are_counted_and_request_diagnosis(self):
        self.controlled_study();trial=self.study['trials'][-1];folder=Path(trial['path'])
        operation=json.loads((folder/'operation/result.json').read_text());operation['candidate_verified']=False;write(folder/'operation/result.json',operation)
        gate=json.loads((folder/'gate/result.json').read_text());gate['exit']=1;gate['metrics']['drc_errors']=1;gate['checks']['drc']['status']='failed';write(folder/'gate/result.json',gate)
        native=json.loads((folder/'gate/drc.json').read_text());native['violations']=[dict(severity='error')];write(folder/'gate/drc.json',native)
        self.reseal(folder,'failed');trial['sha256']=sha(folder/'result.json')
        report=self.evaluate()
        self.assertTrue(report['comparative_readiness'])
        self.assertEqual(report['arms']['proposal']['full_gate_successes'],3)
        self.assertEqual(report['arms']['proposal']['failure_classes']['native_errors'],1)
        self.assertEqual(report['next_action']['kind'],'diagnose_failed_heldout_trials')

    def test_original_placement_not_current_canonical_must_match_the_recorded_route_input(self):
        _,trial=self.run_fixture('development','DEV','baseline',1)
        path=Path(trial['placement_input']['path']);path.write_text(path.read_text().replace('(at 10 10)','(at 11 10)'))
        trial['placement_input']['sha256']=sha(path)
        report=self.evaluate()
        self.assertIn('original route input',report['observations'][0]['cause'])

    def test_incomplete_electrical_gate_and_unknown_native_severity_cannot_pass(self):
        folder,trial=self.run_fixture('development','DEV','baseline',1)
        path=folder/'gate/result.json';gate=json.loads(path.read_text());gate['checks']['paths']['status']='blocked';write(path,gate)
        self.reseal(folder);trial['sha256']=sha(folder/'result.json')
        report=self.evaluate();self.assertFalse(report['observations'][0]['evidence_valid'])
        path=folder/'gate/drc.json';raw=json.loads(path.read_text());raw['violations']=[dict(severity='unknown')];write(path,raw)
        self.reseal(folder);trial['sha256']=sha(folder/'result.json')
        self.assertIn('native report',self.evaluate()['observations'][0]['cause'])

    def test_saved_large_inventory_has_compact_stdout_and_full_json_without_output(self):
        full=dict(schema=outcomes.REPORT,study_id='large-study',status='blocked',qualified=False,adopt_weights=False,
            observational_ready=True,comparative_readiness=False,blockers=[dict(code='controls_unknown')],
            next_action=dict(kind='complete_comparison_evidence',reason='Record equal controls',argv=['tools/pcb','outcomes']),
            inputs={'/observed/source-'+str(i):'a'*64 for i in range(5000)})
        output=self.root/'full-report.json';captured=io.StringIO()
        arguments=['evaluate','large-study','--manifest',str(self.manifest),'--json']
        with mock.patch.object(outcomes,'evaluate_study',return_value=full),contextlib.redirect_stdout(captured):
            code=outcomes.main(arguments+['--output',str(output)])
        self.assertEqual(code,1);self.assertEqual(json.loads(output.read_text()),full)
        printed=json.loads(captured.getvalue());self.assertNotIn('inputs',printed);self.assertEqual(printed['blockers'],1)
        self.assertEqual(printed['report'],dict(path=str(output),sha256=sha(output)))
        self.assertLess(len(captured.getvalue()),2000)
        captured=io.StringIO()
        with mock.patch.object(outcomes,'evaluate_study',return_value=full),contextlib.redirect_stdout(captured):outcomes.main(arguments)
        self.assertEqual(json.loads(captured.getvalue()),full)


if __name__=='__main__':unittest.main()
