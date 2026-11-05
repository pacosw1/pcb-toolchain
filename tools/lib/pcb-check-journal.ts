// One admitted check supervisor owns this journal. Its owner broker retains the
// worker flock until finalization, so terminal evidence cannot precede cleanup.
import { appendFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { now } from './lean-clock.ts';
import { atomicJson, plainJson, readObject } from './json-file.ts';
import { jsonDumps } from './py-compat.mjs';
import { events, utc } from './pcb-runs.ts';
import { Timeline, timingJson, type TimingEvent } from './timing.ts';

export type Row = Record<string, unknown>;

export class CheckJournal {
  readonly folder: string;
  readonly state: Row;
  readonly timeline: Timeline;
  readonly started: number;
  seq: number;
  constructor(folder: string, submitted: unknown, start?: number) {
    this.folder = folder;
    this.state = readObject(join(folder, 'state.json'));
    this.started = start ?? Number(this.state.worker_started_clock_s);
    if (!Number.isFinite(this.started)) throw new Error('worker clock is missing');
    this.seq = Number(this.state.seq ?? 0);
    this.timeline = new Timeline(submitted);
    let cursor = 0;
    for (;;) {
      const rows = events(folder, cursor, 1000);
      for (const entry of rows) {
        cursor = Number(entry.get('cursor'));
        const row = plainJson(entry) as Row;
        delete row.cursor;
        this.timeline.observe(row as TimingEvent);
      }
      if (rows.length < 1000) break;
    }
  }
  emit(type: string, data: Row = {}): void {
    for (const key of ['schema_version', 'run_id', 'seq', 'time', 'elapsed_s', 'type']) {
      if (Object.hasOwn(data, key)) throw new Error(`producer event repeats supervisor field: ${key}`);
    }
    const elapsed = Math.round((now() - this.started) * 1000) / 1000;
    const row: Row = { schema_version: 1, run_id: basename(this.folder), seq: ++this.seq, time: utc(), elapsed_s: elapsed, type, ...data };
    this.timeline.observe(row as TimingEvent);
    appendFileSync(join(this.folder, 'events.jsonl'), jsonDumps(row) + '\n');
    if (type === 'check.end') this.state.last_progress_s = elapsed;
    if (['tool.start', 'tool.exit', 'tool.output', 'stage.start', 'stage.end', 'stage.activity', 'check.end'].includes(type)) this.state.last_activity_s = elapsed;
    const terminal = ['passed', 'failed', 'error', 'cancelled', 'timeout'].includes(String(this.state.status));
    const timing = this.timeline.summary(undefined, terminal);
    Object.assign(this.state, { seq: this.seq, elapsed_s: elapsed, updated_unix: Date.now() / 1000,
      active_stages: terminal ? [] : [...new Set([...this.timeline.active.values()].map(span => span.stage))].sort(),
      active_stage_timing: timing.active_stages, timing: timingJson(timing) });
    atomicJson(join(this.folder, 'state.json'), this.state);
  }
}
