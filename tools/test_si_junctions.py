"""Native centreline representation invariance, independent of sample step."""
import math
import unittest
import si_planes as sp


def rectangle(x0,y0,x1,y1):
    p = [(x0,y0),(x1,y0),(x1,y1),(x0,y1)]
    return list(zip(p,p[1:]+p[:1]))


def spec(step=.25):
    s = sp.load_spec(dict(about='junction geometry fixture',adjacent={'F.Cu':'In1.Cu'},
                         plane_layers=['In1.Cu'],grounds=['GND'],step_mm=step,via_allow_mm=.001))
    s['_edges'] = {'SIG':{'edge_ns':1,'driver':'controlled geometry-only fixture',
                         'timing_evidence':{'qualified_fastest_bound':True}}}
    return s


class JunctionTests(unittest.TestCase):
    def test_unsplit_and_split_t_junctions_same_detour(self):
        ref = lambda x,y:'GND' if -1 <= x <= 3 and .1 <= y <= 2 else None
        edges = rectangle(-1,.1,3,2)
        branches = [((.43,0),(.43,1)),((1.57,0),(1.57,1))]
        cases = [[((0,0),(2,0))]+branches,
                 [((0,0),(.43,0)),((.43,0),(1.57,0)),((1.57,0),(2,0))]+branches]
        for step in (.17,.25,.31):
            for paths in cases:
                s = spec(step)
                r = sp.evaluate_paths(paths,edges,ref,'GND',[],s,'SIG')
                self.assertEqual(len(r['runs']),1)
                self.assertEqual(len(r['runs'][0]['terminals']),2)
                self.assertAlmostEqual(r['bad'],2.2)
                ok = lambda x,y:ref(x,y)=='GND'
                edge = lambda a,b:sp.continuous_reference(ok,edges,a,b)
                detour = lambda layer,domain,run,budget:sp.detour_mm(ok,run['terminals'],budget,.1,edge_ok=edge)
                self.assertEqual(sp.reference_failures({('F.Cu','SIG'):r},{'SIG':'GND'},s,detour,20),[])

    def test_line_crossing_inside_both_paths(self):
        ref = lambda x,y:'GND' if abs(y) >= .1 else None
        bounds = rectangle(-2,.1,2,2)+rectangle(-2,-2,2,-.1)
        r = sp.evaluate_paths([((-1,0),(1,0)),((0,-1),(0,1))],bounds,ref,'GND',[],spec(.31),'SIG')
        self.assertEqual(len(r['runs']),1)
        self.assertEqual(len(r['runs'][0]['terminals']),2)
        self.assertAlmostEqual(r['bad'],2.2)

    def test_endpoint_on_arc_interior(self):
        ref = lambda x,y:'GND' if y >= .7 else None
        r = sp.evaluate_paths([((1,0),(0,1),(-1,0)),((.8,.6),(.8,1.5))],
                              rectangle(-2,.7,2,2),ref,'GND',[],spec(),'SIG')
        self.assertEqual(len(r['runs']),2)
        self.assertEqual(sorted(len(run['terminals']) for run in r['runs']),[1,2])

    def test_line_crosses_arc_interior(self):
        ref = lambda x,y:'GND' if y >= .9 else None
        r = sp.evaluate_paths([((1,0),(0,1),(-1,0)),((.8,-.5),(.8,1.5))],
                              rectangle(-2,.9,2,2),ref,'GND',[],spec(),'SIG')
        self.assertEqual(len(r['runs']),2)
        self.assertEqual(sorted(len(run['terminals']) for run in r['runs']),[1,2])

    def test_arc_crossing_inside_both_sweeps(self):
        ref = lambda x,y:'GND' if y >= .9 else None
        paths = [((1,0),(0,1),(-1,0)),((2,0),(1,1),(0,0))]
        r = sp.evaluate_paths(paths,rectangle(-2,.9,3,2),ref,'GND',[],spec(),'SIG')
        self.assertEqual(len(r['runs']),3)
        self.assertEqual(sorted(len(run['terminals']) for run in r['runs']),[1,1,2])

    def test_coincident_arcs_partition_at_other_native_endpoint(self):
        ref = lambda x,y:'GND' if y >= .9 else None
        paths = [((1,0),(0,1),(-1,0)),((0,1),(1,0),(0,-1))]
        r = sp.evaluate_paths(paths,rectangle(-2,.9,2,2),ref,'GND',[],spec(.31),'SIG')
        # (1,0) is an endpoint of the first arc and an interior point of the
        # second. Equal supporting circles alone have no finite intersections.
        self.assertEqual(len(r['runs']),2)

    def test_near_endpoint_is_not_step_radius_connection(self):
        ref = lambda x,y:'GND' if y >= .1 else None
        paths = [((0,0),(2,0)),((.43,.01),(.43,1))]
        for step in (.17,.25,.31):
            r = sp.evaluate_paths(paths,rectangle(-1,.1,3,2),ref,'GND',[],spec(step),'SIG')
            self.assertEqual(len(r['runs']),2)
            self.assertEqual(sorted(len(run['terminals']) for run in r['runs']),[0,1])

    def test_arc_support_circle_outside_sweep_does_not_join(self):
        ref = lambda x,y:'GND' if y >= .9 else None
        paths = [((1,0),(0,1),(-1,0)),((-.8,-.6),(-.8,-1.5))]
        r = sp.evaluate_paths(paths,rectangle(-2,.9,2,2),ref,'GND',[],spec(),'SIG')
        self.assertEqual(len(r['runs']),3)
        self.assertEqual(sorted(len(run['terminals']) for run in r['runs']),[0,1,1])


if __name__ == '__main__': unittest.main()
