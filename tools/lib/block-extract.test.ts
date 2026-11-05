// The native cut of a design block, on small synthetic text. Real boards were compared with pcbnew when the Python tool went.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { children, clipPolygon, cropSchematic, cutBoard, footprintBox, head, referenceOf, setSchematicFootprint, swapFootprint, topForms } from './block-extract.ts';
import type { Xy } from './board-silk.ts';

const SCH = `(kicad_sch (version 20260306) (generator "eeschema") (generator_version "10.0")
  (uuid "root-1") (paper "A3")
  (title_block (title "BOARD"))
  (lib_symbols
	(symbol "AUTO:D" (pin_names (offset 0)) (property "Reference" "D" (at 0 0 0)))
	(symbol "AUTO:R" (property "Reference" "R" (at 0 0 0)))
  )
	(symbol
		(lib_id "AUTO:D") (at 10 10 0) (unit 1)
		(uuid "sym-d4")
		(property "Reference" "D4" (at 10 8 0))
		(property "Footprint" "Diode_SMD:D_SMC" (at 10 10 0))
		(instances (project "BOARD" (path "/root-1" (reference "D4") (unit 1))))
	)
	(symbol
		(lib_id "AUTO:R") (at 90 90 0) (unit 1)
		(uuid "sym-r1")
		(property "Reference" "R1" (at 90 88 0))
		(instances (project "BOARD" (path "/root-1" (reference "R1") (unit 1))))
	)
	(wire (pts (xy 5 10) (xy 12 10)) (uuid "w-in"))
	(wire (pts (xy 12 10) (xy 80 10)) (uuid "w-cross"))
	(label "A (x)" (at 5 10 0) (uuid "l-in"))
	(text "note" (at 90 5 0) (uuid "t-out"))
  (sheet_instances (path "/" (page "1")))
  (embedded_fonts no)
)
`;

const cropped = () => cropSchematic(SCH, [0, 0, 20, 20], 'PWR-24V-IN');

test('top-level children split with strings that hold parentheses', () => {
  assert.deepEqual(children(SCH).map(head), ['version', 'generator', 'generator_version', 'uuid', 'paper', 'title_block', 'lib_symbols',
    'symbol', 'symbol', 'wire', 'wire', 'label', 'text', 'sheet_instances', 'embedded_fonts']);
});

test('only items fully inside the box stay', () => {
  for (const id of ['"sym-d4"', '"w-in"', '"l-in"']) assert.ok(cropped().includes(id), id);
  for (const id of ['"sym-r1"', '"w-cross"', '"t-out"']) assert.ok(!cropped().includes(id), id);
});

test('library symbols are filtered to the used ones', () => {
  assert.ok(cropped().includes('(symbol "AUTO:D"'));
  assert.ok(!cropped().includes('(symbol "AUTO:R"'));
});

test('the project is renamed, the root uuid stays and the title goes', () => {
  assert.ok(cropped().includes('(project "PWR-24V-IN" (path "/root-1"'));
  assert.ok(!cropped().includes('"BOARD"'));
  assert.ok(cropped().includes('(uuid "root-1")'));
});

test('the output is balanced and keeps its footer', () => {
  const out = cropped();
  assert.equal(out.split('(').length, out.split(')').length);
  assert.ok(out.includes('(sheet_instances'));
  assert.ok(out.startsWith('(kicad_sch'));
});

test('the footprint field is set by reference, and an unknown reference is refused', () => {
  const out = setSchematicFootprint(SCH, 'D4', 'Diode_SMD:D_SMA');
  assert.ok(out.includes('(property "Footprint" "Diode_SMD:D_SMA" (at 10 10 0))'));
  assert.equal(out.split('D_SMA').length, 2);
  assert.throws(() => setSchematicFootprint(SCH, 'D9', 'X'), /D9/);
});

