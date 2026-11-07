import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { holdLock } from './file-lock.ts';
import { iotrouteMissing } from './iotroute-bin.ts';
import { evidenceFiles } from './pcb-evidence.ts';
import { backendOption, compactTerminal, controllerAlive, eventLine, events, explain, gateDirectory, liveStages, requestCancel, runDir, stageStatus, status, utc } from './pcb-runs.ts';
import { jsonDumps, jsonLoads, PyError } from './py-compat.mjs';
const needsBinary = { skip: iotrouteMissing() };   // runs for real in CI job tools-iotroute

let folder: string;
const put = (name: string, text: string) => {
  const path = join(folder, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};
const state = (fields: object) => put('state.json', JSON.stringify({ schema_version: 1, seq: 0, ...fields }));
const seal = (extra: object = {}) => {   // a receipt as pcb-check-finalize writes it: bound to the evidence files on disk
  put('run.json', '{"board":"X","operation":"check"}');
  put('gate/result.json', '{"exit":0}');
  put('result.json', JSON.stringify({ status: 'passed', exit_code: 0, cause: 'gate passed', cleanup: { complete: true }, evidence_sha256: evidenceFiles(folder), ...extra }));
};
const row = (text: string) => jsonLoads(text) as Map<string, unknown>;
const valueError = (error: unknown) => error instanceof PyError && (error as PyError).type === 'ValueError';

beforeEach(() => { folder = realpathSync(mkdtempSync(join(tmpdir(), 'run-abc'))); });
afterEach(() => rmSync(folder, { recursive: true, force: true }));

test('utc has milliseconds and an offset', () => {
  assert.equal(utc(new Date(Date.UTC(2026, 10, 4, 1, 2, 3, 45))), '2026-11-04T01:02:03.045+00:00');
});

test('a backend option is read in both spellings, once', () => {
  assert.equal(backendOption(['--contract', 'a'], '--contract'), 'a');
  assert.equal(backendOption(['--contract=b'], '--contract'), 'b');
  assert.equal(backendOption([], '--contract'), null);
  assert.throws(() => backendOption(['--contract'], '--contract'), /requires a value/);
  assert.throws(() => backendOption(['--contract=a', '--contract', 'b'], '--contract'), /duplicate backend option/);
});

test('a run ID must be well formed and known', () => {
  assert.throws(() => runDir(folder, '../x'), /invalid run ID/);
  assert.throws(() => runDir(folder, 'run-x\n'), /invalid run ID/);
  assert.throws(() => runDir(folder, 'run-x'), /unknown run: run-x/);
  put('run-x/run.json', '{}');
  assert.equal(runDir(folder, 'run-x'), join(folder, 'run-x'));
});

test('a terminal view keeps inventory sizes and binds its receipt', () => {
  const result = row('{"status":"passed","evidence_sha256":{"a":"1","b":"2"},"artifacts":{},"engineering_absent_inputs":["x"]}');
  assert.equal(jsonDumps(compactTerminal(result, folder)), '{"status": "passed", "inventory_counts": {"engineering_absent_inputs": 1, "evidence_sha256": 2, "artifacts": 0}}');
  put('result.json', '{}');
  const view = compactTerminal(result, folder);
  assert.equal((view.get('receipt') as Map<string, unknown>).get('path'), join(folder, 'result.json'));
  assert.equal(result.has('artifacts'), true, 'the receipt itself is not changed');
});

test('controller liveness is the lock: absent, free or held', needsBinary, async () => {
  assert.equal(controllerAlive(folder), null);
  const path = join(folder, 'worker.lock');
  const lock = await holdLock(path);
  assert.equal(controllerAlive(folder), true);
  await lock.release();
  assert.equal(controllerAlive(folder), false);
});

test('a running supervisor adds its wall time; a free lock means it stopped', needsBinary, async () => {
  state({ status: 'running', updated_unix: 1000.0, elapsed_s: 5.0, active_stage_timing: [{ stage: 'drc', started_unix_s: 990.5, last_activity_unix_s: 999.5 }], timing: { x: 1 } });
  const lock = await holdLock(join(folder, 'worker.lock'));
  const live = status(folder, 1002);
  assert.match(jsonDumps(live), /"heartbeat_age_s": 2\.0/);
  assert.match(jsonDumps(live), /"elapsed_s": 7\.0, /);
  assert.equal(live.get('elapsed_clock'), 'supervisor_monotonic_plus_wall_since_update');
  assert.match(jsonDumps(live.get('timing')), /"last_activity_age_s": 2\.5/);
  await lock.release();
  const stopped = status(folder, 1002);
  assert.equal(stopped.get('status'), 'error');
  assert.equal(stopped.get('exit_code'), 2n);
  assert.match(stopped.get('cause') as string, /cleanup unconfirmed/);
  assert.equal(stopped.has('elapsed_clock'), false);
});

test('a sealed receipt wins over a state a crash left open', () => {
  state({ status: 'stopping', updated_unix: 1000.0, elapsed_s: 5.0 });
  seal();
  const view = status(folder, 1002);
  assert.deepEqual([view.get('status'), view.get('exit_code'), view.get('cause'), view.has('elapsed_clock')], ['passed', 0n, 'gate passed', false]);
});

test('a sealed receipt wins when the supervisor lock is already free', needsBinary, async () => {
  state({ status: 'stopping', updated_unix: 1000.0, elapsed_s: 5.0 });
  seal();
  const lock = await holdLock(join(folder, 'worker.lock'));
  await lock.release();
  const view = status(folder, 1002);
  assert.deepEqual([view.get('controller_alive'), view.get('status'), view.get('exit_code')], [false, 'passed', 0n]);
});

test('a non-terminal result.json does not end a run', () => {
  state({ status: 'running', updated_unix: 1000.0, elapsed_s: 5.0 });
  seal({ status: 'running' });
  assert.equal(status(folder, 1002).get('status'), 'error');
});

test('a terminal result.json whose seal does not verify does not end a run', () => {
  const cases: Array<[string, () => void]> = [
    ['no evidence binding', () => put('result.json', JSON.stringify({ status: 'passed', exit_code: 0, cause: 'forged' }))],
    ['evidence changed after the seal', () => { seal(); put('gate/result.json', '{"exit":1}'); }],
    ['cleanup not confirmed', () => seal({ cleanup: { complete: false } })],
    ['unreadable receipt', () => put('result.json', '{not json')],
  ];
  for (const [name, setup] of cases) {
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder);
    state({ status: 'stopping', updated_unix: 1000.0, elapsed_s: 5.0 });
    setup();
    const view = status(folder, 1002);
    assert.deepEqual([name, view.get('status'), view.get('cause')], [name, 'error', 'supervisor lock is missing; cleanup unconfirmed']);
  }
});

