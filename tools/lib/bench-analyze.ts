// Turn trial records and the placement_outcomes evaluation into a sealed paired result, and compare two sealed results.
import { createHash } from 'node:crypto';
import { analyze, type Outcome, type Pair, type PairedAnalysis } from './bench-stats.ts';
import { expandTrials, type PlannedTrial, type Suite } from './bench-suite.ts';
import type { TrialRecord } from './bench-run.ts';

export const RESULT = 'iot-lab.bench-result.v1';
export const COMPARISON = 'iot-lab.bench-comparison.v1';

type Row = Record<string, unknown>;
export interface TrialOutcome extends Outcome {
  id: string; arm: string; case: string; replicate: number; split: string; status: string; failure_class: string | null; evidence_valid: boolean;
}
export interface Evaluation { status?: string; comparative_readiness?: boolean; blockers?: unknown[]; observations?: Row[]; error?: string }

export interface BenchResult {
  schema: typeof RESULT;
  suite_id: string; suite_sha256: string; budget: Suite['budget']; seeds: number[]; arms: string[];
  evaluation: { status: string; comparative_readiness: boolean; blockers: number; error: string | null; report_sha256: string | null };
  evidence_complete: boolean; unknown_outcomes: number; no_run_trials: number;
  trials: TrialOutcome[];
  overall: PairedAnalysis; by_split: Record<string, PairedAnalysis>; by_case: Record<string, PairedAnalysis>;
  inputs: Record<string, string>;
  result_sha256: string;
}

const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const asRow = (value: unknown): Row => (value && typeof value === 'object' ? value : {}) as Row;

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Canonical JSON: object keys sorted, so a result hashes the same wherever it was written. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Row).sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** One outcome per planned trial. A trial with no sealed run, or whose evidence is invalid, is a failure and is counted as unknown or no_run. */
export function outcomes(trials: PlannedTrial[], records: Map<string, TrialRecord>, evaluation: Evaluation): TrialOutcome[] {
  const rows = new Map((evaluation.observations ?? []).map(row => [String(row.id), row]));
  return trials.map(trial => {
    const base = { id: trial.id, arm: trial.arm, case: trial.case, replicate: trial.replicate, split: trial.split };
    const item = records.get(trial.id);
    const row = rows.get(trial.id);
    if (!item || item.status !== 'sealed') {
      return { ...base, ok: false, seconds: null, length_mm: null, vias: null, status: item?.status ?? 'missing', failure_class: item?.status === 'timeout' ? 'timeout' : 'no_run', evidence_valid: false };
    }
    if (!row) return { ...base, ok: false, seconds: null, length_mm: null, vias: null, status: 'unevaluated', failure_class: 'evidence_invalid', evidence_valid: false };
    const ok = row.full_gate_success === true;
    const quality = asRow(row.routed_quality);
    return {
      ...base, ok, seconds: ok ? num(row.elapsed_s) : null, length_mm: ok ? num(quality.routed_track_length_mm) : null, vias: ok ? num(quality.routed_via_count) : null,
      status: String(row.status ?? 'unknown'), failure_class: typeof row.failure_class === 'string' ? row.failure_class : null, evidence_valid: row.evidence_valid === true,
    };
  });
}

function pairsOf(list: TrialOutcome[], first: string, second: string): Pair[] {
  const groups = new Map<string, { a?: TrialOutcome; b?: TrialOutcome }>();
  for (const item of list) {
    const key = `${item.case}#${item.replicate}`;
    const group = groups.get(key) ?? {};
    if (item.arm === first) group.a = item; else if (item.arm === second) group.b = item;
    groups.set(key, group);
  }
  return [...groups].filter(([, group]) => group.a && group.b).map(([key, group]) => ({ key, a: group.a!, b: group.b! }));
}

const group = (list: TrialOutcome[], key: (item: TrialOutcome) => string): Map<string, TrialOutcome[]> => {
  const map = new Map<string, TrialOutcome[]>();
  for (const item of list) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
};

export function buildResult(suite: Suite, suiteSha256: string, records: TrialRecord[], evaluation: Evaluation, reportSha256: string | null, inputs: Record<string, string>): BenchResult {
  const planned = expandTrials(suite);
  const list = outcomes(planned, new Map(records.map(item => [item.id, item])), evaluation);
  const [first, second] = suite.arms.map(arm => arm.id) as [string, string];
  const bySplit: Record<string, PairedAnalysis> = {}, byCase: Record<string, PairedAnalysis> = {};
  for (const [name, items] of group(list, item => item.split)) bySplit[name] = analyze(pairsOf(items, first, second));
  for (const [name, items] of group(list, item => item.case)) byCase[name] = analyze(pairsOf(items, first, second));
  const unknown = list.filter(item => !item.evidence_valid).length;
  const body = {
    schema: RESULT, suite_id: suite.suite_id, suite_sha256: suiteSha256, budget: suite.budget, seeds: suite.seeds, arms: [first, second],
    evaluation: {
      status: evaluation.status ?? 'error', comparative_readiness: evaluation.comparative_readiness === true,
      blockers: (evaluation.blockers ?? []).length, error: evaluation.error ?? null, report_sha256: reportSha256,
    },
    evidence_complete: unknown === 0 && evaluation.comparative_readiness === true, unknown_outcomes: unknown,
    no_run_trials: list.filter(item => item.failure_class === 'no_run' || item.failure_class === 'timeout').length,
    trials: list, overall: analyze(pairsOf(list, first, second)), by_split: bySplit, by_case: byCase, inputs,
  };
  return { ...body, result_sha256: sha256Text(canonicalJson(body)) } as BenchResult;
}

