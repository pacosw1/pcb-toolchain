"""Router congestion at the unit pins (congest.py) and the repair rank 'hot' (repair.hot_order)."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import congest, cost, repair  # noqa: E402
from placer.test_wirelen import problem  # noqa: E402


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


class MapTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, 'congestion.json')
        route_map(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def test_from_route_sums_the_layers_and_checks_the_schema(self):
        g = congest.from_route(self.path)
        self.assertEqual((g['nx'], g['ny'], g['cell']), (40, 40, 1.0))
        self.assertEqual(g['h'][10 * 40 + 10], 2.0)
        self.assertEqual(sum(g['h']), 18.0)
        bad = os.path.join(self.tmp.name, 'b.json')
        with open(bad, 'w') as fh:
            json.dump({'schema': 'x'}, fh)
        with self.assertRaises(ValueError):
            congest.from_route(bad)

    def test_value_counts_signal_pins_in_hot_cells(self):
        pr = problem()
        m = congest.Model(pr, congest.from_route(self.path))
        pose = cost.initial_pose(pr)
        # U1 (10, 10): signal pins A (10.5, 10), B (9.5, 10) and (10.5, 10.3); the plane net P has no pin on U1
        self.assertEqual(m.value(0, *pose[0]), 3 * 2.0)
        # R1 (14, 10): A pin at 13.5 is outside the hot cells; its P pin is a plane net (not counted)
        self.assertEqual(m.value(1, *pose[1]), 0.0)
        self.assertEqual(m.value(1, 10.5, 10.0, 0), 2.0)  # A pin (10.0, 10.0) in the hot cells
        self.assertEqual(m.h_at(-1.0, 5.0), 0.0)  # outside the map

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
