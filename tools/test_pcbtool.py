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


class CorridorGridTest(unittest.TestCase):
    def test_keeps_the_cell_when_the_box_fits(self):
        self.assertEqual(pt.fit_grid((10, 20, 15, 22), 0.25), (10, 20, 0.25, 20, 8))

    def test_grows_the_cell_to_stay_inside_the_cap(self):
        x0, y0, cell, cols, rows = pt.fit_grid((0, 0, 100, 10), 0.25, max_cols=80, max_rows=40)
        self.assertLessEqual(cols, 80)
        self.assertLessEqual(rows, 40)
        self.assertGreaterEqual(cell * cols, 100)


class ShapeDistTest(unittest.TestCase):
    def test_capsule(self):
        seg = ('seg', (0, 0), (10, 0), 0.5)
        self.assertAlmostEqual(pt.shape_dist(seg, (5, 2)), 1.5)
        self.assertAlmostEqual(pt.shape_dist(seg, (13, 0)), 2.5)
        self.assertLessEqual(pt.shape_dist(seg, (5, 0.2)), 0)

    def test_polygon_inside_is_zero_or_less_outside_is_edge_distance(self):
        sq = ('poly', [(0, 0), (4, 0), (4, 4), (0, 4)])
        self.assertLessEqual(pt.shape_dist(sq, (2, 2)), 0)
        self.assertAlmostEqual(pt.shape_dist(sq, (7, 2)), 3)


class CorridorMapTest(unittest.TestCase):
    # grid 0..4 x 0..1 mm, cell 0.5: 8 cols x 2 rows, centres x = 0.25, 0.75, ...
    GRID = (0, 0, 0.5, 8, 2)

    def test_marks_own_other_and_free(self):
        own = [('seg', (0, 0), (0, 1), 0.3)]                      # covers column 0
        other = [(('seg', (2, 0), (2, 1), 0.1), 0.3)]             # blocks x in (1.6, 2.4): cols 3, 4
        rows = pt.corridor_map(self.GRID, None, 0, own, other, [('A', (3.8, 0.2))])
        self.assertEqual(rows, ['+..##..A', '+..##...'])

    def test_outside_the_board_outline_is_blocked(self):
        outline = [[(-1, -1), (3, -1), (3, 2), (-1, 2)]]
        rows = pt.corridor_map(self.GRID, outline, 0.3, [], [], [])
        self.assertEqual(rows, ['.....###', '.....###'])   # col 5 centre 2.75 is 0.25 from the edge


class RatsnestPairsTest(unittest.TestCase):
    def test_nearest_pads_join_the_islands(self):
        islands = [[('U1.1', (0, 0))], [('R1.1', (10, 0)), ('R1.2', (5, 0))], [('C1.1', (5, 4))]]
        self.assertEqual(pt.mst_pairs(islands), [('U1.1', 'R1.2'), ('R1.2', 'C1.1')])

    def test_one_island_needs_nothing(self):
        self.assertEqual(pt.mst_pairs([[('U1.1', (0, 0)), ('U1.2', (1, 0))]]), [])


class NetRulesTest(unittest.TestCase):
    PRO = {'net_settings': {'classes': [{'name': 'Default', 'track_width': 0.2, 'clearance': 0.2},
                                        {'name': 'CELL', 'track_width': 1.5, 'clearance': 0.3}],
                            'netclass_patterns': [{'netclass': 'CELL', 'pattern': 'VBAT*'}]}}

    def test_pattern_class_and_default(self):
        self.assertEqual(pt.net_rules(self.PRO, 'VBAT_F'), ('CELL', 1.5, 0.3))
        self.assertEqual(pt.net_rules(self.PRO, '/SDA'), ('Default', 0.2, 0.2))

    def test_dru_rules_that_name_the_net_or_class(self):
        dru = ('(version 1)\n(rule "Cell gap"\n (condition "A.NetClass == \'CELL\'")\n (constraint clearance (min 1mm)))\n'
               '(rule "Other"\n (condition "A.NetName == \'/SDA\'")\n (constraint clearance (min 0.3mm)))\n')
        self.assertEqual(pt.dru_mentions(dru, ['VBAT_F', 'CELL']), ['Cell gap'])


