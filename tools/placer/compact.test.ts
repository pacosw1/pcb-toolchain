// The compaction core with fake search, write and route effects: no routing, no pcbnew.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixed, Float, jsonDumps, number } from '../lib/py-compat.mjs';
import {
  bareScale, blockBoxSum, boardScale, choose, fanout, HALO, halo, lengthStop, Measured, rawScale, RouteOutcome, runJson, runLoop,
  Schedule, TimeoutExpired, verdict, virtual, withHalos,
  type Effects, type LoopOptions, type LoopResult, type Problem, type RankedStep, type SearchResult, type Step, type Unit,
} from './compact.ts';

type Row = Record<string, any>;

const unit = (name: string, x: number, y: number, rects: number[][], fixed = false): Unit => ({ name, refs: [name], fixed, x, y, rects });
const board = (w = 10, h = 10) => ({ outline: [[0, 0], [w, 0], [w, h], [0, h]], keepouts: [], edge_clearance: 0 });
const net = (name: string, ...units: number[]) => ({ name, weight: 1, pins: units.map(u => [u, 0, 0, 0, 0]) });
const nets4 = () => [0, 1, 2, 3].map(k => net(`N${k}`, 0, 1));
const near = (a: unknown, b: number, places = 7) => assert.ok(Math.abs(number(a) - b) < 0.5 * 10 ** -places, `${number(a)} is not ${b}`);
const plain = (values: unknown[]): number[] => values.map(number);
const legal = (): SearchResult => ({ candidates: [{ pose: [[2, 2, 0], [8, 8, 0]], cost: 1, illegal: [] }] });
const width = (q: Problem) => {
  const xs = q.board.outline.map(p => number(p[0]));
  return Math.max(...xs) - Math.min(...xs);
};

const pair = (half = 0.5): Problem => ({
  units: [unit('A', 2, 2, [[-half, -half, half, half, 0.5]]), unit('B', 8, 8, [[-half, -half, half, half, 0.5]])], nets: nets4(), board: board(),
});

function fakes(routesBelow: number, stepSeconds = 60) {
  const calls = { search: [] as [number, number][], write: [] as [number, number][], route: [] as string[] };
  let time = 0;
  const effects: Effects = {
    search(q, step) {
      calls.search.push([step, number(q.units[0].rects[0][4])]);
      time += stepSeconds;
      return { ...legal(), history: [{ epoch: 1, cost: 1, pose: [[2, 2, 0], [8, 8, 0]], components: {} }] };
    },
    write(q, pose, k, step) {
      calls.write.push([step, k]);
      return `board-${step}`;
    },
    route(path, step) {
      calls.route.push(path);
      return calls.search[step][1] >= routesBelow ? [0, 3] : [4, 5];   // the spacing the step used stands for s
    },
  };
  return { calls, effects, clock: () => time };
}

const diagnostic = (action: string, kinds = ['native_open'], count = 1, options = {}) => new RouteOutcome([count], {
  status: 'diagnosed', action, findings: kinds.map(classification => ({ classification })), evidence: 'step/route-decision.json', qualified: false,
}, options);

const run = (pr: Problem, effects: Partial<Effects>, options: LoopOptions = {}): Promise<LoopResult> => runLoop(pr, [10, 10], {
  search: legal, write: () => 'b', route: () => [0], ...effects,
}, { budget: 1e9, clock: () => 0, ...options });

test('halo is scale times pitch times the root of the nets that leave the unit', () => {
  near(halo(4, 1), HALO.pitch * 2);
  near(halo(9, 2), 2 * HALO.pitch * 3);
  near(halo(0, 5), 0);
});

test('fan-out counts nets to other units', () => {
  const pr = {
    units: ['A', 'B', 'C'].map(name => unit(name, 1, 1, [[0, 0, 1, 1, 0.5]])),
    nets: [net('N1', 0, 1), net('N2', 0, 2), net('N3', 1, 2), net('N4', 0)], board: board(),
  };
  assert.deepEqual(fanout(pr), [2, 2, 2]);
});

