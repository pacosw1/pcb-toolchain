"""The repair rank 'hot' (repair.hot_order). The congestion map tests moved to tools/placer/core/tests/congest.rs."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import repair  # noqa: E402


def unit(name, x, y, fixed=False):
    return {'name': name, 'refs': [name], 'fixed': fixed, 'x': x, 'y': y, 'rects': [[-1.0, -0.5, 1.0, 0.5, 0.5]]}


def net(name, pins):
    """pins: [(unit, local x, local y)] -> one pin box per unit (the box of its points)."""
    by = {}
    for u, x, y in pins:
        by.setdefault(u, []).append((x, y))
    return {'name': name, 'weight': 1.0, 'track': 0.3,
            'pins': [[u, min(p[0] for p in q), min(p[1] for p in q), max(p[0] for p in q), max(p[1] for p in q)]
                     for u, q in sorted(by.items())],
            'pts': [[list(p) for p in by[u]] for u in sorted(by)]}


def problem():
    units = [unit('U1', 10.0, 10.0, fixed=True), unit('R1', 14.0, 10.0), unit('R2', 10.0, 14.0), unit('TP1', 20.0, 20.0)]
    nets = [net('A', [(0, 0.5, 0.0), (1, -0.5, 0.0)]),
            net('B', [(0, -0.5, 0.0), (0, 0.5, 0.3), (2, 0.5, 0.0), (3, 0.0, 0.0)]),
            net('P', [(1, 0.5, 0.0), (2, -0.5, 0.0)]),  # a plane net
            {'name': '~comp:x', 'weight': 1.0, 'track': 0.0, 'cohesion': True,
             'pins': [[1, -1, -0.5, 1, 0.5], [2, -1, -0.5, 1, 0.5]]}]
    return {'units': units, 'nets': nets, 'plane_nets': ['P'],
            'board': {'outline': [[0, 0], [40, 0], [40, 40], [0, 40]], 'keepouts': [], 'edge_clearance': 0.5}}


def route_map(path, nx=40, ny=40):
    """History 2.0 (F.Cu 1.5 + B.Cu 0.5) in the 1 mm cells x 9..11, y 9..11 (round U1 at (10, 10)); 0 elsewhere."""
    hf, hb = [0.0] * (nx * ny), [0.0] * (nx * ny)
    for j in range(9, 12):
        for i in range(9, 12):
            hf[j * nx + i], hb[j * nx + i] = 1.5, 0.5
    m = {'schema': 'iot-lab.route-congestion.v0', 'cell': 1.0, 'origin': [0.0, 0.0], 'nx': nx, 'ny': ny,
         'layers': [{'name': 'F.Cu', 'hist': hf}, {'name': 'B.Cu', 'hist': hb}]}
    with open(path, 'w') as fh:
        json.dump(m, fh)


class HotOrderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_hot_order_puts_the_moves_that_free_history_first(self):
        pr = problem()
        routed = os.path.join(self.tmp.name, 'R.kicad_pcb')
        os.makedirs(routed + '.iotroute')
        route_map(routed + '.iotroute/congestion.json')
        # term order: R1 moves into the hot cells first, then R2 stays cold, then U1's pins leave the hot cells
        props = [dict(unit=1, x=10.5, y=10.0, r=0, name='R1'), dict(unit=2, x=20.0, y=14.0, r=0, name='R2'),
                 dict(unit=0, x=20.0, y=20.0, r=0, name='U1')]
        out = repair.hot_order(props, {'main': pr}, routed)
        self.assertEqual([c['name'] for c in out], ['U1', 'R2', 'R1'])
        self.assertEqual([c['dhot'] for c in out], [-6.0, 0.0, 2.0])
        # no map next to the route: the term order is kept
        self.assertEqual(repair.hot_order(props, {'main': pr}, os.path.join(self.tmp.name, 'none.kicad_pcb')), props)


if __name__ == '__main__':
    unittest.main()
