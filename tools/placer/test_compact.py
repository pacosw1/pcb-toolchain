import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from placer import compact  # noqa: E402


def unit(name, x, y, rects, fixed=False):
    return {'name': name, 'refs': [name], 'fixed': fixed, 'x': x, 'y': y, 'rects': rects}


def board(w=10.0, h=10.0):
    return {'outline': [[0, 0], [w, 0], [w, h], [0, h]], 'keepouts': [], 'edge_clearance': 0.0}


def net(name, *units):
    return {'name': name, 'weight': 1.0, 'pins': [[u, 0, 0, 0, 0] for u in units]}


class HaloTest(unittest.TestCase):
    def test_halo_is_scale_times_pitch_times_sqrt_of_the_nets_that_leave_the_unit(self):
        self.assertAlmostEqual(compact.halo(4, 1.0), compact.HALO['pitch'] * 2.0)
        self.assertAlmostEqual(compact.halo(9, 2.0), 2.0 * compact.HALO['pitch'] * 3.0)
        self.assertAlmostEqual(compact.halo(0, 5.0), 0.0)

    def test_fanout_counts_nets_to_other_units(self):
        pr = {'units': [unit('A', 1, 1, [[0, 0, 1, 1, .5]]), unit('B', 5, 5, [[0, 0, 1, 1, .5]]),
                        unit('C', 8, 8, [[0, 0, 1, 1, .5]])],
              'nets': [net('N1', 0, 1), net('N2', 0, 2), net('N3', 1, 2), net('N4', 0)],
              'board': board()}
        self.assertEqual(compact.fanout(pr), [2, 2, 2])

    def test_with_halos_makes_the_halo_the_spacing_but_never_less_than_d040(self):
        pr = {'units': [unit('A', 1, 1, [[0, 0, 1, 1, .5]]), unit('B', 5, 5, [[0, 0, 1, 1, 1.0]])],
              'nets': [net('N%d' % k, 0, 1) for k in range(4)], 'board': board()}
        q = compact.with_halos(pr, 0.1)
        h = compact.halo(4, 0.1)
        self.assertAlmostEqual(q['units'][0]['rects'][0][4], max(.5, h))
        self.assertAlmostEqual(q['units'][1]['rects'][0][4], 1.0)  # D-040 1.0 mm is larger
        q = compact.with_halos(pr, 5.0)
        self.assertAlmostEqual(q['units'][1]['rects'][0][4], compact.halo(4, 5.0))
        self.assertEqual(pr['units'][0]['rects'][0][4], .5)  # input unchanged


class VirtualBoardTest(unittest.TestCase):
    def test_scale_is_one_when_the_units_fit_and_grows_with_the_needed_area(self):
        pr = {'units': [unit('A', 5, 5, [[-.5, -.5, .5, .5, .5]])], 'nets': [], 'board': board()}
        self.assertEqual(compact.board_scale(pr), 1.0)
        big = {'units': [unit('A', 5, 5, [[-5, -5, 5, 5, 2.0]])], 'nets': [], 'board': board()}
        need = (10 + 2.0) ** 2 / compact.HALO['fill']
        self.assertAlmostEqual(compact.board_scale(big), math.sqrt(need / 100.0))

    def test_virtual_board_scales_outline_and_move_box_about_the_centre(self):
        pr = {'units': [], 'nets': [], 'board': board(10, 4), 'move_box': [2, 1, 4, 3]}
        q = compact.virtual(pr, 2.0)
        self.assertEqual(q['board']['outline'], [[-5.0, -2.0], [15.0, -2.0], [15.0, 6.0], [-5.0, 6.0]])
        self.assertEqual(q['move_box'], [-1.0, 0.0, 3.0, 4.0])
        self.assertIs(compact.virtual(pr, 1.0), pr)


