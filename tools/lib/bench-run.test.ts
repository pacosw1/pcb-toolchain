import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildStudy, runSuite, spawnExecutor, TRIAL_RECORD, type Executor, type TrialRecord } from './bench-run.ts';
import { SUITE, validateSuite } from './bench-suite.ts';

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
