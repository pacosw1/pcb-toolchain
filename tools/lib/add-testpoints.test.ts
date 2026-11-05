import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { planTestPoints, schematicWith, type Inputs, type TestPointsFile } from '../add_testpoints.ts';
import { readSilk } from './board-silk.ts';
import type { ProjectFile } from './board-obstacles.ts';
import type { Board, Graphic, RoutedCopper, Zone } from './board-types.ts';
import { atom, kids, layerOf, one, parse } from './sexpr.ts';
import { connector, fixtureBoard, fixtureText, footprint, pad, polygon, pt, silkLine } from './silk-fixture.ts';
import { shapeNear, shapeTouchesBox, TestPointBoard, type PadShape, type PointSpec } from './testpoint-place.ts';
import { embedLibSymbols, footprintText, libSymbol, padShape, sheetSpot, symbolSources, symbolText } from './testpoint-text.ts';

const library = (name: string, attributes: string, courtyard: number, padForm: string): string => `(footprint "${name}"
\t(version 20260206)
\t(generator "pcbnew")
\t(generator_version "10.0")
\t(layer "F.Cu")
\t(descr "test point")
\t(property "Reference" "REF**"
\t\t(at 0 -1.648 0)
\t\t(layer "F.SilkS")
\t\t(uuid "00000000-0000-0000-0000-000000000001")
\t\t(effects
\t\t\t(font
\t\t\t\t(size 1 1)
\t\t\t\t(thickness 0.15)
\t\t\t)
\t\t)
\t)
\t(property "Value" "${name}"
\t\t(at 0 1.75 0)
\t\t(layer "F.Fab")
\t\t(uuid "00000000-0000-0000-0000-000000000002")
\t)
\t(property "Description" ""
\t\t(at 0 0 0)
\t\t(layer "F.Fab")
\t\t(hide yes)
\t\t(uuid "00000000-0000-0000-0000-000000000003")
\t)
\t(attr ${attributes})
\t(fp_circle
\t\t(center 0 0)
\t\t(end ${courtyard} 0)
\t\t(stroke
\t\t\t(width 0.05)
\t\t\t(type solid)
\t\t)
\t\t(fill no)
\t\t(layer "F.CrtYd")
\t\t(uuid "00000000-0000-0000-0000-000000000004")
\t)
${padForm}\t(embedded_fonts no)
)
`;
const SMD = library('TestPoint_Pad_D1.5mm', 'exclude_from_pos_files exclude_from_bom', 1.25,
  '\t(pad "1" smd circle\n\t\t(at 0 0)\n\t\t(size 1.5 1.5)\n\t\t(layers "F.Cu" "F.Mask")\n\t\t(uuid "00000000-0000-0000-0000-000000000005")\n\t)\n');
const THT = library('TestPoint_THTPad_D2.5mm_Drill1.2mm', 'exclude_from_pos_files exclude_from_bom', 1.75,
  '\t(pad "1" thru_hole circle\n\t\t(at 0 0)\n\t\t(size 2.5 2.5)\n\t\t(drill 1.2)\n\t\t(layers "*.Cu" "*.Mask")\n\t\t(remove_unused_layers no)\n\t\t(uuid "00000000-0000-0000-0000-000000000006")\n\t)\n');
const SMD_PAD: PadShape = padShape(SMD);
const THT_PAD: PadShape = padShape(THT);

const SCHEMATIC = `(kicad_sch
\t(lib_symbols
\t\t(symbol "power:GND"
\t\t\t(pin "1")
\t\t)
\t)
\t(sheet_instances
\t\t(path "/")
\t)
)
`;
const PROJECT: ProjectFile = {
  net_settings: { classes: [{ name: 'Default', track_width: 0.2, clearance: 0.2, via_diameter: 0.6, via_drill: 0.3 }, { name: 'HV', track_width: 0.5, clearance: 1, via_diameter: 1, via_drill: 0.5 }] },
  board: { design_settings: { rules: { min_copper_edge_clearance: 0.3 } } },
};

