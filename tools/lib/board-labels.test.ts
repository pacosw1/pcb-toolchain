import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { labelBoard, type LabelConfig } from '../board_labels.ts';
import { brandBlock } from '../brand_mark.ts';
import { domainShapes, refFieldText, silkMarks } from '../silk_marks.ts';
import { refsOffSilk } from '../silk_refs.ts';
import { readSilk } from './board-silk.ts';
import { LabelBoard, strokeOf } from './label-board.ts';
import { drawGrid, drawPanel, drawTextBlock, infoColumns, type InfoCanvas } from './label-info.ts';
import { NoPlace, placePins, placeTitle, portPads, type Connector } from './label-place.ts';
import { connector, fixtureBoard, fixtureText, footprint, footprintForm, pad, palettePng, polygon, pt } from './silk-fixture.ts';

const J1: Connector = { ref: 'J1', dir: 'N', pins: [['1', 'SIG', '/A'], ['2', 'GND', 'GND']], title: ['PORT'] };
const CONFIG: LabelConfig = { connectors: [J1], pin_h: [1.0], title_h: [1.0] };
const run = { name: 'X', folder: '/nowhere', labelsOnly: true };
const source = () => refsOffSilk(fixtureText(footprintForm('J1', 130, 120, 'f1'))).text;
const logo = palettePng([[0, 0, 0, 0], [0, 0, 0, 0]], [[0, 0, 0]]);

test('a label stroke is 0.15 mm per mm of height, at least 0.15 mm', () => {
  assert.equal(strokeOf(0.8), 0.15);
  assert.equal(strokeOf(2), 0.3);
});

test('pin labels go on the dir side of their pads, at one size', () => {
  const board = fixtureBoard([connector()]);
  const B = new LabelBoard(board, readSilk(source()));
  const { items, failed } = placePins(B, J1, portPads(board), CONFIG);
  assert.equal(failed, null);
  assert.deepEqual(items.map(item => [item.text, item.height, item.v]), [['SIG', 1, 'bottom'], ['GND', 1, 'bottom']]);
  assert.ok(items.every(item => item.at[1] < 119.5));
});

test('a pin whose pad holds another net stops the tool', () => {
  const board = fixtureBoard([connector()]);
  const wrong: Connector = { ...J1, pins: [['1', 'SIG', '/B']] };
  assert.throws(() => placePins(new LabelBoard(board, readSilk(source())), wrong, portPads(board), CONFIG), /label\/net mismatch/);
});

test('a label anchor stays nearest to its own pad', () => {
  const near = footprint('J2', 130, 118.2, [pad('1', '/X', 128.75, 118.2)]);
  const board = fixtureBoard([connector(), near]);
  const rows = placePins(new LabelBoard(board, readSilk(source())), { ...J1, pin_h: [1.0], max_gap: 0.3 }, portPads(board), CONFIG);
  assert.notEqual(rows.failed, null);
});

test('a title has a wording that fits, near the pads', () => {
  const board = fixtureBoard([connector()]);
  const [item] = placeTitle(new LabelBoard(board, readSilk(source())), J1, CONFIG);
  assert.equal(item!.text, 'PORT');
  assert.ok(Math.hypot(item!.at[0] - 130, item!.at[1] - 120) < 12);
});

test('a title with no free place says so', () => {
  const board = fixtureBoard([connector()]);
  board.outlines = [polygon(127, 118, 133, 122)];
  assert.throws(() => placeTitle(new LabelBoard(board, readSilk(source())), { ...J1, title: ['A VERY LONG TITLE THAT CANNOT FIT'] }, CONFIG), NoPlace);
});

test('the back side keeps clear of the vias and mirrors its labels', () => {
  const board = fixtureBoard([connector()]);
  board.copper = [{ Via: { id: 'v', at: pt(130, 110), size: 600_000, drill: 300_000, net: 'GND', locked: false, layers: [] } }];
  const B = new LabelBoard(board, readSilk(source()), true);
  assert.equal(B.local([129, 109, 131, 111], false).length, 1);
  assert.equal(new LabelBoard(board, readSilk(source())).local([129, 109, 131, 111], false).length, 0);
});

