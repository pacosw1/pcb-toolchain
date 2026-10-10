"""Explicit KiCad fixtures; not part of the platform-independent CI class."""
import collections
import json
import hashlib
import os
import tempfile
from pathlib import Path
import unittest
import si_planes as sp

ROOT = Path(os.environ.get('IOT_SI_FIXTURE_DIR') or tempfile.mkdtemp(prefix='iot-si-native-'))


class NativePortalTests(unittest.TestCase):
    def fixture(self, alternate, bridge=None):
        import pcbnew as p
        b = p.BOARD()
        b.SetCopperLayerCount(4)
        net = p.NETINFO_ITEM(b, 'GND')
        b.Add(net)
        for start, end in (((0, 0), (10, 0)), ((10, 0), (10, 10)), ((10, 10), (0, 10)), ((0, 10), (0, 0))):
            edge = p.PCB_SHAPE(b)
            edge.SetShape(p.SHAPE_T_SEGMENT)
            edge.SetStart(p.VECTOR2I(p.FromMM(start[0]), p.FromMM(start[1])))
            edge.SetEnd(p.VECTOR2I(p.FromMM(end[0]), p.FromMM(end[1])))
            edge.SetLayer(p.Edge_Cuts)
            b.Add(edge)
        fp = p.FOOTPRINT(b)
        fp.SetReference('J1')
        lands = []
        for k, x in enumerate((3, 7), 1):
            pad = p.PAD(fp)
            pad.SetNumber(str(k))
            pad.SetAttribute(p.PAD_ATTRIB_PTH)
            pad.SetShape(p.PAD_SHAPE_CIRCLE)
            pad.SetLayerSet(pad.PTHMask())
            pad.SetSize(p.VECTOR2I(p.FromMM(1), p.FromMM(1)))
            pad.SetDrillSize(p.VECTOR2I(p.FromMM(.4), p.FromMM(.4)))
            pad.SetPosition(p.VECTOR2I(p.FromMM(x), p.FromMM(5)))
            pad.SetNet(net)
            fp.Add(pad)
            lands.append(pad)
        b.Add(fp)
        if bridge:
            track_net = net
            if bridge == 'wrong':
                track_net = p.NETINFO_ITEM(b, 'ISO_0V')
                b.Add(track_net)
            track = p.PCB_TRACK(b)
            track.SetLayer(p.In2_Cu)
            track.SetNet(track_net)
            track.SetWidth(p.FromMM(.4))
            # Keep the negative conductor away from GND pad lands.
            x0, x1 = (3, 7) if bridge == 'ground' else (4.6, 5.4)
            track.SetStart(p.VECTOR2I(p.FromMM(x0), p.FromMM(5)))
            track.SetEnd(p.VECTOR2I(p.FromMM(x1), p.FromMM(5)))
            b.Add(track)

        def zone(layer, x0, x1, hole=False):
            z = p.ZONE(b)
            z.SetLayer(layer)
            z.SetNet(net)
            z.SetPadConnection(p.ZONE_CONNECTION_THERMAL)
            z.SetThermalReliefGap(p.FromMM(.3))
            z.SetThermalReliefSpokeWidth(p.FromMM(.3))
            o = z.Outline()
            o.NewOutline()
            for x, y in ((x0, 1), (x1, 1), (x1, 9), (x0, 9)):
                o.Append(p.FromMM(x), p.FromMM(y))
            if hole:
                h = o.NewHole()
                for x, y in ((4, 4), (4, 6), (6, 6), (6, 4)):
                    o.Append(p.FromMM(x), p.FromMM(y), 0, h)
            b.Add(z)
        zone(p.In2_Cu, 1, 4.8)
        zone(p.In2_Cu, 5.2, 9)
        if alternate == 'split':
            zone(p.In1_Cu, 1, 4.8)
            zone(p.In1_Cu, 5.2, 9)
        else:
            zone(p.In1_Cu, 1, 9, hole=alternate == 'hole')
        self.assertTrue(p.ZONE_FILLER(b).Fill(b.Zones()))
        ROOT.mkdir(parents=True, exist_ok=True)
        name = self._testMethodName + '-' + alternate + ('-' + bridge if bridge else '')
        path = ROOT / (name + '.kicad_pcb')
        p.SaveBoard(str(path), b)
        # Validate saved bytes, not transient unsaved construction.
        b = p.LoadBoard(str(path))
        fills = collections.defaultdict(list)
        for z in b.Zones():
            poly = z.GetFilledPolysList(z.GetLayer())
            poly.BuildBBoxCaches()
            fills[z.GetLayer()].append(('GND', poly))
        pads = list(b.GetPads())
        s = {'grounds': ['GND'], 'alt_refs': {}}
        conductors = pads + list(b.GetTracks())
        primary, edge = sp.native_reference_geometry(p, fills, p.In2_Cu, 'GND', s, {}, conductors)
        alt, ae = sp.native_reference_geometry(p, fills, p.In1_Cu, 'GND', s, {}, conductors)
        bare_centers = [any(poly.Contains(pad.GetPosition(), -1, 0, True) for _, poly in fills[p.In1_Cu]) for pad in pads]
        self.assertEqual(bare_centers, [False, False])
        self.assertTrue(primary(3, 5) and primary(7, 5) and alt(3, 5) and alt(7, 5))
        portals = sp.native_ground_portals(pads, p.In2_Cu, p.In1_Cu, 'GND')
        self.assertEqual(set(portals), {(3, 5), (7, 5)})
        d = sp.detour_mm(primary, [(3, 5, .1), (7, 5, .1)], 20, .1, portals, edge, alt, ae)
        receipt = {'alternate': alternate, 'detour_mm': d, 'bare_filled_centers': bare_centers,
                   'filled_holes': sum(poly.HoleCount(i) for ps in fills.values() for _, poly in ps for i in range(poly.OutlineCount())),
                   'declared_zone_holes': sum(z.Outline().HoleCount(i) for z in b.Zones() for i in range(z.Outline().OutlineCount())),
                   'alternate_center_copper': alt(5, 5)}
        if alternate == 'hole':
            # Native saved fills can fracture holes into bridged outer rings.
            # Prove the source hole AND absence of actual copper at its centre.
            self.assertGreater(receipt['declared_zone_holes'], 0)
            self.assertFalse(receipt['alternate_center_copper'])
        (ROOT / (name + '.json')).write_text(json.dumps(receipt, indent=2) + '\n')
        return d

    def test_real_thermal_lands_transfer_on_solid_alternate(self):
        # The native thermal spokes are diagonal, so the real return is longer
        # than the 4 mm terminal separation even on the solid alternate plane.
        d = self.fixture('solid')
        self.assertGreater(d, 4)
        self.assertLess(d, 5)

    def test_real_hole_makes_path_longer(self):
        self.assertGreater(self.fixture('hole'), 4.5)

    def test_real_domain_break_cannot_transfer(self):
        self.assertIsNone(self.fixture('split'))

    def test_actual_ground_track_completes_return(self):
        self.assertAlmostEqual(self.fixture('split', bridge='ground'), 4, delta=.01)

    def test_wrong_domain_track_cannot_complete_return(self):
        self.assertIsNone(self.fixture('split', bridge='wrong'))

    def test_native_portal_requires_domain_and_span(self):
        import pcbnew as p
        b = p.BOARD()
        b.SetCopperLayerCount(4)
        ground = p.NETINFO_ITEM(b, 'GND')
        b.Add(ground)
        other = p.NETINFO_ITEM(b, 'ISO_0V')
        b.Add(other)
        items = []
        for x, net, end in ((1, ground, p.B_Cu), (2, other, p.B_Cu), (3, ground, p.In1_Cu)):
            v = p.PCB_VIA(b)
            v.SetPosition(p.VECTOR2I(p.FromMM(x), p.FromMM(5)))
            v.SetWidth(p.FromMM(.8))
            v.SetDrill(p.FromMM(.4))
            if end != p.B_Cu:
                v.SetViaType(p.VIATYPE_BLIND)
            v.SetLayerPair(p.F_Cu, end)
            v.SetNet(net)
            b.Add(v)
            items.append(v)
        self.assertEqual(sp.native_ground_portals(items, p.In2_Cu, p.In1_Cu, 'GND'), [(1, 5)])