const smd = (extra: Partial<PointSpec> = {}): PointSpec => ({ ref: 'TP1', net: '/A', kind: 'smd', near: [120, 120], ...extra });
const tht = (extra: Partial<PointSpec> = {}): PointSpec => smd({ kind: 'tht', ...extra });
const site = (board: Board, text = fixtureText(), classOf: (net: string) => number = () => 0.2): TestPointBoard => new TestPointBoard(board, readSilk(text), classOf);
const place = (board: Board, spec: PointSpec, shape = SMD_PAD) => site(board).place(spec, shape);
const mmAt = (spot: { at: { x: number; y: number } } | null): [number, number] => [spot!.at.x / 1e6, spot!.at.y / 1e6];

function track(net: string, x0: number, y0: number, x1: number, y1: number, width = 0.2, layer = 'F.Cu'): RoutedCopper {
  return { Track: { id: `t-${x0}-${y0}`, start: pt(x0, y0), end: pt(x1, y1), mid: null, width: width * 1e6, layer, net, locked: false } };
}
const via = (net: string, x: number, y: number): RoutedCopper => ({ Via: { id: `v-${x}`, at: pt(x, y), size: 600_000, drill: 300_000, net, locked: false, layers: ['F.Cu', 'B.Cu'] } });
const ruleArea = (x0: number, y0: number, x1: number, y1: number, layers = ['F.Cu']): Zone => ({
  id: 'k', name: 'KEEP', net: '', layers, outline: [polygon(x0, y0, x1, y1)], filled: [], fill: null, rule_area: { tracks: true, vias: true, pour: true, pads: true, footprints: true },
});
const board = (copper: RoutedCopper[] = [], extra: Partial<Board> = {}): Board => ({ ...fixtureBoard([]), copper, copper_layers: ['F.Cu', 'B.Cu'], ...extra });

test('the footprint size comes from the library: pad radius, courtyard and its stroke', () => {
  assert.deepEqual(SMD_PAD, { radius: 0.75, halfWidth: 1.3, halfHeight: 1.3 });
  assert.deepEqual(THT_PAD, { radius: 1.25, halfWidth: 1.8, halfHeight: 1.8 });
  assert.throws(() => padShape('(footprint "x"\n)\n'), /no pad or no circular courtyard/);
});

test('with nothing near, the point lands on its target', () => {
  assert.deepEqual(place(board(), smd()), { at: pt(120, 120), distance: 0, onTrack: false });
});

test('near may name a pad, and an unknown pad is an error', () => {
  const part = board([], { footprints: [connector()] });
  assert.deepEqual(site(part).target(smd({ near: 'J1.2' })), pt(131.25, 120));
  assert.throws(() => site(part).target(smd({ near: 'J1.9' })), /no pad J1.9/);
  assert.throws(() => site(part).target(smd({ near: 'J9.1' })), /no pad J9.1/);
});

test('the body stays 1.0 mm from U and J courtyards and 0.5 mm from others', () => {
  const near = (reference: string) => board([], { footprints: [footprint(reference, 120, 120, [], polygon(119, 119, 121, 121))] });
  // The courtyard grows by its 0.05 mm default stroke to 121.05. The body half is 1.3 mm.
  assert.deepEqual(mmAt(place(near('R1'), smd({ near: [122, 120] }))), [123, 120]);
  assert.deepEqual(mmAt(place(near('U1'), smd({ near: [122, 120] }))), [123.5, 120]);
  assert.deepEqual(mmAt(place(near('J1'), smd({ near: [122, 120] }))), [123.5, 120]);
});

test('a part with no courtyard stands for its pads', () => {
  const part = board([], { footprints: [footprint('R1', 120, 120, [pad('1', 'GND', 120, 120, 0.5)])] });
  assert.deepEqual(mmAt(place(part, smd({ near: [120, 120] }))), [117.5, 120]);
});

