"""Tests for tools/board_frame.py and tools/route_snapshots.py (W12): DSN/SES parse, a frame with open lines, the
snapshot watcher, the MP4 (when ffmpeg is present). The real-run test uses /tmp/w12/run-1 when it exists."""
import json
import os
import shutil
import tempfile
import time
import unittest

import board_frame as bf
import route_snapshots as rs

DSN = """(pcb "x.dsn"
  (parser (string_quote ") (space_in_quoted_tokens on))
  (resolution um 10) (unit um)
  (structure (layer F.Cu (type signal)) (layer B.Cu (type signal))
    (boundary (path pcb 0  20000 -10000  0 -10000  0 0  20000 0  20000 -10000)))
  (placement (component "lib:R" (place R1 5000 -5000 front 0) (place R2 15000 -5000 back 90)))
  (library (image "lib:R" (pin Rect_1x2 1 -1000 0) (pin Rect_1x2 2 1000 0))
    (padstack Rect_1x2 (shape (rect F.Cu -500 -1000 500 1000)))
    (padstack "Via[0-1]_600:300_um" (shape (circle F.Cu 600)) (shape (circle B.Cu 600))))
  (network (net N1 (pins R1-1 R2-1)))
  (wiring))
"""
SES = """(session x
  (base_design x.dsn)
  (placement (resolution um 10) (component "lib:R" (place R1 50000 -50000 front 0)))
  (routes (resolution um 10)
    (network_out (net N1
      (wire (path F.Cu 2000  40000 -50000  100000 -50000))
      (wire (path B.Cu 2000  100000 -50000  140000 -50000))
      (via "Via[0-1]_600:300_um" 100000 -50000)))))
"""
REAL = '/tmp/w12/run-1'


def fixture_dir():
    d = tempfile.mkdtemp()
    open(os.path.join(d, 'board.dsn'), 'w').write(DSN)
    open(os.path.join(d, 'board.ses'), 'w').write(SES)
    json.dump({'connections': [{'a_pos': {'x': 4, 'y': 2}, 'b_pos': {'x': 16, 'y': 2}}]}, open(os.path.join(d, 'open-triage.json'), 'w'))
    return d


def count(png, colour):
    from PIL import Image
    im = Image.open(png).convert('RGB')
    px = im.load()
    return sum(1 for x in range(im.size[0]) for y in range(im.size[1]) if px[x, y] == colour)


class Parse(unittest.TestCase):
    def test_dsn(self):
        d = fixture_dir()
        try:
            dsn = bf.load_dsn(os.path.join(d, 'board.dsn'))
            self.assertEqual(dsn['bbox'], (0.0, 0.0, 20.0, 10.0))
            self.assertEqual(len(dsn['outline']), 5)
            self.assertEqual(len(dsn['pads']), 4)
            r1 = sorted(p for p in dsn['pads'] if p[4] == 'front')
            self.assertEqual(r1[0][:4], (4.0, 5.0, 1.0, 2.0))      # R1 pin 1 at x 5 - 1, 1 x 2 mm pad
            r2 = sorted(p for p in dsn['pads'] if p[4] == 'back')
            self.assertEqual(r2[0][2:4], (2.0, 1.0))               # rotated 90: pad box swapped
        finally:
            shutil.rmtree(d)

    def test_ses_resolution(self):
        d = fixture_dir()
        try:
            ses = bf.load_ses(os.path.join(d, 'board.ses'))
            self.assertEqual(len(ses['wires']), 2)
            self.assertEqual(ses['wires'][0], ('F.Cu', 0.2, [(4.0, 5.0), (10.0, 5.0)]))
            self.assertEqual(ses['vias'], [(10.0, 5.0)])
            self.assertEqual(bf.open_lines(d), [(4, 2, 16, 2)])
        finally:
            shutil.rmtree(d)


class Frame(unittest.TestCase):
    def test_synthetic_frame_has_open_line_and_tracks(self):
        d = fixture_dir()
        try:
            out = bf.frame(d, stamp='test', width=400)
            self.assertTrue(os.path.isfile(out))
            self.assertGreater(count(out, bf.OPEN), 100)
            self.assertGreater(count(out, bf.COLOURS['F.Cu']), 50)
            self.assertGreater(count(out, bf.COLOURS['B.Cu']), 50)
        finally:
            shutil.rmtree(d)

    @unittest.skipUnless(os.path.isfile(os.path.join(REAL, 'board.ses')), 'no real run at /tmp/w12/run-1')
    def test_real_run_frame(self):
        d = tempfile.mkdtemp()
        try:
            t = time.time()
            out = bf.frame(REAL, out=os.path.join(d, 'f.png'))
            self.assertLess(time.time() - t, 1.0)                  # < 1 s per frame
            self.assertEqual(bf.load_dsn(os.path.join(REAL, 'board.dsn'))['bbox'], (74.0, 55.0, 174.0, 145.0))
            self.assertGreater(count(out, bf.OPEN), 500)           # 10 open connections drawn in red
            from PIL import Image
            self.assertEqual(Image.open(out).size[0], 1200)
        finally:
            shutil.rmtree(d)


class Snapshots(unittest.TestCase):
    def test_watcher_takes_on_change_only(self):
        d = fixture_dir()
        try:
            log = os.path.join(d, 'run.log')
            open(log, 'w').write('   10.784 INFO  Auto-routing pass #1 was completed in 7.63 seconds with score 793.53 (78 unrouted and 3 violations)\n')
            w = rs.Watcher(os.path.join(d, 'board.ses'), d, log, interval_s=0, stage='route', t0=time.time() - 30)
            self.assertEqual(w.take(), 0)
            self.assertIsNone(w.take())                             # unchanged SES: no snapshot
            side = json.load(open(os.path.join(d, 'snapshots', '0000.json')))
            self.assertEqual((side['pass'], side['open'], side['stage']), (1, 78, 'route'))
            self.assertGreaterEqual(side['elapsed_s'], 30)
            for ext in ('.ses', '.json', '.png'):
                self.assertTrue(os.path.isfile(os.path.join(d, 'snapshots', '0000' + ext)), ext)
            self.assertTrue(os.path.isfile(os.path.join(d, 'snapshots', 'latest.png')))
            time.sleep(0.01)
            open(os.path.join(d, 'board.ses'), 'a').write('\n')
            self.assertEqual(w.take(), 1)
            self.assertEqual(w.errors, [])
        finally:
            shutil.rmtree(d)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'no ffmpeg')
    def test_mp4_deletes_frames_unless_keep(self):
        d = fixture_dir()
        try:
            for i in range(3):
                bf.frame(d, out=os.path.join(d, 'snapshots', f'{i:04d}.png'), stamp=str(i), width=200)
            self.assertIsNone(bf.mp4(os.path.join(d, 'nothing')))
            self.assertTrue(bf.mp4(d, seconds=1, keep=True))
            self.assertEqual(len([n for n in os.listdir(os.path.join(d, 'snapshots')) if n.endswith('.png')]), 3)
            self.assertTrue(bf.mp4(d, seconds=1))
            self.assertEqual([n for n in os.listdir(os.path.join(d, 'snapshots')) if n.endswith('.png')], [])
            self.assertGreater(os.path.getsize(os.path.join(d, 'timelapse.mp4')), 0)
        finally:
            shutil.rmtree(d)


if __name__ == '__main__':
    unittest.main()