test('a hole of 3 mm or more is a screw head for the labels', () => {
  const board = fixtureBoard([connector(), footprint('H1', 110, 110, [pad('', '', 110, 110, 1.6, 3.2)])]);
  const B = new LabelBoard(board, readSilk(source()));
  assert.equal(B.overScrew([111, 110, 112, 111]), true);
  assert.equal(B.overScrew([114, 110, 115, 111]), false);
});

test('the whole run writes references to Fab and one label group, and a rerun gives the same labels', () => {
  const board = fixtureBoard([connector()]);
  const once = labelBoard(board, source(), CONFIG, run);
  const silk = readSilk(once.text);
  assert.equal(silk.footprintTexts.find(item => item.name === 'Reference')!.layer, 'F.Fab');
  assert.deepEqual(silk.texts.map(item => item.group), ['board-labels', 'board-labels', 'board-labels']);
  const twice = readSilk(labelBoard(board, once.text, CONFIG, run).text);
  assert.deepEqual(twice.texts.map(item => [item.text, item.at]), silk.texts.map(item => [item.text, item.at]));
});

test('a dry run leaves the board text as it was', () => {
  const text = source();
  assert.equal(labelBoard(fixtureBoard([connector()]), text, CONFIG, { ...run, dryRun: true }).text, text);
});

test('legacy texts within 0.3 mm of their place go, others stay', () => {
  const legacy = '\t(gr_text "OLD"\n\t\t(at 110 110 0)\n\t\t(layer "F.SilkS")\n\t\t(uuid "t1")\n\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 1 1)\n\t\t\t\t(thickness 0.15)\n\t\t\t)\n\t\t)\n\t)\n';
  const text = fixtureText(footprintForm('J1', 130, 120, 'f1'), legacy);
  const board = fixtureBoard([connector()]);
  const gone = labelBoard(board, text, { ...CONFIG, remove: [['OLD', 110.2, 110]] }, run).text;
  const kept = labelBoard(board, text, { ...CONFIG, remove: [['OLD', 111, 110]] }, run).text;
  assert.equal(readSilk(gone).texts.some(item => item.text === 'OLD'), false);
  assert.equal(readSilk(kept).texts.some(item => item.text === 'OLD'), true);
});

test('with --keep-going a title with no place is listed and the rest is written', () => {
  const board = fixtureBoard([connector()]);
  const wide: LabelConfig = { ...CONFIG, connectors: [{ ...J1, title: ['W'.repeat(80)] }] };
  assert.throws(() => labelBoard(board, source(), wide, run), /titles with no free place/);
  const done = labelBoard(board, source(), wide, { ...run, keepGoing: true });
  assert.ok(done.lines.some(line => line.includes('NOT PLACED')));
  assert.equal(readSilk(done.text).texts.length, 2);
});

test('the back pass mirrors the labels into their own group', () => {
  const done = readSilk(labelBoard(fixtureBoard([connector()]), source(), { ...CONFIG, back: true }, run).text);
  const back = done.texts.filter(item => item.group === 'board-labels-back');
  assert.equal(back.length, 3);
  assert.ok(back.every(item => item.layer === 'B.SilkS' && item.style.mirrored));
});

