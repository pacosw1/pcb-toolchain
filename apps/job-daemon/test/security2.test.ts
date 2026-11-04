// Second review of PR 22. Same threat model as security.test.ts: a job is hostile, the daemon runs as root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import * as docker from '../src/docker.ts';
import { createServer } from '../src/server.ts';
import { TOKEN, rig, tarOf } from './helpers.ts';
import type { Rig } from './helpers.ts';

const auth = { authorization: `Bearer ${TOKEN}` };
const header = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64');
const realPath = process.env.PATH;

let r: Rig;
let server: http.Server | undefined;
let timer: NodeJS.Timeout | undefined;

afterEach(async () => {
  mock.restoreAll();
  process.env.PATH = realPath;
  clearInterval(timer);
  if (server) {
    server.closeAllConnections();
    await new Promise((ok) => server!.close(ok));
    server = undefined;
  }
  r?.cleanup();
});

async function boot(over: Parameters<typeof rig>[0] = {}): Promise<string> {
  r = rig(over);
  r.clock.now = Date.now();
  server = createServer(r.mgr);
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
  timer = setInterval(() => {
    r.mgr.tick().catch(() => undefined); // in flight when a test deletes its folder, as main.ts catches them
    r.mgr.clean().catch(() => undefined);
  }, 10);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function until(fn: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (fn()) return;
    await new Promise((ok) => setTimeout(ok, 5));
  }
  assert.fail(`never: ${what}`);
}

/** Puts a fake program first on PATH. */
function fakeProgram(name: string, script: string): void {
  const dir = path.join(r.dir, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  process.env.PATH = `${dir}:${realPath}`;
}

describe('review 2, item 1: cleanup', () => {
  it('a container that may be alive blocks cleanup, and cleanup resumes when it is gone', async () => {
    r = rig();
    const job = r.submit(['start-alive'], { maxRetries: 0 }); // docker run gave up, but the container came up
    r.runtime.removeBroken = true;
    await r.mgr.tick();
    assert.equal(job.state, 'failed');
    await r.mgr.clean?.();
    const work = r.mgr.store.workDir(job.id, 1);
    assert.ok(fs.existsSync(work), 'nothing deleted while the job may be alive');
    assert.deepEqual(r.runtime.cleaned, []);
    r.runtime.removeBroken = false;
    await r.mgr.clean?.();
    assert.ok(!fs.existsSync(work));
    assert.equal(job.attempts[0].trimmed, true);
  });

  it('a Docker that gives no answer about the container blocks cleanup', async () => {
    r = rig();
    const job = r.submit(['pass']);
    await r.mgr.tick();
    await r.mgr.tick();
    assert.equal(job.state, 'passed');
    r.runtime.inspectBroken = true;
    await r.mgr.clean?.();
    assert.deepEqual(r.runtime.cleaned, []);
  });

  it('the daemon itself deletes nothing under an attempt folder', async () => {
    r = rig();
    const job = r.submit(['pass']);
    const seen: string[] = [];
    const rmSync = fs.rmSync;
    mock.method(fs, 'rmSync', (p: string, o?: fs.RmOptions) => {
      if (String(p).includes('/attempts/')) seen.push(String(p));
      return rmSync(p, o);
    });
    await r.mgr.tick();
    await r.mgr.tick();
    await r.mgr.clean?.();
    assert.equal(job.state, 'passed');
    assert.deepEqual(seen, []);
  });

  it('a failed container inventory is not an empty one', async () => {
    r = rig();
    r.runtime.orphans = ['pcbjob-old-1'];
    r.runtime.listBroken = true;
    await assert.doesNotReject(r.mgr.tick());
    r.runtime.listBroken = false;
    await r.mgr.tick();
    assert.deepEqual(r.runtime.orphans, [], 'the inventory is tried again');
  });

  it('results wait for the cleanup', async () => {
    const base = await boot();
    r.runtime.cleanBroken = true;
    const res = await fetch(`${base}/jobs`, { method: 'POST', headers: { ...auth, 'x-job-spec': header({ command: ['pass'] }) }, body: await fs.openAsBlob(tarOf(r.dir)) });
    const { id } = (await res.json()) as { id: string };
    await until(() => r.mgr.jobs.get(id)!.state === 'passed', 'passed');
    assert.equal((await fetch(`${base}/jobs/${id}/results`, { headers: auth })).status, 409);
    r.runtime.cleanBroken = false;
    await until(() => r.mgr.jobs.get(id)!.attempts[0].trimmed === true, 'trimmed');
    assert.equal((await fetch(`${base}/jobs/${id}/results`, { headers: auth })).status, 200);
  });

  it('retention keeps a job whose folder could not be cleaned', async () => {
    r = rig();
    const job = r.submit(['pass']);
    await r.mgr.tick();
    await r.mgr.tick();
    await r.mgr.clean?.();
    r.runtime.cleanBroken = true;
    r.clock.now += 8 * 86_400_000;
    await r.mgr.clean?.();
    assert.ok(r.mgr.jobs.has(job.id));
    assert.ok(fs.existsSync(r.mgr.store.jobDir(job.id)));
  });

  it('the cleaner sees only the attempt folder, with no network and no way to follow a link out', () => {
    r = rig({ cgroupParent: 'pcbjobs.slice' });
    const a = docker.cleanArgs?.('c', '/data/jobs/x/attempts/1', true, r.cfg) ?? [];
    assert.ok(a.includes('/data/jobs/x/attempts/1:/a'));
    assert.equal(a.filter((x) => x === '-v').length, 1);
    assert.equal(a[a.indexOf('--network') + 1], 'none');
    assert.equal(a[a.indexOf('--cap-drop') + 1], 'ALL');
    assert.equal(a[a.indexOf('--cgroup-parent') + 1], 'pcbjobs.slice');
    assert.match(a.join(' '), /rm -rf \/a\/work/);
    assert.match(a.join(' '), /find \/a\/out -mindepth 1 ! -type f ! -type d -delete/);
    assert.ok(!a.join(' ').includes(' -L '), 'find must not follow links');
    assert.match((docker.cleanArgs?.('c', '/x', false, r.cfg) ?? []).join(' '), /rm -rf \/a\/work \/a\/out/);
  });
});

describe('review 2, item 2: upload slot', () => {
  it('a disconnect during validation cancels it, and the slot is held until then', async () => {
    const base = await boot({ maxUploads: 1 });
    const body = fs.readFileSync(tarOf(r.dir));
    const pidFile = path.join(r.dir, 'tar.pid');
    fakeProgram('tar', `echo $$ > ${pidFile}\nexec sleep 30`);
    const req = http.request(new URL(`${base}/jobs`), {
      method: 'POST',
      headers: { ...auth, 'x-job-spec': header({ command: ['pass'] }), 'content-length': body.length },
    });
    req.on('error', () => undefined);
    req.end(body);
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 'validation running');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    req.destroy();
    await new Promise((ok) => setTimeout(ok, 150));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) process.kill(pid, 'SIGKILL');
    assert.equal(alive, false, 'validation goes on for a client that left');
  });

  it('the slot stays taken while validation runs after a disconnect', async () => {
    const base = await boot({ maxUploads: 1 });
    const body = fs.readFileSync(tarOf(r.dir));
    const pidFile = path.join(r.dir, 'tar.pid');
    // Ignores SIGTERM for a moment, as a tar stuck in a read can: the slot must wait for the real end.
    fakeProgram('tar', `echo $$ > ${pidFile}\ntrap '' TERM\nsleep 1`);
    const req = http.request(new URL(`${base}/jobs`), {
      method: 'POST',
      headers: { ...auth, 'x-job-spec': header({ command: ['pass'] }), 'content-length': body.length },
    });
    req.on('error', () => undefined);
    req.end(body);
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 'validation running');
    req.destroy();
    await new Promise((ok) => setTimeout(ok, 100));
    const res = await fetch(`${base}/jobs`, { method: 'POST', headers: { ...auth, 'x-job-spec': header({ command: ['pass'] }) }, body: 'x' });
    assert.equal(res.status, 503);
  });
});

