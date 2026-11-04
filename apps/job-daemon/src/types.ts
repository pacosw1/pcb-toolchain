export type JobState = 'queued' | 'running' | 'retrying' | 'passed' | 'failed' | 'cancelled';

export const TERMINAL: readonly JobState[] = ['passed', 'failed', 'cancelled'];

export const isTerminal = (s: JobState): boolean => TERMINAL.includes(s);

/** Why an attempt ended. README "Retry rule" says which of these retry. */
export type Outcome = 'passed' | 'cancelled' | 'timeout' | 'oom' | 'command' | 'infra' | 'start';

export interface JobSpec {
  name: string;
  command: string[];
  image: string;
  cpus: number;
  memGb: number;
  timeoutS: number;
  maxRetries: number;
  /** Exit codes of the command that also retry. Empty by default: a tool's non-zero exit is a verdict. */
  retryExitCodes: number[];
}

export interface Attempt {
  n: number;
  container: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  outcome?: Outcome;
  detail?: string;
}

export interface JobRecord {
  schema: 'pcb-job.v1';
  id: string;
  /** Submit order; the queue is FIFO on it. */
  seq: number;
  spec: JobSpec;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  cancelRequested: boolean;
  attempts: Attempt[];
  nextAttemptAt?: string;
  result?: { outcome: Outcome; exitCode: number | null; detail: string };
}

export interface Classified {
  outcome: Outcome;
  exitCode: number | null;
  detail: string;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
