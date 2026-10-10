"""Actual scheduler and captured immutable receipt counterexamples; no pcbnew."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import unittest
import ast
import contextlib
import io
import math
import shlex
import shutil
import subprocess
import sys
import tempfile
import types
from unittest import mock
import mandatory_preflight as mp

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('failfast_compact', HERE/'placer/compact.py')
compact = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compact)


class ImmutableReceiptTests(unittest.TestCase):
    def test_actual_captured_four_cc_fault_subset_is_valid_locked_evidence(self):
        fixture=json.loads((HERE/'test-fixtures/mandatory-cc-774.json').read_text())
        self.assertEqual(len(fixture['faults']),4)
        self.assertEqual(fixture['preserved_pair_profile']['expected_vias'],{'p':0,'n':1})
        fatal=mp.locked_faults(fixture,fixture['board_sha256'],fixture['source_records'],fixture,fixture['policy_sources'])
        self.assertEqual(fatal,fixture['faults'])
        # Receipt's original policy revision is bound; do not relabel it as a
        # native execution of the newly integrated SI configuration.
        changed=copy.deepcopy(fixture);changed['policy_sources']['changed']='new'
        self.assertEqual(mp.locked_faults(changed,fixture['board_sha256'],fixture['source_records'],fixture,changed['policy_sources']),[])
    def setUp(self):
        self.rows = [dict(uuid='owned', net='/J1_CC1', layer='In2.Cu', via=False, kind='PCB_TRACK', locked=True,
                          geometry=[[1,2],[3,4]], width=150000)]
        self.fault = dict(uuid='owned', net='/J1_CC1', layer='In2.Cu', source_locked=True,
                          reason='not explicitly eligible for mixed layer',
                          preservation='locked or retained by this invocation')
        self.seed = dict(board_sha256='seed', qualified=False, source_records=self.rows,
                         faults=[self.fault], policy_sources={'/seed/BASE-PWR-B.kicad_pro':'project','/rules':'rules'},
                         board_identity={'board':'BASE-PWR-B','source_project':'/seed/BASE-PWR-B.kicad_pro'},
                         preserved_pair_profile={'board':'BASE-PWR-B','p':'/USB_DP','n':'/USB_DN','expected_vias':{'p':0,'n':1}},
                         routed_nets=['/J1_CC1'], unlock_nets='')
        self.child = copy.deepcopy(self.seed)
        self.child['board_sha256'] = 'actual-child'
        self.child['board_identity']['source_project']='/child/BASE-PWR-B.kicad_pro'
        self.child['policy_sources']={'/child/BASE-PWR-B.kicad_pro':'project','/rules':'rules'}
    def validate(self, receipt=None, rows=None, seed=None, policies=None):
        r=self.child if receipt is None else receipt
        return mp.locked_faults(r,'actual-child',self.rows if rows is None else rows,
                               self.seed if seed is None else seed,
                               r['policy_sources'] if policies is None else policies)
    def test_exact_candidate_with_unchanged_owned_source_is_fatal(self):
        self.assertEqual(self.validate(),[self.fault])
    def test_stale_digest_not_fatal(self):
        self.child['board_sha256']='stale';self.assertEqual(self.validate(),[])
    def test_current_policy_bytes_mismatch_not_fatal(self):
        self.assertEqual(self.validate(policies={'/rules':'different'}),[])
    def test_current_and_child_changed_policy_cannot_replace_seed(self):
        self.child['policy_sources']['/rules']='different';self.assertEqual(self.validate(),[])
    def test_unlocked_source_cannot_globally_stop(self):
        self.seed['source_records'][0]['locked']=False;self.assertEqual(self.validate(),[])
    def test_changed_candidate_lock_cannot_globally_stop(self):
        rows=copy.deepcopy(self.rows);rows[0]['locked']=False;self.assertEqual(self.validate(rows=rows),[])
    def test_changed_candidate_geometry_cannot_globally_stop(self):
        rows=copy.deepcopy(self.rows);rows[0]['geometry'][0][0]+=1;self.assertEqual(self.validate(rows=rows),[])
    def test_forged_reported_geometry_cannot_globally_stop(self):
        self.child['source_records'][0]['width']+=1;self.assertEqual(self.validate(),[])
    def test_changed_uuid_or_net_or_reason_or_preservation_cannot_mint_stop(self):
        for key,value in [('uuid','unowned'),('net','different'),('reason','invented'),('source_locked',False),('preservation','invented')]:
            receipt=copy.deepcopy(self.child);receipt['faults'][0][key]=value
            with self.subTest(key=key):self.assertEqual(self.validate(receipt=receipt),[])
    def test_selection_and_usb_profile_identity_are_bound(self):
        for key,value in [('unlock_nets','/J1_CC1'),('routed_nets',[]),('preserved_pair_profile',{'expected_vias':{'p':1,'n':1}})]:
            receipt=copy.deepcopy(self.child);receipt[key]=value
            with self.subTest(key=key):self.assertEqual(self.validate(receipt=receipt),[])
    def test_pair_fault_without_protected_uuid_is_not_global(self):
        self.child['faults']=[dict(pair='USB',reason='accepted preserved USB via profile mismatch',p=1,n=1,
                                 via_uuids={'/USB_DP':['v']},preservation='both pair nets excluded from routing')]
        self.assertEqual(self.validate(),[])
    def test_missing_malformed_and_duplicate_source_records_do_not_mint_stop(self):
        for field,value in [('faults',None),('faults',['invalid']),('source_records',[self.rows[0],self.rows[0]]),('board_identity',{})]:
            receipt=copy.deepcopy(self.child);receipt[field]=value
            with self.subTest(field=field):self.assertEqual(self.validate(receipt=receipt),[])
    def test_changed_owner_project_identity_never_mints_global_stop(self):
        self.child['board_identity']['owner_project_sha256']='different'
        self.assertEqual(self.validate(),[])
    def test_unsupported_arc_cannot_claim_complete_geometry_from_endpoints(self):
        self.rows[0]['kind']='PCB_ARC'
        self.assertEqual(self.validate(),[])


class SchedulerImmutableTests(unittest.TestCase):
    def test_prior_virtual_success_cannot_survive_later_outline_immutable_failure(self):
        pr={'units':[dict(name='A',refs=['A'],fixed=True,x=5,y=5,rects=[[-5,-5,5,5,2]])],
            'nets':[],'board':{'outline':[[0,0],[10,0],[10,10],[0,10]],'keepouts':[],'edge_clearance':0}}
        def search(q,n):return {'candidates':[dict(cost=1,illegal=[],pose=[])]}
        def route(path,n):
            if n==0:return [0]
            if path < compact.board_scale(compact.with_halos(pr,4)):
                raise mp.ImmutableInputFailure({'faults':[{'uuid':'owned'}]},'later-receipt.json')
            return [3]
        result=compact.run_loop(pr,(10,10),search,lambda q,p,k,n:k,route,budget=60)
        self.assertTrue(result['steps'][0]['passed'])
        self.assertEqual(result['steps'][-1]['phase'],'outline')
        self.assertEqual(result['steps'][-1]['status'],'immutable-input')
        self.assertEqual(result['stop'],'immutable input mandatory rules')
        self.assertIsNone(result['best'])
    def run_schedule(self, outcome, real=True):
        pr={'units':[dict(name='A',refs=['A'],fixed=True,x=5,y=5,rects=[[-.5,-.5,.5,.5,.5]])],
            'nets':[],'board':{'outline':[[0,0],[10,0],[10,10],[0,10]],'keepouts':[],'edge_clearance':0}}
        calls={'search':0,'route':0}
        def search(q,n):
            calls['search']+=1
            return {'candidates':[dict(cost=1,illegal=[],pose=[])]}
        def route(path,n):
            calls['route']+=1
            if isinstance(outcome,Exception):raise outcome
            return outcome
        result=compact.run_loop(pr,(10,10),search,lambda *_:'source',route,real_first=real,budget=60)
        return result,calls
    def test_first_valid_immutable_child_stops_real_and_diagnostic_search(self):
        result,calls=self.run_schedule(mp.ImmutableInputFailure({'faults':[{'uuid':'captured'}]},'receipt.json'))
        self.assertEqual(calls,{'search':1,'route':1})
        self.assertEqual(result['stop'],'immutable input mandatory rules')
        self.assertIsNone(result['best']);self.assertEqual(result['steps'][0]['failure_receipt'],'receipt.json')
    def test_immutable_failure_also_stops_virtual_first(self):
        result,calls=self.run_schedule(mp.ImmutableInputFailure({'faults':[]},'receipt.json'),False)
        self.assertEqual(calls,{'search':1,'route':1});self.assertIsNone(result['best'])
    def test_generic_nonzero_transport_adapter_keeps_normal_schedule(self):
        result,calls=self.run_schedule([1000000])
        self.assertEqual(calls,{'search':6,'route':6});self.assertNotEqual(result['stop'],'immutable input mandatory rules')
    def test_ordinary_repairable_candidate_failures_continue(self):
        result,calls=self.run_schedule([3]);self.assertEqual(calls['route'],6)
        self.assertIsNone(result['best'])
    def test_timeout_is_not_relabelled_immutable(self):
        import subprocess
        result,calls=self.run_schedule(subprocess.TimeoutExpired('router',0))
        self.assertNotEqual(result['stop'],'immutable input mandatory rules')
        self.assertEqual(result['steps'][0]['status'],'timeout')


class SeedEntrypointTests(unittest.TestCase):
    def test_actual_compact_entrypoint_stops_before_placement_or_backend(self):
        self.exercise_entrypoint()
    def test_post_native_deadline_writes_timeout_not_complete(self):
        self.exercise_entrypoint('after-native')
    def test_pre_native_deadline_writes_timeout_without_native_receipt(self):
        self.exercise_entrypoint('before-native')
    def test_admission_timeout_is_distinct_from_workflow_deadline(self):
        self.exercise_entrypoint('admission')
    def exercise_entrypoint(self, timeout_mode=None):
        from placer import compact_cli
        import lean_workflow as lean
        import lean_resources as resources
        root=Path(os.environ.get('IOT_TEST_RULES_ROOT',HERE.parent))
        captured=json.loads((HERE/'test-fixtures/mandatory-cc-774.json').read_text())
        tracks=[]
        for row in captured['source_records']:
            # Read-only native boundary mocked with captured exact nm geometry.
            def point(xy):return types.SimpleNamespace(x=xy[0],y=xy[1])
            tracks.append(types.SimpleNamespace(m_Uuid=types.SimpleNamespace(AsString=lambda r=row:r['uuid']),
                GetNetname=lambda r=row:r['net'],GetLayerName=lambda r=row:r['layer'],
                GetClass=lambda:'PCB_TRACK',IsLocked=lambda:True,GetWidth=lambda r=row:r['width'],
                GetStart=lambda r=row:point(r['geometry'][0]),GetEnd=lambda r=row:point(r['geometry'][1])))
        source=types.SimpleNamespace(GetTracks=lambda:tracks,
            GetNetsByName=lambda:{n:None for n in ('GND','/J1_CC1','/J1_CC2','/USB_DP','/USB_DN')},
            GetEnabledLayers=lambda:types.SimpleNamespace(CuStack=lambda:[0,31]),
            GetLayerName=lambda layer:{0:'F.Cu',31:'B.Cu'}[layer])
        # Native boundary fixture has the accepted inherited DP0/DN1 profile;
        # the captured CC subset alone does not describe all USB copper.
        tracks.append(types.SimpleNamespace(m_Uuid=types.SimpleNamespace(AsString=lambda:'usb-dn-native-boundary-fixture'),
            GetNetname=lambda:'/USB_DN',GetLayerName=lambda:'F.Cu',GetClass=lambda:'PCB_VIA',IsLocked=lambda:True,
            GetPosition=lambda:point([1000000,2000000]),GetWidth=lambda layer:600000,GetDrillValue=lambda:300000,
            IsOnLayer=lambda layer:layer in (0,31),
            TopLayer=lambda:0,BottomLayer=lambda:31))
        def forbidden(*args,**kwargs):raise AssertionError('expensive placement/backend stage ran')
        with tempfile.TemporaryDirectory() as scratch:
            d=Path(scratch);board=d/'BASE-PWR-B.kicad_pcb';board.write_text('mocked CAD reader boundary')
            board.with_suffix('.kicad_pro').write_bytes((root/'hardware-design/boards/BASE-PWR/cad/BASE-PWR-B/BASE-PWR-B.kicad_pro').read_bytes())
            prob=d/'prob.json';prob.write_text('{}');out=d/'job'
            seed_args=types.SimpleNamespace(board=str(board),plane_nets='GND',gnd_vias=False,route_planes=False,
                skip_net='*GND*,/USB_DP,/USB_DN',only_nets='',unlock_nets='')
            function=next(n for n in ast.parse((HERE/'placer/compact_cli.py').read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='main')
            namespace=dict(parser=compact_cli.parser,math=math,lean=lean,json=json,os=os,shlex=shlex,
                           resources=resources,REPO=str(root),mandatory_preflight=mp,subprocess=subprocess)
            exec(compile(ast.Module(body=[function],type_ignores=[]),'<production compact main>','exec'),namespace)
            reads=[]
            def native_read(*args):reads.append(args);return source
            modules={'placer.kicad_io':types.SimpleNamespace(write_board=forbidden),
                     'fastroute_job':types.SimpleNamespace(_parse_args=lambda _:seed_args),
                     'pcbnew':types.SimpleNamespace(LoadBoard=native_read),
                     'route_features':types.SimpleNamespace(ROOT=str(root))}
            def reserve(*args,**kwargs):
                if timeout_mode=='admission':raise TimeoutError('controlled admission timeout')
                return contextlib.nullcontext()
            values={'after-native':[0,0,0,2,2], 'before-native':[0,2,2,2], 'admission':[0,0,0]}
            clock_patch=mock.patch.object(lean,'now',side_effect=values[timeout_mode]) if timeout_mode else contextlib.nullcontext()
            deadline_patch=mock.patch.object(lean,'deadline_after',return_value=1) if timeout_mode else contextlib.nullcontext()
            with mock.patch.dict(sys.modules,modules),mock.patch.object(resources,'reserve',reserve),mock.patch.object(lean,'run_stage',forbidden),clock_patch,deadline_patch,contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit) as stopped:
                    namespace['main']([str(prob),str(board),'--board-dir',str(root),'--outdir',str(out),'--size','100','100'])
            self.assertEqual(stopped.exception.code,124 if timeout_mode else 5)
            run=json.loads((out/'run.json').read_text());self.assertEqual(run['steps'],[])
            self.assertIsNone(run['best']);self.assertFalse(run['qualified'])
            if timeout_mode:
                self.assertEqual(run['stop'],'seed preflight timeout')
                cause='resource_admission_timeout' if timeout_mode=='admission' else 'workflow_deadline'
                self.assertEqual(run['cause'],cause)
                stages=list(map(json.loads,(out/'stages.jsonl').read_text().splitlines()))
                self.assertEqual(len(stages),1);self.assertEqual(stages[0]['status'],'timeout')
                self.assertEqual(stages[0]['cause'],cause)
                self.assertEqual(stages[0]['blocking_native'],timeout_mode=='after-native')
                self.assertEqual((out/'seed-mandatory-preflight.json').exists(),timeout_mode=='after-native')
                self.assertEqual(len(reads),1 if timeout_mode=='after-native' else 0)
                return
            self.assertEqual(len(run['immutable_faults']),4)
            seed=json.loads((out/'seed-mandatory-preflight.json').read_text())
            self.assertEqual(len(seed['faults']),4)
            self.assertEqual(seed['preserved_pair_profile']['expected_vias'],{'p':0,'n':1})
            self.assertEqual([e['stage'] for e in map(json.loads,(out/'stages.jsonl').read_text().splitlines())],['seed-preflight'])

if __name__=='__main__':unittest.main()
