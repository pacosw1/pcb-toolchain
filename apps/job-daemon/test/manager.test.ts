import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runArgs } from '../src/docker.ts';
import { validateSpec } from '../src/manager.ts';
import { installProtectedRuntime, reconcileProtectedCancellations } from '../src/protected-runtime.ts';
import { HttpError } from '../src/types.ts';
import { rig, tarOf } from './helpers.ts';
import type { Rig } from './helpers.ts';

let r: Rig;
beforeEach(() => {
  r = rig();
});
afterEach(() => r.cleanup());

const states = (id: string): string[] =>
  fs.readFileSync(r.mgr.store.eventsFile(id), 'utf8').trim().split('\n').map((l) => JSON.parse(l).to as string);

/** Ticks and moves the clock to the end of any backoff until the job ends. */
async function settle(id: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await r.mgr.tick();
    const job = r.mgr.jobs.get(id)!;
    if (job.nextAttemptAt) r.clock.now = Date.parse(job.nextAttemptAt); // only as far as the backoff: the deadline is real
    if (['passed', 'failed', 'cancelled'].includes(job.state)) return;
  }
  assert.fail(`job did not end: ${r.mgr.jobs.get(id)!.state}`);
}

describe('states', () => {
  it('refuses protected admission when the associated input archive changed', async () => {
    const ref = { project:'p', board:'b', operation:'route', job:'protected', attempt:'attempt' };
    const tar = tarOf(r.dir), bytes = fs.readFileSync(tar), identity = { sha256:createHash('sha256').update(bytes).digest('hex'), size:bytes.length };
    const job = r.mgr.submit(validateSpec({command:['hang'],maxRetries:0},r.cfg),tar,ref);
    const authority = {canDispatchProtected:()=>true,runtimeInputIdentity:()=>identity,pendingRuntimeCancellations:()=>[]};
    installProtectedRuntime(authority as never,r.mgr);
    fs.appendFileSync(r.mgr.store.inputTar(job.id),'tamper');
    await r.mgr.tick(); assert.equal(job.state,'queued'); assert.equal(r.runtime.started.length,0);
    fs.writeFileSync(r.mgr.store.inputTar(job.id),bytes);
    await r.mgr.tick(); assert.equal(job.state,'running');
  });
  it('keeps protected jobs held across restart until coordinator admits them', async () => {
    const ref = { project:'p', board:'b', operation:'route', job:'protected', attempt:'attempt' };
    const spec = validateSpec({ command:['hang'], maxRetries:0 }, r.cfg);
    const job = r.mgr.submit(spec, tarOf(r.dir), ref);
    await r.mgr.tick(); assert.equal(job.state, 'queued'); assert.equal(r.runtime.started.length, 0);
    r.restart(); await r.mgr.tick(); assert.equal(r.mgr.jobs.get(job.id)?.state, 'queued');
    r.mgr.protectedAdmission = current => current.id === job.id && current.protectedRef?.job === 'protected';
    r.mgr.protectedContinuation = () => true;
    await r.mgr.tick(); assert.equal(r.mgr.jobs.get(job.id)?.state, 'running');
    const container = r.mgr.jobs.get(job.id)!.attempts[0].container;
    r.restart(); await r.mgr.tick();
    assert.equal(r.mgr.jobs.get(job.id)?.state, 'cancelled');
    assert.deepEqual(r.runtime.killed, [container]);
  });
  it('reconciles a durable protected cancellation into the actual manager', async () => {
    const job = r.submit(['hang']); await r.mgr.tick();
    const authority = { pendingRuntimeCancellations: () => [{ job:'protected', attempt:'attempt', runtimeJob:job.id }] };
    assert.deepEqual(reconcileProtectedCancellations(authority as never, r.mgr).requested, [job.id]);
    assert.equal(job.cancelRequested, true);
    await r.mgr.tick();
    assert.equal(job.state, 'cancelled');
    assert.deepEqual(r.runtime.killed, [job.attempts[0].container]);
  });
  it('queued -> running -> passed, input extracted, only out/ kept', async () => {
    const job = r.submit(['pass']);
    assert.equal(job.state, 'queued');
    await r.mgr.tick();
    assert.equal(job.state, 'running');
    assert.ok(fs.existsSync(path.join(r.mgr.store.workDir(job.id, 1), 'input.txt')));
    await r.mgr.tick();
    assert.equal(job.state, 'passed');
    assert.deepEqual(states(job.id), ['queued', 'running', 'passed']);
    await r.mgr.clean();
    assert.deepEqual(fs.readdirSync(r.mgr.store.attemptDir(job.id, 1)), ['out']);
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
    fs.writeFileSync(path.join(r.mgr.store.workDir(job.id, 1), 'input.txt'), 'dirty');
    await r.mgr.tick();
    r.clock.now += 31_000;
    await r.mgr.tick();
    assert.equal(fs.readFileSync(path.join(r.mgr.store.workDir(job.id, 2), 'input.txt'), 'utf8'), 'in\n');
  });
});