describe('review 2, item 3: blocking', () => {
  it('a slow cleanup does not hold up deadlines', async () => {
    r = rig();
    const done = r.submit(['pass'], { cpus: 1 });
    const hung = r.submit(['hang'], { cpus: 1, timeoutS: 1 });
    await r.mgr.tick();
    await r.mgr.tick();
    await r.mgr.tick();
    assert.equal(done.state, 'passed');
    assert.equal(hung.state, 'running');
    r.runtime.cleanHangs = true;
    void r.mgr.clean?.();
    r.clock.now += 60_000;
    await r.mgr.tick();
    await r.mgr.tick();
    assert.equal(hung.result?.outcome, 'timeout');
    assert.equal(typeof (r.mgr.store as unknown as { trimAttempt?: unknown }).trimAttempt, 'undefined', 'no synchronous tree walk');
  });

  it('root workers run at the lowest priority', () => {
    r = rig();
    assert.deepEqual(docker.lowPriority?.('du', ['-s', '/x'], 'linux'), ['nice', ['-n', '19', 'ionice', '-c', '3', 'du', '-s', '/x']]);
    assert.deepEqual(docker.lowPriority?.('du', ['-s', '/x'], 'darwin'), ['nice', ['-n', '19', 'du', '-s', '/x']]);
  });

  it('du has a time limit', async () => {
    r = rig();
    fakeProgram('du', 'exec sleep 30');
    assert.equal(await docker.dirBytes(['/x'], 100), null);
  });
});

