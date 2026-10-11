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


def _pline(t, n, open_):
    return (f'   {t:.3f} INFO  Auto-routing pass #{n} was completed in 1.00 seconds with score 10.0 '
            f'({open_} unrouted and 0 violations) (routed 5, failed 1, ripped 2).\n')


def _prow(e, stage, p=None, o=None, t0=1000.0):
    return json.dumps({'t': 'x', 't0': t0, 'elapsed_s': e, 'stage': stage, 'pass': p, 'open': o, 'vias': None,
                       'best_open': o, 'eta_s': None}) + '\n'


def _unrouted(net):
    return {'unrouted': [{'net': net, 'from': {'kind': 'pin', 'component': 'U1', 'pin': '1'},
                          'to': {'kind': 'pin', 'component': 'U2', 'pin': '2'}, 'diagnosis': {'class': 'congestion'}}]}


class Audit805(unittest.TestCase):
    """CIP #805 audit (comment 2880): every routing stage's files, stage identity, per-stage clocks, UNKNOWN wording,
    an incomplete trailing JSONL append."""

    def setUp(self):
        self.d = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.d)

    def w(self, name, text):
        with open(os.path.join(self.d, name), 'w') as f:
            f.write(text)

    def by(self, stage, action):
        return [r for r in rr.derive(self.d) if r['stage'] == stage and r['action'] == action]

    def test_fast_stage_files_and_clocks(self):
        # route-fast twice (attempt 2 owns the files), then the final stage: each log on its own stage's clock
        self.w('progress.jsonl', _prow(0.0, 'job start') + _prow(1.0, 'route-fast start') + _prow(2.0, 'route-fast end')
               + _prow(5.0, 'route-fast start') + _prow(8.0, 'route-fast', 1, 12) + _prow(20.0, 'route-fast end')
               + _prow(30.0, 'route start') + _prow(34.0, 'route', 1, 3) + _prow(50.0, 'route end'))
        self.w('run-fast.log', _pline(2.5, 1, 12))
        self.w('run.log', _pline(3.0, 1, 3))
        self.w('report-fast.json', json.dumps(_unrouted('/FAST')))
        self.w('report.json', json.dumps(_unrouted('/FINAL')))
        self.w('stall-fast.json', json.dumps({'stopped': True, 'seconds': 1018.0, 'stall_passes': 4, 'stage': 'fast'}))
        self.w('optimize-fast.log', _pline(1.5, 2, 11))
        fast = self.by('route-fast', 'pass')
        self.assertEqual(len(fast), 1)
        self.assertEqual(fast[0]['elapsed_s'], 7.5)
        self.assertEqual((fast[0]['inputs']['attempt'], fast[0]['inputs']['log']), (2, 'run-fast.log'))
        final = self.by('route', 'pass')
        self.assertEqual([r['elapsed_s'] for r in final], [33.0])      # the final stage's own start, not route-fast's
        opens = {r['stage']: r for r in rr.derive(self.d) if r['action'] == 'open'}
        self.assertEqual((opens['route-fast']['elapsed_s'], opens['route-fast']['inputs']['net']), (20.0, '/FAST'))
        self.assertEqual((opens['route']['elapsed_s'], opens['route']['inputs']['net']), (50.0, '/FINAL'))
        self.assertEqual(opens['route-fast']['evidence'], 'report-fast.json unrouted[]')
        stall = self.by('route-fast', 'stall stop')
        self.assertEqual((len(stall), stall[0]['evidence'], stall[0]['elapsed_s']), (1, 'stall-fast.json', 18.0))
        opt = self.by('optimize-fast', 'pass')
        self.assertEqual(opt[0]['elapsed_s'], 21.5)                    # optimizer starts at route-fast end
        self.assertEqual([s['stage'] for s in rr.route_stages(self.d, rr._rows(self.d, 'progress.jsonl'))], ['route-fast', 'route'])

    def test_progress_passes_when_the_log_has_none(self):
        self.w('progress.jsonl', _prow(0.0, 'route-fast start') + _prow(8.0, 'route-fast', 1, 12) + _prow(9.0, 'route-fast end'))
        p = self.by('route-fast', 'pass')
        self.assertEqual([(r['result']['pass'], r['result']['open'], r['elapsed_s']) for r in p], [(1, 12, 8.0)])

    def test_unknown_triage_says_cause_unknown(self):
        self.w('open-triage.json', json.dumps({'open': 3, 'enclosed': 1, 'router_miss': 1, 'unknown': 1, 'connections': [
            {'net': 'A', 'class': 'ENCLOSED'}, {'net': 'B', 'class': 'ROUTER_MISS'}, {'net': 'C', 'class': 'UNKNOWN'}]}))
        why = {r['inputs']['net']: r['why'] for r in self.by('triage', 'open')}
        self.assertEqual(why['B'], 'a path exists; the router missed it')
        self.assertIn('cause is unknown', why['C'])
        self.assertNotIn('router missed', why['C'])
        self.assertIn('no legal path', why['A'])

    def test_incomplete_last_append_keeps_valid_rows(self):
        good = json.dumps(rr.record('job', 'configure', why='x', elapsed_s=0.0))
        self.w('run.jsonl', good + '\n' + '{"t": "2026-10-11T00:00:00", "elapsed_s": 1.0, "stag')
        self.assertEqual([r['action'] for r in rr.read(self.d)], ['configure'])
        self.w('progress.jsonl', _prow(0.0, 'route start') + '{"t": "x", "elap')
        self.assertTrue(rr.view(self.d))
        self.assertEqual(rr.sync(self.d), 1)                            # the route start row; the partial line kept as is
        self.w('run.jsonl', good + '\n{"broken\n' + good + '\n')
        with self.assertRaises(ValueError):                             # a bad line before the last is corruption
            rr.read(self.d)


if __name__ == '__main__':
    unittest.main()
