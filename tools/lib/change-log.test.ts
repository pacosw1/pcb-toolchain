import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { reseal } from './cad-seal.ts';
import { changeBlock, changePath, changeStatus, groupHashes, readChanges, recordChange } from './change-log.ts';
import { sha256Text } from './fingerprint.ts';
import { gateInputs } from './gate-inputs.mjs';
import { layoutAdmission } from './pcb-candidate-screens.ts';
import { layoutGate, layoutPlanPath, layoutPlanStatus } from './layout-plan.ts';
import { approveFixture } from './layout-plan-fixture.ts';
import { walkSources } from './pcb-sources.ts';
import { loadTransitions } from './transitions.ts';

const BOARD = '(kicad_pcb (general (thickness 1.6)) (layers (0 "F.Cu" signal)) (setup (stackup (layer "core" (thickness 1.5)))) (footprint "R" (layer "F.Cu") (at 1 1) (property "Reference" "R1")) (gr_line (start 0 0) (end 50 0) (layer "Edge.Cuts") (uuid "1")))';
const NOW = () => new Date('2026-11-06T10:00:00Z');
const CLI = fileURLToPath(new URL('../pcb-state.ts', import.meta.url));

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'change-log-'))), folder = join(root, 'hardware-design/boards/X');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'gate.json'), JSON.stringify({ project: 'X', checks: {} }));
  writeFileSync(join(folder, 'X.kicad_pcb'), BOARD);
  writeFileSync(join(folder, 'X.kicad_sch'), '(kicad_sch)');
  writeFileSync(join(folder, 'X.kicad_pro'), '{}');
  reseal(root, 'X', { tool: 'fixture', run_id: null });
  const write = (name: string, text: string) => { writeFileSync(join(folder, name), text); reseal(root, 'X', { tool: 'fixture', run_id: null }); };
  const record = (kind: string, reason = 'a reason', by = 'Ana') => recordChange(root, 'X', { kind, reason, by, refs: [], now: NOW });
  return { root, folder, write, record, log: changePath(root, 'X') };
}

test('a board with no log has not started, and the status says so', t => {
  const f = fixture(t), status = changeStatus(f.root, 'X');
  assert.equal(status.state, 'not_started');
  assert.equal(changeBlock(f.root, 'X'), null);
});

test('the table groups and the hashes have the same names', t => {
  const f = fixture(t);
  assert.deepEqual(Object.keys(groupHashes(f.root, 'X')).sort(), Object.keys(loadTransitions().groups).sort());
});

test('the baseline records each group, starts the chain and can be first only', t => {
  const f = fixture(t), event = f.record('baseline'), hashes = groupHashes(f.root, 'X');
  assert.equal(event.id, 'c-0001');
  assert.equal(event.prev_sha256, null);
  assert.equal(event.at, '2026-11-06T10:00:00.000Z');
  assert.deepEqual(event.groups.schematic, { before: null, after: hashes.schematic });
  assert.equal(changeStatus(f.root, 'X').state, 'recorded');
  assert.throws(() => f.record('baseline'), /already has a baseline/);
});

test('the first event must be the baseline', t => {
  const f = fixture(t);
  assert.throws(() => f.record('fab_defect'), /--kind baseline/);
  assert.equal(existsSync(f.log), false);
});

test('a kind of a group needs a change in that group and records before and after', t => {
  const f = fixture(t); f.record('baseline');
  const before = groupHashes(f.root, 'X');
  assert.throws(() => f.record('stackup_change'), /no change in group board_shape/);
  f.write('X.kicad_pcb', BOARD.replace('(thickness 1.5)', '(thickness 1.2)'));
  const event = f.record('stackup_change', 'thinner core');
  assert.equal(event.id, 'c-0002');
  assert.deepEqual(Object.keys(event.groups), ['board_shape']);
  assert.deepEqual(event.groups.board_shape, { before: before.board_shape, after: groupHashes(f.root, 'X').board_shape });
  const first = readFileSync(f.log, 'utf8').split('\n')[0]!;
  assert.equal(event.prev_sha256, sha256Text(first));
  assert.equal(changeStatus(f.root, 'X').state, 'recorded');
});

test('a kind with no file change has empty groups', t => {
  const f = fixture(t); f.record('baseline');
  assert.deepEqual(f.record('fab_defect', 'short on U3').groups, {});
});

