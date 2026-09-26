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

    def test_render_black_is_opaque_hex_but_fab_name_stays_black(self):
        out = pt.apply_colors(STACK, mask='Black', silk='White', finish='ENIG', render=True)
        self.assertIn('(color "%s")' % pt.RENDER_COLOR['Black'], out)
        self.assertNotIn('(color "Black")', out)

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


class WidthTest(unittest.TestCase):
    NEED = {'VBAT': 1.5, 'VIN': 1.0}
    PADS = [{'net': 'VBAT', 'pos': (0, 0), 'minor': 0.6}, {'net': 'VBAT', 'pos': (20, 0), 'minor': 3.0}]

    def seg(self, net, w, a, b):
        return {'net': net, 'width': w, 'start': a, 'end': b}

    def test_full_width_is_clean(self):
        r = pt.width_report([self.seg('VBAT', 1.5, (0, 0), (20, 0))], self.NEED, self.PADS)
        self.assertEqual(r['VBAT']['under'], [])

    def test_short_neck_into_narrow_pad_is_allowed(self):
        r = pt.width_report([self.seg('VBAT', 0.6, (0, 0), (0, 1.5)), self.seg('VBAT', 1.5, (0, 1.5), (20, 0))], self.NEED, self.PADS)
        self.assertEqual(r['VBAT']['under'], [])
        self.assertEqual(r['VBAT']['necks'], 1)

    def test_thin_segment_is_under_width(self):
        r = pt.width_report([self.seg('VIN', 0.4, (5, 5), (9, 5))], self.NEED, self.PADS)
        self.assertEqual(r['VIN']['under'], [(0.4, 4.0, (5, 5))])

    def test_long_neck_or_neck_narrower_than_pad_is_under_width(self):
        r = pt.width_report([self.seg('VBAT', 0.6, (0, 0), (0, 3)),     # too long
                             self.seg('VBAT', 0.4, (0, 0), (0, -1)),    # narrower than the 0.6 pad
                             self.seg('VBAT', 1.0, (20, 0), (20, 1))],  # the 3.0 pad is not narrow
                            self.NEED, self.PADS)
        self.assertEqual(len(r['VBAT']['under']), 3)

    def test_nets_without_a_need_are_ignored(self):
        self.assertEqual(pt.width_report([self.seg('SDA', 0.2, (0, 0), (1, 0))], self.NEED, self.PADS), {})


class CurrentTest(unittest.TestCase):
    def test_ipc2221_external_1oz_matches_layout_spec_table(self):
        # BACKUP-POWER LAYOUT-SPEC: 1 oz, dT 10 K: 0.25 mm 0.87 A, 1.0 mm 2.4 A, 1.5 mm 3.2 A
        self.assertAlmostEqual(pt.ipc_amps(0.25), 0.87, delta=0.03)
        self.assertAlmostEqual(pt.ipc_amps(1.0), 2.4, delta=0.1)
        self.assertAlmostEqual(pt.ipc_amps(1.5), 3.2, delta=0.1)

    def test_inner_layer_carries_half_of_external(self):
        self.assertAlmostEqual(pt.ipc_amps(1.0, inner=True), pt.ipc_amps(1.0) / 2, places=6)

    def test_widest_path_ignores_thin_branch_but_finds_thin_bottleneck(self):
        inf = float('inf')
        edges = [('A', 'x', 3.0, 'wide1'), ('x', 'B', 3.0, 'wide2'),   # main path 3 A
                 ('x', 'C', 0.8, 'branch'),                             # thin branch to a small pin
                 ('B', 'D', 0.8, 'thin'), ('D', 'E', inf, 'zone')]
        amps, path = pt.widest_path(edges, 'A', 'B')
        self.assertEqual((amps, path), (3.0, ['wide1', 'wide2']))
        amps, path = pt.widest_path(edges, 'A', 'E')
        self.assertEqual(amps, 0.8)
        self.assertIn('thin', path)

    def test_parallel_paths_do_not_add(self):
        # conservative: two 1 A paths are not one 2 A path
        edges = [('A', 'B', 1.0, 'p1'), ('A', 'm', 1.0, 'p2a'), ('m', 'B', 1.0, 'p2b')]
        self.assertEqual(pt.widest_path(edges, 'A', 'B')[0], 1.0)

    def test_project_point_onto_segment_is_clamped(self):
        self.assertEqual(pt.project((0, 0), (10, 0), (4, 3)), (4.0, 0.0))
        self.assertEqual(pt.project((0, 0), (10, 0), (-5, 1)), (0.0, 0.0))
        self.assertEqual(pt.project((0, 0), (0, 10), (1, 12)), (0.0, 10.0))

    def test_neck_is_short_and_as_wide_as_the_pad(self):
        self.assertTrue(pt.is_neck(length=0.8, width=0.6, pad_minor=0.6))
        self.assertFalse(pt.is_neck(length=1.55, width=0.6, pad_minor=0.6))   # too long
        self.assertFalse(pt.is_neck(length=0.5, width=0.25, pad_minor=0.6))   # narrower than the pad

    def test_spec_pairs_from_pads_or_chains(self):
        spec = {'nets': {'A': {'amps': 1.0, 'pads': ['U1.1', 'C1.1', 'J1.1']},
                         'B': {'chains': [{'amps': 2.0, 'pads': ['U2.6', 'C2.1']}, {'amps': 0.5, 'pads': ['C2.1', 'U7.1']}]}}}
        self.assertEqual(pt.spec_pairs(spec), [('A', 'U1.1', 'C1.1', 1.0), ('A', 'C1.1', 'J1.1', 1.0),
                                               ('B', 'U2.6', 'C2.1', 2.0), ('B', 'C2.1', 'U7.1', 0.5)])

    def test_no_path_is_zero_amps(self):
        self.assertEqual(pt.widest_path([('A', 'x', 3.0, 'w')], 'A', 'B'), (0.0, []))


