#!/usr/bin/env python3
"""Unit tests for tools/net_drivers.py and the driver edge in tools/si_planes.py (D-124 addendum, 2026-10-09).

  python3 tools/test_net_drivers.py
"""
import importlib.util
import os
import sys
import unittest
from unittest import mock
import tempfile
import pathlib
import subprocess
import json
import lean_workflow as lean

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
        with tempfile.TemporaryDirectory(prefix='iot-driver-table-') as scratch:
            path = os.path.join(scratch, 'od-table-test.json')
            with open(path, 'w') as f:
                json.dump(bad, f)
            with self.assertRaises(nd.TableError):
                nd.load_table(path)

    def test_esp32_gpio_net_is_flagged_ibis_not_found(self):
        e = self.edges()['/CS']
        self.assertIn('routed length', e['unknown'])  # D124b conditional estimate needs actual geometry.
        f = fails('/CS', self.s, 2.0)
        self.assertEqual(len(f), 1)
        self.assertIn('unknown driver', f[0])
        self.assertIn('routed length', f[0])

    def test_unknown_driver_is_flagged_not_1_ns(self):
        self.edges()
        f = fails('/ODD', self.s, 2.0)
        self.assertEqual(len(f), 1)
        self.assertTrue(f[0].startswith('FAIL unknown-driver B.Cu /ODD'), f[0])
        self.assertIn('XYZ123: no entry', f[0])
        self.assertNotIn('1 ns', f[0])

    def test_unknown_driver_numeric_zero_is_not_a_stub_proof(self):
        self.edges()
        self.assertEqual(len(fails('/ODD', self.s, 0.0)), 1)

    def test_unknown_driver_unmeasured_detour_stays_rejected(self):
        self.edges()
        self.assertIn('detour not measured: missing edge bound', fails('/ODD', self.s, None)[0])

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
        self.assertIn('MPN/pin', self.edges(s=s)['/FIELD_IN']['unknown'])
        s['offboard']['/FIELD_IN'].update(driver_mpn='THVD1410DR', driver_pin='A')
        self.assertEqual(self.edges(s=s)['/FIELD_IN']['edge_ns'], 460)

    def test_sp3485_cannot_inherit_thvd1410_class(self):
        nl={'comps':{'U13':'SP3485EN-L/TR'},'nets':{'/RS485_A':[('U13','6','A')]}}
        s=base_spec(edge_classes={'rs485':['/RS485_A']})
        s['_edges']=sp.driver_edges(['/RS485_A'],nl,s)
        self.assertIn('incompatible',s['_edges']['/RS485_A']['unknown'])
        self.assertIsNone(sp.net_edge_of('/RS485_A',s)[0])
        self.assertEqual(len(fails('/RS485_A',s,2)),1)

    def test_unknown_driver_cannot_be_masked_by_interface_class(self):
        s=base_spec(edge_classes={'rs485':['/ODD']})
        self.edges(s=s)
        self.assertIn('XYZ123',s['_edges']['/ODD']['unknown'])
        self.assertIsNone(sp.net_edge_of('/ODD',s)[0])

    def test_thvd1410_bus_pin_is_compatible_but_logic_pin_is_not(self):
        s=base_spec(edge_classes={'rs485':['/A']})
        for pin,known in [('A',True),('R',False)]:
            nl={'comps':{'U1':'THVD1410DR'},'nets':{'/A':[('U1','6',pin)]}}
            e=sp.driver_edges(['/A'],nl,s)['/A']
            self.assertEqual('edge_ns' in e,known)
            if known:self.assertEqual(e['edge_ns'],460)

    def test_offboard_driver_part_must_match(self):
        s=base_spec(offboard={'/FIELD_IN':{'class':'rs485','reason':'field bus','driver_mpn':'SP3485EN-L/TR','driver_pin':'A'}})
        self.assertIn('incompatible',self.edges(s=s)['/FIELD_IN']['unknown'])

    def test_same_net_additional_incompatible_driver_cannot_be_hidden(self):
        nl={'comps':{'U1':'THVD1410DR','U2':'SP3485EN-L/TR'},'nets':{'/A':[('U1','6','A'),('U2','6','A')]}}
        s=base_spec(edge_classes={'rs485':['/A']})
        self.assertIn('incompatible',sp.driver_edges(['/A'],nl,s)['/A']['unknown'])

    def test_protocol_class_retains_explicit_contract_without_gpio_fallback(self):
        s=base_spec(edge_classes={'i2c':['/CS']})
        self.assertEqual(self.edges(s=s)['/CS']['edge_ns'],12)
        self.assertIn('protocol i2c',s['_edges']['/CS']['driver'])


