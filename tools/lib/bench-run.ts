// Run a benchmark suite trial by trial through the ordinary pcb run path and describe the sealed runs as a study.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { atomicJson, sha256File } from './json-file.ts';
import { expandTrials, type PlannedTrial, type Suite } from './bench-suite.ts';

export const TRIAL_RECORD = 'iot-lab.bench-trial.v1';
export const STUDY_SCHEMA = 'iot-lab.placement-outcome-study.v1';

export type TrialStatus = 'sealed' | 'timeout' | 'no_run';
export interface TrialRecord {
  schema: typeof TRIAL_RECORD; id: string; arm: string; status: TrialStatus; run_id: string | null; run_path: string | null;
  result_sha256: string | null; wall_s: number; exit_code: number | null; cause: string | null; command: string[];
}
export interface ExecContext { root: string; runsDir: string; timeoutMs: number }
export type Executor = (trial: PlannedTrial, context: ExecContext) => Promise<TrialRecord>;

const GRACE_MS = 60_000;

function record(trial: PlannedTrial, fields: Partial<TrialRecord>): TrialRecord {
  return { schema: TRIAL_RECORD, id: trial.id, arm: trial.arm, status: 'no_run', run_id: null, run_path: null, result_sha256: null,
    wall_s: 0, exit_code: null, cause: null, command: trial.argv, ...fields };
}

function runIdOf(text: string): string | null {
  for (const line of text.split('\n')) {
    try {
      const value = JSON.parse(line) as { run_id?: unknown };
      if (typeof value.run_id === 'string') return value.run_id;
    } catch { /* not a JSON line */ }
  }
  return null;
}

/** Spawn the trial's argv in the project, follow it to its terminal event, and locate the sealed run. SIGINT asks for owned cleanup first. */
export const spawnExecutor: Executor = (trial, context) => new Promise(done => {
  const started = performance.now();
  const [command, ...args] = trial.argv;
  const child = spawn(command!, args, { cwd: context.root, env: { ...process.env, ...trial.env, PCB_RUNS_DIR: context.runsDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGINT');
    setTimeout(() => child.kill('SIGKILL'), GRACE_MS).unref();
  }, context.timeoutMs);
  const finish = (code: number | null, cause: string | null): void => {
    clearTimeout(timer);
    const wall_s = (performance.now() - started) / 1000;
    const runId = runIdOf(stdout);
    const folder = runId ? join(context.runsDir, runId) : null;
    const result = folder ? join(folder, 'result.json') : null;
    if (folder && result && existsSync(result)) {
      done(record(trial, { status: timedOut ? 'timeout' : 'sealed', run_id: runId, run_path: relative(context.root, folder), result_sha256: sha256File(result), wall_s, exit_code: code, cause }));
    } else {
      done(record(trial, { status: timedOut ? 'timeout' : 'no_run', run_id: runId, wall_s, exit_code: code, cause: cause ?? (stderr.trim() || 'no sealed result') }));
    }
  };
  child.on('error', error => finish(null, error.message));
  child.on('close', code => finish(code, timedOut ? 'deadline reached' : null));
});

export const recordPath = (out: string, id: string): string => join(out, 'trials', `${id}.json`);

export function readRecord(out: string, id: string): TrialRecord | null {
  const path = recordPath(out, id);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as TrialRecord : null;
}

export interface RunOptions { root: string; runsDir: string; out: string; executor: Executor; onTrial?: (trial: PlannedTrial, record: TrialRecord, index: number, total: number) => void }

/** Sequential on purpose: trials share the machine, and a finished trial's record is kept so a rerun resumes. */
export async function runSuite(suite: Suite, options: RunOptions): Promise<TrialRecord[]> {
  mkdirSync(join(options.out, 'trials'), { recursive: true });
  const trials = expandTrials(suite);
  const records: TrialRecord[] = [];
  const context: ExecContext = { root: options.root, runsDir: options.runsDir, timeoutMs: Math.round(suite.budget.timeout_s * 1000) };
  for (const [index, trial] of trials.entries()) {
    const kept = readRecord(options.out, trial.id);
    const current = kept ?? await options.executor(trial, context);
    if (!kept) atomicJson(recordPath(options.out, trial.id), current);
    records.push(current);
    options.onTrial?.(trial, current, index, trials.length);
  }
  return records;
}

/** The study placement_outcomes evaluates. Only trials with a sealed run can enter; the others stay failures in the analysis. */
export function buildStudy(suite: Suite, records: TrialRecord[]): Record<string, unknown> {
  const byId = new Map(records.map(item => [item.id, item]));
  const trials = expandTrials(suite).flatMap(trial => {
    const item = byId.get(trial.id);
    if (!item || item.status !== 'sealed' || !item.run_path || !item.result_sha256) return [];
    return [{
      id: trial.id, kind: 'cli_run', path: item.run_path, sha256: item.result_sha256, arm: trial.arm, split: trial.split, family: trial.family,
      case: trial.case, replicate: trial.replicate, placement_input: trial.input, execution_policy: 'operation/execution-policy.json',
    }];
  });
  const families = (split: string) => [...new Set(suite.boards.filter(board => board.split === split).map(board => board.family))];
  return { schema: STUDY_SCHEMA, study_id: suite.suite_id, arms: suite.arms.map(arm => arm.id), development_families: families('development'),
    holdout_families: families('holdout'), trials };
}

export const absolute = (root: string, path: string): string => resolve(root, path);
