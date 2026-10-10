#!/usr/bin/env python3
"""Unit tests for tools/net_drivers.py and the driver edge in tools/si_planes.py (D-124 addendum, 2026-10-09).

  python3 tools/test_net_drivers.py
"""
import importlib.util
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
spec = importlib.util.spec_from_file_location('si_planes', os.path.join(HERE, 'si_planes.py'))
sp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sp)
import net_drivers as nd  # noqa: E402

XML = '''<export version="E">
<components>
  <comp ref="U1"><value>STM32H743VIT6</value><fields><field name="MPN">STM32H743VIT6</field></fields></comp>
  <comp ref="U2"><value>LTV-217-B-G</value><fields><field name="MPN">LTV-217-B-G</field></fields></comp>
  <comp ref="U3"><value>ESP32-S3-WROOM-1-N8</value><fields><field name="MPN">ESP32-S3-WROOM-1-N8</field></fields></comp>
  <comp ref="U4"><value>XYZ123</value><fields><field name="MPN">XYZ123</field></fields></comp>
  <comp ref="U5"><value>ODX</value><fields><field name="MPN">ODX-1</field></fields></comp>
  <comp ref="U6"><value>CA-IS2062W</value><fields><field name="MPN">CA-IS2062W</field></fields></comp>
  <comp ref="R1"><value>10k</value></comp>
  <comp ref="R2"><value>10k</value></comp>
  <comp ref="J1"><value>conn</value></comp>
  <comp ref="U7"><value>ODX</value><fields><field name="MPN">ODX-2</field></fields></comp>
  <comp ref="R3"><value>4.7k</value></comp>
</components>
<nets>
  <net code="1" name="/ALMn">
    <node ref="U2" pin="4" pinfunction="COL_4" pintype="unspecified"/>
    <node ref="U1" pin="40" pinfunction="PE10_40" pintype="unspecified"/>
    <node ref="R1" pin="2" pinfunction="2_2" pintype="passive"/>
  </net>
  <net code="2" name="+3V3"><node ref="R1" pin="1" pinfunction="1_1" pintype="passive"/>
    <node ref="R3" pin="1" pinfunction="1_1" pintype="passive"/></net>
  <net code="8" name="/OD2"><node ref="U7" pin="3" pinfunction="FLT_3" pintype="unspecified"/>
    <node ref="R3" pin="2" pinfunction="2_2" pintype="passive"/></net>
  <net code="3" name="/FLTn">
    <node ref="U5" pin="3" pinfunction="FLT_3" pintype="unspecified"/>
    <node ref="R2" pin="2" pinfunction="2_2" pintype="passive"/>
  </net>
  <net code="4" name="/CS">
    <node ref="U3" pin="22" pinfunction="IO14_22" pintype="unspecified"/>
  </net>
  <net code="5" name="/ODD"><node ref="U4" pin="1" pinfunction="OUT_1" pintype="unspecified"/></net>
  <net code="6" name="/CAN_RXD"><node ref="U6" pin="5" pinfunction="RXD_5" pintype="unspecified"/>
    <node ref="R2" pin="1" pinfunction="1_1" pintype="passive"/></net>
  <net code="7" name="/FIELD_IN"><node ref="J1" pin="1" pinfunction="1_1" pintype="passive"/></net>
</nets></export>'''

OD_TABLE = {'ODX': {'mpn': ['ODX*'], 'pins': [{'match': 'FLT', 'role': 'open_drain', 'tf_ns': 8, 'source': 'test table'}]}}


def base_spec(**extra):
    s = {'about': 'test board', 'adjacent': {'F.Cu': 'In1.Cu', 'B.Cu': 'In2.Cu'},
         'plane_layers': ['In1.Cu', 'In2.Cu'], 'grounds': ['GND']}
    s.update(extra)
    return sp.load_spec(s)


def run(detour):
    return {'length': 1.0, 'at': (0.0, 0.0), 'terminals': [(0, 0, 0.1), (1, 0, 0.1)], 'detour': detour}


def fails(net, s, detour_mm, board_mm=300):
    res = {('B.Cu', net): {'length': 10.0, 'unref': 1.0, 'bad': 1.0, 'worst': 1.0, 'worst_at': (0, 0), 'cross': 0.0,
                           'cross_net': None, 'runs': [run(detour_mm)]}}

    def detour(layer, domain, r, budget):
        return None if r['detour'] is None or r['detour'] > budget else r['detour']
    return sp.reference_failures(res, {net: 'GND'}, s, detour=detour, board_mm=board_mm)


class NetlistTest(unittest.TestCase):
    def test_parse_strips_the_pin_number_from_the_pin_name(self):
        nl = nd.parse_netlist(XML)
        self.assertIn(('U2', '4', 'COL'), nl['nets']['/ALMn'])
        self.assertEqual(nl['comps']['U2'], 'LTV-217-B-G')

    def test_table_loads_and_has_no_default(self):
        t = nd.load_table()
        self.assertIn('LTV-217', t)
        self.assertNotIn('default', t)


