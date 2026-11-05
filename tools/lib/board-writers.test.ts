// The pure parts of the tools that write a board: pcbtool's commands, pixel-art, fp_keepouts, silk_jlc, on small fixtures.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { areasOnBoard, ripPlan, touching, type KeepoutSpec } from '../fp_keepouts.ts';
import { artRectangles, parseArt, png, runs } from '../pixel-art.ts';
import { raisedText, silkItems, underMinimum } from '../silk_jlc.ts';
import { BoardEdit } from './board-edit.ts';
import { circleText, rectText, ruleAreaText, textText, trackText, viaText } from './board-items.ts';
import { polygonNearTrack } from './board-hit.ts';
import type { Board, Pad, Polygon, Track, Via, Zone } from './board-types.ts';
import { artItems, netDomain, stitchSpots, tracksToWiden } from './pcbtool-write.ts';
import { seigaiha } from './seigaiha.ts';

const mm = (value: number): number => value * 1e6;
const track = (id: string, net: string, x0: number, y0: number, x1: number, y1: number, width = 0.2, layer = 'F.Cu'): Track =>
  ({ id, start: { x: mm(x0), y: mm(y0) }, end: { x: mm(x1), y: mm(y1) }, mid: null, width: mm(width), layer, net, locked: false });
const via = (id: string, net: string, x: number, y: number): Via => ({ id, at: { x: mm(x), y: mm(y) }, size: mm(0.6), drill: mm(0.3), net, locked: false, layers: ['F.Cu', 'B.Cu'] });
const box = (x0: number, y0: number, x1: number, y1: number): Polygon =>
  ({ outline: [{ x: mm(x0), y: mm(y0) }, { x: mm(x1), y: mm(y0) }, { x: mm(x1), y: mm(y1) }, { x: mm(x0), y: mm(y1) }], holes: [] });
const area = (name: string, polygon: Polygon, rule: Partial<NonNullable<Zone['rule_area']>> = {}): Zone =>
  ({ id: name, name, net: '', layers: ['F.Cu'], outline: [polygon], filled: [], rule_area: { tracks: true, vias: true, pour: true, pads: false, footprints: false, ...rule }, fill: null });
const board = (copper: (Track | Via)[], zones: Zone[] = [], pads: Pad[] = []): Board => ({
  path: '', copper_layers: ['F.Cu', 'B.Cu'], stackup: [], nets: {}, zones, graphics: [], texts: [], groups: [], constraints: { min_clearance: 0, min_track_width: 0, min_via_size: 0, copper_edge_clearance: 0 }, edges_bbox: { left: 0, top: 0, right: 0, bottom: 0 }, outlines: [],
  copper: copper.map(item => ('at' in item ? { Via: item } : { Track: item })),
  footprints: pads.length ? [{ id: 'f', reference: 'U1', value: '', lib_id: '', layer: 'F.Cu', position: { x: 0, y: 0 }, orientation: 0, locked: false, clearance_override: null, fields: [], pads, graphics: [], zones: [], courtyard_front: [], courtyard_back: [] }] : [],
});

test('widen picks the thinner tracks of the net, on the layer, inside the box', () => {
  const copper = board([track('a', 'N', 1, 1, 2, 1, 0.15), track('b', 'N', 1, 1, 2, 1, 0.3), track('c', 'M', 1, 1, 2, 1, 0.15),
    track('d', 'N', 1, 1, 2, 1, 0.15, 'B.Cu'), track('e', 'N', 1, 1, 9, 1, 0.15), via('v', 'N', 1, 1)]);
  const ids = (options: Parameters<typeof tracksToWiden>[3]): string[] => tracksToWiden(copper, 'N', 0.2, options).map(item => item.id);
  assert.deepEqual(ids({}), ['a', 'd', 'e']);
  assert.deepEqual(ids({ layer: 'F.Cu' }), ['a', 'e']);
  assert.deepEqual(ids({ box: [0, 0, 5, 5] }), ['a', 'd']);
});

