"""Fail before search when an apparently reused module no longer matches."""
import json
from pathlib import Path
import tempfile
import unittest

from pcb_search.block_bindings import bind_instance, verify_binding, attach_to_units


def fp(ref,uid,net,xy,angle,*,mpn='ABC',pad_size='1 2'):
    return f'''(footprint "Lib:Exact" (layer "F.Cu") (at {xy} {angle})
        (path "{uid}") (property "Reference" "{ref}") (property "Value" "1k")
        (property "MPN" "{mpn}") (property "LCSC" "C123")
        (attr smd) (pad "1" smd rect (at 0 0 {angle}) (size {pad_size})
          (layers "F.Cu" "F.Paste" "F.Mask") (net "{net}") (uuid "{ref}-pad")))'''


class BlockBindingsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.block = root/'MODULE.kicad_block';self.block.mkdir()
        self.source = self.block/'MODULE.kicad_pcb'
        self.target = root/'target.kicad_pcb'
        self.source.write_text('(kicad_pcb '+fp('R1','/one','A','2 3',90)+fp('R2','/two','B','5 8',0)+')')
        self.target_text = '(kicad_pcb '+fp('R7','/instance/one','X','13 18',180)+fp('R8','/instance/two','Y','18 15',90)+')'
        self.target.write_text(self.target_text)
        for p in (self.source,self.target):
            for ext in ('.kicad_sch','.kicad_pro','.kicad_dru'):
                p.with_suffix(ext).write_text('{}')
        (self.block/'facts.json').write_text(json.dumps({'level':0,'ports':[],'open_items':['not bench verified']}))

    def bind(self):
        return bind_instance(self.block,self.target,'/instance')

    def test_exact_rigid_rotated_instance_and_fresh_unit_binding(self):
        b = self.bind()
        self.assertEqual(b['refs'],{'R1':'R7','R2':'R8'})
        self.assertEqual(b['net_map'],{'A':'X','B':'Y'})
        self.assertEqual(b['transform'],dict(rotation_quarters=1,translation_mm=['10','20']))
        self.assertFalse(b['qualified']);self.assertFalse(b['copper_reuse_approved'])
        self.assertEqual(b['declared_level'],0)
        p = {'board_file':str(self.target),'units':[{'name':'module','refs':['R7','R8']}]}
        result = attach_to_units(p,[b])
        self.assertEqual(result['block_bindings'][0]['unit'],'module')
        self.assertNotIn('block_bindings',p)
        with self.assertRaisesRegex(ValueError,'distinct intact'):
            attach_to_units(p,[b,b])

    def test_part_pad_and_relative_pose_changes_fail_early(self):
        changes = [('(property "MPN" "ABC")','(property "MPN" "OTHER")'),
                   ('(size 1 2)','(size 1 1)'),('(at 13 18 180)','(at 13.1 18 180)')]
        for old,new in changes:
            self.target.write_text(self.target_text.replace(old,new,1))
            with self.assertRaises(ValueError): self.bind()

    def test_missing_component_and_collapsed_nets_rejected(self):
        for old,new in [('"/instance/two"','"/another/two"'),('(net "Y")','(net "X")')]:
            self.target.write_text(self.target_text.replace(old,new))
            with self.assertRaises(ValueError): self.bind()

    def test_rule_or_source_revision_invalidates_binding(self):
        b = self.bind()
        self.target.with_suffix('.kicad_dru').write_text('new rule')
        with self.assertRaisesRegex(ValueError,'stale'): verify_binding(b)
        b = self.bind()
        (self.block/'facts.json').write_text('{"level":1}')
        with self.assertRaisesRegex(ValueError,'stale'): verify_binding(b)

    def test_split_units_or_wrong_target_cannot_claim_block_reuse(self):
        b = self.bind()
        for p in ({'board_file':str(self.target),'units':[{'name':'a','refs':['R7']},{'name':'b','refs':['R8']}]},
                  {'board_file':'/different.kicad_pcb','units':[{'name':'module','refs':['R7','R8']}]}):
            with self.assertRaises(ValueError): attach_to_units(p,[b])


if __name__ == '__main__':
    unittest.main()
