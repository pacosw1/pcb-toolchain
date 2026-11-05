import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boxProbes, courtyardOf, footprintBox, graphicBox, graphicBoxes, grow, hit, insideBoard, readSilk, toBoard, toFootprint, touch } from './board-silk.ts';
import type { Graphic } from './board-types.ts';
import { fixtureBoard, fixtureText, footprint, footprintForm, pad, polygon, pt, rectRing, silkLine } from './silk-fixture.ts';

const close = (a: readonly number[], b: readonly number[]): void => a.forEach((value, i) => assert.ok(Math.abs(value - b[i]!) < 1e-6, `${a.join(' ')} is not ${b.join(' ')}`));

test('hit leaves out boxes that only touch; touch keeps them, as BOX2::Intersects', () => {
  assert.equal(hit([0, 0, 1, 1], [1, 0, 2, 1]), false);
  assert.equal(touch([0, 0, 1, 1], [1, 0, 2, 1]), true);
  assert.equal(touch([0, 0, 1, 1], [1.1, 0, 2, 1]), false);
});

test('a footprint-local point goes to the board and back, angle counter-clockwise', () => {
  const pose = { at: [10, 20] as const, angle: 90 };
  close(toBoard([1, 0], pose), [10, 19]);
  close(toFootprint(toBoard([3, 4], pose), pose), [3, 4]);
});

test('texts of the board carry size, justification, group and both boxes', () => {
  const form = `\t(gr_text "AB"\n\t\t(at 110 120 0)\n\t\t(layer "B.SilkS")\n\t\t(uuid "t1")\n\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 2 1.5)\n\t\t\t\t(thickness 0.3)\n\t\t\t)\n\t\t\t(justify left top mirror)\n\t\t)\n\t)\n`
    + '\t(group "brand X"\n\t\t(uuid "g1")\n\t\t(members "t1")\n\t)\n';
  const [text] = readSilk(fixtureText(form)).texts;
  assert.equal(text!.group, 'brand X');
  assert.deepEqual([text!.style.height, text!.style.width, text!.style.h, text!.style.v, text!.style.mirrored], [2, 1.5, 'left', 'top', true]);
  assert.ok(text!.box[2] <= 110 && text!.box[0] < text!.ink[0], 'mirrored left text runs to the left, and the box holds the ink');
});

test('a footprint text is placed by its footprint, hidden fields are marked', () => {
  const { footprintTexts } = readSilk(fixtureText(footprintForm('J1', 130, 120, 'f1', 90)));
  const [reference, value] = footprintTexts;
  assert.deepEqual([reference!.reference, reference!.name, reference!.visible, value!.visible], ['J1', 'Reference', true, false]);
  close(reference!.at, [127, 120]); // (0, -3) turned a quarter
});

test('shapes of the board carry their stroke', () => {
  const line = '\t(gr_line\n\t\t(start 0 0)\n\t\t(end 10 0)\n\t\t(stroke\n\t\t\t(width 0.2)\n\t\t\t(type default)\n\t\t)\n\t\t(layer "F.SilkS")\n\t\t(uuid "l1")\n\t)\n';
  const circle = '\t(gr_circle\n\t\t(center 5 5)\n\t\t(end 7 5)\n\t\t(stroke\n\t\t\t(width 0)\n\t\t\t(type default)\n\t\t)\n\t\t(layer "F.SilkS")\n\t\t(uuid "c1")\n\t)\n';
  const arc = '\t(gr_arc\n\t\t(start 1 0)\n\t\t(mid 0 1)\n\t\t(end -1 0)\n\t\t(stroke\n\t\t\t(width 0)\n\t\t\t(type default)\n\t\t)\n\t\t(layer "F.SilkS")\n\t\t(uuid "a1")\n\t)\n';
  const { shapes } = readSilk(fixtureText(line, circle, arc));
  close(shapes.find(shape => shape.uuid === 'l1')!.box, [-0.1, -0.1, 10.1, 0.1]);
  close(shapes.find(shape => shape.uuid === 'c1')!.box, [3, 3, 7, 7]);
  close(shapes.find(shape => shape.uuid === 'a1')!.box, [-1, 0, 1, 1]);
});

test('an arc of the document runs from start to end with a growing angle', () => {
  const arc = { id: 'a', layer: 'F.SilkS', width: 0, filled: false, geometry: { Arc: { start: pt(1, 0), end: pt(-1, 0), center: pt(0, 0) } } } as Graphic;
  close(graphicBox(arc)!, [-1, 0, 1, 1]);
});

test('graphicBoxes gives whole boxes of the layer only', () => {
  const items = [silkLine(0, 0, 1, 1), silkLine(5, 5, 6, 6, 'B.SilkS')];
  assert.equal(graphicBoxes(items, 'F.SilkS').length, 1);
  close(graphicBoxes(items, 'F.SilkS')[0]!, grow([0, 0, 1, 1], 0.05));
});

test('a courtyard box grows by its commonest stroke, as GetCourtyard().BBox() does', () => {
  const part = footprint('U1', 10, 10, [], polygon(0, 0, 4, 2));
  part.graphics = [silkLine(0, 0, 4, 0, 'F.CrtYd', 100_000), silkLine(0, 2, 4, 2, 'F.CrtYd', 100_000), silkLine(0, 0, 0, 2, 'F.CrtYd', 50_000)];
  close(courtyardOf(part)!, [-0.1, -0.1, 4.1, 2.1]);
  part.graphics = [];
  close(courtyardOf(part)!, [-0.05, -0.05, 4.05, 2.05]);
  assert.equal(courtyardOf(footprint('U2', 0, 0, [])), null);
});

test('a footprint with no courtyard stands for its pads and shapes', () => {
  const part = footprint('U1', 10, 10, [pad('1', '', 10, 10)]);
  part.graphics = [silkLine(9, 9, 12, 9)];
  close(footprintBox(part), [9 - 0.05, 9 - 0.05, 12.05, 10.5]);
});

test('insideBoard keeps the gap to the outline and to cut-outs', () => {
  const board = fixtureBoard([]);
  board.outlines = [{ outline: rectRing(100, 100, 160, 140), holes: [rectRing(120, 110, 130, 120)] }];
  assert.equal(insideBoard(board, [100.5, 120]), true);
  assert.equal(insideBoard(board, [100.5, 120], 1), false);
  assert.equal(insideBoard(board, [125, 115]), false);
  assert.equal(insideBoard(board, [119.5, 115], 1), false);
  assert.equal(insideBoard(board, [118, 115], 1), true);
});

test('a box is probed at its corners and edge middles', () => {
  assert.deepEqual(boxProbes([0, 0, 2, 2]), [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]]);
});
