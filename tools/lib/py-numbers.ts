// Number rules that decide a result and must round as Python's do.
import { fixed } from './py-compat.mjs';

/** round(x, places): half even on the exact binary value. Math.round and toFixed take an exact tie up. */
export const round = (x: number, places = 0): number => Number(fixed(x, places));
