import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Board, Footprint, Pad, Polygon, Pt, RoutedCopper, Track, Via, Zone } from './board-types.ts';
import { ipcAmps, viaGroupAmps } from './copper-current.ts';
import type { PinRatings } from './pin-ratings.ts';
import { maxFlow, netGraph, padNode, pairCapacity, project, widestPath, type Conditions, type Edge } from './power-graph.ts';
import { powerPathReport, specPairs } from './power-paths.ts';
import { jsonLoads } from './py-compat.mjs';
import { spanViaKind } from './through-vias.ts';

const MM = 1_000_000;
const pt = (x: number, y: number): Pt => ({ x: Math.round(x * MM), y: Math.round(y * MM) });
const box = (x0: number, y0: number, x1: number, y1: number): Polygon => ({ outline: [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)], holes: [] });
const edge = (u: string, v: string, amps: number, label: string): Edge => ({ u, v, amps, label });

const track = (a: Pt, b: Pt, width = 1, fields: Partial<Track> = {}): RoutedCopper => ({ Track: { id: 't', start: a, end: b, mid: null, width: width * MM, layer: 'F.Cu', net: 'P', locked: false, ...fields } });
const via = (at: Pt, drill = 0.3, net = 'P'): RoutedCopper => ({ Via: { id: 'v', at, size: 2 * drill * MM, drill: drill * MM, net, locked: false, layers: ['F.Cu', 'B.Cu'] } });
function pad(number: string, at: Pt, half: Pt, fields: Partial<Pad> = {}): Pad {
  const [x, y, hx, hy] = [at.x / MM, at.y / MM, half.x / MM, half.y / MM];
  const polygon = box(x - hx, y - hy, x + hx, y + hy);
  return {
    id: number, number, kind: 'Smd', shape: 'Rect', net: 'P', position: at, orientation: 0, size: { x: half.x * 2, y: half.y * 2 }, drill: pt(0, 0), layers: ['F.Cu'],
    bbox: { left: 0, top: 0, right: 0, bottom: 0 }, zone_connection: null, thermal_spoke_angle: 0, spoke_templates: 0, copper: [{ Polygon: polygon.outline }],
    polygons: { 'F.Cu': polygon }, solder_mask_expansion: 0, clearance_override: null, ...fields,
  };
}
const footprint = (reference: string, pads: Pad[], value = ''): Footprint => ({
  id: reference, reference, value, lib_id: '', layer: 'F.Cu', position: pt(0, 0), orientation: 0, locked: false, clearance_override: null, fields: [], pads, graphics: [], zones: [], courtyard_front: [], courtyard_back: [],
});
const board = (copper: RoutedCopper[], footprints: Footprint[], zones: Zone[] = []): Board => ({
  path: 'x', copper_layers: ['F.Cu', 'B.Cu'], stackup: [], nets: {}, footprints, copper, zones, graphics: [], texts: [], groups: [], constraints: { min_clearance: 0, min_track_width: 0, min_via_size: 0, copper_edge_clearance: 0 }, edges_bbox: { left: 0, top: 0, right: 0, bottom: 0 }, outlines: [],
});
const plane = (layer: string, polygons: Polygon[], connection: 'Thermal' | 'Full' = 'Thermal'): Zone => ({
  id: 'z', name: '', net: 'P', layers: [layer], outline: polygons, filled: [{ layer, polygons }], rule_area: null,
  fill: { clearance: 0, min_thickness: 0, thermal_gap: 0, spoke_width: 0.5 * MM, pad_connection: connection, island_removal_mode: 0, min_island_area: 0 },
});
const conditions = (ratings: PinRatings = {}): Conditions => ({ thickness: new Map(), rise: 10, plating: 0.018, ratings });
const J1 = (at: Pt): Footprint => footprint('J1', [pad('1', at, pt(1, 1))]);
const J2 = (at: Pt): Footprint => footprint('J2', [pad('1', at, pt(1, 1))]);
const between = (b: Board, parallel = false): { amps: number; items: string[] } => pairCapacity(netGraph(b, 'P', conditions()).edges, padNode('J1.1'), padNode('J2.1'), parallel);