test('with halos the halo is the spacing, never less than D-040', () => {
  const pr = { units: [unit('A', 1, 1, [[0, 0, 1, 1, 0.5]]), unit('B', 5, 5, [[0, 0, 1, 1, 1.0]])], nets: nets4(), board: board() };
  let q = withHalos(pr, 0.1);
  near(q.units[0].rects[0][4], Math.max(0.5, halo(4, 0.1)));
  near(q.units[1].rects[0][4], 1);   // D-040 1.0 mm is larger
  q = withHalos(pr, 5);
  near(q.units[1].rects[0][4], halo(4, 5));
  assert.equal(pr.units[0].rects[0][4], 0.5);   // input unchanged
});

test('a spacing that stays keeps its number type, a grown one is a float', () => {
  const pr = { units: [unit('A', 1, 1, [[0, 0, 1, 1, 1]]), unit('B', 5, 5, [[0, 0, 1, 1, new Float(1) as unknown as number]])], nets: [net('N', 0, 1)], board: board() };
  const low = withHalos(pr, 1);
  assert.equal(jsonDumps(low.units.map(u => u.rects[0][4])), '[1, 1.0]');
  assert.equal(jsonDumps(withHalos(pr, 2.5).units[0].rects[0][4]), '1');   // 2.5 * 0.4 = 1.0 is not more than 1: max(1, 1.0) is the int
  assert.equal(jsonDumps(withHalos(pr, 5).units[0].rects[0][4]), '2.0');
});

test('board scale is one when the units fit and grows with the needed area', () => {
  assert.equal(boardScale({ units: [unit('A', 5, 5, [[-0.5, -0.5, 0.5, 0.5, 0.5]])], nets: [], board: board() }), 1);
  const big = { units: [unit('A', 5, 5, [[-5, -5, 5, 5, 2]])], nets: [], board: board() };
  near(boardScale(big), Math.sqrt((10 + 2) ** 2 / HALO.fill / 100));
});

test('a block counts its border once, not its parts again', () => {
  const u = { ...unit('B', 5, 5, [[-3, -1, -1, 1, 1], [1, -1, 3, 1, 1], [-4, -2, 4, 2, 1]]), box: [1, 3, 9, 7] };
  const pr = { units: [u], nets: [], board: board(20, 20) };
  let need = (8 + 1) * (4 + 1) / HALO.fill;
  near(rawScale(pr), Math.sqrt(need / 400));
  u.rects.push([-4, 2, 4, 5, 1]);   // a rule area rect beyond the border adds its part outside the border
  need += 8 * 3 / HALO.fill;
  near(rawScale(pr), Math.sqrt(need / 400));
});

test('the virtual board scales outline and move box about the centre', () => {
  const pr = { units: [], nets: [], board: board(10, 4), move_box: [2, 1, 4, 3] };
  const q = virtual(pr, 2);
  assert.deepEqual(q.board.outline.map(plain), [[-5, -2], [15, -2], [15, 6], [-5, 6]]);
  assert.deepEqual(plain(q.move_box as unknown[]), [-1, 0, 3, 4]);
  assert.equal(jsonDumps(q.move_box), '[-1.0, 0.0, 3.0, 4.0]');
  assert.equal(virtual(pr, 1), pr);
});

test('the virtual board scales the unit region box', () => {
  const pr = { units: [{ name: 'TP1', in_box: [8, 1, 10, 3] } as unknown as Unit], nets: [], board: board(10, 4) };
  const q = virtual(pr, 2);
  assert.deepEqual(plain(q.units[0].in_box as unknown[]), [11, 0, 15, 4]);   // on the scaled right edge x 15
  assert.deepEqual(pr.units[0].in_box, [8, 1, 10, 3]);
});

