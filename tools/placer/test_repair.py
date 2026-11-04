"""Failure-driven repair (placer/repair.py): failures from DRC, candidates, legal improving moves, strict accept."""
import json
import math
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import cost, repair  # noqa: E402
from placer.test_cost import problem, square_board  # noqa: E402

GATE_OK = {'erc_errors': 0, 'erc_warnings': 3, 'drc_errors': 0, 'drc_parity': 0, 'drc_unconnected': 0,
           'drc_warnings': 9, 'planes_failures': 0, 'pairs_failures': 0, 'paths_low': 0, 'viapads': 0,
           'kicad_happy_findings': 0, 'port_label_failures': 0}


def part(name, x, y, fixed=False, pads=(('1', -0.5), ('2', 0.5))):
    """A 2-pad part 2 x 1 mm at (x, y) with pads on the x axis."""
    return {'name': name, 'refs': [name], 'fixed': fixed, 'x': x, 'y': y, 'rects': [[-1, -.5, 1, .5, .5]],
            'cu': [[px - .2, -.2, px + .2, .2, 1] for _, px in pads],
            'cu_pads': [[name, 'smd', num] for num, _ in pads]}


def board_problem():
    """U1 fixed at (10, 10); C1 6 mm east (its pad 1 is the open end); C2 next to U1; J1 a connector; C9 far."""
    return problem([part('U1', 10, 10, fixed=True), part('C1', 16, 10), part('C2', 10, 12.5),
                    part('J1', 12, 7.5), part('C9', 25, 25)], [], board=square_board(30, edge=0.5))


def drc(unconnected=(), errors=()):
    return {'violations': [dict(severity='error', type=t, items=items) for t, items in errors]
            + [dict(severity='warning', type='silk_overlap', items=[])],
            'unconnected_items': [dict(items=items) for items in unconnected], 'schematic_parity': []}


def pad_item(ref, num, net, x, y):
    return {'description': 'Pad %s [%s] of %s on F.Cu' % (num, net, ref), 'pos': {'x': x, 'y': y}}


OPEN = [pad_item('U1', '2', '/N', 10.5, 10), pad_item('C1', '1', '/N', 15.5, 10)]
THERMAL = [{'description': "Zone 'GND_F' [GND] on F.Cu, priority 0", 'pos': {'x': 100, 'y': 100}},
           pad_item('U1', '1', 'GND', 9.5, 10)]


class Failures(unittest.TestCase):
    def test_items_and_kinds(self):
        f = repair.parse_failures(drc([OPEN], [('starved_thermal', THERMAL)]))
        self.assertEqual([x['kind'] for x in f], ['drc', 'unconnected'])   # the warning is not a failure
        zone, pad = f[0]['items']
        self.assertIsNone(zone['point'])                 # a zone position is not a location
        self.assertEqual((pad['ref'], pad['pad'], pad['net'], pad['point']), ('U1', '1', 'GND', (9.5, 10.0)))
        self.assertEqual(repair.failure_nets(f), ['/N'])
        self.assertEqual(repair.failure_points(f), [(9.5, 10.0), (10.5, 10.0), (15.5, 10.0)])

    def test_track_item_net(self):
        it = repair.parse_item({'description': 'Track [/CH_LED0] on F.Cu, length 1.2 mm', 'pos': {'x': 1, 'y': 2}})
        self.assertEqual((it['net'], it['ref'], it['point']), ('/CH_LED0', None, (1.0, 2.0)))


class Term(unittest.TestCase):
    def test_open_distance_moves_with_the_pad(self):
        pr = board_problem()
        f = repair.parse_failures(drc([OPEN]))
        pose = cost.initial_pose(pr)
        self.assertAlmostEqual(repair.failure_term(pr, pose, f, 0.0), 5.0)   # cap 0: no room part
        pose[1] = (14, 10, 0)
        self.assertAlmostEqual(repair.failure_term(pr, pose, f, 0.0), 3.0)
        pose[1] = (14, 10, 2)                            # turned 180: pad 1 is now on the east side
        self.assertAlmostEqual(repair.failure_term(pr, pose, f, 0.0), 4.0)

    def test_cached_trial_equals_full_term(self):
        pr = board_problem()
        f = repair.parse_failures(drc([OPEN], [('starved_thermal', THERMAL)]))
        pose = cost.initial_pose(pr)
        tm = repair.Term(pr, pose, f, 5.0)
        for i, q in ((1, (14, 10, 1)), (2, (10, 14, 0)), (2, (8, 13, 3)), (1, (17, 11, 2))):
            trial = list(pose)
            trial[i] = q
            self.assertAlmostEqual(tm.value(i, q), repair.failure_term(pr, trial, f, 5.0))

    def test_room_grows_when_a_neighbour_moves_away(self):
        pr = board_problem()
        f = repair.parse_failures(drc((), [('starved_thermal', THERMAL)]))
        pose = cost.initial_pose(pr)
        t0 = repair.failure_term(pr, pose, f, 5.0)       # nearest other unit to U1.1: C2 (y 12..13)
        pose[2] = (10, 13.5, 0)
        self.assertLess(repair.failure_term(pr, pose, f, 5.0), t0)


