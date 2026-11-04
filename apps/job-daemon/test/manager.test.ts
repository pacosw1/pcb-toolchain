import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runArgs } from '../src/docker.ts';
import { validateSpec } from '../src/manager.ts';
import { HttpError } from '../src/types.ts';
import { rig } from './helpers.ts';
import type { Rig } from './helpers.ts';

let r: Rig;
beforeEach(() => {
  r = rig();
});
afterEach(() => r.cleanup());

const states = (id: string): string[] =>
  fs.readFileSync(r.mgr.store.eventsFile(id), 'utf8').trim().split('\n').map((l) => JSON.parse(l).to as string);

/** Ticks and moves the clock past any backoff until the job ends. */
async function settle(id: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await r.mgr.tick();
    r.clock.now += 1000 * 1000;
    if (['passed', 'failed', 'cancelled'].includes(r.mgr.jobs.get(id)!.state)) return;
  }
  assert.fail(`job did not end: ${r.mgr.jobs.get(id)!.state}`);
}

describe('states', () => {
  it('queued -> running -> passed, input extracted, only out/ kept', async () => {
    const job = r.submit(['pass']);
    assert.equal(job.state, 'queued');
    await r.mgr.tick();
    assert.equal(job.state, 'running');
    assert.ok(fs.existsSync(path.join(r.mgr.store.attemptDir(job.id, 1), 'input.txt')));
    await r.mgr.tick();
    assert.equal(job.state, 'passed');
    assert.deepEqual(states(job.id), ['queued', 'running', 'passed']);
    assert.deepEqual(fs.readdirSync(r.mgr.store.attemptDir(job.id, 1)).sort(), ['.exit-code', 'out']);
    assert.equal(r.runtime.containers.size, 0, 'container removed');
  });

  it('a tool verdict fails at once and does not retry', async () => {
    const job = r.submit(['exit:1']);
    await settle(job.id);
    assert.equal(job.state, 'failed');
    assert.equal(job.attempts.length, 1);
    assert.deepEqual(job.result, { outcome: 'command', exitCode: 1, detail: 'command exit 1' });
  });

  it('cancel while queued', () => {
    const job = r.submit(['pass']);
    r.mgr.cancel(job.id);
    assert.equal(job.state, 'cancelled');
    assert.equal(r.runtime.started.length, 0);
  });

  it('cancel while running kills the container and does not retry', async () => {
    const job = r.submit(['hang']);
    await r.mgr.tick();
    r.mgr.cancel(job.id);
    assert.equal(job.state, 'running', 'stays running until the container is gone');
    await r.mgr.tick();
    assert.equal(job.state, 'cancelled');
    assert.deepEqual(r.runtime.killed, [job.attempts[0].container]);
  });

  it('cancel while retrying', async () => {
    const job = r.submit(['killed']);
    await r.mgr.tick();
    await r.mgr.tick();
    assert.equal(job.state, 'retrying');
    r.mgr.cancel(job.id);
    assert.equal(job.state, 'cancelled');
    r.clock.now += 1000 * 1000;
    await r.mgr.tick();
    assert.equal(r.runtime.started.length, 1, 'no second attempt');
  });

  it('cancel of a finished job changes nothing', async () => {
    const job = r.submit(['pass']);
    await settle(job.id);
    r.mgr.cancel(job.id);
    assert.equal(job.state, 'passed');
  });
});

