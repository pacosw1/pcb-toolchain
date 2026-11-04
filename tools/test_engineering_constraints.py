"""Engineering constraints on native pad geometry, not footprint-name guesses."""
import copy
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import engineering_constraints as engineering
from pcb_workflow import sha


NATIVE_SIDECARS = ('.kicad_pcb','.kicad_pro','.kicad_dru','.kicad_sch')


def proof_inputs(native):
    return {native.with_suffix(ext).name:sha(native.with_suffix(ext)) for ext in NATIVE_SIDECARS}


def checked_drc_report(path, native, command, returncode):
    """Do not infer a completed native invocation from a JSON report alone."""
    required={'--schematic-parity','--refill-zones','--severity-all'}
    if returncode!=0 or isinstance(returncode,bool) or not required<=set(command):
        raise ValueError('native DRC did not complete with required parity/refill/severity checks')
    raw=json.loads(Path(path).read_text())
    if (raw.get('source')!=native.name or raw.get('coordinate_units')!='mm'
            or not {'error','warning','exclusion'}<=set(raw.get('included_severities',[]))
            or any(not isinstance(raw.get(key),list) for key in ('violations','schematic_parity','unconnected_items'))):
        raise ValueError('native DRC report is incomplete or targets another source')
    hard=[row for row in raw['violations'] if row.get('severity')=='error']
    if any(row.get('severity') not in ('error','warning','exclusion') for row in raw['violations']):
        raise ValueError('native DRC contains an unknown finding severity')
    if hard or raw['schematic_parity'] or raw['unconnected_items']:
        raise ValueError('native DRC rejected errors, parity or opens')
    return dict(path=str(Path(path).resolve()),sha256=sha(path),command=command,returncode=returncode,
                inputs=proof_inputs(native),errors=0,parity=0,opens=0,
                warnings=sum(row.get('severity')=='warning' for row in raw['violations']))


def save_placement_checkpoint(output, result, problem, checked, pose, *, reconstructed=False):
    """Persist completed cheap/native-writer work before a separate DRC runtime."""
    import lean_workflow as lean
    output=Path(output).resolve()
    lean.atomic_json(output/'problem.json',problem)
    lean.atomic_json(output/'placement-check.json',checked)
    inputs=dict(problem['engineering']['inputs'])
    for path in (output/'source/tools').rglob('*'):
        if path.is_file() and '__pycache__' not in path.parts:inputs[str(path)]=sha(path)
    native=Path(problem['board_file']);candidate=output/'candidate'/native.relative_to(output/'source')
    artifacts={str(path):sha(path) for path in (output/'problem.json',output/'placement-check.json',
        output/'escape.json',output/'escape-partial.json')}
    checkpoint=dict(schema='iot-lab.native-placement-proof-checkpoint.v1',status='awaiting_native_drc',
        reconstructed_after_runtime_timeout=reconstructed,
        source_guard_scope=('declared reviewed inputs verified at reconstruction; original pre-DRC checkpoint absent'
                            if reconstructed else 'declared reviewed inputs captured before native DRC'),
        source_inputs=inputs,candidate=str(candidate),candidate_inputs=proof_inputs(candidate),
        pose=pose,result=result,artifacts=artifacts)
    checkpoint['checkpoint_sha256']=engineering.fingerprint(checkpoint)
    lean.atomic_json(output/'checkpoint.json',checkpoint)
    return checkpoint


def finish_placement_proof(output, native_reports, *, receipt=None):
    import lean_workflow as lean
    output=Path(output).resolve();path=output/'checkpoint.json'
    checkpoint=json.loads(path.read_text())
    expected=checkpoint.pop('checkpoint_sha256',None)
    if (engineering.fingerprint(checkpoint)!=expected
            or checkpoint.get('schema')!='iot-lab.native-placement-proof-checkpoint.v1'
            or checkpoint.get('status')!='awaiting_native_drc'):
        raise ValueError('placement checkpoint changed')
    for name,digest in {**checkpoint['source_inputs'],**checkpoint['artifacts']}.items():
        if not Path(name).is_file() or sha(name)!=digest:
            raise ValueError('declared placement source or checkpoint artifact changed: '+name)
    if proof_inputs(Path(checkpoint['candidate']))!=checkpoint['candidate_inputs']:
        raise ValueError('native candidate changed after placement checkpoint')
    if set(native_reports)!={'baseline','candidate'}:
        raise ValueError('both exact baseline and candidate native reports are required')
    result=dict(checkpoint['result'],status='passed',qualified=False,skips=0,source_unchanged=True,
        source_inputs=checkpoint['source_inputs'],source_guard_scope=checkpoint['source_guard_scope'],
        reconstructed_after_runtime_timeout=checkpoint['reconstructed_after_runtime_timeout'],
        native_reports=native_reports,checkpoint_sha256=sha(path),completion_implementation_sha256=sha(__file__))
    if receipt:result['native_receipt']=dict(path=str(Path(receipt).resolve()),sha256=sha(receipt))
    lean.atomic_json(output/'summary.json',result)
    return result


