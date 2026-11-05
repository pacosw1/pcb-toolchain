// JSON evidence values with the failures Python gave them: a report records the text of a missing key.
import { jsonCanonical, PyError, pyStr } from './py-compat.mjs';

export type Dict = Record<string, unknown>;

export const isDict = (value: unknown): value is Dict =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Map);

/** value[key]: a missing key is a KeyError, whose text is the quoted key. */
export function need<T = unknown>(row: unknown, key: string): T {
  if (!isDict(row)) throw new PyError('TypeError', `value is not a dict: ${key}`);
  if (!(key in row)) throw new PyError('KeyError', `'${key}'`);
  return row[key] as T;
}

/** a == b for JSON values: key order does not count. */
export const sameValue = (a: unknown, b: unknown): boolean => jsonCanonical(a ?? null) === jsonCanonical(b ?? null);

/** float(text). */
export function pyFloat(text: string): number {
  const value = text.trim().replaceAll('_', '');
  if (/^[+-]?(inf(inity)?)$/i.test(value)) return value.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(value)) return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) {
    throw new PyError('ValueError', `could not convert string to float: ${pyStr([text]).slice(1, -1)}`);
  }
  return Number(value);
}

/** A JSON int or float, as a Python check of type() in (int, float) passes it; true and false do not count. */
export const isNumber = (value: unknown): value is number => typeof value === 'number';
