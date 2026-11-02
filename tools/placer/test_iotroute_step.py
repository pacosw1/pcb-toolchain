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


class Measure(unittest.TestCase):
    def test_measure_reads_the_saved_board_counts_of_run_py(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, 'route-0'))
            rec = dict(CLEAN, track_length_mm=1580.26, vias=296, board_file='/x/route-0/B.kicad_pcb')
            json.dump(dict(run=rec), open(os.path.join(d, 'route-0', 'score.json'), 'w'))
            m = s.measure(d)
            self.assertEqual((m['length_mm'], m['vias'], m['routed']), (1580.3, 296, '/x/route-0/B.kicad_pcb'))
            self.assertIn('copper_counts', m['source'])
            json.dump(dict(run={'status': 'ERROR'}), open(os.path.join(d, 'route-0', 'score.json'), 'w'))
            self.assertIsNone(s.measure(d))
        self.assertIsNone(s.measure('/nonexistent'))

    def test_measure_from_a_repair_key(self):
        m = s.measure_key([0, 0, 1567.04, 291], '/r/routed.kicad_pcb', 'repair')
        self.assertEqual((m['length_mm'], m['vias']), (1567.0, 291))
        self.assertTrue(m['source'].startswith('repair'))
        self.assertIsNone(s.measure_key([1, 0, float('inf'), 0], 'x'))

    def test_best_line_names_step_halo_length_vias_and_reason(self):
        run = dict(best=dict(board='/o/step-2/b/NET-CORE.kicad_pcb', s=0.542, k=1.0, unrouted=0, box_sum=2407.0,
                             measure=dict(length_mm=1580.3, vias=296, routed='/o/step-2/route-0/NET-CORE.kicad_pcb')),
                   best_step=2, best_reason='shortest routed length of 4 measured passing steps')
        line = compact_cli.best_line(run)
        self.assertRegex(line, r'^BEST board .*?/step-(\d+)/')   # tools/design_sweep.py parses this
        for part in ('step 2', 's 0.542', 'length 1580.3 mm', 'vias 296', 'shortest routed length'):
            self.assertIn(part, line)

    def test_rank_length_needs_iotroute(self):
        a = compact_cli.parser().parse_args(['p', 'b', '--board-dir', 'x', '--outdir', 'o', '--size', '1', '1'])
        self.assertIsNone(a.rank)
        self.assertEqual(a.length_patience, 2)
        with self.assertRaises(ValueError):
            compact_cli.main(['p', 'b', '--board-dir', 'x', '--outdir', 'o', '--size', '1', '1', '--rank', 'length'])


if __name__ == '__main__':
    unittest.main()
