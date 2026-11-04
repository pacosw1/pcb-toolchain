import type { Attempt, Classified, JobSpec } from './types.ts';

/** How long after timeoutS the daemon kills a job itself: `timeout -k`'s 10 s, plus this margin. A default to tune. */
export const KILL_AFTER_S = 10;
export const DEADLINE_MARGIN_S = 5;

export const deadlineS = (timeoutS: number): number => timeoutS + KILL_AFTER_S + DEADLINE_MARGIN_S;

/** 128 + SIGXFSZ: a process crossed RLIMIT_FSIZE, the per-file limit from `--ulimit fsize`. */
const EXIT_FILE_TOO_LARGE = 153;

export interface AttemptEnd {
  /** Docker's own record. Nothing the job can write to disk goes into a verdict. */
  containerExit: number | null;
  oomKilled: boolean;
  /** The container is gone and left no state. */
  missing: boolean;
  cancelRequested: boolean;
  killedFor: Attempt['killedFor'];
  killDetail: string;
  elapsedS: number;
  timeoutS: number;
  diskGb: number;
}

export function classify(e: AttemptEnd): Classified {
  if (e.killedFor === 'disk') return { outcome: 'disk', exitCode: e.containerExit, detail: e.killDetail };
  if (e.killedFor === 'deadline') return { outcome: 'timeout', exitCode: e.containerExit, detail: e.killDetail };
  if (e.containerExit === 0) return { outcome: 'passed', exitCode: 0, detail: 'command exit 0' };
  if (e.cancelRequested) return { outcome: 'cancelled', exitCode: e.containerExit, detail: 'cancelled' };
  if (e.missing) return { outcome: 'infra', exitCode: null, detail: 'container gone' };
  if (e.oomKilled) return { outcome: 'oom', exitCode: e.containerExit, detail: 'out of memory at the job limit' };
  const code = e.containerExit as number;
  if (code === 124) return { outcome: 'timeout', exitCode: 124, detail: `timed out after ${e.timeoutS} s` };
  if (code === EXIT_FILE_TOO_LARGE) {
    return { outcome: 'disk', exitCode: code, detail: `a file reached the ${e.diskGb} GB disk limit` };
  }
  if (code === 137) {
    // timeout -k gives 137 when it had to KILL. An early 137 is a SIGKILL from outside: docker kill, the host OOM
    // killer, a host or Docker restart.
    if (e.elapsedS >= e.timeoutS) return { outcome: 'timeout', exitCode: 137, detail: `killed after ${e.timeoutS} s` };
    return { outcome: 'infra', exitCode: 137, detail: 'killed by SIGKILL before its timeout' };
  }
  // Docker records 255 for a container it lost track of, for example when dockerd itself died.
  if (code === 255) return { outcome: 'infra', exitCode: 255, detail: 'container exit 255' };
  return { outcome: 'command', exitCode: code, detail: `command exit ${code}` };
}

/** Infrastructure failures retry. A timeout, an OOM, a disk limit, a bad image or a tool's verdict would fail again. */
export function retryable(c: Classified, spec: JobSpec): boolean {
  if (c.outcome === 'infra') return true;
  return c.outcome === 'command' && c.exitCode !== null && spec.retryExitCodes.includes(c.exitCode);
}

/** Delay before retry number `retry` (1 = first): base, 2 x base, 4 x base. */
export const backoffS = (base: number, retry: number): number => base * 2 ** (retry - 1);
