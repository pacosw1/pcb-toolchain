"""Source-bound lifecycle plans and actual existing-verifier adapters."""
import contextlib
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

import design_contract as design
import part_evidence
import part_native
from test_part_evidence import make_fixture


def idea_fixture(root, board=None):
    """Explicit synthetic idea; no native files or supplier selection needed."""
    root=Path(root);root.mkdir(parents=True,exist_ok=True)
    spec=root/'idea.md';spec.write_text('SYNTHETIC TEST IDEA. Output requirement3.0..3.6V. '
        'Explicit interface and architecture decision. Use test access P1. '
        'Failure: output outside sourced interval. Bench numbers are fixture data, never measured production hardware.\n')
    def source(section):return dict(path='idea.md',sha256=design.sha(spec),section=section)
    requirement=dict(id='OUTPUT',statement='Synthetic output interval',source=source('Output'),verification_stage='prototype',
        acceptance=dict(kind='interval',min=3,max=3.6,unit='V',source=source('Output requirement')))
    value=dict(schema=design.SCHEMA,identity=dict(design_id='IDEA-FIXTURE',board=board,revision='synthetic-1'),current_stage='requirements',
        requirements=[requirement],architecture=dict(source=source('Architecture'),
            interfaces=[dict(id='OUTPUT-PORT',requirements=['OUTPUT'],source=source('Interface'))],
            decisions=[dict(id='TOPOLOGY',requirements=['OUTPUT'],source=source('Architecture choice'))]),
        test_plans=[dict(id='OUTPUT-TEST',requirements=['OUTPUT'],stage='prototype',method='Measure output under sourced operating condition',
            procedure=source('Procedure'),access=source('Test access'),equipment=source('Instrument capability'),
            failure_conditions=source('Failure response'),signals=[dict(net='/A',ref='J1',pad='1')],check='MEASURE')],
        failure_conditions=[dict(id='OUTSIDE-OUTPUT',requirements=['OUTPUT'],source=source('Failure'),condition='Output outside reviewed interval',test_plan='OUTPUT-TEST')],
        unknowns=[],checks=[dict(id='MEASURE',stage='prototype',kind='bench',requirements=['OUTPUT'],path='bench/results.json',plan='bench/plan.json')],production={})
    path=root/'design.json';path.write_text(json.dumps(value,indent=2)+'\n')
    return path


def selection_fixture(root):
    """Reviewed synthetic demands, before any native assets are available."""
    root=Path(root)
    part=make_fixture(root)
    value=json.loads(part.read_text())
    for row in value['parts']:row['native']={}
    value['budgets']=[]
    value['review']['facts_sha256']=part_evidence.facts_digest(value)
    part.write_text(json.dumps(value))
    for path in (root/'hardware-design/boards/PART-FIXTURE').iterdir():
        if path.name!='SPEC.md':path.unlink()
    contract=idea_fixture(root)
    value=json.loads(contract.read_text())
    value['identity']['design_id']='PART-FIXTURE'
    value['checks'].append(dict(id='SELECT',stage='parts',kind='part_selection',requirements=['OUTPUT'],
        path=part.relative_to(root).as_posix(),references=['J1']))
    contract.write_text(json.dumps(value))
    return contract,part


class PreCadSelectionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()
        self.path,self.part=selection_fixture(self.root)
        self.pages=mock.patch.object(part_evidence,'pdf_pages',return_value=1)
        self.pages.start();self.addCleanup(self.pages.stop)

    def test_reviewed_selection_passes_before_cad_without_native_or_stock_claims(self):
        with mock.patch.object(part_native,'read_board',side_effect=AssertionError('native reader forbidden before CAD')):
            result=design.evaluate_contract(self.root,self.path,'parts')
        self.assertEqual(result['status'],'passed',result['blockers'])
        checked=result['check_results']['SELECT']
        self.assertEqual(checked['kind'],'part_selection')
        for flag in ('native_verified','cad_verified','stock_current'):self.assertFalse(checked[flag])
        self.assertFalse(result['qualified']);self.assertIsNone(result['board'])
        self.assertTrue(design.current_assessment(result))
        (self.root/'hardware-design/boards/PART-FIXTURE/SPEC.md').write_text('Changed demand')
        self.assertFalse(design.current_assessment(result))

    def test_wrong_design_owner_and_unreviewed_reference_block_selection(self):
        value=json.loads(self.path.read_text())
        value['identity']['design_id']='OTHER-IDEA'
        self.path.write_text(json.dumps(value))
        self.assertEqual(design.evaluate_contract(self.root,self.path,'parts')['status'],'blocked')
        value['identity']['design_id']='PART-FIXTURE'
        value['checks'][-1]['references']=['U-NOT-REVIEWED']
        self.path.write_text(json.dumps(value))
        result=design.evaluate_contract(self.root,self.path,'parts')
        self.assertEqual(result['status'],'blocked')
        self.assertIn('exact reviewed planned references',str(result['blockers']))

    def test_previous_planned_revision_cannot_supply_the_parts_decision(self):
        value=json.loads(self.path.read_text())
        value['identity']['revision']='synthetic-2'
        self.path.write_text(json.dumps(value))
        result=design.evaluate_contract(self.root,self.path,'parts')
        self.assertEqual(result['status'],'blocked')
        self.assertIn('exact design revision',str(result['blockers']))

    def test_early_selection_cannot_supply_native_or_numeric_final_acceptance(self):
        value=json.loads(self.path.read_text())
        value['identity']['board']='PART-FIXTURE'
        value['checks'][-1]['kind']='part_use'
        self.path.write_text(json.dumps(value))
        self.assertEqual(design.evaluate_contract(self.root,self.path,'parts')['status'],'blocked')
        value['checks'][-1]['kind']='part_selection'
        value['requirements'][0]['verification_stage']='parts'
        self.path.write_text(json.dumps(value))
        result=design.evaluate_contract(self.root,self.path,'parts')
        self.assertEqual(result['status'],'blocked')
        self.assertIn('cannot establish numeric functional acceptance',str(result['blockers']))


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.path=idea_fixture(self.root)

    def edit(self, callback):
        value=json.loads(self.path.read_text());callback(value);self.path.write_text(json.dumps(value));return value

    def report(self, through=None):return design.evaluate_contract(self.root,self.path,through)

    def codes(self, report):return {r['code'] for r in report['blockers']}

    def test_idea_without_gate_or_cad_can_record_plan_and_future_bench_does_not_block(self):
        result=self.report('architecture')
        self.assertEqual(result['status'],'passed',result['blockers'])
        self.assertIsNone(result['board']);self.assertFalse(result['qualified']);self.assertFalse(result['functional_qualification'])
        self.assertFalse((self.root/'bench').exists())
        self.assertEqual(result['stages']['prototype']['readiness'],'future_evidence_not_requested')
        self.assertFalse(result['requirement_results']['OUTPUT']['required_now'])

    def test_unknown_blocks_only_its_explicit_stage(self):
        def add(v):v['unknowns']=[dict(id='CURRENT',question='Maximum load not decided',owner='designer',blocking_stage='parts',source=v['requirements'][0]['source'])]
        self.edit(add)
        self.assertEqual(self.report('architecture')['status'],'passed')
        self.assertIn('unresolved_unknown',self.codes(self.report('parts')))

    def test_missing_architecture_and_failure_links_block_architecture(self):
        self.edit(lambda v:v.update(architecture=None,failure_conditions=[]))
        self.assertEqual(self.report('requirements')['status'],'passed')
        self.assertIn('architecture_plan',self.codes(self.report('architecture')))

    def test_source_change_is_stale_and_empty_or_wrong_units_do_not_parse(self):
        (self.root/'idea.md').write_text('Changed physical limit')
        self.assertEqual(self.report()['status'],'stale')
        self.path=idea_fixture(self.root)
        self.edit(lambda v:v['requirements'][0]['acceptance'].update(min=float('nan')))
        self.assertEqual(self.report()['status'],'blocked')

    def test_invalid_sources_keep_requested_stage_and_design_identity(self):
        (self.root/'idea.md').write_text('Changed source')
        result=self.report('architecture')
        self.assertEqual(result['through'],'architecture');self.assertEqual(result['design_id'],'IDEA-FIXTURE')
        self.assertEqual(result['status'],'stale')

    def test_output_keeps_full_evidence_and_stdout_is_compact_receipt(self):
        output=self.root/'assessment.json';stdout=io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code=design.main(['check','IDEA-FIXTURE','--contract',str(self.path),'--root',str(self.root),
                '--through','architecture','--json','--output',str(output)])
        self.assertEqual(code,0)
        receipt=json.loads(stdout.getvalue());full=json.loads(output.read_text())
        self.assertEqual(receipt['status'],'passed');self.assertFalse(receipt['qualified'])
        self.assertEqual(receipt['report'],dict(path=str(output.resolve()),sha256=design.sha(output)))
        self.assertNotIn('inputs',receipt);self.assertNotIn('requirement_results',receipt)
        self.assertTrue(full['inputs']);self.assertIn('OUTPUT',full['requirement_results'])
        self.assertEqual(receipt['blockers'],len(full['blockers']))

    def test_requirement_lookup_and_source_closure_are_actual(self):
        self.assertEqual(design.requirement(self.root,self.path,'OUTPUT')['acceptance']['unit'],'V')
        self.assertEqual(set(design.dependency_files(self.root,self.path,'architecture')),{'design.json','idea.md'})
        with self.assertRaisesRegex(ValueError,'unknown design requirement'):design.requirement(self.root,self.path,'MISSING')

    def test_dft_plans_required_before_layout_and_no_native_is_explicit(self):
        self.edit(lambda v:v.update(test_plans=[],failure_conditions=[]))
        result=self.report('placement')
        self.assertIn('architecture_plan',self.codes(result));self.assertEqual(result['stages']['placement']['readiness'],'upstream_stage_blocked')
        self.assertFalse(result['qualified'])

    def test_declared_passed_or_unknown_verifier_does_not_prove_a_function(self):
        self.edit(lambda v:v.update(passed=True))
        self.assertEqual(self.report()['status'],'blocked')

    def test_unknown_numeric_conditions_are_not_silently_dropped(self):
        self.edit(lambda v:v['requirements'][0]['acceptance'].update(conditions={'temperature':25}))
        result=self.report();self.assertEqual(result['status'],'blocked')
        self.assertIn('conditions',result['blockers'][0]['detail'])
        self.path=idea_fixture(self.root)
        self.edit(lambda v:v['checks'][0].update(kind='file_exists'))
        self.assertEqual(self.report()['status'],'blocked')

    def test_cli_wrong_design_id_keeps_durable_blocked_report(self):
        output=self.root/'result.json'
        with contextlib.redirect_stdout(io.StringIO()):
            code=design.main(['check','WRONG','--root',str(self.root),'--contract',str(self.path),'--json','--output',str(output)])
        self.assertEqual(code,1);self.assertEqual(json.loads(output.read_text())['blockers'][-1]['code'],'design_identity')

    def test_future_missing_measurements_become_required_only_at_prototype(self):
        self.assertEqual(self.report('architecture')['status'],'passed')
        result=self.report('prototype')
        self.assertIn('stage_evidence_missing',self.codes(result));self.assertEqual(result['requirement_results']['OUTPUT']['status'],'blocked')
        self.assertEqual(result['stages']['prototype']['readiness'],'upstream_stage_blocked')

    def test_production_scope_must_name_all_controls_even_if_missing(self):
        result=self.report('production')
        self.assertEqual(result['status'],'blocked')
        self.assertEqual(result['stages']['production']['readiness'],'upstream_stage_blocked')

    def test_upstream_failure_prevents_later_verifier_work(self):
        with mock.patch.object(design,'_adapter') as adapter:
            result=self.report('production')
        adapter.assert_not_called();self.assertEqual(result['stages']['parts']['status'],'blocked')

    def test_missing_active_checker_is_bound_even_without_board_or_passing_prerequisite(self):
        def check(v):v['checks'].append(dict(id='PARTS',stage='parts',kind='part_use',requirements=['OUTPUT'],path='missing-review.json',references=['U1']))
        self.edit(check);result=self.report('parts')
        self.assertIn(str(self.root/'missing-review.json'),result['absent_inputs'])
        self.assertTrue(design.current_assessment(result))
        (self.root/'missing-review.json').write_text('{}')
        self.assertFalse(design.current_assessment(result))

    def test_current_day_release_expires_but_explicit_historical_context_is_not_current_stock(self):
        result=self.report();self.assertTrue(design.current_assessment(result))
        result['temporal_context']=[dict(order_day_utc='2000-01-01',requires_current_day=True)]
        self.assertFalse(design.current_assessment(result))
        result['temporal_context'][0]['requires_current_day']=False
        self.assertTrue(design.current_assessment(result));self.assertFalse(result['qualified'])

    def test_contract_mutation_during_assessment_is_rejected(self):
        original=design.dependency_files
        def changed(*args,**kwargs):
            result=original(*args,**kwargs);self.path.write_text(self.path.read_text()+'\n');return result
        with mock.patch.object(design,'dependency_files',side_effect=changed):result=self.report()
        self.assertEqual(result['status'],'stale')


class ActualVerifierTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()
        self.part=make_fixture(self.root);self.path=idea_fixture(self.root,'PART-FIXTURE')
        board=self.root/'hardware-design/boards/PART-FIXTURE/fixture'
        board.with_suffix('.kicad_pro').write_text('{}\n');board.with_suffix('.kicad_dru').write_text('(version 1)\n')

    def report_base(self):return dict(inputs={},absent_inputs=[],contract=str(self.path),contract_sha256=design.sha(self.path),schematic_contracts=[])

    def test_existing_part_verifier_runs_and_pin_mutation_is_not_accepted(self):
        row=dict(id='PARTS',kind='part_use',stage='parts',requirements=['OUTPUT'],path=self.part.relative_to(self.root).as_posix(),references=['J1'])
        with mock.patch.object(part_evidence,'pdf_pages',return_value=1):
            result=design._adapter(self.root,design.load_contract(self.root,self.path),row,self.report_base())
            self.assertEqual(result['status'],'passed')
            native=self.root/'hardware-design/boards/PART-FIXTURE/fixture.kicad_pcb'
            native.write_text(native.read_text().replace('SYNTHETIC-TP','WRONG-MPN',1))
            with self.assertRaisesRegex(ValueError,'verifier blocked'):
                design._adapter(self.root,design.load_contract(self.root,self.path),row,self.report_base())

    def bench_fixture(self):
        value=design.load_contract(self.root,self.path);binding=design.design_binding(self.root,value)
        folder=self.root/'bench';folder.mkdir()
        calibration=folder/'calibration.txt';calibration.write_text('Synthetic test calibration attribution, no actual instrument claim.\n')
        descriptor=dict(path=calibration.name,sha256=design.sha(calibration),locator='Synthetic instrument')
        source=dict(path='idea.md',sha256=design.sha(self.root/'idea.md'),locator='Synthetic output acceptance')
        plan=dict(schema='iot-lab.block-bench-plan.v1',binding_sha256=binding,approved_by='synthetic-fixture',approved_at='2026-10-16T00:00:00Z',
            tests=[dict(id='OUTPUT-TEST',requirement='OUTPUT',min=3,max=3.6,unit='V',source=source)])
        (folder/'plan.json').write_text(json.dumps(plan))
        raw=folder/'raw.csv';raw.write_text('test_id,value,unit,instrument_id\nOUTPUT-TEST,3.3,V,METER\n')
        measured=dict(schema='iot-lab.block-bench.v1',binding_sha256=binding,operator='synthetic-fixture',measured_at='2026-10-16T01:00:00Z',board_serial='SYNTHETIC-NO-HARDWARE',
            instruments=[dict(id='METER',calibration_evidence=descriptor)],raw_data=dict(path=raw.name,sha256=design.sha(raw)))
        (folder/'results.json').write_text(json.dumps(measured))
        return value,value['checks'][0],raw

    def test_existing_raw_bench_verifier_recomputes_numeric_result(self):
        value,row,raw=self.bench_fixture();report=self.report_base()
        result=design._adapter(self.root,value,row,report)
        self.assertEqual(result['status'],'passed');self.assertIn(str(raw),report['inputs'])
        raw.write_text(raw.read_text().replace('3.3','4.0'))
        measured=self.root/'bench/results.json';data=json.loads(measured.read_text());data['status']='passed';data['raw_data']['sha256']=design.sha(raw);measured.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError,'outside sourced limits'):design._adapter(self.root,value,row,self.report_base())

    def test_bench_wrong_design_binding_and_changed_acceptance_block(self):
        value,row,_=self.bench_fixture()
        value['requirements'][0]['acceptance']['max']=5
        with self.assertRaisesRegex(ValueError,'exact design/native'):design._adapter(self.root,value,row,self.report_base())

    def test_json_contract_descriptor_has_no_text_locator_or_hash_cycle(self):
        child=self.root/'schematic.json'
        child.write_text(json.dumps(dict(design_contract=dict(path='design.json',sha256=design.sha(self.path)))))
        data=json.loads(self.path.read_text());data['checks'].append(dict(id='SCHEMATIC',kind='schematic',stage='schematic',requirements=['OUTPUT'],path='schematic.json'))
        self.path.write_text(json.dumps(data));child.write_text(json.dumps(dict(design_contract=dict(path='design.json',sha256=design.sha(self.path)))))
        files=design.dependency_files(self.root,self.path,'schematic')
        self.assertIn('schematic.json',files);self.assertIn('design.json',files)

    def test_absent_policy_descriptor_is_not_treated_as_an_existing_document(self):
        child=self.root/'schematic.json'
        child.write_text(json.dumps(dict(population_source=dict(path='variants.json',sha256=None,exists=False))))
        value=json.loads(self.path.read_text());value['checks'].append(dict(id='SCHEMATIC',kind='schematic',stage='schematic',requirements=['OUTPUT'],path='schematic.json'))
        self.path.write_text(json.dumps(value))
        self.assertIn('schematic.json',design.dependency_files(self.root,self.path,'schematic'))

    def test_passing_unrelated_checker_report_cannot_certify_requirements(self):
        child=self.root/'schematic.json'
        child.write_text(json.dumps(dict(design_contract=dict(path='design.json',sha256=design.sha(self.path)))))
        row=dict(id='SCHEMATIC',kind='schematic',stage='schematic',requirements=['OUTPUT'],path='schematic.json')
        with mock.patch('schematic_contract.check_contract',return_value=dict(status='passed',requirement_results={},inputs={})):
            with self.assertRaisesRegex(ValueError,'coverage'):design._adapter(self.root,design.load_contract(self.root,self.path),row,self.report_base())

    def test_declared_block_bench_receipt_without_original_proof_is_rejected(self):
        path=self.root/'fake-block.json';path.write_text('{"status":"passed","level":2,"qualification":"bench_validated"}')
        row=dict(id='BLOCK',kind='block_qualification',stage='parts',requirements=['OUTPUT'],path='fake-block.json')
        value=design.load_contract(self.root,self.path);value['requirements'][0]['acceptance']=dict(kind='review',criterion='Exact block bench evidence',source=value['requirements'][0]['source'])
        with self.assertRaisesRegex(ValueError,'original binding/proof/raw bench'):design._adapter(self.root,value,row,self.report_base())

    def test_real_voltage_measurement_does_not_establish_lot_yield_or_population_test_coverage(self):
        value,row,_=self.bench_fixture()
        self.assertEqual(design._adapter(self.root,value,row,self.report_base())['status'],'passed')
        value['production']={name:dict(required=True,source=value['requirements'][0]['source'],check=row['id']) for name in ('lot_yield','test_coverage')}
        blocked=design.production_controls(value)
        self.assertEqual({b['control'] for b in blocked if b['code']=='unsupported_production_control'},{'lot_yield','test_coverage'})

    def test_real_part_review_does_not_establish_approved_substitution(self):
        value=design.load_contract(self.root,self.path)
        row=dict(id='PARTS',kind='part_use',stage='parts',requirements=['OUTPUT'],path=self.part.relative_to(self.root).as_posix(),references=['J1'])
        with mock.patch.object(part_evidence,'pdf_pages',return_value=1):
            self.assertEqual(design._adapter(self.root,value,row,self.report_base())['status'],'passed')
        value['production']={'substitutions':dict(required=True,source=value['requirements'][0]['source'],check='PARTS')}
        self.assertIn('substitutions',{b['control'] for b in design.production_controls(value) if b['code']=='unsupported_production_control'})

    def test_physical_review_requirement_cannot_be_closed_by_part_selection(self):
        value=design.load_contract(self.root,self.path)
        value['requirements'][0]['acceptance']=dict(kind='review',criterion='Whole device function works',source=value['requirements'][0]['source'])
        row=dict(id='CAD-AS-BUILD',kind='part_use',stage='prototype',requirements=['OUTPUT'],path=self.part.relative_to(self.root).as_posix(),references=['J1'])
        with self.assertRaisesRegex(ValueError,'unsupported physical acceptance'):
            design._adapter(self.root,value,row,self.report_base())

    def layout_fixture(self):
        value=json.loads(self.path.read_text())
        value['checks'].append(dict(id='LAYOUT',kind='placement',stage='placement',requirements=['OUTPUT'],
            path=self.part.relative_to(self.root).as_posix(),constraint_ids=['fixture-distance'],selectors={'OUTPUT':'fixture-distance'}))
        self.path.write_text(json.dumps(value));return value

    def test_candidate_layout_replays_actual_rules_without_prior_gate_or_bench(self):
        self.layout_fixture()
        # A future numeric output requirement can use layout as a contribution;
        # this does not claim the native distance measures output volts.
        with mock.patch.object(part_evidence,'pdf_pages',return_value=1):
            result=design.evaluate_candidate_layout(self.root,self.path)
            self.assertEqual(result['status'],'passed',result['blockers'])
            self.assertEqual(set(result['check_results']),{'LAYOUT'});self.assertFalse(result['qualified'])
            import pq_cadlib as cad
            path=self.root/'hardware-design/boards/PART-FIXTURE/fixture.kicad_pcb';tree=cad.parse(path.read_text())
            fp=next(f for f in cad.items(tree,'footprint') if any(p[1:3]==['Reference','J2'] for p in cad.items(f,'property')))
            cad.item(fp,'at')[1]=cad.Atom('25');path.write_text(cad.dump(tree))
            rejected=design.evaluate_candidate_layout(self.root,self.path)
        self.assertEqual(rejected['status'],'blocked');self.assertIn('placement verifier blocked',rejected['blockers'][0]['detail'])

    def test_candidate_dft_wrong_native_pad_blocks_before_layout_writer(self):
        value=self.layout_fixture();value['test_plans'][0]['signals'][0]['pad']='NO-PAD';self.path.write_text(json.dumps(value))
        result=design.evaluate_candidate_layout(self.root,self.path)
        self.assertIn('dft_native_access',{b['code'] for b in result['blockers']})

    def test_candidate_fixed_pose_uses_unchanged_canonical_baseline(self):
        self.layout_fixture()
        parts=json.loads(self.part.read_text())
        note=self.part.parent/'FIXED-J1.md';note.write_text('SYNTHETIC fixture rule: J1 must retain its original native placement.\n')
        parts['parts'][0]['layout_constraints'].append(dict(id='fixture-fixed',kind='fixed',refs=['J1'],
            source=dict(path=note.relative_to(self.root).as_posix(),sha256=design.sha(note),section='Synthetic fixed fixture',page=1)))
        parts['review']['facts_sha256']=part_evidence.facts_digest(parts);self.part.write_text(json.dumps(parts))
        import pq_cadlib as cad
        original=self.root/'hardware-design/boards/PART-FIXTURE/fixture.kicad_pcb'
        tree=cad.parse(original.read_text());fp=cad.items(tree,'footprint')[0]
        cad.item(fp,'at')[1]=cad.Atom('5.1')
        candidate=self.root/'candidate.kicad_pcb';candidate.write_text(cad.dump(tree))
        before=design.sha(original)
        with mock.patch.object(part_evidence,'pdf_pages',return_value=1):
            baseline=design.evaluate_candidate_layout(self.root,self.path)
            checked=design.evaluate_candidate_layout(self.root,self.path,candidate=candidate)
        self.assertEqual(baseline['status'],'passed',baseline['blockers'])
        self.assertEqual(checked['status'],'blocked');self.assertIn('fixture-fixed',checked['blockers'][0]['detail'])
        self.assertEqual(design.sha(original),before)

    def test_candidate_escape_uses_owned_fresh_override_and_retains_canonical_policy(self):
        value=self.layout_fixture();parts=json.loads(self.part.read_text())
        note=self.part.parent/'ESCAPE-J1.md';note.write_text('SYNTHETIC fixture: J1.1 requires a native minimum-track escape screen.\n')
        parts['parts'][0]['layout_constraints'].append(dict(id='fixture-escape',kind='escape',refs=['J1'],pads=[dict(ref='J1',pad='1')],
            metric='native_minimum_track_escape',source=dict(path=note.relative_to(self.root).as_posix(),sha256=design.sha(note),section='Synthetic escape fixture',page=1)))
        parts['review']['facts_sha256']=part_evidence.facts_digest(parts);self.part.write_text(json.dumps(parts))
        canonical=self.root/'canonical-escape.json';canonical.write_text('{"status":"canonical-original"}\n')
        value['checks'][-1]['escape_evidence']=canonical.name;self.path.write_text(json.dumps(value))
        original=self.root/'hardware-design/boards/PART-FIXTURE/fixture.kicad_pcb'
        candidate=self.root/'candidate.kicad_pcb';candidate.write_bytes(original.read_bytes())
        before={p:design.sha(p) for p in (original,self.path,self.part,canonical)}
        directory=self.root/'owned-operation/layout-evidence';receipt=directory/'LAYOUT-escape.json'
        artifact=self.root/'native-screen-fixture.json';artifact.write_text('{"synthetic":"wiring-only; no native screen"}\n')
        def generate(policy,actual,output):
            self.assertEqual(policy['native'],str(original));self.assertEqual(actual,candidate)
            self.assertEqual(output,receipt);self.assertIn('fixture-escape',{r['id'] for r in policy['rules']})
            output.write_text(json.dumps(dict(schema='iot-lab.pin-escape-evidence.v1',board=str(actual),qualified=False,
                inputs={str(candidate):design.sha(candidate),str(artifact):design.sha(artifact)})))
        def verify(policy,actual,evidence):
            self.assertEqual(actual,candidate);self.assertEqual(evidence,receipt)
            self.assertEqual(json.loads(evidence.read_text())['board'],str(candidate));return []
        with mock.patch.object(part_evidence,'pdf_pages',return_value=1), \
                mock.patch('route_decision.generate_escape_evidence',side_effect=generate) as generated, \
                mock.patch('route_decision.verify_escape_evidence',side_effect=verify) as verified:
            missing=design.evaluate_candidate_layout(self.root,self.path,candidate=candidate)
            self.assertEqual(missing['status'],'blocked');self.assertIn('evidence_directory',missing['blockers'][0]['detail'])
            generated.assert_not_called()
            checked=design.evaluate_candidate_layout(self.root,self.path,candidate=candidate,evidence_directory=directory)
            reused=design.evaluate_candidate_layout(self.root,self.path,candidate=candidate,evidence_directory=directory)
            self.assertEqual(reused['status'],'blocked');self.assertIn('File exists',reused['blockers'][0]['detail'])
            forbidden=self.root/'registry/forbidden-evidence'
            rejected=design.evaluate_candidate_layout(self.root,self.path,candidate=candidate,evidence_directory=forbidden)
            self.assertEqual(rejected['status'],'blocked');self.assertFalse(forbidden.exists())
        self.assertEqual(checked['status'],'passed',checked['blockers']);generated.assert_called_once();verified.assert_called_once()
        self.assertEqual(checked['generated_evidence'],[str(receipt)])
        self.assertEqual(checked['inputs'][str(receipt)],design.sha(receipt))
        self.assertEqual(checked['inputs'][str(artifact)],design.sha(artifact))
        self.assertEqual({p:design.sha(p) for p in before},before)


if __name__=='__main__':unittest.main()
