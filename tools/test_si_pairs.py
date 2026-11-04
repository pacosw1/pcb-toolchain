#!/usr/bin/env python3
"""Tests for the pure core of si_pairs.py. Run: python3 tools/test_si_pairs.py (no pcbnew needed)."""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import si_pairs as sp  # noqa: E402

# JLC04161H-7628 outer layer (jlcpcb.com/impedance, read 2026-09-26): 1 oz copper, 7628 prepreg 0.2104 mm, Er 4.4.
T, H, ER = 0.035, 0.2104, 4.4


def pct(a, b):
    return abs(a - b) / b * 100


class Calculator(unittest.TestCase):
    def test_air_microstrip_matches_textbook(self):
        # Hammerstad-Jensen, w/h = 1, zero thickness, Er = 1: 126.5 ohm (Pozar, Microwave Engineering, fig. 3.26).
        self.assertAlmostEqual(sp.microstrip_z0(1.0, 1.0, 0.0, 1.0), 126.5, delta=0.5)

    def test_jlc_50_ohm_single_uncoated(self):
        # JLC calculator for JLC04161H-7628 top: 50 ohm at w = 0.3244 mm (JITX JLC04161H_7628.RS_50).
        # The JLC value includes solder mask (Er 3.8), which lowers Z. The uncoated model must be above 50
        # and within 10 %.
        z = sp.microstrip_z0(0.3244, H, T, ER)
        self.assertGreater(z, 50.0)
        self.assertLess(pct(z, 50.0), 10.0)

    def test_jlc_pair_holdout(self):
        # JLC calculator: 90 ohm at w 0.2332 / s 0.15 (DRS_90), 100 ohm at w 0.1722 / s 0.15 (DRS_100).
        # Fit the mask factor on DRS_90 only, then predict DRS_100 within 2 %.
        k = 90.0 / sp.microstrip_zdiff(0.2332, 0.15, H, T, ER)
        self.assertLess(pct(k * sp.microstrip_zdiff(0.1722, 0.15, H, T, ER), 100.0), 2.0)

    def test_wider_gap_raises_zdiff(self):
        self.assertGreater(sp.microstrip_zdiff(0.2, 0.3, H, T, ER), sp.microstrip_zdiff(0.2, 0.15, H, T, ER))

    def test_stripline_ipc2141(self):
        # IPC-2141 symmetric stripline: Z0 = 60/sqrt(Er) ln(4b / (0.67 pi (0.8w + t))).
        # b = 1.0, w = 0.2, t = 0.0152, Er = 4.6: 60/2.1448 * ln(4 / 0.3687) = 66.7 ohm (hand calculation).
        self.assertAlmostEqual(sp.stripline_z0(0.2, 1.0, 0.0152, 4.6), 66.7, delta=0.3)


STACKUP_TEXT = """
  (stackup
   (layer "F.Mask" (type "Top Solder Mask") (thickness 0.01) (material "LPI") (epsilon_r 3.8))
   (layer "F.Cu" (type "copper") (thickness 0.035))
   (layer "dielectric 1" (type "prepreg") (thickness 0.2104) (material "7628") (epsilon_r 4.4) (loss_tangent 0.02))
   (layer "In1.Cu" (type "copper") (thickness 0.0152))
   (layer "dielectric 2" (type "core") (thickness 1.065) (material "FR4") (epsilon_r 4.6) (loss_tangent 0.02))
   (layer "In2.Cu" (type "copper") (thickness 0.0152))
   (copper_finish "HAL lead-free")
  )
"""

LAYERS = {'F.Cu': {'model': 'microstrip', 't_mm': 0.035, 'h_mm': 0.2104, 'er': 4.4, 'ref_layer': 'In1.Cu',
                   'mask_factor_diff': 0.884}}


class Stackup(unittest.TestCase):
    def test_parse_copper_and_dielectric_below(self):
        st = sp.parse_stackup(STACKUP_TEXT)
        self.assertEqual(st['F.Cu'], {'t_mm': 0.035, 'h_mm': 0.2104, 'er': 4.4})

    def test_spec_agrees(self):
        sp.check_stackup(LAYERS, sp.parse_stackup(STACKUP_TEXT))

    def test_spec_disagrees_raises(self):
        bad = {'F.Cu': dict(LAYERS['F.Cu'], h_mm=0.0994)}
        with self.assertRaises(sp.SpecError):
            sp.check_stackup(bad, sp.parse_stackup(STACKUP_TEXT))


