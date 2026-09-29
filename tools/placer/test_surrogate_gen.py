import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import surrogate_gen  # noqa: E402
from placer.test_surrogate_features import square_problem  # noqa: E402


def many_units():
    pr = square_problem()
    u = pr['units'][0]
    pr['units'] = [dict(u, name='U%d' % k, x=3.0 + k, y=10.0) for k in range(10)] + [pr['units'][1]]
    pr['nets'] = []
    return pr


class Perturb(unittest.TestCase):
    def test_same_seed_same_pose(self):
        pr = many_units()
        cfg = {'frac': 0.5, 'sigma': 2.0, 'p_turn': 0.3}
        self.assertEqual(surrogate_gen.perturb(pr, random.Random(4), cfg),
                         surrogate_gen.perturb(pr, random.Random(4), cfg))

    def test_fixed_units_stay(self):
        pr = many_units()
        pose = surrogate_gen.perturb(pr, random.Random(1), {'frac': 1.0, 'sigma': 5.0, 'p_turn': 1.0})
        self.assertEqual(pose[-1], (15.0, 15.0, 0))

    def test_moves_the_fraction(self):
        pr = many_units()
        pose = surrogate_gen.perturb(pr, random.Random(2), {'frac': 0.3, 'sigma': 3.0, 'p_turn': 0.0})
        moved = [k for k, u in enumerate(pr['units']) if (u['x'], u['y'], 0) != pose[k]]
        self.assertEqual(len(moved), 3)

    def test_at_least_one_unit_moves(self):
        pr = many_units()
        pose = surrogate_gen.perturb(pr, random.Random(2), {'frac': 0.01, 'sigma': 3.0, 'p_turn': 0.0})
        self.assertEqual(sum(1 for k, u in enumerate(pr['units']) if (u['x'], u['y'], 0) != pose[k]), 1)

    def test_stays_inside_the_board(self):
        pr = many_units()
        pose = surrogate_gen.perturb(pr, random.Random(3), {'frac': 1.0, 'sigma': 100.0, 'p_turn': 0.0})
        for x, y, _ in pose:
            self.assertTrue(0.0 <= x <= 20.0 and 0.0 <= y <= 20.0)

    def test_config_from_the_sets(self):
        rng = random.Random(5)
        for _ in range(50):
            c = surrogate_gen.sample_config(rng)
            self.assertIn(c['frac'], surrogate_gen.FRACS)
            self.assertIn(c['sigma'], surrogate_gen.SIGMAS)
            self.assertIn(c['p_turn'], surrogate_gen.TURNS)


    def test_retry_is_smaller(self):
        c = surrogate_gen.retry_config({'frac': 0.3, 'sigma': 8.0, 'p_turn': 0.3})
        self.assertEqual(c, {'frac': 0.15, 'sigma': 4.0, 'p_turn': 0.15})

    def test_cases_get_other_configs(self):
        a = [surrogate_gen.sample_config(surrogate_gen.case_rng('RELAY-4', s)) for s in range(20)]
        b = [surrogate_gen.sample_config(surrogate_gen.case_rng('IO-6X6', s)) for s in range(20)]
        self.assertNotEqual(a, b)
        self.assertEqual(a, [surrogate_gen.sample_config(surrogate_gen.case_rng('RELAY-4', s)) for s in range(20)])


class Prep(unittest.TestCase):
    def test_plane_nets_are_the_ground_nets(self):
        names = ['GND', '/FIELD_GND', 'FIELD_GND', 'PGND_ISO', '+3V3', '/GNDSENSE', 'VBUS', '']
        self.assertEqual(surrogate_gen.plane_nets(names), ['/FIELD_GND', 'FIELD_GND', 'GND', 'PGND_ISO'])


class Result(unittest.TestCase):
    def test_row_from_drc(self):
        drc = {'unconnected_items': [{'items': [{'description': 'Pad 1 [/A] of R1'}]},
                                     {'items': [{'description': 'Pad 2 [/B] of R2'}]}],
               'violations': [{'severity': 'error', 'type': 'clearance'}, {'severity': 'warning', 'type': 'x'}]}
        self.assertEqual(surrogate_gen.drc_row(drc), {'unrouted': 2, 'errors': 1, 'capped': False})

    def test_row_keeps_the_rich_labels(self):
        drc = {'unconnected_items': [{'items': [{'description': 'Pad 1 [/A] of R1'}]}] * 2,
               'violations': [{'severity': 'error', 'type': 'clearance'}] * 3}
        r = surrogate_gen.drc_row(drc, rich=True)
        self.assertEqual(r['open_nets'], {'/A': 2})
        self.assertEqual(r['error_types'], {'clearance': 3})

    def test_copper_stats(self):
        text = """(segment
\t\t(start 0 0)
\t\t(end 3 4)
\t\t(width 0.2)
\t)
\t(segment (start 1 1) (end 1 3) (width 0.2))
\t(via
\t\t(at 1 1)
\t)
\t(via (at 2 2))
\t(footprint "R" (at 5 5))"""
        self.assertEqual(surrogate_gen.copper_stats(text), {'vias': 2, 'track_mm': 7.0})

    def test_passes_in_the_router_log(self):
        log = "x Auto-router pass #1 on board\ny Auto-router pass #2 on board\nz Restoring an earlier board\n"
        self.assertEqual(surrogate_gen.router_passes(log), 2)
        self.assertEqual(surrogate_gen.router_passes(''), 0)

    def test_timeout_rule(self):
        # the router used the whole limit and left opens: a timeout (the count is an upper bound, not a low score)
        self.assertTrue(surrogate_gen.timed_out(89.0, 90, 5))
        self.assertFalse(surrogate_gen.timed_out(40.0, 90, 5))
        self.assertFalse(surrogate_gen.timed_out(89.5, 90, 0))

    def test_row_marks_the_499_cap(self):
        drc = {'unconnected_items': [{'items': [{'description': 'Pad 1 [/A] of R1'}]}] * 499, 'violations': []}
        self.assertTrue(surrogate_gen.drc_row(drc)['capped'])


if __name__ == '__main__':
    unittest.main()
