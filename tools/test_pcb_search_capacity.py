"""Pinned backend tests; fixture dimensions are synthetic, not production rules."""
import os
import json
import unittest
from unittest import mock
import subprocess

from pcb_search.capacity import retains_fields, route_crossings, run, terminal_conflicts
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
        self.assertEqual(set(result['adapter_files']), {'run.mjs', 'planning.mjs', 'package.json', 'package-lock.json'})

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


if __name__ == '__main__':
    unittest.main()
