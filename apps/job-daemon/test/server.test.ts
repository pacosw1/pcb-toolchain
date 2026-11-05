import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { isDesignFile, manifestOf, pack } from '../src/client.ts';
import { bindAllowed, loadConfig } from '../src/config.ts';
import { CpuMeter, parseCpuCount, parseMeminfoKb } from '../src/host.ts';
import { createHealthServer, createServer } from '../src/server.ts';
import { TOKEN, rig, tarOf } from './helpers.ts';
import type { Rig } from './helpers.ts';

let r: Rig;
let server: http.Server;
let base: string;
let timer: NodeJS.Timeout;

beforeEach(async () => {
  r = rig();
  r.clock.now = Date.now();
  server = createServer(r.mgr, 'startup-identity');
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  timer = setInterval(() => {
    r.mgr.tick().catch(() => undefined); // in flight when a test deletes its folder, as main.ts catches them
    r.mgr.clean().catch(() => undefined);
  }, 20);
});
afterEach(async () => {
  clearInterval(timer);
  server.closeAllConnections();
  await new Promise((ok) => server.close(ok));
  r.cleanup();
});

const auth = { authorization: `Bearer ${TOKEN}` };
it('exposes the startup source identity only to authenticated clients', async () => {
  assert.equal((await fetch(`${base}/status`)).status, 401);
  const response = await fetch(`${base}/status`, { headers: auth });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sourceSha256, 'startup-identity');
});
it('local health server serves authenticated status only', async () => {
  const health = createHealthServer(r.mgr, 'local-source');
  await new Promise<void>((ok) => health.listen(0, '127.0.0.1', ok));
  try {
    const url = `http://127.0.0.1:${(health.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${url}/status`)).status, 401);
    assert.equal((await (await fetch(`${url}/status`, { headers: auth })).json()).sourceSha256, 'local-source');
    assert.equal((await fetch(`${url}/jobs`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${url}/status`, { method: 'POST', headers: auth })).status, 404);
  } finally { health.closeAllConnections(); await new Promise((ok) => health.close(ok)); }
});
it('local socket returns identity only with valid authentication', async () => {
  const local = createHealthServer(r.mgr, 'socket-source');
  const socket = path.join(r.dir, 'health.sock');
  await new Promise<void>((ok) => local.listen(socket, ok));
  const request = (token: string) => new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    http.get({ socketPath: socket, path: '/status', headers: { authorization: `Bearer ${token}` } }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (part: string) => { body += part; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  try {
    assert.equal((await request('incorrect')).status, 401);
    const result = await request(TOKEN);
    assert.equal(result.status, 200); assert.equal(JSON.parse(result.body).sourceSha256, 'socket-source');
  } finally { local.closeAllConnections(); await new Promise((ok) => local.close(ok)); }
});
const specHeader = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64');

async function post(spec: unknown, file = tarOf(r.dir), maxRetries = 0): Promise<Response> {
  return fetch(`${base}/jobs`, {
    method: 'POST',
    headers: { ...auth, 'x-job-spec': specHeader({ maxRetries, ...(spec as object) }) },
    body: await fs.openAsBlob(file),
  });
}

async function until(id: string, state: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (r.mgr.jobs.get(id)?.state === state) return;
    await new Promise((ok) => setTimeout(ok, 10));
  }
  assert.fail(`job never reached ${state}: ${r.mgr.jobs.get(id)?.state}`);
}

describe('auth and bind', () => {
  it('needs the token on every route', async () => {
    for (const p of ['/status', '/jobs', '/jobs/20260101-000000-abcdef']) {
      assert.equal((await fetch(base + p)).status, 401);
      assert.equal((await fetch(base + p, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    }
  });

  it('allows only localhost and Tailscale addresses', () => {
    for (const a of ['127.0.0.1', '::1', '100.93.34.43', '100.64.0.1', '100.127.255.254']) assert.ok(bindAllowed(a), a);
    for (const a of ['0.0.0.0', '::', '', 'localhost', '10.0.0.1', '100.63.0.1', '100.128.0.1', '45.32.193.248']) assert.ok(!bindAllowed(a), a);
  });

  it('refuses to start on 0.0.0.0, without a token, or with a short one', () => {
    const file = path.join(r.dir, 'token');
    fs.writeFileSync(file, TOKEN);
    const env = { JOBD_TOKEN_FILE: file, JOBD_DATA_DIR: r.dir };
    assert.throws(() => loadConfig({ ...env, JOBD_BIND: '0.0.0.0' }), /JOBD_BIND/);
    assert.throws(() => loadConfig({ JOBD_DATA_DIR: r.dir }), /JOBD_TOKEN_FILE/);
    fs.writeFileSync(file, 'short');
    assert.throws(() => loadConfig(env), /shorter/);
  });

  it('refuses a slice name that systemd would nest', () => {
    const file = path.join(r.dir, 'token');
    fs.writeFileSync(file, TOKEN);
    assert.throws(() => loadConfig({ JOBD_TOKEN_FILE: file, JOBD_DATA_DIR: r.dir, JOBD_CGROUP_PARENT: 'pcb-jobs.slice' }), /hyphen/);
  });
});

describe('board leases', () => {
  const call = (url: string, body: unknown, authenticated = true): Promise<Response> => fetch(base + url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? auth : {}) }, body: JSON.stringify(body),
  });

  it('waits while a fresh observed unguarded writer is active on the same board', async () => {
    const event = { source: 'mini', host: 'mini', board: 'project/B', run: 'direct', kind: 'run.state' };
    const data = { status: 'running', operation: 'placement', coordinated: false, supervisorAlive: true, boardKey: 'project/cad/B.kicad_pcb' };
    assert.equal((await call('/live/events', { ...event, eventId: 'started', data })).status, 200);
    const req = { board: data.boardKey, owner: 'macbook', ttlMs: 30000 };
    assert.equal((await call('/board-leases/acquire', req)).status, 409);
    assert.equal((await call('/live/events', { ...event, eventId: 'stopped', data: { ...data, status: 'stopped', supervisorAlive: false } })).status, 200);
    assert.equal((await call('/board-leases/acquire', req)).status, 201);
  });

  it('exports an authenticated protected revision without overwriting a working file', async () => {
    const lease = await (await call('/board-leases/acquire', { board: 'project/cad/B.kicad_pcb', owner: 'test', ttlMs: 30000 })).json();
    await call('/board-leases/commit-begin', { lease });
    await call('/board-revisions', { lease, expected: null, content: Buffer.from('protected-board').toString('base64') });
    const token = path.join(r.dir, 'protected-token'), config = path.join(r.dir, 'protected-config.json'), out = path.join(r.dir, 'working.kicad_pcb');
    fs.writeFileSync(token, TOKEN); fs.writeFileSync(config, JSON.stringify({ url: base, tokenFile: token }));
    const script = path.resolve('..', '..', 'tools/pcb-protected.mts');
    const invoke = async (): Promise<number | null> => await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', script, 'read', '--board', 'project/cad/B.kicad_pcb', '--out', out],
        { env: { ...process.env, PCB_LIVE_CONFIG: config }, stdio: 'ignore' });
      child.once('error', reject); child.once('close', resolve);
    });
    assert.equal(await invoke(), 0); assert.equal(fs.readFileSync(out, 'utf8'), 'protected-board');
    fs.writeFileSync(out, 'local work'); assert.equal(await invoke(), 2); assert.equal(fs.readFileSync(out, 'utf8'), 'local work');
    const project = path.join(r.dir, 'registered-project'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, '.pcb-live.json'), '{"projectId":"project"}');
    const entry = path.resolve('..', '..', 'tools/pcb');
    const status = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(entry, ['--project', project, 'protected', 'list'], { env: { ...process.env, PCB_LIVE_CONFIG: config }, stdio: 'ignore' });
      child.once('error', reject); child.once('close', resolve);
    });
    assert.equal(status, 0);
  });

  it('requires authentication and rejects competing and stale owners', async () => {
    const request = { board: 'project/board', owner: 'mini', ttlMs: 30000 };
    assert.equal((await call('/board-leases/acquire', request, false)).status, 401);
    assert.equal((await call('/board-leases/acquire', { ...request, ttlMs: 1 })).status, 400);
    const first = await call('/board-leases/acquire', request);
    assert.equal(first.status, 201);
    const lease = await first.json() as Record<string, unknown>;
    assert.equal((await call('/board-leases/acquire', { ...request, owner: 'macbook' })).status, 409);
    assert.equal((await call('/board-leases/renew', { lease: { ...lease, token: '0'.repeat(64) }, ttlMs: 30000 })).status, 409);
    assert.equal((await call('/board-leases/renew', { lease, ttlMs: 30000 })).status, 200);
    assert.equal((await call('/board-leases/commit-begin', { lease })).status, 200);
    assert.equal((await call('/board-leases/release', { lease })).status, 409);
    const initial = await call('/board-revisions', { lease, expected: null, content: Buffer.from('board-v1').toString('base64') });
    assert.equal(initial.status, 200);
    const revision = await initial.json() as { revision: number; sha256: string };
    assert.equal(revision.revision, 1);
    assert.equal((await call('/board-revisions', { lease, expected: null, content: Buffer.from('board-v2').toString('base64') })).status, 409);
    const meta = await (await fetch(base + '/board-revisions?board=project%2Fboard', { headers: auth })).json() as { sha256: string };
    assert.equal(meta.sha256, revision.sha256);
    assert.equal((await fetch(base + '/board-revisions/content?board=project%2Fboard')).status, 401);
    assert.equal((await call('/board-revisions', { lease, expected: 1, content: Buffer.from('board-v2').toString('base64') })).status, 200);
    const old = await fetch(base + '/board-revisions/content?board=project%2Fboard&revision=1', { headers: auth });
    assert.equal(await old.text(), 'board-v1');
    assert.equal(old.headers.get('x-board-sha256'), revision.sha256);
    assert.equal(await (await fetch(base + '/board-revisions/content?board=project%2Fboard', { headers: auth })).text(), 'board-v2');
    assert.equal((await call('/board-leases/commit-end', { lease: { ...lease, token: '0'.repeat(64) } })).status, 409);
    assert.equal((await call('/board-leases/commit-end', { lease })).status, 200);
    assert.equal((await call('/board-leases/release', { lease })).status, 200);
    const next = await call('/board-leases/acquire', { ...request, owner: 'macbook' });
    const nextLease = await next.json() as { generation: number };
    assert.equal(next.status, 201);
    assert.equal(nextLease.generation, (lease.generation as number) + 1);
    assert.equal((await call('/board-leases/release', { lease })).status, 409);
  });
});

describe('live progress stream', () => {
  it('authenticates, replays, deduplicates retries and follows new events', async () => {
    const input = { source: 'mini:boot-1', eventId: '1', host: 'mini', board: 'project/A', run: 'run-1', kind: 'progress', data: { pass: 1 } };
    const publish = (body: unknown): Promise<Response> => fetch(base + '/live/events', {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await fetch(base + '/live/events')).status, 401);
    const first = await (await publish(input)).json() as { cursor: number };
    const repeat = await (await publish(input)).json() as { cursor: number };
    assert.equal(repeat.cursor, first.cursor);
    assert.equal((await publish({ ...input, data: { pass: 2 } })).status, 400);
    const stream = await fetch(base + '/live/events?after=0&follow=1', { headers: auth });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes(`id: ${first.cursor}`)) text += decoder.decode((await reader.read()).value);
    const second = await (await publish({ ...input, eventId: '2', data: { pass: 2 } })).json() as { cursor: number };
    while (!text.includes(`id: ${second.cursor}`)) text += decoder.decode((await reader.read()).value);
    await reader.cancel();
    const replay = await fetch(`${base}/live/events?after=${first.cursor}`, { headers: auth });
    const events = await replay.json() as { cursor: number }[];
    assert.deepEqual(events.map(e => e.cursor), [second.cursor]);
    await publish({ ...input, eventId: '3', kind: 'board.snapshot', data: { path: 'a.kicad_pcb' } });
    await publish({ ...input, eventId: '4', kind: 'board.snapshot', data: { path: 'b.kicad_pcb' } });
    const state = await (await fetch(base + '/live/state', { headers: auth })).json() as { events: { kind: string }[] };
    assert.equal(state.events.filter(e => e.kind === 'board.snapshot').length, 2);
    assert.equal((await fetch(base + '/live/events?after=0&epoch=wrong&follow=1', { headers: auth })).status, 409);
  });

  it('serves only a bounded regular preview from a job attempt', async () => {
    const response = await post({ command: ['hang'], name: 'preview' });
    const job = await response.json() as { id: string };
    await until(job.id, 'running');
    const preview = path.join(r.mgr.store.outDir(job.id, 1), 'live-route.json');
    const url = `${base}/jobs/${job.id}/live`;
    assert.equal((await fetch(url, { headers: auth })).status, 404);
    fs.writeFileSync(preview, '{"schema":"iot-lab.route-preview.v1"}');
    assert.equal((await (await fetch(url, { headers: auth })).json() as { schema: string }).schema, 'iot-lab.route-preview.v1');
    fs.unlinkSync(preview);
    fs.symlinkSync('/etc/passwd', preview);
    assert.equal((await fetch(url, { headers: auth })).status, 404);
    assert.equal((await fetch(url)).status, 401);
  });

  it('appends event batches atomically and permits an identical retry', async () => {
    const one = { source: 'mini', eventId: 'one', host: 'mini', board: 'project/B', run: 'r', kind: 'run.event', data: { type: 'start' } };
    const two = { ...one, eventId: 'two', data: { type: 'done' } };
    const postBatch = (items: unknown[]) => fetch(base + '/live/events/batch', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(items) });
    const first = await postBatch([one, two]); assert.equal(first.status, 200);
    const original = await first.json() as { cursor: number }[];
    const retry = await postBatch([one, two]); assert.deepEqual((await retry.json() as { cursor: number }[]).map(e => e.cursor), original.map(e => e.cursor));
    const bad = await postBatch([{ ...one, eventId: 'three' }, { ...one, data: { type: 'changed' } }]);
    assert.equal(bad.status, 400);
    const all = await (await fetch(base + '/live/events?after=0', { headers: auth })).json() as { eventId: string }[];
    assert.deepEqual(all.map(e => e.eventId), ['one', 'two']);
  });

  it('replays only frames for the selected source, board and run', async () => {
    const input = { source: 'mini', host: 'mini', board: 'project/B', run: 'r', kind: 'route.preview', data: { sha256: 'a'.repeat(64) } };
    const batch = Array.from({ length: 20 }, (_, i) => ({ ...input, eventId: `f${i}` }));
    for (let page = 0; page < 11; page++) {
      const items = batch.map(e => ({ ...e, eventId: `${page}:${e.eventId}` }));
      const response = await fetch(base + '/live/events/batch', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(items) });
      assert.equal(response.status, 200);
    }
    const query = '/live/history?source=mini&board=project%2FB&run=r&after=';
    const first = await (await fetch(base + query + '0', { headers: auth })).json() as { events: { cursor: number }[]; more: boolean };
    assert.equal(first.events.length, 200); assert.equal(first.more, true);
    const second = await (await fetch(base + query + first.events.at(-1)!.cursor, { headers: auth })).json() as { events: unknown[]; more: boolean };
    assert.equal(second.events.length, 20); assert.equal(second.more, false);
    const other = await (await fetch(base + '/live/history?source=other&board=project%2FB&run=r', { headers: auth })).json() as { events: unknown[] };
    assert.deepEqual(other.events, []);
  });
});

describe('submit', () => {
  it('runs a job and returns its results and evidence', async () => {
    const res = await post({ command: ['killed', 'pass'], name: 'demo' }, tarOf(r.dir), 1);
    assert.equal(res.status, 201);
    const job = (await res.json()) as { id: string };
    r.mgr.cfg.retryBackoffS = 0;
    await until(job.id, 'passed');
    while (!r.mgr.jobs.get(job.id)!.attempts.every((a) => a.trimmed)) await new Promise((ok) => setTimeout(ok, 10));
    const tar = await fetch(`${base}/jobs/${job.id}/results`, { headers: auth });
    assert.equal(tar.status, 200);
    const file = path.join(r.dir, 'res.tar.gz');
    fs.writeFileSync(file, Buffer.from(await tar.arrayBuffer()));
    const names = spawnSync('tar', ['-tzf', file], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort();
    assert.deepEqual(names, ['attempts/1/out/job.log', 'events.jsonl', 'job.json', 'out/', 'out/job.log']);
  });

  it('refuses bad input without creating a job', async () => {
    assert.equal((await post({ command: [] })).status, 400);
    assert.equal((await post({ command: ['pass'], image: 'evil' })).status, 400);
    const notTar = path.join(r.dir, 'x');
    fs.writeFileSync(notTar, 'plain');
    assert.equal((await post({ command: ['pass'] }, notTar)).status, 400);
    assert.equal(r.mgr.jobs.size, 0);
    assert.deepEqual(fs.readdirSync(r.mgr.store.incomingDir()), []);
  });

  it('refuses a tar that leaves the job folder', async () => {
    const src = path.join(r.dir, 'evil');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'f'), 'x');
    const file = path.join(r.dir, 'evil.tar.gz');
    const flag = process.platform === 'darwin' ? ['-s', ',^f$,../f,'] : ['--transform', 's,^f$,../f,'];
    assert.equal(spawnSync('tar', [...flag, '-czf', file, '-C', src, 'f']).status, 0);
    const res = await post({ command: ['pass'] }, file);
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /unsafe path/);
  });

  it('refuses an upload over the limit', async () => {
    const big = path.join(r.dir, 'big');
    fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024));
    const res = await post({ command: ['pass'] }, big).catch(() => null);
    if (res) assert.equal(res.status, 413);
    assert.equal(r.mgr.jobs.size, 0);
    assert.deepEqual(fs.readdirSync(r.mgr.store.incomingDir()), []);
  });

  it('results of an unfinished job are a 409', async () => {
    const job = (await (await post({ command: ['hang'] })).json()) as { id: string };
    assert.equal((await fetch(`${base}/jobs/${job.id}/results`, { headers: auth })).status, 409);
  });
});

describe('streams survive a client disconnect', () => {
  it('a client that drops resumes the log from its offset and misses nothing', async () => {
    const job = (await (await post({ command: ['hang'] })).json()) as { id: string };
    await until(job.id, 'running');
    const log = r.mgr.store.logFile(job.id, 1);
    const url = `${base}/jobs/${job.id}/log?attempt=1&follow=1`;

    const ctl = new AbortController();
    const first = await fetch(url, { headers: auth, signal: ctl.signal });
    const reader = first.body!.getReader();
    const { value } = await reader.read();
    const got = Buffer.from(value!);
    ctl.abort(); // the client goes away while the job runs

    fs.appendFileSync(log, 'written while nobody was connected\n');
    assert.equal(r.mgr.jobs.get(job.id)!.state, 'running', 'the job does not depend on the client');

    const second = fetch(`${url}&offset=${got.length}`, { headers: auth }).then((x) => x.text());
    await new Promise((ok) => setTimeout(ok, 50));
    fs.appendFileSync(log, 'written after the client came back\n');
    r.mgr.cancel(job.id); // ends the attempt, so the follow ends
    const rest = await second;
    assert.equal(got.toString() + rest, fs.readFileSync(log, 'utf8'));
    assert.match(rest, /nobody was connected[\s\S]*came back/);
  });

  it('does not follow a job.log that the job made a symlink', async () => {
    const job = (await (await post({ command: ['hang'] })).json()) as { id: string };
    await until(job.id, 'running');
    const secret = path.join(r.dir, 'secret');
    fs.writeFileSync(secret, 'host file');
    const log = r.mgr.store.logFile(job.id, 1);
    while (!fs.existsSync(log)) await new Promise((ok) => setTimeout(ok, 5)); // "running" comes before the start
    fs.rmSync(log);
    fs.symlinkSync(secret, log);
    const text = await (await fetch(`${base}/jobs/${job.id}/log?attempt=1`, { headers: auth })).text();
    assert.equal(text, '');
  });

  it('the status stream ends at a terminal state and resumes from an offset', async () => {
    const job = (await (await post({ command: ['exit:1'] })).json()) as { id: string };
    const text = await (await fetch(`${base}/jobs/${job.id}/events?follow=1`, { headers: auth })).text();
    const lines = text.trim().split('\n').map((l) => JSON.parse(l).to as string);
    assert.deepEqual(lines, ['queued', 'running', 'failed']);
    const firstLen = text.indexOf('\n') + 1;
    const rest = await (await fetch(`${base}/jobs/${job.id}/events?offset=${firstLen}`, { headers: auth })).text();
    assert.equal(rest, text.slice(firstLen));
  });

  it('cancel over the API', async () => {
    const job = (await (await post({ command: ['hang'] })).json()) as { id: string };
    await until(job.id, 'running');
    const res = await fetch(`${base}/jobs/${job.id}/cancel`, { method: 'POST', headers: auth });
    assert.equal(res.status, 200);
    await until(job.id, 'cancelled');
  });

  it('status shows the budget and why the queue waits', async () => {
    await post({ command: ['hang'], cpus: 16 });
    await post({ command: ['hang'], cpus: 1 });
    await new Promise((ok) => setTimeout(ok, 80));
    const s = (await (await fetch(`${base}/status`, { headers: auth })).json()) as Record<string, unknown>;
    assert.deepEqual(s.used, { cpus: 16, memGb: 8 });
    assert.equal(s.queued, 1);
    assert.match(s.hold as string, /cpu budget/);
  });

  it('unknown job or malformed id is a 404', async () => {
    assert.equal((await fetch(`${base}/jobs/20260101-000000-abcdef`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${base}/jobs/..%2f..%2fetc`, { headers: auth })).status, 404);
  });
});