test('the schedule shrinks on a pass and bisects after the first fail', () => {
  const schedule = new Schedule(4, 0.85, 0.05);
  assert.equal(schedule.s, 4);
  schedule.report(true);
  near(schedule.s, 3.4);
  schedule.report(true);
  near(schedule.s, 2.89);
  schedule.report(false);   // fail at 2.89: bisect between 3.4 and 2.89
  near(schedule.s, (3.4 + 2.89) / 2);
  schedule.report(true);
  near(schedule.s, (3.145 + 2.89) / 2);
  assert.equal(schedule.done, false);
  schedule.report(true);   // gap now below 5 % of the pass value
  assert.equal(schedule.done, true);
  near(schedule.best, (3.145 + 2.89) / 2);
});

test('a fail at the first scale stops with no pass', () => {
  const schedule = new Schedule(4);
  schedule.report(false);
  assert.equal(schedule.done, true);
  assert.equal(schedule.best, null);
});

test('the schedule stops at the minimum scale', () => {
  const schedule = new Schedule(0.1, 0.5, 0.05, 0.06);
  schedule.report(true);
  assert.equal(schedule.done, true);
  assert.equal(schedule.best, 0.1);
});

test('verdicts', () => {
  const size = [170.5, 86.5];
  const row = (s: number, k: number, unrouted: number, passed: boolean) => ({ s, k, unrouted, passed });
  assert.match(verdict([], size), /no step/);
  assert.match(verdict([row(4, 1.3, 12, false)], size), /not established/);
  assert.match(verdict([row(4, 1.3, -1, false)], size), /no legal placement/);
  const fits = verdict([row(4, 1.3, 0, true), row(3, 1, 0, true)], size);
  assert.match(fits, /fits in 170\.5 x 86\.5 mm/);
  assert.match(fits, /s = 3\.00/);
  const needs = verdict([row(4, 1.2, 0, true), row(3, 1.1, 0, true), row(2.5, 1, 5, false)], size);
  assert.ok(needs.includes(`needs ${fixed(170.5 * 1.1, 1)} x ${fixed(86.5 * 1.1, 1)} mm`), needs);
});

for (const realFirst of [true, false]) {
  for (const [action, kind] of [['resolve_constraint_coverage', 'constraints_unknown'], ['inspect_native_geometry', 'native_geometry'],
    ['inspect_escape', 'escape_failure'], ['diagnose_selected_connections', 'native_open']] as const) {
    test(`a diagnosis stops before another broad search (${action}, realFirst ${realFirst})`, async () => {
      const { calls, effects, clock } = fakes(0);
      const candidate = { path: 'retained/routed.kicad_pcb', sha256: 'a'.repeat(64), qualified: false };
      const result = diagnostic(action, [kind], 1, { candidate });
      const looped = await runLoop(pair(), [10, 10], { ...effects, route: () => result }, { clock, realFirst, budget: 1e6, target: 10 });
      assert.equal(calls.search.length, 1);
      assert.equal(calls.write.length, 1);
      assert.ok(looped.stop.includes(action));
      assert.deepEqual(looped.retained_candidate, candidate);
      assert.equal(looped.best, null);
      assert.equal(looped.qualified, false);
      assert.equal(looped.steps[0].passed, false);   // target cannot promote an open candidate
    });
  }
}

test('a diagnosis stops the outline phase and keeps the prior success apart', async () => {
  const { effects, clock } = fakes(0);
  const routes = [diagnostic('continue_native_validation', ['no_routing_defect'], 0), diagnostic('diagnose_selected_connections')];
  const looped = await runLoop(pair(2), [10, 10], { ...effects, route: () => routes.shift() as RouteOutcome }, { clock, budget: 1e6, sMin: 3.9 });   // sMin: one halo step
  assert.deepEqual(looped.steps.map(row => row.phase), ['halo', 'outline']);
  assert.notEqual(looped.best, null);
  assert.equal(looped.steps.at(-1)?.status, 'routing-decision');
  assert.match(looped.verdict, /routing diagnosis/);
  assert.ok(looped.next_action);
});

