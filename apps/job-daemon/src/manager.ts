import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { Config } from './config.ts';
import { exec } from './docker.ts';
import type { Runtime } from './docker.ts';
import type { HostState } from './host.ts';
import { backoffS, classify, retryable } from './retry.ts';
import { Store } from './store.ts';
import { HttpError, isTerminal } from './types.ts';
import type { Attempt, Classified, JobRecord, JobSpec, JobState } from './types.ts';

const NEXT: Record<JobState, readonly JobState[]> = {
  queued: ['running', 'cancelled'],
  running: ['passed', 'failed', 'retrying', 'cancelled'],
  retrying: ['running', 'cancelled'],
  passed: [],
  failed: [],
  cancelled: [],
};

export function validateSpec(raw: unknown, cfg: Config): JobSpec {
  if (typeof raw !== 'object' || raw === null) throw new HttpError(400, 'spec is not an object');
  const r = raw as Record<string, unknown>;
  const bad = (msg: string): never => {
    throw new HttpError(400, msg);
  };
  const command = r.command;
  if (!Array.isArray(command) || command.length === 0 || !command.every((c) => typeof c === 'string')) {
    bad('command must be a non-empty string array');
  }
  const image = r.image ?? cfg.images[0];
  if (typeof image !== 'string' || !cfg.images.includes(image)) bad(`image must be one of: ${cfg.images.join(', ')}`);
  const number = (key: string, fallback: number, max: number): number => {
    const v = r[key] ?? fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > max) bad(`${key} must be in (0, ${max}]`);
    return v as number;
  };
  const retries = r.maxRetries ?? cfg.defaultRetries;
  if (!Number.isInteger(retries) || (retries as number) < 0 || (retries as number) > cfg.maxRetriesCap) {
    bad(`maxRetries must be an integer in [0, ${cfg.maxRetriesCap}]`);
  }
  const codes = r.retryExitCodes ?? [];
  if (!Array.isArray(codes) || !codes.every((c) => Number.isInteger(c) && c > 0 && c < 256)) {
    bad('retryExitCodes must be exit codes 1-255');
  }
  const timeoutS = number('timeoutS', cfg.defaultTimeoutS, cfg.maxTimeoutS);
  if (!Number.isInteger(timeoutS)) bad('timeoutS must be an integer');
  return {
    name: typeof r.name === 'string' ? r.name.slice(0, 100) : '',
    command: command as string[],
    image: image as string,
    cpus: number('cpus', Math.min(cfg.defaultCpus, cfg.cpuBudget), cfg.cpuBudget),
    memGb: number('memGb', Math.min(cfg.defaultMemGb, cfg.memBudgetGb), cfg.memBudgetGb),
    timeoutS,
    maxRetries: retries as number,
    retryExitCodes: codes as number[],
  };
}

