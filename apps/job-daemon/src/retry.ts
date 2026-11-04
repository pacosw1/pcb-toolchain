import type { Classified, JobSpec } from './types.ts';

export interface AttemptEnd {
  /** What the wrapper wrote to .exit-code; null when the wrapper never finished (container killed from outside). */
  marker: number | null;
  containerExit: number | null;
  oomKilled: boolean;
  /** The container is gone and left no state. */
  missing: boolean;
  cancelRequested: boolean;
  elapsedS: number;
  timeoutS: number;
}

/**
 * Names why an attempt ended. The wrapper's marker separates "the command ended by itself" from
 * "something killed the container", which the container exit code alone cannot do.
 */
export function classify(e: AttemptEnd): Classified {
  if (e.marker === 0) return { outcome: 'passed', exitCode: 0, detail: 'command exit 0' };
  if (e.cancelRequested) return { outcome: 'cancelled', exitCode: e.marker, detail: 'cancelled' };
  if (e.oomKilled) return { outcome: 'oom', exitCode: e.marker ?? e.containerExit, detail: 'out of memory at the job limit' };
  if (e.marker === null) {
    const how = e.missing ? 'container gone' : `container killed from outside (exit ${e.containerExit})`;
    return { outcome: 'infra', exitCode: null, detail: how };
  }
  if (e.marker === 124) return { outcome: 'timeout', exitCode: 124, detail: `timed out after ${e.timeoutS} s` };
  if (e.marker === 137) {
    // timeout -k gives 137 when it had to KILL. An early 137 is a SIGKILL from outside, such as the host OOM killer.
    if (e.elapsedS >= e.timeoutS) return { outcome: 'timeout', exitCode: 137, detail: `killed after ${e.timeoutS} s` };
    return { outcome: 'infra', exitCode: 137, detail: 'command killed by SIGKILL before its timeout' };
  }
  return { outcome: 'command', exitCode: e.marker, detail: `command exit ${e.marker}` };
}

/** Infrastructure failures retry. A timeout, an OOM, a bad image or a tool's verdict would fail the same way again. */
export function retryable(c: Classified, spec: JobSpec): boolean {
  if (c.outcome === 'infra') return true;
  return c.outcome === 'command' && c.exitCode !== null && spec.retryExitCodes.includes(c.exitCode);
}

/** Delay before retry number `retry` (1 = first): base, 2 x base, 4 x base. */
export const backoffS = (base: number, retry: number): number => base * 2 ** (retry - 1);
