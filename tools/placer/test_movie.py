import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from placer import movie  # noqa: E402
from placer.test_viewer import run  # noqa: E402


class MovieTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_one_png_per_viewer_frame_in_order(self):
        paths = movie.render_frames(run(), self.tmp)
        self.assertEqual([os.path.basename(p) for p in paths], ['f0000.png', 'f0001.png', 'f0002.png'])
        for p in paths:
            with open(p, 'rb') as fh:
                self.assertEqual(fh.read(8), b'\x89PNG\r\n\x1a\n')

    def test_frame_rate_fits_the_target_length(self):
        self.assertEqual(movie.fps(300, 15.0), 20)
        self.assertEqual(movie.fps(3, 15.0), 1)  # never below 1 frame/s
        self.assertEqual(movie.fps(3000, 15.0), 30)  # never above 30 frames/s


if __name__ == '__main__':
    unittest.main()
