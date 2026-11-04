import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { Config } from './config.ts';
import { dirBytes } from './docker.ts';
import type { Runtime } from './docker.ts';
import type { HostState } from './host.ts';
import { backoffS, classify, deadlineS, retryable } from './retry.ts';
import { Store } from './store.ts';
import { HttpError, isTerminal } from './types.ts';
import type { Attempt, Classified, JobRecord, JobSpec, JobState } from './types.ts';

const NEXT: Record<JobState, readonly JobState[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['passed', 'failed', 'retrying', 'cancelled'],
  retrying: ['running', 'cancelled'],
  passed: [],
  failed: [],
  cancelled: [],
};

// Floors. Below them Docker or `timeout` would read the value as "no limit", or refuse it.
/** 64 MiB, a default to tune. The hard floor is Docker's 6 MiB minimum; --memory 0 means unlimited. */
const MIN_MEM_GB = 0.0625;
/** The kernel's minimum CFS quota is 1 ms per 100 ms period. */
const MIN_CPUS = 0.01;
/** `timeout 0` means no timeout, and timeout takes whole seconds here. */
const MIN_TIMEOUT_S = 1;
/** 10 MB, a default to tune: it only has to hold a small job folder. */
const MIN_DISK_GB = 0.01;
/** Failed disk measurements in a row before a job is killed. One failure is normal: see dirBytes. A default to tune. */
const MAX_DISK_MISSES = 3;
/** The queue bound's floor: `queueWaitS` is whole seconds and 0 would refuse every job that has to wait a tick. */
const MIN_QUEUE_WAIT_S = 1;
/** How often a hold that does not change is logged again. The period of the guard's own log line. A default to tune. */
const HOLD_REPEAT_MS = 30_000;

