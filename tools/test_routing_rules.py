"""Tests for tools/routing_rules.py (D-125): keepout geometry, stage order, DSN keepouts, via report."""
import unittest

import routing_rules as rr

BOARD = [[(0, 0), (20, 0), (20, 10), (0, 10)]]
SPEC = {'adjacent': {'F.Cu': 'In1.Cu', 'B.Cu': 'In2.Cu'}, 'plane_layers': ['In1.Cu', 'In2.Cu'],
        'grounds': ['GND'], 'power': ['+3V3'], 'exempt': {'nets': {'/STATIC': 'reason'}}}


def area(rects):
    return sum((x1 - x0) * (y1 - y0) for x0, y0, x1, y1 in rects)


class KeepoutGeometry(unittest.TestCase):
    def slotted(self):
        # In1.Cu: solid GND with a slot x 8-12, y 2-8 (a hole ring of the same fill polygon); In2.Cu: solid GND
        in1 = [('GND', [BOARD[0], [(8, 2), (12, 2), (12, 8), (8, 8)]])]
        in2 = [('GND', [BOARD[0]])]
        return {'In1.Cu': in1, 'In2.Cu': in2}

    def test_slot_gives_keepout_over_the_slot_on_the_adjacent_layer_only(self):
        k = rr.layer_keepouts(SPEC, ['F.Cu', 'B.Cu'], BOARD, self.slotted(), {}, grid=0.1)
        self.assertEqual(k['B.Cu'], [])
        self.assertTrue(k['F.Cu'])
        x0 = min(r[0] for r in k['F.Cu'])
        y0 = min(r[1] for r in k['F.Cu'])
        x1 = max(r[2] for r in k['F.Cu'])
        y1 = max(r[3] for r in k['F.Cu'])
        for got, want in zip((x0, y0, x1, y1), (8, 2, 12, 8)):
            self.assertAlmostEqual(got, want, delta=0.11)
        self.assertAlmostEqual(area(k['F.Cu']), 24, delta=1.0)

    def test_inner_layer_and_layer_without_adjacent_plane_get_none(self):
        k = rr.layer_keepouts(SPEC, ['F.Cu', 'In2.Cu'], BOARD, self.slotted(), {})
        self.assertNotIn('In2.Cu', k)

    def test_other_net_pour_is_no_reference(self):
        fills = {'In1.Cu': [('+3V3', [BOARD[0]])], 'In2.Cu': [('GND', [BOARD[0]])]}
        k = rr.layer_keepouts(SPEC, ['F.Cu'], BOARD, fills, {})
        self.assertAlmostEqual(area(k['F.Cu']), 200, delta=1.0)

    def test_split_between_two_pours_is_a_keepout(self):
        fills = {'In1.Cu': [('GND', [[(0, 0), (9.5, 0), (9.5, 10), (0, 10)]]),
                            ('GND', [[(10.5, 0), (20, 0), (20, 10), (10.5, 10)]])]}
        k = rr.layer_keepouts(SPEC, ['F.Cu'], BOARD, fills, {})
        self.assertAlmostEqual(area(k['F.Cu']), 10, delta=0.6)

    def test_disc_keeps_pin_access_open(self):
        discs = {'F.Cu': [(10, 5, 1.0)]}
        k = rr.layer_keepouts(SPEC, ['F.Cu'], BOARD, self.slotted(), discs)
        self.assertLess(area(k['F.Cu']), 24 - 2.5)
        for x0, y0, x1, y1 in k['F.Cu']:   # no rectangle covers the pad centre
            self.assertFalse(x0 < 10 < x1 and y0 < 5 < y1)

    def test_board_hole_is_not_a_keepout(self):
        outline = [BOARD[0], [(8, 2), (12, 2), (12, 8), (8, 8)]]
        fills = {'In1.Cu': [('GND', [BOARD[0], [(8, 2), (12, 2), (12, 8), (8, 8)]])]}
        self.assertEqual(rr.layer_keepouts(SPEC, ['F.Cu'], outline, fills, {})['F.Cu'], [])

    def test_slow_only_alt_ref_is_no_plane_for_a_fast_stage(self):
        spec = dict(SPEC, alt_refs={'VDD': {'domain': 'GND', 'slow_only': True, 'reason': 'r'}})
        fills = {'In1.Cu': [('VDD', [BOARD[0]])]}
        self.assertEqual(rr.layer_keepouts(spec, ['F.Cu'], BOARD, fills, {}, fast=False)['F.Cu'], [])
        self.assertTrue(rr.layer_keepouts(spec, ['F.Cu'], BOARD, fills, {}, fast=True)['F.Cu'])

    def test_dsn_keepouts_go_in_the_structure(self):
        dsn = '(pcb x\n  (structure\n    (layer F.Cu)\n    (via "Via[0-3]")\n    (rule (width 200))\n  )\n)'
        out = rr.add_wire_keepouts(dsn, {'F.Cu': [(1, 2, 3, 4)]})
        self.assertIn('(wire_keepout "iot_ref_void" (polygon F.Cu 0  1000 -2000  3000 -2000', out)
        self.assertLess(out.index('wire_keepout'), out.index('(via "Via'))
        self.assertEqual(rr.add_wire_keepouts(dsn, {'F.Cu': []}), dsn)


