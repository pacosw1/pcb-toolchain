import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { allowedEvents, assertCommand, BOARD_STATES, CHANGE_KINDS, commandEvidence, commandOf, machineTable, position, transition, type BoardEvent, type BoardState, type Evidenced, type Guards } from './board-machine.ts';
import { judgedEvidence, type Decide } from './board-view.ts';
import { acceptSeal, oneEdit, reseal, sealedWrite } from './cad-seal.ts';
import { changeBlock, changePath, recordChange } from './change-log.ts';
import { startCheck } from './pcb-check-start.ts';
import { layoutPlanPath, layoutPlanStatus } from './layout-plan.ts';
import { recordOrder, releaseOrdersPath } from './release-order.mjs';
import { approveFixture, PNG } from './layout-plan-fixture.ts';
import { approveRelease, releaseApprovalPath, releaseApprovalStatus } from './release-approval.mjs';
import { admitPlace } from '../pcb-place.ts';
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
  recordChange(root, 'X', { kind: 'baseline', reason: 'start', by: 'Ana', refs: [] });
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
  if (!stop.ok) { assert.equal(stop.code, 'guard_failed'); assert.equal(stop.guard, 'change_recorded'); assert.deepEqual(stop.allowed, ['check']); }
});

test('a command with no target stays in its state', () => {
  for (const state of BOARD_STATES) { const result = transition(TABLE, state, command('check'), CLOSED); assert.deepEqual([result.ok, result.ok && result.to], [true, state]); }
});

test('a change goes back to its earliest state and never goes forward', () => {
  const gate = transition(TABLE, 'A18', { type: 'change', kind: 'net_change' }, OPEN);
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
  recordChange(f.root, 'X', { kind: 'outline_change', reason: 'wider', by: 'Ana', refs: [] });
  assert.throws(() => assertCommand(f.root, 'X', 'route'), /refused at A8.*layout_approval is stale/s);
});

test('an unrecorded change refuses a guarded command and names the guard', async t => {
  const f = fixture(t); f.plan();
  await approveFixture(f.root, 'X');
  writeFileSync(join(f.folder, 'gate.json'), JSON.stringify({ project: 'X', checks: { erc: true } }));
  reseal(f.root, 'X', { tool: 'fixture', run_id: null });
  assert.throws(() => assertCommand(f.root, 'X', 'route'), /change_recorded.*no event/s);
  assert.doesNotThrow(() => assertCommand(f.root, 'X', 'check'));
});

const ORDER = { schema: 'iot-lab.release-order.v1', board: 'X', by: 'Ana', candidate_sha256: 'a'.repeat(64), approval_sha256: 'b'.repeat(64), what: 'boards', quantity: 5, reference: 'PO-1' };

test('an order moves the board past the plan: its CAD stays closed, a check and a reorder stay open', async t => {
  const f = fixture(t); f.plan();
  await approveFixture(f.root, 'X');
  writeFileSync(releaseOrdersPath(f.root, 'X'), JSON.stringify(ORDER) + '\n');
  const run = join(f.root, '.gate/cli');
  assert.equal(position(TABLE, commandEvidence(f.root, 'X', run)).state, 'A24');   // no sealed run gives the ordered CAD: the compare is unknown
  for (const name of ['build', 'place', 'route', 'repair'] as const) assert.throws(() => assertCommand(f.root, 'X', name), new RegExp(`${name} is refused at A24`));
  assert.doesNotThrow(() => assertCommand(f.root, 'X', 'check'));
  assert.doesNotThrow(() => assertCommand(f.root, 'X', 'release'));
});

test('no move of A24 and A25 opens CAD work', () => {
  for (const state of ['A24', 'A25'] as const) {
    assert.deepEqual(allowedEvents(TABLE, state, OPEN), ['check', 'release']);
    for (const name of ['edit', 'build', 'place', 'route', 'repair'] as const) assert.equal((transition(TABLE, state, command(name), OPEN) as { code?: string }).code, 'move_not_allowed');
  }
});

