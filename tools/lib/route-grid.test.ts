import assert from 'node:assert/strict';
import { test } from 'node:test';
import { polyShape, segmentShape, shapeDist } from './copper-gap.ts';
import { floorDiv } from './py-math.ts';
import { roundWhole } from './py-numbers.ts';
import { corridorMap, fitGrid, markNear, polyNodes, type Grid } from './route-grid.ts';

test('the cell stays when the box fits', () => {
  assert.deepEqual(fitGrid([10, 20, 15, 22], 0.25), { x0: 10, y0: 20, cell: 0.25, cols: 20, rows: 8 });
});

test('the cell grows to stay inside the cap', () => {
  const { cell, cols, rows } = fitGrid([0, 0, 100, 10], 0.25, 80, 40);
  assert.ok(cols <= 80 && rows <= 40 && cell * cols >= 100);
});

test('a capsule measures from its edge, 0 or less inside', () => {
  const capsule = segmentShape([0, 0], [10, 0], 0.5);
  assert.ok(Math.abs(shapeDist(capsule, [5, 2]) - 1.5) < 1e-9);
  assert.ok(Math.abs(shapeDist(capsule, [13, 0]) - 2.5) < 1e-9);
  assert.ok(shapeDist(capsule, [5, 0.2]) <= 0);
});

test('a polygon is 0 or less inside, its edge distance outside', () => {
  const square = polyShape([[0, 0], [4, 0], [4, 4], [0, 4]]);
  assert.ok(shapeDist(square, [2, 2]) <= 0);
  assert.ok(Math.abs(shapeDist(square, [7, 2]) - 3) < 1e-9);
});

// 0..4 x 0..1 mm, cell 0.5: centres at x = 0.25, 0.75, ...
const GRID: Grid = { x0: 0, y0: 0, cell: 0.5, cols: 8, rows: 2 };

test('the map marks own copper, other copper and free cells', () => {
  const rows = corridorMap(GRID, {
    outline: null, edgeGap: 0, own: [segmentShape([0, 0], [0, 1], 0.3)], others: [{ shape: segmentShape([2, 0], [2, 1], 0.1), keep: 0.3 }], marks: [['A', [3.8, 0.2]]],
  });
  assert.deepEqual(rows, ['+..##..A', '+..##...']);
});

test('outside the board outline is blocked', () => {
  const rows = corridorMap(GRID, { outline: [[[-1, -1], [3, -1], [3, 2], [-1, 2]]], edgeGap: 0.3, own: [], others: [], marks: [] });
  assert.deepEqual(rows, ['.....###', '.....###']);   // col 5 centre 2.75 is 0.25 from the edge
});

test('nodes closer than keep are blocked and labelled', () => {
  const grid: Grid = { x0: 0, y0: 0, cell: 1, cols: 5, rows: 1 };
  const free = new Uint8Array(5).fill(1);
  const labels = new Int32Array(5).fill(-1);
  markNear(grid, segmentShape([2, 0], [2, 0], 0), 1.5, free, labels, 7);
  assert.deepEqual([...free], [1, 0, 0, 0, 1]);
  assert.deepEqual([...labels], [-1, 7, 7, 7, -1]);
});

test('a hole ring cuts out of the nodes of its outline', () => {
  const grid: Grid = { x0: 0, y0: 0, cell: 1, cols: 7, rows: 7 };
  const outer: [number, number][] = [[0.5, 0.5], [5.5, 0.5], [5.5, 5.5], [0.5, 5.5]];
  const hole: [number, number][] = [[2.5, 2.5], [3.5, 2.5], [3.5, 3.5], [2.5, 3.5]];
  const nodes = polyNodes(grid, [outer, hole]);
  assert.equal(nodes.length, 25 - 1);
  assert.ok(!nodes.includes(3 * 7 + 3));
});

test('floor division and rounding go as in Python', () => {
  assert.equal(floorDiv(0.6, 0.2), 2);
  assert.equal(floorDiv(-0.25, 0.5), -1);
  assert.deepEqual([0.5, 1.5, 2.5, -0.5, 2.4, 2.6].map(roundWhole).map(value => value + 0), [0, 2, 2, 0, 2, 3]);
});
