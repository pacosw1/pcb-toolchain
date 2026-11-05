// D-124c (b) pin-escape allowance: tools/pin-ratings.json holds, per part, the pin or switch current with its source.
import { readFileSync } from 'node:fs';
import type { Footprint } from './board-types.ts';
import { fnmatchCase } from './fnmatch.ts';
import { formatG } from './py-numbers.ts';

const RATINGS_FILE = new URL('../pin-ratings.json', import.meta.url);
const MPN_FIELDS = new Set(['MPN', 'MFR PART', 'PART NUMBER']);
const STATISTICS = new Set(['min', 'max', 'typ', 'rated']);

export interface PinRating { amps: number; name: string; source: string; statistic: string }
export interface RatedPart { mpn: string[]; pins: Record<string, PinRating> }
export type PinRatings = Record<string, RatedPart>;
/** The current of a pin with where it comes from; amps is null with the reason. */
export interface PinCurrent { amps: number | null; source: string }

const namedText = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

function checkPart(key: string, part: RatedPart): void {
  if (!Array.isArray(part.mpn) || part.mpn.length === 0 || !part.mpn.every(x => typeof x === 'string' && x)) throw new Error(`${key}: pin rating needs MPN identity`);
  for (const [pin, value] of Object.entries(part.pins)) {
    if (typeof value.amps !== 'number' || !Number.isFinite(value.amps) || value.amps <= 0) throw new Error(`${key}.${pin}: pin rating needs positive finite amps`);
    if (!namedText(value.name) || !namedText(value.source) || !STATISTICS.has(value.statistic)) throw new Error(`${key}.${pin}: pin rating needs sourced statistic and pin identity`);
  }
}

export function loadPinRatings(file: URL | string = RATINGS_FILE): PinRatings {
  const { parts } = JSON.parse(readFileSync(file, 'utf8')) as { parts: PinRatings };
  for (const [key, part] of Object.entries(parts)) checkPart(key, part);
  return parts;
}

/** The rating of a part pin from pin-ratings.json, or the reason there is none. */
export function pinRating(ratings: PinRatings, mpn: string, pin: string): PinCurrent {
  const matches = Object.entries(ratings).filter(([, part]) => part.mpn.some(pattern => fnmatchCase(mpn, pattern)));
  if (matches.length > 1) return { amps: null, source: `${mpn}: ambiguous part identity in tools/pin-ratings.json` };
  const [match] = matches;
  if (!match) return { amps: null, source: `${mpn}: no entry in tools/pin-ratings.json` };
  const [key, part] = match;
  const rating = part.pins[pin];
  if (!rating) return { amps: null, source: `${key} pin ${pin}: no rating in tools/pin-ratings.json` };
  return { amps: rating.amps, source: `${key} pin ${pin} ${rating.name} ${formatG(rating.amps)} A (${rating.source})` };
}

/** The first rating among the footprint's value and part-number fields. */
export function footprintPinRating(ratings: PinRatings, footprint: Footprint, pin: string): PinCurrent {
  const numbers = [footprint.value, ...footprint.fields.filter(([name]) => MPN_FIELDS.has(name.toUpperCase())).map(([, text]) => text)];
  return numbers.map(mpn => pinRating(ratings, mpn, pin)).find(rating => rating.amps !== null) ?? { amps: null, source: 'no matched part pin rating' };
}
