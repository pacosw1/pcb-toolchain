#!/usr/bin/env python3
"""Unit tests for the pure core of tools/power_pour.py (no pcbnew, no kicad-cli).

  python3 tools/test_power_pour.py
"""
import importlib.util
import math
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, name + '.py'))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


pp = load('power_pour')
pt = load('pcbtool')

BOX = (0, 0, 100, 50)
VIA = {'dia': 0.8, 'drill': 0.4, 'plating': 0.018, 'dT': 10.0}
RULES = {'clr': 0.2, 'h2h': 0.25, 'gap': 0.2, 'edge': 0.3}


def depth(poly, q):
    """Distance of q inside poly (negative outside)."""
    return -pt.shape_dist(('poly', poly), q)


def pad(name, c, size=(1.0, 0.6), angle=0, fp_c=None, net='+3V3'):
    return {'name': name, 'net': net, 'c': c, 'size': size, 'angle': angle, 'fp_c': fp_c or c, 'layer': 'F.Cu'}


class RegionsTest(unittest.TestCase):
    def test_single_pad_region_holds_the_pad_with_margin(self):
        reg, conf = pp.regions({'A': [(20, 20)]}, BOX, margin=2.0, clearance=0.3)
        self.assertEqual(conf, [])
        self.assertGreaterEqual(depth(reg['A'], (20, 20)), 2.0 - 1e-6)
        self.assertLessEqual(max(math.dist(q, (20, 20)) for q in reg['A']), 2.0 / math.cos(math.pi / 16) + 1e-6)

    def test_every_pad_inside_by_the_margin(self):
        pts = [(10, 10), (30, 12), (22, 25), (15, 18)]
        reg, _ = pp.regions({'A': pts}, BOX, margin=1.5, clearance=0.3)
        for q in pts:
            self.assertGreaterEqual(depth(reg['A'], q), 1.5 - 1e-6)

    def test_region_is_clipped_to_the_board_box(self):
        reg, _ = pp.regions({'A': [(1, 1), (10, 1)]}, BOX, margin=3.0, clearance=0.3)
        for x, y in reg['A']:
            self.assertTrue(BOX[0] - 1e-9 <= x <= BOX[2] + 1e-9 and BOX[1] - 1e-9 <= y <= BOX[3] + 1e-9)

    def test_far_apart_nets_have_no_conflict(self):
        _, conf = pp.regions({'A': [(10, 10), (20, 10)], 'B': [(60, 30), (80, 30)]}, BOX, margin=2.0, clearance=0.3)
        self.assertEqual(conf, [])

    def test_interleaved_nets_are_a_conflict(self):
        _, conf = pp.regions({'A': [(10, 25), (40, 25)], 'B': [(25, 10), (25, 40)]}, BOX, margin=1.0, clearance=0.3)
        self.assertEqual([(a, b) for a, b, _ in conf], [('A', 'B')])
        self.assertEqual(conf[0][2], 0)

    def test_gap_below_the_clearance_is_a_conflict(self):
        # margin 1.0: each disk polygon reaches 1.0 to 1.02 mm, so a 2.14 mm pitch leaves a 0.10-0.14 mm gap
        _, conf = pp.regions({'A': [(10, 10)], 'B': [(12.14, 10)]}, BOX, margin=1.0, clearance=0.3)
        self.assertEqual(len(conf), 1)
        _, conf = pp.regions({'A': [(10, 10)], 'B': [(12.6, 10)]}, BOX, margin=1.0, clearance=0.3)
        self.assertEqual(conf, [])


class NetCheckTest(unittest.TestCase):
    def test_switch_nodes_are_refused(self):
        for n in ('/POWER/PWR_3V3_SW', 'SW', 'BUCK_LX', '/P/SW1'):
            self.assertIn('switch', pp.refused(n, fast=[], grounds=['GND']) or '', n)

    def test_fast_and_ground_nets_are_refused(self):
        self.assertIn('fast', pp.refused('/USB_DP', fast=['/USB_D*'], grounds=['GND']))
        self.assertIn('ground', pp.refused('GND', fast=[], grounds=['GND']))

    def test_rail_nets_pass(self):
        for n in ('+3V3', '5V_SYS', '24V_IO', 'VBUS', '/POWER/PWR_VIN_F'):
            self.assertIsNone(pp.refused(n, fast=['/USB_D*'], grounds=['GND']), n)


class CurrentTest(unittest.TestCase):
    SPEC = {'nets': {'+3V3': {'chains': [{'amps': 0.5, 'pads': ['L1.2', 'U1.75']}, {'amps': 0.2, 'pads': ['L1.2', 'C2.1']}]},
                     'V': {'amps': 3.0, 'pads': ['J1.1', 'F1.1']}}}

    def test_pad_current_is_the_largest_chain_through_it(self):
        self.assertEqual(pp.pad_currents(self.SPEC, '+3V3'), {'L1.2': 0.5, 'U1.75': 0.5, 'C2.1': 0.2})
        self.assertEqual(pp.pad_currents(self.SPEC, 'V'), {'J1.1': 3.0, 'F1.1': 3.0})
        self.assertEqual(pp.pad_currents(self.SPEC, 'NONE'), {})

    def test_via_count_uses_the_pcbtool_via_table(self):
        one = pt.via_amps(0.4)
        self.assertEqual(pp.via_count(0, VIA), 1)
        self.assertEqual(pp.via_count(0.5, VIA), 1)
        self.assertEqual(pp.via_count(one * 2.5, VIA), 3)
        self.assertEqual(pp.via_count(one * 2, VIA), 2)


