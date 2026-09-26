#!/usr/bin/env python3
"""Unit tests for the pure core of tools/pcbtool.py (no pcbnew, no kicad-cli).

  python3 tools/test_pcbtool.py
"""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('pcbtool', os.path.join(HERE, 'pcbtool.py'))
pt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pt)


class GridTest(unittest.TestCase):
    def test_row_major_with_cols(self):
        g = {'refs': ['R1', 'R2', 'R3'], 'origin': [10, 20], 'pitch': [3.2, 2.6], 'cols': 2, 'rot': 90}
        self.assertEqual(pt.grid_positions(g), {'R1': (10, 20, 90), 'R2': (13.2, 20, 90), 'R3': (10, 22.6, 90)})

    def test_default_one_row_rot_0(self):
        g = {'refs': ['C1', 'C2'], 'origin': [0, 0], 'pitch': [2, 0]}
        self.assertEqual(pt.grid_positions(g), {'C1': (0, 0, 0), 'C2': (2, 0, 0)})

    def test_merge_rejects_duplicate_ref(self):
        with self.assertRaises(ValueError):
            pt.placements({'place': {'R1': [0, 0, 0]}, 'grids': [{'refs': ['R1'], 'origin': [1, 1], 'pitch': [1, 0]}]})


class PathTest(unittest.TestCase):
    def test_segments_and_via_switch_layer(self):
        r = {'net': 'N', 'width': 0.3, 'layer': 'F.Cu', 'path': [[0, 0], [1, 0], {'via': [1, 1]}, [2, 1]]}
        segs, vias = pt.expand_route(r)
        self.assertEqual(segs, [((0, 0), (1, 0), 'F.Cu', 0.3), ((1, 0), (1, 1), 'F.Cu', 0.3), ((1, 1), (2, 1), 'B.Cu', 0.3)])
        self.assertEqual(vias, [(1, 1)])

    def test_path_can_start_on_via(self):
        segs, vias = pt.expand_route({'net': 'N', 'width': 0.3, 'layer': 'B.Cu', 'path': [{'via': [0, 0]}, [0, 2]]})
        self.assertEqual(segs, [((0, 0), (0, 2), 'F.Cu', 0.3)])
        self.assertEqual(vias, [(0, 0)])

    def test_rejects_short_path_and_zero_length(self):
        with self.assertRaises(ValueError):
            pt.expand_route({'net': 'N', 'width': 0.3, 'layer': 'F.Cu', 'path': [[0, 0]]})
        with self.assertRaises(ValueError):
            pt.expand_route({'net': 'N', 'width': 0.3, 'layer': 'F.Cu', 'path': [[0, 0], [0, 0]]})

    def test_rejects_non_45_degree_segment(self):
        with self.assertRaises(ValueError):
            pt.expand_route({'net': 'N', 'width': 0.3, 'layer': 'F.Cu', 'path': [[0, 0], [2, 1]]})

    def test_any_angle_allowed_when_asked(self):
        segs, _ = pt.expand_route({'net': 'N', 'width': 0.3, 'layer': 'F.Cu', 'path': [[0, 0], [2, 1]], 'any_angle': True})
        self.assertEqual(len(segs), 1)


class DrcSummaryTest(unittest.TestCase):
    def test_counts_and_errors_first(self):
        d = {'violations': [
            {'type': 'clearance', 'severity': 'error', 'items': [{'description': 'Pad 1 [A] of U1'}, {'description': 'Track [B]'}]},
            {'type': 'silk_overlap', 'severity': 'warning', 'items': [{'description': 'x'}]}],
             'unconnected_items': [{'items': [{'description': 'Pad 1 [VBAT] of Q1', 'pos': {'x': 1, 'y': 2}},
                                              {'description': 'Pad 8 [VBAT] of U1', 'pos': {'x': 3, 'y': 4}}]}],
             'schematic_parity': []}
        s = pt.summarize_drc(d)
        self.assertEqual(s['errors'], 1)
        self.assertEqual(s['warnings'], 1)
        self.assertEqual(s['unconnected'], 1)
        self.assertEqual(s['parity'], 0)
        self.assertEqual(s['error_lines'], ['clearance: Pad 1 [A] of U1 | Track [B]'])
        self.assertEqual(s['unrouted'], {'VBAT': 1})


