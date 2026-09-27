import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import dru  # noqa: E402

RELAY = """(version 1)
# comment with (brackets) and 'quotes'
(rule "Mains to SELV and 24 V"
  (condition "A.NetClass == 'MAINS_K*' && B.NetClass != 'MAINS_K*'")
  (constraint clearance (min 8mm))
  (constraint creepage (min 7.5mm)))
(rule "Relay circuit to relay circuit"
  (condition "A.NetClass == 'MAINS_K*' && B.NetClass == 'MAINS_K*' && A.NetClass != B.NetClass")
  (constraint clearance (min 3mm))
  (constraint creepage (min 3mm)))
(rule "Mains to screw hole"
  (condition "A.NetClass == 'MAINS_K*' && B.Type == 'Pad' && B.Pad_Type == 'NPTH, mechanical' && (B.Reference == 'H1' || B.Reference == 'H2')")
  (constraint hole_clearance (min 9.65mm)))
(rule "Edge connector silk"
  (condition "A.memberOfFootprint('J1') && B.Layer == 'Edge.Cuts'")
  (constraint silk_clearance (min -10mm)))
(rule "Isolation barrier"
  (condition "(A.NetClass == 'FIELD' || A.NetClass == 'FIELD_PWR') && (B.NetClass == 'HOST' || B.NetClass == 'HOST_PWR')")
  (constraint clearance (min 4mm)))
"""


class ParseTest(unittest.TestCase):
    def test_domain_class_gap_and_hole_rules_come_from_the_dru(self):
        r = dru.parse(RELAY)
        self.assertEqual(r['domains'], [('MAINS_K*', 8.0, 3.0)])  # the larger of clearance and creepage
        self.assertEqual(r['holes'], [('MAINS_K*', ('H1', 'H2'), 9.65)])

    def test_a_clearance_rule_the_model_cannot_read_is_listed_not_dropped(self):
        r = dru.parse(RELAY)
        self.assertEqual(r['ignored'], ['Isolation barrier'])  # silk rules are no placement rules

    def test_a_domain_without_a_class_rule_keeps_the_net_clearance_between_its_classes(self):
        r = dru.parse('(rule "PoE" (condition "A.NetClass == \'POE\' && B.NetClass != \'POE\'")'
                      ' (constraint clearance (min 3mm)))')
        self.assertEqual(r['domains'], [('POE', 3.0, 0.0)])


if __name__ == '__main__':
    unittest.main()
