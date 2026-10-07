#!/usr/bin/env python3
"""Tests for tools/port_labels.py.  python3 tools/test_port_labels.py"""
import importlib.util, json, os, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('pl', os.path.join(HERE, 'port_labels.py'))
pl = importlib.util.module_from_spec(spec); spec.loader.exec_module(pl)


def fp(ref, x, y, rot, pads, texts=(), layer='F.Cu'):
    p = ''.join('\t\t(pad "%s" %s circle\n\t\t\t(at %s %s)\n\t\t\t(size 1 1)%s\n\t\t)\n'
                % (n, kind, px, py, '\n\t\t\t(net 1 "%s")' % net if net else '')
                for n, kind, px, py, net in pads)
    t = ''.join('\t\t(fp_text user "%s"\n\t\t\t(at %s %s)\n\t\t\t(layer "%s")\n\t\t)\n' % tx for tx in texts)
    return ('\t(footprint "iot-lab:C1"\n\t\t(layer "%s")\n\t\t(at %s %s %s)\n'
            '\t\t(property "Reference" "%s"\n\t\t\t(at 0 -3 0)\n\t\t\t(layer "F.SilkS")\n\t\t)\n%s%s\t)\n'
            % (layer, x, y, rot, ref, p, t))


def gr(text, x, y, layer='F.SilkS'):
    return '\t(gr_text "%s"\n\t\t(at %s %s 0)\n\t\t(layer "%s")\n\t)\n' % (text, x, y, layer)


J1_PADS = [('1', 'thru_hole', 0, 0, 'A'), ('2', 'thru_hole', 2.5, 0, 'B'),
           ('3', 'thru_hole', 5, 0, 'unconnected-(J1-Pad3)'), ('', 'np_thru_hole', 7, 2, None),
           ('MP', 'smd', -3, 2, 'GND'), ('4', 'thru_hole', 5, 2, None)]


def board(*items):
    return '(kicad_pcb\n' + ''.join(items) + ')\n'


GOOD = board(fp('J1', 10, 10, 0, J1_PADS), gr('A', 10, 8), gr('B', 12.5, 8), gr('24V IN', 12.5, 5.5),
             fp('U1', 40, 40, 0, [('1', 'smd', 0, 0, 'A')]))


def fails(text, **kw):
    return [f for f in pl.check(text, **kw)['failures']]


