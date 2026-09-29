#!/usr/bin/env python3
"""Unit tests for the pure core of tools/si_planes.py (no pcbnew).

  python3 tools/test_si_planes.py
"""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('si_planes', os.path.join(HERE, 'si_planes.py'))
sp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sp)


def base_spec(**extra):
    s = {'about': 'test board',
         'adjacent': {'F.Cu': 'In1.Cu', 'B.Cu': 'In2.Cu'},
         'plane_layers': ['In1.Cu', 'In2.Cu'],
         'grounds': ['GND', 'ISO_0V']}
    s.update(extra)
    return s


class SampleTest(unittest.TestCase):
    def test_segment_samples_cover_length(self):
        pts = sp.sample_segment((0, 0), (1, 0), 0.25)
        self.assertEqual(len(pts), 4)
        self.assertAlmostEqual(sum(w for _, _, w in pts), 1.0)
        self.assertAlmostEqual(pts[0][0], 0.125)
        self.assertAlmostEqual(pts[-1][0], 0.875)

    def test_short_segment_gives_one_sample(self):
        pts = sp.sample_segment((0, 0), (0, 0.1), 0.25)
        self.assertEqual(len(pts), 1)
        self.assertAlmostEqual(pts[0][2], 0.1)

    def test_zero_length_segment_gives_no_sample(self):
        self.assertEqual(sp.sample_segment((1, 1), (1, 1), 0.25), [])

    def test_arc_samples_lie_on_circle_and_sum_to_arc_length(self):
        # A half circle of radius 1 around (0, 0), through (0, 1).
        pts = sp.sample_arc((1, 0), (0, 1), (-1, 0), 0.25)
        for x, y, _ in pts:
            self.assertAlmostEqual(x * x + y * y, 1.0, places=6)
            self.assertGreater(y, 0)
        self.assertAlmostEqual(sum(w for _, _, w in pts), 3.14159265, places=5)

    def test_arc_other_direction(self):
        pts = sp.sample_arc((1, 0), (0, -1), (-1, 0), 0.25)
        self.assertTrue(all(y < 0 for _, y, _ in pts))


class SpecTest(unittest.TestCase):
    def test_minimal_spec_gets_defaults(self):
        s = sp.load_spec(base_spec())
        self.assertEqual(s['max_unreferenced_mm'], 1.0)
        self.assertEqual(s['via_allow_mm'], 0.6)
        self.assertEqual(s['step_mm'], 0.25)

    def test_missing_key_is_an_error(self):
        bad = base_spec()
        del bad['grounds']
        with self.assertRaises(sp.SpecError):
            sp.load_spec(bad)

    def test_two_layer_board_with_empty_plane_layers_loads(self):
        self.assertEqual(sp.load_spec(base_spec(adjacent={'F.Cu': 'B.Cu'}, plane_layers=[]))['plane_layers'], [])

    def test_missing_plane_layers_is_still_an_error(self):
        bad = base_spec()
        del bad['plane_layers']
        with self.assertRaises(sp.SpecError):
            sp.load_spec(bad)

    def test_empty_grounds_is_still_an_error(self):
        with self.assertRaises(sp.SpecError):
            sp.load_spec(base_spec(grounds=[]))

    def test_unknown_key_is_an_error(self):
        with self.assertRaises(sp.SpecError):
            sp.load_spec(base_spec(max_gap=3))

    def test_exempt_net_without_reason_is_an_error(self):
        with self.assertRaises(sp.SpecError):
            sp.load_spec(base_spec(exempt={'nets': {'VIN': ''}}))

    def test_exempt_area_without_reason_is_an_error(self):
        with self.assertRaises(sp.SpecError):
            sp.load_spec(base_spec(exempt={'areas': [{'box': [0, 0, 1, 1], 'nets': ['/A']}]}))

    def test_alt_ref_needs_domain_and_reason(self):
        with self.assertRaises(sp.SpecError):
            sp.load_spec(base_spec(alt_refs={'VDD_3V3': {'domain': 'GND'}}))
        with self.assertRaises(sp.SpecError):
            sp.load_spec(base_spec(alt_refs={'VDD_3V3': {'domain': 'NOPE', 'reason': 'x'}}))

    def test_domain_override_must_name_a_ground(self):
        with self.assertRaises(sp.SpecError):
            sp.load_spec(base_spec(domains={'NOPE': ['/A*']}))

    def test_board_check_rejects_stale_names(self):
        s = sp.load_spec(base_spec(exempt={'nets': {'VIN': 'power'}}))
        with self.assertRaises(sp.SpecError):
            sp.check_against_board(s, nets={'GND', 'ISO_0V'}, layers={'F.Cu', 'B.Cu', 'In1.Cu', 'In2.Cu'})
        with self.assertRaises(sp.SpecError):
            sp.check_against_board(s, nets={'GND', 'ISO_0V', 'VIN'}, layers={'F.Cu', 'B.Cu'})
        sp.check_against_board(s, nets={'GND', 'ISO_0V', 'VIN'}, layers={'F.Cu', 'B.Cu', 'In1.Cu', 'In2.Cu'})