/** The kind of a hold: its text up to the numbers, so a reading that moves is not a new reason. */
const holdKind = (reason: string): string => reason.split(':')[0];

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
  const number = (key: string, fallback: number, min: number, max: number): number => {
    const v = r[key] ?? fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) bad(`${key} must be in [${min}, ${max}]`);
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
  const timeoutS = number('timeoutS', cfg.defaultTimeoutS, MIN_TIMEOUT_S, cfg.maxTimeoutS);
  if (!Number.isInteger(timeoutS)) bad('timeoutS must be an integer');
  const queueWaitS = number('queueWaitS', cfg.defaultQueueWaitS, MIN_QUEUE_WAIT_S, cfg.maxQueueWaitS);
  if (!Number.isInteger(queueWaitS)) bad('queueWaitS must be an integer');
  return {
    name: typeof r.name === 'string' ? r.name.slice(0, 100) : '',
    command: command as string[],
    image: image as string,
    cpus: number('cpus', Math.min(cfg.defaultCpus, cfg.cpuBudget), MIN_CPUS, cfg.cpuBudget),
    memGb: number('memGb', Math.min(cfg.defaultMemGb, cfg.memBudgetGb), MIN_MEM_GB, cfg.memBudgetGb),
    diskGb: number('diskGb', Math.min(cfg.defaultDiskGb, cfg.maxDiskGb), MIN_DISK_GB, cfg.maxDiskGb),
    timeoutS,
    queueWaitS,
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
  private watching = false;
  private cleaning = false;
  private recovered = false;
  private lastSweep = 0;
  private diskMisses = new Map<string, number>();
  /** What was last logged for each waiting job. Lost at a restart, which logs each hold once more. */
  private holdLogged = new Map<string, { kind: string; at: number }>();

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
    job.hold = undefined;
    this.holdLogged.delete(job.id);
    this.store.save(job); // the record first: the event log may lag it after a crash, never lead it
    this.store.appendEvent(job.id, { t: job.updatedAt, from, to, attempt: job.attempts.length, detail });
  }

  /** Also checked before an upload is read, so a full queue costs the caller nothing. */
  assertQueueRoom(): void {
    const waiting = this.list('queued', 'retrying').length;
    if (waiting >= this.cfg.maxQueued) throw new HttpError(429, `queue full: ${waiting} jobs waiting, limit ${this.cfg.maxQueued}`);
  }

  /** The uploaded tar moves into the job folder; job.json is written last, so a crash here leaves no job. */
  submit(spec: JobSpec, tarPath: string): JobRecord {
    this.assertQueueRoom();
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
      if (!this.recovered) await this.recover();
      this.enforceHostFloor();
      for (const job of this.list('running')) await this.reconcile(job);
      await this.admit();
      this.expireQueued(); // after admit: a job that can start at its bound starts
    } finally {
      this.ticking = false;
    }
  }

  /** Clears containers of this daemon that no running attempt owns. No answer means try again, not "there are none". */
  private async recover(): Promise<void> {
    const names = await this.runtime.list();
    if (names === null) return;
    const live = new Set(this.list('running').map((j) => j.attempts[j.attempts.length - 1].container));
    for (const name of names) {
      if (!live.has(name)) await this.runtime.remove(name);
    }
    this.recovered = true;
  }

  /**
   * The last line against filling the disk: statfs sees what du cannot, such as files a job has unlinked but keeps
   * open. Past the floor every running job is killed, whoever used the space. Killing them also frees those files.
   */
  private enforceHostFloor(): void {
    const free = this.host().diskFreeGb;
    if (free >= this.cfg.minFreeGb) return;
    for (const job of this.list('running')) {
      const attempt = job.attempts[job.attempts.length - 1];
      if (attempt.killedFor || job.cancelRequested) continue;
      attempt.killedFor = 'disk';
      attempt.killDetail = `host disk at ${free.toFixed(1)} GB free, below the ${this.cfg.minFreeGb} GB floor`;
      this.store.save(job);
    }
  }

  /**
   * The only code that touches job trees, and it runs apart from tick(), so a slow delete never delays a deadline.
   * Failure of any step means stop and try again on the next call.
   */
  async clean(): Promise<void> {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      for (const job of [...this.jobs.values()]) {
        for (const attempt of job.attempts) {
          if (!attempt.endedAt || attempt.trimmed) continue;
          if (!(await this.cleanOne(job, attempt, true))) continue;
          attempt.trimmed = true;
          this.store.save(job);
        }
      }
      await this.sweep();
    } finally {
      this.cleaning = false;
    }
  }

  /** Never touches the tree unless Docker says the container does not exist: a live job could race any delete. */
  private async cleanOne(job: JobRecord, attempt: Attempt, keepOut: boolean): Promise<boolean> {
    await this.runtime.remove(attempt.container);
    const state = await this.runtime.inspect(attempt.container);
    if (state.status !== 'missing') {
      console.error(`job ${job.id}: cleanup waits, container ${attempt.container} is ${state.status}`);
      return false;
    }
    this.diskMisses.delete(attempt.container);
    const dir = this.store.attemptDir(job.id, attempt.n);
    return !fs.existsSync(dir) || this.runtime.cleanAttempt(dir, keepOut);
  }

  private async reconcile(job: JobRecord): Promise<void> {
    const attempt = job.attempts[job.attempts.length - 1];
    const started = Date.parse(attempt.startedAt);
    // The daemon's own clock and its own record. The timeout process in the container runs as the job's uid, so a
    // job can stop it; this cannot be reached from inside. A restart keeps it: startedAt is durable.
    if (!attempt.killedFor && this.now() - started > deadlineS(job.spec.timeoutS) * 1000) {
      attempt.killedFor = 'deadline';
      attempt.killDetail = `the daemon killed it ${deadlineS(job.spec.timeoutS)} s after the start: timeout ${job.spec.timeoutS} s`;
      this.store.save(job);
    }
    if (job.cancelRequested || attempt.killedFor) await this.runtime.kill(attempt.container);
    const state = await this.runtime.inspect(attempt.container);
    if (state.status === 'running' || state.status === 'unknown') return;
    const c = classify({
      containerExit: state.status === 'exited' ? state.exitCode : null,
      oomKilled: state.status === 'exited' && state.oomKilled,
      missing: state.status === 'missing',
      cancelRequested: job.cancelRequested,
      killedFor: attempt.killedFor,
      killDetail: attempt.killDetail ?? '',
      elapsedS: (this.now() - started) / 1000,
      timeoutS: job.spec.timeoutS,
      diskGb: job.spec.diskGb,
    });
    // The record only. clean() removes the container afterwards: the other order would lose Docker's verdict, and no
    // file the job can write may stand in for it.
    this.finish(job, attempt, c);
  }

  /**
   * The disk limit: a watcher, because md4 is ext4 without the quota and project features, and adding them needs
   * /var/lib/docker unmounted. It runs apart from tick(), so a slow du never delays the deadlines. Between two checks
   * a job can overshoot by what it writes in that time; `--ulimit fsize` bounds any single file exactly.
   */
  async watchDisk(): Promise<void> {
    if (this.watching) return;
    this.watching = true;
    try {
      await Promise.all(this.list('running').map((job) => this.checkDisk(job)));
    } finally {
      this.watching = false;
    }
  }

  private async checkDisk(job: JobRecord): Promise<void> {
    const attempt = job.attempts[job.attempts.length - 1];
    if (job.cancelRequested || attempt.killedFor) return;
    const [files, layer] = await Promise.all([
      dirBytes([this.store.workDir(job.id, attempt.n), this.store.outDir(job.id, attempt.n)]),
      this.runtime.layerBytes(attempt.container),
    ]);
    if (job.state !== 'running' || job.attempts[job.attempts.length - 1] !== attempt) return;
    const limit = `the ${job.spec.diskGb} GB disk limit`;
    let why = '';
    if (files === null || layer === null) {
      // A Docker outage says nothing about the job, and no kill would reach it anyway.
      if (layer === null && !(await this.runtime.ping())) return;
      // Fails closed: a job must not get out of the limit by making its tree impossible to measure.
      const misses = (this.diskMisses.get(attempt.container) ?? 0) + 1;
      this.diskMisses.set(attempt.container, misses);
      if (misses < MAX_DISK_MISSES) return;
      why = `disk use could not be measured ${misses} times in a row, treated as over ${limit}`;
    } else {
      this.diskMisses.delete(attempt.container);
      if (files + layer > job.spec.diskGb * 1024 ** 3) why = `${((files + layer) / 1024 ** 3).toFixed(2)} GB written, over ${limit}`;
    }
    if (!why) return;
    attempt.killedFor = 'disk';
    attempt.killDetail = why;
    this.store.save(job);
    await this.runtime.kill(attempt.container);
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
  }

  /** Why the job cannot start now, or '' when it can. Strict FIFO, so a large job is not passed over for ever. */
  private blockedBy(spec: JobSpec, host: HostState): string {
    const { cpus, memGb } = this.usage();
    if (cpus + spec.cpus > this.cfg.cpuBudget) return `cpu budget: ${cpus} of ${this.cfg.cpuBudget} in use, job needs ${spec.cpus}`;
    if (memGb + spec.memGb > this.cfg.memBudgetGb) return `memory budget: ${memGb} of ${this.cfg.memBudgetGb} GB in use, job needs ${spec.memGb}`;
    if (host.cpuBusyPct === null) return 'host cpu: no reading yet';
    // Busy CPUs, not PSI: see README "CPU budget and the shared host". The job is counted at its full --cpus.
    const adds = (100 * spec.cpus) / host.cpuCount;
    if (host.cpuBusyPct + adds >= this.cfg.cpuBusyMaxPct) {
      return `host cpu: ${host.cpuBusyPct.toFixed(0)} % busy, job adds ${adds.toFixed(0)} %, limit ${this.cfg.cpuBusyMaxPct} %`;
    }
    const floor = host.memTotalGb * this.cfg.memFloorFraction;
    if (host.memAvailableGb - spec.memGb < floor) return `host memory: ${host.memAvailableGb.toFixed(1)} GB available, floor ${floor.toFixed(1)} GB`;
    if (host.diskFreeGb - spec.diskGb < this.cfg.minFreeGb) {
      return `disk: ${host.diskFreeGb.toFixed(1)} GB free, job may use ${spec.diskGb}, floor ${this.cfg.minFreeGb} GB`;
    }
    return '';
  }

  /** Seconds this job has been waiting, whole: since the submit, or for a retry since it came due. */
  private waitedS(job: JobRecord): number {
    return Math.round((this.now() - Date.parse(job.nextAttemptAt ?? job.createdAt)) / 1000);
  }

  /**
   * Into the record every tick, into the events and the journal when the reason changes and every HOLD_REPEAT_MS.
   * The event has from = to, so the state log still reads as states and the client can tell it from a transition.
   */
  private noteHold(job: JobRecord, reason: string): void {
    job.hold = reason;
    const kind = holdKind(reason);
    const last = this.holdLogged.get(job.id);
    if (last?.kind === kind && this.now() - last.at < HOLD_REPEAT_MS) return;
    this.holdLogged.set(job.id, { kind, at: this.now() });
    const detail = `${job.state} for ${this.waitedS(job)} s: ${reason}`;
    this.store.save(job);
    this.store.appendEvent(job.id, { t: this.iso(), from: job.state, to: job.state, attempt: job.attempts.length, detail });
    console.log(`job ${job.id} ${job.spec.name}: ${detail}`);
  }

  /** One start per tick, so that the next job is judged on a host that has seen this one at least begin. */
  private async admit(): Promise<void> {
    const due = (j: JobRecord): boolean => j.state === 'queued' || Date.parse(j.nextAttemptAt ?? '') <= this.now();
    const [next, ...behind] = this.list('queued', 'retrying').filter(due);
    if (!next) {
      this.hold = '';
      return;
    }
    this.hold = this.blockedBy(next.spec, this.host());
    if (!this.hold && !(await this.runtime.ping())) this.hold = 'docker is not answering';
    if (this.hold) {
      this.noteHold(next, this.hold);
      for (const job of behind) this.noteHold(job, `behind ${next.id}: ${this.hold}`);
      return;
    }
    await this.startAttempt(next);
  }

  /**
   * The bound on a wait. The daemon decides it, not the client, so the verdict cannot race a start: a job that ends
   * here has no attempt, and that is what lets a client run the work elsewhere. A retry has run already, so it waits on.
   */
  private expireQueued(): void {
    for (const job of this.list('queued')) {
      const limitS = job.spec.queueWaitS ?? this.cfg.defaultQueueWaitS; // a record from before the bound existed
      if (this.now() - Date.parse(job.createdAt) < limitS * 1000) continue;
      const detail = `queued for ${this.waitedS(job)} s: ${job.hold || 'no hold reason on record'}`;
      job.result = { outcome: 'queue', exitCode: null, detail };
      this.setState(job, 'failed', detail);
      console.log(`job ${job.id} ${job.spec.name}: ${detail}`);
    }
  }

  private async startAttempt(job: JobRecord): Promise<void> {
    const n = job.attempts.length + 1;
    const attempt: Attempt = { n, container: `pcbjob-${job.id}-${n}`, startedAt: this.iso() };
    const waited = n === 1 ? `, after ${this.waitedS(job)} s queued` : '';
    job.attempts.push(attempt);
    job.nextAttemptAt = undefined;
    // Durable before the side effects: a crash from here on leaves "running" with no container, which reconcile
    // sees as an infrastructure failure.
    this.setState(job, 'running', `attempt ${n}${waited}`);
    const workDir = this.store.workDir(job.id, n);
    const outDir = this.store.outDir(job.id, n);
    try {
      // Empty folders only, made by the daemon. The input is unpacked in the container, as the job's uid.
      fs.mkdirSync(`${workDir}/out`, { recursive: true }); // the mount point of outDir
      fs.mkdirSync(outDir);
      if (this.cfg.jobUid !== null) {
        fs.chownSync(workDir, this.cfg.jobUid, this.cfg.jobUid);
        fs.chownSync(outDir, this.cfg.jobUid, this.cfg.jobUid);
      }
    } catch (e) {
      return this.finish(job, attempt, { outcome: 'infra', exitCode: null, detail: `job folder: ${String(e)}` });
    }
    const { image, cpus, memGb, diskGb, timeoutS, command } = job.spec;
    const inputTar = this.store.inputTar(job.id);
    const r = await this.runtime.start({ container: attempt.container, workDir, outDir, inputTar, image, cpus, memGb, diskGb, timeoutS, command });
    if (r.ok) return;
    // The container may exist all the same, if docker run timed out. clean() checks before it touches anything.
    this.finish(job, attempt, { outcome: r.permanent ? 'start' : 'infra', exitCode: null, detail: r.detail });
  }

  /** The disk on this host is shared, so finished jobs do not stay for ever. Hourly is enough for a limit in days. */
  private async sweep(): Promise<void> {
    if (this.now() - this.lastSweep < 3_600_000) return;
    this.lastSweep = this.now();
    const cutoff = this.now() - this.cfg.retainDays * 86_400_000;
    for (const job of this.list('passed', 'failed', 'cancelled')) {
      if (Date.parse(job.updatedAt) >= cutoff || job.attempts.some((a) => !a.trimmed)) continue;
      let emptied = true;
      for (const attempt of job.attempts) {
        if (!(await this.cleanOne(job, attempt, false))) emptied = false;
      }
      if (!emptied) continue; // the next sweep tries again
      await this.store.remove(job.id);
      this.jobs.delete(job.id);
    }
  }
}
