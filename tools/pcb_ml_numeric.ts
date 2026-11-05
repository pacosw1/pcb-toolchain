// Finite numeric boundaries and ML averages over the shared, Python-compatible arithmetic implementation.
import { fsum as partialSum } from './lib/py-math.ts';

export function fsum(values: Iterable<number>): number {
  function* checked(): Generator<number> {
    for (const value of values) {
      if (!Number.isFinite(value)) throw new Error('nonfinite numeric reduction');
      yield value;
    }
  }
  const result = partialSum(checked());
  if (!Number.isFinite(result)) throw new Error('numeric sum exceeds finite range');
  return result === 0 ? 0 : result;
}

export function average(values: number[], weights?: number[]): number | null {
  if (!values.length) return null;
  const w = weights ?? values.map(() => 1);
  const scale = values.reduce((size, v) => Math.max(size, Math.abs(v)), 0) || 1;
  const result = fsum(values.map((v, i) => v / scale * w[i])) / fsum(w) * scale;
  if (!Number.isFinite(result)) throw new Error('derived average must be finite');
  return result;
}
