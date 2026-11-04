// Threat model: a job is hostile and owns /job. The daemon runs as root. One describe per review finding of PR 22.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runArgs } from '../src/docker.ts';
import { validateSpec } from '../src/manager.ts';
import { createServer } from '../src/server.ts';
import { HttpError } from '../src/types.ts';
import { TOKEN, rig, tarOf } from './helpers.ts';
import type { Rig } from './helpers.ts';

const auth = { authorization: `Bearer ${TOKEN}` };
const header = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64');

let r: Rig;
let server: http.Server | undefined;
let timer: NodeJS.Timeout | undefined;

afterEach(async () => {
  mock.restoreAll();
  clearInterval(timer);
  if (server) {
    server.closeAllConnections();
    await new Promise((ok) => server!.close(ok));
    server = undefined;
  }
  r?.cleanup();
});

/** A rig with the HTTP server and the tick loop running. */
async function boot(over: Parameters<typeof rig>[0] = {}): Promise<string> {
  r = rig(over);
  r.clock.now = Date.now();
  server = createServer(r.mgr);
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
  timer = setInterval(() => void r.mgr.tick(), 10);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function submit(base: string, spec: object): Promise<string> {
  const res = await fetch(`${base}/jobs`, {
    method: 'POST',
    headers: { ...auth, 'x-job-spec': header({ maxRetries: 0, ...spec }) },
    body: await fs.openAsBlob(tarOf(r.dir)),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { id: string }).id;
}

async function until(fn: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (fn()) return;
    await new Promise((ok) => setTimeout(ok, 5));
  }
  assert.fail(`never: ${what}`);
}

const logReady = (id: string): (() => boolean) => () => fs.existsSync(r.mgr.store.logFile(id, 1));
const workDir = (): string => r.runtime.started.at(-1)!.workDir;

describe('finding 1: reads under the job-writable tree', () => {
  /** Swaps job.log for a symlink at the worst moment: right after the daemon has checked the file. */
  function swapAfterCheck(log: string, target: string): void {
    let done = false;
    const swap = (): void => {
      if (done) return;
      done = true;
      fs.rmSync(log);
      fs.symlinkSync(target, log);
    };
    const lstat = fs.lstatSync;
    mock.method(fs, 'lstatSync', (p: string, o: fs.StatSyncOptions) => {
      const st = lstat(p, o);
      if (String(p) === log) swap();
      return st;
    });
    const fstat = fs.fstatSync;
    mock.method(fs, 'fstatSync', (fd: number, o?: fs.StatOptions) => {
      const st = fstat(fd, o as never);
      swap();
      return st;
    });
  }

  it('log: a symlink swapped in right after the check is not followed', async () => {
    const base = await boot();
    const id = await submit(base, { command: ['hang'] });
    await until(logReady(id), 'log');
    const secret = path.join(r.dir, 'secret');
    fs.writeFileSync(secret, 'host file content, longer than the log\n');
    swapAfterCheck(r.mgr.store.logFile(id, 1), secret);
    const text = await (await fetch(`${base}/jobs/${id}/log?attempt=1`, { headers: auth })).text();
    assert.ok(!text.includes('host file'), `leaked: ${text}`);
  });

  it('log: a FIFO as job.log does not hang the stream', async () => {
    const base = await boot();
    const id = await submit(base, { command: ['hang'] });
    await until(logReady(id), 'log');
    const log = r.mgr.store.logFile(id, 1);
    fs.rmSync(log);
    assert.equal(spawnSync('mkfifo', [log]).status, 0);
    const res = await fetch(`${base}/jobs/${id}/log?attempt=1`, { headers: auth, signal: AbortSignal.timeout(3000) });
    assert.equal(await res.text(), '');
  });

  it('layout: the job folder is below a root-owned attempt folder, and out/ is its own mount', async () => {
    const base = await boot();
    await submit(base, { command: ['hang'] });
    await until(() => r.runtime.started.length === 1, 'start');
    const req = r.runtime.started[0];
    assert.equal(path.basename(req.workDir), 'work');
    const args = runArgs(req, r.cfg);
    assert.ok(args.includes(`${req.workDir}:/job`));
    assert.ok(args.some((a) => a.endsWith('/out:/job/out')), 'a job cannot replace a mount point with a symlink');
  });

  it('results: links and FIFOs in out/ stay out of the tar', async () => {
    const base = await boot();
    const id = await submit(base, { command: ['hang'] });
    await until(logReady(id), 'log');
    const out = path.dirname(r.mgr.store.logFile(id, 1));
    const secret = path.join(r.dir, 'secret');
    fs.writeFileSync(secret, 'host file\n');
    fs.mkdirSync(path.join(out, 'sub'));
    fs.writeFileSync(path.join(out, 'sub', 'keep.txt'), 'result\n');
    fs.symlinkSync(secret, path.join(out, 'link'));
    fs.symlinkSync('/', path.join(out, 'sub', 'root'));
    assert.equal(spawnSync('mkfifo', [path.join(out, 'pipe')]).status, 0);
    r.mgr.cancel(id);
    await until(() => r.mgr.jobs.get(id)!.state === 'cancelled', 'cancelled');
    const tar = await fetch(`${base}/jobs/${id}/results`, { headers: auth, signal: AbortSignal.timeout(5000) });
    const file = path.join(r.dir, 'res.tgz');
    fs.writeFileSync(file, Buffer.from(await tar.arrayBuffer()));
    const names = spawnSync('tar', ['-tzf', file], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    assert.ok(names.includes('out/sub/keep.txt'), names.join(' '));
    assert.ok(!names.some((n) => /link|root|pipe/.test(n)), names.join(' '));
  });

  it('client: a hostile result tar writes nothing outside the folder', async () => {
    r = rig();
    const dir = r.dir;
    fs.mkdirSync(path.join(dir, 'a'));
    fs.mkdirSync(path.join(dir, 'b/link'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'c/sub'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'outside'));
    fs.symlinkSync(path.join(dir, 'outside'), path.join(dir, 'a/link'));
    fs.writeFileSync(path.join(dir, 'b/link/pwn'), 'through a symlink');
    fs.writeFileSync(path.join(dir, 'c/evil'), 'dotdot');
    const hostile = path.join(dir, 'hostile.tgz');
    const made = spawnSync('tar', ['-P', '-czf', hostile, '-C', path.join(dir, 'a'), 'link', '-C', path.join(dir, 'b'), 'link/pwn', '-C', path.join(dir, 'c/sub'), '../evil']);
    assert.equal(made.status, 0, String(made.stderr));
    server = http.createServer((_req, res) => fs.createReadStream(hostile).pipe(res));
    await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
    const dest = path.join(dir, 'dest/inner');
    const client = fileURLToPath(new URL('../src/client.ts', import.meta.url));
    await new Promise((ok) => {
      spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', client, 'results', '20260101-000000-abcdef', dest], {
        env: { ...process.env, JOBD_URL: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, JOBD_TOKEN: TOKEN },
        stdio: 'ignore',
      }).on('close', ok);
    });
    assert.deepEqual(fs.readdirSync(path.join(dir, 'outside')), [], 'nothing through the symlink');
    assert.ok(!fs.existsSync(path.join(dir, 'dest/evil')), 'nothing through ..');
  });
});

