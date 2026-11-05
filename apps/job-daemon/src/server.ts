import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BoardLeases } from './board-leases.ts';
import type { BoardLease } from './board-leases.ts';
import { LiveEvents } from './live-events.ts';
import type { LiveInput } from './live-events.ts';
import { BlobStore, isSha256, parseManifest } from './blobs.ts';
import { LiveJobBridge } from './live-jobs.ts';
import { exec, lowPriority } from './docker.ts';
import type { JobManager } from './manager.ts';
import { validateSpec } from './manager.ts';
import { openNoFollow } from './store.ts';
import { HttpError, isTerminal } from './types.ts';
import type { JobRecord } from './types.ts';

/** Sockets, idle ones included. Past this Node closes new connections. Above uploads + streams. A default to tune. */
const MAX_CONNECTIONS = 256;
/** Most recent jobs in GET /jobs. A default to tune. */
const MAX_LIST = 500;
/** A manifest or a hash list as JSON. Above the 300 kB of a real job. A default to tune. */
const MAX_JSON_BYTES = 16 * 1024 * 1024;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

function authorized(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') && timingSafeEqual(sha(header.slice(7)), sha(token));
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body) + '\n');
}

/** The tar is extracted as root, so it is refused here if any entry could leave the job folder. */
export async function checkTar(file: string, signal: AbortSignal): Promise<void> {
  const [cmd, args] = lowPriority('tar', ['-tzf', file]);
  const r = await exec(cmd, args, 60_000, { signal });
  if (r.code !== 0) throw new HttpError(400, 'body is not a gzip tar');
  for (const name of r.stdout.split('\n')) {
    if (name.startsWith('/') || name.split('/').includes('..')) throw new HttpError(400, `unsafe path in tar: ${name}`);
  }
}

