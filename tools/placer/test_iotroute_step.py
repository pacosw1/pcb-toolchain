"""The options and best line of compact_cli.py for the iotroute backend; the step itself is in iotroute-step.test.ts."""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import placer  # noqa: E402
from placer import compact_cli  # noqa: E402


class Cli(unittest.TestCase):
    def test_router_choice_and_default(self):
        base = ['p.json', 'b.kicad_pcb', '--board-dir', 'x', '--outdir', 'o', '--size', '72', '80']
        self.assertEqual(compact_cli.parser().parse_args(base).router, 'fastroute')
        self.assertEqual(compact_cli.parser().parse_args(base + ['--router', 'iotroute']).router, 'iotroute')


class Measure(unittest.TestCase):
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

    def test_bad_options_stop_before_pcbnew(self):
        argv = ['p', 'b', '--board-dir', 'x', '--outdir', 'o', '--size', '1', '1', '--rank', 'length']
        with mock.patch.dict(sys.modules, {'pcbnew': None}), mock.patch.dict(placer.__dict__):
            sys.modules.pop('placer.kicad_io', None)
            placer.__dict__.pop('kicad_io', None)
            with self.assertRaisesRegex(ValueError, '--rank length needs --router iotroute'):
                compact_cli.main(argv)


if __name__ == '__main__':
    unittest.main()