test('the widest path ignores a thin branch and finds a thin bottleneck', () => {
  const edges = [edge('A', 'x', 3, 'wide1'), edge('x', 'B', 3, 'wide2'), edge('x', 'C', 0.8, 'branch'), edge('B', 'D', 0.8, 'thin'), edge('D', 'E', Infinity, 'zone')];
  assert.deepEqual(widestPath(edges, 'A', 'B'), { amps: 3, items: ['wide1', 'wide2'] });
  const far = widestPath(edges, 'A', 'E');
  assert.equal(far.amps, 0.8);
  assert.ok(far.items.includes('thin'));
});

test('parallel paths do not add on the widest path, and do in the max flow', () => {
  const edges = [edge('A', 'B', 1, 'p1'), edge('A', 'm', 1, 'p2a'), edge('m', 'B', 1, 'p2b')];
  assert.equal(widestPath(edges, 'A', 'B').amps, 1);
  const flow = maxFlow(edges, 'A', 'B');
  assert.equal(flow.amps, 2);
  assert.ok(flow.items.includes('p1'));
  assert.equal(flow.items.length, 2);
});

test('no path is zero amps', () => {
  assert.deepEqual(widestPath([edge('A', 'x', 3, 'w')], 'A', 'B'), { amps: 0, items: [] });
  assert.deepEqual(maxFlow([edge('A', 'x', 3, 'w')], 'A', 'B'), { amps: 0, items: [] });
});

test('a series chain gives its minimum, in either direction', () => {
  assert.deepEqual(maxFlow([edge('A', 'x', 3, 'w1'), edge('x', 'y', 0.8, 'thin'), edge('y', 'B', 2, 'w2')], 'A', 'B'), { amps: 0.8, items: ['thin'] });
  assert.deepEqual(maxFlow([edge('B', 'A', 1.5, 'e')], 'A', 'B'), { amps: 1.5, items: ['e'] });
});

test('a zone is unlimited, and a path of only zones is infinite', () => {
  assert.equal(maxFlow([edge('A', 'z', Infinity, 'zone'), edge('z', 'B', Infinity, 'zone')], 'A', 'B').amps, Infinity);
  assert.deepEqual(maxFlow([edge('A', 'z', Infinity, 'zone'), edge('z', 'B', 0.5, 'v1'), edge('z', 'B', 0.5, 'v2')], 'A', 'B'), { amps: 1, items: ['v1', 'v2'] });
});

test('a point projects onto a segment, clamped', () => {
  assert.deepEqual(project([0, 0], [10, 0], [4, 3]), [4, 0]);
  assert.deepEqual(project([0, 0], [10, 0], [-5, 1]), [0, 0]);
  assert.deepEqual(project([0, 0], [0, 10], [1, 12]), [0, 10]);
});

test('spec pairs come from pads or chains, with the parallel flag of the chain or the net', () => {
  const spec = jsonLoads('{"A": {"amps": 1.0, "parallel": true, "pads": ["U1.1", "C1.1"]}, "B": {"chains": [{"amps": 2, "parallel": true, "pads": ["U2.6", "C2.1"]}, {"amps": 0.5, "pads": ["C2.1", "U7.1", "J1.1"]}]}}') as Map<string, unknown>;
  assert.deepEqual(specPairs(spec).map(p => [p.net, p.from, p.to, p.text, p.parallel]), [
    ['A', 'U1.1', 'C1.1', '1.0', true], ['B', 'U2.6', 'C2.1', '2', true], ['B', 'C2.1', 'U7.1', '0.5', false], ['B', 'U7.1', 'J1.1', '0.5', false]]);
});

test('one track between two pads carries its IPC current, with no neck credit from pads', () => {
  const { amps, items } = between(board([track(pt(0, 0), pt(10, 0))], [J1(pt(0, 0)), J2(pt(10, 0))]));
  assert.ok(Math.abs(amps - ipcAmps(1)) < 1e-9);
  assert.deepEqual(items.filter(label => label !== 'pad'), ['F.Cu 1.0 mm (0.0, 0.0)-(10.0, 0.0)']);
});

test('no copper between two pads is no path', () => {
  assert.deepEqual(between(board([], [J1(pt(0, 0)), J2(pt(10, 0))])), { amps: 0, items: [] });
});