class StageOrder(unittest.TestCase):
    def info(self):
        return dict(spec=SPEC, fast=['/SPI_*', '/SW'], pairs=['/USB_P', '/USB_N'], current=['/SW', '+5V'],
                    clocks=rr.DEFAULT_CLOCKS)

    def test_order_and_split(self):
        nets = ['/USB_P', '/USB_N', '/MCU_SCK', '/SPI_MOSI', '/SW', '+5V', '+3V3', '/LED', '/STATIC', 'GND', '/BIG']
        plan = rr.stage_plan(nets, self.info(), {'/BIG': 'PWR_WIDE'}, {'PWR_WIDE'}, planes=['GND'])
        self.assertEqual([p[0] for p in plan], ['pairs_clocks', 'fast', 'wide', 'wide_exempt', 'rest', 'rest_exempt'])
        got = {name: (nets_, keep) for name, nets_, keep in plan}
        self.assertEqual(got['pairs_clocks'], (['/MCU_SCK', '/USB_N', '/USB_P'], True))
        self.assertEqual(got['fast'], (['/SPI_MOSI'], True))
        # a switch node in the fast list is wide; +5V is a current path but no "power" net of the spec: keepouts
        self.assertEqual(got['wide'], (['+5V', '/BIG', '/SW'], True))
        self.assertEqual(got['wide_exempt'], (['+3V3'], False))         # spec power: no keepout
        self.assertEqual(got['rest'], (['/LED'], True))
        self.assertEqual(got['rest_exempt'], (['/STATIC'], False))     # a spec "exempt" net
        self.assertNotIn('GND', sum((p[1] for p in plan), []))           # plane nets: the last pass

    def test_empty_stages_are_dropped(self):
        plan = rr.stage_plan(['/LED'], self.info())
        self.assertEqual(plan, [('rest', ['/LED'], True)])


class ViaReport(unittest.TestCase):
    def test_counts_and_fast_vias_without_ground_via(self):
        vias = [('/SPI_MOSI', 0, 0, 0.2), ('/SPI_MOSI', 10, 0, 0.2), ('/LED', 5, 5, 0.2), ('GND', 0.8, 0, 0.2)]
        rep = rr.via_report(vias, {'/SPI_MOSI': 'fast', '/LED': 'rest'}, {}, ['/SPI_*'], ['GND'],
                            [(0.8, 0, 0.2)], 0.6)
        self.assertEqual(rep['by_stage']['fast']['vias'], 2)
        self.assertEqual(rep['by_stage']['rest']['per_net'], {'/LED': 1})
        self.assertNotIn('GND', rep['by_class'].get('?', {}).get('per_net', {}))
        self.assertEqual([(m['x'], m['y']) for m in rep['fast_no_gnd']], [(10, 0)])
        self.assertIn('FAST_VIA_NO_GND 1', rr.summary_line(rep))


class RepairSelection(unittest.TestCase):
    """The repair pass (W9): the open nets and their immediate blockers, nothing else."""
    def rows(self):
        # open /A from (0, 5) to (10, 5) on F.Cu; /B crosses the corridor at x = 5, /C runs far away at y = 9,
        # /D is a via on the line (every layer), GND crosses too but is excluded, /E crosses on B.Cu only
        unrouted = [dict(net='/A', from_xy=[0, 5], to_xy=[10, 5], **{'from': dict(layers=['F.Cu', 'F.Cu']),
                                                                     'to': dict(layers=['F.Cu', 'F.Cu'])})]
        copper = [('/B', 'F.Cu', (5, 0), (5, 10)), ('/C', 'F.Cu', (0, 9), (10, 9)), ('/D', None, (7, 5.2), (7, 5.2)),
                  ('GND', 'F.Cu', (3, 0), (3, 10)), ('/E', 'B.Cu', (8, 0), (8, 10)), ('/A', 'F.Cu', (0, 5), (2, 5))]
        return unrouted, copper

    def test_open_net_and_corridor_blockers_only(self):
        unrouted, copper = self.rows()
        sel = rr.repair_selection(unrouted, copper, corridor_mm=1.0, exclude={'GND'})
        self.assertEqual(sel['nets'], ['/A', '/B', '/D'])
        self.assertEqual(sel['blockers'], {'/A': ['/B', '/D']})
        self.assertEqual(sel['connections'], 1)

    def test_blockers_are_bounded_by_distance_rank(self):
        unrouted, copper = self.rows()
        copper += [('/F', 'F.Cu', (6, 4.5), (6, 5.5))]
        sel = rr.repair_selection(unrouted, copper, corridor_mm=1.0, exclude={'GND'}, max_blockers=2)
        # /B and /F cross the line (distance 0); /D is 0.2 mm off: it is dropped by the bound
        self.assertEqual(sel['blockers'], {'/A': ['/B', '/F']})

    def test_no_opens_selects_nothing(self):
        self.assertEqual(rr.repair_selection([], [('/B', 'F.Cu', (0, 0), (1, 1))], 1.0)['nets'], [])

    def test_pair_and_fast_copper_is_unlocked_only_as_a_blocker(self):
        unrouted, copper = self.rows()
        copper += [('/USB_DP', 'F.Cu', (0, 20), (10, 20))]
        sel = rr.repair_selection(unrouted, copper, 1.0, exclude={'GND'})
        self.assertNotIn('/USB_DP', sel['nets'])
        copper += [('/USB_DN', 'F.Cu', (4, 4), (4, 6))]
        self.assertIn('/USB_DN', rr.repair_selection(unrouted, copper, 1.0, exclude={'GND'})['nets'])

    def test_segment_distance(self):
        self.assertAlmostEqual(rr.segment_distance((0, 0), (10, 0), (5, 3), (5, 8)), 3.0)
        self.assertAlmostEqual(rr.segment_distance((0, 0), (10, 0), (5, -1), (5, 1)), 0.0)
        self.assertAlmostEqual(rr.segment_distance((0, 0), (0, 0), (3, 4), (3, 4)), 5.0)


if __name__ == '__main__':
    unittest.main()