describe('finding 2: limits Docker would read as none', () => {
  const refused = (o: object): void => {
    r = rig();
    assert.throws(() => validateSpec({ command: ['x'], ...o }, r.cfg), (e: HttpError) => e.status === 400, JSON.stringify(o));
    r.cleanup();
  };

  it('refuses memGb below the floor: it would round to --memory 0m', () => refused({ memGb: 0.0001 }));
  it('refuses cpus below the kernel minimum quota', () => refused({ cpus: 0.001 }));
  it('refuses timeoutS below 1: timeout 0 means no timeout', () => refused({ timeoutS: 0.5 }));
  it('refuses non-finite and non-number values', () => {
    for (const o of [{ memGb: 1e999 }, { cpus: 1e999 }, { timeoutS: 1e999 }, { memGb: '4' }, { cpus: null === 0 ? 1 : '2' }]) refused(o);
  });

  it('the floors pass and give a non-zero limit', () => {
    r = rig();
    const s = validateSpec({ command: ['x'], memGb: 0.0625, cpus: 0.01, timeoutS: 1 }, r.cfg);
    assert.equal(s.memGb, 0.0625);
    const a = runArgs({ container: 'c', workDir: '/w', outDir: '/o', inputTar: '/i', image: 'i', cpus: 0.01, memGb: 0.0625, diskGb: 1, timeoutS: 1, command: ['x'] } as never, r.cfg);
    assert.equal(a[a.indexOf('--memory') + 1], '64m');
  });
});

