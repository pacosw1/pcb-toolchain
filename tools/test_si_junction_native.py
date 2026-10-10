"""Explicit saved-native centreline topology tests, not pure CI or release QA."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import si_planes as sp

OUTPUT = Path(os.environ.get('SI_JUNCTION_OUTPUT_ROOT') or tempfile.mkdtemp(prefix='iot-si-junction-native-'))


class NativeJunctionTests(unittest.TestCase):
    def board(self,name,arc=False,split=False,disconnected=False):
        import pcbnew as p
        b = p.BOARD()
        b.SetCopperLayerCount(4)
        nets = {}
        for net in ('GND','SIG'):
            nets[net] = p.NETINFO_ITEM(b,net)
            b.Add(nets[net])
        for a,e in [((0,0),(10,0)),((10,0),(10,10)),((10,10),(0,10)),((0,10),(0,0))]:
            edge = p.PCB_SHAPE(b)
            edge.SetShape(p.SHAPE_T_SEGMENT)
            edge.SetLayer(p.Edge_Cuts)
            edge.SetStart(p.VECTOR2I(p.FromMM(a[0]),p.FromMM(a[1])))
            edge.SetEnd(p.VECTOR2I(p.FromMM(e[0]),p.FromMM(e[1])))
            b.Add(edge)
        fp = p.FOOTPRINT(b)
        fp.SetReference('J1')
        pad = p.PAD(fp)
        pad.SetNumber('1')
        pad.SetAttribute(p.PAD_ATTRIB_PTH)
        pad.SetShape(p.PAD_SHAPE_CIRCLE)
        pad.SetLayerSet(pad.PTHMask())
        pad.SetPosition(p.VECTOR2I(p.FromMM(2),p.FromMM(6)))
        pad.SetSize(p.VECTOR2I(p.FromMM(1),p.FromMM(1)))
        pad.SetDrillSize(p.VECTOR2I(p.FromMM(.4),p.FromMM(.4)))
        pad.SetNet(nets['GND'])
        fp.Add(pad)
        b.Add(fp)
        z = p.ZONE(b)
        z.SetNet(nets['GND'])
        z.SetLayer(p.In1_Cu)
        z.SetMinThickness(p.FromMM(.001))
        boundary = 4.9 if arc else 4.1
        ring = z.Outline()
        ring.NewOutline()
        for x,y in ((1,boundary),(9,boundary),(9,9),(1,9)):
            ring.Append(p.FromMM(x),p.FromMM(y))
        b.Add(z)
        def track(a,e,m=None):
            t = p.PCB_ARC(b) if m else p.PCB_TRACK(b)
            t.SetNet(nets['SIG'])
            t.SetLayer(p.F_Cu)
            t.SetWidth(p.FromMM(.05))
            t.SetStart(p.VECTOR2I(p.FromMM(a[0]),p.FromMM(a[1])))
            if m:
                t.SetMid(p.VECTOR2I(p.FromMM(m[0]),p.FromMM(m[1])))
            t.SetEnd(p.VECTOR2I(p.FromMM(e[0]),p.FromMM(e[1])))
            b.Add(t)
        if arc:
            track((5,4),(3,4),(4,5))
            start_y = 4.7 if disconnected else 4.6
            for x in (3.2,4.8): track((x,start_y),(x,5.5))
        else:
            if split:
                for a,e in [((3,4),(3.43,4)),((3.43,4),(4.57,4)),((4.57,4),(5,4))]:track(a,e)
            else:
                track((3,4),(5,4))
            for x in (3.43,4.57):track((x,4),(x,5))
        self.assertTrue(p.ZONE_FILLER(b).Fill(b.Zones()))
        OUTPUT.mkdir(parents=True,exist_ok=True)
        path = OUTPUT/(self._testMethodName+'-'+name+'.kicad_pcb')
        p.SaveBoard(str(path),b)
        return path

    def analyse(self,path):
        source = hashlib.sha256(path.read_bytes()).hexdigest()
        s = sp.load_spec(dict(about='native junction topology fixture',adjacent={'F.Cu':'In1.Cu'},
                             plane_layers=['In1.Cu'],grounds=['GND'],domains={'GND':['SIG']},via_allow_mm=.001))
        original = sp.evaluate_paths
        captured = []
        def observe(*args,**kwargs):
            result = original(*args,**kwargs)
            captured.append(result)
            return result
        # Empty synthetic schematic and a controlled sufficient edge budget
        # isolate native topology. No actual part/electrical qualification.
        edges = {'SIG':{'edge_ns':1,'driver':'synthetic topology fixture','timing_evidence':{'qualified_fastest_bound':True}}}
        with mock.patch('net_drivers.export_netlist',return_value={'nets':{},'comps':{}}), \
             mock.patch('si_planes.driver_edges',return_value=edges), \
             mock.patch('si_planes.d124c_driver_edges',return_value=edges), \
             mock.patch('si_planes.evaluate_paths',side_effect=observe):
            failures,info,detail = sp.analyse(str(path),s,True)
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(),source)
        self.assertEqual(len(captured),1)
        result = captured[0]
        # D-124d proposed findings are report-only: WARN lines in info, not counted failures.
        proposed = [line.replace('WARN D-124d-proposed ','FAIL ',1) for line in info if line.startswith('WARN D-124d-proposed ')]
        receipt = dict(board_sha256=source,source_unchanged=True,qualified=False,failures=failures,proposed=proposed,
                       runs=result['runs'],bad=result['bad'],detail=detail)
        path.with_suffix('.json').write_text(json.dumps(receipt,indent=2)+'\n')
        return receipt

    def test_native_unsplit_split_line_equivalence(self):
        a = self.analyse(self.board('unsplit'))
        b = self.analyse(self.board('split',split=True))
        for r in (a,b):
            self.assertEqual(r['failures'],[])
            self.assertEqual(r['proposed'],[])
            self.assertEqual(len(r['runs']),1)
            self.assertEqual(len(r['runs'][0]['terminals']),2)
        self.assertAlmostEqual(a['bad'],b['bad'])

    def test_native_endpoint_on_arc(self):
        r = self.analyse(self.board('connected',arc=True))
        self.assertEqual(r['failures'],[])
        self.assertEqual(r['proposed'],[])
        self.assertEqual(len(r['runs']),2)
        self.assertEqual([len(run['terminals']) for run in r['runs']],[2,2])

    def test_native_near_arc_is_disconnected(self):
        r = self.analyse(self.board('disconnected',arc=True,disconnected=True))
        self.assertTrue(any('detour' in line for line in r['failures']+r['proposed']))
        self.assertEqual(len(r['runs']),4)
        self.assertEqual([len(run['terminals']) for run in r['runs']],[1,1,1,1])


if __name__ == '__main__': unittest.main()
