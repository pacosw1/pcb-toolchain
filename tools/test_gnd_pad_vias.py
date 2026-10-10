"""Pure skip-policy tests; select NativeConnectivityTests separately with KiCad Python."""
import contextlib
import io
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import patch

from gnd_pad_vias import NearbyViaConnectivity


def item(kind, x, y, net=1):
    return SimpleNamespace(GetClass=lambda: kind, GetNetCode=lambda: net,
                           GetPosition=lambda: SimpleNamespace(x=x, y=y))


class ConnectivitySkipTests(unittest.TestCase):
    def setUp(self):
        self.pad = item('PAD', 0, 0)
        self.via = item('PCB_VIA', 600, 700)
        self.items = []
        self.refreshes = 0
        def refresh():
            self.refreshes += 1
            return SimpleNamespace(GetConnectedItems=lambda pad: list(self.items))
        self.proof = NearbyViaConnectivity(refresh)

    def test_disconnected_nearby_via_does_not_skip(self):
        self.assertFalse(self.proof.connected(self.pad, [self.via.GetPosition()], 1000))
        self.assertEqual(self.refreshes, 1)

    def test_connected_nearby_via_skips(self):
        self.items = [self.pad, self.via]
        self.assertTrue(self.proof.connected(self.pad, [self.via.GetPosition()], 1000))

    def test_far_via_does_not_refresh(self):
        self.items = [self.via]
        self.assertFalse(self.proof.connected(self.pad, [self.via.GetPosition()], 500))
        self.assertEqual(self.refreshes, 0)

    def test_wrong_net_and_nonvia_do_not_skip(self):
        self.items = [item('PCB_VIA', 1, 1, 2), item('PCB_TRACK', 1, 1)]
        self.assertFalse(self.proof.connected(self.pad, [self.via.GetPosition()], 1000))

    def test_radius_boundary_inclusive(self):
        self.items = [item('PCB_VIA', 600, 800)]
        self.assertTrue(self.proof.connected(self.pad, [self.items[0].GetPosition()], 1000))

    def test_mutations_require_fresh_proof(self):
        self.items = [self.via]
        self.assertTrue(self.proof.connected(self.pad, [self.via.GetPosition()], 1000))
        self.assertTrue(self.proof.connected(self.pad, [self.via.GetPosition()], 1000))
        self.assertEqual(self.refreshes, 1)
        self.proof.invalidate()
        self.items = []
        self.assertFalse(self.proof.connected(self.pad, [self.via.GetPosition()], 1000))
        self.assertEqual(self.refreshes, 2)

    def test_refresh_failure_is_visible(self):
        def fail():
            raise RuntimeError('unproved fill')
        self.proof = NearbyViaConnectivity(fail)
        with self.assertRaisesRegex(RuntimeError, 'unproved fill'):
            self.proof.connected(self.pad, [self.via.GetPosition()], 1000)
        self.assertIsNone(self.proof.connectivity)