test('attributed geometry feedback allows a changed candidate', async () => {
  const { calls, effects, clock } = fakes(0);
  const routes = [diagnostic('inspect_escape', ['escape_failure', 'native_open'], 1, { geometryFeedback: true }), diagnostic('continue_native_validation', ['no_routing_defect'], 0)];
  const looped = await runLoop(pair(), [10, 10], { ...effects, route: () => routes.shift() as RouteOutcome }, { clock, budget: 1e6, realFirst: true });
  assert.equal(calls.write.length, 2);
  assert.notEqual(calls.write[0][0], calls.write[1][0]);
  assert.equal(looped.steps[0].passed, false);
  assert.equal(looped.steps[1].passed, true);
  assert.equal(looped.next_action, null);
});

test('feedback cannot override unknown, native or evidence failures', () => {
  for (const [status, action, kinds] of [
    ['unverified', 'inspect_evidence', ['native_open']], ['unchanged_failed_attempt', 'inspect_prior_diagnosis', ['native_open']],
    ['diagnosed', 'inspect_escape', ['native_geometry', 'escape_failure']], ['diagnosed', 'continue_native_validation', ['new_unsupported_kind']],
  ] as const) {
    const result = new RouteOutcome([0], { status, action, findings: kinds.map(classification => ({ classification })) }, { geometryFeedback: true });
    assert.equal(result.stop, true);
    assert.equal(result.routingStepClean, false);
  }
});

test('the loop shrinks until it fails, then bisects and reports', async () => {
  const { effects, clock } = fakes(halo(4, 2));
  const looped = await runLoop(pair(), [10, 10], effects, { s0: 4, budget: 1e9, clock });
  assert.deepEqual(looped.steps.slice(0, 3).map(t => Number(t.s.toFixed(6))), [4, 3.4, 2.89]);
  assert.ok(looped.steps.every(t => t.passed === (t.s >= 2 - 1e-9)));
  assert.equal(looped.steps[0].unrouted, 0);   // best of the router runs
  assert.deepEqual(looped.steps[0].runs, [0, 3]);
  assert.equal(looped.steps[0].history.length, 1);
  assert.ok((looped.best as Step).s < 2.2);
  assert.ok(looped.verdict);
});

test('kCap keeps every halo step on the real outline', async () => {
  const { effects, clock } = fakes(halo(4, 2));
  assert.ok(boardScale(withHalos(pair(), 12)) > 1);   // uncapped: virtual
  const looped = await runLoop(pair(), [10, 10], effects, { s0: 12, budget: 1e9, clock, kCap: 1 });
  const steps = looped.steps.filter(t => t.phase === 'halo');
  assert.ok(steps.length && steps.every(t => t.k === 1));
});

test('an illegal search retries the same scale on a larger virtual board', async () => {
  const seen: number[] = [];
  const search = (q: Problem) => {
    seen.push(width(q));
    return { candidates: [{ pose: [[2, 2, 0], [8, 8, 0]], cost: 1, illegal: seen.at(-1)! > 10 * 1.3 ? [] : ['A'] }] };
  };
  const looped = await run(pair(), { search }, { s0: 0.1, sMin: 0.09 });
  assert.deepEqual(seen.slice(0, 3).map(w => Number(w.toFixed(3))), [10, 11.5, 13.225]);   // halo phase
  const t = looped.steps[0];
  assert.equal(t.passed, true);
  near(t.k, 1.3225);
  assert.equal(t.tries, 3);
});

