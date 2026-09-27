#!/usr/bin/env python3
"""Tests for tools/fp_courtyard.py.

  python3 tools/test_fp_courtyard.py
  uv run --no-project --python 3.12 --with cadquery-ocp python tools/test_fp_courtyard.py   (also runs the STEP test)
"""
import importlib.util, os, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('fc', os.path.join(HERE, 'fp_courtyard.py'))
fc = importlib.util.module_from_spec(spec); spec.loader.exec_module(fc)

FP = '''(footprint "X"
  (fp_line (start -3 -1) (end 3 -1) (layer F.Fab) (width 0.1))
  (fp_line (start -3 1) (end 3 1) (layer F.Fab) (width 0.1))
  (fp_line (start -5 -2) (end 5 2) (layer F.SilkS) (width 0.1))
  (fp_line (start -9 -9) (end 9 9) (layer F.Cu) (width 0.1))
  (pad 1 smd rect (at -3.5 0 90) (size 2 1) (layers F.Cu F.Paste F.Mask))
  (pad 2 thru_hole circle (at 3.5 0) (size 1 1) (drill 0.5) (layers *.Cu *.Mask))
  (fp_rect (start -5.25 -2.25) (end 5.25 2.25) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))
  (fp_line (start -6 -3) (end 6 -3) (layer F.CrtYd) (width 0.05))
  (model "${IOT_LAB}/x/part.wrl"
    (offset (xyz 1 1 0))
    (scale (xyz 1 1 1))
    (rotate (xyz 0 0 0))
  )
)'''
NO_FAB = FP.replace('(layer F.Fab)', '(layer F.SilkS)')


class PlaceTest(unittest.TestCase):
    """STEP xy box (y up) -> footprint box (y down), KiCad order: rotate, then offset."""
    RAW = (0, 0, 2, 1)

    def test_offset_and_y_flip(self):
        self.assertEqual(fc.place(self.RAW, (1, 1), 1, 0), (1, -2, 3, -1))

    def test_rotate_180(self):
        self.assertEqual(fc.place(self.RAW, (0, 0), 1, 180), (-2, 0, 0, 1))

    def test_rotate_90_is_clockwise_seen_from_top(self):
        # KiCad applies -rotate.z: (x, y) -> (y, -x) in the 3D frame
        self.assertEqual(fc.place(self.RAW, (0, 0), 1, 90), (0, 0, 1, 2))

    def test_scale(self):
        self.assertEqual(fc.place(self.RAW, (0, 0), 2, 0), (0, -2, 4, 0))


class ParseTest(unittest.TestCase):
    def test_pads_box_uses_pad_rotation(self):
        self.assertEqual(fc.pads_box(FP), (-4, -1, 4, 1))

    def test_fab_outline_ignores_circles_and_text(self):
        t = FP.replace('(pad 1', '(fp_circle (center 0 5) (end 0 6) (layer F.Fab) (width 0.1))\n  (pad 1')
        self.assertEqual(fc.fab_box(t), (-3, -1, 3, 1))
        self.assertIsNone(fc.fab_box(NO_FAB))

    def test_model_expands_iot_lab_and_prefers_step(self):
        path, off, scale, rot = fc.model(FP, env={'IOT_LAB': '/r'})
        self.assertEqual((path, off, scale, rot), ('/r/x/part.wrl', (1.0, 1.0), 1.0, 0.0))
        self.assertEqual(fc.step_candidates(path), ['/r/x/part.step', '/r/x/part.stp', '/r/x/part.wrl'])

    def test_model_rejects_non_uniform_scale_and_tilt(self):
        with self.assertRaises(ValueError):
            fc.model(FP.replace('(scale (xyz 1 1 1))', '(scale (xyz 1 2 1))'), env={})
        with self.assertRaises(ValueError):
            fc.model(FP.replace('(rotate (xyz 0 0 0))', '(rotate (xyz 90 0 0))'), env={})