class DomainTest(unittest.TestCase):
    def test_majority_of_pads(self):
        s = sp.load_spec(base_spec())
        self.assertEqual(sp.net_domain('/X', ['GND', 'GND', 'ISO_0V', None], s), 'GND')

    def test_no_pad_in_a_ground_zone_gives_none(self):
        s = sp.load_spec(base_spec())
        self.assertIsNone(sp.net_domain('/X', [None, None], s))

    def test_tie_gives_none(self):
        s = sp.load_spec(base_spec())
        self.assertIsNone(sp.net_domain('/X', ['GND', 'ISO_0V'], s))

    def test_override_pattern_wins(self):
        s = sp.load_spec(base_spec(domains={'ISO_0V': ['/AI*']}))
        self.assertEqual(sp.net_domain('/AI1_ADC', ['GND', 'GND'], s), 'ISO_0V')

    def test_alt_ref_zone_counts_for_its_domain(self):
        s = sp.load_spec(base_spec(alt_refs={'VDD_3V3': {'domain': 'GND', 'reason': 'decoupled power plane'}}))
        self.assertEqual(sp.net_domain('/X', ['VDD_3V3', 'VDD_3V3', 'ISO_0V'], s), 'GND')


def track(x0, x1, y=0.0):
    return sp.sample_segment((x0, y), (x1, y), 0.25)