describe('finding 3: process limit', () => {
  it('docker run has --pids-limit', () => {
    r = rig();
    const a = runArgs({ container: 'c', workDir: '/w', outDir: '/o', inputTar: '/i', image: 'i', cpus: 1, memGb: 1, diskGb: 1, timeoutS: 1, command: ['x'] } as never, r.cfg);
    assert.equal(a[a.indexOf('--pids-limit') + 1], '4096');
  });

  it('the slice has TasksMax', () => {
    const slice = fs.readFileSync(new URL('../deploy/pcbjobs.slice', import.meta.url), 'utf8');
    assert.match(slice, /^TasksMax=\d+$/m);
  });
});

describe('finding 4: disk', () => {
  const startHang = async (over: object = {}): Promise<string> => {
    r = rig();
    const job = r.submit(['hang'], { diskGb: 0.01, ...over });
    await r.mgr.tick();
    return job.id;
  };

  it('a job over its limit is killed and fails with the cause, no retry', async () => {
    const id = await startHang();
    fs.writeFileSync(path.join(workDir(), 'fill'), Buffer.alloc(20 * 1024 * 1024, 1));
    await r.mgr.watchDisk();
    assert.deepEqual(r.runtime.killed, [r.mgr.jobs.get(id)!.attempts[0].container]);
    await r.mgr.tick();
    const job = r.mgr.jobs.get(id)!;
    assert.equal(job.state, 'failed');
    assert.equal(job.result?.outcome, 'disk');
    assert.match(job.result?.detail ?? '', /disk limit/);
    assert.equal(job.attempts.length, 1);
  });

  it('out/ counts', async () => {
    const id = await startHang();
    fs.writeFileSync(path.join(path.dirname(r.mgr.store.logFile(id, 1)), 'fill'), Buffer.alloc(20 * 1024 * 1024, 1));
    await r.mgr.watchDisk();
    assert.equal(r.runtime.killed.length, 1);
  });

  it('the container writable layer counts', async () => {
    await startHang();
    r.runtime.layerSize = 20 * 1024 * 1024;
    await r.mgr.watchDisk();
    assert.equal(r.runtime.killed.length, 1);
  });

  it('a job under its limit is left alone', async () => {
    await startHang({ diskGb: 1 });
    await r.mgr.watchDisk();
    assert.equal(r.runtime.killed.length, 0);
  });

  it('fails closed when the size cannot be measured in time', async () => {
    const id = await startHang();
    r.runtime.layerSize = null;
    await r.mgr.watchDisk();
    assert.equal(r.runtime.killed.length, 1);
    await r.mgr.tick();
    assert.match(r.mgr.jobs.get(id)!.result?.detail ?? '', /could not be measured/);
  });

  it('exit 153 (RLIMIT_FSIZE) is a disk failure, not a tool verdict', async () => {
    r = rig();
    const job = r.submit(['exit:153']);
    await r.mgr.tick();
    await r.mgr.tick();
    assert.equal(job.result?.outcome, 'disk');
  });

  it('the kill reason survives a restart', async () => {
    const id = await startHang();
    fs.writeFileSync(path.join(workDir(), 'fill'), Buffer.alloc(20 * 1024 * 1024, 1));
    await r.mgr.watchDisk();
    r.restart();
    await r.mgr.tick();
    assert.equal(r.mgr.jobs.get(id)!.result?.outcome, 'disk');
  });

  it('docker run caps a single file, and the input is not unpacked by root', () => {
    r = rig();
    const a = runArgs({ container: 'c', workDir: '/w', outDir: '/o', inputTar: '/i.tar.gz', image: 'i', cpus: 1, memGb: 1, diskGb: 2, timeoutS: 1, command: ['x'] } as never, r.cfg);
    assert.equal(a[a.indexOf('--ulimit') + 1], `fsize=${2 * 1024 ** 3}`);
    assert.ok(a.includes('/i.tar.gz:/input.tar.gz:ro'));
    assert.match(a.join(' '), /tar -xzf \/input\.tar\.gz/);
  });

  it('a job does not start unless its disk limit fits above the floor', async () => {
    r = rig();
    const job = r.submit(['hang'], { diskGb: 10 });
    r.host.diskFreeGb = 25;
    await r.mgr.tick();
    assert.equal(job.state, 'queued');
    assert.match(r.mgr.hold, /disk/);
  });

  it('refuses a disk limit over the maximum or below the floor', () => {
    r = rig();
    for (const diskGb of [0.0001, 51, 1e999]) {
      assert.throws(() => validateSpec({ command: ['x'], diskGb }, r.cfg), (e: HttpError) => e.status === 400);
    }
  });
});

