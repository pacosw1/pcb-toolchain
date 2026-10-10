import json
from pathlib import Path
import unittest
import tempfile
from unittest import mock
import base_b_route_rules as rules

ROOT=Path(__file__).resolve().parent.parent
CC=[('/J1_CC2','aed84668-2a32-46b0-939d-984b87638618'),
    ('/J1_CC1','03b6f5f4-2008-467c-9548-5d1463c7addc'),
    ('/J1_CC1','9e5cfac4-d917-46d3-8c7a-00f63bec06c8'),
    ('/J1_CC1','b356e523-f21b-4f5d-ba52-1db50f8be9e4')]

class PreservedPreflightTests(unittest.TestCase):
    def setUp(self):
        bd=ROOT/'hardware-design/boards/BASE-PWR-B'
        self.cfg=rules.evidence(bd,ROOT/'hardware-design/boards/BASE-PWR/cad/BASE-PWR-B/BASE-PWR-B.kicad_pro')
        self.pairs=json.loads((bd/'diff-pairs.json').read_text())['pairs']
        self.records=[dict(net=n,uuid=u,layer='In2.Cu',locked=False,via=False) for n,u in CC]
        self.records.append(dict(net='/USB_DN',uuid='ae741541-3be7-4872-b447-17a44922ae13',layer='F.Cu',locked=False,via=True))

    def test_captured_original_seed_five_immutable_faults(self):
        # UUIDs from frozen board SHA8f14b524...; input/base/routed records exact.
        faults=rules.preserved_input_faults(self.records,self.cfg,self.pairs,{'/J1_CC1','/J1_CC2'})
        self.assertEqual(len(faults),5)
        self.assertEqual({f['uuid'] for f in faults if 'uuid' in f},{u for _,u in CC})
        self.assertEqual(faults[-1]['via_uuids']['/USB_DN'],['ae741541-3be7-4872-b447-17a44922ae13'])
        self.assertEqual((faults[-1]['p'],faults[-1]['n']),(0,1))

    def test_explicitly_unlocked_routed_layer_faults_are_repairable(self):
        nets={'/J1_CC1','/J1_CC2'}
        faults=rules.preserved_input_faults(self.records,self.cfg,self.pairs,nets,unlock=nets)
        self.assertEqual(len(faults),1) # excluded USB pair still immutable

    def test_original_lock_survives_explicit_unlock_request(self):
        self.records[0]['locked']=True
        nets={'/J1_CC1','/J1_CC2','/USB_DP','/USB_DN'}
        faults=rules.preserved_input_faults(self.records,self.cfg,self.pairs,nets,unlock=nets)
        self.assertEqual(len(faults),1)
        self.assertEqual(faults[0]['uuid'],CC[0][1])

    def test_routed_usb_can_add_via_even_when_original_via_locked(self):
        self.records[-1]['locked']=True
        self.assertEqual(rules.preserved_input_faults(self.records[-1:],self.cfg,self.pairs,{'/USB_DP'}),[])

    def test_unrouted_net_remains_preserved_with_unlock_request(self):
        faults=rules.preserved_input_faults(self.records[:1],self.cfg,self.pairs,set(),unlock={'/J1_CC2'})
        self.assertEqual(len(faults),1)

    def test_legal_copper_does_not_block(self):
        self.records[0]['layer']='F.Cu'
        self.assertEqual(rules.preserved_input_faults(self.records[:1],self.cfg,self.pairs,set()),[])

    def profile(self,routed=()):
        return rules.preserved_usb_profile(ROOT/'hardware-design/boards/BASE-PWR-B','BASE-PWR-B',self.pairs,routed)

    def test_accepted_preserved_revb_profile_removes_only_unsupported_fifth(self):
        profile=self.profile()
        faults=rules.preserved_input_faults(self.records,self.cfg,self.pairs,{'/J1_CC1','/J1_CC2'},profile=profile)
        self.assertEqual(len(faults),4)
        self.assertEqual({f['uuid'] for f in faults},{u for _,u in CC})
        self.assertEqual(rules.pair_via_faults({'/USB_DN':1},self.pairs,profile),[])

    def test_accepted_profile_requires_exact_counts_not_arbitrary_imbalance(self):
        for p,n in ((0,0),(1,1),(1,2),(0,2),(1,0)):
            with self.subTest(p=p,n=n):
                faults=rules.pair_via_faults({'/USB_DP':p,'/USB_DN':n},self.pairs,self.profile())
                self.assertEqual(len(faults),1)

    def test_other_pairs_keep_equal_count_requirement(self):
        faults=rules.pair_via_faults({'/USB_DN':1,'/USB_MCU_DN':1},self.pairs,self.profile())
        self.assertEqual([f['pair'] for f in faults],['USB_MCU'])

    def test_profile_only_for_preserved_revb_pair(self):
        self.assertIsNone(self.profile({'/USB_DP'}))
        self.assertIsNone(rules.preserved_usb_profile(ROOT/'hardware-design/boards/BASE-PWR-B','BASE-PWR',self.pairs,set()))
        self.assertEqual(len(rules.pair_via_faults({'/USB_DN':1},self.pairs)),1)

    def test_changed_pair_or_net_rejects_profile(self):
        for key,value in (('name','OTHER'),('p','/OTHER_DP'),('n','/OTHER_DN')):
            pairs=json.loads(json.dumps(self.pairs));pairs[0][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):
                rules.preserved_usb_profile(ROOT/'hardware-design/boards/BASE-PWR-B','BASE-PWR-B',pairs,set())

    def test_changed_source_provenance_or_profile_rejects(self):
        bd=ROOT/'hardware-design/boards/BASE-PWR-B'
        original=Path.read_text
        for kind in ('counts','source_identity','source_excerpt','source_contents'):
            def changed(path,*args,**kwargs):
                text=original(path,*args,**kwargs)
                if path.name=='preserved-usb-policy.json':
                    value=json.loads(text)
                    if kind=='counts':value['expected_vias']['p']=1
                    if kind=='source_identity':value['sources'][0]['path']='hardware-design/STATUS.md'
                    if kind=='source_excerpt':value['sources'][0]['excerpt']='anything'
                    return json.dumps(value)
                if kind=='source_contents' and path.name=='DECISIONS.md':return text.replace('DN has 1 via, DP has 0','DN has 2 vias, DP has 0')
                return text
            with self.subTest(kind=kind),mock.patch.object(Path,'read_text',changed),self.assertRaises(ValueError):
                rules.preserved_usb_profile(bd,'BASE-PWR-B',self.pairs,set())

if __name__=='__main__':unittest.main()