function newId(now: number): string {
  const t = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${t}-${randomBytes(3).toString('hex')}`;
}

/**
 * Owns the jobs. tick() compares each record with the real container and acts on the difference, and it is the
 * only code that does. A normal exit and a restart are therefore the same path: after a restart the daemon loads
 * the records and ticks. Containers run detached, so they do not depend on this process.
 */
export class JobManager {
  cfg: Config;
  store: Store;
  runtime: Runtime;
  host: () => HostState;
  now: () => number;
  jobs = new Map<string, JobRecord>();
  /** Why the head of the queue is not starting; shown in the status. */
  hold = '';
  private seq = 0;
  private ticking = false;
  private lastSweep = 0;

  constructor(cfg: Config, store: Store, runtime: Runtime, host: () => HostState, now: () => number = Date.now) {
    this.cfg = cfg;
    this.store = store;
    this.runtime = runtime;
    this.host = host;
    this.now = now;
    for (const job of store.loadAll()) {
      this.jobs.set(job.id, job);
      this.seq = Math.max(this.seq, job.seq);
    }
  }

  private iso = (): string => new Date(this.now()).toISOString();

  private list(...states: JobState[]): JobRecord[] {
    return [...this.jobs.values()].filter((j) => states.includes(j.state)).sort((a, b) => a.seq - b.seq);
  }

  usage(): { cpus: number; memGb: number } {
    const running = this.list('running');
    return {
      cpus: running.reduce((s, j) => s + j.spec.cpus, 0),
      memGb: running.reduce((s, j) => s + j.spec.memGb, 0),
    };
  }

  status() {
    return {
      budget: { cpus: this.cfg.cpuBudget, memGb: this.cfg.memBudgetGb },
      used: this.usage(),
      running: this.list('running').length,
      queued: this.list('queued').length,
      retrying: this.list('retrying').length,
      hold: this.hold,
    };
  }

  private setState(job: JobRecord, to: JobState, detail: string): void {
    if (!NEXT[job.state].includes(to)) throw new Error(`job ${job.id}: illegal transition ${job.state} -> ${to}`);
    const from = job.state;
    job.state = to;
    job.updatedAt = this.iso();
    this.store.save(job); // the record first: the event log may lag it after a crash, never lead it
    this.store.appendEvent(job.id, { t: job.updatedAt, from, to, attempt: job.attempts.length, detail });
  }

  /** The uploaded tar moves into the job folder; job.json is written last, so a crash here leaves no job. */
  submit(spec: JobSpec, tarPath: string): JobRecord {
    if (this.host().diskFreeGb < this.cfg.minFreeGb) {
      throw new HttpError(507, `less than ${this.cfg.minFreeGb} GB free in ${this.cfg.dataDir}`);
    }
    const id = newId(this.now());
    fs.mkdirSync(this.store.jobDir(id), { recursive: true });
    fs.renameSync(tarPath, this.store.inputTar(id));
    const t = this.iso();
    const job: JobRecord = {
      schema: 'pcb-job.v1',
      id,
      seq: ++this.seq,
      spec,
      state: 'queued',
      createdAt: t,
      updatedAt: t,
      cancelRequested: false,
      attempts: [],
    };
    this.store.save(job);
    this.store.appendEvent(id, { t, from: null, to: 'queued', attempt: 0, detail: 'submitted' });
    this.jobs.set(id, job);
    return job;
  }

  /** Queued and retrying jobs end here; a running one gets its container killed by the next tick. */
  cancel(id: string): JobRecord {
    const job = this.jobs.get(id);
    if (!job) throw new HttpError(404, 'no such job');
    if (isTerminal(job.state) || job.cancelRequested) return job;
    job.cancelRequested = true;
    if (job.state === 'running') {
      job.updatedAt = this.iso();
      this.store.save(job);
      return job;
    }
    job.result = { outcome: 'cancelled', exitCode: null, detail: 'cancelled' };
    this.setState(job, 'cancelled', 'cancelled');
    return job;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const job of this.list('running')) await this.reconcile(job);
      await this.admit();
      this.sweep();
    } finally {
      this.ticking = false;
    }
  }

  private async reconcile(job: JobRecord): Promise<void> {
    const attempt = job.attempts[job.attempts.length - 1];
    if (job.cancelRequested) await this.runtime.kill(attempt.container);
    const state = await this.runtime.inspect(attempt.container);
    if (state.status === 'running' || state.status === 'unknown') return;
    const c = classify({
      marker: this.store.readMarker(job.id, attempt.n),
      containerExit: state.status === 'exited' ? state.exitCode : null,
      oomKilled: state.status === 'exited' && state.oomKilled,
      missing: state.status === 'missing',
      cancelRequested: job.cancelRequested,
      elapsedS: (this.now() - Date.parse(attempt.startedAt)) / 1000,
      timeoutS: job.spec.timeoutS,
    });
    // Remove before the record is saved: if the daemon dies between the two, the marker still gives the verdict.
    await this.runtime.remove(attempt.container);
    this.finish(job, attempt, c);
  }

  private finish(job: JobRecord, attempt: Attempt, c: Classified): void {
    attempt.endedAt = this.iso();
    attempt.exitCode = c.exitCode;
    attempt.outcome = c.outcome;
    attempt.detail = c.detail;
    const retriesUsed = attempt.n - 1;
    if (!job.cancelRequested && retryable(c, job.spec) && retriesUsed < job.spec.maxRetries) {
      const delay = backoffS(this.cfg.retryBackoffS, retriesUsed + 1);
      job.nextAttemptAt = new Date(this.now() + delay * 1000).toISOString();
      this.setState(job, 'retrying', `attempt ${attempt.n}: ${c.detail}; retry in ${delay} s`);
    } else {
      job.nextAttemptAt = undefined;
      job.result = c;
      const end: JobState = c.outcome === 'passed' ? 'passed' : c.outcome === 'cancelled' ? 'cancelled' : 'failed';
      this.setState(job, end, `attempt ${attempt.n}: ${c.detail}`);
    }
    this.store.trimAttempt(job.id, attempt.n);
  }

  /** Why the job cannot start now, or '' when it can. Strict FIFO, so a large job is not passed over for ever. */
  private blockedBy(spec: JobSpec, host: HostState): string {
    const { cpus, memGb } = this.usage();
    if (cpus + spec.cpus > this.cfg.cpuBudget) return `cpu budget: ${cpus} of ${this.cfg.cpuBudget} in use, job needs ${spec.cpus}`;
    if (memGb + spec.memGb > this.cfg.memBudgetGb) return `memory budget: ${memGb} of ${this.cfg.memBudgetGb} GB in use, job needs ${spec.memGb}`;
    if (host.cpuPsiSome10 >= this.cfg.cpuPsiMax) return `host cpu pressure ${host.cpuPsiSome10} >= ${this.cfg.cpuPsiMax}`;
    const floor = host.memTotalGb * this.cfg.memFloorFraction;
    if (host.memAvailableGb - spec.memGb < floor) return `host memory: ${host.memAvailableGb.toFixed(1)} GB available, floor ${floor.toFixed(1)} GB`;
    if (host.diskFreeGb < this.cfg.minFreeGb) return `disk: ${host.diskFreeGb.toFixed(1)} GB free, floor ${this.cfg.minFreeGb} GB`;
    return '';
  }

  /** One start per tick: PSI is a 10 s average, so a burst of starts would all pass on the same quiet reading. */
  private async admit(): Promise<void> {
    const due = (j: JobRecord): boolean => j.state === 'queued' || Date.parse(j.nextAttemptAt ?? '') <= this.now();
    const next = this.list('queued', 'retrying').find(due);
    if (!next) {
      this.hold = '';
      return;
    }
    this.hold = this.blockedBy(next.spec, this.host());
    if (!this.hold && !(await this.runtime.ping())) this.hold = 'docker is not answering';
    if (this.hold) return;
    await this.startAttempt(next);
  }

  private async startAttempt(job: JobRecord): Promise<void> {
    const n = job.attempts.length + 1;
    const attempt: Attempt = { n, container: `pcbjob-${job.id}-${n}`, startedAt: this.iso() };
    job.attempts.push(attempt);
    job.nextAttemptAt = undefined;
    // Durable before the side effects: a crash from here on leaves "running" with no container, which reconcile
    // sees as an infrastructure failure.
    this.setState(job, 'running', `attempt ${n}`);
    const workDir = this.store.attemptDir(job.id, n);
    const prep = await this.prepare(job, workDir);
    if (prep) return this.finish(job, attempt, { outcome: 'infra', exitCode: null, detail: prep });
    const { image, cpus, memGb, timeoutS, command } = job.spec;
    const r = await this.runtime.start({ container: attempt.container, workDir, image, cpus, memGb, timeoutS, command });
    if (r.ok) return;
    await this.runtime.remove(attempt.container);
    this.finish(job, attempt, { outcome: r.permanent ? 'start' : 'infra', exitCode: null, detail: r.detail });
  }

  private async prepare(job: JobRecord, workDir: string): Promise<string> {
    fs.mkdirSync(`${workDir}/out`, { recursive: true });
    const x = await exec('tar', ['-xzf', this.store.inputTar(job.id), '-C', workDir, '--no-same-owner'], 120_000);
    if (x.code !== 0) return `input extract failed: ${x.stderr.trim()}`;
    if (this.cfg.jobUid === null) return '';
    const c = await exec('chown', ['-hR', `${this.cfg.jobUid}:${this.cfg.jobUid}`, workDir], 120_000);
    return c.code === 0 ? '' : `chown failed: ${c.stderr.trim()}`;
  }

  /** The disk on this host is shared, so finished jobs do not stay for ever. Hourly is enough for a limit in days. */
  private sweep(): void {
    if (this.now() - this.lastSweep < 3_600_000) return;
    this.lastSweep = this.now();
    const cutoff = this.now() - this.cfg.retainDays * 86_400_000;
    for (const job of this.list('passed', 'failed', 'cancelled')) {
      if (Date.parse(job.updatedAt) < cutoff) {
        this.store.remove(job.id);
        this.jobs.delete(job.id);
      }
    }
  }
}
