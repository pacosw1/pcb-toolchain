import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandRoute, floatPoint, gridPositions, intentRoute, leg, parseIntent, placements, specPoint, type RouteSpec } from './route-spec.ts';

const route = (path: RouteSpec['path'], extra: Partial<RouteSpec> = {}): RouteSpec => ({ net: 'N', width: 0.2, layer: 'F.Cu', path, ...extra });

test('a grid fills rows of cols and rounds to 4 places', () => {
  const placed = gridPositions({ refs: ['A', 'B', 'C'], origin: [1, 2], pitch: [0.1, 0.2], cols: 2, rot: 90 });
  assert.deepEqual([...placed], [['A', [1, 2, 90]], ['B', [1.1, 2, 90]], ['C', [1, 2.2, 90]]]);
});

test('a part placed by name and by grid is an error', () => {
  assert.throws(() => placements({ place: { R1: [0, 0, 0] }, grids: [{ refs: ['R1'], origin: [1, 1], pitch: [1, 1] }] }), /R1 is placed twice/);
});

test('a via changes the layer and starts the next segment', () => {
  const { segments, vias } = expandRoute(route([[0, 0], [1, 0], { via: [1, 0] }, [2, 0]]));
  assert.deepEqual(segments.map(s => [s.a, s.b, s.layer]), [[[0, 0], [1, 0], 'F.Cu'], [[1, 0], [2, 0], 'B.Cu']]);
  assert.deepEqual(vias, [[1, 0]]);
});

test('a via away from the last point gets a segment to it, and may name its target layer', () => {
  const { segments } = expandRoute(route([[0, 0], { via: [1, 0], to: 'In1.Cu' }, [2, 0]]));
  assert.deepEqual(segments.map(s => s.layer), ['F.Cu', 'In1.Cu']);
});

test('bad paths say why, in the numbers of the spec', () => {
  assert.throws(() => expandRoute(route([[0, 0]])), /N: a path needs 2 or more points/);
  assert.throws(() => expandRoute(route([[100, 100], [101, 103]])), /N: segment \(100, 100\)->\(101, 103\) is not 0\/45\/90 degrees/);
  assert.throws(() => expandRoute(route([[1.5, 2], [1.5, 2]])), /N: zero-length segment at \(1\.5, 2\)/);
  assert.throws(() => expandRoute(route([[0, 0], { via: [1, 0] }], { layer: 'In1.Cu' })), /via at \(1, 0\) from In1\.Cu needs a target layer/);
});

test('any_angle lets a free segment through', () => {
  assert.equal(expandRoute(route([[0, 0], [1, 3]], { any_angle: true })).segments.length, 1);
});

test('points print as Python printed them: ints as written in a spec, floats in connect', () => {
  assert.equal(specPoint([100, 1.5]), '(100, 1.5)');
  assert.equal(floatPoint([100, 1.5]), '(100.0, 1.5)');
});

test('an intent line reads all its options', () => {
  const intent = parseIntent('GND C6.2 -> C8.2 via=0.5/0.25 width=0.2 layer=B.Cu via 119.9,120 through 118,120 via 118,119@In1.Cu');
  assert.deepEqual(intent, { net: 'GND', a: { ref: 'C6', number: '2' }, b: { ref: 'C8', number: '2' }, layer: 'B.Cu', width: 0.2, via: [0.5, 0.25],
    points: [{ kind: 'via', at: [119.9, 120] }, { kind: 'through', at: [118, 120] }, { kind: 'via', at: [118, 119], to: 'In1.Cu' }] });
});

test('auto leaves width and via to the net class', () => {
  const intent = parseIntent('N A.1 -> B.1 width=auto via=auto');
  assert.equal(intent.width, null);
  assert.equal(intent.via, null);
});

test('a bad intent line says what is wrong', () => {
  assert.throws(() => parseIntent('GND C4.2 C5.2'), /expected "NET REF\.PAD -> REF\.PAD \.\.\.": GND C4\.2 C5\.2/);
  assert.throws(() => parseIntent('N A -> B.1'), /expected REF\.PAD, got A/);
  assert.throws(() => parseIntent('N A.1 -> B.1 through 1'), /through needs x,y \(via: x,y or x,y@LAYER\)/);
  assert.throws(() => parseIntent('N A.1 -> B.1 through 1,2@F.Cu'), /through needs x,y/);
  assert.throws(() => parseIntent('N A.1 -> B.1 via 1,x'), /via needs x,y/);
  assert.throws(() => parseIntent('N A.1 -> B.1 nope'), /unknown option nope/);
});

test('a leg goes half straight, the diagonal, the other half', () => {
  assert.deepEqual(leg([0, 0], [4, 1]), [[1.5, 0], [2.5, 1], [4, 1]]);
  assert.deepEqual(leg([0, 0], [-1, -4]), [[0, -1.5], [-1, -2.5], [-1, -4]]);
});

test('a straight or diagonal leg is one piece', () => {
  assert.deepEqual(leg([0, 0], [3, 0]), [[3, 0]]);
  assert.deepEqual(leg([0, 0], [2, 2]), [[2, 2]]);
});

test('an intent route carries the via and enters waypoints straight', () => {
  const intent = parseIntent('N A.1 -> B.1 via 2,0');
  assert.deepEqual(intentRoute(intent, [0, 0], [2, 3], 'F.Cu', 0.3, [0.6, 0.3]),
    { net: 'N', width: 0.3, layer: 'F.Cu', via_size: 0.6, via_drill: 0.3, path: [[0, 0], { via: [2, 0] }, [2, 3]] });
});
