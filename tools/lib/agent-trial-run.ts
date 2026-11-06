// `pcb trial run`: start the agent of a prepared trial in its scratch project with one deadline, save its output, hold the benchmark lock.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fillArgv, readCase } from './agent-trial-case.ts';
import { acquire } from './bench-lock.ts';
import { atomicJson } from './json-file.ts';

export const RUN_SCHEMA = 'iot-lab.agent-trial-run.v1';
const GRACE_MS = 60_000;

export interface RunRecord {
  schema: typeof RUN_SCHEMA; case_id: string; board: string; argv: string[]; started_at: string; ended_at: string; wall_s: number;
  exit_code: number | null; signal: string | null; timed_out: boolean; spawn_error: string | null;
}
export interface RunOptions {
  /** Takes the benchmark lock and returns the release. Default: bench-lock.ts, failing at once when another benchmark holds it. */
  lock?: (label: string) => Promise<() => void>;
  /** Epoch milliseconds. Injected so a test fixes the wall time. */
  clock?: () => number;
  graceMs?: number;
}

const platformBinary = (): string => `iotroute-${process.platform}-${process.arch === 'x64' ? 'x86_64' : process.arch}`;

export async function runTrial(dirPath: string, options: RunOptions = {}): Promise<RunRecord> {
  const dir = resolve(dirPath), project = join(dir, 'project'), clock = options.clock ?? Date.now;
  if (!existsSync(join(dir, 'prepare.json')) || !existsSync(join(dir, 'case.json'))) throw new Error(`${dir} is not prepared; run: tools/pcb trial prepare CASE --lab DIR --out ${dir}`);
  const agentCase = readCase(join(dir, 'case.json')).case;
  const used = (): boolean => existsSync(join(dir, 'run.json')) || existsSync(join(dir, 'agent.stdout.jsonl'));
  const refuse = (): void => { if (used()) throw new Error(`${dir} already ran; a trial runs once. Prepare a new --out`); };
  refuse();
  const release = await (options.lock ?? (async label => acquire({ label })))(`trial ${agentCase.case_id} -> ${dir}`);
  try {
    refuse();
    const argv = fillArgv(agentCase, { prompt_file: join(dir, 'prompt.txt'), root: project });
    const bundled = join(project, 'bin', platformBinary());
    const env = { ...process.env, ...(existsSync(bundled) ? { IOTROUTE_BIN: bundled } : {}), ...agentCase.agent.env, IOT_LAB: project, PCB_RUNS_DIR: join(project, '.gate/cli') };
    const out = openSync(join(dir, 'agent.stdout.jsonl'), 'wx'), err = openSync(join(dir, 'agent.stderr.log'), 'wx');
    const started = clock();
    let spawnError: string | null = null, timedOut = false;
    const [command, ...args] = argv;
    const child = spawn(command!, args, { cwd: project, env, stdio: ['ignore', out, err] });
    closeSync(out); closeSync(err);
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