test('a track drawn twice counts once, the wider one, and a parallel track adds', () => {
  const twice = board([track(pt(0, 0), pt(10, 0), 0.5), track(pt(10, 0), pt(0, 0), 1)], [J1(pt(0, 0)), J2(pt(10, 0))]);
  assert.ok(Math.abs(between(twice, true).amps - ipcAmps(1)) < 1e-9);
  const beside = board([track(pt(0, 0), pt(10, 0)), track(pt(0, 0.5), pt(10, 0.5))], [J1(pt(0, 0)), J2(pt(10, 0))]);
  assert.ok(Math.abs(between(beside, true).amps - 2 * ipcAmps(1)) < 1e-9);
});

test('a branch of the same width gives no thermal uplift', () => {
  const capacities = (copper: RoutedCopper[]): number[] => netGraph(board(copper, []), 'P', conditions()).edges.filter(e => e.label.startsWith('F.Cu')).map(e => e.amps);
  const rail = track(pt(0, 0), pt(5, 0), 0.2);
  assert.deepEqual(capacities([rail]), [ipcAmps(0.2)]);
  assert.ok(capacities([rail, track(pt(2.5, 0), pt(2.5, 0.1), 0.2)]).every(amps => amps === ipcAmps(0.2)));
});

test('a short neck between two pads stays a plain IPC track', () => {
  const b = board([track(pt(0, 0), pt(1, 0), 0.2)], [J1(pt(-0.9, 0)), J2(pt(1.9, 0))]);
  assert.ok(Math.abs(between(b).amps - ipcAmps(0.2)) < 1e-9);
});

test('a T junction splits a track', () => {
  const b = board([track(pt(0, 0), pt(10, 0)), track(pt(5, 0), pt(5, 5), 0.5)], [J1(pt(0, 0)), J2(pt(5, 5))]);
  const { items } = between(b);
  assert.ok(items.includes('F.Cu 1.0 mm (0.0, 0.0)-(5.0, 0.0)'), String(items));
});

test('vias in parallel join the same copper and their barrels add; one duplicate does not', () => {
  const across = (copper: RoutedCopper[]): Board => {
    const front = track(pt(0, 0), pt(10, 0), 5);
    const back = track(pt(0, 0), pt(10, 0), 5, { layer: 'B.Cu' });
    return board([front, back, ...copper], [J1(pt(0, 0)), footprint('J2', [pad('1', pt(10, 0), pt(1, 1), { layers: ['B.Cu'] })])]);
  };
  const single = between(across([via(pt(5, 0))]), true);
  assert.ok(Math.abs(single.amps - viaGroupAmps([0.3])) < 1e-9, String(single.amps));
  assert.deepEqual(single.items, ['via drill 0.30 at (5.0, 0.0)']);
  const duplicate = between(across([via(pt(5, 0)), via(pt(5, 0), 0.25)]), true);
  assert.ok(Math.abs(duplicate.amps - viaGroupAmps([0.25])) < 1e-9, 'coincident vias take the smallest drill');
  const graph = netGraph(board([via(pt(5, 0)), via(pt(6, 0))], [footprint('J1', [pad('1', pt(5.5, 0), pt(1, 1))]), footprint('J2', [pad('1', pt(5.5, 0), pt(1, 1), { layers: ['B.Cu'] })])]), 'P', conditions());
  assert.ok(graph.edges.some(e => e.label === '2 vias in parallel (drill 0.30-0.30) at (5.0, 0.0)'), String(graph.edges.map(e => e.label)));
  assert.ok(Math.abs(graph.edges.find(e => e.label.startsWith('2 vias'))!.amps - viaGroupAmps([0.3, 0.3])) < 1e-9);
});

const blind = (at: Pt): RoutedCopper => ({ Via: { ...(via(at) as { Via: Via }).Via, layers: ['F.Cu', 'In1.Cu'] } });
const inner = (copper: RoutedCopper[], footprints: Footprint[] = [], zones: Zone[] = []): Board => ({ ...board(copper, footprints, zones), copper_layers: ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] });
const onBack = { layers: ['B.Cu'] };
const viaNodes = (b: Board): Set<string> => new Set(netGraph(b, 'P', conditions()).edges.flatMap(e => [e.u, e.v]).filter(node => node.startsWith('v|')));