test('realFirst places on the real outline and stops at the first step that routes', async () => {
  const widths: number[] = [];
  const search = (q: Problem) => {
    widths.push(width(q));
    return { candidates: [{ pose: [[2, 2, 0], [8, 8, 0]], cost: 1, illegal: widths.length > 1 ? [] : ['A'] }] };   // the largest halo is not legal
  };
  const looped = await run(pair(1), { search }, { s0: 4, realFirst: true });
  assert.ok(widths.every(w => Math.abs(w - 10) < 1e-9));   // the outline never grows
  assert.deepEqual(looped.steps.map(t => t.phase), ['real', 'real']);
  assert.deepEqual(looped.steps.map(t => t.passed), [false, true]);
  assert.ok(looped.steps[0].s > looped.steps[1].s);
  assert.match(looped.verdict, /fits in 10\.0 x 10\.0 mm/);
});

test('realFirst falls back to the virtual phases when the real outline fails', async () => {
  const looped = await run(pair(1), { route: () => [5] }, { s0: 4, realFirst: true });
  assert.equal(looped.steps[0].phase, 'real');
  assert.equal(looped.steps.find(t => t.phase !== 'real')?.phase, 'halo');
  assert.equal(looped.best, null);
});

test('a search with no result is a failed step and the loop goes on', async () => {
  // DOOR run 6: the outline-phase search timed out (rc 124) and the run stopped with an exception
  const lines: string[] = [];
  const looped = await run(pair(2), { search: q => (width(q) < 12 ? null : legal()) }, { s0: 4, log: line => lines.push(line) });
  const failed = looped.steps.filter(t => t.illegal[0] === 'no search result');
  assert.ok(failed.length);
  assert.ok(failed.every(t => !t.passed && t.board === null));
  assert.ok((looped.best as Step).k >= 1.2);
  assert.ok(lines.some(line => line.includes('cost nan illegal 1 runs [] -> FAIL')));
});

test('after the halo phase the outline phase tries the real board, then bisects the board scale', async () => {
  const seen: Problem[] = [];
  const ks = new Map<number, number>();
  const looped = await run(pair(2), {
    search: q => { seen.push(q); return legal(); },
    write: (q, pose, k, n) => { ks.set(n, k); return `b${n}`; },
    route: (b, n) => (ks.get(n)! >= 1.2 ? [0] : [3]),
  }, { s0: 4 });
  const outline = looped.steps.filter(t => t.phase === 'outline');
  assert.ok(outline.length);
  assert.equal(outline[0].k, 1);   // the real outline first
  assert.equal(outline[0].passed, false);
  assert.ok(boardScale(seen[looped.steps.length - outline.length]) <= 1 + 1e-6);   // the largest halo scale that fits it
  const best = (looped.best as Step).k;
  assert.ok(best >= 1.2 && best <= 1.2 * 1.03);
  assert.match(looped.verdict, /needs/);
});

test('the outline phase never tries a board smaller than the bare parts', async () => {
  // bare parts (s = 0) need 144.5 mm2 on a 100 mm2 board: k below sqrt(1.445) = 1.202 cannot hold them
  const ks = new Map<number, number>();
  const looped = await run(pair(4), {
    write: (q, pose, k, n) => { ks.set(n, k); return `b${n}`; },
    route: (b, n) => (ks.get(n)! >= 1.25 ? [0] : [3]),
  }, { s0: 4 });
  const outline = looped.steps.filter(t => t.phase === 'outline');
  const halos = looped.steps.filter(t => t.phase === 'halo' && t.passed);
  const bestHalo = halos.reduce((a, b) => (b.k < a.k || (b.k === a.k && b.s < a.s) ? b : a));
  near(bareScale(pair(4)), 1.2020815, 6);
  assert.ok(outline.length);
  assert.ok(outline.every(t => t.k > 1.202));
  assert.ok(outline.every(t => t.s > 0 && t.s <= bestHalo.s));
  const best = (looped.best as Step).k;
  assert.ok(best >= 1.25 && best <= 1.25 * 1.03);
});

