"""Unified engineering adapters reject missing proof and preserve run ownership."""
import hashlib
from importlib.machinery import EXTENSION_SUFFIXES
from fractions import Fraction
import json
import os
from pathlib import Path
import py_compile
import shutil
import socket
import sys
import tempfile
import unittest
from unittest import mock

import pcb_cli
import pcb_cycle
import pcb_operations
import pcb_observation_inputs as inputs
import pcb_routing_trial as routing_trial
import test_pcb_cli as fixtures
import test_pcb_workflow as workflows


class ObservationPolicyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='pcb-observation-inputs-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.tools = self.root / 'tools'
        source = Path(__file__).resolve().parent
        for name in (*inputs.COMMON, 'run_record.py', 'part_evidence.py', 'part_native.py', 'lib/kicad-population.mjs'):
            path = self.tools / name
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / name, path)
        self.launcher = self.root / 'runtime/python3'
        self.launcher.parent.mkdir()
        self.launcher.write_text('An executable identity; collection must not launch it.\n')
        self.launcher.chmod(0o755)
        self.write('test_unrelated.py', 'raise AssertionError("test must not run")\n')
        self.write('unrelated_checker.py', 'raise AssertionError("checker must not run")\n')

    def write(self, name, text):
        path = self.tools / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def collect(self, action='inspect', operation='parts'):
        return inputs.collect(self.root, operation, [action, 'fixture'], str(self.launcher))

    def test_parts_scope_ignores_unrelated_edits_but_keeps_entry_parser_js_and_launcher(self):
        before = self.collect()
        self.assertEqual(before['policy']['mode'], 'audited_parts', before)
        for name in ('part_evidence.py', 'part_native.py', 'lib/kicad-population.mjs'):
            path = self.tools / name
            self.assertEqual(before['files'][str(path)], hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(before['files'][str(self.launcher)], hashlib.sha256(self.launcher.read_bytes()).hexdigest())
        self.write('test_unrelated.py', '# changed test only\n')
        self.write('unrelated_checker.py', '# changed different checker only\n')
        after = self.collect()
        self.assertEqual(before['files'], after['files'])
        self.assertEqual(before['absent'], after['absent'])
        self.assertTrue(inputs.current(before['policy']))
        for name in ('part_evidence.py', 'part_native.py', 'lib/kicad-population.mjs'):
            path = self.tools / name
            original = path.read_bytes()
            with self.subTest(consumed=name):
                path.write_bytes(original + b'\n# changed consumed implementation\n')
                self.assertNotEqual(self.collect()['files'][str(path)], before['files'][str(path)])
            path.write_bytes(original)

    def test_uncertified_local_import_keeps_the_conservative_boundary(self):
        # part_native already imports decimal. A local module can shadow that
        # import without any change to the audited producer's source bytes.
        parser = self.write('decimal.py', 'from evidence_shapes.decoder import decode\nclass Decimal: pass\n')
        self.write('evidence_shapes/__init__.py', 'SCHEMA = 1\n')
        self.write('evidence_shapes/decoder.py', 'def decode(value): return value\n')
        bound = self.collect('verify')
        self.assertEqual(bound['policy']['mode'], 'conservative', bound)
        self.assertIn(str(parser), bound['files'])
        self.assertIn(str(self.tools / 'unrelated_checker.py'), bound['files'])

    def test_new_local_import_candidates_have_absence_bindings(self):
        bound = self.collect('selection')
        self.assertEqual(bound['policy']['mode'], 'audited_parts', bound)
        for name in ('decimal.py', 'decimal/__init__.py', 'json.py', 'json/__init__.py'):
            self.assertIn(str(self.tools / name), bound['absent'])
        new = self.write('decimal.py', 'class Decimal: pass\n')
        fresh = self.collect('selection')
        self.assertEqual(fresh['policy']['mode'], 'conservative', fresh)
        self.assertIn(str(new), fresh['files'])
        self.assertNotIn(str(new), fresh['absent'])

    def test_existing_compiled_import_shadows_force_conservative_scope_and_bind_bytes(self):
        self.assertEqual(self.collect()['policy']['mode'], 'audited_parts')
        source = self.root / 'compiled-source.py'
        source.write_text('class Decimal: pass\n')
        names = ('decimal.pyc', 'decimal' + EXTENSION_SUFFIXES[0], 'decimal/__init__.pyc')
        for name in names:
            with self.subTest(shadow=name):
                path = self.tools / name
                path.parent.mkdir(parents=True, exist_ok=True)
                if path.suffix == '.pyc':
                    py_compile.compile(str(source), cfile=str(path), doraise=True)
                else:
                    path.write_bytes(b'Unsupported local compiled loader candidate\n')
                try:
                    observed = self.collect()
                    self.assertEqual(observed['policy']['mode'], 'conservative', observed)
                    original = observed['files'][str(path)]
                    self.assertEqual(original, hashlib.sha256(path.read_bytes()).hexdigest())
                    path.write_bytes(path.read_bytes() + b'changed candidate bytes')
                    changed = self.collect()
                    self.assertNotEqual(changed['files'][str(path)], original)
                finally:
                    path.unlink()

    def test_unknown_execution_or_operation_keeps_conservative_inventory(self):
        entry = self.tools / 'part_evidence.py'
        original = entry.read_text()
        for mechanism in ("__import__(os.environ['PART_PLUGIN'])", "exec(os.environ['PART_CODE'])",
                          "subprocess.run(['unreviewed-helper'])"):
            with self.subTest(mechanism=mechanism):
                entry.write_text(original + '\n' + mechanism + '\n')
                result = self.collect()
                self.assertEqual(result['policy']['mode'], 'conservative', result)
                self.assertIn(str(self.tools / 'unrelated_checker.py'), result['files'])
                self.assertIn(str(self.tools / 'test_unrelated.py'), result['files'])
        entry.write_text(original)
        # Also exercise the resolver, rather than only the producer's exact
        # audit certificate: a newly imported module can execute more code.
        for mechanism in ("__import__(os.environ['PART_PLUGIN'])", "exec(os.environ['PART_CODE'])",
                          "subprocess.run(['unreviewed-helper'])"):
            with self.subTest(imported_mechanism=mechanism):
                self.write('decimal.py', mechanism + '\nclass Decimal: pass\n')
                result = self.collect()
                self.assertEqual(result['policy']['mode'], 'conservative', result)
                self.assertIn(str(self.tools / 'unrelated_checker.py'), result['files'])
        (self.tools / 'decimal.py').unlink()
        for operation, action in (('parts', 'stock'), ('routing', 'diagnose')):
            with self.subTest(operation=operation, action=action):
                result = self.collect(action, operation)
                self.assertEqual(result['policy']['mode'], 'conservative', result)
                self.assertIn(str(self.tools / 'unrelated_checker.py'), result['files'])
        (self.tools / 'pcb_workflow.py').unlink()
        self.assertEqual(self.collect()['policy']['mode'], 'conservative')

    def test_current_policy_detects_python_resolution_and_environment_changes(self):
        with mock.patch.dict(os.environ, {'PATH': str(self.launcher.parent)}):
            bound = inputs.collect(self.root, 'parts', ['status', 'X'], 'python3')
            self.assertEqual(bound['policy']['mode'], 'audited_parts', bound)
            self.assertTrue(inputs.current(bound['policy']))
            other = self.root / 'different-runtime'
            other.mkdir()
            replacement = other / 'python3'
            replacement.write_text('different resolved Python launcher\n')
            replacement.chmod(0o755)
            with mock.patch.dict(os.environ, {'PATH': str(other)}):
                self.assertFalse(inputs.current(bound['policy']))
            with mock.patch.dict(os.environ, {'PYTHONPATH': str(self.root / 'new-import-root')}):
                self.assertFalse(inputs.current(bound['policy']))
            with mock.patch.dict(os.environ, {'PDFINFO': str(self.root / 'different-pdfinfo')}):
                self.assertFalse(inputs.current(bound['policy']))
            self.write('selectors.py', '# can shadow a common-envelope stdlib import\n')
            self.assertFalse(inputs.current(bound['policy']))
        self.assertFalse(inputs.current({}))
        self.assertFalse(inputs.current(None))



class RoutingTrialTests(unittest.TestCase):
    """Synthetic runtime protocol; separate real-Node gate admission coverage."""
    def setUp(self):
        temporary=tempfile.TemporaryDirectory(prefix='controlled-routing-')
        self.addCleanup(temporary.cleanup);self.root=Path(temporary.name).resolve()
        self.native=self.root/'hardware-design/boards/TRIAL/cad/TRIAL.kicad_pcb'
        self.json_file(self.native.parent.parent/'gate.json',dict(project='cad/TRIAL',checks=dict(drc=True),
            route_features=dict(routing_rules=dict(on=False))))
        self.native.parent.mkdir(parents=True,exist_ok=True)
        for extension in ('.kicad_pcb','.kicad_sch','.kicad_pro','.kicad_dru'):
            self.native.with_suffix(extension).write_text('synthetic protocol input '+extension)
        for name in ('fastroute_job.py','route_features.py','route_rule_coverage.py','route_project_coverage.py','route_hole_coverage.py','route_native_thermals.py','backend_quality.py'):
            path=self.root/'tools'/name;path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text('# synthetic producer identity; never executed\n')
        self.json_file(self.root/'tools/route-features.json',dict(features=dict(routing_rules=dict(on=True,repair_iterations=2))))
        self.executables={}
        for name in ('python','router','kicad'):
            path=self.root/'bin'/name;path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text('synthetic executable identity; version probe is stubbed\n');path.chmod(0o755)
            self.executables[name]=path
        self.context=self.root/'host-context/inspect.json'
        self.context_value=dict(Id='c'*64,Image='sha256:'+'a'*64,Config=dict(Hostname=socket.gethostname()),
            Mounts=[dict(Destination=str(self.context.parent),RW=False)],
            HostConfig=dict(NetworkMode='none',NanoCpus=2000000000,Memory=2147483648))
        self.json_file(self.context,self.context_value)
        environment=dict(PCB_EXECUTION_CONTEXT=str(self.context),PCB_EXECUTION_IMAGE_ID='sha256:'+'b'*64,
            KICAD_PYTHON=str(self.executables['python']),FASTROUTE_BIN=str(self.executables['router']),
            KICAD_CLI=str(self.executables['kicad']),HOME=str(self.root),PATH=os.environ.get('PATH',os.defpath))
        patch=mock.patch.dict(os.environ,environment,clear=True);patch.start();self.addCleanup(patch.stop)
        patch=mock.patch.object(routing_trial,'_cgroups',return_value=dict(cpus=Fraction(2),memory_bytes=2147483648,affinity_cpus=2))
        self.cgroups=patch.start();self.addCleanup(patch.stop)
        def probe(command,env,probes):
            probes.append(dict(command=command,returncode=0,output='synthetic fixture version'))
            return 'synthetic fixture version'
        patch=mock.patch.object(routing_trial,'_probe',side_effect=probe)
        self.probe=patch.start();self.addCleanup(patch.stop)
        patch=mock.patch.object(routing_trial,'_gate_admission',return_value=dict(stage='G4',inputs={}))
        patch.start();self.addCleanup(patch.stop)
        self.config=dict(schema=routing_trial.SCHEMA,layers=['F.Cu','B.Cu'],only_nets=['/A','/B'],
            passes=2,threads=2,timeout_s=8,optimizer='off',max_repairs=0)
        self.counter=0

    def json_file(self,path,value):
        path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value))
        return path

    def prepare(self,config=None):
        self.counter+=1
        return routing_trial.prepare(self.root,self.native,self.root/f'run-{self.counter}/operation/router',
            self.config if config is None else config,20,board='TRIAL')

    def router_output(self,prepared,status='complete',*,coverage_status='passed',solver_launched=True):
        output=Path(prepared['output']);output.mkdir()
        config=prepared['config']
        configuration=dict(board=str(self.native),outdir=str(output),passes=config['passes'],
            layers=','.join(config['layers']),only_nets=','.join(config['only_nets']),threads=config['threads'],
            max_time=config['timeout_s'],optimizer=config['optimizer'],preflight=True,skip_net='',plane_nets='',
            gnd_vias=False,route_planes=False,unlock_nets='',set=[],neck_um=0)
        configuration['native_thermal_checkback'] = config.get('thermal_verification') == 'native-checkback'
        self.json_file(output/'input-manifest.json',dict(configuration=configuration,
            board_sha256=pcb_operations.sha(self.native),router_sha256=pcb_operations.sha(self.executables['router']),
            features=prepared['policy']['effort']['feature_policy']))
        backend_policy=dict(mode='legacy-unverified',qualified=False)
        self.json_file(output/'backend-policy.json',backend_policy)
        # Exercise the receipt protocol, not native/DSN semantic coverage. The
        # real pure coverage checker has its own source/model counterexamples.
        dsn=output/'router-model.dsn';dsn.write_text('(pcb "synthetic receipt protocol model")\n')
        # board.dsn is a replaceable compatibility view; stage evidence and the
        # actual -de argument bind the immutable router-model snapshot instead.
        shutil.copyfile(dsn,output/'board.dsn')
        coverage_inputs=[dsn,self.native,self.native.with_suffix('.kicad_dru'),
            self.native.with_suffix('.kicad_pro'),self.native.parent.parent/'gate.json',
            self.root/'tools/route_rule_coverage.py',self.root/'tools/route_project_coverage.py',
            self.root/'tools/route_features.py']
        backend_command=[str(self.executables['router']),'-de',str(dsn),'-do',str(output/'router.ses')]
        coverage=dict(schema='iot-lab.route-rule-coverage.v1',status=coverage_status,
            solver_launch_allowed=coverage_status in ('passed','pending_native'),qualified=False,
            cause='synthetic admitted coverage' if coverage_status=='passed' else 'RP-001: stitching unsupported',
            active_nets=config['only_nets'],job_layers=config['layers'],requirements=[],
            backend_command=backend_command,
            backend_command_sha256=hashlib.sha256(json.dumps(backend_command,separators=(',',':'),ensure_ascii=True).encode()).hexdigest(),
            inputs={str(p):pcb_operations.sha(p) for p in coverage_inputs},
            dsn=dict(path=str(dsn),sha256=pcb_operations.sha(dsn)))
        coverage_path=self.json_file(output/'rule-coverage.json',coverage)
        if not solver_launched:
            self.json_file(output/'outcome.json',dict(status='blocked',cause=coverage['cause'],
                coverage=str(coverage_path),coverage_sha256=pcb_operations.sha(coverage_path),
                blocked_stage='rest',stage_solver_launched=False,solver_launched=False,qualified=False))
            return output
        self.json_file(output/'effective-configuration.json',dict(configuration=configuration,
            command=backend_command,
            backend_policy=backend_policy,
            dsn_sha256=pcb_operations.sha(dsn),
            rule_coverage=dict(path=str(coverage_path),sha256=pcb_operations.sha(coverage_path)),
            backend_resources=dict(global_rayon_threads=2,autorouter_workers=2,optimizer_workers=2)))
        candidate=output/'routed.kicad_pcb';candidate.write_text('synthetic routed candidate; requires native gate\n')
        self.json_file(output/'outcome.json',dict(status=status,board_sha256=pcb_operations.sha(candidate),optimizer=config['optimizer']))
        return output

    def thermal_output(self):
        config=dict(self.config,schema=routing_trial.THERMAL_SCHEMA,thermal_verification='native-checkback')
        prepared=self.prepare(config)
        output=self.router_output(prepared,coverage_status='pending_native')
        captured=output/'native-thermal-source'/self.native.name
        captured.parent.mkdir()
        originals={}
        copies={}
        for suffix in ('.kicad_pcb','.kicad_pro','.kicad_dru','.kicad_sch'):
            original=self.native.with_suffix(suffix);target=captured.with_suffix(suffix)
            shutil.copyfile(original,target)
            originals[str(original)]=pcb_operations.sha(original);copies[str(target)]=pcb_operations.sha(target)
        self.json_file(output/'native-thermal-source.json',dict(schema='iot-lab.native-thermal-source.v1',
            original=dict(path=str(self.native),sha256=pcb_operations.sha(self.native)),
            captured=dict(path=str(captured),sha256=pcb_operations.sha(captured)),original_files=originals,inputs=copies))
        capability=dict(schema='iot-lab.native-thermal-capability.v1',status='pending_native',required_count=2,
                        content_sha256='a'*64)
        self.json_file(output/'native-thermal-initial.json',capability)
        coverage_path=output/'rule-coverage.json';coverage=json.loads(coverage_path.read_text())
        coverage['native_thermal_capability']=capability
        coverage['model_status']='partial'
        coverage['native_postconditions']=[dict(constraint='min_resolved_spokes',required_count='2',capability_sha256='a'*64)]
        self.json_file(coverage_path,coverage)
        effective_path=output/'effective-configuration.json';effective=json.loads(effective_path.read_text())
        effective['rule_coverage']['sha256']=pcb_operations.sha(coverage_path)
        self.json_file(effective_path,effective)
        final=dict(schema='iot-lab.native-thermal-discharge.v1',status='passed',qualified=False)
        self.json_file(output/'native-thermal-final.json',final)
        return prepared,output,capability,final

    def test_thermal_mode_is_exact_opt_in_and_disables_internal_repairs_before_probes(self):
        for config in (dict(self.config,thermal_verification='native-checkback'),
                       dict(self.config,schema=routing_trial.THERMAL_SCHEMA),
                       dict(self.config,schema=routing_trial.THERMAL_SCHEMA,thermal_verification='ignore')):
            with self.subTest(config=config),self.assertRaises(ValueError):self.prepare(config)
        config=dict(self.config,schema=routing_trial.THERMAL_SCHEMA,thermal_verification='native-checkback')
        prepared=self.prepare(config)
        self.assertIn('--native-thermal-checkback',prepared['command'])
        self.assertEqual(prepared['policy']['effort']['thermal_verification'],'native-checkback')
        self.assertIn(str(self.root/'tools/route_native_thermals.py'),prepared['policy']['inputs'])
        legacy=self.prepare()
        self.assertNotIn('--native-thermal-checkback',legacy['command'])
        self.assertNotIn('thermal_verification',legacy['policy']['effort'])
        gate=self.native.parent.parent/'gate.json';value=json.loads(gate.read_text())
        value['route_features']['routing_rules']['on']=True;self.json_file(gate,value)
        probes=self.probe.call_count
        with self.assertRaisesRegex(ValueError,'internal routing/repair'):self.prepare(config)
        self.assertEqual(self.probe.call_count,probes)

    def test_pending_thermal_mode_requires_revalidated_initial_and_exact_final_discharge(self):
        prepared,output,capability,final=self.thermal_output()
        with mock.patch.object(routing_trial.route_native_thermals,'validate_capability',return_value=capability) as initial, \
             mock.patch.object(routing_trial.route_native_thermals,'discharge',return_value=final) as discharge:
            result=routing_trial.finalize(prepared,returncode=0)
        self.assertEqual(result['status'],'passed')
        initial.assert_called_once_with(capability,output/'native-thermal-source'/self.native.name,output/'base.kicad_pcb',
                                        selected_nets=prepared['config']['only_nets'])
        discharge.assert_called_once_with(capability,output/'routed.kicad_pcb',
            fill_receipt=output/'native-thermal-final-fill.json',drc_receipt=output/'native-thermal-final-drc.json')
        controls=json.loads(Path(prepared['policy_path']).read_text())['controls']
        self.assertEqual(controls['native_thermal_obligations']['status'],'passed')
        self.assertEqual(controls['native_thermal_obligations']['candidate']['sha256'],pcb_operations.sha(output/'routed.kicad_pcb'))

    def test_pending_thermal_receipt_missing_changed_or_invalid_cannot_complete(self):
        for broken in ('initial','final','capability','raw-discharge','final-result','obligation','source-snapshot','source-copy'):
            with self.subTest(broken=broken):
                prepared,output,capability,final=self.thermal_output()
                if broken in ('initial','final'):(output/f'native-thermal-{broken}.json').unlink()
                if broken=='capability':self.json_file(output/'native-thermal-initial.json',dict(capability,required_count=1))
                if broken=='final-result':self.json_file(output/'native-thermal-final.json',dict(final,status='blocked'))
                if broken=='source-snapshot':(output/'native-thermal-source.json').unlink()
                if broken=='source-copy':(output/'native-thermal-source'/self.native.name).write_text('different original')
                if broken=='obligation':
                    path=output/'rule-coverage.json';value=json.loads(path.read_text());value['native_postconditions']=[]
                    self.json_file(path,value)
                    path2=output/'effective-configuration.json';value=json.loads(path2.read_text())
                    value['rule_coverage']['sha256']=pcb_operations.sha(path);self.json_file(path2,value)
                def validate(value,*args,**kwargs):return value
                with mock.patch.object(routing_trial.route_native_thermals,'validate_capability',side_effect=validate), \
                     mock.patch.object(routing_trial.route_native_thermals,'discharge',
                        **({'side_effect':ValueError('raw native thermal evidence invalid')} if broken=='raw-discharge' else {'return_value':final})), \
                     self.assertRaises(ValueError):routing_trial.finalize(prepared,returncode=0)

    def test_v1_cannot_accept_pending_native_coverage(self):
        prepared=self.prepare();self.router_output(prepared,coverage_status='pending_native')
        with self.assertRaisesRegex(ValueError,'without passing rule coverage'):
            routing_trial.finalize(prepared,returncode=0)

    def test_inspect_context_must_match_actual_hostname_mount_and_resource_limits(self):
        observed=routing_trial.execution_context()
        self.assertEqual(observed['image_id'],self.context_value['Image'])
        self.assertEqual(observed['cpus'],2);self.assertEqual(observed['memory_bytes'],2147483648)
        with mock.patch.dict(os.environ,{'PCB_EXECUTION_CONTEXT':''}):
            with self.assertRaisesRegex(ValueError,'host-recorded Docker inspect'):
                self.prepare()
        for change,cause in ((dict(Image='mutable:image-tag'),'immutable actual image'),
                             (dict(Config=dict(Hostname='another-container')),'another container hostname'),
                             (dict(Mounts=[dict(Destination=str(self.context.parent),RW=True)]),'read-only'),
                             (dict(HostConfig=dict(NetworkMode='bridge',NanoCpus=2000000000,Memory=2147483648)),'network-none')):
            with self.subTest(change=change):
                self.json_file(self.context,dict(self.context_value,**change))
                with self.assertRaisesRegex(ValueError,cause):self.prepare()
        self.json_file(self.context,self.context_value)
        for observed in (dict(cpus=Fraction(1),memory_bytes=2147483648),dict(cpus=None,memory_bytes=2147483648)):
            with self.subTest(cgroup=observed):
                self.cgroups.return_value=observed
                with self.assertRaisesRegex(ValueError,'cgroup limits differ'):self.prepare()
        self.probe.assert_not_called()

    def test_prepare_binds_normalized_configuration_and_observed_controls_before_launch(self):
        prepared=self.prepare();command=prepared['command'];policy=prepared['policy']
        self.assertEqual(prepared['config'],self.config);self.assertIsNot(prepared['config'],self.config)
        for name,value in (('--threads','2'),('--max-time','8'),('--passes','2'),('--optimizer','off'),
                           ('--layers','F.Cu,B.Cu'),('--only-nets','/A,/B'),('--skip-net',''),('--plane-nets','')):
            self.assertEqual(command[command.index(name)+1],value)
        self.assertIn('--preflight',command);self.assertFalse(Path(prepared['output']).exists())
        self.assertEqual(policy['runtime']['image_id'],self.context_value['Image'])
        self.assertEqual(policy['resources'],dict(cpus=2,memory_bytes=2147483648,threads=2))
        self.assertEqual(policy['effort']['router_timeout_s'],8)
        self.assertEqual(policy['effort']['timeout_s'],20)
        self.assertFalse(policy['effort']['feature_policy']['routing_rules']['on'])
        for name in ('route_rule_coverage.py','route_project_coverage.py','route_hole_coverage.py'):
            coverage=self.root/'tools'/name
            self.assertEqual(policy['inputs'][str(coverage)],pcb_operations.sha(coverage))
        self.assertFalse(policy['controls']['effective_configuration_verified'])
        self.assertEqual(policy['effort']['backend_policy'],{'mode':'legacy-unverified'})
        self.assertEqual(json.loads(Path(prepared['policy_path']).read_text()),policy)
        self.assertEqual((Path(prepared['output']).parent/'execution-context.json').read_bytes(),self.context.read_bytes())
        self.assertEqual(self.probe.call_count,3)

    def test_out_of_budget_or_unsupported_configuration_fails_before_runtime_probes(self):
        for change,cause in ((dict(threads=3),'CPU quota'),(dict(timeout_s=21),'complete CLI deadline'),
                             (dict(unlock_nets=['/A']),'exactly the routing-policy')):
            with self.subTest(change=change):
                with self.assertRaisesRegex(ValueError,cause):self.prepare(dict(self.config,**change))
        self.probe.assert_not_called()

    def test_actual_gate_validator_rejects_incomplete_or_g3_policy_before_runtime_admission(self):
        core=self.root/'tools/lib/gate-core.mjs';core.parent.mkdir(parents=True)
        shutil.copyfile(Path(routing_trial.__file__).resolve().parent/'lib/gate-core.mjs',core)
        config=self.native.parent.parent/'gate.json'
        with mock.patch.object(routing_trial,'_gate_admission',routing_trial.validate_gate), \
                mock.patch.object(routing_trial,'execution_context') as context:
            with self.assertRaisesRegex(ValueError,'required check disabled or absent: paths'):
                self.prepare()
            self.json_file(config,dict(project='cad/TRIAL',stage='G3',checks=dict(erc=True)))
            with self.assertRaisesRegex(ValueError,'requires a G4 or G5 gate'):
                self.prepare()
            context.assert_not_called();self.probe.assert_not_called()
        self.json_file(config,dict(project='cad/TRIAL',checks=dict(erc=True,drc=True,paths='current-paths.json',
            viapads=dict(allow=[]),kicad_happy={},port_labels=True)))
        admitted=routing_trial.validate_gate(self.root,'TRIAL')
        self.assertEqual(admitted['stage'],'G4')
        self.assertEqual(admitted['inputs'][str(config)],pcb_operations.sha(config))
        self.assertEqual(admitted['inputs'][str(core)],pcb_operations.sha(core))

    def test_finalize_preserves_failure_and_requires_fresh_native_acceptance(self):
        prepared=self.prepare();self.router_output(prepared)
        result=routing_trial.finalize(prepared,returncode=0)
        self.assertEqual(result['status'],'passed');self.assertTrue(result['controls_verified'])
        self.assertTrue(result['native_gate_required']);self.assertFalse(result['qualified'])
        prepared=self.prepare();self.router_output(prepared,'stuck')
        result=routing_trial.finalize(prepared,returncode=3)
        self.assertEqual(result['status'],'failed');self.assertTrue(result['controls_verified'])
        self.assertTrue(Path(result['candidate']).is_file())
        prepared=self.prepare()
        result=routing_trial.finalize(prepared,returncode=124)
        self.assertEqual(result['status'],'failed');self.assertFalse(result['controls_verified'])
        self.assertIsNone(result['candidate'])

    def test_finalize_rejects_output_configuration_tool_and_context_mutations(self):
        for target in ('input-manifest.json','effective-configuration.json','missing-effective',
                       'routed.kicad_pcb','router','coverage-tool','project-coverage-tool','original-context','retained-context'):
            with self.subTest(target=target):
                prepared=self.prepare();output=self.router_output(prepared)
                if target in ('input-manifest.json','effective-configuration.json'):
                    path=output/target;value=json.loads(path.read_text())
                    if target=='input-manifest.json':value['configuration']['threads']=3
                    else:value['backend_resources']['autorouter_workers']=3
                    self.json_file(path,value);original=None
                elif target=='missing-effective':
                    (output/'effective-configuration.json').unlink();original=None;path=None
                else:
                    path=(self.executables['router'] if target=='router' else self.root/'tools/route_rule_coverage.py' if target=='coverage-tool'
                          else self.root/'tools/route_project_coverage.py' if target=='project-coverage-tool'
                          else self.context if target=='original-context'
                          else output.parent/'execution-context.json' if target=='retained-context' else output/target)
                    original=path.read_bytes();path.write_bytes(original+b'changed bytes')
                try:
                    with self.assertRaises(ValueError):routing_trial.finalize(prepared,returncode=0)
                finally:
                    if original is not None:path.write_bytes(original)

    def test_final_command_must_match_project_admission_even_when_receipts_are_resealed(self):
        for target in ('coverage', 'effective', 'missing'):
            with self.subTest(target=target):
                prepared=self.prepare();output=self.router_output(prepared)
                coverage_path=output/'rule-coverage.json';effective_path=output/'effective-configuration.json'
                coverage=json.loads(coverage_path.read_text());effective=json.loads(effective_path.read_text())
                if target=='coverage':
                    coverage['backend_command'].append('--router.min_trace_width_um=1')
                    coverage['backend_command_sha256']=hashlib.sha256(json.dumps(coverage['backend_command'],separators=(',',':'),ensure_ascii=True).encode()).hexdigest()
                elif target=='effective':
                    effective['command'].append('--router.copper_to_edge_clearance_um=1')
                else:
                    del coverage['backend_command'];del coverage['backend_command_sha256']
                self.json_file(coverage_path,coverage)
                effective['rule_coverage']['sha256']=pcb_operations.sha(coverage_path)
                self.json_file(effective_path,effective)
                with self.assertRaisesRegex(ValueError,'command differs from project-rule admission'):
                    routing_trial.finalize(prepared,returncode=0)

    def test_legacy_and_quality_modes_cannot_share_controlled_algorithm_identity(self):
        quality=dict(mode='quality-first',binary_sha256='a'*64,manifest_sha256='b'*64,
                     patch_sha256='c'*64,upstream_commit='d'*40)
        self.assertNotEqual(routing_trial._backend_effort(quality),routing_trial._backend_effort({'mode':'legacy-unverified'}))
        for target in ('stage', 'job', 'flag'):
            with self.subTest(target=target):
                prepared=self.prepare();output=self.router_output(prepared)
                effective_path=output/'effective-configuration.json';effective=json.loads(effective_path.read_text())
                if target=='job':
                    self.json_file(output/'backend-policy.json',quality)
                elif target=='stage':
                    effective['backend_policy']=quality;self.json_file(effective_path,effective)
                else:
                    effective['command'].append('--quality-first');self.json_file(effective_path,effective)
                with self.assertRaisesRegex(ValueError,'backend algorithm'):
                    routing_trial.finalize(prepared,returncode=0)

    def test_finalize_rejects_missing_or_tampered_stage_coverage_seal(self):
        for mutation in ('missing-binding','missing-receipt','tampered-receipt','additional-unsealed-stage'):
            with self.subTest(mutation=mutation):
                prepared=self.prepare();output=self.router_output(prepared)
                effective=output/'effective-configuration.json'
                if mutation in ('missing-binding','additional-unsealed-stage'):
                    value=json.loads(effective.read_text());value.pop('rule_coverage')
                    self.json_file(output/'effective-configuration-fast.json' if mutation=='additional-unsealed-stage' else effective,value)
                elif mutation=='missing-receipt':
                    (output/'rule-coverage.json').unlink()
                else:
                    coverage=output/'rule-coverage.json'
                    value=json.loads(coverage.read_text());value['cause']='changed after stage admission'
                    self.json_file(coverage,value)
                with self.assertRaisesRegex(ValueError,'sealed rule-coverage admission'):
                    routing_trial.finalize(prepared,returncode=0)

    def test_finalize_requires_the_exact_admitted_router_dsn(self):
        for mutation in ('dsn-bytes','effective-dsn-hash'):
            with self.subTest(mutation=mutation):
                prepared=self.prepare();output=self.router_output(prepared)
                if mutation=='dsn-bytes':
                    (output/'router-model.dsn').write_text('(pcb "different actual router model")\n')
                else:
                    path=output/'effective-configuration.json';value=json.loads(path.read_text())
                    value['dsn_sha256']='0'*64;self.json_file(path,value)
                with self.assertRaisesRegex(ValueError,'actual router model'):
                    routing_trial.finalize(prepared,returncode=0)

    def test_compatibility_dsn_replacement_preserves_immutable_stage_binding(self):
        prepared=self.prepare();output=self.router_output(prepared)
        model=output/'router-model.dsn';original=pcb_operations.sha(model)
        (output/'board.dsn').write_text('(pcb "later repair compatibility export")\n')
        result=routing_trial.finalize(prepared,returncode=0)
        self.assertEqual(result['status'],'passed');self.assertTrue(result['controls_verified'])
        self.assertEqual(pcb_operations.sha(model),original)
        self.assertNotEqual(pcb_operations.sha(output/'board.dsn'),original)
        self.assertTrue(result['native_gate_required']);self.assertFalse(result['qualified'])

    def test_actual_command_must_use_exact_admitted_dsn_path_even_with_identical_bytes(self):
        prepared=self.prepare();output=self.router_output(prepared)
        effective=output/'effective-configuration.json';value=json.loads(effective.read_text())
        self.assertEqual(pcb_operations.sha(output/'board.dsn'),value['dsn_sha256'])
        value['command'][value['command'].index('-de')+1]=str(output/'board.dsn')
        self.json_file(effective,value)
        with self.assertRaisesRegex(ValueError,'command does not use its admitted model'):
            routing_trial.finalize(prepared,returncode=0)

    def test_pre_solver_coverage_block_preserves_cause_and_unknown_controls(self):
        prepared=self.prepare()
        output=self.router_output(prepared,coverage_status='blocked',solver_launched=False)
        original=(output/'outcome.json').read_bytes()
        result=routing_trial.finalize(prepared,returncode=4)
        self.assertEqual(result['status'],'failed');self.assertFalse(result['controls_verified'])
        self.assertFalse(result['solver_launched']);self.assertIsNone(result['candidate'])
        self.assertFalse(result['qualified']);self.assertIn('RP-001: stitching unsupported',result['cause'])
        self.assertEqual((output/'outcome.json').read_bytes(),original)
        self.assertFalse((output/'routed.kicad_pcb').exists())
        self.assertFalse(list(output.glob('effective-configuration*.json')))
        policy=json.loads(Path(prepared['policy_path']).read_text())
        self.assertEqual(policy['controls']['status'],'blocked')
        self.assertFalse(policy['controls']['effective_configuration_verified'])
        self.assertFalse(policy['controls']['solver_launched'])
        self.assertEqual(policy['controls']['rule_coverage'][0]['sha256'],pcb_operations.sha(output/'rule-coverage.json'))
        self.assertNotIn('routed_track_length_mm',json.loads(original))
        self.assertNotIn('routed_via_count',json.loads(original))

    def test_later_stage_block_retains_whole_job_solver_history_without_candidate_promotion(self):
        prepared=self.prepare();output=self.router_output(prepared)
        model=output/'router-model-rest.dsn';model.write_text('(pcb "later blocked stage model")\n')
        coverage=json.loads((output/'rule-coverage.json').read_text())
        coverage['inputs'].pop(str(output/'router-model.dsn'))
        coverage['inputs'][str(model)]=pcb_operations.sha(model)
        coverage.update(status='blocked',solver_launch_allowed=False,cause='later stage unsupported',
            dsn=dict(path=str(model),sha256=pcb_operations.sha(model)))
        coverage_path=self.json_file(output/'rule-coverage-rest.json',coverage)
        outcome=self.json_file(output/'outcome.json',dict(status='blocked',cause=coverage['cause'],
            coverage=str(coverage_path),coverage_sha256=pcb_operations.sha(coverage_path),
            blocked_stage='rest',stage_solver_launched=False,solver_launched=True,qualified=False))
        original=outcome.read_bytes()
        result=routing_trial.finalize(prepared,returncode=4)
        self.assertEqual(result['status'],'failed');self.assertFalse(result['controls_verified'])
        self.assertTrue(result['solver_launched']);self.assertIsNone(result['candidate'])
        self.assertTrue((output/'routed.kicad_pcb').is_file())
        self.assertEqual(outcome.read_bytes(),original)
        self.assertFalse(json.loads(original)['stage_solver_launched'])
        self.assertTrue(json.loads(original)['solver_launched'])

    def test_success_exit_cannot_promote_blocked_rule_coverage(self):
        prepared=self.prepare()
        self.router_output(prepared,coverage_status='blocked',solver_launched=False)
        with self.assertRaisesRegex(ValueError,'success contradicts blocked rule coverage'):
            routing_trial.finalize(prepared,returncode=0)

    def test_explicit_route_keeps_the_existing_writer_without_solver_context(self):
        flow=workflows.WorkflowTests();flow.setUp();self.addCleanup(flow.tearDown)
        (flow.root/'tools/pcbtool.py').write_text('import sys\nprint("explicit-route-writer",sys.argv[1],flush=True)\n')
        spec=flow.root/'explicit-routes.json';spec.write_text('{"routes":[]}')
        response=flow.fixture.cli('route','X','--spec',str(spec),'--json',
            env=dict(flow.env,PCB_EXECUTION_CONTEXT=''))
        self.assertEqual(response.returncode,0,response.stdout+response.stderr)
        result=json.loads(response.stdout.splitlines()[-1]);folder=flow.runs/result['run_id']
        self.assertTrue(result['candidate_verified'])
        self.assertIn('explicit-route-writer route',(folder/'operation/route.log').read_text())
        self.assertFalse((folder/'operation/execution-policy.json').exists())


class EngineeringCliTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.PcbCliTests()
        self.fixture.setUp()
        self.root, self.runs = self.fixture.root, self.fixture.runs
        source = Path(__file__).resolve().parent
        for name in ('pcb_cycle.py',):
            shutil.copyfile(source / name, self.root / 'tools' / name)

    def tearDown(self):
        self.fixture.tearDown()

    def test_cycle_cli_records_review_and_requires_integration_owner(self):
        denied = self.fixture.cli('cycle', 'start', 'X', '--json')
        self.assertNotEqual(denied.returncode, 0)
        created = self.fixture.cli('cycle', 'start', 'X', '--owner', 'integrator', '--json')
        self.assertEqual(created.returncode, 0, created.stderr)
        cycle = json.loads(created.stdout)['cycle_id']
        activity = self.fixture.cli('cycle', 'begin', cycle, '--stage', 'schematic', '--owner', 'reviewer',
                                    '--description', 'Review exact pin mappings', '--json')
        self.assertEqual(activity.returncode, 0, activity.stderr)
        activity_id = json.loads(activity.stdout)['activity_id']
        review = self.root / 'review.json'
        review.write_text('{"unresolved":["pin mapping"]}')
        ended = self.fixture.cli('cycle', 'end', cycle, '--activity', activity_id, '--outcome', 'blocked',
                                '--evidence', str(review), '--decision', 'Pin mapping remains unresolved', '--json')
        self.assertEqual(ended.returncode, 0, ended.stderr)
        closed = self.fixture.cli('cycle', 'finish', cycle, '--json')
        self.assertEqual(closed.returncode, 0, closed.stderr)
        self.assertEqual(json.loads(closed.stdout)['stages']['schematic']['blocked'], 1)

    def test_owned_check_is_automatically_linked_and_other_board_rejected(self):
        created = self.fixture.cli('cycle', 'start', 'X', '--owner', 'integrator', '--json')
        cycle = json.loads(created.stdout)['cycle_id']
        checked = self.fixture.cli('check', 'X', '--cycle', cycle, '--json')
        self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
        state = self.fixture.cli('cycle', 'status', cycle, '--json')
        data = json.loads(state.stdout)
        self.assertEqual(data['runs'][0]['stage'], 'verification')
        self.assertTrue(data['runs'][0]['evidence_verified'])
        self.assertIsNotNone(data['covered_elapsed_s'])

    def test_backend_success_without_machine_evidence_is_rejected(self):
        folder = self.root / 'operation-missing-report'
        folder.mkdir(parents=True)
        (folder / 'operation').mkdir()
        (folder / 'run.json').write_text(json.dumps(dict(root=str(self.root), operation='parts',
            board='X', arguments=['status', 'X'])))
        with mock.patch.object(pcb_operations, 'execute', return_value=0):
            with self.assertRaisesRegex(ValueError, 'scoped, unqualified report'):
                pcb_operations.run(folder)

    def test_failed_engineering_report_remains_scoped_and_source_bound(self):
        folder = self.root / 'operation-parts-blocked'
        folder.mkdir(parents=True)
        (folder / 'operation').mkdir()
        (folder / 'run.json').write_text(json.dumps(dict(root=str(self.root), operation='parts',
            board='X', arguments=['status', 'X'])))
        def blocked(*args):
            (folder / 'operation/report.json').write_text(json.dumps(dict(schema='iot-lab.part-evidence.v1',
                status='blocked', qualified=False, inputs={}, blockers=[dict(code='missing_part_review')])) )
            return 1
        with mock.patch.object(pcb_operations, 'execute', side_effect=blocked):
            self.assertEqual(pcb_operations.run(folder), 1)
        result = json.loads((folder / 'operation/result.json').read_text())
        self.assertFalse(result['qualified'])
        self.assertEqual(result['scope'], 'part_evidence')
        self.assertTrue(result['engineering_inputs'])
        self.assertNotIn('candidate_verified', result)

    def test_routing_tool_relative_policy_hashes_use_the_tools_namespace(self):
        folder = self.root / 'operation-routing'
        (folder / 'operation').mkdir(parents=True)
        (folder / 'run.json').write_text(json.dumps(dict(root=str(self.root), operation='routing',
            board='X', arguments=['diagnose', 'X', '--evidence', 'unused-fixture'])))
        policy = (self.root / 'tools/pcb_workflow.py').resolve()
        def diagnosed(*args):
            (folder / 'operation/report.json').write_text(json.dumps(dict(schema='iot-lab.route-decision.v1',
                status='decision', qualified=False, implementation_sha256={'pcb_workflow.py': pcb_operations.sha(policy)})))
            return 0
        with mock.patch.object(pcb_operations, 'execute', side_effect=diagnosed):
            self.assertEqual(pcb_operations.run(folder), 0)
        result = json.loads((folder / 'operation/result.json').read_text())
        self.assertEqual(result['engineering_inputs'][str(policy)], pcb_operations.sha(policy))
        self.assertNotIn(str(self.root / 'pcb_workflow.py'), result['engineering_inputs'])

    def parts_sources(self):
        source = Path(__file__).resolve().parent
        for name in (*inputs.COMMON, 'run_record.py', 'part_evidence.py', 'part_native.py', 'lib/kicad-population.mjs'):
            target = self.root / 'tools' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / name, target)

    def parts_operation(self, name):
        self.parts_sources()
        folder = self.root / name
        (folder / 'operation').mkdir(parents=True)
        (folder / 'run.json').write_text(json.dumps(dict(root=str(self.root), operation='parts',
            board='X', arguments=['status', 'X'])))
        return folder

    def test_parts_policy_keeps_backend_sources_and_absence_without_unrelated_checkers(self):
        folder = self.parts_operation('operation-scoped-parts')
        unrelated = self.root / 'tools/unrelated_checker.py'
        unrelated.write_text('# unrelated checker\n')
        review = self.root / 'review.json'
        review.write_text('{"reviewed":false}\n')
        def blocked(*args):
            (folder / 'operation/report.json').write_text(json.dumps(dict(schema='iot-lab.part-evidence.v1',
                status='blocked', qualified=False, inputs={'review.json': pcb_operations.sha(review)},
                absent_inputs=['optional-review.json'], blockers=[dict(code='missing_part_review')])))
            return 1
        with mock.patch.object(pcb_operations, 'execute', side_effect=blocked):
            self.assertEqual(pcb_operations.run(folder), 1)
        result = json.loads((folder / 'operation/result.json').read_text())
        self.assertEqual(result['engineering_policy']['mode'], 'audited_parts', result)
        self.assertEqual(result['engineering_inputs'][str(review.resolve())], pcb_operations.sha(review))
        self.assertIn(str(self.root.resolve() / 'optional-review.json'), result['engineering_absent_inputs'])
        self.assertIn(str((self.root / 'tools/part_native.py').resolve()), result['engineering_inputs'])
        self.assertNotIn(str(unrelated.resolve()), result['engineering_inputs'])
        self.assertEqual(result['status'], 'failed')
        self.assertFalse(result['qualified'])

    def test_backend_cannot_override_a_bound_parser_hash(self):
        folder = self.parts_operation('operation-conflicting-parser')
        def conflicts(*args):
            (folder / 'operation/report.json').write_text(json.dumps(dict(schema='iot-lab.part-evidence.v1',
                status='blocked', qualified=False, tool_inputs={'tools/part_native.py': '0' * 64})))
            return 1
        with mock.patch.object(pcb_operations, 'execute', side_effect=conflicts):
            with self.assertRaisesRegex(ValueError, 'changed policy input'):
                pcb_operations.run(folder)
        self.assertFalse((folder / 'operation/result.json').exists())

    def test_new_import_shadow_during_backend_execution_cannot_be_sealed(self):
        folder = self.parts_operation('operation-import-race')
        def appeared(*args):
            (self.root / 'tools/decimal.py').write_text('class Decimal: pass\n')
            (folder / 'operation/report.json').write_text(json.dumps(dict(schema='iot-lab.part-evidence.v1',
                status='blocked', qualified=False)))
            return 1
        with mock.patch.object(pcb_operations, 'execute', side_effect=appeared):
            with self.assertRaisesRegex(ValueError, 'absent|appeared|resolution changed'):
                pcb_operations.run(folder)
        self.assertFalse((folder / 'operation/result.json').exists())


