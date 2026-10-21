"""Engine contracts and recovery tests; no real CAD is adopted."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pcb_engine.backends import Blocked, move_proposals, strip_moved_nets, verify_movement
from pcb_engine.local_router import astar, route_srj
from pcb_engine.model import BoardState, Candidate, Finding, RuleContext, file_digest
from pcb_engine.policy import JobPolicy, validate_policy
from pcb_engine.search import _placement_compute, run_engine
from pcb_engine.session import Session, atomic_json


BOARD = '(kicad_pcb (version 20260101) (net 1 "N") (net 2 "OTHER"))'
SEGMENT = '(segment (start 1 1) (end 2 2) (width .2) (layer "F.Cu") (net 1) (uuid "seg-1"))'


def policy(**changes):
    value = dict(schema='iot-lab.engine-policy.v1', routing=dict(
        schema='iot-lab.routing-policy.v1', layers=['F.Cu', 'B.Cu'], only_nets=['N'],
        passes=2, threads=1, timeout_s=10, optimizer='off', max_repairs=0),
        max_attempts=2, movement=dict(refs=[], max_displacement_mm=0, step_mm=.5), compute='cpu')
    value.update(changes)
    return value


class FakeBackend:
    def __init__(self, folder, workspace, board, policy, timeout_s, **kwargs):
        self.folder, self.native = Path(folder), Path(workspace) / 'board.kicad_pcb'
        self.calls = 0

    def remaining(self):
        return 30

    def verify(self, directory):
        directory.mkdir(parents=True)
        complete = 'segment' in self.native.read_text()
        report = dict(exit=0 if complete else 1, metrics=dict(drc_errors=0, drc_parity=0,
                                                            drc_unconnected=0 if complete else 1))
        path = directory / 'result.json'
        atomic_json(path, report)
        return complete, report['metrics'], {str(path): file_digest(path)}

    def route(self, directory):
        self.calls += 1
        self.native.write_text(self.native.read_text()[:-1] + SEGMENT + ')')
        return {'controls_verified': True}, ()


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.workspace = self.root / 'workspace'
        self.workspace.mkdir()
        self.native = self.workspace / 'board.kicad_pcb'
        self.native.write_text(BOARD)
        self.rule = self.workspace / 'board.kicad_dru'
        self.rule.write_text('(version 1)')
        self.rules = RuleContext({str(self.rule): file_digest(self.rule)}, {}, str(self.workspace))
        self.policy = JobPolicy.parse(policy(), 30)

    def tearDown(self):
        self.temp.cleanup()

    def test_policy_rejects_implicit_movement_and_unknown_terms(self):
        for update in (dict(movement={'refs': ['R1'], 'max_displacement_mm': 0}),
                       dict(compute='neural-engine'), dict(runtime='magic'),
                       dict(max_attempts=True), dict(unrecognized=True)):
            with self.subTest(update=update), self.assertRaises(ValueError):
                validate_policy(policy(**update), 30)

    def test_policy_accepts_native_explicitly_and_preserves_rules(self):
        parsed = validate_policy(policy(runtime='native'), 30)
        self.assertEqual(parsed['runtime'], 'native')
        self.assertEqual(parsed['routing'], policy()['routing'])

    def test_model_paths_and_hash_are_required(self):
        for ranking in ({'model_path': '/tmp/model.json', 'model_sha256': '0'*64},
                        {'model_path': '../model.json', 'model_sha256': '0'*64},
                        {'model_path': 'model.json', 'model_sha256': 'bad'},
                        {'model_path': 'model.json', 'model_sha256': '0'*64, 'allow_experimental': 'yes'}):
            with self.subTest(ranking=ranking), self.assertRaises(ValueError):
                validate_policy(policy(ranking=ranking), 30)

    def test_transaction_rolls_back_exception_and_keeps_pending_through_state_updates(self):
        folder = self.root / 'session'
        with Session(folder, self.native, self.rules, self.policy) as session:
            session.transition('searching')
            with self.assertRaisesRegex(RuntimeError, 'failure'):
                with session.transaction('one'):
                    self.native.write_text('changed')
                    session.transition('verifying')
                    self.assertIsNotNone(json.loads((folder / 'state.json').read_text())['pending'])
                    raise RuntimeError('failure')
            self.assertEqual(self.native.read_text(), BOARD)
            self.assertIsNone(json.loads((folder / 'state.json').read_text())['pending'])

    def test_crash_recovery_restores_original_before_new_work(self):
        folder = self.root / 'session'
        with Session(folder, self.native, self.rules, self.policy) as session:
            backup = folder / 'rollback.kicad_pcb'
            backup.write_text(BOARD)
            session.pending = dict(backup=backup.name, sha256=file_digest(backup))
            self.native.write_text('interrupted geometry')
            session.persist()
        with Session(folder, self.native, self.rules, self.policy):
            self.assertEqual(self.native.read_text(), BOARD)

    def test_stale_rules_and_duplicate_attempts_stop(self):
        with Session(self.root / 'session', self.native, self.rules, self.policy) as session:
            self.assertIsNotNone(session.admit_attempt({'kind': 'route'}))
            self.assertIsNone(session.admit_attempt({'kind': 'route'}))
            self.rule.write_text('(version 2)')
            with self.assertRaisesRegex(ValueError, 'dependency changed'):
                session.admit_attempt({'kind': 'move'})

    def test_single_writer_and_transition_checks(self):
        folder = self.root / 'session'
        with Session(folder, self.native, self.rules, self.policy) as session:
            with self.assertRaises(BlockingIOError):
                with Session(folder, self.native, self.rules, self.policy):
                    pass
            with self.assertRaisesRegex(ValueError, 'invalid engine transition'):
                session.transition('complete')

    def test_verified_incumbent_cannot_be_displaced_by_better_proxy(self):
        with Session(self.root / 'session', self.native, self.rules, self.policy) as session:
            state = BoardState.capture('TEST', self.native, self.rules)
            good = Candidate('good', state, str(self.native), True,
                             {'drc_errors': 0, 'drc_unconnected': 0, 'track_length_mm': 100}, (), {}, {})
            partial = Candidate('partial', state, str(self.native), False,
                                {'drc_errors': 0, 'drc_unconnected': 0, 'track_length_mm': 1}, (), {}, {})
            session.record(good)
            session.record(partial)
            self.assertEqual(session.best.candidate_id, 'good')
            self.assertEqual(session.best_verified.candidate_id, 'good')

    def test_router_success_alone_never_certifies_candidate(self):
        result = run_engine(self.root, self.workspace, 'TEST', policy(), timeout_s=30,
                            backend_factory=FakeBackend)
        self.assertEqual(result['status'], 'candidate')
        self.assertFalse(result['candidate_verified'])
        self.assertTrue(result['improved'])
        self.assertTrue(result['native_and_board_specific_gates_required'])
        state = json.loads((self.root / 'operation/engine/state.json').read_text())
        self.assertEqual(state['phase'], 'complete')
        self.assertEqual(len(state['attempts']), 2)
        self.assertIn('segment', self.native.read_text())

    def test_failed_route_restores_and_retains_checked_baseline(self):
        class Failing(FakeBackend):
            def route(self, directory):
                self.native.write_text('corrupt')
                raise Blocked('controlled routing admission: missing runtime')
        result = run_engine(self.root, self.workspace, 'TEST', policy(max_attempts=1), timeout_s=30,
                            backend_factory=Failing)
        self.assertEqual(self.native.read_text(), BOARD)
        self.assertFalse(result['improved'])
        self.assertEqual(result['selected_strategy']['kind'], 'baseline')
        self.assertIn('missing runtime', result['cause'])

    def test_unexpected_attempt_error_stops_search_and_keeps_verified_incumbent(self):
        self.native.write_text(BOARD[:-1] + SEGMENT + ')')
        class Broken(FakeBackend):
            def route(self, directory):
                self.native.write_text('corrupt')
                raise ValueError('finalize could not read export')
            def local_repair(self, directory, worker):
                raise AssertionError('search continued after an unexpected error')
        result = run_engine(self.root, self.workspace, 'TEST', policy(max_attempts=3), timeout_s=30,
                            backend_factory=Broken)
        output = self.root / 'operation/engine'
        self.assertEqual(json.loads((output / 'result.json').read_text())['cause'], result['cause'])
        self.assertEqual(result['selected_strategy']['kind'], 'baseline')
        self.assertEqual(result['attempts'], 1)
        self.assertIn('finalize could not read export', result['cause'])
        self.assertIn('engine_error', [f['classification'] for f in result['findings']])
        self.assertEqual(self.native.read_text(), BOARD[:-1] + SEGMENT + ')')
        failed = list(output.glob('attempt-*/failed.json'))
        self.assertEqual(len(failed), 1)
        self.assertEqual(json.loads(failed[0].read_text())['error_type'], 'ValueError')
        events = [json.loads(line)['type'] for line in (output / 'events.jsonl').read_text().splitlines()]
        self.assertIn('engine.failed_attempt', events)

    def test_diagnosed_gap_uses_cheap_guarded_repair_before_solver(self):
        class Repair(FakeBackend):
            def diagnose(self, evidence):
                return dict(status='repairable', plan_sha256='0'*64, findings=[
                    dict(classification='native_open', reason='gap', refs=[], nets=['N'])])
            def cheap_repair(self, plan, output):
                self.native.write_text(self.native.read_text()[:-1] + SEGMENT + ')')
                return ()
            def route(self, directory):
                raise AssertionError('cheap supported repair should avoid broad routing')
        result = run_engine(self.root, self.workspace, 'TEST', policy(max_attempts=1), timeout_s=30,
                            backend_factory=Repair)
        self.assertEqual(result['selected_strategy']['kind'], 'repair')
        self.assertEqual(result['attempts'], 1)
        self.assertFalse(result['candidate_verified'])

    def test_unsafe_movement_cannot_remove_other_net(self):
        footprint = '(footprint "R" (at 1 1) (property "Reference" "R1") (pad "1" smd rect (at 0 0) (net 2 "OTHER")))'
        self.native.write_text(BOARD[:-1] + footprint + SEGMENT + ')')
        before = self.native.read_bytes()
        with self.assertRaisesRegex(Blocked, 'outside routing authority'):
            strip_moved_nets(self.native, ['R1'], ['N'], allowed_layers=['F.Cu'])
        self.assertEqual(self.native.read_bytes(), before)

    def test_movement_cannot_remove_incident_copper_on_undeclared_layer(self):
        footprint = '(footprint "R" (at 1 1) (property "Reference" "R1") (pad "1" smd rect (at 0 0) (net 1 "N")))'
        self.native.write_text(BOARD[:-1] + footprint + SEGMENT.replace('"F.Cu"', '"B.Cu"') + ')')
        before = self.native.read_bytes()
        with self.assertRaisesRegex(Blocked, 'layer authority'):
            strip_moved_nets(self.native, ['R1'], ['N'], allowed_layers=['F.Cu'])
        self.assertEqual(self.native.read_bytes(), before)

    def test_continuation_movement_origin_is_canonical_not_parent_candidate(self):
        canonical = self.root / 'canonical'
        canonical.mkdir()
        original = canonical / 'board.kicad_pcb'
        original.write_text('(kicad_pcb (version 20260101) (net 1 "N") (footprint "R" (at 0 0) (property "Reference" "R1") (uuid "r1")))')
        self.native.write_text(original.read_text().replace('(at 0 0)', '(at .4 0)'))
        atomic_json(self.root / 'operation/source.json',
                    {'files': {'board.kicad_pcb': file_digest(original),
                               'board.kicad_dru': file_digest(self.rule)}})
        atomic_json(self.root / 'run.json', {'root': str(canonical)})
        class Moving(FakeBackend):
            def route(self, directory):
                self.native.write_text(self.native.read_text().replace('(at .4 0)', '(at .8 0)'))
                return {}, ()
        result = run_engine(self.root, self.workspace, 'TEST',
            policy(max_attempts=1, movement=dict(refs=['R1'], max_displacement_mm=.5, step_mm=.2)),
            timeout_s=30, backend_factory=Moving)
        self.assertIn('original movement envelope', result['cause'])
        self.assertIn('(at .4 0)', self.native.read_text())
        state = json.loads((self.root / 'operation/engine/state.json').read_text())
        self.assertEqual(state['movement_origin']['sha256'], file_digest(original))
        self.assertNotEqual(state['movement_origin']['sha256'], file_digest(self.native))
        # Routing-only continuation can retain previously authorized movement,
        # but cannot introduce another unscoped move.
        verify_movement(original, self.native, self.policy, baseline=self.native)

    def test_resume_skips_identical_route_but_runs_remaining_local_frontier(self):
        class First(FakeBackend):
            def route(self, directory):
                raise KeyboardInterrupt('simulated interrupted solver')
        with self.assertRaises(KeyboardInterrupt):
            run_engine(self.root, self.workspace, 'TEST', policy(), timeout_s=30, backend_factory=First)
        class Next(FakeBackend):
            def route(self, directory):
                raise AssertionError('same unchanged route was repeated')
            def local_repair(self, directory, worker):
                self.native.write_text(self.native.read_text()[:-1] + SEGMENT + ')')
        class Compute:
            def __init__(self, **kwargs): pass
            def __enter__(self): return self
            def __exit__(self, *args): pass
        with patch('pcb_engine.compute.ComputeWorker', Compute):
            second = run_engine(self.root, self.workspace, 'TEST', policy(), timeout_s=30, backend_factory=Next)
        self.assertEqual(second['attempts'], 2)
        self.assertEqual(second['selected_strategy']['kind'], 'local')
        third = run_engine(self.root, self.workspace, 'TEST', policy(), timeout_s=30, backend_factory=Next)
        self.assertEqual(third['attempts'], 2)
        self.assertEqual(third['candidate_sha256'], second['candidate_sha256'])

    def test_move_proposals_use_diagnosis_scope_and_full_production_objective(self):
        from test_pcb_search import placement_problem, PARAMS
        from placer import cost
        raw = dict(problem=placement_problem(), params=PARAMS, attachments=[])
        movement = JobPolicy.parse(policy(movement=dict(refs=['B'], max_displacement_mm=.5, step_mm=.5)), 30)
        self.assertEqual(move_proposals(raw, [Finding('native_open', 'unknown')], movement), [])
        proposals = move_proposals(raw, [Finding('escape_failure', 'blocked pin', refs=('B',))], movement)
        self.assertTrue(proposals)
        for proposal in proposals:
            self.assertEqual(proposal['moved_refs'], ['B'])
            self.assertEqual(proposal['pose'][0], [2, 5, 0])
            self.assertAlmostEqual(proposal['production_score'],
                                   cost.total(raw['problem'], proposal['pose'], raw['params']))
            self.assertLessEqual(abs(proposal['strategy']['dx'])+abs(proposal['strategy']['dy']), .5)

    def test_failed_route_drives_bounded_move_and_reroute(self):
        from test_pcb_search import placement_problem, PARAMS
        initial = '(kicad_pcb (version 20260101) (net 1 "N") (footprint "R" (at 8 5) (property "Reference" "B") (uuid "b")))'
        self.native.write_text(initial)
        class Repair(FakeBackend):
            def route(self, directory):
                if '(at 8 5)' in self.native.read_text():
                    return {}, (Finding('escape_failure', 'pin blocked', refs=('B',), nets=('N',)),)
                self.native.write_text(self.native.read_text()[:-1] + SEGMENT + ')')
                return {}, ()
            def local_repair(self, directory, compute):
                raise Blocked('local adapter unsupported for fixture')
            def export_placement(self, output):
                return dict(problem=placement_problem(), params=PARAMS, attachments=[])
            def apply_move(self, export, proposal, output):
                x, y, _ = proposal['pose'][1]
                self.native.write_text(self.native.read_text().replace('(at 8 5)', f'(at {x} {y})'))
        class Compute:
            def __init__(self, **kwargs): pass
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def prepare(self, op, **kwargs): return 'fixture'
            def request(self, op, **kwargs):
                return dict(result={'scores': [0]*len(kwargs['candidate_deltas'])}, metrics={'backend': 'cpu'})
        config = policy(max_attempts=3, movement=dict(refs=['B'], max_displacement_mm=.5, step_mm=.5))
        with patch('pcb_engine.compute.ComputeWorker', Compute):
            result = run_engine(self.root, self.workspace, 'TEST', config, timeout_s=30, backend_factory=Repair)
        self.assertEqual(result['selected_strategy']['kind'], 'move')
        self.assertEqual(result['attempts'], 3)
        self.assertIn('segment', self.native.read_text())
        self.assertNotIn('(at 8 5)', self.native.read_text())

    def test_infinite_gpu_guidance_does_not_prune_a_legal_path(self):
        path = astar(5, 5, {6, 7, 8}, 0, 24, field=[1_000_000_000] * 25)
        self.assertIsNotNone(path)
        self.assertEqual((path[0], path[-1]), (0, 24))
        self.assertFalse(set(path) & {6, 7, 8})

    def test_local_route_consumes_gpu_field_but_remains_unqualified(self):
        class Compute:
            requests = []
            def request(self, operation, **args):
                self.requests.append((operation, args))
                return dict(result={'distances': [0]*(args['width']*args['height'])},
                            metrics={'backend': 'metal', 'dispatches': 1})
        worker = Compute()
        srj = dict(bounds=dict(minX=0, minY=0, maxX=4, maxY=4),
            minTraceWidth=.2, minViaPadDiameter=.6, defaultObstacleMargin=.2,
            obstacles=[], traces=[], connections=[dict(name='N', nominalTraceWidth=.2,
                pointsToConnect=[dict(x=1., y=1., layers=['top']), dict(x=3., y=3., layers=['top'])])])
        result = route_srj(srj, compute=worker, backend='metal', budget_s=3)
        self.assertEqual(result['status'], 'candidate')
        self.assertFalse(result['qualified'])
        self.assertEqual(worker.requests[0][0], 'cost_field')
        self.assertTrue(worker.requests[0][1]['blocked'])
        self.assertEqual(len(result['output']['traces']), 1)

    def test_local_route_connects_multiple_native_groups_on_declared_layers(self):
        srj = dict(bounds=dict(minX=0, minY=0, maxX=6, maxY=6),
            minTraceWidth=.2, minViaPadDiameter=.6, defaultObstacleMargin=.2,
            obstacles=[], traces=[], connections=[dict(name='N', nominalTraceWidth=.2,
                pointsToConnect=[dict(x=1., y=1., layers=['top'], pointId='A'),
                                 dict(x=3., y=3., layers=['top'], pointId='B'),
                                 dict(x=5., y=3., layers=['top'], pointId='C')],
                externallyConnectedPointIds=[['A', 'B']])])
        result = route_srj(srj, budget_s=3, allowed_layers=['top'])
        self.assertEqual(result['status'], 'candidate')
        self.assertEqual(result['routed_connections'], 1)
        blocked = route_srj(srj, budget_s=3, allowed_layers=['bottom'])
        self.assertEqual(blocked['status'], 'blocked')
        self.assertEqual(blocked['unresolved_nets'], ['N'])

    def test_compute_refusal_falls_back_to_cpu_search(self):
        class Compute:
            def request(self, *args, **kwargs):
                raise ValueError('accelerator work budget exceeded')
        srj = dict(bounds=dict(minX=0, minY=0, maxX=4, maxY=4),
            minTraceWidth=.2, minViaPadDiameter=.6, defaultObstacleMargin=.2,
            obstacles=[], traces=[], connections=[dict(name='N', nominalTraceWidth=.2,
                pointsToConnect=[dict(x=1., y=1., layers=['top']), dict(x=3., y=3., layers=['top'])])])
        events = []
        result = route_srj(srj, compute=Compute(), budget_s=3, emit=lambda kind, **row: events.append(kind))
        self.assertEqual(result['status'], 'candidate')
        self.assertIn('engine.compute_fallback', events)

    def test_gpu_primitive_rotates_pin_centers_and_keeps_production_priority(self):
        class Compute:
            points = None
            def prepare(self, op, **kwargs):
                self.base = kwargs['candidates'][0]
                return 'fixture'
            def request(self, op, **kwargs):
                self.points = []
                for deltas in kwargs['candidate_deltas']:
                    row = [list(point) for point in self.base]
                    for index, dx, dy in deltas:
                        row[index][0] += dx
                        row[index][1] += dy
                    self.points.append(row)
                return dict(result={'scores': [99, 0]}, metrics={})
        raw = dict(problem=dict(nets=[dict(pins=[[0, 1, 2, 3, 4], [1, 0, 0, 0, 0]])]))
        proposals = [dict(pose=[[10, 20, 1], [0, 0, 0]], production_score=1, strategy={'id': 1}),
                     dict(pose=[[10, 20, 3], [0, 0, 0]], production_score=2, strategy={'id': 2})]
        worker = Compute()
        _placement_compute(raw, proposals, worker, self.policy, lambda *a, **k: None)
        self.assertEqual(worker.points[0][0], [13, 18])
        self.assertEqual(worker.points[1][0], [7, 22])
        self.assertEqual(proposals[0]['production_score'], 1)


if __name__ == '__main__':
    unittest.main()
