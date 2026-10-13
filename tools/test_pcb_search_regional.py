"""Regional width changes must not alter protected copper or claim completion."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from env_routing_rules import applies
from pcb_search.native_srj import geometry_digest
from pcb_search.regional import normalize


def segment(uid,x,y,width):
    return f'(segment (start {x} {y}) (end {x+1} {y}) (width {width}) (layer "F.Cu") (net "A") (uuid "{uid}"))'


class RegionalTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.source=self.root/'source.kicad_pcb';self.backend=self.root/'backend.kicad_pcb'
        self.source.write_text('(kicad_pcb '+segment('kept',1,1,.25)+')')
        for ext in ('.kicad_pro','.kicad_dru','.kicad_sch'):self.source.with_suffix(ext).write_text('{}')
        self.backend.write_text('(kicad_pcb '+segment('kept',1,1,.25)+segment('new',2,2,.25)+segment('outside',2,8,.25)+')')
        self.rule=dict(id='test',bounds=[0,None,4,4],layers=['F.Cu','B.Cu'],preferred_width_mm=.15,
                       max_width_mm=.2,selection='segment_midpoint',source='synthetic fixture')
        self.spec=dict(regions=[self.rule],min_width_mm=.15)
        self.patch=mock.patch('pcb_search.regional.policy',return_value=copy.deepcopy(self.spec))
        self.patch.start();self.addCleanup(self.patch.stop)

    def test_only_new_matching_segments_change_and_partial_stays_partial(self):
        before=self.backend.read_text();out=self.root/'out'
        result=normalize(self.source,self.backend,self.spec,out,completed=False)
        self.assertEqual(result['status'],'partial');self.assertFalse(result['qualified'])
        self.assertEqual([r['uuid'] for r in result['changes']],['new'])
        actual=(out/'proposal.kicad_pcb').read_text()
        self.assertIn(segment('kept',1,1,.25),actual)
        self.assertIn(segment('outside',2,8,.25),actual)
        self.assertIn('(width 0.150000000)',actual)
        self.assertEqual(before,self.backend.read_text())
        self.assertEqual(geometry_digest(self.source),geometry_digest(out/'proposal.kicad_pcb',['new','outside']))

    def test_policy_edit_cannot_keep_old_attribution(self):
        changed=copy.deepcopy(self.spec);changed['regions'][0]['preferred_width_mm']=.1
        with self.assertRaisesRegex(ValueError,'policy'):
            normalize(self.source,self.backend,changed,self.root/'out',completed=False)
        self.assertFalse((self.root/'out').exists())

    def test_protected_edit_or_undersized_new_copper_rejects(self):
        for old,new in (('"kept"','"different"'),('(width 0.25)','(width 0.1)')):
            original=self.backend.read_text();self.backend.write_text(original.replace(old,new,1))
            with self.assertRaises(ValueError):
                normalize(self.source,self.backend,self.spec,self.root/'out',completed=False)
            self.backend.write_text(original)
        self.backend.write_text(self.backend.read_text().replace(segment('new',2,2,.25),segment('new',2,2,.1)))
        with self.assertRaisesRegex(ValueError,'minimum'):
            normalize(self.source,self.backend,self.spec,self.root/'out',completed=False)

    def test_existing_midpoint_semantics_and_layer_scope_are_explicit(self):
        self.assertTrue(applies(self.rule,(-1,1),(3,1),'F.Cu'))
        self.assertTrue(applies(self.rule,(1,-20),(2,-20),'B.Cu'))
        self.assertFalse(applies(self.rule,(1,8),(2,8),'F.Cu'))
        self.assertFalse(applies(self.rule,(1,1),(2,1),'In1.Cu'))


if __name__=='__main__':unittest.main()