class NetCheckTest(unittest.TestCase):
    D = {'violations': [
        {'type': 'clearance', 'severity': 'error', 'items': [{'description': 'Track [VBAT] on F.Cu'}, {'description': 'Pad 1 [GND] of U1'}]},
        {'type': 'clearance', 'severity': 'error', 'items': [{'description': 'Track [/SDA] on F.Cu'}, {'description': 'Pad 2 [GND] of U1'}]},
        {'type': 'silk_overlap', 'severity': 'warning', 'items': [{'description': 'x'}]}],
        'unconnected_items': [{'items': [{'description': 'Pad 1 [VBAT] of Q1'}, {'description': 'Pad 8 [VBAT] of U1'}]},
                              {'items': [{'description': 'Pad 1 [/SDA] of U2'}, {'description': 'Pad 3 [/SDA] of U1'}]}],
        'schematic_parity': [{'type': 'x'}]}

    def test_one_summary_line_then_the_net_items(self):
        text, ok = pt.net_check(self.D, 'VBAT')
        lines = text.splitlines()
        self.assertEqual(lines[0], 'DRC total: 2 errors, 2 unconnected, 1 parity | VBAT: 1 violations, 1 unconnected')
        self.assertEqual(len(lines), 3)
        self.assertIn('clearance', lines[1])
        self.assertFalse(ok)

    def test_clean_net_is_ok(self):
        text, ok = pt.net_check(self.D, '/SCL')
        self.assertTrue(ok)
        self.assertEqual(len(text.splitlines()), 1)

    def test_net_match_is_exact(self):
        self.assertTrue(pt.net_check(self.D, 'BAT')[1])


class IntentParseTest(unittest.TestCase):
    def test_full_line(self):
        it = pt.parse_intent('/SDA U1.3 -> R5.1 layer=B.Cu width=0.3 via=0.6/0.3 through 10,5 via 12,5 through 14,7')
        self.assertEqual(it, {'net': '/SDA', 'a': ('U1', '3'), 'b': ('R5', '1'), 'layer': 'B.Cu', 'width': 0.3,
                              'via': (0.6, 0.3), 'points': [('through', (10.0, 5.0)), ('via', (12.0, 5.0)), ('through', (14.0, 7.0))]})

    def test_defaults_are_auto(self):
        it = pt.parse_intent('GND C1.2 -> U1.EP')
        self.assertEqual((it['layer'], it['width'], it['via'], it['points'], it['b']), (None, None, None, [], ('U1', 'EP')))

    def test_bad_lines_raise(self):
        for bad in ('GND C1.2 R1.1', 'GND C1.2 -> R1.1 through 1', 'GND C1.2 -> R1.1 color=red', 'GND C1 -> R1.1'):
            with self.assertRaises(ValueError, msg=bad):
                pt.parse_intent(bad)


class IntentLegTest(unittest.TestCase):
    def test_straight_and_pure_diagonal_are_one_segment(self):
        self.assertEqual(pt.leg((0, 0), (5, 0)), [(5, 0)])
        self.assertEqual(pt.leg((0, 0), (3, -3)), [(3, -3)])

    def test_diagonal_in_the_middle_of_the_straight_part(self):
        self.assertEqual(pt.leg((0, 0), (10, 2)), [(4.0, 0), (6.0, 2), (10, 2)])
        self.assertEqual(pt.leg((0, 0), (-1, -5)), [(0, -2.0), (-1, -3.0), (-1, -5)])

    def test_route_through_points_and_via(self):
        it = pt.parse_intent('N A.1 -> B.1 via 4,0 through 4,4')
        r = pt.intent_route(it, (0, 0), (8, 4), 'F.Cu', 0.25, (0.6, 0.3))
        self.assertEqual(r, {'net': 'N', 'width': 0.25, 'layer': 'F.Cu', 'via_size': 0.6, 'via_drill': 0.3,
                             'path': [(0, 0), {'via': (4.0, 0.0)}, (4.0, 4.0), (8, 4)]})
        segs, vias = pt.expand_route(r)                     # the route writer accepts it: 0/45/90 only
        self.assertEqual([s[2] for s in segs], ['F.Cu', 'B.Cu', 'B.Cu'])