describe('client', () => {
  const client = fileURLToPath(new URL('../src/client.ts', import.meta.url));
  const flags = ['--experimental-strip-types', '--no-warnings'];
  let root: string;
  const env = (): NodeJS.ProcessEnv => ({ ...process.env, JOBD_URL: base, JOBD_TOKEN: TOKEN, PCB_TOOLCHAIN_ROOT: root, IOT_LAB: root });

  before(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'jobd-client-'));
    fs.mkdirSync(path.join(root, 'tools/__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tools/a.py'), '# only a fixture\n');
    fs.writeFileSync(path.join(root, 'tools/__pycache__/a.pyc'), 'x');
    const board = path.join(root, 'hardware-design/boards/B');
    fs.mkdirSync(path.join(board, 'render'), { recursive: true });
    fs.mkdirSync(path.join(board, 'lib.3dshapes'));
    fs.writeFileSync(path.join(board, 'B.kicad_pcb'), '(kicad_pcb)');
    fs.writeFileSync(path.join(board, 'gate.json'), '{}');
    fs.writeFileSync(path.join(board, 'fp-lib-table'), '()');
    fs.writeFileSync(path.join(board, 'notes.md'), 'no');
    fs.writeFileSync(path.join(board, '.hidden.json'), '{}');
    fs.writeFileSync(path.join(board, 'render/x.json'), '{}');
    fs.writeFileSync(path.join(board, 'lib.3dshapes/x.json'), '{}');
    fs.writeFileSync(path.join(root, 'prob.json'), '{}');
    fs.mkdirSync(path.join(root, 'hardware-design/registry/datasheets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hardware-design/registry/datasheets/a.pdf'), 'pdf');
    fs.writeFileSync(path.join(root, 'hardware-design/registry/datasheets/other.pdf'), 'pdf');
    const evidence = ['hardware-design/registry/datasheets/a.pdf', 'hardware-design/registry/datasheets/gone.pdf'];
    fs.writeFileSync(path.join(root, 'tools/driver-edges.json'), JSON.stringify({ evidence_files: evidence.map((p) => ({ path: p })) }));
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  function run(args: string[], extra: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((ok) => {
      const p = spawn(process.execPath, [...flags, client, ...args], { env: { ...env(), ...extra } });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => ok({ code, out, err }));
    });
  }

  it('run shows why the job waits, and stops at --queue-wait with exit 75', async () => {
    r.host.cpuBusyPct = 100;
    const results = path.join(root, 'queue-results');
    const running = run(['run', 'hardware-design/boards/B', '--queue-wait', '3', '--results', results, '--', 'pass']);
    for (let i = 0; i < 500 && r.mgr.jobs.size === 0; i++) await new Promise((ok) => setTimeout(ok, 10));
    const [job] = [...r.mgr.jobs.values()];
    assert.equal(job.spec.queueWaitS, 3);
    for (let i = 0; i < 300 && !job.hold; i++) await new Promise((ok) => setTimeout(ok, 10));
    const listed = await run(['list']);
    assert.match(listed.out, /held: host cpu/);
    const status = await run(['status', job.id]);
    assert.match(JSON.parse(status.out).hold, /host cpu/);
    r.clock.now += 3000;
    const res = await running;
    assert.equal(res.code, 75, res.err);
    assert.match(res.err, /\] queued for 0 s: host cpu: 100 % busy/);
    assert.match(res.err, /failed: queued for 3 s: host cpu: 100 % busy/);
  });

  it('--fit budget lowers cpus and memory to the budget; without it they are refused', async () => {
    const args = ['hardware-design/boards/B', '--cpus', '30', '--mem', '32'];
    const refused = await run(['submit', ...args, '--', 'true']);
    assert.notEqual(refused.code, 0);
    const fitted = await run(['submit', ...args, '--fit', 'budget', '--', 'true']);
    assert.equal(fitted.code, 0, fitted.err);
    assert.match(fitted.err, /cpus 30 is over the daemon budget, using 16/);
    const id = fitted.out.trim();
    const job = await (await fetch(`${base}/jobs/${id}`, { headers: auth })).json() as { spec: { cpus: number; memGb: number } };
    assert.deepEqual([job.spec.cpus, job.spec.memGb], [16, 16]);
  });

  it('selects the same files as remote.sh, plus the driver evidence', () => {
    const tar = path.join(root, 'sel.tar.gz');
    pack(root, root, 'hardware-design/boards/B', [path.join(root, 'prob.json')], tar);
    const names = spawnSync('tar', ['-tzf', tar], { encoding: 'utf8' }).stdout.split('\n')
      .filter((n) => n && !n.endsWith('/')).map((n) => n.replace(/^\.\//, '')).sort();
    assert.deepEqual(names, [
      'hardware-design/boards/B/B.kicad_pcb', 'hardware-design/boards/B/fp-lib-table', 'hardware-design/boards/B/gate.json',
      'hardware-design/registry/datasheets/a.pdf', 'in/prob.json', 'tools/a.py', 'tools/driver-edges.json',
    ]);
    assert.ok(isDesignFile('x.kicad_mod'));
  });

  it('run: exit code 0, log on stdout, results in the folder', async () => {
    const dir = path.join(root, 'res');
    const res = await run(['run', 'hardware-design/boards/B', '--results', dir, '--', 'pass']);
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /attempt 1: pass/);
    assert.match(res.err, /passed/);
    assert.ok(fs.existsSync(path.join(dir, 'out/job.log')));
    assert.ok(fs.existsSync(path.join(dir, 'job.json')));
  });

  it('run: the exit code of a failed job, after a retry that streams both attempts', async () => {
    r.mgr.cfg.retryBackoffS = 0;
    const res = await run(['run', 'hardware-design/boards/B', '--retries', '1', '--results', path.join(root, 'r2'), '--', 'killed', 'exit:7']);
    assert.equal(res.code, 7, res.err);
    assert.match(res.out, /attempt 1: killed\n[\s\S]*attempt 2: exit:7/);
    assert.match(res.err, /retrying/);
  });

  it('submit, status, list and cancel', async () => {
    const sub = await run(['submit', 'hardware-design/boards/B', '--cpus', '2', '--', 'hang']);
    assert.equal(sub.code, 0, sub.err);
    const id = sub.out.trim();
    await until(id, 'running');
    assert.match((await run(['status', id])).out, /"state": "running"/);
    assert.match((await run(['list'])).out, new RegExp(`${id}  running`));
    assert.match((await run(['status'])).out, /"cpus": 2/);
    assert.equal((await run(['cancel', id])).code, 0);
    await until(id, 'cancelled');
    assert.equal((await run(['watch', id])).code, 130);
  });

  it('a bad token is an error, not a hang', async () => {
    const res = await run(['status'], { JOBD_TOKEN: 'wrong' });
    assert.equal(res.code, 2);
    assert.match(res.err, /401/);
  });
});

