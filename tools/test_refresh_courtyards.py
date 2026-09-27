#!/usr/bin/env python3
"""Tests for tools/refresh_courtyards.py.  python3 tools/test_refresh_courtyards.py"""
import importlib.util, os, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('rc', os.path.join(HERE, 'refresh_courtyards.py'))
rc = importlib.util.module_from_spec(spec); spec.loader.exec_module(rc)

LIB = '''(module easyeda2kicad:C0603 (layer F.Cu)
	(pad 1 smd rect (at -0.7 0 0) (size 0.8 0.9) (layers F.Cu F.Paste F.Mask))
	(fp_rect (start -1.35 -0.7) (end 1.35 0.7) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))
  (model "x.step")
)'''

BOARD = '''(kicad_pcb
	(footprint "iot-lab:C1"
		(layer "F.Cu")
		(uuid "11111111-1111-1111-1111-111111111111")
		(at 10 20 90)
		(property "Reference" "C5"
			(at 0 -1 0)
		)
		(fp_line
			(start -1 -1)
			(end 1 -1)
			(stroke
				(width 0.12)
				(type solid)
			)
			(layer "F.SilkS")
			(uuid "22222222-2222-2222-2222-222222222222")
		)
		(fp_rect
			(start -1.64 -0.96)
			(end 1.64 0.96)
			(stroke
				(width 0.05)
				(type solid)
			)
			(fill no)
			(layer "F.CrtYd")
			(uuid "33333333-3333-3333-3333-333333333333")
		)
		(fp_circle
			(center 0 0)
			(end 1.25 0)
			(stroke
				(width 0.05)
				(type solid)
			)
			(fill no)
			(layer "F.CrtYd")
			(uuid "44444444-4444-4444-4444-444444444444")
		)
		(pad "1" smd rect
			(at -0.7 0 90)
			(size 0.8 0.9)
			(layers "F.Cu" "F.Paste" "F.Mask")
		)
		(model "x.step"
			(offset
				(xyz 0 0 0)
			)
		)
	)
	(footprint "MountingHole:MH"
		(layer "F.Cu")
		(uuid "55555555-5555-5555-5555-555555555555")
		(fp_circle
			(center 0 0)
			(end 3 0)
			(layer "F.CrtYd")
		)
	)
)
'''


class RefreshTest(unittest.TestCase):
    def setUp(self):
        self.lib = tempfile.mkdtemp()
        open(os.path.join(self.lib, 'C1.kicad_mod'), 'w').write(LIB)

    def test_replaces_only_the_courtyard_of_iot_lab_footprints(self):
        out, rows = rc.refresh(BOARD, self.lib)
        self.assertEqual(rows, [('C5', 'C1', (-1.64, -0.96, 1.64, 0.96), (-1.35, -0.7, 1.35, 0.7))])
        self.assertNotIn('33333333', out); self.assertNotIn('44444444', out)
        self.assertIn('(fp_rect (start -1.35 -0.7) (end 1.35 0.7) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd") (uuid "', out)
        self.assertIn('(end 3 0)\n\t\t\t(layer "F.CrtYd")', out)  # the mounting hole keeps its courtyard
        keep = lambda t: [l for l in t.splitlines() if 'F.CrtYd' not in l]
        old = keep(BOARD); new = keep(out)
        self.assertTrue(set(new) <= set(old))  # no other line is new or changed

    def test_is_deterministic_and_idempotent(self):
        out, _ = rc.refresh(BOARD, self.lib)
        self.assertEqual(rc.refresh(BOARD, self.lib)[0], out)
        self.assertEqual(rc.refresh(out, self.lib)[0], out)

    def test_bottom_side_footprint_fails(self):
        with self.assertRaises(ValueError):
            rc.refresh(BOARD.replace('(layer "F.Cu")\n\t\t(uuid "1111', '(layer "B.Cu")\n\t\t(uuid "1111'), self.lib)

    def test_missing_library_footprint_fails(self):
        with self.assertRaises(ValueError):
            rc.refresh(BOARD.replace('iot-lab:C1', 'iot-lab:C9'), self.lib)


if __name__ == '__main__':
    unittest.main()
