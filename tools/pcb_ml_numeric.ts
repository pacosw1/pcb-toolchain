// Error-free partial sums, followed by one IEEE-754 round-to-nearest-even, as math.fsum in the numeric contract.
export function fsum(values: Iterable<number>): number {
  const partials: number[] = [];
  for (let x of values) {
    if (!Number.isFinite(x)) throw new Error('nonfinite numeric reduction');
    let count = 0;
    for (let y of partials) {
      if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
      const high = x + y, low = y - (high - x);
      if (low) partials[count++] = low;
      x = high;
    }
    partials.length = count;
    if (!Number.isFinite(x)) throw new Error('numeric sum exceeds finite range');
    if (x) partials.push(x);
  }
  let high = 0, low = 0, count = partials.length;
  if (count) {
    high = partials[--count];
    while (count) {
      const x = high, y = partials[--count];
      high = x + y; low = y - (high - x);
      if (low) break;
    }
    if (count && ((low < 0 && partials[count - 1] < 0) || (low > 0 && partials[count - 1] > 0))) {
      const doubled = low * 2, rounded = high + doubled;
      if (doubled === rounded - high) high = rounded;
    }
  }
  return high;
}

export function average(values: number[], weights?: number[]): number | null {
  if (!values.length) return null;
  const w = weights ?? values.map(() => 1);
  const scale = values.reduce((size, v) => Math.max(size, Math.abs(v)), 0) || 1;
  const result = fsum(values.map((v, i) => v / scale * w[i])) / fsum(w) * scale;
  if (!Number.isFinite(result)) throw new Error('derived average must be finite');
  return result;
}
