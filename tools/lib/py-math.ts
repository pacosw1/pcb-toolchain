// Float functions whose result lands in a report. Python's hypot and fsum round correctly; Math.hypot and a plain sum
// can differ in the last bit, and % takes the sign of the divisor in Python but of the dividend in JavaScript.

/** x % y on floats, for y > 0. */
export function pyMod(x: number, y: number): number {
  const rest = x % y;
  return rest < 0 ? rest + y : rest === 0 ? 0 : rest;
}

const view = new DataView(new ArrayBuffer(8));

/** A finite double as integer mantissa x 2^exponent. */
function decompose(value: number): [bigint, number] {
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const raw = Number(bits >> 52n), fraction = bits & ((1n << 52n) - 1n);
  return raw === 0 ? [fraction, -1074] : [fraction | (1n << 52n), raw - 1075];
}

function integerSqrt(value: bigint): bigint {
  if (value < 2n) return value;
  let estimate = 1n << BigInt((value.toString(2).length + 1) >> 1);
  for (;;) {
    const next = (estimate + value / estimate) >> 1n;
    if (next >= estimate) return estimate;
    estimate = next;
  }
}

/** Round root x 2^exponent to the nearest double, ties to even; `inexact` says bits below root were lost. */
function toDouble(root: bigint, exponent: number, inexact: boolean): number {
  const extra = root.toString(2).length - 53;
  if (extra <= 0) return Number(root) * 2 ** exponent;
  const shift = BigInt(extra), rest = root & ((1n << shift) - 1n), half = 1n << (shift - 1n);
  let kept = root >> shift;
  if (rest > half || (rest === half && (inexact || (kept & 1n) === 1n))) kept += 1n;
  return Number(kept) * 2 ** (exponent + extra);
}

/** math.hypot of two finite floats: exact integer arithmetic, then one rounding. */
export function hypot(x: number, y: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return Math.hypot(x, y);
  if (x === 0 || y === 0) return Math.abs(x) + Math.abs(y);
  const [a, ea] = decompose(x), [b, eb] = decompose(y);
  const base = Math.min(ea, eb) - (Math.min(ea, eb) & 1);
  const p = a << BigInt(ea - base), q = b << BigInt(eb - base);
  // Doubling the bits of the square keeps at least 64 significant bits in its root.
  const scale = 64n;
  const square = (p * p + q * q) << (2n * scale);
  const root = integerSqrt(square);
  return toDouble(root, base - Number(scale), root * root !== square);
}

/** math.dist of two 2D points. */
export const dist = (a: readonly number[], b: readonly number[]): number => hypot((a[0] as number) - (b[0] as number), (a[1] as number) - (b[1] as number));

/** math.fsum: Shewchuk's exact partial sums, rounded once. */
export function fsum(values: Iterable<number>): number {
  const partials: number[] = [];
  for (let x of values) {
    let kept = 0;
    for (let y of partials) {
      if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
      const high = x + y, low = y - (high - x);
      if (low) partials[kept++] = low;
      x = high;
    }
    partials.length = kept;
    partials.push(x);
  }
  let total = partials.pop() ?? 0;
  let low = 0;
  while (partials.length) {
    const x = total, y = partials.pop() as number;
    total = x + y;
    low = y - (total - x);
    if (low) break;
  }
  // A tie in the final rounding is settled by the sign of the next partial.
  const next = partials.at(-1);
  if (next !== undefined && ((low < 0 && next < 0) || (low > 0 && next > 0))) {
    const doubled = low * 2, moved = total + doubled;
    if (doubled === moved - total) total = moved;
  }
  return total;
}
