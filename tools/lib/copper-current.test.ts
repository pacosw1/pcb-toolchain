import assert from 'node:assert/strict';
import { test } from 'node:test';
import { areaAmps, endRise, ipcAmps, ipcRise, jouleRise, neckAmps, neckCapacity, neckChains, neckMaxMm, neckPeakRise, nodeId, pinEscape, trackAmps, viaGroupAmps, type Evidence, type Piece, type Xy } from './copper-current.ts';

const near = (actual: number, expected: number, delta: number): void => assert.ok(Math.abs(actual - expected) <= delta, `${actual} is not ${expected} +- ${delta}`);
const PLANE: Evidence[] = [{ kind: 'plane' }];
const PAD: Evidence[] = [{ kind: 'pad' }];
const piece = (u: Xy, v: Xy, width: number): Piece => ({ group: 'F', u, v, width, thickness: 0.035 });

test('IPC-2221 external 1 oz matches the BACKUP-POWER layout table', () => {
  near(ipcAmps(0.25), 0.87, 0.03);
  near(ipcAmps(1), 2.4, 0.1);
  near(ipcAmps(1.5), 3.2, 0.1);
});

test('an inner layer uses the external constant: 0.5 mm 0.5 oz is 0.79 A (D-124, report A3)', () => {
  near(ipcAmps(0.5, 0.0152), 0.79, 0.02);
});

test('a via group is rated by its barrel area, as the feeding trace', () => {
  near(viaGroupAmps([0.3]), ipcAmps(0.5), 0.05);
  near(viaGroupAmps([0.3, 0.3, 0.3, 0.3]), areaAmps(4 * Math.PI * 0.3 * 0.018), 1e-9);
  assert.ok(viaGroupAmps([0.3, 0.3, 0.3, 0.3]) < 4 * viaGroupAmps([0.3]));
});

test('the neck length limit matches report C5', () => {
  near(neckMaxMm(0.25, 0.035, 2.3), 5.1, 0.1);
  near(neckMaxMm(0.3, 0.035, 1), 14.1, 0.2);
  near(neckMaxMm(0.2, 0.035, 0.5), 18.8, 0.3);
  near(neckAmps(0.3, 0.035, neckMaxMm(0.3, 0.035, 1)), 1, 1e-6);
  assert.ok(neckAmps(0.24, 0.035, 2.27) > 1.1);
  assert.equal(neckMaxMm(0.3, 0.035, 0), Infinity);
  assert.equal(neckAmps(0.3, 0.035, 0), Infinity);
});

test('neck chains stop at pads, branches and wider copper', () => {
  const pieces = [piece([0, 0], [5, 0], 1), piece([5, 0], [6, 0], 0.3), piece([6, 0], [7.27, 0], 0.24), piece([7.27, 0], [12, 0], 1), piece([12, 0], [13, 0], 0.3)];
  const chains = neckChains(pieces, new Set([nodeId('F', [12, 0])]));
  near(chains[1]!.length, 2.27, 1e-6);       // the 0.3 piece spans the whole neck
  near(chains[1]!.minWidth, 0.24, 1e-12);    // at the narrowest width
  near(chains[2]!.length, 1.27, 1e-6);       // the 0.24 piece does not extend into wider copper
  near(chains[4]!.length, 1, 1e-12);         // a stop (pad, via, zone) ends a chain
});

test('a neck chain reports its end nodes', () => {
  const pieces = [piece([0, 0], [5, 0], 1), piece([5, 0], [6, 0], 0.3), piece([6, 0], [7.27, 0], 0.24), piece([7.27, 0], [12, 0], 1)];
  const chains = neckChains(pieces);
  assert.deepEqual([...chains[1]!.ends].sort(), [nodeId('F', [5, 0]), nodeId('F', [7.27, 0])].sort());
  assert.deepEqual([...chains[2]!.ends].sort(), [nodeId('F', [6, 0]), nodeId('F', [7.27, 0])].sort());
});