describe('file cache', () => {
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
  const entry = (p: string, b: Buffer) => ({ path: p, sha256: sha(b), mode: 0o755, mtimeMs: 1_700_000_000_000 });
  const put = (b: Buffer, name = sha(b)) => fetch(`${base}/blobs/${name}`, { method: 'PUT', headers: auth, body: new Uint8Array(b) });
  const job = (files: unknown) => fetch(`${base}/jobs`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json', 'x-job-spec': specHeader({ command: ['pass'], maxRetries: 0 }) },
    body: JSON.stringify({ files }),
  });

  it('reports what is missing, stores it, and builds the job from it', async () => {
    const a = Buffer.from('tools file'), b = Buffer.from('board file');
    const asked = await fetch(`${base}/blobs/missing`, { method: 'POST', headers: auth, body: JSON.stringify({ sha256: [sha(a), sha(b)] }) });
    assert.deepEqual(((await asked.json()) as { missing: string[] }).missing, [sha(a), sha(b)]);
    assert.equal((await put(a)).status, 201);
    assert.equal((await job([entry('tools/a.py', a), entry('b.kicad_pcb', b)])).status, 409);
    assert.equal((await put(b)).status, 201);
    const res = await job([entry('tools/a.py', a), entry('b.kicad_pcb', b)]);
    assert.equal(res.status, 201);
    const { id } = (await res.json()) as { id: string };
    const out = spawnSync('tar', ['-tzvf', r.mgr.store.inputTar(id)], { encoding: 'utf8' }).stdout;
    assert.match(out, /rwxr-xr-x.*tools\/a\.py/);
    assert.match(out, /b\.kicad_pcb/);
  });

  it('refuses a body that does not match its hash', async () => {
    assert.equal((await put(Buffer.from('real'), sha(Buffer.from('other')))).status, 400);
    assert.deepEqual(fs.readdirSync(r.mgr.store.blobsDir()), []);
  });

  it('refuses a manifest path that could leave the job folder', async () => {
    const a = Buffer.from('x');
    await put(a);
    for (const p of ['../a', '/etc/a', 'a/../../b', 'a//b', '']) assert.equal((await job([entry(p, a)])).status, 400, p);
  });

  it('refuses a file where a manifest path needs a folder', async () => {
    const a = Buffer.from('x');
    await put(a);
    assert.equal((await job([entry('a', a), entry('a/b', a)])).status, 400);
  });

  it('refuses a name that is not a hash', async () => {
    assert.equal((await put(Buffer.from('x'), 'nothash')).status, 400);
  });

  it('drops the setuid bit', async () => {
    const a = Buffer.from('x');
    await put(a);
    const res = await job([{ ...entry('a', a), mode: 0o4755 }]);
    const { id } = (await res.json()) as { id: string };
    assert.match(spawnSync('tar', ['-tzvf', r.mgr.store.inputTar(id)], { encoding: 'utf8' }).stdout, /rwxr-xr-x/);
  });

  it('manifestOf lists files with hashes and gives up on a link', () => {
    const d = fs.mkdtempSync(path.join(r.dir, 'stage-'));
    fs.mkdirSync(path.join(d, 'tools'));
    fs.writeFileSync(path.join(d, 'tools/a'), 'x');
    assert.deepEqual(manifestOf(d)?.map((f) => [f.path, f.sha256]), [['tools/a', sha(Buffer.from('x'))]]);
    fs.symlinkSync('a', path.join(d, 'tools/l'));
    assert.equal(manifestOf(d), null);
  });
});