class EvaluateTest(unittest.TestCase):
    def setUp(self):
        self.spec = sp.load_spec(base_spec())

    def test_fully_referenced(self):
        r = sp.evaluate_net(track(0, 10), lambda x, y: 'GND', 'GND', [], self.spec)
        self.assertAlmostEqual(r['length'], 10)
        self.assertAlmostEqual(r['unref'], 0)
        self.assertEqual(r['worst'], 0)
        self.assertEqual(r['cross'], 0)

    def test_slot_crossing_gives_worst_run(self):
        # A 2 mm slot in the plane from x = 4 to x = 6.
        ref = lambda x, y: None if 4 < x < 6 else 'GND'
        r = sp.evaluate_net(track(0, 10), ref, 'GND', [], self.spec)
        self.assertAlmostEqual(r['unref'], 2.0)
        self.assertAlmostEqual(r['worst'], 2.0)
        self.assertAlmostEqual(r['worst_at'][0], 5.0, delta=0.2)

    def test_run_continues_across_a_bend(self):
        pts = sp.sample_segment((0, 0), (1, 0), 0.25) + sp.sample_segment((1, 0), (1, 1), 0.25)
        r = sp.evaluate_net(pts, lambda x, y: None, 'GND', [], self.spec)
        self.assertAlmostEqual(r['worst'], 2.0)

    def test_two_separate_gaps_are_two_runs(self):
        ref = lambda x, y: None if (1 < x < 2 or 5 < x < 6.5) else 'GND'
        r = sp.evaluate_net(track(0, 10), ref, 'GND', [], self.spec)
        self.assertAlmostEqual(r['unref'], 2.5)
        self.assertAlmostEqual(r['worst'], 1.5)

    def test_antipad_run_near_own_via_is_ok(self):
        # The track ends at a via at x = 10 (radius 0.3). The plane has an antipad to x = 9.5.
        ref = lambda x, y: None if x > 9.5 else 'GND'
        r = sp.evaluate_net(track(0, 10), ref, 'GND', [(10, 0, 0.3)], self.spec)
        self.assertAlmostEqual(r['unref'], 0.5)
        self.assertEqual(r['worst'], 0)

    def test_run_longer_than_via_allowance_still_counts(self):
        # Gap from x = 7 to 10; only the part within 0.3 + 0.6 mm of the via is excused.
        ref = lambda x, y: None if x > 7 else 'GND'
        r = sp.evaluate_net(track(0, 10), ref, 'GND', [(10, 0, 0.3)], self.spec)
        self.assertAlmostEqual(r['worst'], 2.0, delta=0.15)

    def test_wrong_domain_is_a_crossing(self):
        ref = lambda x, y: 'ISO_0V' if x > 8 else 'GND'
        r = sp.evaluate_net(track(0, 10), ref, 'GND', [], self.spec)
        self.assertAlmostEqual(r['cross'], 2.0)
        self.assertEqual(r['cross_net'], 'ISO_0V')
        self.assertAlmostEqual(r['worst'], 2.0)

    def test_crossing_near_own_via_is_ok(self):
        ref = lambda x, y: 'ISO_0V' if x > 9.8 else 'GND'
        r = sp.evaluate_net(track(0, 10), ref, 'GND', [(10, 0, 0.3)], self.spec)
        self.assertEqual(r['cross'], 0)

    def test_alt_ref_of_same_domain_is_a_reference(self):
        s = sp.load_spec(base_spec(alt_refs={'VDD_3V3': {'domain': 'GND', 'reason': 'decoupled'}}))
        r = sp.evaluate_net(track(0, 4), lambda x, y: 'VDD_3V3', 'GND', [], s)
        self.assertAlmostEqual(r['unref'], 0)

    def test_other_net_plane_is_not_a_reference(self):
        r = sp.evaluate_net(track(0, 4), lambda x, y: 'BACKUP_5V', 'GND', [], self.spec)
        self.assertAlmostEqual(r['unref'], 4.0)
        self.assertEqual(r['cross'], 0)

    def test_no_domain_means_nothing_is_a_reference(self):
        r = sp.evaluate_net(track(0, 4), lambda x, y: 'GND', None, [], self.spec)
        self.assertAlmostEqual(r['unref'], 4.0)

    def test_exempt_area_excuses_samples(self):
        s = sp.load_spec(base_spec(exempt={'areas': [{'box': [3, -1, 7, 1], 'nets': ['/A'], 'reason': 'no plane under RJ45'}]}))
        ref = lambda x, y: None if 4 < x < 6 else 'GND'
        r = sp.evaluate_net(track(0, 10), ref, 'GND', [], s, net='/A')
        self.assertEqual(r['worst'], 0)
        r = sp.evaluate_net(track(0, 10), ref, 'GND', [], s, net='/B')
        self.assertAlmostEqual(r['worst'], 2.0)