class Candidates(unittest.TestCase):
    def test_near_movable_no_connector_no_fixed(self):
        pr = board_problem()
        f = repair.parse_failures(drc([OPEN], [('starved_thermal', THERMAL)]))
        names = [pr['units'][i]['name'] for i in repair.candidates(pr, cost.initial_pose(pr), f, 5.0)]
        self.assertEqual(names, ['C1', 'C2'])            # owner first; U1 fixed, J1 connector, C9 far

    def test_block_is_one_unit(self):
        pr = board_problem()
        blk = pr['units'][2]
        blk.update(name='BLK', refs=['C2', 'R2'], rects=[[-1, -.5, 1, .5, .5], [1.5, -.5, 3, .5, .5]])
        f = repair.parse_failures(drc((), [('starved_thermal', THERMAL)]))
        props = repair.proposals(pr, cost.initial_pose(pr), f)
        self.assertTrue(props)
        self.assertEqual({p['name'] for p in props}, {'BLK'})


class Proposals(unittest.TestCase):
    def setUp(self):
        self.pr = board_problem()
        self.f = repair.parse_failures(drc([OPEN], [('starved_thermal', THERMAL)]))
        self.pose = cost.initial_pose(self.pr)
        self.props = repair.proposals(self.pr, self.pose, self.f)

    def test_legal_improving_bounded(self):
        self.assertTrue(self.props)
        ev = cost.Evaluator(self.pr, {}, pose=self.pose)
        t0 = repair.failure_term(self.pr, self.pose, self.f, 5.0)
        for p in self.props:
            i = p['unit']
            self.assertFalse(self.pr['units'][i]['fixed'])
            self.assertNotEqual(self.pr['units'][i]['name'], 'J1')
            self.assertLessEqual(ev.legal_penalty_at(i, p['x'], p['y'], p['r']), 1e-9)
            self.assertLessEqual(math.hypot(p['x'] - self.pose[i][0], p['y'] - self.pose[i][1]), 5.0 + 1e-9)
            trial = list(self.pose)
            trial[i] = (p['x'], p['y'], p['r'])
            self.assertLess(repair.failure_term(self.pr, trial, self.f, 5.0), t0)

    def test_deterministic_and_round_robin(self):
        again = repair.proposals(self.pr, self.pose, self.f)
        self.assertEqual(self.props, again)
        first = [p['name'] for p in self.props[:2]]
        self.assertEqual(sorted(first), ['C1', 'C2'])    # one of each unit before the second of any

    def test_no_rotate(self):
        props = repair.proposals(self.pr, self.pose, self.f, rotate=False)
        self.assertTrue(props)
        self.assertTrue(all(p['r'] == 0 for p in props))


def summary(drc_part=0, gate=None, length=100.0, vias=10):
    run = dict(status='PASS' if drc_part == 0 else 'FAIL', drc_errors=0, unconnected=drc_part, parity=0,
               track_length_mm=length, vias=vias)
    return dict(run=run, gate_metrics=gate)


class Key(unittest.TestCase):
    def test_order(self):
        k = repair.score_key
        self.assertTrue(repair.better(k(summary(1)), k(summary(2))))
        self.assertTrue(repair.better(k(summary(0)), k(summary(1, length=1))))      # no gate yet: still better
        self.assertTrue(repair.better(k(summary(0, GATE_OK)), k(summary(0))))
        self.assertTrue(repair.better(k(summary(0, GATE_OK, 99.0)), k(summary(0, GATE_OK, 100.0))))
        self.assertFalse(repair.better(k(summary(1)), k(summary(1))))
        self.assertTrue(repair.passed(k(summary(0, GATE_OK))))
        self.assertFalse(repair.passed(k(summary(0, dict(GATE_OK, planes_failures=1)))))
        self.assertEqual(k({'run': {'status': 'ERROR'}})[0], repair.NO_RESULT)