test('a bad request writes nothing', t => {
  const f = fixture(t); f.record('baseline');
  const size = readFileSync(f.log).length;
  assert.throws(() => f.record('nothing'), /unknown change kind nothing/);
  assert.throws(() => f.record('human_edit'), /human_edit names no change/);
  assert.throws(() => f.record('fab_defect', ' '), /--reason/);
  assert.throws(() => f.record('fab_defect', 'r', ' '), /--by/);
  assert.equal(readFileSync(f.log).length, size);
});

test('a run workspace or an unsealed board is refused', t => {
  const f = fixture(t); f.record('baseline');
  assert.throws(() => recordChange(join(f.root, '.gate/work'), 'X', { kind: 'fab_defect', reason: 'r', by: 'A', refs: [], now: NOW }), /not canonical/);
  writeFileSync(join(f.folder, 'X.kicad_pcb'), BOARD.replace('(end 50 0)', '(end 60 0)'));
  assert.throws(() => f.record('outline_change'), /changed outside our tools/);
});

test('an unrecorded change gives the widest row of the group and fails closed', t => {
  const f = fixture(t); f.record('baseline');
  f.write('X.kicad_pcb', BOARD.replace('(thickness 1.5)', '(thickness 1.2)'));
  const status = changeStatus(f.root, 'X');
  assert.equal(status.state, 'unrecorded');
  if (status.state !== 'unrecorded') return;
  assert.deepEqual(status.groups.map(row => [row.group, row.kind.id]), [['board_shape', 'stackup_change']]);
  const block = changeBlock(f.root, 'X');
  assert.equal(block?.code, 'change_unrecorded');
  assert.match(block!.message, /board_shape/);
  assert.match(block!.message, /re-enter A6/);
  assert.equal(layoutGate(f.root, 'X', () => {})?.code, 'change_unrecorded');
});

test('each group of files has its own widest row', t => {
  const f = fixture(t); f.record('baseline');
  f.write('X.kicad_sch', '(kicad_sch (changed))');
  f.write('gate.json', JSON.stringify({ project: 'X', checks: { erc: true } }));
  const status = changeStatus(f.root, 'X');
  assert.equal(status.state, 'unrecorded');
  if (status.state === 'unrecorded') assert.deepEqual(status.groups.map(row => [row.group, row.kind.id]), [['schematic', 'part_swap_new_footprint'], ['rules', 'rule_change']]);
});

test('placement and copper are not an unrecorded change', t => {
  const f = fixture(t); f.record('baseline');
  f.write('X.kicad_pcb', BOARD.replace('(at 1 1)', '(at 9 9)').replace('(gr_line', '(segment (start 1 1) (end 2 2) (width 0.2) (layer "F.Cu") (net 1)) (gr_line'));
  assert.equal(changeStatus(f.root, 'X').state, 'recorded');
});

test('a hand edit of the log breaks the chain and fails closed', t => {
  const edits: [string, (text: string) => string][] = [
    ['changed line', text => text.replace('a reason', 'b reason')],
    ['removed line', text => text.split('\n').filter((_, index) => index !== 1).join('\n')],
    ['partial line', text => text.slice(0, -1)],
    ['bad JSON', text => text + 'nothing\n'],
    ['unknown key', text => text.replace('"kind"', '"extra":1,"kind"')],
    ['unknown kind', text => text.replace('fab_defect', 'nothing')],
  ];
  for (const [name, edit] of edits) {
    const f = fixture(t); f.record('baseline'); f.record('fab_defect'); f.record('out_of_stock');
    writeFileSync(f.log, edit(readFileSync(f.log, 'utf8')));
    const status = changeStatus(f.root, 'X');
    assert.equal(status.state, 'invalid', name);
    assert.equal(changeBlock(f.root, 'X')?.code, 'change_log_invalid', name);
    assert.throws(() => f.record('fab_defect'), /not valid/, name);
  }
});

test('a board that cannot be read is invalid, not recorded', t => {
  const f = fixture(t); f.record('baseline');
  f.write('X.kicad_pcb', 'not a board');
  assert.equal(changeStatus(f.root, 'X').state, 'invalid');
});

