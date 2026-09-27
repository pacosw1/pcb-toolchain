"""Tests for the pure parts of tools/render_with_plugs.py.

Run: python3 tools/test_render_with_plugs.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render_with_plugs as rp

BOM = '''Designator,Function,MPN,Manufacturer,LCSC,Package
J1,RELAY LINK from INPUT-4D2A J2,WJ15EDGRC-3.81-04P-14-00A,Kangnex,C7245,"3.81 mm header"
P1,Mating plug for J1 (loose),WJ15EDGK-3.81-04P-14-00A,Kangnex,C7244,3.81 mm plug
"J3,J4","Mains terminals, 4 poles",WJ2EDGRC-5.08-04P-14-00A,Kangnex,C8446,"5.08 mm pluggable header"
"P3,P4",Mating plugs for J3/J4 (loose),WJ2EDGK-5.08-04P-14-00A,Kangnex,C71372,5.08 mm pluggable plug
J5,Fan connector,530470310,MOLEX,C122442,P=1.25mm
'''

SPEC = '''| Ref | Part | Pins |
| --- | --- | --- |
| J1 "24V IN" | MX2EDGRC-5.08-02P C5188019 (5.08 mm pluggable, right angle), loose plug P1 MX2EDGK-5.08-02P C5187912 | 1 +24 V |
| J2-J21 | MX15EDGRC-3.5-02P C5188295 (3.5 mm pluggable), loose plugs MX15EDGK-3.5-02P C5188249 | 1 24 V |
| J3 | MX15EDGRC-3.5-08P C5188301, plug P3 MX15EDGK-3.5-08P C5188255 | 1 24V_S |
| P3, P4 | Loose plugs 8P (not PCBA) | MX15EDGK-3.5-08P-GN01-Cu-Y-A | C5188255 | Extended |
| Mains terminals | 2 x 4-pole 5.08 mm pluggable (C8446 + C71372) |
'''

FOOTPRINT = '''	(footprint "iot-lab:C7245"
		(layer "F.Cu")
		(at 120.77 108.1 180)
		(pad "1" thru_hole rect
			(at -5.72 0 180)
		)
		(pad "4" thru_hole circle
			(at 5.72 0 180)
		)
		(fp_rect
			(start -8.31 -1.85)
			(end 8.31 7.8)
			(layer "F.CrtYd")
		)
		(model "${IOT_LAB}/x/C7245.step"
			(offset
				(xyz 0 -2.98 0)
			)
		)
	)
'''


class BomTests(unittest.TestCase):
    def test_bom_maps_header_to_plug(self):
        self.assertEqual(rp.plugs_from_bom(BOM), {'C7245': 'C7244', 'C8446': 'C71372'})

    def test_spec_maps_header_to_plug_in_one_cell(self):
        self.assertEqual(rp.plugs_from_spec(SPEC),
                         {'C5188019': 'C5187912', 'C5188295': 'C5188249', 'C5188301': 'C5188255'})

    def test_merge_rejects_a_conflict(self):
        self.assertEqual(rp.merge_maps({'C1': 'C2'}, {'C1': 'C2', 'C3': 'C4'}), {'C1': 'C2', 'C3': 'C4'})
        with self.assertRaises(ValueError):
            rp.merge_maps({'C1': 'C2'}, {'C1': 'C9'})


class FootprintTests(unittest.TestCase):
    def test_footprints_gives_header_code_and_geometry(self):
        fps = list(rp.footprints('(kicad_pcb\n' + FOOTPRINT + ')'))
        self.assertEqual(len(fps), 1)
        fp = fps[0]
        self.assertEqual(fp['code'], 'C7245')
        self.assertEqual(fp['pad_x'], [-5.72, 5.72])
        self.assertEqual(fp['courtyard'], (-8.31, -1.85, 8.31, 7.8))

    def test_add_model_inserts_before_the_footprint_end(self):
        text = '(kicad_pcb\n' + FOOTPRINT + ')'
        fp = next(rp.footprints(text))
        out = rp.add_model(text, fp, '/p/plug.step', (0.0, -7.55, -1.55), 180)
        self.assertEqual(out.count('(model '), 2)
        self.assertIn('(model "/p/plug.step" (offset (xyz 0 -7.55 -1.55)) (scale (xyz 1 1 1)) '
                      '(rotate (xyz 0 0 180)))\n\t)', out)
        self.assertTrue(out.endswith(')'))


class OffsetTests(unittest.TestCase):
    def test_opening_on_plus_y_turns_the_plug(self):
        # courtyard y -1.85..7.8: the opening is on footprint +y (Y down), which is model -y
        off, rot = rp.plug_transform((-8.31, -1.85, 8.31, 7.8), [-5.72, 5.72], -1.55)
        self.assertEqual(rot, 180)
        self.assertAlmostEqual(off[0], 0.0)
        self.assertAlmostEqual(off[1], -7.55)
        self.assertAlmostEqual(off[2], -1.55)

    def test_opening_on_minus_y_keeps_the_plug(self):
        off, rot = rp.plug_transform((-2.0, -9.0, 5.5, 1.5), [0.0, 3.5], 0.5)
        self.assertEqual(rot, 0)
        self.assertAlmostEqual(off[0], 1.75)
        self.assertAlmostEqual(off[1], 8.75)
        self.assertAlmostEqual(off[2], 0.5)


if __name__ == '__main__':
    unittest.main()
