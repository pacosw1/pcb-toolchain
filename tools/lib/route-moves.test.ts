import assert from 'node:assert/strict';
import test from 'node:test';
import { movedPlan, movedPolicy, nextMove, NOTHING_REVIEWED, reviewedFrom, validateMove } from './route-moves.ts';
import type { Move, MoveContext, Part } from './route-moves.ts';
import type { StuckReport } from './route-stuck.ts';

const report = (fields: Partial<StuckReport> = {}): StuckReport => ({ schema: 'iot-lab.stuck-report.v1', board: 'B', work: 'w', drc_errors: 0, unconnected: 1, parity: 0, enclosed: 0, router_miss: 1, unknown: 0,
  search: { stop: 'stall-passes', max_passes: 80, passes_since_best: 5 }, route_layers: ['F.Cu', 'B.Cu'], reused: false, changed: null, open_nets: ['/A'], region: null, rows: [],
  blockers: { parts: [], nets: [], keepouts: [], layers: [], boxed_in: [] }, summary: [], ...fields });
const blocked = (blockers: Partial<StuckReport['blockers']>, fields: Partial<StuckReport> = {}): StuckReport => report({ enclosed: 1, router_miss: 0, blockers: { ...report().blockers, ...blockers }, ...fields });
const part = (x: number, locked = false): Part => ({ x, y: 10, orientation: 0, locked, pads: ['1', '2'] });
const reviewed = reviewedFrom([{ id: 'FIX', kind: 'fixed', refs: ['J1'] }, { id: 'GRP', kind: 'rigid_group', refs: ['U1', 'C1'] }, { id: 'DIST', kind: 'pin_distance', a: { ref: 'U2', pad: '1' }, b: { ref: 'C2', pad: '1' } }]);
const context = (fields: Partial<MoveContext> = {}): MoveContext => ({ report: blocked({ nets: ['/B'] }), reviewed, bounds: { left: 0, top: 0, right: 50, bottom: 50 },
  parts: new Map([['J1', part(5)], ['U1', part(10)], ['C1', part(12)], ['U2', part(20)], ['C2', part(22)], ['R1', part(30)], ['R2', part(32, true)]]), ...fields });

test('the next move follows from the report', () => {
  assert.deepEqual(nextMove(report()), { kind: 'reroute_stuck' });
  assert.deepEqual(nextMove(report({ search: { stop: 'iters', max_passes: 80, passes_since_best: 0 } })), { kind: 'change_setting', setting: 'passes', value: 160 });
  assert.deepEqual(nextMove(report({ search: { stop: 'iters', max_passes: 1000, passes_since_best: 0 } })), { kind: 'reroute_stuck' });
  assert.deepEqual(nextMove(blocked({ layers: ['/A: F.Cu'], parts: ['R1'] })), { kind: 'change_setting', setting: 'layers', value: ['F.Cu', 'B.Cu'] });
  assert.deepEqual(nextMove(blocked({ parts: ['J1', 'R1'] }), reviewed), { kind: 'move_part', ref: 'R1', dx_mm: null, dy_mm: null });
  assert.deepEqual(nextMove(blocked({ parts: ['U1'] }), reviewed), { kind: 'move_cluster', refs: ['U1', 'C1'], dx_mm: null, dy_mm: null });
  assert.deepEqual(nextMove(blocked({ parts: ['J1'], nets: ['/B'] }), reviewed), { kind: 'widen_region', nets: ['/B'] });
  assert.equal(nextMove(blocked({ parts: ['J1'] }), reviewed).kind, 'ask_user');
  assert.equal(nextMove(report({ parity: 1 })).kind, 'ask_user');
  assert.equal(NOTHING_REVIEWED.groups.length, 0);
});

test('a reuse that came out worse is neither suggested nor allowed again', () => {
  const worse = { reused: true, changed: { worse: true, better: false } };
  assert.equal(nextMove(report(worse)).kind, 'ask_user');
  assert.equal(nextMove(blocked({ nets: ['/B'] }, worse)).kind, 'ask_user');
  assert.equal(nextMove(report({ reused: true, changed: { worse: false, better: true } })).kind, 'reroute_stuck');
  assert.equal(nextMove(report({ reused: true, changed: { worse: false, better: false } })).kind, 'ask_user');
  assert.equal(nextMove(report({ reused: false, changed: { worse: true, better: false } })).kind, 'reroute_stuck');
  assert.deepEqual(validateMove({ kind: 'reroute_stuck' }, context({ report: report({ reused: true, changed: { worse: false, better: false } }) })), []);
  assert.match(validateMove({ kind: 'reroute_stuck' }, context({ report: report(worse) })).join(), /came out worse/);
  assert.match(validateMove({ kind: 'widen_region', nets: ['/A'] }, context({ report: report(worse) })).join(), /came out worse/);
});

