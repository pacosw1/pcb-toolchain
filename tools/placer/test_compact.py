import ast
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class ParseTest(unittest.TestCase):
    def test_router_output_gives_the_last_unrouted_count_or_a_no_result_value(self):
        from placer import compact_cli
        self.assertEqual(compact_cli.parse_unrouted('FR_RC 0\nUNROUTED 12 SUBSET 3 ERRORS 1\n'), 12)
        self.assertEqual(compact_cli.parse_unrouted('remote: exit 124\n'), compact_cli.NO_RESULT)

    def test_the_schedule_shrink_and_tolerance_come_from_the_command_line(self):
        from placer import compact_cli
        a = compact_cli.parser().parse_args(['p.json', 'b.kicad_pcb', '--board-dir', 'd', '--outdir', 'o', '--size', '70',
                                             '50', '--wheel', 'w.whl', '--tol', '0.2', '--shrink', '0.8'])
        self.assertEqual((a.tol, a.shrink), (0.2, 0.8))
        d = compact_cli.parser().parse_args(['p.json', 'b', '--board-dir', 'd', '--outdir', 'o', '--size', '1', '1',
                                             '--wheel', 'w'])
        self.assertEqual((d.tol, d.shrink), (0.05, 0.85))
        self.assertEqual(d.routes, 3)  # a step passes when the best of 3 runs is at or below the target

    def test_route_job_adds_ground_pad_vias_only_when_asked(self):
        from placer import compact_cli
        self.assertEqual(compact_cli.route_cmd('B', False), ['bash', 'tools/placer/fr_job.sh', 'B'])
        self.assertEqual(compact_cli.route_cmd('B', True), ['env', 'GNDVIAS=1', 'bash', 'tools/placer/fr_job.sh', 'B'])


