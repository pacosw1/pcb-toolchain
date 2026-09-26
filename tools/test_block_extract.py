#!/usr/bin/env python3
"""Unit tests for the pure core of tools/block_extract.py (no pcbnew).

  python3 tools/test_block_extract.py
"""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('block_extract', os.path.join(HERE, 'block_extract.py'))
bx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bx)

SCH = '''(kicad_sch (version 20260306) (generator "eeschema") (generator_version "10.0")
  (uuid "root-1") (paper "A3")
  (title_block (title "BOARD"))
  (lib_symbols
	(symbol "AUTO:D" (pin_names (offset 0)) (property "Reference" "D" (at 0 0 0)))
	(symbol "AUTO:R" (property "Reference" "R" (at 0 0 0)))
  )
	(symbol
		(lib_id "AUTO:D") (at 10 10 0) (unit 1)
		(uuid "sym-d4")
		(property "Reference" "D4" (at 10 8 0))
		(property "Footprint" "Diode_SMD:D_SMC" (at 10 10 0))
		(instances (project "BOARD" (path "/root-1" (reference "D4") (unit 1))))
	)
	(symbol
		(lib_id "AUTO:R") (at 90 90 0) (unit 1)
		(uuid "sym-r1")
		(property "Reference" "R1" (at 90 88 0))
		(instances (project "BOARD" (path "/root-1" (reference "R1") (unit 1))))
	)
	(wire (pts (xy 5 10) (xy 12 10)) (uuid "w-in"))
	(wire (pts (xy 12 10) (xy 80 10)) (uuid "w-cross"))
	(label "A (x)" (at 5 10 0) (uuid "l-in"))
	(text "note" (at 90 5 0) (uuid "t-out"))
  (sheet_instances (path "/" (page "1")))
  (embedded_fonts no)
)
'''


class SplitTest(unittest.TestCase):
    def test_top_level_children_with_strings_holding_parens(self):
        heads = [bx.head(c) for c in bx.children(SCH)]
        self.assertEqual(heads, ['version', 'generator', 'generator_version', 'uuid', 'paper', 'title_block',
                                 'lib_symbols', 'symbol', 'symbol', 'wire', 'wire', 'label', 'text',
                                 'sheet_instances', 'embedded_fonts'])


class CropSchTest(unittest.TestCase):
    def setUp(self):
        self.out = bx.crop_sch(SCH, (0, 0, 20, 20), 'PWR-24V-IN')

    def test_keeps_items_fully_inside_box_only(self):
        self.assertIn('"sym-d4"', self.out)
        self.assertIn('"w-in"', self.out)
        self.assertIn('"l-in"', self.out)
        for u in ('"sym-r1"', '"w-cross"', '"t-out"'):
            self.assertNotIn(u, self.out)

    def test_lib_symbols_filtered_to_used(self):
        self.assertIn('(symbol "AUTO:D"', self.out)
        self.assertNotIn('(symbol "AUTO:R"', self.out)

    def test_project_renamed_root_uuid_kept_title_dropped(self):
        self.assertIn('(project "PWR-24V-IN" (path "/root-1"', self.out)
        self.assertNotIn('"BOARD"', self.out)
        self.assertIn('(uuid "root-1")', self.out)

    def test_output_is_balanced_and_keeps_footer(self):
        self.assertEqual(self.out.count('('), self.out.count(')'))
        self.assertIn('(sheet_instances', self.out)
        self.assertTrue(self.out.startswith('(kicad_sch'))


class FootprintFieldTest(unittest.TestCase):
    def test_set_footprint_by_reference(self):
        out = bx.set_sch_footprint(SCH, 'D4', 'Diode_SMD:D_SMA')
        self.assertIn('(property "Footprint" "Diode_SMD:D_SMA" (at 10 10 0))', out)
        self.assertEqual(out.count('D_SMA'), 1)

    def test_unknown_reference_raises(self):
        with self.assertRaises(KeyError):
            bx.set_sch_footprint(SCH, 'D9', 'X')


if __name__ == '__main__':
    unittest.main()