def region_all():
    return [(-50, -50), (150, -50), (150, 100), (-50, 100)]


class ViaPlanTest(unittest.TestCase):
    def plan(self, p, amps=0.5, obstacles=None, smd=None, region=None, allow=(), taken=()):
        return pp.via_plan(p, amps, VIA, RULES, obstacles or {'F.Cu': [], 'B.Cu': [], 'In2.Cu': []},
                           smd if smd is not None else [(p['name'], (*p['c'], *p['size'], p['angle'], 0))],
                           region or region_all(), allow=allow, taken=list(taken))

    def test_one_via_outward_with_a_pad_width_stub(self):
        r = self.plan(pad('U1.1', (10, 10), fp_c=(8, 10)))
        self.assertEqual(r['n'], 1)
        (vx, vy), = r['vias']
        self.assertAlmostEqual(vy, 10)
        self.assertGreaterEqual(vx, 10 + 0.5 + RULES['gap'] + 0.4 - 1e-9)
        a, b, w = r['stub']
        self.assertEqual((a, b), ((10, 10), (vx, vy)))
        self.assertAlmostEqual(w, 0.6)

    def test_high_current_pad_gets_a_row_of_vias(self):
        r = self.plan(pad('U1.1', (10, 10), fp_c=(8, 10)), amps=pt.via_amps(0.4) * 1.5)
        self.assertEqual(r['n'], 2)
        (x1, y1), (x2, y2) = r['vias']
        self.assertGreaterEqual(math.dist((x1, y1), (x2, y2)), max(VIA['dia'] + RULES['clr'], VIA['drill'] + RULES['h2h']) - 1e-9)
        self.assertEqual(r['stub'][1], (x2, y2))

    def test_blocked_direction_moves_the_via(self):
        wall = ('seg', (11.0, 5), (11.0, 15), 0.1)          # other-net track just east of the pad
        r = self.plan(pad('U1.1', (10, 10), fp_c=(8, 10)), obstacles={'F.Cu': [(wall, 0.2, 'track X')], 'B.Cu': [], 'In2.Cu': []})
        self.assertNotIn('error', r)
        self.assertLess(r['vias'][0][0], 11.0)

    def test_blocked_axes_use_a_diagonal_spot(self):
        # small B.Cu copper dots on each side spot (all extras): only a via spot there fails, the corners stay free
        walls = [(('seg', (10 + dx, 10 + dy), (10 + dx, 10 + dy), 0.05), 0.2, 'dot X')
                 for dx, dy in ((1.1, 0), (-1.1, 0), (0, 0.9), (0, -0.9), (1.35, 0), (-1.35, 0), (0, 1.15), (0, -1.15),
                                (1.6, 0), (-1.6, 0), (0, 1.4), (0, -1.4), (2.1, 0), (-2.1, 0), (0, 1.9), (0, -1.9),
                                (2.6, 0), (-2.6, 0), (0, 2.4), (0, -2.4))]
        r = self.plan(pad('U1.1', (10, 10)), obstacles={'F.Cu': [], 'B.Cu': walls, 'In2.Cu': []})
        self.assertNotIn('error', r)
        (vx, vy), = r['vias']
        self.assertTrue(abs(vx - 10) > 0.5 and abs(vy - 10) > 0.5, r['vias'])

    def test_no_free_spot_fails_closed(self):
        box = ('poly', [(5, 5), (15, 5), (15, 15), (5, 15)])
        r = self.plan(pad('U1.1', (10, 10)), obstacles={'F.Cu': [], 'B.Cu': [(box, 0.2, 'zone X')], 'In2.Cu': []})
        self.assertIn('error', r)
        self.assertNotIn('vias', r)

    def test_via_never_lands_in_an_smd_pad(self):
        p = pad('U1.1', (10, 10), fp_c=(8, 10))
        smd = [('U1.1', (10, 10, 1.0, 0.6, 0, 0)), ('C1.1', (11.6, 10, 1.0, 1.0, 0, 0))]   # same-net pad east
        r = self.plan(p, smd=smd)
        for v in r['vias']:
            for _, sp in smd:
                self.assertFalse(pt.hole_in_pad((*v, VIA['dia'] / 2), sp))

    def test_allow_list_puts_the_via_in_the_pad(self):
        r = self.plan(pad('U1.1', (10, 10), size=(2, 2)), allow=('U1.1',))
        self.assertEqual(r['vias'], [(10, 10)])
        self.assertIsNone(r['stub'])

    def test_via_outside_the_region_is_refused(self):
        tiny = [(9, 9.5), (11, 9.5), (11, 10.5), (9, 10.5)]
        r = self.plan(pad('U1.1', (10, 10)), region=tiny)
        self.assertIn('error', r)

    def test_taken_via_of_another_net_keeps_the_clearance(self):
        r = self.plan(pad('U1.1', (10, 10), fp_c=(8, 10)), taken=[((11.2, 10), '5V')])
        for v in r['vias']:
            self.assertGreaterEqual(math.dist(v, (11.2, 10)), VIA['dia'] + RULES['clr'] - 1e-9)


