import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { holdLock } from './file-lock.ts';
import { inherited, jobMemory, limits, liveClaims, nativeEnv, NATIVE_KEYS, reserve, routerEnv, StageCancelled, summarize } from './lean-resources.ts';
import { DEADLINE_PROTOCOL } from './lean-workflow.ts';
import { jsonDumps, PyError } from './py-compat.mjs';

let root: string;
const saved = { ...process.env };
const pyType = (type: string) => (error: unknown) => error instanceof PyError && (error as PyError).type === type;
const tickets = () => readdirSync(root).filter(name => name.endsWith('.ticket'));
const claim = (id: string, status: string, extra: object = {}) => jsonDumps({
  id, pid: 1, queued_at: 1.5, status, clock_protocol: DEADLINE_PROTOCOL, label: 'x', cpu: 1, memory_gib: 1, cpu_capacity: 4, memory_capacity_gib: 8, ...extra,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lean-resources-'));
  Object.assign(process.env, { IOT_RESOURCE_DIRECTORY: root, IOT_CPU_BUDGET: '4', IOT_MEMORY_BUDGET_GIB: '8', IOT_JOB_MEMORY_GIB: '2' });
  delete process.env.IOT_RESOURCE_TICKET;
  delete process.env.IOT_LEAN_DEADLINE;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  process.env = { ...saved };
});

test('capacities come from the environment and must be positive', () => {
  assert.deepEqual(limits(), [4, 8]);
  assert.equal(jobMemory(), 2);
  assert.throws(() => limits({ IOT_CPU_BUDGET: '0' }), pyType('ValueError'));
  assert.throws(() => limits({ IOT_CPU_BUDGET: '2', IOT_MEMORY_BUDGET_GIB: 'inf' }), pyType('ValueError'));
  assert.throws(() => limits({ IOT_CPU_BUDGET: 'many' }), pyType('ValueError'));
});

test('native env pins each numeric library to one thread', () => {
  const env = nativeEnv({ KEEP: 'x', OMP_NUM_THREADS: '8' });
  assert.equal(env.KEEP, 'x');
  assert.ok(NATIVE_KEYS.every(key => env[key] === '1'));
});

test('a free ticket is a dead owner and is removed; a held one is a live claim', async () => {
  writeFileSync(join(root, 'dead.ticket'), claim('dead', 'admitted'));
  const path = join(root, 'live.ticket');
  const lock = await holdLock(path);
  writeFileSync(path, claim('live', 'admitted'));
  const claims = liveClaims(root);
  assert.deepEqual(claims.map(row => row.get('id')), ['live']);
  assert.deepEqual(tickets(), ['live.ticket']);
  await lock.release();
});

test('a reservation runs the body, writes a Python-readable ticket and releases it', async () => {
  const events = join(root, 'log/events.jsonl');
  const seen = await reserve(2, { memoryGib: 3, events, label: 'test' }, async ({ env }) => {
    const ticket = JSON.parse(readFileSync(env.IOT_RESOURCE_TICKET!, 'utf8'));
    assert.equal(ticket.status, 'admitted');
    assert.equal(ticket.clock_protocol, DEADLINE_PROTOCOL);
    assert.deepEqual([ticket.cpu, ticket.memory_gib, ticket.cpu_capacity, ticket.memory_capacity_gib, ticket.label], [2, 3, 4, 8, 'test']);
    assert.equal(env.IOT_RESOURCE_CPU, '2');
    assert.equal(env.IOT_JOB_MEMORY_GIB, '3.0');
    assert.equal(tickets().length, 1);
    return 'done';
  });
  assert.equal(seen, 'done');
  assert.deepEqual(tickets(), []);
  const lines = readFileSync(events, 'utf8').trim().split('\n');
  assert.deepEqual(lines.map(line => JSON.parse(line).action), ['queued', 'admitted', 'released']);
  assert.match(lines[0]!, /"memory_gib": 3\.0/);
});

test('a request over capacity is refused before any ticket', async () => {
  await assert.rejects(reserve(5, {}, async () => 0), pyType('ValueError'));
  await assert.rejects(reserve(1, { memoryGib: 9 }, async () => 0), pyType('ValueError'));
  await assert.rejects(reserve(1, { waitS: -1 }, async () => 0), pyType('ValueError'));
  assert.deepEqual(tickets(), []);
});

test('capacity held by another job times out, and the ticket goes away', async () => {
  const path = join(root, 'other.ticket');
  const lock = await holdLock(path);
  writeFileSync(path, claim('other', 'admitted', { cpu: 4 }));
  await assert.rejects(reserve(1, { waitS: 0.2 }, async () => 0), (error: unknown) => pyType('TimeoutError')(error) && /admission deadline/.test((error as Error).message));
  assert.deepEqual(tickets(), ['other.ticket']);
  await lock.release();
});

