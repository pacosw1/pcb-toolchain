"""Pin-escape term (escape.py), its Evaluator integration, the escape-aware repair proposals and the router tokens."""
import math
import os
import random
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import anneal, batch_capabilities, cost, escape, iotroute_step, repair  # noqa: E402

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


try:
    import pcbnew  # noqa: F401  (repair.movable reads kicad_io)
    HAVE_PCBNEW = True
except ImportError:
    HAVE_PCBNEW = False


def problem(units):
    sink = part('R9', 20.0, 20.0, (11, 12))  # the far end of nets 11 and 12 (they must leave U1)
    sink2 = part('R8', 22.0, 20.0, (13, 99))
    return {'units': [ic_unit(10.0, 10.0)] + units + [sink, sink2], 'nets': [],
            'board': {'outline': [[0, 0], [30, 0], [30, 30], [0, 30]], 'keepouts': [], 'edge_clearance': 0.0},
            'escape_rules': dict(RULES)}


class GeometryTest(unittest.TestCase):
    def test_corridor_length_has_a_stated_source(self):
        rt, rv, L, t, rad = escape.geometry(RULES, 0.5)
        self.assertAlmostEqual(rt, 0.225)
        self.assertAlmostEqual(rv, 0.45)
        self.assertAlmostEqual(L, 0.15 + 0.3 + 2 * 0.75)  # n = ceil(0.75 / 0.5) = 2 staggered neighbour vias
        self.assertAlmostEqual(rad[-1], rv)
        self.assertLessEqual(max(b - a for a, b in zip(t, t[1:])), rt + 1e-9)  # samples keep the track radius
        self.assertAlmostEqual(escape.geometry(RULES, 1.27)[2], 0.45)  # pitch >= via pitch: one via in line

    def test_rules_from_problem_or_default_class(self):
        self.assertEqual(escape.rules({'escape_rules': RULES}), RULES)
        r = escape.rules({'route_rules': {'classes': {'Default': [0.2, 0.25]}}}, {'via_d': 0.5})
        self.assertEqual(r, {'track': 0.25, 'clearance': 0.2, 'via_d': 0.5})

    def test_pins_sides_pitch_need(self):
        pr = problem([])
        m = escape.Model(pr)
        q = m.pins[0]
        self.assertEqual(q['n'], 6)  # the exposed pad is not a pin
        sides = sorted(s for _, s in q['names'])
        self.assertEqual(sides, ['E', 'N', 'S', 'S', 'S', 'W'])
        self.assertEqual(list(q['need'][:3]), [1.0, 1.0, 1.0])
        self.assertEqual(list(q['need'][3:]), [0.0, 0.0, 0.0])  # no net
        self.assertIsNone(m.pins[1])  # a resistor is not an IC

    def test_turned_unit_turns_its_corridors(self):
        pr = problem([])
        m = escape.Model(pr)
        b0 = m.pin_boxes(0, (10.0, 10.0, 0))[0]
        b1 = m.pin_boxes(0, (10.0, 10.0, 1))[0]
        self.assertGreater(b0[3], 11.0)  # south pin: the corridor goes to +y
        self.assertGreater(b1[2], 11.0)  # r = 1 maps (x, y) -> (y, -x): south becomes east


class BlockedTest(unittest.TestCase):
    def test_free_pins_cost_nothing(self):
        self.assertEqual(escape.escape(problem([]), cost.initial_pose(problem([]))), (0.0, 0))

    def test_foreign_pad_in_front_blocks_and_partner_does_not(self):
        pr = problem([wall('C1', 10.0, 11.8)])  # a wide foreign pad right below the south pins
        d, h = escape.escape(pr, cost.initial_pose(pr))
        self.assertAlmostEqual(d, 3.0)
        self.assertEqual(h, 1)  # every south pin blocked
        rep = escape.report(pr, cost.initial_pose(pr))
        self.assertEqual(sorted(r['pad'] for r in rep), ['1', '2', '3'])
        pr2 = problem([wall('C1', 10.0, 11.8, net=11)])
        b2 = escape.unit_blocked(pr2, cost.initial_pose(pr2), escape.Model(pr2), 0)
        self.assertEqual(list(b2[:3]), [0.0, 1.0, 1.0])  # the partner pad of net 11 does not block pin 1

    def test_partner_within_reach_frees_the_pin(self):
        m = escape.Model(problem([]))
        pr = problem([part('C1', 9.75, 11.6, (11, 0)), part('C2', 10.4, 12.5, (5, 6))])
        b = escape.unit_blocked(pr, cost.initial_pose(pr), escape.Model(pr), 0)
        self.assertEqual(b[0], 0.0)  # pin 1 (net 11) has its partner pad 0.35 mm below its toe
        self.assertIsNotNone(m)

    def test_one_free_ray_is_enough(self):
        pr = problem([part('C1', 10.5, 12.3, (5, 6))])  # blocks the straight and the south-east rays of pin 3
        b = escape.unit_blocked(pr, cost.initial_pose(pr), escape.Model(pr), 0)
        self.assertEqual(b[2], 0.0)


class EvaluatorTest(unittest.TestCase):
    def pr(self):
        units = [wall('W1', 10.0, 16.0)] + [part('C%d' % k, 6.0 + 2.5 * k, 20.0, (5, 6)) for k in range(4)]
        return problem(units)

    def test_off_by_default(self):
        ev = cost.Evaluator(self.pr(), {})
        self.assertIsNone(ev.esc)
        self.assertEqual(ev.components()['escape'], 0.0)

    def test_incremental_equals_full(self):
        pr = self.pr()
        p = anneal.params_all({'w_esc': 20.0})
        ev = cost.Evaluator(pr, p)
        rng = random.Random(1)
        mv = [i for i in range(ev.n) if not ev.fixed[i]]
        for _ in range(300):
            i = rng.choice(mv)
            ev.propose([(i, 10.0 + rng.uniform(-2.5, 2.5), 12.0 + rng.uniform(-0.5, 2), rng.randrange(4))])
            ev.commit() if rng.random() < 0.5 else ev.revert()
        full = cost.components(pr, ev.pose(), p)
        self.assertAlmostEqual(ev.components()['escape'], full['escape'], places=9)
        self.assertAlmostEqual(ev.cost, cost.weighted(full, p), places=6)

    def test_move_into_the_corridor_costs(self):
        pr = self.pr()
        ev = cost.Evaluator(pr, {'w_esc': 20.0})
        self.assertEqual(ev.comp[8], 0.0)
        d = ev.propose([(1, 10.0, 11.8, 0)])
        self.assertGreater(ev.comp[8], 0.0)
        self.assertGreater(d, 0.0)
        ev.revert()
        self.assertEqual(ev.comp[8], 0.0)

    def test_hard_side_is_illegal_only_with_esc_hard(self):
        pr = problem([wall('C1', 10.0, 11.8)])
        soft = cost.Evaluator(pr, {'w_esc': 20.0})
        hard = cost.Evaluator(pr, {'w_esc': 20.0, 'esc_hard': 1})
        self.assertEqual(soft.legal_penalty(1), 0.0)
        self.assertGreaterEqual(hard.legal_penalty(1), 1.0)
        self.assertEqual(hard.legal_penalty_at(1, 10.0, 16.0, 0), 0.0)  # moved away: the rays are free

    def test_batch_rejects_the_term(self):
        with self.assertRaises(ValueError):
            batch_capabilities.check_cost({}, {'w_esc': 1.0})


class RepairTest(unittest.TestCase):
    @unittest.skipUnless(HAVE_PCBNEW, 'repair.movable needs pcbnew (KiCad Python)')
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
