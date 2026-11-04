"""Actual process budget regressions, including KiCad Python 3.9 clocks."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import lean_route_bench as bench
import lean_workflow as lean


class RouteBudgetTests(unittest.TestCase):
    def test_actual_child_budget_ignores_process_relative_monotonic(self):
        with tempfile.TemporaryDirectory() as directory:
            events = Path(directory)/'events.jsonl'
            env = dict(os.environ, PYTHONPATH=str(Path(lean.__file__).parent))
            env.pop('IOT_LEAN_DEADLINE', None)
            with open(Path(directory)/'command.log', 'w+') as log:
                with patch('time.monotonic', return_value=-99999):
                    rc, wall = bench.run_policy(
                        [sys.executable, '-c', 'import lean_workflow as l;print(l.remaining(),flush=True)'],
                        seconds=3, events=events, env=env, log=log)
                log.seek(0)
                remaining = float(log.read().strip())
            self.assertEqual(rc, 0)
            self.assertGreater(remaining, 1)
            self.assertLessEqual(remaining, 3)
            self.assertGreaterEqual(wall, 0)

    def test_inherited_expiry_does_not_launch_or_gain_extra_allowance(self):
        with tempfile.TemporaryDirectory() as directory:
            sentinel = Path(directory)/'launched'
            events = Path(directory)/'events.jsonl'
            env = dict(os.environ, IOT_LEAN_DEADLINE=lean.encode_deadline(lean.now()-1))
            with open(Path(directory)/'command.log', 'w') as log:
                rc, wall = bench.run_policy(
                    [sys.executable, '-c', 'open(%r,"w").write("launched")' % str(sentinel)],
                    seconds=30, events=events, env=env, log=log)
            self.assertEqual(rc, 124)
            self.assertFalse(sentinel.exists())
            self.assertLess(wall, 1)


if __name__ == '__main__':
    unittest.main()