test('the outline phase reports a fit when the real board routes', async () => {
  const ks = new Map<number, number>();
  const looped = await run(pair(2), {   // the halo phase fails below s 3.0 (k about 1.3); the real board still routes with small halos
    write: (q, pose, k, n) => { ks.set(n, k); return `b${n}`; },
    route: (b, n) => (ks.get(n)! >= 1.3 || ks.get(n) === 1 ? [0] : [2]),
  }, { s0: 4 });
  assert.equal((looped.best as Step).k, 1);
  assert.match(looped.verdict, /fits in 10\.0 x 10\.0 mm/);
});

test('the loop stops at the time budget', async () => {
  const { effects, clock } = fakes(0, 100);
  const looped = await runLoop(pair(), [10, 10], effects, { s0: 4, budget: 250, clock });
  assert.equal(looped.steps.length, 3);   // starts at 0, 100, 200; not at 300
  assert.match(looped.stop, /budget/);
});

const one = (): Problem => ({ units: [unit('A', 2, 2, [[0, 0, 1, 1, 0.5]])], nets: [], board: board() });
const onePose = (): SearchResult => ({ candidates: [{ pose: [[2, 2, 0]], cost: 1, illegal: [] }] });

test('a routing timeout keeps the checkpoint board but cannot pass', async () => {
  let time = 0;
  const looped = await run(one(), {
    search: onePose, write: () => 'checkpoint',
    route: () => { time = 10; throw new TimeoutExpired('router', 1); },
  }, { realFirst: true, budget: 2, clock: () => time });
  assert.equal(looped.best, null);
  assert.equal(looped.steps[0].board, 'checkpoint');
  assert.equal(looped.steps[0].status, 'timeout');
  assert.equal(looped.steps[0].passed, false);
});

test('a placement timeout does not route', async () => {
  let time = 0;
  const forbidden = (): never => assert.fail('timeout must not write or route');
  const looped = await run(one(), {
    search: () => { time = 10; throw new TimeoutExpired('placement', 1); }, write: forbidden, route: forbidden,
  }, { realFirst: true, budget: 2, clock: () => time });
  assert.equal(looped.steps[0].status, 'timeout');
  assert.equal(looped.best, null);
});

test('a zero diagnostic budget keeps the real attempts and stops the diagnostic work', async () => {
  const looped = await run(one(), { search: onePose, route: () => [3] }, { realFirst: true, budget: 1e6, diagnosticBudget: 0 });
  assert.ok(looped.steps.length);
  assert.ok(looped.steps.every(t => t.phase === 'real'));
  assert.match(looped.stop, /budget/);
});

test('a step keeps the key order of the Python record, and run.json its floats', async () => {
  const looped = await run(pair(), { route: () => new Measured([0], { length_mm: new Float(1580), vias: 296, routed: 'r' }) }, { s0: 4, realFirst: true });
  assert.deepEqual(Object.keys(looped.steps[0]), ['s', 'k', 'tries', 'cost', 'illegal', 'phase', 'history', 'pose', 'halo', 'board', 'runs', 'unrouted', 'passed', 'measure', 'box_sum']);
  const record = runJson(looped) as Row;
  assert.equal(jsonDumps(record.steps[0].k), '1.0');
  assert.equal(jsonDumps(record.best.k), '1.0');
  assert.equal(jsonDumps(record.steps[0].box_sum), '0.0');
});

const stepRow = (s: number, length: number | null = null, vias: number | null = null, box: number | null = null, passed = true, k = 1): RankedStep =>
  ({ s, k, passed, ...(length === null ? {} : { measure: { length_mm: length, vias, routed: 'r.kicad_pcb' }, box_sum: box }) });

test('the length rank takes the shortest route, not the smallest halo', () => {
  // README pin-escape run A: 1580 / 1937 / 1661 / 1914 mm at s 0.542 / 0.461 / 0.392 / 0.333
  const steps = [stepRow(0.542, 1580, 296, 2407), stepRow(0.461, 1937, 310, 2300), stepRow(0.392, 1661, 300, 2200), stepRow(0.333, 1914, 320, 2100)];
  const [best, why] = choose(steps, 'length');
  assert.equal(best, steps[0]);
  assert.match(why, /shortest routed length of 4/);
  assert.equal(choose(steps, 'halo')[0], steps[3]);
});

