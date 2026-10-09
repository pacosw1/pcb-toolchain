"""Same-host deadline and owned process cancellation regressions."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from unittest.mock import Mock

import lean_workflow as lean
import lean_resources as resources


class ClockTests(unittest.TestCase):
    def test_clock_round_trip_across_actual_processes(self):
        deadline = lean.deadline_after(3, {})
        env = dict(os.environ, PYTHONPATH=str(Path(lean.__file__).parent),
                   IOT_LEAN_DEADLINE=lean.encode_deadline(deadline))
        child = subprocess.run([sys.executable, '-c',
                                'import lean_workflow as l;print(l.now());print(l.remaining())'],
                               env=env, capture_output=True, text=True, check=True)
        clock, left = map(float, child.stdout.splitlines())
        self.assertLess(abs(clock-lean.now()), 1)
        self.assertGreater(left, 1)
        self.assertLessEqual(left, 3)

    def test_process_relative_monotonic_is_never_deadline_source(self):
        with patch('time.monotonic', return_value=-99999):
            deadline = lean.deadline_after(1, {})
            self.assertGreater(lean.remaining(deadline), .9)

    def test_raw_nan_unknown_protocol_fail_closed(self):
        for value in ('123', 'clock-monotonic-v1:nan', 'clock-monotonic-v2:3', ''):
            with self.subTest(value=value), patch.dict(os.environ, IOT_LEAN_DEADLINE=value):
                with self.assertRaises(ValueError):
                    lean.remaining()

    def test_nested_budget_cannot_extend_inherited(self):
        value = lean.now()+1
        env = dict(IOT_LEAN_DEADLINE=lean.encode_deadline(value))
        self.assertEqual(lean.deadline_after(100, env), value)

    def test_child_inherits_explicit_deadline(self):
        result = lean.run_stage([sys.executable, '-c',
                                'import os; print(os.environ["IOT_LEAN_DEADLINE"])'],
                               stage='clock', deadline=lean.deadline_after(2, {}),
                               stdout=subprocess.PIPE, text=True)
        self.assertGreater(lean.remaining(result.stdout.strip()), 0)

    def test_stage_cannot_extend_expired_inherited_deadline(self):
        env = dict(os.environ, IOT_LEAN_DEADLINE=lean.encode_deadline(lean.now()-1))
        with self.assertRaises(subprocess.TimeoutExpired):
            lean.run_stage(['must-not-launch'], stage='expired-parent',
                           deadline=lean.now()+30, env=env)

    def test_explicit_child_environment_cannot_remove_parent_budget(self):
        with patch.dict(os.environ, IOT_LEAN_DEADLINE=lean.encode_deadline(lean.now()-1)):
            with self.assertRaises(subprocess.TimeoutExpired):
                lean.run_stage(['must-not-launch'], stage='stripped-parent', env={}, deadline=lean.now()+30)

    def test_live_group_after_direct_child_exit_is_not_confirmed_clean(self):
        proc = Mock(pid=123456789)
        proc.communicate.return_value = ('', '')
        proc.poll.return_value = 0
        with patch.object(lean.os, 'killpg') as kill:
            record = lean.cleanup_group(proc)
        self.assertFalse(record['complete'])
        self.assertTrue(record['child_reaped'])
        self.assertTrue(any(call.args == (proc.pid, signal.SIGKILL) for call in kill.call_args_list))

    def test_actual_signal_distinguished_from_deadline(self):
        for signum in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signum=signum), tempfile.TemporaryDirectory() as d:
                event = Path(d)/'events'
                code = 'import os,signal,time;os.kill(os.getppid(),%d);time.sleep(30)' % signum
                with self.assertRaises(lean.StageCancelled) as caught:
                    lean.run_stage([sys.executable, '-c', code], stage='signal',
                                   deadline=lean.deadline_after(3, {}), event_file=event)
                self.assertEqual(caught.exception.signum, signum)
                record = json.loads(event.read_text())
                self.assertEqual(record['status'], 'cancelled')
                self.assertEqual(record['cause']['signal'], signum)
                self.assertTrue(record['cleanup']['child_reaped'])

    def test_group_eperm_preserves_original_timeout_and_marks_uncertain_cleanup(self):
        with tempfile.TemporaryDirectory() as d, patch.object(lean.os, 'killpg', side_effect=PermissionError('fixture')):
            event = Path(d)/'events'
            with self.assertRaises(subprocess.TimeoutExpired) as caught:
                lean.run_stage([sys.executable, '-c', 'import time;time.sleep(30)'],
                               stage='denied-group', deadline=lean.deadline_after(.15, {}), event_file=event)
            self.assertFalse(caught.exception.cleanup['complete'])
            self.assertTrue(caught.exception.cleanup['child_reaped'])
            self.assertEqual(json.loads(event.read_text())['status'], 'timeout')

    def test_expired_parent_budget_rejected_before_inherited_admission(self):
        with patch.dict(os.environ, IOT_LEAN_DEADLINE=lean.encode_deadline(lean.now()-1)):
            with self.assertRaises(TimeoutError), resources.reserve(1):
                self.fail('expired budget admitted')

    def test_profile_budget_includes_queue_wait(self):
        with tempfile.TemporaryDirectory() as d:
            env = dict(os.environ, IOT_RESOURCE_DIRECTORY=str(Path(d)/'resources'),
                       IOT_CPU_BUDGET='1', IOT_MEMORY_BUDGET_GIB='4')
            with patch.dict(os.environ, env), resources.reserve(1, 4):
                # Remove only inherited reservation: this is an independent queued job.
                env.pop('IOT_RESOURCE_TICKET', None)
                output = Path(d)/'profile'
                result = subprocess.run([sys.executable, resources.__file__, '--cpu', '1',
                                         '--memory-gib', '4', '--wait', '3', '--seconds', '.2',
                                         '--output', str(output), '--', sys.executable, '-c',
                                         'raise Exception("must not launch")'], env=env,
                                        capture_output=True, text=True, timeout=3)
            self.assertEqual(result.returncode, 124)
            record = json.loads((output/'outcome.json').read_text())
            self.assertEqual(record['status'], 'timeout')
            self.assertLess(record['wall_s'], 1)
            self.assertFalse((output/'command.log').exists())


if __name__ == '__main__':
    unittest.main()
