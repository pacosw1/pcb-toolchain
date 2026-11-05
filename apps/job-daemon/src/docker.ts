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
  /** Image configuration digest of the exact container, or null if inspection is inconclusive. */
  inspectImage(container: string): Promise<string | null>;
  kill(container: string): Promise<void>;
  remove(container: string): Promise<void>;
  /** This daemon's containers, running or not. null: no answer, which is not the same as none. */
  list(): Promise<string[] | null>;
  /** Bytes in the container's writable layer; 0 only if Docker says it does not exist; null when not measured. */
  layerBytes(container: string): Promise<number | null>;
  /** Deletes the job's files in a throw-away container. Call only when the job's container is confirmed gone. */
  cleanAttempt(attemptDir: string, keepOut: boolean): Promise<boolean>;
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

export function exec(
  cmd: string,
  args: string[],
  timeoutMs = 30_000,
  opts: { signal?: AbortSignal; killSignal?: NodeJS.Signals } = {},
): Promise<Exec> {
  return new Promise((resolve) => {
    const { signal, killSignal } = opts;
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, killSignal }, (err, stdout, stderr) => {
      signal?.removeEventListener('abort', stop);
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      resolve({ code, stdout, stderr: stderr || (err ? err.message : '') });
    });
    // Not execFile's own `signal`: that one calls back at once, while the process may still be running, and callers
    // count on this promise meaning the process has ended.
    function stop(): void {
      child.kill();
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  });
}

/** For root workers that walk or read what a job made: they must not compete with CI. ionice is Linux only. */
export function lowPriority(cmd: string, args: string[], platform: string = process.platform): [string, string[]] {
  return ['nice', ['-n', '19', ...(platform === 'linux' ? ['ionice', '-c', '3'] : []), cmd, ...args]];
}

/**
 * Disk blocks in use, not following links, staying on the filesystem. Anything but a clean, complete answer is null:
 * a partial total would let a job pass by making du fail. du also fails when a file vanishes during the walk, which
 * is normal, so one null is not a verdict; JobManager.checkDisk decides.
 */
export async function dirBytes(dirs: string[], timeoutMs = 30_000): Promise<number | null> {
  const [cmd, args] = lowPriority('du', ['-skx', ...dirs]);
  const r = await exec(cmd, args, timeoutMs, { killSignal: 'SIGKILL' });
  if (r.code !== 0) return null;
  const lines = r.stdout.trim().split('\n');
  if (lines.length !== dirs.length) return null;
  let kb = 0;
  for (const line of lines) {
    const m = /^(\d+)\s/.exec(line);
    if (!m) return null;
    kb += Number(m[1]);
  }
  return kb * 1024;
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
    // Per process, so with fsize it only bounds what one process can hide in unlinked files. README "Limits".
    '--ulimit', `nofile=${cfg.nofile}:${cfg.nofile}`,
    // The kernel picks a job first when the host runs out of memory, not CI or the orchestrator.
    '--oom-score-adj', '1000',
    '-v', `${req.workDir}:/job`, '-v', `${req.outDir}:/job/out`, '-v', `${req.inputTar}:/input.tar.gz:ro`,
    '-w', '/job', '-e', 'TMPDIR=/job/out/tmp',
    req.image, 'bash', '-c', WRAPPER, '_', String(req.timeoutS), ...req.command,
  ];
}

/**
 * The cleaner: only the attempt folder is mounted, so even wrong logic or a link in the tree cannot reach the host.
 * It runs as root with just the capabilities that get past a job's chmod 000. rm and find -delete do not follow
 * links. keepOut leaves regular files and folders in out/, for the results. The limits are defaults to tune.
 */
export function cleanArgs(name: string, attemptDir: string, keepOut: boolean, cfg: Config): string[] {
  const script = keepOut
    ? 'rm -rf /a/work && if [ -d /a/out ]; then find /a/out -mindepth 1 ! -type f ! -type d -delete; fi'
    : 'rm -rf /a/work /a/out';
  return [
    'run', '--rm', '--pull', 'never', '--name', name, '--label', `pcb-job-cleaner=${cfg.instance}`,
    ...(cfg.cgroupParent ? ['--cgroup-parent', cfg.cgroupParent] : []),
    '--network', 'none', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'DAC_READ_SEARCH',
    '--security-opt', 'no-new-privileges', '--log-driver', 'none', '--user', '0:0',
    '--cpus', '1', '--memory', '256m', '--pids-limit', '64',
    '-v', `${attemptDir}:/a`, cfg.images[0], 'sh', '-c', script,
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

  async inspectImage(container: string): Promise<string | null> {
    const r = await exec('docker', ['inspect', '--format', '{{.Image}}', container]);
    const value = r.stdout.trim();
    return r.code === 0 && /^sha256:[0-9a-f]{64}$/.test(value) ? value : null;
  }

  async kill(container: string): Promise<void> {
    await exec('docker', ['kill', container]);
  }

  async remove(container: string): Promise<void> {
    await exec('docker', ['rm', '-f', container]);
  }

  async list(): Promise<string[] | null> {
    const r = await exec('docker', ['ps', '-a', '--filter', `label=pcb-job-daemon=${this.cfg.instance}`, '--format', '{{.Names}}']);
    return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : null;
  }

  async layerBytes(container: string): Promise<number | null> {
    const r = await exec('docker', ['inspect', '--size', '--format', '{{.SizeRw}}', container]);
    if (r.code === 0) return /^\d+$/.test(r.stdout.trim()) ? Number(r.stdout.trim()) : null;
    return /no such (object|container)/i.test(r.stderr) ? 0 : null;
  }

  async cleanAttempt(attemptDir: string, keepOut: boolean): Promise<boolean> {
    const [n, , id] = attemptDir.split('/').reverse(); // <data>/jobs/<id>/attempts/<n>
    const name = `pcbclean-${id}-${n}`;
    await exec('docker', ['rm', '-f', name]); // one left by a run that timed out
    return (await exec('docker', cleanArgs(name, attemptDir, keepOut, this.cfg), 600_000)).code === 0;
  }
}
