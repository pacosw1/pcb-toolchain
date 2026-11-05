// Measured workflow boundaries. Overlapping stages are never added as wall time.
import { randomBytes } from 'node:crypto';
import { Float } from './py-compat.mjs';
import { round } from './py-numbers.ts';

export const CATEGORIES = ['startup', 'snapshot', 'preflight', 'kicad', 'export', 'validation', 'operation', 'cleanup', 'sealing', 'queue'];

const STARTS: Readonly<Record<string, 'tool' | 'stage'>> = { 'tool.start': 'tool', 'stage.start': 'stage' };
const ENDS: Readonly<Record<string, 'tool' | 'stage'>> = { 'tool.exit': 'tool', 'stage.end': 'stage' };
const ACTIVITY = new Set(['tool.output', 'stage.activity']);

/** A JSON event as producers write it: every field may be missing or of the wrong type. */
export type TimingEvent = Record<string, unknown>;
export interface ActiveSpan {
  span_id: string; stage: string; category: string;
  started_unix_s: unknown; last_activity_unix_s?: unknown;
}
export interface ClosedSpan {
  span_id: string; stage: string; category: string; started_unix_s: unknown;
  ended_unix_s: unknown; duration_s: number | null; duration_source: string; status: unknown;
}
export type LiveStage<T> = T & { elapsed_s: number | null; last_activity_age_s: number | null };
export interface CategoryTime { wall_s: number | null; completed_spans: number }
export interface TimingSummary {
  schema_version: 1;
  supervisor_startup_s: number | null;
  supervisor_startup_clock: 'wall' | 'unavailable';
  queue_wait_s: null;
  queue_reason: string;
  busy_wall_s: number | null;
  categories: Record<string, CategoryTime>;
  spans: ClosedSpan[];
  active_stages: LiveStage<ActiveSpan>[];
  incomplete_stages: ActiveSpan[];
  coverage: 'partial' | 'recorded_boundaries' | 'unavailable';
  issues: string[];
  wall_accounting: string;
}