const FOOTPRINT = (ref: string, net: string, x: number, extra = '') => `(footprint "Lib:R" (layer "F.Cu") (uuid "fp-${ref}") (at ${x} 10)
  (property "Reference" "${ref}" (at 0 0 0) (layer "F.Fab") (hide yes) (uuid "ref-${ref}") (effects (font (size 1 1))))
  (property "Value" "1k" (at 0 0 0) (layer "F.Fab") (hide yes) (uuid "val-${ref}") (effects (font (size 1 1))))
  (path "/one/${ref}")
  (pad "1" smd rect (at 0 0) (size 2 2) (layers "F.Cu") (net "${net}") (uuid "pad-${ref}"))${extra})`;

const BOARD = `(kicad_pcb (version 20260206)
 ${FOOTPRINT('R1', 'A', 10)}
 ${FOOTPRINT('R2', 'B', 50)}
 (gr_rect (start 0 0) (end 100 100) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts") (uuid "old-edge"))
 (gr_line (start 10 10) (end 10.5 10) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "line-in"))
 (gr_line (start 40 40) (end 41 40) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "line-out"))
 (segment (start 10 10) (end 10.5 10) (width 0.2) (layer "F.Cu") (net "A") (uuid "kept"))
 (segment (start 10 10) (end 30 10) (width 0.2) (layer "F.Cu") (net "A") (uuid "long"))
 (segment (start 10 10) (end 10.5 10) (width 0.2) (layer "F.Cu") (net "B") (uuid "other-net"))
 (via (at 10.5 10) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "A") (uuid "via-in"))
 (zone (net "A") (layer "F.Cu") (uuid "zone-a") (polygon (pts (xy 0 0) (xy 100 0) (xy 100 100) (xy 0 100))))
 (zone (net "B") (layer "F.Cu") (uuid "zone-b") (polygon (pts (xy 0 0) (xy 100 0) (xy 100 100) (xy 0 100))))
 (zone (net "A") (layer "F.Cu") (uuid "zone-far") (polygon (pts (xy 60 60) (xy 70 60) (xy 70 70) (xy 60 70))))
 (zone (layer "F.Cu") (uuid "zone-rule") (keepout (tracks not_allowed)) (polygon (pts (xy 9 9) (xy 11 9) (xy 11 11) (xy 9 11))))
 (group "both" (uuid "group-both") (members "line-in" "line-out"))
 (group "gone" (uuid "group-gone") (members "line-out"))
 (embedded_fonts no)
)
`;

const ids = (text: string): string[] => topForms(text).map(row => (row.form.find(item => Array.isArray(item) && item[0] === 'uuid') as string[] | undefined)?.[1] ?? '').filter(Boolean);

