import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureArt, type ArtReport } from '../check_pixel_art.ts';
import { lineText, rectText, textText } from './board-items.ts';
import type { Board, Pad, Zone } from './board-types.ts';
import { pixelArtChecks } from './pixel-art-checks.mjs';
import { fixtureBoard, fixtureText, footprint, footprintForm, pad, polygon, pt, silkLine } from './silk-fixture.ts';

type Report = Extract<ArtReport, { exists: true }>;

const rect = (uuid: string, x: number, y: number, layer = 'B.SilkS'): string =>
  rectText({ start: [x, y], end: [x + 1, y + 1], layer, width: 0.16, filled: true, uuid });
const group = (name: string, ...members: string[]): string =>
  `\t(group "${name}"\n\t\t(uuid "g-${name}")\n\t\t(members ${members.map(member => `"${member}"`).join(' ')})\n\t)\n`;
const art = (x = 120, y = 120, layer = 'B.SilkS'): string[] => [rect('a1', x, y, layer), group('pixel-art logo', 'a1')];

function measure(board: Board, ...forms: string[]): Report {
  const report = measureArt(board, fixtureText(...forms), ['logo']).art.logo!;
  assert.equal(report.exists, true);
  return report as Report;
}

const backPad = (x: number, y: number, extra: Partial<Pad> = {}): Pad => ({ ...pad('1', 'GND', x, y), layers: ['B.Cu', 'B.Mask'], ...extra });
const ruleArea = (name: string, x0: number, y0: number, x1: number, y1: number): Zone => ({
  id: name, name, net: '', layers: ['B.Cu'], outline: [polygon(x0, y0, x1, y1)], filled: [], fill: null,
  rule_area: { tracks: true, vias: true, pour: true, pads: true, footprints: true },
});

test('one JSON report: the limits and a group that is missing', () => {
  const result = measureArt(fixtureBoard([]), fixtureText(), ['none']);
  assert.deepEqual(result, { edge_mm: 0.5, clear_mm: 0.2, art: { none: { exists: false } } });
});

test('a clear shape reports its layer and box, with nothing outside and nothing hit', () => {
  assert.deepEqual(measure(fixtureBoard([]), ...art()), { exists: true, shapes: 1, layers: ['B.SilkS'], bbox: [119.92, 119.92, 121.08, 121.08], outside: [], hits: [] });
});

test('a group of no shapes exists and has none', () => {
  const report = measure(fixtureBoard([]), textText({ text: 'T', at: [120, 120], layer: 'B.SilkS', size: 1, thickness: 0.15, uuid: 't1' }), group('pixel-art logo', 't1'));
  assert.equal(report.shapes, 0);
  assert.deepEqual(report.layers, []);
});

test('a shape less than 0.5 mm inside the outline is reported by its top left corner', () => {
  assert.deepEqual(measure(fixtureBoard([]), ...art(100.3, 120)).outside, [[100.22, 119.92]]);
  assert.deepEqual(measure(fixtureBoard([]), ...art(100.6, 120)).outside, []);
});

test('a shape past the outline is outside, and so is one over or near a cut-out', () => {
  assert.equal(measure(fixtureBoard([]), ...art(90, 120)).outside.length, 1);
  const board = fixtureBoard([]);
  board.outlines = [{ ...polygon(100, 100, 160, 140), holes: [polygon(118, 118, 124, 124).outline] }];
  assert.equal(measure(board, ...art(120, 120)).outside.length, 1, 'over the cut-out');
  assert.equal(measure(board, ...art(116.5, 120)).outside.length, 1, 'beside the cut-out');
  assert.deepEqual(measure(board, ...art(115, 120)).outside, []);
});

test('a shape round a whole cut-out is outside', () => {
  const board = fixtureBoard([]);
  board.outlines = [{ ...polygon(100, 100, 160, 140), holes: [polygon(120.4, 120.4, 120.6, 120.6).outline] }];
  assert.equal(measure(board, ...art()).outside.length, 1);
});

test('a pad on the side counts with its mask opening; a shrinking margin counts as none', () => {
  const near = (expansion: number) => fixtureBoard([footprint('U1', 123, 120.5, [backPad(122, 120.5, { solder_mask_expansion: expansion })])]);
  // The shape ends at 121.08, the pad at 121.5: 0.42 mm apart. Grown by 0.2 mm, it needs a margin of 0.22 mm to touch.
  assert.deepEqual(measure(near(0), ...art()).hits, []);
  assert.deepEqual(measure(near(-500_000), ...art()).hits, []);
  assert.deepEqual(measure(near(300_000), ...art()).hits, ['pad U1.1']);
});