test('the place is the nearest free grid point within max_mm, or none', () => {
  const part = board([], { footprints: [footprint('R1', 120, 120, [], polygon(115, 115, 125, 125))] });
  assert.equal(place(part, smd({ max_mm: 4 })), null);
  const far = place(part, smd({ max_mm: 8 }));
  assert.equal(far!.distance, 28);
  assert.equal(far!.onTrack, false);
});

test('the footprint stays 1 mm inside the outline box', () => {
  assert.deepEqual(mmAt(place(board(), smd({ near: [100, 120] }))), [102.5, 120]);
});

test('the outline polygon counts: a cut-out keeps the pad and a ring round it out', () => {
  const part = board([], { outlines: [{ ...polygon(100, 100, 160, 140), holes: [polygon(118, 118, 122, 122).outline] }] });
  const spot = mmAt(place(part, smd()));
  assert.ok(spot[0] <= 118 - 2.3 || spot[0] >= 122 + 2.3 || spot[1] <= 118 - 2.3 || spot[1] >= 122 + 2.3, `${spot}`);
});

test('a pad of another net needs its clearance + 0.1 mm; the same net does not', () => {
  const copper = [track('GND', 122, 115, 122, 125, 0.2)];
  // Pad edge to track edge: 0.75 + 0.1 + 0.3 = 1.15 mm from the centre line, on the 0.25 mm grid. Default class 0.2 mm.
  assert.deepEqual(mmAt(place(board(copper), smd({ near: [121.5, 120] }))), [120.75, 120]);
  assert.deepEqual(mmAt(place(board([track('/A', 122, 115, 122, 125, 0.2)]), smd({ near: [121.5, 120], track_only: false })))[0], 122);
});

test('the class clearance of the net sets the gap, never less than 0.2 mm', () => {
  const copper = [track('GND', 122, 115, 122, 125, 0.2)];
  const wide = site(board(copper), fixtureText(), () => 1).place(smd({ near: [121.5, 120] }), SMD_PAD);
  assert.deepEqual(mmAt(wide), [120, 120]);
  const narrow = site(board(copper), fixtureText(), () => 0.05).place(smd({ near: [121.5, 120] }), SMD_PAD);
  assert.deepEqual(mmAt(narrow), [120.75, 120]);
});

test('smd looks at F.Cu copper only; tht at every layer', () => {
  const back = [track('GND', 120, 115, 120, 125, 0.2, 'B.Cu')];
  assert.deepEqual(mmAt(place(board(back), smd())), [120, 120]);
  assert.notDeepEqual(mmAt(place(board(back), tht(), THT_PAD)), [120, 120]);
});

test('a via of another net blocks every layer', () => {
  assert.notDeepEqual(mmAt(place(board([via('GND', 120, 120)]), smd())), [120, 120]);
});

test('a rule area on the layers keeps the pad out', () => {
  const zones = [ruleArea(119, 119, 121, 121)];
  assert.notDeepEqual(mmAt(place(board([], { zones }), smd())), [120, 120]);
  assert.deepEqual(mmAt(place(board([], { zones: [ruleArea(119, 119, 121, 121, ['B.Cu'])] }), smd())), [120, 120]);
  assert.notDeepEqual(mmAt(place(board([], { zones: [ruleArea(119, 119, 121, 121, ['B.Cu'])] }), tht(), THT_PAD)), [120, 120]);
});

test('a rule area of a footprint counts too; a plain zone does not', () => {
  const inside = { ...footprint('H1', 150, 130, []), zones: [ruleArea(119, 119, 121, 121)] };
  assert.notDeepEqual(mmAt(place(board([], { footprints: [inside] }), smd())), [120, 120]);
  assert.deepEqual(mmAt(place(board([], { zones: [{ ...ruleArea(119, 119, 121, 121), rule_area: null }] }), smd())), [120, 120]);
});

