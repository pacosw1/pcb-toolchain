// Cooperating local board jobs: declared CPU and memory reservations, not OS quotas.
// iotroute shares one ledger of flocked tickets (src/job/resources.rs), so the ticket text and locks must stay compatible.
// A crash releases capacity: a ticket is live only while its flock is held, never by PID. Admission is FIFO, bounded and
// interruptible; no unrelated process is stopped. Memory requests are estimates, not RSS limits.
//
// Python raises from a signal handler at any line. Here reserve() races the work with a cancellation, passes the body
// an AbortSignal, and always releases the ticket on the way out.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { holdLock, type HeldLock, LockBusyError, lockHeld } from './file-lock.ts';
import { now } from './lean-clock.ts';
import { DEADLINE_PROTOCOL, inheritedDeadline, remaining } from './lean-workflow.ts';
import { Float, get, item, jsonDumps, jsonLoads, number, PyError, pyRepr, pyStr, readText, splitlines } from './py-compat.mjs';
import { pyFloat } from './py-numbers.ts';
import { textOf } from './py-path.ts';

export const NATIVE_KEYS = ['OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'NUMEXPR_NUM_THREADS', 'BLIS_NUM_THREADS'];
const MAX_DEFAULT_CPUS = 12;
const DEFAULT_MEMORY_GIB = '16';
const DEFAULT_JOB_MEMORY_GIB = '8';
const GUARD_WAIT_S = 5;
const ADMISSION_POLL_S = 0.1;
const PS_TIMEOUT_MS = 3000;
const RSS_LIMITS = 'RSS sums include shared pages and profiler; sampling can miss peaks. ps CPU is lifetime average. VM rates/compression are system-wide, not attributed to this job. No supported GPU memory counter collected.';

type Environment = Record<string, string | undefined>;
type Dict = Map<string, unknown>;

export interface Claim {
  id: string; pid: number; queued_at: Float; status: 'waiting' | 'admitted'; clock_protocol: string; label: string;
  cpu: number; memory_gib: Float; cpu_capacity: number; memory_capacity_gib: Float;
}
export interface ReserveOptions { memoryGib?: number; waitS?: number; events?: string | null; label?: string }
export interface Reservation { env: Environment; signal: AbortSignal }

/** Stage cancelled by a signal: Python's StageCancelled, a KeyboardInterrupt. */
export class StageCancelled extends Error {
  readonly signal: NodeJS.Signals;
  constructor(signal: NodeJS.Signals) {
    super('stage cancelled by signal');
    this.signal = signal;
  }
}

function pyInt(text: string): number {
  if (!/^\s*[+-]?\d+(?:_\d+)*\s*$/.test(text)) throw new PyError('ValueError', `invalid literal for int() with base 10: ${pyRepr(text)}`);
  return Number(text.replaceAll('_', ''));
}

const timeoutError = (message: string) => new PyError('TimeoutError', message);
const sleep = (seconds: number) => new Promise(done => setTimeout(done, seconds * 1000));

/** One native worker per placement process prevents nested oversubscription. */
export const nativeEnv = (env: Environment = process.env): Environment =>
  ({ ...env, ...Object.fromEntries(NATIVE_KEYS.map(key => [key, '1'])) });

export function limits(env: Environment = process.env): [number, number] {
  const cpu = env.IOT_CPU_BUDGET === undefined ? Math.min(MAX_DEFAULT_CPUS, cpus().length || 1) : pyInt(env.IOT_CPU_BUDGET);
  const memory = pyFloat(env.IOT_MEMORY_BUDGET_GIB ?? DEFAULT_MEMORY_GIB);
  if (cpu < 1 || !Number.isFinite(memory) || memory <= 0) throw new PyError('ValueError', 'resource capacities must be finite and positive');
  return [cpu, memory];
}

export const rootDirectory = (env: Environment = process.env): string => env.IOT_RESOURCE_DIRECTORY ?? join(homedir(), '.cache/iot-lab/resources');
export const jobMemory = (env: Environment = process.env): number => pyFloat(env.IOT_JOB_MEMORY_GIB ?? DEFAULT_JOB_MEMORY_GIB);
export const defaultCpu = (env: Environment = process.env): number => (env.IOT_RESOURCE_CPU === undefined ? limits(env)[0] : pyInt(env.IOT_RESOURCE_CPU));

export function event(path: string | null | undefined, values: object): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${jsonDumps({ time_monotonic: new Float(now()), ...values })}\n`);
}

/** Run `work` under the ledger lock, retried until `deadline` on the shared clock. */
async function guarded<T>(root: string, deadline: number, work: () => T | Promise<T>): Promise<T> {
  let guard: HeldLock;
  try {
    guard = await holdLock(join(root, 'guard'), { waitS: Math.max(0, deadline - now()) });
  } catch (error) {
    if (error instanceof LockBusyError) throw timeoutError('resource ledger busy; admission deadline reached');
    throw error;
  }
  try {
    return await work();   // await: async work must finish before the ledger is free again
  } finally {
    await guard.release();
  }
}

const ticketNames = (root: string): string[] => readdirSync(root).filter(name => name.endsWith('.ticket'));

/** Must hold the guard. A locked ticket inode is liveness; a free one is a dead owner, and its checkpoints live elsewhere. */
export function liveClaims(root: string): Dict[] {
  const claims: Dict[] = [];
  for (const name of ticketNames(root)) {
    const path = join(root, name);
    if (lockHeld(path)) claims.push(jsonLoads(readText(path)) as Dict);
    else rmSync(path);
  }
  return claims;
}

export function inherited(cpu: number, memoryGib: number, env: Environment = process.env): boolean {
  const path = env.IOT_RESOURCE_TICKET;
  if (!path) return false;
  const text = readText(path);
  if (!lockHeld(path)) throw new PyError('ValueError', 'inherited resource reservation is no longer live');
  const claim = jsonLoads(text);
  if (item(claim, 'status') !== 'admitted' || cpu > number(item(claim, 'cpu')) || memoryGib > number(item(claim, 'memory_gib'))) {
    throw new PyError('ValueError', 'child request exceeds inherited reservation');
  }
  return true;
}

/** Cap the backend's global Rayon pool within a live reservation. Explicit router pools still need their CLI caps. */
export function routerEnv(cpu: number, env: Environment = process.env): Environment {
  if (!Number.isInteger(cpu) || cpu < 1) throw new PyError('ValueError', 'router CPU request must be a positive integer');
  if (!inherited(cpu, 0, env)) throw new PyError('ValueError', 'router environment requires a live resource reservation');
  return { ...nativeEnv(env), RAYON_NUM_THREADS: String(cpu) };
}

function validate(cpu: number, memoryGib: number, waitS: number, capacity: number, memoryCapacity: number): void {
  if (cpu < 1 || cpu > capacity || !Number.isFinite(memoryGib) || memoryGib <= 0 || memoryGib > memoryCapacity) {
    throw new PyError('ValueError', 'request exceeds cooperating resource capacity');
  }
  if (!Number.isFinite(waitS) || waitS < 0) throw new PyError('ValueError', 'admission wait must be finite and nonnegative');
}

function checkAgreement(active: Dict[], capacity: number, memoryCapacity: number): void {
  if (active.some(claim => get(claim, 'clock_protocol') !== DEADLINE_PROTOCOL)) throw new PyError('ValueError', 'cooperating jobs use incompatible queue clock protocols');
  // All clients must agree on capacities, or an optimistic client breaks a pessimistic client's budget.
  if (active.some(claim => number(item(claim, 'cpu_capacity')) !== capacity || number(item(claim, 'memory_capacity_gib')) !== memoryCapacity)) {
    throw new PyError('ValueError', 'cooperating jobs disagree on resource capacities');
  }
}

const queueOrder = (a: Dict, b: Dict): number =>
  number(item(a, 'queued_at')) - number(item(b, 'queued_at')) || (String(item(a, 'id')) < String(item(b, 'id')) ? -1 : 1);

/** Must hold the guard. FIFO: only the first waiter is admitted, and only if the admitted claims leave room. */
function mayAdmit(root: string, claim: Claim, capacity: number, memoryCapacity: number): boolean {
  const active = liveClaims(root);
  checkAgreement(active, capacity, memoryCapacity);
  const waiting = active.filter(row => item(row, 'status') === 'waiting').sort(queueOrder);
  const admitted = active.filter(row => item(row, 'status') === 'admitted');
  const used = (key: string) => admitted.reduce((sum, row) => sum + number(item(row, key)), 0);
  return item(waiting[0], 'id') === claim.id && used('cpu') + claim.cpu <= capacity
    && used('memory_gib') + claim.memory_gib.value <= memoryCapacity;
}

/** Stops at `signal`: after a cancel nothing may write the ticket again, because release() has removed it. */
async function admit(
  root: string, ticket: string, claim: Claim, deadline: number, hardDeadline: number | null, capacity: number, memoryCapacity: number, signal: AbortSignal,
): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    if (hardDeadline !== null && now() >= hardDeadline) throw timeoutError('end-to-end deadline reached during admission');
    const admitted = await guarded(root, deadline, () => {
      signal.throwIfAborted();
      if (!mayAdmit(root, claim, capacity, memoryCapacity)) return false;
      claim.status = 'admitted';
      writeFileSync(ticket, jsonDumps(claim));
      return true;
    });
    if (admitted) return;
    if (now() >= deadline) throw timeoutError('cooperating resource admission deadline reached');
    await sleep(Math.min(ADMISSION_POLL_S, Math.max(0, deadline - now())));
  }
}

function cancellation(): { cancelled: Promise<never>; signal: AbortSignal; stop(): void } {
  const controller = new AbortController();
  const listeners: [NodeJS.Signals, () => void][] = [];
  const cancelled = new Promise<never>((_, reject) => {
    for (const name of ['SIGTERM', 'SIGINT'] as const) {
      const listener = () => {
        const error = new StageCancelled(name);
        controller.abort(error);
        reject(error);
      };
      process.on(name, listener);
      listeners.push([name, listener]);
    }
  });
  cancelled.catch(() => undefined);   // no unhandled rejection when nothing is waiting on it
  return { cancelled, signal: controller.signal, stop: () => listeners.forEach(([name, listener]) => process.off(name, listener)) };
}

async function release(root: string, ticket: string, lock: HeldLock): Promise<void> {
  try {
    await guarded(root, now() + GUARD_WAIT_S, () => rmSync(ticket, { force: true }));
  } finally {
    await lock.release();
  }
}

/** Reserve capacity for `body`: admitted FIFO within `waitS`, released however the body ends. */
export async function reserve<T>(cpu: number, options: ReserveOptions, body: (reservation: Reservation) => Promise<T>): Promise<T> {
  const { waitS = 30, events = null, label = 'board' } = options;
  const memoryGib = options.memoryGib ?? jobMemory();
  const [capacity, memoryCapacity] = limits();
  validate(cpu, memoryGib, waitS, capacity, memoryCapacity);
  if (remaining() === 0) throw timeoutError('end-to-end deadline reached before admission');
  if (inherited(cpu, memoryGib)) return body({ env: nativeEnv(), signal: new AbortController().signal });
  const root = rootDirectory();
  const started = now();
  const hardDeadline = inheritedDeadline();
  const deadline = hardDeadline === null ? started + waitS : Math.min(started + waitS, hardDeadline);
  const id = randomUUID().replaceAll('-', '');
  const ticket = join(root, `${id}.ticket`);
  const claim: Claim = {
    id, pid: process.pid, queued_at: new Float(started), status: 'waiting', clock_protocol: DEADLINE_PROTOCOL, label, cpu,
    memory_gib: new Float(memoryGib), cpu_capacity: capacity, memory_capacity_gib: new Float(memoryCapacity),
  };
  const lock = await guarded(root, deadline, () => holdLock(ticket).then(held => { writeFileSync(ticket, jsonDumps(claim)); return held; }));
  return withTicket(root, ticket, lock, claim, async stop => {
    event(events, { action: 'queued', ...claim });
    await Promise.race([admit(root, ticket, claim, deadline, hardDeadline, capacity, memoryCapacity, stop.signal), stop.cancelled]);
    event(events, { action: 'admitted', queue_s: new Float(now() - started), ...claim });
    const env = {
      ...nativeEnv(), IOT_RESOURCE_TICKET: ticket, IOT_RESOURCE_CPU: String(cpu), IOT_JOB_MEMORY_GIB: pyStr(new Float(memoryGib)),
    };
    return Promise.race([body({ env, signal: stop.signal }), stop.cancelled]);
  }, started, events);
}

async function withTicket<T>(
  root: string, ticket: string, lock: HeldLock, claim: Claim,
  work: (stop: ReturnType<typeof cancellation>) => Promise<T>, started: number, events: string | null,
): Promise<T> {
  const stop = cancellation();
  try {
    return await work(stop);
  } catch (error) {
    const cancelled = error instanceof StageCancelled;
    event(events, {
      action: cancelled ? 'cancelled' : 'failed', reason: cancelled ? 'StageCancelled' : (error as PyError).type ?? (error as Error).name,
      signal: cancelled ? error.signal : null, queue_s: new Float(now() - started), ...claim,
    });
    throw error;
  } finally {
    stop.stop();
    await release(root, ticket, lock);
    event(events, { action: 'released', ...claim });
  }
}

interface ProcessRow { pid: number; ppid: number; cpu_percent: Float; rss_kib: number }

function processRows(): ProcessRow[] {
  const listing = spawnSync('ps', ['-axo', 'pid,ppid,%cpu,rss'], { encoding: 'utf8', timeout: PS_TIMEOUT_MS });
  return splitlines(listing.stdout ?? '').slice(1).map(line => line.trim().split(/\s+/)).filter(fields => fields.length === 4)
    .map(([pid, ppid, cpu, rss]) => ({ pid: Number(pid), ppid: Number(ppid), cpu_percent: new Float(Number(cpu)), rss_kib: Number(rss) }));
}

function family(rows: ProcessRow[], pid: number): Set<number> {
  const members = new Set([pid]);
  for (let size = 0; size !== members.size;) {
    size = members.size;
    for (const row of rows) if (members.has(row.ppid)) members.add(row.pid);
  }
  return members;
}

function systemCounter(command: string, args: string[]): object {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: PS_TIMEOUT_MS });
  return result.error ? { unavailable: result.error.message } : { returncode: result.status, raw: result.stdout, error: result.stderr };
}

/** One resource sample of `pid` and its descendants. */
export function sample(pid: number): object {
  const rows = processRows();
  const members = family(rows, pid);
  return {
    monotonic: new Float(now()), processes: rows.filter(row => members.has(row.pid)), gpu_memory_bytes: null,
    gpu_memory_note: 'no supported process GPU counter collected',
    vm_stat: systemCounter('vm_stat', []), swapusage: systemCounter('sysctl', ['vm.swapusage']),
  };
}

function vmCounters(raw: string): { page: number; counts: Map<string, number> } {
  const page = /page size of (\d+) bytes/.exec(raw);
  const counts = new Map([...raw.matchAll(/^([^:\n]+):\s+(\d+)\./gm)].map(match => [match[1]!.trim(), Number(match[2])]));
  return { page: page ? Number(page[1]) : 0, counts };
}

const familyRss = (row: Dict): number => (item(row, 'processes') as Dict[]).reduce((sum, process) => sum + number(item(process, 'rss_kib')) * 1024, 0);

function vmRates(rows: { at: number; page: number; counts: Map<string, number> }[]): object | null {
  const first = rows[0]!;
  const last = rows.at(-1)!;
  const seconds = last.at - first.at;
  if (seconds <= 0 || first.page !== last.page) return null;
  const rate = (key: string) => new Float((((last.counts.get(key) ?? 0) - (first.counts.get(key) ?? 0)) * last.page) / seconds);
  return Object.fromEntries(['Swapins', 'Swapouts', 'Pageins', 'Pageouts'].map(key => [key, rate(key)]));
}

/** The profile of a samples.jsonl: peak family RSS and system-wide VM movement, with what that cannot show. */
export function summarize(path: string): object {
  const valid = splitlines(textOf(path)).map(line => jsonLoads(line) as Dict).filter(row => row.has('processes'));
  const vm = valid.filter(row => get(get(row, 'vm_stat', new Map()), 'returncode') !== null && number(get(get(row, 'vm_stat', new Map()), 'returncode', 1n)) === 0)
    .map(row => ({ at: number(item(row, 'monotonic')), ...vmCounters(String(get(get(row, 'vm_stat', new Map()), 'raw', ''))) }));
  const peak = (key: string) => Math.max(...vm.map(row => (row.counts.get(key) ?? 0) * row.page));
  return {
    sample_count: valid.length, peak_observed_family_rss_bytes: Math.max(0, ...valid.map(familyRss)),
    system_vm_rates_bytes_s: vm.length > 1 ? vmRates(vm) : null,
    system_compression: vm.length > 1 ? { peak_physical_bytes: peak('Pages occupied by compressor'), peak_logical_bytes: peak('Pages stored in compressor') } : null,
    gpu_memory_bytes: null, limitations: RSS_LIMITS,
  };
}
