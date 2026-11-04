import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { exec } from './docker.ts';
import type { JobManager } from './manager.ts';
import { validateSpec } from './manager.ts';
import { HttpError, isTerminal } from './types.ts';
import type { JobRecord } from './types.ts';

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
export async function checkTar(file: string): Promise<void> {
  const r = await exec('tar', ['-tzf', file], 60_000);
  if (r.code !== 0) throw new HttpError(400, 'body is not a gzip tar');
  for (const name of r.stdout.split('\n')) {
    if (name.startsWith('/') || name.split('/').includes('..')) throw new HttpError(400, `unsafe path in tar: ${name}`);
  }
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
    fs.rmSync(file, { force: true });
    throw e;
  }
}

/**
 * Sends a file from `offset`. With follow it keeps reading until done() is true and the file is drained. It reads
 * from disk, not from a live pipe, so a client that lost its connection resumes from the offset it holds.
 */
async function tail(res: http.ServerResponse, file: string, offset: number, follow: boolean, done: () => boolean): Promise<void> {
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  let pos = offset;
  for (;;) {
    const finished = !follow || done(); // read before the drain, so nothing written before "done" is missed
    // lstat: the job owns out/, and this process is root. A job.log that is a symlink must not be followed.
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    const size = st?.isFile() ? st.size : 0;
    if (size > pos) {
      const stream = fs.createReadStream(file, { start: pos, end: size - 1 });
      for await (const chunk of stream) {
        if (closed) {
          stream.destroy();
          return;
        }
        if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
      }
      pos = size;
      continue;
    }
    if (finished || closed) break;
    await sleep(500);
  }
  res.end();
}

function offsetOf(url: URL): number {
  const v = Number(url.searchParams.get('offset') ?? '0');
  if (!Number.isInteger(v) || v < 0) throw new HttpError(400, 'bad offset');
  return v;
}

function sendResults(res: http.ServerResponse, mgr: JobManager, job: JobRecord): void {
  if (!isTerminal(job.state)) throw new HttpError(409, `job is ${job.state}`);
  const dir = mgr.store.jobDir(job.id);
  const last = job.attempts.length;
  // out/ of the last attempt, the logs of earlier attempts, and the record: the evidence of how it got here.
  const args = ['-czf', '-', '-C', dir, 'job.json', 'events.jsonl'];
  for (let n = 1; n < last; n++) {
    if (fs.existsSync(mgr.store.logFile(job.id, n))) args.push(`attempts/${n}/out/job.log`);
  }
  if (last > 0 && fs.existsSync(path.join(mgr.store.attemptDir(job.id, last), 'out'))) {
    args.push('-C', mgr.store.attemptDir(job.id, last), 'out');
  }
  const tar = spawn('tar', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  res.writeHead(200, { 'content-type': 'application/gzip' });
  tar.stdout.pipe(res);
  res.on('close', () => tar.kill());
}

async function route(req: http.IncomingMessage, res: http.ServerResponse, mgr: JobManager): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const method = req.method ?? 'GET';
  if (url.pathname === '/status' && method === 'GET') return json(res, 200, mgr.status());
  if (url.pathname === '/jobs' && method === 'GET') {
    return json(res, 200, [...mgr.jobs.values()].sort((a, b) => b.seq - a.seq));
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
    const file = await receive(req, mgr.store.incomingDir(), mgr.cfg.maxUploadMb * 1024 * 1024);
    try {
      await checkTar(file);
      return json(res, 201, mgr.submit(spec, file));
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
  const m = /^\/jobs\/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})(?:\/(cancel|log|events|results))?$/.exec(url.pathname);
  const job = m ? mgr.jobs.get(m[1]) : undefined;
  if (!m || !job) throw new HttpError(404, 'not found');
  const follow = url.searchParams.get('follow') === '1';
  switch (`${method} ${m[2] ?? ''}`) {
    case 'GET ':
      return json(res, 200, job);
    case 'POST cancel':
      return json(res, 200, mgr.cancel(job.id));
    case 'GET events':
      return tail(res, mgr.store.eventsFile(job.id), offsetOf(url), follow, () => isTerminal(job.state));
    case 'GET log': {
      const n = Number(url.searchParams.get('attempt') ?? job.attempts.length);
      const attempt = job.attempts.find((a) => a.n === n);
      if (!attempt) throw new HttpError(404, 'no such attempt');
      return tail(res, mgr.store.logFile(job.id, n), offsetOf(url), follow, () => attempt.endedAt !== undefined);
    }
    case 'GET results':
      return sendResults(res, mgr, job);
    default:
      throw new HttpError(405, 'method not allowed');
  }
}

export function createServer(mgr: JobManager): http.Server {
  return http.createServer((req, res) => {
    if (!authorized(req, mgr.cfg.token)) {
      res.setHeader('connection', 'close');
      return json(res, 401, { error: 'unauthorized' });
    }
    route(req, res, mgr).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (res.headersSent) return res.destroy();
      res.setHeader('connection', 'close');
      json(res, status, { error: e instanceof Error ? e.message : String(e) });
    });
  });
}