describe('retry rule', () => {
  it('an outside kill retries, then passes', async () => {
    const job = r.submit(['killed', 'pass']);
    await settle(job.id);
    assert.equal(job.state, 'passed');
    assert.deepEqual(states(job.id), ['queued', 'running', 'retrying', 'running', 'passed']);
    assert.equal(job.attempts[0].outcome, 'infra');
  });

  it('a vanished container retries', async () => {
    const job = r.submit(['vanish', 'pass']);
    await settle(job.id);
    assert.equal(job.state, 'passed');
    assert.equal(job.attempts.length, 2);
  });

  it('a transient docker run error retries', async () => {
    const job = r.submit(['start-infra', 'pass']);
    await settle(job.id);
    assert.equal(job.state, 'passed');
    assert.equal(job.attempts[0].outcome, 'infra');
  });

  it('stops at maxRetries', async () => {
    const job = r.submit(['killed'], { maxRetries: 2 });
    await settle(job.id);
    assert.equal(job.state, 'failed');
    assert.equal(job.attempts.length, 3);
    assert.equal(job.result?.outcome, 'infra');
  });

  it('maxRetries 0 never retries', async () => {
    const job = r.submit(['killed'], { maxRetries: 0 });
    await settle(job.id);
    assert.equal(job.state, 'failed');
    assert.equal(job.attempts.length, 1);
  });

  it('backoff doubles and is respected', async () => {
    const job = r.submit(['killed', 'killed', 'pass']);
    await r.mgr.tick();
    await r.mgr.tick();
    assert.equal(job.state, 'retrying');
    assert.equal(Date.parse(job.nextAttemptAt!) - r.clock.now, 30_000);
    r.clock.now += 29_000;
    await r.mgr.tick();
    assert.equal(job.state, 'retrying', 'not due yet');
    r.clock.now += 1_000;
    await r.mgr.tick();
    assert.equal(job.state, 'running');
    await r.mgr.tick();
    assert.equal(Date.parse(job.nextAttemptAt!) - r.clock.now, 60_000);
  });

  for (const [act, outcome] of [['oom', 'oom'], ['start-image', 'start'], ['exit:124', 'timeout'], ['exit:2', 'command']]) {
    it(`${act} does not retry`, async () => {
      const job = r.submit([act]);
      await settle(job.id);
      assert.equal(job.state, 'failed');
      assert.equal(job.attempts.length, 1);
      assert.equal(job.result?.outcome, outcome);
    });
  }

  it('137 from timeout -k at the limit is a timeout; an early 137 is infrastructure', async () => {
    const late = r.submit(['exit:137'], { timeoutS: 1 });
    await r.mgr.tick();
    r.clock.now += 2000;
    await r.mgr.tick();
    assert.equal(late.result?.outcome, 'timeout');
    const early = r.submit(['exit:137', 'pass']);
    await r.mgr.tick();
    await r.mgr.tick();
    assert.equal(early.attempts[0].outcome, 'infra');
    assert.equal(early.state, 'retrying');
  });

  it('retryExitCodes opts a tool exit code in', async () => {
    const job = r.submit(['exit:2', 'pass'], { retryExitCodes: [2] });
    await settle(job.id);
    assert.equal(job.state, 'passed');
    assert.equal(job.attempts.length, 2);
  });

  it('each attempt starts from a fresh copy of the input', async () => {
    const job = r.submit(['killed', 'hang']);
    await r.mgr.tick();
    fs.writeFileSync(path.join(r.mgr.store.attemptDir(job.id, 1), 'input.txt'), 'dirty');
    await r.mgr.tick();
    r.clock.now += 31_000;
    await r.mgr.tick();
    assert.equal(fs.readFileSync(path.join(r.mgr.store.attemptDir(job.id, 2), 'input.txt'), 'utf8'), 'in\n');
  });
});