test('an event never makes evidence valid', async t => {
  const f = fixture(t);
  writeFileSync(join(f.folder, 'route.json'), JSON.stringify({ schema: 'iot-lab.route.v1', backend: 'tracemaker', layers: ['F.Cu'], stages: [{ name: 'main' }] }));
  writeFileSync(join(f.folder, 'SPEC.md'), 'source');
  f.write('placement-constraints.json', JSON.stringify({ schema: 'iot-lab.placement-constraints.v1', rules: [{ id: 'd', kind: 'part_distance', source: { path: 'hardware-design/boards/X/SPEC.md', sha256: 'x', page: 1 } }] }));
  writeFileSync(layoutPlanPath(f.root, 'X'), JSON.stringify({ schema: 'iot-lab.layout-plan.v1', intents: [{ id: 'a', statement: 'b', rule_ids: ['d'] }], route_plan: 'hardware-design/boards/X/route.json', approval: null }));
  await approveFixture(f.root, 'X');
  f.record('baseline');
  f.write('X.kicad_pcb', BOARD.replace('(end 50 0)', '(end 60 0)'));
  assert.equal(layoutPlanStatus(f.root, 'X').state, 'stale');
  f.record('outline_change', 'wider board');
  assert.equal(changeBlock(f.root, 'X'), null);
  assert.equal(layoutPlanStatus(f.root, 'X').state, 'stale');
  assert.equal(layoutGate(f.root, 'X', () => {})?.code, 'layout_plan_stale');
});

test('a new approval stops on an unrecorded change', async t => {
  const f = fixture(t);
  writeFileSync(join(f.folder, 'route.json'), JSON.stringify({ schema: 'iot-lab.route.v1', backend: 'tracemaker', layers: ['F.Cu'], stages: [{ name: 'main' }] }));
  writeFileSync(join(f.folder, 'SPEC.md'), 'source');
  f.write('placement-constraints.json', JSON.stringify({ schema: 'iot-lab.placement-constraints.v1', rules: [{ id: 'd', kind: 'part_distance', source: { path: 'hardware-design/boards/X/SPEC.md', sha256: 'x', page: 1 } }] }));
  writeFileSync(layoutPlanPath(f.root, 'X'), JSON.stringify({ schema: 'iot-lab.layout-plan.v1', intents: [{ id: 'a', statement: 'b', rule_ids: ['d'] }], route_plan: 'hardware-design/boards/X/route.json', approval: null }));
  f.record('baseline');
  f.write('X.kicad_pcb', BOARD.replace('(end 50 0)', '(end 60 0)'));
  await assert.rejects(approveFixture(f.root, 'X'), /no event/);
});

test('a release run stops on an unrecorded change, and a check run does not', t => {
  const f = fixture(t); f.record('baseline');
  f.write('X.kicad_pcb', BOARD.replace('(end 50 0)', '(end 60 0)'));
  mkdirSync(join(f.root, 'run/operation'), { recursive: true });
  const folder = join(f.root, 'run');
  assert.equal(layoutAdmission(f.root, folder, { board: 'X', operation: 'release' } as never, () => {}), true);
  assert.match(readFileSync(join(folder, 'operation/result.json'), 'utf8'), /change_unrecorded/);
  assert.equal(layoutAdmission(f.root, folder, { board: 'X', operation: 'check' } as never, () => {}), false);
});

test('the log is no gate input and no candidate source', t => {
  const f = fixture(t); f.record('baseline');
  assert.equal(gateInputs(f.root, 'X').files.some(path => path.endsWith('changes.jsonl')), false);
  const found: string[] = [];
  walkSources(f.folder, f.root, 'X', found);
  assert.ok(found.some(path => path.endsWith('X.kicad_pcb')));
  assert.equal(found.some(path => path.endsWith('changes.jsonl')), false);
});

test('pcb change appends one line and a refused request exits with the cause', t => {
  const f = fixture(t), run = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, '--project', f.root, 'change', 'X', ...args], { encoding: 'utf8' });
  const first = run('--kind', 'baseline', '--reason', 'start of the log', '--by', 'Ana', '--json');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).id, 'c-0001');
  assert.equal(readChanges(f.root, 'X').length, 1);
  const refused = run('--kind', 'nothing', '--reason', 'r', '--by', 'Ana');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /unknown change kind/);
  const text = run('--kind', 'fab_defect', '--reason', 'short on U3', '--by', 'Ana', '--refs', 'U3,U4');
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /c-0002 fab_defect/);
  assert.deepEqual(readChanges(f.root, 'X')[1]!.refs, ['U3', 'U4']);
  assert.equal(run('--reason', 'r', '--by', 'Ana').status === 0, false);
});
