import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { boardView, judgedEvidence, viewText, type Decide } from './board-view.ts';
import { reseal } from './cad-seal.ts';
import { sealFixtureBoard } from './cad-seal-fixture.ts';
import { recordChange } from './change-log.ts';
import { layoutPlanPath } from './layout-plan.ts';
import { orderCandidate, approveCandidate, releaseRun } from './release-run-fixture.ts';
import { releaseOrdersPath } from './release-order.mjs';
import { approveFixture } from './layout-plan-fixture.ts';
import { loadTransitions } from './transitions.ts';

const BOARD = '(kicad_pcb (general (thickness 1.6)) (layers (0 "F.Cu" signal)) (gr_line (start 0 0) (end 50 0) (layer "Edge.Cuts") (uuid "1")))';
const CLI = fileURLToPath(new URL('../pcb-state.ts', import.meta.url));
const decide = (state: string, code: string, run: string | null = null): Decide => async () => ({ state, blocker: { code }, next_action: { command: 'tools/pcb next X' }, observed_run: run ? { run_id: run } : null });

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'board-view-'))), folder = join(root, 'hardware-design/boards/X');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'gate.json'), JSON.stringify({ project: 'X', checks: {} }));
  writeFileSync(join(folder, 'X.kicad_pcb'), BOARD);
  writeFileSync(join(folder, 'X.kicad_sch'), '(kicad_sch)');
  writeFileSync(join(folder, 'X.kicad_pro'), '{}');
  writeFileSync(join(folder, 'route.json'), JSON.stringify({ schema: 'iot-lab.route.v1', backend: 'tracemaker', layers: ['F.Cu'], stages: [{ name: 'main' }] }));
  writeFileSync(join(folder, 'SPEC.md'), 'source');
  writeFileSync(join(folder, 'placement-constraints.json'), JSON.stringify({ schema: 'iot-lab.placement-constraints.v1', rules: [{ id: 'd', kind: 'part_distance', source: { path: 'hardware-design/boards/X/SPEC.md', sha256: 'x', page: 1 } }] }));
  writeFileSync(layoutPlanPath(root, 'X'), JSON.stringify({ schema: 'iot-lab.layout-plan.v1', intents: [{ id: 'a', statement: 'b', rule_ids: ['d'] }], route_plan: 'hardware-design/boards/X/route.json', approval: null }));
  sealFixtureBoard(root, 'X');
  return { root, folder, base: join(root, '.gate/cli') };
}

test('the view shows each state with its status, inputs and outputs', async t => {
  const f = fixture(t), view = await boardView(f.root, 'X', f.base, decide('blocked', 'layout_plan_missing'));
  assert.equal(view.position.state, 'A8');
  assert.equal(view.position.name, loadTransitions().states.find(state => state.id === 'A8')!.name);
  assert.deepEqual(view.allowed, ['check', 'edit']);
  assert.equal(view.states.length, loadTransitions().states.length);
  const a8 = view.states.find(state => state.id === 'A8')!, a4 = view.states.find(state => state.id === 'A4')!;
  assert.equal(a8.position, true); assert.equal(a4.position, false);
  assert.equal(a4.freshness, 'current');
  assert.ok(a8.inputs.length + a8.outputs.length > 0);
  assert.equal(view.states.find(state => state.id === 'A1')!.freshness, 'unknown', 'a class with no proof is unknown, not current');
  assert.equal(view.states.find(state => state.id === 'A15')!.freshness, null, 'a state with no class has no freshness');
});

test('a path expands with the board, the project and the run, and shows if the file exists', async t => {
  const f = fixture(t), run = join(f.base, 'run-a');
  mkdirSync(join(run, 'images'), { recursive: true });
  writeFileSync(join(run, 'images/top.svg'), '<svg/>');
  const view = await boardView(f.root, 'X', f.base, decide('needs_release', 'release_evidence_missing', 'run-a'));
  const items = view.states.flatMap(state => [...state.inputs, ...state.outputs]);
  const top = items.find(item => item.path?.endsWith('images/top.svg'))!, schematic = items.find(item => item.path?.endsWith('X.kicad_sch'))!;
  assert.equal(top.path, join(run, 'images/top.svg')); assert.equal(top.exists, true); assert.equal(top.image, true);
  assert.equal(schematic.exists, true);
  assert.equal(items.find(item => item.path?.endsWith('images/bottom.svg'))!.exists, false);
  assert.ok(view.images.includes(join(run, 'images/top.svg')));
  assert.equal(items.some(item => item.path?.includes('{')), false);
});