test('a pad on the other side counts only when it has a hole', () => {
  const smd = pad('1', 'GND', 120.5, 120.5);
  assert.deepEqual(measure(fixtureBoard([footprint('U1', 120, 120, [smd])]), ...art()).hits, []);
  const drilled = { ...smd, drill: pt(0.8, 0.8) };
  assert.deepEqual(measure(fixtureBoard([footprint('U1', 120, 120, [drilled])]), ...art()).hits, ['pad U1.1']);
});

test('footprint courtyards, mask openings and silk count by the side of the art', () => {
  const board = fixtureBoard([{ ...footprint('U1', 120, 120, []), graphics: [
    silkLine(120, 119.7, 122, 119.7, 'B.CrtYd'), silkLine(120, 121.3, 122, 121.3, 'B.Mask'), silkLine(119.7, 120, 119.7, 122, 'B.SilkS'), silkLine(121.3, 120, 121.3, 122, 'F.SilkS'),
  ] }]);
  assert.deepEqual(measure(board, ...art()).hits, ['courtyard U1', 'mask opening U1', 'silk U1 PCB_SHAPE']);
});

test('a visible footprint text on the side counts; a hidden one does not', () => {
  const shown = footprintForm('U1', 120.5, 123, 'f1').replaceAll('"F.SilkS"', '"B.SilkS"');
  assert.deepEqual(measure(fixtureBoard([]), ...art(), shown).hits, ['silk U1 PCB_FIELD']);
  const hidden = shown.replace('(layer "B.SilkS")\n', '(layer "B.SilkS")\n\t\t\t(hide yes)\n');
  assert.deepEqual(measure(fixtureBoard([]), ...art(), hidden).hits, []);
});

const via = (tenting = ''): string => `\t(via\n\t\t(at 120.5 121.6)\n\t\t(size 1)\n\t\t(drill 0.5)\n\t\t(layers "F.Cu" "B.Cu")\n${tenting}\t\t(net "GND")\n\t\t(uuid "v1")\n\t)\n`;
const setup = (tenting: string): string => `\t(setup\n\t\t${tenting}\n\t)\n`;

test('a via counts only when it is not tented: its own setting, else the board, else tented', () => {
  const board = fixtureBoard([]);
  assert.deepEqual(measure(board, ...art(), via()).hits, []);
  assert.deepEqual(measure(board, ...art(), via(), setup('(tenting\n(front yes)\n(back yes)\n)')).hits, []);
  assert.deepEqual(measure(board, ...art(), via(), setup('(tenting\n(front yes)\n(back no)\n)')).hits, ['untented via']);
  assert.deepEqual(measure(board, ...art(), via(), setup('(tenting front)')).hits, ['untented via']);
  assert.deepEqual(measure(board, ...art(), via(), setup('(tenting none)')).hits, ['untented via']);
  assert.deepEqual(measure(board, ...art(), via('\t\t(tenting\n(front yes)\n(back no)\n)\n')).hits, ['untented via']);
  assert.deepEqual(measure(board, ...art(), via('\t\t(tenting\n(back yes)\n)\n'), setup('(tenting none)')).hits, []);
});

test('tenting of the other side does not count', () => {
  const front = art(120, 120, 'F.SilkS');
  assert.deepEqual(measure(fixtureBoard([]), ...front, via(), setup('(tenting\n(front yes)\n(back no)\n)')).hits, []);
});

test('only hole keepout and barrier rule areas count', () => {
  const board = fixtureBoard([]);
  board.zones = [ruleArea('H3_KEEPOUT', 118, 118, 123, 123), ruleArea('mains Barrier', 121, 121, 125, 125), ruleArea('RF_KEEPOUT', 118, 118, 123, 123),
    ruleArea('H3_KEEPOUT_X', 118, 118, 123, 123), ruleArea('H9_KEEPOUT', 150, 130, 155, 135)];
  assert.deepEqual(measure(board, ...art()).hits, ['rule area H3_KEEPOUT', 'rule area mains Barrier']);
});

test('a zone that is not a rule area does not count, whatever its name', () => {
  const board = fixtureBoard([]);
  board.zones = [{ ...ruleArea('BARRIER', 118, 118, 123, 123), rule_area: null }];
  assert.deepEqual(measure(board, ...art()).hits, []);
});

