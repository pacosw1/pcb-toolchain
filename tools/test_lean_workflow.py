import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

import lean_workflow as lean


class WorkflowTest(unittest.TestCase):
    def test_router_timeout_retains_checkpoint_hash_and_cannot_be_promoted(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            checkpoint = root / 'board.ses'
            checkpoint.write_text('partial session')
            lean.router_timeout(root)
            evidence = json.loads((root / 'outcome.json').read_text())
            self.assertEqual(evidence['status'], 'timeout')
            self.assertEqual(evidence['returncode'], 124)
            self.assertFalse(evidence['qualified'])
            self.assertEqual(evidence['artifacts']['board.ses'], lean.digest(checkpoint))
            self.assertEqual(checkpoint.read_text(), 'partial session')
            self.assertFalse((root / 'routed.kicad_pcb').exists())

    def test_deadline_preserves_checkpoint_and_never_accepts_successful_timeout(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'checkpoint'
            code = ('import signal,time,pathlib,sys; '
                    'signal.signal(signal.SIGTERM,lambda *a:(pathlib.Path(sys.argv[1]).write_text("saved"),sys.exit(0))); '
                    'time.sleep(30)')
            with self.assertRaises(subprocess.TimeoutExpired):
                lean.run_stage([sys.executable, '-c', code, str(p)], stage='test',
                               deadline=time.monotonic() + .3, event_file=str(Path(d) / 'events'))
            self.assertEqual(p.read_text(), 'saved')
            self.assertEqual(json.loads((Path(d) / 'events').read_text())['status'], 'timeout')

    def test_expired_deadline_does_not_launch(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            lean.run_stage(['does-not-exist'], stage='test', deadline=time.monotonic() - 1)

    def test_only_native_existing_copper_errors_are_fatal(self):
        rows = [{'type': t, 'severity': 'error'} for t in ['clearance', 'shorting_items', 'unconnected_items']]
        rows += [dict(type='clearance', severity='warning'), dict(type='clearance', severity='error', excluded=True)]
        self.assertEqual([x['type'] for x in lean.preflight_errors({'violations': rows})], ['clearance', 'shorting_items'])

    def test_virtual_and_timeout_results_cannot_be_promoted_or_old_paths_followed(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            steps = []
            for i, (scale, score, status) in enumerate([(1.4, 0, 'complete'), (1., 0, 'timeout'), (1., 3, 'complete')]):
                b = root / f'step-{i}' / 'route-0' / 'routed.kicad_pcb'
                b.parent.mkdir(parents=True)
                b.write_text('candidate')
                steps.append(dict(k=scale, runs=[score], passed=score == 0, status=status, board='/wrong/run/board'))
            self.assertEqual(lean.select_real({'steps': steps}, root), str((root / 'step-2/route-0/routed.kicad_pcb').resolve()))
            with self.assertRaises(ValueError):
                lean.select_real({'steps': steps[:2]}, root)

    def test_admission_refuses_second_pipeline_without_stealing_slot(self):
        with tempfile.TemporaryDirectory() as d:
            with lean.job_slot(Path(d) / 'lock'):
                with self.assertRaises(RuntimeError):
                    with lean.job_slot(Path(d) / 'lock'):
                        pass

    def test_thread_budget_covers_both_router_phases(self):
        opts = lean.optimizer_options('off', 4)
        self.assertIn('--router.autorouter.max_threads=4', opts)
        self.assertIn('--router.optimizer.max_threads=4', opts)
        self.assertIn('--router.optimizer.enabled=false', opts)

    def test_modified_candidate_and_malformed_drc_are_rejected(self):
        with self.assertRaises(ValueError):
            lean.validate_drc({'violations': []})
        with tempfile.TemporaryDirectory() as d:
            b = Path(d) / 'step-0/route-0/routed.kicad_pcb'
            b.parent.mkdir(parents=True)
            b.write_text('before')
            lean.atomic_json(b.parent / 'outcome.json', dict(status='complete', board_sha256=lean.digest(b)))
            b.write_text('changed')
            with self.assertRaises(ValueError):
                lean.select_real({'steps': [dict(k=1., board='b', runs=[0], passed=True)]}, d)

    def test_pipeline_success_during_shutdown_grace_is_still_incomplete(self):
        with tempfile.TemporaryDirectory() as d:
            p = subprocess.run([sys.executable, str(Path(lean.__file__)), 'exec', '--work', d,
                                '--lock', str(Path(d) / 'lock'), '--budget', '.1', '--',
                                sys.executable, '-c', 'import time;time.sleep(.2)'], capture_output=True, text=True)
            self.assertEqual(p.returncode, 124)
            self.assertEqual(json.loads((Path(d) / 'pipeline-outcome.json').read_text())['status'], 'timeout')


if __name__ == '__main__':
    unittest.main()
