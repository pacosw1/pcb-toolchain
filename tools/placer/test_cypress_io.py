import json
import os
import tempfile
import unittest

from placer import cypress_io

PR = {'board': {'outline': [[10, 20], [60, 20], [60, 50], [10, 50]], 'keepouts': [[[55, 45], [58, 45], [58, 48]]]},
      'units': [{'name': 'A', 'fixed': False, 'x': 20.0, 'y': 30.0, 'rects': [[-1, -2, 3, 1, 0.5]]},
                {'name': 'B', 'fixed': True, 'x': 40.0, 'y': 40.0, 'rects': [[-2, -2, 2, 2, 0.5]]}],
      'nets': [{'name': 'N 1', 'weight': 1.0, 'pins': [[0, 1, 0, 1, 0], [1, 0, 0, 0, 0]]},
               {'name': 'ONE', 'weight': 1.0, 'pins': [[0, 0, 0, 0, 0]]}]}


class RoundTrip(unittest.TestCase):
    def test_start_pose_comes_back(self):
        start = json.loads(json.dumps(PR))
        start['units'][0].update(x=33.3, y=27.7)
        with tempfile.TemporaryDirectory() as d:
            n, t, W, H = cypress_io.to_bookshelf(PR, start, d, 'b', 10)
            self.assertEqual((n, t, W, H), (3, 2, 500, 300))
            nets = open(os.path.join(d, 'b.nets')).read()
            self.assertIn('NumNets : 1', nets)
            self.assertIn('U0 B : 0.000 5.000', nets)  # pin (1, 0) minus box centre (1, -0.5), times 10
            pose, orients = cypress_io.from_bookshelf(PR, os.path.join(d, 'b.aux'), os.path.join(d, 'b.pl'), 10)
        self.assertAlmostEqual(pose[0][0], 33.3, places=3)
        self.assertAlmostEqual(pose[0][1], 27.7, places=3)
        self.assertEqual(pose[1], (40.0, 40.0, 0))
        self.assertEqual(orients, {'N': 1})


if __name__ == '__main__':
    unittest.main()
