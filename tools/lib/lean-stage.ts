// lean_workflow.run_stage: bound an entire child process group; timeout output is never a pass. Ownership lives in
// `iotroute owned run`, which refuses an expired deadline at admission but does not watch it afterwards, so this module
// watches it and cancels. The broker's TERM allows five seconds for checkpoints, then KILL gets two. Logs and checkpoints
// are kept, but no timeout or uncertain cleanup is accepted.
import { appendFileSync } from 'node:fs';
import { constants } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { now } from './lean-clock.ts';
import { StageCancelled } from './lean-resources.ts';
import { decodeDeadline, encodeDeadline, inheritedDeadline, remaining, stageDepth } from './lean-workflow.ts';
import { type Cleanup, OwnedStageError, type OwnedOptions, type OwnedResult, type OwnedStage, startOwned } from './owned-stage.ts';
import { Float, jsonDumps, PyError, pyStr } from './py-compat.mjs';
import { round } from './py-numbers.ts';
import { append } from './run-record.ts';

const WATCH_MS = 200;   // polled, not one long timer: macOS timers stop during sleep, the deadline clock does not
const DRAIN_MS = 7000;  // the whole cleanup budget of lean_owned: TERM five seconds, KILL two

/** subprocess.TimeoutExpired. `cleanup` says whether the owned group is confirmed gone. */
export class TimeoutExpired extends PyError {
  readonly cleanup: Cleanup | null;
  constructor(command: string[], cleanup: Cleanup | null = null) {
    super('subprocess.TimeoutExpired', `Command '${command.join(' ')}' timed out`);
    this.cleanup = cleanup;
  }
}

export interface StageOptions extends OwnedOptions {
  stage: string;
  /** Appends one line to this file, and one record to run.jsonl beside it. */
  eventFile?: string | null;
  deadline?: number | string | null;
  /** The running stage, for a caller that needs a graceful stop. */
  onStart?: (stage: OwnedStage) => void;
}
export interface StageResult { returncode: number; stdout: string | null; stderr: string | null }
interface Cause { type: string; signal: number | null }
interface Outcome { status: string; rc: number | null; cause: Cause | null; cleanup: Cleanup | null; result: OwnedResult | null }

/** The earliest of the given, the child's and this process's deadlines: a child can never extend its budget. */
function childDeadline(env: NodeJS.ProcessEnv, deadline: StageOptions['deadline']): number | null {
  const given = typeof deadline === 'string' ? decodeDeadline(deadline) : deadline ?? null;
  const bounds = [inheritedDeadline(env), inheritedDeadline(), given].filter(bound => bound !== null);
  return bounds.length ? Math.min(...bounds) : null;
}

interface Capture { text(): string | null; ended: Promise<void> }

function collect(stream: Readable | null): Capture {
  if (!stream) return { text: () => null, ended: Promise.resolve() };
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise<void>(done => { stream.once('close', () => done()); });
  return { text: () => Buffer.concat(chunks).toString('utf8').replace(/\r\n?/g, '\n'), ended };
}

/**
 * The stage settles when the broker exits, which can be before its pipes are read to the end. Output cut short must not
 * pass as complete: as in lean_owned, streams still open after the budget make the cleanup unconfirmed.
 */
async function drained(captures: Capture[], cleanup: Cleanup): Promise<Cleanup> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>(done => { timer = setTimeout(() => done(false), DRAIN_MS); });
  const finished = await Promise.race([Promise.all(captures.map(capture => capture.ended)).then(() => true), late]);
  clearTimeout(timer);
  return finished ? cleanup : { ...cleanup, complete: false, errors: [...cleanup.errors, { operation: 'pipes', error: 'owned captured streams remain open' }] };
}

/** Rejects when the deadline passes or a signal arrives; a repeated signal cannot interrupt bounded cleanup. */
function watch(deadline: number | null): { stopped: Promise<never>; end(): void } {
  const listeners: [NodeJS.Signals, () => void][] = [];
  let timer: NodeJS.Timeout | undefined;
  const stopped = new Promise<never>((_, reject) => {
    for (const name of ['SIGTERM', 'SIGINT'] as const) {
      const listener = () => reject(new StageCancelled(name));
      process.on(name, listener);
      listeners.push([name, listener]);
    }
    if (deadline !== null) timer = setInterval(() => { if (remaining(deadline) === 0) reject(new TimeoutExpired([])); }, WATCH_MS);
  });
  stopped.catch(() => undefined);
  return { stopped, end: () => { clearInterval(timer); listeners.forEach(([name, listener]) => process.off(name, listener)); } };
}