class PlanAllTest(unittest.TestCase):
    def test_new_copper_of_one_net_blocks_the_other(self):
        pads = [pad('A1.1', (10, 10), fp_c=(8, 10), net='A'), pad('B1.1', (12.4, 10), fp_c=(14.4, 10), net='B')]
        smd = [(p['name'], (*p['c'], *p['size'], 0, 0)) for p in pads]
        base = {'F.Cu': [], 'B.Cu': [], 'In2.Cu': []}
        res = pp.plan_all(pads, {}, VIA, RULES, {'A': base, 'B': base}, smd, {'A': region_all(), 'B': region_all()})
        va, vb = res[0]['vias'][0], res[1]['vias'][0]
        self.assertGreaterEqual(math.dist(va, vb), VIA['dia'] + RULES['clr'] - 1e-9)
        # B's via or stub must also clear A's stub
        sa = res[0]['stub']
        self.assertGreaterEqual(pt.seg_dist(vb, sa[0], sa[1]) - sa[2] / 2 - VIA['dia'] / 2, RULES['clr'] - 1e-9)

    def test_through_hole_pads_need_no_via(self):
        p = dict(pad('J1.1', (10, 10)), th=True)
        res = pp.plan_all([p], {}, VIA, RULES, {'+3V3': {'F.Cu': []}}, [], {'+3V3': region_all()})
        self.assertEqual(res[0]['n'], 0)
        self.assertEqual(res[0]['vias'], [])


class PlanRailsTest(unittest.TestCase):
    def test_regions_hold_the_vias_of_edge_pads(self):
        pads = {'A': [pad('A1.1', (10, 10), fp_c=(8, 10), net='A'), pad('A2.1', (30, 10), fp_c=(32, 10), net='A')]}
        base = {'A': {'F.Cu': [], 'B.Cu': [], 'In2.Cu': []}}
        smd = [(q['name'], (*q['c'], *q['size'], 0, 0)) for q in pads['A']]
        reg, conf, plans = pp.plan_rails(pads, {}, VIA, RULES, base, smd, BOX, margin=1.0)
        self.assertEqual(conf, [])
        vias = [v for r in plans for v in r['vias']]
        self.assertEqual(len(vias), 2)
        for v in vias:   # the outward vias sit past the pads: the region grows around them too
            self.assertGreaterEqual(depth(reg['A'], v), 1.0 - 1e-6)

    def test_region_margin_counts_from_the_pad_edge(self):
        big = dict(pad('J1.1', (20, 20), size=(2.4, 2.4), net='A'), th=True)
        pads = {'A': [big, pad('C1.1', (40, 20), net='A')]}
        base = {'A': {'F.Cu': [], 'B.Cu': [], 'In2.Cu': []}}
        reg, _, _ = pp.plan_rails(pads, {}, VIA, RULES, base, [], BOX, margin=1.0)
        for q in ((18.8, 18.8), (18.8, 21.2), (18.8, 20), (20, 21.2)):   # THT pad edge: thermal spokes need room
            self.assertGreaterEqual(depth(reg['A'], q), 1.0 - 1e-6, q)

    def test_rail_conflict_is_reported_with_the_plans(self):
        pads = {'A': [pad('A1.1', (10, 25), net='A'), pad('A2.1', (40, 25), net='A')],
                'B': [pad('B1.1', (25, 10), net='B'), pad('B2.1', (25, 40), net='B')]}
        base = {n: {'F.Cu': [], 'B.Cu': [], 'In2.Cu': []} for n in pads}
        _, conf, _ = pp.plan_rails(pads, {}, VIA, RULES, base, [], BOX, margin=1.0)
        self.assertEqual([(a, b) for a, b, _ in conf], [('A', 'B')])


class FastOverTest(unittest.TestCase):
    REG = {'5V': [(10, 10), (30, 10), (30, 20), (10, 20)]}

    def test_fast_track_under_a_region_is_a_conflict(self):
        segs = [('/USB_DP', (0, 15), (40, 15)), ('/USB_DN', (12, 12), (14, 12)), ('/ETH_X', (0, 30), (40, 30))]
        self.assertEqual(pp.fast_over(self.REG, segs, clearance=0.2), [('5V', '/USB_DN', 1), ('5V', '/USB_DP', 1)])

    def test_fast_track_near_the_edge_is_a_conflict(self):
        self.assertEqual(pp.fast_over(self.REG, [('/F', (0, 20.1), (40, 20.1))], clearance=0.2), [('5V', '/F', 1)])
        self.assertEqual(pp.fast_over(self.REG, [('/F', (0, 20.5), (40, 20.5))], clearance=0.2), [])


if __name__ == '__main__':
    unittest.main()
