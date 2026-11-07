import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  startLoop,
  statusLoop,
  decideLoop,
  cancelLoop,
  listLoops,
  loopFolder,
  loopHash,
  LOOP_TERMINAL,
  LOOP_OPEN_NEXT
} from './route-loop.ts';
import type { LoopBackend, LoopEvidence, LoopPolicy, LoopState } from './route-loop.ts';
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'route-loop-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let clock = 100000,
    source = 'source',
    started = 0,
    cancelled = 0,
    serial = Promise.resolve();
  const evidence = new Map<string, LoopEvidence>();
  const backend: LoopBackend = {
    now: () => clock,
    source: () => source,
    validatePolicy: (p) => {
      assert.equal(p.schema, 'policy');
    },
    lock: async (_path, work) => {
      const previous = serial;
      let unlock!: () => void;
      serial = new Promise((r) => {
        unlock = r;
      });
      await previous;
      try {
        return await work();
      } finally {
        unlock();
      }
    },
    start: async (s, r, timeout) => {
      assert.ok(timeout <= s.policy.deadline_s);
      started++;
      const child = { id: `run-${started}`, folder: join(root, `run-${started}`) };
      evidence.set(child.id, { state: 'running', cleanup: false });
      return child;
    },
    recover: () => null,
    inspect: (_s, c) => evidence.get(c.id)!,
    cancel: () => {
      cancelled++;
    },
    propose: async (_s, r, m) => ({
      status: 'accepted',
      policy: { ...r.policy, iters: Number(m.value ?? 90), reuse: 'retained-copper' }
    })
  };
  const policy: LoopPolicy = {
    experimental: true,
    max_rounds: 3,
    deadline_s: 120,
    done_when: 'verified',
    route: { schema: 'policy', iters: 80, max_time_s: 60, keep: 'all', layers: ['F.Cu'], nets: ['A'] }
  };
  const fail = (s: LoopState, key = 'blocked', opens = 2) =>
    evidence.set(s.rounds.at(-1)!.child!.id, {
      state: 'failed',
      cleanup: true,
      receipt_sha256: 'receipt',
      identity_preserved: true,
      candidate: 'candidate',
      cause: key,
      wire_mm: 20,
      vias: 2,
      report: { parity: 0, drc_errors: 0, unconnected: opens, open_nets: ['A'], rows: [{ why: key }] }
    });
  const pass = (s: LoopState, wire = 12) =>
    evidence.set(s.rounds.at(-1)!.child!.id, {
      state: 'passed',
      cleanup: true,
      receipt_sha256: 'receipt',
      identity_preserved: true,
      verified: true,
      candidate: 'candidate',
      wire_mm: wire,
      vias: 1
    });
  return {
    root,
    backend,
    policy,
    fail,
    pass,
    evidence,
    started: () => started,
    cancelled: () => cancelled,
    clock: (n: number) => {
      clock = n;
    },
    source: (s: string) => {
      source = s;
    }
  };
}
test('opt-in is mandatory and policy fields cannot carry model-written commands', async (t) => {
  const f = fixture(t);
  await assert.rejects(startLoop(f.root, 'X', { ...f.policy, experimental: false }, f.backend), /explicitly/);
  await assert.rejects(startLoop(f.root, 'X', { ...f.policy, command: 'rm' }, f.backend), /unknown/);
  assert.equal(f.started(), 0);
});
test('failed round, reasoned move and complete fresh verification end at one verified candidate', async (t) => {
  const f = fixture(t);
  let s = await startLoop(f.root, 'X', f.policy, f.backend);
  f.fail(s);
  s = await statusLoop(f.root, s.id, f.backend);
  assert.equal(s.status, 'decision_required');
  const revision = s.revision;
  s = await decideLoop(
    f.root,
    s.id,
    revision,
    {
      reason: 'The first search reached its work bound; retain its copper and increase passes.',
      move: { kind: 'change_setting', setting: 'passes', value: 90 }
    },
    f.backend
  );
  assert.equal(s.rounds.length, 2);
  assert.equal(s.rounds[1]!.from!.id, 'run-1');
  f.pass(s);
  s = await statusLoop(f.root, s.id, f.backend);
  assert.equal(s.status, 'passed');
  assert.equal(s.best_search, 1);
  assert.equal(s.best_verified, 2);
  assert.equal(s.decisions.length, 1);
  assert.equal(f.started(), 2);
  assert.equal(listLoops(f.root)[0]!.id, s.id);
});
test('decision replay is idempotent and concurrent stale alternatives never launch another round', async (t) => {
  const f = fixture(t);
  let s = await startLoop(f.root, 'X', f.policy, f.backend);
  f.fail(s);
  s = await statusLoop(f.root, s.id, f.backend);
  const d = { reason: 'Continue the preserved candidate.', move: { kind: 'reroute_stuck' } };
  const revision = s.revision;
  await Promise.all([
    decideLoop(f.root, s.id, revision, d, f.backend),
    decideLoop(f.root, s.id, revision, d, f.backend)
  ]);
  assert.equal(f.started(), 2);
  await assert.rejects(
    decideLoop(f.root, s.id, revision, { ...d, reason: 'different' }, f.backend),
    /different decision/
  );
  assert.equal(f.started(), 2);
});
test('two repeated causes stop retries; a prior verified candidate survives a worse later trial', async (t) => {
  const f = fixture(t);
  let s = await startLoop(f.root, 'X', { ...f.policy, max_rounds: 4, done_when: 'budget' }, f.backend);
  f.pass(s);
  s = await statusLoop(f.root, s.id, f.backend);
  const d = {
    reason: 'Try a bounded continuation while retaining the verified candidate.',
    move: { kind: 'change_setting', setting: 'passes', value: 90 }
  };
  s = await decideLoop(f.root, s.id, s.revision, d, f.backend);
  f.fail(s);
  s = await statusLoop(f.root, s.id, f.backend);
  s = await decideLoop(f.root, s.id, s.revision, d, f.backend);
  f.fail(s);
  s = await statusLoop(f.root, s.id, f.backend);
  assert.equal(s.status, 'passed');
  assert.equal(s.best_verified, 1);
  assert.match(s.cause, /same failure/);
  assert.equal(f.started(), 3);
});
test('source drift, cancellation and total deadline wait for child cleanup', async (t) => {
  const f = fixture(t);
  let s = await startLoop(f.root, 'X', f.policy, f.backend);
  f.source('changed');
  s = await statusLoop(f.root, s.id, f.backend);
  assert.equal(s.status, 'stopping');
  assert.ok(f.cancelled() > 0);
  f.fail(s);
  s = await statusLoop(f.root, s.id, f.backend);
  assert.equal(s.status, 'cancelled');
  const g = fixture(t);
  let q = await startLoop(g.root, 'X', g.policy, g.backend);
  g.clock(q.deadline_ms + 1);
  q = await statusLoop(g.root, q.id, g.backend);
  assert.equal(q.status, 'stopping');
  g.fail(q);
  q = await statusLoop(g.root, q.id, g.backend);
  assert.equal(q.status, 'expired');
});
test('unconfirmed cleanup never qualifies a candidate', async (t) => {
  const f = fixture(t);
  let s = await startLoop(f.root, 'X', f.policy, f.backend);
  f.pass(s);
  f.evidence.get('run-1')!.cleanup = false;
  s = await statusLoop(f.root, s.id, f.backend);
  assert.equal(s.status, 'error');
  assert.equal(s.best_verified, null);
});
test('immutable policy and source binding are checked after restart; ambiguous launches are not repeated', async (t) => {
  const f = fixture(t);
  let s = await startLoop(f.root, 'X', f.policy, f.backend);
  const path = join(loopFolder(f.root, s.id), 'state.json');
  let raw = JSON.parse(readFileSync(path, 'utf8'));
  raw.policy.deadline_s = 999;
  writeFileSync(path, JSON.stringify(raw));
  await assert.rejects(statusLoop(f.root, s.id, f.backend), /binding changed/);
  raw = JSON.parse(JSON.stringify(s));
  raw.status = 'launching';
  delete raw.rounds[0].child;
  writeFileSync(path, JSON.stringify(raw));
  s = await statusLoop(f.root, s.id, f.backend);
  assert.equal(s.status, 'blocked');
  assert.equal(f.started(), 1);
});
test('layer and net authority cannot expand, and an explicit stop never launches work', async (t) => {
  const f = fixture(t);
  let s = await startLoop(f.root, 'X', f.policy, f.backend);
  f.fail(s);
  s = await statusLoop(f.root, s.id, f.backend);
  f.backend.propose = async () => ({ status: 'accepted', policy: { ...f.policy.route, layers: ['B.Cu'] } });
  await assert.rejects(
    decideLoop(
      f.root,
      s.id,
      s.revision,
      { reason: 'bad expansion', move: { kind: 'change_setting', setting: 'layers', value: ['B.Cu'] } },
      f.backend
    ),
    /admitted trace layers/
  );
  s = await statusLoop(f.root, s.id, f.backend);
  s = await decideLoop(
    f.root,
    s.id,
    s.revision,
    { reason: 'The move exceeds the admitted layer scope.', move: { kind: 'stop' } },
    f.backend
  );
  assert.equal(s.status, 'stopped');
  assert.equal(f.started(), 1);
});
test('loop storage refuses symlink escapes before writing', async (t) => {
  const f = fixture(t),
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'loop-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(f.root, '.gate'));
  await assert.rejects(startLoop(f.root, 'X', f.policy, f.backend), /leaves the project/);
});
test('a recovered launch and a saved terminal boundary do not repeat work', async (t) => {
  const f = fixture(t);
  let s = await startLoop(f.root, 'X', f.policy, f.backend);
  const file = join(loopFolder(f.root, s.id), 'state.json');
  const child = s.rounds[0]!.child!;
  let raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.status = 'launching';
  delete raw.rounds[0].child;
  writeFileSync(file, JSON.stringify(raw));
  f.backend.recover = () => child;
  s = await statusLoop(f.root, s.id, f.backend);
  assert.equal(s.status, 'running');
  assert.equal(f.started(), 1);
  f.fail(s);
  raw = JSON.parse(JSON.stringify(s));
  raw.rounds[0].evidence = f.evidence.get(child.id);
  writeFileSync(file, JSON.stringify(raw));
  s = await statusLoop(f.root, s.id, f.backend);
  assert.equal(s.status, 'decision_required');
  assert.equal(f.started(), 1);
});
test('an omitted electrical-policy field cannot be added by a decision', async (t) => {
  const f = fixture(t);
  let s = await startLoop(f.root, 'X', f.policy, f.backend);
  f.fail(s);
  s = await statusLoop(f.root, s.id, f.backend);
  f.backend.propose = async () => ({ status: 'accepted', policy: { ...f.policy.route, return_exempt: true } });
  await assert.rejects(
    decideLoop(
      f.root,
      s.id,
      s.revision,
      { reason: 'Attempted policy expansion.', move: { kind: 'reroute_stuck' } },
      f.backend
    ),
    /admitted return_exempt/
  );
  assert.equal(f.started(), 1);
});
test('steady time prevents a wall-clock rollback from granting more loop budget', async (t) => {
  const f = fixture(t);
  let steady = 1000;
  f.backend.clock = () => steady;
  let s = await startLoop(f.root, 'X', f.policy, f.backend);
  f.clock(1);
  steady += 121000;
  s = await statusLoop(f.root, s.id, f.backend);
  assert.equal(s.status, 'stopping');
  assert.ok(f.cancelled() > 0);
  f.fail(s);
  s = await statusLoop(f.root, s.id, f.backend);
  assert.equal(s.status, 'expired');
});
test('loop IDs must match completely and unknown geometry is not a zero-quality score', async (t) => {
  const f = fixture(t);
  let s = await startLoop(f.root, 'X', { ...f.policy, done_when: 'budget' }, f.backend);
  await assert.rejects(statusLoop(f.root, s.id + '\n', f.backend), /loop ID/);
  f.pass(s);
  delete f.evidence.get('run-1')!.wire_mm;
  delete f.evidence.get('run-1')!.vias;
  s = await statusLoop(f.root, s.id, f.backend);
  s = await decideLoop(
    f.root,
    s.id,
    s.revision,
    { reason: 'Try one comparable bounded trial.', move: { kind: 'change_setting', setting: 'passes', value: 90 } },
    f.backend
  );
  f.pass(s, 1);
  s = await statusLoop(f.root, s.id, f.backend);
  assert.equal(s.best_verified, 1, 'an unknown incumbent cannot be claimed worse on invented zero metrics');
  assert.equal(s.rounds[1]!.evidence!.wire_mm, 1);
});
test('startLoop saves the first state inside the controller lock', async (t) => {
  const f = fixture(t);
  const inner = f.backend.lock;
  let stateBeforeLock: boolean | null = null;
  f.backend.lock = (path, work) => {
    stateBeforeLock ??= existsSync(join(dirname(path), 'state.json'));
    return inner(path, work);
  };
  await startLoop(f.root, 'X', f.policy, f.backend);
  assert.equal(stateBeforeLock, false);
});
test('a status poll between admission and launch cannot turn a terminal loop active again', async (t) => {
  const f = fixture(t);
  const inner = f.backend.lock;
  let polled = false;
  f.backend.lock = async (path, work) => {
    if (!polled) {
      polled = true;
      // Studio polls every loop in the store while a start is still admitting.
      await statusLoop(f.root, basename(dirname(path)), { ...f.backend, lock: (_p, w) => w() }).catch(() => undefined);
    }
    return inner(path, work);
  };
  const s = await startLoop(f.root, 'X', f.policy, f.backend);
  const events = readFileSync(join(loopFolder(f.root, s.id), 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(s.status, 'running');
  const reopened = events.some((e, i) => LOOP_TERMINAL.has(e.status) && events.slice(i + 1).some((n) => !LOOP_TERMINAL.has(n.status)));
  assert.equal(reopened, false);
});
test('the transition table has no way out of a terminal status', () => {
  for (const next of Object.values(LOOP_OPEN_NEXT)) for (const to of next) assert.ok(to in LOOP_OPEN_NEXT);
  for (const terminal of LOOP_TERMINAL) assert.equal(terminal in LOOP_OPEN_NEXT, false);
});
test('a rejected decision is not recorded, so the same revision can take a valid one', async (t) => {
  const f = fixture(t);
  let s = await startLoop(f.root, 'X', f.policy, f.backend);
  f.fail(s);
  s = await statusLoop(f.root, s.id, f.backend);
  const revision = s.revision;
  const propose = f.backend.propose;
  f.backend.propose = async (state, round, move) => {
    const proposed = await propose(state, round, move);
    return move.kind === 'bad' ? { ...proposed, policy: { ...proposed.policy!, keep: 'none' } } : proposed;
  };
  await assert.rejects(
    decideLoop(f.root, s.id, revision, { reason: 'Change an admitted field.', move: { kind: 'bad' } }, f.backend),
    /admitted keep policy/
  );
  const after = JSON.parse(readFileSync(join(loopFolder(f.root, s.id), 'state.json'), 'utf8')) as LoopState;
  assert.equal(after.decisions.length, 0);
  assert.equal(after.revision, revision);
  assert.equal(f.started(), 1);
  const next = await decideLoop(
    f.root,
    s.id,
    revision,
    { reason: 'Continue the preserved candidate.', move: { kind: 'reroute_stuck' } },
    f.backend
  );
  assert.equal(next.decisions.length, 1);
  assert.equal(next.rounds.length, 2);
  assert.equal(f.started(), 2);
});
