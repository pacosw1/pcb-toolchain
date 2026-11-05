// Which passing compaction step is best, and when the halo shrink stops paying. See README "Rank by routed length".
import { number } from '../lib/py-compat.mjs';
import type { Num } from './compact-geometry.ts';

export const RANKS = ['halo', 'length'] as const;
export type Rank = (typeof RANKS)[number];
export const LENGTH_PATIENCE = 2;

/** Copper measured on the routed board of a step. */
export interface Measure { length_mm?: Num | null; vias?: Num | null; routed?: string | null; source?: string }
export interface RankedStep { s: number; k: number; passed: boolean; measure?: Measure | null; box_sum?: Num | null }

/** Python's a < b on tuples. */
const before = (a: number[], b: number[]): boolean => {
  const at = a.findIndex((value, index) => value !== b[index]);
  return at >= 0 && a[at] < b[at];
};

/** min(items, key=key): the first of equals. */
export function minBy<T>(items: T[], key: (item: T) => number[]): T {
  return items.reduce((best, item) => (before(key(item), key(best)) ? item : best));
}

const lastIfNone = (value: Num | null | undefined): number => (value === null || value === undefined ? Infinity : number(value));

/** Sort key of a passing step (lower is better). Both ranks put a real-outline step (k <= 1) first.
 *  halo: the smallest board scale, then the smallest halo scale (maximum compaction, the old rule).
 *  length: the shortest routed length, then fewer vias, then the smaller block box sum, then the smaller halo.
 *  A step without a measure ranks after every measured step. */
export function rankKey(t: RankedStep, rank: Rank = 'length'): number[] {
  const virtualStep = Number(t.k > 1 + 1e-9);
  if (rank === 'halo') return [virtualStep, t.k, t.s];
  return [virtualStep, lastIfNone(t.measure?.length_mm), Math.trunc(lastIfNone(t.measure?.vias)), lastIfNone(t.box_sum), t.s];
}

const measured = (t: RankedStep): boolean => t.passed && (t.measure?.length_mm ?? null) !== null;

/** [best passing step or null, reason]. Rank length falls back to halo when no passing step has a measure. */
export function choose<T extends RankedStep>(steps: T[], rank: Rank = 'length'): [T | null, string] {
  const ok = steps.filter(t => t.passed);
  if (!ok.length) return [null, 'no passing step'];
  const smallestHalo = minBy(ok, t => rankKey(t, 'halo'));
  if (rank !== 'length') return [smallestHalo, `smallest halo scale on the smallest board scale of ${ok.length} passing steps (rank halo)`];
  const lengths = ok.filter(measured);
  if (!lengths.length) return [smallestHalo, 'no passing step has a routed-length measure: smallest halo (rank halo fallback)'];
  const reason = `shortest routed length of ${lengths.length} measured passing steps (rank length; ties: fewer vias, then smaller block box sum)`;
  return [minBy(lengths, t => rankKey(t, 'length')), reason];
}

/** True when the last `patience` measured passing steps all rank after the best measured step so far (the halo shrink
 *  makes the route longer, not shorter). Failed steps do not count and do not reset the count. Patience 0 or null: never. */
export function lengthStop(steps: RankedStep[], patience: number | null = LENGTH_PATIENCE): boolean {
  if (!patience) return false;
  const lengths = steps.filter(measured);
  if (lengths.length <= patience) return false;
  const best = lengths.indexOf(minBy(lengths, t => rankKey(t, 'length')));
  return lengths.length - 1 - best >= patience;
}
