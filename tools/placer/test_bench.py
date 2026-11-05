import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from placer import bench  # noqa: E402


def unit(name, x, y, fixed=False):
    return {'name': name, 'refs': [name], 'fixed': fixed, 'x': x, 'y': y, 'rects': [[-.5, -.5, .5, .5, .5]]}


def problem():
    return {'units': [unit('A', 5, 5), unit('B', 10, 10), unit('H', 1, 1, fixed=True)], 'nets': [],
            'board': {'outline': [[0, 0], [20, 0], [20, 20], [0, 20]], 'keepouts': [], 'edge_clearance': 1.0}}


class ScrambleCliTest(unittest.TestCase):
    def test_cli_writes_a_problem_copy_with_scrambled_start_positions(self):
        import json
        import tempfile
        from placer import cli
        d = tempfile.mkdtemp()
        src, out = os.path.join(d, 'p.json'), os.path.join(d, 'q.json')
        json.dump(problem(), open(src, 'w'))
        cli.main(['scramble', src, '-o', out, '--seed', '3', '--sigma', '4'])
        q = json.load(open(out))
        pose = bench.scramble(problem(), seed=3, sigma=4.0)
        self.assertEqual([(u['x'], u['y']) for u in q['units']], [(p[0], p[1]) for p in pose])
        self.assertEqual((q['units'][2]['x'], q['units'][2]['y']), (1, 1))


if __name__ == '__main__':
    unittest.main()


class ParamTest(unittest.TestCase):
    def test_params_are_numbers_or_words(self):
        from placer import cli
        self.assertEqual(cli.parse_params(['t0=5', 'schedule=lam', 'init=spectral']),
                         {'t0': 5.0, 'schedule': 'lam', 'init': 'spectral'})