test('a move that breaks a reviewed constraint or leaves the list is refused, by name', () => {
  const refused = (move: unknown, text: string) => assert.ok(validateMove(move as Move, context()).join('; ').includes(text), `${JSON.stringify(move)}: ${validateMove(move as Move, context()).join('; ')}`);
  refused({ kind: 'relax_clearance' }, 'is not on the list');
  refused({ kind: 'reroute_stuck', nets: ['/A'] }, 'has no field nets');
  refused({ kind: 'change_setting', setting: 'clearance_mm', value: 0.1 }, 'is no setting');
  refused({ kind: 'change_setting', setting: 'passes', value: 1001 }, 'passes must be');
  refused({ kind: 'change_setting', setting: 'layers', value: ['In1.Cu'] }, 'layers must be some of');
  refused({ kind: 'move_part', ref: 'J1', dx_mm: 1, dy_mm: 0 }, 'fixed by reviewed rule FIX');
  refused({ kind: 'move_part', ref: 'R2', dx_mm: 1, dy_mm: 0 }, 'R2 is locked');
  refused({ kind: 'move_part', ref: 'U1', dx_mm: 1, dy_mm: 0 }, 'rigid group GRP');
  refused({ kind: 'move_part', ref: 'R1', dx_mm: 25, dy_mm: 0 }, 'would leave the board');
  refused({ kind: 'move_part', ref: 'R1', dx_mm: null, dy_mm: null }, 'must be numbers');
  refused({ kind: 'move_cluster', refs: ['U1', 'R1'], dx_mm: 1, dy_mm: 0 }, 'GRP would split');
  refused({ kind: 'swap_pins', ref: 'U2', pads: ['1', '2'] }, 'reviewed rule DIST');
  refused({ kind: 'widen_region', nets: ['/Z'] }, '/Z is neither stuck nor a blocker');
  for (const good of [{ kind: 'reroute_stuck' }, { kind: 'change_setting', setting: 'layers', value: ['B.Cu'] }, { kind: 'move_part', ref: 'R1', dx_mm: 1, dy_mm: -1 },
    { kind: 'move_cluster', refs: ['U1', 'C1'], dx_mm: 1, dy_mm: 0 }, { kind: 'swap_pins', ref: 'R1', pads: ['1', '2'] }, { kind: 'widen_region', nets: ['/B', '/A'] }, { kind: 'ask_user', question: 'Why?' }]) {
    assert.deepEqual(validateMove(good as Move, context()), [], JSON.stringify(good));
  }
});

test('an iotroute policy takes the same moves', () => {
  const policy = { schema: 's', iters: 6, keep: 'lock-nets', reuse: '/old', reuse_nets: ['/Z'] };
  assert.deepEqual(movedPolicy(policy, { kind: 'reroute_stuck' }, '/run/B.kicad_pcb'), { schema: 's', iters: 6, keep: 'lock-nets', reuse: '/run/B.kicad_pcb' });
  assert.deepEqual(movedPolicy(policy, { kind: 'widen_region', nets: ['/B'] }, '/b').reuse_nets, ['/B']);
  assert.deepEqual(movedPolicy(policy, { kind: 'change_setting', setting: 'passes', value: 12 }, '/b'), { schema: 's', iters: 12, keep: 'lock-nets' });
  assert.deepEqual(movedPolicy(policy, { kind: 'change_setting', setting: 'layers', value: ['F.Cu'] }, '/b').layers, ['F.Cu']);
});

test('a route move changes only its own part of the plan', () => {
  const plan = { schema: 's', layers: ['F.Cu'], budget: { passes: 6, time_s: 60 }, stages: [{ name: 'main', layers: ['F.Cu'], passes: 3 }], reuse: { from: '/old', nets: [] } };
  assert.deepEqual(movedPlan(plan, { kind: 'reroute_stuck' }, '/run'), { ...plan, reuse: { from: '/run', nets: [] } });
  assert.deepEqual(movedPlan(plan, { kind: 'widen_region', nets: ['/B'] }, '/run').reuse, { from: '/run', nets: ['/B'] });
  const layers = movedPlan(plan, { kind: 'change_setting', setting: 'layers', value: ['F.Cu', 'B.Cu'] }, '/run');
  assert.deepEqual([layers.layers, layers.stages, layers.reuse], [['F.Cu', 'B.Cu'], [{ name: 'main', passes: 3 }], undefined]);
  const passes = movedPlan(plan, { kind: 'change_setting', setting: 'passes', value: 12 }, '/run');
  assert.deepEqual([passes.budget, passes.stages], [{ passes: 12, time_s: 60 }, [{ name: 'main', layers: ['F.Cu'] }]]);
});