class FailureTest(unittest.TestCase):
    def setUp(self):
        self.spec = sp.load_spec(base_spec(exempt={'nets': {'VIN': 'power net, wide pour'}}))

    def res(self, **kw):
        r = {'length': 10.0, 'unref': 0.0, 'worst': 0.0, 'worst_at': (0, 0), 'cross': 0.0, 'cross_net': None}
        r.update(kw)
        return r

    def test_gap_over_limit_fails(self):
        fails = sp.reference_failures({('B.Cu', '/A'): self.res(worst=1.5, unref=2.0)}, {'/A': 'GND'}, self.spec)
        self.assertEqual(len(fails), 1)
        self.assertTrue(fails[0].startswith('FAIL'))
        self.assertIn('/A', fails[0])

    def test_gap_at_limit_passes(self):
        self.assertEqual(sp.reference_failures({('B.Cu', '/A'): self.res(worst=1.0)}, {'/A': 'GND'}, self.spec), [])

    def test_exempt_net_does_not_fail(self):
        self.assertEqual(sp.reference_failures({('B.Cu', 'VIN'): self.res(worst=5, unref=5)}, {'VIN': 'GND'}, self.spec), [])

    def test_ground_net_is_not_checked(self):
        self.assertEqual(sp.reference_failures({('F.Cu', 'GND'): self.res(worst=5, unref=5)}, {'GND': 'GND'}, self.spec), [])

    def test_crossing_fails_separately(self):
        fails = sp.reference_failures({('F.Cu', '/A'): self.res(cross=0.5, cross_net='ISO_0V', worst=0.5)}, {'/A': 'GND'}, self.spec)
        self.assertEqual(len(fails), 1)
        self.assertIn('ISO_0V', fails[0])

    def test_no_domain_fails(self):
        fails = sp.reference_failures({('F.Cu', '/A'): self.res(worst=10, unref=10)}, {'/A': None}, self.spec)
        self.assertTrue(any('domain' in f for f in fails))

    def test_plane_cut_fails_per_net(self):
        fails = sp.plane_cut_failures({('In2.Cu', '/A'): 12.34, ('In2.Cu', '/B'): 1.0}, self.spec)
        self.assertEqual(len(fails), 2)
        self.assertIn('12.3', fails[0])

    def test_plane_cut_by_exempt_net_still_fails(self):
        self.assertEqual(len(sp.plane_cut_failures({('In2.Cu', 'VIN'): 3.0}, self.spec)), 1)

    def test_track_on_non_plane_layer_is_not_a_cut(self):
        self.assertEqual(sp.plane_cut_failures({('F.Cu', '/A'): 3.0}, self.spec), [])


MIXED = {'In2.Cu': {'allow': 'slow', 'fast_file': 'fast.json', 'power': ['GND', 'VBUS', '/P*'],
                    'reason': 'user decision'}}