class MaxFlowTest(unittest.TestCase):
    inf = float('inf')

    def test_two_parallel_1a_edges_give_2a(self):
        edges = [('A', 'B', 1.0, 'p1'), ('A', 'm', 1.0, 'p2a'), ('m', 'B', 1.0, 'p2b')]
        amps, cut = pt.max_flow(edges, 'A', 'B')
        self.assertAlmostEqual(amps, 2.0)
        self.assertIn('p1', cut)
        self.assertEqual(len(cut), 2)

    def test_series_chain_gives_its_minimum(self):
        edges = [('A', 'x', 3.0, 'w1'), ('x', 'y', 0.8, 'thin'), ('y', 'B', 2.0, 'w2')]
        self.assertEqual(pt.max_flow(edges, 'A', 'B'), (0.8, ['thin']))

    def test_edges_are_undirected(self):
        self.assertEqual(pt.max_flow([('B', 'A', 1.5, 'e')], 'A', 'B'), (1.5, ['e']))

    def test_zone_island_is_unlimited_and_all_zone_path_is_infinite(self):
        edges = [('A', 'z', self.inf, 'zone'), ('z', 'B', self.inf, 'zone')]
        self.assertEqual(pt.max_flow(edges, 'A', 'B')[0], self.inf)
        edges = [('A', 'z', self.inf, 'zone'), ('z', 'B', 0.5, 'v1'), ('z', 'B', 0.5, 'v2')]
        self.assertEqual(pt.max_flow(edges, 'A', 'B'), (1.0, ['v1', 'v2']))

    def test_no_path_is_zero_amps(self):
        self.assertEqual(pt.max_flow([('A', 'x', 3.0, 'w')], 'A', 'B'), (0.0, []))

    def test_spec_pairs_parallel_flag_on_net_or_chain(self):
        spec = {'nets': {'A': {'amps': 1.0, 'parallel': True, 'pads': ['U1.1', 'C1.1']},
                         'B': {'chains': [{'amps': 2.0, 'parallel': True, 'pads': ['U2.6', 'C2.1']},
                                          {'amps': 0.5, 'pads': ['C2.1', 'U7.1']}]}}}
        self.assertEqual(pt.spec_pairs(spec, parallel=True),
                         [('A', 'U1.1', 'C1.1', 1.0, True), ('B', 'U2.6', 'C2.1', 2.0, True),
                          ('B', 'C2.1', 'U7.1', 0.5, False)])

    def test_flagless_spec_gives_the_widest_path_result(self):
        edges = [('A', 'B', 1.0, 'p1'), ('A', 'm', 1.0, 'p2a'), ('m', 'B', 1.0, 'p2b')]
        spec = {'nets': {'N': {'amps': 1.5, 'pads': ['A', 'B']}}}
        (net, u, v, need, par), = pt.spec_pairs(spec, parallel=True)
        self.assertFalse(par)
        self.assertEqual(pt.pair_capacity(edges, u, v, par), pt.widest_path(edges, u, v))
        self.assertEqual(pt.pair_capacity(edges, u, v, True)[0], 2.0)


class WidenSelectTest(unittest.TestCase):
    T = [{'net': 'V5', 'layer': 'In2.Cu', 'width': 0.5, 'start': (0, 0), 'end': (10, 0)},
         {'net': 'V5', 'layer': 'F.Cu', 'width': 0.5, 'start': (0, 0), 'end': (0, 5)},
         {'net': 'V5', 'layer': 'In2.Cu', 'width': 1.0, 'start': (10, 0), 'end': (20, 0)},
         {'net': 'V5', 'layer': 'In2.Cu', 'width': 0.5, 'start': (50, 50), 'end': (60, 50)},
         {'net': 'GND', 'layer': 'In2.Cu', 'width': 0.5, 'start': (0, 1), 'end': (10, 1)}]

    def test_net_layer_and_narrower_than_the_new_width(self):
        self.assertEqual(pt.select_tracks(self.T, 'V5', 0.9, layer='In2.Cu'), [0, 3])

    def test_box_keeps_tracks_with_both_ends_inside(self):
        self.assertEqual(pt.select_tracks(self.T, 'V5', 0.9, box=(-1, -1, 30, 10)), [0, 1])


