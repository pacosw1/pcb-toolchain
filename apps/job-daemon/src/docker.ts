import { execFile } from 'node:child_process';
import type { Config } from './config.ts';

export interface StartRequest {
  container: string;
  workDir: string;
  image: string;
  cpus: number;
  memGb: number;
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
}

// Same job contract as tools/remote.sh: run in /job, write to out/, stdout+stderr in out/job.log, timeout -k 10.
// Two changes. The log goes straight to a file: a pipe into tee hangs when a child outlives the command, and the
// file survives a daemon restart. And .exit-code records that the command ended by itself (retry.ts).
const WRAPPER =
  'mkdir -p out/tmp; timeout -k 10 "$1" "${@:2}" > out/job.log 2>&1; rc=$?; rm -rf out/tmp; echo "$rc" > .exit-code; exit "$rc"';

export interface Exec {
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

export function runArgs(req: StartRequest, cfg: Config): string[] {
  const mem = `${Math.round(req.memGb * 1024)}m`;
  const uid = cfg.jobUid === null ? [] : ['--user', `${cfg.jobUid}:${cfg.jobUid}`];
  const parent = cfg.cgroupParent ? ['--cgroup-parent', cfg.cgroupParent] : [];
  return [
    'run', '-d', '--pull', 'never', '--name', req.container, '--label', `pcb-job-daemon=${cfg.instance}`,
    ...uid, ...parent,
    '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--log-driver', 'none',
    '--cpus', String(req.cpus), '--memory', mem, '--memory-swap', mem,
    // The kernel picks a job first when the host runs out of memory, not CI or the orchestrator.
    '--oom-score-adj', '1000',
    '-v', `${req.workDir}:/job`, '-w', '/job', '-e', 'TMPDIR=/job/out/tmp',
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
}