test('a track with no end evidence is rated by IPC alone', () => {
  near(trackAmps(0.25, 0.035, 10, { length: 2.27, minWidth: 0.25 }), ipcAmps(0.25), 1e-9);
  near(trackAmps(0.25, 0.035, 10, { length: 100, minWidth: 0.25 }), ipcAmps(0.25), 1e-9);
});

test('ipcRise inverts ipcAmps', () => {
  for (const [w, t, rise] of [[0.25, 0.035, 10], [1, 0.035, 4], [0.5, 0.0152, 20]] as const) near(ipcRise(ipcAmps(w, t, rise), w, t), rise, 1e-9);
});

test('the Joule rise is the fin peak', () => {
  const [area, length] = [0.25 * 0.035e-6, 2.27e-3];
  near(jouleRise(0.25, 0.035, 2.27, 1.1), 1.1 ** 2 * 1.72e-8 * length ** 2 / (8 * 390 * area ** 2), 1e-12);
});

test('a neck between two planes passes', () => {
  const rise = neckPeakRise(0.25, 0.035, 2.27, 1.1, [PLANE, PLANE], 10);
  near(rise, jouleRise(0.25, 0.035, 2.27, 1.1), 1e-12);
  assert.ok(rise < 10);
  assert.ok(neckCapacity(0.25, 0.035, 2.27, [PLANE, PLANE], 10) > 1.1);
});

test('a neck to a wide track uses that track\'s rise', () => {
  const wide: Evidence[] = [{ kind: 'track', width: 1, thickness: 0.035 }];
  near(neckPeakRise(0.25, 0.035, 2.27, 1.1, [PLANE, wide], 10), ipcRise(1.1, 1, 0.035) + jouleRise(0.25, 0.035, 2.27, 1.1), 1e-12);
  const capacity = neckCapacity(0.25, 0.035, 2.27, [PLANE, wide], 10);
  near(neckPeakRise(0.25, 0.035, 2.27, capacity, [PLANE, wide], 10), 10, 1e-6);
  assert.ok(neckPeakRise(0.25, 0.035, 2.27, 1.1, [PAD, wide], 10) > 10);
  assert.equal(neckCapacity(0.25, 0.035, 2.27, [PAD, wide], 10), 0);
});

test('a neck to an unknown pad end has no credit', () => {
  assert.equal(neckCapacity(0.25, 0.035, 0.1, [PLANE, PAD], 10), 0);
  assert.equal(neckCapacity(0.25, 0.035, 0.1, [PLANE, []], 10), 0);
  near(trackAmps(0.25, 0.035, 10, { length: 0.1, minWidth: 0.25 }, [PLANE, PAD]), ipcAmps(0.25), 1e-9);
  assert.equal(neckCapacity(0.25, 0.035, 2.27, [PAD, PAD], 10), 0);
});

test('an end takes the coolest evidence', () => {
  assert.equal(endRise([{ kind: 'pad' }, { kind: 'plane' }], 1, 10), 0);
  assert.equal(endRise([{ kind: 'pad' }], 1, 10), 10);
});

test('a pin escape needs a rating and stays within the pad', () => {
  assert.ok(pinEscape(0.5, 0.3, 0.3, 0.6, 2.7, 1.1));
  assert.ok(!pinEscape(0.5, 0.3, 0.3, 0.6, null, 1.1));
  assert.ok(!pinEscape(0.7, 0.3, 0.3, 0.6, 2.7, 1.1));
  assert.ok(!pinEscape(0.5, 0.25, 0.3, 0.6, 2.7, 1.1));
  assert.ok(!pinEscape(0.5, 0.3, 0.3, 0.6, 1, 1.1));
  assert.ok(pinEscape(0.54, 0.25, 0.25, 0.6, 5, 2.6));   // BASE-PWR U10.4
  assert.ok(!pinEscape(2.27, 0.25, 0.3, 0.6, 2.7, 1.1)); // PQ-METER /BST_SW
});