class PortLabelsTest(unittest.TestCase):
    def test_labelled_connector_passes(self):
        r = pl.check(GOOD)
        self.assertEqual(r['failures'], [])
        self.assertEqual((r['connectors'], r['pads']), (1, 2))  # U1 is no connector; NC/NPTH/MP/no-net pads skipped

    def test_shield_net_pads_are_skipped(self):
        pads = J1_PADS + [('15', 'thru_hole', 7, 0, 'CHASSIS'), ('16', 'thru_hole', 7, 1, '/SHIELD')]
        self.assertEqual(pl.check(GOOD.replace(fp('J1', 10, 10, 0, J1_PADS), fp('J1', 10, 10, 0, pads)))['pads'], 2)

    def test_footprint_without_checked_pads_needs_no_title(self):
        # a mounting hole with a P reference, and SH1/SH2 shield pads
        b = GOOD[:-2] + fp('P7', 60, 60, 0, [('', 'np_thru_hole', 0, 0, None)]) \
            + fp('J9', 80, 80, 0, [('SH1', 'thru_hole', 0, 0, 'GND'), ('SH2', 'thru_hole', 5, 0, 'GND')]) + ')\n'
        r = pl.check(b)
        self.assertEqual((r['connectors'], r['failures']), (1, []))

    def test_missing_pin_label_fails(self):
        b = GOOD.replace(gr('B', 12.5, 8), '')
        self.assertEqual(fails(b), ['FAIL J1 pad 2 (B): no F.SilkS label within 4.0 mm'])

    def test_label_goes_to_its_nearest_pad_only(self):
        # one text between two pads names one pad, not both
        b = GOOD.replace(gr('A', 10, 8), '').replace(gr('B', 12.5, 8), gr('AB', 11.0, 8))
        self.assertEqual(fails(b), ['FAIL J1 pad 2 (B): no F.SilkS label within 4.0 mm'])

    def test_distance_is_configurable(self):
        b = GOOD.replace(gr('B', 12.5, 8), gr('B', 12.5, 5.0)).replace(gr('24V IN', 12.5, 5.5), gr('24V IN', 12.5, 3))
        self.assertEqual(len(fails(b)), 1)
        self.assertEqual(fails(b, dist=6.0), [])

    def test_title_required_and_pin_label_is_not_a_title(self):
        b = GOOD.replace(gr('24V IN', 12.5, 5.5), '')
        self.assertEqual(fails(b), ['FAIL J1: no title text within 8.0 mm'])

    def test_reference_and_back_silk_do_not_count(self):
        b = GOOD.replace(gr('B', 12.5, 8), gr('J1', 12.5, 8) + gr('B', 12.5, 8.1, 'B.SilkS'))
        self.assertEqual(len(fails(b)), 1)

    def test_reference_text_far_from_its_part_is_a_label(self):
        # "C1" (RTD lead C) at the connector, with a capacitor C1 30 mm away, is a pin label; "RTD1 C" is a label
        cap = fp('C1', 40, 40, 0, [('1', 'smd', 0, 0, 'X'), ('2', 'smd', 1, 0, 'Y')])
        b = GOOD[:-2] + cap + ')\n'
        self.assertEqual(fails(b.replace(gr('B', 12.5, 8), gr('C1', 12.5, 8))), [])
        self.assertEqual(fails(b.replace(gr('B', 12.5, 8), gr('RTD1 C', 12.5, 8))), [])
        # the same text next to its own part is that part's reference: it does not count
        near = fp('C1', 12.5, 10, 0, [('1', 'smd', 3, 3, 'X')])
        b2 = GOOD[:-2] + near + ')\n'
        self.assertEqual(len(fails(b2.replace(gr('B', 12.5, 8), gr('C1', 12.5, 8)))), 1)

    def test_fp_text_user_in_rotated_footprint_counts(self):
        # rot 90: local (0, 2.5) is board (12.5, 10); local (-2, 2.5) is board (12.5, 12)
        pads = [('1', 'smd', 0, 0, 'A'), ('2', 'smd', 0, 2.5, 'B')]
        b = board(fp('J2', 10, 10, 90, pads, [('A', -2, 0, 'F.SilkS'), ('B', -2, 2.5, 'F.SilkS'),
                                               ('OUT', -5, 1.25, 'F.SilkS')]))
        self.assertEqual(pl.pad_xy((10, 10, 90), (0, 2.5)), (12.5, 10.0))
        self.assertEqual(fails(b), [])

    def test_exemption_with_reason_passes_and_stale_fails(self):
        b = GOOD.replace(gr('B', 12.5, 8), '')
        ex = [{'ref': 'J1', 'pads': ['2'], 'reason': 'only "1" fits'}]
        self.assertEqual(fails(b, exempt=ex), [])
        self.assertEqual(fails(GOOD, exempt=ex), ['STALE exempt J1 pad 2: the pad has a label'])
        with self.assertRaises(ValueError):
            pl.check(b, exempt=[{'ref': 'J1', 'pads': ['2']}])

    def test_skip_removes_a_mounting_pad_before_labels_are_assigned(self):
        # "24V IN" is nearest to pad 5 (MNT); with pad 5 skipped it is the title again
        pads = J1_PADS + [('5', 'smd', 2.5, -6, 'GND')]
        b = GOOD.replace(fp('J1', 10, 10, 0, J1_PADS), fp('J1', 10, 10, 0, pads))
        self.assertEqual(fails(b), ['FAIL J1: no title text within 8.0 mm'])
        ex = [{'ref': 'J1', 'skip': ['5'], 'reason': 'mounting pad'}]
        self.assertEqual(fails(b, exempt=ex), [])
        self.assertEqual(fails(GOOD, exempt=ex), ['STALE exempt J1 skip 5: no such pad with a net'])

    def test_exempt_all_pads_and_title(self):
        b = board(fp('J1', 10, 10, 0, J1_PADS))
        ex = [{'ref': 'J1', 'pads': 'all', 'reason': 'RJ45'}, {'ref': 'J1', 'title': True, 'reason': 'x'}]
        self.assertEqual(fails(b, exempt=ex), [])

    def test_main_exit_code_json_and_default_exempt_file(self):
        with tempfile.TemporaryDirectory() as d:
            cad = os.path.join(d, 'boards', 'X', 'cad', 'X')
            os.makedirs(cad)
            p = os.path.join(cad, 'X.kicad_pcb')
            open(p, 'w').write(GOOD.replace(gr('B', 12.5, 8), ''))
            self.assertEqual(pl.main([p]), 1)
            json.dump({'exempt': [{'ref': 'J1', 'pads': ['2'], 'reason': 'r'}]},
                      open(os.path.join(d, 'boards', 'X', 'port-labels.json'), 'w'))
            self.assertEqual(pl.main([p, '--json']), 0)


if __name__ == '__main__':
    unittest.main()
