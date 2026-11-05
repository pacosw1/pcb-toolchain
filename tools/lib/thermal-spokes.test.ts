import assert from 'node:assert/strict';
import { test } from 'node:test';
import { board, box, pad, part, project, zone } from './board-fixture.ts';
import { round } from './py-numbers.ts';
import { padThermals, spokeSegments, thermalSpokes } from './thermal-spokes.ts';

const rounded = (points: [number, number][]): string[] => points.map(([x, y]) => `${round(x, 3) + 0},${round(y, 3) + 0}`).sort();

test('four spokes from the pad edge out', () => {
  const spokes = spokeSegments([10, 10], 0.5, 0.3, 0, 0, 1);
  assert.deepEqual(rounded(spokes.map(([, end]) => end as [number, number])), ['10,11.3', '10,8.7', '11.5,10', '8.5,10']);
  assert.deepEqual(rounded(spokes.map(([start]) => start as [number, number])), ['10,10.3', '10,9.7', '10.5,10', '9.5,10']);
});

test('spokes at 45 degrees on a round pad', () => {
  for (const [, [x, y]] of spokeSegments([0, 0], 0.5, 0.5, 0, 45, 1, true)) {
    assert.ok(Math.abs(Math.abs(x) - 1.5 / 2 ** 0.5) < 1e-3);
    assert.ok(Math.abs(Math.abs(y) - 1.5 / 2 ** 0.5) < 1e-3);
  }
});

const spokesOf = (...args: Parameters<typeof zone>) => thermalSpokes(board([part('R9', pad('1', 'GND', 15, 11.2))], [], [zone(...args)]), project, 'SIG', 0.2, new Map(), () => ({}));

test('an unfilled zone keeps all four spokes; a filled one those its fill holds', () => {
  assert.equal(spokesOf('GND', 13, 0, 17, 20)['F.Cu']!.length, 4);
  assert.equal(spokesOf('GND', 13, 0, 17, 20, { fill: [box(13, 0, 17, 20)] })['F.Cu']!.length, 4);
  assert.equal(spokesOf('GND', 13, 0, 17, 20, { fill: [box(13, 11.9, 17, 20)] })['F.Cu']!.length, 1);
});

test('no spokes for a pad outside its pour, or for the net being routed', () => {
  assert.deepEqual(spokesOf('GND', 3, 15, 6, 18), {});
  const own = thermalSpokes(board([part('R9', pad('1', 'GND', 15, 11.2))], [], [zone('GND', 13, 0, 17, 20)]), project, 'GND', 0.2, new Map(), () => ({}));
  assert.deepEqual(own, {});
});

test('a full connection has no spokes, and a pad of another net none either', () => {
  const full = pad('1', 'GND', 15, 11.2, 1, 1, { zone_connection: 'Full' });
  assert.deepEqual(thermalSpokes(board([part('R9', full)], [], [zone('GND', 13, 0, 17, 20)]), project, 'SIG', 0.2, new Map(), () => ({})), {});
  assert.deepEqual(thermalSpokes(board([part('R9', pad('1', 'VCC', 15, 11.2))], [], [zone('GND', 13, 0, 17, 20)]), project, 'SIG', 0.2, new Map(), () => ({})), {});
});

test('a pad sets its own spoke width and gap in the board text', () => {
  const text = '(kicad_pcb\n\t(footprint "x"\n\t\t(pad "1" smd rect\n\t\t\t(thermal_bridge_width 0.3)\n\t\t\t(thermal_gap 0.2)\n\t\t\t(uuid "aaa")\n\t\t)\n\t\t(pad "2" smd rect\n\t\t\t(uuid "bbb")\n\t\t)\n\t\t(uuid "fff")\n\t)\n)\n';
  const thermals = padThermals(text);
  assert.deepEqual(thermals(pad('1', 'GND', 0, 0, 1, 1, { id: 'aaa' })), { width: 300000, gap: 200000 });
  assert.deepEqual(thermals(pad('2', 'GND', 0, 0, 1, 1, { id: 'bbb' })), {});
  assert.deepEqual(thermals(pad('3', 'GND', 0, 0, 1, 1, { id: 'none' })), {});
});