describe('host readings', () => {
  it('parses meminfo', () => {
    assert.equal(parseMeminfoKb('MemTotal:       65000000 kB\nMemAvailable:   1000 kB\n', 'MemAvailable'), 1000);
  });

  // user nice system idle iowait irq softirq steal guest guest_nice, as /proc/stat
  const stat = (user: number, idle: number, iowait = 0): string =>
    `cpu  ${user} 0 0 ${idle} ${iowait} 0 0 0 0 0\ncpu0 1 0 0 1 0 0 0 0 0 0\ncpu1 1 0 0 1 0 0 0 0 0 0\nintr 1\n`;

  it('counts the CPUs of /proc/stat', () => {
    assert.equal(parseCpuCount(stat(1, 1)), 2);
  });

  it('measures busy as the guard does, over its 5 s window: iowait is idle', () => {
    const m = new CpuMeter();
    assert.equal(m.read(stat(100, 100), 0), null, 'one sample is no reading');
    assert.equal(m.read(stat(9999, 1), 4999), null, 'inside the window: not resampled');
    assert.equal(m.read(stat(130, 150, 20), 5000), 30); // busy +30 of +100
    assert.equal(m.read(stat(9999, 1), 6000), 30, 'keeps the last window between samples');
    assert.equal(m.read(stat(230, 150, 20), 10000), 100);
  });
});
