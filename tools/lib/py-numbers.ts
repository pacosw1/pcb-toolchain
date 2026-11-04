// Number rules that decide a result and must round as Python's do.
import { fixed, PyError, pyRepr } from './py-compat.mjs';

const DECIMAL = /^[+-]?(?:\d+(?:_\d+)*\.?(?:\d+(?:_\d+)*)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/;
const SPECIAL = /^([+-]?)(?:(inf(?:inity)?)|nan)$/i;

/** float(text): Number() also takes '', '0x10' and '1e', and has no 'inf'. */
export function pyFloat(text: string): number {
  const value = text.trim();
  const special = SPECIAL.exec(value);
  if (special) return special[2] ? (special[1] === '-' ? -Infinity : Infinity) : NaN;
  if (!DECIMAL.test(value)) throw new PyError('ValueError', `could not convert string to float: ${pyRepr(text)}`);
  return Number(value.replaceAll('_', ''));
}

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