test('a sealed error, cancelled or timeout receipt also wins over an open state', () => {
  for (const verdict of ['error', 'cancelled', 'timeout']) {
    state({ status: 'stopping', updated_unix: 1000.0, elapsed_s: 5.0 });
    seal({ status: verdict, exit_code: 1, cause: `sealed ${verdict}` });
    const view = status(folder, 1002);
    assert.deepEqual([view.get('status'), view.get('cause')], [verdict, `sealed ${verdict}`]);
  }
});

test('a run past startup with no supervisor lock is stopped, not running forever', () => {
  state({ status: 'running', updated_unix: 1000.0, elapsed_s: 5.0 });
  const view = status(folder, 1002);
  assert.equal(view.get('controller_alive'), null);
  assert.equal(view.get('status'), 'error');
  assert.match(view.get('cause') as string, /lock is missing/);
});

test('a clock behind the update gives the int 0, as max(0, x) does', () => {
  state({ status: 'passed', updated_unix: 1000.0 });
  assert.match(jsonDumps(status(folder, 999)), /"heartbeat_age_s": 0[,}]/);
  assert.match(jsonDumps(status(folder, 1000)), /"heartbeat_age_s": 0[,}]/);
});

test('starting run keeps integer elapsed when the wall clock is behind its update', () => {
  state({ status: 'starting', updated_unix: 1000, elapsed_s: 1 });
  assert.match(jsonDumps(status(folder, 999)), /"elapsed_s": 1[,}]/);
  assert.doesNotMatch(jsonDumps(status(folder, 999)), /"elapsed_s": 1\.0/);
});

test('startup gets ten seconds, with or without a lock', needsBinary, () => {
  state({ status: 'starting', updated_unix: 1000.0 });
  assert.equal(status(folder, 1005).get('status'), 'starting');
  assert.equal(status(folder, 1005).get('controller_alive'), null);
  assert.equal(status(folder, 1011).get('cause'), 'supervisor did not start; inspect worker.log');
  put('worker.lock', '');
  assert.equal(status(folder, 1005).get('status'), 'starting');
  assert.equal(status(folder, 1011).get('status'), 'error');
});

test('a terminal run stays as recorded', () => {
  state({ status: 'failed', updated_unix: 1000.0, elapsed_s: 5.0, cause: 'x' });
  const final = status(folder, 2000);
  assert.deepEqual([final.get('status'), final.get('cause'), final.has('elapsed_clock')], ['failed', 'x', false]);
});

test('cancel writes the request for a live run only', needsBinary, async () => {
  state({ status: 'passed', updated_unix: Date.now() / 1000 });
  assert.equal(requestCancel(folder).has('cancellation_requested'), false);
  assert.equal(existsSync(join(folder, 'cancel.request')), false);
  state({ status: 'running', updated_unix: Date.now() / 1000 });
  const lock = await holdLock(join(folder, 'worker.lock'));
  assert.equal(requestCancel(folder).get('cancellation_requested'), true);
  assert.equal(existsSync(join(folder, 'cancel.request')), true);
  await lock.release();
});