const ISO_WITH_ZONE = /^(.*:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const wallClock = (): number => Date.now() / 1000;
const monotonic = (): number => performance.now() / 1000;
export const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Epoch seconds of a number, or of an ISO time that names its zone. */
export function timestamp(value: unknown): number | null {
  if (isNumber(value)) return value;
  if (typeof value !== 'string') return null;
  const [, seconds, fraction = '', zone] = value.match(ISO_WITH_ZONE) ?? [];
  const parsed = Date.parse(`${seconds}${zone}`);
  return Number.isNaN(parsed) ? null : parsed / 1000 + Number(`0${fraction}`);
}

export function stageCategory(stage: string): string {
  if (stage === 'erc' || stage === 'drc') return 'kicad';
  if (stage.startsWith('snapshot')) return 'snapshot';
  if (['export', 'candidate-fab', 'fab-zip'].includes(stage)) return 'export';
  if (['preflight', 'gerber-runtime'].includes(stage) || stage.startsWith('probe:')) return 'preflight';
  if (stage.startsWith('validate') || stage.startsWith('board-semantic')) return 'validation';
  return 'operation';
}

export interface SpanFields { span_id: string; stage: string; category: string; producer: string; started_unix_s: number }

/** Start and end are sampled in the producing process; the duration uses its clock. */
export class MeasuredSpan {
  readonly fields: SpanFields;
  readonly #started = monotonic();

  constructor(stage: string, category: string | null = null, producer = 'supervisor') {
    this.fields = {
      span_id: randomBytes(16).toString('hex'), stage, category: category || stageCategory(stage), producer,
      started_unix_s: wallClock(),
    };
  }

  end(status = 'passed', data: Record<string, unknown> = {}) {
    const duration_s = monotonic() - this.#started;
    return { ...this.fields, ended_unix_s: wallClock(), duration_s, duration_source: 'producer_monotonic', status, ...data };
  }
}

/** Union of wall-clock boundaries; null means no usable interval. */
export function unionSeconds(intervals: [unknown, unknown][]): number | null {
  const usable = intervals
    .filter((pair): pair is [number, number] => isNumber(pair[0]) && isNumber(pair[1]) && pair[1] >= pair[0])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const first = usable[0];
  if (!first) return null;
  let total = 0;
  let [left, right] = first;
  for (const [start, end] of usable.slice(1)) {
    if (start > right) {
      total += right - left;
      [left, right] = [start, end];
    } else {
      right = Math.max(right, end);
    }
  }
  return round(total + right - left, 6);
}

const ageSince = (now: number, moment: unknown): number | null =>
  isNumber(moment) && now >= moment ? round(now - moment, 3) : null;

export function liveStages<T extends { started_unix_s?: unknown; last_activity_unix_s?: unknown }>(stages: Iterable<T>, now = wallClock()): LiveStage<T>[] {
  return [...stages].map(stage => ({
    ...stage,
    elapsed_s: ageSince(now, stage.started_unix_s),
    last_activity_age_s: ageSince(now, stage.last_activity_unix_s),
  }));
}

export class Timeline {
  readonly submitted: number | null;
  supervisorStarted: number | null = null;
  readonly active = new Map<string, ActiveSpan>();
  readonly closed = new Map<string, ClosedSpan>();
  readonly issues: string[] = [];

  constructor(submittedAt?: unknown) {
    this.submitted = timestamp(submittedAt);
  }

  observe(row: TimingEvent): void {
    const kind = String(row.type);
    const at = timestamp(row.source_time) ?? timestamp(row.time);
    if (kind === 'run.start' && this.supervisorStarted === null) this.supervisorStarted = at;
    const family = STARTS[kind] ?? ENDS[kind];
    if (family) {
      if (typeof row.stage !== 'string') return;
      const identity = row.span_id ? String(row.span_id) : `${String(row.producer ?? 'legacy')}:${family}:${row.stage}`;
      if (kind in STARTS) this.#start(identity, row.stage, row, at);
      else this.#end(identity, row.stage, row, at);
    } else if (ACTIVITY.has(kind) && at !== null) {
      this.#activity(row, at);
    }
  }

  #start(identity: string, stage: string, row: TimingEvent, at: number | null): void {
    if (this.active.has(identity) || this.closed.has(identity)) {
      this.issues.push(`duplicate start: ${identity}`);
      return;
    }
    const start = 'started_unix_s' in row ? row.started_unix_s : at;
    this.active.set(identity, {
      span_id: identity, stage, category: categoryOf(row, stage), started_unix_s: start,
      last_activity_unix_s: at ?? start,
    });
  }

  #end(identity: string, stage: string, row: TimingEvent, at: number | null): void {
    if (this.closed.has(identity)) return;   // Replayed producer events cannot inflate durations.
    const span = this.active.get(identity);
    this.active.delete(identity);
    if (!span) this.issues.push(`end without observed start: ${identity}`);
    const start = span ? span.started_unix_s : row.started_unix_s ?? null;
    const end = 'ended_unix_s' in row ? row.ended_unix_s : at;
    if (isNumber(start) && isNumber(end) && end < start) this.issues.push(`wall clock moved backwards: ${identity}`);
    this.closed.set(identity, {
      span_id: identity, stage, category: span?.category ?? categoryOf(row, stage), started_unix_s: start, ended_unix_s: end,
      ...measuredDuration(row, start, end),
      status: 'status' in row ? row.status : row.code === 0 ? 'passed' : 'failed',
    });
  }

  #activity(row: TimingEvent, at: number): void {
    for (const [identity, span] of this.active) {
      if (row.span_id === identity || (!row.span_id && row.stage === span.stage)) span.last_activity_unix_s = at;
    }
  }

  summary(now?: number, terminal = false): TimingSummary {
    const spans = [...this.closed.values()];
    const interval = (span: ClosedSpan): [unknown, unknown] => [span.started_unix_s, span.ended_unix_s];
    const names = new Set([...CATEGORIES, ...spans.map(span => span.category)]);
    const categories = Object.fromEntries([...names].map(name => {
      const members = spans.filter(span => span.category === name);
      return [name, { wall_s: unionSeconds(members.map(interval)), completed_spans: members.length }];
    }));
    const { supervisorStarted: started, submitted } = this;
    const startup = started !== null && submitted !== null && isNumber(started) && started >= submitted ? started - submitted : null;
    return {
      schema_version: 1,
      supervisor_startup_s: startup === null ? null : round(startup, 6),
      supervisor_startup_clock: startup === null ? 'unavailable' : 'wall',
      queue_wait_s: null,
      queue_reason: 'no queue admission boundary recorded',
      busy_wall_s: unionSeconds(spans.map(interval)),
      categories,
      spans,
      active_stages: terminal ? [] : liveStages(this.active.values(), now),
      incomplete_stages: terminal ? [...this.active.values()] : [],
      coverage: this.active.size || this.issues.length ? 'partial' : spans.length ? 'recorded_boundaries' : 'unavailable',
      issues: [...this.issues],
      wall_accounting: 'union of boundaries; nested/concurrent stages are not added',
    };
  }
}

const categoryOf = (row: TimingEvent, stage: string): string =>
  'category' in row ? String(row.category) : stageCategory(stage);

function measuredDuration(row: TimingEvent, start: unknown, end: unknown): { duration_s: number | null; duration_source: string } {
  const reported = row.duration_s;
  if (isNumber(reported) && reported >= 0) {
    return { duration_s: round(reported, 6), duration_source: String(row.duration_source ?? 'producer_monotonic') };
  }
  if (isNumber(start) && isNumber(end) && end >= start) return { duration_s: round(end - start, 6), duration_source: 'event_wall_clock' };
  return { duration_s: null, duration_source: 'unavailable' };
}

export function fromEvents(rows: TimingEvent[], submittedAt?: unknown, terminal = false): TimingSummary {
  const timeline = new Timeline(submittedAt);
  rows.forEach(row => timeline.observe(row));
  return timeline.summary(undefined, terminal);
}

const FLOAT_FIELDS = new Set([
  'supervisor_startup_s', 'queue_wait_s', 'busy_wall_s', 'wall_s', 'started_unix_s', 'ended_unix_s', 'last_activity_unix_s',
  'duration_s', 'elapsed_s', 'last_activity_age_s',
]);

/** A summary for jsonDumps: Python's seconds are floats, so a whole 2.0 must not print as 2. Counts stay ints. */
export function timingJson(value: unknown, field = ''): unknown {
  if (typeof value === 'number') return FLOAT_FIELDS.has(field) ? new Float(value) : value;
  if (Array.isArray(value)) return value.map(entry => timingJson(entry));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, timingJson(entry, key)]));
}
