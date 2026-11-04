import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from placer import pinswap  # noqa: E402


def slot(name, x, y, typ='FT_h', note=''):
    return {'name': name, 'type': typ, 'x': x, 'y': y, 'note': note}


class RulesTest(unittest.TestCase):
    def test_port_line_is_the_pin_number_in_the_port(self):
        self.assertEqual(pinswap.port_line('PE13'), 13)
        self.assertEqual(pinswap.port_line('PC14-OSC32_IN'), 14)
        self.assertEqual(pinswap.port_line('PH0-OSC_IN'), 0)
        self.assertIsNone(pinswap.port_line('VDD'))

    def test_usable_slot_excludes_analog_only_not_usable_and_reserved_pins(self):
        self.assertTrue(pinswap.usable(slot('PA3', 0, 0, 'FT_ha', 'PA3: spare')))
        self.assertFalse(pinswap.usable(slot('PC2_C', 0, 0, 'ANA TT_a')))
        self.assertFalse(pinswap.usable(slot('PB14', 0, 0, 'FT_u', 'not usable: REF_CLK')))
        self.assertFalse(pinswap.usable(slot('PC7', 0, 0, 'FT_h', 'spare (reserved for 2nd axis option)')))

    def test_allowed_keeps_exti_lines_unique_drive_and_5v_tolerance(self):
        slots = {1: slot('PE2', 0, 0), 2: slot('PD2', 1, 0), 3: slot('PC13', 2, 0, 'FT'),
                 4: slot('PE7', 3, 0, 'TT_ha'), 5: slot('PE4', 4, 0)}
        nets = {'A': {'kind': 'exti', 'pin': 1, 'ft': True, 'ends': [[0, 5]]},
                'B': {'kind': 'exti', 'pin': 5, 'ft': True, 'ends': [[4, 5]]},
                'O': {'kind': 'out', 'pin': 2, 'ft': True, 'ends': [[1, 5]]},
                'T': {'kind': 'in', 'pin': 4, 'ft': False, 'ends': [[3, 5]]}}
        assign = {n: v['pin'] for n, v in nets.items()}
        # A to pin 2 (PD2): line 2 is A's own line, so it stays unique
        self.assertTrue(pinswap.allowed('A', 2, nets, slots, assign))
        # B to pin 1 (PE2) collides with A on line 2 while A stays there
        self.assertFalse(pinswap.allowed('B', 1, nets, slots, assign))
        # an output never goes to the low-drive RTC pins
        self.assertFalse(pinswap.allowed('O', 3, nets, slots, assign))
        # a 5 V tolerant net never goes to a TT pin; a TT net may go to an FT pin
        self.assertFalse(pinswap.allowed('A', 4, nets, slots, assign))
        self.assertTrue(pinswap.allowed('T', 2, nets, slots, assign))


class SearchTest(unittest.TestCase):
    def problem(self):
        # two pins on the IC edge (y=0), each net ends above the other pin: the rat lines cross
        slots = {1: slot('PD1', 0, 0), 2: slot('PD2', 10, 0)}
        nets = {'A': {'kind': 'in', 'pin': 1, 'ft': True, 'ends': [[10, 10]]},
                'B': {'kind': 'in', 'pin': 2, 'ft': True, 'ends': [[0, 10]]}}
        return nets, slots

    def test_cost_counts_hpwl_and_crossings(self):
        nets, slots = self.problem()
        c = pinswap.measure({'A': 1, 'B': 2}, nets, slots, [])
        self.assertEqual(c['crossings'], 1)
        self.assertAlmostEqual(c['hpwl'], 40.0)
        c = pinswap.measure({'A': 2, 'B': 1}, nets, slots, [])
        self.assertEqual(c['crossings'], 0)
        self.assertAlmostEqual(c['hpwl'], 20.0)

    def test_search_swaps_crossed_pins_and_reports_the_diff(self):
        nets, slots = self.problem()
        res = pinswap.search(nets, slots, [], seed=1)
        self.assertEqual(res['assign'], {'A': 2, 'B': 1})
        self.assertEqual(res['before']['crossings'], 1)
        self.assertEqual(res['after']['crossings'], 0)
        self.assertEqual(sorted((d['net'], d['from_name'], d['to_name']) for d in res['diff']),
                         [('A', 'PD1', 'PD2'), ('B', 'PD2', 'PD1')])

    def test_search_moves_a_net_to_a_free_usable_pin(self):
        slots = {1: slot('PD1', 0, 0), 2: slot('PD2', 10, 0)}
        nets = {'A': {'kind': 'in', 'pin': 1, 'ft': True, 'ends': [[10, 10]]}}
        res = pinswap.search(nets, slots, [], seed=1)
        self.assertEqual(res['assign'], {'A': 2})

    def test_a_cost_per_changed_pin_keeps_small_gains_out_of_the_proposal(self):
        slots = {1: slot('PD1', 0, 0), 2: slot('PD2', 10, 0)}
        nets = {'A': {'kind': 'in', 'pin': 1, 'ft': True, 'ends': [[10, 10]]}}
        self.assertEqual(pinswap.measure({'A': 2}, nets, slots, [], w_c=4.0)['changes'], 1)
        self.assertEqual(pinswap.search(nets, slots, [], seed=1, w_c=15.0)['assign'], {'A': 1})  # gain 10 mm < 15
        self.assertEqual(pinswap.search(nets, slots, [], seed=1, w_c=5.0)['assign'], {'A': 2})

    def test_search_never_breaks_a_rule_for_a_gain(self):
        # B would gain on pin 1 (PE2), but line 2 belongs to A, and A has no other legal pin
        slots = {1: slot('PE2', 0, 0), 2: slot('PD5', 10, 0), 3: slot('PD2', 30, 0)}
        nets = {'A': {'kind': 'exti', 'pin': 1, 'ft': True, 'ends': [[0, 5]]},
                'B': {'kind': 'exti', 'pin': 2, 'ft': True, 'ends': [[0, 10]]}}
        res = pinswap.search(nets, slots, [], seed=3)
        a = res['assign']
        lines = [pinswap.port_line(slots[a[n]]['name']) for n in ('A', 'B')]
        self.assertEqual(len(set(lines)), 2)
        for n in nets:
            self.assertTrue(pinswap.allowed(n, a[n], nets, slots, a))

    def test_search_is_deterministic_for_a_seed(self):
        nets, slots = self.problem()
        self.assertEqual(pinswap.search(nets, slots, [], seed=7), pinswap.search(nets, slots, [], seed=7))


if __name__ == '__main__':
    unittest.main()
