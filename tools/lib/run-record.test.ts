import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Float, jsonDumps, jsonLoads, PyError } from './py-compat.mjs';
import * as rr from './run-record.ts';

const FIXTURES = fileURLToPath(new URL('../fixtures/run-record', import.meta.url));
const hasFixtures = existsSync(FIXTURES);
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const plain = (row: unknown) => JSON.parse(jsonDumps(row)) as Record<string, any>;
const pass = (t: number, n: number, open: number) =>
  `   ${t.toFixed(3)} INFO  Auto-routing pass #${n} was completed in 1.00 seconds with score 10.0 (${open} unrouted and 0 violations) (routed 5, failed 1, ripped 2).\n`;
const progress = (elapsed: number, stage: string, passNumber: number | null = null, open: number | null = null) =>
  `${JSON.stringify({ t: 'x', t0: 1000, elapsed_s: elapsed, stage, pass: passNumber, open, vias: null, best_open: open, eta_s: null })}\n`;
const unrouted = (net: string) => JSON.stringify({
  unrouted: [{ net, from: { kind: 'pin', component: 'U1', pin: '1' }, to: { kind: 'pin', component: 'U2', pin: '2' }, diagnosis: { class: 'congestion' } }],
});

let folder: string;
const write = (name: string, text: string) => writeFileSync(join(folder, name), text);
const derived = () => rr.derive(folder).map(plain);
const by = (stage: string, action: string) => derived().filter(row => row.stage === stage && row.action === action);

beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'run-record-')); });
afterEach(() => rmSync(folder, { recursive: true, force: true }));

