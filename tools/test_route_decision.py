"""Source/evidence mutations and one guarded deterministic copper operation."""
import copy
import ast
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import route_decision as route
from pcb_search.native_srj import source_set,geometry_digest
from test_pcb_search_native_eco import PCB


GAP = '''(kicad_pcb (version 20260101) (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
 (segment (start 0 0) (end 1 0) (width .25) (layer "F.Cu") (net "A") (uuid "left"))
 (segment (start 2 0) (end 3 0) (width .25) (layer "F.Cu") (net "A") (uuid "right")))'''


class RouteDecisionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.base=Path(self.tmp.name).resolve();self.root=self.base/'source';self.root.mkdir()
        self.board=self.root/'hardware-design/boards/X/native.kicad_pcb';self.board.parent.mkdir(parents=True)
        self.board.write_text(GAP)
        for ext in ('.kicad_pro','.kicad_dru','.kicad_sch'):self.board.with_suffix(ext).write_text('fixture')
        (self.board.parent/'gate.json').write_text('{"project":"native","checks":{"erc":true,"drc":true}}')
        source=Path(route.__file__).parent
        for name in set(route.IMPLEMENTATIONS) | set(route.ESCAPE_POLICY_FILES):
            target=self.root/'tools'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source/name,target)
        self.launcher=mock.patch.object(route,'python_native',return_value=sys.executable)
        self.launcher.start();self.addCleanup(self.launcher.stop)
        self.evidence=self.base/'evidence';self.evidence.mkdir()
        self.report=dict(source=self.board.name,coordinate_units='mm',included_severities=['error','warning','exclusion'],
            violations=[],schematic_parity=[],unconnected_items=[dict(items=[
                dict(uuid='left',description='Track [A]',pos=dict(x=1,y=0)),
                dict(uuid='right',description='Track [A]',pos=dict(x=2,y=0))])])
        self.save()

    def save(self):
        route.lean.atomic_json(self.evidence/'drc.json',self.report)
        self.record=dict(schema='iot-lab.native-export.v1',status='reject',board=str(self.board),source_mutated=False,
            drc_returncode=0,inputs=source_set(self.board),drc_sha256=route.sha(self.evidence/'drc.json'),
            drc_command=['--schematic-parity','--refill-zones','--severity-all'])
        route.lean.atomic_json(self.evidence/'record.json',self.record)

    def diagnose(self):return route.diagnose_evidence(self.root,'X',self.evidence/'record.json',self.base/'plan.json')

    def workspace(self):
        result=self.base/'workspace';shutil.copytree(self.root,result);return result

    def test_exact_native_gap_is_deterministic_and_preserves_all_original_geometry(self):
        plan=self.diagnose();self.assertEqual(plan,self.diagnose())
        self.assertEqual(plan['choice']['strategy'],'straight_gap_bridge')
        self.assertEqual(plan['next_action']['argv'],['tools/pcb','repair','X','--plan',str(self.base/'plan.json'),'--follow'])
        workspace=self.workspace();native=workspace/self.board.relative_to(self.root)
        before=geometry_digest(native)
        result=route.apply_plan(workspace,'X',plan,self.base/'repair')
        self.assertEqual(result['status'],'proposed');self.assertFalse(result['qualified'])
        self.assertEqual(before,geometry_digest(native,result['added_items']))
        self.assertEqual(self.board.read_text(),GAP)
        self.assertEqual(result['candidate_sha256'],route.sha(native))
        self.assertTrue(result['full_configured_gates_required'])

    def test_native_display_anchor_at_opposite_track_end_uses_exact_source_gap(self):
        # Native ENV proof: KiCad's left display position is the connected
        # start, while the actual removed 45-degree segment meets its end.
        self.board.write_text('''(kicad_pcb (version 20260101)
          (segment (start 120.4078 122.2914) (end 119.45 122.2914) (width .25) (layer "F.Cu") (net "/V_GAS") (uuid "left"))
          (segment (start 119.1767 122.0181) (end 119.1767 121.5) (width .25) (layer "F.Cu") (net "/V_GAS") (uuid "right"))
          (segment (start 120.7092 122.5928) (end 120.4078 122.2914) (width .25) (layer "F.Cu") (net "/V_GAS") (uuid "left-connected"))
          (segment (start 118.5 121.5) (end 119.1767 121.5) (width .25) (layer "F.Cu") (net "/V_GAS") (uuid "right-connected")))''')
        self.report['unconnected_items'][0]['items']=[
            dict(uuid='left',description='Track [/V_GAS]',pos=dict(x=120.4078,y=122.2914)),
            dict(uuid='right',description='Track [/V_GAS]',pos=dict(x=119.1767,y=122.0181))]
        self.save();plan=self.diagnose()
        self.assertEqual(plan['choice']['points_mm'],[['119.45','122.2914'],['119.1767','122.0181']])
        workspace=self.workspace();result=route.apply_plan(workspace,'X',plan,self.base/'repair')
        self.assertEqual(geometry_digest(self.board),geometry_digest(workspace/self.board.relative_to(self.root),result['added_items']))
        # Distinct equally near pairs do not justify guessing a repair.
        self.board.write_text(GAP.replace('(start 2 0) (end 3 0)','(start 0 1) (end 1 1)'))
        self.report['unconnected_items'][0]['items']=[
            dict(uuid='left',description='Track [A]',pos=dict(x=0,y=0)),
            dict(uuid='right',description='Track [A]',pos=dict(x=0,y=1))]
        self.save();self.assertIsNone(self.diagnose()['choice'])

    def test_canonical_repair_and_existing_output_are_rejected_before_any_write(self):
        plan=self.diagnose()
        with self.assertRaisesRegex(ValueError,'isolated'):route.apply_plan(self.root,'X',plan,self.base/'bad')
        workspace=self.workspace();(self.base/'out').mkdir()
        with self.assertRaisesRegex(ValueError,'new'):route.apply_plan(workspace,'X',plan,self.base/'out')
        self.assertEqual(self.board.read_text(),GAP)

    def test_source_sidecar_evidence_and_implementation_mutations_refuse_plan(self):
        for path in (self.board,self.board.with_suffix('.kicad_dru'),self.evidence/'drc.json',self.root/'tools/route_decision.py'):
            plan=self.diagnose();workspace=self.workspace();old=path.read_bytes();path.write_bytes(old+b' ')
            try:
                with self.subTest(path=path),self.assertRaises(ValueError):route.apply_plan(workspace,'X',plan,self.base/'repair')
                self.assertEqual((workspace/self.board.relative_to(self.root)).read_text(),GAP)
            finally:path.write_bytes(old);shutil.rmtree(workspace)

    def test_rehashing_an_edited_choice_does_not_authorize_unreported_copper(self):
        plan=self.diagnose();plan['choice']['points_mm'][1][0]='900'
        plan['plan_sha256']=route.fingerprint({k:v for k,v in plan.items() if k!='plan_sha256'})
        with self.assertRaisesRegex(ValueError,'stale'):route.apply_plan(self.workspace(),'X',plan,self.base/'repair')

    def test_crossing_unknown_endpoint_width_and_locked_patterns_never_apply(self):
        variants=[GAP[:-1]+'(segment (start 1.5 -1) (end 1.5 1) (width .2) (layer "F.Cu") (net "B") (uuid "blocker")))',
                  GAP.replace('(width .25) (layer "F.Cu") (net "A") (uuid "right")','(width .3) (layer "F.Cu") (net "A") (uuid "right")'),
                  GAP.replace('(uuid "left")','(locked yes) (uuid "left")')]
        for source in variants:
            self.board.write_text(source);self.save()
            with self.subTest(source=source):self.assertIsNone(self.diagnose()['choice'])
        self.board.write_text(GAP);self.report['unconnected_items'][0]['items'][0]['pos']['x']=.5;self.save()
        self.assertIsNone(self.diagnose()['choice'])

    def test_native_parity_and_constraint_unknown_stop_local_repair(self):
        self.report['schematic_parity']=[dict(type='missing_footprint')];self.save()
        plan=self.diagnose();self.assertEqual(plan['action'],'resolve_schematic_parity');self.assertIsNone(plan['choice'])
        self.report['schematic_parity']=[];self.save()
        rules=self.evidence/'rules.log';rules.write_text("rule isolation: term memberOfFootprint not compiled")
        envelope=dict(schema='iot-lab.route-evidence.v1',board='X',source_inputs=source_set(self.board),artifacts={
            'native':dict(path=str(self.evidence/'record.json'),sha256=route.sha(self.evidence/'record.json')),
            'rules':dict(path=str(rules),sha256=route.sha(rules))})
        route.lean.atomic_json(self.evidence/'envelope.json',envelope)
        plan=route.diagnose_evidence(self.root,'X',self.evidence/'envelope.json')
        self.assertEqual(plan['action'],'resolve_constraint_coverage');self.assertIsNone(plan['choice'])

    def test_router_miss_never_claims_joint_routability_or_placement_cause(self):
        findings=route.classify(self.report,dict(triage=dict(connections=[dict(net='A',**{'class':'ROUTER_MISS'})])))
        miss=next(row for row in findings if row['classification']=='router_miss')
        self.assertIn('joint routability is unproven',miss['reason']);self.assertEqual(miss['refs'],[])

    def test_native_disagrees_only_with_explicit_completed_net_scope(self):
        self.assertFalse(any(row['classification']=='native_router_disagreement' for row in route.classify(self.report,dict(router=dict(stats=dict(unrouted=0))))))
        self.assertTrue(any(row['classification']=='native_router_disagreement' for row in route.classify(self.report,dict(router=dict(completed_nets=['A'])))))

    def test_existing_native_via_repair_retains_all_tracks_and_nonselected_forms(self):
        self.board.write_text(PCB[:-1]+'''(footprint "U" (at -1 -1) (uuid "u") (property "Reference" "U1")
            (pad "1" smd rect (at 0 0) (size .8 .8) (layers "F.Cu") (net "B") (uuid "p"))))''')
        self.report.update(unconnected_items=[],violations=[dict(type='clearance',severity='error',items=[dict(uuid='via'),dict(uuid='p')])]);self.save()
        plan=self.diagnose();self.assertEqual(plan['choice']['strategy'],'via_shift_bridge')
        workspace=self.workspace();result=route.apply_plan(workspace,'X',plan,self.base/'via-repair')
        self.assertEqual(result['allowed_original_edits'],['via'])
        native=workspace/self.board.relative_to(self.root)
        self.assertEqual(geometry_digest(self.board,['via']),geometry_digest(native,['via']+result['added_items']))

    def test_native_helper_cannot_change_unrelated_copper_even_if_it_claims_success(self):
        self.board.write_text(PCB[:-1]+'''(footprint "U" (at -1 -1) (uuid "u") (property "Reference" "U1")
            (pad "1" smd rect (at 0 0) (size .8 .8) (layers "F.Cu") (net "B") (uuid "p"))))''')
        self.report.update(unconnected_items=[],violations=[dict(type='clearance',severity='error',items=[dict(uuid='via'),dict(uuid='p')])]);self.save()
        plan=self.diagnose();original=route.shift_via;workspace=self.workspace()
        def corrupt(*args,**kwargs):
            receipt=original(*args,**kwargs);path=Path(args[3])/'proposal.kicad_pcb'
            path.write_text(path.read_text().replace('(at 3 4)','(at 8 9)'));return receipt
        with mock.patch.object(route,'shift_via',side_effect=corrupt),self.assertRaisesRegex(ValueError,'protected geometry'):
            route.apply_plan(workspace,'X',plan,self.base/'repair')
        self.assertEqual((workspace/self.board.relative_to(self.root)).read_bytes(),self.board.read_bytes())

    def test_via_geometry_and_bridge_width_cannot_hide_inside_allowed_ids(self):
        self.board.write_text(PCB[:-1]+'''(footprint "U" (at -1 -1) (uuid "u") (property "Reference" "U1")
            (pad "1" smd rect (at 0 0) (size .8 .8) (layers "F.Cu") (net "B") (uuid "p"))))''')
        self.report.update(unconnected_items=[],violations=[dict(type='clearance',severity='error',items=[dict(uuid='via'),dict(uuid='p')])]);self.save()
        plan=self.diagnose();original=route.shift_via
        for old,new in [('(size .6)','(size .9)'),('(width .15) (layer "B.Cu")','(width .1) (layer "B.Cu")')]:
            workspace=self.workspace()
            def corrupt(*args,**kwargs):
                receipt=original(*args,**kwargs);path=Path(args[3])/'proposal.kicad_pcb'
                path.write_text(path.read_text().replace(old,new));return receipt
            try:
                with mock.patch.object(route,'shift_via',side_effect=corrupt),self.assertRaises(ValueError):
                    route.apply_plan(workspace,'X',plan,self.base/('bad-'+str(len(new))))
                self.assertEqual((workspace/self.board.relative_to(self.root)).read_bytes(),self.board.read_bytes())
            finally:shutil.rmtree(workspace)

    def escape_fixture(self):
        geometry=dict(refs={'U1':dict(pads={str(i):[dict(kind='smd',layers=['F.Cu'])] for i in (1,2)})})
        contract=dict(board='X',geometry=geometry,inputs={str(self.board):route.sha(self.board)},
            rules=[dict(id='critical',kind='escape',refs=['U1'],metric='native_minimum_track_escape')])
        proof=dict(schema='iot-lab.pin-escape-evidence.v1',qualified=False,status='screened',board=str(self.board),
            source_inputs=source_set(self.board),screened_pads=[dict(ref='U1',pad=str(i)) for i in (1,2)],
            unsupported_constraints=[],not_checked=0,boxed_in=[],native_validation='not_run; fresh parent configured gate required')
        context=route.escape_context(self.root,'X')
        runtime_file=self.base/'synthetic-runtime.bin';runtime_file.write_text('synthetic CPU fixture; no native claims')
        runtime=dict(python_version='synthetic',pcbnew_version='synthetic',numpy_version='synthetic',
            files={role:dict(path=str(runtime_file),sha256=route.sha(runtime_file)) for role in
                   ('python','pcbnew','pcbnew_native','numpy','numpy_native')})
        proof.update(generator_context=context,generator_inputs=context['files'],feature_config=context['feature_config'],
                     model_parameters=context['model_parameters'],runtime=runtime)
        path=self.evidence/'escape.json';route.lean.atomic_json(path,proof)
        return contract,proof,path

    def test_escape_requires_every_reviewed_pad_and_exact_native_sidecars(self):
        contract,proof,path=self.escape_fixture()
        self.assertEqual(route.verify_escape_evidence(contract,self.board,path),[])
        for changes in (dict(screened_pads=[dict(ref='U1',pad='1')]),dict(screened_pads=[dict(ref='OTHER',pad='1')]),
                        dict(source_inputs={}),dict(unsupported_constraints=['class-to-class clearance']),dict(native_validation='passed')):
            route.lean.atomic_json(path,dict(proof,**changes))
            with self.subTest(changes=changes):self.assertEqual(route.verify_escape_evidence(contract,self.board,path)[0]['code'],'native_escape_evidence_invalid')
        route.lean.atomic_json(path,proof);self.board.with_suffix('.kicad_pro').write_text('different project')
        self.assertTrue(route.verify_escape_evidence(contract,self.board,path))

    def test_explicit_escape_pad_scope_and_reviewed_overrides_are_not_ignored(self):
        contract,proof,path=self.escape_fixture()
        contract['rules'][0]['pads']=[dict(ref='U1',pad='1')]
        proof['screened_pads']=[dict(ref='U1',pad='1')];route.lean.atomic_json(path,proof)
        self.assertEqual(route.verify_escape_evidence(contract,self.board,path),[])
        contract['rules'][0]['width_mm']=.5
        self.assertIn('unsupported reviewed',route.verify_escape_evidence(contract,self.board,path)[0]['detail'])
        del contract['rules'][0]['width_mm']
        proof['boxed_in']=[dict(ref='U1',pad='U1.1',net='A')];route.lean.atomic_json(path,proof)
        self.assertEqual(route.verify_escape_evidence(contract,self.board,path)[0]['code'],'escape_model_enclosure')

    def test_escape_producer_runs_one_owned_geometry_screen_without_duplicate_drc(self):
        contract,proof,path=self.escape_fixture();calls=[]
        def screen(command,**kwargs):
            calls.append((command,kwargs))
            route.lean.atomic_json(Path(command[command.index('--out')+1]),proof)
            return SimpleNamespace(returncode=0)
        output=self.base/'produced-escape.json'
        with mock.patch.object(route.lean,'run_stage',side_effect=screen):result=route.generate_escape(self.root,'X',output)
        self.assertEqual(len(calls),1);self.assertNotIn('drc',calls[0][0])
        self.assertEqual(result['native_validation'],'not_run; fresh parent configured gate required')
        self.assertEqual(route.verify_escape_evidence(contract,self.board,output),[])

    def test_escape_screen_rejects_changed_policy_runtime_and_unknown_external_override(self):
        contract,proof,path=self.escape_fixture()
        for target in (self.root/'tools/route-features.json',self.root/'tools/route_grid.py',
                       self.board.parent/'gate.json',self.base/'synthetic-runtime.bin'):
            original=target.read_bytes();target.write_bytes(original+b' ')
            try:
                with self.subTest(target=target):self.assertTrue(route.verify_escape_evidence(contract,self.board,path))
            finally:target.write_bytes(original)
        changed=copy.deepcopy(proof);changed['model_parameters']['grid_mm']=.5;route.lean.atomic_json(path,changed)
        self.assertTrue(route.verify_escape_evidence(contract,self.board,path))
        route.lean.atomic_json(path,proof)
        with mock.patch.dict(os.environ,ROUTE_FEATURES_FILE=str(self.root/'tools/route-features.json')):
            self.assertTrue(route.verify_escape_evidence(contract,self.board,path))
            with self.assertRaisesRegex(ValueError,'external'):route.generate_escape(self.root,'X',self.base/'unknown.json')
        with mock.patch.dict(os.environ,ROUTE_BOARD='OTHER'):
            self.assertTrue(route.verify_escape_evidence(contract,self.board,path))

    def test_escape_explicit_candidate_keeps_reviewed_root_policy_and_exact_candidate_sources(self):
        contract,proof,path=self.escape_fixture();contract['root']=str(self.root)
        candidate=self.base/'compact/native.kicad_pcb';candidate.parent.mkdir()
        for ext in ('.kicad_pcb','.kicad_pro','.kicad_dru','.kicad_sch'):
            shutil.copyfile(self.board.with_suffix(ext),candidate.with_suffix(ext))
        proof.update(board=str(candidate),source_inputs=source_set(candidate))
        def screen(command,**kwargs):
            self.assertEqual(command[command.index('escape')+1],str(candidate))
            self.assertEqual(kwargs['env']['ROUTE_BOARD'],'X')
            route.lean.atomic_json(Path(command[command.index('--out')+1]),proof)
            return SimpleNamespace(returncode=0)
        output=self.base/'compact-screen.json'
        with mock.patch.object(route.lean,'run_stage',side_effect=screen):
            result=route.generate_escape_for_candidate(self.root,'X',candidate,output)
        self.assertEqual(route.verify_escape_evidence(contract,candidate,output),[])
        self.assertEqual(result['source_inputs'],source_set(candidate))
        candidate.with_suffix('.kicad_dru').write_text('new candidate rule')
        self.assertTrue(route.verify_escape_evidence(contract,candidate,output))

    def stage_fixture(self):
        contract,proof,_=self.escape_fixture();contract['root']=str(self.root)
        candidate=self.base/'candidate/native.kicad_pcb';candidate.parent.mkdir()
        for suffix in ('.kicad_pcb','.kicad_sch','.kicad_pro','.kicad_dru'):
            shutil.copyfile(self.board.with_suffix(suffix),candidate.with_suffix(suffix))
        runtime=self.base/'synthetic-runtime.bin'
        def producer(policy,native,output):
            context=route.escape_context(self.root,'X')
            value=copy.deepcopy(proof)
            value.update(board=str(native),source_inputs=source_set(native),generator_context=context,
                generator_inputs=context['files'],feature_config=context['feature_config'],model_parameters=context['model_parameters'])
            for item in value['runtime']['files'].values():item['sha256']=route.sha(runtime)
            value['inputs']={str(native.with_suffix(Path(name).suffix)):digest for name,digest in source_set(native).items()}
            route.lean.atomic_json(output,value)
            return value
        return contract,candidate,producer

    def test_same_stage_shares_verified_receipt_and_separate_post_stage_generates_again(self):
        contract,candidate,producer=self.stage_fixture();events=[]
        screens=route.EscapeStageReceipts(lambda kind,**data:events.append((kind,data)))
        first=self.base/'pre-engineering.json';second=self.base/'pre-design.json';post=self.base/'post.json'
        with mock.patch.object(route,'generate_escape_evidence',side_effect=producer) as generate:
            self.assertEqual(screens.get(contract,candidate,first),first)
            self.assertEqual(screens.get(contract,candidate,second),first)
            self.assertFalse(second.exists());self.assertEqual(generate.call_count,1)
            self.assertEqual(route.EscapeStageReceipts().get(contract,candidate,post),post)
            self.assertEqual(generate.call_count,2)
        self.assertEqual((screens.generated,screens.hits),(1,1))
        self.assertEqual([kind for kind,_ in events],['cache.miss','cache.hit'])

    def test_stage_receipt_invalidates_for_candidate_policy_code_environment_and_observed_runtime(self):
        contract,candidate,producer=self.stage_fixture()
        targets=[candidate.with_suffix(suffix) for suffix in ('.kicad_pcb','.kicad_sch','.kicad_pro','.kicad_dru')]
        targets += [self.root/'tools/route_grid.py',self.root/'tools/route_decision.py',
                    self.board.parent/'gate.json',self.base/'synthetic-runtime.bin']
        with mock.patch.object(route,'generate_escape_evidence',side_effect=producer) as generate:
            for n,target in enumerate(targets):
                with self.subTest(target=str(target)):
                    screens=route.EscapeStageReceipts();first=self.base/('first-'+str(n)+'.json');next_file=self.base/('next-'+str(n)+'.json')
                    screens.get(contract,candidate,first);before=generate.call_count
                    original=target.read_bytes();target.write_bytes(original+b' ')
                    try:self.assertEqual(screens.get(contract,candidate,next_file),next_file)
                    finally:target.write_bytes(original)
                    self.assertEqual(generate.call_count,before+1);self.assertEqual(screens.hits,0)
            screens=route.EscapeStageReceipts();screens.get(contract,candidate,self.base/'env-first.json')
            with mock.patch.dict(os.environ,LD_PRELOAD='synthetic-cache-key-only'):
                self.assertEqual(screens.get(contract,candidate,self.base/'env-next.json'),self.base/'env-next.json')
            screens=route.EscapeStageReceipts();screens.get(contract,candidate,self.base/'policy-first.json')
            changed=copy.deepcopy(contract);changed['rules'][0]['id']='changed-reviewed-rule'
            self.assertEqual(screens.get(changed,candidate,self.base/'policy-next.json'),self.base/'policy-next.json')

    def test_sealed_receipt_tamper_and_unchanged_failed_screen_never_trigger_another_producer(self):
        contract,candidate,producer=self.stage_fixture();screens=route.EscapeStageReceipts()
        first=self.base/'sealed.json'
        with mock.patch.object(route,'generate_escape_evidence',side_effect=producer) as generate:
            screens.get(contract,candidate,first);first.write_text(first.read_text()+' ')
            with self.assertRaisesRegex(ValueError,'sealed stage escape receipt changed'):
                screens.get(contract,candidate,self.base/'tampered-next.json')
            self.assertEqual(generate.call_count,1)
        def failed(policy,native,output):route.lean.atomic_json(output,dict(status='blocked',cause='fixture missing runtime'))
        screens=route.EscapeStageReceipts()
        with mock.patch.object(route,'generate_escape_evidence',side_effect=failed) as generate:
            screens.get(contract,candidate,self.base/'failed.json')
            with self.assertRaisesRegex(ValueError,'already failed'):
                screens.get(contract,candidate,self.base/'failed-next.json')
            self.assertEqual(generate.call_count,1)

if __name__=='__main__':unittest.main()
