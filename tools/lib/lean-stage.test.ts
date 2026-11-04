import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { iotrouteMissing } from './iotroute-bin.ts';
import { now } from './lean-clock.ts';
import { StageCancelled } from './lean-resources.ts';
import { runStage, TimeoutExpired } from './lean-stage.ts';
import { encodeDeadline } from './lean-workflow.ts';
import { OwnedStageError } from './owned-stage.ts';
import { PyError } from './py-compat.mjs';

const needsBinary = { skip: iotrouteMissing() };   // runs for real in CI job tools-iotroute

let folder: string;
const lines = (name: string) => readFileSync(join(folder, name), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const capture = { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } as const;

beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'lean-stage-')); });
afterEach(() => rmSync(folder, { recursive: true, force: true }));

test('a stage captures text, translates newlines and records its end', needsBinary, async () => {
  const events = join(folder, 'stages.jsonl');
  const result = await runStage(['sh', '-c', "printf 'a\\r\\nb'; printf e >&2"], { stage: 'one', eventFile: events, ...capture });
  assert.deepEqual(result, { returncode: 0, stdout: 'a\nb', stderr: 'e' });
  const [event] = lines('stages.jsonl');
  assert.deepEqual([event.stage, event.status, event.returncode, event.cause], ['one', 'complete', 0, null]);
  assert.equal(event.cleanup.complete, true);
  assert.equal(typeof event.child_cpu_s, 'number');
  const [record] = lines('run.jsonl');
  assert.deepEqual([record.stage, record.action, record.evidence], ['one', 'stage complete', 'stages.jsonl']);
});

test('a failing command is a failed stage, not an error', needsBinary, async () => {
  const events = join(folder, 'stages.jsonl');
  assert.equal((await runStage(['sh', '-c', 'exit 3'], { stage: 'two', eventFile: events, ...capture })).returncode, 3);
  assert.deepEqual([lines('stages.jsonl')[0].status, lines('stages.jsonl')[0].returncode], ['failed', 3]);
});

test('the deadline stops the whole group and confirms it', needsBinary, async () => {
  const events = join(folder, 'stages.jsonl');
  const marker = join(folder, 'late');
  const run = runStage(['sh', '-c', `sleep 30 & wait; touch '${marker}'`], { stage: 'slow', eventFile: events, deadline: now() + 0.4, ...capture });
  await assert.rejects(run, (error: unknown) => error instanceof TimeoutExpired && error.cleanup?.complete === true);
  const [event] = lines('stages.jsonl');
  assert.deepEqual([event.status, event.cause], ['timeout', { type: 'TimeoutExpired', signal: null }]);
  assert.equal(event.cleanup.complete, true);
  assert.equal(lines('run.jsonl')[0].why, "stage timeout: {'type': 'TimeoutExpired', 'signal': None}");
});

test('all output of a stage arrives, however large', needsBinary, async () => {
  const size = 4 * 1024 * 1024;
  const result = await runStage(['sh', '-c', `head -c ${size} /dev/zero | tr '\\0' x`], { stage: 'big', ...capture });
  assert.equal(result.stdout!.length, size);
});

test('an expired deadline never launches the command', needsBinary, async () => {
  const marker = join(folder, 'ran');
  const events = join(folder, 'stages.jsonl');
  await assert.rejects(runStage(['touch', marker], { stage: 'late', eventFile: events, deadline: encodeDeadline(now() - 1), ...capture }), TimeoutExpired);
  assert.equal(existsSync(marker), false);
  assert.equal(lines('stages.jsonl')[0].status, 'timeout');
});

test('a child environment cannot extend or remove the parent budget', needsBinary, async () => {
  const saved = process.env.IOT_LEAN_DEADLINE;
  const bound = now() + 30;
  process.env.IOT_LEAN_DEADLINE = encodeDeadline(bound);
  try {
    const env = { ...process.env, IOT_LEAN_DEADLINE: encodeDeadline(bound + 100) };
    const seen = await runStage(['sh', '-c', 'printf %s "$IOT_LEAN_DEADLINE"'], { stage: 'inherit', env, ...capture });
    assert.equal(seen.stdout, encodeDeadline(bound));
  } finally {
    if (saved === undefined) delete process.env.IOT_LEAN_DEADLINE;
    else process.env.IOT_LEAN_DEADLINE = saved;
  }
});

test('a child environment cannot reset the stage depth', async () => {
  await assert.rejects(runStage(['true'], { stage: 'depth', env: { IOT_LEAN_STAGE_DEPTH: '2' } }), (error: unknown) => error instanceof PyError && /reset owned stage depth/.test(error.message));
});

test('a signal cancels the stage and says which signal', needsBinary, async () => {
  const events = join(folder, 'stages.jsonl');
  const run = runStage(['sleep', '30'], { stage: 'sig', eventFile: events, onStart: () => setTimeout(() => process.emit('SIGTERM'), 200), ...capture });
  await assert.rejects(run, (error: unknown) => error instanceof StageCancelled && (error as StageCancelled & { cleanup?: { complete: boolean } }).cleanup?.complete === true);
  const [event] = lines('stages.jsonl');
  assert.deepEqual([event.status, event.cause], ['cancelled', { type: 'StageCancelled', signal: 15 }]);
  assert.equal(process.listenerCount('SIGTERM'), 0);
});

test('a missing program rejects with the spawn error and is recorded', needsBinary, async () => {
  const events = join(folder, 'stages.jsonl');
  await assert.rejects(runStage(['/nonexistent/program'], { stage: 'gone', eventFile: events, ...capture }), (error: unknown) => error instanceof OwnedStageError && error.kind === 'FileNotFoundError');
  assert.deepEqual([lines('stages.jsonl')[0].status, lines('stages.jsonl')[0].cause.type], ['failed', 'FileNotFoundError']);
});

test('a stage may write to a log file', needsBinary, async () => {
  const log = join(folder, 'out.log');
  writeFileSync(log, '');
  const { openSync, closeSync } = await import('node:fs');
  const file = openSync(log, 'a');
  const result = await runStage(['sh', '-c', 'echo hi'], { stage: 'log', stdin: 'ignore', stdout: file, stderr: file });
  closeSync(file);
  assert.deepEqual([result.returncode, result.stdout], [0, null]);
  assert.equal(readFileSync(log, 'utf8'), 'hi\n');
});