test('a path of a run with no run has no value and does not exist', async t => {
  const f = fixture(t), view = await boardView(f.root, 'X', f.base, decide('blocked', 'x'));
  const item = view.states.flatMap(state => state.outputs).find(entry => entry.template?.includes('{run}'))!;
  assert.equal(item.path, null); assert.equal(item.exists, false);
});

test('an unrecorded change shows what to redo and keep from the widest row', async t => {
  const f = fixture(t);
  writeFileSync(join(f.folder, 'X.kicad_pcb'), BOARD.replace('(thickness 1.6)', '(thickness 0.8)'));
  reseal(f.root, 'X', { tool: 'fixture', run_id: null });
  const view = await boardView(f.root, 'X', f.base, decide('blocked', 'change_unrecorded'));
  const table = loadTransitions(), row = table.kinds.find(kind => kind.id === 'stackup_change')!;
  assert.equal(view.change.state, 'unrecorded');
  assert.equal(view.change.pending.length, 1);
  const pending = view.change.pending[0]!;
  assert.equal(pending.kind, 'stackup_change');
  assert.deepEqual(pending.reenter, row.reenter);
  assert.deepEqual(pending.keep, row.keep);
  assert.deepEqual(pending.redo.map(item => item.evidence), row.redo);
  assert.ok(pending.redo.every(item => ['current', 'stale', 'missing', 'exempt', 'unknown'].includes(item.status)));
  assert.equal(view.allowed.includes('route'), false);
});

test('the last event shows what it asks to redo, with the state of each class now', async t => {
  const f = fixture(t);
  recordChange(f.root, 'X', { kind: 'fab_defect', reason: 'short on U3', by: 'Ana', refs: ['U3'] });
  const view = await boardView(f.root, 'X', f.base, decide('blocked', 'x'));
  assert.equal(view.change.last?.kind, 'fab_defect');
  assert.equal(view.change.last?.reason, 'short on U3');
  assert.ok(view.change.last!.redo.length > 0);
});

test('a decision of pcb next proves the classes that it read, and only those', () => {
  assert.deepEqual(judgedEvidence('board_unplaced'), { placement: 'missing' });
  assert.deepEqual(judgedEvidence('release_evidence_missing'), { placement: 'current', copper: 'current', gate: 'current', release: 'missing' });
  assert.deepEqual(judgedEvidence('a code with no row'), {});
});

test('the position moves with the decision, and the evidence still has the last word', async t => {
  const f = fixture(t);
  assert.equal((await boardView(f.root, 'X', f.base, decide('needs_release', 'release_evidence_missing'))).position.state, 'A8', 'the plan is not approved');
  await approveFixture(f.root, 'X');
  assert.equal((await boardView(f.root, 'X', f.base, decide('needs_place', 'board_unplaced'))).position.state, 'A9');
  assert.equal((await boardView(f.root, 'X', f.base, decide('needs_release', 'release_evidence_missing'))).position.state, 'A21');
});

test('a decision that cannot be made reads as unavailable and proves nothing', async t => {
  const f = fixture(t); await approveFixture(f.root, 'X');
  const view = await boardView(f.root, 'X', f.base, async () => { throw new Error('no gate'); });
  assert.deepEqual(view.next, { state: 'unavailable', cause: 'no gate' });
  assert.equal(view.position.state, 'A9');
});

test('the text view names the position, the allowed events and the images', async t => {
  const f = fixture(t), text = viewText(await boardView(f.root, 'X', f.base, decide('blocked', 'x')));
  assert.match(text, /X is at A8/);
  assert.match(text, /Allowed: check, edit/);
  assert.match(text, /> A8 /);
});

test('pcb state prints JSON and a text view, and an unknown board exits with a cause', t => {
  const f = fixture(t), run = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, '--project', f.root, 'state', ...args], { encoding: 'utf8' });
  const json = run('X', '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).schema, 'iot-lab.board-state.v1');
  const text = run('X');
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /X is at A/);
  assert.notEqual(run('NOBOARD').status, 0);
});

