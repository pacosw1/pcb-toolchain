// `pcb trial run`: start the agent of a prepared trial in its scratch project with one deadline, save its output, hold the benchmark lock.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fillArgv, readCase } from './agent-trial-case.ts';
import { acquire } from './bench-lock.ts';
import { atomicJson, readObject } from './json-file.ts';

export const RUN_SCHEMA = 'iot-lab.agent-trial-run.v1';
export const PENDING_SCHEMA = 'iot-lab.agent-trial-pending.v1';
const GRACE_MS = 60_000;

export interface RunRecord {
  schema: typeof RUN_SCHEMA; case_id: string; board: string; argv: string[]; started_at: string; ended_at: string; wall_s: number;
  exit_code: number | null; signal: string | null; timed_out: boolean; spawn_error: string | null;
  /** Set only when the runner died before it wrote this record. Older records have no such field. */
  aborted?: string;
}
/** `run.pending.json`: written before the agent starts. The trial is "running" while it exists without run.json. */
interface Pending { schema: typeof PENDING_SCHEMA; case_id: string; board: string; argv: string[]; started_at: string; runner_pid: number; agent_pid: number | null }
/** The process calls of the recovery. Injected so a test needs no real process. */
export interface Processes { alive(pid: number): boolean; kill(pid: number): void; clock(): number }
export interface RunOptions {
  /** Takes the benchmark lock and returns the release. Default: bench-lock.ts, failing at once when another benchmark holds it. */
  lock?: (label: string) => Promise<() => void>;
  /** Epoch milliseconds. Injected so a test fixes the wall time. */
  clock?: () => number;
  graceMs?: number;
  processes?: Processes;
}

export const osProcesses: Processes = {
  alive: pid => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } },
  kill: pid => { try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } },
  clock: Date.now,
};

/**
 * A trial with run.pending.json and no run.json whose runner pid is gone lost its runner. Kill the agent it left, then write the
 * run.json that says so, so that collect gives a failed verdict. Returns that record, or null when there is nothing to settle.
 */
export function settleCrashedTrial(dir: string, processes: Processes = osProcesses): RunRecord | null {
  const pendingPath = join(dir, 'run.pending.json');
  if (existsSync(join(dir, 'run.json')) || !existsSync(pendingPath)) return null;
  const pending = readObject<Pending>(pendingPath);
  if (pending.schema !== PENDING_SCHEMA || !Number.isInteger(pending.runner_pid)) throw new Error(`${pendingPath} is not a ${PENDING_SCHEMA} record`);
  if (processes.alive(pending.runner_pid)) return null;
  if (pending.agent_pid !== null && processes.alive(pending.agent_pid)) processes.kill(pending.agent_pid);
  const ended = processes.clock();
  const record: RunRecord = {
    schema: RUN_SCHEMA, case_id: pending.case_id, board: pending.board, argv: pending.argv, started_at: pending.started_at, ended_at: new Date(ended).toISOString(),
    wall_s: (ended - Date.parse(pending.started_at)) / 1000, exit_code: null, signal: null, timed_out: false, spawn_error: null,
    aborted: `the runner ended (pid ${pending.runner_pid}) before it wrote run.json; the agent output is incomplete`,
  };
  atomicJson(join(dir, 'run.json'), record);
  return record;
}

const platformBinary = (): string => `iotroute-${process.platform}-${process.arch === 'x64' ? 'x86_64' : process.arch}`;

export async function runTrial(dirPath: string, options: RunOptions = {}): Promise<RunRecord> {
  const dir = resolve(dirPath), project = join(dir, 'project'), clock = options.clock ?? Date.now;
  if (!existsSync(join(dir, 'prepare.json')) || !existsSync(join(dir, 'case.json'))) throw new Error(`${dir} is not prepared; run: tools/pcb trial prepare CASE --lab DIR --out ${dir}`);
  const agentCase = readCase(join(dir, 'case.json')).case;
  const used = (): boolean => existsSync(join(dir, 'run.json')) || existsSync(join(dir, 'agent.stdout.jsonl'));
  const refuse = (): void => { settleCrashedTrial(dir, options.processes); if (used()) throw new Error(`${dir} already ran; a trial runs once. Prepare a new --out`); };
  refuse();
  const release = await (options.lock ?? (async label => acquire({ label })))(`trial ${agentCase.case_id} -> ${dir}`);
  try {
    refuse();
    const argv = fillArgv(agentCase, { prompt_file: join(dir, 'prompt.txt'), root: project });
    const bundled = join(project, 'bin', platformBinary());
    const env = { ...process.env, ...(existsSync(bundled) ? { IOTROUTE_BIN: bundled } : {}), ...agentCase.agent.env, IOT_LAB: project, PCB_RUNS_DIR: join(project, '.gate/cli') };
    const started = clock();
    const pending: Pending = { schema: PENDING_SCHEMA, case_id: agentCase.case_id, board: agentCase.board, argv, started_at: new Date(started).toISOString(), runner_pid: process.pid, agent_pid: null };
    atomicJson(join(dir, 'run.pending.json'), pending);
    const out = openSync(join(dir, 'agent.stdout.jsonl'), 'wx'), err = openSync(join(dir, 'agent.stderr.log'), 'wx');
    let spawnError: string | null = null, timedOut = false;
    const [command, ...args] = argv;
    const child = spawn(command!, args, { cwd: project, env, stdio: ['ignore', out, err] });
    closeSync(out); closeSync(err);
    if (child.pid !== undefined) atomicJson(join(dir, 'run.pending.json'), { ...pending, agent_pid: child.pid });
    const ended = await new Promise<{ code: number | null; signal: string | null }>(done => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGINT');
        setTimeout(() => child.kill('SIGKILL'), options.graceMs ?? GRACE_MS).unref();
      }, Math.max(1, agentCase.budget.timeout_s * 1000));
      const forward = (signal: NodeJS.Signals) => () => { child.kill(signal); };
      const handlers = (['SIGINT', 'SIGTERM'] as const).map(signal => [signal, forward(signal)] as const);
      for (const [signal, handler] of handlers) process.on(signal, handler);
      const finish = (code: number | null, signal: string | null): void => { clearTimeout(timer); for (const [name, handler] of handlers) process.off(name, handler); done({ code, signal }); };
      child.on('error', error => { spawnError = error.message; finish(null, null); });
      child.on('close', (code, signal) => finish(code, signal));
    });
    const finished = clock();
    const record: RunRecord = {
      schema: RUN_SCHEMA, case_id: agentCase.case_id, board: agentCase.board, argv, started_at: new Date(started).toISOString(), ended_at: new Date(finished).toISOString(),
      wall_s: (finished - started) / 1000, exit_code: ended.code, signal: ended.signal, timed_out: timedOut, spawn_error: spawnError,
    };
    atomicJson(join(dir, 'run.json'), record);
    return record;
  } finally { release(); }
}
