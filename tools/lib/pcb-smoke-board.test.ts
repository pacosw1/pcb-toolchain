import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { layoutOf, moveFootprint, removeSegment, segments, withClearance, withShort, withWrongPadNet } from './pcb-smoke-board.ts';

const segment = (a: string, b: string, net: string, uuid: string, extra = '') => `\t(segment\n\t\t(start ${a})\n\t\t(end ${b})\n\t\t(width 0.25)\n\t\t(layer "F.Cu")\n\t\t(net "${net}")\n\t\t(uuid "${uuid}")${extra}\n\t)\n`;
const BOARD = `(kicad_pcb
\t(version 20260206)
\t(generator "pcbnew")
\t(footprint "T:P"
\t\t(layer "F.Cu")
\t\t(at 10 20 90)
\t\t(property "Reference" "C1" (at 0 0 0))
\t\t(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "A") (uuid "p1"))
\t\t(pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net "B") (uuid "p2"))
\t)
${segment('0 0', '1 0', 'A', 's1')}${segment('1 0', '2 0', 'A', 's2')}${segment('2 0', '3 0', 'A', 's3')}${segment('5 5', '6 5', 'B', 's4')})
`;

test('segments are read with their spans, and a locked one is marked', () => {
  const rows = segments(BOARD);
  assert.deepEqual(rows.map(row => row.uuid), ['s1', 's2', 's3', 's4']);
  assert.deepEqual([rows[0]!.start, rows[0]!.end, rows[0]!.width, rows[0]!.layer, rows[0]!.net], [[0, 0], [1, 0], 0.25, 'F.Cu', 'A']);
  assert.ok(BOARD.slice(...rows[1]!.span).includes('"s2"'));
  assert.equal(segments(BOARD.replace('(uuid "s2")', '(uuid "s2") (locked yes)'))[1]!.locked, true);
});

test('moving a footprint keeps the rest of the text and gives back the pose it had', () => {
  const moved = moveFootprint(BOARD, 'C1', 3);
  assert.deepEqual(moved.pose, [10, 20, 90]);
  assert.ok(moved.text.includes('(at 13 20 90)'));
  assert.equal(moved.text.length, BOARD.length);
  assert.throws(() => moveFootprint(BOARD, 'R9', 1), /no footprint R9/);
});

test('a gap is cut from the interior of a run of copper only, and the guard can veto it', () => {
  const gap = removeSegment(BOARD, () => true);
  assert.equal(gap.removed.uuid, 's2');
  assert.deepEqual(segments(gap.text).map(row => row.uuid), ['s1', 's3', 's4']);
  assert.throws(() => removeSegment(BOARD, () => false), /no interior segment/);
});

test('a gap never comes from a loop or a poured net: it would open nothing', () => {
  const loop = BOARD.replace(')\n', ')\n').replace(/\)\n$/, `${segment('0 0', '0 1', 'A', 'l1')}${segment('0 1', '3 1', 'A', 'l2')}${segment('3 1', '3 0', 'A', 'l3')})\n`);
  assert.throws(() => removeSegment(loop, row => row.net === 'A'), /no interior segment/);
  const poured = BOARD.replace(/\)\n$/, '\t(zone\n\t\t(net "A")\n\t)\n)\n');
  assert.throws(() => removeSegment(poured, () => true), /no interior segment/);
});

test('short, clearance and pad-net defects each add exactly their copper or change one pad', () => {
  const short = segments(withShort(BOARD)).at(-1)!;
  assert.deepEqual([short.start, short.end, short.net], [[1, 0], [6, 5], 'A']);
  const near = segments(withClearance(BOARD, 0.1, 0.2)).at(-1)!;
  assert.deepEqual([near.net, near.width, near.start[1], near.end[1]], ['B', 0.2, 0.325, 0.325]);
  assert.ok(near.start[0] > 0 && near.end[0] < 1);
  const wrong = withWrongPadNet(BOARD, 'C1');
  assert.ok(wrong.includes('(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "B")'));
  assert.ok(wrong.includes('(pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net "B")'));
});

test('the layout of a board ignores number spelling and sees a moved part or changed copper', t => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-smoke-board-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const layout = (text: string) => { const path = join(root, 'board.kicad_pcb'); writeFileSync(path, text); return layoutOf(path); };
  const base = layout(BOARD);
  assert.deepEqual(layout(BOARD.replace('(start 0 0)', '(start 0.0 0.00)')), base);
  assert.notDeepEqual(layout(moveFootprint(BOARD, 'C1', 1).text).poses, base.poses);
  assert.notDeepEqual(layout(removeSegment(BOARD, () => true).text).copper, base.copper);
});
