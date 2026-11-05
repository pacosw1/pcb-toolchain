import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newCopper, withCopper, type CopperDocument } from '../import_nets.ts';

const track = (id: string, net: string) => ({ Track: { id, net } });
const via = (id: string, net: string) => ({ Via: { id, net } });
const document = (nets: string[], copper: CopperDocument['board']['copper']): CopperDocument =>
  ({ board: { nets: Object.fromEntries(nets.map(net => [net, 'Default'])), copper } });

const BASE = document(['A', 'B'], [track('old', 'A')]);
const CANDIDATE = document(['A', 'B', 'C'], [track('old', 'A'), track('t1', 'A'), via('v1', 'A'), track('t2', 'B'), track('t3', 'C')]);

test('only new copper of the listed nets is copied, in the order of the candidate', () => {
  assert.deepEqual(newCopper(BASE, CANDIDATE, new Set(['A'])).map(({ id }) => id), ['t1', 'v1']);
});

test('old copper is never copied, even on a listed net', () => {
  assert.ok(!newCopper(BASE, CANDIDATE, new Set(['A', 'B'])).some(({ id }) => id === 'old'));
});

test('a net the base does not have is left out', () => {
  assert.deepEqual(newCopper(BASE, CANDIDATE, new Set(['C'])), []);
});

const segment = (id: string, locked = '') =>
  `\t(segment\n\t\t(start 1 2)\n\t\t(end 3 4)\n\t\t(width 0.25)\n${locked}\t\t(layer "F.Cu")\n\t\t(net "A")\n\t\t(uuid "${id}")\n\t)\n`;
const board = (...items: string[]) => `(kicad_pcb\n\t(version 20260206)\n${items.join('')})\n`;

test('an item is added whole before the end of the board, and the rest of the base stays', () => {
  const text = withCopper(board(segment('old')), board(segment('old'), segment('t1')), [{ id: 't1', net: 'A' }]);
  assert.equal(text, board(segment('old'), segment('t1')));
});

test('copied copper is unlocked', () => {
  const text = withCopper(board(), board(segment('t1', '\t\t(locked yes)\n')), [{ id: 't1', net: 'A' }]);
  assert.equal(text, board(segment('t1')));
});

test('nothing to copy keeps the text', () => {
  assert.equal(withCopper(board(segment('old')), board(), []), board(segment('old')));
});
