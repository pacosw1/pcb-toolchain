// The record of the last `pcb place` call: the comparison table of its seeds and the hash of each spec file. A place edit
// names its spec by hash, so the run keeps the table row and the whole table. The next `pcb place` call replaces this file;
// the run record does not change.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readObject } from './json-file.ts';
import { sha } from './pcb-workflow.ts';
import { jsonDumps } from './py-compat.mjs';
import { isFile } from './py-path.ts';

const SCHEMA = 'iot-lab.place-candidates.v1';
export const ORIGINS = ['hand', 'move'] as const;
export interface PlaceRow {
  seed: number; spec: string; spec_sha256: string; legal: boolean; moved: number;
  margins: { smallest_mm: number | null; rules: { id: string; margin_mm: number | null }[] };
  wirelength: number | null; estimates: unknown; misses: { id: string; miss_mm: number | null }[];
}
interface PlaceRecord { schema: string; board: string; rows: PlaceRow[] }

export const placeRecordPath = (root: string, board: string): string => join(root, '.gate/place', `${board}-candidates.json`);

export function writePlaceRecord(root: string, board: string, rows: PlaceRow[]): void {
  const path = placeRecordPath(root, board);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${jsonDumps({ schema: SCHEMA, board, rows })}\n`);
}

/** Why a place edit uses this spec. A row of the table wins over the origin word. Anything else stops. */
export function placeChoice(root: string, board: string, specPath: string, origin?: string): Record<string, unknown> {
  if (origin !== undefined && !(ORIGINS as readonly string[]).includes(origin)) throw new Error(`--origin must be ${ORIGINS.join(' or ')}`);
  const record = placeRecordPath(root, board);
  if (isFile(record)) {
    const table = readObject<PlaceRecord>(record), hash = sha(specPath);
    const row = table.rows.find(candidate => candidate.spec_sha256 === hash);
    if (row) return { source: 'table', seed: row.seed, record, record_sha256: sha(record), table: table.rows };
  }
  if (origin) return { source: origin };
  throw new Error(`the place spec is not a row of ${record}; run \`tools/pcb place ${board} --seeds N\` and pass one of its specs, or pass --origin ${ORIGINS.join(' or --origin ')}`);
}
