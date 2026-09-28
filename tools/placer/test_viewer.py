import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from placer import viewer  # noqa: E402


def run():
    units = [{'name': 'A', 'refs': ['A'], 'fixed': False, 'x': 2, 'y': 2, 'rects': [[-.5, -.5, .5, .5, .5]], 'box': None},
             {'name': 'B', 'refs': ['B'], 'fixed': True, 'x': 8, 'y': 8, 'rects': [[-.5, -.5, .5, .5, .5]], 'box': None}]
    pr = {'units': units, 'nets': [{'name': 'N', 'weight': 1.0, 'pins': [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]]}],
          'board': {'outline': [[0, 0], [10, 0], [10, 10], [0, 10]], 'keepouts': [], 'edge_clearance': 0.0},
          'region': {'box': [1, 1, 4, 4]}}
    comp = {'hpwl': 12.0, 'cong': 0.0, 'overlap': 0.0, 'oob': 0.0}
    step = {'s': 2.0, 'k': 1.2, 'cost': 12.0, 'unrouted': 0, 'passed': True, 'pose': [[3, 3, 0], [8, 8, 0]],
            'history': [{'epoch': 1, 'cost': 20.0, 'pose': [[2, 2, 0], [8, 8, 0]], 'components': comp},
                        {'epoch': 2, 'cost': 12.0, 'pose': [[3, 3, 1], [8, 8, 0]], 'components': comp}]}
    return {'problem': pr, 'steps': [step], 'verdict': 'fits'}


class ViewerTest(unittest.TestCase):
    def test_one_frame_per_epoch_and_per_step_result_self_contained(self):
        html, data = viewer.build(run())
        self.assertEqual(len(data['frames']), 3)
        self.assertEqual(data['frames'][-1]['unrouted'], 0)
        self.assertEqual(data['frames'][0]['segs'], [[2.0, 2.0, 8.0, 8.0]])
        self.assertEqual(data['frames'][0]['outline'][0], [-1.0, -1.0])  # virtual board k = 1.2
        self.assertNotIn('/*DATA*/null', html)
        self.assertNotIn('src="http', html)
        self.assertNotIn("href=\"http", html)
        self.assertEqual(data['units'][0]['nets'], ['N'])

    def test_a_step_with_no_search_result_adds_no_frame(self):
        r = run()
        r['steps'].append({'s': 1.0, 'k': 1.0, 'cost': float('nan'), 'unrouted': None, 'passed': False,
                           'pose': None, 'history': []})
        html, data = viewer.build(r)
        self.assertEqual(len(data['frames']), 3)


if __name__ == '__main__':
    unittest.main()