test('silk art and text keep the pad out: F.SilkS always, B.SilkS for tht only', () => {
  const art = (layer: string): Graphic => silkLine(118, 120, 122, 120, layer);
  assert.notDeepEqual(mmAt(place(board([], { graphics: [art('F.SilkS')] }), smd())), [120, 120]);
  assert.deepEqual(mmAt(place(board([], { graphics: [art('B.SilkS')] }), smd())), [120, 120]);
  assert.notDeepEqual(mmAt(place(board([], { graphics: [art('B.SilkS')] }), tht(), THT_PAD)), [120, 120]);
  const text = (layer: string): string => fixtureText(`\t(gr_text "T"\n\t\t(at 120 120 0)\n\t\t(layer "${layer}")\n\t\t(uuid "t1")\n\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 1 1)\n\t\t\t)\n\t\t)\n\t)\n`);
  assert.notDeepEqual(mmAt(site(board(), text('F.SilkS')).place(smd(), SMD_PAD)), [120, 120]);
  assert.deepEqual(mmAt(site(board(), text('B.SilkS')).place(smd(), SMD_PAD)), [120, 120]);
});

test('a shape collides by its stroke; only a filled one by its inside', () => {
  const frame = (filled: boolean): Graphic => ({ id: 'r', geometry: { Rect: { top_left: pt(110, 110), bottom_right: pt(130, 130) } }, layer: 'F.SilkS', width: 100_000, filled });
  assert.equal(shapeNear(frame(false), pt(120, 120), 1_000_000), false);
  assert.equal(shapeNear(frame(true), pt(120, 120), 1_000_000), true);
  assert.equal(shapeNear(frame(false), pt(110.9, 120), 1_000_000), true);
  assert.equal(shapeTouchesBox(frame(false), [119, 119, 121, 121]), false);
  assert.equal(shapeTouchesBox(frame(true), [119, 119, 121, 121]), true);
  assert.equal(shapeTouchesBox(frame(false), [109, 119, 111, 121]), true);
});

test('circles and arcs collide on their lines; an arc runs from start to end with the angle growing', () => {
  const circle: Graphic = { id: 'c', geometry: { Circle: { center: pt(120, 120), radius_point: pt(125, 120) } }, layer: 'F.SilkS', width: 100_000, filled: false };
  assert.equal(shapeNear(circle, pt(120, 115), 100_000), true);
  assert.equal(shapeNear(circle, pt(120, 120), 100_000), false);
  const arc: Graphic = { id: 'a', geometry: { Arc: { start: pt(125, 120), end: pt(120, 125), center: pt(120, 120) } }, layer: 'F.SilkS', width: 100_000, filled: false };
  assert.equal(shapeNear(arc, pt(123.5355, 123.5355), 100_000), true);
  assert.equal(shapeNear(arc, pt(116.4645, 116.4645), 100_000), false);
});

test('an smd point takes a track of its net before the grid', () => {
  const spot = place(board([track('/A', 118, 121, 125, 121)]), smd());
  assert.deepEqual(spot, { at: pt(120, 121), distance: 4, onTrack: true });
});

test('a track does not qualify on another net or layer, wider than the pad, as an arc, or for a tht point', () => {
  const arc: RoutedCopper = { Track: { id: 'a', start: pt(118, 121), end: pt(122, 121), mid: pt(120, 122), width: 200_000, layer: 'F.Cu', net: '/A', locked: false } };
  for (const copper of [track('/A', 118, 121, 125, 121, 0.2, 'B.Cu'), track('/A', 118, 121, 125, 121, 1.6), arc]) assert.equal(place(board([copper]), smd())!.onTrack, false);
  assert.equal(place(board([track('/A', 118, 121, 125, 121)]), tht(), THT_PAD)!.onTrack, false);
});

test('a point on a track keeps off vias of any net and pads of parts', () => {
  const copper = [track('/A', 118, 121, 125, 121), via('/A', 120, 121)];
  const spot = place(board(copper), smd());
  assert.ok(spot!.onTrack);
  assert.ok(Math.abs(spot!.at.x / 1e6 - 120) >= 1.05, `${spot!.at.x}`);
});

