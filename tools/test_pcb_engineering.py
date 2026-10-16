"""Unified engineering adapters reject missing proof and preserve run ownership."""
import json
from pathlib import Path
import shutil
import sys
import unittest
from unittest import mock

import pcb_cli
import pcb_cycle
import pcb_operations
import test_pcb_cli as fixtures
import test_pcb_workflow as workflows


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
