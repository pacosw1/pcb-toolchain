// Duplicate item UUIDs in a native KiCad board: check and deterministic repair (W9, 2026-10-10).
//
// A board whose zones (or other items) share one UUID stops the routing step: immutable_board in iotroute job/fastroute/thermal.rs
// rejects "duplicate native immutable item identity" in the import replay guard (seen on IO-6X6, DOOR-RELAY, RELAY-4
// and PWR-24V-5V, each with a zone UUID used two or three times; the generator scripts copy a zone with its UUID).
// The first occurrence keeps its UUID; each repeat gets uuid5(NAMESPACE, "<uuid>#<ordinal>"), so a repair is the same
// on every host and run. Only the uuid tokens change: no copper, no geometry, no other text.
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const NAMESPACE = '7b6f2c8e-5d1a-4d0e-9f3b-2a6c4e8d1b05';   // fixed for this repository
const COLLISION_STEP = 1000;
const TOKEN = /"[^"\\]*(?:\\[\s\S][^"\\]*)*"?|\(([^\s()]*)|\)/g;

interface UuidToken { start: number; end: number; uuid: string; kind: string }
export interface Duplicate extends UuidToken { ordinal: number }
export interface Replacement { kind: string; uuid: string; ordinal: number; new: string }
export interface RepairReport {
  board: string;
  replaced: number;
  duplicates: number;
  rows: Replacement[];
  written: boolean;
}

/** RFC 4122 version 5 in the fixed namespace. */
export function replacement(old: string, ordinal: number): string {
  const digest = createHash('sha1')
    .update(Buffer.from(NAMESPACE.replaceAll('-', ''), 'hex'))
    .update(`${old}#${ordinal}`)
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  return digest.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

/** Every (uuid "...") token with the kind of the enclosing item, quote-aware. */
function uuidTokens(text: string): UuidToken[] {
  const tokens: UuidToken[] = [];
  const stack: string[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const word = match[1];
    if (match[0] === ')') stack.pop();
    if (word === undefined) continue;
    if (word === 'uuid') {
      const quote = text.indexOf('"', match.index + match[0].length);
      const end = text.indexOf('"', quote + 1);
      tokens.push({ start: quote + 1, end, uuid: text.slice(quote + 1, end), kind: stack.at(-1) ?? '' });
    }
    stack.push(word);
  }
  return tokens;
}

function repeats(tokens: UuidToken[]): Duplicate[] {
  const seen = new Map<string, number>();
  const rows: Duplicate[] = [];
  for (const token of tokens) {
    const ordinal = seen.get(token.uuid) ?? 0;
    seen.set(token.uuid, ordinal + 1);
    if (ordinal > 0) rows.push({ ...token, ordinal });
  }
  return rows;
}

/** Every repeated uuid token after its first occurrence. */
export const duplicates = (text: string): Duplicate[] => repeats(uuidTokens(text));

/** Repeats get their deterministic replacement; one that would collide with an existing uuid takes a later ordinal. */
export function repair(text: string): { text: string; rows: Replacement[] } {
  const tokens = uuidTokens(text);
  const used = new Set(tokens.map(token => token.uuid));
  const rows: Replacement[] = [];
  let repaired = text;
  // From the end of the file, so the offsets of the rows still to come stay valid.
  for (const { kind, uuid, ordinal, start, end } of repeats(tokens).reverse()) {
    let attempt = ordinal;
    while (used.has(replacement(uuid, attempt))) attempt += COLLISION_STEP;
    const fresh = replacement(uuid, attempt);
    used.add(fresh);
    rows.unshift({ kind, uuid, ordinal, new: fresh });
    repaired = repaired.slice(0, start) + fresh + repaired.slice(end);
  }
  return { text: repaired, rows };
}

/** With write, the repaired board replaces the file (atomic rename). */
export function repairFile(path: string, write = true): RepairReport {
  const { text, rows } = repair(readFileSync(path, 'utf8'));
  const written = rows.length > 0 && write;
  if (written) {
    const temporary = `${path}.uuidfix`;
    writeFileSync(temporary, text);
    renameSync(temporary, path);
  }
  return { board: resolve(path), replaced: write ? rows.length : 0, duplicates: rows.length, rows, written };
}
