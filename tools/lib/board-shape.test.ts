import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { boardShape, boardShapeSha256 } from './board-shape.ts';

const BOARD = `(kicad_pcb (version 20240108) (generator "pcbnew")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (setup
    (stackup (layer "F.Cu" (type "copper") (thickness 0.035)) (layer "dielectric 1" (type "core") (thickness 1.51) (material "FR4") (epsilon_r 4.5)))
    (pad_to_mask_clearance 0)
    (pcbplotparams (outputdirectory "old")))
  (net 0 "")
  (net 1 "GND")
  (footprint "R_0402" (layer "F.Cu") (uuid "aaaa") (at 10 10) (property "Reference" "R1"))
  (gr_line (start 0 0) (end 50 0) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "1111"))
  (gr_rect (start 0 0) (end 50 40) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts") (uuid "2222"))
  (gr_text "REV A" (at 5 5) (layer "F.SilkS") (uuid "3333"))
  (segment (start 1 1) (end 2 2) (width 0.2) (layer "F.Cu") (net 1) (uuid "4444"))
  (via (at 3 3) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "5555"))
  (zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "6666") (filled_polygon (layer "F.Cu") (pts (xy 0 0))))
)`;

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'board-shape-')), folder = join(root, 'hardware-design/boards/X');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'gate.json'), JSON.stringify({ project: 'X', checks: {} }));
  writeFileSync(join(folder, 'X.kicad_pcb'), BOARD);
  return { root, pcb: join(folder, 'X.kicad_pcb'), dru: join(folder, 'X.kicad_dru'), hash: () => boardShapeSha256(root, 'X') };
}

test('placement, copper, pours, silk, plot settings and ids do not change the shape', () => {
  const start = JSON.stringify(boardShape(BOARD));
  const legal = [
    BOARD.replace('(at 10 10)', '(at 20 30 90)'),
    BOARD.replace('(segment (start 1 1) (end 2 2)', '(segment (start 1 1) (end 9 9)'),
    BOARD.replace('(via (at 3 3)', '(via (at 7 7)'),
    BOARD.replace('(segment ', '(arc (start 0 0) (mid 1 1) (end 2 0) (width 0.2) (layer "F.Cu") (net 1) (uuid "7777"))\n(segment '),
    BOARD.replace('(pts (xy 0 0))', '(pts (xy 9 9))'),
    BOARD.replace('"REV A"', '"REV B"'),
    BOARD.replace('"old"', '"new"'),
    BOARD.replace('(pad_to_mask_clearance 0)', '(pad_to_mask_clearance 0.05)'),
    BOARD.replace('(net 1 "GND")', '(net 1 "GND") (net 2 "VCC")'),
    BOARD.replace('(uuid "1111")', '(uuid "9999")'),
    BOARD.replace('(stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "1111")', '(stroke (width 0.1) (type solid)) (layer "Edge.Cuts") (uuid "1111")'),
    BOARD.replace('(end 50 0)', '(end 50.000 0)'),
  ];
  for (const board of legal) { assert.notEqual(board, BOARD); assert.equal(JSON.stringify(boardShape(board)), start, board.slice(0, 40)); }
});

test('the order of the outline forms does not change the shape', () => {
  const line = BOARD.match(/ {2}\(gr_line.*\n/)![0], rect = BOARD.match(/ {2}\(gr_rect.*\n/)![0];
  assert.equal(JSON.stringify(boardShape(BOARD.replace(line + rect, rect + line))), JSON.stringify(boardShape(BOARD)));
});

test('the outline, the stackup, the layers and the thickness change the shape', () => {
  const start = JSON.stringify(boardShape(BOARD));
  const shaped = [
    BOARD.replace('(end 50 0)', '(end 60 0)'),
    BOARD.replace('(end 50 40)', '(end 50 45)'),
    BOARD.replace('(uuid "2222")', '(uuid "2222"))\n(gr_circle (center 9 9) (end 9 10) (layer "Edge.Cuts") (uuid "8888")'),
    BOARD.replace('(thickness 1.51)', '(thickness 1.2)'),
    BOARD.replace('(epsilon_r 4.5)', '(epsilon_r 4.1)'),
    BOARD.replace('(general (thickness 1.6))', '(general (thickness 1.2))'),
    BOARD.replace('(31 "B.Cu" signal)', '(1 "In1.Cu" signal) (31 "B.Cu" signal)'),
  ];
  for (const board of shaped) { assert.notEqual(board, BOARD); assert.notEqual(JSON.stringify(boardShape(board)), start, board.slice(0, 40)); }
});

test('a file that is not a board is an error', () => {
  assert.throws(() => boardShape('fixture'), /native PCB/);
  assert.throws(() => boardShape('(kicad_sch)'), /native PCB/);
});

test('the hash covers the design rules file and its absence', t => {
  const f = fixture(t), none = f.hash();
  writeFileSync(f.dru, '(version 1)');
  const first = f.hash();
  assert.notEqual(first, none);
  writeFileSync(f.dru, '(version 1)\n(rule a (constraint clearance (min 0.2mm)))');
  assert.notEqual(f.hash(), first);
  rmSync(f.dru);
  assert.equal(f.hash(), none);
  writeFileSync(f.pcb, BOARD.replace('(at 10 10)', '(at 11 11)'));
  assert.equal(f.hash(), none);
  writeFileSync(f.pcb, BOARD.replace('(end 50 0)', '(end 60 0)'));
  assert.notEqual(f.hash(), none);
});