DRU_TEXT = """
# comment (rule "not a rule")
(rule "USB 90R diff pair"
  (condition "A.inDiffPair('/USB_D')")
  (constraint track_width (min 0.22mm) (opt 0.22mm) (max 0.22mm))
  (constraint diff_pair_gap (min 0.12mm) (opt 0.13mm)))

(rule "Other"
  (constraint clearance (min 0.5mm)))
"""


class Dru(unittest.TestCase):
    def test_parse_rule_constraints(self):
        r = sp.parse_dru_rule(DRU_TEXT, 'USB 90R diff pair')
        self.assertEqual(r['track_width'], {'min': 0.22, 'opt': 0.22, 'max': 0.22})
        self.assertEqual(r['diff_pair_gap'], {'min': 0.12, 'opt': 0.13})

    def test_missing_rule_raises(self):
        with self.assertRaises(sp.SpecError):
            sp.parse_dru_rule(DRU_TEXT, 'Nope')

    def test_zdiff_window_uses_the_corners(self):
        # Z falls with width and rises with gap: low corner (w max, gap min), high corner (w min, gap max).
        rule = {'track_width': {'min': 0.2, 'opt': 0.22, 'max': 0.24}, 'diff_pair_gap': {'min': 0.12, 'opt': 0.13}}
        lo, nom, hi = sp.zdiff_window(LAYERS['F.Cu'], rule)
        self.assertAlmostEqual(lo, sp.zdiff(LAYERS['F.Cu'], 0.24, 0.12))
        self.assertAlmostEqual(nom, sp.zdiff(LAYERS['F.Cu'], 0.22, 0.13))
        self.assertAlmostEqual(hi, sp.zdiff(LAYERS['F.Cu'], 0.2, 0.13))

    def test_rule_without_gap_raises(self):
        with self.assertRaises(sp.SpecError):
            sp.zdiff_window(LAYERS['F.Cu'], {'track_width': {'opt': 0.2}})


def seg(x1, y1, x2, y2, w=0.22, layer='F.Cu'):
    return (layer, x1, y1, x2, y2, w)


P = {'segs': [seg(0, 0, 10, 0)]}
N = {'segs': [seg(0, 0.35, 10, 0.35)]}


def board(p=P, n=N, ref=lambda layer, x, y: {'GND'}, vias=None):
    return {'stackup': sp.parse_stackup(STACKUP_TEXT), 'nets': {'/DP': p, '/DN': n}, 'ref_at': ref,
            'dru': DRU_TEXT, 'vias': vias or {}}


# A gap in the reference plane between x 4 and 6 (a 2 mm hole), the rest fully covered. 10 mm track.
def ref_with_gap(layer, x, y):
    return set() if 4 <= x <= 6 else {'GND'}


PAIR = {'name': 'USB', 'p': '/DP', 'n': '/DN', 'z_diff': 90, 'tol_pct': 10, 'dru_rule': 'USB 90R diff pair',
        'reference': 'GND'}


def status(rows):
    return {r['check']: r['status'] for r in rows}


class Evaluate(unittest.TestCase):
    def spec(self, **kw):
        return {'stackup': {'layers': LAYERS}, 'pairs': [dict(PAIR, **kw)]}

    def test_good_pair_passes(self):
        rows = sp.evaluate(self.spec(), board())
        self.assertEqual(status(rows), {'zdiff F.Cu': 'PASS', 'reference p': 'PASS', 'reference n': 'PASS'}, rows)

    def test_zdiff_off_target_fails(self):
        self.assertEqual(status(sp.evaluate(self.spec(z_diff=120), board()))['zdiff F.Cu'], 'FAIL')

    def test_reference_gap_under_one_leg_fails(self):
        def ref(layer, x, y):
            return set() if y > 0.1 and x > 5 else {'GND'}
        st = status(sp.evaluate(self.spec(), board(ref=ref)))
        self.assertEqual((st['reference p'], st['reference n']), ('PASS', 'FAIL'))

    def test_reference_may_list_nets(self):
        def ref(layer, x, y):
            return {'GND'} if x < 5 else {'VDD'}
        st = status(sp.evaluate(self.spec(reference=['GND', 'VDD']), board(ref=ref)))
        self.assertEqual(st['reference p'], 'PASS')

    def test_missing_net_raises(self):
        with self.assertRaises(sp.SpecError):
            sp.evaluate(self.spec(p='/NOPE'), board())

    def test_layer_without_model_raises(self):
        p = dict(P, segs=P['segs'] + [seg(0, 0, 1, 1, layer='B.Cu')])
        with self.assertRaises(sp.SpecError):
            sp.evaluate(self.spec(), board(p=p))

    def test_single_ended_net_reference(self):
        spec = {'stackup': {'layers': LAYERS}, 'pairs': [],
                'nets': [{'name': 'SCK', 'net': '/DN', 'reference': 'GND'}]}
        self.assertEqual(status(sp.evaluate(spec, board())), {'reference': 'PASS'})