class SegClearTest(unittest.TestCase):
    def test_seg_seg_distance(self):
        self.assertAlmostEqual(pt.seg_seg_dist((0, 0), (10, 0), (5, 1), (5, 4)), 1)
        self.assertEqual(pt.seg_seg_dist((0, 0), (10, 0), (5, -1), (5, 4)), 0)   # crossing

    def test_shape_seg_dist_poly_inside_is_zero(self):
        sq = ('poly', [(0, 0), (4, 0), (4, 4), (0, 4)])
        self.assertEqual(pt.shape_seg_dist(sq, (1, 1), (2, 2)), 0)
        self.assertAlmostEqual(pt.shape_seg_dist(sq, (6, 0), (6, 4)), 2)
        self.assertAlmostEqual(pt.shape_seg_dist(('seg', (0, 0), (0, 4), 0.5), (2, 1), (2, 3)), 1.5)

    def test_first_conflict_names_the_obstacle(self):
        obs = {'F.Cu': [(('seg', (5, -5), (5, 5), 0.125), 0.2, 'track GND')], 'B.Cu': []}
        hit = pt.first_conflict([((0, 0), (10, 0), 'F.Cu', 0.2)], [], 0.6, obs)
        self.assertRegex(hit, r'^F\.Cu track \(0\.000, 0\.000\)-\(10\.000, 0\.000\) w 0\.2: gap -0\.225 < 0\.2 to track GND$')
        self.assertIsNone(pt.first_conflict([((0, 0), (10, 0), 'B.Cu', 0.2)], [], 0.6, obs))
        self.assertRegex(pt.first_conflict([], [(5, 0.8)], 0.6, obs), r'^F\.Cu via \(5\.000, 0\.800\)')


class BudgetTest(unittest.TestCase):
    LINES = ['head'] + [f'LOW N{i % 3} pair {i} ' + 'x' * 20 for i in range(20)] + ['20 pairs below']

    def kind(self, line):
        return ('pairs below current', line.split()[1]) if line.startswith('LOW') else (None, None)

    def test_fits_is_unchanged(self):
        self.assertEqual(pt.budget_cut(self.LINES, 10 ** 6, self.kind, keep_last=True), self.LINES)

    def test_cut_keeps_head_and_last_and_names_the_rest(self):
        out = pt.budget_cut(self.LINES, 200, self.kind, keep_last=True)
        self.assertLessEqual(len('\n'.join(out)) + 1, 200)
        self.assertEqual((out[0], out[-1]), ('head', '20 pairs below'))
        shown = sum(1 for l in out if l.startswith('LOW'))
        self.assertEqual(out[-2], f'... {20 - shown} more pairs below current, 3 nets, not shown')

    def test_unknown_lines_count_as_lines(self):
        out = pt.budget_cut(['a' * 10] * 5, 30, lambda l: (None, None))
        self.assertEqual(out[-1], f'... {5 - len(out) + 1} more lines, not shown')
        self.assertLessEqual(len('\n'.join(out)) + 1, 30)

    def test_net_check_without_limit_lists_all(self):
        text, _ = pt.net_check(NetCheckTest.D, 'VBAT', limit=None)
        self.assertEqual(len(text.splitlines()), 3)


try:
    import pcbnew
except ImportError:
    pcbnew = None


