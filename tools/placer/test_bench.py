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


class SpearmanTest(unittest.TestCase):
    def test_rank_correlation(self):
        self.assertAlmostEqual(bench.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1.0)
        self.assertAlmostEqual(bench.spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1.0)
        self.assertAlmostEqual(bench.spearman([1, 2, 3], [1, 3, 2]), 0.5)
        # ties get the average rank
        self.assertAlmostEqual(bench.spearman([1, 1, 2], [1, 2, 3]), 0.8660254, places=6)


class ScrambleTest(unittest.TestCase):
    def test_uniform_scramble_keeps_fixed_units_and_stays_in_the_board(self):
        pr = problem()
        a, b = bench.scramble(pr, seed=4), bench.scramble(pr, seed=4)
        self.assertEqual(a, b)
        self.assertNotEqual(a, bench.scramble(pr, seed=5))
        self.assertEqual(a[2], (1, 1, 0))
        for x, y, r in a[:2]:
            self.assertTrue(1.5 <= x <= 18.5 and 1.5 <= y <= 18.5 and r in (0, 1, 2, 3))

    def test_sigma_scramble_moves_units_about_sigma_and_clips_to_the_board(self):
        pr = problem()
        p = bench.scramble(pr, seed=1, sigma=0.01)
        self.assertLess(abs(p[0][0] - 5) + abs(p[0][1] - 5), 0.2)
        p = bench.scramble(pr, seed=1, sigma=100.0)
        for x, y, r in p[:2]:
            self.assertTrue(1.5 <= x <= 18.5 and 1.5 <= y <= 18.5)


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


class TableTest(unittest.TestCase):
    def test_median_per_row_and_rank_correlation_of_proxy_vs_median(self):
        rows = [('a', 10.0, [5, 1, 3]), ('b', 20.0, [9, 7, 8]), ('c', 30.0, [20, 30, 10])]
        text, rho = bench.table(rows)
        self.assertAlmostEqual(rho, 1.0)
        self.assertIn('| a | 10.0 | 1 / 3 / 5 |', text)

    def test_a_row_without_router_results_is_left_out_of_the_correlation(self):
        rows = [('a', 10.0, [1]), ('b', 20.0, [2]), ('x', 5.0, []), ('c', 30.0, [3])]
        text, rho = bench.table(rows)
        self.assertAlmostEqual(rho, 1.0)
        self.assertIn('| x | 5.0 | no result |', text)


class PortfolioPickTest(unittest.TestCase):
    """Seed portfolio: K searches with other seeds, one route of each best pose; the fewest unrouted wins,
    a tie goes to the lower search cost, a pose without a route result never wins."""

    def test_the_fewest_unrouted_wins(self):
        runs = [{'name': 's23', 'unrouted': 9, 'cost': 1.0}, {'name': 's37', 'unrouted': 5, 'cost': 9.0},
                {'name': 's51', 'unrouted': 30, 'cost': 0.5}]
        self.assertEqual(bench.portfolio_pick(runs)['name'], 's37')

    def test_a_tie_goes_to_the_lower_cost(self):
        runs = [{'name': 'a', 'unrouted': 5, 'cost': 1005.6}, {'name': 'b', 'unrouted': 5, 'cost': 1001.0}]
        self.assertEqual(bench.portfolio_pick(runs)['name'], 'b')

    def test_a_pose_without_a_route_result_never_wins(self):
        runs = [{'name': 'a', 'unrouted': None, 'cost': 0.1}, {'name': 'b', 'unrouted': 80, 'cost': 5.0}]
        self.assertEqual(bench.portfolio_pick(runs)['name'], 'b')
        self.assertIsNone(bench.portfolio_pick([{'name': 'a', 'unrouted': None, 'cost': 0.1}]))

    def test_pick_command_reads_the_search_cost_and_the_last_unrouted_line(self):
        import json
        import tempfile
        d = tempfile.mkdtemp()
        args = []
        for name, cost, log in (('s1', 3.0, 'FR_RC 0\nUNROUTED 7 SUBSET 7 ERRORS 0\n'),
                                ('s2', 2.0, 'UNROUTED 9 SUBSET 9 ERRORS 0\nUNROUTED 7 SUBSET 7 ERRORS 1\n'),
                                ('s3', 1.0, 'remote: job x exit 124\n')):
            res, rl = os.path.join(d, name + '.json'), os.path.join(d, name + '.log')
            json.dump({'candidates': [{'cost': cost, 'pose': []}]}, open(res, 'w'))
            open(rl, 'w').write(log)
            args.append('%s:%s:%s' % (name, res, rl))
        self.assertEqual(bench.main(['pick'] + args), 's2')


class ScatterTest(unittest.TestCase):
    def test_scatter_moves_the_start_of_movable_units_into_the_board_on_a_copy(self):
        pr = problem()
        pr['units'][0]['x'] = 500.0  # staged outside the board
        q = bench.scatter(pr, 1)
        self.assertEqual(pr['units'][0]['x'], 500.0)
        self.assertEqual((q['units'][2]['x'], q['units'][2]['y']), (1, 1))
        for u in q['units'][:2]:
            self.assertTrue(1.5 <= u['x'] <= 18.5 and 1.5 <= u['y'] <= 18.5)


if __name__ == '__main__':
    unittest.main()


class ParamTest(unittest.TestCase):
    def test_params_are_numbers_or_words(self):
        from placer import cli
        self.assertEqual(cli.parse_params(['t0=5', 'schedule=lam', 'init=spectral']),
                         {'t0': 5.0, 'schedule': 'lam', 'init': 'spectral'})
