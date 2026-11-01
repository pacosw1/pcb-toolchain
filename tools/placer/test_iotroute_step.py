"""Compaction backend iotroute: the step score is measured (DRC + gate), never the router claim."""
import json
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import compact_cli, iotroute_step as s  # noqa: E402

CLEAN = dict(status='PASS', drc_errors=0, unconnected=0, parity=0, track_length_mm=10.0, vias=3)
GATE_OK = {'erc_errors': 0, 'erc_warnings': 311, 'drc_errors': 0, 'drc_parity': 0, 'drc_unconnected': 0,
           'drc_warnings': 31, 'planes_failures': 0, 'pairs_failures': 0, 'paths_low': 0, 'viapads': 0,
           'kicad_happy_findings': 0, 'port_label_failures': 0}


class Score(unittest.TestCase):
    def test_board_id(self):
        self.assertEqual(s.board_id('hardware-design/boards/NET-CORE/cad/NET-CORE'), 'NET-CORE')
        self.assertEqual(s.board_id('/x/hardware-design/boards/H7-CORE'), 'H7-CORE')
        with self.assertRaises(ValueError):
            s.board_id('/tmp/NET-CORE')

    def test_drc_part_counts_without_gate(self):
        self.assertEqual(s.score(dict(CLEAN, status='FAIL', drc_errors=2, unconnected=3, parity=1), None), 6)

    def test_clean_drc_needs_a_complete_gate(self):
        self.assertEqual(s.score(CLEAN, None), s.NO_RESULT)
        self.assertEqual(s.score(CLEAN, GATE_OK), 0)
        self.assertEqual(s.score(CLEAN, dict(GATE_OK, kicad_happy_findings=4, planes_failures=1)), 5)
        self.assertEqual(s.score(CLEAN, dict(GATE_OK, pairs_failures=None)), s.NO_RESULT)
        self.assertEqual(s.score(CLEAN, {}), s.NO_RESULT)

    def test_warnings_and_gate_drc_do_not_count_twice(self):
        self.assertEqual(s.score(CLEAN, dict(GATE_OK, drc_warnings=99, erc_warnings=5, drc_errors=1)), 0)

    def test_router_claim_is_not_a_result(self):
        self.assertEqual(s.score({'status': 'ERROR', 'cause': 'x'}, GATE_OK), s.NO_RESULT)


class Step(unittest.TestCase):
    def run_step(self, rec, metrics):
        gate_calls = []

        class Gate:
            def run(self, routed, evidence, log):
                gate_calls.append(routed)
                return metrics
        with tempfile.TemporaryDirectory() as d:
            calls = []

            def run_stage(cmd, stage, **kw):
                calls.append((cmd, stage))
                return SimpleNamespace(returncode=0 if rec.get('status') == 'PASS' else 1,
                                       stdout='PASS 0 0 0 1 1 1\n' + json.dumps(rec) + '\n')
            out = s.route_step(os.path.join(d, 'b', 'NET-CORE.kicad_pcb'), d, 'NET-CORE', Gate(), 40,
                               ['--max-time', '60'], run_stage)
            summary = json.load(open(os.path.join(d, 'route-0', 'score.json')))
        return out, calls, gate_calls, summary

    def test_clean_step_runs_the_gate_and_passes(self):
        out, calls, gates, summary = self.run_step(CLEAN, GATE_OK)
        cmd, stage = calls[0]
        self.assertEqual(stage, 'routing')
        self.assertTrue(cmd[1].endswith('tools/router/run.py'))
        self.assertEqual(cmd[2], 'NET-CORE')
        self.assertTrue(cmd[3].endswith('route-0/NET-CORE.kicad_pcb'))
        self.assertEqual(cmd[cmd.index('--iters') + 1], '40')
        self.assertIn('--max-time', cmd)
        self.assertEqual((out, len(gates), summary['passed']), ([0], 1, True))

    def test_drc_fail_skips_the_gate(self):
        out, _, gates, summary = self.run_step(dict(CLEAN, status='FAIL', drc_errors=1), GATE_OK)
        self.assertEqual((out, gates, summary['passed']), ([1], [], False))

    def test_gate_findings_fail_the_step(self):
        out, _, _, _ = self.run_step(CLEAN, dict(GATE_OK, kicad_happy_findings=2))
        self.assertEqual(out, [2])


class Cli(unittest.TestCase):
    def test_router_choice_and_default(self):
        base = ['p.json', 'b.kicad_pcb', '--board-dir', 'x', '--outdir', 'o', '--size', '72', '80']
        self.assertEqual(compact_cli.parser().parse_args(base).router, 'fastroute')
        self.assertEqual(compact_cli.parser().parse_args(base + ['--router', 'iotroute']).router, 'iotroute')


if __name__ == '__main__':
    unittest.main()
