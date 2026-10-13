"""Native local-repair counterexamples; dimensions are synthetic fixtures."""
from pathlib import Path
import tempfile
import unittest

from pcb_search.native_candidate import copper_items
from pcb_search.native_eco import shift_via
from pcb_search.native_srj import geometry_digest, source_set


PCB = '''(kicad_pcb (version 20260101)
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
 (footprint "R" (at 3 4) (property "Reference" "R1") (uuid "fp"))
 (segment (start 0 0) (end 2 0) (width .25) (layer "F.Cu") (net "A") (uuid "top"))
 (segment (start -1 -1) (end 0 0) (width .15) (layer "B.Cu") (net "A") (uuid "bottom"))
 (via (at 0 0) (size .6) (drill .3) (layers "F.Cu" "B.Cu") (net "A") (uuid "via")))'''


class NativeEcoTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.board=self.root/'input.kicad_pcb'
        self.board.write_text(PCB)
        for ext in ('.kicad_pro','.kicad_dru','.kicad_sch'):
            self.board.with_suffix(ext).write_text('fixture')

    def test_via_moves_on_source_track_and_other_layer_keeps_its_connection(self):
        before=source_set(self.board)
        r=shift_via(self.board,'via','top',self.root/'out',fraction=.5)
        target=self.root/'out/proposal.kicad_pcb'
        self.assertEqual(r['destination_mm'],['1.000000','0.000000'])
        self.assertEqual(geometry_digest(self.board,['via']),geometry_digest(target,['via',r['added_bridge_id']]))
        text,items=copper_items(target)
        a,b=items[r['added_bridge_id']]['span'];bridge=text[a:b]
        self.assertIn('(start 0 0)',bridge)
        self.assertIn('(end 1.000000 0.000000)',bridge)
        self.assertIn('(layer "B.Cu")',bridge)
        self.assertIn('(width .15)',bridge)
        self.assertEqual(items[r['added_bridge_id']]['net'],'A')
        self.assertEqual(before,source_set(self.board))
        self.assertFalse(r['qualified']);self.assertTrue(r['native_and_board_specific_gates_required'])
        with self.assertRaisesRegex(ValueError,'new separate'):
            shift_via(self.board,'via','top',self.root/'out',fraction=.5)

    def test_locked_branch_and_wrong_layer_repairs_abstain(self):
        variants=[PCB.replace('(via (at','(via (locked yes) (at'),
                  PCB.replace('(via (at','(via micro (at'),
                  PCB.replace('(via (at','(via blind (at'),
                  PCB.replace('(uuid "top")','(locked yes) (uuid "top")'),
                  PCB.replace('(layer "B.Cu") (net "A")','(layer "F.Cu") (net "A")'),
                  PCB[:-1]+'(segment (start 0 0) (end 0 2) (width .15) (layer "B.Cu") (net "A") (uuid "branch")))',
                  PCB[:-1]+'(segment (start -1 0) (end 1 0) (width .15) (layer "B.Cu") (net "A") (uuid "mid")))']
        for value in variants:
            with self.subTest(value=value):
                self.board.write_text(value)
                with self.assertRaises(ValueError):shift_via(self.board,'via','top',self.root/'out',fraction=.5)
                self.assertFalse((self.root/'out').exists())

    def test_fraction_and_subgrid_moves_cannot_break_the_original_anchor(self):
        for value in (0,1,-.1,True,float('nan')):
            with self.subTest(value=value),self.assertRaises(ValueError):
                shift_via(self.board,'via','top',self.root/'out',fraction=value)
        self.board.write_text(PCB.replace('(end 2 0)','(end 0.000001 0)'))
        with self.assertRaisesRegex(ValueError,'precision'):
            shift_via(self.board,'via','top',self.root/'out',fraction=.1)


if __name__=='__main__':unittest.main()