class MixedLayerTest(unittest.TestCase):
    def setUp(self):
        self.spec = sp.load_spec(base_spec(mixed_layers=MIXED))
        sp.set_fast(self.spec, {'In2.Cu': ['/USB_*', '/SCK*']})

    def res(self, **kw):
        r = {'length': 10.0, 'unref': 0.0, 'worst': 0.0, 'worst_at': (0, 0), 'cross': 0.0, 'cross_net': None}
        r.update(kw)
        return r

    def test_spec_needs_a_plane_layer_a_reason_and_allow_slow(self):
        for bad in ({'In3.Cu': MIXED['In2.Cu']},
                    {'In2.Cu': dict(MIXED['In2.Cu'], reason='')},
                    {'In2.Cu': dict(MIXED['In2.Cu'], allow='all')},
                    {'In2.Cu': dict(MIXED['In2.Cu'], power='GND')},
                    {'In2.Cu': {k: v for k, v in MIXED['In2.Cu'].items() if k != 'fast_file'}}):
            with self.assertRaises(sp.SpecError):
                sp.load_spec(base_spec(mixed_layers=bad))

    def test_fast_file_must_be_a_list_of_patterns(self):
        self.assertEqual(sp.parse_fast({'fast': ['/A*']}, 'f.json'), ['/A*'])
        for bad in ({}, {'fast': '/A*'}, {'fast': []}, {'fast': [1]}):
            with self.assertRaises(sp.SpecError):
                sp.parse_fast(bad, 'f.json')

    def test_missing_fast_file_fails_closed(self):
        with self.assertRaises(sp.SpecError):
            sp.load_fast(self.spec, '/no/such/dir')

    def test_net_kind(self):
        m = self.spec['mixed_layers']['In2.Cu']
        self.assertEqual(sp.net_kind('/USB_DP', m, self.spec), 'fast')
        self.assertEqual(sp.net_kind('VBUS', m, self.spec), 'power')
        self.assertEqual(sp.net_kind('/PROBE_3V3', m, self.spec), 'power')
        self.assertEqual(sp.net_kind('ISO_0V', m, self.spec), 'power')   # every ground is power
        self.assertEqual(sp.net_kind('/EN', m, self.spec), 'slow')

    def test_slow_net_on_mixed_layer_is_not_a_cut(self):
        self.assertEqual(sp.plane_cut_failures({('In2.Cu', '/EN'): 5.0}, self.spec), [])

    def test_fast_and_power_on_mixed_layer_fail(self):
        fails = sp.plane_cut_failures({('In2.Cu', '/SCK'): 2.0, ('In2.Cu', 'VBUS'): 1.0}, self.spec)
        self.assertEqual(len(fails), 2)
        self.assertTrue(any('/SCK' in f and 'fast' in f for f in fails))
        self.assertTrue(any('VBUS' in f and 'power' in f for f in fails))

    def test_slow_net_on_solid_plane_still_fails(self):
        self.assertEqual(len(sp.plane_cut_failures({('In1.Cu', '/EN'): 1.0}, self.spec)), 1)

    def test_fast_net_over_mixed_layer_allows_no_gap(self):
        fails = sp.reference_failures({('B.Cu', '/USB_DP'): self.res(worst=0.3, unref=0.3)}, {'/USB_DP': 'GND'}, self.spec)
        self.assertEqual(len(fails), 1)
        self.assertIn('fast', fails[0])

    def test_fast_net_on_other_layer_keeps_the_normal_limit(self):
        self.assertEqual(sp.reference_failures({('F.Cu', '/USB_DP'): self.res(worst=0.3, unref=0.3)},
                                               {'/USB_DP': 'GND'}, self.spec), [])

    def test_slow_net_over_mixed_layer_keeps_the_normal_limit(self):
        self.assertEqual(sp.reference_failures({('B.Cu', '/EN'): self.res(worst=0.9, unref=3)}, {'/EN': 'GND'}, self.spec), [])

    def test_island_without_ground_via_or_pad_fails(self):
        fails = sp.island_failures([('In2.Cu', 'GND', 3, (1, 2)), ('In2.Cu', 'GND', 0, (5.25, 6))])
        self.assertEqual(len(fails), 1)
        self.assertIn('island', fails[0])
        self.assertIn('(5.2, 6.0)', fails[0])

    def slow_only_spec(self):
        s = sp.load_spec(base_spec(mixed_layers=MIXED, alt_refs={
            '+3V3': {'domain': 'GND', 'slow_only': True, 'reason': 'decoupling cap to GND within 5 mm'}}))
        sp.set_fast(s, {'In2.Cu': ['/USB_*', '/SCK*']})
        return s

    def test_slow_only_alt_ref_is_a_reference_for_a_slow_net(self):
        r = sp.evaluate_net(track(0, 4), lambda x, y: '+3V3', 'GND', [], self.slow_only_spec(), net='/LED')
        self.assertAlmostEqual(r['unref'], 0)

    def test_slow_only_alt_ref_is_not_a_reference_for_a_fast_net(self):
        s = self.slow_only_spec()
        r = sp.evaluate_net(track(0, 4), lambda x, y: '+3V3', 'GND', [], s, net='/USB_DP')
        self.assertAlmostEqual(r['unref'], 4.0)
        fails = sp.reference_failures({('B.Cu', '/USB_DP'): r}, {'/USB_DP': 'GND'}, s)
        self.assertTrue(any('fast-unreferenced' in f for f in fails))

    def test_cap_mm_alt_ref_counts_only_near_a_decoupling_cap(self):
        s = sp.load_spec(base_spec(mixed_layers=MIXED, alt_refs={
            '+3V3': {'domain': 'GND', 'slow_only': True, 'cap_mm': 5, 'reason': 'decoupling cap to GND within 5 mm'}}))
        sp.set_fast(s, {'In2.Cu': ['/USB_*']})
        r = sp.evaluate_net(track(0, 10), lambda x, y: '+3V3', 'GND', [], s, net='/LED', caps={'+3V3': [(0, 3)]})
        self.assertAlmostEqual(r['unref'], 6.0)   # only the samples at x 0..4 are within 5 mm of the cap

    def test_cap_mm_must_be_a_positive_number(self):
        with self.assertRaises(sp.SpecError):
            sp.load_spec(base_spec(alt_refs={'+3V3': {'domain': 'GND', 'cap_mm': 0, 'reason': 'x'}}))

    def test_slow_only_must_be_a_bool(self):
        with self.assertRaises(sp.SpecError):
            sp.load_spec(base_spec(alt_refs={'+3V3': {'domain': 'GND', 'slow_only': 'yes', 'reason': 'x'}}))