class DeadlineEvidenceTest(unittest.TestCase):
    def test_nonfinite_or_boolean_driver_timing_rejected(self):
        for value in (float('inf'), float('-inf'), float('nan'), True, False, 0, -1):
            with self.subTest(value=value), tempfile.NamedTemporaryFile(mode='w', suffix='.json') as f:
                json.dump({'parts': {'test': {'mpn':['TEST'], 'pins':[{'match':'OUT', 'role':'push_pull', 'tr_ns':value, 'tf_ns':1, 'source':'fixture'}]}}},f)
                f.flush()
                with self.assertRaises(nd.TableError):nd.load_table(f.name)

    def test_export_uses_supervised_absolute_inherited_deadline(self):
        with tempfile.TemporaryDirectory() as tmp:
            sch=pathlib.Path(tmp)/'X.kicad_sch';sch.write_text('fixture')
            inherited=lean.now()+5
            def stage(cmd,**kw):
                self.assertLessEqual(kw['deadline'],inherited)
                pathlib.Path(cmd[cmd.index('-o')+1]).write_text(XML)
                return subprocess.CompletedProcess(cmd,0,'','')
            with mock.patch.dict(os.environ,IOT_LEAN_DEADLINE=lean.encode_deadline(inherited)),mock.patch.object(lean,'run_stage',side_effect=stage):
                self.assertEqual(nd.export_netlist(str(sch),deadline=lean.now()+100)['comps']['U1'],'STM32H743VIT6')

    def test_timeout_propagates_and_missing_schematic_never_looks_successful(self):
        with tempfile.TemporaryDirectory() as tmp:
            sch=pathlib.Path(tmp)/'X.kicad_sch';sch.write_text('fixture')
            with mock.patch.object(lean,'run_stage',side_effect=subprocess.TimeoutExpired('export',1)):
                with self.assertRaises(subprocess.TimeoutExpired):nd.export_netlist(str(sch))
            with self.assertRaises(OSError):nd.export_netlist(str(sch.with_name('missing.kicad_sch')))

    def test_changed_or_missing_evidence_rejects(self):
        with self.assertRaises(nd.TableError):nd.verify_evidence({'evidence_files':[{'path':'hardware-design/registry/datasheets/SP3485EN-L-TR_C8963.pdf','sha256':'0'*64}]})
        with self.assertRaises(nd.TableError):nd.verify_evidence({'evidence_files':[{'path':'hardware-design/registry/datasheets/../escape','sha256':'0'*64}]})

    def test_spec_checks_receivers_and_offboard(self):
        with self.assertRaises(sp.SpecError):
            base_spec(receivers={'/A': {'refs': ['U1']}})
        with self.assertRaises(sp.SpecError):
            base_spec(offboard={'/A': {'class': 'gpio', 'reason': 'x'}})

    def test_no_gpio_default_class(self):
        self.assertNotIn('gpio', sp.load_edge_rates())
        self.assertIsNone(sp.edge_class('/EN', base_spec()))


