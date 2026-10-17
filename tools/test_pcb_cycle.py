"""Engineering observations preserve failures, overlap and evidence attribution."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import pcb_cycle as cycle
from pcb_evidence import evidence_files


class CycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.base = self.root / '.gate/cli'
        board = self.root / 'hardware-design/boards/X'
        board.mkdir(parents=True)
        (board / 'gate.json').write_text('{"project":"cad/X"}')
        state = cycle.create(self.root, self.base, 'X', 'integrator')
        self.folder = cycle.folder_for(self.base, state['cycle_id'])
        self.evidence = self.root / 'review.json'
        self.evidence.write_text('{"source":"fixture review", "unresolved":["package"]}')

    def tearDown(self):
        self.temp.cleanup()

    def run_fixture(self, name, start, duration, status='passed', board='X'):
        folder = self.base / ('run-' + name)
        folder.mkdir()
        manifest = dict(run_id=folder.name, root=str(self.root), board=board,
                        created_at='2026-10-16T00:00:%02d+00:00' % start, operation='parts')
        (folder / 'run.json').write_text(json.dumps(manifest))
        result = dict(status=status, cleanup=dict(complete=True), elapsed_s=duration,
                      timing=dict(supervisor_startup_s=0))
        result['evidence_sha256'] = evidence_files(folder)
        (folder / 'result.json').write_text(json.dumps(result))
        return folder

    def test_review_records_blocker_and_changed_evidence_without_promoting_board(self):
        with mock.patch.object(cycle.time, 'time', return_value=100):
            activity = cycle.begin(self.folder, 'datasheets', 'reviewer', 'check exact package')
        with mock.patch.object(cycle.time, 'time', return_value=115):
            result = cycle.end(self.folder, activity['activity_id'], 'blocked', [self.evidence],
                               'exact package remains unresolved')
        self.assertEqual(result['stages']['datasheets']['review_elapsed_s'], 15)
        self.assertEqual(result['stages']['datasheets']['blocked'], 1)
        self.assertFalse(result['qualified'])
        self.assertIn('routing', result['unobserved_stages'])
        self.evidence.write_text('changed review')
        self.assertEqual(len(cycle.summarize(self.folder)['evidence_issues']), 1)
        with self.assertRaisesRegex(ValueError, 'changed evidence'):
            cycle.finish(self.folder)

    def test_parallel_runs_use_union_and_failed_outcomes_remain_observed(self):
        first = self.run_fixture('a', 0, 10)
        second = self.run_fixture('b', 5, 10, 'timeout')
        cycle.attach(self.folder, first, 'parts')
        cycle.attach(self.folder, second, 'datasheets')
        state = cycle.finish(self.folder)
        self.assertEqual(state['covered_elapsed_s'], 15)
        self.assertEqual(state['stages']['datasheets']['blocked'], 1)
        self.assertEqual(state['runs'][1]['status'], 'timeout')
        self.assertEqual(state['status'], 'recorded')
        self.assertFalse(state['qualified'])
        changed = json.loads((first / 'result.json').read_text())
        changed['elapsed_s'] = 1
        (first / 'result.json').write_text(json.dumps(changed))
        self.assertTrue(cycle.summarize(self.folder)['evidence_issues'])

    def test_ownership_open_review_and_wrong_board_are_not_silently_accepted(self):
        activity = cycle.begin(self.folder, 'schematic', 'designer', 'review pin mapping')
        with self.assertRaisesRegex(ValueError, 'end recorded review'):
            cycle.finish(self.folder)
        with self.assertRaisesRegex(ValueError, 'another board'):
            cycle.attach(self.folder, self.run_fixture('wrong', 0, 1, board='Y'))
        cycle.end(self.folder, activity['activity_id'], 'rework', [self.evidence], 'correct pin mapping')
        state = cycle.finish(self.folder)
        self.assertEqual(state['stages']['schematic']['rework'], 1)
        self.assertEqual(state['recorded_failure_rework_causes'][0]['cause'], 'correct pin mapping')
        with self.assertRaisesRegex(ValueError, 'closed'):
            cycle.begin(self.folder, 'routing', 'designer', 'late work')

    def test_running_or_changed_run_cannot_be_hidden_by_closing_cycle(self):
        folder = self.run_fixture('pending', 0, 2)
        cycle.attach(self.folder, folder)
        (folder / 'run.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'changed evidence|verified terminal'):
            cycle.finish(self.folder)

    def test_startup_delay_is_counted_and_legacy_interval_stays_unknown(self):
        folder = self.run_fixture('delayed', 0, 20)
        terminal = json.loads((folder / 'result.json').read_text())
        terminal['timing']['supervisor_startup_s'] = 100
        (folder / 'result.json').write_text(json.dumps(terminal))
        cycle.attach(self.folder, folder)
        self.assertEqual(cycle.summarize(self.folder)['covered_elapsed_s'], 120)
        terminal.pop('timing')
        (folder / 'result.json').write_text(json.dumps(terminal))
        state = cycle.summarize(self.folder)
        self.assertIsNone(state['covered_elapsed_s'])
        self.assertTrue(state['runs'][0]['interval_source'].startswith('unknown'))

    def test_concurrent_activity_is_checked_inside_finish_lock(self):
        original = cycle.mutate
        inserted = []
        def concurrent(folder, callback):
            if not inserted:
                inserted.append(True)
                original(folder, lambda data: data['activities'].append(dict(activity_id='activity-concurrent',
                    stage='parts', owner='reviewer', status='running', started_unix_s=100)))
            return original(folder, callback)
        with mock.patch.object(cycle, 'mutate', side_effect=concurrent):
            with self.assertRaisesRegex(ValueError, 'end recorded review'):
                cycle.finish(self.folder)
        self.assertEqual(cycle.read(self.folder / 'cycle.json')['status'], 'open')

    def test_stock_observation_expires_without_losing_historical_evidence(self):
        folder = self.run_fixture('stock', 0, 1)
        (folder / 'operation').mkdir()
        (folder / 'operation/report.json').write_text(json.dumps(dict(scope='assembly_stock_observation', board='X',
            order_day_utc='2000-01-01', stock_current=True,
            population_source=dict(path=str(self.root / 'hardware-design/boards/X/variants.json'), exists=False, sha256=None),
            inputs={str(self.evidence): cycle.sha(self.evidence)})))
        result = json.loads((folder / 'result.json').read_text())
        result['evidence_sha256'] = evidence_files(folder)
        (folder / 'result.json').write_text(json.dumps(result))
        cycle.attach(self.folder, folder)
        state = cycle.finish(self.folder)
        self.assertTrue(state['runs'][0]['evidence_verified'])
        self.assertTrue(state['runs'][0]['availability_inputs_current'])
        self.assertFalse(state['runs'][0]['stock_current'])
        self.assertFalse(state['runs'][0]['availability_current_day'])

    def test_new_population_policy_invalidates_current_stock_but_retains_history(self):
        import datetime as dt
        folder = self.run_fixture('population', 0, 1)
        population = self.root / 'hardware-design/boards/X/variants.json'
        (folder / 'operation').mkdir()
        (folder / 'operation/report.json').write_text(json.dumps(dict(scope='assembly_stock_observation', board='X',
            order_day_utc=dt.datetime.now(dt.timezone.utc).date().isoformat(), stock_current=True,
            population_source=dict(path=str(population), exists=False, sha256=None),
            inputs={str(self.evidence): cycle.sha(self.evidence)})))
        result = json.loads((folder / 'result.json').read_text())
        result['evidence_sha256'] = evidence_files(folder)
        (folder / 'result.json').write_text(json.dumps(result))
        cycle.attach(self.folder, folder)
        self.assertTrue(cycle.summarize(self.folder)['runs'][0]['stock_current'])
        population.write_text('{"variants":["NEW"],"fit":{}}')
        state = cycle.finish(self.folder)
        self.assertTrue(state['runs'][0]['evidence_verified'])
        self.assertTrue(state['runs'][0]['availability_current_day'])
        self.assertFalse(state['runs'][0]['availability_inputs_current'])
        self.assertFalse(state['runs'][0]['stock_current'])


if __name__ == '__main__':
    unittest.main()
