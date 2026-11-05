import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fromEvents, liveStages, stageCategory, timestamp, Timeline, unionSeconds, type TimingEvent } from './timing.ts';

const start = (id: string, stage: string, at: number, category = 'operation'): TimingEvent =>
  ({ type: 'stage.start', span_id: id, stage, category, started_unix_s: at, time: at });
const end = (id: string, stage: string, left: number, right: number, category = 'operation'): TimingEvent =>
  ({ type: 'stage.end', span_id: id, stage, category, started_unix_s: left, ended_unix_s: right, time: right,
     duration_s: right - left, duration_source: 'producer_monotonic', status: 'passed' });

test('sequential, concurrent and nested stages use union wall time', () => {
  const rows = [start('outer', 'validate', 10, 'validation'), start('erc', 'erc', 11, 'kicad'), start('drc', 'drc', 12, 'kicad'),
    end('erc', 'erc', 11, 14, 'kicad'), end('drc', 'drc', 12, 16, 'kicad'), end('outer', 'validate', 10, 17, 'validation'),
    start('export', 'export', 20, 'export'), end('export', 'export', 20, 22, 'export')];
  const result = fromEvents(rows, undefined, true);
  assert.equal(result.busy_wall_s, 9);
  assert.equal(result.categories.kicad?.wall_s, 5);
  assert.equal(result.categories.validation?.wall_s, 7);
  assert.equal(result.spans.reduce((sum, span) => sum + (span.duration_s ?? 0), 0), 16);
  assert.equal(result.categories.snapshot?.wall_s, null);
  assert.equal(result.queue_wait_s, null);
});

test('a replay cannot double count and repeated names have distinct spans', () => {
  const rows = [start('one', 'export', 10), end('one', 'export', 10, 12), end('one', 'export', 10, 12),
    start('two', 'export', 20), end('two', 'export', 20, 21)];
  const result = fromEvents(rows, undefined, true);
  assert.equal(result.spans.length, 2);
  assert.equal(result.busy_wall_s, 3);
  assert.deepEqual(result.issues, []);
});

test('live elapsed time, activity and terminal incomplete stages are truthful', () => {
  const timeline = new Timeline(8);
  timeline.observe({ type: 'run.start', time: 9 });
  timeline.observe(start('drc', 'drc', 10, 'kicad'));
  timeline.observe({ type: 'tool.output', stage: 'drc', span_id: 'drc', source_time: 12, time: 15 });
  const row = timeline.summary(20).active_stages[0]!;
  assert.deepEqual([row.elapsed_s, row.last_activity_age_s], [10, 8]);
  const terminal = timeline.summary(20, true);
  assert.equal(terminal.coverage, 'partial');
  assert.deepEqual(terminal.spans, []);
  assert.equal(terminal.busy_wall_s, null);
  assert.equal(terminal.supervisor_startup_s, 1);
  assert.ok(!('duration_s' in terminal.incomplete_stages[0]!));
  assert.equal(liveStages([{ started_unix_s: undefined }], 20)[0]!.elapsed_s, null);
});

test('a monotonic duration survives a backwards wall clock without a made-up union', () => {
  const row = { ...end('one', 'drc', 20, 19, 'kicad'), duration_s: 2 };
  const result = fromEvents([start('one', 'drc', 20, 'kicad'), row], undefined, true);
  assert.equal(result.spans[0]?.duration_s, 2);
  assert.equal(result.busy_wall_s, null);
  assert.equal(result.coverage, 'partial');
  assert.match(result.issues[0]!, /backwards/);
  assert.equal(unionSeconds([]), null);
  assert.equal(fromEvents([]).coverage, 'unavailable');
});

test('an end without a start and a duration from event times', () => {
  const result = fromEvents([{ type: 'tool.exit', stage: 'erc', started_unix_s: 3, ended_unix_s: 5, code: 1 }], undefined, true);
  const span = result.spans[0]!;
  assert.deepEqual(result.issues, ['end without observed start: legacy:tool:erc']);
  assert.deepEqual([span.category, span.duration_s, span.duration_source, span.status], ['kicad', 2, 'event_wall_clock', 'failed']);
});

test('timestamps need a zone and keep microseconds', () => {
  assert.equal(timestamp(12.5), 12.5);
  assert.equal(timestamp('2026-01-01T00:00:00Z'), 1767225600);
  assert.equal(timestamp('2026-01-01T01:00:00.123456+01:00'), 1767225600.123456);
  assert.equal(timestamp('2026-01-01T00:00:00'), null);
  assert.equal(timestamp('later'), null);
  assert.equal(timestamp(true), null);
});

test('stage categories', () => {
  const stages = ['erc', 'snapshot-a', 'fab-zip', 'probe:kicad', 'gerber-runtime', 'validate-x', 'board-semantic', 'route'];
  assert.deepEqual(stages.map(stageCategory), ['kicad', 'snapshot', 'export', 'preflight', 'preflight', 'validation', 'validation', 'operation']);
});

const wrapper = new URL('../pcb_timing.ts', import.meta.url).pathname;
const runWrapper = (...args: string[]) =>
  spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', wrapper, ...args], { encoding: 'utf8' });
function eventsFile(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'pcb-timing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'sub/stages.jsonl');
}
const rowsOf = (file: string): TimingEvent[] => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('the wrapper keeps the child exit and records a failed boundary', t => {
  const file = eventsFile(t);
  const result = runWrapper('--events', file, '--stage', 'export', '--category', 'export', '--', process.execPath, '-e', 'process.exit(23)');
  assert.equal(result.status, 23);
  const rows = rowsOf(file);
  assert.deepEqual(rows.map(row => row.type), ['stage.start', 'stage.end']);
  assert.equal(rows[1]!.code, 23);
  assert.equal(rows[1]!.status, 'failed');
  assert.equal(rows[0]!.span_id, rows[1]!.span_id);
  assert.ok(Number(rows[1]!.duration_s) >= 0);
});

test('the wrapper gives 128 + signal for a killed child', t => {
  const result = runWrapper('--events', eventsFile(t), '--stage', 'export', '--', 'sh', '-c', 'kill -TERM $$');
  assert.equal(result.status, 143);
});

test('a launch failure never claims a pass', t => {
  const file = eventsFile(t);
  const result = runWrapper('--events', file, '--stage', 'export', '--', join(file, 'missing'));
  assert.equal(result.status, 1);
  const row = rowsOf(file).at(-1)!;
  assert.equal(row.status, 'error');
  assert.ok(!('code' in row));
});
