"""Measured boundaries, overlap accounting and owned subprocess behavior."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import lean_workflow as lean
from pcb_timing import Timeline, from_events, live_stages, main, union_seconds


def start(identity, stage, at, category='operation'):
    return dict(type='stage.start', span_id=identity, stage=stage, category=category,
                started_unix_s=at, time=at)


def end(identity, stage, left, right, category='operation'):
    return dict(type='stage.end', span_id=identity, stage=stage, category=category,
                started_unix_s=left, ended_unix_s=right, time=right,
                duration_s=right-left, duration_source='producer_monotonic', status='passed')


class TimingTests(unittest.TestCase):
    def test_worker_terminal_measurement_includes_evidence_sealing(self):
        import pcb_cli
        import pcb_evidence
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory) / 'run-sealing'
            folder.mkdir()
            manifest = dict(run_id=folder.name, board='X', operation='check', command=['fixture-only'],
                            timeout_s=10, heartbeat_s=1, created_at=pcb_cli.utc())
            (folder / 'run.json').write_text(json.dumps(manifest))
            (folder / 'state.json').write_text(json.dumps(dict(status='starting')))
            process = mock.Mock(returncode=0, last_cleanup=dict(complete=True), child_cpu_s=0, cpu_scope='fixture')
            process.communicate.return_value = ('', '')
            process.close.return_value = True
            clock = [100.0]
            evidence_files = pcb_evidence.evidence_files
            def seal(path):
                clock[0] += 5.0  # Simulate expensive hashing without a slow test.
                return evidence_files(path)
            with mock.patch.object(pcb_cli.lean_owned, 'prepare', return_value=process), \
                 mock.patch.object(pcb_cli, 'gate_outcome', return_value=dict(status='passed', exit_code=0, cause='fixture')), \
                 mock.patch.object(pcb_cli.time, 'monotonic', side_effect=lambda: clock[0]), \
                 mock.patch.object(pcb_evidence, 'evidence_files', side_effect=seal):
                self.assertEqual(pcb_cli.worker(folder), 0)
            result = json.loads((folder / 'result.json').read_text())
            self.assertEqual(result['elapsed_s'], 5.0)
            sealing = next(row for row in result['timing']['spans'] if row['stage'] == 'evidence-sealing')
            self.assertEqual(sealing['duration_s'], 5.0)
            self.assertEqual(sealing['category'], 'sealing')
            self.assertEqual(sealing['status'], 'passed')
            self.assertEqual(pcb_evidence.verify(folder)['status'], 'passed')

    def test_sequential_concurrent_and_nested_stages_use_union_wall_time(self):
        rows = [start('outer', 'validate', 10, 'validation'),
                start('erc', 'erc', 11, 'kicad'), start('drc', 'drc', 12, 'kicad'),
                end('erc', 'erc', 11, 14, 'kicad'), end('drc', 'drc', 12, 16, 'kicad'),
                end('outer', 'validate', 10, 17, 'validation'),
                start('export', 'export', 20, 'export'), end('export', 'export', 20, 22, 'export')]
        result = from_events(rows, terminal=True)
        self.assertEqual(result['busy_wall_s'], 9)
        self.assertEqual(result['categories']['kicad']['wall_s'], 5)
        self.assertEqual(result['categories']['validation']['wall_s'], 7)
        self.assertEqual(sum(s['duration_s'] for s in result['spans']), 16)
        self.assertIsNone(result['categories']['snapshot']['wall_s'])
        self.assertIsNone(result['queue_wait_s'])

    def test_replay_cannot_doublecount_and_repeated_names_have_distinct_spans(self):
        rows = [start('one', 'export', 10), end('one', 'export', 10, 12),
                end('one', 'export', 10, 12), start('two', 'export', 20), end('two', 'export', 20, 21)]
        result = from_events(rows, terminal=True)
        self.assertEqual(len(result['spans']), 2)
        self.assertEqual(result['busy_wall_s'], 3)
        self.assertEqual(result['issues'], [])

    def test_live_elapsed_activity_and_terminal_incomplete_are_truthful(self):
        timeline = Timeline(8)
        timeline.observe(dict(type='run.start', time=9))
        timeline.observe(start('drc', 'drc', 10, 'kicad'))
        timeline.observe(dict(type='tool.output', stage='drc', span_id='drc', source_time=12, time=15))
        row = timeline.summary(now=20)['active_stages'][0]
        self.assertEqual((row['elapsed_s'], row['last_activity_age_s']), (10, 8))
        terminal = timeline.summary(now=20, terminal=True)
        self.assertEqual(terminal['coverage'], 'partial')
        self.assertEqual(terminal['spans'], [])
        self.assertIsNone(terminal['busy_wall_s'])
        self.assertEqual(terminal['supervisor_startup_s'], 1)
        self.assertNotIn('duration_s', terminal['incomplete_stages'][0])
        self.assertIsNone(live_stages([dict(stage='legacy')], 20)[0]['elapsed_s'])

    def test_monotonic_duration_survives_backwards_wall_clock_without_fabricated_union(self):
        row = end('one', 'drc', 20, 19, 'kicad')
        row['duration_s'] = 2
        result = from_events([start('one', 'drc', 20, 'kicad'), row], terminal=True)
        self.assertEqual(result['spans'][0]['duration_s'], 2)
        self.assertIsNone(result['busy_wall_s'])
        self.assertEqual(result['coverage'], 'partial')
        self.assertIn('backwards', result['issues'][0])
        self.assertIsNone(union_seconds([]))
        self.assertEqual(from_events([])['coverage'], 'unavailable')

    def test_wrapper_keeps_child_exit_and_records_failed_boundary(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'stages.jsonl'
            self.assertEqual(main(['--events', str(path), '--stage', 'export', '--category', 'export',
                                   '--', sys.executable, '-c', 'raise SystemExit(23)']), 23)
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertEqual([row['type'] for row in rows], ['stage.start', 'stage.end'])
            self.assertEqual(rows[-1]['code'], 23)
            self.assertEqual(rows[-1]['status'], 'failed')
            self.assertGreaterEqual(rows[-1]['duration_s'], 0)
            self.assertEqual(rows[0]['span_id'], rows[1]['span_id'])

    def test_wrapper_launch_failure_never_claims_pass(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'stages.jsonl'
            with self.assertRaises(FileNotFoundError):
                main(['--events', str(path), '--stage', 'export', '--', str(Path(folder) / 'missing')])
            row = json.loads(path.read_text().splitlines()[-1])
            self.assertEqual(row['status'], 'error')
            self.assertNotIn('code', row)

    def test_owned_cancel_reaps_wrapper_child_and_grandchild(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            child = 'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'
            parent = ('import subprocess,sys,pathlib,time;'
                      'p=subprocess.Popen([sys.executable,"-c",' + repr(child) + ']);'
                      'pathlib.Path(' + repr(str(root / 'pid')) + ').write_text(str(p.pid));time.sleep(60)')
            command = [sys.executable, str(Path(__file__).with_name('pcb_timing.py')), '--events', str(root / 'events'),
                       '--stage', 'export', '--', sys.executable, '-c', parent]
            with self.assertRaises(subprocess.TimeoutExpired) as caught:
                lean.run_stage(command, stage='timed-export', deadline=lean.deadline_after(1.5, {}),
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertTrue(caught.exception.cleanup['complete'])
            self.assertTrue((root / 'pid').exists(), 'the actual descendant must start before cancellation')
            with self.assertRaises(ProcessLookupError):
                os.kill(int((root / 'pid').read_text()), 0)
            rows = [json.loads(line) for line in (root / 'events').read_text().splitlines()]
            summary = from_events(rows, terminal=True)
            self.assertEqual(summary['spans'], [])
            self.assertEqual(summary['incomplete_stages'][0]['stage'], 'export')


if __name__ == '__main__':
    unittest.main()