class NativeConnectivityTests(unittest.TestCase):
    """Real saved boards, run explicitly; unavailable pcbnew is a failure, not a skip."""

    def fixture(self, directory, connected=False, zone=False, early_repair=False):
        import pcbnew as p
        mm = p.FromMM
        b = p.BOARD()
        net = p.NETINFO_ITEM(b, 'GND')
        b.Add(net)
        fp = p.FOOTPRINT(b)
        fp.SetReference('C1')
        fp.SetPosition(p.VECTOR2I(mm(10), mm(10)))
        pad = p.PAD(fp)
        pad.SetNumber('2')
        pad.SetAttribute(p.PAD_ATTRIB_SMD)
        pad.SetShape(p.PAD_SHAPE_RECT)
        pad.SetSize(p.VECTOR2I(mm(.8), mm(.9)))
        pad.SetLayerSet(pad.SMDMask())
        pad.SetPosition(fp.GetPosition())
        pad.SetNet(net)
        fp.Add(pad)
        b.Add(fp)
        via = p.PCB_VIA(b)
        via.SetPosition(p.VECTOR2I(mm(10.62), mm(10.76)))
        via.SetWidth(mm(.6))
        via.SetDrill(mm(.3))
        via.SetLayerPair(p.F_Cu, p.B_Cu)
        via.SetNet(net)
        b.Add(via)
        if early_repair:
            later = p.FOOTPRINT(b)
            later.SetReference('C2')
            later.SetPosition(p.VECTOR2I(mm(15), mm(15)))
            later_pad = p.PAD(later)
            later_pad.SetNumber('2')
            later_pad.SetAttribute(p.PAD_ATTRIB_SMD)
            later_pad.SetShape(p.PAD_SHAPE_RECT)
            later_pad.SetSize(p.VECTOR2I(mm(.8), mm(.9)))
            later_pad.SetLayerSet(later_pad.SMDMask())
            later_pad.SetPosition(later.GetPosition())
            later_pad.SetNet(net)
            later.Add(later_pad)
            b.Add(later)
            later_via = p.PCB_VIA(b)
            later_via.SetPosition(p.VECTOR2I(mm(15.62), mm(15.76)))
            later_via.SetWidth(mm(.6))
            later_via.SetDrill(mm(.3))
            later_via.SetLayerPair(p.F_Cu, p.B_Cu)
            later_via.SetNet(net)
            b.Add(later_via)
        for start, end in (((0, 0), (20, 0)), ((20, 0), (20, 20)),
                           ((20, 20), (0, 20)), ((0, 20), (0, 0))):
            edge = p.PCB_SHAPE(b)
            edge.SetShape(p.SHAPE_T_SEGMENT)
            edge.SetStart(p.VECTOR2I(mm(start[0]), mm(start[1])))
            edge.SetEnd(p.VECTOR2I(mm(end[0]), mm(end[1])))
            edge.SetLayer(p.Edge_Cuts)
            b.Add(edge)
        if connected:
            track = p.PCB_TRACK(b)
            track.SetStart(pad.GetPosition())
            track.SetEnd(via.GetPosition())
            track.SetWidth(mm(.4))
            track.SetLayer(p.F_Cu)
            track.SetNet(net)
            b.Add(track)
        if zone:
            z = p.ZONE(b)
            z.SetLayer(p.F_Cu)
            z.SetNet(net)
            z.SetPadConnection(p.ZONE_CONNECTION_FULL)
            outline = z.Outline()
            outline.NewOutline()
            lower = 14 if early_repair else 1
            for x, y in ((lower, lower), (19, lower), (19, 19), (lower, 19)):
                outline.Append(mm(x), mm(y))
            b.Add(z)
        path = Path(directory) / 'fixture.kicad_pcb'
        p.SaveBoard(str(path), b)
        return path

    def run_tool(self, source, disconnected_refs=()):
        import pcbnew as p
        from gnd_pad_vias import main
        out = source.with_name('out.kicad_pcb')
        native_footprints = p.BOARD.GetFootprints
        def ordered_footprints(board):
            return sorted(native_footprints(board), key=lambda fp: fp.GetReference())
        # Force the adverse ordering using real native board items; saved-file
        # enumeration order otherwise varies with generated UUIDs.
        with patch.object(p.BOARD, 'GetFootprints', ordered_footprints), \
                patch.object(sys, 'argv', ['gnd_pad_vias', str(source), str(out)]):
            with contextlib.redirect_stdout(io.StringIO()) as log:
                main()
        saved = p.LoadBoard(str(out))
        saved.BuildConnectivity()
        vias = [t for t in saved.GetTracks() if t.GetClass() == 'PCB_VIA']
        for fp in saved.GetFootprints():
            for pad in fp.Pads():
                connected = any(t.GetClass() == 'PCB_VIA'
                                for t in saved.GetConnectivity().GetConnectedItems(pad))
                self.assertEqual(connected, fp.GetReference() not in disconnected_refs)
        return len(vias), log.getvalue()

    def test_saved_disconnected_nearby_via_gets_repair(self):
        with tempfile.TemporaryDirectory() as directory:
            count, log = self.run_tool(self.fixture(directory))
            self.assertEqual(count, 2)
            self.assertIn('vias added: 1;', log)

    def test_saved_connected_pad_does_not_add_via(self):
        with tempfile.TemporaryDirectory() as directory:
            count, log = self.run_tool(self.fixture(directory, connected=True))
            self.assertEqual(count, 1)
            self.assertIn('vias added: 0;', log)

    def test_unfilled_plane_is_refilled_before_skip(self):
        with tempfile.TemporaryDirectory() as directory:
            count, log = self.run_tool(self.fixture(directory, zone=True))
            self.assertEqual(count, 1)
            self.assertIn('vias added: 0;', log)

    def test_added_stub_refreshes_native_connectivity(self):
        import pcbnew as p
        with tempfile.TemporaryDirectory() as directory:
            b = p.LoadBoard(str(self.fixture(directory)))
            pad = next(iter(next(iter(b.GetFootprints())).Pads()))
            via = next(t for t in b.GetTracks() if t.GetClass() == 'PCB_VIA')
            refreshes = []
            def refresh():
                b.BuildConnectivity()
                refreshes.append(True)
                return b.GetConnectivity()
            proof = NearbyViaConnectivity(refresh)
            self.assertFalse(proof.connected(pad, [via.GetPosition()], p.FromMM(1)))
            track = p.PCB_TRACK(b)
            track.SetStart(pad.GetPosition())
            track.SetEnd(via.GetPosition())
            track.SetWidth(p.FromMM(.4))
            track.SetLayer(p.F_Cu)
            track.SetNet(pad.GetNet())
            b.Add(track)
            proof.invalidate()
            self.assertTrue(proof.connected(pad, [via.GetPosition()], p.FromMM(1)))
            self.assertEqual(len(refreshes), 2)

    def test_early_repair_keeps_later_plane_skip_with_two_fills(self):
        import pcbnew as p
        with tempfile.TemporaryDirectory() as directory:
            source = self.fixture(directory, zone=True, early_repair=True)
            native_filler = p.ZONE_FILLER
            fills = []
            def counted_filler(board):
                filler = native_filler(board)
                def fill(zones):
                    fills.append(True)
                    return filler.Fill(zones)
                return SimpleNamespace(Fill=fill)
            with patch.object(p, 'ZONE_FILLER', counted_filler):
                count, log = self.run_tool(source)
            self.assertEqual(count, 3)  # two original vias, exactly one repair
            self.assertEqual(len(fills), 2)
            self.assertIn('vias added: 1;', log)
            self.assertIn('final connectivity unresolved: 0', log)

    def test_final_fill_reports_lost_provisional_connection(self):
        import pcbnew as p
        with tempfile.TemporaryDirectory() as directory:
            source = self.fixture(directory, zone=True, early_repair=True)
            native_filler = p.ZONE_FILLER
            fills = []
            def changed_plane_filler(board):
                filler = native_filler(board)
                def fill(zones):
                    fills.append(True)
                    if len(fills) == 2:
                        # Force loss of the provisional plane connection at the
                        # final verification boundary using real native geometry.
                        for zone in zones:
                            zone.SetLayer(p.B_Cu)
                    return filler.Fill(zones)
                return SimpleNamespace(Fill=fill)
            with patch.object(p, 'ZONE_FILLER', changed_plane_filler):
                count, log = self.run_tool(source, disconnected_refs=('C2',))
            self.assertEqual(count, 3)
            self.assertEqual(len(fills), 2)
            self.assertIn('no free place: 1 C2.2', log)
            self.assertIn('final connectivity unresolved: 1 C2.2', log)

    def test_first_repair_connects_shared_track_without_duplicate_via(self):
        import pcbnew as p
        with tempfile.TemporaryDirectory() as directory:
            source = self.fixture(directory, early_repair=True)
            b = p.LoadBoard(str(source))
            fps = {fp.GetReference(): fp for fp in b.GetFootprints()}
            first = next(iter(fps['C1'].Pads()))
            second = next(iter(fps['C2'].Pads()))
            # Move the second pad onto a shared F.Cu trace within 1 mm of the
            # first repair's candidate via. Remove its remote original via.
            second.SetPosition(p.VECTOR2I(p.FromMM(11.8), p.FromMM(10)))
            for via in list(b.GetTracks()):
                if via.GetPosition().x > p.FromMM(14):
                    b.Remove(via)
            track = p.PCB_TRACK(b)
            track.SetStart(first.GetPosition())
            track.SetEnd(second.GetPosition())
            track.SetWidth(p.FromMM(.4))
            track.SetLayer(p.F_Cu)
            track.SetNet(first.GetNet())
            b.Add(track)
            p.SaveBoard(str(source), b)
            count, log = self.run_tool(source)
            self.assertEqual(count, 2)
            self.assertIn('vias added: 1;', log)
            self.assertIn('final connectivity unresolved: 0', log)

    def test_native_exclude_zones_does_not_traverse_plane(self):
        import pcbnew as p
        with tempfile.TemporaryDirectory() as directory:
            b = p.LoadBoard(str(self.fixture(directory, zone=True)))
            self.assertTrue(p.ZONE_FILLER(b).Fill(b.Zones()))
            b.BuildConnectivity()
            pad = next(iter(next(iter(b.GetFootprints())).Pads()))
            via = next(t for t in b.GetTracks() if t.GetClass() == 'PCB_VIA')
            refresh = lambda: b.GetConnectivity()
            self.assertTrue(NearbyViaConnectivity(refresh).connected(pad, [via.GetPosition()], p.FromMM(1)))
            self.assertFalse(NearbyViaConnectivity(refresh, p.EXCLUDE_ZONES).connected(
                pad, [via.GetPosition()], p.FromMM(1)))


if __name__ == '__main__':
    unittest.main()