def import_placement_drc(output, receipt):
    """Import a recorded source-bound native invocation; never run DRC again."""
    output,receipt=Path(output).resolve(),Path(receipt).resolve()
    checkpoint=json.loads((output/'checkpoint.json').read_text())
    record=json.loads(receipt.read_text());runtime=record.get('runtime',{})
    image=runtime.get('image_id','')
    if (not image.startswith('sha256:') or len(image)!=71 or not runtime.get('kicad_version')
            or record.get('status')!='passed' or record.get('schema')!='iot-lab.native-placement-drc.v1'
            or len(record.get('tool_sha256',''))!=64):
        raise ValueError('native receipt lacks successful pinned runtime attribution')
    reports={};native=Path(checkpoint['result']['native_source'])
    for label,target in (('baseline',native),('candidate',Path(checkpoint['candidate']))):
        row=record.get('reports',{}).get(label if label in record.get('reports',{}) else 'source' if label=='baseline' else label)
        supplied=row.get('inputs',{}) if isinstance(row,dict) else {}
        normalized={Path(name).name:digest for name,digest in supplied.items()}
        if (not isinstance(row,dict) or len(normalized)!=len(supplied) or normalized!=proof_inputs(target)
                or row.get('source_unchanged') is not True or row.get('timeout_s')!=20):
            raise ValueError('native receipt does not bind exact '+label+' inputs')
        report=(receipt.parent/Path(row.get('report',row.get('path',''))).name).resolve()
        if sha(report)!=row.get('report_sha256'):
            raise ValueError('native report changed: '+label)
        reports[label]=checked_drc_report(report,target,row.get('command',[]),row.get('returncode'))
        reports[label]['runtime']=runtime
    return finish_placement_proof(output,reports,receipt=receipt)


def reconstruct_placement_checkpoint(output):
    """Recover v1's missing checkpoint from preserved CAD and original escape.

    No placement, extraction, escape generation or DRC is rerun. A small native
    projection supports independent rigid/native-form checks and production
    writer rejection guards. Its later observation time remains explicit.
    """
    import lean_workflow as lean
    import route_decision
    from placer import kicad_io
    from pcb_search.native_placement import verify_preserved
    output=Path(output).resolve()
    if (output/'checkpoint.json').exists():raise ValueError('checkpoint already exists; import it directly')
    root=output/'source';manifest=root/'hardware-design/registry/part-reviews/PART-FIXTURE.json'
    contract=engineering.reviewed_contract(root,'PART-FIXTURE',manifest)
    native=Path(contract['native']);candidate=output/'candidate'/native.relative_to(root)
    units=[dict(name=ref,refs=[ref],x=entry['origin'][0],y=entry['origin'][1],fixed=entry['locked'],rects=[])
           for ref,entry in contract['geometry']['refs'].items()]
    x0,y0,x1,y1=contract['geometry']['bounds']
    problem=dict(board_file=str(native),units=units,nets=[],board=dict(outline=[[x0,y0],[x1,y0],[x1,y1],[x0,y1]],keepouts=[],edge_clearance=0))
    problem=engineering.prepare_problem(root,'PART-FIXTURE',manifest,problem)
    after=engineering.native_geometry(candidate)
    pose=[[after['refs'][u['name']]['origin'][0],after['refs'][u['name']]['origin'][1],
           (after['refs'][u['name']]['quarter']-contract['geometry']['refs'][u['name']]['quarter'])%4] for u in units]
    moved,protected=verify_preserved(native,candidate,problem,pose)
    if moved!=['J1'] or abs(after['refs']['J1']['origin'][0]-contract['geometry']['refs']['J1']['origin'][0]-.1)>1e-9:
        raise ValueError('preserved native candidate is not the original J1 positive movement')
    escape=output/'escape.json';partial=output/'escape-partial.json'
    if route_decision.verify_escape_evidence(problem['engineering'],candidate,escape):
        raise ValueError('original actual escape evidence no longer verifies')
    partial_blockers=route_decision.verify_escape_evidence(problem['engineering'],candidate,partial)
    stale=json.loads(escape.read_text());stale['source_inputs'][native.with_suffix('.kicad_dru').name]='0'*64
    stale_path=output/'escape-stale.json';lean.atomic_json(stale_path,stale)
    stale_blockers=route_decision.verify_escape_evidence(problem['engineering'],candidate,stale_path)
    if any(not rows or rows[0]['code']!='native_escape_evidence_invalid' for rows in (partial_blockers,stale_blockers)):
        raise ValueError('partial or stale original escape receipt was accepted')
    checked=engineering.check_manifest(root,'PART-FIXTURE',manifest,candidate,escape_evidence=escape)
    if checked['status']!='passed':raise ValueError('preserved placement no longer meets sourced constraints')
    rejected=copy.deepcopy(pose);j2=next(i for i,u in enumerate(units) if u['name']=='J2');rejected[j2][0]+=3
    proofs={}
    for label in ('distance','rule','geometry','writer-input'):
        forged=copy.deepcopy(problem);source=native
        if label=='rule':forged['engineering']['rules'][0]['max_mm']=3000
        elif label=='geometry':forged['engineering']['geometry']['refs']['J2']['pads']['1'][0]['center'][0]-=3
        elif label=='writer-input':source=candidate
        forged['engineering']['review_sha256']=engineering.contract_digest(forged['engineering'])
        forbidden=output/('resume-'+label+'-must-not-exist.kicad_pcb')
        if forbidden.exists():raise ValueError('reconstruction output is not fresh')
        try:kicad_io.write_board(str(source),forged,rejected,str(forbidden))
        except ValueError as error:proofs[label]=str(error)
        else:raise ValueError('production writer accepted reconstructed invalid '+label)
        if forbidden.exists():raise ValueError('rejected guard wrote native CAD')
    raw=json.loads(escape.read_text())
    result=dict(scope='synthetic_native_placement_guard',qualified=False,native_source=str(native),
        native_version=raw['runtime']['pcbnew_version'],moved=moved,
        writer=dict(copper_retained=True,protected_native_forms_sha256=protected,
                    verification='independent preserved native source/candidate bytes; original writer return value unavailable'),
        rejection=proofs.pop('distance'),trust_boundary_rejections=proofs,
        escape=dict(status='passed',path=str(escape),sha256=sha(escape),screened_pads=raw['screened_pads'],
                    partial_rejection=partial_blockers,stale_rejection=stale_blockers,qualified=False),
        reconstruction=dict(no_placement_or_extraction_rerun=True,no_escape_or_drc_rerun=True,
                            original_runtime_failure=str(output/'failure.json')),
        implementations={str(p):sha(p) for p in (Path(engineering.__file__),Path(kicad_io.__file__),Path(__file__))})
    return save_placement_checkpoint(output,result,problem,checked,pose,reconstructed=True)


