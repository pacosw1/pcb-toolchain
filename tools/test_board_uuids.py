"""Tests for tools/board_uuids.py: duplicate item UUIDs in a native board, deterministic repair."""
import os
import tempfile
import unittest

import board_uuids as bu

BOARD = '''(kicad_pcb
\t(version 20260206)
\t(footprint "R_0402"
\t\t(uuid "aaaaaaaa-0000-0000-0000-000000000001")
\t\t(property "Reference" "R1 (c)" (uuid "aaaaaaaa-0000-0000-0000-000000000002"))
\t\t(pad "1" smd rect (uuid "aaaaaaaa-0000-0000-0000-000000000003"))
\t)
\t(zone
\t\t(net 1)
\t\t(uuid "bbbbbbbb-0000-0000-0000-000000000001")
\t\t(polygon (pts (xy 0 0) (xy 1 0) (xy 1 1)))
\t)
\t(zone
\t\t(net 1)
\t\t(uuid "bbbbbbbb-0000-0000-0000-000000000001")
\t\t(polygon (pts (xy 0 0) (xy 2 0) (xy 2 2)))
\t)
\t(zone
\t\t(net 2)
\t\t(uuid "bbbbbbbb-0000-0000-0000-000000000001")
\t)
\t(gr_text "a \\"(\\" quote" (uuid "cccccccc-0000-0000-0000-000000000001"))
\t(segment (start 0 0) (end 1 1) (uuid "dddddddd-0000-0000-0000-000000000001"))
)
'''


class Duplicates(unittest.TestCase):
    def test_finds_every_repeat_with_its_item_kind(self):
        d = bu.duplicates(BOARD)
        self.assertEqual([(r['kind'], r['uuid'], r['ordinal']) for r in d],
                         [('zone', 'bbbbbbbb-0000-0000-0000-000000000001', 1),
                          ('zone', 'bbbbbbbb-0000-0000-0000-000000000001', 2)])

    def test_clean_board_has_none_and_is_unchanged(self):
        text = BOARD.replace('bbbbbbbb-0000-0000-0000-000000000001', 'x', 1)
        text = text.replace('bbbbbbbb-0000-0000-0000-000000000001', 'y', 1)
        self.assertEqual(bu.duplicates(text), [])
        self.assertEqual(bu.repair(text), (text, []))

    def test_repair_is_deterministic_and_keeps_everything_else(self):
        new, rows = bu.repair(BOARD)
        new2, rows2 = bu.repair(BOARD)
        self.assertEqual((new, rows), (new2, rows2))
        self.assertEqual(len(rows), 2)
        self.assertEqual(len({r['new'] for r in rows} | {rows[0]['uuid']}), 3)
        self.assertEqual(bu.duplicates(new), [])
        # the first occurrence keeps its UUID; only the uuid tokens of the repeats change
        self.assertEqual(new.count('bbbbbbbb-0000-0000-0000-000000000001'), 1)
        strip = lambda s: s.replace(rows[0]['new'], 'Z').replace(rows[1]['new'], 'Z').replace(rows[0]['uuid'], 'Z')
        self.assertEqual(strip(new), strip(BOARD))
        self.assertEqual(rows[0]['new'], bu.replacement(rows[0]['uuid'], 1))
        self.assertNotEqual(rows[0]['new'], rows[1]['new'])

    def test_repair_file_writes_only_when_needed(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'b.kicad_pcb')
            open(p, 'w').write(BOARD)
            rep = bu.repair_file(p)
            self.assertEqual(rep['replaced'], 2)
            self.assertEqual(bu.duplicates(open(p).read()), [])
            self.assertEqual(bu.repair_file(p)['replaced'], 0)
            rep = bu.repair_file(p, write=False)
            self.assertEqual(rep['replaced'], 0)


if __name__ == '__main__':
    unittest.main()
