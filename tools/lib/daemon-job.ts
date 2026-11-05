// Small jobs on the job daemon for Mac-side tools, and the cache that keeps their results by content. A job gets its files
// through --in, so a scratch copy outside the project works too. An error stops the tool: nothing falls back to the Mac.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileRoot, projectRoot } from './project-root.mjs';

export interface DaemonJob {
  /** What failed, in the error of a job that does not pass. */
  label: string;
  inputs: string[];
  image: string;
  timeoutS: number;
  cpus: number;
  memGb: number;
  /** The daemon's default bound when left out. */
  queueWaitS?: number;
  name?: string;
  command: string[];
}

export const contentKey = (parts: string[]): string => createHash('sha256').update(parts.join('\n')).digest('hex');

export const cacheFolder = (name: string): string =>
  join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'pcb-toolchain', name);

/**
 * What is kept at `cached`, a file or a folder: `read` of what is there, else `make` of a fresh one, which is kept when it
 * returns. A result `make` throws on is never kept. The rename makes it whole at once; two runs of one key make equal results.
 */
export function cachedWhole<T>(cached: string, read: (path: string) => T, make: (fresh: string) => T): T {
  if (existsSync(cached)) return read(cached);
  mkdirSync(dirname(cached), { recursive: true });
  const fresh = `${cached}.${process.pid}`;
  try {
    const value = make(fresh);
    try {
      renameSync(fresh, cached);
    } catch (error) {
      if (!existsSync(cached)) throw error; // a folder cannot replace the one the other run kept first
    }
    return value;
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}

/** The client arguments of a job. */
export function jobArguments(job: DaemonJob, results: string): string[] {
  return ['run', 'job', ...job.inputs.flatMap(file => ['--in', file]), '--image', job.image,
    '--timeout', String(job.timeoutS), '--cpus', String(job.cpus), '--mem', String(job.memGb), '--results', results,
    ...(job.queueWaitS === undefined ? [] : ['--queue-wait', String(job.queueWaitS)]),
    ...(job.name === undefined ? [] : ['--name', job.name]),
    '--', ...job.command];
}

/** The daemon settings of the environment, else of the project's .pcb-toolchain.env, as tools/router/route-dispatch.mjs reads them. */
export function daemonSettings(env: NodeJS.ProcessEnv, project: string, home = homedir()): { JOBD_URL: string; JOBD_TOKEN_FILE: string } {
  const file = join(project, '.pcb-toolchain.env');
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  const url = env.JOBD_URL || lines.filter(line => line.startsWith('JOBD_URL=')).at(-1)?.slice('JOBD_URL='.length);
  if (!url) throw new Error(`no JOBD_URL in the environment or in ${file}`);
  return { JOBD_URL: url, JOBD_TOKEN_FILE: env.JOBD_TOKEN_FILE || join(home, '.config/pcb-job/token') };
}

function jobClient(toolchain: string): string {
  const client = [join(toolchain, 'tools/pcb-job/client.ts'), join(toolchain, 'apps/job-daemon/src/client.ts')].find(file => existsSync(file));
  if (!client) throw new Error(`no job client under ${toolchain}`);
  return client;
}

/**
 * One job, waited for. `collect` gets the job's out folder while it exists. The client stages a project and its tools; here they
 * are an empty stand-in, because the job needs only its --in files. A job that does not pass is an error.
 */
export function runDaemonJob(job: DaemonJob, collect: (out: string) => void): void {
  const toolchain = process.env.PCB_TOOLCHAIN_ROOT || fileRoot;
  const standIn = mkdtempSync(join(tmpdir(), 'daemon-job-'));
  try {
    mkdirSync(join(standIn, 'tools'));
    mkdirSync(join(standIn, 'job'));
    const results = join(standIn, 'results');
    const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', jobClient(toolchain), ...jobArguments(job, results)],
      { encoding: 'utf8', env: { ...process.env, ...daemonSettings(process.env, projectRoot()), IOT_LAB: standIn, PCB_TOOLCHAIN_ROOT: standIn } });
    if (run.status !== 0) throw new Error(`${job.label} ended with ${run.status}: ${run.stderr.slice(-500)}`);
    collect(join(results, 'out'));
  } finally {
    rmSync(standIn, { recursive: true, force: true });
  }
}
