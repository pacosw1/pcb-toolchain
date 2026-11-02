"""Unit tests of tools/router/pairrules.py (no KiCad): the KiCad 10 resolution of DRU pair rules.

The expected values come from kicad-cli 10.0 DRC on small test boards (reports/2026-11-01-isolation.md, test boards
t1-t4): the last matching rule wins, both item orders, creepage on one layer only (safe form: a straight clearance).
  python3 -m unittest test_pairrules
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE)))
import pairrules as pr  # noqa: E402
import route_rule_coverage as rrc  # noqa: E402


def rules(text):
    return pr.Rules(rrc._forms('(version 1)\n' + text))


def trk(net, cls, **kw):
    return dict({'NetName': net, 'NetClass': cls, 'Type': 'Track', 'Pad_Type': '', 'kind': 'track'}, **kw)


def pad(net, cls, ref, num, kind='pad_smd', ptype='SMD', **kw):
    return dict({'NetName': net, 'NetClass': cls, 'Type': 'Pad', 'Pad_Type': ptype, 'Reference': ref, 'Pad_Number': num,
                 'kind': kind}, **kw)


def scope(c):
    return 'either_th' if c and 'Through-hole' in c else None


G = """(rule "G" (condition "A.NetClass == 'ISO' && B.NetClass != 'ISO'") (constraint clearance (min 1.0mm)))"""
R = """(rule "R" (condition "A.NetClass == 'ISO' && B.NetClass != 'ISO' && A.intersectsCourtyard('J1') && B.intersectsCourtyard('J1')") (constraint clearance (min 0.4mm)))"""
IN = {'intersectsCourtyard:J1': True}
OUT = {'intersectsCourtyard:J1': False}


class Resolution(unittest.TestCase):
    def test_later_rule_wins_not_the_largest(self):
        # kicad-cli t1 (G then R): inside J1 0.4 applies; t2 (R then G): 1.0 applies inside J1 too
        a, b = trk('ISO2', 'ISO', regions=IN), trk('OTH2', 'OTH', regions=IN)
        self.assertEqual(rules(G + R).resolve('clearance', a, b), (0.4, 'R'))
        self.assertEqual(rules(R + G).resolve('clearance', a, b), (1.0, 'G'))
        # t1 case 4: B outside the courtyard: G
        self.assertEqual(rules(G + R).resolve('clearance', a, trk('OTH3', 'OTH', regions=OUT)), (1.0, 'G'))

    def test_both_item_orders(self):
        # kicad-cli t3 rule S 'A.NetClass == Default && B.NetClass == ISO' flags the ISO-Default pair from either side
        r = rules("""(rule "S" (condition "A.NetClass == 'Default' && B.NetClass == 'ISO'") (constraint clearance (min 1.0mm)))""")
        self.assertEqual(r.resolve('clearance', trk('ISO7', 'ISO'), trk('DEF7', 'Default')), (1.0, 'S'))
        self.assertEqual(r.resolve('clearance', trk('DEF7', 'Default'), trk('ISO7', 'ISO')), (1.0, 'S'))
        self.assertIsNone(r.resolve('clearance', trk('X', 'Default'), trk('Y', 'Default')))

    def test_attribute_to_attribute_compare(self):
        # RELAY-4 'Relay circuit to relay circuit': two mains classes 3 mm, one class with itself: no rule
        r = rules("""(rule "M" (condition "A.NetClass == 'MAINS_K*' && B.NetClass != 'MAINS_K*'") (constraint clearance (min 8mm)))
(rule "K" (condition "A.NetClass == 'MAINS_K*' && B.NetClass == 'MAINS_K*' && A.NetClass != B.NetClass") (constraint clearance (min 3mm)))""")
        self.assertEqual(r.resolve('clearance', trk('a', 'MAINS_K1'), trk('b', 'MAINS_K2')), (3.0, 'K'))
        self.assertIsNone(r.resolve('clearance', trk('a', 'MAINS_K1'), trk('c', 'MAINS_K1')))
        self.assertEqual(r.resolve('clearance', trk('a', 'MAINS_K1'), trk('s', 'SELV')), (8.0, 'M'))

    def test_footprint_exception(self):
        # BASE-PWR-B 'CAN isolation barrier': not between two pads of U22 (the isolator)
        r = rules("""(rule "CAN" (condition "A.NetClass == 'CAN_ISO' && B.NetClass != 'CAN_ISO' && B.NetName != '' && !(A.memberOfFootprint('U22') && B.memberOfFootprint('U22'))") (constraint clearance (min 4mm)) (constraint creepage (min 4mm)))""")
        self.assertIsNone(r.resolve('clearance', pad('CANH', 'CAN_ISO', 'U22', '13'), pad('3V3', 'Default', 'U22', '1')))
        self.assertEqual(r.resolve('clearance', trk('CANH', 'CAN_ISO'), pad('3V3', 'Default', 'U22', '1')), (4.0, 'CAN'))
        self.assertIsNone(r.resolve('clearance', trk('CANH', 'CAN_ISO'), pad('', 'Default', 'H1', '')))

    def test_undecidable_pair_is_unknown(self):
        r = rules("""(rule "X" (condition "A.NetClass == 'ISO' && B.someFunction('Q')") (constraint clearance (min 2mm)))""")
        self.assertIs(r.resolve('clearance', trk('a', 'ISO'), trk('b', 'OTH')), rrc.UNKNOWN)
        self.assertIsNone(r.resolve('clearance', trk('a', 'OTH'), trk('b', 'OTH')))

    def test_layer_rule_gives_the_larger_value(self):
        r = rules("""(rule "A" (condition "A.NetClass == 'ISO' && B.NetClass != 'ISO'") (constraint clearance (min 3mm)))