test('ties go to fewer vias, then to the smaller box sum', () => {
  const [a, b, c] = [stepRow(0.6, 1500, 290, 2500), stepRow(0.5, 1500, 280, 2600), stepRow(0.4, 1500, 280, 2400)];
  assert.equal(choose([a, b], 'length')[0], b);
  assert.equal(choose([a, b, c], 'length')[0], c);
});

test('failed, virtual and unmeasured steps', () => {
  const fail = stepRow(0.3, 1000, 100, 1000, false);
  const virtualStep = stepRow(0.9, 1100, 100, 1000, true, 1.2);
  const real = stepRow(0.5, 1600, 300, 2400);
  assert.equal(choose([fail, virtualStep, real, stepRow(0.4)], 'length')[0], real);
  assert.deepEqual(choose([fail], 'length'), [null, 'no passing step']);
  const [best, why] = choose([stepRow(0.5), stepRow(0.4)], 'length');
  assert.equal(best?.s, 0.4);
  assert.match(why, /fallback/);
});

test('the length stop comes after k passing steps that rank after the best', () => {
  const [a, b] = [stepRow(0.6, 1600, 300), stepRow(0.54, 1580, 296)];
  const [worse1, worse2] = [stepRow(0.46, 1937, 310), stepRow(0.39, 1661, 300)];
  const failed = stepRow(0.35, null, null, null, false);
  assert.equal(lengthStop([a, b], 2), false);
  assert.equal(lengthStop([a, b, worse1], 2), false);
  assert.equal(lengthStop([a, b, worse1, failed], 2), false);   // a failed step does not count
  assert.equal(lengthStop([a, b, worse1, failed, worse2], 2), true);
  assert.equal(lengthStop([a, b, worse1], 1), true);
  assert.equal(lengthStop([a, b, worse1, worse2], 0), false);   // 0 = no stop
  assert.equal(lengthStop([a, b, worse1, stepRow(0.4, 1570, 290)], 2), false);   // a new best resets
});

test('the block box sum counts rigid borders and soft block boxes', () => {
  const pr: Problem = {
    units: [{ ...unit('B1', 0, 0, [[-1, -1, 1, 1, 0]]), box: [-2, -2, 2, 3] }, unit('R1', 0, 0, [[-1, -1, 1, 1, 0]]), unit('C1', 0, 0, [[-1, -1, 1, 1, 0]])],
    nets: [{ name: '~block:U9', weight: 4, cohesion: true, pins: [[1, -1, -1, 1, 1], [2, -1, -1, 1, 1]] },
      { name: '~comp:X', weight: 1, cohesion: true, pins: [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]] }],
    board: board(),
  };
  near(blockBoxSum(pr, [[10, 10, 0], [0, 0, 0], [4, 0, 0]]), 4 * 5 + 6 * 2);
});

test('the block box sum turns a soft block pin with the part', () => {
  const pr: Problem = { units: [unit('R1', 0, 0, [])], nets: [{ name: '~block:U9', cohesion: true, pins: [[0, 0, 0, 2, 1]] }], board: board() };
  assert.deepEqual([0, 1, 2, 3, -1].map(turn => blockBoxSum(pr, [[0, 0, turn]])), [2, 2, 2, 2, 2]);
});

const lengths = [1700, 1580, 1937, 1661, 1500, 1600, 1650, 1700];   // every step passes
const measuredRoute = (b: string, n: number) => new Measured([0], { length_mm: lengths[n], vias: 300, routed: `step-${n}` });