def native_copy_proof(output):
    """Explicit native-runtime integration, separate from CPU unittest discovery.

    Uses an attributable synthetic review, actual Poppler, pcbnew and native DRC;
    it never reads or writes shipping CAD and never grants board qualification.
    """
    import lean_workflow as lean
    import native_workflow_smoke
    import part_evidence
    import pcbnew
    import route_decision
    from placer import kicad_io, cost
    from pcb_search.native_placement import verify_preserved
    from test_part_evidence import make_fixture
    output = Path(output).resolve();output.mkdir(parents=True,exist_ok=False)
    root = output/'source'
    manifest = make_fixture(root,native_generator=native_workflow_smoke.generate,include_escape=True)
    reviewed = part_evidence.verify_manifest(root,'PART-FIXTURE',manifest)
    if reviewed['status']!='passed':
        raise AssertionError(reviewed)
    native = root/'hardware-design/boards/PART-FIXTURE/fixture.kicad_pcb'
    source_tools = Path(__file__).resolve().parent
    escape_tools = ('route_grid.py','route_features.py','route-features.json','placer/dru.py','placer/__init__.py')
    for name in escape_tools:
        target = root/'tools'/name;target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(source_tools/name,target)
    problem = kicad_io.read_problem(str(native),decap_tie=0,edge_dist=0)
    problem = engineering.prepare_problem(root,'PART-FIXTURE',manifest,problem)
    pose = [list(p) for p in cost.initial_pose(problem)]
    index = next(i for i,u in enumerate(problem['units']) if 'J1' in u['refs'])
    if problem['units'][index]['fixed']:
        raise AssertionError('fixture intended movement is unexpectedly fixed')
    pose[index][0] += .1  # Deliberate fixture perturbation; no electrical acceptance threshold.
    candidate_root = output/'candidate'
    candidate = candidate_root/native.relative_to(root)
    candidate.parent.mkdir(parents=True)
    shutil.copyfile(native.parent/'gate.json',candidate.parent/'gate.json')
    for extension in ('.kicad_pro','.kicad_dru','.kicad_sch'):
        shutil.copyfile(native.with_suffix(extension),candidate.with_suffix(extension))
    writer = kicad_io.write_board(str(native),problem,pose,str(candidate))
    moved,_ = verify_preserved(native,candidate,problem,pose)
    escape_path = output/'escape.json'
    generated_escape = route_decision.generate_escape_evidence(problem['engineering'],candidate,escape_path)
    escape_blockers = route_decision.verify_escape_evidence(problem['engineering'],candidate,escape_path)
    if generated_escape['status']!='screened' or escape_blockers:
        raise AssertionError(dict(escape=generated_escape,blockers=escape_blockers))
    checked = engineering.check_manifest(root,'PART-FIXTURE',manifest,candidate,escape_evidence=escape_path)
    if checked['status']!='passed' or writer['removed_tracks']!=0 or 'J1' not in moved:
        raise AssertionError(dict(writer=writer,check=checked,moved=moved))
    rejected = copy.deepcopy(pose)
    other = next(i for i,u in enumerate(problem['units']) if 'J2' in u['refs'])
    rejected[other][0] += 3
    refused = output/'must-not-exist.kicad_pcb'
    try:
        kicad_io.write_board(str(native),problem,rejected,str(refused))
    except ValueError as error:
        rejection = str(error)
    else:
        raise AssertionError('source-bound maximum pin distance was bypassed by native writer')
    if refused.exists():
        raise AssertionError('rejected placement wrote native CAD')
    rejection_proofs = {}
    for label in ('rule','geometry','writer-input'):
        forged = copy.deepcopy(problem)
        writer_input = native
        if label=='rule':
            forged['engineering']['rules'][0]['max_mm']=3000
        elif label=='geometry':
            forged['engineering']['geometry']['refs']['J2']['pads']['1'][0]['center'][0]-=3
        else:
            writer_input = candidate
        forged['engineering']['review_sha256']=engineering.contract_digest(forged['engineering'])
        forbidden = output/(label+'-must-not-exist.kicad_pcb')
        try:
            kicad_io.write_board(str(writer_input),forged,rejected,str(forbidden))
        except ValueError as error:
            rejection_proofs[label]=str(error)
        else:
            raise AssertionError('native writer accepted forged '+label)
        if forbidden.exists():raise AssertionError('failed native guard wrote CAD: '+label)
    partial = copy.deepcopy(generated_escape);partial['screened_pads']=[]
    partial_path=output/'escape-partial.json';partial_path.write_text(json.dumps(partial)+'\n')
    partial_blockers=route_decision.verify_escape_evidence(problem['engineering'],candidate,partial_path)
    rules_path=candidate.with_suffix('.kicad_dru');original_rules=rules_path.read_bytes()
    try:
        rules_path.write_bytes(original_rules+b'\n# deliberate stale-evidence mutation\n')
        stale_blockers=route_decision.verify_escape_evidence(problem['engineering'],candidate,escape_path)
    finally:
        rules_path.write_bytes(original_rules)
    if any(not blockers or blockers[0]['code']!='native_escape_evidence_invalid'
           for blockers in (partial_blockers,stale_blockers)):
        raise AssertionError('partial/stale escape evidence was accepted')
    escape_result=dict(status='passed',path=str(escape_path),sha256=sha(escape_path),
        screened_pads=generated_escape['screened_pads'],partial_rejection=partial_blockers,
        stale_rejection=stale_blockers,scope=generated_escape['scope'],qualified=False,
        implementations={name:sha(root/'tools'/name) for name in escape_tools})
    result=dict(scope='synthetic_native_placement_guard',qualified=False,native_source=str(native),
        native_version=pcbnew.Version(),moved=moved,writer=writer,rejection=rejection,
        trust_boundary_rejections=rejection_proofs,escape=escape_result,
        implementations={str(p):sha(p) for p in (Path(engineering.__file__),Path(kicad_io.__file__),Path(cost.__file__),Path(__file__))})
    save_placement_checkpoint(output,result,problem,checked,pose)
    binary = os.environ.get('KICAD_CLI','kicad-cli')
    native_reports = {}
    for label,path in (('baseline',native),('candidate',candidate)):
        report = output/(label+'-drc.json')
        command = [binary,'pcb','drc','--schematic-parity','--refill-zones','--severity-all',
                   '--format','json','--units','mm','-o',str(report),str(path)]
        result = lean.run_stage(command,stage=label+'-drc',deadline=lean.deadline_after(20),
                                text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        (output/(label+'-drc.log')).write_text(result.stdout)
        native_reports[label]=checked_drc_report(report,path,command,result.returncode)
    return finish_placement_proof(output,native_reports)


def fp(ref,x,y,pad_x=0,locked=False):
    return f'''(footprint "Test:Exact" (layer "F.Cu") (at {x} {y}) (uuid "{ref}")
      {'(locked yes)' if locked else ''}
      (property "Reference" "{ref}" (at 0 0)) (property "Value" "fixture")
      (property "MPN" "EXACT") (property "LCSC" "C123")
      (fp_rect (start -0.5 -0.5) (end 0.5 0.5) (layer "F.CrtYd"))
      (pad "1" smd rect (at {pad_x} 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask") (net "N") (uuid "{ref}-pad")))'''


class EngineeringTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='engineering-constraints-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        folder = self.root/'hardware-design/boards/X'
        (folder/'cad').mkdir(parents=True)
        (folder/'gate.json').write_text(json.dumps(dict(project='cad/X',checks=dict(erc=True,drc=True))))
        self.native = folder/'cad/X.kicad_pcb'
        self.text = '(kicad_pcb (version 20260101) '+fp('U1',10,10,1)+fp('C1',14,10)+fp('J1',1,3)+'''
        (gr_rect (start 0 0) (end 20 20) (layer "Edge.Cuts")))'''
        self.native.write_text(self.text)
        for extension in ('.kicad_pro','.kicad_dru','.kicad_sch'):
            self.native.with_suffix(extension).write_text('fixture')
        self.document = self.root/'reviewed.pdf'
        self.document.write_bytes(b'%PDF-1.4 fixture-source-only\n')
        self.source = dict(path='reviewed.pdf',sha256=sha(self.document),page=1)
        self.manifest = self.root/'parts.json'
        self.manifest.write_text('{"fixture":true}\n')
        self.review = dict(status='passed',constraints=dict(schema=engineering.SCHEMA,rules=[]),
            native_inputs={str(self.native.with_suffix(e)):sha(self.native.with_suffix(e))
                           for e in ('.kicad_pcb','.kicad_sch','.kicad_pro','.kicad_dru')})
        self.verify = mock.Mock(side_effect=lambda *_:copy.deepcopy(self.review))
        patch = mock.patch.dict(sys.modules,{'part_evidence':SimpleNamespace(verify_manifest=self.verify)})
        patch.start();self.addCleanup(patch.stop)

    def rule(self,kind,**fields):
        return dict(id='reviewed-'+kind,kind=kind,source=copy.deepcopy(self.source),**fields)

    def rules(self,*rules):
        self.review['constraints']['rules'] = list(rules)

    def check(self,candidate=None):
        return engineering.check_manifest(self.root,'X',self.manifest,candidate)

    def candidate(self,text):
        path = self.root/'candidate.kicad_pcb';path.write_text(text)
        return path

    def problem(self,group=False):
        refs = [['U1','C1'],['J1']] if group else [['U1'],['C1'],['J1']]
        positions = [(12,10),(1,3)] if group else [(10,10),(14,10),(1,3)]
        return dict(board_file=str(self.native),units=[dict(name=','.join(r),refs=r,x=x,y=y,fixed=False,
                    rects=[[-.5,-.5,.5,.5,0]]) for r,(x,y) in zip(refs,positions)],
                    nets=[],board=dict(outline=[[0,0],[20,0],[20,20],[0,20]],keepouts=[],edge_clearance=0))

    def test_pin_distance_uses_actual_pad_centers_and_native_candidate(self):
        self.rules(self.rule('pin_distance',a=dict(ref='U1',pad='1'),b=dict(ref='C1',pad='1'),
                             metric='pad_center_euclidean',max_mm=3))
        self.assertEqual(self.check()['status'],'passed')
        report = self.check(self.candidate(self.text.replace('(at 14 10)','(at 15 10)')))
        self.assertEqual(report['status'],'blocked')
        self.assertEqual(report['blockers'][0]['measured_mm'],4)
        self.assertEqual(report['blockers'][0]['source'],self.source)
        self.assertFalse(report['qualified'])

    def test_clearance_uses_copper_edges_and_rejects_unsupported_pad_shape(self):
        self.rules(self.rule('clearance',a=dict(ref='U1',pad='1'),b=dict(ref='C1',pad='1'),
                             metric='copper_edge_2d',min_mm=2))
        self.assertEqual(self.check()['status'],'passed')
        report = self.check(self.candidate(self.text.replace('(at 14 10)','(at 13 10)')))
        self.assertEqual(report['blockers'][0]['measured_mm'],1)
        self.native.write_text(self.text.replace('smd rect','smd oval'))
        self.review['native_inputs'][str(self.native)] = sha(self.native)
        self.assertIn('unsupported exact copper',self.check()['unsupported'][0])

    def test_connector_corridor_requires_outward_exit_and_clear_native_courtyards(self):
        self.rules(self.rule('connector_access',ref='J1',metric='courtyard_corridor_2d',
                             corridor_mm=[-4,-.6,0,.6],exit_side='L'))
        self.assertEqual(self.check()['status'],'passed')
        report = self.check(self.candidate(self.text.replace('(at 14 10)','(at 0 3)')))
        self.assertEqual(report['blockers'][0]['blocking_refs'],['C1'])
        self.review['constraints']['rules'][0]['exit_side']='R'
        self.assertFalse(self.check()['blockers'][0]['reaches_requested_edge'])

    def test_fixed_and_native_locked_parts_cannot_move(self):
        self.rules(self.rule('fixed',refs=['U1']))
        self.assertEqual(self.check(self.candidate(self.text.replace('(at 10 10)','(at 11 10)')))['status'],'blocked')
        self.rules()
        self.native.write_text(self.text.replace('(uuid "U1")','(uuid "U1") (locked yes)'))
        self.review['native_inputs'][str(self.native)] = sha(self.native)
        moved = self.native.read_text().replace('(at 10 10)','(at 11 10)')
        self.assertEqual(self.check(self.candidate(moved))['blockers'][0]['code'],'native_locked_part_moved')

    def test_rigid_group_preserves_relative_native_geometry(self):
        self.rules(self.rule('rigid_group',refs=['U1','C1']))
        together = self.text.replace('(at 10 10)','(at 11 10)').replace('(at 14 10)','(at 15 10)')
        self.assertEqual(self.check(self.candidate(together))['status'],'passed')
        self.assertEqual(self.check(self.candidate(self.text.replace('(at 14 10)','(at 15 10)')))['status'],'blocked')
        with self.assertRaisesRegex(ValueError,'intact placement unit'):
            engineering.prepare_problem(self.root,'X',self.manifest,self.problem())
        prepared = engineering.prepare_problem(self.root,'X',self.manifest,self.problem(group=True))
        self.assertEqual(engineering.check_problem(prepared,[[13,10,0],[1,3,0]])['status'],'passed')

    def test_pose_violations_remain_repairable_and_reach_the_production_legalizer(self):
        self.rules(self.rule('pin_distance',a=dict(ref='U1',pad='1'),b=dict(ref='C1',pad='1'),
                             metric='pad_center_euclidean',max_mm=2))
        prepared = engineering.prepare_problem(self.root,'X',self.manifest,self.problem())
        self.assertEqual(prepared['engineering']['initial_screen']['status'],'blocked')
        from placer import cost
        initial = cost.initial_pose(prepared)
        self.assertEqual(cost.rule_miss(prepared,initial,1),1)
        corrected = [initial[0],(13,10,0),initial[2]]
        self.assertEqual(cost.rule_miss(prepared,corrected,1),0)
        self.assertEqual(engineering.check_problem(prepared,corrected)['status'],'passed')

    def test_soft_clusters_give_way_to_every_reviewed_rule(self):
        from placer import anneal, cost, membership
        self.rules(self.rule('fixed',refs=['J1']),self.rule('rigid_group',refs=['U1','C1']),
                   self.rule('pin_distance',a=dict(ref='C1',pad='1'),b=dict(ref='J1',pad='1'),
                             metric='pad_center_euclidean',min_mm=8))
        problem = self.problem(group=True)
        tie = dict(ref='C1',pad='1',to='J1',to_pad='1',net='N',rule='support',why='test')
        problem['clusters'],nets = membership.cluster_model(problem['units'],{'U1':0,'C1':0,'J1':1},
            dict(clusters=[dict(name='J1',anchor='J1',why='test',ties=[tie])]),lambda ref,num,net:[0.,0.],40.)
        problem['nets'] += nets
        prepared = engineering.prepare_problem(self.root,'X',self.manifest,problem)
        self.assertEqual(prepared['clusters'],problem['clusters'])
        self.assertTrue(prepared['units'][1]['fixed'])
        # The tie pulls C1 onto J1; the reviewed minimum, the fixed J1 and the rigid U1 + C1 all hold.
        result = anneal.optimize(prepared,dict(mask_cell=.25),workers=1,epochs=4,steps=800,seed=1,top=1)
        pose = result['candidates'][0]['pose']
        self.assertEqual(result['candidates'][0]['illegal'],[])
        self.assertEqual(engineering.check_problem(prepared,pose)['status'],'passed')
        self.assertEqual(tuple(pose[1]),tuple(cost.initial_pose(prepared)[1]))

    def test_missing_or_unreviewed_source_and_unknown_fields_fail_closed(self):
        for change in (dict(status='blocked',blockers=[dict(code='datasheet_review_missing')]),):
            self.review.update(change)
            self.assertIn('incomplete',self.check()['blockers'][0]['detail'])
        self.review['status']='passed'
        self.rules(self.rule('fixed',refs=['U1'],unmodeled_condition='hot_only'))
        self.assertIn('unsupported constraint fields',self.check()['unsupported'][0])
        self.rules(self.rule('thermal_loop',refs=['U1']))
        self.assertIn('unsupported engineering constraint',self.check()['unsupported'][0])

    def test_changed_pdf_rules_and_footprint_pinmap_cannot_reuse_review(self):
        self.rules(self.rule('fixed',refs=['U1']))
        self.document.write_bytes(b'changed PDF')
        self.assertEqual(self.check()['status'],'stale')
        self.document.write_bytes(b'%PDF-1.4 fixture-source-only\n')
        self.native.with_suffix('.kicad_dru').write_text('changed rules')
        self.assertEqual(self.check()['status'],'stale')
        self.native.with_suffix('.kicad_dru').write_text('fixture')
        report = self.check(self.candidate(self.text.replace('(net "N")','(net "WRONG")',1)))
        self.assertIn('pad nets changed',report['blockers'][0]['detail'])

    def test_prepared_model_is_source_bound_and_legacy_is_explicitly_unreviewed(self):
        self.rules(self.rule('fixed',refs=['U1']))
        prepared = engineering.prepare_problem(self.root,'X',self.manifest,self.problem())
        self.assertTrue(prepared['units'][0]['fixed'])
        tampered = copy.deepcopy(prepared);tampered['units'][0]['x'] += 1
        with self.assertRaisesRegex(ValueError,'anchors changed'):engineering.check_problem(tampered)
        self.manifest.write_text('changed')
        with self.assertRaisesRegex(ValueError,'input changed'):engineering.check_problem(prepared)
        self.assertEqual(engineering.check_problem(self.problem())['status'],'legacy_unreviewed')

    def test_self_hashed_rule_or_geometry_changes_cannot_replace_actual_review(self):
        self.rules(self.rule('pin_distance',a=dict(ref='U1',pad='1'),b=dict(ref='C1',pad='1'),
                             metric='pad_center_euclidean',max_mm=3))
        prepared = engineering.prepare_problem(self.root,'X',self.manifest,self.problem())
        pose = [[10,10,0],[15,10,0],[1,3,0]]
        self.assertEqual(engineering.check_problem(prepared,pose)['status'],'blocked')
        for mutation in ('rule','geometry'):
            with self.subTest(mutation=mutation):
                edited = copy.deepcopy(prepared)
                if mutation=='rule':
                    edited['engineering']['rules'][0]['max_mm']=3000
                else:
                    edited['engineering']['geometry']['refs']['C1']['pads']['1'][0]['center'][0]-=1
                edited['engineering']['review_sha256']=engineering.contract_digest(edited['engineering'])
                # A fresh JSON consumer has no trusted in-memory producer object.
                engineering._TRUSTED_CONTRACTS.clear()
                with self.assertRaisesRegex(ValueError,'actual reviewed source contract'):
                    engineering.check_problem(edited,pose)
        self.assertGreaterEqual(self.verify.call_count,3)

    def test_projection_mapping_native_locks_and_writer_source_remain_bound(self):
        self.rules(self.rule('fixed',refs=['U1']))
        prepared = engineering.prepare_problem(self.root,'X',self.manifest,self.problem())
        changed = copy.deepcopy(prepared);changed['engineering']['where']['U1']=1
        with self.assertRaisesRegex(ValueError,'reference-to-unit mapping changed'):
            engineering.check_problem(changed)
        changed = copy.deepcopy(prepared);changed['board_file']=str(self.candidate(self.text))
        with self.assertRaisesRegex(ValueError,'source differs'):
            engineering.check_problem(changed)
        self.native.write_text(self.text.replace('(uuid "U1")','(uuid "U1") (locked yes)',1))
        self.review['native_inputs'][str(self.native)]=sha(self.native)
        self.rules()
        locked = engineering.prepare_problem(self.root,'X',self.manifest,self.problem())
        moved = engineering.check_problem(locked,[[11,10,0],[14,10,0],[1,3,0]])
        self.assertEqual(moved['status'],'blocked')
        self.assertEqual(moved['blockers'][0]['code'],'native_locked_part_moved')

    def test_real_placement_run_stops_stale_review_before_worker_admission(self):
        from placer import cli
        self.rules(self.rule('fixed',refs=['U1']))
        prepared = engineering.prepare_problem(self.root,'X',self.manifest,self.problem())
        path = self.root/'problem.json';path.write_text(json.dumps(prepared))
        self.document.write_bytes(b'changed source PDF')
        with mock.patch.object(cli.resources,'reserve') as reserve, mock.patch.object(cli.anneal,'optimize') as optimize:
            with self.assertRaisesRegex(ValueError,'input changed'):
                cli.cmd_run(SimpleNamespace(prob=str(path),o=str(self.root/'result.json')))
        reserve.assert_not_called();optimize.assert_not_called()

    def test_cli_writer_rejects_wrong_source_before_replacing_any_output(self):
        from placer import cli, cost
        import placer
        self.rules(self.rule('fixed',refs=['U1']))
        prepared=engineering.prepare_problem(self.root,'X',self.manifest,self.problem())
        path=self.root/'problem.json';path.write_text(json.dumps(prepared))
        result=self.root/'result.json';result.write_text(json.dumps(dict(candidates=[dict(pose=cost.initial_pose(prepared))])))
        output=self.root/'output';output.mkdir();marker=output/'keep.txt';marker.write_text('existing result')
        args=SimpleNamespace(board=str(self.candidate(self.text)),prob=str(path),result=str(result),initial=False,outdir=str(output))
        writer=mock.Mock()
        with mock.patch.object(placer,'kicad_io',SimpleNamespace(write_board=writer),create=True), \
             mock.patch.object(cli.shutil,'copytree') as copytree,mock.patch.object(cli.shutil,'rmtree') as remove:
            with self.assertRaisesRegex(ValueError,'writer source differs'):cli.cmd_write(args)
        copytree.assert_not_called();remove.assert_not_called();writer.assert_not_called()
        self.assertEqual(marker.read_text(),'existing result')

    def test_compact_pre_route_screens_actual_copy_under_reviewed_owner_root(self):
        from placer import compact_cli
        import route_decision
        self.rules(self.rule('escape',refs=['U1'],metric='native_minimum_track_escape'))
        prepared=engineering.prepare_problem(self.root,'X',self.manifest,self.problem())
        candidate=self.candidate(self.text);output=self.root/'pre-route.json'
        receipt=output.with_name('pre-route-escape.json')
        with mock.patch.object(route_decision,'generate_escape_for_candidate') as generate, \
             mock.patch.object(engineering,'check_manifest',return_value=dict(status='passed',qualified=False)) as check:
            report=compact_cli.engineering_route_check(prepared,candidate,output)
        self.assertEqual(report['status'],'passed')
        generate.assert_called_once_with(str(self.root.resolve()),'X',candidate,receipt)
        check.assert_called_once_with(str(self.root.resolve()),'X',str(self.manifest.resolve()),candidate,escape_evidence=receipt)
        self.assertEqual(json.loads(output.read_text())['status'],'passed')
        self.document.write_bytes(b'changed before native screen')
        with mock.patch.object(route_decision,'generate_escape_for_candidate') as generate:
            with self.assertRaisesRegex(ValueError,'input changed'):
                compact_cli.engineering_route_check(prepared,candidate,self.root/'stale.json')
        generate.assert_not_called()

    def imported_native_fixture(self):
        output=self.root/'proof';output.mkdir()
        candidate=self.candidate(self.text)
        for ext in NATIVE_SIDECARS[1:]:shutil.copyfile(self.native.with_suffix(ext),candidate.with_suffix(ext))
        checkpoint=dict(schema='iot-lab.native-placement-proof-checkpoint.v1',status='awaiting_native_drc',
            reconstructed_after_runtime_timeout=False,source_guard_scope='declared reviewed inputs captured before native DRC',
            source_inputs={str(self.document):sha(self.document)},artifacts={},candidate=str(candidate),
            candidate_inputs=proof_inputs(candidate),result=dict(native_source=str(self.native),qualified=False))
        checkpoint['checkpoint_sha256']=engineering.fingerprint(checkpoint)
        (output/'checkpoint.json').write_text(json.dumps(checkpoint))
        reports={}
        for label,native in (('source',self.native),('candidate',candidate)):
            path=output/(label+'-drc.json')
            path.write_text(json.dumps(dict(source=native.name,coordinate_units='mm',
                included_severities=['error','warning','exclusion'],violations=[dict(severity='warning')]*8,
                schematic_parity=[],unconnected_items=[])))
            reports[label]=dict(inputs={str(native.with_suffix(ext)):digest for ext,digest in
                ((Path(name).suffix,value) for name,value in proof_inputs(native).items())},
                report='/remote/evidence/'+path.name,report_sha256=sha(path),returncode=0,timeout_s=20,source_unchanged=True,
                command=['kicad-cli','pcb','drc','--schematic-parity','--refill-zones','--severity-all'])
        record=dict(schema='iot-lab.native-placement-drc.v1',status='passed',tool_sha256='a'*64,
            runtime=dict(image_id='sha256:'+'b'*64,kicad_version='10.0.6'),reports=reports)
        receipt=output/'receipt.json';receipt.write_text(json.dumps(record))
        return output,receipt,record

    def test_imported_drc_requires_exact_inputs_report_and_completed_native_command(self):
        output,receipt,record=self.imported_native_fixture()
        result=import_placement_drc(output,receipt)
        self.assertEqual(result['native_reports']['baseline']['warnings'],8)
        self.assertEqual(result['native_reports']['candidate']['errors'],0)
        self.assertFalse(result['qualified'])
        for fault in ('input','command','returncode','runtime','report'):
            changed=copy.deepcopy(record)
            if fault=='input':changed['reports']['source']['inputs'][str(self.native)]='0'*64
            elif fault=='command':changed['reports']['source']['command'].remove('--schematic-parity')
            elif fault=='returncode':changed['reports']['source'].pop('returncode')
            elif fault=='runtime':changed['runtime']={}
            else:changed['reports']['candidate']['report_sha256']='0'*64
            receipt.write_text(json.dumps(changed))
            with self.subTest(fault=fault),self.assertRaises(ValueError):import_placement_drc(output,receipt)

    def test_checkpoint_preserves_declared_inputs_but_allows_new_housekeeping(self):
        output,receipt,_=self.imported_native_fixture()
        self.native.with_suffix('.kicad_prl').write_text('new runtime housekeeping')
        self.assertTrue(import_placement_drc(output,receipt)['source_unchanged'])
        self.document.write_bytes(b'changed declared review source')
        with self.assertRaisesRegex(ValueError,'declared placement source'):import_placement_drc(output,receipt)
        self.document.write_bytes(b'%PDF-1.4 fixture-source-only\n')
        checkpoint=json.loads((output/'checkpoint.json').read_text());checkpoint['candidate_inputs']={}
        (output/'checkpoint.json').write_text(json.dumps(checkpoint))
        with self.assertRaisesRegex(ValueError,'checkpoint changed'):import_placement_drc(output,receipt)

    def test_frozen_remote_model_is_explicit_and_cannot_bypass_writer_source_recheck(self):
        from placer import cli, cost
        self.rules(self.rule('fixed',refs=['U1']))
        prepared = engineering.prepare_problem(self.root,'X',self.manifest,self.problem())
        path = self.root/'problem.json';path.write_text(json.dumps(prepared))
        args = SimpleNamespace(prob=str(path),o=str(self.root/'result.json'),workers=1,epochs=1,steps=1,
            seed=1,top=1,param=[],engineering_frozen_model_sha256='wrong')
        with mock.patch.object(cli.resources,'reserve') as reserve:
            with self.assertRaisesRegex(ValueError,'fingerprint differs'):cli.cmd_run(args)
        reserve.assert_not_called()
        args.engineering_frozen_model_sha256=hashlib.sha256(path.read_bytes()).hexdigest()
        self.document.write_bytes(b'producer input changed while remote work was running')
        candidate = dict(cost=0,components=dict(hpwl=0,cong=0,overlap=0,oob=0),
                         illegal=[],mains=[],worker=0,pose=cost.initial_pose(prepared),timeout=False)
        result = dict(initial=copy.deepcopy(candidate),candidates=[copy.deepcopy(candidate)],wall_s=0,moves_per_s_per_worker=0)
        with mock.patch.object(cli.resources,'reserve',return_value=contextlib.nullcontext({})), \
             mock.patch.object(cli.resources,'environment',return_value=contextlib.nullcontext()), \
             mock.patch.object(cli.anneal,'optimize',return_value=result),mock.patch('builtins.print'):
            cli.cmd_run(args)
        shown = json.loads(Path(args.o).read_text())
        self.assertIn('producer must recheck',shown['engineering_source_verification'])
        self.assertFalse(shown['candidates'][0]['engineering']['qualified'])
        with self.assertRaisesRegex(ValueError,'input changed'):
            engineering.check_problem(prepared,shown['candidates'][0]['pose'])

    def test_frozen_digest_checks_the_same_bytes_that_are_parsed(self):
        from placer import cli
        prepared=engineering.prepare_problem(self.root,'X',self.manifest,self.problem())
        path=self.root/'problem.json';path.write_text(json.dumps(prepared))
        expected=hashlib.sha256(path.read_bytes()).hexdigest()
        edited=copy.deepcopy(prepared);edited['engineering']['geometry']['refs']['U1']['pads']['1'][0]['center'][0]+=1
        edited['engineering']['review_sha256']=engineering.contract_digest(edited['engineering'])
        payload=json.dumps(edited).encode();real_open=open;reads=[]
        def swapped_open(name,mode='r',*args,**kwargs):
            if Path(name)==path and not reads:
                reads.append(name)
                return io.BytesIO(payload) if 'b' in mode else io.StringIO(payload.decode())
            return real_open(name,mode,*args,**kwargs)
        args=SimpleNamespace(prob=str(path),engineering_frozen_model_sha256=expected)
        with mock.patch('builtins.open',side_effect=swapped_open),mock.patch.object(cli.resources,'reserve') as reserve:
            with self.assertRaisesRegex(ValueError,'fingerprint differs'):cli.cmd_run(args)
        reserve.assert_not_called()

    def test_bound_block_is_an_actual_native_instance_and_never_transfers_qualification(self):
        from test_pcb_search_block_bindings import BlockBindingsTest
        from pcb_search.block_bindings import bind_instance
        fixture = BlockBindingsTest();fixture.setUp()
        try:
            from test_pcb_search_block_bindings import fp as bound_fp
            self.native.write_text(fixture.target.read_text()[:-1]+bound_fp('R9','/outside','Z','28 28',0)+')')
            self.review['native_inputs'][str(self.native)] = sha(self.native)
            binding = bind_instance(fixture.block,self.native,'/instance')
            path = self.root/'binding.json';path.write_text(json.dumps(binding))
            bound = self.rule('rigid_group',refs=['R7','R8'],binding=dict(path=str(path),sha256=sha(path)))
            self.rules(bound)
            self.assertIn('layout-rule coverage missing',self.check()['blockers'][0]['detail'])
            bound['binding'].update(layout_rule_ids={},boundary_rule_ids=['boundary'])
            boundary = self.rule('clearance',a=dict(ref='R7',pad='1'),b=dict(ref='R9',pad='1'),metric='copper_edge_2d',min_mm=1)
            boundary['id']='boundary'
            self.rules(bound,boundary)
            report = self.check()
            self.assertEqual(report['status'],'passed',report)
            self.assertFalse(report['reuse'][0]['qualification_transferred'])
            problem = dict(board_file=str(self.native),units=[dict(name='module',refs=['R7','R8'],x=15,y=16,fixed=False),
                           dict(name='external',refs=['R9'],x=28,y=28,fixed=False)],
                           board=dict(outline=[[0,0],[30,0],[30,30],[0,30]]))
            prepared = engineering.prepare_problem(self.root,'X',self.manifest,problem)
            self.assertEqual(engineering.check_problem(prepared,[[16,16,0],[28,28,0]])['status'],'passed')
            fixture.source.write_text(fixture.source.read_text()[:-1]+
                '(segment (start 2 3) (end 3 3) (width .2) (layer "F.Cu") (net "A")))')
            path.write_text(json.dumps(bind_instance(fixture.block,self.native,'/instance')))
            bound['binding']['sha256']=sha(path)
            self.rules(bound,boundary)
            frozen = engineering.prepare_problem(self.root,'X',self.manifest,problem)
            self.assertTrue(frozen['units'][0]['fixed'])
            blocked = engineering.check_problem(frozen,[[16,16,0],[28,28,0]])
            self.assertEqual(blocked['blockers'][0]['policy'],'fixed_retained_copper')
            (fixture.block/'facts.json').write_text('{"level":1}')
            with self.assertRaisesRegex(ValueError,'changed|stale'):engineering.check_problem(frozen)
        finally:
            fixture.doCleanups()

    def test_escape_requires_native_evidence_and_never_claims_no_path(self):
        self.rules(self.rule('escape',refs=['U1'],metric='native_minimum_track_escape'))
        report = self.check()
        self.assertEqual(report['blockers'][0]['code'],'native_escape_evidence_missing')
        self.assertNotIn('unroutable',json.dumps(report))

    def test_reviewed_escape_overrides_cannot_silently_become_grid_defaults(self):
        self.rules(self.rule('escape',refs=['U1'],metric='native_minimum_track_escape',width_mm=1))
        self.assertIn('unsupported native escape overrides',self.check()['unsupported'][0])

    def test_backend_writes_a_machine_readable_report(self):
        self.rules(self.rule('fixed',refs=['U1']))
        out = self.root/'report.json'
        with mock.patch('builtins.print'):
            self.assertEqual(engineering.main(['check','X','--root',str(self.root),'--manifest',str(self.manifest),
                                               '--output',str(out),'--json']),0)
        self.assertEqual(json.loads(out.read_text())['status'],'passed')


if __name__ == '__main__':
    unittest.main()