test('two vias at one spot with different spans stay two conductors', () => {
  const front = track(pt(0, 0), pt(10, 0)), back = track(pt(0, 0), pt(10, 0), 1, { layer: 'B.Cu' });
  assert.equal(viaNodes(inner([front, back, via(pt(0, 0)), via(pt(0, 0))])).size, 1);
  assert.equal(viaNodes(inner([front, back, via(pt(0, 0)), blind(pt(0, 0))])).size, 2);
});

test('a blind via makes no path from the front to the back', () => {
  const pads = [J1(pt(0, 0)), footprint('J2', [pad('1', pt(10, 0), pt(1, 1), onBack)])];
  const copper = [track(pt(0, 0), pt(10, 0)), track(pt(0, 0), pt(10, 0), 1, { layer: 'B.Cu' }), blind(pt(5, 0))];
  assert.equal(between(inner(copper, pads)).amps, 0);
});

test('a blind via does not touch a pad on the back', () => {
  const pads = [J1(pt(0, 0)), footprint('J2', [pad('1', pt(0, 0), pt(1, 1), onBack)])];
  assert.equal(between(inner([blind(pt(0, 0))], pads)).amps, 0);
});

test('a via that is not on a layer does not cut the track there', () => {
  const pieces = (extra: RoutedCopper[]): number => netGraph(inner([track(pt(0, 0), pt(10, 0), 1, { layer: 'B.Cu' }), ...extra]), 'P', conditions()).edges.filter(e => !e.label.startsWith('via')).length;
  assert.equal(pieces([blind(pt(5, 0))]), pieces([]));
  assert.ok(pieces([via(pt(5, 0))]) > pieces([]));
});

test('a blind via does not join a pour on a layer it does not reach', () => {
  const pads = [J1(pt(0, 0)), footprint('J2', [pad('1', pt(10, 0), pt(1, 1), onBack)])];
  const pour = plane('B.Cu', [box(-5, -5, 15, 5)], 'Full');
  assert.equal(between(inner([blind(pt(0, 0))], pads, [pour])).amps, 0);
  assert.ok(between(inner([via(pt(0, 0))], pads, [pour])).amps > 0);
});

test('a pad in a pour joins it solid or through two thermal spokes', () => {
  const pads = [J1(pt(0, 0)), J2(pt(10, 0))];
  const solid = between(board([], pads, [plane('F.Cu', [box(-5, -5, 15, 5)], 'Full')]));
  assert.equal(solid.amps, Infinity);
  assert.ok(solid.items.includes('zone F.Cu solid'), String(solid.items));
  const thermal = between(board([], pads, [plane('F.Cu', [box(-5, -5, 15, 5)])]));
  assert.ok(Math.abs(thermal.amps - 2 * ipcAmps(0.5)) < 1e-9);
  assert.ok(thermal.items.includes('zone F.Cu thermal 2 x 0.5 mm spokes to J1.1'), String(thermal.items));
});

test('a pad on its own override ignores the zone default, and two islands do not join', () => {
  const pads = [footprint('J1', [pad('1', pt(0, 0), pt(1, 1), { zone_connection: 'Full' })]), footprint('J2', [pad('1', pt(10, 0), pt(1, 1), { zone_connection: 'Full' })])];
  assert.equal(between(board([], pads, [plane('F.Cu', [box(-5, -5, 15, 5)])])).amps, Infinity);
  assert.equal(between(board([], pads, [plane('F.Cu', [box(-5, -5, 3, 5), box(7, -5, 15, 5)])])).amps, 0);
});

test('a neck into a same-net plane is credited at both ends', () => {
  const b = board([track(pt(2, 0), pt(4, 0), 0.25)], [J1(pt(0, 0)), J2(pt(6, 0))], [plane('F.Cu', [box(-2, -2, 2.5, 2), box(3.5, -2, 8, 2)], 'Full')]);
  const { amps, items } = between(b);
  assert.ok(amps > ipcAmps(0.25), String(amps));
  assert.ok(items.some(label => label.includes('(neck 2.00 mm, end evidence)')), String(items));
});