class CandidateContinuationTests(unittest.TestCase):
    def setUp(self):
        self.flow = workflows.WorkflowTests()
        self.flow.setUp()

    def tearDown(self):
        self.flow.tearDown()

    def test_continue_candidate_preserves_original_and_adopts_only_final_verified_geometry(self):
        original = self.flow.board / 'cad/X.kicad_pcb'
        (self.flow.root / 'tools/pcbtool.py').write_text('''import json,pathlib,re,sys
p=pathlib.Path(sys.argv[2]);spec=json.loads(pathlib.Path(sys.argv[3]).read_text())
text=p.read_text();prior=re.search(r'\\(at (\\d+) 10\\)',text).group(1)
print('prior_x='+prior,flush=True)
p.write_text(text.replace('(at '+prior+' 10)', '(at '+str(spec['J1'][0])+' 10)',1))
''')
        parent = self.flow.candidate()
        self.flow.spec.write_text('{"J1":[12,10,0]}')
        response = self.flow.fixture.cli('edit', 'X', '--kind', 'place', '--spec', str(self.flow.spec),
            '--from-run', parent.name, '--json', env=self.flow.env)
        self.assertEqual(response.returncode, 0, response.stdout + response.stderr)
        result = json.loads(response.stdout.splitlines()[-1])
        self.assertTrue(result['candidate_verified'])
        child = self.flow.runs / result['run_id']
        self.assertIn('prior_x=11', (child / 'operation/edit.log').read_text())
        self.assertIn('(at 12 10)', Path(result['candidate']).read_text())
        self.assertEqual(original.read_text(), workflows.BOARD)
        with mock.patch.dict(pcb_operations.os.environ, self.flow.env):
            pcb_operations.adopt(self.flow.root, child)
        self.assertIn('(at 12 10)', original.read_text())

    def test_changed_parent_geometry_is_rejected_before_new_candidate_write(self):
        parent = self.flow.candidate()
        result = json.loads((parent / 'result.json').read_text())
        Path(result['candidate']).write_text('mutated parent')
        response = self.flow.fixture.cli('edit', 'X', '--kind', 'place', '--spec', str(self.flow.spec),
            '--from-run', parent.name, '--json', env=self.flow.env)
        self.assertNotEqual(response.returncode, 0)
        self.assertIn('evidence changed', response.stderr + response.stdout)
        self.assertEqual((self.flow.board / 'cad/X.kicad_pcb').read_text(), workflows.BOARD)


if __name__ == '__main__':
    unittest.main()
