"""The escape-aware repair proposals and the router tokens. The pin-escape term: tools/placer/core/tests/escape.rs."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import cost, escape, iotroute_step, repair  # noqa: E402

RULES = {'track': 0.15, 'clearance': 0.15, 'via_d': 0.6}  # NET-CORE Default class + via size


def ic_unit(x, y, nets_s=(11, 12, 13), pitch=0.5):
    """U1: 3 pads on the south side (0.3 x 0.8 mm, pitch 0.5) + 1 pad on each other side (net 0 = no net) and an
    exposed pad (net 1). Pads in unit coordinates; the pad box spans y -1.0 .. 1.0."""
    cu, meta = [], []
    for k, n in enumerate(nets_s):
        cx = (k - 1) * pitch
        cu.append([cx - 0.15, 0.2, cx + 0.15, 1.0, n])
        meta.append(['U1', 'smd', str(k + 1)])
    cu += [[-1.0, -0.15, -0.2, 0.15, 0], [0.2, -0.15, 1.0, 0.15, 0], [-0.15, -1.0, 0.15, -0.2, 0],
           [-0.4, -0.4, 0.4, 0.1, 1]]
    meta += [['U1', 'smd', '4'], ['U1', 'smd', '5'], ['U1', 'smd', '6'], ['U1', 'smd', 'EP']]
    return {'name': 'U1', 'refs': ['U1'], 'fixed': True, 'x': x, 'y': y, 'rects': [[-1.2, -1.2, 1.2, 1.2, 1.0]],
            'cu': cu, 'cu_pads': meta}


def part(ref, x, y, nets, fixed=False):
    """A 2-pad part (0402-like) at (x, y): pads 0.5 x 0.5 mm, 1.0 mm apart along x."""
    return {'name': ref, 'refs': [ref], 'fixed': fixed, 'x': x, 'y': y, 'rects': [[-0.9, -0.45, 0.9, 0.45, 0.5]],
            'cu': [[-0.75, -0.25, -0.25, 0.25, nets[0]], [0.25, -0.25, 0.75, 0.25, nets[1]]],
            'cu_pads': [[ref, 'smd', '1'], [ref, 'smd', '2']]}


def wall(ref, x, y, net=5):
    """A part with one 4 mm wide pad (net) and a small pad of net 6: it walls in every ray of the U1 south side."""
    return {'name': ref, 'refs': [ref], 'fixed': False, 'x': x, 'y': y, 'rects': [[-2.2, -0.5, 2.2, 1.3, 0.5]],
            'cu': [[-2.0, -0.3, 2.0, 0.3, net], [-0.25, 0.7, 0.25, 1.1, 6]],
            'cu_pads': [[ref, 'smd', '1'], [ref, 'smd', '2']]}


def problem(units):
    sink = part('R9', 20.0, 20.0, (11, 12))  # the far end of nets 11 and 12 (they must leave U1)
    sink2 = part('R8', 22.0, 20.0, (13, 99))
    return {'units': [ic_unit(10.0, 10.0)] + units + [sink, sink2], 'nets': [],
            'board': {'outline': [[0, 0], [30, 0], [30, 30], [0, 30]], 'keepouts': [], 'edge_clearance': 0.0},
            'escape_rules': dict(RULES)}


class RepairTest(unittest.TestCase):
    def test_proposals_move_the_unit_that_walls_in_the_failed_pin(self):
        pr = problem([wall('C1', 10.0, 11.8)])
        fails = [dict(kind='unconnected', type='unconnected',
                      items=[dict(ref='U1', pad='2', net='N12', point=(10.0, 10.6)),
                             dict(ref='R9', pad='2', net='N12', point=(20.5, 20.0))])]
        m = escape.Model(pr)
        self.assertEqual(repair.failed_pins(pr, fails, m), [(0, 1)])
        self.assertIn(1, repair.corridor_blockers(pr, cost.initial_pose(pr), m, [(0, 1)]))
        props = repair.escape_proposals(pr, cost.initial_pose(pr), fails, rotate=False)
        self.assertTrue(props)
        self.assertTrue(all(c['kind'] == 'escape' and c['term'] < c['term0'] for c in props))
        self.assertEqual(props[0]['term'], 0.0)

    def test_no_failed_pin_no_proposal(self):
        pr = problem([])
        fails = [dict(kind='unconnected', type='unconnected', items=[dict(ref='R9', pad='1', net='N', point=None)])]
        self.assertEqual(repair.escape_proposals(pr, cost.initial_pose(pr), fails), [])

    def test_alternate_merges_without_duplicates(self):
        a = [dict(unit=1, x=0, y=0, r=0), dict(unit=2, x=0, y=0, r=0)]
        b = [dict(unit=1, x=0, y=0, r=0), dict(unit=3, x=1, y=0, r=0)]
        self.assertEqual([c['unit'] for c in repair.alternate(a, b)], [1, 2, 3])


class RouterTokensTest(unittest.TestCase):
    def core(self, src):
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, 'src'))
        open(os.path.join(d, 'Cargo.toml'), 'w').write('[dependencies]\nserde = "1"\n')
        open(os.path.join(d, 'src', 'main.rs'), 'w').write(src)
        return d

    def test_single_thread_router_takes_two_tokens(self):
        self.assertEqual(iotroute_step.router_cpu(self.core('fn main() {}'), full=12), 2)

    def test_threaded_router_takes_the_full_budget(self):
        self.assertEqual(iotroute_step.router_cpu(self.core('use std::thread;'), full=12), 12)

    def test_unreadable_core_fails_safe(self):
        self.assertEqual(iotroute_step.router_cpu('/nonexistent/core', full=12), 12)

    def test_current_core(self):
        self.assertIn(iotroute_step.router_cpu(full=12), (2, 12))


if __name__ == '__main__':
    unittest.main()
