"""Constraint and state-transition tests for placement/routing proposals.

All numerical dimensions below are synthetic test geometry, not design rules.
No KiCad installation or production-board edits are needed.
"""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from pcb_search.contracts import Problem, fingerprint
from pcb_search.patterns import Route, blockers, route_patterns
from pcb_search.placement import anchor_fingerprint, quench, screen_pose
from placer import cost


def routing_problem():
    return dict(schema='iot-lab.route-problem.v1', bounds=[0, 0, 10, 10],
                edge_clearance=.2, edge_source='synthetic fixture', layers=['F.Cu', 'B.Cu'],
                nets=[dict(name=n, width=.2, clearance=.2, layers=['F.Cu', 'B.Cu'],
                           source='synthetic fixture') for n in ('A', 'B')],
                obstacles=[], connections=[dict(name='a', net='A', start=[1, 5], end=[9, 5],
                                               layers=['F.Cu'])],
                pair_clearances=[], unsupported=[], inputs={'fixture': '0' * 64})


def obstacle(name, bounds, net='', layers=None, clearance=0):
    return dict(name=name, bounds=bounds, net=net, layers=layers or ['F.Cu'], clearance=clearance)


def placement_problem():
    return dict(units=[dict(name=n, refs=[n], fixed=fixed, x=x, y=5.,
                           rects=[[-.5, -.5, .5, .5, .2]])
                       for n, x, fixed in [('A', 2., True), ('B', 8., False)]],
                nets=[dict(name='N', weight=1., pins=[[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]])],
                board=dict(outline=[[0, 0], [10, 0], [10, 10], [0, 10]], keepouts=[], edge_clearance=.2),
                region=None)


PARAMS = dict(mask_cell=.1, rudy_cell=1., layers=2, pitch=.4, limit=.1)


class RouteContractTests(unittest.TestCase):
    def test_malformed_or_unsourced_rules_never_become_defaults(self):
        mutations = [lambda r: r.update(extra_rule=8), lambda r: r.update(layers='F.Cu'),
                     lambda r: r.update(obstacles={}), lambda r: r.update(inputs={}),
                     lambda r: r['nets'][0].update(width=True),
                     lambda r: r['nets'][0].update(clearance=float('nan')),
                     lambda r: r['nets'][0].update(source=''),
                     lambda r: r['nets'].append(copy.deepcopy(r['nets'][0])),
                     lambda r: r['connections'][0].update(layers=['In1.Cu']),
                     lambda r: r['connections'][0].update(net='missing'),
                     lambda r: r['connections'][0].update(start=None),
                     lambda r: r.update(pair_clearances=[dict(nets=['A', 'B'], clearance=1, source=True)])]
        for mutate in mutations:
            with self.subTest(mutation=mutations.index(mutate)):
                raw = routing_problem()
                mutate(raw)
                with self.assertRaises(ValueError):
                    Problem.read(raw)

    def test_clearance_pair_is_symmetric_and_cannot_weaken_other_rules(self):
        raw = routing_problem()
        raw['pair_clearances'] = [dict(nets=['A', 'B'], clearance=2., source='synthetic')]
        p = Problem.read(raw)
        self.assertEqual(p.gap('A', 'B'), p.gap('B', 'A'))
        self.assertEqual(p.gap('A', 'B'), 2.)
        raw['pair_clearances'][0]['clearance'] = .1
        self.assertEqual(Problem.read(raw).gap('A', 'B', .3), .3)

    def test_rule_and_input_changes_change_identity(self):
        raw = routing_problem()
        before = Problem.read(raw).identity
        raw['nets'][0]['width'] = .4
        self.assertNotEqual(before, Problem.read(raw).identity)
        before = Problem.read(raw).identity
        raw['inputs']['fixture'] = '1' * 64
        self.assertNotEqual(before, Problem.read(raw).identity)


