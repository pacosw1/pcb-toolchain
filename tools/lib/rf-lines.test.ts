import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Board, Footprint, Pad, Polygon, Pt, RoutedCopper, Track, Via, Zone } from './board-types.ts';
import { jsonLoads } from './py-compat.mjs';
import { gcpwImpedance, readRfSpec, rfChecks, type RfCheck } from './rf-lines.ts';

const MM = 1_000_000;
const pt = (x: number, y: number): Pt => ({ x: Math.round(x * MM), y: Math.round(y * MM) });
const box = (x0: number, y0: number, x1: number, y1: number): Polygon => ({ outline: [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)], holes: [] });

const track = (start: Pt, end: Pt, fields: Partial<Track> = {}): RoutedCopper => ({
  Track: { id: 't', start, end, mid: null, width: 0.38 * MM, layer: 'F.Cu', net: '/RF', locked: false, ...fields },
});
const via = (at: Pt, net = 'GND'): RoutedCopper => ({ Via: { id: 'v', at, size: 0.6 * MM, drill: 0.3 * MM, net, locked: false } satisfies Via });
const zone = (net: string, layer: string, polygons: Polygon[], fields: Partial<Zone> = {}): Zone => ({
  id: 'z', name: '', net, layers: [layer], outline: polygons, filled: [{ layer, polygons }], rule_area: null, fill: null, ...fields,
});
const pad = (net: string, center: Pt, half: number, layers = ['F.Cu']): Pad => ({
  id: 'p', number: '1', kind: 'Smd', shape: 'Rect', net, position: center, orientation: 0, size: pt(half * 2, half * 2), drill: pt(0, 0), layers,
  bbox: { left: 0, top: 0, right: 0, bottom: 0 }, zone_connection: null, thermal_spoke_angle: 0, spoke_templates: 0, copper: [],
  polygons: { 'F.Cu': box(center.x / MM - half, center.y / MM - half, center.x / MM + half, center.y / MM + half) }, solder_mask_expansion: 0,
});
const footprint = (pads: Pad[], zones: Zone[] = []): Footprint => ({
  id: 'f', reference: 'U1', value: '', lib_id: '', layer: 'F.Cu', position: pt(0, 0), orientation: 0, locked: false, fields: [], pads, graphics: [], zones,
  courtyard_front: [], courtyard_back: [],
});

/** A line along y = 10 from x = 0 to 10, in a ground pour with its gap cut out, a solid reference and a via fence on both sides. */
function goodBoard(): Board {
  const fence = [0, 2, 4, 6, 8, 10].flatMap(x => [via(pt(x, 9.3)), via(pt(x, 10.7))]);
  return {
    path: 'x', copper_layers: ['F.Cu', 'In1.Cu'], stackup: [], nets: {}, footprints: [], graphics: [], outlines: [],
    edges_bbox: { left: 0, top: 0, right: 0, bottom: 0 }, copper: [track(pt(0, 10), pt(10, 10)), ...fence],
    zones: [zone('GND', 'F.Cu', [box(-5, 0, 15, 9.61), box(-5, 10.39, 15, 20)]), zone('GND', 'In1.Cu', [box(-5, 0, 15, 20)])],
  };
}

const SPEC = `{"nets": ["/RF"], "layer": "F.Cu", "ref_layer": "In1.Cu", "ground": "GND", "width_mm": 0.38, "gap_mm": 0.20, "h_mm": 0.2104, "er": 4.4,
  "z_target": 50, "z_tol": 5, "width_tol_mm": 0.005, "gap_tol_mm": 0.03, "max_length_mm": 15, "fence_pitch_max_mm": 2.0, "fence_offset_max_mm": 1.0}`;
const spec = (changes = ''): ReturnType<typeof readRfSpec> => readRfSpec(jsonLoads(changes ? SPEC.replace(/}$/, `, ${changes}}`) : SPEC));
const failures = (checks: Iterable<RfCheck>): string[] => [...checks].filter(check => !check.ok).map(check => check.message);
const named = (checks: Iterable<RfCheck>, start: string): RfCheck => {
  const check = [...checks].find(c => c.message.startsWith(start));
  assert.ok(check, `no check starts with ${start}`);
  return check;
};

test('the impedance of the CELLULAR line', () => {
  const { z, eeff } = gcpwImpedance(0.38, 0.2, 0.2104, 4.4);
  assert.ok(Math.abs(z - 49.7) < 0.05, String(z));
  assert.ok(eeff > 1 && eeff < 4.4);
});

test('a good line passes every check', () => {
  assert.deepEqual(failures(rfChecks(goodBoard(), spec())), []);
});

test('spec numbers print as Python printed them', () => {
  const text = [...rfChecks(goodBoard(), spec())].map(check => check.message).join('\n');
  assert.match(text, /^Z\(W 0\.38, gap 0\.2, h 0\.2104, Er 4\.4\) = 49\.7 ohm \(eeff \d\.\d\d\); target 50 \+- 5$/m);
  assert.match(text, /pitch <= 2\.0, offset <= 1\.0 mm/);
});

