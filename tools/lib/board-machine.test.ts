import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { assertCommand, BOARD_STATES, CHANGE_KINDS, commandOf, machineTable, position, transition, type BoardEvent, type BoardState, type Evidenced, type Guards } from './board-machine.ts';
import { reseal } from './cad-seal.ts';
import { recordChange } from './change-log.ts';
import { startCheck } from './pcb-check-start.ts';
import { layoutPlanPath } from './layout-plan.ts';
import { approveFixture } from './layout-plan-fixture.ts';
import { COMMANDS, loadTransitions, parseTransitions } from './transitions.ts';

const TABLE = loadTransitions(), OPEN: Guards = { change_recorded: true }, CLOSED: Guards = { change_recorded: false };
const raw = () => JSON.parse(readFileSync(new URL('../pcb-transitions.json', import.meta.url), 'utf8'));
const EVENTS: BoardEvent[] = [...COMMANDS.map(command => ({ type: 'command', command }) as const), ...CHANGE_KINDS.map(kind => ({ type: 'change', kind }) as const)];
const command = (name: typeof COMMANDS[number]): BoardEvent => ({ type: 'command', command: name });
const BOARD = '(kicad_pcb (general (thickness 1.6)) (layers (0 "F.Cu" signal)) (gr_line (start 0 0) (end 50 0) (layer "Edge.Cuts") (uuid "1")))';

// Exhaustive by type: this function does not run. Typecheck fails when a name is outside the unions.
export function typeChecks(): void {
  // @ts-expect-error A99 is not a state
  transition(TABLE, 'A99', command('check'), OPEN);
  // @ts-expect-error B3 is a rule, not a position
  transition(TABLE, 'B3', command('check'), OPEN);
  // @ts-expect-error fly is not a command
  transition(TABLE, 'A1', { type: 'command', command: 'fly' }, OPEN);
  // @ts-expect-error nothing is not a change kind
  transition(TABLE, 'A1', { type: 'change', kind: 'nothing' }, OPEN);
  // @ts-expect-error a guard must have a value
  transition(TABLE, 'A1', command('check'), {});
}

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'board-machine-'))), folder = join(root, 'hardware-design/boards/X');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'gate.json'), JSON.stringify({ project: 'X', checks: {} }));
  writeFileSync(join(folder, 'X.kicad_pcb'), BOARD);
  writeFileSync(join(folder, 'X.kicad_sch'), '(kicad_sch)');
  writeFileSync(join(folder, 'X.kicad_pro'), '{}');
  writeFileSync(join(folder, 'route.json'), JSON.stringify({ schema: 'iot-lab.route.v1', backend: 'tracemaker', layers: ['F.Cu'], stages: [{ name: 'main' }] }));
  writeFileSync(join(folder, 'SPEC.md'), 'source');
  writeFileSync(join(folder, 'placement-constraints.json'), JSON.stringify({ schema: 'iot-lab.placement-constraints.v1', rules: [{ id: 'd', kind: 'part_distance', source: { path: 'hardware-design/boards/X/SPEC.md', sha256: 'x', page: 1 } }] }));
  reseal(root, 'X', { tool: 'fixture', run_id: null });
  const plan = () => writeFileSync(layoutPlanPath(root, 'X'), JSON.stringify({ schema: 'iot-lab.layout-plan.v1', intents: [{ id: 'a', statement: 'b', rule_ids: ['d'] }], route_plan: 'hardware-design/boards/X/route.json', approval: null }));
  return { root, folder, plan };
}

test('the state and kind unions are the rows of the table', () => {
  assert.deepEqual([...BOARD_STATES], TABLE.states.filter(state => state.id.startsWith('A')).map(state => state.id));
  assert.deepEqual([...CHANGE_KINDS], TABLE.kinds.map(kind => kind.id));
  assert.throws(() => machineTable(parseTransitions({ ...raw(), kinds: raw().kinds.filter((kind: { id: string }) => kind.id !== 'fab_defect') })), /fab_defect/);
});

test('every state and event pair has a defined result', () => {
  for (const state of BOARD_STATES) for (const event of EVENTS) for (const guards of [OPEN, CLOSED]) {
    const result = transition(TABLE, state, event, guards), name = `${state} ${JSON.stringify(event)}`;
    assert.equal(result.state, state, name);
    if (result.ok) { assert.ok(BOARD_STATES.includes(result.to), name); continue; }
    assert.ok(['move_not_allowed', 'guard_failed', 'kind_names_no_move'].includes(result.code), name);
    assert.ok(result.allowed.every(item => COMMANDS.includes(item)), name);
    for (const item of result.allowed) assert.equal(transition(TABLE, state, command(item), guards).ok, true, name);
  }
});

test('a move that is not in the table is refused with the state and the allowed events', () => {
  const result = transition(TABLE, 'A8', command('route'), OPEN);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'move_not_allowed');
  assert.deepEqual(result.allowed, ['check', 'edit']);
});

test('a row with a guard is refused when the guard fails, and the row stays in the table', () => {
  const pass = transition(TABLE, 'A9', command('route'), OPEN), stop = transition(TABLE, 'A9', command('route'), CLOSED);
  assert.deepEqual([pass.ok, pass.ok && pass.to], [true, 'A14']);
  assert.equal(stop.ok, false);
  if (!stop.ok) { assert.equal(stop.code, 'guard_failed'); assert.equal(stop.guard, 'change_recorded'); assert.deepEqual(stop.allowed, ['check', 'edit']); }
});