class PatternTests(unittest.TestCase):
    def test_complete_proposal_is_deterministic_and_unqualified(self):
        p = Problem.read(routing_problem())
        first = route_patterns(p, budget_s=1)
        second = route_patterns(p, budget_s=1)
        self.assertEqual(first['routes'], second['routes'])
        self.assertEqual(first['unresolved'], [])
        self.assertEqual(first['routes'][0]['length_mm'], 8)
        self.assertFalse(first['qualified'])
        self.assertTrue(first['native_validation_required'])

    def test_actual_width_closes_channel_minimum_width_would_pass(self):
        raw = routing_problem()
        raw['obstacles'] = [obstacle('lower', [0, 0, 10, 4.5]),
                            obstacle('upper', [0, 5.5, 10, 10])]
        self.assertFalse(route_patterns(Problem.read(raw), budget_s=1)['unresolved'])
        raw['nets'][0]['width'] = .8
        result = route_patterns(Problem.read(raw), budget_s=1)
        self.assertFalse(result['routes'])
        self.assertEqual(set(result['unresolved'][0]['blockers']), {'lower', 'upper'})
        self.assertFalse(result['unresolved'][0]['unroutable_proven'])

    def test_layers_and_pair_rules_are_preserved(self):
        raw = routing_problem()
        raw['obstacles'] = [obstacle('B-pad', [4, 5.6, 6, 6.6], net='B')]
        self.assertFalse(route_patterns(Problem.read(raw), budget_s=1)['unresolved'])
        raw['pair_clearances'] = [dict(nets=['A', 'B'], clearance=1, source='synthetic')]
        self.assertTrue(route_patterns(Problem.read(raw), budget_s=1)['unresolved'])
        raw['connections'][0]['layers'] = ['B.Cu']
        result = route_patterns(Problem.read(raw), budget_s=1)
        self.assertFalse(result['unresolved'])
        self.assertEqual(result['routes'][0]['layer'], 'B.Cu')

    def test_copper_kept_on_other_net_blocks_and_own_net_connects(self):
        raw = routing_problem()
        raw['obstacles'] = [obstacle('locked-trace-envelope', [4, 0, 6, 10], net='B')]
        before = fingerprint(raw)
        result = route_patterns(Problem.read(raw), budget_s=1)
        self.assertTrue(result['unresolved'])
        self.assertEqual(before, fingerprint(raw))
        raw['obstacles'][0]['net'] = 'A'
        self.assertFalse(route_patterns(Problem.read(raw), budget_s=1)['unresolved'])

    def test_generated_routes_cannot_short_each_other(self):
        raw = routing_problem()
        raw['connections'].append(dict(name='b', net='B', start=[5, 1], end=[5, 9], layers=['F.Cu']))
        result = route_patterns(Problem.read(raw), budget_s=1)
        self.assertEqual(len(result['routes']), 1)
        self.assertEqual(result['unresolved'][0]['blockers'], ['route:a'])
        raw['connections'][1]['layers'] = ['B.Cu']
        self.assertEqual(len(route_patterns(Problem.read(raw), budget_s=1)['routes']), 2)

    def test_edge_and_route_width_are_checked(self):
        p = Problem.read(routing_problem())
        self.assertEqual(blockers(p, Route('x', 'A', 'F.Cu', .2, ((.1, 5), (9, 5)))), ['board_edge'])
        with self.assertRaises(ValueError):
            blockers(p, Route('x', 'A', 'F.Cu', .1, ((1, 5), (9, 5))))

    def test_unsupported_constraints_abstain_before_search(self):
        raw = routing_problem()
        raw['unsupported'] = ['differential-pair skew constraint']
        result = route_patterns(Problem.read(raw), budget_s=1)
        self.assertEqual(result['status'], 'unsupported')
        self.assertEqual(result['attempts'], 0)
        self.assertFalse(result['routes'])

    def test_timeout_inside_geometry_never_accepts_half_checked_route(self):
        raw = routing_problem()
        raw['obstacles'] = [obstacle('far', [1, 1, 2, 2])]
        ticks = iter([0., 0., 0., 2., 2.])
        result = route_patterns(Problem.read(raw), budget_s=1, clock=lambda: next(ticks))
        self.assertEqual(result['status'], 'timeout')
        self.assertFalse(result['routes'])
        self.assertEqual(result['unresolved'][0]['reason'], 'budget')


