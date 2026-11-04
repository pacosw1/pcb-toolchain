"""Constraint and state-transition tests for placement proposals.

All numerical dimensions below are synthetic test geometry, not design rules.
No KiCad installation or production-board edits are needed.
"""
import copy
import unittest

from pcb_search.contracts import fingerprint
from pcb_search.placement import anchor_fingerprint, quench, screen_pose
from placer import cost


def placement_problem():
    return dict(units=[dict(name=n, refs=[n], fixed=fixed, x=x, y=5.,
                           rects=[[-.5, -.5, .5, .5, .2]])
                       for n, x, fixed in [('A', 2., True), ('B', 8., False)]],
                nets=[dict(name='N', weight=1., pins=[[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]])],
                board=dict(outline=[[0, 0], [10, 0], [10, 10], [0, 10]], keepouts=[], edge_clearance=.2),
                region=None)


PARAMS = dict(mask_cell=.1, rudy_cell=1., layers=2, pitch=.4, limit=.1)


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

    def test_geometry_repair_precedes_wirelength_but_does_not_qualify(self):
        pr = placement_problem()
        pr['units'][1]['x'] = 2.
        before = fingerprint(pr)
        result = quench(pr, steps_mm=[1.], budget_s=2, params=PARAMS)
        self.assertEqual(result['initial']['status'], 'needs_native_check')
        self.assertEqual(result['status'], 'candidate')
        self.assertEqual(result['final']['components']['overlap'], 0)
        self.assertGreater(result['final']['components']['hpwl'], result['initial']['components']['hpwl'])
        self.assertEqual(result['pose'][0], [2., 5., 0])
        self.assertEqual(result['moves'][0]['phase'], 'geometry')
        self.assertFalse(result['qualified'])
        self.assertTrue(result['final']['native_validation_required'])
        self.assertEqual(before, fingerprint(pr))

    def test_unrepairable_geometry_cannot_be_reported_as_candidate(self):
        pr = placement_problem()
        pr['units'][1].update(x=2., fixed=True)
        result = quench(pr, steps_mm=[1.], budget_s=2, params=PARAMS)
        self.assertEqual(result['status'], 'needs_native_check')
        self.assertFalse(result['moves'])
        pr['units'][1]['fixed'] = False
        result = quench(pr, steps_mm=[1.], budget_s=2, params=dict(PARAMS, max_displacement=.1))
        self.assertEqual(result['status'], 'needs_native_check')
        self.assertFalse(result['moves'])

    def test_geometry_repair_cannot_leave_attached_copper_behind(self):
        pr = placement_problem()
        pr['units'][1]['x'] = 2.
        attachment = dict(id='fanout', owners=['B'], geometry_sha256='0'*64,
                          anchor_sha256=anchor_fingerprint(pr, cost.initial_pose(pr), ['B']))
        result = quench(pr, steps_mm=[1.], budget_s=2, params=PARAMS, attachments=[attachment])
        self.assertEqual(result['status'], 'needs_native_check')
        self.assertFalse(result['moves'])

    def test_edge_repair_cannot_trade_out_of_bounds_for_an_overlap(self):
        pr = placement_problem()
        pr['units'][0]['x'] = 9.2
        pr['units'][1]['x'] = 10.2
        result = quench(pr, steps_mm=[1.], budget_s=2, params=PARAMS)
        self.assertEqual(result['status'], 'needs_native_check')
        self.assertFalse(result['moves'])
        self.assertEqual(result['final']['components']['overlap'], 0)

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


if __name__ == '__main__':
    unittest.main()