class DriverDecisionTest(unittest.TestCase):
    def setUp(self):
        from placer import compact_cli
        self.driver = compact_cli
        temporary = tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        self.route = self.folder/'route-0';self.route.mkdir()
        self.candidate = self.route/'routed.kicad_pcb';self.candidate.write_text('synthetic retained copper')
        self.outcome = self.route/'outcome.json'
        self.outcome.write_text(json.dumps(dict(board_sha256=self.driver.lean.digest(self.candidate))))
        self.feedback_source = self.route/'pin-escape.json';self.feedback_source.write_text('synthetic source-bound screen fixture')
        self.decision = dict(status='diagnosed', action='inspect_escape', qualified=False,
            source_board_sha256='b'*64, findings=[dict(classification='escape_failure')],
            evidence=str(self.folder/'route-decision.json'),
            artifacts={name:self.driver.lean.digest(self.route/name) for name in ('outcome.json','pin-escape.json')})
        self.feedback = dict(accepted=True, source_board_sha256='b'*64,
            sources={str(self.feedback_source):self.driver.lean.digest(self.feedback_source)})

    def test_only_source_bound_positive_geometry_update_can_continue(self):
        checked = self.driver.route_handoff([2], self.decision, self.folder,
            feedback=self.feedback, prior_hints={}, hints={'U1':.5})
        self.assertFalse(checked.stop)
        self.assertEqual(checked.candidate['sha256'], self.driver.lean.digest(self.candidate))
        before = self.candidate.read_bytes()
        for feedback, prior, hints in (
                (dict(self.feedback, accepted=False), {}, {'U1':.5}),
                (dict(self.feedback, source_board_sha256='c'*64), {}, {'U1':.5}),
                (dict(self.feedback, sources={}), {}, {'U1':.5}),
                (self.feedback, {'U1':.5}, {'U1':.5})):
            with self.subTest(feedback=feedback, prior=prior):
                checked = self.driver.route_handoff([2], self.decision, self.folder,
                    feedback=feedback, prior_hints=prior, hints=hints)
                self.assertTrue(checked.stop)
                self.assertTrue(checked.decision['next_action']['full_configured_gates_required'])
                self.assertFalse(checked.decision['next_action']['qualified'])
        self.assertEqual(self.candidate.read_bytes(), before)

    def test_changed_retained_copper_or_feedback_stops_instead_of_reusing_it(self):
        self.candidate.write_text('changed after native diagnosis')
        checked = self.driver.route_handoff([2], self.decision, self.folder,
            feedback=self.feedback, prior_hints={}, hints={'U1':.5})
        self.assertTrue(checked.stop);self.assertIsNone(checked.candidate)
        self.assertEqual(checked.decision['action'], 'inspect_evidence')
        self.candidate.unlink()
        checked = self.driver.route_handoff([0], self.decision, self.folder)
        self.assertTrue(checked.stop);self.assertIsNone(checked.candidate)

    def skipped_fixture(self):
        manifest = dict(board_sha256='b'*64, configuration=dict(skip_net='*GND*', plane_nets='',
            gnd_vias=False, route_planes=False))
        outcome = dict(status='complete', board_sha256=self.driver.lean.digest(self.candidate),
                       signal_open=0, ground_open=1, errors=0)
        drc = dict(violations=[], schematic_parity=[], unconnected_items=[dict(items=[
            dict(description='Pad 1 [GND] of J1'), dict(description='Zone [GND] on F.Cu')])])
        decision = dict(self.decision, action='diagnose_selected_connections', findings=[dict(classification='native_open')])
        return manifest, outcome, drc, decision

    def scoped_result(self, manifest, outcome, drc, decision, reported=None):
        for name, value in zip(('input-manifest.json','outcome.json','drc.json'), (manifest,outcome,drc)):
            (self.route/name).write_text(json.dumps(value))
            decision.setdefault('artifacts', {})[name] = self.driver.lean.digest(self.route/name)
        reported = dict(signal_open=0, ground_open=1, errors=0) if reported is None else reported
        return self.driver.route_handoff([0], decision, self.folder, reported_counts=reported)

    def test_explicit_skipped_plane_opens_preserve_signal_step_semantics_only(self):
        for config in (dict(skip_net='*GND*'), dict(skip_net='', gnd_vias=True),
                       dict(skip_net='', plane_nets='GND'), dict(skip_net='*GND*', plane_nets='GND', route_planes=True)):
            with self.subTest(config=config):
                manifest, outcome, drc, decision = self.skipped_fixture()
                manifest['configuration'].update(config)
                result = self.scoped_result(manifest,outcome,drc,decision)
                self.assertFalse(result.stop);self.assertTrue(result.routing_step_clean)
                scope = result.decision['routing_step_scope']
                self.assertEqual(scope['excluded_native_opens'],1);self.assertEqual(scope['nets'],['GND'])
                self.assertFalse(scope['native_verified']);self.assertFalse(scope['qualified'])
                self.assertTrue(scope['full_configured_gates_required'])
                self.assertEqual(json.loads((self.route/'drc.json').read_text()),drc)

    def test_unconfigured_mixed_unnamed_or_inconsistent_skipped_opens_do_not_pass(self):
        cases = (
            lambda m,o,d,c:m['configuration'].update(skip_net=''),
            lambda m,o,d,c:m['configuration'].update(route_planes='false'),
            lambda m,o,d,c:o.update(ground_open=2),
            lambda m,o,d,c:o.update(signal_open=1),
            lambda m,o,d,c:o.update(status='stuck'),
            lambda m,o,d,c:d['unconnected_items'][0]['items'][1].update(description='Pad 1 [VCC] of U1'),
            lambda m,o,d,c:d['unconnected_items'][0]['items'][1].update(description='Unnamed zone'),
            lambda m,o,d,c:d['unconnected_items'][0]['items'][1].update(description='Zone [[GND]]'),
            lambda m,o,d,c:d['violations'].append(dict(severity='error',type='clearance')),
            lambda m,o,d,c:d['schematic_parity'].append(dict(type='pad_net_conflict')),
            lambda m,o,d,c:c['findings'].append(dict(classification='constraints_unknown')),
            lambda m,o,d,c:c['findings'].append(dict(classification='escape_failure')))
        for index, change in enumerate(cases):
            with self.subTest(case=index):
                manifest, outcome, drc, decision = self.skipped_fixture();change(manifest,outcome,drc,decision)
                result = self.scoped_result(manifest,outcome,drc,decision)
                self.assertTrue(result.stop);self.assertFalse(result.routing_step_clean)
                self.assertNotIn('routing_step_scope',result.decision)
        manifest,outcome,drc,decision = self.skipped_fixture()
        result = self.scoped_result(manifest,outcome,drc,decision,reported=dict(signal_open=0,ground_open=2,errors=0))
        self.assertTrue(result.stop)
        decision['artifacts'].pop('input-manifest.json')
        result = self.driver.route_handoff([0],decision,self.folder,reported_counts=dict(signal_open=0,ground_open=1,errors=0))
        self.assertTrue(result.stop)

    def test_production_callback_continues_changed_geometry_but_not_identical_failure(self):
        # CPU transport fixture only; no router/native correctness is claimed.
        source = Path(self.driver.__file__)
        main = next(node for node in ast.parse(source.read_text()).body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        function = next(node for node in main.body if isinstance(node, ast.FunctionDef) and node.name == 'route')
        native = self.folder/'source.kicad_pcb';native.write_text('synthetic placement bytes A')
        def sdir(n):
            folder = self.folder/('step-'+str(n));folder.mkdir();return str(folder)
        def execute(command, *args, **kwargs):
            route = Path(command[3]);route.mkdir()
            routed = route/'routed.kicad_pcb';routed.write_bytes(Path(command[2]).read_bytes()+b' retained router copper')
            for name, value in {
                    'input-manifest.json':dict(board_sha256=self.driver.lean.digest(native)),
                    'outcome.json':dict(status='complete', errors=0, board_sha256=self.driver.lean.digest(routed)),
                    'drc.json':dict(violations=[], schematic_parity=[], unconnected_items=[dict(items=[])]),
                    'pin-escape.json':dict(boxed_in=[dict(ref='U1', pad='U1.1', net='A')], halo_hint={'U1':.5})}.items():
                (route/name).write_text(json.dumps(value))
            return SimpleNamespace(returncode=3, stdout='UNROUTED 1 GND_OPEN 0 ERRORS 0\n')
        run = mock.Mock(side_effect=execute)
        namespace = dict(vars(self.driver), sdir=sdir,
            a=SimpleNamespace(max_routes=0, router='fastroute', passes=1, optimizer='off', gnd_vias=False,
                route_args='', feedback_max_mm=1, congestion_feedback=False), routes_done=[0], routing_attempts={},
            run_stage=run, name='source', seed_receipt=None, escape_hint={},
            pr=dict(units=[dict(name='U1', refs=['U1'], fixed=False)]))
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)
        first = namespace['route'](str(native), 0)
        self.assertFalse(first.stop);self.assertEqual(first.decision['geometry_feedback']['changed_refs'], ['U1'])
        before = Path(first.candidate['path']).read_bytes()
        unchanged = namespace['route'](str(native), 1)
        self.assertTrue(unchanged.stop);self.assertEqual(run.call_count, 1)
        self.assertEqual(unchanged.candidate, first.candidate)
        native.write_text('synthetic placement bytes B')
        changed = namespace['route'](str(native), 2)
        self.assertFalse(changed.stop);self.assertEqual(run.call_count, 2)
        self.assertNotEqual(changed.candidate['sha256'], first.candidate['sha256'])
        self.assertEqual(Path(first.candidate['path']).read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