test('events return byte cursors and leave an unfinished line unread', () => {
  assert.deepEqual(events(folder), []);
  assert.throws(() => events(folder, 5), valueError);
  const first = '{"type":"a","text":"é"}\n';
  put('events.jsonl', `${first}{"type":"b"}\n{"type":"c`);
  const rows = events(folder);
  assert.deepEqual(rows.map(entry => entry.get('type')), ['a', 'b']);
  const cursor = Number(rows[0]!.get('cursor'));
  assert.equal(cursor, Buffer.byteLength(first));
  assert.deepEqual(events(folder, cursor).map(entry => entry.get('type')), ['b']);
  assert.equal(events(folder, 0, 1).length, 1);
  assert.throws(() => events(folder, 3), /returned line boundary/);
  assert.throws(() => events(folder, 10_000), /outside this run/);
  assert.throws(() => events(folder, -1), /outside this run/);
});

test('events preserve byte cursors across read chunks and stop at the requested limit', () => {
  const first = JSON.stringify({ type: 'a', text: 'é'.repeat(40_000) }) + '\n';
  const second = JSON.stringify({ type: 'b' }) + '\n';
  put('events.jsonl', first + second + '{"type":"partial"');
  const one = events(folder, 0, 1);
  assert.equal(one.length, 1);
  assert.equal(Number(one[0]!.get('cursor')), Buffer.byteLength(first));
  const next = events(folder, Number(one[0]!.get('cursor')), 1);
  assert.equal(next[0]!.get('type'), 'b');
  assert.equal(Number(next[0]!.get('cursor')), Buffer.byteLength(first + second));
  assert.deepEqual(events(folder, Number(next[0]!.get('cursor'))), []);
});

test('event lines read as the Python CLI prints them', () => {
  const line = (text: string) => eventLine(row(text), false);
  const head = '"run_id":"run-x","elapsed_s":1.25';
  assert.equal(line(`{${head},"type":"tool.output","stage":"drc","text":" a\\nb \\n"}`), 'run-x     1.2s tool.output drc a | b');
  assert.equal(line(`{${head},"type":"check.end","stage":"erc","status":"passed","metrics":{"e":0}}`), 'run-x     1.2s check.end erc passed {"e": 0}');
  assert.equal(line(`{${head},"type":"tool.exit","stage":"drc","code":1}`), 'run-x     1.2s tool.exit drc exit=1');
  assert.equal(line(`{${head},"type":"run.end","status":"failed","cause":"c"}`), 'run-x     1.2s run.end  failed: c');
  assert.equal(line(`{${head},"type":"run.heartbeat","active_stages":["a","b"]}`), 'run-x     1.2s run.heartbeat  alive; progress unknown; active=a,b');
  assert.equal(line(`{${head},"type":"run.start"}`), 'run-x     1.2s run.start');
  assert.equal(eventLine(row(`{${head}}`), true), '{"run_id": "run-x", "elapsed_s": 1.25}');
});

test('stage status prints what is known', () => {
  const stages = liveStages([row('{"stage":"drc","started_unix_s":10.0}')], 12.5);
  assert.equal(stageStatus(stages), 'drc elapsed=2.5s last-activity=unavailable');
});

test('the gate folder follows a release move', () => {
  assert.equal(gateDirectory(folder), join(folder, 'gate'));
  mkdirSync(join(folder, 'release-work/gate'), { recursive: true });
  assert.equal(gateDirectory(folder), join(folder, 'release-work/gate'));
  mkdirSync(join(folder, 'candidate/gate'), { recursive: true });
  assert.equal(gateDirectory(folder), join(folder, 'candidate/gate'));
});

test('explain counts findings past the limit, and survives a malformed report', () => {
  state({ status: 'failed', updated_unix: 1000.0 });
  put('gate/erc.json', '{"sheets":[{"violations":[1,2]},{"violations":[3]}]}');
  put('gate/drc.json', '[]');
  put('gate/findings.json', '{"complete":true}');
  put('gate/b.log', '');
  put('gate/a.log', '');
  put('operation/c.log', '');
  const report = explain(folder, 2);
  assert.equal(report.details.length, 3);
  assert.equal(report.omitted, 0);
  assert.deepEqual(report.details[2], { stage: 'drc', report: join(folder, 'gate/drc.json'), cause: 'malformed report; inspect original evidence' });
  assert.deepEqual(report.logs.slice(0, 3).map(path => path.slice(folder.length + 1)), ['gate/a.log', 'gate/b.log', 'operation/c.log']);
  put('gate/drc.json', '{"violations":[1],"unconnected_items":[2,3]}');
  const counted = explain(folder, 2);
  assert.deepEqual([counted.details.length, counted.omitted], [2, 4]);
  assert.equal((counted.findings as Map<string, unknown>).get('complete'), true);
});
