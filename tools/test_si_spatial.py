import random
import unittest

import si_planes as si


class SpatialReferenceTests(unittest.TestCase):
    def test_randomized_exact_intersections_and_continuous_result(self):
        rng = random.Random(777)
        boundaries = [(tuple(rng.uniform(-100, 100) for _ in range(2)),
                       tuple(rng.uniform(-100, 100) for _ in range(2))) for _ in range(250)]
        circles = [(tuple(rng.uniform(-100, 100) for _ in range(2)), rng.uniform(0, 10)) for _ in range(60)]
        indexed, caps = si.segment_candidates(boundaries), si.circle_candidates(circles)
        ok = lambda x, y: (int(x * 10) + int(y * 10)) % 7 != 0
        for _ in range(300):
            a, b = tuple(rng.uniform(-120, 120) for _ in range(2)), tuple(rng.uniform(-120, 120) for _ in range(2))
            for start, end in ((a, b), (b, a)):
                self.assertEqual(si.reference_breaks(boundaries, start, end, circles),
                                 si.reference_breaks(indexed, start, end, caps))
                self.assertEqual(si.continuous_reference(ok, boundaries, start, end, circles),
                                 si.continuous_reference(ok, indexed, start, end, caps))

    def test_tangency_collinear_zero_length_and_narrow_void(self):
        boundaries = [((.11, -1), (.11, 1)), ((.12, -1), (.12, 1)),
                      ((0, 0), (.25, 0)), ((.25, 0), (.25, 0)),
                      ((0, 1e-16), (1, 1e-16))]
        circles = [((.5, 1), 1), ((.5, 0), 0), ((1, 0), 1e-9)]
        for a, b in [((0, 0), (1, 0)), ((1, 0), (0, 0)), ((.11, 0), (.11, 0)),
                     ((0, 0), (1e-9, 0)), ((0, 0), (1, 1e-14))]:
            self.assertEqual(si.reference_breaks(boundaries, a, b, circles),
                             si.reference_breaks(si.segment_candidates(boundaries), a, b, si.circle_candidates(circles)))
        self.assertFalse(si.continuous_reference(lambda x, y: not .11 < x < .12,
                         si.segment_candidates(boundaries), (0, 0), (1, 0)))

    def test_multiscale_intersection_oracle(self):
        rng = random.Random(3)
        for exponent in (-12, -8, -3, 0, 6, 12):
            scale = 10 ** exponent
            for _ in range(100):
                point = lambda: tuple(rng.uniform(-1, 1) * scale for _ in range(2))
                boundaries = [(point(), point()) for _ in range(10)]
                circles = [(point(), rng.random() * scale) for _ in range(10)]
                a, b = point(), point()
                self.assertEqual(si.reference_breaks(boundaries, a, b, circles),
                                 si.reference_breaks(si.segment_candidates(boundaries), a, b, si.circle_candidates(circles)))

    def test_point_candidates_include_bbox_edges_preserve_original_order(self):
        index = si.SpatialCandidates(range(100), [(i, 0, i + 2, 2) for i in range(100)])
        self.assertEqual(list(index.candidates((20, 0, 20, 0))), [18, 19, 20])
        self.assertEqual(list(index.candidates((-2, 0, -1, 1))), [])

    def test_native_rounding_domain_order_and_cache_are_scoped(self):
        class Point:
            def __init__(self, x, y): self.x, self.y = x, y
        class Ring:
            def __init__(self, x): self.x = x
            def PointCount(self): return 4
            def CPoint(self, i): return Point(*[(self.x, 0), (self.x + 1000000, 0),
                                               (self.x + 1000000, 1000000), (self.x, 1000000)][i])
        class Poly:
            def __init__(self, x): self.x, self.calls = x, 0
            def OutlineCount(self): return 1
            def HoleCount(self, k): return 0
            def Outline(self, k): return Ring(self.x)
            def Contains(self, p, *args):
                self.calls += 1
                return self.x <= p.x <= self.x + 1000000 and 0 <= p.y <= 1000000
        class PCB:
            VECTOR2I = Point
            @staticmethod
            def FromMM(x): return round(x * 1000000)
        wrong, right, distant = Poly(0), Poly(0), Poly(100000000)
        spec = {'grounds': ['GND', 'OTHER'], 'alt_refs': {}}
        ok, edge = si.native_reference_geometry(PCB, {1: [('OTHER', wrong), ('GND', right), ('GND', distant)]}, 1, 'GND', spec, {})
        self.assertFalse(ok(.5, .5))  # first containing domain remains decisive
        self.assertEqual(right.calls, 0)
        self.assertEqual(distant.calls, 0)
        self.assertFalse(ok(.5, .5))
        self.assertEqual(wrong.calls, 1)
        fresh, edge = si.native_reference_geometry(PCB, {1: [('GND', right)]}, 1, 'GND', spec, {})
        self.assertTrue(fresh(-.0000004, .5))  # rounded point is exactly on edge
        self.assertTrue(edge((0, .5), (1, .5)))
        calls = right.calls
        self.assertTrue(edge((0, .5), (1, .5)))
        self.assertEqual(right.calls, calls)
        self.assertTrue(edge((1, .5), (0, .5)))
        # Changed geometry/domain must create an independent scope.
        changed, _ = si.native_reference_geometry(PCB, {1: [('OTHER', right)]}, 1, 'GND', spec, {})
        self.assertFalse(changed(.5, .5))
        cap_spec = {'grounds': ['GND'], 'alt_refs': {'VDD': {'domain': 'GND', 'cap_mm': .5}}}
        capped, capped_edge = si.native_reference_geometry(PCB, {1: [('VDD', right)]}, 1, 'GND', cap_spec, {'VDD': [(0, .5)]})
        # These round to the same native PCB point but have different capacitor
        # applicability; an integer-only point memo would make a false pass.
        self.assertTrue(capped(.4999999, .5))
        self.assertFalse(capped(.5000001, .5))
        self.assertFalse(capped_edge((.4, .5), (.6, .5)))


if __name__ == '__main__':
    unittest.main()