describe('queue wait', () => {
  const events = (id: string): { from: string | null; to: string; detail: string }[] =>
    fs.readFileSync(r.mgr.store.eventsFile(id), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const holds = (id: string): string[] => events(id).filter((e) => e.from === e.to).map((e) => e.detail);
  const busy = async (seconds: number): Promise<void> => {
    r.clock.now += seconds * 1000;
    await r.mgr.tick();
  };

  it('the run\'s own time starts when it runs: a long wait costs it nothing', async () => {
    const job = r.submit(['hang'], { timeoutS: 60 });
    r.host.cpuBusyPct = 90;
    await busy(1000);
    assert.equal(job.state, 'queued');
    r.host.cpuBusyPct = 10;
    await r.mgr.tick();
    assert.equal(job.state, 'running');
    await busy(70);
    assert.equal(job.state, 'running', 'inside timeout + kill margin, counted from the start');
    await busy(10);
    await r.mgr.tick();
    assert.equal(job.result?.outcome, 'timeout');
  });

  it('at the bound the job fails with the cause, and it never started', async () => {
    const job = r.submit(['hang'], { queueWaitS: 300 });
    r.host.cpuBusyPct = 90;
    await busy(299);
    assert.equal(job.state, 'queued');
    await busy(1);
    assert.equal(job.state, 'failed');
    assert.equal(job.result?.outcome, 'queue');
    assert.equal(job.result?.exitCode, null);
    assert.match(job.result?.detail ?? '', /^queued for 300 s: host cpu: 90 % busy/);
    assert.equal(job.attempts.length, 0);
    assert.equal(r.runtime.started.length, 0);
    assert.equal(r.mgr.status().queued, 0);
  });

  it('a job that can start at the bound starts', async () => {
    const job = r.submit(['hang'], { queueWaitS: 300 });
    r.host.cpuBusyPct = 90;
    await r.mgr.tick();
    r.host.cpuBusyPct = 0;
    await busy(300);
    assert.equal(job.state, 'running');
  });

  it('the bound survives a restart: it counts from the submit', async () => {
    const { id } = r.submit(['hang'], { queueWaitS: 300 });
    r.host.cpuBusyPct = 90;
    await r.mgr.tick();
    r.clock.now += 301_000;
    r.restart();
    await r.mgr.tick();
    const job = r.mgr.jobs.get(id)!;
    assert.equal(job.result?.outcome, 'queue');
    assert.match(job.result?.detail ?? '', /host cpu/);
  });

  it('a job already in the queue when the daemon is upgraded gets the default bound', async () => {
    const job = r.submit(['hang']);
    delete (job.spec as Partial<typeof job.spec>).queueWaitS;
    r.host.cpuBusyPct = 90;
    await busy(r.cfg.defaultQueueWaitS);
    assert.equal(job.result?.outcome, 'queue');
  });

  it('a retry is not a queue wait: the job has run, so "never started" must stay true of this outcome', async () => {
    const job = r.submit(['killed', 'pass'], { queueWaitS: 5 });
    await r.mgr.tick();
    await r.mgr.tick();
    assert.equal(job.state, 'retrying');
    r.host.cpuBusyPct = 90;
    await busy(1000);
    assert.equal(job.state, 'retrying');
    assert.match(job.hold ?? '', /host cpu/);
  });

  it('every hold reason goes to the job\'s events and the journal, once per reason', async (t) => {
    const journal = t.mock.method(console, 'log', () => undefined);
    const job = r.submit(['hang'], { cpus: 8 });
    r.host.cpuBusyPct = 90;
    await busy(2);
    r.host.cpuBusyPct = 91; // the same reason with another number
    await busy(2);
    r.host.memAvailableGb = 15;
    r.host.cpuBusyPct = 10;
    await busy(2);
    const seen = holds(job.id);
    assert.equal(seen.length, 2, seen.join('\n'));
    assert.match(seen[0], /^queued for 2 s: host cpu: 90 % busy/);
    assert.match(seen[1], /^queued for 6 s: host memory/);
    const lines = journal.mock.calls.map((c) => String(c.arguments[0]));
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes(job.id) && lines[0].includes('host cpu'), lines[0]);
    assert.ok(lines[1].includes(job.id) && lines[1].includes('host memory'), lines[1]);
  });

  it('a hold that lasts says so again every 30 s, with the live numbers', async (t) => {
    t.mock.method(console, 'log', () => undefined);
    const job = r.submit(['hang'], { cpus: 8 });
    r.host.cpuBusyPct = 90;
    await busy(2);
    r.host.cpuBusyPct = 80;
    await busy(29);
    assert.equal(holds(job.id).length, 1);
    await busy(1);
    const seen = holds(job.id);
    assert.equal(seen.length, 2);
    assert.match(seen[1], /^queued for 32 s: host cpu: 80 % busy/);
  });

  it('the record carries the reason while it holds and drops it at the start', async (t) => {
    t.mock.method(console, 'log', () => undefined);
    const { id } = r.submit(['hang']);
    r.host.cpuBusyPct = 90;
    await busy(2);
    assert.match(r.mgr.store.loadAll()[0].hold ?? '', /host cpu/);
    r.host.cpuBusyPct = 0;
    await busy(2);
    const job = r.mgr.jobs.get(id)!;
    assert.equal(job.hold, undefined);
    assert.equal(r.mgr.store.loadAll()[0].hold, undefined);
    assert.equal(events(id).at(-1)?.detail, 'attempt 1, after 4 s queued');
  });

  it('a job behind the head says which job it waits for, and why', async (t) => {
    t.mock.method(console, 'log', () => undefined);
    const a = r.submit(['hang'], { cpus: 16 });
    await r.mgr.tick();
    const b = r.submit(['hang'], { cpus: 8 });
    const c = r.submit(['hang'], { cpus: 1 });
    await busy(2);
    assert.equal(a.state, 'running');
    assert.match(holds(b.id)[0], /cpu budget: 16 of 16/);
    assert.match(holds(c.id)[0], new RegExp(`behind ${b.id}: cpu budget`));
  });

  it('checks the bound it is given', () => {
    const spec = (o: object) => validateSpec({ command: ['x'], ...o }, r.cfg);
    assert.equal(spec({}).queueWaitS, r.cfg.defaultQueueWaitS);
    assert.equal(spec({ queueWaitS: 120 }).queueWaitS, 120);
    for (const v of [0, -1, r.cfg.maxQueueWaitS + 1, 1.5, '60']) {
      assert.throws(() => spec({ queueWaitS: v }), (e: HttpError) => e.status === 400, String(v));
    }
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

  it('holds when the job would take the host to the guard\'s cut line, then starts', async () => {
    const job = r.submit(['hang'], { cpus: 8 }); // 8 of 32 CPUs is 25 %
    r.host.cpuBusyPct = 70;
    await r.mgr.tick();
    assert.equal(job.state, 'queued');
    assert.match(r.mgr.hold, /host cpu: 70 % busy, job adds 25 %, limit 95 %/);
    r.host.cpuBusyPct = 69.9;
    await r.mgr.tick();
    assert.equal(job.state, 'running');
    assert.equal(r.mgr.hold, '');
  });

  it('a bigger job needs more room on the same host', async () => {
    const job = r.submit(['hang'], { cpus: 16 });
    r.host.cpuBusyPct = 45;
    await r.mgr.tick();
    assert.equal(job.state, 'queued');
    r.host.cpuBusyPct = 44;
    await r.mgr.tick();
    assert.equal(job.state, 'running');
  });

  it('the FW-IO hold does not repeat: the guard logged 19-51 % busy for those 5 min 33 s', async () => {
    const job = r.submit(['hang'], { cpus: 8 });
    r.host.cpuBusyPct = 50.7;
    await r.mgr.tick();
    assert.equal(job.state, 'running');
  });

  it('holds until the host has a first CPU reading', async () => {
    const job = r.submit(['hang']);
    r.host.cpuBusyPct = null;
    await r.mgr.tick();
    assert.equal(job.state, 'queued');
    assert.match(r.mgr.hold, /host cpu: no reading yet/);
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
    await r.mgr.clean();
    const running = r.submit(['hang']);
    await r.mgr.tick();
    r.clock.now += 8 * 86_400_000;
    await r.mgr.clean();
    assert.ok(!r.mgr.jobs.has(old.id));
    assert.ok(!fs.existsSync(r.mgr.store.jobDir(old.id)));
    assert.ok(r.mgr.jobs.has(running.id));
  });
});

describe('docker arguments', () => {
  it('hard limits, no network, no pull, low OOM priority', () => {
    const cfg = { ...r.cfg, jobUid: 1000, cgroupParent: 'pcbjobs.slice' };
    const a = runArgs({ container: 'c', workDir: '/w', outDir: '/o', inputTar: '/i', image: 'img:1', cpus: 4, memGb: 1.5, diskGb: 1, timeoutS: 60, command: ['python3', 'a b.py'] }, cfg);
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
