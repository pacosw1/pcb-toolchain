import math
import ast
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from types import SimpleNamespace

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

    def test_a_block_counts_its_border_once_not_its_parts_again(self):
        u = unit('B', 5, 5, [[-3, -1, -1, 1, 1.0], [1, -1, 3, 1, 1.0], [-4, -2, 4, 2, 1.0]])
        u['box'] = [1, 3, 9, 7]
        pr = {'units': [u], 'nets': [], 'board': board(20, 20)}
        need = (8 + 1.0) * (4 + 1.0) / compact.HALO['fill']
        self.assertAlmostEqual(compact._raw_scale(pr), math.sqrt(need / 400.0))
        # a rule area rect beyond the border adds its part outside the border
        u['rects'].append([-4, 2, 4, 5, 1.0])
        need += 8 * 3 / compact.HALO['fill']
        self.assertAlmostEqual(compact._raw_scale(pr), math.sqrt(need / 400.0))

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
        self.assertIn('not established', v)
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

    def diagnostic(self, action, kinds=('native_open',), count=1, **kwargs):
        return compact.RouteOutcome([count], dict(status='diagnosed', action=action,
            findings=[dict(classification=kind) for kind in kinds], evidence='step/route-decision.json',
            qualified=False), **kwargs)

    def test_hard_diagnosis_and_local_gap_stop_before_another_broad_search(self):
        for real_first in (True, False):
            for action, kinds in (
                    ('resolve_constraint_coverage', ('constraints_unknown',)),
                    ('inspect_native_geometry', ('native_geometry',)),
                    ('inspect_escape', ('escape_failure',)),
                    ('diagnose_selected_connections', ('native_open',))):
                with self.subTest(real_first=real_first, action=action):
                    calls, search, write, _, clock = self.fakes(0)
                    candidate = dict(path='retained/routed.kicad_pcb', sha256='a'*64, qualified=False)
                    result = self.diagnostic(action, kinds, candidate=candidate)
                    run = compact.run_loop(self.problem(), (10, 10), search, write,
                        lambda *args: result, clock=clock, real_first=real_first, budget=1e6, target=10)
                    self.assertEqual(len(calls['search']), 1)
                    self.assertEqual(len(calls['write']), 1)
                    self.assertIn(action, run['stop'])
                    self.assertEqual(run['retained_candidate'], candidate)
                    self.assertIsNone(run['best']);self.assertFalse(run['qualified'])
                    self.assertFalse(run['steps'][0]['passed'])  # target cannot promote an open candidate

    def test_diagnosis_stops_outline_phase_and_retains_prior_success_separately(self):
        pr = self.problem()
        for item in pr['units']:item['rects'] = [[-2, -2, 2, 2, .5]]
        calls, search, write, _, clock = self.fakes(0)
        routes = [self.diagnostic('continue_native_validation', ('no_routing_defect',), 0),
                  self.diagnostic('diagnose_selected_connections')]
        class OneHalo:
            def __init__(self, s, *args):self.s, self.done = s, False
            def report(self, passed):self.done = True
        with mock.patch.object(compact, 'Schedule', OneHalo):
            run = compact.run_loop(pr, (10, 10), search, write, lambda *args: routes.pop(0),
                                   clock=clock, budget=1e6)
        self.assertEqual([row['phase'] for row in run['steps']], ['halo', 'outline'])
        self.assertIsNotNone(run['best'])
        self.assertEqual(run['steps'][-1]['status'], 'routing-decision')
        self.assertIn('routing diagnosis', run['verdict']);self.assertTrue(run['next_action'])

    def test_attributed_geometry_feedback_allows_a_changed_candidate(self):
        calls, search, write, _, clock = self.fakes(0)
        routes = [self.diagnostic('inspect_escape', ('escape_failure', 'native_open'), geometry_feedback=True),
                  self.diagnostic('continue_native_validation', ('no_routing_defect',), 0)]
        run = compact.run_loop(self.problem(), (10, 10), search, write, lambda *args: routes.pop(0),
                               clock=clock, budget=1e6, real_first=True)
        self.assertEqual(len(calls['write']), 2)
        self.assertNotEqual(calls['write'][0][0], calls['write'][1][0])
        self.assertFalse(run['steps'][0]['passed']);self.assertTrue(run['steps'][1]['passed'])
        self.assertIsNone(run['next_action'])

    def test_feedback_cannot_override_unknown_native_or_evidence_failures(self):
        for status, action, kinds in (
                ('unverified', 'inspect_evidence', ['native_open']),
                ('unchanged_failed_attempt', 'inspect_prior_diagnosis', ['native_open']),
                ('diagnosed', 'inspect_escape', ['native_geometry', 'escape_failure']),
                ('diagnosed', 'continue_native_validation', ['new_unsupported_kind'])):
            result = compact.RouteOutcome([0], dict(status=status, action=action,
                findings=[dict(classification=kind) for kind in kinds]), geometry_feedback=True)
            self.assertTrue(result.stop);self.assertFalse(result.routing_step_clean)

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

    def test_real_first_places_on_the_real_outline_and_stops_at_the_first_step_that_routes(self):
        pr = {'units': [unit('A', 2, 2, [[-1, -1, 1, 1, .5]]), unit('B', 8, 8, [[-1, -1, 1, 1, .5]])],
              'nets': [net('N%d' % k, 0, 1) for k in range(4)], 'board': board()}
        widths = []

        def search(q, n):
            xs = [p[0] for p in q['board']['outline']]
            widths.append(max(xs) - min(xs))
            legal = len(widths) > 1  # the largest halo is not legal, the next one is
            return {'candidates': [{'pose': [[2, 2, 0], [8, 8, 0]], 'cost': 1.0, 'illegal': [] if legal else ['A']}]}
        run = compact.run_loop(pr, (10, 10), search, lambda q, p, k, n: 'b', lambda b, n: [0],
                               s0=4.0, budget=1e9, clock=lambda: 0.0, real_first=True)
        self.assertTrue(all(abs(w - 10.0) < 1e-9 for w in widths))  # the outline never grows
        self.assertEqual([t['phase'] for t in run['steps']], ['real', 'real'])
        self.assertEqual([t['passed'] for t in run['steps']], [False, True])
        self.assertGreater(run['steps'][0]['s'], run['steps'][1]['s'])
        self.assertIn('fits in 10.0 x 10.0 mm', run['verdict'])

    def test_real_first_falls_back_to_the_virtual_phases_when_the_real_outline_fails(self):
        pr = {'units': [unit('A', 2, 2, [[-1, -1, 1, 1, .5]]), unit('B', 8, 8, [[-1, -1, 1, 1, .5]])],
              'nets': [net('N%d' % k, 0, 1) for k in range(4)], 'board': board()}

        def search(q, n):
            return {'candidates': [{'pose': [[2, 2, 0], [8, 8, 0]], 'cost': 1.0, 'illegal': []}]}
        run = compact.run_loop(pr, (10, 10), search, lambda q, p, k, n: 'b', lambda b, n: [5],
                               s0=4.0, budget=1e9, clock=lambda: 0.0, real_first=True)
        self.assertEqual(run['steps'][0]['phase'], 'real')
        self.assertEqual([t['phase'] for t in run['steps'] if t['phase'] != 'real'][0], 'halo')
        self.assertIsNone(run['best'])

    def test_a_search_with_no_result_is_a_failed_step_and_the_loop_goes_on(self):
        # DOOR run 6: the outline-phase search timed out (rc 124) and the run stopped with an exception
        pr = {'units': [unit('A', 2, 2, [[-2, -2, 2, 2, .5]]), unit('B', 8, 8, [[-2, -2, 2, 2, .5]])],
              'nets': [net('N%d' % k, 0, 1) for k in range(4)], 'board': board()}

        def search(q, n):
            xs = [p[0] for p in q['board']['outline']]
            if max(xs) - min(xs) < 12.0:
                return None  # no result: remote timeout
            return {'candidates': [{'pose': [[2, 2, 0], [8, 8, 0]], 'cost': 1.0, 'illegal': []}]}
        run = compact.run_loop(pr, (10, 10), search, lambda q, p, k, n: 'b', lambda b, n: [0],
                               s0=4.0, budget=1e9, clock=lambda: 0.0)
        failed = [t for t in run['steps'] if t['illegal'] == ['no search result']]
        self.assertTrue(failed)
        self.assertTrue(all(not t['passed'] and t['board'] is None for t in failed))
        self.assertGreaterEqual(run['best']['k'], 1.2)

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

    def test_the_outline_phase_never_tries_a_board_smaller_than_the_bare_parts(self):
        # bare parts (s = 0) need 144.5 mm2 on a 100 mm2 board: k below sqrt(1.445) = 1.202 cannot hold them
        pr = {'units': [unit('A', 2, 2, [[-4, -4, 4, 4, .5]]), unit('B', 8, 8, [[-4, -4, 4, 4, .5]])],
              'nets': [net('N%d' % k, 0, 1) for k in range(4)], 'board': board()}
        res = {'candidates': [{'pose': [[2, 2, 0], [8, 8, 0]], 'cost': 1.0, 'illegal': []}]}
        ks = {}

        def write(q, pose, k, n):
            ks[n] = k
            return 'b%d' % n
        run = compact.run_loop(pr, (10, 10), lambda q, n: res, write, lambda b, n: [0] if ks[n] >= 1.25 else [3],
                               s0=4.0, budget=1e9, clock=lambda: 0.0)
        out = [t for t in run['steps'] if t.get('phase') == 'outline']
        halo = [t for t in run['steps'] if t.get('phase') == 'halo']
        best_halo = min((t for t in halo if t['passed']), key=lambda t: (t['k'], t['s']))
        self.assertTrue(out)
        self.assertTrue(all(t['k'] > 1.202 for t in out))
        self.assertTrue(all(0.0 < t['s'] <= best_halo['s'] for t in out))
        self.assertTrue(1.25 <= run['best']['k'] <= 1.25 * 1.03)

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
    def test_routing_timeout_keeps_checkpoint_board_but_cannot_pass(self):
        import subprocess
        pr = {'units': [unit('A', 2, 2, [[0, 0, 1, 1, .5]])], 'nets': [], 'board': board()}
        now = [0.]
        def route(path, n):
            now[0] = 10.
            raise subprocess.TimeoutExpired('router', 1)
        res = {'candidates': [{'pose': [[2, 2, 0]], 'cost': 1., 'illegal': []}]}
        run = compact.run_loop(pr, (10, 10), lambda q, n: res, lambda *args: 'checkpoint', route,
                               real_first=True, budget=2, clock=lambda: now[0])
        self.assertIsNone(run['best'])
        self.assertEqual(run['steps'][0]['board'], 'checkpoint')
        self.assertEqual(run['steps'][0]['status'], 'timeout')
        self.assertFalse(run['steps'][0]['passed'])

    def test_placement_timeout_does_not_route(self):
        import subprocess
        now = [0.]
        def search(q, n):
            now[0] = 10.
            raise subprocess.TimeoutExpired('placement', 1)
        def forbidden(*args):
            self.fail('timeout must not write or route')
        pr = {'units': [unit('A', 2, 2, [[0, 0, 1, 1, .5]])], 'nets': [], 'board': board()}
        run = compact.run_loop(pr, (10, 10), search, forbidden, forbidden,
                               real_first=True, budget=2, clock=lambda: now[0])
        self.assertEqual(run['steps'][0]['status'], 'timeout')
        self.assertIsNone(run['best'])

    def test_zero_virtual_budget_retains_real_attempts_but_stops_diagnostic_work(self):
        pr = {'units': [unit('A', 2, 2, [[0, 0, 1, 1, .5]])], 'nets': [], 'board': board()}
        res = {'candidates': [{'pose': [[2, 2, 0]], 'cost': 1., 'illegal': []}]}
        run = compact.run_loop(pr, (10, 10), lambda q, n: res, lambda *args: 'b', lambda *args: [3],
                               real_first=True, budget=1e6, clock=lambda: 0., diagnostic_budget=0)
        self.assertTrue(run['steps'])
        self.assertTrue(all(s['phase'] == 'real' for s in run['steps']))
        self.assertIn('budget', run['stop'])

    def test_router_output_gives_the_last_unrouted_count_or_a_no_result_value(self):
        from placer import compact_cli
        self.assertEqual(compact_cli.parse_unrouted('FR_RC 0\nUNROUTED 12 SUBSET 3 ERRORS 1\n'), 12)
        self.assertEqual(compact_cli.parse_unrouted('remote: exit 124\n'), compact_cli.NO_RESULT)

    def test_the_schedule_shrink_and_tolerance_come_from_the_command_line(self):
        from placer import compact_cli
        a = compact_cli.parser().parse_args(['p.json', 'b.kicad_pcb', '--board-dir', 'd', '--outdir', 'o', '--size', '70',
                                             '50', '--wheel', 'w.whl', '--tol', '0.2', '--shrink', '0.8'])
        self.assertEqual((a.tol, a.shrink), (0.2, 0.8))
        d = compact_cli.parser().parse_args(['p.json', 'b', '--board-dir', 'd', '--outdir', 'o', '--size', '1', '1',
                                             '--wheel', 'w'])
        self.assertEqual((d.tol, d.shrink), (0.05, 0.85))
        self.assertEqual(d.routes, 3)  # a step passes when the best of 3 runs is at or below the target

    def test_route_job_adds_ground_pad_vias_only_when_asked(self):
        from placer import compact_cli
        self.assertEqual(compact_cli.route_cmd('B', False), ['bash', 'tools/placer/fr_job.sh', 'B'])
        self.assertEqual(compact_cli.route_cmd('B', True), ['env', 'GNDVIAS=1', 'bash', 'tools/placer/fr_job.sh', 'B'])


