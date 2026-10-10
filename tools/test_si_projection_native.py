"""Saved native projection fixtures; explicitly separate from pure CI."""
import hashlib
import json
import math
import os
import tempfile
from pathlib import Path
import unittest
from unittest import mock
import si_planes as sp

OUTPUT = Path(os.environ.get('SI_PROJECTION_OUTPUT_ROOT') or tempfile.mkdtemp(prefix='iot-si-projection-native-'))


class NativeProjectionTests(unittest.TestCase):
    def fixture(self, arc=False, domain=False, solid=False):
        import pcbnew as p
        b = p.BOARD()
        b.SetCopperLayerCount(4)
        nets = {}
        for name in ('GND','ISO','SIG'):
            nets[name] = p.NETINFO_ITEM(b,name)
            b.Add(nets[name])
        for a,e in [((0,0),(10,0)),((10,0),(10,10)),((10,10),(0,10)),((0,10),(0,0))]:
            edge = p.PCB_SHAPE(b)
            edge.SetShape(p.SHAPE_T_SEGMENT)
            edge.SetStart(p.VECTOR2I(p.FromMM(a[0]),p.FromMM(a[1])))
            edge.SetEnd(p.VECTOR2I(p.FromMM(e[0]),p.FromMM(e[1])))
            edge.SetLayer(p.Edge_Cuts)
            b.Add(edge)
        # Ground PTH establishes actual plane connectivity without granting a
        # signal anchor exception near the synthetic projection gap.
        fp = p.FOOTPRINT(b)
        fp.SetReference('J1')
        pad = p.PAD(fp)
        pad.SetNumber('1')
        pad.SetAttribute(p.PAD_ATTRIB_PTH)
        pad.SetShape(p.PAD_SHAPE_CIRCLE)
        pad.SetLayerSet(pad.PTHMask())
        pad.SetPosition(p.VECTOR2I(p.FromMM(2),p.FromMM(2)))
        pad.SetSize(p.VECTOR2I(p.FromMM(1),p.FromMM(1)))
        pad.SetDrillSize(p.VECTOR2I(p.FromMM(.4),p.FromMM(.4)))
        pad.SetNet(nets['GND'])
        fp.Add(pad)
        b.Add(fp)

        z = p.ZONE(b)
        z.SetNet(nets['GND'])
        z.SetLayer(p.In1_Cu)
        z.SetMinThickness(p.FromMM(.001))
        outline = z.Outline()
        outline.NewOutline()
        for x,y in ((1,1),(9,1),(9,9),(1,9)):
            outline.Append(p.FromMM(x),p.FromMM(y))
        if not solid:
            hole = outline.NewHole()
            left,right = (3.7,4.3) if domain else (4.11,4.12)
            for x,y in ((left,4),(left,7),(right,7),(right,4)):
                outline.Append(p.FromMM(x),p.FromMM(y),0,hole)
        b.Add(z)
        if domain:
            # A real isolated native ISO conductor under part of the path.
            # Projection may not substitute the surrounding GND domain.
            iso = p.ZONE(b)
            iso.SetNet(nets['ISO'])
            iso.SetLayer(p.In1_Cu)
            iso.SetMinThickness(p.FromMM(.001))
            iso.SetIslandRemovalMode(p.ISLAND_REMOVAL_MODE_NEVER)
            iso.SetAssignedPriority(1)
            ring = iso.Outline()
            ring.NewOutline()
            for x,y in ((3.75,4.1),(4.25,4.1),(4.25,6.9),(3.75,6.9)):
                ring.Append(p.FromMM(x),p.FromMM(y))
            b.Add(iso)
        track = p.PCB_ARC(b) if arc else p.PCB_TRACK(b)
        track.SetLayer(p.F_Cu)
        track.SetNet(nets['SIG'])
        track.SetWidth(p.FromMM(.1))
        if arc:
            track.SetStart(p.VECTOR2I(p.FromMM(5),p.FromMM(5)))
            track.SetMid(p.VECTOR2I(p.FromMM(4),p.FromMM(6)))
            track.SetEnd(p.VECTOR2I(p.FromMM(3),p.FromMM(5)))
        else:
            track.SetStart(p.VECTOR2I(p.FromMM(4),p.FromMM(5)))
            track.SetEnd(p.VECTOR2I(p.FromMM(5),p.FromMM(5)))
        b.Add(track)
        self.assertTrue(p.ZONE_FILLER(b).Fill(b.Zones()))
        OUTPUT.mkdir(parents=True,exist_ok=True)
        name = self._testMethodName
        path = OUTPUT/(name+'.kicad_pcb')
        p.SaveBoard(str(path),b)
        b = p.LoadBoard(str(path))
        fills = [(zone.GetNetname(),zone.GetFilledPolysList(p.In1_Cu)) for zone in b.Zones()]
        def ref(x,y):
            q = p.VECTOR2I(p.FromMM(x),p.FromMM(y))
            return next((name for name,poly in fills if poly.Contains(q,-1,0,True)),None)
        if domain:
            self.assertEqual(ref(4.115,5.5 if arc else 5),'ISO')
        elif not solid:
            self.assertIsNone(ref(4.115,5.5 if arc else 5))
        # Confirm the original midpoint-only projection misses this saved
        # native narrow feature, not merely a hand-written pure predicate.
        pts = sp.sample_arc((5,5),(4,6),(3,5),.25) if arc else sp.sample_segment((4,5),(5,5),.25)
        if not domain:
            self.assertTrue(all(ref(x,y)=='GND' for x,y,w in pts))
        return path

    def run_case(self,arc=False,domain=False,fast=False,solid=False,finite=False):
        path = self.fixture(arc,domain,solid)
        s = sp.load_spec(dict(about='native projection counterexample',adjacent={'F.Cu':'In1.Cu'},
                             plane_layers=['In1.Cu'],grounds=['GND','ISO'] if domain else ['GND'],
                             domains={'GND':['SIG']},via_allow_mm=.001))
        s['_fast_top'] = ['SIG'] if fast else []
        source = hashlib.sha256(path.read_bytes()).hexdigest()
        # Synthetic fixture deliberately has no schematic/driver. The actual
        # native track, polygon, path producer and saved-byte loader are used.
        with mock.patch('net_drivers.export_netlist',return_value={'nets':{},'comps':{}}):
            if finite:
                # A controlled budget fixture, not a manufacturer edge claim.
                with mock.patch('si_planes.driver_edges',return_value={'SIG':{'edge_ns':.1,'driver':'synthetic finite-budget fixture'}}):
                    failures,info,detail = sp.analyse(str(path),s,True)
            else:
                failures,info,detail = sp.analyse(str(path),s,True)
        expected = 'none' if solid else 'domain-cross' if domain else 'fast-crossing' if fast else 'detour' if finite else 'unknown-driver'
        if solid:
            self.assertEqual(failures,[])
        else:
            self.assertTrue(any(expected in line for line in failures),failures)
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(),source)
        (OUTPUT/(path.stem+('-fast' if fast else '-finite' if finite else '-slow')+'.json')).write_text(json.dumps(
            dict(board_sha256=source,source_unchanged=True,qualified=False,expected=expected,failures=failures,detail=detail),indent=2)+'\n')

    def test_native_segment_fast_void(self): self.run_case(fast=True)
    def test_native_segment_unknown_void(self): self.run_case()
    def test_native_segment_wrong_domain(self): self.run_case(domain=True)
    def test_native_arc_fast_void(self): self.run_case(arc=True,fast=True)
    def test_native_arc_unknown_void(self): self.run_case(arc=True)
    def test_native_arc_wrong_domain(self): self.run_case(arc=True,domain=True)
    def test_native_segment_finite_budget(self): self.run_case(finite=True)
    def test_native_arc_finite_budget(self): self.run_case(arc=True,finite=True)
    def test_native_segment_solid_positive(self): self.run_case(solid=True)
    def test_native_arc_solid_positive(self): self.run_case(arc=True,solid=True)


if __name__ == '__main__': unittest.main()