class Loop(unittest.TestCase):
    """run() with injected effects: the router answers from a script of outcomes."""

    def go(self, outcomes, start=None, notes=None, **kw):
        tmp = tempfile.mkdtemp()
        pr = board_problem()
        calls = []
        extras = self.extras = []

        def fake_files(path, drc_report):
            os.makedirs(path + '.iotroute', exist_ok=True)
            open(path, 'w').write('board')
            json.dump(drc_report, open(path + '.iotroute/drc.json', 'w'))

        place, routed = os.path.join(tmp, 'p', 'X.kicad_pcb'), os.path.join(tmp, 'r', 'X.kicad_pcb')
        os.makedirs(os.path.dirname(place))
        os.makedirs(os.path.dirname(routed))
        open(place, 'w').write('board')
        fake_files(routed, start or drc([OPEN]))
        if notes is not None:
            json.dump({'notes': notes}, open(routed + '.iotroute/route.json', 'w'))

        def read_fn(path, out, args):
            return json.loads(json.dumps(pr))

        def write_fn(src, q, pose, out, side):
            os.makedirs(os.path.dirname(out), exist_ok=True)
            open(out, 'w').write('board')

        def route_fn(path, d, board, gate, iters, extra=()):
            s, report = outcomes[len(calls)]
            calls.append(path)
            extras.append(tuple(extra))
            out = os.path.join(d, 'route-0', os.path.basename(path))
            fake_files(out, report)
            return s, out

        rec = repair.run('X', place, routed, os.path.join(tmp, 'out'), route_fn=route_fn, read_fn=read_fn,
                         write_fn=write_fn, rip_fn=lambda *a: 0, gate=object(), log=lambda s: None,
                         start_summary=summary(1), **kw)
        return rec, calls

    def test_reaches_pass_and_stops(self):
        rec, calls = self.go([(summary(1, length=120.0), drc([OPEN])),     # not better (longer): rejected
                              (summary(0, GATE_OK), drc())], per_round=4)
        self.assertTrue(rec['passed'])
        self.assertEqual([a['accepted'] for a in rec['attempts']], [False, True])
        self.assertEqual(len(calls), 2)
        self.assertIn('score 0', rec['stop'])

    def test_keeps_previous_candidate_when_nothing_is_better(self):
        rec, calls = self.go([(summary(2), drc([OPEN, OPEN]))] * 3, per_round=3)
        self.assertFalse(rec['passed'])
        self.assertEqual(rec['best']['key'], list(repair.score_key(summary(1))))
        self.assertEqual(rec['best']['routed'], rec['start']['routed'])
        self.assertEqual(len(calls), 3)
        self.assertIn('no routed proposal is strictly better', rec['stop'])

    def test_reuse_mode_routes_the_moved_placement_from_the_present_route(self):
        rec, calls = self.go([(summary(1, length=90.0), drc([OPEN])), (summary(0, GATE_OK), drc())], per_round=1)
        self.assertEqual(rec['mode'], 'reuse')
        # each proposal: the moved placement board (PLACE + move), reuse from the routed board of the candidate
        self.assertTrue(all(c.endswith(os.path.join('place', 'X.kicad_pcb')) for c in calls))
        self.assertEqual(self.extras[0], ('--reuse', rec['start']['routed'], '--reuse-fallback', 'none'))
        self.assertEqual(self.extras[1], ('--reuse', rec['attempts'][0]['routed'], '--reuse-fallback', 'none'))
        rec, calls = self.go([(summary(0, GATE_OK), drc())], per_round=1, mode='local')
        self.assertEqual(self.extras, [()])

    def test_route_cap(self):
        rec, calls = self.go([(summary(1, length=90.0 - k), drc([OPEN])) for k in range(5)], max_routes=2,
                             per_round=1)
        self.assertEqual(len(calls), 2)
        self.assertIn('route cap 2', rec['stop'])
        self.assertEqual(len(rec['best']['moves']), 2)  # each strictly shorter route was accepted


WALL_NOTE = ('pour: U1.1 on F.Cu: 1 spoke(s) reach a connected pour piece, 0 reach an island (KiCad starved_thermal); '
             'fixed copper alone walls it in (input)')