describe('budget and queue', () => {
  it('stays inside the CPU budget, FIFO, and starts the next job when one ends', async () => {
    const a = r.submit(['hang'], { cpus: 10 });
    const b = r.submit(['hang'], { cpus: 10 });
    const c = r.submit(['hang'], { cpus: 2 });
    await r.mgr.tick();
    await r.mgr.tick();
    assert.equal(a.state, 'running');
    assert.equal(b.state, 'queued');
    assert.equal(c.state, 'queued', 'a small job does not pass the head of the queue');
    assert.match(r.mgr.hold, /cpu budget: 10 of 16/);
    r.mgr.cancel(a.id);
    await r.mgr.tick();
    assert.equal(b.state, 'running');
    await r.mgr.tick();
    assert.equal(c.state, 'running');
    assert.equal(r.mgr.usage().cpus, 12);
  });

  it('stays inside the memory budget', async () => {
    const a = r.submit(['hang'], { cpus: 1, memGb: 10 });
    const b = r.submit(['hang'], { cpus: 1, memGb: 10 });
    await r.mgr.tick();
    await r.mgr.tick();
    assert.equal(a.state, 'running');
    assert.equal(b.state, 'queued');
    assert.match(r.mgr.hold, /memory budget/);
  });

  it('starts one job per tick', async () => {
    r.submit(['hang'], { cpus: 1 });
    r.submit(['hang'], { cpus: 1 });
    await r.mgr.tick();
    assert.equal(r.runtime.started.length, 1);
  });

  it('holds on host cpu pressure, then starts', async () => {
    const job = r.submit(['hang']);
    r.host.cpuPsiSome10 = 5;
    await r.mgr.tick();
    assert.equal(job.state, 'queued');
    assert.match(r.mgr.hold, /cpu pressure/);
    r.host.cpuPsiSome10 = 4.99;
    await r.mgr.tick();
    assert.equal(job.state, 'running');
    assert.equal(r.mgr.hold, '');
  });

  it('holds when the job would take host memory below the floor', async () => {
    const job = r.submit(['hang'], { memGb: 8 });
    r.host.memAvailableGb = 20; // 20 - 8 = 12 < 62 x 0.2
    await r.mgr.tick();
    assert.equal(job.state, 'queued');
    assert.match(r.mgr.hold, /host memory/);
  });

  it('holds when docker does not answer, without using a retry', async () => {
    const job = r.submit(['pass']);
    r.runtime.dockerUp = false;
    await r.mgr.tick();
    assert.equal(job.state, 'queued');
    assert.equal(job.attempts.length, 0);
    assert.match(r.mgr.hold, /docker/);
  });

  it('refuses a submit below the disk floor', () => {
    r.host.diskFreeGb = 19;
    assert.throws(() => r.submit(['pass']), (e: HttpError) => e.status === 507);
  });

  it('refuses a spec over the budget, an unknown image and a bad command', () => {
    const bad = (o: unknown): void => assert.throws(() => validateSpec(o, r.cfg), (e: HttpError) => e.status === 400);
    bad({ command: ['x'], cpus: 17 });
    bad({ command: ['x'], memGb: 17 });
    bad({ command: ['x'], image: 'alpine' });
    bad({ command: [] });
    bad({ command: 'x' });
    bad({ command: ['x'], timeoutS: 21601 });
    bad({ command: ['x'], maxRetries: 6 });
    bad({ command: ['x'], retryExitCodes: [0] });
  });
});

