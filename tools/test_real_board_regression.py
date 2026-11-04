"""Fail-closed contracts; the separate native CI job performs the full replay."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import real_board_regression as regression
import pcb_operations as operations


class RealBoardRegressionTests(unittest.TestCase):
    def test_terminal_output_links_exact_full_inventory_without_dumping_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            result = dict(schema='iot-lab.real-board-regression.v1', status='passed', board='X',
                scope='isolated native replay', cause='all cases passed', elapsed_s=1,
                cases=[dict(case=name, status='passed') for name in regression.CASES],
                skipped=0, shipping_sources_unchanged=True,
                shipping_inputs={'files': {str(i): 'a' * 64 for i in range(3000)}})
            report = folder / 'summary.json'
            report.write_text(json.dumps(result))
            summary = regression.terminal_summary(result, folder)
            self.assertLess(len(json.dumps(summary)), 2000)
            self.assertEqual(summary['summary_sha256'], regression.sha(report))
            self.assertEqual(summary['summary_json'], str(report.resolve()))
            self.assertEqual(len(summary['cases']), len(regression.CASES))
            self.assertNotIn('shipping_inputs', summary)
            self.assertEqual(json.loads(report.read_text()), result)

    def test_first_exception_settles_actual_detached_cli_worker(self):
        self.assert_detached_failure_settles_worker(False)

    def test_sigterm_settles_actual_detached_cli_worker_before_returning(self):
        self.assert_detached_failure_settles_worker(True)

    def assert_detached_failure_settles_worker(self, terminate):
        import pcb_cli
        import test_pcb_cli
        fixture = test_pcb_cli.PcbCliTests()
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        output = fixture.root / '.gate/replay'
        spawned = []

        def fail_after_detached_start(root, workspace, board):
            shutil.copytree(root, workspace, ignore=shutil.ignore_patterns('.gate'))
            response = subprocess.run([sys.executable, str(workspace / 'tools/pcb_cli.py'), 'check', 'X',
                '--detach', '--json', '--runs-dir', str(output / 'runs')], env=dict(fixture.env, PCB_FIXTURE_DELAY='60', IOT_LAB=str(workspace)),
                capture_output=True, text=True, timeout=5)
            self.assertEqual(response.returncode, 0, response.stdout + response.stderr)
            folder = output / 'runs' / json.loads(response.stdout)['run_id']
            spawned.append(folder)
            fixture.until(lambda: (folder / 'gate/drc.log').exists())
            if terminate:
                os.kill(os.getpid(), signal.SIGTERM)
            raise TimeoutError('injected first-stage timeout after detached worker admission')

        source = dict(sha256='unchanged-original-source', files={})
        handler = signal.getsignal(signal.SIGTERM)
        try:
            with mock.patch.object(regression, 'ROOT', fixture.root), mock.patch.object(regression, 'BOARD', 'X'), \
                    mock.patch.object(operations, 'source_state', return_value=source), \
                    mock.patch.object(operations, 'snapshot', side_effect=fail_after_detached_start):
                result = regression.run(SimpleNamespace(output=output, timeout=5, python=sys.executable))
            self.assertEqual(result['status'], 'failed')
            self.assertIn('stage cancelled by signal' if terminate else 'injected first-stage timeout', result['cause'])
            self.assertTrue(result['run_cleanup']['complete'], result)
            observation = result['run_cleanup']['runs'][spawned[0].name]
            self.assertTrue(observation['cancellation_requested'])
            self.assertEqual(observation['status'], 'cancelled')
            self.assertTrue(observation['cleanup']['complete'])
            self.assertFalse(pcb_cli.controller_alive(spawned[0]))
            self.assertEqual(result['cases'], [])
            self.assertIs(signal.getsignal(signal.SIGTERM), handler)
        finally:
            if spawned:
                regression.cancel_and_settle(output / 'runs', output / 'checkout')

    def test_cleanup_rejects_a_run_owned_by_another_checkout_without_cancelling(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = root / 'runs/run-other'
            folder.mkdir(parents=True)
            (folder / 'run.json').write_text(json.dumps(dict(run_id=folder.name, root=str(root / 'other'))))
            result = regression.cancel_and_settle(root / 'runs', root / 'checkout', timeout=0)
            self.assertFalse(result['complete'])
            self.assertIn('isolated replay checkout', result['errors'][0])
            self.assertFalse((folder / 'cancel.request').exists())

    def test_repair_must_restore_all_poses_and_preserve_copper(self):
        source = '''(kicad_pcb
          (footprint "X" (at 1 2 90) (property "Reference" "C1"))
          (footprint "X" (at 3 4 0) (property "Reference" "C2"))
          (segment (start 1 2) (end 3 4) (width 0.2) (layer "F.Cu") (net 1)))'''
        with tempfile.TemporaryDirectory() as tmp:
            before, after = Path(tmp) / 'before', Path(tmp) / 'after'
            before.write_text(source)
            after.write_text(source.replace('(width 0.2)', '(width 0.2000)'))
            self.assertEqual(regression.preserved_layout(before, after)['footprint_poses_checked'], 2)
            after.write_text(source.replace('(at 3 4 0)', '(at 3 5 0)'))
            with self.assertRaisesRegex(ValueError, 'every original'):
                regression.preserved_layout(before, after)
            after.write_text(source.replace('(width 0.2)', '(width 0.3)'))
            with self.assertRaisesRegex(ValueError, 'retained native copper'):
                regression.preserved_layout(before, after)

    def test_snapshot_binds_only_named_semantic_datasheets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            board = root / 'hardware-design/boards/ENV-SENSE'
            board.mkdir(parents=True)
            (board / 'gate.json').write_text('{"project":"native","snapshot_schematic_datasheets":true}')
            (board / 'native.kicad_sch').write_text('''(kicad_sch
              (lib_symbols (symbol "Unused" (property "Datasheet" "unused.pdf")))
              (symbol (property "Datasheet" "${KIPRJMOD}/../../registry/datasheets/required.pdf")))''')
            pdfs = root / 'hardware-design/registry/datasheets'
            pdfs.mkdir(parents=True)
            (pdfs / 'required.pdf').write_bytes(b'original manufacturer PDF')
            (pdfs / 'unused.pdf').write_bytes(b'unrelated library document')
            with mock.patch.object(operations.subprocess, 'run', return_value=mock.Mock(returncode=0, stdout='[]')):
                files = operations.source_files(root, 'ENV-SENSE')
                self.assertIn(pdfs / 'required.pdf', files)
                self.assertNotIn(pdfs / 'unused.pdf', files)
                before = operations.source_state(root, 'ENV-SENSE')
                (pdfs / 'required.pdf').write_bytes(b'changed document')
                self.assertNotEqual(before, operations.source_state(root, 'ENV-SENSE'))

    def test_native_success_requires_complete_configured_fresh_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder / 'gate').mkdir()
            result = dict(status='passed', cleanup=dict(complete=True))
            gate = dict(exit=0, changedDuringRun=False, preflightErrors=[], metrics=dict(
                erc_errors=0, drc_errors=0, drc_parity=0, drc_unconnected=0), cache=dict(enabled=False, hits=0))
            findings = dict(inputs_valid=True, complete=True, completed_checks=['erc', 'drc'], findings=[])

            def write():
                for name, value in [('result.json', result), ('gate/result.json', gate), ('gate/findings.json', findings)]:
                    (folder / name).write_text(json.dumps(value))

            write()
            regression.native_contract(folder, 'passed')
            for key in ('erc_errors', 'drc_errors', 'drc_parity', 'drc_unconnected'):
                gate['metrics'][key] = 1
                write()
                with self.assertRaisesRegex(ValueError, 'targets failed'):
                    regression.native_contract(folder, 'passed')
                gate['metrics'][key] = 0
            findings['complete'] = False
            write()
            with self.assertRaisesRegex(ValueError, 'complete configured'):
                regression.native_contract(folder, 'passed')
            findings['complete'] = True
            gate['cache'] = dict(enabled=True, hits=1)
            write()
            with self.assertRaisesRegex(ValueError, 'fresh native'):
                regression.native_contract(folder, 'passed')

    def test_tool_failure_or_missing_native_stage_cannot_count_as_injected_defect(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder / 'gate').mkdir()
            (folder / 'result.json').write_text(json.dumps(dict(status='failed', cleanup=dict(complete=True))))
            (folder / 'gate/result.json').write_text(json.dumps(dict(preflightErrors=['missing library'])))
            findings = dict(inputs_valid=True, completed_checks=['erc'], findings=[])
            (folder / 'gate/findings.json').write_text(json.dumps(findings))
            with self.assertRaisesRegex(ValueError, 'invalid/missing'):
                regression.native_contract(folder, 'failed')
            (folder / 'gate/result.json').write_text(json.dumps(dict(cache=dict(enabled=False, hits=0))))
            with self.assertRaisesRegex(ValueError, 'both native'):
                regression.native_contract(folder, 'failed')


if __name__ == '__main__':
    unittest.main()