test('track_only never falls back to the grid', () => {
  assert.equal(place(board(), smd({ track_only: true })), null);
  assert.ok(place(board([track('/A', 118, 121, 125, 121)]), smd({ track_only: true }))!.onTrack);
});

test('each new point counts for the next: copper and courtyard', () => {
  const sites = site(board());
  const spec = smd();
  const first = sites.place(spec, SMD_PAD)!;
  sites.add(spec, first.at, SMD_PAD);
  const next = sites.place(smd({ ref: 'TP2', net: 'GND' }), SMD_PAD);
  assert.ok(Math.hypot(next!.at.x - first.at.x, next!.at.y - first.at.y) >= 3.1e6);
});

test('a pad keeps off the label of the point before it, which is not on the board yet', () => {
  const sites = site(board());
  const label = sites.label(['LABEL'], pt(120, 120), 0.75)!;
  assert.deepEqual(mmAt(place(board(), smd({ near: [...label.at] }))), [...label.at]);
  const spot = mmAt(sites.place(smd({ near: [...label.at] }), SMD_PAD));
  assert.notDeepEqual(spot, [...label.at]);
  assert.ok(Math.abs(spot[1] - label.at[1]) >= 1.2 || Math.abs(spot[0] - label.at[0]) >= 2, `${spot}`);
});

test('a label goes above the pad first, then round it', () => {
  const sites = site(board());
  assert.deepEqual(sites.label(['VBUS'], pt(120, 120), 0.75), { text: 'VBUS', at: [120, 118.25] });
  assert.deepEqual(sites.label(['VBUS'], pt(120, 120), 0.75)?.at, [120, 121.75]);
});

test('a label stays clear of pads, vias, courtyards and other silk; the first text that fits wins', () => {
  const part = footprint('R1', 120, 118, [pad('1', 'GND', 120, 118, 1.5)]);
  const near = site(board([], { footprints: [part] })).label(['VBUS'], pt(120, 120), 0.75);
  assert.notDeepEqual(near?.at, [120, 118.25]);
  const tight = polygon(116, 116, 124, 124);
  const blocked = site(board([], { footprints: [footprint('R1', 120, 120, [], tight)] }));
  assert.equal(blocked.label(['A LONG LABEL'], pt(120, 120), 0.75), null);
  const narrow = { outlines: [polygon(111, 100, 129, 140)] };
  assert.equal(site(board([], narrow)).label(['A VERY VERY VERY LONG LABEL', 'V'], pt(120, 120), 0.75)?.text, 'V');
});

test('a label must be clearly nearer its own pad than any other test point', () => {
  const other = footprint('TP9', 120, 116.6, [], polygon(119.9, 116.5, 120.1, 116.7));
  const label = site(board([], { footprints: [other] })).label(['GND'], pt(120, 120), 0.75);
  assert.notDeepEqual(label?.at, [120, 118.25]);
  assert.ok(label);
});

test('a label keeps 0.35 mm inside the outline', () => {
  assert.notDeepEqual(site(board()).label(['GND'], pt(120, 102), 0.75)?.at, [120, 100.25]);
});

const ids = (): (() => string) => { let n = 0; return () => `id-${n++}`; };
const placed = { name: 'TestPoint_Pad_D1.5mm', ref: 'TP7', value: 'VBUS', net: '/VBUS', kind: 'smd' as const, at: pt(120.7, 130.25), symbol: 'sym-1', next: ids() };

test('the footprint is a board item: library name, place, path, hidden reference on F.Fab, net on its pad', () => {
  const form = parse(footprintText(SMD, placed));
  assert.equal(form[1], 'TestPoint:TestPoint_Pad_D1.5mm');
  assert.deepEqual(one(form, 'at'), ['at', '120.7', '130.25']);
  assert.deepEqual(one(form, 'path'), ['path', '/sym-1']);
  assert.equal(one(form, 'version'), undefined);
  assert.deepEqual(one(form, 'attr')?.slice(1), ['exclude_from_pos_files', 'exclude_from_bom']);
  const field = (name: string) => kids(form, 'property').find(item => item[1] === name)!;
  assert.equal(field('Reference')[2], 'TP7');
  assert.equal(layerOf(field('Reference')), 'F.Fab');
  assert.deepEqual(one(field('Reference'), 'hide'), ['hide', 'yes']);
  assert.equal(field('Value')[2], 'VBUS');
  assert.equal(layerOf(field('Value')), 'F.Fab');
  assert.equal(field('Description')[2], 'Bring-up test point, bare copper pad, not assembled');
  assert.deepEqual(one(one(form, 'pad')!, 'net'), ['net', '/VBUS']);
  assert.equal(one(one(form, 'pad')!, 'zone_connect'), undefined);
});

