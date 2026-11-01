"""Speed helpers of si_planes give the same answers as the slow paths.

- SpatialCandidates grid fast path == AABB tree == brute-force overlap scan.
- CandidateUnion (indexed boundaries + plain per-net edges) == one plain list.
- CellContainsPoly (cell memo) == native SHAPE_POLY_SET.Contains (needs pcbnew).
Run: cd tools && python3 -m unittest test_si_speed_index   (KiCad Python for the native test)
"""
import math
import random
import unittest

import si_planes as si


def brute(boxes, query):
    return [i for i, b in enumerate(boxes)
            if b[0] <= query[2] and query[0] <= b[2] and b[1] <= query[3] and query[1] <= b[3]]


def tree_ids(index, query):
    """The tree path only (the grid switched off)."""
    grid, index.grid = index.grid, None
    try:
        return list(index.candidates(query))
    finally:
        index.grid = grid


class GridIndexTests(unittest.TestCase):
    def test_grid_tree_and_brute_force_agree(self):
        rng = random.Random(11)
        for scale in (1e-3, 1.0, 150.0, 1e6):
            boxes = []
            for _ in range(600):
                x, y = rng.uniform(-1, 1) * scale, rng.uniform(-1, 1) * scale
                w, h = rng.expovariate(1 / (scale * .01)), rng.expovariate(1 / (scale * .01))
                boxes.append((x, y, x + w, y + h))
            boxes += [(0, 0, -1, -1), (scale, scale, -scale, -scale),               # inverted boxes
                      (-scale, -scale, scale, scale), (0, 0, math.inf, 1),            # wide, non-finite
                      (1, 1, 1, 1), (-scale, 0, scale, 0)]                            # point, zero height
            index = si.SpatialCandidates(range(len(boxes)), boxes)
            self.assertIsNotNone(index.grid)
            for _ in range(800):
                x, y = rng.uniform(-1.2, 1.2) * scale, rng.uniform(-1.2, 1.2) * scale
                size = rng.choice((0, 0, scale * 1e-4, scale * .01, scale * .1, scale))
                query = (x, y, x + size * rng.random(), y + size * rng.random())
                want = brute(boxes, query)
                self.assertEqual(list(index.candidates(query)), want, query)
                self.assertEqual(tree_ids(index, query), want, query)
            for query in ((-2 * scale, -2 * scale, -1.5 * scale, -1.5 * scale),   # outside the grid
                          (-math.inf, 0, 0, 1), (1, 1, 0, 0), (0, 0, math.nan, 1)):
                self.assertEqual(list(index.candidates(query)), brute(boxes, query), query)

    def test_box_edges_are_inclusive_on_cell_borders(self):
        boxes = [(i, 0, i + 1, 1) for i in range(100)]
        index = si.SpatialCandidates(range(100), boxes)
        for q in ((5, 0, 5, 0), (5.5, .5, 5.5, .5), (99, 1, 99, 1), (100, 0, 100, 0), (0, 1, 0, 1)):
            self.assertEqual(list(index.candidates(q)), brute(boxes, q), q)

    def test_small_sets_use_the_tree(self):
        self.assertIsNone(si.SpatialCandidates(range(3), [(0, 0, 1, 1)] * 3).grid)


