"""Tiny native KiCad/router smoke checks; no project board is modified."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

try:
    import pcbnew
except ImportError:
    pcbnew = None

ROOT = Path(__file__).resolve().parent.parent
BIN = Path.home() / 'opt/fastroute/fastroute-0.1.7-macos-arm64/fastroute'


@unittest.skipUnless(pcbnew and BIN.is_file(), 'requires native KiCad and pinned Fastroute')
class NativeWorkflowTest(unittest.TestCase):
    def fixture(self, path, short=False):
        b = pcbnew.BOARD()
        for a, z in [((0, 0), (20, 0)), ((20, 0), (20, 20)), ((20, 20), (0, 20)), ((0, 20), (0, 0))]:
            edge = pcbnew.PCB_SHAPE(b)
            edge.SetShape(pcbnew.SHAPE_T_SEGMENT)
            edge.SetStart(pcbnew.VECTOR2I(*[pcbnew.FromMM(v) for v in a]))
            edge.SetEnd(pcbnew.VECTOR2I(*[pcbnew.FromMM(v) for v in z]))
            edge.SetLayer(pcbnew.Edge_Cuts)
            edge.SetWidth(pcbnew.FromMM(.05))
            b.Add(edge)
        net = pcbnew.NETINFO_ITEM(b, 'N1', 1)
        b.Add(net)
        for name, at in [('J1', (5, 5)), ('J2', (15, 15))]:
            fp = pcbnew.FOOTPRINT(b)
            fp.SetReference(name)
            fp.SetFPID(pcbnew.LIB_ID('LeanFixture', 'Pad'))
            pad = pcbnew.PAD(fp)
            pad.SetNumber('1')
            pad.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
            pad.SetShape(pcbnew.PAD_SHAPE_RECT)
            pad.SetSize(pcbnew.VECTOR2I(pcbnew.FromMM(1), pcbnew.FromMM(1)))
            layers = pcbnew.LSET()
            for layer in (pcbnew.F_Cu, pcbnew.F_Mask, pcbnew.F_Paste):
                layers.AddLayer(layer)
            pad.SetLayerSet(layers)
            pad.SetNet(net)
            fp.Add(pad)
            b.Add(fp)
            fp.SetPosition(pcbnew.VECTOR2I(*[pcbnew.FromMM(v) for v in at]))
        if short:
            other = pcbnew.NETINFO_ITEM(b, 'N2', 2)
            b.Add(other)
            # KiCad derives track nets from pad connectivity when saving; retain
            # a second pad/net so the fixture contains a genuine two-net short.
            fp = pcbnew.FOOTPRINT(b)
            fp.SetReference('J3')
            fp.SetFPID(pcbnew.LIB_ID('LeanFixture', 'Pad'))
            pad = pcbnew.PAD(fp)
            pad.SetNumber('1')
            pad.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
            pad.SetShape(pcbnew.PAD_SHAPE_RECT)
            pad.SetSize(pcbnew.VECTOR2I(pcbnew.FromMM(1), pcbnew.FromMM(1)))
            pad.SetLayerSet(layers)
            pad.SetNet(other)
            fp.Add(pad)
            b.Add(fp)
            fp.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(6), pcbnew.FromMM(5)))
            track = pcbnew.PCB_TRACK(b)
            track.SetStart(pcbnew.VECTOR2I(pcbnew.FromMM(4), pcbnew.FromMM(5)))
            track.SetEnd(pcbnew.VECTOR2I(pcbnew.FromMM(6), pcbnew.FromMM(5)))
            track.SetWidth(pcbnew.FromMM(.25))
            track.SetLayer(pcbnew.F_Cu)
            track.SetNet(other)
            track.SetLocked(True)
            b.Add(track)
        pcbnew.SaveBoard(str(path), b)

    def run_job(self, board, out, policy):
        return subprocess.run([sys.executable, str(ROOT / 'tools/fastroute_job.py'), str(board), str(out),
                               '--preflight', '--optimizer', policy, '--threads', '1', '--passes', '2', '--max-time', '5'],
                              env=dict(os.environ, IOT_LEAN_DEADLINE=str(time.monotonic()+20)),
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=25)

    def test_native_screen_and_checkpoint_optimization_keep_quality(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            board = root / 'tiny.kicad_pcb'
            self.fixture(board)
            for policy in ('always', 'off', 'if-routed'):
                out = root / policy
                result = self.run_job(board, out, policy)
                self.assertEqual(result.returncode, 0, result.stdout)
                evidence = json.loads((out / 'outcome.json').read_text())
                self.assertEqual((evidence['signal_open'], evidence['errors']), (0, 0))
                self.assertFalse(evidence['qualified'])
                if policy == 'if-routed':
                    self.assertTrue((out / 'screen.ses').exists())
                    self.assertTrue((out / 'optimize.log').exists())

    def test_native_short_stops_before_router_and_output_cannot_be_reused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            board, out = root / 'short.kicad_pcb', root / 'job'
            self.fixture(board, short=True)
            result = self.run_job(board, out, 'off')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('preflight blocked', result.stdout)
            self.assertFalse((out / 'report.json').exists())
            again = self.run_job(board, out, 'off')
            self.assertIn('fresh job directory', again.stdout)


if __name__ == '__main__':
    unittest.main()