test('a through-hole pad connects solid to the planes', () => {
  const form = parse(footprintText(THT, { ...placed, name: 'TestPoint_THTPad_D2.5mm_Drill1.2mm', kind: 'tht' }));
  assert.deepEqual(one(one(form, 'pad')!, 'zone_connect'), ['zone_connect', '2']);
});

test('every uuid of a footprint is new and none repeats', () => {
  const text = footprintText(SMD, { ...placed, next: ids() });
  const all = [...text.matchAll(/\(uuid "([^"]+)"\)/g)].map(match => match[1]);
  assert.equal(new Set(all).size, all.length);
  assert.ok(all.every(id => id!.startsWith('id-')));
  assert.equal(all.length, 6);
  assert.equal(atom(one(parse(text), 'uuid')!, 1), 'id-0');
});

test('a footprint text is one indented board item', () => {
  const text = footprintText(SMD, { ...placed, next: ids() });
  assert.ok(text.startsWith('\t(footprint "TestPoint:'));
  assert.ok(text.endsWith('\t)\n'));
});

const symbol = (extra: Partial<Parameters<typeof symbolText>[0]> = {}) => symbolText({ ref: 'TP1', value: 'GND', footprint: 'TestPoint_Pad_D1.5mm', net: 'GND', x: 10.16, y: 20.32, next: ids(), ...extra });

test('a global net gets its power symbol, its value set to the net', () => {
  const { text, uuid } = symbol({ power: 'power:GND' });
  assert.equal(uuid, 'id-0');
  const root = parse(`(x\n${text})`);
  const [point, power] = kids(root, 'symbol');
  assert.deepEqual(one(point!, 'in_bom'), ['in_bom', 'no']);
  assert.deepEqual(one(point!, 'at'), ['at', '10.16', '20.32', '0']);
  assert.deepEqual(one(power!, 'lib_id'), ['lib_id', 'power:GND']);
  assert.deepEqual(one(power!, 'at'), ['at', '10.16', '20.32', '180']);
  const field = (name: string) => kids(power!, 'property').find(item => item[1] === name)!;
  assert.equal(field('Reference')[2], '#PWR_TP1');
  assert.equal(field('Value')[2], 'GND');
  assert.deepEqual(kids(root, 'wire'), []);
});

test('a root-sheet net gets a short wire and a local label with no slash', () => {
  const root = parse(`(x\n${symbol({ net: '/SENSE', value: 'SENSE' }).text})`);
  assert.equal(kids(root, 'symbol').length, 1);
  assert.deepEqual(one(one(kids(root, 'wire')[0]!, 'pts')!, 'xy'), ['xy', '10.16', '20.32']);
  assert.deepEqual(kids(one(kids(root, 'wire')[0]!, 'pts')!, 'xy')[1], ['xy', '10.16', '22.86']);
  assert.equal(kids(root, 'label')[0]![1], 'SENSE');
});

test('the reference shows on the sheet; the other fields are hidden', () => {
  const root = parse(`(x\n${symbol().text})`);
  const fields = kids(kids(root, 'symbol')[0]!, 'property');
  assert.deepEqual(fields.map(field => [field[1], one(one(field, 'effects')!, 'hide') !== undefined]),
    [['Reference', false], ['Value', true], ['Footprint', true], ['Datasheet', true], ['Description', true]]);
});

test('symbols go in eight columns on the sheet grid, and stop below the area', () => {
  const area: [number, number, number, number] = [600, 40, 680, 60];
  assert.deepEqual(sheetSpot(area, 0), { x: 236 * 2.54, y: 16 * 2.54 });
  assert.deepEqual(sheetSpot(area, 1), { x: 244 * 2.54, y: 16 * 2.54 });
  assert.deepEqual(sheetSpot(area, 8), { x: 236 * 2.54, y: 22 * 2.54 });
  assert.equal(sheetSpot(area, 16), null);
});

test('a library symbol is found by its form, a parenthesis in a string does not end it', () => {
  const text = '(kicad_sch\n(lib_symbols\n(symbol "AUTO:TP"\n(property "x" ")")\n)\n)\n(symbol "AUTO:TP" (at 0 0))\n)\n';
  assert.equal(libSymbol(text, 'AUTO:TP'), '(symbol "AUTO:TP"\n(property "x" ")")\n)');
  assert.equal(libSymbol(text, 'AUTO:NO'), null);
  assert.equal(libSymbol('(symbol "AUTO:TP")', 'AUTO:TP'), null);
});

test('a missing definition is copied in from the first source that has it; one already there is left', () => {
  const folder = mkdtempSync(join(tmpdir(), 'testpoints-'));
  try {
    const source = join(folder, 'other.kicad_sch');
    writeFileSync(source, '(kicad_sch\n(lib_symbols\n(symbol "AUTO:TP" (pin "1"))\n)\n)\n');
    const { text, embedded } = embedLibSymbols(SCHEMATIC, ['AUTO:TP', 'power:GND', 'AUTO:TP'], [join(folder, 'missing.kicad_sch'), source]);
    assert.deepEqual(embedded, ['AUTO:TP']);
    assert.equal(libSymbol(text, 'AUTO:TP'), '(symbol "AUTO:TP" (pin "1"))');
    assert.ok(libSymbol(text, 'power:GND'));
    assert.throws(() => embedLibSymbols(SCHEMATIC, ['AUTO:NO'], [source]), /no definition of AUTO:NO/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the symbol sources are the sheets of the board, its blocks, then BASE-PWR', () => {
  const folder = mkdtempSync(join(tmpdir(), 'testpoints-'));
  try {
    writeFileSync(join(folder, 'b.kicad_sch'), '');
    writeFileSync(join(folder, 'a.kicad_sch'), '');
    writeFileSync(join(folder, 'a.kicad_pcb'), '');
    assert.deepEqual(symbolSources(join(folder, 'b.kicad_sch'), '/root'),
      [join(folder, 'a.kicad_sch'), join(folder, 'b.kicad_sch'), '/root/hardware-design/boards/BASE-PWR/cad/BASE-PWR/BASE-PWR.kicad_sch']);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

const inputs = (extra: Partial<Inputs> = {}): Inputs => ({ board: board(), project: PROJECT, pcbText: fixtureText(), schematic: SCHEMATIC, libraries: { smd: SMD, tht: THT }, ...extra });
const file = (points: PointSpec[], area: [number, number, number, number] = [10, 10, 200, 200]): TestPointsFile => ({ project: 'cad/X/X', sheet_area: area, points });

test('a plan adds footprints and labels to the board text and reports each place', () => {
  const plan = planTestPoints(file([smd({ label: 'A' }), tht({ ref: 'TP2', net: 'GND', power: 'power:GND', near: [140, 120] })]), inputs());
  assert.deepEqual(plan.lines, ['TP1 /A: (120.00, 120.00), 0.00 mm from [120, 120], needs a route, label A', 'TP2 GND: (140.00, 120.00), 0.00 mm from [140, 120], needs a route']);
  const root = parse(plan.pcbText);
  const placedRefs = kids(root, 'footprint').map(form => kids(form, 'property').find(item => item[1] === 'Reference')![2]);
  assert.deepEqual(placedRefs, ['TP1', 'TP2']);
  const label = kids(root, 'gr_text')[0]!;
  assert.equal(label[1], 'A');
  assert.equal(layerOf(label), 'F.SilkS');
  assert.equal(plan.symbols.length, 2);
});

test('a label with no place is reported, and the point still goes on', () => {
  const small = board([], { outlines: [polygon(117, 133, 122, 138)], edges_bbox: { left: 117e6, top: 133e6, right: 122e6, bottom: 138e6 } });
  const plan = planTestPoints(file([smd({ near: [119.5, 135.5], label: ['LONG', 'L'] })]), inputs({ board: small }));
  assert.match(plan.lines[0]!, /^TP1: no clear place for a silk label \['LONG', 'L'\]$/);
  assert.match(plan.lines[1]!, /^TP1 \/A: /);
});

test('a plan stops on a point that is there already, an unknown net, or a power symbol the sheet lacks', () => {
  const taken = board([], { footprints: [footprint('TP1', 150, 130, [])] });
  assert.throws(() => planTestPoints(file([smd()]), inputs({ board: taken })), /TP1 is already on the board or in the schematic/);
  const sheet = SCHEMATIC.replace('(sheet_instances', '(symbol (property "Reference" "TP1"))\n\t(sheet_instances');
  assert.throws(() => planTestPoints(file([smd()]), inputs({ schematic: sheet })), /TP1 is already on the board or in the schematic/);
  assert.throws(() => planTestPoints(file([smd({ net: 'NOPE' })]), inputs()), /no net NOPE on the board/);
  assert.throws(() => planTestPoints(file([smd({ power: 'power:VBUS' })]), inputs()), /no embedded symbol power:VBUS/);
});

test('a plan stops on a point with no place, a track_only point off its track, or a full sheet area', () => {
  const full = board([], { footprints: [footprint('R1', 120, 120, [], polygon(100, 100, 160, 140))] });
  assert.throws(() => planTestPoints(file([smd()]), inputs({ board: full })), /no free place for TP1 \(\/A\) within 8 mm of \[120, 120\]/);
  assert.throws(() => planTestPoints(file([smd({ track_only: true, near: 'J1.1' })]), inputs({ board: board([], { footprints: [connector()] }) })),
    /TP1 \(\/A\) is track_only and has no place on a F.Cu track of its net within 8 mm of J1.1/);
  assert.throws(() => planTestPoints(file([smd()], [10, 100, 200, 50]), inputs()), /sheet_area is too small/);
});

test('the class clearance of a net comes from the project', () => {
  const copper = [track('/A', 122, 115, 122, 125)];
  const part = board(copper, { nets: { '/A': 'Default', HV: 'HV' } });
  const plan = planTestPoints(file([smd({ net: 'HV', near: [121.5, 120] })]), inputs({ board: part }));
  assert.match(plan.lines[0]!, /^TP1 HV: \(120\.00, 120\.00\)/);
});

test('two runs of a plan give the same ids, so the same file', () => {
  const run = () => planTestPoints(file([smd()]), inputs()).pcbText;
  assert.equal(run(), run());
});

test('symbols go before the sheet_instances of the schematic, with their definitions', () => {
  const folder = mkdtempSync(join(tmpdir(), 'testpoints-'));
  try {
    const source = join(folder, 'base.kicad_sch');
    writeFileSync(source, '(kicad_sch\n(lib_symbols\n(symbol "AUTO:TP" (pin "1"))\n)\n)\n');
    const { text, embedded } = schematicWith(SCHEMATIC, [symbol().text], [source]);
    assert.deepEqual(embedded, ['AUTO:TP']);
    assert.ok(text.indexOf('(lib_id "AUTO:TP")') < text.indexOf('(sheet_instances'));
    assert.ok(libSymbol(text, 'AUTO:TP'));
    assert.throws(() => schematicWith('(kicad_sch\n)\n', [symbol().text], [source]), /no sheet_instances/);
    assert.throws(() => schematicWith(SCHEMATIC, [symbol().text], []), /add_testpoints: no definition of AUTO:TP to embed/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
