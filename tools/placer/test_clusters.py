#!/usr/bin/env python3
"""Soft clusters: the search side (anneal.py, membership.cluster_model). The proposer has clusters.test.mjs.

  $PY -m unittest tools/placer/test_clusters.py
"""
import hashlib
import math
import os
import random
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import anneal, batch_capabilities, cli, cost, membership  # noqa: E402
from placer.test_anneal import chain  # noqa: E402
from placer.test_cost import problem, square_board, unit  # noqa: E402

P = {'rudy_cell': 1.0, 'mask_cell': 0.25, 'layers': 2, 'pitch': 0.4, 'limit': 1.0, 'grid': 0.05}
CAP = [[-.5, -.25, .5, .25, .5]]
IC = [[-2, -2, 2, 2, 1.0]]


def tie(ref, to, pad='1', to_pad='1'):
    return {'ref': ref, 'pad': pad, 'to': to, 'to_pad': to_pad, 'net': 'N', 'rule': 'decap', 'why': 'test'}


def proposal(anchor, ties):
    return {'clusters': [{'name': anchor, 'anchor': anchor, 'why': 'test', 'ties': ties}]}


def clustered(units, ties, anchor='U1', nets=(), board=None, weight=4.0, pad=(-.5, 0), pin=(2, 0)):
    """A problem with one cluster; each tie goes from the pad offset `pad` to the pin offset `pin`."""
    member = {r: i for i, u in enumerate(units) for r in u['refs']}
    at = lambda ref, num, net: list(pin) if num == 'pin' else list(pad)  # noqa: E731
    soft, cnets = membership.cluster_model(units, member, proposal(anchor, ties), at, weight)
    pr = problem(units, list(nets) + cnets, board=board or square_board(40, edge=1.0))
    pr['clusters'] = soft
    return pr


def ic_and_caps(n=3, x=20.0, y=20.0, spread=0.0, board=None):
    us = [unit('U1', x, y, IC)]
    ties = []
    for k in range(n):
        us.append(unit('C%d' % k, x + 3.5 + spread, y - 1.5 + 1.5 * k, CAP))
        ties.append(tie('C%d' % k, 'U1', to_pad='pin'))
    return clustered(us, ties, board=board)


class ClusterModelTest(unittest.TestCase):
    def test_each_tie_is_a_two_pin_cohesion_net_with_no_wire_demand(self):
        pr = ic_and_caps(2)
        nets = [n for n in pr['nets'] if n['name'].startswith('~cluster:')]
        self.assertEqual(len(nets), 2)
        for n in nets:
            self.assertTrue(n['cohesion'])
            self.assertEqual(n['weight'], 4.0)
            self.assertEqual(cost.track_factor(n, cost.params_with_defaults({})), 0.0)
            self.assertEqual([q[0] for q in n['pins']][1], 0)

    def test_a_tie_inside_one_unit_or_between_fixed_units_has_no_net(self):
        us = [unit('U1', 5, 5, IC, fixed=True), unit('J1', 15, 5, IC, fixed=True), unit('C1', 25, 5, CAP)]
        us[2]['refs'] = ['C1', 'C2']  # a rigid unit of two parts
        member = {'U1': 0, 'J1': 1, 'C1': 2, 'C2': 2}
        at = lambda ref, num, net: [0.0, 0.0]  # noqa: E731
        p = {'clusters': [{'name': 'U1', 'anchor': 'U1', 'why': 'w', 'ties': [tie('J1', 'U1'), tie('C2', 'C1')]}]}
        soft, nets = membership.cluster_model(us, member, p, at, 4.0)
        self.assertEqual(nets, [])
        self.assertEqual(soft[0]['ties'], [])

    def test_a_proposal_changes_no_unit(self):
        us = [unit('U1', 5, 5, IC, fixed=True), unit('C0', 25, 5, CAP)]
        before = repr(us)
        membership.cluster_model(us, {'U1': 0, 'C0': 1}, proposal('U1', [tie('C0', 'U1')]), lambda r, n, net: [0.0, 0.0], 4.0)
        self.assertEqual(repr(us), before)

    def test_clusters_that_meet_in_a_unit_merge(self):
        us = [unit('U1', 5, 5, IC), unit('U2', 15, 5, IC), unit('C1', 25, 5, CAP)]
        us[2]['refs'] = ['C1', 'C2']
        member = {'U1': 0, 'U2': 1, 'C1': 2, 'C2': 2}
        p = {'clusters': [{'name': 'U1', 'anchor': 'U1', 'why': 'a', 'ties': [tie('C1', 'U1')]},
                          {'name': 'U2', 'anchor': 'U2', 'why': 'b', 'ties': [tie('C2', 'U2')]}]}
        soft, _ = membership.cluster_model(us, member, p, lambda r, n, net: [0.0, 0.0], 4.0)
        self.assertEqual(len(soft), 1)
        self.assertEqual(soft[0]['units'], [0, 1, 2])

    def test_a_stale_end_stops_the_read(self):
        def at(ref, num, net):
            raise ValueError('stale cluster proposal: %s pad %s is not on %s' % (ref, num, net))
        with self.assertRaisesRegex(ValueError, 'stale cluster proposal: C0 pad 1 is not on N'):
            membership.cluster_model([unit('U1', 5, 5, IC), unit('C0', 15, 5, CAP)], {'U1': 0, 'C0': 1},
                                     proposal('U1', [tie('C0', 'U1')]), at, 4.0)

    def test_a_part_that_is_not_on_the_board_stops(self):
        with self.assertRaisesRegex(ValueError, 'not on the board: C9'):
            membership.cluster_model([unit('U1', 5, 5, IC)], {'U1': 0}, proposal('U1', [tie('C9', 'U1')]),
                                     lambda r, n, net: [0.0, 0.0], 4.0)


