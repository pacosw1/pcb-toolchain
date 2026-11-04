#!/usr/bin/env python3
"""What is left of the Python cost tests: the rest moved to tools/placer/core/tests. Kept here: the helpers other test
files import, the option parsers of cli.py, and the rules that the Rust evaluator does not have (part_rules, the check
of pad_copper_layers). Needs numpy, no pcbnew.

  $PY -m unittest discover -s tools/placer -p 'test_*.py'
  ($PY = the KiCad bundled Python; it has numpy and pcbnew.)
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import cost  # noqa: E402


def unit(name, x, y, rects, fixed=False):
    return {'name': name, 'refs': [name], 'fixed': fixed, 'x': x, 'y': y, 'rects': rects}


def square_board(size=10.0, edge=0.0, keepouts=()):
    return {'outline': [[0, 0], [size, 0], [size, size], [0, size]],
            'keepouts': [list(k) for k in keepouts], 'edge_clearance': edge}


def problem(units, nets, board=None, region=None):
    return {'units': units, 'nets': nets, 'board': board or square_board(), 'region': region}


P = {'rudy_cell': 1.0, 'mask_cell': 0.25, 'layers': 1, 'pitch': 1.0, 'limit': 0.5,
     'w_wl': 1.0, 'w_cong': 1.0, 'w_ov': 1.0, 'w_oob': 1.0}


def random_problem(rng, n=8, nets=10):
    units = []
    for i in range(n):
        w, h = rng.uniform(.5, 3), rng.uniform(.5, 3)
        rects = [[-w / 2, -h / 2, w / 2, h / 2, rng.choice([.5, 1.0])]]
        if i % 3 == 0:
            rects.append([w / 2, -h / 2, w / 2 + 1, h / 2, .5])
        units.append(unit('U%d' % i, rng.uniform(0, 20), rng.uniform(0, 20), rects, fixed=(i == 0)))
        if i % 3 == 0:
            units[-1]['hard'] = [1]
        units[-1]['pads'] = [[rng.uniform(-w / 2, w / 2), rng.uniform(-h / 2, h / 2)] for _ in range(rng.randint(0, 6))]
    ns = []
    for j in range(nets):
        us = rng.sample(range(n), rng.randint(2, 4))
        ns.append({'name': 'N%d' % j, 'weight': rng.choice([1.0, 2.0]),
                   'pins': [[u, rng.uniform(-1, 1), rng.uniform(-1, 1), 0, 0] for u in us]})
        for p in ns[-1]['pins']:
            p[3], p[4] = p[1] + .2, p[2] + .1
    return problem(units, ns, board=square_board(20, edge=1.0, keepouts=[[[8, 8], [12, 8], [12, 12], [8, 12]]]),
                   region={'box': [0, 0, 10, 10], 'weight': 2.0, 'refs': []})


class CliParseTest(unittest.TestCase):
    def test_parse_edges_inset_and_tol(self):
        from placer import cli
        self.assertEqual(cli.parse_edges(['J1=TB:S']), {'J1': ('TB', 'S')})
        self.assertEqual(cli.parse_edges(['J2=B:S:0']), {'J2': ('B', 'S', 0.0, 0.05)})
        self.assertEqual(cli.parse_edges(['J4=R:E:0.2:0.1']), {'J4': ('R', 'E', 0.2, 0.1)})
        for bad in ('J2=B:S:x', 'J2=B:S:-1', 'J2=B:S:0:0:0', 'J2=Q:S'):
            with self.assertRaises(SystemExit):
                cli.parse_edges([bad])

    def test_parse_near(self):
        from placer import cli
        self.assertEqual(cli.parse_near(['D1.1=J1.1:7', 'U2.A1=J1.3:5.5']),
                         [('D1', '1', 'J1', '1', 7.0), ('U2', 'A1', 'J1', '3', 5.5)])
        for bad in ('D1.1=J1.1', 'D1=J1.1:7', 'D1.1=J1.1:x'):
            with self.assertRaises(SystemExit):
                cli.parse_near([bad])

    def test_domain_option_gives_pattern_gap_and_class_gap(self):
        from placer import cli
        self.assertEqual(cli.parse_domains(['MAINS_K*:8:3']), [('MAINS_K*', 8.0, 3.0)])
        with self.assertRaises(SystemExit):
            cli.parse_domains(['MAINS_K*:8'])


class PartRuleTest(unittest.TestCase):
    """pr['part_rules']: regions [{refs, box}] (the part centre must be in the box) and min_dist [{a, b, d}]
    (each part centre of a keeps d mm or more to each part centre of b). u['centres'] = {ref: local point at
    r = 0}; without it the centre is the unit origin. The miss in mm is illegal (legal_penalty), not a cost."""

    def pr(self):
        h = unit('H', 5.0, 5.0, [[-1, -1, 1, 1, 0.0]])
        h['refs'], h['centres'] = ['U1', 'C1'], {'U1': [0.0, 0.0], 'C1': [2.0, 0.0]}
        b = unit('B', 25.0, 5.0, [[-1, -1, 1, 1, 0.0]])
        b['refs'] = ['R1']
        pr = problem([h, b], [], square_board(40.0))
        pr['part_rules'] = {'regions': [{'refs': ['U1'], 'box': [0, 0, 40, 10]}],
                            'min_dist': [{'a': ['U1', 'C1'], 'b': ['R1'], 'd': 20.0}]}
        return pr

    def test_a_legal_pose_has_no_miss(self):
        pr = self.pr()
        self.assertAlmostEqual(cost.rule_miss(pr, [(5.0, 5.0, 0), (28.0, 5.0, 0)], 0), 0.0)
        self.assertAlmostEqual(cost.rule_miss(pr, [(5.0, 5.0, 0), (28.0, 5.0, 0)], 1), 0.0)

    def test_region_miss_is_the_distance_out_of_the_box(self):
        pr = self.pr()
        self.assertAlmostEqual(cost.rule_miss(pr, [(5.0, 13.0, 0), (28.0, 13.0, 0)], 0), 3.0)

    def test_min_dist_miss_counts_for_both_units_and_uses_the_part_centre(self):
        pr = self.pr()
        pose = [(5.0, 5.0, 0), (22.0, 5.0, 0)]  # C1 at x 7: 15 mm to R1 (5 short); U1 at x 5: 17 mm (3 short)
        self.assertAlmostEqual(cost.rule_miss(pr, pose, 0), 8.0)
        self.assertAlmostEqual(cost.rule_miss(pr, pose, 1), 8.0)

    def test_turned_unit_turns_its_part_centres(self):
        pr = self.pr()
        pose = [(5.0, 5.0, 2), (22.0, 5.0, 0)]  # r = 2 puts C1 at x 3: 19 mm (1 short); U1: 17 mm (3 short)
        self.assertAlmostEqual(cost.rule_miss(pr, pose, 0), 4.0)

    def test_legal_penalty_holds_the_miss(self):
        pr = self.pr()
        ev = cost.Evaluator(pr, P, pose=[(5.0, 5.0, 0), (22.0, 5.0, 0)])
        self.assertAlmostEqual(ev.legal_penalty(1), 8.0)
        self.assertAlmostEqual(ev.legal_penalty_at(1, 30.0, 5.0, 0), 0.0)


class PadLayerCheckTest(unittest.TestCase):
    def layered(self):
        u = unit('TP7', 113., 101.7, [[-1.75, -1.75, 1.75, 1.75, 0.]])
        u['pad_rects'] = [[-1.25, -1.25, 1.25, 1.25]]
        u['pad_copper_layers'] = [['F.Cu']]
        row = ['B.Cu', 114.6, 100.95, 111., 100.95, .2]
        return problem([u], [], dict(square_board(150.), fixed_copper=[row], fixed_copper_layers=[row]))

    def test_layer_metadata_must_align_with_pad_boxes(self):
        pr = self.layered()
        pr['units'][0]['pad_copper_layers'] = []
        with self.assertRaisesRegex(ValueError, 'align'):
            cost.Evaluator(pr, P)

    def test_malformed_membership_is_rejected(self):
        for layers in ('B.Cu', ['B.Cu', 'B.Cu'], ['B.Mask'], ['Foo.Cu'], ['In63.Cu']):
            pr = self.layered()
            pr['units'][0]['pad_copper_layers'] = [layers]
            with self.assertRaisesRegex(ValueError, 'distinct copper'):
                cost.Evaluator(pr, P)


if __name__ == '__main__':
    unittest.main()
