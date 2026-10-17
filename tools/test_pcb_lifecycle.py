"""Actual owned lifecycle operations before CAD and fail-fast candidate admission."""
import json
from pathlib import Path
import shutil
import sys
import unittest
from unittest import mock

import pcb_evidence
import pcb_cli
import pcb_operations
import test_pcb_cli as cli_fixtures
from test_design_contract import idea_fixture, selection_fixture


class LifecycleCliTests(unittest.TestCase):
    def setUp(self):
        self.fixture = cli_fixtures.PcbCliTests()
        self.fixture.setUp()
        self.fixture.env['PYTHON_MODERN'] = sys.executable
        self.addCleanup(self.fixture.tearDown)
        self.root = self.fixture.root.resolve()
        self.path = idea_fixture(self.root)
        source = Path(__file__).resolve().parent
        for name in ('design_contract.py', 'part_evidence.py', 'part_native.py', 'pcb_next.py'):
            shutil.copyfile(source / name, self.root / 'tools' / name)

    def cli(self, *args):
        return self.fixture.cli(*args)

    def change(self, callback):
        value = json.loads(self.path.read_text())
        callback(value)
        self.path.write_text(json.dumps(value))

    def assess(self, stage='architecture', cycle=None):
        flags = ['--json'] + (['--cycle', cycle] if cycle else [])
        result = self.cli('design', *flags, 'check', 'IDEA-FIXTURE', '--contract', str(self.path), '--through', stage)
        self.assertIn(result.returncode, (0, 1), result.stdout + result.stderr)
        terminal = json.loads(result.stdout.splitlines()[-1])
        folder = self.fixture.runs / terminal['run_id']
        return result, folder, pcb_evidence.verify(folder)

    def next(self, stage='architecture'):
        result = self.cli('next', 'IDEA-FIXTURE', '--design-contract', str(self.path), '--through', stage, '--json')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def test_idea_uses_owned_progress_cycle_and_current_next_without_native_project(self):
        created = self.cli('cycle', 'start', 'IDEA-FIXTURE', '--contract', str(self.path), '--owner', 'integrator', '--json')
        self.assertEqual(created.returncode, 0, created.stdout + created.stderr)
        cycle = json.loads(created.stdout)['cycle_id']
        result, folder, receipt = self.assess(cycle=cycle)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(receipt['scope'], 'design_assessment')
        self.assertFalse(receipt['qualified'])
        self.assertIsNone(json.loads((folder / 'run.json').read_text())['project'])
        self.assertFalse((self.root / 'hardware-design/boards/IDEA-FIXTURE').exists())
        before = set(self.fixture.runs.glob('run-*'))
        current = self.next()
        self.assertTrue(current['readiness_verified'])
        self.assertEqual(current['observed_run']['run_id'], folder.name)
        self.assertEqual(set(self.fixture.runs.glob('run-*')), before)
        state = self.cli('cycle', 'finish', cycle, '--json')
        self.assertEqual(state.returncode, 0, state.stdout + state.stderr)
        recorded = json.loads(state.stdout)
        self.assertEqual(recorded['runs'][0]['stage'], 'architecture')
        self.assertTrue(recorded['runs'][0]['evidence_verified'])
        self.assertTrue(recorded['runs'][0]['assessment_current'])
        self.assertIn('prototype', recorded['unobserved_stages'])
        self.assertIn('production', recorded['unobserved_stages'])

    def test_owned_part_selection_and_design_parts_work_before_native_project(self):
        self.path,part=selection_fixture(self.root)
        # CPU broker fixture only; source/PDF inspection has its own real-tool tests.
        probe=self.root/'fixture-pdfinfo'
        probe.write_text('#!'+sys.executable+'\nimport sys\nprint("fixture-pdfinfo1" if "-v" in sys.argv else "Pages: 1")\n')
        probe.chmod(0o755)
        self.fixture.env['PDFINFO']=str(probe)
        self.fixture.env['NODE']=str(self.root/'absent-node')
        for command in (
                ('parts','--json','selection','PART-FIXTURE','--manifest',str(part)),
                ('design','--json','check','PART-FIXTURE','--contract',str(self.path),'--through','parts')):
            result=self.cli(*command)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            terminal=json.loads(result.stdout.splitlines()[-1])
            folder=self.fixture.runs/terminal['run_id']
            receipt=pcb_evidence.verify(folder)
            self.assertEqual(receipt['status'],'passed')
            self.assertIsNone(json.loads((folder/'run.json').read_text())['project'])
            report=json.loads((folder/'operation/report.json').read_text())
            checked=report if command[0]=='parts' else report['check_results']['SELECT']
            for flag in ('native_verified','cad_verified','stock_current'):self.assertFalse(checked[flag])
        self.assertFalse(list((self.root/'hardware-design/boards/PART-FIXTURE').glob('*.kicad_*')))

    def test_same_failure_twice_stops_next_retry_until_inputs_change(self):
        def unresolved(value):
            value['unknowns'] = [dict(id='LOAD', question='Maximum operating load unresolved', owner='designer',
                blocking_stage='architecture', source=value['requirements'][0]['source'])]
        self.change(unresolved)
        for _ in range(2):
            result, _, receipt = self.assess()
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertEqual(receipt['status'], 'failed')
        current = self.next()
        self.assertEqual(current['state'], 'stuck')
        self.assertEqual(current['blocker']['code'], 'repeated_unchanged_failure')
        self.assertEqual(current['blocker']['repeated_failures'], 2)
        self.assertEqual(current['next_action']['argv'][1], 'explain')
        self.change(lambda value: value.update(unknowns=[]))
        self.assertEqual(self.next()['state'], 'needs_check')
        result, _, _ = self.assess()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(self.next()['readiness_verified'])

    def test_new_previously_missing_evidence_expires_the_recorded_blocker(self):
        def missing_review(value):
            value['checks'].append(dict(id='PARTS', stage='parts', kind='part_use', requirements=['OUTPUT'], path='missing-review.json'))
        self.change(missing_review)
        result, folder, receipt = self.assess('parts')
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        missing = str(self.root / 'missing-review.json')
        self.assertIn(missing, receipt['engineering_absent_inputs'])
        self.assertEqual(self.next('parts')['state'], 'blocked')
        (self.root / 'missing-review.json').write_text('{}')
        observed = self.next('parts')
        self.assertEqual(observed['state'], 'needs_check')
        self.assertIn('absent', observed['blocker']['message'])
        self.assertEqual(pcb_evidence.verify(folder)['status'], 'failed')

    def test_other_stage_and_changed_requirement_source_need_a_new_assessment(self):
        result, _, _ = self.assess()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.next('requirements')['state'], 'needs_check')
        (self.root / 'idea.md').write_text('Changed upstream requirement source')
        current = self.next()
        self.assertEqual(current['state'], 'needs_check')
        self.assertFalse(current['readiness_verified'])

    def test_incomplete_prerequisites_stop_before_snapshot_or_route(self):
        idea_fixture(self.root, board='X')
        folder = self.root / 'blocked-route-admission'
        (folder / 'operation').mkdir(parents=True)
        (folder / 'run.json').write_text(json.dumps(dict(root=str(self.root), board='X', operation='route',
            design_contract=dict(path=str(self.path), sha256=pcb_operations.sha(self.path)))))
        with mock.patch.object(pcb_operations, 'snapshot') as snapshot, mock.patch.object(pcb_operations, 'execute') as execute:
            self.assertEqual(pcb_operations.run(folder), 1)
        snapshot.assert_not_called()
        execute.assert_not_called()
        result = json.loads((folder / 'operation/result.json').read_text())
        self.assertEqual(result['scope'], 'design_preflight')
        self.assertFalse(result['candidate_verified'])
        self.assertEqual(result['design_stage'], 'placement')

    def test_backend_zero_exit_cannot_promote_a_blocked_or_wrong_stage_report(self):
        folder = self.root / 'misleading-backend'
        (folder / 'operation').mkdir(parents=True)
        (folder / 'run.json').write_text(json.dumps(dict(root=str(self.root), board='IDEA-FIXTURE',
            operation='design', arguments=['check', 'IDEA-FIXTURE'],
            design_id='IDEA-FIXTURE', design_stage='architecture')))
        report = dict(schema='iot-lab.design-assessment.v1', design_id='IDEA-FIXTURE',
            through='architecture', status='blocked', qualified=False, blockers=[dict(code='missing_evidence')])
        def output(*args):
            (folder / 'operation/report.json').write_text(json.dumps(report))
            return 0
        with mock.patch.object(pcb_operations, 'execute', side_effect=output):
            with self.assertRaisesRegex(ValueError, 'exit disagrees'):
                pcb_operations.run(folder)
            report.update(status='passed', through='production')
            with self.assertRaisesRegex(ValueError, 'requested stage'):
                pcb_operations.run(folder)

    def test_unrelated_idea_cannot_supply_a_native_candidate_prerequisite(self):
        folder = self.root / 'wrong-design-admission'
        (folder / 'operation').mkdir(parents=True)
        manifest = dict(root=str(self.root), board='X', operation='build',
            design_contract=dict(path=str(self.path), sha256=pcb_operations.sha(self.path)))
        with mock.patch('design_contract.evaluate_contract') as evaluate:
            with self.assertRaisesRegex(ValueError, 'exact native board'):
                pcb_operations.design_admission(self.root, folder, manifest)
        evaluate.assert_not_called()

    def test_terminal_stream_keeps_full_evidence_in_the_exact_sealed_receipt(self):
        folder = self.root / 'large-receipt'
        folder.mkdir()
        original = dict(status='passed', run_id='run-large', scope='design_assessment', qualified=False,
            engineering_inputs={'source-%d' % i: 'a' * 64 for i in range(5000)},
            evidence_sha256={'file-%d' % i: 'b' * 64 for i in range(5000)})
        receipt = folder / 'result.json'
        receipt.write_text(json.dumps(original))
        view = pcb_cli.compact_terminal(original, folder)
        self.assertLess(len(json.dumps(view)), 1000)
        self.assertEqual(view['inventory_counts']['engineering_inputs'], 5000)
        self.assertEqual(view['receipt']['sha256'], pcb_operations.sha(receipt))
        self.assertEqual(json.loads(receipt.read_text()), original)

    def test_layout_integration_checks_actual_candidate_against_canonical_constraints(self):
        from test_design_contract import ActualVerifierTests
        import part_evidence
        import pq_cadlib as cad
        fixture = ActualVerifierTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.layout_fixture()
        workspace = fixture.root / 'candidate-workspace'
        shutil.copytree(fixture.root / 'hardware-design', workspace / 'hardware-design')
        original = fixture.root / 'hardware-design/boards/PART-FIXTURE/fixture.kicad_pcb'
        candidate = workspace / original.relative_to(fixture.root)
        before = pcb_operations.sha(original)
        folder = fixture.root / 'layout-operation'
        (folder / 'operation').mkdir(parents=True)
        manifest = dict(board='PART-FIXTURE', design_contract=dict(path=str(fixture.path)))
        with mock.patch.object(part_evidence, 'pdf_pages', return_value=1):
            passed = pcb_operations.candidate_layout_check(fixture.root, workspace, folder, manifest,
                folder / 'operation/layout-pass.json')
            self.assertEqual(passed['status'], 'passed', passed['blockers'])
            tree = cad.parse(candidate.read_text())
            part = next(fp for fp in cad.items(tree, 'footprint')
                if any(prop[1:3] == ['Reference', 'J2'] for prop in cad.items(fp, 'property')))
            cad.item(part, 'at')[1] = cad.Atom('25')
            candidate.write_text(cad.dump(tree))
            blocked = pcb_operations.candidate_layout_check(fixture.root, workspace, folder, manifest,
                folder / 'operation/layout-blocked.json')
        self.assertEqual(blocked['status'], 'blocked')
        self.assertEqual(pcb_operations.sha(original), before)


if __name__ == '__main__':
    unittest.main()
