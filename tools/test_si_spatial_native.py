"""Actual native membership oracle; synthetic fixtures, not board qualification."""
import collections
import hashlib
import json
import os
from pathlib import Path
import random
import unittest

import si_planes as si
import test_si_detour_native as fixtures


def unindexed_native_geometry(p, fills, layer, domain, spec, caps, copper_items):
    """Legacy full-scan oracle, deliberately independent of spatial/memo helpers.

    Native Contains remains the membership oracle; exact unfiltered boundaries
    use the intersection routine whose randomized equality is separately tested.
    """
    lands = []
    for item in copper_items:
        if item.GetNetname() != domain or not item.IsOnLayer(layer):
            continue
        poly = p.SHAPE_POLY_SET()
        item.TransformShapeToPolygon(poly, layer, 0, p.FromMM(.001), p.ERROR_INSIDE)
        poly.BuildBBoxCaches()
        lands.append(poly)
    boundaries = []
    for poly in [poly for _, poly in fills[layer]] + lands:
        for k in range(poly.OutlineCount()):
            for ring in [poly.Outline(k)] + [poly.Hole(k, j) for j in range(poly.HoleCount(k))]:
                pts = [(si.mm(ring.CPoint(j).x), si.mm(ring.CPoint(j).y)) for j in range(ring.PointCount())]
                boundaries.extend(zip(pts, pts[1:] + pts[:1]))
    def ok(x, y):
        point = p.VECTOR2I(p.FromMM(x), p.FromMM(y))
        if any(poly.Contains(point, -1, 0, True) for poly in lands):
            return True
        ref = next((net for net, poly in fills[layer] if poly.Contains(point, -1, 0, True)), None)
        return si.ref_domain(ref, spec, False, (x, y), caps) == domain
    circles = [(c, a['cap_mm']) for n, a in spec['alt_refs'].items() if 'cap_mm' in a for c in caps[n]]
    def edge(a, b):
        return si.continuous_reference(ok, boundaries, a, b, circles)
    edge.breaks = lambda a, b: si.reference_breaks(boundaries, a, b, circles)
    return ok, edge


class NativeSpatialTests(unittest.TestCase):
    def test_real_holes_thermal_lands_rounding_and_edges_match_original(self):
        import pcbnew as p
        factory = fixtures.NativePortalTests('test_real_thermal_lands_transfer_on_solid_alternate')
        factory._testMethodName = self._testMethodName
        factory.fixture('hole')
        path = fixtures.ROOT / (self._testMethodName + '-hole.kicad_pcb')
        board = p.LoadBoard(str(path))
        fills = collections.defaultdict(list)
        for zone in board.Zones():
            poly = zone.GetFilledPolysList(zone.GetLayer())
            poly.BuildBBoxCaches()
            fills[zone.GetLayer()].append((zone.GetNetname(), poly))
        spec = {'grounds': ['GND'], 'alt_refs': {}}
        items = list(board.GetPads()) + list(board.GetTracks())
        rng = random.Random(777)
        points = [(rng.uniform(0, 10), rng.uniform(0, 10)) for _ in range(250)]
        for poly in (poly for ps in fills.values() for _, poly in ps):
            for k in range(poly.OutlineCount()):
                ring = poly.Outline(k)
                for j in range(min(30, ring.PointCount())):
                    v = ring.CPoint(j)
                    points.extend((si.mm(v.x) + delta, si.mm(v.y)) for delta in (-.0000004, 0, .0000004))
        compared = 0
        for layer in (p.In1_Cu, p.In2_Cu):
            old, old_edge = unindexed_native_geometry(p, fills, layer, 'GND', spec, {}, items)
            new, new_edge = si.native_reference_geometry(p, fills, layer, 'GND', spec, {}, items)
            for q in points:
                self.assertEqual(new(*q), old(*q), (layer, q))
                compared += 1
            for a, b in zip(points[:80], points[80:160]):
                for start, end in ((a, b), (b, a)):
                    self.assertEqual(new_edge.breaks(start, end), old_edge.breaks(start, end))
                    self.assertEqual(new_edge(start, end), old_edge(start, end))
            self.assertFalse(new(5, 5))
            self.assertTrue(new(3, 5))  # thermal barrel land is real copper
        receipt = dict(scope='native Contains/cut/edge equivalence, synthetic unqualified geometry',
                       membership_queries=compared, directed_edges=320,
                       board_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                       oracle_contract='unindexed native geometry at SI 862911; exact native Contains and full boundary scan',
                       harness_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                       corrected_sha256=hashlib.sha256(Path(si.__file__).read_bytes()).hexdigest())
        (fixtures.ROOT / (self._testMethodName + '-oracle.json')).write_text(json.dumps(receipt, indent=2)+'\n')


if __name__ == '__main__':
    unittest.main()