test('a record has every key in order', () => {
  const row = rr.record('route', 'pass', { result: { pass: 1n }, why: 'x', elapsed_s: new Float(1) });
  assert.deepEqual([...row.keys()], [...rr.KEYS]);
  assert.match(row.get('t') as string, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
});

test('append reads back in order and floats stay floats in the file', () => {
  rr.start(folder, 0);
  rr.append(folder, 'a', 'one', { why: 'first', elapsed_s: new Float(1) });
  rr.append(folder, 'b', 'two', { why: 'second', elapsed_s: 2n });
  const rows = rr.read(folder);
  assert.deepEqual(rows.map(row => row.get('action')), ['one', 'two']);
  assert.ok(rows.every(row => [...row.keys()].join() === rr.KEYS.join()));
  assert.equal(rr.ordered([...rows].reverse())[0]!.get('action'), 'one');
  const text = readFileSync(join(folder, rr.FILE), 'utf8');
  assert.match(text, /"elapsed_s": 1\.0, /);
  assert.match(text, /"elapsed_s": 2, /);
});

test('an unknown elapsed keeps its file position', () => {
  const rows = [rr.record('s', 'a', { elapsed_s: new Float(5) }), rr.record('s', 'b'), rr.record('s', 'c', { elapsed_s: new Float(6) })];
  assert.deepEqual(rr.ordered(rows).map(row => row.get('action')), ['a', 'b', 'c']);
});

test('the job clock falls back to progress.jsonl and a zero t0 is unknown', () => {
  write('progress.jsonl', progress(0, 'job start'));
  assert.equal(rr.clock(folder), 1000);
  const other = mkdtempSync(join(tmpdir(), 'run-record-'));
  rr.start(other, 0);
  assert.equal(rr.elapsed(other), null);
  rmSync(other, { recursive: true });
});

test('router pass lines', { skip: !hasFixtures }, () => {
  const passes = rr.parseLog(fixture('run.log'), 12.7).map(plain).filter(row => row.action === 'pass');
  assert.deepEqual(passes.map(row => row.result.pass), [1, 2, 3, 29, 30]);
  const first = passes[0]!;
  assert.deepEqual([first.result.open, first.result.violations, first.result.ripups, first.result.routed, first.result.failed], [78, 3, 93, 172, 35]);
  assert.ok(Math.abs(first.elapsed_s - (12.7 + 10.784)) < 0.06);
  assert.match(first.why, /93 rip-ups/);
});

test('the other router actions', { skip: !hasFixtures }, () => {
  const rows = rr.parseLog(fixture('run.log')).map(plain);
  for (const action of ['fanout', 'checkpoint', 'stop', 'router end', 'skip', 'diagnosis']) assert.ok(rows.some(row => row.action === action), action);
  assert.deepEqual(rows.find(row => row.action === 'diagnosis')!.result, { open: 10, congestion: 6, blocked: 4, ignored: 0, seconds: 8.71 });
  const skip = rows.find(row => row.action === 'skip')!;
  assert.equal(skip.result.items, 8);
  assert.match(skip.why, /second failure/);
  const times = rows.map(row => row.elapsed_s);
  assert.deepEqual([...times].sort((a, b) => a - b), times);
});

test('a line with an impossible number is a ValueError, as float() raises', () => {
  assert.throws(() => rr.parseLogLine(' 1.2.3 INFO  stop requested: x'), (error: unknown) => error instanceof PyError && (error as PyError).type === 'ValueError');
});

test('reasons per net', { skip: !hasFixtures }, () => {
  const rows = rr.reasons(jsonLoads(fixture('report.json')), new Float(96)).map(plain);
  assert.deepEqual(rows.map(row => row.inputs.net), ['/PWR-24V/VIN', '/PWR-24V/5V_24V']);
  assert.deepEqual(rows.map(row => row.result.class), ['blocked', 'congestion']);
  assert.equal(rows[0]!.inputs.from, 'U18.2');
  assert.match(rows[0]!.result.router_text, /no connection was found/);
  assert.match(rows[0]!.why, /^blocked:/);
  assert.deepEqual(rows[1]!.result.passes_failed, [1, 10]);
});

test('sync is idempotent', { skip: !hasFixtures }, () => {
  copyFileSync(join(FIXTURES, 'run.log'), join(folder, 'run.log'));
  copyFileSync(join(FIXTURES, 'report.json'), join(folder, 'report.json'));
  const row = (elapsed: number, stage: string) => `${JSON.stringify({ t: 'x', t0: 0, elapsed_s: elapsed, stage })}\n`;
  write('progress.jsonl', row(0, 'job start') + row(12.7, 'route start') + row(95.9, 'route end'));
  write('outcome.json', JSON.stringify({ status: 'stuck', signal_open: 10, note: 'fail_fast' }));
  const added = rr.sync(folder);
  assert.equal(rr.sync(folder), 0);
  const rows = rr.ordered(rr.read(folder)).map(plain);
  assert.equal(rows.length, added);
  assert.equal(rows[0]!.action, 'job start');
  assert.equal(rows.at(-1)!.action, 'exit STUCK');
  assert.equal(rows.at(-1)!.elapsed_s, 95.9);
  assert.ok(rr.logLines(folder, false).some(line => line.includes('exit STUCK') && line.includes('fail_fast')));
});

test('each routing stage reads its own files on its own clock', () => {
  write('progress.jsonl', progress(0, 'job start') + progress(1, 'route-fast start') + progress(2, 'route-fast end')
    + progress(5, 'route-fast start') + progress(8, 'route-fast', 1, 12) + progress(20, 'route-fast end')
    + progress(30, 'route start') + progress(34, 'route', 1, 3) + progress(50, 'route end'));
  write('run-fast.log', pass(2.5, 1, 12));
  write('run.log', pass(3, 1, 3));
  write('report-fast.json', unrouted('/FAST'));
  write('report.json', unrouted('/FINAL'));
  write('stall-fast.json', JSON.stringify({ stopped: true, seconds: 1018, stall_passes: 4, stage: 'fast' }));
  write('optimize-fast.log', pass(1.5, 2, 11));
  const fast = by('route-fast', 'pass');
  assert.equal(fast.length, 1);
  assert.equal(fast[0]!.elapsed_s, 7.5);
  assert.deepEqual([fast[0]!.inputs.attempt, fast[0]!.inputs.log], [2, 'run-fast.log']);
  assert.deepEqual(by('route', 'pass').map(row => row.elapsed_s), [33]);
  const opens = Object.fromEntries(derived().filter(row => row.action === 'open').map(row => [row.stage, row]));
  assert.deepEqual([opens['route-fast'].elapsed_s, opens['route-fast'].inputs.net], [20, '/FAST']);
  assert.deepEqual([opens.route.elapsed_s, opens.route.inputs.net], [50, '/FINAL']);
  assert.equal(opens['route-fast'].evidence, 'report-fast.json unrouted[]');
  const stall = by('route-fast', 'stall stop');
  assert.deepEqual([stall.length, stall[0]!.evidence, stall[0]!.elapsed_s], [1, 'stall-fast.json', 18]);
  assert.equal(stall[0]!.inputs.receipt_format, 'historical_stopped');
  assert.match(stall[0]!.why, /historical stop receipt/);
  assert.match(stall[0]!.why, /confirmation is unavailable/);
  assert.equal(by('optimize-fast', 'pass')[0]!.elapsed_s, 21.5);
  assert.deepEqual(rr.routeStages(folder, rr.readJsonl(join(folder, 'progress.jsonl'))).map(stage => stage.stage), ['route-fast', 'route']);
});

for (const [attempted, acknowledged, action, explanation] of [
  [true, true, 'stall interrupt attempted', 'broker acknowledged the request'],
  [true, false, 'stall interrupt attempted', 'broker did not acknowledge the request'],
  [true, null, 'stall interrupt attempted', 'broker acknowledgment is unknown'],
  [false, null, 'stall interrupt not attempted', 'no owned router handle'],
] as const) {
  test(`a stall receipt claims no exit: ${attempted} ${acknowledged}`, () => {
    write('progress.jsonl', progress(2, 'route-fast start'));
    const receipt = { interrupt_attempted: attempted, interrupt_acknowledged: acknowledged, pass_no: 6, best: 1, unrouted: 1, seconds: 1012, stall_passes: 5, stage: 'fast' };
    write('stall-fast.json', JSON.stringify(receipt));
    const rows = derived().filter(row => row.evidence === 'stall-fast.json');
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.deepEqual([row.stage, row.action, row.elapsed_s], ['route-fast', action, 12]);
    assert.deepEqual(row.result, receipt);
    assert.equal(row.inputs.receipt_format, 'interrupt_request');
    assert.ok(row.why.includes(explanation));
    assert.match(row.why, /does not confirm process exit/);
    assert.equal(rr.sync(folder), 2);
    assert.equal(rr.sync(folder), 0);
  });
}

test('live watcher passes stand in when the log has none', () => {
  write('progress.jsonl', progress(0, 'route-fast start') + progress(8, 'route-fast', 1, 12) + progress(9, 'route-fast end'));
  assert.deepEqual(by('route-fast', 'pass').map(row => [row.result.pass, row.result.open, row.elapsed_s]), [[1, 12, 8]]);
});

test('unknown triage says the cause is unknown', () => {
  write('open-triage.json', JSON.stringify({ open: 3, enclosed: 1, router_miss: 1, unknown: 1, connections: [
    { net: 'A', class: 'ENCLOSED' }, { net: 'B', class: 'ROUTER_MISS' }, { net: 'C', class: 'UNKNOWN' }] }));
  const why = Object.fromEntries(by('triage', 'open').map(row => [row.inputs.net, row.why]));
  assert.equal(why.B, 'a path exists; the router missed it');
  assert.match(why.C, /cause is unknown/);
  assert.doesNotMatch(why.C, /router missed/);
  assert.match(why.A, /no legal path/);
});

test('an incomplete last append keeps the valid rows; a bad line before it is corruption', () => {
  const good = jsonDumps(rr.record('job', 'configure', { why: 'x', elapsed_s: new Float(0) }));
  write('run.jsonl', `${good}\n{"t": "2026-10-11T00:00:00", "elapsed_s": 1.0, "stag`);
  assert.deepEqual(rr.read(folder).map(row => row.get('action')), ['configure']);
  write('progress.jsonl', `${progress(0, 'route start')}{"t": "x", "elap`);
  assert.ok(rr.view(folder).length);
  assert.equal(rr.sync(folder), 1);
  write('run.jsonl', `${good}\n{"broken\n${good}\n`);
  assert.throws(() => rr.read(folder), (error: unknown) => error instanceof PyError && (error as PyError).type === 'ValueError');
});

test('format prints the elapsed column, the net and scalar results only', () => {
  const row = rr.record('route', 'open', { elapsed_s: new Float(1.25), inputs: { net: '/N' }, result: { open: 2n, command: 'x', list: [1n], ok: true, none: null }, why: 'w' });
  assert.equal(rr.format(row), '    1.2s route: open /N  [open=2 ok=True none=None]  -- w');
  assert.equal(rr.format(rr.record('job', 'x', { why: 'w' })), '      -s job: x  -- w');
});
