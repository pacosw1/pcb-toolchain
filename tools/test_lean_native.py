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
    def test_conflicting_cli_controls_fail_with_parser_error(self):
        for options in (['--set', 'router.autorouter.max_threads=2'],
                        ['--set', 'router.optimizer.max_threads=2'],
                        ['--optimizer', 'off', '--set', 'router.optimizer.enabled=true']):
            with self.subTest(options=options):
                result = subprocess.run([sys.executable, str(ROOT/'tools/fastroute_job.py'),
                                         'unused.kicad_pcb', 'unused-output']+options,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                        text=True, timeout=10)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertIn('error:', result.stdout)
                self.assertNotIn('NameError', result.stdout)

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

    def run_job(self, board, out, policy, extra=()):
        return subprocess.run([sys.executable, str(ROOT / 'tools/fastroute_job.py'), str(board), str(out),
                               '--preflight', '--optimizer', policy, '--threads', '1', '--passes', '2', '--max-time', '5']+list(extra),
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

    def test_router_deadline_reports_timeout_even_when_checkpoint_exit_is_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            board, out = root / 'tiny.kicad_pcb', root / 'timeout'
            self.fixture(board)
            fake = root / 'checkpoint-router'
            fake.write_text('#!/usr/bin/env python3\n'
                            'import pathlib,signal,sys,time\n'
                            'p=pathlib.Path(sys.argv[sys.argv.index("-do")+1])\n'
                            'signal.signal(signal.SIGTERM,lambda *a:(p.write_text("partial session"),sys.exit(0)))\n'
                            'time.sleep(30)\n')
            fake.chmod(0o755)
            result = subprocess.run([sys.executable, str(ROOT / 'tools/fastroute_job.py'),
                                     '--threads', '1', '--max-time', '1', str(board), str(out)],
                                    env=dict(os.environ, FASTROUTE_BIN=str(fake),
                                             IOT_RESOURCE_DIRECTORY=str(root / 'resources')),
                                    capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 124, result.stdout + result.stderr)
            evidence = json.loads((out / 'outcome.json').read_text())
            self.assertEqual(evidence['status'], 'timeout')
            self.assertFalse(evidence['qualified'])
            self.assertEqual((out / 'board.ses').read_text(), 'partial session')
            self.assertIn('board.ses', evidence['artifacts'])
            self.assertFalse((out / 'routed.kicad_pcb').exists())

    def test_ignored_ground_membership_and_locked_copper_survive_real_router_import(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            board, out = root / 'tiny.kicad_pcb', root / 'ignored'
            self.fixture(board)
            b = pcbnew.LoadBoard(str(board))
            net = pcbnew.NETINFO_ITEM(b, 'GND', 2)
            b.Add(net)
            fp = b.FindFootprintByReference('J1').Duplicate(False).Cast()
            fp.SetReference('J3')
            b.Add(fp)
            fp.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(5), pcbnew.FromMM(12)))
            for pad in fp.Pads():
                pad.SetNet(net)
            via = pcbnew.PCB_VIA(b)
            via.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(6), pcbnew.FromMM(12)))
            via.SetWidth(pcbnew.FromMM(.6))
            via.SetDrill(pcbnew.FromMM(.3))
            via.SetViaType(pcbnew.VIATYPE_THROUGH)
            via.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
            via.SetNet(net)
            via.SetLocked(True)
            b.Add(via)
            track = pcbnew.PCB_TRACK(b)
            track.SetStart(fp.Pads()[0].GetPosition())
            track.SetEnd(via.GetPosition())
            track.SetLayer(pcbnew.F_Cu)
            track.SetWidth(pcbnew.FromMM(.25))
            track.SetNet(net)
            track.SetLocked(True)
            b.Add(track)
            pcbnew.SaveBoard(str(board), b)
            def ground_copper(pcb):
                return sorted((t.GetClass(), t.GetStart().x, t.GetStart().y,
                               t.GetEnd().x, t.GetEnd().y, t.GetLayer(),
                               tuple(t.GetWidth(layer) for layer in pcb.GetEnabledLayers().CuStack())
                               if t.GetClass() == 'PCB_VIA' else t.GetWidth(),
                               t.GetDrillValue() if t.GetClass() == 'PCB_VIA' else 0)
                              for t in pcb.GetTracks() if t.GetNetname() == 'GND')
            before = ground_copper(b)
            board.with_suffix('.kicad_pro').write_text(json.dumps(dict(net_settings=dict(classes=[
                dict(name='Default', track_width=.2, clearance=.2, via_diameter=.4, via_drill=.2,
                     microvia_diameter=.3, microvia_drill=.1, diff_pair_width=.2,
                     diff_pair_gap=.25, diff_pair_via_gap=.25)]))))
            result = self.run_job(board, out, 'if-routed', ['--signal-via', '.5'])
            self.assertEqual(result.returncode, 0, result.stdout)
            after = pcbnew.LoadBoard(str(out / 'routed.kicad_pcb'))
            self.assertEqual(ground_copper(after), before)
            self.assertTrue(all(t.IsLocked() for t in after.GetTracks() if t.GetNetname() == 'GND'))
            evidence = json.loads((out / 'outcome.json').read_text())
            self.assertEqual((evidence['signal_open'], evidence['ground_open'], evidence['errors']), (0, 0, 0))
            self.assertTrue(json.loads((out / 'effective-configuration.json').read_text())['ignored_classes'])


if __name__ == '__main__':
    unittest.main()