describe('restart recovery', () => {
  it('a job running during a restart is picked up and finishes', async () => {
    const job = r.submit(['hang']);
    await r.mgr.tick();
    const container = job.attempts[0].container;
    r.restart();
    const again = r.mgr.jobs.get(job.id)!;
    assert.equal(again.state, 'running');
    assert.equal(r.mgr.usage().cpus, 8, 'the budget counts recovered jobs');
    await r.mgr.tick();
    assert.equal(r.runtime.started.length, 1, 'no second start');
    fs.writeFileSync(r.mgr.store.markerFile(job.id, 1), '0\n');
    r.runtime.containers.set(container, { status: 'exited', exitCode: 0, oomKilled: false });
    await r.mgr.tick();
    assert.equal(again.state, 'passed');
  });

  it('a container lost while the daemon was down retries', async () => {
    const job = r.submit(['hang', 'pass']);
    await r.mgr.tick();
    r.runtime.containers.clear();
    r.restart();
    await settle(job.id);
    assert.equal(r.mgr.jobs.get(job.id)!.state, 'passed');
    assert.equal(r.mgr.jobs.get(job.id)!.attempts[0].detail, 'container gone');
  });

  it('the marker gives the verdict when the daemon died after docker rm', async () => {
    const job = r.submit(['hang']);
    await r.mgr.tick();
    fs.writeFileSync(r.mgr.store.markerFile(job.id, 1), '0\n');
    r.runtime.containers.clear();
    r.restart();
    await r.mgr.tick();
    assert.equal(r.mgr.jobs.get(job.id)!.state, 'passed');
    assert.equal(r.mgr.jobs.get(job.id)!.attempts.length, 1);
  });

  it('keeps queue order, retry times and new ids after a restart', async () => {
    const a = r.submit(['killed', 'hang'], { cpus: 8 });
    const big = r.submit(['hang'], { cpus: 16 });
    const small = r.submit(['hang'], { cpus: 1 });
    await r.mgr.tick();
    await r.mgr.tick();
    assert.equal(a.state, 'retrying');
    assert.equal(big.state, 'running', 'a queued job may use the slot during a backoff');
    r.restart();
    assert.equal(r.mgr.jobs.get(a.id)!.nextAttemptAt, a.nextAttemptAt);
    await r.mgr.tick();
    assert.equal(r.mgr.jobs.get(a.id)!.state, 'retrying', 'the backoff survives');
    r.clock.now += 31_000;
    r.mgr.cancel(big.id);
    await r.mgr.tick();
    assert.equal(r.mgr.jobs.get(a.id)!.state, 'running', 'the retry goes first: it was submitted first');
    assert.equal(r.mgr.jobs.get(small.id)!.state, 'queued');
    const c = r.submit(['pass']);
    assert.ok(c.seq > small.seq);
  });

  it('a cancel asked before a restart is carried out after it', async () => {
    const job = r.submit(['hang']);
    await r.mgr.tick();
    r.mgr.cancel(job.id);
    r.restart();
    await r.mgr.tick();
    assert.equal(r.mgr.jobs.get(job.id)!.state, 'cancelled');
  });

  it('does not act when docker gives no answer', async () => {
    const job = r.submit(['hang']);
    await r.mgr.tick();
    r.runtime.inspectBroken = true;
    await r.mgr.tick();
    assert.equal(job.state, 'running');
    assert.equal(job.attempts.length, 1);
  });

  it('forgets a folder with no record, and a stale upload', async () => {
    fs.mkdirSync(r.mgr.store.jobDir('20260101-000000-abcdef'));
    fs.writeFileSync(path.join(r.mgr.store.incomingDir(), 'x.tar.gz'), 'x');
    r.restart();
    assert.ok(!fs.existsSync(r.mgr.store.jobDir('20260101-000000-abcdef')));
    assert.deepEqual(fs.readdirSync(r.mgr.store.incomingDir()), []);
  });
});

describe('retention', () => {
  it('removes finished jobs after retainDays and keeps the rest', async () => {
    const old = r.submit(['pass']);
    await settle(old.id);
    const running = r.submit(['hang']);
    await r.mgr.tick();
    r.clock.now += 8 * 86_400_000;
    await r.mgr.tick();
    assert.ok(!r.mgr.jobs.has(old.id));
    assert.ok(!fs.existsSync(r.mgr.store.jobDir(old.id)));
    assert.ok(r.mgr.jobs.has(running.id));
  });
});

describe('docker arguments', () => {
  it('hard limits, no network, no pull, low OOM priority', () => {
    const cfg = { ...r.cfg, jobUid: 1000, cgroupParent: 'pcbjobs.slice' };
    const a = runArgs({ container: 'c', workDir: '/w', image: 'img:1', cpus: 4, memGb: 1.5, timeoutS: 60, command: ['python3', 'a b.py'] }, cfg);
    const after = (flag: string): string => a[a.indexOf(flag) + 1];
    assert.equal(after('--cpus'), '4');
    assert.equal(after('--memory'), '1536m');
    assert.equal(after('--memory-swap'), '1536m', 'no swap on a shared host');
    assert.equal(after('--network'), 'none');
    assert.equal(after('--pull'), 'never');
    assert.equal(after('--cgroup-parent'), 'pcbjobs.slice');
    assert.equal(after('--oom-score-adj'), '1000');
    assert.equal(after('--user'), '1000:1000');
    assert.deepEqual(a.slice(-4), ['_', '60', 'python3', 'a b.py'], 'the command stays one argument per word');
  });
});