test('a track at the asked width is not narrower', () => {
  assert.deepEqual(tracksToWiden(board([track('a', 'N', 1, 1, 2, 1, 0.2)]), 'N', 0.2, {}), []);
});

test('a net finds its ground domain: itself, a pattern, most pads, the only ground', () => {
  assert.equal(netDomain('GND', [], ['GND', 'ISO'], {}), 'GND');
  assert.equal(netDomain('/A', [], ['GND', 'ISO'], { ISO: ['/A*'] }), 'ISO');
  assert.equal(netDomain('/B', ['ISO', 'ISO', 'GND', null], ['GND', 'ISO'], {}), 'ISO');
  assert.equal(netDomain('/C', ['ISO', 'GND'], ['GND', 'ISO'], {}), null);
  assert.equal(netDomain('/D', [], ['GND'], {}), 'GND');
});

test('stitch spots start on the outer ring at angle 0', () => {
  const spots = [...stitchSpots([10, 10], 1)];
  assert.equal(spots.length, 4 * 36);
  assert.deepEqual(spots[0], [10.97, 10]);
  assert.deepEqual(spots[36], [10.9, 10]);
});

test('seigaiha draws upper arcs, and a lower row hides part of the row above', () => {
  const arcs = seigaiha([0, 0, 8, 6], 2, 2);
  assert.ok(arcs.length > 0);
  assert.ok(arcs.every(arc => arc.from >= 180 && arc.to <= 360));
  assert.ok(arcs.some(arc => arc.to - arc.from < 180));
});

test('art on the back is mirrored text; a vertical text is one item per letter', () => {
  let n = 0;
  const items = artItems({ texts: [{ text: 'AB', at: [1, 2], size: 1, vertical: true, line: 2 }] }, 'B.SilkS', () => `id${n++}`);
  assert.equal(items.length, 2);
  assert.match(items[1]!.text, /\(at 1 4 0\)/);
  assert.match(items[1]!.text, /\(justify mirror\)/);
});

test('bold text takes KiCad\'s stroke, not the one of the spec', () => {
  const [bold, thin] = artItems({ texts: [{ text: 'B', at: [0, 0], size: 2, thickness: 0.1, bold: true }, { text: 'T', at: [0, 0], size: 2, thickness: 0.1 }] }, 'F.SilkS', () => 'id');
  assert.match(bold!.text, /\(thickness 0\.4\)\n\t+\(bold yes\)/);
  assert.match(thin!.text, /\(thickness 0\.1\)/);
  assert.doesNotMatch(thin!.text, /justify|bold/);
});