const causeOf = (error: unknown): Cause => (error instanceof StageCancelled
  ? { type: 'StageCancelled', signal: constants.signals[error.signal] }
  : { type: error instanceof TimeoutExpired ? 'TimeoutExpired' : (error as OwnedStageError).kind ?? (error as Error).name, signal: null });

function recordEvent(file: string, stage: string, command: string[], outcome: Outcome, started: number): void {
  const { status, rc, cause, cleanup, result } = outcome;
  const wall = now() - started;
  const float = (value: number | null | undefined) => (typeof value === 'number' ? new Float(value) : null);
  appendFileSync(file, `${jsonDumps({
    stage, command, status, returncode: rc, wall_s: new Float(wall), cause, cleanup, child_cpu_s: float(result?.childCpuS),
    adopted_child_cpu_s: float(result?.adoptedChildCpuS), cpu_scope: result?.cpuScope ?? 'unavailable; no owned leader reaped',
  })}\n`);
  try {   // the same stage end as one action next to stages.jsonl; it never blocks the stage
    append(dirname(resolve(file)), stage, `stage ${status}`, {
      inputs: { command }, evidence: basename(file), result: { returncode: rc, wall_s: new Float(round(wall, 3)), cause },
      why: status === 'complete' ? 'owned subprocess stage of the job' : `stage ${status}: ${pyStr(cause && new Map(Object.entries(cause)))}`,
    });
  } catch {
    // the stage line above is the evidence
  }
}

function admissionEnv(options: StageOptions, deadline: number | null, command: string[]): NodeJS.ProcessEnv {
  const childEnv = options.env ?? process.env;
  const depth = stageDepth(process.env);
  if ('IOT_LEAN_STAGE_DEPTH' in childEnv && stageDepth(childEnv) !== depth) throw new PyError('ValueError', 'child environment cannot reset owned stage depth');
  if (deadline !== null && remaining(deadline) === 0) throw new TimeoutExpired(command);
  return deadline === null ? childEnv : { ...childEnv, IOT_LEAN_DEADLINE: encodeDeadline(deadline) };
}

async function cancelled(stage: OwnedStage, error: Error): Promise<Cleanup> {
  const cleanup = await stage.cancel();
  await stage.settled.catch(() => undefined);
  Object.assign(error, { cleanup });
  return cleanup;
}

/** Runs `command` as an owned stage. Rejects on timeout, cancellation, a failed start or unconfirmed cleanup. */
export async function runStage(command: string[], options: StageOptions): Promise<StageResult> {
  const { stage: name, eventFile, onStart } = options;
  const started = now();
  const deadline = childDeadline(options.env ?? process.env, options.deadline);
  const outcome: Outcome = { status: 'failed', rc: null, cause: null, cleanup: null, result: null };
  const watcher = watch(deadline);
  try {
    const env = admissionEnv(options, deadline, command);
    const stage = startOwned(command, { cwd: options.cwd, env, stdin: options.stdin, stdout: options.stdout, stderr: options.stderr });
    const captures = [collect(stage.stdout), collect(stage.stderr)];
    onStart?.(stage);
    try {
      outcome.result = await Promise.race([stage.settled, watcher.stopped]);
    } catch (error) {
      if (error instanceof StageCancelled || error instanceof TimeoutExpired) outcome.cleanup = await cancelled(stage, error);
      throw error;
    }
    outcome.rc = outcome.result.returncode;
    outcome.cleanup = await drained(captures, outcome.result.cleanup);
    if (!outcome.cleanup.complete) throw new PyError('RuntimeError', 'owned-stage cleanup could not be confirmed');
    outcome.status = outcome.rc === 0 ? 'complete' : 'failed';
    return { returncode: outcome.rc, stdout: captures[0]!.text(), stderr: captures[1]!.text() };
  } catch (error) {
    if (error instanceof StageCancelled) outcome.status = 'cancelled';
    else if (error instanceof TimeoutExpired) outcome.status = 'timeout';
    outcome.cause = causeOf(error);
    if (error instanceof OwnedStageError) outcome.cleanup = error.cleanup;
    throw error;
  } finally {
    watcher.end();
    if (eventFile) recordEvent(eventFile, name, command, outcome, started);
  }
}
