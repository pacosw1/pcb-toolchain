"""Tests for tools/run_record.py (W5): the record schema, the order of the log, the parser of the router's reasons."""
import json
import os
import shutil
import tempfile
import unittest

import run_record as rr

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'run-record')


class Schema(unittest.TestCase):
    def test_keys_and_order(self):
        r = rr.record('route', 'pass', result={'pass': 1}, why='x', elapsed_s=1.0)
        self.assertEqual(tuple(r), rr.KEYS)
        self.assertEqual(r['why'], 'x')

    def test_append_reads_back_in_order(self):
        d = tempfile.mkdtemp()
        try:
            rr.start(d, t0=0)
            rr.append(d, 'a', 'one', why='first', elapsed_s=1)
            rr.append(d, 'b', 'two', why='second', elapsed_s=2)
            rows = rr.read(d)
            self.assertEqual([r['action'] for r in rows], ['one', 'two'])
            self.assertTrue(all(tuple(r) == rr.KEYS for r in rows))
            self.assertEqual(rr.ordered(rows[::-1])[0]['action'], 'one')
        finally:
            shutil.rmtree(d)

    def test_unknown_elapsed_keeps_file_position(self):
        a = rr.record('s', 'a', elapsed_s=5.0)
        b = rr.record('s', 'b', elapsed_s=None)
        c = rr.record('s', 'c', elapsed_s=6.0)
        self.assertEqual([r['action'] for r in rr.ordered([a, b, c])], ['a', 'b', 'c'])


class RouterLog(unittest.TestCase):
    def test_pass_line(self):
        recs = rr.parse_log(open(os.path.join(FIX, 'run.log')).read(), offset=12.7)
        passes = [r for r in recs if r['action'] == 'pass']
        self.assertEqual([p['result']['pass'] for p in passes], [1, 2, 3, 29, 30])
        p1 = passes[0]['result']
        self.assertEqual((p1['open'], p1['violations'], p1['ripups'], p1['routed'], p1['failed']), (78, 3, 93, 172, 35))
        self.assertAlmostEqual(passes[0]['elapsed_s'], 12.7 + 10.784, places=1)
        self.assertIn('93 rip-ups', passes[0]['why'])

    def test_other_actions(self):
        recs = rr.parse_log(open(os.path.join(FIX, 'run.log')).read())
        actions = [r['action'] for r in recs]
        for a in ('fanout', 'checkpoint', 'stop', 'router end', 'skip', 'diagnosis'):
            self.assertIn(a, actions)
        diag = next(r for r in recs if r['action'] == 'diagnosis')
        self.assertEqual(diag['result'], {'open': 10, 'congestion': 6, 'blocked': 4, 'ignored': 0, 'seconds': 8.71})
        skip = next(r for r in recs if r['action'] == 'skip')
        self.assertEqual(skip['result']['items'], 8)
        self.assertIn('second failure', skip['why'])
        self.assertEqual(sorted(r['elapsed_s'] for r in recs), [r['elapsed_s'] for r in recs])

    def test_reasons_per_net(self):
        recs = rr.reasons(json.load(open(os.path.join(FIX, 'report.json'))), elapsed_s=96.0)
        self.assertEqual([r['inputs']['net'] for r in recs], ['/PWR-24V/VIN', '/PWR-24V/5V_24V'])
        self.assertEqual([r['result']['class'] for r in recs], ['blocked', 'congestion'])
        self.assertEqual(recs[0]['inputs']['from'], 'U18.2')
        self.assertIn('no connection was found', recs[0]['result']['router_text'])
        self.assertTrue(recs[0]['why'].startswith('blocked:'))
        self.assertEqual(recs[1]['result']['passes_failed'], [1, 10])


class Sync(unittest.TestCase):
    def test_sync_is_idempotent(self):
        d = tempfile.mkdtemp()
        try:
            shutil.copy(os.path.join(FIX, 'run.log'), d)
            shutil.copy(os.path.join(FIX, 'report.json'), d)
            with open(os.path.join(d, 'progress.jsonl'), 'w') as f:
                f.write(json.dumps({'t': 'x', 't0': 0, 'elapsed_s': 0.0, 'stage': 'job start'}) + '\n')
                f.write(json.dumps({'t': 'x', 't0': 0, 'elapsed_s': 12.7, 'stage': 'route start'}) + '\n')
                f.write(json.dumps({'t': 'x', 't0': 0, 'elapsed_s': 95.9, 'stage': 'route end'}) + '\n')
            json.dump({'status': 'stuck', 'signal_open': 10, 'note': 'fail_fast'}, open(os.path.join(d, 'outcome.json'), 'w'))
            n = rr.sync(d)
            self.assertEqual(rr.sync(d), 0)
            rows = rr.ordered(rr.read(d))
            self.assertEqual(len(rows), n)
            self.assertEqual(rows[0]['action'], 'job start')
            self.assertEqual(rows[-1]['action'], 'exit STUCK')
            self.assertEqual(rows[-1]['elapsed_s'], 95.9)
            lines = rr.log_lines(d, do_sync=False)
            self.assertTrue(any('exit STUCK' in l and 'fail_fast' in l for l in lines))
        finally:
            shutil.rmtree(d)


if __name__ == '__main__':
    unittest.main()
