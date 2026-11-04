import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { isDesignFile, pack } from '../src/client.ts';
import { bindAllowed, loadConfig } from '../src/config.ts';
import { parseMeminfoKb, parsePsiSome10 } from '../src/host.ts';
import { createServer } from '../src/server.ts';
import { TOKEN, rig, tarOf } from './helpers.ts';
import type { Rig } from './helpers.ts';

let r: Rig;
let server: http.Server;
let base: string;
let timer: NodeJS.Timeout;

beforeEach(async () => {
  r = rig();
  r.clock.now = Date.now();
  server = createServer(r.mgr);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  timer = setInterval(() => void r.mgr.tick(), 20);
});
afterEach(async () => {
  clearInterval(timer);
  server.closeAllConnections();
  await new Promise((ok) => server.close(ok));
  r.cleanup();
});

const auth = { authorization: `Bearer ${TOKEN}` };
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

describe('submit', () => {
  it('runs a job and returns its results and evidence', async () => {
    const res = await post({ command: ['killed', 'pass'], name: 'demo' }, tarOf(r.dir), 1);
    assert.equal(res.status, 201);
    const job = (await res.json()) as { id: string };
    r.mgr.cfg.retryBackoffS = 0;
    await until(job.id, 'passed');
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

describe('host readings', () => {
  it('parses PSI and meminfo', () => {
    assert.equal(parsePsiSome10('some avg10=12.34 avg60=0.00 avg300=0.11 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'), 12.34);
    assert.equal(parseMeminfoKb('MemTotal:       65000000 kB\nMemAvailable:   1000 kB\n', 'MemAvailable'), 1000);
  });
});
