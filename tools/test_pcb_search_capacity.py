"""Pinned backend tests; fixture dimensions are synthetic, not production rules."""
import os
import json
import unittest
from unittest import mock
import subprocess

from pcb_search.capacity import retains_fields, route_crossings, run, terminal_conflicts, resolve_existing_vias
from pcb_search.contracts import Problem
from pcb_search.patterns import route_patterns
from test_pcb_search import obstacle, routing_problem


def srj():
    return dict(layerCount=2, minTraceWidth=.2, minViaPadDiameter=.6, minViaHoleDiameter=.3,
                defaultObstacleMargin=.2, minBoardEdgeClearance=.2, allowViaInPad=False,
                allowJumpers=False, bounds=dict(minX=0, minY=0, maxX=10, maxY=10),
                obstacles=[dict(type='rect', obstacleId='wall', layers=['top', 'bottom'],
                                center=dict(x=5, y=5), width=2, height=4, connectedTo=[])],
                connections=[dict(name='A', pointsToConnect=[dict(x=1, y=5, layer='top'),
                                                            dict(x=9, y=5, layer='top')])])


class CapacityTests(unittest.TestCase):
    def test_unsupported_transition_is_preserved_for_diagnosis_without_candidate_output(self):
        p = srj()
        from pcb_search.contracts import fingerprint
        backend = dict(schema='iot-lab.capacity-route.v1', status='candidate', qualified=False,
            input_sha256=fingerprint(p), native_validation_required=True,
            output=dict(p, traces=[dict(pcb_trace_id='new', connection_name='A', route=[dict(
                route_type='through_obstacle', start=dict(x=2,y=3), end=dict(x=2,y=3),
                from_layer='top', to_layer='bottom', width=.2)])]))
        proc = subprocess.CompletedProcess([], 0, stdout=json.dumps(backend), stderr='')
        with mock.patch('pcb_search.capacity.subprocess.run', return_value=proc):
            result = run(p, budget_s=1)
        self.assertEqual(result['status'], 'unsupported')
        self.assertNotIn('output', result)
        self.assertEqual(result['backend_output'], backend['output'])
        self.assertFalse(result['qualified'])

    def test_existing_transition_requires_exact_native_via_identity_and_net(self):
        via = dict(pcb_trace_id='native-via', connection_name='A', route=[dict(route_type='via',
            x=2, y=3, from_layer='top', to_layer='bottom', via_diameter=.6, via_hole_diameter=.3)])
        p = dict(route_type='through_obstacle', start=dict(x=2,y=3), end=dict(x=2,y=3),
                 from_layer='bottom', to_layer='top', width=.2)
        trace = dict(pcb_trace_id='new', connection_name='A', route=[p])
        result = resolve_existing_vias(dict(traces=[via]), [trace])
        self.assertEqual(result[0]['route'][0]['reuse_via_id'], 'native-via')
        self.assertEqual(result[0]['route'][0]['from_layer'], 'bottom')
        self.assertEqual(trace['route'][0]['route_type'], 'through_obstacle')
        for changed in (dict(trace, connection_name='B'),
                        dict(trace, route=[dict(p, end=dict(x=2.000001,y=3))])):
            with self.assertRaises(ValueError):
                resolve_existing_vias(dict(traces=[via]), [changed])
        for originals in ([], [via, dict(via, pcb_trace_id='duplicate')]):
            with self.assertRaises(ValueError):
                resolve_existing_vias(dict(traces=originals), [trace])

    def test_crossing_checks_original_copper_even_when_solver_moves_it(self):
        def trace(tid,net,points,layer='bottom'):
            return dict(pcb_trace_id=tid, connection_name=net,
                        route=[dict(route_type='wire',x=x,y=y,layer=layer,width=.2) for x,y in points])
        original=trace('old','SCL',[(0,0),(4,4)])
        proposed=trace('new','V_GAS',[(0,4),(4,0)])
        moved=trace('old','SCL',[(10,10),(14,14)])
        conflicts=route_crossings(dict(traces=[original]),[moved,proposed])
        self.assertEqual(len(conflicts),1)
        self.assertEqual(conflicts[0]['nets'],['SCL','V_GAS'])
        proposed['route'][1].update(x=1,y=4)
        self.assertFalse(route_crossings(dict(traces=[original]),[proposed]))
        proposed=trace('new','V_GAS',[(0,4),(4,0)],'top')
        self.assertFalse(route_crossings(dict(traces=[original]),[proposed]))

    def test_blocked_terminal_stops_before_backend_without_claiming_unroutable(self):
        p = srj(); p['obstacles'][0]['center'] = dict(x=1, y=5)
        with mock.patch('pcb_search.capacity.subprocess.run') as process:
            result = run(p, budget_s=1)
        process.assert_not_called()
        self.assertEqual(result['status'], 'model_conflict')
        self.assertFalse(result['conflicts'][0]['unroutable_proven'])
        p['connections'][0]['pointsToConnect'][0] = dict(x=1, y=5, layers=['top', 'bottom'])
        p['obstacles'][0]['layers'] = ['top']
        self.assertFalse(terminal_conflicts(p))
        p['obstacles'][0]['layers'] = ['top', 'bottom']
        p['obstacles'][0]['connectedTo'] = ['A']
        self.assertFalse(terminal_conflicts(p))

    def test_rotated_obstacle_does_not_use_its_large_axis_aligned_box(self):
        p = srj(); p['obstacles'][0].update(center=dict(x=2,y=4),width=4,height=.2,ccwRotationDegrees=45)
        self.assertFalse(terminal_conflicts(p))
        p['connections'][0]['pointsToConnect'][0].update(x=1,y=3)
        self.assertTrue(terminal_conflicts(p))

    def test_annotations_are_allowed_but_not_changes_to_geometry_or_connectivity(self):
        self.assertTrue(retains_fields({'width': 2, '__zLayers': [0, 1]}, {'width': 2.0}))
        self.assertFalse(retains_fields({'width': 1, '__zLayers': [0, 1]}, {'width': 2}))
        self.assertFalse(retains_fields({'connectedTo': ['B']}, {'connectedTo': ['A']}))
        self.assertFalse(retains_fields({'width': True}, {'width': 1}))

    def test_missing_rules_unknown_fields_and_duplicate_connections_fail_before_process(self):
        for mutate in (lambda p:p.pop('minViaHoleDiameter'), lambda p:p.update(unknown_rule=1),
                       lambda p:p.update(allowViaInPad='yes'),
                       lambda p:p['connections'].append(p['connections'][0])):
            with mock.patch('pcb_search.capacity.subprocess.run') as process:
                p = srj(); mutate(p)
                with self.assertRaises(ValueError):
                    run(p, budget_s=1)
                process.assert_not_called()

    def test_process_deadline_is_terminal_and_never_qualifies(self):
        phase = dict(schema='iot-lab.capacity-progress.v1', phase='highDensityRouteSolver',
                     iterations=42, elapsed_ms=900)
        # TimeoutExpired exposes captured bytes even when text=True. An
        # incomplete diagnostic line must not hide the last complete phase.
        stderr = ('unrelated backend log\nIOT_CAPACITY_PROGRESS ' + json.dumps(phase)
                  + '\nIOT_CAPACITY_PROGRESS {"phase":').encode()
        error = subprocess.TimeoutExpired('node', 1, output=b'{"status":"candidate"}', stderr=stderr)
        with mock.patch('pcb_search.capacity.subprocess.run', side_effect=error):
            result = run(srj(), budget_s=1)
        self.assertEqual(result['status'], 'timeout')
        self.assertFalse(result['qualified'])
        self.assertEqual(result['progress'], [phase])
        self.assertNotIn('output', result)
        self.assertEqual(set(result['adapter_files']), {'run.mjs', 'planning.mjs', 'reuse.mjs', 'package.json', 'package-lock.json'})

    @unittest.skipUnless(os.environ.get('PCB_CAPACITY_INTEGRATION') == '1', 'optional pinned Node backend')
    def test_topology_resolves_case_beyond_cheap_patterns(self):
        raw = routing_problem()
        raw['obstacles'] = [obstacle('wall', [4, 3, 6, 7], layers=['F.Cu', 'B.Cu'])]
        cheap = route_patterns(Problem.read(raw), budget_s=1)
        self.assertTrue(cheap['unresolved'])
        self.assertFalse(cheap['unresolved'][0]['unroutable_proven'])
        result = run(srj(), budget_s=3)
        self.assertEqual(result['status'], 'candidate', result)
        self.assertTrue(result['output']['traces'])
        self.assertEqual(result['backend']['version'], '0.0.979')
        self.assertFalse(result['qualified'])
        self.assertEqual(result['progress'][0]['phase'], 'loading_backend')
        self.assertTrue(any(row['phase'] == 'initializing' for row in result['progress']))

    @unittest.skipUnless(os.environ.get('PCB_CAPACITY_INTEGRATION') == '1', 'optional pinned Node backend')
    def test_reuse_pipeline_returns_only_a_stitched_native_check_proposal(self):
        result = run(srj(), budget_s=3, pipeline='reuse', capture_stages=True)
        self.assertEqual(result['status'], 'candidate', result)
        self.assertFalse(result['qualified'])
        self.assertFalse(result['backend_solved'])
        self.assertTrue(result['native_validation_required'])
        self.assertEqual(result['completed_stage'], 'highDensityStitchSolver')
        self.assertTrue(result['output']['traces'])
        self.assertEqual(result['reuse']['reused_nodes'], [])
        self.assertFalse(result['stage_geometry']['qualified'])
        self.assertTrue(result['stage_geometry']['node_inputs'])
        self.assertTrue(result['stage_geometry']['local_routes'])
        self.assertTrue(result['stage_geometry']['stitched_routes'])


if __name__ == '__main__':
    unittest.main()
