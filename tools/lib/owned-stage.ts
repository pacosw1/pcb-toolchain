// Owned stages from TypeScript. Everything Node cannot do lives in `iotroute owned run`: this client starts it, reads
// its result file and turns cancel into SIGTERM and interrupt into SIGUSR1. Inside an owned stage the same command is a
// client of the broker that owns the stage, so nesting needs nothing here but the lineage variables.
import { type ChildProcess, type StdioOptions, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { iotrouteBin } from './iotroute-bin.ts';

const SOCKET_ENV = 'IOT_LEAN_BROKER_SOCKET';
const HANDLE_ENV = 'IOT_LEAN_STAGE_HANDLE';
const DEPTH_ENV = 'IOT_LEAN_STAGE_DEPTH';
const LINEAGE = [SOCKET_ENV, HANDLE_ENV, DEPTH_ENV];
const NEVER_SPAWNED = 'unavailable; cancelled before leader spawn';
const NO_LEADER = 'unavailable; no owned leader reaped';
/** The broker blocks these first thing, so one that killed it came before it could start any stage. */
const EARLY_STOP_SIGNALS: readonly string[] = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGUSR1'];

export interface CleanupError {
  operation: string;
  error: string;
  signal?: number;
}

/** The field names of lean_owned: this object goes into stage evidence as it is. */
export interface Cleanup {
  complete: boolean;
  errors: CleanupError[];
  child_reaped: boolean;
  family_cleanup?: string;
  owned_group_gone?: boolean;
  leader_spawned?: boolean;
}

export interface OwnedResult {
  /** The exit code, or minus the signal number. 125 means cancelled before the command ran. */
  returncode: number;
  childCpuS: number | null;
  adoptedChildCpuS: number | null;
  cpuScope: string;
  /** Read `complete`: lean_workflow.run_stage rejects a stage whose cleanup is not confirmed, even at returncode 0. */
  cleanup: Cleanup;
}

/** The stage did not produce a result. `kind` is the lean_owned name: FileNotFoundError, TimeoutExpired, ... */
export class OwnedStageError extends Error {
  readonly kind: string;
  readonly cleanup: Cleanup;
  readonly childCpuS: number | null;
  constructor(kind: string, message: string, cleanup: Cleanup, childCpuS: number | null = null) {
    super(message);
    this.kind = kind;
    this.cleanup = cleanup;
    this.childCpuS = childCpuS;
  }
}

type Stdio = 'inherit' | 'ignore' | 'pipe' | number;

export interface OwnedOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: Stdio;
  stdout?: Stdio;
  stderr?: Stdio;
}

export interface OwnedStage {
  /** Resolves when the stage settled, cleanup included. Rejects with OwnedStageError when it has no result. */
  readonly settled: Promise<OwnedResult>;
  readonly done: boolean;
  /** Set for streams started as 'pipe'. */
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  /** TERM, then KILL after the grace, for the stage and its registered subtree. Safe to repeat, or after settling. */
  cancel(): Promise<Cleanup>;
  /**
   * One graceful TERM of the stage's registered group, with no cancel and no KILL: a command that writes its best result
   * ends by itself. True when the broker took the request, false once the stage has settled. Repeating it sends no second
   * TERM. The broker has nothing to signal before the stage has a process, so an interrupt that early does not stop it.
   */
  interrupt(): Promise<boolean>;
}

/** The content of the result file, as `iotroute owned run` writes it. */
interface ResultFile {
  returncode: number | null;
  child_cpu_s: number | null;
  adopted_child_cpu_s: number | null;
  cpu_scope: string;
  cleanup: Cleanup;
  error: { type: string; message: string } | null;
}

/** lean_owned.prepare: a child cannot reset lineage. A value equal to this process's own is no reset. */
function checkLineage(env: NodeJS.ProcessEnv): void {
  for (const key of LINEAGE) {
    const own = process.env[key] ?? (key === DEPTH_ENV ? '0' : undefined);
    if (key in env && env[key] !== own) throw new Error('child cannot reset owned-stage lineage metadata');
  }
}

