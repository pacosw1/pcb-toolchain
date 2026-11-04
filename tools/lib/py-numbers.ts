// Number rules that decide a result and must round as Python's do.
import { fixed } from './py-compat.mjs';

/** round(x, places): half even on the exact binary value. Math.round and toFixed take an exact tie up. */
export const round = (x: number, places = 0): number => Number(fixed(x, places));

/** f'{x:g}': six significant digits, no trailing zeros, an exponent below 1e-4 and from 1e6. */
export function formatG(x: number): string {
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  const [mantissa, exponentText] = x.toExponential(5).split('e') as [string, string];
  const exponent = Number(exponentText);
  const trim = (digits: string) => (digits.includes('.') ? digits.replace(/\.?0+$/, '') : digits);
  if (exponent >= -4 && exponent < 6) return trim(fixed(x, 5 - exponent));
  const size = String(Math.abs(exponent)).padStart(2, '0');
  return `${trim(mantissa)}e${exponent < 0 ? '-' : '+'}${size}`;
}
