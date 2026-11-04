"""D124b production parser/driver regressions; native topology proof remains separate."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from unittest import mock
import ibis_ramp as ib
import net_drivers as nd

FIX='''[IBIS Ver] 4.1
[Component] GATE
[Pin] signal_name model_name
1 A IN
4 Y OUT
5 VCC POWER
[Model Selector] OUT
OUT_33 output3V3
[Model] IN_33
Model_type Input
C_comp 3pF 2pF 4pF
[Model] OUT_33
Model_type Output
C_comp 3pF NA 4pF
[Voltage Range] 3.3 3 3.6
[Temperature Range] 25 125 -40
[Ramp]
dV/dt_r 1/10n 1/1n 1/5n
dV/dt_f 1/10n NA 1/5n
[End]
'''

class IbisParserScreeningTest(unittest.TestCase):
    def test_public_number_accepts_whitespace(self):
        self.assertEqual(ib.number('  3.3n  '),3.3e-9)
        self.assertIsNone(ib.number('  NA  '))
    def test_actual_vendor_cli_and_errors(self):
        script=Path(ib.__file__);vendor=Path(nd.HERE).parent/'hardware-design/registry/ibis/SN74LVC1G08/lvc1g08.ibs'
        r=subprocess.run([sys.executable,str(script),str(vendor),'LVC1G08_OUT_33'],capture_output=True,text=True,timeout=5)
        self.assertEqual(r.returncode,0,r.stderr);out=json.loads(r.stdout)
        self.assertEqual(out['source_sha256'],hashlib.sha256(vendor.read_bytes()).hexdigest())
        self.assertGreater(out['edge_screen']['tr_ns'],0);self.assertFalse(out['qualified_fastest_bound'])
        for args,code in (([str(vendor),'NOT_A_MODEL'],1),([],2)):
            with self.subTest(args=args):
                r=subprocess.run([sys.executable,str(script),*args],capture_output=True,text=True,timeout=5)
                self.assertEqual(r.returncode,code);self.assertTrue(r.stderr);self.assertFalse(r.stdout)
    def test_corners_load_and_pvt_are_explicit(self):
        m=ib.parse(FIX.splitlines())['models']['out_33'];e=ib.ramp_edges(m)
        self.assertEqual(e['tr_ns'],1);self.assertEqual(e['corner_r'],'min')
        self.assertEqual(e['missing_corners']['f'],['min'])
        self.assertEqual(e['r_load_ohm'],50);self.assertTrue(e['r_load_default'])
        self.assertEqual(e['voltage_range'],[3.3,3,3.6]);self.assertEqual(e['temperature_range'],[25,125,-40])
        self.assertIsNone(m['c_comp'][1])
    def test_explicit_load(self):
        m=ib.parse(FIX.replace('[End]','R_load = 300ohms\n[End]').splitlines())['models']['out_33']
        self.assertEqual(ib.ramp_edges(m)['r_load_ohm'],300)
    def test_missing_requested_corners_fails(self):
        m=ib.parse(FIX.replace('1/1n 1/5n','NA NA').replace('NA 1/5n','NA NA').splitlines())['models']['out_33']
        with self.assertRaises(ib.IbisError):ib.ramp_edges(m,('min','max'))
    def test_invalid_numeric_and_ramp(self):
        for token in ('1e999','nan','inf','1banana'):
            with self.subTest(token=token),self.assertRaises(ib.IbisError):ib.number(token)
        for replacement in ('1/0','1/-1n','0/1n','NA'):
            with self.subTest(token=replacement),self.assertRaises(ib.IbisError):ib.parse(FIX.replace('1/10n',replacement).splitlines())
    def test_duplicate_model_rejected(self):
        with self.assertRaises(ib.IbisError):ib.parse((FIX+'\n[Model] OUT_33').splitlines())
    def test_content_cache_and_hash_binding(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'x.ibs';p.write_text(FIX);sha=hashlib.sha256(p.read_bytes()).hexdigest()
            first=ib.load(p,sha);p.write_text(FIX.replace('1/1n','1/2n'))
            self.assertNotEqual(ib.load(p)['source_sha256'],first['source_sha256'])
            with self.assertRaises(ib.IbisError):ib.load(p,sha)
    def test_nine_original_files_and_models(self):
        table=nd.load_table();count=0;files=0
        for part in table.values():
            if 'ibis' not in part:continue
            data=ib.load(nd._ibis_path(part),part['ibis']['sha256']);files+=1;count+=len(data['models'])
            self.assertIn(part['ibis']['component'],data['pins'])
            for rule in part['pins']:
                if rule.get('ibis_model') and rule['role']!='input':
                    for suffix in part['ibis']['variants'].values():
                        e=nd.ibis_edges(part,rule['ibis_model']+suffix)
                        self.assertGreater(e['tr_ns'],0);self.assertGreater(e['tf_ns'],0)
                        volts=float(next(v for v,s in part['ibis']['variants'].items() if s==suffix))
                        vi=ib.vi_edges(nd.ibis_model(part,rule['ibis_model']+suffix),1e-12,
                                       swing_v=volts,open_drain=rule['role']=='open_drain')
                        self.assertGreater(vi['tf_ns'],0);self.assertFalse(vi['qualified_fastest_bound'])
        self.assertEqual(files,9);self.assertEqual(count,92)

class IbisViScreeningTest(unittest.TestCase):
    def model(self):
        return ib.parse(('''[Model] OUT
Model_type Output
C_comp 3pF 2pF 4pF
[Voltage Range] 3.3 3.0 3.6
[Pulldown]
0 0 0 0
3.6 36mA 18mA 72mA
[Pullup]
0 0 0 0
3.6 -18mA -9mA -36mA
[Ramp]
dV/dt_r 3.3/0.1n 3.0/0.1n 3.6/0.1n
dV/dt_f 3.3/0.1n 3.0/0.1n 3.6/0.1n
[End]
''').splitlines())['models']['out']
    def test_static_mean_and_hand_calculated_load(self):
        m=self.model();e=ib.vi_edges(m,4.81e-12)
        self.assertAlmostEqual(ib.vi_avg_current(m['vi']['pulldown'],'typ',.33,2.97),.0165)
        self.assertAlmostEqual(e['tf_ns'],.3848);self.assertAlmostEqual(e['tr_ns'],.7696)
        self.assertEqual(e['corner_f'],'max');self.assertFalse(e['qualified_fastest_bound'])
        od=ib.vi_edges(m,4.81e-12,swing_v=3.3,open_drain=True)
        self.assertNotIn('tr_ns',od);self.assertAlmostEqual(od['tf_ns'],.3848)
    def test_ramp_time_is_a_lower_bound_of_the_edge(self):
        # D-124e. Ramp 3.3 V / 1 ns typ, 3.0 V / 1.5 ns min, 3.6 V / 0.5 ns max: 10-90 % of the corner's swing
        # (Voltage Range 3.3 / 3.0 / 3.6) = 0.8 V / (dV/dt) = 0.8, 1.2, 0.4 ns; the faster corner (max) is 0.4 ns.
        m=self.model();m['ramp']['f']=[(3.3,1e-9),(3.0,1.5e-9),(3.6,.5e-9)]
        e=ib.vi_edges(m,4.81e-12)       # C*dV/I (fall): typ .7696, max .3848 ns
        self.assertAlmostEqual(e['tf_ramp_ns'],.4);self.assertAlmostEqual(e['tf_vi_ns'],.3848)
        self.assertAlmostEqual(e['tf_ns'],.4);self.assertEqual(e['bound_f'],'ramp')
        e=ib.vi_edges(m,40e-12)         # C*dV/I (fall) max 3.2 ns > 0.4 ns
        self.assertAlmostEqual(e['tf_ns'],e['tf_vi_ns']);self.assertEqual(e['bound_f'],'C*dV/I')
    def test_missing_ramp_is_an_error(self):
        m=self.model();m['ramp']={}
        with self.assertRaises(ib.IbisError):ib.vi_edges(m,4.81e-12)
    def test_missing_corners_are_not_typical(self):
        m=self.model();m['vi']['pulldown'][0][1][2]=None
        e=ib.vi_edges(m,4.81e-12);self.assertEqual(e['corner_f'],'typ');self.assertEqual(e['missing_corners']['f'],['max'])
        with self.assertRaises(ib.IbisError):ib.vi_edges(m,4.81e-12,corners=('max',))
    def test_invalid_load_limit_interval_and_current(self):
        for c in (0,-1,float('nan'),float('inf')):
            with self.subTest(c=c),self.assertRaises(ib.IbisError):ib.vi_edges(self.model(),c)
        for limit in (0,-1,float('inf')):
            with self.subTest(limit=limit),self.assertRaises(ib.IbisError):ib.vi_edges(self.model(),1e-12,i_limit_a=limit)
        for rows in ([(0,[0]*3),(1,[.01]*3)],[(0,[.01]*3),(3.6,[-.01]*3)],[(0,[0]*3),(3.6,[0]*3)]):
            with self.subTest(rows=rows),self.assertRaises(ib.IbisError):ib.vi_avg_current(rows,'typ',.33,2.97)
    def test_malformed_duplicate_and_nonfinite_vi_rows_rejected(self):
        base='[Model] OUT\nModel_type Output\n[Pulldown]\n'
        for rows in ('0 0 0\n','NA 0 0 0\n','0 NA 0 0\n','0 0 0 0\n0 1 1 1\n','0 0 0 0\n1 1e999 0 0\n','0 0 0 0\n[Pulldown]\n'):
            with self.subTest(rows=rows),self.assertRaises(ib.IbisError):ib.parse((base+rows).splitlines())
    def test_series_limit_and_model_applicability(self):
        e=ib.vi_edges(self.model(),1e-12,i_limit_a=.001)
        self.assertAlmostEqual(e['tf_ns'],2.4);self.assertEqual(e['corner_f'],'min')
        m=self.model();m['type']='Input'
        with self.assertRaises(ib.IbisError):ib.vi_edges(m,1e-12)
        with self.assertRaises(ib.IbisError):ib.vi_edges(self.model(),1e-12,open_drain=True)

class DriverConditionalScreeningTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.file=Path(self.temp.name)/'x.ibs'
        self.driver_fixture=FIX.replace('C_comp 3pF NA 4pF','C_comp 3pF 2pF 4pF').replace('[Ramp]',
            '[Pulldown]\n0 0 0 0\n3.6 36mA 18mA 72mA\n[Pullup]\n0 0 0 0\n3.6 -18mA -9mA -36mA\n[Ramp]').replace('1/10n','3.3/0.1n').replace('1/1n','3.3/0.1n').replace('1/5n','3.3/0.1n')
        self.file.write_text(self.driver_fixture)
        self.part={'mpn':['GATE'],'ibis':{'file':str(self.file),'sha256':hashlib.sha256(self.file.read_bytes()).hexdigest(),'component':'GATE','supply_pin':'VCC','variants':{'3.3':'_33'},'url':'vendor','downloaded':'2026-10-09'},'pins':[{'match':'Y','role':'push_pull','ibis_model':'OUT','source':'vendor model'},{'match':'A|VCC','role':'input'}]}
        self.table={'gate':self.part}
        self.nl={'comps':{'U1':'GATE'},'values':{},'nets':{'VDD_3V3':[('U1','5','VCC')],'/Y':[('U1','4','Y')]}}
        self.geom={'length_mm':{'/Y':10},'pf_per_mm':{'/Y':(.1,'fixture microstrip')}}
    def test_actual_model_screen_never_certifies_bound(self):
        e=nd.net_edge('/Y',self.nl,self.table,geom=self.geom)
        self.assertAlmostEqual(e['edge_ns'],.24)
        self.assertFalse(e['timing_evidence']['qualified_fastest_bound'])
        proof=e['timing_evidence']['contributors'][0]['evidence']
        self.assertEqual(proof['kind'],'ibis_vi_load_estimate');self.assertEqual(proof['estimates'][0]['capacitance_pf'],3)
        self.assertEqual(proof['inputs']['trace_capacitance_pf'],1)
        self.assertEqual(proof['estimates'][0]['driver_c_comp_min_pf'],2)
        self.assertEqual(proof['estimates'][0]['corner_f'],'max')
        self.assertEqual(proof['primary_evidence']['sha256'],self.part['ibis']['sha256'])
    def test_wrong_component_pin_and_selector_unknown(self):
        self.nl['nets']['/Y']=[('U1','1','Y')]
        self.assertIn('selector mismatch',nd.net_edge('/Y',self.nl,self.table,geom=self.geom)['unknown'])
    def test_wrong_role_or_tampered_source_unknown(self):
        self.part['pins'][0]['role']='open_drain'
        self.nl['comps']['R1']='10k';self.nl['values']['R1']='10k'
        self.nl['nets']['/Y'].append(('R1','1','1'));self.nl['nets']['VDD_3V3'].append(('R1','2','2'))
        self.assertIn('incompatible',nd.net_edge('/Y',self.nl,self.table,geom=self.geom)['unknown'])
        self.part['pins'][0]['role']='push_pull';self.file.write_text(FIX+'\n| changed')
        self.assertIn('hash mismatch',nd.net_edge('/Y',self.nl,self.table,geom=self.geom)['unknown'])
    def test_unknown_driver_not_masked_by_model(self):
        self.nl['comps']['U2']='UNKNOWN';self.nl['nets']['/Y'].append(('U2','1','OUT'))
        self.assertIn('no entry',nd.net_edge('/Y',self.nl,self.table)['unknown'])
    def test_bound_formula_remains_conditional(self):
        rule=self.part['pins'][0];rule.pop('ibis_model');rule['bound']={'i_ma':20,'i_source':'approx drive','vdd_v':3.3,'cpin_pf':2,'cpin_source':'typ capacitance'}
        geom={'length_mm':{'/Y':10},'pf_per_mm':{'/Y':(.1,'estimatedmicrostrip')}}
        e=nd.net_edge('/Y',self.nl,self.table,geom=geom)
        self.assertAlmostEqual(e['edge_ns'],3*2.64/20)
        evidence=e['timing_evidence']['contributors'][0]['evidence']
        self.assertEqual(evidence['kind'],'conditional_capacitance_current_estimate');self.assertFalse(evidence['qualified_fastest_bound'])
        self.assertEqual(evidence['geometry_screening']['length_mm'],10)
        self.assertEqual(evidence['geometry_screening']['pf_per_mm'],(.1,'estimatedmicrostrip'))
        self.assertIn('conditional estimate: C*dV/I',e['driver'])
        self.assertIn('unknown',nd.net_edge('/Y',self.nl,self.table))
        self.assertIn('unknown',nd.net_edge('/Y',self.nl,self.table,geom={'length_mm':{'/Y':10}}))
    def test_formula_rejects_nonfinite_and_negative(self):
        for c,v,i in ((float('inf'),3.3,20),(1,-3.3,20),(1,3.3,0)):
            with self.assertRaises(nd.TableError):nd.edge_bound_ns(c,v,i)
    def test_real_sp3485_bound_and_unknowns_preserved(self):
        table=nd.load_table();role,e,rule=nd.pin_edge('SP3485EN-L/TR','RO',table)
        self.assertEqual(role,'bound');self.assertIsNone(e)
        self.assertEqual(nd.pin_edge('TPS2116DRLR','ST',table)[0],'unknown')
    def test_missing_min_capacitance_not_substituted(self):
        self.part['pins'][0]['match']='Y'
        self.file.write_text(self.driver_fixture.replace('C_comp 3pF 2pF 4pF','C_comp 3pF NA 4pF'))
        self.part['ibis']['sha256']=hashlib.sha256(self.file.read_bytes()).hexdigest()
        self.assertIsNone(nd.pin_c_pf('GATE','Y',self.table)[0])
        self.assertIn('C_comp minimum unavailable',nd.net_edge('/Y',self.nl,self.table,geom=self.geom)['unknown'])
    def test_invalid_geometry_is_unknown_not_a_screening_pass(self):
        rule=self.part['pins'][0];rule.pop('ibis_model');rule['bound']={'i_ma':20,'i_source':'approx','vdd_v':3.3}
        for value in (float('inf'),float('nan'),-1):
            geom={'length_mm':{'/Y':value},'pf_per_mm':{'/Y':(.1,'screen')}}
            self.assertIn('unknown',nd.net_edge('/Y',self.nl,self.table,geom=geom))
    def test_series_resistor_numeric_screen_not_qualified(self):
        rule=self.part['pins'][0];rule.pop('ibis_model');rule['bound']={'i_ma':20,'i_source':'approx','vdd_v':3.3}
        self.nl['comps']['R1']='10k';self.nl['values']['R1']='10k'
        self.nl['nets']['/Y'].append(('R1','1','1'));self.nl['nets']['/POST']=[('R1','2','2')]
        geom={'length_mm':{'/POST':10},'pf_per_mm':{'/POST':(.1,'screen')}}
        e=nd.net_edge('/POST',self.nl,self.table,geom=geom)
        self.assertAlmostEqual(e['edge_ns'],7.6);self.assertFalse(e['timing_evidence']['qualified_fastest_bound'])
    def test_unknown_supply_keeps_all_variant_uncertainty(self):
        self.nl['nets'].pop('VDD_3V3')
        e=nd.net_edge('/Y',self.nl,self.table,geom=self.geom)
        self.assertIn('rail not found',e['timing_evidence']['contributors'][0]['evidence']['estimates'][0]['supply_resolution'])
        self.assertFalse(e['timing_evidence']['qualified_fastest_bound'])
    def test_sibling_output_not_checked_as_selected_pin(self):
        self.part['pins'][0]['match']='Y|Z'
        self.nl['nets']['/Z']=[('U1','1','Z')] # sibling's distinct model is irrelevant to Y.
        self.assertAlmostEqual(nd.net_edge('/Y',self.nl,self.table,geom=self.geom)['edge_ns'],.24)

if __name__=='__main__':unittest.main()
