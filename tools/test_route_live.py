"""Tests for tools/route_live.py (W12): the handlers on a fixture run directory, read-only, no path escape, bind rule."""
import json
import os
import shutil
import tempfile
import threading
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
        rl.Handler.runs = rl.Runs([cls.rundir], roots=())
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


if __name__ == '__main__':
    unittest.main()
