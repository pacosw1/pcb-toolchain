import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drcLines, summarizeDrc } from './drc-summary.ts';

const REPORT = {
  violations: [
    { type: 'clearance', severity: 'error', items: [{ description: 'Pad 1' }, { description: 'Track [GND]' }] },
    { type: 'silk_overlap', severity: 'warning', items: [] },
    { type: 'lib_footprint_issues', severity: 'warning', items: [] },
    { type: 'silk_overlap', severity: 'warning', items: [] },
  ],
  unconnected_items: [{ items: [{ description: 'Pad [/A] x' }] }, { items: [{ description: 'Pad [/B] x' }] }, { items: [{ description: 'Pad [/B] y' }] }, { items: [{ description: 'no net' }] }],
  schematic_parity: [{}],
};

test('errors and warnings are counted by severity', () => {
  const summary = summarizeDrc(REPORT);
  assert.equal(summary.errors, 1);
  assert.equal(summary.warnings, 3);
  assert.deepEqual([...summary.warningTypes], [['silk_overlap', 2], ['lib_footprint_issues', 1]]);
});

test('the summary prints as pcbtool always did, worst net first', () => {
  assert.deepEqual(drcLines(summarizeDrc(REPORT)), [
    "DRC: 1 errors, 3 warnings {'silk_overlap': 2, 'lib_footprint_issues': 1}, 4 unconnected, 1 parity",
    '  E clearance: Pad 1 | Track [GND]',
    '  unrouted: /B 2, /A 1, ? 1',
  ]);
});

test('a clean report is one line, an empty dict included', () => {
  assert.deepEqual(drcLines(summarizeDrc({})), ['DRC: 0 errors, 0 warnings {}, 0 unconnected, 0 parity']);
});

test('error lines are cut at 200 characters and at the limit', () => {
  const many = { violations: Array.from({ length: 4 }, () => ({ type: 't', severity: 'error', items: [{ description: 'x'.repeat(300) }] })) };
  const lines = drcLines(summarizeDrc(many), 2);
  assert.equal(lines.length, 3);
  assert.equal(lines[1]!.length, 204);
});
