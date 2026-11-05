import assert from 'node:assert/strict';
import { test } from 'node:test';
import { offsetOutlines, type BarrierShape } from './barrier-line.ts';

const NEAR_MM = 0.06; // one grid pitch and a little
const square = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

test('nothing to grow gives no line', () => {
  assert.deepEqual(offsetOutlines([], 1), []);
});

test('the line round a dot stands at the radius plus the distance', () => {
  const [ring, ...rest] = offsetOutlines([{ kind: 'capsule', a: [10, 10], b: [10, 10], radius: 0.5 }], 1.5);
  assert.equal(rest.length, 0);
  for (const [x, y] of ring!) assert.ok(Math.abs(Math.hypot(x - 10, y - 10) - 2) < NEAR_MM);
});

test('the line along a track stays parallel to it', () => {
  const [ring] = offsetOutlines([{ kind: 'capsule', a: [0, 0], b: [20, 0], radius: 0.25 }], 1);
  const crossings = ring!.flatMap(([ax, ay], i) => { // the straight sides keep only their ends: read them at the middle
    const [bx, by] = ring![(i + 1) % ring!.length]!;
    return (ax - 10) * (bx - 10) < 0 ? [ay + (10 - ax) * (by - ay) / (bx - ax)] : [];
  });
  assert.equal(crossings.length, 2);
  for (const y of crossings) assert.ok(Math.abs(Math.abs(y) - 1.25) < NEAR_MM);
});

test('two shapes nearer than twice the distance share one line', () => {
  const dots: BarrierShape[] = [{ kind: 'capsule', a: [0, 0], b: [0, 0], radius: 0.5 }, { kind: 'capsule', a: [3, 0], b: [3, 0], radius: 0.5 }];
  assert.equal(offsetOutlines(dots, 1.5).length, 1);
  assert.equal(offsetOutlines(dots, 0.5).length, 2);
});

test('a line that bounds a hole of the region is left out', () => {
  const frame: BarrierShape = { kind: 'polygon', rings: [square(0, 0, 20, 20), square(5, 5, 15, 15)] };
  const rings = offsetOutlines([frame], 1);
  assert.equal(rings.length, 1);
  assert.ok(Math.max(...rings[0]!.map(point => point[0])) > 20.9);
});

test('a simple edge needs few points', () => {
  const [ring] = offsetOutlines([{ kind: 'polygon', rings: [square(0, 0, 10, 10)] }], 1);
  assert.ok(ring!.length < 80, `${ring!.length} points`);
});