test('silk marks and the brand run from the labels, in their groups', t => {
  const folder = mkdtempSync(join(tmpdir(), 'labels-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(join(folder, 'silk-marks.json'), JSON.stringify({ texts: [{ text: 'RATED', near: 'J1' }] }));
  const root = mkdtempSync(join(tmpdir(), 'root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const board = fixtureBoard([connector()]);
  const marks = silkMarks(board, source(), { texts: [{ text: 'RATED', near: 'J1' }] }, 'X');
  assert.equal(marks.items, 1);
  assert.equal(readSilk(marks.text).texts.find(item => item.text === 'RATED')!.group, 'silk-marks');
  const brand = brandBlock(board, marks.text, { name: 'X', rev: 'A', logoMm: 4, textMm: 1.2 }, logo);
  assert.ok(brand);
  const silk = readSilk(brand.text);
  assert.ok(silk.texts.some(item => item.text === 'X rev A' && item.layer === 'B.SilkS' && item.group === 'brand X'));
  assert.ok(silk.shapes.every(shape => shape.group === 'brand X'));
});

test('a silk mark with no free place stops the tool', () => {
  const board = fixtureBoard([connector()]);
  board.outlines = [polygon(129, 119, 131, 121)];
  assert.throws(() => silkMarks(board, source(), { texts: [{ text: 'RATED', near: 'J1' }] }, 'X'), /no free place for "RATED"/);
});

test('a brand block with no free place is null, and a rerun replaces the old block', () => {
  const board = fixtureBoard([connector()]);
  assert.equal(brandBlock(board, source(), { name: 'X', rev: 'A', logoMm: 80, textMm: 1.2 }, logo), null);
  const once = brandBlock(board, source(), { name: 'X', rev: 'A', logoMm: 4, textMm: 1.2 }, logo)!;
  const twice = brandBlock(board, once.text, { name: 'X', rev: 'A', logoMm: 4, textMm: 1.2 }, logo)!;
  assert.equal(readSilk(twice.text).texts.length, 1);
  assert.deepEqual(twice.place.centre, once.place.centre);
});

test('the barrier domain is the copper of the nets of its classes', () => {
  const board = fixtureBoard([connector()], { '/A': 'HOST', GND: 'Default' });
  board.copper = [{ Track: { id: 't', start: pt(120, 120), end: pt(125, 120), mid: null, width: 200_000, layer: 'F.Cu', net: '/A', locked: false } },
    { Track: { id: 'u', start: pt(120, 125), end: pt(125, 125), mid: null, width: 200_000, layer: 'F.Cu', net: 'GND', locked: false } }];
  assert.equal(domainShapes(board, ['HOST']).length, 2); // the track and pad 1
});

test('a barrier is a dashed line in the group, broken at nothing here, with its label', () => {
  const board = fixtureBoard([connector()], { '/A': 'HOST', GND: 'Default' });
  const done = silkMarks(board, source(), { barrier: { classes: ['HOST'], gap: 4, label: 'ISOLATED' } }, 'X');
  assert.ok(done.items > 2);
  assert.match(done.text, /\(type dash\)/);
  assert.ok(readSilk(done.text).texts.some(item => item.text === 'ISOLATED'));
});

test('a kept reference moves to silk beside its courtyard, in the footprint frame', () => {
  const board = fixtureBoard([connector()]);
  const text = labelBoard(board, source(), { connectors: [] }, run).text;
  const done = silkMarks(board, text, { refs: { keep: ['J*'] } }, 'X');
  const field = readSilk(done.text).footprintTexts.find(item => item.name === 'Reference')!;
  assert.equal(field.layer, 'F.SilkS');
  assert.ok(field.at[1] < 118.5 || field.at[1] > 121.5 || field.at[0] < 127.5 || field.at[0] > 132.5);
});

test('a reference with no place stays on Fab and is listed', () => {
  const board = fixtureBoard([connector()]);
  board.edges_bbox = { left: 127_000_000, top: 118_000_000, right: 133_000_000, bottom: 122_000_000 };
  const done = silkMarks(board, source(), { refs: { keep: ['J*'], max_mm: 0.25 } }, 'X');
  assert.ok(done.lines.some(line => line.includes('left on F.Fab): J1')));
});

test('a value pattern in skip_values keeps a part off the silk', () => {
  const done = silkMarks(fixtureBoard([connector()]), source(), { refs: { keep: ['J*'], skip_values: ['J1-*'] } }, 'X');
  assert.ok(done.lines.some(line => line.includes('references on F.SilkS: 0')));
});

test('a reference field goes back to its footprint frame', () => {
  const field = readSilk(fixtureText(footprintForm('J1', 130, 120, 'f1'))).footprintTexts[0]!;
  const text = refFieldText({ field, at: [131, 118], angle: 90, size: 0.8 });
  assert.match(text, /\(at 1 -2 90\)/);
  assert.match(text, /\(layer "F\.SilkS"\)/);
  assert.match(refFieldText({ field, at: null, angle: 0, size: 0.8 }), /\(layer "F\.Fab"\)/);
});

const canvasOf = (back = true): { canvas: InfoCanvas; drawn: string[] } => {
  const board = fixtureBoard([connector(), footprint('TP2', 120, 130, [pad('1', '/NET/B', 120, 130)]), footprint('TP10', 125, 130, [pad('1', 'GND', 125, 130)])]);
  const drawn: string[] = [];
  let id = 0;
  const canvas: InfoCanvas = {
    board, B: new LabelBoard(board, readSilk(source()), back), tented: false, outline: [100, 100, 160, 140], date: '2026-11-04', lines: [], skipped: [],
    add: make => { drawn.push(make(`u${id++}`)); },
  };
  return { canvas, drawn };
};

test('info lines come from the config and the board', () => {
  const { board } = canvasOf().canvas;
  assert.deepEqual(infoColumns(board, { lines: ['built {date}'] }, 'D'), [['built D']]);
  assert.deepEqual(infoColumns(board, { kind: 'columns', columns: [['a'], ['b']] }, 'D'), [['a'], ['b']]);
  assert.deepEqual(infoColumns(board, { kind: 'parts', parts: [['J1', 'port'], ['J1', null, 'J1-V']] }, 'D'), [['J1 J1-VALUE  port', 'J1 J1-V']]);
  assert.deepEqual(infoColumns(board, { kind: 'testpoints', rows: 1 }, 'D'), [['TP2 NET/B'], ['TP10 GND']]);
  assert.throws(() => infoColumns(board, { kind: 'parts', parts: [['J9', 'x']] }, 'D'), /no footprint J9/);
  assert.throws(() => infoColumns(board, { kind: 'parts', parts: [['J1', 'x', 'NOPE']] }, 'D'), /not the start/);
});

test('a text block goes to the free place nearest to its near', () => {
  const { canvas, drawn } = canvasOf();
  assert.equal(drawTextBlock(canvas, { id: 'b', lines: ['ONE', 'TWO'], near: [110, 110] }), true);
  assert.equal(drawn.length, 2);
  assert.match(drawn[0]!, /\(justify left top mirror\)/);
});

test('a panel has a chamfered frame, its header and its lines', () => {
  const { canvas, drawn } = canvasOf();
  const box = drawPanel(canvas, { id: 'p', kind: 'panel', header: 'HEAD', lines: ['ONE'], near: [110, 110] });
  assert.ok(box);
  assert.equal(drawn.filter(item => item.includes('gr_line')).length, 9); // eight frame edges and the rule
  assert.equal(drawn.filter(item => item.includes('gr_text')).length, 2);
});

test('a warning panel draws its triangle', () => {
  const { canvas, drawn } = canvasOf();
  drawPanel(canvas, { id: 'w', kind: 'panel', icon: 'warning', header: 'DANGER', lines: ['HOT'], near: [110, 110] });
  assert.equal(drawn.filter(item => item.includes('gr_line')).length, 12);
  assert.ok(drawn.some(item => item.includes('"!"')));
});

test('a panel with no room is listed, not drawn', () => {
  const { canvas, drawn } = canvasOf();
  assert.equal(drawPanel(canvas, { id: 'p', kind: 'panel', lines: ['ONE'], min_w: 500 }), null);
  assert.equal(drawn.length, 0);
  assert.ok(canvas.lines.some(line => line.includes('no free place')));
});

test('a grid sets its panels in rows and columns', () => {
  const { canvas } = canvasOf();
  const blocks = ['a', 'b', 'c'].map(id => ({ id, kind: 'panel' as const, lines: ['X'] }));
  assert.equal(drawGrid(canvas, blocks, { rows: [['a', 'b'], ['c']], span_single: true, near: [120, 110] }), 3);
  assert.ok(canvas.lines.some(line => line.includes('info_layout: 2 rows x 2 columns')));
});

test('a grid at a fixed origin that is taken is listed with what blocks it', () => {
  const { canvas } = canvasOf();
  const blocks = [{ id: 'a', kind: 'panel' as const, lines: ['X'] }];
  assert.equal(drawGrid(canvas, blocks, { rows: [['a']], at: [101, 120] }), 0);
  assert.ok(canvas.skipped.some(line => line.includes('is not free')));
});