class PlacementTests(unittest.TestCase):
    def test_bound_block_cannot_be_split_or_assigned_twice(self):
        pr = placement_problem()
        pr['block_bindings'] = [dict(unit='B', refs=['B'], binding_sha256='0'*64)]
        self.assertEqual(screen_pose(pr, cost.initial_pose(pr), PARAMS)['status'], 'candidate')
        pr['block_bindings'][0]['refs'] = ['A','B']
        self.assertEqual(screen_pose(pr, cost.initial_pose(pr), PARAMS)['status'], 'reject')
        pr['block_bindings'][0]['refs'] = ['B']
        pr['block_bindings'].append(copy.deepcopy(pr['block_bindings'][0]))
        self.assertEqual(screen_pose(pr, cost.initial_pose(pr), PARAMS)['status'], 'reject')

    def test_fixed_fixed_collision_is_not_hidden_by_search_objective(self):
        pr = placement_problem()
        pr['units'][1].update(fixed=True, x=2.)
        pose = cost.initial_pose(pr)
        self.assertEqual(cost.components(pr, pose, PARAMS)['overlap'], 0)
        report = screen_pose(pr, pose, PARAMS)
        self.assertEqual(report['status'], 'needs_native_check')
        self.assertIn('overlap', report['geometry_conflicts'])
        self.assertFalse(report['qualified'])

    def test_fixed_move_and_out_of_bounds_rejected(self):
        pr = placement_problem()
        pose = cost.initial_pose(pr)
        pose[0] = (3., 5., 0)
        self.assertIn('fixed unit moved: A', screen_pose(pr, pose, PARAMS)['errors'])
        pose = cost.initial_pose(pr)
        pose[1] = (11., 5., 0)
        self.assertIn('oob', screen_pose(pr, pose, PARAMS)['geometry_conflicts'])
        pose[1] = (8., 5., 45)
        with self.assertRaisesRegex(ValueError, 'pose'):
            screen_pose(pr, pose, PARAMS)

    def test_derived_copper_must_follow_owner_and_local_geometry(self):
        pr = placement_problem()
        pose = cost.initial_pose(pr)
        attachment = dict(id='B-fanout', owners=['B'], geometry_sha256='0' * 64,
                          anchor_sha256=anchor_fingerprint(pr, pose, ['B']))
        self.assertEqual(screen_pose(pr, pose, PARAMS, attachments=[attachment])['status'], 'candidate')
        pose[1] = (7., 5., 0)
        report = screen_pose(pr, pose, PARAMS, attachments=[attachment])
        self.assertEqual(report['status'], 'needs_regeneration')
        self.assertEqual(report['stale_attachments'], ['B-fanout'])
        pr['units'][1]['rects'][0][0] = -.6
        self.assertEqual(screen_pose(pr, cost.initial_pose(pr), PARAMS, attachments=[attachment])['status'],
                         'needs_regeneration')

    def test_movement_rotation_and_part_region_constraints(self):
        pr = placement_problem()
        pr['move_box'] = [6, 4, 9, 6]
        pr['part_rules'] = {'regions': [{'refs': ['B'], 'box': [7, 4, 9, 6]}]}
        pose = cost.initial_pose(pr)
        pose[1] = (5., 5., 0)
        report = screen_pose(pr, pose, dict(PARAMS, max_displacement=2))
        self.assertIn('movement region: B', report['errors'])
        self.assertIn('displacement cap: B', report['errors'])
        self.assertIn('part rule: B', report['errors'])
        pr['units'][1]['rotate'] = False
        pose[1] = (8., 5., 1)
        self.assertIn('unit rotation forbidden: B', screen_pose(pr, pose, PARAMS)['errors'])

    def test_unknown_part_rule_or_mains_request_abstains(self):
        pr = placement_problem()
        pr['part_rules'] = {'a_future_rule': []}
        self.assertEqual(screen_pose(pr, cost.initial_pose(pr), PARAMS)['status'], 'unknown')
        pr.pop('part_rules')
        self.assertEqual(screen_pose(pr, cost.initial_pose(pr), dict(PARAMS, mains=1))['status'], 'unknown')

    def test_quench_improves_wirelength_and_preserves_fixed_unit(self):
        pr = placement_problem()
        before = fingerprint(pr)
        result = quench(pr, steps_mm=[1.], budget_s=2, params=PARAMS)
        self.assertEqual(result['status'], 'candidate')
        self.assertEqual(result['pose'][0], [2., 5., 0])
        self.assertEqual(result['pose'][1], [7., 5., 0])
        self.assertLess(result['final']['components']['hpwl'], result['initial']['components']['hpwl'])
        self.assertFalse(result['qualified'])
        self.assertEqual(before, fingerprint(pr))

    def test_quench_cannot_move_part_with_stale_fanout(self):
        pr = placement_problem()
        attachment = dict(id='fanout', owners=['B'], geometry_sha256='0' * 64,
                          anchor_sha256=anchor_fingerprint(pr, cost.initial_pose(pr), ['B']))
        result = quench(pr, steps_mm=[1.], budget_s=2, params=PARAMS, attachments=[attachment])
        self.assertFalse(result['moves'])
        self.assertEqual(result['pose'][1], [8., 5., 0])

    def test_unsupported_placement_rules_do_not_enter_optimizer(self):
        pr = placement_problem()
        pr['dru_ignored'] = ['unrepresented rule']
        result = quench(pr, steps_mm=[1.], budget_s=1, params=PARAMS)
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['evaluated'], 1)
        self.assertFalse(result['moves'])

    def test_timeout_during_initial_screen_never_enters_search(self):
        ticks = iter([0., 2., 2.])
        result = quench(placement_problem(), steps_mm=[1.], budget_s=1, params=PARAMS,
                        clock=lambda: next(ticks))
        self.assertEqual(result['status'], 'timeout')
        self.assertEqual(result['evaluated'], 1)
        self.assertFalse(result['moves'])


class CLITests(unittest.TestCase):
    def test_new_output_partial_route_exit_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, dst = Path(tmp) / 'input.json', Path(tmp) / 'output.json'
            raw = routing_problem()
            raw['obstacles'] = [obstacle('wall', [4, 0, 6, 10])]
            src.write_text(json.dumps(raw))
            original = src.read_bytes()
            cmd = [sys.executable, '-m', 'pcb_search', 'route', str(src), '--output', str(dst), '--budget-s', '1']
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 3, result.stderr)
            self.assertIn('STUCK:', result.stdout)
            self.assertFalse(json.loads(dst.read_text())['qualified'])
            self.assertEqual(src.read_bytes(), original)
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 2)
            self.assertIn('output must be new', result.stderr)


if __name__ == '__main__':
    unittest.main()
