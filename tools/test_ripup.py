#!/usr/bin/env python3
"""Unit tests for the pure core of tools/ripup.py (no pcbnew, no kicad-cli).

  python3 -m unittest test_ripup
"""
import collections
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('ripup', os.path.join(HERE, 'ripup.py'))
ru = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ru)

NO_PATH = ('pair 1 of 1: U1.24 -> R3.1; class Default w 0.2 clr 0.2 via 0.6/0.3; cell 0.1 box 0,0..9,9\n'
           'no path: closest reach (118.950, 122.225) is 5.31 mm from U1.24; blocked there by track /ETH_SCLK_MCU, '
           'via GND, pad U1.3 /X, track /BUZ_GATE. Try a larger --box, --layers F.Cu,B.Cu or a lower --via-cost.\n')
FOUND = ('pair 1 of 2: U1.24 -> R3.1; class Default\n'
         '1) len 12.50 vias 2 bends 3 margin +0.020 pour 1.5\n'
         '/ETH_RESET U1.24 -> R3.1 layer=F.Cu via 1,2 through 3,4\n'
         '2) len 14.00 vias 0 bends 1 margin +0.050 pour 0.0\n'
         '/ETH_RESET U1.24 -> R3.1 layer=B.Cu\n')


class BlockerTest(unittest.TestCase):
    def test_rank_by_length_inside_the_band(self):
        corridor = [(0, 0), (10, 0)]            # band: |y| <= 1 along x 0..10
        items = [('/A', (5, -5), (5, 5), 0.1),   # crosses: 2 mm inside
                 ('/B', (2, 0), (8, 0), 0.1),    # along: 6 mm inside
                 ('/C', (0, 5), (10, 5), 0.1),   # far away
                 ('/T', (1, 0), (9, 0), 0.1),    # own net
                 ('GND', (3, 0), (3, 0), 0.3)]   # via of a skipped net
        got = ru.rank_blockers(items, corridor, 1.0, skip={'/T', 'GND'})
        self.assertEqual([n for n, _ in got], ['/B', '/A'])
        self.assertAlmostEqual(got[0][1], 6.0, delta=0.2)
        self.assertAlmostEqual(got[1][1], 2.0, delta=0.3)

    def test_via_counts_its_diameter(self):
        got = ru.rank_blockers([('/V', (5, 0), (5, 0), 0.3)], [(0, 0), (10, 0)], 1.0, skip=set())
        self.assertEqual(got, [('/V', 0.6)])


class SuggestParseTest(unittest.TestCase):
    def test_no_path_gives_reach_and_track_or_via_nets(self):
        r = ru.parse_suggest(NO_PATH, 1)
        self.assertEqual(r['lines'], [])
        self.assertEqual(r['reach'], (118.95, 122.225))
        self.assertEqual(r['pads'], ('U1.24', 'R3.1'))
        self.assertEqual(r['blocked_by'], ['/ETH_SCLK_MCU', 'GND', '/BUZ_GATE'])
        self.assertFalse(r['done'])

    def test_found_lines_with_cost_terms(self):
        r = ru.parse_suggest(FOUND, 0)
        self.assertEqual(r['lines'], [(12.5, 2, 1.5, '/ETH_RESET U1.24 -> R3.1 layer=F.Cu via 1,2 through 3,4'),
                                      (14.0, 0, 0.0, '/ETH_RESET U1.24 -> R3.1 layer=B.Cu')])
        self.assertFalse(r['done'])

    def test_done_when_no_pair_is_open(self):
        self.assertTrue(ru.parse_suggest('/ETH_RESET: unconnected: none\n', 0)['done'])

    def test_unknown_output_is_an_error(self):
        with self.assertRaises(RuntimeError):
            ru.parse_suggest('Traceback: boom\n', 1)