const stateOf = (view: Awaited<ReturnType<typeof boardView>>, id: string) => view.states.find(state => state.id === id)!;
const CREATED = '2026-11-06T10:00:00+00:00';
async function ordered(t: TestContext) {
  const f = fixture(t);
  await approveFixture(f.root, 'X');
  const candidate = releaseRun(f.root, f.base, 'run-rel', CREATED);
  approveCandidate(f.root, candidate);
  orderCandidate(f.root, candidate);
  return { ...f, candidate };
}
const viewOf = (f: { root: string; base: string }) => boardView(f.root, 'X', f.base, decide('blocked', 'x'));

test('a board with no release record has no claim about a release', async t => {
  const f = fixture(t), view = await viewOf(f);
  assert.deepEqual(view.release, { approval: { state: 'missing', path: join(f.folder, 'release-approval.json'), by: null, problems: [], stale: [] }, orders: [], cad_after_order: 'no_order', problems: [] });
  assert.equal(stateOf(view, 'A22').freshness, 'unknown');
  assert.equal(view.position.state, 'A8', 'a missing record does not move the position');
});

test('the view shows the release approval and the orders of the sealed release', async t => {
  const f = await ordered(t), view = await viewOf(f);
  assert.equal(view.release.approval.state, 'approved');
  assert.equal(view.release.approval.by, 'Ana');
  assert.deepEqual(view.release.orders.map(order => order.reference), ['JLC-1']);
  assert.equal(view.release.cad_after_order, 'same');
  assert.equal(stateOf(view, 'A22').freshness, 'current');
  assert.equal(stateOf(view, 'A24').freshness, 'current');
  assert.equal(view.position.state, 'A25');
  assert.match(viewText(view), /Release approval: approved by Ana/);
  assert.match(viewText(view), /Orders: 1, last JLC-1; CAD after the order: same/);
});

test('CAD that differs from the ordered release reads as stale, and the view says so', async t => {
  const f = await ordered(t);
  writeFileSync(join(f.folder, 'X.kicad_pcb'), BOARD.replace('(gr_line', '(gr_text "new" (at 1 1) (layer "F.SilkS"))(gr_line'));
  reseal(f.root, 'X', { tool: 'fixture', run_id: null });
  const view = await viewOf(f);
  assert.equal(view.release.cad_after_order, 'differs');
  assert.equal(stateOf(view, 'A24').freshness, 'stale');
  assert.equal(view.position.state, 'A24');
  assert.match(viewText(view), /CAD after the order: differs/);
});

test('with no sealed run of the order the CAD compare is unknown and never reads as the same', async t => {
  const f = await ordered(t);
  rmSync(join(f.base, 'run-rel'), { recursive: true });
  const view = await viewOf(f);
  assert.equal(view.release.cad_after_order, 'unknown');
  assert.equal(stateOf(view, 'A24').freshness, 'unknown');
  assert.equal(view.release.approval.state, 'stale');
});

test('a run that fails its seal is no proof of the ordered CAD', async t => {
  const f = await ordered(t);
  writeFileSync(join(f.base, 'run-rel/run.json'), JSON.stringify({ run_id: 'run-rel', board: 'X', operation: 'release', created_at: CREATED, changed: true }));
  assert.equal((await viewOf(f)).release.cad_after_order, 'unknown');
});

test('a newer sealed release makes the approval stale', async t => {
  const f = await ordered(t);
  releaseRun(f.root, f.base, 'run-new', '2026-11-06T11:00:00+00:00', '{"revision":"b"}');
  const view = await viewOf(f);
  assert.equal(view.release.approval.state, 'stale');
  assert.equal(view.release.cad_after_order, 'same', 'the order keeps its own run');
  assert.equal(stateOf(view, 'A22').freshness, 'stale');
});

test('a damaged order log is a problem in the view and proves nothing', async t => {
  const f = await ordered(t);
  writeFileSync(releaseOrdersPath(f.root, 'X'), 'not json\n');
  const view = await viewOf(f);
  assert.match(view.release.problems[0]!, /line 1 is not an order/);
  assert.equal(view.release.cad_after_order, 'unknown');
  assert.equal(stateOf(view, 'A24').freshness, 'unknown');
});

test('a damaged approval is a problem in the view and never reads as current', async t => {
  const f = await ordered(t);
  writeFileSync(join(f.folder, 'release-approval.json'), '{');
  const view = await viewOf(f);
  assert.equal(view.release.approval.state, 'invalid');
  assert.equal(stateOf(view, 'A22').freshness, 'unknown');
});
