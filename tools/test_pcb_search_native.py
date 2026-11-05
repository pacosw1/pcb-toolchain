"""Guard the protected-geometry hash."""
from pathlib import Path
import tempfile
import unittest

from pcb_search.native_srj import geometry_digest


class NativeContracts(unittest.TestCase):
    def test_geometry_hash_detects_changes_to_placement_rules_and_retained_copper(self):
        root = '(kicad_pcb (version 1) (footprint "R" (at 1 2) (uuid "f")) (segment (width .25) (uuid "t")))'
        with tempfile.TemporaryDirectory() as d:
            a, b = Path(d)/'a', Path(d)/'b'; a.write_text(root)
            b.write_text(root[:-1] + '(segment (width .15) (uuid "new")))')
            self.assertEqual(geometry_digest(a), geometry_digest(b, ['new']))
            for change in (root.replace('(at 1 2)', '(at 2 2)'), root.replace('.25', '.15'),
                           root[:-1] + '(setup (clearance .1)))'):
                b.write_text(change)
                self.assertNotEqual(geometry_digest(a), geometry_digest(b))
            with self.assertRaises(ValueError):
                geometry_digest(a, ['f'])


if __name__ == '__main__':
    unittest.main()
