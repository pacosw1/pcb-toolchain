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
  assert.equal(result.no_run_trials + result.timeout_trials, 6);
  assert.equal(result.overall.pairs, 12);
  assert.equal(result.overall.b.successes, 6);
  assert.equal(result.evidence_complete, true);   // a deadline is a known failure, not missing evidence
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

test('the native metric counts a clean native result even when the configured gate fails, and reports the gate as secondary', () => {
  const nativeSuite = validateSuite({ ...suite, metric: 'native' });
  const evaluationNative: Evaluation = {
    status: 'passed', comparative_readiness: true, blockers: [],
    observations: expandTrials(nativeSuite).map(t => ({ id: t.id, full_gate_success: false, evidence_valid: true, status: 'failed',
      native: { errors: 0, opens: t.arm === 'new' ? 0 : 2, parity: 0 }, failure_class: t.arm === 'new' ? 'configured_or_electrical_check' : 'routing_opens' })),
  };
  const result = buildResult(nativeSuite, sha('suite'), records(), evaluationNative, null, {});
  assert.equal(result.metric, 'native');
  assert.equal(result.overall.b.successes, 12);
  assert.equal(result.overall.a.successes, 0);
  assert.equal(result.secondary.metric, 'gate');
  assert.equal(result.secondary.overall.b.successes, 0);
  assert.throws(() => validateSuite({ ...suite, metric: 'other' }), /metric/);
});

test('a run stopped at its own deadline is a timeout failure, not an unknown outcome', () => {
  const recs = records().map(r => r.id.startsWith('REL') && r.arm === 'new' ? { ...r, run_status: 'timeout' } : r);
  const ev = evaluation((_, arm) => arm === 'base');
  ev.observations = ev.observations!.map(o => String(o.id).startsWith('REL') && String(o.id).endsWith('.new') ? { ...o, evidence_valid: false, full_gate_success: false } : o);
  const result = buildResult(suite, sha('suite'), recs, ev, null, {});
  assert.equal(result.timeout_trials, 6);
  assert.equal(result.unknown_outcomes, 0);
  assert.equal(result.trials.find(t => t.id === 'REL.r1.new')!.failure_class, 'timeout');
});

test('a router suite tolerates the unequal-execution blocker; a placement suite does not', () => {
  const ev = { ...evaluation((_, arm) => arm === 'new'), status: 'blocked', comparative_readiness: false, blockers: [{ code: 'unequal_case_or_execution' }] };
  assert.equal(buildResult(suite, sha('s'), records(), ev, null, {}).evidence_complete, false);
  const router = buildResult(validateSuite({ ...suite, treatment: 'router' }), sha('s'), records(), ev, null, {});
  assert.equal(router.evidence_complete, true);
  assert.equal(router.evaluation.tolerated_blockers, 1);
  const other = { ...ev, blockers: [{ code: 'unequal_case_or_execution' }, { code: 'trial_evidence_invalid' }] };
  assert.equal(buildResult(validateSuite({ ...suite, treatment: 'router' }), sha('s'), records(), other, null, {}).evidence_complete, false);
  assert.throws(() => validateSuite({ ...suite, treatment: 'x' }), /treatment/);
});
