#!/usr/bin/env python3
"""Tests for tools/model_sync.py.  python3 tools/test_model_sync.py"""
import importlib.util, os, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('ms', os.path.join(HERE, 'model_sync.py'))
ms = importlib.util.module_from_spec(spec); spec.loader.exec_module(ms)

LIB = {
    'C1': '''(footprint "C1"
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))
  (model "${IOT_LAB}/new/C1.step"
		(offset (xyz 0.000 -2.980 0.450))
		(scale (xyz 1 1 1))
		(rotate (xyz 0 0 90))
	)
)
''',
    'C2': '''(footprint "C2"
  (model "${IOT_LAB}/C2.step"
		(offset (xyz 0.000 -3.400 0.000))
		(scale (xyz 1 1 1))
		(rotate (xyz 0 0 0))
	)
)
''',
}

BOARD = '''(kicad_pcb
	(footprint "iot-lab:C1"
		(layer "F.Cu")
		(at 10 20 90)
		(property "Reference" "J2"
			(at 0 -1 0)
			(layer "F.SilkS")
		)
		(pad "1" smd rect
			(at 0 0 90)
			(size 1 1)
		)
		(model "${IOT_LAB}/old/C1.step"
			(offset
				(xyz 0 -3.425 0)
			)
			(scale
				(xyz 1 1 1)
			)
			(rotate
				(xyz 0 0 0)
			)
		)
	)
	(footprint "iot-lab:C2"
		(layer "F.Cu")
		(model "${IOT_LAB}/C2.step"
			(offset
				(xyz 0 -3.4 -0)
			)
			(scale
				(xyz 1 1 1)
			)
			(rotate
				(xyz 0 0 0)
			)
		)
	)
	(footprint "iot-lab:C9"
		(layer "F.Cu")
		(model "${IOT_LAB}/C9.step"
			(offset
				(xyz 0 0 0)
			)
		)
	)
	(footprint "Other:X"
		(model "x.step"
			(offset
				(xyz 1 2 3)
			)
		)
	)
)
'''


def lib(c):
    return LIB.get(c)


class ModelSyncTest(unittest.TestCase):
    def test_model_path_offset_rotate_follow_the_library(self):
        out, changed, _ = ms.sync(BOARD, lib)
        self.assertIn('(model "${IOT_LAB}/new/C1.step"\n\t\t\t(offset\n\t\t\t\t(xyz 0.000 -2.980 0.450)\n', out)
        self.assertIn('(rotate\n\t\t\t\t(xyz 0 0 90)\n', out)
        self.assertEqual(changed, ['C1'])

    def test_only_model_lines_change(self):
        out, _, _ = ms.sync(BOARD, lib)
        a, b = BOARD.split('\n'), out.split('\n')
        self.assertEqual(len(a), len(b))
        diff = [i for i, (x, y) in enumerate(zip(a, b)) if x != y]
        self.assertEqual([a[i].strip().split()[0] for i in diff], ['(model', '(xyz', '(xyz'])

    def test_numerically_equal_values_keep_the_board_text(self):
        out, changed, _ = ms.sync(BOARD, lib)
        self.assertIn('(xyz 0 -3.4 -0)', out)
        self.assertNotIn('C2', changed)

    def test_missing_library_and_foreign_footprints_are_untouched(self):
        out, _, missing = ms.sync(BOARD, lib)
        self.assertEqual(missing, ['C9'])
        self.assertIn('(model "x.step"\n\t\t\t(offset\n\t\t\t\t(xyz 1 2 3)', out)

    def test_idempotent(self):
        out, _, _ = ms.sync(BOARD, lib)
        self.assertEqual(ms.sync(out, lib)[:2], (out, []))

    def test_model_count_mismatch_fails(self):
        two = BOARD.replace('\t(footprint "iot-lab:C2"\n\t\t(layer "F.Cu")\n',
                            '\t(footprint "iot-lab:C2"\n\t\t(layer "F.Cu")\n\t\t(model "extra.step")\n')
        with self.assertRaises(ValueError):
            ms.sync(two, lib)

    def test_main_dry_run_writes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'b.kicad_pcb')
            open(p, 'w').write(BOARD)
            for c, t in LIB.items():
                open(os.path.join(d, c + '.kicad_mod'), 'w').write(t)
            ms.main([p, '--lib', d, '--dry-run'])
            self.assertEqual(open(p).read(), BOARD)
            ms.main([p, '--lib', d])
            self.assertIn('new/C1.step', open(p).read())


if __name__ == '__main__':
    unittest.main()
