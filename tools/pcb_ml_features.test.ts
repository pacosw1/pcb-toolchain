import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Board, Footprint, Pad, Track } from './lib/board-types.ts';
import { featureContract, nativeCopperMetrics, numericProducer, routingFeatures, workflowCase, workflowFeatures } from './pcb_ml_features.ts';
import { artifactIdentity, encode, float, number, object } from './pcb_ml_json.ts';

export const pad = (x: number, y: number, net = 'N'): Pad => ({ id: `${x},${y}`, number: '1', kind: 'Smd', shape: 'Rect', net,
  position: { x, y }, orientation: 0, size: { x: 1e6, y: 1e6 }, drill: { x: 0, y: 0 }, layers: ['F.Cu'], bbox: { left: x, right: x, top: y, bottom: y },
  zone_connection: null, thermal_spoke_angle: 0, spoke_templates: 0, copper: [], polygons: {}, solder_mask_expansion: 0, clearance_override: null });
export const footprint = (pads: Pad[]): Footprint => ({ id: 'fp', reference: 'J1', value: '', lib_id: '', layer: 'F.Cu', position: { x: 0, y: 0 },
  orientation: 0, locked: false, clearance_override: null, fields: [], pads, graphics: [], zones: [], courtyard_front: [], courtyard_back: [] });
export const boardFixture = (): Board => ({ path: 'synthetic', copper_layers: ['F.Cu', 'B.Cu'], stackup: [], nets: { N: 'Default' },
  footprints: [footprint([pad(0, 0), pad(3e6, 4e6)])], copper: [{ Track: { id: 't', start: { x: 0, y: 0 }, end: { x: 3e6, y: 4e6 }, mid: null, width: 250000, layer: 'F.Cu', net: 'N', locked: false } }],
  zones: [], texts: [], groups: [], graphics: [{ id: 'g', layer: 'Edge.Cuts', width: 50000, filled: false, geometry: { Rect: { top_left: { x: 0, y: 0 }, bottom_right: { x: 10e6, y: 20e6 } } } }],
  constraints: { min_clearance: 0, min_track_width: 0, min_via_size: 0, copper_edge_clearance: 0 },
  edges_bbox: { left: -25000, top: -25000, right: 10025000, bottom: 20025000 }, outlines: [] });

test('API world pad centers, straight copper and outline vertices give analytic measurements', () => {
  const [features, reasons] = routingFeatures(boardFixture());
  assert.equal(features.footprint_count, 1); assert.equal(features.pad_count, 2); assert.equal(features.declared_net_count, 1);
  assert.equal(number(features.all_net_pad_hpwl_mm), 7); assert.equal(number(features.all_net_pairwise_distance_sum_mm), 5);
  assert.equal(number(features.two_pad_distance_max_mm), 5); assert.equal(number(features.retained_track_length_mm), 5);
  assert.equal(number(features.edge_bbox_area_mm2), 200); assert.deepEqual(reasons, []);
  const board = boardFixture(); board.footprints[0].pads = [pad(0, 0), pad(10e6, 0), pad(5e6, 1e6)];
  const before = routingFeatures(board)[0]; board.footprints[0].pads[2] = pad(1e6, 1e6);
  const after = routingFeatures(board)[0];
  assert.deepEqual(before.all_net_pad_hpwl_mm, after.all_net_pad_hpwl_mm);
  assert.notDeepEqual(before.all_net_pairwise_distance_sum_mm, after.all_net_pairwise_distance_sum_mm);
});

test('unsupported arcs/outlines are unknown; via proof cannot omit missing span/type', () => {
  const board = boardFixture(); (board.copper[0] as { Track: Track }).Track.mid = { x: 1e6, y: 1e6 };
  board.graphics[0].geometry = { Circle: { center: { x: 0, y: 0 }, radius_point: { x: 1e6, y: 0 } } };
  const [values, reasons] = routingFeatures(board);
  assert.equal(values.retained_track_length_mm, null); assert.equal(values.edge_bbox_area_mm2, null); assert.equal(reasons.length, 2);
  const viaBoard = boardFixture(); viaBoard.copper.push({ Via: { id: 'v', at: { x: 0, y: 0 }, size: 600000, drill: 300000, net: 'N', locked: false, layers: ['F.Cu', 'B.Cu'] } });
  const metrics = nativeCopperMetrics(viaBoard); assert.equal(metrics.track_length_mm, 5); assert.equal(metrics.copper, null); assert.match(metrics.unknowns.copper, /layer\/type/);
  const bad = boardFixture(); bad.footprints[0].pads[0].position.x = NaN;
  assert.equal(routingFeatures(bad)[0].all_net_pad_hpwl_mm, null);
});

test('retained geometry ignores track direction/id/lock while preserving multiplicity', () => {
  const board = boardFixture(), first = nativeCopperMetrics(board), track = (board.copper[0] as { Track: Track }).Track;
  [track.start, track.end] = [track.end, track.start]; track.id = 'other'; track.locked = true;
  assert.deepEqual(nativeCopperMetrics(board).copper, first.copper);
  board.copper.push({ Track: { ...track, id: 'duplicate' } });
  assert.equal([...nativeCopperMetrics(board).copper!.values()][0], 2);
});

test('workflow values and case identity exclude post-decision labels and host locations', () => {
  const manifest = { operation: 'route', timeout_s: float(30), project: 'cad/ENV-SENSE', design_contract: {}, result: { status: 'passed' },
    engineering_manifest: { path: '/old/location', sha256: artifactIdentity('controls'), content: { mode: 'frozen' } }, created_at: 'old' };
  const [values] = workflowFeatures(manifest);
  assert.equal(values.operation_route, 1); assert.equal(values.has_design_contract, 0);
  const moved = { ...manifest, result: { status: 'timeout' }, created_at: 'later', engineering_manifest: { ...manifest.engineering_manifest, path: '/other/location' } };
  assert.deepEqual(workflowFeatures(moved), workflowFeatures(manifest)); assert.equal(workflowCase(moved), workflowCase(manifest));
  assert.equal(workflowFeatures({ timeout_s: true, operation: 'unknown' })[0].budget_s, null);
  assert.equal(workflowFeatures({ timeout_s: 3, operation: 'unknown' })[0].operation_route, null);
});

test('routing contract versions the API/numeric change and binds actual Node content without host paths', () => {
  const contract = featureContract('routing'); assert.equal(contract.version, 5); assert.equal(featureContract('workflow').version, 1);
  assert.ok(Object.entries(object(contract.implementation_sha256)).every(([name, digest]) => name.startsWith('tools/') && /^[a-f0-9]{64}$/.test(digest as string)));
  assert.ok(Object.hasOwn(object(contract.implementation_sha256), 'tools/router/core/proto/PIN'));
  const producer = numericProducer(); assert.equal(producer.implementation, 'node'); assert.equal(object(producer.float_abi).mant_dig, 53);
  assert.doesNotMatch(encode(producer), /\/Users\/|\/usr\/|python|cpython/);
  assert.equal(artifactIdentity(producer), artifactIdentity(numericProducer()));
});
