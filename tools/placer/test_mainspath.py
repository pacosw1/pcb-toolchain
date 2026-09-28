"""Tests for mainspath.py (pure geometry core; no pcbnew). Run: python3 -m unittest discover -s tools/placer"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import dru, mainspath as mr  # noqa: E402

DRU = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'hardware-design', 'boards', 'RELAY-4',
                   'cad', 'RELAY-4', 'RELAY-4.kicad_dru')


def pad(x, y, net, cls='MAINS_K1', w=2.0, h=3.0, ref='X'):
    return mr.Item(ref, net, cls, ('rect', x, y, w, h))


def gap(a_cls, b_cls):  # the RELAY-4 rules: 8 mm mains to other, 3 mm between two mains classes and two mains nets
    am, bm = a_cls.startswith('MAINS_K'), b_cls.startswith('MAINS_K')
    return 3.0 if am and bm else 8.0 if am or bm else 0.2


class GeometryTest(unittest.TestCase):
    def test_segment_to_rect_distance(self):
        r = ('rect', 10, 0, 2, 2)
        self.assertAlmostEqual(mr.seg_dist(((0, 5), (20, 5)), r), 4.0)
        self.assertAlmostEqual(mr.seg_dist(((0, 0), (20, 0)), r), 0.0)
        self.assertAlmostEqual(mr.seg_dist(((0, 0), (5, 0)), r), 4.0)
        self.assertAlmostEqual(mr.seg_dist(((0, 4), (4, 0)), ('rect', 4, 4, 2, 2)), 2 ** 0.5, places=6)


class RouteTest(unittest.TestCase):
    W = 2.0

    def route(self, net, pads, obstacles, jumpered=()):
        return mr.route_net(net, 'MAINS_K1', pads, obstacles, self.W, gap, set(jumpered))

    def test_aligned_pads_get_one_straight_segment(self):
        r = self.route('N', [pad(0, 0, 'N'), pad(0, 20, 'N')], [])
        self.assertEqual(r['path'], [(0, 0), (0, 20)])

    def test_a_blocked_straight_line_takes_an_l_path(self):
        a, b = pad(0, 0, 'N'), pad(30, 40, 'N')
        block = pad(15, 20, 'OTHER', cls='SELV', w=1, h=1)   # on the straight line and near both 45-degree paths
        r = self.route('N', [a, b], [block])
        self.assertIsNotNone(r['path'])
        self.assertEqual(len(r['path']), 3)
        self.assertTrue(all(mr.seg_dist(s, block.shape) - self.W / 2 >= 8.0 - 1e-9 for s in zip(r['path'], r['path'][1:])))

    def test_a_blocked_aligned_pair_takes_a_z_jog_around(self):
        a, b = pad(0, 0, 'N'), pad(0, 40, 'N')
        block = pad(0, 20, 'OTHER', cls='SELV', w=1, h=1)
        r = self.route('N', [a, b], [block])
        self.assertEqual(len(r['path']), 4)
        self.assertTrue(all(mr.seg_dist(s, block.shape) - self.W / 2 >= 8.0 - 1e-9 for s in zip(r['path'], r['path'][1:])))

    def test_of_two_legal_paths_of_equal_length_the_one_with_more_margin_wins(self):
        a, b = pad(0, 0, 'N'), pad(30, 40, 'N')
        near = pad(40, 30, 'OTHER', cls='SELV', w=0.001, h=0.001)   # 1 mm margin to the 45-degree path via (30, 30)
        r = self.route('N', [a, b], [near])
        self.assertEqual(r['path'], [(0, 0), (0, 10), (30, 40)])    # the same length via (0, 10), 5.1 mm more margin

    def test_a_longer_path_with_more_margin_does_not_win(self):
        a, b = pad(0, 0, 'N'), pad(0, 20, 'N')
        near = pad(9.5, 10, 'OTHER', cls='SELV', w=0.001, h=0.001)  # 0.5 mm margin to the straight line
        r = self.route('N', [a, b], [near])
        self.assertEqual(r['path'], [(0, 0), (0, 20)])

    def test_no_legal_path_names_the_blocker(self):
        a, b = pad(0, 0, 'N'), pad(0, 20, 'N')
        wall = [pad(x, 10, 'OTHER', cls='SELV', w=4, h=4, ref='U9') for x in range(-40, 41, 4)]
        r = self.route('N', [a, b], wall)
        self.assertIsNone(r['path'])
        self.assertIn('U9', r['why'])

    def test_no_legal_path_gives_a_fault_record_for_the_placer(self):
        a, b = pad(0, 0, 'N'), pad(0, 20, 'N')
        wall = [pad(x, 10, 'OTHER', cls='SELV', w=4, h=4, ref=f'U{x + 40}') for x in range(-40, 41, 4)]
        f = self.route('N', [a, b], wall)['fault']
        self.assertEqual(f['net'], 'N')
        self.assertEqual(f['least_bad'][0], (0, 0))
        self.assertTrue(f['blockers'])
        for x in f['blockers']:
            self.assertEqual(set(x), {'ref', 'net', 'shortfall_mm'})
            self.assertGreater(x['shortfall_mm'], 0)
        self.assertEqual([x['shortfall_mm'] for x in f['blockers']],
                         sorted((x['shortfall_mm'] for x in f['blockers']), reverse=True))   # worst first

    def test_a_routed_net_has_no_fault(self):
        self.assertIsNone(self.route('N', [pad(0, 0, 'N'), pad(0, 20, 'N')], [])['fault'])

    def test_the_nearer_twin_pad_is_used(self):
        j = pad(0, 30, 'N', ref='J3')
        k_far, k_near = pad(0, 0, 'N', ref='K1'), pad(0, 20, 'N', ref='K1')
        r = self.route('N', [j, k_far, k_near], [], jumpered={'K1'})
        self.assertEqual(r['path'], [(0, 20), (0, 30)])

    def test_without_the_jumper_the_twin_pads_get_their_own_link(self):
        j = pad(0, 30, 'N', ref='J3')
        k_far, k_near = pad(0, 0, 'N', ref='K1'), pad(0, 20, 'N', ref='K1')
        r = self.route('N', [j, k_far, k_near], [])
        self.assertEqual(sorted(r['paths']), [[(0, 0), (0, 20)], [(0, 20), (0, 30)]])

    def test_the_gap_follows_the_class_rules(self):
        a, b = pad(0, 0, 'N'), pad(0, 20, 'N')
        selv = pad(6, 10, 'S', cls='SELV', w=1, h=1)            # 5.5 mm from the track centre, 4.5 mm from its edge
        other_mains = pad(6, 10, 'M', cls='MAINS_K2', w=1, h=1)
        self.assertEqual(self.route('N', [a, b], [other_mains])['path'], [(0, 0), (0, 20)])
        self.assertNotEqual(self.route('N', [a, b], [selv])['path'], [(0, 0), (0, 20)])

    def test_same_net_copper_is_not_an_obstacle(self):
        a, b = pad(0, 0, 'N'), pad(0, 20, 'N')
        self.assertEqual(self.route('N', [a, b], [pad(0, 10, 'N')])['path'], [(0, 0), (0, 20)])

    def test_a_single_pad_group_needs_no_route(self):
        self.assertEqual(self.route('N', [pad(0, 0, 'N')], [])['path'], [])


class MazeTest(unittest.TestCase):
    """When no straight, L, 45 or Z path is legal, a grid A* path (8 directions) is tried and then checked exactly."""
    W = 2.0

    def test_a_path_outside_the_z_window(self):
        # The only way around the wall is 24.5 mm to the left of both pads, outside the 12 mm Z window.
        a, b = pad(0, 0, 'N'), pad(0, 30, 'N')
        walls = [pad(0, 15, 'W', cls='SELV', w=30, h=1, ref='WALL'),       # between a and b
                 pad(15.5, 30, 'W', cls='SELV', w=1, h=40, ref='RIGHT')]    # closes the right side
        r = mr.route_net('N', 'MAINS_K1', [a, b], walls, self.W, gap)
        self.assertIsNotNone(r['path'])
        self.assertEqual(mr._blockers(r['path'], 'N', 'MAINS_K1', walls, self.W, gap), [])

    def test_a_closed_pocket_has_no_path(self):
        a, b = pad(0, 0, 'N'), pad(0, 30, 'N')
        box = [pad(0, 18, 'W', cls='SELV', w=40, h=1, ref='WALL'), pad(0, 42, 'W', cls='SELV', w=40, h=1, ref='TOP'),
               pad(-20, 30, 'W', cls='SELV', w=1, h=25, ref='LEFT'), pad(20, 30, 'W', cls='SELV', w=1, h=25, ref='RIGHT')]
        self.assertIsNone(mr.route_net('N', 'MAINS_K1', [a, b], box, self.W, gap)['path'])


class TwinTest(unittest.TestCase):
    def test_twin_pads_of_one_part_count_as_one_node_when_jumpered(self):
        j = pad(0, 30, 'N', ref='J3')
        k1, k2 = pad(0, 0, 'N', ref='K1'), pad(7.5, 0, 'N', ref='K1')
        groups = mr.nodes([j, k1, k2], jumpered={'K1'})
        self.assertEqual(sorted(len(g) for g in groups), [1, 2])
        self.assertEqual(len(mr.nodes([j, k1, k2], jumpered=set())), 3)


class BoardGapTest(unittest.TestCase):
    def test_relay_4_rules(self):
        text = open(DRU).read()
        g = mr.board_gap(dru.parse(text), {'MAINS_K1': 3.0, 'MAINS_K2': 3.0, 'SELV': 0.2}, 0.5)
        self.assertEqual(g('MAINS_K1', 'SELV'), 8.0)
        self.assertEqual(g('MAINS_K1', 'MAINS_K2'), 3.0)
        self.assertEqual(g('MAINS_K1', 'MAINS_K1'), 3.0)
        self.assertEqual(g('MAINS_K1', 'HOLE:H1'), 9.65)
        self.assertEqual(g('MAINS_K1', 'HOLE:H7'), 3.0)
        self.assertEqual(g('MAINS_K1', 'EDGE'), 0.5)
        self.assertEqual(g('MAINS_K1', 'KEEPOUT'), 0.0)

    def test_each_dru_gap_comes_from_its_own_rule(self):
        # Class clearances 0.2 everywhere, so each gap above 0.2 must come from the .kicad_dru rule it tests.
        text = open(DRU).read()
        g = mr.board_gap(dru.parse(text), {'MAINS_K1': 0.2, 'MAINS_K2': 0.2, 'SELV': 0.2}, 0.5)
        self.assertEqual(g('MAINS_K1', 'MAINS_K2'), 3.0)   # rule "Relay circuit to relay circuit"
        self.assertEqual(g('MAINS_K1', 'SELV'), 8.0)       # rule "Mains to SELV and 24 V"
        self.assertEqual(g('MAINS_K1', 'MAINS_K1'), 0.2)   # same class: the class clearance only
        self.assertEqual(g('MAINS_K1', 'HOLE:H2'), 9.65)   # rule "Mains to screw hole"



MAINS = ['/MAINS_COM1', '/MAINS_COM2', '/MAINS_COM3', '/MAINS_COM4', '/MAINS_NO1', '/MAINS_NO2', '/MAINS_NO3',
         '/MAINS_NO4', '/RELAY-CH1/NC', '/RELAY-CH2/NC', '/RELAY-CH3/NC', '/RELAY-CH4/NC']  # RELAY-4 tier 1


def relay4(name):
    """The RELAY-4 problem (units with cu/cu_pads, outline, cu_nets, route_rules) of bench pose O or s67."""
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'testdata', 'relay4-mains-O-s67.json')) as f:
        return json.load(f)[name]


def pose(pr):
    return [(u['x'], u['y'], 0) for u in pr['units']]


class FaultsTest(unittest.TestCase):
    def test_s67_com2_and_com3_have_no_legal_mains_path(self):
        # Hetzner mains router on s67 (2026-09-28): COM2 blocked by K2/K1/J3, COM3 by K4/J4/K3.
        pr = relay4('s67')
        fs = mr.faults(pr, pose(pr), MAINS)
        self.assertEqual(sorted(f['net'] for f in fs), ['/MAINS_COM2', '/MAINS_COM3'])
        refs = {f['net']: {b['ref'] for b in f['blockers']} for f in fs}
        self.assertIn('K2', refs['/MAINS_COM2'])
        self.assertIn('K4', refs['/MAINS_COM3'])

    def test_o_has_a_legal_path_for_every_mains_net(self):
        pr = relay4('O')
        self.assertEqual(mr.faults(pr, pose(pr), MAINS), [])

    def test_the_domain_nets_of_relay_4_are_the_tier_1_mains_nets(self):
        self.assertEqual(mr.domain_nets(relay4('O')), sorted(MAINS))

    def test_the_check_uses_the_pose_not_the_read_positions(self):
        pr, o = relay4('s67'), relay4('O')
        at = {tuple(u['refs']): (u['x'], u['y'], 0) for u in o['units']}   # the unit names differ per read
        self.assertEqual(mr.faults(pr, [at[tuple(u['refs'])] for u in pr['units']], MAINS), [])


class MemberTest(unittest.TestCase):
    """A no-net pad that the dru makes a domain member (BACKUP-POWER PS1 pad 3) is no obstacle to the domain nets."""

    def prob(self, members):
        u = {'refs': ['PS1'], 'x': 0, 'y': 0, 'cu': [[-0.5, -0.5, 0.5, 0.5, 1], [2.0, -0.5, 3.0, 0.5, 0],
                                                    [4.5, -0.5, 5.5, 0.5, 1]],
             'cu_pads': [['PS1', 'pth', '1'], ['PS1', 'pth', '3'], ['PS1', 'pth', '2']]}
        return {'units': [u], 'cu_nets': {'1': ['FGND', 'FIELD']},
                'route_rules': {'dru': {'domains': [('FIELD', 4.0, 0.0)], 'holes': [], 'pairs': [], 'members': members},
                                'classes': {'Default': [0.2, 0.2], 'FIELD': [0.2, 0.5]}},
                'board': {'outline': [[-10, -10], [15, -10], [15, 10], [-10, 10]], 'edge_clearance': 0.3}}

    def test_a_no_net_pad_between_two_domain_pads_blocks_them(self):
        fs = mr.faults(self.prob([]), [(0, 0, 0)], ['FGND'])
        self.assertEqual([f['net'] for f in fs], ['FGND'])

    def test_the_same_pad_as_a_domain_member_does_not(self):
        self.assertEqual(mr.faults(self.prob([['FIELD', 'PS1', '3']]), [(0, 0, 0)], ['FGND']), [])

    def test_old_two_field_cu_pads_still_read(self):
        pr = self.prob([])
        pr['units'][0]['cu_pads'] = [r[:2] for r in pr['units'][0]['cu_pads']]
        self.assertEqual([f['net'] for f in mr.faults(pr, [(0, 0, 0)], ['FGND'])], ['FGND'])


if __name__ == '__main__':
    unittest.main()