async function readJson(req: http.IncomingMessage, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new HttpError(413, `body over ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not JSON');
  }
}

function parseLease(value: unknown): BoardLease {
  const lease = value as Partial<BoardLease> | null;
  if (!lease || typeof lease.board !== 'string' || !lease.board || lease.board.length > 512 ||
      typeof lease.owner !== 'string' || !lease.owner || lease.owner.length > 256 ||
      typeof lease.token !== 'string' || !/^[0-9a-f]{64}$/.test(lease.token) ||
      !Number.isSafeInteger(lease.generation) || (lease.generation ?? 0) < 1 ||
      typeof lease.expiresAt !== 'number' || !Number.isSafeInteger(lease.expiresAt))
    throw new HttpError(400, 'invalid lease');
  return lease as BoardLease;
}

async function receive(req: http.IncomingMessage, dir: string, maxBytes: number): Promise<string> {
  const file = path.join(dir, `${randomBytes(8).toString('hex')}.tar.gz`);
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      cb(bytes > maxBytes ? new HttpError(413, `upload over ${maxBytes} bytes`) : null, chunk);
    },
  });
  try {
    await pipeline(req, limit, fs.createWriteStream(file));
    return file;
  } catch (e) {
    await fs.promises.rm(file, { force: true });
    throw e;
  }
}

/**
 * Sends a file from `offset`. With follow it keeps reading until done() is true and the file is drained. It reads
 * from disk, not from a live pipe, so a client that lost its connection resumes from the offset it holds.
 *
 * The file may be job.log, which the job can swap at any moment, and this process is root. So it is opened once with
 * openNoFollow() and every read is on that descriptor; the name is not used again. A file that is not regular reads
 * as empty. The size is bounded by `--ulimit fsize`.
 */
async function tail(res: http.ServerResponse, file: string, offset: number, follow: boolean, done: () => boolean): Promise<void> {
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  const writable = (): Promise<void> =>
    new Promise((ok) => {
      const go = (): void => {
        res.off('drain', go);
        res.off('close', go);
        ok();
      };
      res.once('drain', go);
      res.once('close', go); // a reader that goes away never drains; its slot must come back
    });
  const buf = Buffer.allocUnsafe(64 * 1024);
  let fd: number | null = null;
  let pos = offset;
  try {
    for (;;) {
      const finished = !follow || done(); // read before the drain, so nothing written before "done" is missed
      fd ??= openNoFollow(file);
      const n = fd === null ? 0 : fs.readSync(fd, buf, 0, buf.length, pos);
      if (n > 0) {
        pos += n;
        if (!res.write(Buffer.from(buf.subarray(0, n)))) await writable();
        if (closed) return;
        continue;
      }
      if (finished || closed) break;
      await sleep(500);
    }
    res.end();
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function offsetOf(url: URL): number {
  const v = Number(url.searchParams.get('offset') ?? '0');
  if (!Number.isInteger(v) || v < 0) throw new HttpError(400, 'bad offset');
  return v;
}

function sendResults(res: http.ServerResponse, mgr: JobManager, job: JobRecord): void {
  if (!isTerminal(job.state)) throw new HttpError(409, `job is ${job.state}`);
  // Until then the container may not be confirmed gone, and out/ may still hold links.
  if (job.attempts.some((a) => !a.trimmed)) throw new HttpError(409, 'results are not ready: cleanup is running');
  const dir = mgr.store.jobDir(job.id);
  const last = job.attempts.length;
  // out/ of the last attempt, the logs of earlier attempts, and the record: the evidence of how it got here. The job
  // has ended, so nothing can change this tree. trimAttempt left regular files and folders only, and tar does not
  // follow links without -h, so no entry can reach outside out/.
  const args = ['-czf', '-', '-C', dir, 'job.json', 'events.jsonl'];
  for (let n = 1; n < last; n++) {
    if (fs.lstatSync(mgr.store.logFile(job.id, n), { throwIfNoEntry: false })?.isFile()) args.push(`attempts/${n}/out/job.log`);
  }
  if (last > 0 && fs.lstatSync(mgr.store.outDir(job.id, last), { throwIfNoEntry: false })?.isDirectory()) {
    args.push('-C', mgr.store.attemptDir(job.id, last), 'out');
  }
  const tar = spawn('tar', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  res.writeHead(200, { 'content-type': 'application/gzip' });
  tar.stdout.pipe(res);
  res.on('close', () => tar.kill());
}

/** Counts work that holds a process, a file or a socket for a long time. */
class Slots {
  active = 0;
  what: string;
  limit: number;

  constructor(what: string, limit: number) {
    this.what = what;
    this.limit = limit;
  }

  /** The caller releases when the work has really ended, which can be after the client has gone. */
  take(): () => void {
    if (this.active >= this.limit) throw new HttpError(503, `busy: ${this.active} ${this.what} in progress, limit ${this.limit}`);
    this.active += 1;
    return () => {
      this.active -= 1;
    };
  }

  /** For work that ends with the response. */
  untilClose(res: http.ServerResponse): void {
    res.once('close', this.take());
  }
}

async function route(req: http.IncomingMessage, res: http.ServerResponse, mgr: JobManager, uploads: Slots, streams: Slots, blobs: BlobStore, leases: BoardLeases, live: LiveEvents, sourceSha256: string | null): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const method = req.method ?? 'GET';
  if (url.pathname === '/live/identity' && method === 'GET') return json(res, 200, { epoch: live.epoch, maxSnapshotBytes: Math.min(20 * 1024 * 1024, mgr.cfg.maxUploadMb * 1024 * 1024) });
  if (url.pathname === '/board-leases/status' && method === 'GET') {
    const board = url.searchParams.get('board');
    if (!board || board.length > 512) throw new HttpError(400, 'invalid board');
    return json(res, 200, leases.status(board));
  }
  if (url.pathname === '/board-revisions' && method === 'GET') {
    const board = url.searchParams.get('board');
    if (!board || board.length > 512) throw new HttpError(400, 'invalid board');
    return json(res, 200, leases.boardMeta(board));
  }
  if (url.pathname === '/board-revisions' && method === 'POST') {
    const release = uploads.take();
    try {
      const body = await readJson(req, 28 * 1024 * 1024) as { lease?: unknown; expected?: unknown; content?: unknown } | null;
      const lease = parseLease(body?.lease);
      if (body?.expected !== null && (!Number.isSafeInteger(body?.expected) || (body?.expected as number) < 1))
        throw new HttpError(400, 'invalid expected revision');
      if (typeof body?.content !== 'string' || body.content.length > 27_962_028)
        throw new HttpError(400, 'invalid board content');
      const bytes = Buffer.from(body.content, 'base64');
      if (bytes.toString('base64') !== body.content) throw new HttpError(400, 'invalid board content');
      try { return json(res, 200, leases.publish(lease, body.expected as number | null, bytes)); }
      catch (error) { throw new HttpError(409, error instanceof Error ? error.message : 'cannot publish board'); }
    } finally { release(); }
  }
  if (url.pathname === '/live/state' && method === 'GET') return json(res, 200, live.current());
  if (url.pathname === '/live/models' && method === 'POST') {
    const body = await readJson(req) as { cursor?: unknown } | null;
    try { return json(res, 200, live.requestModel(body?.cursor as number)); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'invalid model request'); }
  }
  if (url.pathname === '/live/models' && method === 'GET') {
    try { return json(res, 200, live.pendingModels(url.searchParams.get('source') ?? '')); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'invalid source'); }
  }
  const model = /^\/live\/models\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (model && method === 'GET') {
    const result = live.model(model[1]); if (!result) throw new HttpError(404, 'model request not found');
    return json(res, 200, result);
  }
  if (model && method === 'POST') {
    const body = await readJson(req) as { source?: unknown; modelSha?: unknown; error?: unknown } | null;
    try { return json(res, 200, live.finishModel(model[1], body?.source as string, (body?.modelSha ?? null) as string | null, (body?.error ?? null) as string | null)); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'invalid model result'); }
  }
  if (url.pathname === '/live/history' && method === 'GET') {
    const source = url.searchParams.get('source') ?? '', board = url.searchParams.get('board') ?? '', run = url.searchParams.get('run') ?? '';
    const after = Number(url.searchParams.get('after') ?? '0');
    try { return json(res, 200, live.history(source, board, run, after, Math.max(0, Date.now() - mgr.cfg.blobKeepDays * 86_400_000))); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'invalid history request'); }
  }
  if (url.pathname === '/live/events/batch' && method === 'POST') {
    const value = await readJson(req, 2 * 1024 * 1024);
    if (!Array.isArray(value)) throw new HttpError(400, 'invalid event batch');
    try { return json(res, 200, live.appendBatch(value as LiveInput[])); }
    catch (e) { throw new HttpError(400, e instanceof Error ? e.message : 'invalid event batch'); }
  }
  if (url.pathname === '/live/events' && method === 'POST') {
    const value = await readJson(req);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid event');
    try { return json(res, 200, live.append(value as LiveInput)); }
    catch (e) { throw new HttpError(400, e instanceof Error ? e.message : 'invalid event'); }
  }
  if (url.pathname === '/live/events' && method === 'GET') {
    const cursor = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? '0');
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new HttpError(400, 'invalid cursor');
    const epoch = url.searchParams.get('epoch');
    if (epoch !== null && epoch !== live.epoch) throw new HttpError(409, 'coordinator history changed; reload state');
    if (cursor > live.head()) throw new HttpError(409, 'cursor is ahead of coordinator history; reload state');
    if (url.searchParams.get('follow') !== '1') return json(res, 200, live.after(cursor));
    streams.untilClose(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.write(': connected\n\n');
    let position = cursor, pumping = false, closed = false;
    const pump = (): void => {
      if (pumping || closed) return;
      pumping = true;
      const batch = live.after(position);
      for (const event of batch) {
        if (res.writableLength > 1024 * 1024) { res.destroy(); break; }
        res.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`);
        position = event.cursor;
      }
      pumping = false;
      if (batch.length === 500 && !closed) setImmediate(safePump);
    };
    const safePump = (): void => { try { pump(); } catch { res.destroy(); } };
    const off = live.subscribe(safePump);
    const heartbeat = setInterval(() => { if (!closed) res.write(': heartbeat\n\n'); }, 15_000);
    res.once('close', () => { closed = true; clearInterval(heartbeat); off(); });
    safePump();
    return;
  }
  if (url.pathname === '/board-leases/acquire' && method === 'POST') {
    const body = await readJson(req) as { board?: unknown; owner?: unknown; ttlMs?: unknown } | null;
    if (!body || typeof body.board !== 'string' || !body.board || body.board.length > 512 ||
        typeof body.owner !== 'string' || !body.owner || body.owner.length > 256 ||
        typeof body.ttlMs !== 'number' || !Number.isSafeInteger(body.ttlMs) || body.ttlMs < 1000 || body.ttlMs > 300_000)
      throw new HttpError(400, 'invalid lease request');
    if (live.hasObservedWriter(body.board, Date.now() - 45_000)) throw new HttpError(409, 'board has an observed unguarded writer');
    const lease = leases.acquire(body.board, body.owner, body.ttlMs);
    if (!lease) throw new HttpError(409, 'board is leased');
    return json(res, 201, lease);
  }
  if (['/board-leases/renew', '/board-leases/release', '/board-leases/commit-begin', '/board-leases/commit-end'].includes(url.pathname) && method === 'POST') {
    const body = await readJson(req) as { lease?: Partial<BoardLease>; ttlMs?: unknown } | null;
    const lease = parseLease(body?.lease);
    if (url.pathname.endsWith('/release')) {
      if (!leases.release(lease as BoardLease)) throw new HttpError(409, 'lease expired or replaced');
      return json(res, 200, { released: true });
    }
    if (url.pathname.endsWith('/commit-begin')) {
      if (live.hasObservedWriter(lease.board, Date.now() - 45_000)) throw new HttpError(409, 'board has an observed unguarded writer');
      if (!leases.beginCommit(lease as BoardLease)) throw new HttpError(409, 'lease expired or replaced');
      return json(res, 200, { pinned: true });
    }
    if (url.pathname.endsWith('/commit-end')) {
      if (!leases.endCommit(lease as BoardLease)) throw new HttpError(409, 'commit is not pinned by this lease');
      return json(res, 200, { pinned: false });
    }
    if (typeof body?.ttlMs !== 'number' || !Number.isSafeInteger(body.ttlMs) || body.ttlMs < 1000 || body.ttlMs > 300_000)
      throw new HttpError(400, 'invalid lease duration');
    const renewed = leases.renew(lease as BoardLease, body.ttlMs);
    if (!renewed) throw new HttpError(409, 'lease expired or replaced');
    return json(res, 200, renewed);
  }
  if (url.pathname === '/status' && method === 'GET') return json(res, 200, { ...mgr.status(), sourceSha256 });
  if (url.pathname === '/jobs' && method === 'GET') {
    const raw = url.searchParams.get('limit');
    const limit = raw === null ? MAX_LIST : Number(raw);
    if (raw === '' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) {
      throw new HttpError(400, `limit must be an integer in 1..${MAX_LIST}`);
    }
    return json(res, 200, [...mgr.jobs.values()].sort((a, b) => b.seq - a.seq).slice(0, limit));
  }
  if (url.pathname === '/blobs/missing' && method === 'POST') {
    const hashes = ((await readJson(req)) as { sha256?: unknown } | null)?.sha256;
    if (!Array.isArray(hashes) || !hashes.every(isSha256)) throw new HttpError(400, 'sha256 must be a list of hashes');
    return json(res, 200, { missing: blobs.missing(hashes) });
  }
  const blob = /^\/blobs\/([^/]+)$/.exec(url.pathname);
  if (blob && method === 'GET') {
    const file = blobs.read(blob[1]);
    streams.untilClose(res);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=3600' });
    file.on('error', () => res.destroy());
    res.on('close', () => file.destroy());
    file.pipe(res);
    return;
  }
  if (blob && method === 'PUT') {
    if (!isSha256(blob[1])) throw new HttpError(400, 'bad sha256');
    const release = uploads.take();
    try {
      await blobs.put(req, blob[1], mgr.cfg.maxUploadMb * 1024 * 1024);
      return json(res, 201, { sha256: blob[1] });
    } finally {
      release();
    }
  }
  if (url.pathname === '/jobs' && method === 'POST') {
    const header = req.headers['x-job-spec'];
    if (typeof header !== 'string') throw new HttpError(400, 'x-job-spec header missing');
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    } catch {
      throw new HttpError(400, 'x-job-spec is not base64 JSON');
    }
    const spec = validateSpec(raw, mgr.cfg);
    mgr.assertQueueRoom();
    const maxBytes = mgr.cfg.maxUploadMb * 1024 * 1024;
    if (Number(req.headers['content-length'] ?? 0) > maxBytes) throw new HttpError(413, `upload over ${maxBytes} bytes`);
    // The slot covers the upload, the validation and its cleanup, so it must outlive a client that leaves. A client
    // that leaves cancels the validation.
    const release = uploads.take();
    const left = new AbortController();
    res.once('close', () => left.abort());
    let file = '';
    try {
      if (req.headers['content-type'] === 'application/json') {
        file = await blobs.buildTar(parseManifest(await readJson(req)), maxBytes, left.signal);
        const now = Date.now();
        blobs.sweep(now, () => live.retainedBlobs(now - mgr.cfg.blobKeepDays * 86_400_000));
      } else {
        file = await receive(req, mgr.store.incomingDir(), maxBytes);
      }
      await checkTar(file, left.signal);
      return json(res, 201, mgr.submit(spec, file));
    } finally {
      if (file) await fs.promises.rm(file, { force: true });
      release();
    }
  }
  const m = /^\/jobs\/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})(?:\/(cancel|log|events|results|live))?$/.exec(url.pathname);
  const job = m ? mgr.jobs.get(m[1]) : undefined;
  if (!m || !job) throw new HttpError(404, 'not found');
  const follow = url.searchParams.get('follow') === '1';
  switch (`${method} ${m[2] ?? ''}`) {
    case 'GET ':
      return json(res, 200, job);
    case 'POST cancel':
      return json(res, 200, mgr.cancel(job.id));
    case 'GET events':
      streams.untilClose(res);
      return tail(res, mgr.store.eventsFile(job.id), offsetOf(url), follow, () => isTerminal(job.state));
    case 'GET live': {
      const n = Number(url.searchParams.get('attempt') ?? job.attempts.length);
      if (!job.attempts.some(a => a.n === n)) throw new HttpError(404, 'no such attempt');
      const kind = url.searchParams.get('kind') ?? 'route';
      const names: Record<string, string> = { route: 'live-route.json', placement: 'live-place.json', 'route-base': 'live-route-base.kicad_pcb' };
      if (!Object.hasOwn(names, kind)) throw new HttpError(400, 'invalid preview kind');
      const fd = openNoFollow(path.join(mgr.store.outDir(job.id, n), names[kind]));
      if (fd === null) throw new HttpError(404, 'no preview');
      try {
        const size = fs.fstatSync(fd).size;
        if (size > 20 * 1024 * 1024) throw new HttpError(413, 'route preview too large');
        const buf = Buffer.allocUnsafe(size + 1);
        const nread = fs.readSync(fd, buf, 0, buf.length, 0);
        if (nread !== size) throw new HttpError(409, 'route preview changed while reading');
        const bytes = buf.subarray(0, nread);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(bytes);
        return;
      } finally { fs.closeSync(fd); }
    }
    case 'GET log': {
      const n = Number(url.searchParams.get('attempt') ?? job.attempts.length);
      const attempt = job.attempts.find((a) => a.n === n);
      if (!attempt) throw new HttpError(404, 'no such attempt');
      streams.untilClose(res);
      return tail(res, mgr.store.logFile(job.id, n), offsetOf(url), follow, () => attempt.endedAt !== undefined);
    }
    case 'GET results':
      streams.untilClose(res);
      return sendResults(res, mgr, job);
    default:
      throw new HttpError(405, 'method not allowed');
  }
}

