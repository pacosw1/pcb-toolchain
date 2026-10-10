"""Unknown timing cannot qualify a positive detour; numeric zero is no proof."""
import ast
import copy
from pathlib import Path
import types
import unittest
import si_planes as si


class UnknownDetourWasteTests(unittest.TestCase):
    def fixture(self, terminals=2):
        run=dict(length=1,at=(.5,0),terminals=[(i,0,.1) for i in range(terminals)],
                 bad_points=[(.25,0),(.75,0)],net='/SIG')
        result=dict(cross=0,cross_net=None,worst=1,worst_at=(.5,0),runs=[run])
        spec=dict(grounds=['GND'],exempt={'nets':{}},power=[],mixed_layers={},edge_classes={},
                  _edges={'/SIG':{'unknown':'missing manufacturer edge'}},_edge_rates={},_fast=[])
        return run,result,spec

    def assess(self, run, result, spec, callback, source='source'):
        return si.reference_assessment({('F.Cu','/SIG'):result},{'/SIG':'GND'},spec,callback,450,source)

    def proof(self, run, source='source'):
        track=types.SimpleNamespace(m_Uuid=types.SimpleNamespace(AsString=lambda:'actual-producer-fixture'))
        return si._NativeStubProof(source,track,'/SIG','F.Cu','GND',run)

    def test_positive_unknown_searches_are_never_requested(self):
        run,result,spec=self.fixture();calls=[]
        def callback(*args):
            calls.append(args[-1])
            if args[-1]>0: raise AssertionError('positive search cannot qualify unknown edge')
            return None
        assessed=self.assess(run,result,spec,callback)
        self.assertEqual(calls,[0.0])
        self.assertEqual(len(assessed['screening_failures']),1)
        self.assertEqual(len(assessed['timing_evidence_failures']),1)
        self.assertIn('detour not measured: missing edge bound',assessed['screening_failures'][0])
        self.assertNotIn('no reference path',assessed['screening_failures'][0])

    def test_raw_zero_false_dict_and_source_mismatch_cannot_mint_stub(self):
        for value in (0,0.0,False,True,{'contract':'native-unloaded-single-straight-leaf-v1'}):
            run,result,spec=self.fixture(1);run['_stub_proof']=value
            self.assertTrue(self.assess(run,result,spec,lambda *_:value)['screening_failures'])
        for change in ('source','net','layer','domain','run','contract'):
            run,result,spec=self.fixture(1);proof=self.proof(run);run['_stub_proof']=proof
            if change=='source':proof.record['source_sha256']='stale'
            elif change=='run':run['bad_points']=[(.3,0)]
            else:proof.record[change]='stale'
            assessed=self.assess(run,result,spec,lambda *_:0)
            self.assertTrue(assessed['screening_failures'],change)
            self.assertFalse(assessed['timing_evidence_complete'],change)

    def test_typed_current_native_proof_attached_by_producer_passes(self):
        run,result,spec=self.fixture(1);calls=[]
        def producer(layer,domain,target,budget):
            calls.append(budget);target['_stub_proof']=self.proof(target);return 0.0
        assessed=self.assess(run,result,spec,producer)
        self.assertEqual(calls,[0.0])
        self.assertEqual(assessed['screening_failures'],[])
        self.assertTrue(assessed['timing_evidence_complete'])
        # Without authoritative source identity the same typed proof rejects.
        self.assertTrue(self.assess(run,result,spec,producer,None)['screening_failures'])

    def test_known_budget_and_failure_diagnostic_remain(self):
        run,result,spec=self.fixture();spec['_edges']['/SIG']={'edge_ns':1,'driver':'fixture'};calls=[]
        def callback(*args):calls.append(args[-1]);return None
        self.assess(run,result,spec,callback)
        self.assertEqual(calls,[si.detour_budget_mm(1),20.0,450])

    def test_actual_native_callback_zero_budget_never_enters_grid(self):
        tree=ast.parse(Path(si.__file__).read_text())
        analyse=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='analyse')
        detour=next(n for n in analyse.body if isinstance(n,ast.FunctionDef) and n.name=='detour')
        def forbidden(*args):raise AssertionError('geometry/grid search started for nonqualifying zero-budget run')
        namespace=dict(_native_stub_matches=si._native_stub_matches,source_sha='source',
                       native_reference_geometry=forbidden,detour_mm=forbidden)
        exec(compile(ast.Module(body=[detour],type_ignores=[]),'<actual native detour callback>','exec'),namespace)
        for count in (0,2,3):
            run,_,_=self.fixture(count)
            self.assertIsNone(namespace['detour']('F.Cu','GND',run,0.0))
        # A single-terminal loaded pad/via still needs the native producer;
        # a failed proof must return without any detour grid or alternate plane.
        calls=[]
        namespace.update(layers={'In1.Cu':1},s={'adjacent':{'F.Cu':'In1.Cu'}},
                         reference_geometry={},p=object(),b=object(),fills={},caps={},copper_items=[],
                         native_reference_geometry=lambda *args:(calls.append('geometry') or (lambda *_:False,lambda *_:False)),
                         prove_native_stub=lambda *args:calls.append('proof'))
        run,_,_=self.fixture(1)
        self.assertIsNone(namespace['detour']('F.Cu','GND',run,0.0))
        self.assertEqual(calls,['geometry','proof'])


if __name__=='__main__':unittest.main()
