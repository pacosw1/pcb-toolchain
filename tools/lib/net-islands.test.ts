import assert from 'node:assert/strict';
import { test } from 'node:test';
import { board, box, pad, part, track, via, zone } from './board-fixture.ts';
import { mstPairs, netPadPairs } from './net-islands.ts';

const names = (b: ReturnType<typeof board>): string[][] => netPadPairs(b, 'SIG').map(([a, c]) => [a.name, c.name]);
const parts = [part('R1', pad('1', 'SIG', 10, 10)), part('R2', pad('1', 'SIG', 20, 10)), part('R3', pad('1', 'SIG', 26, 10))];

test('the nearest pads join the islands', () => {
  const islands: [string, [number, number]][][] = [[['U1.1', [0, 0]]], [['R1.1', [10, 0]], ['R1.2', [5, 0]]], [['C1.1', [5, 4]]]];
  assert.deepEqual(mstPairs(islands), [['U1.1', 'R1.2'], ['R1.2', 'C1.1']]);
});

test('one island needs nothing', () => {
  assert.deepEqual(mstPairs([[['U1.1', [0, 0]], ['U1.2', [1, 0]]]]), []);
});

test('pads with no copper between them pair up, nearest first', () => {
  assert.deepEqual(names(board(parts)), [['R1.1', 'R2.1'], ['R2.1', 'R3.1']]);
});

test('a track between two pads joins them', () => {
  assert.deepEqual(names(board(parts, [track('SIG', 10, 10, 20, 10)])), [['R2.1', 'R3.1']]);
});

test('a track on the other layer does not touch an SMD pad', () => {
  assert.deepEqual(names(board(parts, [track('SIG', 10, 10, 20, 10, 'B.Cu')])).length, 2);
});

test('a via joins the layers', () => {
  const copper = [track('SIG', 10, 10, 15, 10), via('SIG', 15, 10), track('SIG', 15, 10, 18, 10, 'B.Cu'), via('SIG', 18, 10), track('SIG', 18, 10, 20, 10)];
  assert.deepEqual(names(board(parts, copper)), [['R2.1', 'R3.1']]);
});

test('copper of another net joins nothing', () => {
  assert.equal(names(board(parts, [track('GND', 10, 10, 20, 10)])).length, 2);
});

test('a filled island joins the pads it reaches, and only filled copper counts', () => {
  const fill = [box(9, 9, 21, 11)];
  assert.deepEqual(names(board(parts, [], [zone('SIG', 9, 9, 21, 11, { fill })])), [['R2.1', 'R3.1']]);
  assert.equal(names(board(parts, [], [zone('SIG', 9, 9, 21, 11)])).length, 2);
});

test('two islands of a fill stay apart', () => {
  const fill = [box(9, 9, 11, 11), box(19, 9, 21, 11)];
  assert.equal(names(board(parts, [], [zone('SIG', 9, 9, 21, 11, { fill })])).length, 2);
});

test('a track end inside an island joins it; a track that only passes over does not', () => {
  const fill = [box(14, 5, 16, 15)];
  const ending = [track('SIG', 10, 10, 15, 10), track('SIG', 15, 10, 20, 10)];
  assert.deepEqual(names(board(parts, ending, [zone('SIG', 14, 5, 16, 15, { fill })])), [['R2.1', 'R3.1']]);
});