class ScheduleTest(unittest.TestCase):
    def test_shrinks_on_pass_and_bisects_after_the_first_fail(self):
        sch = compact.Schedule(s0=4.0, shrink=0.85, tol=0.05)
        self.assertEqual(sch.s, 4.0)
        sch.report(True)
        self.assertAlmostEqual(sch.s, 3.4)
        sch.report(True)
        self.assertAlmostEqual(sch.s, 2.89)
        sch.report(False)  # fail at 2.89: bisect between 3.4 and 2.89
        self.assertAlmostEqual(sch.s, (3.4 + 2.89) / 2)
        sch.report(True)
        self.assertAlmostEqual(sch.s, (3.145 + 2.89) / 2)
        self.assertFalse(sch.done)
        sch.report(True)  # gap now below 5 % of the pass value
        self.assertTrue(sch.done)
        self.assertAlmostEqual(sch.best, (3.145 + 2.89) / 2)

    def test_a_fail_at_the_first_scale_stops_with_no_pass(self):
        sch = compact.Schedule(s0=4.0)
        sch.report(False)
        self.assertTrue(sch.done)
        self.assertIsNone(sch.best)

    def test_stops_at_the_minimum_scale(self):
        sch = compact.Schedule(s0=0.1, shrink=0.5, s_min=0.06)
        sch.report(True)
        self.assertTrue(sch.done)
        self.assertEqual(sch.best, 0.1)


class VerdictTest(unittest.TestCase):
    def test_verdicts(self):
        size = (170.5, 86.5)
        v = compact.verdict([], size)
        self.assertIn('no step', v)
        v = compact.verdict([{'s': 4.0, 'k': 1.3, 'unrouted': 12, 'passed': False}], size)
        self.assertIn('pin order', v)
        v = compact.verdict([{'s': 4.0, 'k': 1.3, 'unrouted': -1, 'passed': False}], size)
        self.assertIn('no legal placement', v)
        v = compact.verdict([{'s': 4.0, 'k': 1.3, 'unrouted': 0, 'passed': True},
                             {'s': 3.0, 'k': 1.0, 'unrouted': 0, 'passed': True}], size)
        self.assertIn('fits in 170.5 x 86.5 mm', v)
        self.assertIn('s = 3.00', v)
        v = compact.verdict([{'s': 4.0, 'k': 1.2, 'unrouted': 0, 'passed': True},
                             {'s': 3.0, 'k': 1.1, 'unrouted': 0, 'passed': True},
                             {'s': 2.5, 'k': 1.0, 'unrouted': 5, 'passed': False}], size)
        self.assertIn('needs %.1f x %.1f mm' % (170.5 * 1.1, 86.5 * 1.1), v)


