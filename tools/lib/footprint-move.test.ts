import assert from 'node:assert/strict';
import { test } from 'node:test';
import { childForms, footprintAngle, movedFootprint } from './footprint-move.ts';

const FOOTPRINT = `(footprint "lib:C (x)"
\t\t(layer "F.Cu")
\t\t(uuid "aaaa")
\t\t(at 10 20)
\t\t(property "Reference" "C1 (at 9 9 9)"
\t\t\t(at 0 -4 0)
\t\t\t(layer "F.Fab")
\t\t)
\t\t(fp_line
\t\t\t(start -1 0)
\t\t\t(end 1 0)
\t\t)
\t\t(fp_text user "T"
\t\t\t(at 1 2 90)
\t\t)
\t\t(pad "1" smd rect
\t\t\t(at -0.7 0)
\t\t\t(size 1 1)
\t\t)
\t\t(pad "2" smd rect
\t\t\t(at 0.7 0 180)
\t\t\t(size 1 1)
\t\t)
\t\t(zone
\t\t\t(polygon
\t\t\t\t(pts
\t\t\t\t\t(xy 10 20) (xy 12 20) (xy 12 21)
\t\t\t\t)
\t\t\t)
\t\t)
\t)`;

const lines = (text: string, pattern: RegExp): string[] => text.split('\n').filter(line => pattern.test(line)).map(line => line.trim());

test('children are the direct forms, and a parenthesis in a string is no form', () => {
  assert.deepEqual(childForms(FOOTPRINT).map(form => form.kind), ['layer', 'uuid', 'at', 'property', 'fp_line', 'fp_text', 'pad', 'pad', 'zone']);
});

test('a footprint angle is in (-180, 180]', () => {
  assert.deepEqual([0, 90, 180, 270, 360, -90, -180, 45].map(footprintAngle), [0, 90, 180, -90, 0, -90, 180, 45]);
});

test('a move with no turn changes only the footprint position, and the zone with it', () => {
  const moved = movedFootprint(FOOTPRINT, { x: 10, y: 20, rot: 0 }, { x: 11, y: 19.5, rot: 0 });
  assert.match(moved, /\(at 11 19\.5 0\)/);
  assert.deepEqual(lines(moved, /^\s*\(at /).slice(1), ['(at 0 -4 0)', '(at 1 2 90)', '(at -0.7 0 0)', '(at 0.7 0 180)']);
  assert.match(moved, /\(xy 11 19\.5\) \(xy 13 19\.5\) \(xy 13 20\.5\)/);
});

test('a turn adds to the angle of pads, fields and texts; their positions and graphics stay', () => {
  const moved = movedFootprint(FOOTPRINT, { x: 10, y: 20, rot: 0 }, { x: 10, y: 20, rot: 270 });
  assert.deepEqual(lines(moved, /^\s*\(at /), ['(at 10 20 -90)', '(at 0 -4 270)', '(at 1 2 0)', '(at -0.7 0 270)', '(at 0.7 0 90)']);
  assert.match(moved, /\(start -1 0\)/);
});

test('the text of a field that looks like an (at) is left alone', () => {
  assert.match(movedFootprint(FOOTPRINT, { x: 10, y: 20, rot: 0 }, { x: 1, y: 1, rot: 90 }), /"C1 \(at 9 9 9\)"/);
});

test('a zone turns about the old position, then moves: a right angle is exact', () => {
  const moved = movedFootprint(FOOTPRINT, { x: 10, y: 20, rot: 0 }, { x: 10, y: 20, rot: 90 });
  assert.match(moved, /\(xy 10 20\) \(xy 10 18\) \(xy 11 18\)/);
});

test('a zone at an odd angle lands on whole nanometres', () => {
  const moved = movedFootprint(FOOTPRINT, { x: 10, y: 20, rot: 0 }, { x: 10, y: 20, rot: 30 });
  assert.match(moved, /\(xy 11\.732051 19\) /);
});
