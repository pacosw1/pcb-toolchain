#!/usr/bin/env python3
"""Tests for tools/silk_refs.py.  python3 tools/test_silk_refs.py"""
import importlib.util, os, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('sr', os.path.join(HERE, 'silk_refs.py'))
sr = importlib.util.module_from_spec(spec); spec.loader.exec_module(sr)

BOARD = '''(kicad_pcb
	(footprint "iot-lab:C1"
		(layer "F.Cu")
		(property "Reference" "C5"
			(at 0 -1 0)
			(layer "F.SilkS")
			(uuid "a")
		)
		(property "Value" "100nF"
			(at 0 1 0)
			(layer "F.Fab")
			(hide yes)
			(uuid "b")
		)
		(fp_text user "+"
			(at 1 1 0)
			(layer "F.SilkS")
		)
	)
	(footprint "iot-lab:C2"
		(layer "B.Cu")
		(property "Reference" "J3"
			(at 0 -1 0)
			(layer "B.SilkS")
			(uuid "c")
		)
	)
	(footprint "iot-lab:C3"
		(layer "F.Cu")
		(property "Reference" "U1"
			(at 0 -1 0)
			(layer "F.Fab")
			(uuid "d")
		)
	)
	(gr_text "RS-485"
		(at 5 5 0)
		(layer "F.SilkS")
	)
)
'''


class SilkRefsTest(unittest.TestCase):
    def test_silk_references_move_to_fab(self):
        out, n = sr.refs_off_silk(BOARD)
        self.assertEqual(n, 2)
        self.assertIn('"Reference" "C5"\n\t\t\t(at 0 -1 0)\n\t\t\t(layer "F.Fab")', out)
        self.assertIn('"Reference" "J3"\n\t\t\t(at 0 -1 0)\n\t\t\t(layer "B.Fab")', out)

    def test_other_silk_texts_stay(self):
        out, _ = sr.refs_off_silk(BOARD)
        self.assertIn('(fp_text user "+"\n\t\t\t(at 1 1 0)\n\t\t\t(layer "F.SilkS")', out)
        self.assertIn('(gr_text "RS-485"\n\t\t(at 5 5 0)\n\t\t(layer "F.SilkS")', out)

    def test_fab_reference_and_value_unchanged_and_idempotent(self):
        out, _ = sr.refs_off_silk(BOARD)
        self.assertIn('"Reference" "U1"\n\t\t\t(at 0 -1 0)\n\t\t\t(layer "F.Fab")', out)
        self.assertEqual(sr.refs_off_silk(out), (out, 0))
        self.assertEqual(out.count('\n'), BOARD.count('\n'))


if __name__ == '__main__':
    unittest.main()
