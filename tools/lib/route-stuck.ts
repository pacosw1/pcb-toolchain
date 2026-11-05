// What a failed route left, kept with its run: iotroute's stuck.json (tools/router/core/src/stuck.rs) as operation/stuck.json, against
// the last report of this board, so each round says what changed. The report is written in the job; this only keeps and compares it.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { iotrouteBin } from './iotroute-bin.ts';
import { readObject } from './json-file.ts';
import { isFile } from './py-path.ts';

export const STUCK_FILE = 'operation/stuck.json';
export interface StuckReport {
  schema: string; board: string; work: string; drc_errors: number; unconnected: number; parity: number; enclosed: number; router_miss: number; unknown: number;
  search: { stop?: string | null; pass?: number; max_passes?: number; passes_since_best?: number; search_limited?: number } | null;
  route_layers: string[]; reused: boolean; changed: { worse: boolean; better: boolean; names_comparable?: boolean;
    drc_before?: number; drc_now?: number; parity_before?: number; parity_now?: number } | null; open_nets: string[]; region: number[] | null;
  /** Additive v1 evidence fields; absent on older reports. Unknown causes are not a zero-open verdict. */
  coverage?: { native_connections: number; diagnosed_connections: number; undiagnosed_connections: number;
    unlocated_connections: number; unidentified_connections: number; unused_diagnoses: number; parity_reported: boolean };
  comparison_note?: string | null;
  rows: { net: string; class: string; connections: number; why: string }[];
  blockers: { parts: string[]; nets: string[]; keepouts: string[]; layers: string[]; boxed_in: string[] };
  summary: string[];
}
interface RunManifest { board?: string; created_at?: string }

/** The report of the newest other run of this board beside `folder`. */
export function previousStuck(folder: string, board: string): string | null {
  const runs = readdirSync(dirname(folder)).filter(name => name !== basename(folder)).map(name => join(dirname(folder), name));
  const rows = runs.filter(run => isFile(join(run, STUCK_FILE)) && isFile(join(run, 'run.json'))).map(run => ({ run, manifest: readObject<RunManifest>(join(run, 'run.json')) }));
  const newest = rows.filter(row => row.manifest.board === board).sort((a, b) => String(b.manifest.created_at).localeCompare(String(a.manifest.created_at)))[0];
  return newest ? join(newest.run, STUCK_FILE) : null;
}

function compare(work: string, board: string, previous: string): void {
  const done = spawnSync(iotrouteBin(), ['stuck', work, board, '--previous', previous], { encoding: 'utf8' });
  if (done.error) throw done.error;
  if (done.status) throw new Error(`iotroute stuck: ${done.stderr.trim()}`);
}

/** Keeps the report at `file`, when the route wrote one, and returns it. A run on another machine left its `work` there: it stays uncompared. */
export function keepStuck(folder: string, board: string, file: string, again = compare): StuckReport | null {
  if (!isFile(file)) return null;
  const { work } = readObject<StuckReport>(file), previous = previousStuck(folder, board), here = existsSync(join(work, 'drc.json'));
  if (previous && here) again(work, board, previous);
  copyFileSync(here ? join(work, 'stuck.json') : file, join(folder, STUCK_FILE));
  return readObject<StuckReport>(join(folder, STUCK_FILE));
}
