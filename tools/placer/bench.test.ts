// The bench table and the seed portfolio pick. iotplace is a fake here: its cost and scramble have their tests in Rust.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Float, jsonDumps, PyError } from '../lib/py-compat.mjs';
import { collect, pick, portfolioPick, scatter, spearman, table, type PortfolioRun } from './bench.ts';
import type { Pose, Problem } from './compact.ts';

const near = (a: number, b: number, places = 6) => assert.ok(Math.abs(a - b) < 10 ** -places, `${a} is not ${b}`);
const run = (name: string, unrouted: number | null, errors: number | null, cost: number): PortfolioRun => ({ name, unrouted, errors, cost });

function folder(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), 'bench-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

const entry = (d: string, name: string, cost: number, log: string | null): string => {
  writeFileSync(join(d, `${name}.json`), JSON.stringify({ candidates: [{ cost, pose: [] }] }));
  if (log !== null) writeFileSync(join(d, `${name}.log`), log);
  return `${name}:${join(d, `${name}.json`)}:${join(d, `${name}.log`)}`;
};

test('rank correlation', () => {
  near(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  near(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  near(spearman([1, 2, 3], [1, 3, 2]), 0.5);
  near(spearman([1, 1, 2], [1, 2, 3]), 0.8660254);   // ties get the average rank
  near(spearman([1, 2, 3], [3, 2, 1]), -1);
  near(spearman([1, 1, 3], [2, 2, 4]), 1);
});

test('no variance is an error, not an invented correlation', () => {
  assert.throws(() => spearman([1, 1], [1, 2]), (error: PyError) => error.type === 'ZeroDivisionError');
  assert.throws(() => table([['x', 5, []]]), (error: PyError) => error.type === 'ZeroDivisionError');
});

test('the median per row and the rank correlation of proxy vs median', () => {
  const [text, rho] = table([['a', 10, [5, 1, 3]], ['b', 20, [9, 7, 8]], ['c', 30, [20, 30, 10]]]);
  near(rho, 1);
  assert.ok(text.includes('| a | 10.0 | 1 / 3 / 5 |'));
  assert.ok(text.endsWith('Spearman (proxy cost vs median unrouted, n = 3): 1.00'));
});

test('an even row has the float median Python prints', () => {
  const [text] = table([['a', 1, [1, 2]], ['b', 2, [3, 3]], ['c', 3, [4, 8]]]);
  assert.ok(text.includes('| a | 1.0 | 1 / 1.5 / 2 |'));
  assert.ok(text.includes('| b | 2.0 | 3 / 3.0 / 3 |'));
});

test('a row without router results is left out of the correlation', () => {
  const [text, rho] = table([['a', 10, [1]], ['b', 20, [2]], ['x', 5, []], ['c', 30, [3]]]);
  near(rho, 1);
  assert.ok(text.includes('| x | 5.0 | no result |'));
});

test('the fewest unrouted wins', () => {
  assert.equal(portfolioPick([run('s23', 9, 0, 1), run('s37', 5, 0, 9), run('s51', 30, 0, 0.5)])?.name, 's37');
});

test('a tie goes to the lower cost', () => {
  assert.equal(portfolioPick([run('a', 5, 0, 1005.6), run('b', 5, 0, 1001)])?.name, 'b');
});

test('a pose with DRC errors loses to any pose without', () => {
  // VX4 2026-09-28: s51 (5 unrouted, 1 error) won over s37 (30, 0) and s23 (48, 0).
  assert.equal(portfolioPick([run('s23', 48, 0, 1), run('s51', 5, 1, 1)])?.name, 's23');
});

test('when all poses have errors the fewest errors win', () => {
  assert.equal(portfolioPick([run('s79', 56, 6, 1), run('s89', 10, 10, 1), run('s97', 45, 3, 1)])?.name, 's97');
});

test('a pose without a route result never wins', () => {
  assert.equal(portfolioPick([run('a', null, null, 0.1), run('b', 80, 3, 5)])?.name, 'b');
  assert.equal(portfolioPick([run('a', null, null, 0.1)]), null);
});

test('pick reads the search cost and the last UNROUTED line', t => {
  const d = folder(t);
  const entries = [entry(d, 's1', 3, 'FR_RC 0\nUNROUTED 7 SUBSET 7 ERRORS 0\n'),
    entry(d, 's2', 2, 'UNROUTED 9 SUBSET 9 ERRORS 0\nUNROUTED 7 SUBSET 7 ERRORS 1\n'), entry(d, 's3', 1, 'remote: job x exit 124\n')];
  assert.equal(pick(entries), 's1');   // s2 has the same unrouted and a lower cost, but ERRORS 1
});

test('a capped unrouted count is unknown high in the pick', t => {
  const d = folder(t);
  const entries = [entry(d, 's1', 1, 'UNROUTED 499 SUBSET 0 ERRORS 0 CAPPED\n'), entry(d, 's2', 2, 'UNROUTED 499 SUBSET 0 ERRORS 0\n')];   // a capped 499 is more than 499
  assert.equal(pick(entries), 's2');
});

test('a pick with no log has no winner, and a bad entry stops it', t => {
  const d = folder(t);
  assert.equal(pick([entry(d, 's1', 1, null)]), null);
  assert.throws(() => pick(['s1:only-two']), (error: PyError) => error.type === 'ValueError');
});

test('collect takes the pose of each tag and the last count of its logs', t => {
  const d = folder(t);
  mkdirSync(join(d, 's-search'));
  writeFileSync(join(d, 's-search/res.json'), '{"candidates": [{"pose": [[1.0, 2, 0]], "cost": 9}]}');
  writeFileSync(join(d, 'base-r1.log'), 'UNROUTED 9\nUNROUTED 1\n');
  writeFileSync(join(d, 'base-r2.log'), 'UNROUTED 3 SUBSET 3 ERRORS 0\n');
  writeFileSync(join(d, 's-r1.log'), 'UNROUTED 6\n');
  writeFileSync(join(d, 's-r2.log'), 'no count\n');
  writeFileSync(join(d, 'sx-r1.log'), 'UNROUTED 100\n');
  writeFileSync(join(d, 'p-r1.txt'), 'UNROUTED 100\n');
  const poses: string[] = [];
  const cost = (prob: string, pose: Pose | null) => {
    poses.push(`${prob} ${jsonDumps(pose)}`);
    return pose === null ? 1 : 2;
  };
  const text = collect('prob.json', d, ['base', 's'], cost);
  assert.deepEqual(poses, ['prob.json null', 'prob.json [[1.0, 2, 0]]']);
  assert.ok(text.includes('| base | 1.0 | 1 / 2.0 / 3 |'));
  assert.ok(text.includes('| s | 2.0 | 6 / 6 / 6 |'));
});

test('scatter moves the start of movable units on a copy and keeps the fixed ones', () => {
  const unit = (name: string, x: number, fixed = false) => ({ name, fixed, x, y: x, rects: [] });
  const pr: Problem = { units: [unit('A', 500), unit('H', 1, true)], nets: [], board: { outline: [] } };
  const scramble = (p: Problem, seed: number) => {
    assert.equal(seed, 7);
    return { ...p, units: [{ ...p.units[0], x: new Float(3), y: new Float(4.5) }, { ...p.units[1], x: new Float(1), y: new Float(1) }] };
  };
  const q = scatter(pr, 7, scramble);
  assert.equal(pr.units[0].x, 500);
  assert.equal(jsonDumps(q.units.map(u => [u.x, u.y])), '[[3.0, 4.5], [1, 1]]');
});