class GateParseTest(unittest.TestCase):
    def test_findings_are_normalized_fail_lines(self):
        out = 'INFO x\nFAIL via in pad U4.2 GND via at (122.150, 107.050)\n1 vias in SMD pads\n'
        self.assertEqual(ru.gate_findings('viapads', out, 1), collections.Counter({'FAIL via in pad U4.2 GND via at (#, #)': 1}))

    def test_low_lines_count_for_paths(self):
        out = 'LOW VBUS J1.B4->D2.2: 0.60 A < 0.86 A\n1 power-path pairs below the design current\n'
        self.assertEqual(sum(ru.gate_findings('paths', out, 1).values()), 1)

    def test_missing_summary_is_a_crash(self):
        with self.assertRaises(RuntimeError):
            ru.gate_findings('si_planes', 'ERROR no board\n', 2)

    def test_error_exit_is_a_crash_even_with_summary(self):
        with self.assertRaises(RuntimeError):
            ru.gate_findings('kicad_happy', 'STALE exempt x\n0 kicad-happy findings (rules X)\n', 2)


def drc(errors=(), unconnected=(), parity=0):
    return {'violations': [{'type': t, 'severity': 'error', 'items': []} for t in errors],
            'unconnected_items': [{'items': [{'description': f'Track [{n}] on F.Cu'}]} for n in unconnected],
            'schematic_parity': [{}] * parity}


class JudgeTest(unittest.TestCase):
    def setUp(self):
        self.base = ru.state_result(drc(['clearance'], ['/T', '/Q']), {'viapads': collections.Counter({'FAIL a': 1})})

    def test_clean_state_passes_with_deltas(self):
        cand = ru.state_result(drc(['clearance'], ['/Q']), {'viapads': collections.Counter({'FAIL a': 1})})
        ok, why, delta = ru.judge(self.base, cand, ['/T', '/R'])
        self.assertTrue(ok, why)
        self.assertEqual(delta['unconnected'], -1)

    def test_new_error_type_count_rejects(self):
        cand = ru.state_result(drc(['clearance', 'clearance'], []), {'viapads': collections.Counter({'FAIL a': 1})})
        self.assertFalse(ru.judge(self.base, cand, ['/T'])[0])

    def test_ripped_net_left_open_rejects(self):
        cand = ru.state_result(drc(['clearance'], ['/Q', '/R']), {'viapads': collections.Counter({'FAIL a': 1})})
        ok, why, _ = ru.judge(self.base, cand, ['/T', '/R'])
        self.assertFalse(ok)
        self.assertIn('/R', why)

    def test_other_net_more_unconnected_rejects(self):
        cand = ru.state_result(drc(['clearance'], ['/Q', '/Q']), {'viapads': collections.Counter({'FAIL a': 1})})
        self.assertFalse(ru.judge(self.base, cand, ['/T'])[0])

    def test_parity_rejects(self):
        cand = ru.state_result(drc(['clearance'], [], parity=1), {'viapads': collections.Counter({'FAIL a': 1})})
        self.assertFalse(ru.judge(self.base, cand, ['/T'])[0])

    def test_new_gate_finding_rejects(self):
        cand = ru.state_result(drc(['clearance'], []), {'viapads': collections.Counter({'FAIL a': 1, 'FAIL b': 1})})
        ok, why, _ = ru.judge(self.base, cand, ['/T'])
        self.assertFalse(ok)
        self.assertIn('viapads', why)

    def test_missing_gate_rejects(self):
        cand = ru.state_result(drc(['clearance'], []), {})
        self.assertFalse(ru.judge(self.base, cand, ['/T'])[0])


class CostTest(unittest.TestCase):
    def test_length_plus_via_plus_pour(self):
        self.assertEqual(ru.route_cost([(10.0, 2, 1.5), (3.0, 0, 0.0)]), 10 + 4 + 1.5 + 3)


