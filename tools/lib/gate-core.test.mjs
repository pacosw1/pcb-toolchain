import test from 'node:test';
import assert from 'node:assert/strict';
import {passes, ratchet, metricsText, countFrom} from './gate-core.mjs';

test('passes: zero targets, info metrics do not count, null fails', () => {
  assert.equal(passes({drc_errors: 0, drc_warnings: 164, erc_warnings: 665}).ok, true);
  assert.deepEqual(passes({drc_unconnected: 172, drc_errors: 0}).open, ['drc_unconnected: 172']);
  assert.equal(passes({viapads: null}).ok, false);
});

test('ratchet: hard increase blocks, soft increase warns, info is ignored', () => {
  const r = ratchet({drc_unconnected: 172, paths_low: 2, drc_warnings: 164}, {drc_unconnected: 173, paths_low: 3, drc_warnings: 200});
  assert.deepEqual(r.blocked, ['drc_unconnected: 172 -> 173']);
  assert.deepEqual(r.warnings, ['paths_low: 2 -> 3']);
});

test('ratchet: improvement is listed, equal is silent, a new metric is accepted', () => {
  const r = ratchet({drc_unconnected: 172}, {drc_unconnected: 160, drc_errors: 0, viapads: 0});
  assert.deepEqual(r.improved, ['drc_unconnected: 172 -> 160']);
  assert.deepEqual(r.blocked, []);
});

test('ratchet: a waiver with reason and date allows a rise up to its limit', () => {
  const w = [{metric: 'drc_unconnected', to: 175, reason: 'net X ripped for the 5V feed', date: '2026-10-03'}];
  assert.equal(ratchet({drc_unconnected: 172}, {drc_unconnected: 175}, w).blocked.length, 0);
  assert.equal(ratchet({drc_unconnected: 172}, {drc_unconnected: 176}, w).blocked.length, 1);
  assert.equal(ratchet({drc_unconnected: 172}, {drc_unconnected: 175}, [{metric: 'drc_unconnected', to: 175}]).blocked.length, 1);
});

test('ratchet: a tool that did not run blocks; no baseline accepts all', () => {
  assert.deepEqual(ratchet({viapads: 0}, {viapads: null}).blocked, ['viapads: tool did not run']);
  assert.deepEqual(ratchet(null, {drc_errors: 5}).blocked, []);
});

test('metricsText is stable and has no time or path', () => {
  const a = metricsText({board: 'X', pcbSha256: 'p', schSha256: 's', metrics: {drc_errors: 0, erc_errors: 0}});
  const b = metricsText({board: 'X', pcbSha256: 'p', schSha256: 's', metrics: {erc_errors: 0, drc_errors: 0}});
  assert.equal(a, b);
  assert.ok(!a.includes('/Users'));
});

test('countFrom', () => {
  assert.equal(countFrom('x\n0 vias in SMD pads\n', /(\d+) vias in SMD pads/), 0);
  assert.equal(countFrom('Traceback', /(\d+) vias in SMD pads/), null);
});
