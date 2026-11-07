import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, median, MIN_PAIRS, signTest, wilson, type Outcome, type Pair } from './bench-stats.ts';

const out = (ok: boolean, seconds: number | null = null): Outcome => ({ ok, seconds: ok ? seconds : null, length_mm: ok ? 100 : null, vias: ok ? 10 : null });
const pair = (a: boolean, b: boolean, i: number, sa = 10, sb = 8): Pair => ({ key: `k${i}`, a: out(a, sa), b: out(b, sb) });

test('wilson interval brackets the rate and stays inside 0..1', () => {
  const interval = wilson(9, 15)!;
  assert.ok(interval.low < 0.6 && interval.high > 0.6 && interval.low > 0.3 && interval.high < 0.85);
  assert.equal(wilson(0, 10)!.low, 0);
  assert.ok(Math.abs(wilson(10, 10)!.high - 1) < 1e-9);
  assert.equal(wilson(0, 0), null);
});

test('sign test is exact: 8 to 0 is significant, 5 to 3 is not, no discordance is null', () => {
  assert.ok(signTest(0, 8)! < 0.01);
  assert.ok(Math.abs(signTest(0, 8)! - 2 / 256) < 1e-12);
  assert.ok(signTest(5, 3)! > 0.5);
  assert.equal(signTest(0, 0), null);
});

test('the 9/15 against 12/15 case from the old placer study is inconclusive and asks for more seeds', () => {
  const pairs: Pair[] = [];
  for (let i = 0; i < 8; i += 1) pairs.push(pair(true, true, i));
  pairs.push(pair(true, false, 8));
  for (let i = 9; i < 13; i += 1) pairs.push(pair(false, true, i));
  for (let i = 13; i < 15; i += 1) pairs.push(pair(false, false, i));
  const result = analyze(pairs);
  assert.equal(result.a.successes, 9);
  assert.equal(result.b.successes, 12);
  assert.equal(result.verdict, 'inconclusive');
  assert.ok(result.seeds_needed! > 15);
});

test('a consistent win is better, a consistent loss is worse', () => {
  const wins = Array.from({ length: 12 }, (_, i) => pair(i < 2, true, i));
  assert.equal(analyze(wins).verdict, 'better');
  const losses = Array.from({ length: 12 }, (_, i) => pair(true, i < 2, i));
  assert.equal(analyze(losses).verdict, 'worse');
});

test('fewer than the minimum pairs cannot give a verdict, however one-sided', () => {
  for (const count of [2, MIN_PAIRS - 1]) {
    const result = analyze(Array.from({ length: count }, (_, i) => pair(false, true, i)));
    assert.equal(result.verdict, 'inconclusive');
    assert.equal(result.seeds_needed, MIN_PAIRS);
  }
  assert.equal(analyze(Array.from({ length: MIN_PAIRS }, (_, i) => pair(false, true, i))).verdict, 'better');
});

test('analysis is deterministic and timing counts only pairs verified on both sides', () => {
  const pairs = [pair(true, true, 0, 10, 8), pair(true, true, 1, 20, 14), pair(true, false, 2), pair(false, true, 3)];
  const first = analyze(pairs), second = analyze(pairs);
  assert.deepEqual(first, second);
  assert.equal(first.median_seconds_diff!.pairs, 2);
  assert.equal(first.median_seconds_diff!.value, -4);
});

test('empty and single pair inputs do not throw and give no verdict', () => {
  assert.equal(analyze([]).difference, null);
  assert.equal(analyze([pair(true, true, 0)]).verdict, 'inconclusive');
  assert.equal(median([3, 1, 2]), 2);
});
