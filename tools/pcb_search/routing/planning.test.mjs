import test from 'node:test';
import assert from 'node:assert/strict';
import { retainedTrackPortConflicts, solverWork } from './planning.mjs';

// Synthetic geometry in mm; these values are test inputs, not board rules.
const input = { layerCount: 2, minTraceWidth: .2, defaultObstacleMargin: .2,
  traces: [{ pcb_trace_id: 'fixed', connection_name: 'GND', route: [
    { route_type: 'wire', x: 0, y: 0, width: .2, layer: 'top' },
    { route_type: 'wire', x: 4, y: 4, width: .2, layer: 'top' },
  ] }] };
const node = (x, y, z = 0, root = 'signal') => [{ capacityMeshNodeId: 'region', portPoints: [
  { portPointId: 'port', connectionName: 'signal_mst2', rootConnectionName: root, x, y, z },
] }];

test('exact capsule catches a crossing while keeping the diagonal AABB corner clear', () => {
  assert.equal(retainedTrackPortConflicts(input, node(0, 4)).length, 0);
  const [witness] = retainedTrackPortConflicts(input, node(2, 2));
  assert.equal(witness.retained_trace_id, 'fixed');
  assert.equal(witness.centerline_distance_mm, 0);
  assert.equal(witness.required_centerline_distance_mm, .4);
  assert.equal(witness.unroutable_proven, false);
  assert.equal(retainedTrackPortConflicts(input, node(4.2, 4.2)).length, 1);
});

test('same-net aliases and other copper layers remain usable', () => {
  const map = { getNetConnectedToId: n => ({ GND: 'net5', ground_alias: 'net5' })[n] };
  assert.equal(retainedTrackPortConflicts(input, node(2, 2, 0, 'ground_alias'), map).length, 0);
  assert.equal(retainedTrackPortConflicts(input, node(2, 2, 1)).length, 0);
});

test('exact legal tangency passes but a one-nanometre intrusion fails', () => {
  const horizontal = structuredClone(input);
  horizontal.traces[0].route[1].y = 0;
  assert.equal(retainedTrackPortConflicts(horizontal, node(2, .4)).length, 0);
  assert.equal(retainedTrackPortConflicts(horizontal, node(2, .4 - .000001)).length, 1);
});

test('via boundaries never become diagonal wire segments', () => {
  const withVia = structuredClone(input);
  withVia.traces[0].route.splice(1, 0, { route_type: 'via', x: 0, y: 0, from_layer: 'top', to_layer: 'bottom' });
  assert.equal(retainedTrackPortConflicts(withVia, node(2, 2)).length, 0);
});

test('progress exposes nested solver names and is bounded even for a cycle', () => {
  const child = { getSolverName: () => 'Detail', iterations: 12, activeConnection: { connectionName: 'SDA' } };
  const solver = { getSolverName: () => 'Pipeline', activeSubSolver: child,
    highDensityRouteSolver: { activeNode: { capacityMeshNodeId: 'region' },
      stats: { solvedNodeCount: 3, nodeCount: 5 }, activeFallbackReason: 'blocked' } };
  child.activeSubSolver = solver;
  const work = solverWork(solver);
  assert.deepEqual(work.chain.map(s => s.name), ['Pipeline', 'Detail']);
  assert.equal(work.chain[1].connection, 'SDA');
  assert.equal(work.node_id, 'region');
  assert.equal(work.solved_nodes, 3);
  assert.equal(work.fallback_reason, 'blocked');
});