(rule "L" (layer "F.Cu") (condition "A.NetClass == 'ISO' && B.NetClass != 'ISO'") (constraint clearance (min 1mm)))""")
        self.assertEqual(r.resolve('clearance', trk('a', 'ISO'), trk('b', 'OTH')), (3.0, 'A'))


class Table(unittest.TestCase):
    POE = """(rule "PoE isolation" (condition "A.NetClass == 'POE' && B.NetClass != 'POE'") (constraint clearance (min 3mm)) (constraint creepage (min 3mm)))
(rule "PoE isolation inside J1" (condition "A.NetClass == 'POE' && B.NetClass != 'POE' && A.Type != 'Zone' && B.Type != 'Zone' && A.intersectsCourtyard('J1') && B.intersectsCourtyard('J1')") (constraint clearance (min 1.25mm)))
(rule "PoE creepage J1 pin pitch" (condition "(A.NetName == '/POE_V1P' && B.NetName == '/MAG_RDN') || (A.NetName == '/MAG_RDN' && B.NetName == '/POE_V1P')") (constraint creepage (min 1.25mm)))
(rule "JLC PTH hole to copper" (constraint hole_clearance (min 0.28mm)) (condition "A.Pad_Type == 'Through-hole' || B.Pad_Type == 'Through-hole'"))"""

    def build(self):
        r = rules(self.POE)
        routed = {'/POE_V1P': trk('/POE_V1P', 'POE'), '/POE_V1N': trk('/POE_V1N', 'POE'), 'GND': trk('GND', 'Default'),
                  '': trk('', 'Default')}
        pads = [pad('/MAG_RDN', 'Default', 'J1', '5', 'pad_pth', 'Through-hole', regions=IN),
                pad('/ETH_CT', 'Default', 'J1', '3', 'pad_pth', 'Through-hole', regions=IN),
                pad('GND', 'Default', 'C1', '2', regions=OUT)]
        zones = [dict(trk('GND', 'Default'), Type='Zone', kind='zone', regions=IN)]
        return pr.build(r, scope, routed, pads, zones, ['intersectsCourtyard:J1'])

    def val(self, t, net, kind, bits, other):
        n = t['groups']
        return t['table'][t['var'][net][kind][bits] * n + other]

    def test_creepage_keeps_the_relaxed_clearance_up(self):
        t = self.build()
        mag, ct, c1 = t['pad_groups']
        # inside J1 the clearance relaxes to 1.25 for every pair, but the creepage stays 3.0 except the named pair
        self.assertEqual(self.val(t, '/POE_V1P', 'track', 1, mag), 1.25)
        self.assertEqual(self.val(t, '/POE_V1P', 'track', 1, ct), 3.0)
        self.assertEqual(self.val(t, '/POE_V1P', 'track', 0, mag), 3.0)
        self.assertEqual(self.val(t, '/POE_V1N', 'track', 1, mag), 3.0)
        self.assertEqual(self.val(t, 'GND', 'track', 0, c1), 0.0)
        # the zone keeps the clearance only (the filler): GND zone in J1 to a POE track in J1 = 3.0 (rule excludes zones)
        z = t['zone_groups'][0]
        self.assertEqual(t['clearance'][z * t['groups'] + t['var']['/POE_V1P']['track'][1]], 3.0)

    def test_known_hole_rule_stays_out_of_the_table(self):
        # 'JLC PTH hole to copper' is applied by model.py hole_rules (measured from the hole edge); in the table it
        # would be measured from the pad copper (over-strict): GND track to the PTH pad /ETH_CT = no pair value
        t = self.build()
        self.assertEqual(self.val(t, 'GND', 'track', 1, t['pad_groups'][1]), 0.0)

    def test_raising_region_on_routed_copper_is_refused(self):
        r = rules("""(rule "In" (condition "A.NetClass == 'ISO' && A.intersectsArea('HV') && B.NetClass != 'ISO'") (constraint clearance (min 5mm)))""")
        with self.assertRaisesRegex(ValueError, 'raises the value'):
            pr.build(r, scope, {'a': trk('a', 'ISO'), 'b': trk('b', 'OTH'), '': trk('', 'Default')}, [], [], ['intersectsArea:HV'])

    def test_trigger(self):
        # NET-CORE-like rules (pair inner gap, pour gap, JLC hole rules) are not pair rules: the model stays as before
        r = rules("""(rule "gap" (condition "A.isCoupledDiffPair()") (constraint clearance (min 0.12mm)))
(rule "pour" (condition "A.inDiffPair('/USB_D') && A.Type == 'Track' && B.Type == 'Zone'") (constraint clearance (min 0.5mm)))
(rule "JLC" (constraint hole_clearance (min 0.28mm)) (condition "A.Pad_Type == 'Through-hole' || B.Pad_Type == 'Through-hole'"))""")
        self.assertEqual(r.trigger(scope), [])
        self.assertEqual(rules(self.POE).trigger(scope), [('PoE isolation', 'clearance'), ('PoE isolation', 'creepage'),
                                                          ('PoE isolation inside J1', 'clearance'), ('PoE creepage J1 pin pitch', 'creepage')])


if __name__ == '__main__':
    unittest.main()