class DriverDecisionTest(unittest.TestCase):
    def setUp(self):
        from placer import compact_cli
        self.driver = compact_cli
        temporary = tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        self.route = self.folder/'route-0';self.route.mkdir()
        self.candidate = self.route/'routed.kicad_pcb';self.candidate.write_text('synthetic retained copper')
        self.outcome = self.route/'outcome.json'
        self.outcome.write_text(json.dumps(dict(board_sha256=self.driver.lean.digest(self.candidate))))
        self.feedback_source = self.route/'pin-escape.json';self.feedback_source.write_text('synthetic source-bound screen fixture')
        self.decision = dict(status='diagnosed', action='inspect_escape', qualified=False,
            source_board_sha256='b'*64, findings=[dict(classification='escape_failure')],
            evidence=str(self.folder/'route-decision.json'),
            artifacts={name:self.driver.lean.digest(self.route/name) for name in ('outcome.json','pin-escape.json')})
        self.feedback = dict(accepted=True, source_board_sha256='b'*64,
            sources={str(self.feedback_source):self.driver.lean.digest(self.feedback_source)})

    def test_only_source_bound_positive_geometry_update_can_continue(self):
        checked = self.driver.route_handoff([2], self.decision, self.folder,
            feedback=self.feedback, prior_hints={}, hints={'U1':.5})
        self.assertFalse(checked.stop)
        self.assertEqual(checked.candidate['sha256'], self.driver.lean.digest(self.candidate))
        before = self.candidate.read_bytes()
        for feedback, prior, hints in (
                (dict(self.feedback, accepted=False), {}, {'U1':.5}),
                (dict(self.feedback, source_board_sha256='c'*64), {}, {'U1':.5}),
                (dict(self.feedback, sources={}), {}, {'U1':.5}),
                (self.feedback, {'U1':.5}, {'U1':.5})):
            with self.subTest(feedback=feedback, prior=prior):
                checked = self.driver.route_handoff([2], self.decision, self.folder,
                    feedback=feedback, prior_hints=prior, hints=hints)
                self.assertTrue(checked.stop)
                self.assertTrue(checked.decision['next_action']['full_configured_gates_required'])
                self.assertFalse(checked.decision['next_action']['qualified'])
        self.assertEqual(self.candidate.read_bytes(), before)

    def test_changed_retained_copper_or_feedback_stops_instead_of_reusing_it(self):
        self.candidate.write_text('changed after native diagnosis')
        checked = self.driver.route_handoff([2], self.decision, self.folder,
            feedback=self.feedback, prior_hints={}, hints={'U1':.5})
        self.assertTrue(checked.stop);self.assertIsNone(checked.candidate)
        self.assertEqual(checked.decision['action'], 'inspect_evidence')
        self.candidate.unlink()
        checked = self.driver.route_handoff([0], self.decision, self.folder)
        self.assertTrue(checked.stop);self.assertIsNone(checked.candidate)

    def skipped_fixture(self):
        manifest = dict(board_sha256='b'*64, configuration=dict(skip_net='*GND*', plane_nets='',
            gnd_vias=False, route_planes=False))
        outcome = dict(status='complete', board_sha256=self.driver.lean.digest(self.candidate),
                       signal_open=0, ground_open=1, errors=0)
        drc = dict(violations=[], schematic_parity=[], unconnected_items=[dict(items=[
            dict(description='Pad 1 [GND] of J1'), dict(description='Zone [GND] on F.Cu')])])
        decision = dict(self.decision, action='diagnose_selected_connections', findings=[dict(classification='native_open')])
        return manifest, outcome, drc, decision

    def scoped_result(self, manifest, outcome, drc, decision, reported=None):
        for name, value in zip(('input-manifest.json','outcome.json','drc.json'), (manifest,outcome,drc)):
            (self.route/name).write_text(json.dumps(value))
            decision.setdefault('artifacts', {})[name] = self.driver.lean.digest(self.route/name)
        reported = dict(signal_open=0, ground_open=1, errors=0) if reported is None else reported
        return self.driver.route_handoff([0], decision, self.folder, reported_counts=reported)

    def test_explicit_skipped_plane_opens_preserve_signal_step_semantics_only(self):
        for config in (dict(skip_net='*GND*'), dict(skip_net='', gnd_vias=True),
                       dict(skip_net='', plane_nets='GND'), dict(skip_net='*GND*', plane_nets='GND', route_planes=True)):
            with self.subTest(config=config):
                manifest, outcome, drc, decision = self.skipped_fixture()
                manifest['configuration'].update(config)
                result = self.scoped_result(manifest,outcome,drc,decision)
                self.assertFalse(result.stop);self.assertTrue(result.routing_step_clean)
                scope = result.decision['routing_step_scope']
                self.assertEqual(scope['excluded_native_opens'],1);self.assertEqual(scope['nets'],['GND'])
                self.assertFalse(scope['native_verified']);self.assertFalse(scope['qualified'])
                self.assertTrue(scope['full_configured_gates_required'])
                self.assertEqual(json.loads((self.route/'drc.json').read_text()),drc)

    def test_unconfigured_mixed_unnamed_or_inconsistent_skipped_opens_do_not_pass(self):
        cases = (
            lambda m,o,d,c:m['configuration'].update(skip_net=''),
            lambda m,o,d,c:m['configuration'].update(route_planes='false'),
            lambda m,o,d,c:o.update(ground_open=2),
            lambda m,o,d,c:o.update(signal_open=1),
            lambda m,o,d,c:o.update(status='stuck'),
            lambda m,o,d,c:d['unconnected_items'][0]['items'][1].update(description='Pad 1 [VCC] of U1'),
            lambda m,o,d,c:d['unconnected_items'][0]['items'][1].update(description='Unnamed zone'),
            lambda m,o,d,c:d['unconnected_items'][0]['items'][1].update(description='Zone [[GND]]'),
            lambda m,o,d,c:d['violations'].append(dict(severity='error',type='clearance')),
            lambda m,o,d,c:d['schematic_parity'].append(dict(type='pad_net_conflict')),
            lambda m,o,d,c:c['findings'].append(dict(classification='constraints_unknown')),
            lambda m,o,d,c:c['findings'].append(dict(classification='escape_failure')))
        for index, change in enumerate(cases):
            with self.subTest(case=index):
                manifest, outcome, drc, decision = self.skipped_fixture();change(manifest,outcome,drc,decision)
                result = self.scoped_result(manifest,outcome,drc,decision)
                self.assertTrue(result.stop);self.assertFalse(result.routing_step_clean)
                self.assertNotIn('routing_step_scope',result.decision)
        manifest,outcome,drc,decision = self.skipped_fixture()
        result = self.scoped_result(manifest,outcome,drc,decision,reported=dict(signal_open=0,ground_open=2,errors=0))
        self.assertTrue(result.stop)
        decision['artifacts'].pop('input-manifest.json')
        result = self.driver.route_handoff([0],decision,self.folder,reported_counts=dict(signal_open=0,ground_open=1,errors=0))
        self.assertTrue(result.stop)

    def test_production_callback_continues_changed_geometry_but_not_identical_failure(self):
        # CPU transport fixture only; no router/native correctness is claimed.
        source = Path(self.driver.__file__)
        main = next(node for node in ast.parse(source.read_text()).body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        function = next(node for node in main.body if isinstance(node, ast.FunctionDef) and node.name == 'route')
        native = self.folder/'source.kicad_pcb';native.write_text('synthetic placement bytes A')
        def sdir(n):
            folder = self.folder/('step-'+str(n));folder.mkdir();return str(folder)
        def execute(command, *args, **kwargs):
            route = Path(command[3]);route.mkdir()
            routed = route/'routed.kicad_pcb';routed.write_bytes(Path(command[2]).read_bytes()+b' retained router copper')
            for name, value in {
                    'input-manifest.json':dict(board_sha256=self.driver.lean.digest(native)),
                    'outcome.json':dict(status='complete', errors=0, board_sha256=self.driver.lean.digest(routed)),
                    'drc.json':dict(violations=[], schematic_parity=[], unconnected_items=[dict(items=[])]),
                    'pin-escape.json':dict(boxed_in=[dict(ref='U1', pad='U1.1', net='A')], halo_hint={'U1':.5})}.items():
                (route/name).write_text(json.dumps(value))
            return SimpleNamespace(returncode=3, stdout='UNROUTED 1 GND_OPEN 0 ERRORS 0\n')
        run = mock.Mock(side_effect=execute)
        namespace = dict(vars(self.driver), sdir=sdir,
            a=SimpleNamespace(max_routes=0, router='fastroute', passes=1, optimizer='off', gnd_vias=False,
                route_args='', feedback_max_mm=1, congestion_feedback=False), routes_done=[0], routing_attempts={},
            run_stage=run, name='source', seed_receipt=None, escape_hint={},
            pr=dict(units=[dict(name='U1', refs=['U1'], fixed=False)]))
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)
        first = namespace['route'](str(native), 0)
        self.assertFalse(first.stop);self.assertEqual(first.decision['geometry_feedback']['changed_refs'], ['U1'])
        before = Path(first.candidate['path']).read_bytes()
        unchanged = namespace['route'](str(native), 1)
        self.assertTrue(unchanged.stop);self.assertEqual(run.call_count, 1)
        self.assertEqual(unchanged.candidate, first.candidate)
        native.write_text('synthetic placement bytes B')
        changed = namespace['route'](str(native), 2)
        self.assertFalse(changed.stop);self.assertEqual(run.call_count, 2)
        self.assertNotEqual(changed.candidate['sha256'], first.candidate['sha256'])
        self.assertEqual(Path(first.candidate['path']).read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