class SlowLimitTest(unittest.TestCase):
    """Lead decision D8: slow nets min 95 % coverage and max 5 mm per gap; fast nets keep the 1.0 mm limit."""
    def setUp(self):
        self.spec = sp.load_spec(base_spec(mixed_layers=MIXED, slow_max_gap_mm=5.0, slow_min_coverage_pct=95))
        sp.set_fast(self.spec, {'In2.Cu': ['/SCK*']})

    def res(self, **kw):
        r = {'length': 100.0, 'unref': 0.0, 'bad': 0.0, 'worst': 0.0, 'worst_at': (0, 0), 'cross': 0.0, 'cross_net': None}
        r.update(kw)
        return r

    def fails(self, layer, net, **kw):
        return sp.reference_failures({(layer, net): self.res(**kw)}, {net: 'GND'}, self.spec)

    def test_slow_gap_up_to_5_mm_passes(self):
        self.assertEqual(self.fails('F.Cu', '/EN', worst=4.9, unref=4.9, bad=4.9), [])

    def test_slow_gap_over_5_mm_fails(self):
        self.assertEqual(len(self.fails('F.Cu', '/EN', worst=5.1, unref=5.1, bad=5.1)), 1)

    def test_slow_coverage_under_95_fails(self):
        f = self.fails('F.Cu', '/EN', worst=2.0, unref=6.0, bad=6.0)
        self.assertEqual(len(f), 1)
        self.assertIn('coverage', f[0])

    def test_fast_net_keeps_1_mm(self):
        self.assertEqual(len(self.fails('F.Cu', '/SCK', worst=1.5, unref=1.5, bad=1.5)), 1)

    def test_evaluate_net_reports_bad_length(self):
        s = sp.load_spec(base_spec())
        pts = [(x + 0.5, 0, 1.0) for x in range(10)]
        r = sp.evaluate_net(pts, lambda x, y: None if 2 <= x <= 5 else 'GND', 'GND', [], s)
        self.assertAlmostEqual(r['bad'], 3.0)

    def test_limits_must_be_numbers(self):
        with self.assertRaises(sp.SpecError):
            sp.load_spec(base_spec(slow_max_gap_mm='x'))


class StitchTest(unittest.TestCase):
    def test_farthest_point_from_vias(self):
        pts = [(0, 0), (3, 4), (10, 0)]
        self.assertAlmostEqual(sp.max_min_distance(pts, [(0, 0), (10, 0)]), 5.0)

    def test_no_via_gives_none(self):
        self.assertIsNone(sp.max_min_distance([(0, 0)], []))

    def test_no_points_gives_zero(self):
        self.assertEqual(sp.max_min_distance([], [(0, 0)]), 0.0)


if __name__ == '__main__':
    unittest.main()