test('what a run proves reaches the machine: open copper and a stale gate refuse a release', async t => {
  const f = fixture(t); f.plan();
  await approveFixture(f.root, 'X');
  assert.throws(() => assertCommand(f.root, 'X', 'release', judgedEvidence('candidate_connectivity_open')), /release is refused at A13.*copper is missing/s);
  assert.throws(() => assertCommand(f.root, 'X', 'release', judgedEvidence('evidence_not_current')), /release is refused at A18.*gate is stale/s);
  assert.doesNotThrow(() => assertCommand(f.root, 'X', 'release', judgedEvidence('release_evidence_missing')));
  assert.doesNotThrow(() => assertCommand(f.root, 'X', 'route', judgedEvidence('candidate_connectivity_open')));
});

test('startCheck reads the judged evidence for a release, and a decision that fails stops it', async t => {
  const f = fixture(t), start = (decide: Decide) => startCheck({ root: f.root, base: join(f.root, '.gate/cli'), board: 'X', operation: 'release', timeout: 60, heartbeat: 1, decide });
  f.plan();
  await approveFixture(f.root, 'X');
  await assert.rejects(start(async () => ({ blocker: { code: 'route_stuck' } })), /release is refused at A13/);
  await assert.rejects(start(async () => { throw new Error('no decision'); }), /no decision/);
});

const WRITER = { tool: 'set_stackup', run_id: null };

test('a sealed writer stops at the machine: an unrecorded change, a stale board and an order refuse it', async t => {
  const f = fixture(t), pcb = join(f.folder, 'X.kicad_pcb'), write = () => sealedWrite(pcb, WRITER, () => writeFileSync(pcb, BOARD.replace('(end 50 0)', '(end 99 0)')));
  f.plan();
  await approveFixture(f.root, 'X');
  writeFileSync(join(f.folder, 'gate.json'), JSON.stringify({ project: 'X', checks: { erc: true } }));
  reseal(f.root, 'X', { tool: 'fixture', run_id: null });
  assert.throws(write, /edit is refused at .*change_recorded/s);
  assert.equal(readFileSync(pcb, 'utf8'), BOARD);
  recordChange(f.root, 'X', { kind: 'rule_change', reason: 'erc on', by: 'Ana', refs: [] });
  write();
  recordChange(f.root, 'X', { kind: 'outline_change', reason: 'wider', by: 'Ana', refs: [] });
  writeFileSync(releaseOrdersPath(f.root, 'X'), JSON.stringify(ORDER) + '\n');
  assert.throws(() => sealedWrite(pcb, WRITER, () => writeFileSync(pcb, BOARD)), /edit is refused at A24/);
  assert.match(readFileSync(pcb, 'utf8'), /end 99 0/);
});

test('a sealed board with no log refuses a writer and gives the command', t => {
  const f = fixture(t), pcb = join(f.folder, 'X.kicad_pcb');
  rmSync(changePath(f.root, 'X'));
  rmSync(join(f.folder, 'cad-seal.json'));
  reseal(f.root, 'X', { tool: 'fixture', run_id: null });
  assert.throws(() => sealedWrite(pcb, WRITER, () => writeFileSync(pcb, 'x')), /tools\/pcb change X --kind baseline/);
});

test('one edit may write twice, and a second edit stops at what the first one changed', t => {
  const f = fixture(t), sheet = join(f.folder, 'X.kicad_sch'), pcb = join(f.folder, 'X.kicad_pcb');
  const both = () => { sealedWrite(sheet, WRITER, () => writeFileSync(sheet, '(kicad_sch (a))')); sealedWrite(pcb, WRITER, () => writeFileSync(pcb, BOARD + ' ')); };
  oneEdit(sheet, both);
  assert.equal(changeBlock(f.root, 'X')?.code, 'change_unrecorded');
  assert.throws(() => sealedWrite(pcb, WRITER, () => writeFileSync(pcb, BOARD)), /edit is refused/);
  assert.throws(() => oneEdit(sheet, () => assert.fail('no check ran')), /edit is refused/);
});