STACK = """		(stackup
			(layer "F.SilkS"
				(type "Top Silk Screen")
			)
			(layer "F.Mask"
				(type "Top Solder Mask")
				(thickness 0.01)
			)
			(layer "B.Mask"
				(type "Bottom Solder Mask")
				(color "Green")
				(thickness 0.01)
			)
			(layer "B.SilkS"
				(type "Bottom Silk Screen")
			)
			(copper_finish "HAL lead-free")
"""


class ColorTest(unittest.TestCase):
    def test_sets_mask_silk_and_finish(self):
        out = pt.apply_colors(STACK, mask='Black', silk='White', finish='ENIG')
        self.assertEqual(out.count('(color "Black")'), 2)
        self.assertEqual(out.count('(color "White")'), 2)
        self.assertNotIn('Green', out)
        self.assertIn('(copper_finish "ENIG")', out)

    def test_twice_is_same_as_once(self):
        once = pt.apply_colors(STACK, mask='Blue', silk='White', finish='ENIG')
        self.assertEqual(pt.apply_colors(once, mask='Blue', silk='White', finish='ENIG'), once)

    def test_changes_only_the_stackup(self):
        tail = '\t(gr_line\n\t\t(layer "F.SilkS")\n\t)\n\t(gr_line\n\t\t(stroke\n\t\t\t(width 0.1)\n\t\t\t(type solid)\n\t\t)\n\t)\n'
        out = pt.apply_colors(STACK + '\t\t)\n' + tail, mask='Black', silk='White', finish='ENIG')
        self.assertTrue(out.endswith(tail))

    def test_rejects_colour_jlc_does_not_make(self):
        with self.assertRaises(ValueError):
            pt.apply_colors(STACK, mask='Pink', silk='White', finish='ENIG')


class CompareTest(unittest.TestCase):
    A = {'drc': {'errors': 0, 'unconnected': 81, 'parity': 0}, 'checker': [47, 52],
         'parts': {'R1': [1, 1, 0, 'F'], 'R2': [2, 2, 0, 'F']}, 'tracks': 10, 'vias': 2}

    def test_no_change_is_clean(self):
        r = pt.compare(self.A, self.A)
        self.assertEqual(r['regressions'], [])
        self.assertEqual(r['moved'], [])

    def test_more_errors_or_fewer_checks_is_a_regression(self):
        b = json_copy(self.A)
        b['drc']['errors'] = 2
        b['checker'] = [45, 52]
        r = pt.compare(self.A, b)
        self.assertEqual(r['regressions'], ['DRC errors 0 -> 2', 'checker 47/52 -> 45/52'])

    def test_fewer_unconnected_is_progress_and_moves_are_listed(self):
        b = json_copy(self.A)
        b['drc']['unconnected'] = 70
        b['parts']['R1'] = [1.5, 1, 0, 'F']
        del b['parts']['R2']
        b['parts']['R3'] = [3, 3, 0, 'F']
        r = pt.compare(self.A, b)
        self.assertEqual(r['regressions'], [])
        self.assertEqual(r['progress'], ['unconnected 81 -> 70'])
        self.assertEqual(r['moved'], ['R1 (1, 1, 0, F) -> (1.5, 1, 0, F)'])
        self.assertEqual(r['added'], ['R3'])
        self.assertEqual(r['removed'], ['R2'])


class WaveTest(unittest.TestCase):
    def test_seigaiha_arcs_stay_inside_the_box(self):
        arcs = pt.seigaiha((0, 0, 20, 10), r=2.0, rings=3)
        self.assertTrue(arcs)
        for (cx, cy), rad, a0, a1 in arcs:
            self.assertTrue(0 <= cx - rad and cx + rad <= 20 and 0 <= cy - rad and cy <= 10)
            self.assertTrue(0 < rad <= 2.0)


def json_copy(x):
    import json
    return json.loads(json.dumps(x))


if __name__ == '__main__':
    unittest.main()