class D124cLoadDriverTest(unittest.TestCase):
    """D-124c hand calculations and unknown-on-error integration coverage."""
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.path=pathlib.Path(self.tmp.name)/'fixture.ibs'
        self.fixture='''[Component] GATE
[Pin] signal_name model_name
4 Y OUT
5 VCC POWER
[Model Selector] OUT
OUT_33 gate
[Model] OUT_33
Model_type Output
C_comp 7.52pF 3.81pF 9.89pF
[Voltage Range] 3.3 3.0 3.6
[Pullup Reference] 3.3 3.0 3.6
[Pulldown]
-1 -50mA -40mA -60mA
0 0 0 0
3.6 36mA 18mA 72mA
[Pullup]
0 0 0 0
3.6 -18mA -9mA -36mA
[Ramp]
dV/dt_r 3.3/0.1n 3.3/0.1n 3.3/0.1n
dV/dt_f 3.3/0.1n 3.3/0.1n 3.3/0.1n
[End]
'''
        self.write(self.fixture)
        self.part={'mpn':['GATE'],'ibis':{'file':str(self.path),'sha256':self.sha,'component':'GATE','supply_pin':'VCC','variants':{'3.3':'_33'},'url':'fixture','downloaded':'2026-10-10'},'pins':[{'match':'Y','role':'push_pull','ibis_model':'OUT','source':'fixture V-I'},{'match':'VCC','role':'input'}]}
        self.table={'gate':self.part}
        self.nl={'comps':{'U1':'GATE'},'values':{},'nets':{'/Y':[('U1','4','Y')],'VDD_3V3':[('U1','5','VCC')]}}
        self.geom={'length_mm':{'/Y':10},'pf_per_mm':{'/Y':(.1,'test 0.1 pF/mm')}}
    def write(self,text):
        import hashlib
        self.path.write_text(text);self.sha=hashlib.sha256(self.path.read_bytes()).hexdigest()
    def edge(self,**kw):return nd.net_edge('/Y',self.nl,self.table,geom=self.geom,**kw)
    def test_actual_load_uses_vi_not_fixture_ramp(self):
        e=self.edge();self.assertAlmostEqual(e['edge_ns'],.3848)
        self.assertIn('V-I conditional estimate',e['driver'])
        self.assertFalse(e['timing_evidence']['qualified_fastest_bound'])
        proof=e['timing_evidence']['contributors'][0]['evidence']
        self.assertEqual(proof['inputs']['trace_capacitance_pf'],1)
        self.assertEqual(proof['estimates'][0]['driver_c_comp_min_pf'],3.81)
        self.geom['length_mm']['/Y']=20
        self.assertAlmostEqual(self.edge()['edge_ns'],.4648)
    def ramp(self,dvdt):
        self.write(self.fixture.replace('3.3/0.1n',dvdt));self.part['ibis']['sha256']=self.sha
    def test_edge_is_the_larger_of_ramp_and_cdv_over_i_ramp_wins(self):
        # D-124e. [Ramp] 3.3 V / 1 ns into R_fixture: fastest corner = min supply 3.0 V: 10-90 % = 0.8 * 3.0 / 3.3e9 = 0.72727 ns > C*dV/I fall 0.3848 ns (rise 0.7696 ns)
        self.ramp('3.3/1n')
        e=self.edge();self.assertAlmostEqual(e['edge_ns'],.8*3/3.3)
        est=e['timing_evidence']['contributors'][0]['evidence']['estimates'][0]
        self.assertEqual(est['bound_f'],'ramp');self.assertAlmostEqual(est['tf_ramp_ns'],.8*3/3.3);self.assertAlmostEqual(est['tf_vi_ns'],.3848)
        self.assertAlmostEqual(est['tr_ns'],.7696)   # rise: C*dV/I 0.7696 ns > ramp 0.7273 ns
        self.assertEqual(est['bound_r'],'C*dV/I')
    def test_edge_is_the_larger_of_ramp_and_cdv_over_i_cdv_wins(self):
        # D-124e. Ramp 3.3 V / 0.1 ns -> 0.0727 ns < C*dV/I 0.3848 ns (fall) and 0.7696 ns (rise): the V-I time stays
        e=self.edge();self.assertAlmostEqual(e['edge_ns'],.3848)
        est=e['timing_evidence']['contributors'][0]['evidence']['estimates'][0]
        self.assertEqual(est['bound_f'],'C*dV/I');self.assertAlmostEqual(est['tf_ramp_ns'],.08*3/3.3)
    def test_edge_without_a_ramp_is_unknown(self):
        self.write(self.fixture.replace('[Ramp]','[Ramp Removed]'));self.part['ibis']['sha256']=self.sha
        self.assertIn('ramp',self.edge()['unknown'])
    def test_receiver_capacitance_and_missing_loads_are_attributed(self):
        self.nl['comps'].update(U2='RECEIVER',U3='MISSING')
        self.nl['nets']['/Y'] += [('U2','1','IN'),('U3','1','IN')]
        self.table['receiver']={'mpn':['RECEIVER'],'pin_c':{'pf':2,'source':'receiver fixture'},'pins':[{'match':'IN','role':'input'}]}
        self.table['missing']={'mpn':['MISSING'],'pins':[{'match':'IN','role':'input'}]}
        e=self.edge();self.assertAlmostEqual(e['edge_ns'],.5448)
        inputs=e['timing_evidence']['contributors'][0]['evidence']['inputs']
        self.assertEqual(inputs['receiver_capacitance_pf'],2)
        self.assertEqual(inputs['omitted_loads'],['U3.IN'])
    def test_missing_geometry_is_unknown(self):
        self.assertIn('routed length',nd.net_edge('/Y',self.nl,self.table)['unknown'])
    def test_missing_vi_never_uses_ramp_or_datasheet_fallback(self):
        self.write(self.fixture.replace('[Pulldown]','[GND Clamp]'))
        self.part['ibis']['sha256']=self.sha
        self.part['pins'][0].update(tr_ns=1,tf_ns=1)
        self.assertIn('no pulldown',self.edge()['unknown'])
    def test_missing_supply_variant_does_not_hide_bad_possible_model(self):
        self.nl['nets'].pop('VDD_3V3')
        self.part['ibis']['variants']['5']='_MISSING'
        self.assertIn('not in',self.edge()['unknown'])
    def test_series_load_and_limit_are_explicit(self):
        self.nl['comps']['R1']='10k';self.nl['values']['R1']='10k'
        self.nl['nets']['/Y'].append(('R1','1','1'));self.nl['nets']['/POST']=[('R1','2','2')]
        geom={'length_mm':{'/POST':10},'pf_per_mm':{'/POST':(.1,'fixture')}}
        e=nd.net_edge('/POST',self.nl,self.table,geom=geom)
        self.assertGreater(e['edge_ns'],5)
        estimate=e['timing_evidence']['contributors'][0]['evidence']['estimates'][0]
        self.assertTrue(estimate['driver_capacitance_omitted_for_series'])
        self.assertEqual(estimate['driver_c_comp_min_pf'],0)
        self.assertAlmostEqual(estimate['series_current_limit_a'],3.3/(.95*10000))
        self.assertFalse(e['timing_evidence']['qualified_fastest_bound'])


if __name__ == '__main__':
    unittest.main()