test('jobs with other capacities or clock protocols are refused', async () => {
  const path = join(root, 'other.ticket');
  const lock = await holdLock(path);
  writeFileSync(path, claim('other', 'admitted', { cpu_capacity: 2 }));
  await assert.rejects(reserve(1, {}, async () => 0), /disagree on resource capacities/);
  writeFileSync(path, claim('other', 'admitted', { clock_protocol: 'other:' }));
  await assert.rejects(reserve(1, {}, async () => 0), /incompatible queue clock protocols/);
  await lock.release();
});

test('a failed body still releases its ticket and records why', async () => {
  const events = join(root, 'e.jsonl');
  await assert.rejects(reserve(1, { events }, async () => { throw new PyError('ValueError', 'boom'); }), /boom/);
  assert.deepEqual(tickets(), []);
  const rows = readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.slice(-2).map(row => [row.action, row.reason ?? null]), [['failed', 'ValueError'], ['released', null]]);
});

test('a signal cancels the body, aborts its signal and releases the ticket', async () => {
  const events = join(root, 'e.jsonl');
  let aborted = false;
  const run = reserve(1, { events }, ({ signal }) => new Promise(() => {
    signal.addEventListener('abort', () => { aborted = true; });
    process.emit('SIGTERM');
  }));
  await assert.rejects(run, StageCancelled);
  assert.equal(aborted, true);
  assert.deepEqual(tickets(), []);
  const rows = readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual([rows.at(-2).action, rows.at(-2).signal], ['cancelled', 'SIGTERM']);
  assert.equal(process.listenerCount('SIGTERM'), 0);
});

test('a cancel during admission stops the queue loop, so the ticket stays gone', async () => {
  const path = join(root, 'other.ticket');
  const lock = await holdLock(path);
  writeFileSync(path, claim('other', 'admitted', { cpu: 4 }));
  const run = reserve(1, { waitS: 5 }, async () => 0);
  await new Promise(done => setTimeout(done, 300));
  assert.equal(tickets().length, 2, 'queued behind the other job');
  process.emit('SIGTERM');
  await assert.rejects(run, StageCancelled);
  await lock.release();   // capacity frees: a loop still running would now admit and write its ticket back
  await new Promise(done => setTimeout(done, 400));
  assert.deepEqual(tickets(), ['other.ticket']);
});

test('two jobs for all the capacity run one after the other', async () => {
  let running = 0;
  let peak = 0;
  const job = () => reserve(4, { waitS: 10 }, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise(done => setTimeout(done, 150));
    running -= 1;
  });
  await Promise.all([job(), job()]);
  assert.equal(peak, 1);
  assert.deepEqual(tickets(), []);
});

test('an inherited reservation needs a live, large enough, admitted ticket', async () => {
  const path = join(root, 'parent.ticket');
  const lock = await holdLock(path);
  writeFileSync(path, claim('parent', 'admitted', { cpu: 2, memory_gib: 4 }));
  const env = { IOT_RESOURCE_TICKET: path };
  assert.equal(inherited(2, 4, env), true);
  assert.equal(routerEnv(2, env).RAYON_NUM_THREADS, '2');
  assert.throws(() => inherited(3, 1, env), /exceeds inherited reservation/);
  assert.throws(() => routerEnv(0, env), /positive integer/);
  await lock.release();
  assert.throws(() => inherited(1, 1, env), /no longer live/);
  assert.equal(inherited(1, 1, {}), false);
  assert.throws(() => routerEnv(1, {}), /requires a live resource reservation/);
  assert.throws(() => inherited(1, 1, { IOT_RESOURCE_TICKET: join(root, 'gone') }), pyType('FileNotFoundError'));
});

test('a child inside an inherited reservation takes no new ticket', async () => {
  const path = join(root, 'parent.ticket');
  const lock = await holdLock(path);
  writeFileSync(path, claim('parent', 'admitted', { cpu: 2, memory_gib: 4 }));
  process.env.IOT_RESOURCE_TICKET = path;
  assert.equal(await reserve(1, { memoryGib: 1 }, async ({ env }) => env.OMP_NUM_THREADS), '1');
  assert.deepEqual(tickets(), ['parent.ticket']);
  await lock.release();
});

test('summarize reports peak family RSS and system VM movement', () => {
  mkdirSync(join(root, 'p'));
  const vm = (pageins: number) => ({ returncode: 0, raw: `Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPageins:   ${pageins}.\nPages occupied by compressor:  10.\n` });
  const path = join(root, 'p/samples.jsonl');
  writeFileSync(path, [
    { monotonic: 10.0, processes: [{ rss_kib: 1 }, { rss_kib: 2 }], vm_stat: vm(100) },
    { unavailable: 'x' },
    { monotonic: 12.0, processes: [{ rss_kib: 5 }], vm_stat: vm(300) },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const summary = JSON.parse(jsonDumps(summarize(path)));
  assert.equal(summary.sample_count, 2);
  assert.equal(summary.peak_observed_family_rss_bytes, 5 * 1024);
  assert.equal(summary.system_vm_rates_bytes_s.Pageins, (200 * 4096) / 2);
  assert.equal(summary.system_compression.peak_physical_bytes, 10 * 4096);
  assert.equal(existsSync(path), true);
});
