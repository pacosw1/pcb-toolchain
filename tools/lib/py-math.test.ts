import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dist, fsum, hypot, pyMod } from './py-math.ts';

const SCALE = 1100n;

/** A positive double times 2^SCALE, as an exact integer. */
function exact(value: number): bigint {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value);
  const raw = bits.getBigUint64(0);
  const mantissa = (raw & ((1n << 52n) - 1n)) | (1n << 52n);
  return mantissa << (SCALE + (raw >> 52n) - 1075n);
}

const nextUp = (value: number): number => {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value);
  bits.setBigUint64(0, bits.getBigUint64(0) + 1n);
  return bits.getFloat64(0);
};

/** The true root lies within half an ulp of `result`: (2r - u)^2 <= 4(x^2 + y^2) <= (2r + u)^2 in exact integers. */
function isCorrectlyRounded(x: number, y: number, result: number): boolean {
  const twice = 2n * exact(result), ulp = exact(nextUp(result)) - exact(result);
  const square = 4n * (exact(x) ** 2n + exact(y) ** 2n);
  return (twice - ulp) ** 2n <= square && square <= (twice + ulp) ** 2n;
}

test('hypot is exact on Pythagorean triples and with a zero', () => {
  assert.equal(hypot(3, 4), 5);
  assert.equal(hypot(-5, 12), 13);
  assert.equal(hypot(0, -2.5), 2.5);
  assert.equal(hypot(0, 0), 0);
});

test('the rounding check itself rejects a result one ulp off', () => {
  assert.ok(isCorrectlyRounded(1, 1, 1.4142135623730951));
  assert.ok(!isCorrectlyRounded(1, 1, nextUp(1.4142135623730951)));
});

test('hypot rounds once: the result is the double nearest the true root', () => {
  let state = 12345;
  const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pairs: [number, number][] = [[1.27, 3.81], [0.65, 0.3], [12.7, 0.0254], [1e-3, 7e-3], [0.1, 0.2]];
  for (let i = 0; i < 2000; i++) pairs.push([random() * 200 + 1e-3, random() * 200 + 1e-3]);
  for (const [x, y] of pairs) assert.ok(isCorrectlyRounded(x, y, hypot(x, y)), `hypot(${x}, ${y})`);
});

test('dist is hypot of the differences', () => {
  assert.equal(dist([1, 1], [4, 5]), 5);
});

test('fsum does not lose small terms', () => {
  assert.equal(fsum([1e100, 1, -1e100]), 1);
  assert.equal(fsum(Array(10).fill(0.1)), 1);
  assert.equal(fsum([]), 0);
  assert.equal(fsum([1, 1e-16, 1e-16]), 1.0000000000000002);
});

test('% takes the sign of the divisor', () => {
  assert.equal(pyMod(-90, 360), 270);
  assert.equal(pyMod(450, 360), 90);
  assert.equal(pyMod(-360, 360), 0);
  assert.ok(Object.is(pyMod(-360, 360), 0));
});
