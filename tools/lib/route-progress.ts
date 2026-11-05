// OUTDIR/progress.jsonl seen from outside the job: the status line of the last event, and a stage event for the shell
// stages (gate, render, fab). The job itself writes the router events (tools/router/core/src/job/progress.rs).
//
// One line per event: {"t": ISO time, "t0": job start, "elapsed_s": since t0, "stage": name, "pass": autorouter pass or null,
// "open": open connections of that pass or null, "vias": null until the board is imported, "best_open": lowest open count
// so far, "eta_s": seconds to 0 open or null}.
import { appendFileSync } from 'node:fs';
import { Float, get, item, jsonDumps, number, pyStr } from './py-compat.mjs';
import { round } from './py-numbers.ts';
import { readJsonl, type Row } from './run-record.ts';

const shown = (value: unknown): string => (value === null ? '-' : pyStr(value));
const seconds = (value: number): Float => new Float(round(value, 1));

function localTime(now: Date): string {
  const offsetMs = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 19);
}

/** The last complete event, null when there is none yet. */
export const lastEvent = (path: string): Row | null => readJsonl(path).at(-1) ?? null;

export function statusLine(row: Row | null): string {
  if (row === null) return 'no progress yet';
  const [open, best, vias, eta] = ['open', 'best_open', 'vias', 'eta_s'].map(key => shown(item(row, key)));
  return `${pyStr(item(row, 'stage'))} ${pyStr(item(row, 'elapsed_s'))}s open=${open} best=${best} vias=${vias} eta=${eta}`;
}

/** Append a stage event on the job's clock, keeping its best count and vias; a file with no event starts the clock now. */
export function markStage(path: string, stage: string, now = new Date()): Row {
  const last = lastEvent(path);
  const time = now.getTime() / 1000;
  const t0 = last === null ? time : number(item(last, 't0'));
  const row: Row = new Map<string, unknown>([
    ['t', localTime(now)], ['t0', seconds(t0)], ['elapsed_s', seconds(time - t0)], ['stage', stage], ['pass', null], ['open', null],
    ['vias', last === null ? null : get(last, 'vias')], ['best_open', last === null ? null : get(last, 'best_open')], ['eta_s', null],
  ]);
  appendFileSync(path, `${jsonDumps(row)}\n`);
  return row;
}