test('a run workspace copy stays free of the machine', t => {
  const f = fixture(t), copy = join(f.root, '.gate/work/hardware-design/boards/X'), pcb = join(copy, 'X.kicad_pcb');
  mkdirSync(copy, { recursive: true });
  writeFileSync(pcb, BOARD);
  writeFileSync(join(f.folder, 'gate.json'), JSON.stringify({ project: 'X', checks: { erc: true } }));
  sealedWrite(pcb, WRITER, () => writeFileSync(pcb, BOARD + ' '));
  assert.equal(readFileSync(pcb, 'utf8'), BOARD + ' ');
});

test('pcb change, seal and layout approval stay open on a board that the machine stops', async t => {
  const f = fixture(t), rules = join(f.folder, 'gate.json');
  f.plan();
  writeFileSync(rules, JSON.stringify({ project: 'X', checks: { erc: true } }));
  await acceptSeal(f.root, 'X', 'more checks');
  assert.throws(() => assertCommand(f.root, 'X', 'edit'), /change_recorded/);
  recordChange(f.root, 'X', { kind: 'rule_change', reason: 'erc on', by: 'Ana', refs: [] });
  await approveFixture(f.root, 'X');
  assert.doesNotThrow(() => assertCommand(f.root, 'X', 'route'));
});

test('place asks the machine: an unrecorded change or an order refuses it', async t => {
  const f = fixture(t); f.plan();
  await approveFixture(f.root, 'X');
  assert.doesNotThrow(() => admitPlace(f.root, 'X'));
  writeFileSync(releaseOrdersPath(f.root, 'X'), JSON.stringify(ORDER) + '\n');
  assert.throws(() => admitPlace(f.root, 'X'), /place is refused at A24/);
  rmSync(releaseOrdersPath(f.root, 'X'));
  writeFileSync(join(f.folder, 'gate.json'), JSON.stringify({ project: 'X', checks: { erc: true } }));
  reseal(f.root, 'X', { tool: 'fixture', run_id: null });
  assert.throws(() => admitPlace(f.root, 'X'), /change_recorded/);
});

function releaseInputs(root: string) {
  const candidate = join(root, 'cand'), manifest = join(candidate, 'release-manifest.json'), report = join(root, 'report.json'), image = join(root, 'img.png');
  mkdirSync(candidate);
  writeFileSync(manifest, '{"board":"X"}');
  writeFileSync(report, JSON.stringify({ board: 'X', status: 'ready_for_user_review', checks: { cad_fabrication: { candidate_sha256: createHash('sha256').update(readFileSync(manifest)).digest('hex') } } }));
  writeFileSync(image, PNG);
  return { candidate, report, image };
}

test('a release approval and an order stop where the machine stops a release, and write nothing', async t => {
  const f = fixture(t), { candidate, report, image } = releaseInputs(f.root); f.plan();
  await approveFixture(f.root, 'X');
  writeFileSync(join(f.folder, 'X.kicad_sch'), '(kicad_sch (changed after the gate))');
  reseal(f.root, 'X', { tool: 'fixture', run_id: null });
  assert.throws(() => approveRelease(f.root, 'X', candidate, { by: 'Ana', reason: 'ok', report, image }), /release is refused at .*change_unrecorded/s);
  assert.throws(() => recordOrder(f.root, 'X', candidate, { by: 'Ana', what: 'boards', quantity: 5, reference: 'PO-1' }), /release is refused at .*change_unrecorded/s);
  assert.equal(existsSync(releaseApprovalPath(f.root, 'X')), false);
  assert.equal(existsSync(releaseOrdersPath(f.root, 'X')), false);
  recordChange(f.root, 'X', { kind: 'net_change', reason: 'one more net', by: 'Ana', refs: [] });
  assert.throws(() => approveRelease(f.root, 'X', candidate, { by: 'Ana', reason: 'ok', report, image }), /release is refused at A8.*layout_approval is stale/s);
  await approveFixture(f.root, 'X');
  assert.equal(approveRelease(f.root, 'X', candidate, { by: 'Ana', reason: 'ok', report, image }).state, 'approved');
  assert.equal(recordOrder(f.root, 'X', candidate, { by: 'Ana', what: 'boards', quantity: 5, reference: 'PO-1' }).reference, 'PO-1');
});

