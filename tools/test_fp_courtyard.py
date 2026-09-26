#!/usr/bin/env python3
"""Tests for tools/fp_courtyard.py.  python3 tools/test_fp_courtyard.py"""
import importlib.util, os, unittest
spec = importlib.util.spec_from_file_location('fc', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fp_courtyard.py'))
fc = importlib.util.module_from_spec(spec); spec.loader.exec_module(fc)

FP = '''(footprint "X"
  (fp_line (start -3 -1) (end 3 -1) (layer F.Fab) (width 0.1))
  (fp_line (start -3 1) (end 3 1) (layer F.Fab) (width 0.1))
  (fp_line (start -5 -2) (end 5 2) (layer F.SilkS) (width 0.1))
  (fp_line (start -9 -9) (end 9 9) (layer F.Cu) (width 0.1))
  (pad 1 smd rect (at -3.5 0 90) (size 2 1) (layers F.Cu F.Paste F.Mask))
  (pad 2 thru_hole circle (at 3.5 0) (size 1 1) (drill 0.5) (layers *.Cu *.Mask))
  (model "x.step")
)'''


class CourtyardTest(unittest.TestCase):
    def test_box_is_pads_fab_and_silk_plus_margin(self):
        # pads x -4..4, y -1..1 (pad 1 rotated 90); fab x -3..3; silk body x -5..5, y -2..2; F.Cu line ignored
        self.assertEqual(fc.box(FP, 0.25), (-5.25, -2.25, 5.25, 2.25))

    def test_add_inserts_rect_before_model_once(self):
        out = fc.add(FP, 0.25)
        self.assertIn('(fp_rect (start -5.25 -2.25) (end 5.25 2.25) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))', out)
        self.assertLess(out.index('F.CrtYd'), out.index('(model'))
        self.assertEqual(fc.add(out, 0.25), out)


if __name__ == '__main__':
    unittest.main()