const RATINGS: PinRatings = { TEST: { mpn: ['TEST'], pins: { 1: { amps: 2.7, name: 'SW', source: 'page 5', statistic: 'max' } } } };
const escape = (length: number): Board => board([track(pt(0, 0), pt(length, 0), 0.4)], [
  footprint('U1', [pad('1', pt(0, 0), pt(0.2, 0.3))], 'TEST'), footprint('J2', [pad('1', pt(length, 0), pt(1, 1))])]);

test('a short track from a rated pad carries the pin rating, a long one does not', () => {
  const graph = netGraph(escape(0.5), 'P', conditions(RATINGS));
  const item = graph.edges.find(e => e.label.includes('pin escape'));
  assert.equal(item?.amps, 2.7);
  assert.equal(item?.label, 'F.Cu 0.4 mm (0.0, 0.0)-(0.5, 0.0) (pin escape of U1.1: TEST pin 1 SW 2.7 A (page 5))');
  assert.ok(!netGraph(escape(1), 'P', conditions(RATINGS)).edges.some(e => e.label.includes('pin escape')));
});

test('a split does not turn a long physical track into a pin escape', () => {
  const b = escape(1);
  b.copper.push(track(pt(0.3, 0), pt(0.3, 0.1), 0.4));
  assert.ok(!netGraph(b, 'P', conditions(RATINGS)).edges.some(e => e.label.includes('pin escape')));
});

const report = (b: Board, spec: string): { lines: string[]; code: number } => {
  const lines: string[] = [];
  const code = powerPathReport(b, jsonLoads(spec), { limit: 4, verbose: true, print: line => lines.push(line), supplies: () => new Map([['+5V', 'net name']]) });
  return { lines, code };
};

test('the report words a pass, a low pair, no path, a stranger pad and a missing supply', () => {
  const b = board([track(pt(0, 0), pt(10, 0))], [J1(pt(0, 0)), J2(pt(10, 0))]);
  const ok = report(b, '{"nets": {"P": {"amps": 1.5, "pads": ["J1.1", "J2.1"]}}, "exempt": [{"net": "+5V", "reason": "sense only"}]}');
  assert.deepEqual(ok.lines, [`OK  P J1.1->J2.1: ${ipcAmps(1).toFixed(2)} A >= 1.5 A`, '0 power-path pairs below the design current', '0 supply nets not covered']);
  assert.equal(ok.code, 0);
  const low = report(b, '{"nets": {"P": {"amps": 50.0, "pads": ["J1.1", "J2.1", "U9.1"]}}}');
  assert.equal(low.lines[0], `LOW P J1.1->J2.1: ${ipcAmps(1).toFixed(2)} A < 50.0 A; 1 items under: F.Cu 1.0 mm (0.0, 0.0)-(10.0, 0.0)`);
  assert.equal(low.lines[1], "LOW P J2.1->U9.1: pads not on this net: ['U9.1']");
  assert.deepEqual(low.lines.slice(2), ['2 power-path pairs below the design current', 'MISSING +5V (net name): supply net not in the spec nets or exempt list', '1 supply nets not covered']);
  assert.equal(low.code, 1);
  const none = report(board([], [J1(pt(0, 0)), J2(pt(10, 0))]), '{"nets": {"P": {"amps": 1, "pads": ["J1.1", "J2.1"]}}, "exempt": [{"net": "+5V", "reason": null}]}');
  assert.equal(none.lines[0], 'LOW P J1.1->J2.1: no copper path (need 1 A)');
});

test('blind, buried and micro vias are found in the board text, as words or as a type', () => {
  assert.equal(spanViaKind('(via\n\t(at 1 2)\n\t(size 0.6)\n)'), null);
  assert.equal(spanViaKind('(via blind\n\t(at 1 2)\n)'), 'blind');
  assert.equal(spanViaKind('(via micro (at 1 2))'), 'micro');
  assert.equal(spanViaKind('(via\n\t(type buried)\n\t(at 1 2)\n)'), 'buried');
  assert.equal(spanViaKind('(gr_text "via blind" (at 1 2))'), null);
});