async function ordered(t: TestContext) {
  const f = fixture(t), inputs = releaseInputs(f.root); f.plan();
  await approveFixture(f.root, 'X');
  const order = (reference: string) => recordOrder(f.root, 'X', inputs.candidate, { by: 'Ana', what: 'boards', quantity: 5, reference });
  approveRelease(f.root, 'X', inputs.candidate, { by: 'Ana', reason: 'ok', ...inputs });
  const hash = order('PO-1').candidate_sha256, change = (kind: string, refs: string[]) => recordChange(f.root, 'X', { kind, reason: 'why', by: 'Ana', refs });
  return { ...f, order, hash, change };
}

test('a defect names a recorded release, stops its next order, and ends only with a decision', async t => {
  const f = await ordered(t);
  assert.throws(() => f.change('fab_defect', ['U3']), /release hash of a recorded order/);
  assert.throws(() => f.change('bringup_failure', []), /release hash of a recorded order/);
  f.change('fab_defect', [f.hash]);
  assert.throws(() => f.order('PO-2'), /open defect.*defect_closed/);
  assert.throws(() => f.change('defect_closed', [f.hash, 'later']), /new_revision, use_as_is, reorder/);
  f.change('defect_closed', [f.hash, 'reorder']);
  assert.equal(f.order('PO-2').reference, 'PO-2');
  assert.throws(() => f.change('defect_closed', [f.hash, 'reorder']), /no open defect/);
});

test('a new revision ends the ordered CAD: the order proves no position, and the hash takes no order', async t => {
  const f = await ordered(t);
  f.change('bringup_failure', [f.hash]);
  assert.throws(() => assertCommand(f.root, 'X', 'edit'), /edit is refused at A24/);
  f.change('defect_closed', [f.hash, 'new_revision']);
  assert.doesNotThrow(() => assertCommand(f.root, 'X', 'edit'));
  assert.throws(() => f.order('PO-2'), /closed revision/);
});

test('cad_after_order names the ordered release and opens CAD work for the next revision', async t => {
  const f = await ordered(t);
  assert.throws(() => f.change('cad_after_order', []), /release hash of a recorded order/);
  f.change('cad_after_order', [f.hash]);
  assert.doesNotThrow(() => assertCommand(f.root, 'X', 'edit'));
});

test('a withdrawn approval reads as stale until a new approval, and a kind must name a real approval', async t => {
  const f = fixture(t), change = (refs: string[]) => recordChange(f.root, 'X', { kind: 'approval_withdrawn', reason: 'no longer true', by: 'Ana', refs });
  f.plan();
  await approveFixture(f.root, 'X');
  assert.throws(() => change(['plan']), /--refs layout or --refs release/);
  assert.throws(() => change(['release']), /no release approval/);
  change(['layout']);
  assert.deepEqual(layoutPlanStatus(f.root, 'X').stale, ['the approval was withdrawn by c-0002: no longer true']);
  assert.throws(() => assertCommand(f.root, 'X', 'route'), /refused at A8.*layout_approval is stale/s);
  const inputs = releaseInputs(f.root);
  await approveFixture(f.root, 'X', 'Ana', 'a new look at the plan');
  assert.equal(layoutPlanStatus(f.root, 'X').state, 'approved');
  approveRelease(f.root, 'X', inputs.candidate, { by: 'Ana', reason: 'ok', ...inputs });
  change(['release']);
  assert.match(releaseApprovalStatus(f.root, 'X', inputs.candidate).stale[0]!, /withdrawn by c-0003/);
  assert.throws(() => recordOrder(f.root, 'X', inputs.candidate, { by: 'Ana', what: 'boards', quantity: 5, reference: 'PO-1' }), /no approved release/);
});

test('startCheck asks the machine before a run starts', async t => {
  const f = fixture(t);
  await assert.rejects(startCheck({ root: f.root, base: join(f.root, '.gate/cli'), board: 'X', operation: 'release', timeout: 60, heartbeat: 1 }), /release is refused at A7/);
});
