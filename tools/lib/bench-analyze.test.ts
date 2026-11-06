import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildResult, compare, sealed, type BenchResult, type Evaluation } from './bench-analyze.ts';
import { TRIAL_RECORD, type TrialRecord } from './bench-run.ts';
import { expandTrials, SUITE, validateSuite } from './bench-suite.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const suite = validateSuite({
  schema: SUITE, suite_id: 's', arms: [{ id: 'base', argv: ['x'] }, { id: 'new', argv: ['x'] }],
  boards: [{ family: 'A', board: 'ENV', split: 'development', input: { path: 'e', sha256: sha('e') } }, { family: 'B', board: 'REL', split: 'holdout', input: { path: 'r', sha256: sha('r') } }],
  seeds: [1, 2, 3, 4, 5, 6], budget: { timeout_s: 5, cpus: 1, memory_gb: 1 },
});
const records = (skip: (id: string) => boolean = () => false): TrialRecord[] => expandTrials(suite).map(t => ({
  schema: TRIAL_RECORD, id: t.id, arm: t.arm, status: skip(t.id) ? 'timeout' : 'sealed', run_id: 'r', run_path: 'p', result_sha256: sha(t.id), wall_s: 1, exit_code: 0, cause: null, command: [],
}));
const evaluation = (win: (id: string, arm: string) => boolean): Evaluation => ({
  status: 'passed', comparative_readiness: true, blockers: [],
  observations: expandTrials(suite).map(t => ({ id: t.id, full_gate_success: win(t.id, t.arm), evidence_valid: true, status: 'passed', elapsed_s: 10, routed_quality: { routed_track_length_mm: 100, routed_via_count: 5 }, failure_class: null })),
});
const build = (win: (id: string, arm: string) => boolean, skip?: (id: string) => boolean) => buildResult(suite, sha('suite'), records(skip), evaluation(win), sha('eval'), {});

test('a result is sealed, splits by case and detects an edit', () => {
  const result = build((_, arm) => arm === 'new');
  assert.equal(result.overall.verdict, 'better');
  assert.deepEqual(Object.keys(result.by_split).sort(), ['development', 'holdout']);
  assert.deepEqual(Object.keys(result.by_case).sort(), ['ENV', 'REL']);
  assert.ok(sealed(result));
  assert.ok(!sealed({ ...result, suite_id: 'other' }));
});

test('trials with no sealed run count as failures, not omissions', () => {
  const result = build((_, arm) => arm === 'new', id => id.endsWith('.new') && id.startsWith('ENV'));
  assert.equal(result.no_run_trials, 6);
  assert.equal(result.overall.pairs, 12);
  assert.equal(result.overall.b.successes, 6);
  assert.equal(result.evidence_complete, false);
});

test('compare pairs the same cases across two results and refuses a different suite or budget', () => {
  const base = build(() => false);
  const better = build((_, arm) => arm === 'new');
  const comparison = compare(base, better, 'base', 'new');
  assert.equal(comparison.analysis.pairs, 12);
  assert.equal(comparison.analysis.verdict, 'better');
  const otherSuite: BenchResult = { ...better, suite_sha256: sha('different') };
  assert.throws(() => compare(base, { ...otherSuite, result_sha256: rehash(otherSuite) }), /suite definitions differ/);
  const otherBudget: BenchResult = { ...better, budget: { ...better.budget, cpus: 8 } };
  assert.throws(() => compare(base, { ...otherBudget, result_sha256: rehash(otherBudget) }), /budgets differ/);
  assert.throws(() => compare(base, { ...better, suite_id: 'x' }), /fails its own hash/);
  assert.throws(() => compare(base, better, 'nope'), /no arm nope/);
});

function rehash(result: BenchResult): string {
  const { result_sha256: _drop, ...body } = result;
  return sha(canonical(body));
}
import { canonicalJson as canonical } from './bench-analyze.ts';