for (const [lengthPatience, count, bestStep] of [[2, 4, 1], [3, 8, 4]] as const) {
  test(`the loop ranks by length and stops after ${lengthPatience} worse passing steps`, async () => {
    const looped = await run(pair(1), { write: (q, p, k, n) => `step-${n}`, route: measuredRoute }, { s0: 0.5, kCap: 1, rank: 'length', lengthPatience });
    assert.equal(looped.steps.length, count);
    assert.ok(looped.stop.startsWith('length stop'));
    assert.equal(looped.best_step, bestStep);
    assert.match(looped.best_reason, /shortest routed length/);
    assert.equal(looped.steps[1].measure?.length_mm, 1580);
  });
}

test('the old default ranks by halo and has no length stop', async () => {
  const looped = await run(pair(1), { route: measuredRoute }, { s0: 0.5, kCap: 1, sMin: 0.2 });
  assert.equal(looped.rank, 'halo');
  assert.equal(looped.best_step, looped.steps.length - 1);
});

const three = (): SearchResult => ({ candidates: [0, 1, 2, 3].map(i => ({ pose: [[2 + i, 2, 0], [8, 8, 0]], cost: i + 1, illegal: i === 3 ? ['bad'] : [] })) });

function routeTop(outcomes: Record<number, any>, options: LoopOptions) {
  const seen = { write: [] as number[], route: [] as number[], limit: [] as (number | null)[] };
  let time = 0;
  const effects: Partial<Effects> = {
    search: three,
    write: (q, pose, k, step, slot = 0) => (seen.write.push(slot), `b-${slot}`),
    route: (path, step, slot = 0) => (seen.route.push(slot), time += 10, outcomes[slot]),
    limit: seconds => void seen.limit.push(seconds),
  };
  return { seen, looped: runLoop(pair(), [10, 10], effects as Effects, { realFirst: true, budget: 300, clock: () => time, ...options }) };
}

test('route-top routes the retained candidates and stops at the first verified one', async () => {
  const { seen, looped } = routeTop({ 0: [4], 1: [0], 2: [0] }, { routeTop: 3 });
  const t = (await looped).steps[0];
  assert.deepEqual(seen.route, [0, 1]);
  assert.deepEqual(t.route_top?.map(r => [r.slot, r.passed, r.chosen]), [[0, false, false], [1, true, true]]);
  assert.equal(t.passed, true);
  assert.equal(t.board, 'b-1');
  assert.equal(number(t.cost), 2);
  assert.deepEqual(seen.limit.slice(0, 2), [100, null]);   // the budget of 300 s split in 3
});

test('route-top pick length routes all legal candidates and takes the shortest verified', async () => {
  const m = (length: number) => new Measured([0], { length_mm: length, vias: 1 });
  const { seen, looped } = routeTop({ 0: m(50), 1: m(40), 2: m(45) }, { routeTop: 4, routeTopPick: 'length', routeTopBudget: 20 });
  const t = (await looped).steps[0];
  assert.deepEqual(seen.route, [0, 1, 2]);   // the illegal one is never routed
  assert.deepEqual(t.route_top?.map(r => r.chosen), [false, true, false]);
  assert.equal(number(t.measure?.length_mm), 40);
  assert.equal(seen.limit[0], 20);
});

test('route-top with nothing verified keeps the fewest unrouted, earliest on a tie', async () => {
  const { looped } = routeTop({ 0: [5], 1: [2], 2: [2] }, { routeTop: 3, target: 0, budget: 1e6 });
  const t = (await looped).steps[0];
  assert.equal(t.passed, false);
  assert.deepEqual(t.route_top?.map(r => r.chosen), [false, true, false]);
  assert.equal(t.unrouted, 2);
});

test('route-top off routes only the first candidate and records nothing extra', async () => {
  const { seen, looped } = routeTop({ 0: [0] }, {});
  const t = (await looped).steps[0];
  assert.deepEqual(seen.route, [0]);
  assert.equal(t.route_top, undefined);
});