test('a track off the width or layer is listed as a Python tuple', () => {
  const board = goodBoard();
  board.copper.push(track(pt(10, 10), pt(11, 10), { width: MM, layer: 'In1.Cu' }));
  const check = named(rfChecks(board, spec()), '2 RF tracks');
  assert.equal(check.ok, false);
  assert.ok(check.message.endsWith("wrong [('/RF', 1.0, 'In1.Cu')]"), check.message);
});

test('no track on the nets fails, and no sample is not a pass', () => {
  const board = goodBoard();
  board.copper = board.copper.filter(item => 'Via' in item);
  assert.equal(named(rfChecks(board, spec()), '0 RF tracks').ok, false);
  assert.equal(named(rfChecks(board, spec()), 'gap >=').ok, false);
});

test('a via on the nets fails', () => {
  const board = goodBoard();
  board.copper.push(via(pt(5, 10), '/RF'));
  assert.equal(named(rfChecks(board, spec()), 'RF vias: 1').ok, false);
});

test('a track drawn twice counts once in the length, either way round', () => {
  const board = goodBoard();
  board.copper.push(track(pt(10, 10), pt(0, 10)));
  assert.equal(named(rfChecks(board, spec()), 'RF track length').message, 'RF track length 10.00 mm (max 15)');
});

test('an arc of the nets is no line track, an arc of another net is copper', () => {
  const board = goodBoard();
  board.copper.push(track(pt(20, 0), pt(30, 0), { mid: pt(25, 5) }));
  assert.ok(named(rfChecks(board, spec()), '1 RF tracks').ok);
  const crossing = goodBoard();
  crossing.copper.push(track(pt(4, 9.6), pt(6, 9.6), { mid: pt(5, 9.8), net: '/OTHER', width: 0.1 * MM }));
  assert.equal(named(rfChecks(crossing, spec()), 'gap >=').ok, false);
});

test('each line of a spec has its own length, and every net must be named once', () => {
  const lines = '"lines": [{"name": "main", "nets": ["/RF"]}, {"name": "gnss", "nets": ["/GNSS"]}]';
  const checks = [...rfChecks(goodBoard(), spec(lines))];
  assert.equal(named(checks, 'lines must').message, "lines must name each net once: ['/GNSS', '/RF'] against nets ['/RF']");
  assert.equal(named(checks, 'lines must').ok, false);
  assert.equal(named(checks, 'main track').message, 'main track length 10.00 mm (max 15)');
  assert.equal(named(checks, 'gnss track').message, 'gnss track length 0.00 mm (max 15)');
});

test('samples beside a part of the line are not line samples', () => {
  const board = goodBoard();
  const samples = (b: Board): string => named(rfChecks(b, spec()), 'gap >=').message;
  assert.match(samples(board), /: 41 samples/);
  board.footprints.push(footprint([pad('/RF', pt(0, 10), 0.3), pad('/OTHER', pt(0, 12), 0.1)]));
  assert.match(samples(board), /: 36 samples/);
});

test('copper of another net in the gap fails, ground copper in the gap fails too', () => {
  for (const net of ['/OTHER', 'GND']) {
    const board = goodBoard();
    board.footprints.push(footprint([pad(net, pt(5, 9.65), 0.05)]));
    assert.equal(named(rfChecks(board, spec()), 'gap >=').ok, false, net);
  }
});

test('a gap cut too wide misses the coplanar ground', () => {
  const board = goodBoard();
  board.zones[0] = zone('GND', 'F.Cu', [box(-5, 0, 15, 9.3), box(-5, 10.39, 15, 20)]);
  const check = named(rfChecks(board, spec()), 'coplanar GND');
  assert.equal(check.ok, false);
  assert.match(check.message, /^coplanar GND within 0\.2 \+ 0\.03 mm on both sides: 41 misses \['\/RF \(0\.00, 10\.00\)'/);
});

test('misses show six entries, all with verbose', () => {
  const board = goodBoard();
  board.zones[1] = zone('GND', 'In1.Cu', [box(-5, 0, 15, 5)]);
  const count = (verbose: boolean): number => named(rfChecks(board, spec(), verbose), 'solid GND').message.split("'/RF").length - 1;
  assert.equal(count(false), 6);
  assert.equal(count(true), 41);
});

test('rule areas and footprint zones are not fill', () => {
  const board = goodBoard();
  board.zones[1] = zone('GND', 'In1.Cu', [box(-5, 0, 15, 20)], { rule_area: { tracks: true, vias: true, pour: true } });
  board.footprints.push(footprint([], [zone('GND', 'In1.Cu', [box(-5, 0, 15, 20)])]));
  assert.equal(named(rfChecks(board, spec()), 'solid GND').ok, false);
});

test('a fence via must be on each side, within the offset and half the pitch', () => {
  const board = goodBoard();
  board.copper = board.copper.filter(item => !('Via' in item && item.Via.at.y === pt(0, 10.7).y));
  const check = named(rfChecks(board, spec()), 'ground via fence');
  assert.equal(check.ok, false);
  assert.match(check.message, /: 41 misses /);
});