class BodyTest(unittest.TestCase):
    def test_step_body_wins_when_aligned(self):
        body, src = fc.body_box(FP, step_box=lambda p: (-3.5, -0.5, 1.5, 0.5), bodies={})
        # raw x -3.5..1.5, y -0.5..0.5, offset (1, 1) -> x -2.5..2.5, y -1.5..-0.5
        self.assertEqual((body, src), ((-2.5, -1.5, 2.5, -0.5), 'step'))

    def test_misaligned_step_falls_back_to_fab(self):
        body, src = fc.body_box(FP, step_box=lambda p: (10, 10, 12, 12), bodies={})
        self.assertEqual(src, 'fab (step misaligned)')
        self.assertEqual(body, (-3, -1, 3, 1))

    def test_datasheet_body_when_no_step_and_no_fab(self):
        body, src = fc.body_box(NO_FAB, step_box=lambda p: None, bodies={'C1': {'body': [-1, -1, 1, 1]}}, key='C1')
        self.assertEqual((body, src), ((-1, -1, 1, 1), 'datasheet'))

    def test_no_body_source_fails(self):
        with self.assertRaises(ValueError):
            fc.body_box(NO_FAB, step_box=lambda p: None, bodies={})

    def test_aligned_allows_leads_under_pads_but_not_outside_silk(self):
        self.assertTrue(fc.aligned((-4.4, -1, 4.4, 1), FP))
        self.assertFalse(fc.aligned((-4, -1, 4, 3), FP))

    def test_aligned_accepts_a_body_inside_the_fab_outline(self):
        t = FP.replace('(start -3 1) (end 3 1) (layer F.Fab)', '(start -3 4) (end 3 4) (layer F.Fab)')
        self.assertTrue(fc.aligned((-3, -1, 3, 4), t))


class CourtyardTest(unittest.TestCase):
    def test_box_is_pads_and_body_plus_margin_silk_excluded(self):
        # pads x -4..4, y -1..1; body y -1.5..-0.5; silk x -5..5 is not used
        self.assertEqual(fc.box(FP, (-2.5, -1.5, 2.5, -0.5), 0.25), (-4.25, -1.75, 4.25, 1.25))

    def test_box_never_smaller_than_pads_plus_margin(self):
        self.assertEqual(fc.box(FP, (-0.1, -0.1, 0.1, 0.1), 0.25), (-4.25, -1.25, 4.25, 1.25))

    def test_set_replaces_every_courtyard_item_only(self):
        out = fc.set_courtyard(FP, (-4.25, -1.25, 4.25, 1.25))
        self.assertEqual(out.count('CrtYd'), 1)
        self.assertIn('(fp_rect (start -4.25 -1.25) (end 4.25 1.25) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))', out)
        self.assertLess(out.index('F.CrtYd'), out.index('(model'))
        keep = lambda t: [l for l in t.splitlines() if 'CrtYd' not in l]
        self.assertEqual(keep(out), keep(FP))
        self.assertEqual(fc.set_courtyard(out, (-4.25, -1.25, 4.25, 1.25)), out)

    def test_set_adds_courtyard_when_none(self):
        t = '\n'.join(l for l in FP.splitlines() if 'CrtYd' not in l)
        self.assertEqual(fc.set_courtyard(t, (0, 0, 1, 1)).count('F.CrtYd'), 1)


@unittest.skipUnless(importlib.util.find_spec('OCP'), 'OCP not installed; run with uv (see docstring)')
class StepTest(unittest.TestCase):
    def test_step_box_of_0603_capacitor_is_the_body(self):
        f = os.path.join(HERE, '..', 'hardware-design/registry/cad-assets/C14663/C14663.3dshapes/C0603_L1.6-W0.8-H0.8.step')
        self.assertEqual(tuple(round(v, 2) for v in fc.step_box(f)), (-0.8, -0.4, 0.8, 0.4))


if __name__ == '__main__':
    unittest.main()
