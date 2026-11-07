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
  parent_run?: { path: string; sha256: string }; placement_input?: { path: string; sha256: string } | null;
  /** The sealed run's own terminal status (passed, failed, timeout, cancelled), read from its result.json. */
  run_status?: string | null;
}
export interface ExecContext { root: string; runsDir: string; timeoutMs: number; work?: string; signal?: AbortSignal }
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

interface StepOutcome { code: number | null; stdout: string; stderr: string; timedOut: boolean; interrupted: boolean; error: string | null }

function runStep(argv: string[], env: Record<string, string>, context: ExecContext, timeoutMs: number): Promise<StepOutcome> {
  if (context.signal?.aborted) return Promise.resolve({ code: null, stdout: '', stderr: '', timedOut: false, interrupted: true, error: 'interrupted' });
  return new Promise(done => {
    const [command, ...args] = argv;
    const child = spawn(command!, args, { cwd: context.root, env: { ...process.env, ...env, PCB_RUNS_DIR: context.runsDir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, interrupted = false, settled = false, killTimer: NodeJS.Timeout | undefined;
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
    // A deadline or a signal stops the same child: SIGINT first, then SIGKILL after the grace, so releasing
    // the lock never leaves the trial running behind the next bench.
    const terminate = (): void => {
      child.kill('SIGINT');
      if (!killTimer) { killTimer = setTimeout(() => child.kill('SIGKILL'), GRACE_MS); killTimer.unref(); }
    };
    const onAbort = (): void => { interrupted = true; terminate(); };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, Math.max(1, timeoutMs));
    const finish = (code: number | null, error: string | null): void => {
      if (settled) return; settled = true;
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      context.signal?.removeEventListener('abort', onAbort);
      done({ code, stdout, stderr, timedOut, interrupted, error });
    };
    context.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', error => finish(null, error.message));
    child.on('close', code => finish(code, interrupted ? 'interrupted' : null));
  });
}

const fill = (part: string, values: Record<string, string>): string => part.replace(/\{(work|prev_run|prev_run_path)\}/g, (whole, name: string) => values[name] ?? whole);

interface Sealed { id: string; folder: string; path: string; sha: string; status?: string | null }

function sealedOf(stdout: string, context: ExecContext): Sealed | null {
  const id = runIdOf(stdout);
  if (!id) return null;
  const folder = join(context.runsDir, id), result = join(folder, 'result.json');
  if (!existsSync(result)) return null;
  let status: string | null = null;
  try { status = (JSON.parse(readFileSync(result, 'utf8')) as { status?: string }).status ?? null; } catch { /* unreadable: stays null */ }
  return { id, folder, path: relative(context.root, folder), sha: sha256File(result), status };
}

/** The candidate a sealed run produced, as the file inside its workspace (not the daemon's path, which may be stale). */
function candidateOf(parent: Sealed, context: ExecContext): { path: string; sha256: string } | null {
  try {
    const operation = JSON.parse(readFileSync(join(parent.folder, 'operation/result.json'), 'utf8')) as { candidate?: string; workspace?: string };
    if (!operation.candidate || !operation.workspace) return null;
    const file = join(parent.folder, 'workspace', relative(operation.workspace, operation.candidate));
    return existsSync(file) ? { path: relative(context.root, file), sha256: sha256File(file) } : null;
  } catch { return null; }
}

/** Run the trial's steps in order in the project; only the last must seal a run. A step may read the previous sealed run through {prev_run}.
 *  The whole trial shares one deadline. SIGINT asks for owned cleanup first. The final run's parent is the last earlier step that sealed a run. */
export const spawnExecutor: Executor = async (trial, context) => {
  const started = performance.now();
  const deadline = started + context.timeoutMs;
  const work = context.work ? join(context.work, trial.id) : join(context.runsDir, '..', 'bench-work', trial.id);
  mkdirSync(work, { recursive: true });
  const steps = trial.steps?.length ? trial.steps : [trial.argv];
  let previous: Sealed | null = null, parent: Sealed | null = null, last: StepOutcome | null = null, sealed: Sealed | null = null;
  for (const [index, step] of steps.entries()) {
    const values: Record<string, string> = { work, ...(previous ? { prev_run: previous.id, prev_run_path: previous.folder } : {}) };
    const argv = step.map(part => fill(part, values));
    const unfilled = argv.find(part => /\{(prev_run|prev_run_path)\}/.test(part));
    const wall_s = (): number => (performance.now() - started) / 1000;
    if (context.signal?.aborted) return record(trial, { wall_s: wall_s(), cause: 'interrupted', command: trial.argv });
    if (unfilled) return record(trial, { wall_s: wall_s(), cause: `step ${index + 1} needs a previous sealed run that step ${index} did not produce`, command: trial.argv });
    last = await runStep(argv, trial.env, context, deadline - performance.now());
    if (last.interrupted) return record(trial, { status: 'no_run', wall_s: wall_s(), exit_code: last.code, cause: 'interrupted', command: trial.argv });
    sealed = sealedOf(last.stdout, context);
    if (index < steps.length - 1 && (last.timedOut || last.error)) {
      return record(trial, { status: last.timedOut ? 'timeout' : 'no_run', wall_s: wall_s(), exit_code: last.code, cause: `step ${index + 1} ${last.error ?? 'reached the deadline'}` });
    }
    if (index === steps.length - 1) break;
    if (sealed) { parent = sealed; previous = sealed; }
    if (!sealed && last.code !== 0) return record(trial, { wall_s: wall_s(), exit_code: last.code, cause: `step ${index + 1} failed: ${last.stderr.trim() || 'no output'}`, command: trial.argv });
  }
  const wall_s = (performance.now() - started) / 1000;
  const outcome = last!;
  const cause = outcome.error ?? (outcome.timedOut ? 'deadline reached' : null);
  if (!sealed) return record(trial, { status: outcome.timedOut ? 'timeout' : 'no_run', run_id: runIdOf(outcome.stdout), wall_s, exit_code: outcome.code, cause: cause ?? (outcome.stderr.trim() || 'no sealed result') });
  let chain: Partial<TrialRecord> = parent ? { parent_run: { path: parent.path, sha256: parent.sha }, placement_input: candidateOf(parent, context) } : {};
  if (trial.route_input) {
    const file = resolve(context.root, fill(trial.route_input, { work }));
    chain = { ...chain, placement_input: existsSync(file) ? { path: relative(context.root, file), sha256: sha256File(file) } : null };
  }
  return record(trial, { status: outcome.timedOut ? 'timeout' : 'sealed', run_id: sealed.id, run_path: sealed.path, result_sha256: sealed.sha, run_status: sealed.status ?? null, wall_s, exit_code: outcome.code, cause, ...chain });
};

export const recordPath = (out: string, id: string): string => join(out, 'trials', `${id}.json`);

export function readRecord(out: string, id: string): TrialRecord | null {
  const path = recordPath(out, id);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as TrialRecord : null;
}

export interface RunOptions { root: string; runsDir: string; out: string; executor: Executor; signal?: AbortSignal; onTrial?: (trial: PlannedTrial, record: TrialRecord, index: number, total: number) => void }

/** Sequential on purpose: trials share the machine, and a finished trial's record is kept so a rerun resumes. */
export async function runSuite(suite: Suite, options: RunOptions): Promise<TrialRecord[]> {
  mkdirSync(join(options.out, 'trials'), { recursive: true });
  const trials = expandTrials(suite);
  const records: TrialRecord[] = [];
  const context: ExecContext = { root: options.root, runsDir: options.runsDir, timeoutMs: Math.round(suite.budget.timeout_s * 1000), work: join(options.out, 'work'), signal: options.signal };
  for (const [index, trial] of trials.entries()) {
    if (options.signal?.aborted) break;
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
      case: trial.case, replicate: trial.replicate, placement_input: item.parent_run || trial.route_input ? item.placement_input ?? null : trial.input,
      ...(item.parent_run ? { parent_run: item.parent_run } : {}), execution_policy: 'operation/execution-policy.json',
    }];
  });
  const families = (split: string) => [...new Set(suite.boards.filter(board => board.split === split).map(board => board.family))];
  return { schema: STUDY_SCHEMA, study_id: suite.suite_id, arms: suite.arms.map(arm => arm.id), development_families: families('development'),
    holdout_families: families('holdout'), trials };
}

export const absolute = (root: string, path: string): string => resolve(root, path);
