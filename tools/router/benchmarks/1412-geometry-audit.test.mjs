import assert from 'node:assert/strict';
import test from 'node:test';
import { audit } from './1412-geometry-audit.mjs';
const board = (x, id = 'route', locked = false) => ({ schema: 'iot-lab.board.v1', board_sha256: String(x), board: { copper: [
  { Track: { id, net: 'A', layer: 'F.Cu', start: { x, y: 1 }, end: { x: 2, y: 3 }, width: 150000, locked } },
] } });
test('one native nanometre is a change; float route JSON is not a native export', () => {
  assert.deepEqual(audit(board(108699999), board(108700000)).changed_nets, ['A']);
  assert.throws(() => audit(board(108.69999999999999), board(108.7)), /integer units/);
});
test('unlocked UUID regeneration is separate from protected native object identity', () => {
  assert.deepEqual(audit(board(1), board(1, 'new-id')).changed_nets, []);
  assert.equal(audit(board(1, 'locked', true), board(1, 'locked', true)).protected_locked_unchanged, true);
  assert.equal(audit(board(1, 'locked', true), board(1, 'new-id', true)).protected_locked_unchanged, false);
  assert.equal(audit(board(1), board(1, 'route', true)).protected_locked_unchanged, false);
});
