import math
import unittest
import si_planes as sp


def edges(x0,y0,x1,y1):
    ring = [(x0,y0),(x1,y0),(x1,y1),(x0,y1)]
    return list(zip(ring,ring[1:]+ring[:1]))


def spec(**kw):
    fast = kw.pop('fast',[])
    zero = kw.pop('via_allow_mm',None) == 0
    s = sp.load_spec(dict(about='projection fixture',adjacent={'F.Cu':'In1.Cu'},
                         plane_layers=['In1.Cu'],grounds=['GND','ISO'],**kw))
    s['_fast_top'] = fast
    # Pure zero-clearance geometry fixture, not an accepted production spec.
    if zero:
        s['via_allow_mm'] = 0
    return s


class ContinuousProjectionTests(unittest.TestCase):
    def test_exact_original_narrow_void_fast_crossing(self):
        s = spec(fast=['SIG'],via_allow_mm=0)
        ref = lambda x,y: None if .11 < x < .12 else 'GND'
        r = sp.evaluate_paths([((0,0),(1,0))],edges(.11,-1,.12,1),ref,'GND',[],s,'SIG')
        self.assertAlmostEqual(r['bad'],.01)
        self.assertEqual(len(r['runs']),1)
        self.assertEqual(len(r['runs'][0]['terminals']),2)
        self.assertTrue(any('fast-crossing' in x for x in sp.reference_failures({('F.Cu','SIG'):r},{'SIG':'GND'},s)))

    def test_slow_unknown_void_does_not_disappear(self):
        s = spec(via_allow_mm=0)
        ref = lambda x,y: None if .11 < x < .12 else 'GND'
        r = sp.evaluate_paths([((0,0),(1,0))],edges(.11,-1,.12,1),ref,'GND',[],s,'SIG')
        self.assertTrue(any('unknown-driver' in x for x in sp.reference_failures({('F.Cu','SIG'):r},{'SIG':'GND'},s)))

    def test_wrong_domain_narrow_strip(self):
        s = spec(via_allow_mm=0)
        ref = lambda x,y: 'ISO' if .11 < x < .12 else 'GND'
        r = sp.evaluate_paths([((0,0),(1,0))],edges(.11,-1,.12,1),ref,'GND',[],s,'SIG')
        self.assertAlmostEqual(r['cross'],.01)
        self.assertTrue(any('domain-cross' in x for x in sp.reference_failures({('F.Cu','SIG'):r},{'SIG':'GND'},s)))

    def test_arc_crossing_between_original_midpoints(self):
        s = spec(fast=['SIG'],via_allow_mm=0)
        path = ((1,0),(0,1),(-1,0))
        ref = lambda x,y: None if .11 < x < .12 else 'GND'
        r = sp.evaluate_paths([path],edges(.11,-2,.12,2),ref,'GND',[],s,'SIG')
        self.assertAlmostEqual(r['length'],math.pi)
        self.assertAlmostEqual(r['bad'],math.acos(.11)-math.acos(.12))
        self.assertEqual(len(r['runs'][0]['terminals']),2)

    def test_anchor_circle_splits_partial_permission_exactly(self):
        s = spec(via_allow_mm=0)
        r = sp.evaluate_paths([((0,0),(1,0))],[],lambda x,y:None,'GND',[(0,0,.12)],s,'SIG')
        self.assertAlmostEqual(r['bad'],.88)
        self.assertEqual(len(r['runs'][0]['terminals']),1)

    def test_arc_anchor_intersection_exact(self):
        s = spec(via_allow_mm=0)
        r = sp.evaluate_paths([((1,0),(0,1),(-1,0))],[],lambda x,y:None,'GND',[(1,0,.12)],s,'SIG')
        self.assertAlmostEqual(r['bad'],math.pi-2*math.asin(.06))

    def test_exemption_cannot_hide_unexempt_fraction(self):
        s = spec(via_allow_mm=0,exempt={'areas':[{'box':[.11,-1,.115,1],'nets':['SIG'],'reason':'bounded fixture exemption'}]})
        ref = lambda x,y: None if .11 < x < .12 else 'GND'
        r = sp.evaluate_paths([((0,0),(1,0))],edges(.11,-1,.12,1),ref,'GND',[],s,'SIG')
        self.assertAlmostEqual(r['bad'],.005)

    def test_cap_boundary_limits_alt_reference(self):
        s = spec(via_allow_mm=0,alt_refs={'VDD':{'domain':'GND','cap_mm':.12,'reason':'fixture'}})
        r = sp.evaluate_paths([((0,0),(1,0))],[],lambda x,y:'VDD','GND',[],s,'SIG',{'VDD':[(0,0)]})
        self.assertAlmostEqual(r['bad'],.88)

    def test_native_junction_connects_intervals_without_step_jump(self):
        s = spec(via_allow_mm=0)
        ref = lambda x,y: None if .1 < x < .5 else 'GND'
        r = sp.evaluate_paths([((0,0),(.3,0)),((.3,0),(1,0))],edges(.1,-1,.5,1),ref,'GND',[],s,'SIG')
        self.assertEqual(len(r['runs']),1)
        self.assertAlmostEqual(r['bad'],.4)
        self.assertEqual(len(r['runs'][0]['terminals']),2)

    def test_separated_bad_paths_not_merged_by_step_radius(self):
        s = spec(via_allow_mm=0)
        r = sp.evaluate_paths([((0,0),(.1,0)),((.2,0),(.3,0))],[],lambda x,y:None,'GND',[],s,'SIG')
        self.assertEqual(len(r['runs']),2)

    def test_reverse_arc_same_measure(self):
        s = spec(via_allow_mm=0)
        ref = lambda x,y: None if .11 < x < .12 else 'GND'
        for path in [((1,0),(0,1),(-1,0)),((-1,0),(0,1),(1,0))]:
            r = sp.evaluate_paths([path],edges(.11,-2,.12,2),ref,'GND',[],s,'SIG')
            self.assertAlmostEqual(r['bad'],math.acos(.11)-math.acos(.12))


if __name__ == '__main__':
    unittest.main()