class FindPointTest(unittest.TestCase):
    def test_finds_the_one_point_within_tolerance(self):
        self.assertEqual(pt.find_point([(1, 1), (124.635, 116.912)], (124.64, 116.91)), 1)

    def test_missing_or_ambiguous_point_is_an_error(self):
        with self.assertRaises(ValueError):
            pt.find_point([(1, 1)], (2, 2))
        with self.assertRaises(ValueError):
            pt.find_point([(1, 1), (1.005, 1)], (1, 1))


class GapTest(unittest.TestCase):
    def test_copper_gap_from_a_via_to_a_track(self):
        # via r 0.3 at (0, 1); track 0.2 wide from (-5, 0) to (5, 0): 1 - 0.3 - 0.1 = 0.6
        self.assertAlmostEqual(pt.copper_gap((0, 1), 0.3, (-5, 0), (5, 0), 0.2), 0.6)

    def test_gap_past_the_track_end_uses_the_end(self):
        self.assertAlmostEqual(pt.copper_gap((8, 0), 0.3, (-5, 0), (5, 0), 0.2), 2.6)

    def test_overlap_is_negative(self):
        self.assertLess(pt.copper_gap((0, 0), 0.3, (-5, 0), (5, 0), 0.2), 0)


class NoiseTest(unittest.TestCase):
    def test_drops_known_pcbnew_noise_keeps_real_errors(self):
        text = ('./src/common/stdpbase.cpp(59): assert ""traits"" failed in Get(): create wxApp before calling this\n'
                'Fontconfig warning: "/opt/homebrew/etc/fonts/conf.d/49-sansserif.conf", line 10: invalid constant used : serif\n'
                'Traceback (most recent call last):\n'
                'ValueError: net /X not on board\n')
        self.assertEqual(pt.drop_noise(text), 'Traceback (most recent call last):\nValueError: net /X not on board\n')


class TempProjectTest(unittest.TestCase):
    def test_removes_project_files_of_the_temp_board_only(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            tmp = os.path.join(d, '.pcbtool-route.kicad_pcb')
            for f in (tmp, tmp[:-3] + 'pro', tmp[:-3] + 'prl', os.path.join(d, 'B.kicad_pro')):
                open(f, 'w').close()
            pt.remove_temp_project(tmp)
            self.assertEqual(sorted(os.listdir(d)), ['.pcbtool-route.kicad_pcb', 'B.kicad_pro'])
            pt.remove_temp_project(tmp)  # nothing left to remove is not an error


class ViaInPadTest(unittest.TestCase):
    # pad: (cx, cy, w, h, angle_deg, corner_r); via hole: (x, y, r)
    def test_hole_inside_or_touching_the_pad_is_a_hit(self):
        pad = (10, 10, 1.0, 0.6, 0, 0)
        self.assertTrue(pt.hole_in_pad((10.2, 10.1, 0.15), pad))
        self.assertTrue(pt.hole_in_pad((10.6, 10, 0.15), pad))    # edge 0.45 < 0.5 + ...
        self.assertFalse(pt.hole_in_pad((10.7, 10, 0.15), pad))   # hole edge 0.55, pad edge 0.5

    def test_rotation_and_round_corners(self):
        pad = (0, 0, 2.0, 0.4, 90, 0)                              # long side on y after rotation
        self.assertTrue(pt.hole_in_pad((0, 0.9, 0.1), pad))
        self.assertFalse(pt.hole_in_pad((0.9, 0, 0.1), pad))
        corner = (0, 0, 1.0, 1.0, 0, 0.5)                          # a circle of r 0.5
        self.assertFalse(pt.hole_in_pad((0.45, 0.45, 0.1), corner))
        self.assertTrue(pt.hole_in_pad((0.45, 0.45, 0.1), (0, 0, 1.0, 1.0, 0, 0)))


class ViaPadAllowTest(unittest.TestCase):
    def test_allowed_pads_are_removed_and_unknown_allow_is_an_error(self):
        hits = ['U1.9 GND via at (1.000, 2.000)', 'R9.1 VBUS via at (3.000, 4.000)']
        self.assertEqual(pt.drop_allowed(hits, ['U1.9']), ['R9.1 VBUS via at (3.000, 4.000)'])
        with self.assertRaises(ValueError):
            pt.drop_allowed(hits, ['U7.5'])   # an allow entry that matches nothing is stale


def json_copy(x):
    import json
    return json.loads(json.dumps(x))


if __name__ == '__main__':
    unittest.main()
