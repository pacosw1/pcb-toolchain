"""Pure counterexamples; native polygon API integration needs separate approval."""
import unittest
import si_planes as sp


def rectangle_edges(x0, y0, x1, y1):
    p = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    return list(zip(p, p[1:] + p[:1]))


def plane_with_strip():
    ok = lambda x, y: -1 <= x <= 6 and -2 <= y <= 2 and not (.21 < x < .39)
    boundaries = rectangle_edges(-1, -2, 6, 2) + rectangle_edges(.21, -2, .39, 2)
    return ok, lambda a, b: sp.continuous_reference(ok, boundaries, a, b)


class DetourCorrectnessTests(unittest.TestCase):
    def test_coarse_grid_cannot_jump_thin_domain_break(self):
        ok, edge = plane_with_strip()
        for cell in (.1, .5):
            self.assertIsNone(sp.detour_mm(ok, [(0, 0, .01), (5, 0, .01)], 100, cell, edge_ok=edge))

    def test_portals_cannot_invent_alternate_copper(self):
        ok, edge = plane_with_strip()
        self.assertIsNone(sp.detour_mm(ok, [(0, 0, .01), (5, 0, .01)], 100, .5,
                                      [(0, 0), (5, 0)], edge_ok=edge))
        self.assertIsNone(sp.detour_mm(ok, [(0, 0, .01), (5, 0, .01)], 100, .5,
                                      [(0, 0), (5, 0)], edge, ok, edge))

    def test_portals_transfer_only_through_actual_alternate_plane(self):
        ok, edge = plane_with_strip()
        alt = lambda x, y: -1 <= x <= 6 and -2 <= y <= 2
        ae = lambda a, b: sp.continuous_reference(alt, rectangle_edges(-1, -2, 6, 2), a, b)
        self.assertAlmostEqual(sp.detour_mm(ok, [(0, 0, .01), (5, 0, .01)], 100, .5,
                                          [(0, 0), (5, 0)], edge, alt, ae), 5)

    def test_hole_on_alternate_plane_forces_real_detour(self):
        ok, edge = plane_with_strip()
        alt = lambda x, y: -1 <= x <= 6 and -2 <= y <= 2 and not (2 < x < 3 and -1 < y < 1)
        boundaries = rectangle_edges(-1, -2, 6, 2) + rectangle_edges(2, -1, 3, 1)
        ae = lambda a, b: sp.continuous_reference(alt, boundaries, a, b)
        d = sp.detour_mm(ok, [(0, 0, .01), (5, 0, .01)], 100, .5, [(0, 0), (5, 0)], edge, alt, ae)
        self.assertGreater(d, 5)
        self.assertIsNone(sp.detour_mm(ok, [(0, 0, .01), (5, 0, .01)], 5.01, .5,
                                      [(0, 0), (5, 0)], edge, alt, ae))

    def test_absent_terminals_are_not_proven_stub(self):
        for terminals in ([], [(0, 0, .1)]):
            self.assertIsNone(sp.detour_mm(lambda x, y: False, terminals, 100, .1))
        # No external boolean can turn a missing-reference net into a stub.
        with self.assertRaises(TypeError):
            sp.detour_mm(lambda x, y: False, [], 100, .1, stub_proven=True)

    def test_snap_overlap_does_not_erase_actual_length(self):
        ok = lambda x, y: True
        edge = lambda a, b: True
        self.assertAlmostEqual(sp.detour_mm(ok, [(0, 0, .5), (.2, 0, .5)], 10, .5, edge_ok=edge), .2)

    def test_non_grid_portals_preserve_distance(self):
        ok, edge = plane_with_strip()
        alt = lambda x, y: True
        d = sp.detour_mm(ok, [(0, 0, .01), (5, 0, .01)], 100, .5,
                         [(0.03, 0), (4.97, 0)], edge, alt, lambda a, b: True)
        self.assertIsNotNone(d)
        self.assertGreaterEqual(d, 5)

    def test_cap_boundary_is_not_bridged_by_free_endpoints(self):
        ok = lambda x, y: abs(x) <= .1 or abs(x - 1) <= .1
        circles = [((0, 0), .1), ((1, 0), .1)]
        self.assertFalse(sp.continuous_reference(ok, [], (0, 0), (1, 0), circles))

    def test_straight_leaf_requires_contiguous_reference_prefix(self):
        run = {'terminals': [(4.9, 0, .1)], 'bad_points': [(5.1, 0), (7.9, 0)]}
        ref = lambda x, y: x <= 5
        breaks = lambda a, b: [0, .5, 1]
        self.assertEqual(sp.single_leaf_candidate((2, 0), (8, 0), run, ref, breaks),
                         ((2, 0), (5, 0), (8, 0)))
        self.assertIsNone(sp.single_leaf_candidate((2, 0), (8, 0), run, lambda x, y: False, breaks))
        self.assertIsNone(sp.single_leaf_candidate((2, 0), (8, 0), dict(run, terminals=[]), ref, breaks))
        self.assertIsNone(sp.single_leaf_candidate((2, 0), (8, 0), dict(run, bad_points=[(6, .01)]), ref, breaks))

    def test_a_gap_before_leaf_is_not_single_attachment(self):
        run = {'terminals': [(4.9, 0, .1)], 'bad_points': [(7.9, 0)]}
        ref = lambda x, y: x <= 5 and not (3 < x < 4)
        breaks = lambda a, b: [0, 1/6, 2/6, .5, 1]
        self.assertIsNone(sp.single_leaf_candidate((2, 0), (8, 0), run, ref, breaks))


if __name__ == '__main__':
    unittest.main()
