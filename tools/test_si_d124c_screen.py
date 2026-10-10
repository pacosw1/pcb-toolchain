"""The gate counts the accepted D-124c screen; D-124d proposed findings are report-only (WARN, not counted)."""
import os, pathlib, sys, unittest
ROOT = pathlib.Path(os.environ.get('IOT_TEST_RULES_ROOT', pathlib.Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(ROOT / 'tools'))
import si_planes as sp


def spec(**kw):
    raw = dict(about='fixture', adjacent={'F.Cu': 'In1.Cu'}, plane_layers=['In1.Cu'], grounds=['GND'], mixed_layers={},
               power=[], edge_classes={}, receivers={}, offboard={})
    raw.update(kw)
    s = sp.load_spec(raw)
    sp.set_fast(s, {})
    return s


def result(terminals, length=0.2):
    return dict(cross=0, runs=[{'length': length, 'at': (0, 0), 'terminals': terminals, 'net': '/SIG'}],
                worst=length, worst_at=(0, 0), cross_net=None)


class D124cScreenTests(unittest.TestCase):
    def test_stub_passes_enforced_screen_and_proposed_finding_is_not_counted(self):
        s = spec()
        s['_edges'] = {'/SIG': {'unknown': 'missing driver'}}
        edges = {'/SIG': {'unknown': 'missing driver'}}
        stub = {('F.Cu', '/SIG'): result([(0, 0, .1)])}
        # D-124c: a run with one terminal is a stub (detour 0), it passes at any edge
        detour124c = lambda layer, domain, run, budget: sp.d124c_detour_mm(lambda x, y: True, run['terminals'], budget, 0.1)
        enforced = sp.d124c_reference_failures(stub, {'/SIG': 'GND'}, s, edges, detour124c, 200)
        self.assertEqual(enforced, [])
        # D-124d proposal: an unproven stub has no detour, so it needs an edge time
        proposed = sp.reference_assessment(stub, {'/SIG': 'GND'}, s, lambda *_: None, 200, report_only_timing=True)
        self.assertEqual(len(proposed['gate_failures']), 1)
        fails, report = sp.planes_outcome([], enforced, proposed)
        self.assertEqual(fails, [])
        self.assertTrue(any(line.startswith('WARN D-124d-proposed unknown-driver F.Cu /SIG:') for line in report))
        self.assertFalse(any(line.startswith('FAIL ') for line in report))

    def test_enforced_finding_is_counted_once_and_never_dropped(self):
        enforced = ['FAIL detour B.Cu /A: 1 of 1 crossings ... detour 9.0 mm', 'FAIL unknown-driver B.Cu /B: ...']
        assessment = dict(gate_failures=['FAIL detour B.Cu /A: 1 of 1 crossings ... detour 9.4 mm',
                                         'FAIL unknown-driver B.Cu /C: ...'],
                          gate_warnings=['WARN unproved-fastest-edge B.Cu /A: ...'])
        fails, report = sp.planes_outcome(['FAIL plane-cut In1.Cu /X: 1.0 mm of track'], enforced, assessment)
        # /B is found by the enforced screen only: it stays counted (no loosening)
        self.assertEqual(fails, ['FAIL plane-cut In1.Cu /X: 1.0 mm of track'] + enforced)
        warns = [line for line in report if line.startswith('WARN D-124d-proposed')]
        self.assertEqual(warns, ['WARN D-124d-proposed unknown-driver B.Cu /C: ...'])
        self.assertIn('WARN unproved-fastest-edge B.Cu /A: ...', report)

    def test_d124c_class_applies_to_its_nets(self):
        s = spec(edge_classes={'rs485': ['/RS485_A']})
        tr, label = sp.d124c_net_edge_of('/RS485_A', s, {})
        self.assertEqual(tr, s['_edge_rates']['rs485']['tr_ns'])
        self.assertTrue(label.startswith('class rs485'))
        self.assertEqual(sp.d124c_net_edge_of('/OTHER', s, {'/OTHER': {'unknown': 'x'}}), (None, 'x'))

    def test_d124c_detour_counts_a_blocked_path_and_a_stub(self):
        ok = lambda x, y: not (0.9 < x < 1.1 and -2 < y < 2)   # a slot across the direct path
        self.assertEqual(sp.d124c_detour_mm(ok, [(0, 0, .1)], 10, 0.1), 0.0)
        d = sp.d124c_detour_mm(ok, [(0, 0, .1), (2, 0, .1)], 20, 0.1)
        self.assertIsNotNone(d)
        self.assertGreater(d, 4.0)
        self.assertIsNone(sp.d124c_detour_mm(ok, [(0, 0, .1), (2, 0, .1)], 2, 0.1))


if __name__ == '__main__':
    unittest.main()