class NativeStubTests(unittest.TestCase):
    def fixture(self, load=None, reference=True):
        import pcbnew as p
        b = p.BOARD()
        b.SetCopperLayerCount(4)
        ground = p.NETINFO_ITEM(b, 'GND')
        b.Add(ground)
        signal = p.NETINFO_ITEM(b, '/A')
        b.Add(signal)
        other = p.NETINFO_ITEM(b, '/B')
        b.Add(other)
        self.assertEqual(len({ground.GetNetCode(), signal.GetNetCode(), other.GetNetCode()}), 3)
        for a, e in (((0, 0), (10, 0)), ((10, 0), (10, 10)), ((10, 10), (0, 10)), ((0, 10), (0, 0))):
            edge = p.PCB_SHAPE(b)
            edge.SetShape(p.SHAPE_T_SEGMENT)
            edge.SetLayer(p.Edge_Cuts)
            edge.SetStart(p.VECTOR2I(p.FromMM(a[0]), p.FromMM(a[1])))
            edge.SetEnd(p.VECTOR2I(p.FromMM(e[0]), p.FromMM(e[1])))
            b.Add(edge)
        for x0, x1, net in ((2, 3, signal), (3, 8, signal)):
            t = p.PCB_TRACK(b)
            t.SetLayer(p.F_Cu)
            t.SetNet(net)
            t.SetWidth(p.FromMM(.2))
            t.SetStart(p.VECTOR2I(p.FromMM(x0), p.FromMM(5)))
            t.SetEnd(p.VECTOR2I(p.FromMM(x1), p.FromMM(5)))
            b.Add(t)
        if load == 'via':
            v = p.PCB_VIA(b)
            v.SetPosition(p.VECTOR2I(p.FromMM(8), p.FromMM(5)))
            v.SetLayerPair(p.F_Cu, p.B_Cu)
            v.SetWidth(p.FromMM(.8))
            v.SetDrill(p.FromMM(.4))
            v.SetNet(signal)
            b.Add(v)
        if load == 'pad':
            f = p.FOOTPRINT(b)
            f.SetReference('U1')
            pad = p.PAD(f)
            pad.SetNumber('1')
            pad.SetAttribute(p.PAD_ATTRIB_SMD)
            pad.SetShape(p.PAD_SHAPE_RECT)
            pad.SetLayerSet(pad.SMDMask())
            pad.SetSize(p.VECTOR2I(p.FromMM(.8), p.FromMM(.8)))
            pad.SetPosition(p.VECTOR2I(p.FromMM(8), p.FromMM(5)))
            pad.SetNet(signal)
            f.Add(pad)
            b.Add(f)
        if reference:
            f = p.FOOTPRINT(b)
            f.SetReference('J1')
            pad = p.PAD(f)
            pad.SetNumber('1')
            pad.SetAttribute(p.PAD_ATTRIB_PTH)
            pad.SetShape(p.PAD_SHAPE_CIRCLE)
            pad.SetLayerSet(pad.PTHMask())
            pad.SetSize(p.VECTOR2I(p.FromMM(1), p.FromMM(1)))
            pad.SetDrillSize(p.VECTOR2I(p.FromMM(.4), p.FromMM(.4)))
            pad.SetPosition(p.VECTOR2I(p.FromMM(2), p.FromMM(2)))
            pad.SetNet(ground)
            f.Add(pad)
            b.Add(f)
            z = p.ZONE(b)
            z.SetLayer(p.In1_Cu)
            z.SetNet(ground)
            z.SetPadConnection(p.ZONE_CONNECTION_FULL)
            o = z.Outline()
            o.NewOutline()
            for x, y in ((1, 1), (5, 1), (5, 9), (1, 9)):
                o.Append(p.FromMM(x), p.FromMM(y))
            b.Add(z)
        self.assertTrue(p.ZONE_FILLER(b).Fill(b.Zones()))
        name = self._testMethodName + '-stub-' + (load or 'leaf') + ('-no-reference' if not reference else '')
        ROOT.mkdir(parents=True, exist_ok=True)
        path = ROOT / (name + '.kicad_pcb')
        p.SaveBoard(str(path), b)
        source_sha = hashlib.sha256(path.read_bytes()).hexdigest()
        b = p.LoadBoard(str(path))
        fills = collections.defaultdict(list)
        for z in b.Zones():
            poly = z.GetFilledPolysList(z.GetLayer())
            poly.BuildBBoxCaches()
            fills[z.GetLayer()].append((z.GetNetname(), poly))
        s = {'grounds': ['GND'], 'alt_refs': {}, 'exempt': {'nets': {}, 'areas': []}, 'via_allow_mm': .6,
             'step_mm': .25, '_fast': [], 'mixed_layers': {}, 'power': [], 'edge_classes': {}, 'offboard': {},
             '_edges': {'/A': {'unknown': 'fixture unknown driver'}}}
        ok, edge = sp.native_reference_geometry(p, fills, p.In1_Cu, 'GND', s, {}, list(b.GetPads()) + list(b.GetTracks()))
        # Raw projection deliberately gives the producer no pad/via allowance:
        # even if a caller misses a land, native physical topology must reject it.
        r = sp.evaluate_net(sp.sample_segment((3, 5), (8, 5), .25),
                            lambda x, y: 'GND' if ok(x, y) else None, 'GND', [], s, net='/A')
        self.assertEqual(len(r['runs']), 1)
        run = r['runs'][0]
        self.assertEqual(len(run['terminals']), 1 if reference else 0)
        proof = sp.prove_native_stub(p, b, 'F.Cu', '/A', 'GND', run, ok, edge, source_sha)
        self.native_stub_context = (p, b, ok, edge, source_sha, fills)
        def detour(layer, domain, run, budget):
            if proof is not None and proof.matches(source_sha, '/A', layer, domain, run):
                run['_stub_proof'] = proof
                return 0.0
            return sp.detour_mm(ok, run['terminals'], budget, .1, edge_ok=edge)
        failures = sp.reference_failures({('F.Cu', '/A'): r}, {'/A': 'GND'}, s, detour, 40, source_sha)
        record = {'source_sha256': source_sha, 'terminals': len(run['terminals']),
                  'proof': proof.record if proof is not None else None, 'failures': failures}
        (ROOT / (name + '.json')).write_text(json.dumps(record, indent=2) + '\n')
        return proof, failures, run

    def assess_known_typical_leaf(self, load=None):
        _, _, run = self.fixture(load=load)
        # Exercise a fresh assessment after the perimeter screen exemption,
        # rather than reusing the proof attached by the preceding fixture check.
        run = dict(run)
        run.pop('_stub_proof', None)
        p, b, ok, edge, source_sha, fills = self.native_stub_context
        import net_drivers as nd
        table = {'THVD1410': {'mpn': ['THVD1410DR'], 'pins': [
            {'match': 'A', 'role': 'push_pull', 'tr_ns': 460, 'tf_ns': 460,
             'stat': 'typ', 'source': 'fixture using accepted THVD1410 TYP screening value'}]}}
        timing = nd.net_edge('/A', {'comps': {'U1': 'THVD1410DR'},
                                  'nets': {'/A': [('U1', '6', 'A')]}}, table)
        self.assertEqual(timing['edge_ns'], 460)
        self.assertFalse(timing['timing_evidence']['qualified_fastest_bound'])
        s = {'grounds': ['GND'], 'exempt': {'nets': {}}, 'power': [], 'mixed_layers': {},
             'edge_classes': {}, '_edges': {'/A': timing}, '_fast': [], '_edge_rates': {}}
        result = {'cross': 0, 'worst': run['length'], 'worst_at': run['at'], 'runs': [run]}
        calls = []
        def detour(layer, domain, target, budget):
            calls.append(budget)
            produced = sp.prove_native_stub(p, b, layer, '/A', domain, target, ok, edge, source_sha)
            if produced is not None:
                target['_stub_proof'] = produced
                return 0.0
            return None
        assessed = sp.reference_assessment({('F.Cu', '/A'): result}, {'/A': 'GND'}, s,
                                           detour, board_mm=40, source_sha=source_sha)
        self.assertEqual(assessed['screening_failures'], [])
        self.assertEqual(calls, [0.0])
        return assessed, run

    def test_native_known_typical_perimeter_leaf_gets_producer_proof(self):
        assessed, run = self.assess_known_typical_leaf()
        self.assertIsInstance(run.get('_stub_proof'), sp._NativeStubProof)
        self.assertTrue(assessed['timing_evidence_complete'])

    def test_native_known_typical_loaded_pad_stays_timing_incomplete(self):
        assessed, run = self.assess_known_typical_leaf(load='pad')
        self.assertNotIn('_stub_proof', run)
        self.assertFalse(assessed['timing_evidence_complete'])

    def test_actual_unloaded_native_leaf_passes_unknown_driver(self):
        proof, failures, run = self.fixture()
        self.assertIsNotNone(proof)
        self.assertEqual(failures, [])
        self.assertFalse(proof.matches('wrong-source', '/A', 'F.Cu', 'GND', run))
        self.assertFalse(proof.matches(proof.record['source_sha256'], '/B', 'F.Cu', 'GND', run))
        self.assertFalse(proof.matches(proof.record['source_sha256'], '/A', 'B.Cu', 'GND', run))
        changed = dict(run, bad_points=[(7.5, 5)])
        self.assertFalse(proof.matches(proof.record['source_sha256'], '/A', 'F.Cu', 'GND', changed))
        # Evidence closure accepts only the actual producer's typed, bound proof.
        run['_stub_proof']=proof
        s={'grounds':['GND'],'exempt':{'nets':{}},'power':[],'mixed_layers':{},'edge_classes':{},
           '_edges':{'/A':{'unknown':'fixture unknown'}},'_fast':[],'_edge_rates':{}}
        result={'cross':0,'worst':run['length'],'worst_at':run['at'],'runs':[run]}
        assess=lambda source:sp.reference_assessment({('F.Cu','/A'):result},{'/A':'GND'},s,
            detour=lambda *_:0,board_mm=40,source_sha=source)
        self.assertTrue(assess(proof.record['source_sha256'])['timing_evidence_complete'])
        self.assertFalse(assess('wrong-source')['timing_evidence_complete'])
        run['_stub_proof']=True
        self.assertFalse(assess(proof.record['source_sha256'])['timing_evidence_complete'])

    def test_single_terminal_actual_loaded_pad_is_not_stub(self):
        proof, failures, _ = self.fixture(load='pad')
        self.assertIsNone(proof)
        self.assertIn('unknown-driver', failures[0])

    def test_single_terminal_actual_signal_via_is_not_stub(self):
        proof, failures, _ = self.fixture(load='via')
        self.assertIsNone(proof)
        self.assertIn('unknown-driver', failures[0])

    def test_actual_no_terminal_net_is_not_stub(self):
        proof, failures, _ = self.fixture(reference=False)
        self.assertIsNone(proof)
        self.assertIn('unknown-driver', failures[0])

if __name__ == '__main__':
    unittest.main()