export function createServer(mgr: JobManager, sourceSha256: string | null = null): http.Server {
  const uploads = new Slots('uploads', mgr.cfg.maxUploads);
  const streams = new Slots('streams', mgr.cfg.maxStreams);
  const blobs = new BlobStore(mgr.store.blobsDir(), mgr.store.incomingDir(), mgr.cfg.blobKeepDays);
  const leases = new BoardLeases(path.join(mgr.store.root, 'board-leases.sqlite'));
  const live = new LiveEvents(path.join(mgr.store.root, 'live-events.sqlite'));
  const bridge = new LiveJobBridge(mgr, live, blobs);
  const liveTimer = setInterval(() => { try { bridge.scan(); } catch (error) { console.error('live job bridge:', error); } }, 2000);
  liveTimer.unref();
  const server = http.createServer((req, res) => {
    if (!authorized(req, mgr.cfg.token)) {
      res.setHeader('connection', 'close');
      return json(res, 401, { error: 'unauthorized' });
    }
    route(req, res, mgr, uploads, streams, blobs, leases, live, sourceSha256).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (res.headersSent) return res.destroy();
      res.setHeader('connection', 'close');
      json(res, status, { error: e instanceof Error ? e.message : String(e) });
    });
  });
  server.once('close', () => { clearInterval(liveTimer); leases.close(); live.close(); });
  server.maxConnections = MAX_CONNECTIONS;
  // Node's default of 300 s fails a large file on a slow link; the file then starts again from nothing.
  server.requestTimeout = mgr.cfg.requestTimeoutS * 1000;
  return server;
}

/** Local-only status endpoint; the caller must bind it to loopback. */
export function createHealthServer(mgr: JobManager, sourceSha256: string): http.Server {
  const server = http.createServer((req, res) => {
    if (!authorized(req, mgr.cfg.token)) return json(res, 401, { error: 'unauthorized' });
    if (req.method !== 'GET' || req.url !== '/status') return json(res, 404, { error: 'not found' });
    return json(res, 200, { ...mgr.status(), sourceSha256 });
  });
  server.maxConnections = 32;
  server.requestTimeout = 5000;
  return server;
}
