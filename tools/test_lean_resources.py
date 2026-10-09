import json
import fcntl
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import lean_resources as r


class ResourcesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = dict(IOT_RESOURCE_DIRECTORY=self.tmp.name, IOT_CPU_BUDGET='2', IOT_MEMORY_BUDGET_GIB='4')
        self.patch = patch.dict(os.environ, self.env)
        self.patch.start()
        os.environ.pop('IOT_RESOURCE_TICKET', None)
        os.environ.pop('IOT_LEAN_DEADLINE', None)

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def holder(self, cpu=1, memory=4):
        code = ('import lean_resources as r,time; '
                f'ctx=r.reserve({cpu},{memory});ctx.__enter__();print("ready",flush=True);time.sleep(20)')
        p = subprocess.Popen([sys.executable, '-c', code], cwd=Path(__file__).parent,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertEqual(p.stdout.readline().strip(), 'ready')
        self.addCleanup(lambda: p.poll() is None and p.kill())
        return p

    def test_memory_wait_bound_and_crash_release(self):
        p = self.holder()
        start = time.monotonic()
        with self.assertRaises(TimeoutError):
            with r.reserve(1, 1, wait_s=.15):
                self.fail('memory capacity bypassed')
        self.assertLess(time.monotonic()-start, 1)
        p.kill()
        p.communicate()
        with r.reserve(2, 4, wait_s=0):
            pass
        self.assertEqual(list(Path(self.tmp.name).glob('*.ticket')), [])

    def test_nested_request_and_native_caps(self):
        with r.reserve(2, 4) as env:
            with r.environment(env):
                with r.reserve(1, 2) as child:
                    self.assertEqual(child['IOT_RESOURCE_TICKET'], env['IOT_RESOURCE_TICKET'])
                    self.assertTrue(all(child[k] == '1' for k in r.NATIVE_KEYS))
                with self.assertRaises(ValueError):
                    with r.reserve(2, 4.1):
                        pass

    def test_oversize_and_expired_rejected(self):
        for cpu, memory in [(3, 1), (0, 1), (1, 5), (1, float('nan'))]:
            with self.assertRaises(ValueError):
                with r.reserve(cpu, memory):
                    pass
        with patch.dict(os.environ, IOT_LEAN_DEADLINE=r.lean.encode_deadline(r.lean.now()-1)):
            with self.assertRaises(TimeoutError):
                with r.reserve(1, 1):
                    pass

    def test_conflicting_capacities_fail_closed(self):
        p = self.holder(memory=1)
        with patch.dict(os.environ, IOT_CPU_BUDGET='3'):
            with self.assertRaisesRegex(ValueError, 'disagree'):
                with r.reserve(1, 1):
                    pass
        p.terminate()
        p.communicate()

    def test_cpu_capacity_is_shared(self):
        p = self.holder(cpu=2, memory=1)
        with self.assertRaises(TimeoutError):
            with r.reserve(1, 1, wait_s=.05):
                self.fail('CPU capacity bypassed')
        p.kill()
        p.communicate()

    def test_busy_ledger_wait_is_bounded(self):
        with open(Path(self.tmp.name) / 'guard', 'a') as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            start = time.monotonic()
            with self.assertRaises(TimeoutError):
                with r.reserve(1, 1, wait_s=.05):
                    pass
            self.assertLess(time.monotonic()-start, .5)

    def test_wait_cancel_retains_observable_event(self):
        p = self.holder(cpu=2, memory=4)
        path = Path(self.tmp.name) / 'wait.jsonl'
        code = ('import lean_resources as r; '
                f'ctx=r.reserve(1,1,wait_s=10,events={str(path)!r});ctx.__enter__()')
        waiter = subprocess.Popen([sys.executable, '-c', code], cwd=Path(__file__).parent,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: waiter.poll() is None and waiter.kill())
        for _ in range(100):
            if path.exists():
                break
            time.sleep(.01)
        waiter.terminate()
        waiter.communicate(timeout=2)
        self.assertIn('cancelled', [json.loads(line)['action'] for line in path.read_text().splitlines()])
        p.kill()
        p.communicate()


if __name__ == '__main__':
    unittest.main()