test('board silk and mask count; the shapes of the art do not hit each other', () => {
  const forms = [rect('a1', 120, 120), rect('a2', 121, 120), group('pixel-art logo', 'a1', 'a2')];
  assert.deepEqual(measure(fixtureBoard([]), ...forms).hits, []);
  const line = lineText({ start: [122.3, 120], end: [122.3, 121], layer: 'B.SilkS', width: 0.2, uuid: 'l1' });
  const mask = lineText({ start: [119, 119.65], end: [123, 119.65], layer: 'B.Mask', width: 0.2, uuid: 'l2' });
  assert.deepEqual(measure(fixtureBoard([]), ...forms, line, mask).hits, ['board mask opening', 'board silk']);
});

test('a text or a shape of another group is named with its group; a text in the art group still counts', () => {
  const text = textText({ text: 'JLC', at: [120.5, 122], layer: 'B.SilkS', size: 1, thickness: 0.15, uuid: 't1' });
  assert.deepEqual(measure(fixtureBoard([]), ...art(), text).hits, ['text "JLC"']);
  assert.deepEqual(measure(fixtureBoard([]), ...art(), text, group('brand X', 't1')).hits, ['text "JLC" (group "brand X")']);
  assert.deepEqual(measure(fixtureBoard([]), rect('a1', 120, 120), text, group('pixel-art logo', 'a1', 't1')).hits, ['text "JLC" (group "pixel-art logo")']);
  const other = rect('o1', 121.2, 120);
  assert.deepEqual(measure(fixtureBoard([]), ...art(), other, group('pixel-art x', 'o1')).hits, ['board silk (group "pixel-art x")']);
});

test('art on the top side looks at the top side; mixed layers look at the top side too', () => {
  const back = textText({ text: 'B', at: [120.5, 122], layer: 'B.SilkS', size: 1, thickness: 0.15, uuid: 't1' });
  const front = textText({ text: 'F', at: [120.5, 122], layer: 'F.SilkS', size: 1, thickness: 0.15, uuid: 't2' });
  assert.deepEqual(measure(fixtureBoard([]), ...art(120, 120, 'F.SilkS'), back, front).hits, ['text "F"']);
  const mixed = measure(fixtureBoard([]), rect('a1', 120, 120, 'F.SilkS'), rect('a2', 120, 125), group('pixel-art logo', 'a1', 'a2'), back, front);
  assert.deepEqual(mixed.layers, ['B.SilkS', 'F.SilkS']);
  assert.deepEqual(mixed.hits, ['text "F"']);
});

test('a drawing the probe cannot measure on the side stops it; on another layer it does not', () => {
  const box = (layer: string): string => `\t(gr_text_box "X"\n\t\t(layer "${layer}")\n\t\t(uuid "b1")\n\t)\n`;
  assert.throws(() => measure(fixtureBoard([]), ...art(), box('B.SilkS')), /cannot measure the gr_text_box on B.SilkS/);
  assert.deepEqual(measure(fixtureBoard([]), ...art(), box('F.Fab')).hits, []);
});

const audit = (art: Record<string, unknown>): [string, boolean, string][] => {
  const results: [string, boolean, string][] = [];
  pixelArtChecks({ pcb: 'x', arts: { logo: 'B.SilkS' }, check: (name: string, ok: boolean, detail: string) => results.push([name, ok, detail]), measure: () => ({ edge_mm: 0.5, art }) });
  return results;
};

test('the audit passes clear art and fails each finding of the probe', () => {
  const clear = { exists: true, shapes: 2, layers: ['B.SilkS'], bbox: [1, 2, 3, 4], outside: [], hits: [] };
  assert.deepEqual(audit({ logo: clear }).map(result => result[1]), [true, true, true]);
  assert.deepEqual(audit({ logo: { ...clear, layers: ['F.SilkS'] } }).map(result => result[1]), [false, true, true]);
  assert.deepEqual(audit({ logo: { ...clear, outside: [[1, 2]] } }).map(result => result[1]), [true, false, true]);
  assert.deepEqual(audit({ logo: { ...clear, hits: ['pad U1.1'] } }).map(result => result[1]), [true, true, false]);
  assert.deepEqual(audit({ logo: { ...clear, shapes: 0, layers: [] } }).map(result => result[1]), [false, false, false]);
  assert.deepEqual(audit({}).map(result => result[1]), [false, false, false]);
});

test('an audit whose probe stops is one failed check, and old callers may still pass python and probe', () => {
  const results: [string, boolean, string][] = [];
  const check = (name: string, ok: boolean, detail: string) => results.push([name, ok, detail]);
  const call = { python: 'python3', probe: 'tools/check_pixel_art.py', pcb: 'x', arts: { logo: 'B.SilkS' }, check, measure: () => { throw new Error('no board'); } };
  pixelArtChecks(call);
  assert.deepEqual(results, [['pixel-art probe runs', false, 'no board']]);
});
