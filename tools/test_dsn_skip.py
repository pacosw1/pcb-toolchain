import unittest
import tempfile
from pathlib import Path
import dsn_skip
import route_features


FIXTURE = '''(pcb test
 (parser (string_quote "))
 (network
  (net A (pins U1-1 U2-1))
  (net B (pins U1-2 U2-2))
  (net C (pins U1-3 U2-3))
  (class Mixed A B (circuit (use_via VIA)) (rule (width 220) (clearance 200)))
  (class Other C (rule (width 180) (clearance 300)))
  (class_class (classes Mixed Other) (rule (clearance 500)))
 )
 (wiring (wire (path F.Cu 220 0 0 1000 0) (net B) (type fix)))
)'''


class SkipTests(unittest.TestCase):
    def network(self, text):
        # Strip parser section with its deliberately bare quote.
        start = text.index('(network')
        return route_features.sexpr(text[start:text.index('(wiring')])[0]

    def test_membership_and_selectivity(self):
        result, ignored = dsn_skip.exclude(FIXTURE, {'A', 'C'})
        old, new = self.network(FIXTURE), self.network(result)
        self.assertEqual([x for x in old if isinstance(x, list) and x[0] == 'net'],
                         [x for x in new if isinstance(x, list) and x[0] == 'net'])
        self.assertEqual(result[result.index('(wiring'):], FIXTURE[FIXTURE.index('(wiring'):])
        classes = {x[1]: x for x in new if isinstance(x, list) and x[0] == 'class'}
        self.assertEqual(ignored, ['IOT_SKIP_0'])
        self.assertEqual(classes['Mixed'][2], 'A')
        self.assertEqual(classes['IOT_SKIP_0'][2], 'B')
        self.assertEqual(classes['Mixed'][3:], classes['IOT_SKIP_0'][3:])
        self.assertEqual(classes['Other'], [x for x in old if isinstance(x, list) and x[0] == 'class'][1])
        pairs = [x for x in new if isinstance(x, list) and x[0] == 'class_class']
        self.assertIn(['class_class', ['classes', 'IOT_SKIP_0', 'Other'], ['rule', ['clearance', '500']]], pairs)

    def test_no_selection_excludes_every_net(self):
        result, ignored = dsn_skip.exclude(FIXTURE, set())
        self.assertEqual(len(ignored), 2)
        net_nodes = [x for x in self.network(result) if isinstance(x, list) and x[0] == 'net']
        self.assertTrue(all(len(x[2]) == 3 for x in net_nodes))

    def test_all_selected_no_change(self):
        result, ignored = dsn_skip.exclude(FIXTURE, {'A', 'B', 'C'})
        self.assertEqual(ignored, [])
        self.assertEqual(self.network(result), self.network(FIXTURE))

    def test_unknown_and_unclassified_fail_closed(self):
        with self.assertRaises(ValueError):
            dsn_skip.exclude(FIXTURE, {'missing'})
        with self.assertRaises(ValueError):
            dsn_skip.exclude(FIXTURE.replace('Mixed A B', 'Mixed A'), {'A', 'C'})

    def test_class_collision(self):
        with self.assertRaises(ValueError):
            dsn_skip.exclude(FIXTURE.replace('Other C', 'IOT_SKIP_0 C'), {'A', 'C'})

    def test_report_accounting(self):
        self.assertEqual(dsn_skip.routable_open({'stats': {'unrouted': 3, 'unrouted_ignored_classes': 3}}), 0)
        self.assertEqual(dsn_skip.routable_open({'stats': {'unrouted': 4, 'unrouted_ignored_classes': 3}}), 1)
        for bad in ({}, {'unrouted': 1, 'unrouted_ignored_classes': 2}, {'unrouted': True}):
            with self.assertRaises(ValueError):
                dsn_skip.routable_open({'stats': bad})

class NativeSkipTests(unittest.TestCase):
    def test_native_export_membership_and_copper(self):
        try:
            import pcbnew
        except ImportError:
            self.skipTest('native KiCad Python required')
        source = Path(__file__).resolve().parents[1] / 'hardware-design/boards/BASE-PWR/cad/BASE-PWR-B/BASE-PWR-B.kicad_pcb'
        board = pcbnew.LoadBoard(str(source))
        for t in board.GetTracks():
            t.SetLocked(True)
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)/'native.dsn'
            self.assertTrue(pcbnew.ExportSpecctraDSN(board, str(output)))
            original = output.read_text()
        names = {str(n) for n in board.GetNetsByName().keys() if str(n)}
        skipped = {n for n in names if 'GND' in n or n.startswith('/USB_')}
        converted, ignored = dsn_skip.exclude(original, names-skipped)
        self.assertTrue(ignored)
        # Native network contains no string_quote parser directive.
        def parsed(text):
            return route_features.sexpr(text[text.index('(network'):text.index('(wiring')])[0]
        before, after = parsed(original), parsed(converted)
        self.assertEqual([x for x in before if isinstance(x, list) and x[0] == 'net'],
                         [x for x in after if isinstance(x, list) and x[0] == 'net'])
        self.assertEqual(original[original.index('(wiring'):], converted[converted.index('(wiring'):])


if __name__ == '__main__':
    unittest.main()
