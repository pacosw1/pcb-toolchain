// Content hashes of JSON values. Each hashes the text Python's json.dumps gave, so a receipt written by one tool checks
// in another. A value read with jsonLoad keeps its int or float type; a plain number prints as an int when whole.
import { createHash } from 'node:crypto';
import { jsonCanonical } from './py-compat.mjs';

export const sha256Text = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** sort_keys, compact separators, ASCII. */
export const fingerprint = (value: unknown): string => sha256Text(jsonCanonical(value));

/** sort_keys, default separators, ASCII. */
export const identity = (value: unknown): string => sha256Text(jsonCanonical(value, { separators: [', ', ': '] }));

/** sort_keys, compact separators, non-ASCII kept as UTF-8. */
export const utf8Fingerprint = (value: unknown): string => sha256Text(jsonCanonical(value, { ascii: false }));