test('a font face goes in the font form before the size', () => {
  assert.match(textText({ text: 'F', at: [0, 0], size: 1, thickness: 0.15, face: 'Arial', layer: 'F.SilkS', uuid: 'u' }), /\(font\n\t+\(face "Arial"\)\n\t+\(size 1 1\)/);
});

test('new items are forms BoardEdit can find again by uuid', () => {
  const texts = [trackText({ start: [0, 0], end: [1, 0], width: 0.2, layer: 'F.Cu', net: 'N', uuid: 'u1' }), viaText({ at: [1, 1], size: 0.6, drill: 0.3, net: 'N', uuid: 'u2' }),
    rectText({ start: [0, 0], end: [1, 1], width: 0.16, filled: true, layer: 'F.SilkS', uuid: 'u3' }), circleText({ center: [0, 0], end: [1, 0], width: 0.2, filled: false, layer: 'F.SilkS', uuid: 'u4' }),
    ruleAreaText({ name: 'U1 KO A', layers: ['F.Cu', 'B.Cu'], notAllowed: new Set(['tracks', 'pour']), points: [[0, 0], [1, 0], [1, 1]], uuid: 'u5' })];
  const edit = new BoardEdit(`(kicad_pcb\n${texts.join('')})\n`);
  for (const uuid of ['u1', 'u2', 'u3', 'u4', 'u5']) assert.ok(edit.textOf(uuid));
  assert.match(edit.textOf('u5'), /\(tracks not_allowed\)\n\t+\(vias allowed\)\n\t+\(pads allowed\)\n\t+\(copperpour not_allowed\)/);
});

test('a bitmap is read past its comments, and bad ones are refused', () => {
  assert.deepEqual(parseArt('; c\n.#\n##\n', 'p'), ['.#', '##']);
  assert.throws(() => parseArt('; only\n', 'p'), /p: no pixel rows/);
  assert.throws(() => parseArt('#\n##\n', 'p'), /p: rows have different lengths/);
  assert.throws(() => parseArt('#x\n', 'p'), /p: characters other than # and \.: \['x'\]/);
});

test('each horizontal run of pixels is one piece', () => {
  assert.deepEqual(runs(['##.#', '....']), [{ row: 0, first: 0, last: 1 }, { row: 0, first: 3, last: 3 }]);
});

test('a rectangle is inset by half its stroke, and the back is mirrored in x', () => {
  const place = { x: 10, y: 10, pixel: 0.5 };
  const front = artRectangles(['#.'], { ...place, layer: 'F.SilkS' }, () => 'u')[0]!.text;
  const back = artRectangles(['#.'], { ...place, layer: 'B.SilkS' }, () => 'u')[0]!.text;
  assert.match(front, /\(start 9\.58 9\.83\)\n\t+\(end 9\.92 10\.17\)/);
  assert.match(back, /\(start 10\.08 9\.83\)\n\t+\(end 10\.42 10\.17\)/);
  assert.match(front, /\(fill yes\)/);
});

test('the preview is a PNG of the bitmap in ink and mask green', () => {
  const data = png(['#']);
  assert.equal(data.subarray(1, 4).toString('latin1'), 'PNG');
  const side = (1 + 4) * 16;
  assert.equal(data.readUInt32BE(16), side);
  const start = data.indexOf('IDAT') + 4;
  const raw = inflateSync(data.subarray(start, data.length - 16));
  const row = 2 * 16 * (1 + side * 3);
  assert.deepEqual([...raw.subarray(row + 1, row + 4)], [0x1e, 0x4d, 0x2b]);
  assert.deepEqual([...raw.subarray(row + 1 + 2 * 16 * 3, row + 4 + 2 * 16 * 3)], [0xf4, 0xf4, 0xf0]);
});

const SPEC: KeepoutSpec = { areas_fp_mm: [{ name: 'A', rect: [-1, -1, 1, 1] }], layers: ['F.Cu'], not_allowed: ['tracks'] };

test('keep-out rectangles follow the footprint pose', () => {
  assert.deepEqual(areasOnBoard([10, 20], 0, SPEC)[0]!.points, [[9, 19], [11, 19], [11, 21], [9, 21]]);
  assert.deepEqual(areasOnBoard([103.6, 119.2], -90, { ...SPEC, areas_fp_mm: [{ name: 'P', rect: [0, 0, 1, 2] }] })[0]!.points,
    [[103.6, 119.2], [103.6, 120.2], [101.6, 120.2], [101.6, 119.2]]);
});

const KO = area('U1 KO A', box(4, 4, 6, 6));

test('copper touches an area through its width; a track that only reaches the edge does not', () => {
  const copper = [track('in', 'N', 5, 5, 7, 5), track('near', 'N', 3.95, 3, 3.95, 8, 0.2), track('edge', 'N', 3.9, 3, 3.9, 8, 0.2), via('v', 'N', 3.8, 5), track('b', 'N', 5, 5, 7, 5, 0.2, 'B.Cu')];
  assert.deepEqual(touching(board(copper, [KO]), 'U1').map(hit => hit.item.id), ['in', 'near', 'v']);
});

test('a rule area reaches only what it forbids, other areas are not read', () => {
  const copper = [track('t', 'N', 5, 5, 7, 5), via('v', 'N', 5, 5)];
  assert.deepEqual(touching(board(copper, [area('U1 KO A', box(4, 4, 6, 6), { tracks: false })]), 'U1').map(hit => hit.item.id), ['v']);
  assert.deepEqual(touching(board(copper, [area('U2 KO A', box(4, 4, 6, 6))]), 'U1'), []);
});

test('an arc through an area touches it, an arc round it does not', () => {
  const arc = (y: number): Track => ({ ...track('a', 'N', 0, y, 10, y), mid: { x: mm(5), y: mm(y + 1) } });
  assert.equal(polygonNearTrack(box(4, 4, 6, 6), arc(4)), true);
  assert.equal(polygonNearTrack(box(4, 4, 6, 6), arc(8)), false);
});

test('rip removes the copper in the area and the chain it leaves dangling, pass by pass', () => {
  const plan = ripPlan(board([track('hit', 'N', 5, 5, 8, 5), track('next', 'N', 8, 5, 10, 5), track('last', 'N', 10, 5, 12, 5), track('other', 'M', 8, 8, 9, 8)], [KO]), 'U1');
  assert.equal(plan.hits, 1);
  assert.deepEqual([...plan.ids], ['hit', 'next', 'last']);
  assert.equal(plan.pruned, 2);
  assert.deepEqual(plan.nets, ['N']);
  assert.equal(plan.lines[0], '  rip [U1 KO A] track N F.Cu (5.0,5.0)->(8.0,5.0)');
});

test('a chain of a net with a pour stays: its ends anchor in the fill', () => {
  const pour: Zone = { ...area('pour', box(0, 0, 1, 1)), rule_area: null, net: 'N' };
  assert.deepEqual([...ripPlan(board([track('hit', 'N', 5, 5, 8, 5), track('next', 'N', 8, 5, 10, 5)], [KO, pour]), 'U1').ids], ['hit']);
});

const SILK = `(kicad_pcb
\t(layers
\t\t(5 "F.SilkS" user "F.Silkscreen")
\t)
\t(gr_text "low"
\t\t(layer "F.SilkS")
\t\t(uuid "t1")
\t\t(effects (font (size 0.8 0.7) (thickness 0.1)))
\t)
\t(gr_text "cu"
\t\t(layer "F.Cu")
\t\t(uuid "t2")
\t\t(effects (font (size 0.8 0.8) (thickness 0.1)))
\t)
\t(gr_poly
\t\t(stroke (width 0.05) (type default))
\t\t(fill yes)
\t\t(layer "F.SilkS")
\t\t(uuid "p1")
\t)
\t(gr_line
\t\t(stroke (width 0.1) (type default))
\t\t(layer "B.SilkS")
\t\t(uuid "l1")
\t)
\t(footprint "x"
\t\t(property "Reference" "U1"
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "r1")
\t\t\t(effects (font (size 1 1) (thickness 0.15)))
\t\t)
\t\t(property "Value" "V"
\t\t\t(layer "F.SilkS")
\t\t\t(hide yes)
\t\t\t(uuid "v1")
\t\t\t(effects (font (size 0.5 0.5) (thickness 0.05)))
\t\t)
\t\t(fp_circle
\t\t\t(stroke (width 0.06) (type default))
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "c1")
\t\t)
\t)
)
`;

test('silk items are the visible ones on silk: board first, then footprints', () => {
  assert.deepEqual(silkItems(SILK).map(item => [item.owner, item.uuid, item.kind]),
    [['board', 't1', 'text'], ['board', 'p1', 'shape'], ['board', 'l1', 'shape'], ['U1', 'r1', 'text'], ['U1', 'c1', 'shape']]);
});

test('under the minimum: a low or thin text, a thin stroke, but no filled polygon', () => {
  assert.deepEqual(silkItems(SILK).filter(underMinimum).map(item => item.uuid), ['t1', 'l1', 'c1']);
});

test('a text scales to 1 mm in proportion and its stroke follows', () => {
  assert.deepEqual(raisedText({ height: 0.8, width: 0.7, thickness: 0.1 }), { height: 1, width: 0.875, thickness: 0.1667 });
  assert.deepEqual(raisedText({ height: 2, width: 2, thickness: 0.1 }), { height: 2, width: 2, thickness: 0.3333 });
});
