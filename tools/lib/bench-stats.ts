// Paired statistics of a two-arm benchmark. Pure and deterministic: the bootstrap uses a fixed seed.

export interface Outcome { ok: boolean; seconds: number | null; length_mm: number | null; vias: number | null }
export interface Pair { key: string; a: Outcome; b: Outcome }
export type Verdict = 'better' | 'worse' | 'inconclusive';

export interface Interval { low: number; high: number }
export interface Rate { successes: number; trials: number; rate: number | null; wilson95: Interval | null }

export interface PairedAnalysis {
  pairs: number;
  a: Rate;
  b: Rate;
  difference: number | null;
  difference_ci95: Interval | null;
  both_ok: number;
  only_a_ok: number;
  only_b_ok: number;
  sign_test_p: number | null;
  verdict: Verdict;
  seeds_needed: number | null;
  median_seconds_diff: { value: number; ci95: Interval; pairs: number } | null;
  median_length_mm_diff: { value: number; ci95: Interval; pairs: number } | null;
  median_vias_diff: { value: number; ci95: Interval; pairs: number } | null;
}

const Z = 1.959964;
const BOOTSTRAP_ROUNDS = 4000;
/** Fewer paired trials than this cannot support a verdict, however one-sided the sample is. */
export const MIN_PAIRS = 8;

export function wilson(successes: number, trials: number): Interval | null {
  if (trials <= 0) return null;
  const p = successes / trials, z2 = Z * Z, denom = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denom;
  const half = Z * Math.sqrt(p * (1 - p) / trials + z2 / (4 * trials * trials)) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export function rate(outcomes: Outcome[]): Rate {
  const successes = outcomes.filter(outcome => outcome.ok).length;
  return { successes, trials: outcomes.length, rate: outcomes.length ? successes / outcomes.length : null, wilson95: wilson(successes, outcomes.length) };
}

function logChoose(n: number, k: number): number {
  let sum = 0;
  for (let i = 1; i <= k; i += 1) sum += Math.log(n - k + i) - Math.log(i);
  return sum;
}

/** Exact two-sided sign test on the discordant pairs (McNemar's exact test). */
export function signTest(onlyA: number, onlyB: number): number | null {
  const n = onlyA + onlyB;
  if (n === 0) return null;
  const k = Math.min(onlyA, onlyB);
  let tail = 0;
  for (let i = 0; i <= k; i += 1) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function bootstrap(values: number[], statistic: (sample: number[]) => number): Interval {
  const random = mulberry32(0x5EED);
  const stats: number[] = [];
  for (let round = 0; round < BOOTSTRAP_ROUNDS; round += 1) {
    const sample: number[] = [];
    for (let i = 0; i < values.length; i += 1) sample.push(values[Math.floor(random() * values.length)]!);
    stats.push(statistic(sample));
  }
  stats.sort((x, y) => x - y);
  return { low: stats[Math.floor(0.025 * stats.length)]!, high: stats[Math.min(stats.length - 1, Math.ceil(0.975 * stats.length) - 1)]! };
}

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

function continuous(pairs: Pair[], pick: (outcome: Outcome) => number | null): PairedAnalysis['median_seconds_diff'] {
  const diffs: number[] = [];
  for (const { a, b } of pairs) {
    const x = pick(a), y = pick(b);
    if (a.ok && b.ok && x !== null && y !== null) diffs.push(y - x);
  }
  return diffs.length ? { value: median(diffs), ci95: bootstrap(diffs, sample => median(sample)), pairs: diffs.length } : null;
}

/** Pairs after the first arm (a, baseline) and the second (b, proposal). Positive difference: b succeeds more often. */
export function analyze(pairs: Pair[]): PairedAnalysis {
  const n = pairs.length;
  const onlyA = pairs.filter(pair => pair.a.ok && !pair.b.ok).length;
  const onlyB = pairs.filter(pair => !pair.a.ok && pair.b.ok).length;
  const both = pairs.filter(pair => pair.a.ok && pair.b.ok).length;
  const diffs = pairs.map(pair => Number(pair.b.ok) - Number(pair.a.ok));
  const difference = n ? mean(diffs) : null;
  const ci = n >= 2 ? bootstrap(diffs, mean) : null;
  const verdict: Verdict = n < MIN_PAIRS || !ci ? 'inconclusive' : ci.low > 0 ? 'better' : ci.high < 0 ? 'worse' : 'inconclusive';
  const discordant = (onlyA + onlyB) / (n || 1);
  const seeds = n === 0 ? null : n < MIN_PAIRS ? MIN_PAIRS
    : verdict === 'inconclusive' && difference ? Math.ceil(Z * Z * Math.max(discordant - difference * difference, 1 / n) / (difference * difference)) : null;
  return {
    pairs: n, a: rate(pairs.map(pair => pair.a)), b: rate(pairs.map(pair => pair.b)), difference, difference_ci95: ci,
    both_ok: both, only_a_ok: onlyA, only_b_ok: onlyB, sign_test_p: signTest(onlyA, onlyB), verdict,
    seeds_needed: seeds === null ? null : Math.max(seeds, n + 1),
    median_seconds_diff: continuous(pairs, outcome => outcome.seconds),
    median_length_mm_diff: continuous(pairs, outcome => outcome.length_mm),
    median_vias_diff: continuous(pairs, outcome => outcome.vias),
  };
}
