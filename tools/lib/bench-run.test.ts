import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildStudy, runSuite, spawnExecutor, TRIAL_RECORD, type Executor, type TrialRecord } from './bench-run.ts';
import { expandTrials, SUITE, validateSuite } from './bench-suite.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const suite = (argv: string[] = ['x']) => validateSuite({
  schema: SUITE, suite_id: 's', arms: [{ id: 'base', argv }, { id: 'new', argv }],
  boards: [{ family: 'A', board: 'ENV', split: 'development', input: { path: 'e', sha256: sha('e') } }, { family: 'B', board: 'REL', split: 'holdout', input: { path: 'r', sha256: sha('r') } }],
  seeds: [1, 2], budget: { timeout_s: 5, cpus: 1, memory_gb: 1 },
});
const fake = (status: TrialRecord['status']): Executor => async trial => ({
  schema: TRIAL_RECORD, id: trial.id, arm: trial.arm, status, run_id: status === 'sealed' ? `run-${trial.id}` : null, run_path: status === 'sealed' ? `runs/run-${trial.id}` : null,
  result_sha256: status === 'sealed' ? sha(trial.id) : null, wall_s: 1, exit_code: 0, cause: null, command: trial.argv,
});

test('runSuite stores one record per trial and resumes without rerunning', async () => {
  const out = mkdtempSync(join(tmpdir(), 'bench-run-'));
  try {
    let calls = 0;
    const counting: Executor = async (trial, context) => { calls += 1; return fake('sealed')(trial, context); };
    const first = await runSuite(suite(), { root: out, runsDir: out, out, executor: counting });
    assert.equal(first.length, 8);
    assert.equal(calls, 8);
    assert.equal(readdirSync(join(out, 'trials')).length, 8);
    await runSuite(suite(), { root: out, runsDir: out, out, executor: counting });
    assert.equal(calls, 8);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('resume reruns a trial that made no run, and keeps sealed and timed-out ones', async () => {
  const out = mkdtempSync(join(tmpdir(), 'bench-run-'));
  try {
    const first = expandTrials(suite())[0]!.id, second = expandTrials(suite())[1]!.id;
    const answers: Record<string, TrialRecord['status']> = { [first]: 'no_run', [second]: 'timeout' };
    const calls: string[] = [];
    const scripted: Executor = async (trial, context) => { calls.push(trial.id); return fake(answers[trial.id] ?? 'sealed')(trial, context); };
    await runSuite(suite(), { root: out, runsDir: out, out, executor: scripted });
    assert.equal(calls.length, 8);
    calls.length = 0;
    const resumed = await runSuite(suite(), { root: out, runsDir: out, out, executor: scripted });
    assert.deepEqual(calls, [first]);                 // only the trial that made no run is tried again
    assert.equal(resumed.length, 8);
    assert.equal(resumed.find(item => item.id === second)!.status, 'timeout');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('the study lists only sealed trials with splits, families and placement input', async () => {
  const out = mkdtempSync(join(tmpdir(), 'bench-run-'));
  try {
    const records = await runSuite(suite(), { root: out, runsDir: out, out, executor: fake('sealed') });
    const study = buildStudy(suite(), records) as { arms: string[]; development_families: string[]; holdout_families: string[]; trials: Record<string, unknown>[] };
    assert.deepEqual(study.arms, ['base', 'new']);
    assert.deepEqual([study.development_families, study.holdout_families], [['A'], ['B']]);
    assert.equal(study.trials.length, 8);
    assert.equal(study.trials[0]!.kind, 'cli_run');
    assert.deepEqual(study.trials[0]!.placement_input, { path: 'e', sha256: sha('e') });
    const none = buildStudy(suite(), await runSuite(suite(), { root: out, runsDir: out, out: join(out, 'b'), executor: fake('no_run') }));
    assert.equal((none.trials as unknown[]).length, 0);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('spawnExecutor follows a command to its run folder, and reports a command that makes none', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-spawn-'));
  try {
    const runs = join(root, 'runs');
    mkdirSync(join(runs, 'run-abc'), { recursive: true });
    writeFileSync(join(runs, 'run-abc/result.json'), '{"status":"passed"}');
    const script = join(root, 'fake.sh');
    writeFileSync(script, '#!/bin/sh\necho \'{"run_id":"run-abc","type":"terminal"}\'\n');
    chmodSync(script, 0o755);
    const trial = { id: 't', arm: 'base', family: 'A', board: 'ENV', split: 'development', case: 'ENV', replicate: 1, seed: 1, argv: [script], steps: [], env: {}, input: { path: 'e', sha256: sha('e') } };
    const context = { root, runsDir: runs, timeoutMs: 10_000 };
    const sealed = await spawnExecutor(trial, context);
    assert.equal(sealed.status, 'sealed');
    assert.equal(sealed.run_path, 'runs/run-abc');
    assert.equal(sealed.result_sha256, sha('{"status":"passed"}'));
    const nothing = await spawnExecutor({ ...trial, argv: ['/bin/sh', '-c', 'echo boom >&2; exit 3'] }, context);
    assert.equal(nothing.status, 'no_run');
    assert.equal(nothing.exit_code, 3);
    assert.match(nothing.cause ?? '', /boom/);
    const missing = await spawnExecutor({ ...trial, argv: ['/no/such/binary'] }, context);
    assert.equal(missing.status, 'no_run');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a trial that timed out is a timeout even when its run sealed as passed, and says so', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-timeout-'));
  try {
    const runs = join(root, 'runs');
    mkdirSync(join(runs, 'run-late'), { recursive: true });
    writeFileSync(join(runs, 'run-late/result.json'), '{"status":"passed"}');
    const trial = { id: 't', arm: 'base', family: 'A', board: 'ENV', split: 'development', case: 'ENV', replicate: 1, seed: 1,
      argv: ['/bin/sh', '-c', 'echo \'{"run_id":"run-late"}\'; exec sleep 30'], steps: [], env: {}, input: { path: 'e', sha256: sha('e') } };
    const record = await spawnExecutor(trial, { root, runsDir: runs, timeoutMs: 300 });
    assert.equal(record.status, 'timeout');
    assert.equal(record.run_status, null);            // one verdict: the trial timed out
    assert.match(record.cause ?? '', /deadline reached.*sealed as passed/);
    assert.equal(record.run_id, 'run-late');          // the sealed run stays named as evidence
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a trial starts in an empty work folder, never in a killed attempt\'s', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-work-'));
  try {
    const runs = join(root, 'runs'), work = join(root, 'work');
    mkdirSync(join(runs, 'run-w'), { recursive: true });
    writeFileSync(join(runs, 'run-w/result.json'), '{"status":"passed"}');
    mkdirSync(join(work, 't'), { recursive: true });
    writeFileSync(join(work, 't/stale.kicad_pcb'), 'old attempt');
    const trial = { id: 't', arm: 'base', family: 'A', board: 'ENV', split: 'development', case: 'ENV', replicate: 1, seed: 1, argv: ['x'],
      steps: [['/bin/sh', '-c', 'test -z "$(ls -A "$1")"', 'sh', '{work}'], ['/bin/sh', '-c', 'echo \'{"run_id":"run-w"}\'']], env: {}, input: { path: 'e', sha256: sha('e') } };
    const record = await spawnExecutor(trial, { root, runsDir: runs, timeoutMs: 10_000, work });
    assert.equal(record.status, 'sealed', record.cause ?? '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a signal stops the running child and returns at once, so the lock can be released', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-signal-'));
  try {
    const trial = { id: 'sig', arm: 'base', family: 'A', board: 'ENV', split: 'development', case: 'ENV', replicate: 1, seed: 1,
      argv: ['/bin/sleep', '30'], steps: [], env: {}, input: { path: 'e', sha256: sha('e') } };
    const abort = new AbortController();
    const started = Date.now();
    const running = spawnExecutor(trial, { root, runsDir: join(root, 'runs'), timeoutMs: 60_000, signal: abort.signal });
    setTimeout(() => abort.abort(), 100);
    const record = await running;
    assert.equal(record.cause, 'interrupted');
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started}ms`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('route_input: a placer arm records the placed board it routed as the trial placement input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-ri-'));
  try {
    const runs = join(root, 'runs');
    mkdirSync(join(runs, 'run-ri'), { recursive: true });
    writeFileSync(join(runs, 'run-ri/result.json'), '{"status":"passed"}');
    const value = validateSuite({
      schema: SUITE, suite_id: 'ri', budget: { timeout_s: 10, cpus: 1, memory_gb: 1 }, seeds: [1, 2],
      arms: ['a', 'b'].map(id => ({ id, route_input: '{work}/proj/{input}', steps: [
        ['/bin/sh', '-c', 'mkdir -p "$1/proj/x" && printf placed-{seed} > "$1/proj/x/b.kicad_pcb"', 'sh', '{work}'],
        ['/bin/sh', '-c', 'echo \'{"run_id":"run-ri"}\''],
      ] })),
      boards: [{ family: 'A', board: 'B1', split: 'development', input: { path: 'x/b.kicad_pcb', sha256: sha('orig') } },
               { family: 'B', board: 'B2', split: 'holdout', input: { path: 'x/b.kicad_pcb', sha256: sha('orig') } }],
    });
    assert.throws(() => validateSuite({ ...value, arms: [{ id: 'a', argv: ['x'], route_input: 'y' }, value.arms[1]] }), /route_input needs steps/);
    const records = await runSuite(value, { root, runsDir: runs, out: join(root, 'out'), executor: spawnExecutor });
    assert.equal(records[0]!.status, 'sealed');
    assert.equal(records[0]!.placement_input!.sha256, sha('placed-1'));
    assert.match(records[0]!.placement_input!.path, /out\/work\/B1\.r1\.a\/proj\/x\/b\.kicad_pcb$/);
    const study = buildStudy(value, records) as { trials: { placement_input: { sha256: string } }[] };
    assert.equal(study.trials[2]!.placement_input.sha256, sha('placed-2'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
