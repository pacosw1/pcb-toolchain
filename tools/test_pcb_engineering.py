"""Unified engineering adapters reject missing proof and preserve run ownership."""
import hashlib
from importlib.machinery import EXTENSION_SUFFIXES
import json
import os
from pathlib import Path
import py_compile
import shutil
import sys
import tempfile
import unittest
from unittest import mock

import pcb_cli
import pcb_cycle
import pcb_operations
import pcb_observation_inputs as inputs
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