class BeamTest(unittest.TestCase):
    def run_search(self, table, blockers, width=2, depth=2):
        seen = []

        def evaluate(rips):
            seen.append(rips)
            return table.get(frozenset(rips), {'status': 'reject', 'why': 'gate'})
        best, log = ru.beam_search(blockers, evaluate, width, depth, pmap=map)
        return best, seen, log

    def test_one_rip_is_enough(self):
        table = {frozenset({'/A'}): {'status': 'ok', 'cost': 20.0},
                 frozenset({'/B'}): {'status': 'ok', 'cost': 10.0}}
        best, seen, _ = self.run_search(table, ['/A', '/B', '/C'])
        self.assertEqual(best[0], ('/B',))
        self.assertEqual(len(seen), 2)          # width 2; no depth 2 when depth 1 has a clean state

    def test_second_rip_from_the_open_state_blockers(self):
        table = {frozenset({'/A'}): {'status': 'open', 'open': 1, 'blocked_by': ['/X']},
                 frozenset({'/B'}): {'status': 'open', 'open': 2, 'blocked_by': []},
                 frozenset({'/A', '/X'}): {'status': 'ok', 'cost': 30.0}}
        best, seen, _ = self.run_search(table, ['/A', '/B'])
        self.assertEqual(best[0], ('/A', '/X'))
        self.assertEqual(seen[2], ('/A', '/X'))  # the state blockers come before the target blockers

    def test_no_duplicate_states_and_width_limit(self):
        table = {frozenset({'/A'}): {'status': 'open', 'open': 1, 'blocked_by': ['/B']},
                 frozenset({'/B'}): {'status': 'open', 'open': 1, 'blocked_by': ['/A']}}
        best, seen, log = self.run_search(table, ['/A', '/B', '/C'], width=2)
        self.assertIsNone(best)
        self.assertEqual(len({frozenset(s) for s in seen}), len(seen))
        self.assertLessEqual(len(seen), 2 + 2 * 2)

    def test_rejected_state_is_not_expanded(self):
        table = {frozenset({'/A'}): {'status': 'reject', 'why': 'DRC'}}
        best, seen, _ = self.run_search(table, ['/A'], width=1)
        self.assertIsNone(best)
        self.assertEqual(seen, [('/A',)])


class RouteNetTest(unittest.TestCase):
    """route_net with a fake runner: suggest gives two lines, then 'unconnected: none' after one connect."""
    def run_route(self, stitch_ok):
        import tempfile
        calls = []
        state = {'routed': False}

        def sh(cmd):
            calls.append(cmd[2:4] + cmd[4:5])
            if cmd[2] == 'suggest':
                if state['routed']:
                    return 0, '/N: unconnected: none\n'
                return 0, ('pair 1 of 1: A.1 -> B.1; x\n1) len 30.00 vias 6 bends 0 margin +0.1 pour 0.0\nN A.1 -> B.1 six\n'
                           '2) len 10.00 vias 2 bends 0 margin +0.1 pour 0.0\nN A.1 -> B.1 two\n'
                           '3) len 12.00 vias 0 bends 0 margin +0.1 pour 0.0\nN A.1 -> B.1 zero\n')
            if cmd[2] == 'connect':
                with open(cmd[3], 'a') as f:
                    f.write(cmd[4])
                return 0, 'added'
            if cmd[2] == 'stitch':
                ok = stitch_ok(open(cmd[3]).read())
                state['routed'] = ok
                return (0, 'added') if ok else (1, 'no room')
        with tempfile.TemporaryDirectory() as d:
            board = os.path.join(d, 'B.kicad_pcb')
            open(board, 'w').write('base|')
            done, fail = ru.route_net(board, 'N', None, max_vias=4, sh=sh)
            text = open(board).read()
        return done, fail, calls, text

    def test_too_many_vias_is_skipped_and_stitch_follows_connect(self):
        done, fail, calls, text = self.run_route(lambda t: True)
        self.assertIsNone(fail)
        self.assertEqual([r[3] for r in done], ['N A.1 -> B.1 two'])
        self.assertEqual(text, 'base|N A.1 -> B.1 two')
        self.assertEqual([c[0] for c in calls], ['suggest', 'connect', 'stitch', 'suggest'])

    def test_no_stitch_room_restores_the_board_and_tries_the_next_line(self):
        done, fail, calls, text = self.run_route(lambda t: t.endswith('zero'))
        self.assertIsNone(fail)
        self.assertEqual([r[3] for r in done], ['N A.1 -> B.1 zero'])
        self.assertEqual(text, 'base|N A.1 -> B.1 zero')

    def test_no_stitchable_line_is_a_failure(self):
        done, fail, calls, text = self.run_route(lambda t: False)
        self.assertEqual(done, [])
        self.assertIn('stitch', fail['why'])
        self.assertEqual(text, 'base|')


if __name__ == '__main__':
    unittest.main()