class DriverEdgeTest(unittest.TestCase):
    def setUp(self):
        self.nl = nd.parse_netlist(XML)
        self.s = base_spec(receivers={'/ALMn': {'refs': ['U1'], 'reason': 'pin map: PE10 GPIO in'}})

    def edges(self, table=None, s=None):
        s = s or self.s
        s['_edges'] = sp.driver_edges(sorted(self.nl['nets']), self.nl, s, table)
        return s['_edges']

    def test_optocoupler_net_uses_the_datasheet_time(self):
        e = self.edges()['/ALMn']
        self.assertEqual(e['edge_ns'], 2000)   # LTV-217 tr typ 2 us (tf 3 us), not 1 ns
        self.assertIn('LTV-217', e['driver'])
        self.assertEqual(fails('/ALMn', self.s, 50.0), [])   # 50 mm detour: inside 13 m (board rule off)

    def test_mcu_pin_counts_as_driver_unless_it_is_a_receiver(self):
        s = base_spec()
        e = self.edges(s=s)['/ALMn']
        self.assertEqual(e['edge_ns'], 1.5)   # STM32H743 GPIO is faster than the opto

    def test_open_drain_net_uses_the_fall_time(self):
        e = self.edges(table=OD_TABLE)['/OD2']   # open drain with a 4.7k pull-up: the RC rise is slow, the fall is 8 ns
        self.assertEqual(e['edge_ns'], 8)
        self.assertIn('open drain, tf 8 ns', e['driver'])
        self.assertEqual(fails('/OD2', self.s, 50.0), [])          # 8 ns -> 53.3 mm
        self.assertEqual(len(fails('/OD2', self.s, 60.0)), 1)

    def test_open_drain_rule_needs_the_fall_time(self):
        bad = {'parts': {'X': {'mpn': ['X'], 'pins': [{'match': 'A', 'role': 'open_drain', 'tr_ns': 300, 'source': 's'}]}}}
        path = os.path.join(HERE, '__pycache__', 'od-table-test.json')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            import json
            json.dump(bad, f)
        with self.assertRaises(nd.TableError):
            nd.load_table(path)

    def test_esp32_gpio_net_is_flagged_ibis_not_found(self):
        e = self.edges()['/CS']
        self.assertIn('IBIS not found', e['unknown'])
        f = fails('/CS', self.s, 2.0)
        self.assertEqual(len(f), 1)
        self.assertIn('unknown driver', f[0])
        self.assertIn('IBIS not found', f[0])

    def test_unknown_driver_is_flagged_not_1_ns(self):
        self.edges()
        f = fails('/ODD', self.s, 2.0)
        self.assertEqual(len(f), 1)
        self.assertTrue(f[0].startswith('FAIL unknown-driver B.Cu /ODD'), f[0])
        self.assertIn('XYZ123: no entry', f[0])
        self.assertNotIn('1 ns', f[0])

    def test_unknown_driver_with_a_stub_only_passes(self):
        self.edges()
        self.assertEqual(fails('/ODD', self.s, 0.0), [])

    def test_unknown_driver_with_no_reference_path_fails(self):
        self.edges()
        self.assertIn('no reference path', fails('/ODD', self.s, None)[0])

    def test_series_resistor_passes_the_driver_edge(self):
        e = self.edges()['/FLTn']   # U5 not in the real table, but R2 leads to /CAN_RXD (CA-IS2062W RXD 2.5 ns)
        self.assertIn('unknown', e)
        e = self.edges(table=dict(nd.load_table(), **OD_TABLE))['/FLTn']
        self.assertEqual(e['edge_ns'], 2.5)
        self.assertIn('through R2', e['driver'])

    def test_pull_up_to_a_rail_is_not_followed(self):
        e = self.edges()['/ALMn']
        self.assertNotIn('+3V3', e['driver'])

    def test_offboard_net_needs_an_interface_class(self):
        self.assertIn('off-board via J1.1', self.edges()['/FIELD_IN']['unknown'])
        s = base_spec(offboard={'/FIELD_IN': {'class': 'rs485', 'reason': 'RS-485 bus from the drive'}})
        self.assertEqual(self.edges(s=s)['/FIELD_IN']['edge_ns'], 460)

    def test_spec_checks_receivers_and_offboard(self):
        with self.assertRaises(sp.SpecError):
            base_spec(receivers={'/A': {'refs': ['U1']}})
        with self.assertRaises(sp.SpecError):
            base_spec(offboard={'/A': {'class': 'gpio', 'reason': 'x'}})

    def test_no_gpio_default_class(self):
        self.assertNotIn('gpio', sp.load_edge_rates())
        self.assertIsNone(sp.edge_class('/EN', base_spec()))


if __name__ == '__main__':
    unittest.main()
