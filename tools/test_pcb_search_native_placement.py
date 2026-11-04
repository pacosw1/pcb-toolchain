"""Pose and copper counterexamples for native placement verification."""
import copy
from pathlib import Path
import tempfile
import unittest

from pcb_search.block_bindings import footprints
from pcb_search.native_placement import footprint_signature, verify_preserved


PCB='''(kicad_pcb (version 20260101)
 (footprint "R" (at 2 5) (property "Reference" "A") (uuid "a"))
 (footprint "R" (at 8 5) (property "Reference" "B" (at 0 0)) (uuid "b")
  (pad "1" smd rect (at 1 0) (size .5 .8) (net "N") (uuid "pad")))
 (segment (start 8 5) (end 4 5) (width .2) (layer "F.Cu") (net "N") (uuid "t")))'''
POSE=[[2,5,0],[8,4,0]]


def placement_problem():
    return dict(units=[dict(name=n,refs=[n],fixed=fixed,x=x,y=5.) for n,x,fixed in [('A',2.,True),('B',8.,False)]])


class NativePlacementTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.source=self.root/'input.kicad_pcb';self.source.write_text(PCB)
        for ext in ('.kicad_pro','.kicad_dru','.kicad_sch'):self.source.with_suffix(ext).write_text('fixture')
        self.problem=placement_problem();self.problem['board_file']=str(self.source)
        self.target=self.root/'output.kicad_pcb'

    def test_rigid_translation_and_quarter_turn_keep_pad_definition_and_copper(self):
        for quarter in (0,1):
            with self.subTest(quarter=quarter):
                text=PCB.replace('(at 8 5)',f'(at 8 4 {90*quarter})')
                if quarter:text=text.replace('(at 0 0)','(at 0 0 90)').replace('(at 1 0)','(at 1 0 90)')
                self.target.write_text(text)
                changed,_=verify_preserved(self.source,self.target,self.problem,[[2,5,0],[8,4,quarter]])
                self.assertEqual(changed,['B'])

    def test_native_pad_copper_other_footprint_and_pose_tampering_rejected(self):
        text=PCB.replace('(at 8 5)','(at 8 4)')
        changes=[text.replace('(net "N") (uuid "pad")','(net "OTHER") (uuid "pad")'),
                 text.replace('(size .5 .8)','(size .5 .9)'),text.replace('(width .2)','(width .3)'),
                 text.replace('(at 2 5)','(at 3 5)'),text.replace('(at 8 4)','(at 8 4.000001)')]
        for changed in changes:
            with self.subTest(changed=changed):
                self.target.write_text(changed)
                with self.assertRaises(ValueError):verify_preserved(self.source,self.target,self.problem,POSE)

    def test_native_reordering_keeps_every_independent_footprint_item(self):
        original=footprints(self.source)[1];reordered=copy.deepcopy(original)
        reordered['form']=reordered['form'][:2]+list(reversed(reordered['form'][2:]))
        self.assertEqual(footprint_signature(original),footprint_signature(reordered))
        reordered['form'].append(copy.deepcopy(reordered['form'][2]))
        self.assertNotEqual(footprint_signature(original),footprint_signature(reordered))

    def test_locked_footprint_and_owned_board_geometry_are_not_exempted(self):
        self.source.write_text(PCB.replace('(uuid "b")','(locked yes) (uuid "b")'))
        self.target.write_text(self.source.read_text().replace('(at 8 5)','(at 8 4)'))
        with self.assertRaisesRegex(ValueError,'locked'):verify_preserved(self.source,self.target,self.problem,POSE)
        self.source.write_text(PCB);self.target.write_text(PCB.replace('(at 8 5)','(at 8 4)'))
        for field in ('cuts','borders','zones'):
            problem=copy.deepcopy(self.problem);problem['units'][1][field]=['owned']
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'geometry transform'):
                verify_preserved(self.source,self.target,problem,POSE)

    def test_sub_native_motion_does_not_claim_a_placement_change(self):
        self.target.write_text(PCB)
        with self.assertRaisesRegex(ValueError,'native coordinate precision'):
            verify_preserved(self.source,self.target,self.problem,[[2,5,0],[8+1e-9,5,0]])

if __name__=='__main__':unittest.main()
