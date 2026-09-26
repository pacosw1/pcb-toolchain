#!/usr/bin/env python3
"""Tests for tools/fp_courtyard.py.  python3 tools/test_fp_courtyard.py"""
import importlib.util, os, unittest
spec = importlib.util.spec_from_file_location('fc', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fp_courtyard.py'))
fc = importlib.util.module_from_spec(spec); spec.loader.exec_module(fc)

FP = '''(footprint "X"
  (fp_line (start -3 -1) (end 3 -1) (layer F.Fab) (width 0.1))
  (fp_line (start -3 1) (end 3 1) (layer F.Fab) (width 0.1))
  (fp_line (start -9 -9) (end 9 9) (layer F.SilkS) (width 0.1))
  (pad 1 smd rect (at -3.5 0 90) (size 2 1) (layers F.Cu F.Paste F.Mask))
  (pad 2 thru_hole circle (at 3.5 0) (size 1 1) (drill 0.5) (layers *.Cu *.Mask))
  (model "x.step")
)'''


class CourtyardTest(unittest.TestCase):
    def test_box_is_pads_and_fab_plus_margin_rotated_pad_counts(self):
        # pad 1 rotated 90: 1 wide in x, 2 tall in y -> x -4..-3, y -1..1 ; pad 2 x 3..4 ; fab x -3..3, y -1..1
        self.assertEqual(fc.box(FP, 0.25), (-4.25, -1.25, 4.25, 1.25))

    def test_add_inserts_rect_before_model_once(self):
        out = fc.add(FP, 0.25)
        self.assertIn('(fp_rect (start -4.25 -1.25) (end 4.25 1.25) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))', out)
        self.assertLess(out.index('F.CrtYd'), out.index('(model'))
        self.assertEqual(fc.add(out, 0.25), out)


if __name__ == '__main__':
    unittest.main()