@unittest.skipIf(pcbnew is None, 'needs the KiCad bundled Python (pcbnew)')
class CorridorBoardTest(unittest.TestCase):
    """Synthetic board: SIG pads R1.1 (10, 10), R2.1 (20, 10), R3.1 (26, 10) on F.Cu; a GND track x = 15 on F.Cu."""

    def make_board(self, d):
        import json
        mm = pcbnew.FromMM
        b = pcbnew.BOARD()
        nets = {}
        for n in ('SIG', 'GND'):
            nets[n] = pcbnew.NETINFO_ITEM(b, n)
            b.Add(nets[n])
        edge = pcbnew.PCB_SHAPE(b)
        edge.SetShape(pcbnew.SHAPE_T_RECT)
        edge.SetStart(pcbnew.VECTOR2I(mm(0), mm(0)))
        edge.SetEnd(pcbnew.VECTOR2I(mm(30), mm(20)))
        edge.SetLayer(pcbnew.Edge_Cuts)
        b.Add(edge)
        for ref, x in (('R1', 10), ('R2', 20), ('R3', 26)):
            fp = pcbnew.FOOTPRINT(b)
            fp.SetReference(ref)
            fp.SetPosition(pcbnew.VECTOR2I(mm(x), mm(10)))
            pad = pcbnew.PAD(fp)
            pad.SetNumber('1')
            pad.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
            pad.SetShape(pcbnew.PAD_SHAPE_RECT)
            pad.SetSize(pcbnew.VECTOR2I(mm(1), mm(1)))
            pad.SetLayerSet(pad.SMDMask())
            pad.SetPosition(pcbnew.VECTOR2I(mm(x), mm(10)))
            pad.SetNet(nets['SIG'])
            fp.Add(pad)
            b.Add(fp)
        t = pcbnew.PCB_TRACK(b)
        t.SetStart(pcbnew.VECTOR2I(mm(15), mm(5)))
        t.SetEnd(pcbnew.VECTOR2I(mm(15), mm(15)))
        t.SetWidth(mm(0.25))
        t.SetLayer(pcbnew.F_Cu)
        t.SetNet(nets['GND'])
        b.Add(t)
        path = os.path.join(d, 'T.kicad_pcb')
        b.Save(path)
        with open(os.path.join(d, 'T.kicad_pro'), 'w') as f:
            json.dump({'net_settings': {'classes': [{'name': 'Default', 'track_width': 0.2, 'clearance': 0.2,
                                                         'via_diameter': 0.6, 'via_drill': 0.3}],
                                        'netclass_patterns': []}}, f)
        return path

    def test_corridor_lists_the_pair_and_maps_the_block(self):
        import subprocess
        import sys
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            board = self.make_board(d)
            r = subprocess.run([sys.executable, os.path.join(HERE, 'pcbtool.py'), 'corridor', board, 'SIG',
                                '--margin', '1', '--cell', '0.5'], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = r.stdout
        self.assertIn('class Default, width 0.2, clearance 0.2', out)
        self.assertRegex(out, r'A R1\.1 \(10\.000, 10\.000\) F\s*-\s*B R2\.1 \(20\.000, 10\.000\) F')
        maps = out.split('map ')[1:]
        self.assertEqual([m.split()[0] for m in maps], ['F.Cu', 'B.Cu'])
        front = [l for l in maps[0].splitlines() if 'A' in l and 'B' in l][0]
        self.assertRegex(front, r'A[.+]*#+[.+]*B')          # the GND track blocks the straight path on F.Cu
        back = maps[1].splitlines()[maps[0].splitlines().index(front)]
        self.assertNotRegex(back, r'[#AB]')                  # B.Cu is free; SMD pads on F.Cu are not marked there
        self.assertLess(len(out), 2500)

    def test_pair_option_maps_one_pair_only(self):
        import subprocess
        import sys
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            board = self.make_board(d)
            r = subprocess.run([sys.executable, os.path.join(HERE, 'pcbtool.py'), 'corridor', board, 'SIG',
                                '--margin', '1', '--cell', '0.5', '--pair', '2'], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('grid x0=19.000 y0=9.000 cell=0.5 cols=16 rows=4', r.stdout)

    def run_box(self, *box):
        import subprocess
        import sys
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            board = self.make_board(d)
            r = subprocess.run([sys.executable, os.path.join(HERE, 'pcbtool.py'), 'corridor', board, 'SIG',
                                '--cell', '0.5', '--box', *map(str, box)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def test_box_maps_only_the_window_at_the_cell(self):
        out = self.run_box(16, 11, 14, 9)                    # corners in any order
        self.assertIn('grid x0=14.000 y0=9.000 cell=0.5 cols=4 rows=4', out)
        self.assertNotIn('cell grown', out)

    def test_large_box_grows_the_cell_and_says_so(self):
        out = self.run_box(0, 0, 60, 20)
        self.assertIn('cell grown from 0.5 to 0.75', out)

    def run_connect(self, *intent):
        import hashlib
        import pathlib
        import subprocess
        import sys
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            board = self.make_board(d)
            before = hashlib.sha256(pathlib.Path(board).read_bytes()).hexdigest()
            spec = os.path.join(d, 'intent.txt')
            with open(spec, 'w') as f:
                f.write('# comment\n' + '\n'.join(intent) + '\n')
            r = subprocess.run([sys.executable, os.path.join(HERE, 'pcbtool.py'), 'connect', board, spec],
                               capture_output=True, text=True)
            b = pcbnew.LoadBoard(board)
            sig = [t for t in b.GetTracks() if t.GetNetname() == 'SIG']
            changed = hashlib.sha256(pathlib.Path(board).read_bytes()).hexdigest() != before
        return r, sig, changed

    def test_connect_conflict_writes_nothing(self):
        r, sig, changed = self.run_connect('SIG R1.1 -> R2.1')
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertFalse(changed)
        self.assertEqual(r.stdout.strip().splitlines(), [r.stdout.strip()])
        self.assertIn('to track GND', r.stdout)
        self.assertIn('nothing written', r.stdout)

    def test_connect_with_vias_under_the_block(self):
        r, sig, changed = self.run_connect('SIG R1.1 -> R2.1 via 12,10 via 18,10')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(changed)
        vias = [t for t in sig if isinstance(t, pcbnew.PCB_VIA)]
        segs = sorted((t.GetLayerName(), pcbnew.ToMM(t.GetWidth())) for t in sig if not isinstance(t, pcbnew.PCB_VIA))
        self.assertEqual(len(vias), 2)
        self.assertEqual(segs, [('B.Cu', 0.2), ('F.Cu', 0.2), ('F.Cu', 0.2)])   # class width, B.Cu under the GND track
        self.assertEqual(pcbnew.ToMM(vias[0].GetWidth(pcbnew.F_Cu)), 0.6)

    def test_corridor_budget_cuts_and_says_what(self):
        import subprocess
        import sys
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            board = self.make_board(d)
            cmd = [sys.executable, os.path.join(HERE, 'pcbtool.py'), 'corridor', board, 'SIG', '--margin', '1', '--cell', '0.5']
            full = subprocess.run(cmd, capture_output=True, text=True)
            r = subprocess.run(cmd + ['--budget', '700'], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertLessEqual(len(r.stdout), 700)
        self.assertRegex(r.stdout.splitlines()[-1], r'^\.\.\. \d+ more map rows(, \d+ maps)?, not shown$')
        self.assertTrue(full.stdout.startswith(r.stdout.rsplit('\n', 2)[0]))



class SuggestCoreTest(unittest.TestCase):
    def test_corners_keep_turns_and_vias_only(self):
        cols = 10                                        # (c, r) -> r * cols + c; layers 0/1
        path = [(0, 0), (1, 0), (2, 0), (13, 0), (24, 0), (24, 1), (25, 1), (26, 1)]
        self.assertEqual(pt.node_corners(path, cols), [('through', 2), ('via', 24)])

    def test_astar_goes_around_a_block_and_under_a_wall(self):
        cols, rows = 5, 3                                # wall at c = 2 on layer 0, all rows
        free0 = bytearray(1 if i % cols != 2 else 0 for i in range(cols * rows))
        path, cost = pt.astar((cols, rows, 1.0), [free0, bytearray([1] * 15)], bytearray([1] * 15),
                              [[0.0] * 15, [0.0] * 15], 5, {0}, 9, {0}, via_cost=2)
        self.assertEqual([l for _, l in path].count(1) > 0, True)
        self.assertEqual(path[0], (5, 0))
        self.assertEqual(path[-1], (9, 0))
        self.assertAlmostEqual(cost, 4 + 2 * 2)          # 4 steps, 2 vias

    def test_astar_no_path_returns_the_reached_nodes(self):
        free0 = bytearray(1 if i % 5 != 2 else 0 for i in range(15))
        path, reached = pt.astar((5, 3, 1.0), [free0], bytearray(15), [[0.0] * 15], 5, {0}, 9, {0}, via_cost=2)
        self.assertIsNone(path)
        self.assertIn(6, reached)
        self.assertNotIn(8, reached)

    def test_drop_jogs_removes_short_legs_and_straight_points_when_free(self):
        pts = [('end', (0, 0)), ('through', (5, 0)), ('through', (5.2, 0.2)), ('through', (8, 0.2)), ('end', (10, 0.2))]
        out = pt.drop_jogs(pts, 'F.Cu', lambda a, b, c, L: True)
        self.assertEqual(out, [('end', (0, 0)), ('end', (10, 0.2))])

    def test_drop_jogs_keeps_a_jog_when_the_direct_leg_is_blocked(self):
        pts = [('end', (0, 0)), ('through', (5, 0)), ('through', (5.2, 0.2)), ('end', (10, 0.2))]
        self.assertEqual(pt.drop_jogs(pts, 'F.Cu', lambda a, b, c, L: False), pts)

    def test_drop_jogs_tracks_the_layer_after_a_via(self):
        seen = []
        pts = [('end', (0, 0)), ('via', (2, 0)), ('through', (4, 0)), ('end', (6, 0))]
        pt.drop_jogs(pts, 'F.Cu', lambda a, b, c, L: seen.append(L) or True)
        self.assertEqual(seen, ['B.Cu'])


class VerifyVerdictTest(unittest.TestCase):
    @staticmethod
    def drc(errors=(), unc=()):
        return {'violations': [{'type': t, 'severity': 'error', 'items': [{'description': f'Track [{n}]'}]} for t, n in errors],
                'unconnected_items': [{'items': [{'description': f'Pad 1 [{n}]'}, {'description': f'Pad 2 [{n}]'}]} for n in unc]}

    def test_ok_when_the_net_connects_and_nothing_else_changes(self):
        base = self.drc([('clearance', 'X')], ['SIG', 'GND'])
        self.assertEqual(pt.verify_verdict(base, self.drc([('clearance', 'X')], ['GND']), 'SIG'), (True, ''))

    def test_new_error_is_rejected(self):
        ok, why = pt.verify_verdict(self.drc(unc=['SIG']), self.drc([('clearance', 'SIG')]), 'SIG')
        self.assertFalse(ok)
        self.assertIn('+1 clearance', why)

    def test_more_gnd_unconnected_is_rejected(self):
        ok, why = pt.verify_verdict(self.drc(unc=['SIG', 'GND']), self.drc(unc=['GND', 'GND']), 'SIG')
        self.assertFalse(ok)
        self.assertIn('GND unconnected 1 -> 2', why)

    def test_net_still_open_is_rejected(self):
        ok, why = pt.verify_verdict(self.drc(unc=['SIG']), self.drc(unc=['SIG']), 'SIG')
        self.assertFalse(ok)
        self.assertIn('SIG unconnected 1 -> 1', why)


@unittest.skipIf(pcbnew is None, 'needs the KiCad bundled Python (pcbnew)')
class SuggestBoardTest(unittest.TestCase):
    """Synthetic board 30 x 20 mm: SIG pads R1.1 (10, 10) and R2.1 (20, 10) on F.Cu; optional GND track x = 15 on
    F.Cu from y1 to y2; optional zone (net, x1, y1, x2, y2) on F.Cu."""

    def make_board(self, d, wall=None, zone=None):
        import json
        mm = pcbnew.FromMM
        b = pcbnew.BOARD()
        nets = {}
        for n in ('SIG', 'GND', 'VCC'):
            nets[n] = pcbnew.NETINFO_ITEM(b, n)
            b.Add(nets[n])
        edge = pcbnew.PCB_SHAPE(b)
        edge.SetShape(pcbnew.SHAPE_T_RECT)
        edge.SetStart(pcbnew.VECTOR2I(mm(0), mm(0)))
        edge.SetEnd(pcbnew.VECTOR2I(mm(30), mm(20)))
        edge.SetLayer(pcbnew.Edge_Cuts)
        b.Add(edge)
        for ref, x in (('R1', 10), ('R2', 20)):
            fp = pcbnew.FOOTPRINT(b)
            fp.SetReference(ref)
            fp.SetPosition(pcbnew.VECTOR2I(mm(x), mm(10)))
            pad = pcbnew.PAD(fp)
            pad.SetNumber('1')
            pad.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
            pad.SetShape(pcbnew.PAD_SHAPE_RECT)
            pad.SetSize(pcbnew.VECTOR2I(mm(1), mm(1)))
            pad.SetLayerSet(pad.SMDMask())
            pad.SetPosition(pcbnew.VECTOR2I(mm(x), mm(10)))
            pad.SetNet(nets['SIG'])
            fp.Add(pad)
            b.Add(fp)
        if wall:
            t = pcbnew.PCB_TRACK(b)
            t.SetStart(pcbnew.VECTOR2I(mm(15), mm(wall[0])))
            t.SetEnd(pcbnew.VECTOR2I(mm(15), mm(wall[1])))
            t.SetWidth(mm(0.25))
            t.SetLayer(pcbnew.F_Cu)
            t.SetNet(nets['GND'])
            b.Add(t)
        if zone:
            z = pcbnew.ZONE(b)
            z.SetLayer(pcbnew.F_Cu)
            z.SetNet(nets[zone[0]])
            ol = z.Outline()
            ol.NewOutline()
            x1, y1, x2, y2 = zone[1:]
            for x, y in ((x1, y1), (x2, y1), (x2, y2), (x1, y2)):
                ol.Append(mm(x), mm(y))
            b.Add(z)
        path = os.path.join(d, 'T.kicad_pcb')
        b.Save(path)
        with open(os.path.join(d, 'T.kicad_pro'), 'w') as f:
            json.dump({'net_settings': {'classes': [{'name': 'Default', 'track_width': 0.2, 'clearance': 0.2,
                                                         'via_diameter': 0.6, 'via_drill': 0.3}],
                                        'netclass_patterns': []}}, f)
        return path

    def run_suggest(self, *args, wall=None, zone=None):
        """(suggest result, connect result of the first proposed line or None)."""
        import subprocess
        import sys
        import tempfile
        tool = os.path.join(HERE, 'pcbtool.py')
        with tempfile.TemporaryDirectory() as d:
            board = self.make_board(d, wall, zone)
            r = subprocess.run([sys.executable, tool, 'suggest', board, 'SIG', '--cell', '0.25', *args],
                               capture_output=True, text=True)
            lines = [l for l in r.stdout.splitlines() if l.startswith('SIG R1.1 -> R2.1')]
            c = lines and subprocess.run([sys.executable, tool, 'connect', board, lines[0]], capture_output=True, text=True)
        return r, (lines[0] if lines else None), c

    def test_straight_path(self):
        r, line, c = self.run_suggest()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(line, 'SIG R1.1 -> R2.1 layer=F.Cu')
        self.assertIn('1) len 10.00 vias 0 bends 0', r.stdout)
        self.assertEqual(c.returncode, 0, c.stdout + c.stderr)
        self.assertLess(len(r.stdout), 1500)

    def test_detour_around_an_obstacle(self):
        r, line, c = self.run_suggest('--layers', 'F.Cu', wall=(8, 12))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('through', line)
        self.assertNotIn('via ', line)
        self.assertRegex(r.stdout, r'1\) len 1\d\.\d\d vias 0 ')
        self.assertEqual(c.returncode, 0, c.stdout + c.stderr)

    def test_forced_via_to_the_other_layer(self):
        r, line, c = self.run_suggest(wall=(0, 20))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(line.count(' via '), 2)
        self.assertIn('vias 2', r.stdout)
        self.assertEqual(c.returncode, 0, c.stdout + c.stderr)

    def test_no_path_names_the_block(self):
        r, line, c = self.run_suggest('--layers', 'F.Cu', wall=(0, 20))
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIsNone(line)
        self.assertIn('no path', r.stdout)
        self.assertIn('track GND', r.stdout)

    def test_gnd_pour_is_avoided_when_a_detour_is_cheap(self):
        r, line, c = self.run_suggest('--layers', 'F.Cu', zone=('GND', 13, 9, 17, 20))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('pour 0.0', r.stdout.split('1) ')[1].splitlines()[0])
        ys = [float(t.split(',')[1]) for t in line.split() if ',' in t]
        self.assertTrue(ys and min(ys) < 9)
        self.assertEqual(c.returncode, 0, c.stdout + c.stderr)

    def test_verify_applies_on_a_copy_and_marks_verified(self):
        import hashlib
        import pathlib
        import subprocess
        import sys
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            board = self.make_board(d)
            before = hashlib.sha256(pathlib.Path(board).read_bytes()).hexdigest()
            r = subprocess.run([sys.executable, os.path.join(HERE, 'pcbtool.py'), 'suggest', board, 'SIG', '--cell', '0.25',
                                '--k', '2', '--verify'], capture_output=True, text=True)
            after = hashlib.sha256(pathlib.Path(board).read_bytes()).hexdigest()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(before, after)
        self.assertIn('1) verified len 10.00 vias 0', r.stdout)

    def test_other_net_pour_blocks(self):
        r, line, c = self.run_suggest('--layers', 'F.Cu', zone=('VCC', 13, 0, 17, 20))
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn('pour VCC', r.stdout)

def json_copy(x):
    import json
    return json.loads(json.dumps(x))


if __name__ == '__main__':
    unittest.main()