class ViaAntipadRadius(unittest.TestCase):
    def test_radius_is_half_width_plus_the_largest_zone_clearance(self):
        self.assertAlmostEqual(sp.via_antipad_radius(0.6, [0.3, 0.2]), 0.6)

    def test_no_clearance_is_just_half_the_via_width(self):
        self.assertAlmostEqual(sp.via_antipad_radius(0.6, []), 0.3)


class ExemptAreas(unittest.TestCase):
    def spec(self, **kw):
        return {'stackup': {'layers': LAYERS}, 'pairs': [dict(PAIR, **kw)]}

    def test_gap_fails_without_exemption(self):
        st = status(sp.evaluate(self.spec(), board(ref=ref_with_gap)))
        self.assertEqual((st['reference p'], st['reference n']), ('FAIL', 'FAIL'))

    def test_exempt_area_removes_gap_from_coverage(self):
        areas = [{'layer': 'F.Cu', 'rect': [4, -1, 6, 1], 'reason': 'via keepout, see ECO-12'}]
        rows = sp.evaluate(self.spec(exempt_areas=areas), board(ref=ref_with_gap))
        st = status(rows)
        self.assertEqual((st['reference p'], st['reference n']), ('PASS', 'PASS'))

    def test_exempt_area_length_is_reported(self):
        areas = [{'layer': 'F.Cu', 'rect': [4, -1, 6, 1], 'reason': 'via keepout'}]
        rows = sp.evaluate(self.spec(exempt_areas=areas), board(ref=ref_with_gap))
        exempt_rows = [r for r in rows if r['check'] == 'exempt area']
        self.assertEqual(len(exempt_rows), 1)
        self.assertIn('4.0', exempt_rows[0]['detail'])  # 2 mm on each of p and n

    def test_exempt_area_needs_a_reason(self):
        areas = [{'layer': 'F.Cu', 'rect': [4, -1, 6, 1], 'reason': ''}]
        with self.assertRaises(sp.SpecError):
            sp.evaluate(self.spec(exempt_areas=areas), board(ref=ref_with_gap))

    def test_stale_exempt_area_raises(self):
        # This area touches no track: it removes nothing, so it is stale.
        areas = [{'layer': 'F.Cu', 'rect': [100, 100, 110, 110], 'reason': 'unused'}]
        with self.assertRaisesRegex(sp.SpecError, 'STALE exempt_area'):
            sp.evaluate(self.spec(exempt_areas=areas), board(ref=ref_with_gap))

    def test_top_level_exempt_areas_apply_to_every_pair(self):
        spec = {'stackup': {'layers': LAYERS}, 'pairs': [dict(PAIR)],
                'exempt_areas': [{'layer': 'F.Cu', 'rect': [4, -1, 6, 1], 'reason': 'via keepout'}]}
        st = status(sp.evaluate(spec, board(ref=ref_with_gap)))
        self.assertEqual(st['reference p'], 'PASS')

    def test_pair_level_exempt_areas_overrides_top_level(self):
        # The pair opts out with an empty list, so the top-level area does not apply to it.
        spec = {'stackup': {'layers': LAYERS}, 'pairs': [dict(PAIR, exempt_areas=[])],
                'exempt_areas': [{'layer': 'F.Cu', 'rect': [4, -1, 6, 1], 'reason': 'via keepout'}]}
        with self.assertRaisesRegex(sp.SpecError, 'STALE exempt_area'):
            sp.evaluate(spec, board(ref=ref_with_gap))