class Walled(unittest.TestCase):
    def test_note_parse_and_split(self):
        self.assertEqual(repair.walled_pads([WALL_NOTE, 'VDD: neck 0.2 mm']), {('U1', '1')})
        pr = board_problem()
        f = repair.parse_failures(drc([OPEN], [('starved_thermal', THERMAL)]))
        keep, faults = repair.split_walled(f, {('U1', '1')}, pr)
        self.assertEqual([x['kind'] for x in keep], ['unconnected'])
        self.assertEqual([x['type'] for x in faults], ['starved_thermal'])
        pr['units'][0]['fixed'] = False                  # a movable pad unit is not an input fault
        self.assertEqual(len(repair.split_walled(f, {('U1', '1')}, pr)[1]), 0)

    def test_walled_only_stops_without_a_route(self):
        rec, calls = Loop.go(self, [], start=drc((), [('starved_thermal', THERMAL)]), notes=[WALL_NOTE])
        self.assertEqual(calls, [])
        self.assertIn('walled in by fixed input copper', rec['stop'])
        self.assertIn('U1.1', rec['stop'])


class LineBorders(unittest.TestCase):
    def test_four_lines_close_a_rectangle(self):
        try:
            from placer import kicad_io
        except ImportError:
            self.skipTest('needs pcbnew (KiCad Python)')
        rect = [(0, 0, 4, 0, 'a'), (4, 0, 4, 3, 'b'), (4, 3, 0, 3, 'c'), (0, 3, 0, 0, 'd')]
        self.assertEqual(kicad_io.line_rectangles(rect), [((0, 0, 4, 3), ['a', 'c', 'd', 'b'])])
        self.assertEqual(kicad_io.line_rectangles(rect[:3]), [])                  # open: not a border
        self.assertEqual(kicad_io.line_rectangles(rect + [(10, 10, 12, 10, 'e')]), [((0, 0, 4, 3), ['a', 'c', 'd', 'b'])])
        two = rect + [(4, 0, 9, 0, 'f'), (9, 0, 9, 3, 'g'), (9, 3, 4, 3, 'h')]   # a second box shares edge b
        self.assertEqual(sorted(b for b, _ in kicad_io.line_rectangles(two)), [(0, 0, 4, 3), (4, 0, 9, 3)])


class PadsBox(unittest.TestCase):
    def test_pads_beyond_the_courtyard_grow_the_part_rect(self):
        try:
            import pcbnew
            from placer import kicad_io
        except ImportError:
            self.skipTest('needs pcbnew (KiCad Python)')
        M = 1e6

        class Box:
            def __init__(self, x0, y0, x1, y1):
                self.b = (x0, y0, x1, y1)

            def GetX(self): return int(self.b[0] * M)
            def GetY(self): return int(self.b[1] * M)
            def GetRight(self): return int(self.b[2] * M)
            def GetBottom(self): return int(self.b[3] * M)

        class Pad:
            def __init__(self, box, attr):
                self.box, self.attr = box, attr

            def GetAttribute(self): return self.attr
            def GetBoundingBox(self): return self.box

        class Fp:
            def Pads(self):
                return [Pad(Box(106.85, 154.5, 108.15, 155.1), pcbnew.PAD_ATTRIB_SMD),    # J1 A1B12 (NET-CORE)
                        Pad(Box(90, 150, 91, 151), pcbnew.PAD_ATTRIB_NPTH)]               # a hole has no copper
        self.assertEqual(kicad_io.pads_box(Fp(), (99.89, 153.49, 107.33, 162.51)), (99.89, 153.49, 108.15, 162.51))


class Driver(unittest.TestCase):
    def test_compaction_options(self):
        from placer import compact_cli
        base = ['p.json', 'b.kicad_pcb', '--board-dir', 'hardware-design/boards/X', '--outdir', 'o', '--size', '1', '1']
        a = compact_cli.parser().parse_args(base + ['--router', 'iotroute', '--repair', '--repair-routes', '3'])
        self.assertEqual((a.repair, a.repair_mode, a.repair_routes, a.repair_per_round), (True, 'reuse', 3, 4))
        self.assertFalse(compact_cli.parser().parse_args(base).repair)
        with self.assertRaisesRegex(ValueError, 'needs --router iotroute'):
            compact_cli.main(base + ['--repair'])


if __name__ == '__main__':
    unittest.main()