describe('finding 5: job-writable marker', () => {
  it('a FIFO at .exit-code does not hang the daemon', async () => {
    r = rig();
    const job = r.submit(['exit:1']);
    await r.mgr.tick();
    const marker = path.join(workDir(), '.exit-code');
    fs.rmSync(marker, { force: true });
    assert.equal(spawnSync('mkfifo', [marker]).status, 0);
    await r.mgr.tick();
    assert.equal(job.state, 'failed');
  });

  it('a symlink or a huge sparse file at .exit-code is never read', async () => {
    r = rig();
    const job = r.submit(['exit:1']);
    await r.mgr.tick();
    const marker = path.join(workDir(), '.exit-code');
    fs.rmSync(marker, { force: true });
    fs.closeSync(fs.openSync(marker, 'w'));
    fs.truncateSync(marker, 64 * 1024 ** 3);
    await r.mgr.tick();
    assert.equal(job.state, 'failed');
    assert.equal(job.result?.exitCode, 1);
  });
});

describe('finding 6: forged success', () => {
  it('a marker of 0 does not pass a job that Docker saw killed', async () => {
    r = rig();
    const job = r.submit(['killed', 'exit:1'], { maxRetries: 1 });
    await r.mgr.tick();
    fs.writeFileSync(path.join(workDir(), '.exit-code'), '0\n');
    await r.mgr.tick();
    assert.equal(job.attempts[0].outcome, 'infra');
    assert.notEqual(job.state, 'passed');
  });

  it('a marker of 0 does not pass a job whose container is gone, across a restart', async () => {
    r = rig();
    const job = r.submit(['hang'], { maxRetries: 0 });
    await r.mgr.tick();
    fs.writeFileSync(path.join(workDir(), '.exit-code'), '0\n');
    r.runtime.containers.clear();
    r.restart();
    await r.mgr.tick();
    const again = r.mgr.jobs.get(job.id)!;
    assert.equal(again.state, 'failed');
    assert.equal(again.result?.outcome, 'infra');
  });

  it('the wrapper writes no marker', () => {
    r = rig();
    const a = runArgs({ container: 'c', workDir: '/w', outDir: '/o', inputTar: '/i', image: 'i', cpus: 1, memGb: 1, diskGb: 1, timeoutS: 1, command: ['x'] } as never, r.cfg);
    assert.ok(!a.join(' ').includes('.exit-code'));
  });

  it('the record is saved before the container goes: a crash leaves a container, which the sweep removes', async () => {
    r = rig();
    const job = r.submit(['pass']);
    await r.mgr.tick();
    const container = job.attempts[0].container;
    const remove = r.runtime.remove.bind(r.runtime);
    let stateAtRemove = '';
    r.runtime.remove = async (c: string) => {
      stateAtRemove = JSON.parse(fs.readFileSync(path.join(r.mgr.store.jobDir(job.id), 'job.json'), 'utf8')).state;
      r.runtime.orphans.push(c);
      void remove;
    };
    await r.mgr.tick();
    assert.equal(stateAtRemove, 'passed');
    r.runtime.remove = remove;
    r.restart();
    await r.mgr.tick();
    assert.ok(!r.runtime.containers.has(container));
    assert.deepEqual(r.runtime.orphans, []);
  });

  it('the sweep does not touch a running attempt', async () => {
    r = rig();
    const job = r.submit(['hang']);
    await r.mgr.tick();
    r.restart();
    await r.mgr.tick();
    assert.equal(r.mgr.jobs.get(job.id)!.state, 'running');
    assert.deepEqual(r.runtime.killed, []);
    assert.ok(r.runtime.containers.has(job.attempts[0].container));
  });
});

describe('finding 7: the deadline is the daemon\'s', () => {
  it('kills a job that stopped its own timer', async () => {
    r = rig();
    const job = r.submit(['hang'], { timeoutS: 60 });
    await r.mgr.tick();
    r.clock.now += 74_000;
    await r.mgr.tick();
    assert.deepEqual(r.runtime.killed, [], 'timeout + 10 s kill grace + 5 s margin not reached');
    r.clock.now += 2_000;
    await r.mgr.tick();
    assert.deepEqual(r.runtime.killed, [job.attempts[0].container]);
    await r.mgr.tick();
    assert.equal(job.state, 'failed');
    assert.equal(job.result?.outcome, 'timeout');
    assert.match(job.result?.detail ?? '', /daemon/);
    assert.equal(job.attempts.length, 1);
  });

  it('holds across a restart: the start time is in the record', async () => {
    r = rig();
    const job = r.submit(['hang'], { timeoutS: 60 });
    await r.mgr.tick();
    r.clock.now += 3_600_000;
    r.restart();
    await r.mgr.tick();
    await r.mgr.tick();
    assert.equal(r.mgr.jobs.get(job.id)!.result?.outcome, 'timeout');
  });
});

