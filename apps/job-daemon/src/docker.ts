import { execFile } from 'node:child_process';
import type { Config } from './config.ts';
import { KILL_AFTER_S } from './retry.ts';

export interface StartRequest {
  container: string;
  workDir: string;
  outDir: string;
  inputTar: string;
  image: string;
  cpus: number;
  memGb: number;
  diskGb: number;
  timeoutS: number;
  command: string[];
}

export type StartResult = { ok: true } | { ok: false; permanent: boolean; detail: string };

export type ContainerState =
  | { status: 'running' }
  | { status: 'exited'; exitCode: number; oomKilled: boolean }
  | { status: 'missing' }
  /** Docker did not answer. Says nothing about the job, so the daemon must not act on it. */
  | { status: 'unknown'; detail: string };

/** All the daemon needs from a container engine. Tests use a fake of this. */
export interface Runtime {
  ping(): Promise<boolean>;
  start(req: StartRequest): Promise<StartResult>;
  inspect(container: string): Promise<ContainerState>;
  kill(container: string): Promise<void>;
  remove(container: string): Promise<void>;
  /** This daemon's containers, running or not. */
  list(): Promise<string[]>;
  /** Bytes in the container's writable layer; 0 if it does not exist; null if Docker did not answer in time. */
  layerBytes(container: string): Promise<number | null>;
}

// Same job contract as tools/remote.sh: run in /job, write to out/, stdout+stderr in out/job.log, timeout -k 10.
// Three changes. The input is unpacked here, as the job's uid and inside its limits, not by root on the host. The log
// goes straight to a file: a pipe into tee hangs when a child outlives the command. And this timeout runs as the job's
// uid, so a job can stop it: it only gives a clean exit 124; the real deadline is in JobManager.reconcile.
const WRAPPER =
  'mkdir -p out/tmp; ' +
  `timeout -k ${KILL_AFTER_S} "$1" bash -c 'tar -xzf /input.tar.gz && exec "$@"' _ "\${@:2}" > out/job.log 2>&1; ` +
  'rc=$?; rm -rf out/tmp; exit "$rc"';

export interface Exec {
  /** null: killed at the time limit, or could not run. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export function exec(cmd: string, args: string[], timeoutMs = 30_000): Promise<Exec> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      resolve({ code, stdout, stderr: stderr || (err ? err.message : '') });
    });
  });
}

/** Disk blocks in use, not following links, staying on the filesystem. null if du did not finish in time. */
export async function dirBytes(dirs: string[]): Promise<number | null> {
  const r = await exec('du', ['-skx', ...dirs]);
  if (r.code === null) return null;
  // A non-zero code here means files went away during the walk, which is normal for a running job.
  return r.stdout.split('\n').reduce((sum, line) => sum + (Number.parseInt(line, 10) || 0) * 1024, 0);
}

export function runArgs(req: StartRequest, cfg: Config): string[] {
  const mem = `${Math.round(req.memGb * 1024)}m`;
  const uid = cfg.jobUid === null ? [] : ['--user', `${cfg.jobUid}:${cfg.jobUid}`];
  const parent = cfg.cgroupParent ? ['--cgroup-parent', cfg.cgroupParent] : [];
  return [
    'run', '-d', '--pull', 'never', '--name', req.container, '--label', `pcb-job-daemon=${cfg.instance}`,
    ...uid, ...parent,
    '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--log-driver', 'none',
    '--cpus', String(req.cpus), '--memory', mem, '--memory-swap', mem, '--pids-limit', String(cfg.pidsLimit),
    // Hard, per file, and it also stops a sparse file. The sum over all files is JobManager.watchDisk.
    '--ulimit', `fsize=${Math.round(req.diskGb * 1024 ** 3)}`,
    // The kernel picks a job first when the host runs out of memory, not CI or the orchestrator.
    '--oom-score-adj', '1000',
    '-v', `${req.workDir}:/job`, '-v', `${req.outDir}:/job/out`, '-v', `${req.inputTar}:/input.tar.gz:ro`,
    '-w', '/job', '-e', 'TMPDIR=/job/out/tmp',
    req.image, 'bash', '-c', WRAPPER, '_', String(req.timeoutS), ...req.command,
  ];
}

export class DockerRuntime implements Runtime {
  cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  async ping(): Promise<boolean> {
    return (await exec('docker', ['version', '--format', '{{.Server.Version}}'], 10_000)).code === 0;
  }

  async start(req: StartRequest): Promise<StartResult> {
    const r = await exec('docker', runArgs(req, this.cfg), 120_000);
    if (r.code === 0) return { ok: true };
    const detail = r.stderr.trim().split('\n').slice(-1)[0] || `docker run exit ${r.code}`;
    return { ok: false, permanent: /no such image|unable to find image/i.test(r.stderr), detail };
  }

  async inspect(container: string): Promise<ContainerState> {
    const r = await exec('docker', ['inspect', '--format', '{{json .State}}', container]);
    if (r.code !== 0) {
      if (/no such (object|container)/i.test(r.stderr)) return { status: 'missing' };
      return { status: 'unknown', detail: r.stderr.trim() };
    }
    const s = JSON.parse(r.stdout) as { Status: string; ExitCode: number; OOMKilled: boolean };
    if (s.Status === 'running' || s.Status === 'paused' || s.Status === 'restarting') return { status: 'running' };
    return { status: 'exited', exitCode: s.ExitCode, oomKilled: s.OOMKilled };
  }

  async kill(container: string): Promise<void> {
    await exec('docker', ['kill', container]);
  }

  async remove(container: string): Promise<void> {
    await exec('docker', ['rm', '-f', container]);
  }

  async list(): Promise<string[]> {
    const r = await exec('docker', ['ps', '-a', '--filter', `label=pcb-job-daemon=${this.cfg.instance}`, '--format', '{{.Names}}']);
    return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
  }

  async layerBytes(container: string): Promise<number | null> {
    const r = await exec('docker', ['inspect', '--size', '--format', '{{.SizeRw}}', container]);
    if (r.code === null) return null;
    return r.code === 0 ? Number.parseInt(r.stdout, 10) || 0 : 0;
  }
}