class LoopTest(unittest.TestCase):
    def problem(self):
        return {'units': [unit('A', 2, 2, [[-.5, -.5, .5, .5, .5]]), unit('B', 8, 8, [[-.5, -.5, .5, .5, .5]])],
                'nets': [net('N%d' % k, 0, 1) for k in range(4)], 'board': board()}

    def fakes(self, routes_below, t_step=60.0):
        calls = {'search': [], 'write': [], 'route': []}
        now = [0.0]

        def search(q, step):
            calls['search'].append((step, q['units'][0]['rects'][0][4]))
            now[0] += t_step
            return {'candidates': [{'pose': [[2, 2, 0], [8, 8, 0]], 'cost': 1.0, 'illegal': []}],
                    'history': [{'epoch': 1, 'cost': 1.0, 'pose': [[2, 2, 0], [8, 8, 0]], 'components': {}}]}

        def write(q, pose, k, step):
            calls['write'].append((step, k))
            return 'board-%d' % step

        def route(path, step):
            s = calls['search'][step][1]  # the spacing the step used stands for s
            calls['route'].append(path)
            return [0, 3] if s >= routes_below else [4, 5]
        return calls, search, write, route, (lambda: now[0])

    def test_loop_shrinks_until_it_fails_then_bisects_and_reports(self):
        calls, search, write, route, clock = self.fakes(routes_below=compact.halo(4, 2.0))
        run = compact.run_loop(self.problem(), (10, 10), search, write, route, s0=4.0, budget=1e9, clock=clock)
        ss = [round(t['s'], 6) for t in run['steps']]
        self.assertEqual(ss[:3], [4.0, 3.4, 2.89])
        self.assertTrue(all(t['passed'] == (t['s'] >= 2.0 - 1e-9) for t in run['steps']))
        self.assertTrue(run['steps'][0]['passed'])
        self.assertEqual(run['steps'][0]['unrouted'], 0)  # best of the router runs
        self.assertEqual(run['steps'][0]['runs'], [0, 3])
        self.assertIn('history', run['steps'][0])
        self.assertLess(run['best']['s'], 2.2)
        self.assertIn('verdict', run)

    def test_an_illegal_search_retries_the_same_scale_on_a_larger_virtual_board(self):
        seen = []

        def search(q, n):
            xs = [p[0] for p in q['board']['outline']]
            seen.append(max(xs) - min(xs))
            ok = seen[-1] > 10 * 1.3
            return {'candidates': [{'pose': [[2, 2, 0], [8, 8, 0]], 'cost': 1.0, 'illegal': [] if ok else ['A']}]}
        run = compact.run_loop(self.problem(), (10, 10), search, lambda q, p, k, n: 'b', lambda b, n: [0],
                               s0=0.1, budget=1e9, clock=lambda: 0.0, s_min=0.09)
        self.assertEqual([round(w, 3) for w in seen[:3]], [10.0, 11.5, 13.225])  # halo phase
        t = run['steps'][0]
        self.assertTrue(t['passed'])
        self.assertAlmostEqual(t['k'], 1.3225)
        self.assertEqual(t['tries'], 3)

    def test_after_the_halo_phase_the_outline_phase_tries_the_real_board_then_bisects_the_board_scale(self):
        pr = {'units': [unit('A', 2, 2, [[-2, -2, 2, 2, .5]]), unit('B', 8, 8, [[-2, -2, 2, 2, .5]])],
              'nets': [net('N%d' % k, 0, 1) for k in range(4)], 'board': board()}
        seen = []

        def search(q, n):
            seen.append(q)
            return {'candidates': [{'pose': [[2, 2, 0], [8, 8, 0]], 'cost': 1.0, 'illegal': []}]}
        ks = {}

        def write(q, pose, k, n):
            ks[n] = k
            return 'b%d' % n
        run = compact.run_loop(pr, (10, 10), search, write, lambda b, n: [0] if ks[n] >= 1.2 else [3],
                               s0=4.0, budget=1e9, clock=lambda: 0.0)
        out = [t for t in run['steps'] if t.get('phase') == 'outline']
        self.assertTrue(out)
        self.assertEqual(out[0]['k'], 1.0)  # the real outline first
        self.assertFalse(out[0]['passed'])
        # the halo scale on the real board is the largest that fits it
        q = seen[len(run['steps']) - len(out)]
        self.assertLessEqual(compact.board_scale(q), 1.0 + 1e-6)
        self.assertTrue(1.2 <= run['best']['k'] <= 1.2 * 1.03)
        self.assertIn('needs', run['verdict'])

    def test_outline_phase_reports_a_fit_when_the_real_board_routes(self):
        pr = {'units': [unit('A', 2, 2, [[-2, -2, 2, 2, .5]]), unit('B', 8, 8, [[-2, -2, 2, 2, .5]])],
              'nets': [net('N%d' % k, 0, 1) for k in range(4)], 'board': board()}
        res = {'candidates': [{'pose': [[2, 2, 0], [8, 8, 0]], 'cost': 1.0, 'illegal': []}]}
        ks = {}

        def write(q, pose, k, n):
            ks[n] = k
            return 'b%d' % n
        # the halo phase fails below s 3.0 (k about 1.3); the real board still routes with small halos
        run = compact.run_loop(pr, (10, 10), lambda q, n: res, write,
                               lambda b, n: [0] if ks[n] >= 1.3 or ks[n] == 1.0 else [2],
                               s0=4.0, budget=1e9, clock=lambda: 0.0)
        self.assertEqual(run['best']['k'], 1.0)
        self.assertIn('fits in 10.0 x 10.0 mm', run['verdict'])

    def test_loop_stops_at_the_time_budget(self):
        calls, search, write, route, clock = self.fakes(routes_below=0.0, t_step=100.0)
        run = compact.run_loop(self.problem(), (10, 10), search, write, route, s0=4.0, budget=250.0, clock=clock)
        self.assertEqual(len(run['steps']), 3)  # starts at 0, 100, 200; not at 300
        self.assertIn('budget', run['stop'])


class ParseTest(unittest.TestCase):
    def test_router_output_gives_the_last_unrouted_count_or_a_no_result_value(self):
        from placer import compact_cli
        self.assertEqual(compact_cli.parse_unrouted('FR_RC 0\nUNROUTED 12 SUBSET 3 ERRORS 1\n'), 12)
        self.assertEqual(compact_cli.parse_unrouted('remote: exit 124\n'), compact_cli.NO_RESULT)


if __name__ == '__main__':
    unittest.main()
