// The call log: one start line and one end line for each `tools/pcb` call, appended to `.gate/calls.jsonl`.
// The log is a record for people. No gate reads it, it never changes the exit code of a command, and it holds no secret.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { callLogPath, commandOf, openCall, redactArgs } from './call-log.ts';

const WRAPPER = new URL('../pcb-call.ts', import.meta.url).pathname;

test('a secret in the arguments is masked, and a long argument is cut', () => {
  assert.deepEqual(redactArgs(['check', 'B', '--token', 'abc', '--api-key=xyz', 'MY_SECRET=1', '--json']), ['check', 'B', '--token', '***', '--api-key=***', 'MY_SECRET=***', '--json']);
  assert.equal(redactArgs(['x'.repeat(500)])[0]!.length, 200);
  assert.equal(redactArgs(Array.from({ length: 80 }, (_, i) => String(i))).length, 41);   // 40 arguments and one mark
});

test('the command and its arguments are found after --project', () => {
  assert.deepEqual(commandOf(['--project', '/p', 'check', 'B', '--json']), { project: '/p', command: 'check', args: ['B', '--json'] });
  assert.deepEqual(commandOf(['--project=/p', 'state', 'B']), { project: '/p', command: 'state', args: ['B'] });
  assert.deepEqual(commandOf(['check', 'B']), { project: null, command: 'check', args: ['B'] });
  assert.deepEqual(commandOf([]), { project: null, command: 'check', args: [] });     // the dispatcher runs check when there is no command
});

test('a call has a start line and an end line with the time, the exit code and the duration', () => {
  const lines: string[] = [], times = [Date.parse('2026-11-07T08:00:00Z'), Date.parse('2026-11-07T08:00:02.500Z')];
  const call = openCall({ append: line => lines.push(line), now: () => times.shift()!, id: () => 'c-1', warn: () => assert.fail('no warning') }, ['--project', '/p', 'check', 'B', '--token', 'abc'], { caller: 'studio', pid: 7 });
  call.end(1, null);
  assert.deepEqual(lines.map(line => JSON.parse(line)), [
    { schema: 'iot-lab.cli-call.v1', id: 'c-1', phase: 'start', at: '2026-11-07T08:00:00.000Z', command: 'check', args: ['B', '--token', '***'], caller: 'studio', pid: 7 },
    { schema: 'iot-lab.cli-call.v1', id: 'c-1', phase: 'end', at: '2026-11-07T08:00:02.500Z', exit_code: 1, signal: null, duration_ms: 2500 }]);
});

test('a failed write warns once and never throws, and a call whose start is not written has no end line', () => {
  const warnings: string[] = [];
  const call = openCall({ append: () => { throw new Error('disk full'); }, now: () => 0, id: () => 'c-2', warn: message => warnings.push(message) }, ['state', 'B'], {});
  call.end(0, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /call log not written.*disk full/);
});

test('a failed end write is a warning, and the start line stays without an end', () => {
  const lines: string[] = [], warnings: string[] = [];
  let writes = 0;
  const call = openCall({ append: line => { if (++writes === 2) throw new Error('gone'); lines.push(line); }, now: () => 0, id: () => 'c-3', warn: message => warnings.push(message) }, ['state', 'B'], {});
  call.end(0, null);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]!).phase, 'start');
  assert.equal(warnings.length, 1);
});

test('the log is in .gate of the project', () => {
  assert.equal(callLogPath('/p'), '/p/.gate/calls.jsonl');
});

/** The wrapper runs a script, so a test script stands in for the real command. */
function wrapped(root: string, script: string, extra: NodeJS.ProcessEnv = {}): { status: number | null; stderr: string; lines: Record<string, unknown>[] } {
  const file = join(root, 'script.mjs');
  writeFileSync(file, script);
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', WRAPPER, file, '--project', root, 'check', 'B', '--token', 'hunter2'], { encoding: 'utf8', env: { ...process.env, SECRET_ENV: 'env-value-9', ...extra } });
  let text = '';
  try { text = readFileSync(callLogPath(root), 'utf8'); } catch { /* no log */ }
  return { status: result.status, stderr: result.stderr, lines: text.split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

test('the wrapper passes the exit code through and logs the call without any secret', () => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-call-'));
  const out = wrapped(root, 'process.exit(3)');
  assert.equal(out.status, 3);
  assert.deepEqual(out.lines.map(line => line.phase), ['start', 'end']);
  assert.equal(out.lines[1]!.exit_code, 3);
  assert.equal(out.lines[0]!.command, 'check');
  const text = readFileSync(callLogPath(root), 'utf8');
  assert.ok(!text.includes('hunter2') && !text.includes('env-value-9'));
});

test('the wrapper keeps the exit code when the log cannot be written, and says so on stderr', () => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-call-'));
  writeFileSync(join(root, '.gate'), 'a file, not a folder');
  const failing = wrapped(root, 'process.exit(5)');
  assert.equal(failing.status, 5);
  assert.match(failing.stderr, /call log not written/);
  assert.equal(failing.lines.length, 0);
  const passing = wrapped(root, 'process.exit(0)');
  assert.equal(passing.status, 0);
  assert.match(passing.stderr, /call log not written/);
});

test('PCB_CALL_LOG=0 turns the log off', () => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-call-'));
  mkdirSync(join(root, '.gate'));
  const out = wrapped(root, 'process.exit(0)', { PCB_CALL_LOG: '0' });
  assert.equal(out.status, 0);
  assert.equal(out.lines.length, 0);
});