test('a command with no target stays in its state', () => {
  for (const state of BOARD_STATES) { const result = transition(TABLE, state, command('check'), CLOSED); assert.deepEqual([result.ok, result.ok && result.to], [true, state]); }
});

test('a change goes back to its earliest state and never goes forward', () => {
  const gate = transition(TABLE, 'A18', { type: 'change', kind: 'gate_failed' }, OPEN);
  assert.deepEqual([gate.ok, gate.ok && gate.to], [true, 'A4']);
  const early = transition(TABLE, 'A2', { type: 'change', kind: 'outline_change' }, OPEN);
  assert.deepEqual([early.ok, early.ok && early.to], [true, 'A2']);
  const edit = transition(TABLE, 'A9', { type: 'change', kind: 'human_edit' }, OPEN);
  assert.equal(edit.ok, false);
  if (!edit.ok) assert.equal(edit.code, 'kind_names_no_move');
});

test('the position is the first state with no proof', () => {
  const at = (found: Evidenced) => position(TABLE, found);
  assert.equal(at({ schematic: 'missing' }).state, 'A4');
  assert.equal(at({ schematic: 'current', route_plan: 'missing', layout_approval: 'missing' }).state, 'A7');
  assert.deepEqual(at({ schematic: 'current', route_plan: 'current', layout_approval: 'stale' }), { state: 'A8', evidence: 'layout_approval', freshness: 'stale' });
  assert.equal(at({ schematic: 'current', route_plan: 'current', layout_approval: 'unknown' }).state, 'A8', 'unknown is never current');
  assert.deepEqual(at({ schematic: 'exempt', route_plan: 'exempt', layout_approval: 'exempt' }), { state: 'A9', evidence: null, freshness: null });
  assert.equal(at({}).state, 'A1');
  assert.equal(at({ bringup: 'current' }).state, 'A25', 'the last state has no state after it');
});

test('a run maps to one command, and a read of evidence maps to none', () => {
  assert.equal(commandOf('edit', 'place'), 'place');
  assert.equal(commandOf('edit', 'route'), 'route');
  assert.equal(commandOf('edit', 'copper'), 'edit');
  assert.equal(commandOf('route', undefined), 'route');
  assert.equal(commandOf('routing', undefined), null);
});

test('the table refuses a bad move row', () => {
  const bad = (rows: unknown[]) => () => parseTransitions({ ...raw(), moves: rows });
  assert.throws(bad([...raw().moves, { event: 'fly', from: ['A1'], to: null }]), /event fly/);
  assert.throws(bad([...raw().moves, { event: 'route', from: ['A1'], to: 'A99' }]), /A99/);
  assert.throws(bad([...raw().moves, { event: 'route', from: ['B3'], to: null }]), /from B3/);
  assert.throws(bad([...raw().moves, { event: 'check', from: ['A1'], to: null }]), /twice/);
  assert.throws(bad([...raw().moves, { event: 'route', from: ['A1'], to: null, guard: 'luck' }]), /guard luck/);
  assert.throws(bad(raw().moves.filter((row: { event: string }) => row.event !== 'release')), /release has no move/);
});

test('a board with no approved plan may check but may not route or release', async t => {
  const f = fixture(t);
  assert.throws(() => assertCommand(f.root, 'X', 'route'), /route is refused at A7.*route_plan is missing.*layout_plan_missing.*Allowed events: check, edit/s);
  assert.doesNotThrow(() => assertCommand(f.root, 'X', 'check'));
  f.plan();
  assert.throws(() => assertCommand(f.root, 'X', 'release'), /release is refused at A8/);
  await approveFixture(f.root, 'X');
  assert.doesNotThrow(() => assertCommand(f.root, 'X', 'release'));
  writeFileSync(join(f.folder, 'X.kicad_pcb'), BOARD.replace('(end 50 0)', '(end 60 0)'));
  reseal(f.root, 'X', { tool: 'fixture', run_id: null });
  assert.throws(() => assertCommand(f.root, 'X', 'route'), /refused at A8.*layout_approval is stale/s);
});

test('an unrecorded change refuses a guarded command and names the guard', async t => {
  const f = fixture(t); f.plan();
  await approveFixture(f.root, 'X');
  recordChange(f.root, 'X', { kind: 'baseline', reason: 'start', by: 'Ana', refs: [] });
  writeFileSync(join(f.folder, 'gate.json'), JSON.stringify({ project: 'X', checks: { erc: true } }));
  reseal(f.root, 'X', { tool: 'fixture', run_id: null });
  assert.throws(() => assertCommand(f.root, 'X', 'route'), /change_recorded.*no event/s);
  assert.doesNotThrow(() => assertCommand(f.root, 'X', 'check'));
});

test('startCheck asks the machine before a run starts', async t => {
  const f = fixture(t);
  await assert.rejects(startCheck({ root: f.root, base: join(f.root, '.gate/cli'), board: 'X', operation: 'release', timeout: 60, heartbeat: 1 }), /release is refused at A7/);
});