class LoadTest(unittest.TestCase):
    def test_the_default_reads_no_clusters(self):
        self.assertIsNone(cli.load_clusters(None, 'board'))

    def test_a_file_must_be_a_proposal(self):
        with tempfile.NamedTemporaryFile('w', suffix='.json') as f:
            f.write('{"clusters": []}')
            f.flush()
            with self.assertRaisesRegex(ValueError, 'not a cluster proposal'):
                cli.load_clusters(f.name, 'board')


class NoClustersTest(unittest.TestCase):
    def test_a_problem_without_clusters_draws_the_same_moves_as_before(self):
        # The hash comes from origin/main at 92ccfd0, before clusters: no new random draw on this path.
        pr = chain()
        ev = cost.Evaluator(pr, {'mask_cell': 0.25})
        mover = anneal.Mover(pr, ev, {})
        rng = random.Random(5)
        out = []
        for _ in range(500):
            moves, kind = mover.propose(rng, 4.0)
            out.append((kind, [(i, round(x, 6), round(y, 6), r) for i, x, y, r in moves]))
        self.assertEqual(hashlib.sha256(repr(out).encode()).hexdigest(),
                         '0a67e476dbd762420d8298fa94225811649ab2e458e7a9feb532cc1f3c2cb34a')

    def test_an_empty_cluster_list_and_no_list_give_one_result(self):
        pr = chain()
        a = anneal.optimize(pr, P, workers=1, epochs=2, steps=300, seed=3, top=1)
        b = anneal.optimize(dict(pr, clusters=[]), P, workers=1, epochs=2, steps=300, seed=3, top=1)
        self.assertEqual(a['candidates'][0]['pose'], b['candidates'][0]['pose'])
        self.assertEqual(a['params'], b['params'])
        self.assertNotIn('clu_phase', a['params'])

    def test_the_batch_path_refuses_clusters(self):
        with self.assertRaisesRegex(ValueError, 'soft clusters'):
            batch_capabilities.check_search(ic_and_caps(), {})