/** Lineage belongs to this process, whatever the caller's env says: the stage's own is set by the broker. */
function brokerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged = { ...env };
  for (const key of LINEAGE) {
    if (process.env[key] === undefined) delete merged[key];
    else merged[key] = process.env[key];
  }
  return merged;
}

const unconfirmed = (error: string): Cleanup =>
  ({ complete: false, errors: [{ operation: 'broker', error }], child_reaped: false, family_cleanup: 'unconfirmed' });

const nothingStarted = (): Cleanup => ({ complete: true, errors: [], child_reaped: true });

function toOutcome(report: ResultFile): OwnedResult {
  if (report.error) {
    throw new OwnedStageError(report.error.type, report.error.message, report.cleanup, report.child_cpu_s);
  }
  if (report.returncode === null) {
    throw new OwnedStageError('RuntimeError', 'owned stage ended with no return code', report.cleanup, report.child_cpu_s);
  }
  return { returncode: report.returncode, childCpuS: report.child_cpu_s, adoptedChildCpuS: report.adopted_child_cpu_s,
           cpuScope: report.cpu_scope, cleanup: report.cleanup };
}

function readReport(path: string): ResultFile | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ResultFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** With no result file the broker died. Only a stop signal proves that no stage had started. */
function withoutReport(code: number | null, signal: NodeJS.Signals | null): OwnedResult {
  if (signal !== null && EARLY_STOP_SIGNALS.includes(signal)) {
    return { returncode: 125, childCpuS: null, adoptedChildCpuS: null, cpuScope: NEVER_SPAWNED,
             cleanup: { ...nothingStarted(), leader_spawned: false } };
  }
  const message = `owned broker ended with no result (exit ${code}, signal ${signal})`;
  throw new OwnedStageError('RuntimeError', message, unconfirmed(message));
}

function settle(broker: ChildProcess, resultFile: string): Promise<OwnedResult> {
  return new Promise((resolve, reject) => {
    // 'exit', not 'close': a stray holder of a piped stream must not delay settling.
    broker.once('exit', (code, signal) => {
      try {
        const report = readReport(resultFile);
        resolve(report ? toOutcome(report) : withoutReport(code, signal));
      } catch (error) {
        reject(error);
      }
    });
    broker.once('error', error => {
      const kind = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'FileNotFoundError' : 'OSError';
      reject(new OwnedStageError(kind, `owned broker did not start: ${error.message}`, nothingStarted()));
    });
  });
}

/**
 * Starts `command` as an owned stage in its own session. stdio defaults to this process's own. `cwd` must exist.
 * The broker stays in this process's group: a broker above checks that, so never add `detached` here.
 */
export function startOwned(command: string[], options: OwnedOptions = {}): OwnedStage {
  if (command.length === 0) throw new RangeError('owned stage needs a command');
  const env = options.env ?? process.env;
  checkLineage(env);
  const folder = mkdtempSync(join(tmpdir(), 'owned-stage-'));
  const resultFile = join(folder, 'result.json');
  const stdio: StdioOptions = [options.stdin ?? 'inherit', options.stdout ?? 'inherit', options.stderr ?? 'inherit'];
  const broker = spawn(iotrouteBin(), ['owned', 'run', '--result', resultFile, '--', ...command], { cwd: options.cwd, env: brokerEnv(env), stdio });
  let done = false;
  const settled = settle(broker, resultFile).finally(() => {
    done = true;
    rmSync(folder, { recursive: true, force: true });
  });
  settled.catch(() => {}); // a caller that only uses cancel() must not die of an unhandled rejection
  return {
    settled,
    get done() { return done; },
    stdin: broker.stdin,
    stdout: broker.stdout,
    stderr: broker.stderr,
    cancel: async () => {
      if (!done) broker.kill('SIGTERM');
      try {
        return (await settled).cleanup;
      } catch (error) {
        if (error instanceof OwnedStageError) return error.cleanup;
        throw error;
      }
    },
    interrupt: async () => !done && broker.kill('SIGUSR1'),
  };
}
