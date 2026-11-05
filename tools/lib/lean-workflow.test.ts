import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { sha256File } from './json-file.ts';
import { createClock } from './lean-clock.ts';
import {
  deadlineAfter, decodeDeadline, encodeDeadline, inheritedDeadline, optimizerOptions, preflightErrors, remaining, routerTimeout, selectReal, stageDepth, validateDrc,
} from './lean-workflow.ts';
import { jsonLoads, PyError } from './py-compat.mjs';
import { pyFloat } from './py-numbers.ts';

let folder: string;
const valueError = (error: unknown) => error instanceof PyError && (error as PyError).type === 'ValueError';
const fixedClock = (value: number) => () => value;
const load = (value: object) => jsonLoads(JSON.stringify(value));

beforeEach(() => { folder = realpathSync(mkdtempSync(join(tmpdir(), 'lean-workflow-'))); });
afterEach(() => rmSync(folder, { recursive: true, force: true }));

function board(step: number, outcome?: object): string {
  const directory = join(folder, `step-${step}/route-0`);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'routed.kicad_pcb');
  writeFileSync(path, `board ${step}`);
  if (outcome) writeFileSync(join(directory, 'outcome.json'), JSON.stringify(outcome));
  return path;
}

test('pyFloat takes what float() takes and refuses what it refuses', () => {
  assert.equal(pyFloat(' 1_000.5e1 '), 10005);
  assert.equal(pyFloat('-inf'), -Infinity);
  assert.ok(Number.isNaN(pyFloat('nan')));
  for (const text of ['', ' ', '0x10', '1e', 'abc', '1__0']) assert.throws(() => pyFloat(text), valueError, text);
});

test('a deadline round-trips in the text Python writes', () => {
  assert.equal(encodeDeadline(5), 'clock-monotonic-v1:5.0');
  assert.equal(decodeDeadline(encodeDeadline(183032.9975435)), 183032.9975435);
});

test('raw, NaN and unknown protocols fail closed', () => {
  for (const value of ['12.5', 'other:1.0', 'clock-monotonic-v1:nan', 'clock-monotonic-v1:inf', 'clock-monotonic-v1:', 5]) {
    assert.throws(() => decodeDeadline(value), valueError, String(value));
  }
  assert.throws(() => encodeDeadline(NaN), valueError);
});

test('a nested budget cannot extend the inherited deadline', () => {
  const env = { IOT_LEAN_DEADLINE: encodeDeadline(110) };
  assert.equal(inheritedDeadline(env), 110);
  assert.equal(deadlineAfter(60, env, fixedClock(100)), 110);
  assert.equal(deadlineAfter(5, env, fixedClock(100)), 105);
  assert.equal(deadlineAfter(5, {}, fixedClock(100)), 105);
  assert.throws(() => deadlineAfter(-1, {}, fixedClock(100)), valueError);
  assert.throws(() => deadlineAfter(Infinity, {}, fixedClock(100)), valueError);
});

test('remaining is never negative and decodes a protocol string', () => {
  assert.equal(remaining(105, fixedClock(100)), 5);
  assert.equal(remaining(95, fixedClock(100)), 0);
  assert.equal(remaining(encodeDeadline(105), fixedClock(100)), 5);
});

test('the clock samples once a second and carries the sample on hrtime between', () => {
  let samples = 0;
  let hr = 0n;
  const now = createClock(() => { samples += 1; return 1000 + samples * 100; }, () => hr);
  assert.equal(now(), 1100);
  hr = 500_000_000n;
  assert.equal(now(), 1100.5);
  assert.equal(samples, 1);
  hr = 1_000_000_000n;
  assert.equal(now(), 1200);   // a sleep shows up here: the sample jumps, hrtime did not
  assert.equal(samples, 2);
});

test('a sample is stamped midway through its call, not after the subprocess exits', () => {
  let hr = 0n;
  const now = createClock(() => { hr += 10_000_000n; return 500; }, () => hr);
  assert.equal(now(), 500.005);
});

test('process-relative hrtime is never the source of a deadline', () => {
  const clock = createClock(() => 5000, () => -99_999_000_000_000n);
  const deadline = deadlineAfter(1, {}, clock);
  assert.equal(deadline, 5001);
  assert.ok(remaining(deadline, clock)! > 0.9);
});