class GroupMoveTest(unittest.TestCase):
    def mover(self, pr, **q):
        ev = cost.Evaluator(pr, P)
        return ev, anneal.Mover(pr, ev, dict(P, **q))

    def test_a_group_keeps_the_relative_places_of_its_units(self):
        pr = ic_and_caps(3)
        ev, m = self.mover(pr)
        rng = random.Random(1)
        seen = set()
        for _ in range(200):
            moves, kind = m.propose(rng, 5.0)
            self.assertEqual(kind, 'group')  # first phase: nothing else is left to move
            self.assertEqual(sorted(q[0] for q in moves), [0, 1, 2, 3])
            turn = (moves[0][3] - ev.R[moves[0][0]]) % 4
            seen.add(turn)
            base = {q[0]: q for q in moves}
            for i, x, y, r in moves:
                dx, dy = cost.rot_pt(ev.X[i] - ev.X[0], ev.Y[i] - ev.Y[0], turn)
                self.assertAlmostEqual(x - base[0][1], dx)
                self.assertAlmostEqual(y - base[0][2], dy)
                self.assertEqual(r, (ev.R[i] + turn) % 4)
        self.assertGreater(len(seen), 1)

    def test_the_incremental_cost_of_a_group_move_is_exact(self):
        pr = ic_and_caps(3)
        pr['units'].append(unit('X', 26, 21, CAP))
        ev, m = self.mover(pr)
        rng = random.Random(2)
        for _ in range(80):
            d = anneal._step(ev, m.propose(rng, 6.0))[0]
            if d > 0:
                ev.revert()
            else:
                ev.commit()
            self.assertAlmostEqual(ev.cost, cost.total(pr, ev.pose(), ev.p), places=6)

    def test_a_held_part_never_moves_with_the_cluster(self):
        for key, value in (('fixed', True), ('edge', {'at': [0, 0], 'sides': 'L'}), ('in_box', [0, 0, 40, 40]),
                           ('near', [[0, 0, 5, 5, 3]]), ('refs', ['J1']), ('refs', ['SW1']), ('refs', ['TP3'])):
            pr = ic_and_caps(3)
            pr['units'][1][key] = value
            pr['clusters'][0]['units'] = [0, 1, 2, 3]
            ev, m = self.mover(pr)
            rng = random.Random(3)
            for _ in range(100):
                moves, kind = m.propose(rng, 5.0)
                if kind == 'group':
                    self.assertNotIn(1, [q[0] for q in moves], key)

    def test_a_displacement_cap_turns_cluster_moves_off(self):
        pr = ic_and_caps(3)
        _, m = self.mover(pr, max_displacement=3)
        self.assertEqual(m.groups, [])

    def test_a_member_moves_alone_only_after_the_first_phase_and_only_a_little(self):
        pr = ic_and_caps(3)
        pr['units'].append(unit('X', 8, 8, CAP))
        ev, first = self.mover(pr, clu_free=False)
        ev2, second = self.mover(pr, clu_free=True, clu_local=2.0)
        r1, r2 = random.Random(4), random.Random(4)
        for _ in range(300):
            moves, kind = first.propose(r1, 15.0)
            if kind != 'group':
                self.assertEqual([q[0] for q in moves], [4])
            moves, kind = second.propose(r2, 15.0)
            if kind == 'translate' and moves[0][0] != 4:
                i, x, y, _ = moves[0]
                self.assertLessEqual(max(abs(x - ev2.X[i]), abs(y - ev2.Y[i])), 2.0 + 1e-9)

    def test_the_phase_comes_from_the_epoch(self):
        p = anneal.params_all(P)
        free = [anneal.epoch_params(p, e, 4)['clu_free'] for e in range(4)]
        self.assertEqual(free, [False, False, True, True])


