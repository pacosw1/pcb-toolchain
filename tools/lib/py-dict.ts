// What Python does with values from jsonLoads (dict = Map, int = BigInt, float = Float), where JavaScript differs.
import { compare, Float, PyError, typeName } from './py-compat.mjs';

export type Dict = Map<string, unknown>;

export const isDict = (value: unknown): value is Dict => value instanceof Map;

const isRecord = (value: unknown): value is object =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Float);
const entriesOf = (value: object): [string, unknown][] =>
  value instanceof Map ? [...value] as [string, unknown][] : Object.entries(value);

function numeric(value: unknown): number | bigint | null {
  if (value instanceof Float) return value.value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return typeof value === 'number' || typeof value === 'bigint' ? value : null;
}

/** a == b: 1 equals 1.0 and True, and a dict equals a dict in any key order. A plain object counts as a dict. */
export function pyEquals(a: unknown, b: unknown): boolean {
  const x = numeric(a);
  const y = numeric(b);
  // eslint-disable-next-line eqeqeq
  if (x !== null || y !== null) return x !== null && y !== null && x == y;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, i) => pyEquals(item, b[i]));
  if (!isRecord(a) || !isRecord(b)) return a === b;
  const left = entriesOf(a);
  const right = new Map(entriesOf(b));
  return left.length === right.size && left.every(([key, item]) => right.has(key) && pyEquals(item, right.get(key)));
}

/** copy.deepcopy of a JSON value. */
export function deepCopy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(deepCopy) as T;
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [key, deepCopy(item)])) as T;
  return value;
}

/** The value with every dict in key order, for jsonDumps: json.dump(sort_keys=True). */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  return new Map(entriesOf(value).sort(([a], [b]) => compare(a, b)).map(([key, item]) => [key, sortKeys(item)]));
}

/** `for x in value`: a list, the keys of a dict, or the characters of a string. */
export function iterate(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return [...value.keys()];
  if (typeof value === 'string') return [...value];
  throw new PyError('TypeError', `'${typeName(value)}' object is not iterable`);
}

/** re.fullmatch of an anchored `pattern`: anything but a string is a TypeError, not a failed match. */
export function fullMatch(pattern: RegExp, value: unknown): boolean {
  if (typeof value !== 'string') throw new PyError('TypeError', `expected string or bytes-like object, got '${typeName(value)}'`);
  return pattern.test(value);
}