test('stage depth supports root plus two nested levels', () => {
  assert.equal(stageDepth({}), 0);
  assert.equal(stageDepth({ IOT_LEAN_STAGE_DEPTH: '2' }), 2);
  for (const value of ['3', '-1', 'x', '']) assert.throws(() => stageDepth({ IOT_LEAN_STAGE_DEPTH: value }), valueError, value);
});

test('the thread budget covers both router phases', () => {
  assert.deepEqual(optimizerOptions('always'), ['--router.optimizer.enabled=true']);
  assert.deepEqual(optimizerOptions('never', 4), ['--router.optimizer.enabled=false', '--router.autorouter.max_threads=4', '--router.optimizer.max_threads=4']);
});

test('only native existing copper errors are fatal', () => {
  const drc = load({ violations: [
    { severity: 'error', type: 'clearance' }, { severity: 'error', type: 'shorting_items', excluded: true },
    { severity: 'warning', type: 'clearance' }, { severity: 'error', type: 'unconnected_items' },
    { severity: 'error', type: 'copper_edge_clearance', excluded: false },
  ] });
  assert.equal(preflightErrors(drc).length, 2);
});

test('malformed DRC evidence is rejected', () => {
  const good = load({ violations: [], unconnected_items: [] });
  assert.equal(validateDrc(good), good);
  for (const bad of [load({ violations: [] }), load({ violations: {}, unconnected_items: [] }), null, []]) {
    assert.throws(() => validateDrc(bad), valueError);
  }
});

test('a router timeout keeps the checkpoint hash and is never qualified', () => {
  writeFileSync(join(folder, 'board.ses'), 'checkpoint');
  routerTimeout(folder, { name: 'TimeoutExpired', cleanup: { complete: true } });
  const outcome = JSON.parse(readFileSync(join(folder, 'outcome.json'), 'utf8'));
  assert.equal(outcome.status, 'timeout');
  assert.equal(outcome.returncode, 124);
  assert.equal(outcome.qualified, false);
  assert.deepEqual(outcome.artifacts, { 'board.ses': sha256File(join(folder, 'board.ses')) });
  assert.deepEqual(outcome.cleanup, { complete: true });
});

test('selection prefers a passed step, then the lowest score, then the first index', () => {
  board(0);
  const passed = board(1);
  const low = board(2);
  const step = (runs: number[], passedStep: boolean) => ({ k: 1.0, board: 'stored', runs, passed: passedStep });
  assert.equal(selectReal(load({ steps: [step([1.5], false), step([9.5], true)] }), folder), passed);
  assert.equal(selectReal(load({ steps: [step([5.5], false), step([9.5], false), step([1.5], false)] }), folder), low);
  assert.equal(selectReal(load({ steps: [step([3.5], false), step([3.5], false)] }), folder), join(folder, 'step-0/route-0/routed.kicad_pcb'));
});

test('virtual, timed-out and off-outline steps cannot be selected, and stored paths are not followed', () => {
  const stored = join(folder, 'elsewhere.kicad_pcb');
  writeFileSync(stored, 'x');
  board(0);
  const steps = [
    { k: 0.9, board: stored, runs: [1.5] }, { k: 1.0, status: 'timeout', board: stored, runs: [1.5] },
    { k: 1.0, runs: [1.5] }, { k: 1.0, board: stored, runs: [] }, { k: 1.0, board: stored, runs: [1000000] },
    { k: 1.0, board: stored, runs: ['1'] },
  ];
  for (const step of steps) assert.throws(() => selectReal(load({ steps: [step] }), folder), /no verified candidate/, JSON.stringify(step));
  assert.throws(() => selectReal(load({ steps: [{}, { k: 1.0, board: stored, runs: [1.5] }] }), folder), /no verified candidate/);
});

test('a modified candidate is rejected through its outcome hash', () => {
  const path = board(0, { status: 'complete', board_sha256: 'old' });
  const run = load({ steps: [{ k: 1.0, board: 'b', runs: [1.5] }] });
  assert.throws(() => selectReal(run, folder), /no verified candidate/);
  writeFileSync(join(folder, 'step-0/route-0/outcome.json'), JSON.stringify({ status: 'complete', board_sha256: sha256File(path) }));
  assert.equal(selectReal(run, folder), path);
  writeFileSync(join(folder, 'step-0/route-0/outcome.json'), JSON.stringify({ status: 'timeout', board_sha256: sha256File(path) }));
  assert.throws(() => selectReal(run, folder), /no verified candidate/);
});