test('a cut keeps the parts, their nets inside the box, and zones clipped to it', () => {
  const cut = cutBoard(BOARD, ['R1'], 2);
  assert.deepEqual(cut.box, [7, 7, 13, 13]);
  assert.equal(cut.parts, 1);
  assert.equal(cut.tracks, 2);
  assert.equal(cut.zones, 1);
  const kept = ids(cut.text);
  for (const id of ['fp-R1', 'line-in', 'kept', 'via-in', 'zone-a', 'group-both']) assert.ok(kept.includes(id), id);
  for (const id of ['fp-R2', 'old-edge', 'line-out', 'long', 'other-net', 'zone-b', 'zone-far', 'zone-rule', 'group-gone']) assert.ok(!kept.includes(id), id);
  assert.ok(cut.text.includes('(members "line-in")'));
  for (const corner of ['(xy 7 7)', '(xy 13 7)', '(xy 13 13)', '(xy 7 13)']) assert.ok(cut.text.includes(corner), corner);
  assert.ok(!cut.text.includes('(xy 100 100)'));
  assert.ok(/\(gr_rect\s+\(start 7 7\)\s+\(end 13 13\)/.test(cut.text));
  assert.equal(cut.text.split('(').length, cut.text.split(')').length);
});

test('a reference that is not on the board is named', () => {
  assert.throws(() => cutBoard(BOARD, ['R1', 'R9'], 2), /refs not on the board: \["R9"\]/);
});

test('a drawing with no known box is refused, not guessed', () => {
  assert.throws(() => cutBoard(BOARD.replace('(embedded_fonts no)', '(dimension (uuid "d"))'), ['R1'], 2), /dimension/);
});

test('a zone outline with an arc is refused', () => {
  const arc = BOARD.replace('(xy 0 0) (xy 100 0)', '(arc (start 0 0) (mid 50 1) (end 100 0))');
  assert.throws(() => cutBoard(arc, ['R1'], 2), /arc/);
});

const area = (polygon: Xy[]): number => Math.abs(polygon.reduce((sum, [x, y], index) => {
  const [nextX, nextY] = polygon[(index + 1) % polygon.length] as Xy;
  return sum + x * nextY - nextX * y;
}, 0)) / 2;

test('a square is clipped to the rectangle and a far polygon goes', () => {
  const square: Xy[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.deepEqual(clipPolygon(square, [-1, -1, 11, 11]), [square]);
  assert.equal(area((clipPolygon(square, [2, 3, 6, 9])[0]) as Xy[]), 24);
  assert.deepEqual(clipPolygon(square, [20, 20, 30, 30]), []);
});

test('a concave polygon falls into separate pieces, with no bridge along the cut', () => {
  const comb: Xy[] = [[0, 0], [10, 0], [10, 10], [7, 10], [7, 2], [3, 2], [3, 10], [0, 10]];
  const pieces = clipPolygon(comb, [-1, 5, 11, 11]);
  assert.equal(pieces.length, 2);
  assert.deepEqual(pieces.map(area).sort(), [15, 15]);
  const clockwise: Xy[] = [...comb].reverse();
  assert.deepEqual(clipPolygon(clockwise, [-1, 5, 11, 11]).map(area).sort(), [15, 15]);
});

test('a rotated pad and a visible text set the box of a footprint', () => {
  const turned = `(footprint "Lib:R" (layer "F.Cu") (uuid "f") (at 10 10 90)
    (property "Reference" "R1" (at 0 0 0) (layer "F.Fab") (hide yes) (uuid "r") (effects (font (size 1 1))))
    (pad "1" smd rect (at 3 0 90) (size 4 2) (layers "F.Cu") (uuid "p")))`;
  const row = topForms(`(kicad_pcb ${turned})`)[0] as ReturnType<typeof topForms>[number];
  assert.equal(referenceOf(row.form), 'R1');
  const box = footprintBox(turned, row.form);
  assert.deepEqual(box.map(value => Number(value.toFixed(6))), [9, 5, 11, 10.25]);
});

const MODULE = `(footprint "R_0603"
  (version 20241229) (generator "pcbnew") (generator_version "10.0") (layer "F.Cu") (descr "d")
  (property "Reference" "REF**" (at 0 -1 0) (layer "F.SilkS") (uuid "m1") (effects (font (size 1 1))))
  (property "Value" "R_0603" (at 0 1 0) (layer "F.Fab") (uuid "m2") (effects (font (size 1 1))))
  (attr smd)
  (pad "1" smd roundrect (at -0.8 0) (size 0.8 0.9) (layers "F.Cu") (uuid "m3"))
  (embedded_fonts no)
)`;

test('a swapped footprint keeps the pose, path, fields and nets of the part', () => {
  const part = FOOTPRINT('R1', 'A', 10).replace('(at 10 10)', '(at 10 10 90)').replace('(path', '(property "MPN" "X1" (at 0 0 0) (layer "F.Fab") (hide yes) (uuid "mpn") (effects (font (size 1 1))))\n(path');
  const row = topForms(`(kicad_pcb ${part})`)[0] as ReturnType<typeof topForms>[number];
  const text = swapFootprint(part, row.form, 'Resistor_SMD', 'R_0603', MODULE);
  for (const piece of ['(footprint "Resistor_SMD:R_0603"', '(at 10 10 90)', '(path "/one/R1")', '"Reference" "R1"', '"Value" "1k"', '"MPN" "X1"', '(net "A")', '(at -0.8 0 90)', '(at 0 -1 90)']) {
    assert.ok(text.includes(piece), piece);
  }
  assert.ok(!text.includes('generator') && !text.includes('REF**'));
  assert.throws(() => swapFootprint(part, row.form, 'L', 'N', MODULE.replace('(layer "F.Cu") (descr', '(layer "B.Cu") (descr')), /side change/);
});