describe('review 2, item 4: measurement fails closed', () => {
  it('du: a nonzero exit is no measurement, even with a total', async () => {
    r = rig();
    fakeProgram('du', 'echo "100\t/a"\nexit 1');
    assert.equal(await docker.dirBytes(['/a']), null);
  });

  it('du: output that does not parse is no measurement', async () => {
    r = rig();
    fakeProgram('du', 'echo "oops"');
    assert.equal(await docker.dirBytes(['/a']), null);
  });

  it('du: a missing line is no measurement', async () => {
    r = rig();
    fakeProgram('du', 'echo "100\t/a"');
    assert.equal(await docker.dirBytes(['/a', '/b']), null);
  });

  it('du: a clean total counts', async () => {
    r = rig();
    fakeProgram('du', 'echo "100\t/a"\necho "1\t/b"');
    assert.equal(await docker.dirBytes(['/a', '/b']), 101 * 1024);
  });

  it('docker: an inspect error is no measurement', async () => {
    r = rig();
    fakeProgram('docker', 'echo "Cannot connect to the Docker daemon" >&2\nexit 1');
    assert.equal(await new docker.DockerRuntime(r.cfg).layerBytes('c'), null);
  });

  it('docker: a value that does not parse is no measurement', async () => {
    r = rig();
    fakeProgram('docker', 'echo "<no value>"');
    assert.equal(await new docker.DockerRuntime(r.cfg).layerBytes('c'), null);
  });

  it('docker: zero only when the container is known to be gone', async () => {
    r = rig();
    fakeProgram('docker', 'echo "Error: No such object: c" >&2\nexit 1');
    assert.equal(await new docker.DockerRuntime(r.cfg).layerBytes('c'), 0);
  });

  it('one failed measurement is forgiven, three in a row kill the job', async () => {
    r = rig();
    const job = r.submit(['hang'], { diskGb: 1 });
    await r.mgr.tick();
    r.runtime.layerSize = null;
    await r.mgr.watchDisk();
    await r.mgr.watchDisk();
    assert.equal(r.runtime.killed.length, 0, 'du fails when a file vanishes mid-walk, which is normal');
    r.runtime.layerSize = 0;
    await r.mgr.watchDisk();
    r.runtime.layerSize = null;
    await r.mgr.watchDisk();
    await r.mgr.watchDisk();
    assert.equal(r.runtime.killed.length, 0, 'a good reading resets the count');
    await r.mgr.watchDisk();
    assert.deepEqual(r.runtime.killed, [job.attempts[0].container]);
  });

  it('a Docker outage is not held against the job', async () => {
    r = rig();
    r.submit(['hang'], { diskGb: 1 });
    await r.mgr.tick();
    r.runtime.layerSize = null;
    r.runtime.dockerUp = false;
    for (let i = 0; i < 5; i++) await r.mgr.watchDisk();
    assert.equal(r.runtime.killed.length, 0);
  });
});

describe('review 2, item 5: list limit', () => {
  it('refuses anything but an integer in 1..500', async () => {
    const base = await boot();
    for (const v of ['-1', '0', '501', '1.5', 'abc', '']) {
      assert.equal((await fetch(`${base}/jobs?limit=${v}`, { headers: auth })).status, 400, `limit=${v}`);
    }
    assert.equal((await fetch(`${base}/jobs?limit=500`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/jobs`, { headers: auth })).status, 200);
  });
});

describe('review 2, item 6: space du cannot see', () => {
  it('docker run caps open files', () => {
    r = rig();
    const a = docker.runArgs({ container: 'c', workDir: '/w', outDir: '/o', inputTar: '/i', image: 'i', cpus: 1, memGb: 1, diskGb: 1, timeoutS: 1, command: ['x'] }, r.cfg);
    assert.ok(a.includes('nofile=1024:1024'), a.join(' '));
  });

  it('crossing the host disk floor kills every running job, with the cause, no retry', async () => {
    r = rig();
    const a = r.submit(['hang'], { cpus: 1 });
    const b = r.submit(['hang'], { cpus: 1 });
    await r.mgr.tick();
    await r.mgr.tick();
    assert.equal(b.state, 'running');
    r.host.diskFreeGb = 19.5;
    await r.mgr.tick();
    await r.mgr.tick();
    for (const job of [a, b]) {
      assert.equal(job.state, 'failed');
      assert.equal(job.result?.outcome, 'disk');
      assert.match(job.result?.detail ?? '', /host disk/);
      assert.equal(job.attempts.length, 1);
    }
  });

  it('above the floor nothing is killed', async () => {
    r = rig();
    r.submit(['hang']);
    await r.mgr.tick();
    r.host.diskFreeGb = 20;
    await r.mgr.tick();
    assert.deepEqual(r.runtime.killed, []);
  });
});
