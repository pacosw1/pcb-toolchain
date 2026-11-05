import assert from 'node:assert/strict';
import test from 'node:test';
import { sprintPolicy } from './sprint-policy.mjs';
import { runPortfolio, type Backend, type Variant, type Event } from './sprint-controller.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const candidate = (v: Variant, wire = 100) => ({ variant: v.id, board: `${v.id}.pcb`, board_sha256: 'a'.repeat(64), wire_mm: wire, vias: 2, receipt: `${v.id}.receipt` });

test('policy rejects excessive resources, duplicate work and unknown knobs', () => {
  for (const value of [{ seeds: [1, 1] }, { parallelism: 17 }, { seeds: Array.from({length: 16},(_,i)=>i), via_costs:[3,6] },
    { parallelism: 4, mem_gb: 4 }, { deadline_s: 10 }, { deadline_s: 30.5 }, { verify_reserve_s: 120 }, { relax_rules: true }, { seeds: [NaN] }])
    assert.throws(() => sprintPolicy(value));
});

test('one preparation, bounded parallel slices, exact seeds and only verified winners', async () => {
  let prepared = 0, active = 0, peak = 0, settled = 0;
  const calls = new Map<string, number>(); const events: Event[] = [];
  const backend: Backend = {
    async prepare() { prepared++; },
    async slice(v, _signal, progress) {
      active++; peak = Math.max(peak, active);
      await sleep(2); active--;
      calls.set(v.id, (calls.get(v.id) ?? 0) + 1);
      const p = { pass: v.pass + 2, unrouted: 0, conflicts: 0, wire_mm: v.seed, vias: 2 };
      progress({...p,pass:0}); // A core restarting from state emits an initialization frame.
      progress(p);
      return p.pass < 6 ? { kind: 'yielded', pass: p.pass, cpu_s: 0.1, checkpoint: `${v.id}.state`, progress: p }
        : { kind: 'complete', pass: p.pass, cpu_s: 0.1, route: `${v.id}.route`, progress: p };
    },
    async verify(v) { return v.seed === 0 ? null : candidate(v, 100 - v.seed); },
    async settle() { settled++; assert.equal(active, 0); },
  };
  const result = await runPortfolio(sprintPolicy({ seeds: [0,1,2], parallelism: 2 }), 6, backend, e => events.push(e));
  assert.equal(prepared, 1); assert.equal(settled, 1); assert.equal(peak, 2);
  assert.deepEqual([...calls.values()], [3,3,3]);
  assert.equal(result.status, 'PASS'); assert.equal(result.winner?.variant, 'v02');
  assert.equal(result.variants.length, 3); assert.ok(result.variants.every(v => v.checkpoint));
  assert.equal(events.filter(e => e.type === 'sprint.checkpoint').length, 9);
});

test('a completed seed is verified before slower seeds finish searching', async () => {
  let slowRunning=false, verifiedEarly=false;
  const backend: Backend={
    async prepare(){},
    async slice(v){
      if(v.seed===1){slowRunning=true;await sleep(25);slowRunning=false;}else await sleep(2);
      return {kind:'complete',pass:1,cpu_s:0.01,route:`${v.id}.route`};
    },
    async verify(v){if(v.seed===0)verifiedEarly=slowRunning;return candidate(v);},
    async settle(){},
  };
  const result=await runPortfolio(sprintPolicy({seeds:[0,1],parallelism:2}),5,backend);
  assert.equal(result.status,'PASS');assert.ok(verifiedEarly);
});

test('a measured verification reserve protects an incumbent from late native work',async()=>{
  let verifies=0;
  const backend: Backend={
    async prepare(){},
    async slice(v){await sleep(v.seed===0?2:160);return {kind:'complete',pass:1,cpu_s:0.01,route:`${v.id}.route`};},
    async verify(v){verifies++;await sleep(60);return candidate(v);},
    async settle(){},
  };
  const policy={...sprintPolicy({seeds:[0,1],parallelism:2}),deadline_s:8.2,verify_reserve_s:8.01};
  const result=await runPortfolio(policy,5,backend);
  assert.equal(result.status,'PASS');assert.equal(result.winner?.variant,'v00');assert.equal(verifies,1);
  assert.match(result.variants[1]!.reason!,/verification deferred/);
});

test('global search deadline stops the queue while preserving checkpoints for verification', async () => {
  let active = 0, started = 0;
  const backend: Backend = {
    async prepare() { await sleep(5); },
    async slice(v, signal) {
      started++; active++;
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      active--;
      return { kind: 'yielded', pass: 1, cpu_s: 0.01, checkpoint: `${v.id}.state` };
    },
    async verify(v) { assert.equal(active, 0); return candidate(v); },
    async settle() { assert.equal(active, 0); },
  };
  // Small controller-only clock budget; production parsing requires >=30 seconds.
  const policy = { ...sprintPolicy({ seeds: [0,1,2,3], parallelism: 2 }), deadline_s: 8.2, verify_reserve_s: 8.15 };
  const result = await runPortfolio(policy, 80, backend);
  assert.equal(started, 2, 'a deadline cannot reset for each queued variant');
  assert.equal(result.status, 'PASS'); assert.equal(result.candidates.length, 2);
  assert.ok(result.elapsed_s < 2);
});

test('cleanup uncertainty invalidates even an otherwise verified winner', async () => {
  const backend: Backend = {
    async prepare() {}, async slice() { return {kind:'complete', pass:1, cpu_s:0, route:'route.json'}; },
    async verify(v) { return candidate(v); }, async settle() { throw Error('child group remains'); },
  };
  const result = await runPortfolio(sprintPolicy({seeds:[0]}), 5, backend);
  assert.equal(result.status, 'ERROR'); assert.equal(result.winner, null);
  assert.match(result.reason, /cleanup unconfirmed/);
});

test('a proxy score or non-advancing checkpoint never produces a passing result', async () => {
  let verifies = 0;
  const backend: Backend = {
    async prepare() {}, async slice() { return {kind:'yielded', pass:0, cpu_s:0, checkpoint:'state'}; },
    async verify() { verifies++; return null; }, async settle() {},
  };
  const result = await runPortfolio(sprintPolicy({seeds:[0]}), 5, backend);
  assert.equal(verifies, 0); assert.equal(result.winner, null); assert.equal(result.variants[0]!.state, 'failed');
});

test('user cancellation stops scheduling and never returns a winner', async () => {
  const abort = new AbortController(); let settled = false;
  const backend: Backend = {
    async prepare() { abort.abort(); }, async slice() { throw Error('must not start'); },
    async verify() { throw Error('must not verify'); }, async settle() { settled = true; },
  };
  const result = await runPortfolio(sprintPolicy({seeds:[0]}), 5, backend, undefined, abort.signal);
  assert.equal(result.status, 'ERROR'); assert.equal(result.winner, null); assert.ok(settled);
});
