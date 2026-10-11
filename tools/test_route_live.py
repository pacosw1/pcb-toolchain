"""Tests for tools/route_live.py (W12): the handlers on a fixture run directory, read-only, no path escape, bind rule."""
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import route_live as rl

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'run-record')


class Handlers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.rundir = os.path.join(cls.tmp, 'run-7')
        os.makedirs(os.path.join(cls.rundir, 'snapshots'))
        shutil.copy(os.path.join(FIX, 'run.log'), cls.rundir)
        shutil.copy(os.path.join(FIX, 'report.json'), cls.rundir)
        with open(os.path.join(cls.rundir, 'progress.jsonl'), 'w') as f:
            for e, st, p, o, b, eta in ((0.0, 'job start', None, None, None, None), (12.7, 'route start', None, None, None, None),
                                        (23.5, 'route', 1, 78, 78, None), (33.3, 'route', 3, 59, 59, 32.6), (37.2, 'route', 4, 44, 44, 17.0)):
                f.write(json.dumps({'t': 'x', 't0': 0, 'elapsed_s': e, 'stage': st, 'pass': p, 'open': o, 'vias': None, 'best_open': b, 'eta_s': eta}) + '\n')
        with open(os.path.join(cls.rundir, 'snapshots', 'latest.png'), 'wb') as f:
            f.write(b'\x89PNG\r\n\x1a\nfake')
        cls.done = os.path.join(cls.tmp, 'run-8')          # finished run: outcome.json, two snapshots
        os.makedirs(os.path.join(cls.done, 'snapshots'))
        with open(os.path.join(cls.done, 'progress.jsonl'), 'w') as f:
            f.write(json.dumps({'elapsed_s': 9.0, 'stage': 'route', 'pass': 2, 'open': 12, 'vias': None, 'best_open': 12, 'eta_s': None}) + '\n')
        with open(os.path.join(cls.done, 'outcome.json'), 'w') as f:
            json.dump({'status': 'stuck'}, f)
        for n, (e, p_, o) in (('0001', (9.0, 2, 12)), ('0000', (4.5, 1, 30))):
            with open(os.path.join(cls.done, 'snapshots', n + '.png'), 'wb') as f:
                f.write(b'\x89PNG\r\n\x1a\nfake')
            with open(os.path.join(cls.done, 'snapshots', n + '.json'), 'w') as f:
                json.dump({'t': 'x', 'elapsed_s': e, 'pass': p_, 'open': o, 'stage': 'route'}, f)
        with open(os.path.join(cls.done, 'snapshots', '0002.json'), 'w') as f:      # json without its png: not listed
            json.dump({'elapsed_s': 12.0}, f)
        rl.Handler.runs = rl.Runs([cls.rundir, cls.done], roots=())
        cls.srv = ThreadingHTTPServer(('127.0.0.1', 0), rl.Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        shutil.rmtree(cls.tmp)

    def get(self, path, method='GET'):
        req = urllib.request.Request(f'http://127.0.0.1:{self.port}{path}', method=method, data=b'' if method == 'POST' else None)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, r.headers.get('Content-Type', ''), r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get('Content-Type', ''), e.read()

    def test_index_lists_run(self):
        code, ctype, body = self.get('/')
        self.assertEqual(code, 200)
        self.assertIn('text/html', ctype)
        self.assertIn(b'/run/x/run-7', body)
        self.assertIn(b'open=44', body)
        self.assertIn(b'viewport', body)

    def test_run_page(self):
        code, _, body = self.get('/run/x/run-7')
        self.assertEqual(code, 200)
        t = body.decode()
        self.assertIn('route 37.2s open=44 best=44 vias=- eta=17.0', t)
        self.assertIn('<polyline', t)                       # pass trend
        self.assertIn('new EventSource(', t)
        self.assertNotIn('<meta http-equiv="refresh"', t)   # only a document.write fallback without EventSource
        self.assertIn('/events', t)
        self.assertIn('frame.png', t)                        # latest frame present
        self.assertIn('autorouter pass 3', t)                # action log tail, derived in memory
        self.assertFalse(os.path.exists(os.path.join(self.rundir, 'run.jsonl')))   # nothing written by the viewer

    def test_frame(self):
        code, ctype, body = self.get('/run/x/run-7/frame.png')
        self.assertEqual((code, ctype), (200, 'image/png'))
        self.assertTrue(body.startswith(b'\x89PNG'))

    def test_unknown_and_escape(self):
        self.assertEqual(self.get('/run/x/other')[0], 404)
        self.assertEqual(self.get('/run/x/run-7/../../etc/passwd')[0], 404)
        self.assertEqual(self.get('/run/' + os.path.relpath(self.rundir, '/'))[0], 404)
        self.assertEqual(self.get('/etc/passwd')[0], 404)
        self.assertEqual(self.get('/snapshots/latest.png')[0], 404)

    def read_events(self, path, n_data=1, n_hb=0, timeout=8):
        import socket
        sk = socket.create_connection(('127.0.0.1', self.port), timeout=timeout)
        sk.sendall(f'GET {path} HTTP/1.1\r\nHost: x\r\n\r\n'.encode())
        return sk

    @staticmethod
    def frames(sk, want, timeout=8):
        import time
        buf, t0 = b'', time.time()
        while time.time() - t0 < timeout and not want(buf):
            try:
                c = sk.recv(65536)
            except OSError:
                break
            if not c:
                break
            buf += c
        return buf

    def test_events_full_delta_heartbeat(self):
        old = rl.POLL_S, rl.HEARTBEAT_S
        rl.POLL_S, rl.HEARTBEAT_S = 0.1, 0.6
        prog = os.path.join(self.rundir, 'progress.jsonl')
        png = os.path.join(self.rundir, 'snapshots', 'latest.png')
        saved, png_t = open(prog).read(), os.stat(png).st_mtime
        try:
            sk = self.read_events('/run/x/run-7/events')
            buf = self.frames(sk, lambda b: b.count(b'data: ') >= 1)
            head, _, body = buf.partition(b'\r\n\r\n')
            self.assertIn(b'text/event-stream', head)
            first = json.loads(body.split(b'data: ', 1)[1].split(b'\n\n')[0])
            self.assertTrue(first['full'])
            self.assertEqual(first['passes'], [[1, 78], [3, 59], [4, 44]])
            self.assertEqual((first['open'], first['stage'], first['best_open']), (44, 'route', 44))
            self.assertTrue(first['frame']['url'].startswith('/run/x/run-7/frame.png'))
            self.assertTrue(first['log_reset'] and first['log_tail'])
            # nothing changed: a heartbeat comment, no data event
            buf = self.frames(sk, lambda b: b': heartbeat' in b)
            self.assertIn(b': heartbeat', buf)
            self.assertNotIn(b'data: ', buf)
            # append a pass and touch the frame: one delta event with only the new point
            with open(os.path.join(self.rundir, 'progress.jsonl'), 'a') as f:
                f.write(json.dumps({'elapsed_s': 41.0, 'stage': 'route', 'pass': 5, 'open': 30, 'vias': None, 'best_open': 30, 'eta_s': 9.0}) + '\n')
            os.utime(png, (first['frame']['mtime'] + 5, first['frame']['mtime'] + 5))
            buf = self.frames(sk, lambda b: b.count(b'data: ') >= 1)
            ev = json.loads(buf.split(b'data: ', 1)[1].split(b'\n\n')[0])
            self.assertFalse(ev['full'])
            self.assertEqual(ev['passes'], [[5, 30]])
            self.assertEqual(ev['open'], 30)
            self.assertEqual(ev['log_tail'], [])
            self.assertGreater(ev['frame']['mtime'], first['frame']['mtime'])
            sk.close()
        finally:
            rl.POLL_S, rl.HEARTBEAT_S = old
            open(prog, 'w').write(saved)
            os.utime(png, (png_t, png_t))

    def test_events_unknown_and_head(self):
        self.assertEqual(self.get('/run/x/other/events')[0], 404)
        self.assertEqual(self.get('/run/x/run-7/../../events')[0], 404)
        self.assertEqual(self.get('/run/x/run-7/events', 'POST')[0], 405)
        code, ctype, body = self.get('/run/x/run-7/events', 'HEAD')
        self.assertEqual((code, body), (200, b''))
        self.assertIn('text/event-stream', ctype)
        code, _, body = self.get('/run/x/run-7', 'HEAD')
        self.assertEqual((code, body), (200, b''))

    def test_selector_and_no_meta_refresh(self):
        for path in ('/run/x/run-7', '/'):
            t = self.get(path)[2].decode()
            self.assertIn('<select id="sel"', t)
            self.assertIn('value="x/run-8"', t)
            self.assertNotIn('<meta http-equiv="refresh"', t)
        run = self.get('/run/x/run-8')[2].decode()
        self.assertIn('class="taps"', run)
        self.assertIn('history.pushState', run)
        self.assertIn('id="strip"', run)
        self.assertIn('FINISHED: STUCK 12 open', run)
        self.assertIn('LIVE', self.get('/run/x/run-7')[2].decode())
        self.assertNotIn('http-equiv', self.get('/')[2].decode())

    def test_api_runs_split(self):
        code, ctype, body = self.get('/api/runs')
        self.assertEqual((code, ctype), (200, 'application/json'))
        d = json.loads(body)
        self.assertEqual([i['id'] for i in d['active']], ['x/run-7'])
        self.assertEqual([i['id'] for i in d['recent']], ['x/run-8'])
        self.assertTrue(d['active'][0]['live'])
        self.assertEqual(d['active'][0]['open'], 44)
        self.assertEqual(d['recent'][0]['banner'], 'FINISHED: STUCK 12 open')
        self.assertEqual(self.get('/api/runs', 'POST')[0], 405)
        self.assertEqual(self.get('/api/runs', 'HEAD')[1:], ('application/json', b''))

    def test_finished_run_events_one_event_then_close(self):
        sk = self.read_events('/run/x/run-8/events')
        buf = self.frames(sk, lambda b: False, timeout=5)      # reads until the server closes the stream
        sk.close()
        self.assertEqual(buf.count(b'data: '), 1)
        ev = json.loads(buf.split(b'data: ', 1)[1].split(b'\n\n')[0])
        self.assertTrue(ev['finished'] and not ev['live'])
        self.assertEqual(ev['banner'], 'FINISHED: STUCK 12 open')

    def test_snapshots(self):
        code, ctype, body = self.get('/run/x/run-8/snapshots.json')
        self.assertEqual((code, ctype), (200, 'application/json'))
        lst = json.loads(body)
        self.assertEqual([e['i'] for e in lst], [0, 1])                 # ordered by elapsed_s; 0002 has no png
        self.assertEqual(lst[1], {'i': 1, 'elapsed_s': 9.0, 'pass': 2, 'open': 12, 'stage': 'route', 'url': '/run/x/run-8/snapshots/0001.png'})
        code, ctype, body = self.get(lst[0]['url'])
        self.assertEqual((code, ctype), (200, 'image/png'))
        self.assertEqual(json.loads(self.get('/run/x/run-7/snapshots.json')[2]), [])
        for bad in ('/run/x/other/snapshots.json', '/run/x/run-8/snapshots/0009.png', '/run/x/run-8/snapshots/latest.png',
                    '/run/x/run-8/../run-7/snapshots/0000.png', '/run/x/run-8/snapshots/../progress.jsonl', '/run/x/other/snapshots/0000.png'):
            self.assertEqual(self.get(bad)[0], 404, bad)
        t = self.get('/run/x/run-8')[2].decode()
        for ident in ('id="scrub"', 'id="play"', 'id="speed"', 'id="golive"', 'id="hint"'):
            self.assertIn(ident, t)

    def test_log_structured(self):
        j = json.loads(self.get('/run/x/run-7/log.json')[2])
        self.assertTrue(j['records'] and j['start'] == 0)
        self.assertEqual(j['records'][-1]['action'], j['records'][-1]['action'])
        self.assertTrue(any(r['action'] == 'pass' for r in j['records']))
        j2 = json.loads(self.get('/run/x/run-7/log.json?before=2')[2])
        self.assertEqual(len(j2['records']), 2)
        t = self.get('/run/x/run-7')[2].decode()
        for ident in ('id="logbox"', 'id="lq"', 'data-f="decisions"', 'id="older"'):
            self.assertIn(ident, t)

    def test_read_only(self):
        self.assertEqual(self.get('/run/x/run-7', 'POST')[0], 405)
        self.assertEqual(self.get('/', 'DELETE')[0], 405)


class Bind(unittest.TestCase):
    def test_bind_rule(self):
        self.assertTrue(rl.allowed_bind(rl.TS_ADDR))
        self.assertTrue(rl.allowed_bind('127.0.0.1'))
        for bad in ('0.0.0.0', '::', '192.168.1.5', '8.8.8.8', '', 'localhost'):
            self.assertFalse(rl.allowed_bind(bad), bad)
        with self.assertRaises(SystemExit):
            rl.serve('0.0.0.0', 0)

    def test_trend_svg(self):
        self.assertIn('no passes yet', rl.trend_svg([]))
        s = rl.trend_svg([(10, 50), (20, 30), (30, 10)])
        self.assertIn('polyline', s)
        self.assertIn('>10<', s)


class Audit829(unittest.TestCase):
    """CIP #829 audit (comment 2881): STALE is not terminal; a quiet interval over 60 s then renewed progress keeps one
    stream live; only outcome.json or the exit record finishes; an incomplete trailing run.jsonl append is tolerated."""

    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.prog = os.path.join(self.d, 'progress.jsonl')

    def tearDown(self):
        shutil.rmtree(self.d)

    def row(self, e, stage, p=None, o=None):
        with open(self.prog, 'a') as f:
            f.write(json.dumps({'t': 'x', 't0': 0, 'elapsed_s': e, 'stage': stage, 'pass': p, 'open': o, 'vias': None,
                                'best_open': o, 'eta_s': None}) + '\n')

    def age(self, s):
        t = time.time() - s
        os.utime(self.prog, (t, t))

    def test_quiet_over_60s_then_renewed_progress(self):
        self.row(0.0, 'route start')
        self.row(9.0, 'route', 1, 30)
        st = rl.Stream('x/q', self.d)
        self.assertEqual(st.event()['status'], 'ACTIVE')
        self.age(61)
        ev = st.event()
        self.assertEqual(ev['status'], 'STALE')
        self.assertFalse(ev['finished'])
        self.assertNotIn('FINISHED', ev['banner'])
        self.assertIn('still listening', ev['banner'])
        self.assertEqual([i['id'] for i in rl.summary(_One(self.d))['recent']], ['x/q'])
        self.row(80.0, 'route', 2, 20)                                   # progress resumes after the quiet interval
        ev = st.event()
        self.assertEqual((ev['status'], ev['finished'], ev['live'], ev['banner']), ('ACTIVE', False, True, 'LIVE'))
        self.assertEqual(ev['passes'], [[2, 20]])
        with open(os.path.join(self.d, 'outcome.json'), 'w') as f:
            json.dump({'status': 'stuck'}, f)
        ev = st.event()
        self.assertTrue(ev['finished'])
        self.assertEqual(ev['banner'], 'FINISHED: STUCK 20 open')

    def test_no_progress_is_not_finished(self):
        s = rl.status(self.d)
        self.assertEqual((s['state'], s['finished']), ('NO PROGRESS', False))
        self.assertNotIn('FINISHED', rl.banner_text(s))

    def test_exit_record_finishes(self):
        self.row(0.0, 'route start')
        self.age(120)
        with open(os.path.join(self.d, 'run.jsonl'), 'w') as f:
            f.write(json.dumps(rl.run_record.record('job', 'exit FAILED', result={'returncode': 1}, why='x')) + '\n')
        ev = rl.Stream('x/q', self.d).event()
        self.assertTrue(ev['finished'])
        self.assertEqual(ev['banner'], 'FINISHED: FAILED')

    def test_incomplete_trailing_run_jsonl_append(self):
        self.row(0.0, 'route start')
        with open(os.path.join(self.d, 'run.jsonl'), 'w') as f:
            f.write(json.dumps(rl.run_record.record('job', 'configure', why='bound', elapsed_s=0.0)) + '\n{"t": "x", "act')
        ev = rl.Stream('x/q', self.d).event()                           # raised JSONDecodeError before the fix
        self.assertIn('configure', [r['action'] for r in ev['log_tail']])
        with open(self.prog, 'a') as f:
            f.write('{"t": "x", "elap')
        self.assertEqual(rl.status(self.d)['stage'], 'route start')
        import route_progress
        self.assertEqual(route_progress.last(self.prog)['stage'], 'route start')


class _One:
    def __init__(self, d):
        self.d = d

    def ids(self):
        return {'x/q': self.d}


if __name__ == '__main__':
    unittest.main()
