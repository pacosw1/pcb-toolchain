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


def seg(x1, y1, x2, y2, w=0.22, layer='F.Cu'):
    return (layer, x1, y1, x2, y2, w)


# A 10 mm pair on F.Cu at 0.37 mm pitch (w 0.22, gap 0.15). The p leg has a 1 mm fanout at the start and a 2 mm
# stub (for example to an ESD pad) at x = 5. Pads: A at the start, B at the end of each leg.
P = {'segs': [seg(-1, 0, 0, 0), seg(0, 0, 10, 0), seg(5, 0, 5, -2)], 'vias': [],
     'pads': {'A': [(-1, 0)], 'B': [(10, 0)]}}
N = {'segs': [seg(0, 0.37, 10, 0.37)], 'vias': [],
     'pads': {'A': [(0, 0.37)], 'B': [(10, 0.37)]}}


class Geometry(unittest.TestCase):
    def test_path_length_ignores_stub(self):
        self.assertAlmostEqual(sp.path_length(P, 'A', 'B'), 11.0, places=6)

    def test_path_length_missing_pad_raises(self):
        with self.assertRaises(sp.SpecError):
            sp.path_length(P, 'A', 'X')

    def test_pair_coupling(self):
        r = sp.analyze_pair(P, N, gap_tol=0.02)
        # About 0.1 mm of the fanout and the stub root are at the nominal gap, so 2.86 mm, not 3.0 mm.
        self.assertAlmostEqual(r['uncoupled_p'], 3.0, delta=0.2)
        self.assertAlmostEqual(r['uncoupled_n'], 0.0, delta=0.1)
        lay = r['layers']['F.Cu']
        self.assertAlmostEqual(lay['gap'], 0.15, places=3)
        self.assertEqual(lay['widths'], [0.22])


def board(p=P, n=N, ref=lambda layer, x, y: {'GND'}):
    return {'stackup': sp.parse_stackup(STACKUP_TEXT), 'nets': {'/DP': p, '/DN': n}, 'ref_at': ref}


PAIR = {'name': 'USB', 'p': '/DP', 'n': '/DN', 'p_pads': ['A', 'B'], 'n_pads': ['A', 'B'], 'z_diff': 90,
        'tol_pct': 10, 'max_skew_mm': 1.5, 'max_uncoupled_mm': 3.5, 'reference': 'GND'}


def status(rows):
    return {r['check']: r['status'] for r in rows}


class Evaluate(unittest.TestCase):
    def spec(self, **kw):
        return {'stackup': {'layers': LAYERS}, 'pairs': [dict(PAIR, **kw)]}

    def test_good_pair_passes(self):
        rows = sp.evaluate(self.spec(), board())
        self.assertEqual(set(status(rows).values()), {'PASS'}, rows)

    def test_zdiff_off_target_fails(self):
        self.assertEqual(status(sp.evaluate(self.spec(z_diff=120), board()))['zdiff F.Cu'], 'FAIL')

    def test_skew_fails(self):
        self.assertEqual(status(sp.evaluate(self.spec(max_skew_mm=0.5), board()))['skew'], 'FAIL')

    def test_uncoupled_fails(self):
        self.assertEqual(status(sp.evaluate(self.spec(max_uncoupled_mm=1), board()))['uncoupled'], 'FAIL')

    def test_unequal_vias_fail(self):
        p = dict(P, vias=[(5, 0)])
        self.assertEqual(status(sp.evaluate(self.spec(), board(p=p)))['vias'], 'FAIL')

    def test_reference_gap_fails(self):
        def ref(layer, x, y):
            return {'GND'} if x < 5 else set()
        self.assertEqual(status(sp.evaluate(self.spec(), board(ref=ref)))['reference'], 'FAIL')

    def test_never_coupled_pair_fails_not_error(self):
        n = dict(N, segs=[seg(0, 3, 10, 3)], pads={'A': [(0, 3)], 'B': [(10, 3)]})
        st = status(sp.evaluate(self.spec(), board(n=n)))
        self.assertEqual(st['coupling'], 'FAIL')
        self.assertEqual(st['uncoupled'], 'FAIL')

    def test_reference_may_list_nets(self):
        def ref(layer, x, y):
            return {'GND'} if x < 5 else {'VDD'}
        self.assertEqual(status(sp.evaluate(self.spec(reference=['GND', 'VDD']), board(ref=ref)))['reference'],
                         'PASS')

    def test_missing_net_raises(self):
        with self.assertRaises(sp.SpecError):
            sp.evaluate(self.spec(p='/NOPE'), board())

    def test_layer_without_model_raises(self):
        p = dict(P, segs=P['segs'] + [seg(0, 0, 1, 1, layer='B.Cu')])
        with self.assertRaises(sp.SpecError):
            sp.evaluate(self.spec(), board(p=p))

    def test_single_ended_net_length(self):
        spec = {'stackup': {'layers': LAYERS}, 'pairs': [],
                'nets': [{'name': 'SCK', 'net': '/DN', 'pads': ['A', 'B'], 'max_len_mm': 5, 'reference': 'GND'}]}
        st = status(sp.evaluate(spec, board()))
        self.assertEqual(st['length'], 'FAIL')
        self.assertEqual(st['reference'], 'PASS')


class Arc(unittest.TestCase):
    def test_quarter_circle_chords(self):
        # Start (1, 0), mid (cos 45, sin 45), end (0, 1): radius 1, length pi / 2.
        m = math.sqrt(0.5)
        pts = sp.arc_points((1, 0), (m, m), (0, 1), max_chord=0.05)
        self.assertEqual(pts[0], (1, 0))
        self.assertEqual(pts[-1], (0, 1))
        L = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))
        self.assertAlmostEqual(L, math.pi / 2, delta=0.002)


if __name__ == '__main__':
    unittest.main()
