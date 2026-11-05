import assert from 'node:assert/strict';
import { test } from 'node:test';
import { astar, closestReach, dropJogs, mmWord, nodeCorners, pathPoints, stateOf, viaLayers, viaWords, type EndCosts, type LinePoint, type SearchGrid } from './grid-search.ts';

const ones = (count: number): Uint8Array => new Uint8Array(count).fill(1);
const grid = (cols: number, rows: number, free: Uint8Array[], viaOk: Uint8Array, viaCost = 2): SearchGrid =>
  ({ cols, rows, cell: 1, free, viaOk, extra: free.map(() => new Float64Array(cols * rows)), viaCost });
const ends = (layers: number, ...states: [node: number, layer: number, cost: number][]): EndCosts => new Map(states.map(([node, layer, cost]) => [stateOf(node, layer, layers), cost]));
const end = (at: [number, number]): LinePoint => ({ kind: 'end', at });
const through = (at: [number, number]): LinePoint => ({ kind: 'through', at });

test('corners keep turns and vias only', () => {
  const path: [number, number][] = [[0, 0], [1, 0], [2, 0], [13, 0], [24, 0], [24, 1], [25, 1], [26, 1]];
  assert.deepEqual(nodeCorners(path, 10), [{ kind: 'through', node: 2 }, { kind: 'via', node: 24 }]);
});

test('a path goes under a wall through two vias', () => {
  const [cols, rows] = [5, 3];
  const wall = Uint8Array.from({ length: 15 }, (_, i) => (i % cols !== 2 ? 1 : 0));
  const found = astar(grid(cols, rows, [wall, ones(15)], ones(15)), ends(2, [5, 0, 0]), ends(2, [9, 0, 0]), 9);
  assert.ok(found.path);
  assert.ok(found.path.some(([, layer]) => layer === 1));
  assert.deepEqual(found.path[0], [5, 0]);
  assert.deepEqual(found.path.at(-1), [9, 0]);
  assert.ok(Math.abs(found.cost - (4 + 2 * 2)) < 1e-9);
});

test('no path gives the nodes reached', () => {
  const wall = Uint8Array.from({ length: 15 }, (_, i) => (i % 5 !== 2 ? 1 : 0));
  const found = astar(grid(5, 3, [wall], new Uint8Array(15)), ends(1, [5, 0, 0]), ends(1, [9, 0, 0]), 9);
  assert.equal(found.path, null);
  assert.ok(found.path === null && found.reached.has(6) && !found.reached.has(8));
});

test('a failed search tells reaching below a pad from reaching its layer', () => {
  const top = Uint8Array.from([1, 1, 0, 1, 1]);
  const found = astar(grid(5, 1, [top, ones(5)], new Uint8Array(5)), ends(2, [0, 0, 0], [0, 1, 0]), ends(2, [4, 0, 0]), 4);
  assert.ok(found.path === null && found.reached.has(4));
  const { closest, onTargetLayer } = closestReach(found.masks, node => [node, 0], [4, 0], new Set([0]), ['F.Cu', 'B.Cu'], new Uint8Array(5));
  assert.equal(closest!.distanceMm, 0);
  assert.deepEqual(closest!.layers, ['B.Cu']);
  assert.equal(closest!.viaAllowed, false);
  assert.equal(onTargetLayer!.distanceMm, 3);
});

test('an unreached target layer reports no access', () => {
  const { onTargetLayer } = closestReach(new Map([[1, 2]]), node => [node, 0], [1, 0], new Set([0]), ['F.Cu', 'B.Cu'], new Uint8Array(2));
  assert.equal(onTargetLayer, null);
});

test('the search ends at the goal node of the lowest total cost', () => {
  const search = grid(5, 1, [ones(5)], new Uint8Array(5));
  const far = astar(search, ends(1, [0, 0, 0]), ends(1, [3, 0, 5], [4, 0, 0]), 4);
  assert.ok(far.path);
  assert.deepEqual([far.path.at(-1), far.cost], [[4, 0], 4]);
  const near = astar(search, ends(1, [0, 0, 0]), ends(1, [3, 0, 0.5], [4, 0, 0]), 4);
  assert.ok(near.path);
  assert.deepEqual([near.path.at(-1), near.cost], [[3, 0], 3.5]);
});

test('the search starts at the start node of the lowest total cost', () => {
  const found = astar(grid(5, 1, [ones(5)], new Uint8Array(5)), ends(1, [0, 0, 0], [2, 0, 1]), ends(1, [4, 0, 0]), 4);
  assert.ok(found.path);
  assert.deepEqual([found.path[0], found.cost], [[2, 0], 3]);
});

test('off-centre end nodes are added once', () => {
  const via: LinePoint = { kind: 'via', at: [4, 0] };
  assert.deepEqual(pathPoints([0, 0], [5, 0.05], [0.1, 0], [via], [4, 0]), [end([0, 0]), through([0.1, 0]), via, end([5, 0.05])]);
  assert.deepEqual(pathPoints([0, 0], [5, 0], [0, 0], [], [5, 0]), [end([0, 0]), end([5, 0])]);
});

test('jogs and straight points go when the direct leg is free', () => {
  const points = [end([0, 0]), through([5, 0]), through([5.2, 0.2]), through([8, 0.2]), end([10, 0.2])];
  assert.deepEqual(dropJogs(points, 'F.Cu', () => true), [end([0, 0]), end([10, 0.2])]);
});

test('a jog stays when the direct leg is blocked', () => {
  const points = [end([0, 0]), through([5, 0]), through([5.2, 0.2]), end([10, 0.2])];
  assert.deepEqual(dropJogs(points, 'F.Cu', () => false), points);
});

test('the layer after a via is the other side, or its named target', () => {
  const seen: string[] = [];
  const check = (via: LinePoint): void => {
    dropJogs([end([0, 0]), via, through([4, 0]), end([6, 0])], 'F.Cu', (_a, _b, _c, layer) => { seen.push(layer); return true; });
  };
  check({ kind: 'via', at: [2, 0] });
  check({ kind: 'via', at: [2, 0], to: 'In2.Cu' });
  assert.deepEqual(seen, ['B.Cu', 'In2.Cu']);
});

test('the layer after each via of a node path', () => {
  assert.deepEqual(viaLayers([[0, 0], [1, 0], [1, 2], [2, 2], [2, 1], [3, 1]]), [2, 1]);
});

test('a via names its target only off F.Cu <-> B.Cu', () => {
  assert.equal(viaWords([1, 2], 'F.Cu', 'B.Cu'), ' via 1,2');
  assert.equal(viaWords([1, 2.5], 'F.Cu', 'In2.Cu'), ' via 1,2.5@In2.Cu');
  assert.equal(viaWords([1, 2], 'In2.Cu', 'B.Cu'), ' via 1,2@B.Cu');
});

test('millimetres are six places with no trailing zeros', () => {
  assert.equal(mmWord(100), '100');
  assert.equal(mmWord(0.1 + 0.2), '0.3');
  assert.equal(mmWord(12.3456789), '12.345679');
});