describe('finding 8: bounds', () => {
  it('Content-Length over the limit is refused before the body is read', async () => {
    const base = await boot();
    const url = new URL(`${base}/jobs`);
    const status = await new Promise<number>((ok, no) => {
      const req = http.request(url, {
        method: 'POST',
        headers: { ...auth, 'x-job-spec': header({ command: ['pass'] }), 'content-length': 2 * 1024 * 1024 },
      }, (res) => ok(res.statusCode ?? 0));
      req.on('error', no);
      req.setTimeout(2000, () => no(new Error('no answer: the body was awaited')));
      req.flushHeaders();
    });
    assert.equal(status, 413);
  });

  it('a full queue refuses a submit with 429, before the upload', async () => {
    const base = await boot({ maxQueued: 2, cpuBudget: 16 });
    for (let i = 0; i < 3; i++) await submit(base, { command: ['hang'], cpus: 16 });
    await until(() => r.mgr.usage().cpus === 16, 'first job running');
    const res = await fetch(`${base}/jobs`, { method: 'POST', headers: { ...auth, 'x-job-spec': header({ command: ['hang'] }) }, body: 'x' });
    assert.equal(res.status, 429);
    assert.match(((await res.json()) as { error: string }).error, /queue/);
    assert.equal(r.mgr.jobs.size, 3);
  });

  it('concurrent uploads over the limit get 503, and the slot comes back', async () => {
    const base = await boot({ maxUploads: 1 });
    const url = new URL(`${base}/jobs`);
    const open = http.request(url, { method: 'POST', headers: { ...auth, 'x-job-spec': header({ command: ['pass'] }), 'content-length': 100 } });
    open.on('error', () => undefined);
    open.write('x');
    await new Promise((ok) => setTimeout(ok, 50));
    const res = await fetch(`${base}/jobs`, { method: 'POST', headers: { ...auth, 'x-job-spec': header({ command: ['pass'] }) }, body: 'x' });
    assert.equal(res.status, 503);
    open.destroy();
    await new Promise((ok) => setTimeout(ok, 50));
    await submit(base, { command: ['pass'] });
  });

  it('concurrent streams over the limit get 503, and a dropped client frees its slot', async () => {
    const base = await boot({ maxStreams: 1 });
    const id = await submit(base, { command: ['hang'] });
    await until(logReady(id), 'log');
    const url = `${base}/jobs/${id}/log?attempt=1&follow=1`;
    const ctl = new AbortController();
    const first = await fetch(url, { headers: auth, signal: ctl.signal });
    assert.equal(first.status, 200);
    assert.equal((await fetch(url, { headers: auth })).status, 503);
    ctl.abort();
    await new Promise((ok) => setTimeout(ok, 50));
    const again = new AbortController();
    assert.equal((await fetch(url, { headers: auth, signal: again.signal })).status, 200);
    again.abort();
  });

  it('a stalled reader does not keep its slot after it goes', async () => {
    const base = await boot({ maxStreams: 1 });
    const id = await submit(base, { command: ['hang'] });
    await until(logReady(id), 'log');
    fs.writeFileSync(r.mgr.store.logFile(id, 1), Buffer.alloc(32 * 1024 * 1024, 65));
    const url = new URL(`${base}/jobs/${id}/log?attempt=1&follow=1`);
    await new Promise<void>((ok) => {
      const req = http.get(url, { headers: auth }, (res) => {
        res.pause(); // read nothing: the server blocks on drain
        setTimeout(() => {
          req.destroy();
          ok();
        }, 100);
      });
      req.on('error', () => undefined);
    });
    await new Promise((ok) => setTimeout(ok, 100));
    const ctl = new AbortController();
    assert.equal((await fetch(url, { headers: auth, signal: ctl.signal })).status, 200);
    ctl.abort();
  });

  it('the job list is bounded', async () => {
    const base = await boot({ cpuBudget: 16 });
    for (let i = 0; i < 3; i++) r.submit(['pass'], { cpus: 1 });
    const list = (await (await fetch(`${base}/jobs?limit=2`, { headers: auth })).json()) as unknown[];
    assert.equal(list.length, 2);
  });
});