class ViaAntipadAllowance(unittest.TestCase):
    def spec(self, **kw):
        return {'stackup': {'layers': LAYERS}, 'pairs': [dict(PAIR, **kw)]}

    def test_gap_near_a_same_net_via_is_allowed(self):
        # A via of /DP at (5, 0) with a 1.5 mm allowance radius covers the whole x 4..6 gap.
        vias = {'/DP': [(5, 0, 1.5)], '/DN': [(5, 0.35, 1.5)]}
        rows = sp.evaluate(self.spec(via_antipad_allowance=True), board(ref=ref_with_gap, vias=vias))
        st = status(rows)
        self.assertEqual((st['reference p'], st['reference n']), ('PASS', 'PASS'))

    def test_allowance_is_off_by_default(self):
        vias = {'/DP': [(5, 0, 1.5)], '/DN': [(5, 0.35, 1.5)]}
        st = status(sp.evaluate(self.spec(), board(ref=ref_with_gap, vias=vias)))
        self.assertEqual(st['reference p'], 'FAIL')

    def test_allowed_length_is_reported(self):
        vias = {'/DP': [(5, 0, 1.5)], '/DN': [(5, 0.35, 1.5)]}
        rows = sp.evaluate(self.spec(via_antipad_allowance=True), board(ref=ref_with_gap, vias=vias))
        allow_rows = [r for r in rows if r['check'] == 'via antipad' and r['status'] == 'INFO']
        self.assertEqual(len(allow_rows), 1)
        self.assertIn('4.0', allow_rows[0]['detail'])  # 2 mm gap x 2 legs

    def test_allowance_over_1_5_mm_per_via_warns(self):
        vias = {'/DP': [(5, 0, 1.5)], '/DN': [(5, 0.35, 1.5)]}
        rows = sp.evaluate(self.spec(via_antipad_allowance=True), board(ref=ref_with_gap, vias=vias))
        warns = [r for r in rows if r['status'] == 'WARN']
        self.assertTrue(warns, rows)

    def test_small_allowance_does_not_warn(self):
        # A 0.5 mm gap next to the via stays under the 1.5 mm-per-via bound.
        def ref_small_gap(layer, x, y):
            return set() if 4.75 <= x <= 5.25 else {'GND'}
        vias = {'/DP': [(5, 0, 1.5)], '/DN': [(5, 0.35, 1.5)]}
        rows = sp.evaluate(self.spec(via_antipad_allowance=True), board(ref=ref_small_gap, vias=vias))
        self.assertFalse([r for r in rows if r['status'] == 'WARN'], rows)


class Arc(unittest.TestCase):
    def test_quarter_circle_chords(self):
        # Start (1, 0), mid (cos 45, sin 45), end (0, 1): radius 1, length pi / 2.
        m = math.sqrt(0.5)
        pts = sp.arc_points((1, 0), (m, m), (0, 1), max_chord=0.05)
        self.assertEqual(pts[0], (1, 0))
        self.assertEqual(pts[-1], (0, 1))
        L = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))
        self.assertAlmostEqual(L, math.pi / 2, delta=0.002)


class FullCoverage(unittest.TestCase):
    def test_full_coverage_is_exactly_100_pct(self):
        # POE-ETHERNET ETH_RXP (2026-09-26): hit == tot, but 100 * hit / tot gave 99.99999999999999.
        net = {'segs': [('F.Cu', 135.788, 113.7, 133.475, 113.7, 0.2), ('F.Cu', 135.838, 113.75, 135.788, 113.7, 0.2),
                        ('F.Cu', 133.475, 113.7, 133.05, 114.05, 0.2)]}
        layers = {'F.Cu': {'ref_layer': 'In1.Cu'}}
        ref_at = lambda layer, x, y: {'GND'}  # noqa: E731
        self.assertEqual(sp.coverage_detail(net, layers, 'GND', ref_at)['pct'], 100.0)
        self.assertEqual(sp.ref_coverage([net], layers, 'GND', ref_at), 100.0)


if __name__ == '__main__':
    unittest.main()
