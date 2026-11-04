"""Accepted numeric screening values cannot silently certify fastest-edge bounds."""
import os,pathlib,sys,unittest,tempfile,json,copy
ROOT=pathlib.Path(os.environ.get('IOT_TEST_RULES_ROOT',pathlib.Path(__file__).resolve().parent.parent))
sys.path.insert(0,str(ROOT/'tools'));sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
import net_drivers as nd
import si_planes as sp

class TimingEvidenceTests(unittest.TestCase):
    def test_report_only_retains_missing_evidence_without_counting_it(self):
        s=sp.load_spec(dict(about='fixture',adjacent={'F.Cu':'In1.Cu'},plane_layers=['In1.Cu'],grounds=['GND'],mixed_layers={},power=[],edge_classes={},receivers={},offboard={}))
        sp.set_fast(s,{})
        r=dict(cross=0,runs=[{'length':2,'at':(0,0),'terminals':[(0,0,.1),(2,0,.1)]}],worst=2,worst_at=(0,0))
        for edge in ({'unknown':'missing driver'},{'edge_ns':2000,'driver':'screening only'}):
            with self.subTest(edge=edge):
                s['_edges']={'/SIG':edge}
                result=sp.reference_assessment({('F.Cu','/SIG'):r},{'/SIG':'GND'},s,lambda *_:0,200,report_only_timing=True)
                self.assertEqual(result['gate_failures'],[])
                self.assertEqual(len(result['gate_warnings']),1)
                self.assertTrue(result['gate_warnings'][0].startswith('WARN unproved-fastest-edge'))
                self.assertFalse(result['timing_evidence_complete'])
        s['_edges']={'/SIG':{'unknown':'missing driver'}}
        result=sp.reference_assessment({('F.Cu','/SIG'):r},{'/SIG':'GND'},s,lambda *_:None,200,report_only_timing=True)
        self.assertEqual(len(result['gate_failures']),1)
        self.assertTrue(result['gate_failures'][0].startswith('FAIL unknown-driver'))

    def setUp(self):
        self.saved=(nd.HERE,sp.EDGE_RATES_FILE);nd.HERE=str(ROOT/'tools');sp.EDGE_RATES_FILE=str(ROOT/'tools/edge-rates.json')
        self.addCleanup(self.restore)
        self.table=nd.load_table(ROOT/'tools/driver-edges.json')
        self.classes=sp.load_edge_rates(sp.EDGE_RATES_FILE)
        self.base=dict(about='fixture',adjacent={'F.Cu':'In1.Cu'},plane_layers=['In1.Cu'],grounds=['GND'],mixed_layers={},power=[],edge_classes={},receivers={},offboard={})
    def restore(self):nd.HERE,sp.EDGE_RATES_FILE=self.saved
    def netlist(self,mpn,pin):return {'comps':{'U1':mpn},'nets':{'/SIG':[('U1','1',pin)]}}
    def assess(self,edge,runs=True):
        s=sp.load_spec(self.base);s['_edges']={'/SIG':edge};sp.set_fast(s,{})
        r=dict(cross=0,runs=[{'length':2,'at':(0,0),'terminals':[(0,0,.1),(2,0,.1)]}] if runs else [],worst=2,worst_at=(0,0),cross_net=None)
        return sp.reference_assessment({('F.Cu','/SIG'):r},{'/SIG':'GND'},s,detour=lambda *_:0,board_mm=200)

    def test_thvd_typ460_perimeter_screen_is_not_physical_bound(self):
        edge=nd.net_edge('/SIG',self.netlist('THVD1410DR','A'),self.table,classes=self.classes,interface='rs485')
        self.assertEqual(edge['edge_ns'],460)
        result=self.assess(edge)
        self.assertEqual(result['screening_failures'],[])
        self.assertEqual(len(result['timing_evidence_failures']),1)
        self.assertFalse(result['timing_evidence_complete'])

    def test_max_only_driver_cannot_certify_fastest_edge(self):
        edge=nd.net_edge('/SIG',self.netlist('STM32H743VIT6','PE10'),self.table)
        self.assertIn('edge_ns',edge)
        self.assertFalse(edge['timing_evidence']['qualified_fastest_bound'])
        self.assertEqual(len(self.assess(edge)['timing_evidence_failures']),1)

    def test_line_side_100base_edge_remains_screening_only(self):
        edge=nd.net_edge('/SIG',self.netlist('UNKNOWN','OUT'),self.table,classes=self.classes,interface='100base_tx')
        self.assertEqual(edge['edge_ns'],3.0)
        self.assertFalse(edge['timing_evidence']['qualified_fastest_bound'])
        self.assertFalse(self.assess(edge)['timing_evidence_complete'])

    def test_sourced_minimum_control_under_stated_source_conditions(self):
        table={'fixture':{'mpn':['MIN-PART'],'pins':[{'match':'OUT','role':'push_pull','tr_ns':1,'tf_ns':2,'stat':'min','load':'stated fixture load','source':'reviewed fixture minimum'}]}}
        rule=table['fixture']['pins'][0]
        rule['_minimum_proof']=nd._ReviewedMinimumProof(nd._minimum_record_hash('fixture',['MIN-PART'],rule),
            ('fixture-primary','fixture-sha'),'driver pin under matched fixture conditions','matched fixture electrical load/PVT',True)
        edge=nd.net_edge('/SIG',self.netlist('MIN-PART','OUT'),table)
        self.assertTrue(edge['timing_evidence']['qualified_fastest_bound'])
        self.assertTrue(self.assess(edge)['timing_evidence_complete'])

    def test_actual_lan8742_minimum_is_retained_with_its_load_scope(self):
        edge=nd.net_edge('/SIG',self.netlist('LAN8742A-CZ-TR','TXP'),self.table)
        self.assertEqual(edge['edge_ns'],3)
        evidence=edge['timing_evidence']['contributors'][0]['evidence']
        self.assertEqual(evidence['stat'],'min');self.assertIn('Note 1',evidence['load'])
        self.assertTrue(evidence['source_MIN_verified'])
        self.assertFalse(evidence['applicable_driver_bound'])
        self.assertEqual(evidence['measurement_boundary'],'line side of transformer')
        self.assertIn('100 ohm',evidence['source_conditions'])
        self.assertFalse(self.assess(edge)['timing_evidence_complete'])

    def test_typ_driver_cannot_hide_behind_faster_stored_min_driver(self):
        table={'minimum':{'mpn':['MIN'],'pins':[{'match':'OUT','role':'push_pull','tr_ns':1,'tf_ns':1,'stat':'min','source':'fixture minimum'}]},'typical':{'mpn':['TYP'],'pins':[{'match':'OUT','role':'push_pull','tr_ns':20,'tf_ns':20,'stat':'typ','source':'fixture typical'}]}}
        minimum=table['minimum']['pins'][0]
        minimum['_minimum_proof']=nd._ReviewedMinimumProof(nd._minimum_record_hash('minimum',['MIN'],minimum),
            ('fixture-primary','fixture-sha'),'driver pin under matched fixture conditions','matched fixture electrical load/PVT',True)
        nl={'comps':{'U1':'MIN','U2':'TYP'},'nets':{'/SIG':[('U1','1','OUT'),('U2','1','OUT')]}}
        edge=nd.net_edge('/SIG',nl,table)
        self.assertEqual(edge['edge_ns'],1)
        self.assertEqual([d['evidence']['qualified_fastest_bound'] for d in edge['timing_evidence']['contributors']],[True,False])
        self.assertFalse(edge['timing_evidence']['qualified_fastest_bound'])
        self.assertFalse(self.assess(edge)['timing_evidence_complete'])

    def test_unknown_sp3485_cannot_inherit_partclass_or_qualified_status(self):
        edge=nd.net_edge('/SIG',self.netlist('SP3485EN-L/TR','A'),self.table,classes=self.classes,interface='rs485')
        self.assertIn('unknown',edge);self.assertNotIn('edge_ns',edge)
        self.assertFalse(self.assess(edge)['timing_evidence_complete'])

    def test_continuous_reference_does_not_depend_on_unproved_timing(self):
        edge=nd.net_edge('/SIG',self.netlist('THVD1410DR','A'),self.table,classes=self.classes,interface='rs485')
        result=self.assess(edge,runs=False)
        self.assertEqual(result['timing_evidence_failures'],[])
        self.assertTrue(result['timing_evidence_complete'])

    def test_typ_to_min_label_tamper_never_mints_reviewed_bound(self):
        raw=json.loads((ROOT/'tools/driver-edges.json').read_text())
        raw['parts']['74HC08']['pins'][0]['stat']='min'
        with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as f:
            json.dump(raw,f);f.flush();table=nd.load_table(f.name)
        edge=nd.net_edge('/SIG',self.netlist('74HC08D','1Y'),table)
        self.assertFalse(edge['timing_evidence']['qualified_fastest_bound'])
        self.assertFalse(edge['timing_evidence']['contributors'][0]['evidence']['source_MIN_verified'])

    def test_min_record_pin_mpn_stat_and_primary_declaration_are_bound(self):
        for mutation in ('stat','mpn','pin','value'):
            table=copy.deepcopy(self.table);part=table['LAN8742A'];rule=part['pins'][0]
            if mutation=='stat':rule['stat']='typ'
            if mutation=='mpn':part['mpn']=['DIFFERENT*']
            if mutation=='pin':rule['match']='OUT'
            if mutation=='value':rule['tr_ns']=4
            with self.subTest(mutation=mutation):
                quality=nd.timing_evidence(rule,'LAN8742A',part['mpn'])
                self.assertFalse(quality['source_MIN_verified']);self.assertFalse(quality['qualified_fastest_bound'])
        raw=json.loads((ROOT/'tools/driver-edges.json').read_text())
        raw['evidence_files']=[e for e in raw['evidence_files'] if 'LAN8742A' not in e['path']]
        with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as f:
            json.dump(raw,f);f.flush()
            with self.assertRaises(nd.TableError):nd.load_table(f.name)

    def test_typed_producer_stub_proof_matches_exact_run_and_source(self):
        source='fixture-source';run=dict(length=2,at=(1,0),terminals=[(0,0,.1)],bad_points=[(1,0),(2,0)],net='/SIG')
        track=type('Track',(),{'m_Uuid':type('UUID',(),{'AsString':lambda self:'native-producer-fixture-track'})()})()
        proof=sp._NativeStubProof(source,track,'/SIG','F.Cu','GND',run)
        run['_stub_proof']=proof
        s=sp.load_spec(self.base);s['_edges']={'/SIG':{'unknown':'fixture'}};sp.set_fast(s,{})
        r=dict(cross=0,runs=[run],worst=2,worst_at=(1,0))
        assess=lambda sha:sp.reference_assessment({('F.Cu','/SIG'):r},{'/SIG':'GND'},s,detour=lambda *_:0,board_mm=200,source_sha=sha)
        self.assertTrue(assess(source)['timing_evidence_complete'])
        self.assertFalse(assess('wrong-source')['timing_evidence_complete'])
        run['_stub_proof']=True
        self.assertFalse(assess(source)['timing_evidence_complete'])
        run['_stub_proof']=proof;run['bad_points']=[(1.5,0)]
        self.assertFalse(assess(source)['timing_evidence_complete'])
        run['bad_points']=[(1,0),(2,0)];proof.record['contract']='raw-user-claim'
        self.assertFalse(assess(source)['timing_evidence_complete'])

    def test_raw_zero_callback_never_mints_single_terminal_stub_proof(self):
        edge=nd.net_edge('/SIG',self.netlist('THVD1410DR','A'),self.table,classes=self.classes,interface='rs485')
        s=sp.load_spec(self.base);s['_edges']={'/SIG':edge};sp.set_fast(s,{})
        run=dict(length=2,at=(1,0),terminals=[(0,0,.1)],bad_points=[(1,0),(2,0)],net='/SIG')
        r=dict(cross=0,runs=[run],worst=2,worst_at=(1,0));calls=[]
        def raw_zero(*args):calls.append(args[-1]);return 0
        result=sp.reference_assessment({('F.Cu','/SIG'):r},{'/SIG':'GND'},s,raw_zero,board_mm=200,source_sha='fixture-source')
        self.assertEqual(calls,[0.0]);self.assertEqual(result['screening_failures'],[])
        self.assertFalse(result['timing_evidence_complete'])
        self.assertNotIn('_stub_proof',run)

if __name__=='__main__':unittest.main()
