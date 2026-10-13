"""Source/pose/copper counterexamples for native placement import."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from pcb_search.contracts import fingerprint
from pcb_search.block_bindings import footprints
from pcb_search.native_placement import footprint_signature, read_proposal, restrict_movement, verify_preserved
from pcb_search.native_srj import digest, source_set
from test_pcb_search import placement_problem, PARAMS


PCB='''(kicad_pcb (version 20260101)
 (footprint "R" (at 2 5) (property "Reference" "A") (uuid "a"))
 (footprint "R" (at 8 5) (property "Reference" "B" (at 0 0)) (uuid "b")
  (pad "1" smd rect (at 1 0) (size .5 .8) (net "N") (uuid "pad")))
 (segment (start 8 5) (end 4 5) (width .2) (layer "F.Cu") (net "N") (uuid "t")))'''


class NativePlacementTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.source=self.root/'input.kicad_pcb';self.source.write_text(PCB)
        for ext in ('.kicad_pro','.kicad_dru','.kicad_sch'):self.source.with_suffix(ext).write_text('fixture')
        self.problem=placement_problem();self.problem['board_file']=str(self.source)
        self.raw=dict(problem=self.problem,params=PARAMS,attachments=[])
        self.model=self.root/'placement.json';self.model.write_text(json.dumps(self.raw))
        self.manifest=dict(schema='iot-lab.native-export.v1',status='candidate',source_mutated=False,
            board=str(self.source),inputs=source_set(self.source),placement_sha256=digest(self.model))
        (self.root/'record.json').write_text(json.dumps(self.manifest))
        self.result=dict(schema='iot-lab.placement-quench.v1',status='candidate',qualified=False,
            source_sha256=fingerprint(self.raw),pose=[[2,5,0],[8,4,0]])
        self.proposal=self.root/'proposal.json';self.proposal.write_text(json.dumps(self.result))
        self.target=self.root/'output.kicad_pcb'

    def test_input_source_and_model_changes_invalidate_export(self):
        self.assertEqual(read_proposal(self.root,self.proposal)[4]['status'],'candidate')
        for path in (self.source,self.source.with_suffix('.kicad_dru'),self.model):
            with self.subTest(path=path):
                original=path.read_text();path.write_text(original+' ')
                with self.assertRaisesRegex(ValueError,'stale'):read_proposal(self.root,self.proposal)
                path.write_text(original)

    def test_backend_claim_cannot_bypass_fixed_part_or_matching_input(self):
        cases=[dict(source_sha256='0'*64),dict(status='timeout'),dict(qualified=True),
               dict(pose=[[3,5,0],[8,4,0]])]
        for changes in cases:
            with self.subTest(changes=changes):
                self.proposal.write_text(json.dumps(dict(self.result,**changes)))
                with self.assertRaises(ValueError):read_proposal(self.root,self.proposal)

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
                with self.assertRaises(ValueError):verify_preserved(self.source,self.target,self.problem,self.result['pose'])

    def test_native_reordering_keeps_every_independent_footprint_item(self):
        original=footprints(self.source)[1];reordered=copy.deepcopy(original)
        reordered['form']=reordered['form'][:2]+list(reversed(reordered['form'][2:]))
        self.assertEqual(footprint_signature(original),footprint_signature(reordered))
        reordered['form'].append(copy.deepcopy(reordered['form'][2]))
        self.assertNotEqual(footprint_signature(original),footprint_signature(reordered))

    def test_locked_footprint_and_owned_board_geometry_are_not_exempted(self):
        self.source.write_text(PCB.replace('(uuid "b")','(locked yes) (uuid "b")'))
        self.target.write_text(self.source.read_text().replace('(at 8 5)','(at 8 4)'))
        with self.assertRaisesRegex(ValueError,'locked'):verify_preserved(self.source,self.target,self.problem,self.result['pose'])
        self.source.write_text(PCB);self.target.write_text(PCB.replace('(at 8 5)','(at 8 4)'))
        for field in ('cuts','borders','zones'):
            problem=copy.deepcopy(self.problem);problem['units'][1][field]=['owned']
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'geometry transform'):
                verify_preserved(self.source,self.target,problem,self.result['pose'])

    def test_sub_native_motion_does_not_claim_a_placement_change(self):
        self.target.write_text(PCB)
        with self.assertRaisesRegex(ValueError,'native coordinate precision'):
            verify_preserved(self.source,self.target,self.problem,[[2,5,0],[8+1e-9,5,0]])

    def test_movement_selection_preserves_fixed_parts_and_rigid_unit_membership(self):
        problem=copy.deepcopy(self.problem)
        restrict_movement(problem,['A','B'],no_rotate=True)
        self.assertTrue(problem['units'][0]['fixed']);self.assertFalse(problem['units'][1]['fixed'])
        self.assertTrue(all(not u['rotate'] for u in problem['units']))
        problem['units'][1]['refs'].append('C')
        with self.assertRaisesRegex(ValueError,'every reference'):restrict_movement(problem,['B'])
        with self.assertRaisesRegex(ValueError,'known'):restrict_movement(problem,['UNKNOWN'])
        restrict_movement(problem,['B','C'])
        self.assertTrue(problem['units'][0]['fixed']);self.assertFalse(problem['units'][1]['fixed'])


if __name__=='__main__':unittest.main()