class CandidateUnionTests(unittest.TestCase):
    def test_union_breaks_equal_plain_list(self):
        rng = random.Random(5)
        point = lambda: (rng.uniform(0, 50), rng.uniform(0, 50))
        boundaries = [(point(), point()) for _ in range(400)]
        extra = [(point(), point()) for _ in range(20)] + [((1, 1), (1, 1))]
        union = si.CandidateUnion(si.segment_candidates(boundaries), extra)
        self.assertEqual(list(union), boundaries + extra)
        circles = [(point(), rng.uniform(0, 3)) for _ in range(20)]
        for _ in range(500):
            a, b = point(), point()
            if rng.random() < .5:
                b = (a[0] + rng.uniform(-.5, .5), a[1] + rng.uniform(-.5, .5))
            self.assertEqual(si.reference_breaks(union, a, b, circles),
                             si.reference_breaks(boundaries + extra, a, b, circles))

    def test_evaluate_paths_indexed_equals_plain(self):
        spec = {'alt_refs': {}, 'exempt': {'areas': [{'box': (4, 4, 6, 6), 'nets': ['N']}], 'nets': {}},
                'via_allow_mm': .3, 'step_mm': .25, 'grounds': ['GND'], 'fast': [], 'mixed_layers': {}}
        ring = [(0, 0), (10, 0), (10, 10), (0, 10)]
        hole = [(3, 3), (7, 3), (7, 7), (3, 7)]
        boundaries = list(zip(ring, ring[1:] + ring[:1])) + list(zip(hole, hole[1:] + hole[:1]))
        boundaries += [((20 + i, 0), (20 + i, 1)) for i in range(80)]   # enough edges for the grid
        ref = lambda x, y: 'GND' if 0 < x < 10 and 0 < y < 10 and not (3 < x < 7 and 3 < y < 7) else None
        paths = [((1, 5), (9, 5)), ((5, 1), (5, 9)), ((1, 1), (2, 2), (3, 1))]
        anchors = [(1, 5, .2)]
        plain = si.evaluate_paths(paths, boundaries, ref, 'GND', anchors, spec, 'N')
        indexed = si.evaluate_paths(paths, si.segment_candidates(boundaries), ref, 'GND', anchors, spec, 'N')
        self.assertEqual(indexed, plain)
        self.assertGreater(plain['unref'], 0)


try:
    import pcbnew
except ImportError:   # system Python: the native test needs the KiCad Python
    pcbnew = None


@unittest.skipIf(pcbnew is None, 'needs KiCad pcbnew')
class CellContainsNativeTests(unittest.TestCase):
    def polygon(self, rng):
        p = pcbnew
        poly = p.SHAPE_POLY_SET()
        poly.NewOutline()
        for x, y in ((0, 0), (40, 0), (40, 3), (37, 30), (0, 30)):
            poly.Append(p.FromMM(x), p.FromMM(y))
        holes = p.SHAPE_POLY_SET()
        for _ in range(40):   # round holes and thin slots, some of them overlap
            cx, cy, r = rng.uniform(2, 38), rng.uniform(2, 28), rng.uniform(.05, 1.5)
            holes.NewOutline()
            for k in range(rng.choice((6, 16, 32))):
                t = 2 * math.pi * k / 16
                holes.Append(p.FromMM(cx + r * math.cos(t)), p.FromMM(cy + r * math.sin(t)))
        for _ in range(10):
            x, y = rng.uniform(2, 38), rng.uniform(2, 28)
            holes.NewOutline()
            for dx, dy in ((0, 0), (5, .7), (5, .75), (0, .05)):
                holes.Append(p.FromMM(x + dx), p.FromMM(y + dy))
        poly.BooleanSubtract(holes)
        poly.BuildBBoxCaches()
        return poly

    def test_memo_equals_native_contains(self):
        p = pcbnew
        rng = random.Random(42)
        poly = self.polygon(rng)
        self.assertGreater(poly.HoleCount(0), 5)
        memo = si.CellContainsPoly(poly)
        points = []
        for _ in range(30000):   # random points, many in clean cells
            points.append((p.FromMM(rng.uniform(-1, 41)), p.FromMM(rng.uniform(-1, 31))))
        for k in range(poly.OutlineCount()):   # vertices and points 1 nm and 2 um next to them
            for ring in [poly.COutline(k)] + [poly.CHole(k, h) for h in range(poly.HoleCount(k))]:
                for j in range(ring.PointCount()):
                    v = ring.CPoint(j)
                    for dx, dy in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1), (2000, 0), (-2000, 2000)):
                        points.append((v.x + dx, v.y + dy))
        clean = 0
        for x, y in points * 2:   # second pass reads the memo
            v = p.VECTOR2I(x, y)
            self.assertEqual(memo.Contains(v, -1, 0, True), poly.Contains(v, -1, 0, True), (x, y))
            clean += any((x // c, y // c) not in d for c, d in zip(memo.levels, memo.dirty))
        self.assertGreater(clean, len(points) // 2)
        self.assertEqual(memo.Area(), poly.Area())   # other calls go to the native polygon
        v = p.VECTOR2I(p.FromMM(20), p.FromMM(15))
        self.assertEqual(memo.Contains(v, 0, 0, False), poly.Contains(v, 0, 0, False))


if __name__ == '__main__':
    unittest.main()