/** A result is intact when its recorded hash matches its content. */
export function sealed(result: BenchResult): boolean {
  const { result_sha256: digest, ...body } = result;
  return digest === sha256Text(canonicalJson(body));
}

export interface Comparison {
  schema: typeof COMPARISON; suite_id: string; a: { result_sha256: string; arm: string }; b: { result_sha256: string; arm: string };
  analysis: PairedAnalysis; evidence_complete: boolean; caveats: string[];
}

/** Compare one arm of result A with one arm of result B over the same planned cases and seeds. Different suites or budgets are refused. */
export function compare(a: BenchResult, b: BenchResult, armA?: string, armB?: string): Comparison {
  for (const [name, result] of [['A', a], ['B', b]] as const) if (!sealed(result)) throw new Error(`result ${name} fails its own hash; it was edited or is damaged`);
  if (a.suite_id !== b.suite_id) throw new Error(`different suites: ${a.suite_id} and ${b.suite_id}`);
  if (a.suite_sha256 !== b.suite_sha256) {
    throw new Error('the suite definitions differ (boards, input hashes, seeds, budget or arm commands changed); rerun both under one suite file');
  }
  if (canonicalJson(a.budget) !== canonicalJson(b.budget)) throw new Error('budgets differ');
  const chosenA = armA ?? a.arms[1]!, chosenB = armB ?? b.arms[1]!;
  if (!a.arms.includes(chosenA)) throw new Error(`result A has no arm ${chosenA}`);
  if (!b.arms.includes(chosenB)) throw new Error(`result B has no arm ${chosenB}`);
  const left = a.trials.filter(item => item.arm === chosenA).map(item => ({ ...item, arm: 'a' }));
  const right = b.trials.filter(item => item.arm === chosenB).map(item => ({ ...item, arm: 'b' }));
  const analysis = analyze(pairsOf([...left, ...right], 'a', 'b'));
  const caveats: string[] = [];
  if (!a.evidence_complete || !b.evidence_complete) caveats.push('at least one result has incomplete evidence (unknown outcomes or blockers); treat the verdict as provisional');
  if (chosenA === chosenB && a.result_sha256 === b.result_sha256) caveats.push('both sides are the same arm of the same result');
  if (analysis.pairs < a.trials.length / 2) caveats.push('fewer paired trials than planned');
  return { schema: COMPARISON, suite_id: a.suite_id, a: { result_sha256: a.result_sha256, arm: chosenA }, b: { result_sha256: b.result_sha256, arm: chosenB },
    analysis, evidence_complete: a.evidence_complete && b.evidence_complete, caveats };
}

const pct = (value: number | null): string => value === null ? 'n/a' : `${(value * 100).toFixed(0)}%`;

export function formatAnalysis(name: string, analysis: PairedAnalysis, labels: [string, string]): string {
  const ci = analysis.difference_ci95;
  const lines = [
    `${name}: ${analysis.pairs} pairs`,
    `  ${labels[0]}: ${analysis.a.successes}/${analysis.a.trials} verified (${pct(analysis.a.rate)}, 95% ${pct(analysis.a.wilson95?.low ?? null)}-${pct(analysis.a.wilson95?.high ?? null)})`,
    `  ${labels[1]}: ${analysis.b.successes}/${analysis.b.trials} verified (${pct(analysis.b.rate)}, 95% ${pct(analysis.b.wilson95?.low ?? null)}-${pct(analysis.b.wilson95?.high ?? null)})`,
    `  difference ${analysis.difference === null ? 'n/a' : `${(analysis.difference * 100).toFixed(0)} points`}${ci ? ` (95% ${(ci.low * 100).toFixed(0)} to ${(ci.high * 100).toFixed(0)})` : ''}; only ${labels[0]} ${analysis.only_a_ok}, only ${labels[1]} ${analysis.only_b_ok}, both ${analysis.both_ok}; sign test p=${analysis.sign_test_p === null ? 'n/a' : analysis.sign_test_p.toFixed(3)}`,
    `  verdict: ${analysis.verdict}${analysis.seeds_needed ? `; about ${analysis.seeds_needed} pairs would settle it at this effect size` : analysis.verdict === 'inconclusive' ? '; no measurable difference yet' : ''}`,
  ];
  if (analysis.median_seconds_diff) lines.push(`  median seconds to verified, ${labels[1]} minus ${labels[0]}: ${analysis.median_seconds_diff.value.toFixed(1)} (${analysis.median_seconds_diff.pairs} pairs)`);
  return lines.join('\n');
}