class GatherTest(unittest.TestCase):
    def test_a_scattered_part_goes_next_to_its_pin_clear_of_the_cluster(self):
        pr = ic_and_caps(3, spread=12.0)
        p = anneal.params_all(P)
        pose = anneal.gather(pr, cost.initial_pose(pr), p)
        self.assertEqual(pose[0], (20.0, 20.0, 0))
        pin = (22.0, 20.0)
        for i in (1, 2, 3):
            self.assertLess(math.hypot(pose[i][0] - .5 - pin[0], pose[i][1] - pin[1]), anneal.CLU_REACH)
        self.assertEqual(cost.overlap(pr, pose), 0.0)
        self.assertEqual(cost.spacing(pr, pose), 0.0)

    def test_a_warm_start_keeps_its_places(self):
        pr = ic_and_caps(3)
        p = anneal.params_all(P)
        self.assertEqual(anneal.gather(pr, cost.initial_pose(pr), p), cost.initial_pose(pr))

    def test_a_held_part_stays(self):
        pr = ic_and_caps(2, spread=12.0)
        pr['units'][1]['fixed'] = True
        pose = anneal.gather(pr, cost.initial_pose(pr), anneal.params_all(P))
        self.assertEqual(pose[1], cost.initial_pose(pr)[1])

    def test_gather_keeps_a_part_inside_the_board(self):
        board = square_board(40, edge=1.0)
        pr = ic_and_caps(3, x=3.0, y=20.0, spread=12.0, board=board)  # the pin on the far side of the IC, at the left edge
        for t in pr['clusters'][0]['ties']:
            t['target'] = [-2, 0]
        pose = anneal.gather(pr, cost.initial_pose(pr), anneal.params_all(P))
        mask = cost.Mask(board, 0.25, 0.2)
        for u, q in zip(pr['units'][1:], pose[1:]):
            self.assertEqual(mask.edge_area(cost.world_rects(u, q)), 0.0)


class ScheduleTest(unittest.TestCase):
    def test_group_moves_do_not_raise_the_start_temperature(self):
        # RELAY-4: their big uphill deltas took T0 from 1050 to 3400, and a hot run ended illegal.
        pr = ic_and_caps(3)  # warm: gather changes nothing, so the two starts are one pose
        run = lambda q: anneal.optimize(q, P, workers=1, epochs=2, steps=20, seed=3, top=1)['t0']  # noqa: E731
        self.assertEqual(run(pr), run(dict(pr, clusters=None)))


class ConstraintTest(unittest.TestCase):
    """A proposal is advice: the pull may lose, a rule may not."""

    def run_search(self, pr, **q):
        return anneal.optimize(pr, dict(P, **q), workers=1, epochs=4, steps=1500, seed=2, top=1)['candidates'][0]

    def test_a_keepout_at_the_pin_wins_over_the_pull(self):
        ko = [[23, 15], [33, 15], [33, 25], [23, 25]]
        board = square_board(40, edge=1.0, keepouts=[ko])
        us = [unit('U1', 20, 20, IC, fixed=True), unit('C0', 8, 8, CAP)]
        pr = clustered(us, [tie('C0', 'U1', to_pad='pin')], board=board, pin=(6, 0))  # the pin point is in the keepout
        c = self.run_search(pr)
        self.assertEqual(c['illegal'], [])
        self.assertEqual(cost.Mask(board, 0.25, 0.2).edge_area(cost.world_rects(pr['units'][1], c['pose'][1])), 0.0)

    def test_a_fixed_part_stays_when_its_cluster_moves(self):
        pr = ic_and_caps(3, spread=8.0)
        pr['units'][1]['fixed'] = True
        before = cost.initial_pose(pr)[1]
        c = self.run_search(pr)
        self.assertEqual(tuple(c['pose'][1]), before)

    def test_a_reviewed_distance_rule_wins_over_the_pull(self):
        pr = ic_and_caps(1, spread=8.0)
        pr['part_rules'] = {'min_dist': [{'a': ['U1'], 'b': ['C0'], 'd': 8.0}]}
        c = self.run_search(pr)
        self.assertEqual(c['illegal'], [])
        self.assertGreaterEqual(math.hypot(c['pose'][0][0] - c['pose'][1][0], c['pose'][0][1] - c['pose'][1][1]), 8.0)

    def test_the_search_keeps_caps_at_the_pin_where_the_net_does_not_pull(self):
        def board(with_ties):
            pr = ic_and_caps(3, spread=10.0)
            pr['units'].append(unit('X', 35, 35, IC))
            rail = {'name': 'RAIL', 'weight': 1.0, 'pins': [[i, 0, 0, 0, 0] for i in range(5)]}
            if not with_ties:
                pr.pop('clusters')
                pr['nets'] = [rail]
            else:
                pr['nets'].append(rail)
            return pr
        far = lambda c: max(math.hypot(q[0] - c[0][0], q[1] - c[0][1]) for q in c[1:4])  # noqa: E731
        self.assertLess(far(self.run_search(board(True))['pose']), far(self.run_search(board(False))['pose']))


if __name__ == '__main__':
    unittest.main()
