import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearMargin, dotShape, firstConflict, inPoly, polyShape, segDist, segmentShape, segSegDist, shapeSegDist, type Obstacles } from './copper-gap.ts';
import type { RouteSegment, Xy } from './route-spec.ts';

const square: Xy[] = [[0, 0], [2, 0], [2, 2], [0, 2]];
const segment = (a: Xy, b: Xy, width = 0.2): RouteSegment => ({ a, b, layer: 'F.Cu', width });

test('distance to a segment stops at its ends', () => {
  assert.equal(segDist([1, 1], [0, 0], [2, 0]), 1);
  assert.equal(segDist([5, 0], [0, 0], [2, 0]), 3);
  assert.equal(segDist([3, 4], [0, 0], [0, 0]), 5);
});

test('a point is in a polygon by the even-odd rule', () => {
  assert.equal(inPoly([1, 1], square), true);
  assert.equal(inPoly([3, 1], square), false);
});

test('crossing segments are 0 apart, parallel ones their gap', () => {
  assert.equal(segSegDist([0, 0], [2, 2], [0, 2], [2, 0]), 0);
  assert.equal(segSegDist([0, 0], [2, 0], [0, 1], [2, 1]), 1);
});

test('a segment that starts in a polygon or crosses it is 0 from it; a fat segment measures from its edge', () => {
  assert.equal(shapeSegDist(polyShape(square), [1, 1], [5, 5]), 0);
  assert.equal(shapeSegDist(polyShape(square), [-1, 1], [3, 1]), 0);
  assert.equal(shapeSegDist(polyShape(square), [3, 1], [5, 1]), 1);
  assert.equal(shapeSegDist(segmentShape([0, 0], [2, 0], 0.25), [0, 1], [2, 1]), 0.75);
});

const obstacles: Obstacles = {
  'F.Cu': [{ shape: dotShape([5, 0], 0.5), clearance: 0.2, label: 'via GND' }],
  'B.Cu': [{ shape: polyShape(square), clearance: 0, label: 'track keepout' }],
};

test('no conflict gives null', () => {
  assert.equal(firstConflict([segment([0, 0], [4, 0])], [], 0.6, obstacles), null);
});

test('a conflict names the layer, the item, the gap and the obstacle', () => {
  assert.equal(firstConflict([segment([0, 0], [4.3, 0], 0.3)], [], 0.6, obstacles), 'F.Cu track (0.000, 0.000)-(4.300, 0.000) w 0.3: gap 0.050 < 0.2 to via GND');
});

test('a via is checked on every layer', () => {
  assert.equal(firstConflict([], [[1, 1]], 0.6, obstacles), 'B.Cu via (1.000, 1.000) w 0.6: gap -0.300 < 0 to track keepout');
});

test('the margin is the gap less the clearance, at most the window', () => {
  assert.equal(clearMargin([], [[20, 20]], 0.6, obstacles), 1);
  assert.ok(Math.abs(clearMargin([], [[4, 0]], 0.6, { 'F.Cu': obstacles['F.Cu']! }) - 0) < 1e-9);
  assert.ok(clearMargin([], [[4.2, 0]], 0.6, { 'F.Cu': obstacles['F.Cu']! }) < 0);
});
