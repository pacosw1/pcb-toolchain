import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { reseal } from './cad-seal.ts';
import { SCHEMA } from './engineering-constraints.ts';
import { approveLayoutPlan, layoutGate, layoutPlanPath, layoutPlanStatus } from './layout-plan.ts';
import { sha256File } from './json-file.ts';
import { placementRulesPath } from './placement-rules.ts';

type Row = Record<string, unknown>;
const ROUTE = { schema: 'iot-lab.route.v1', backend: 'tracemaker', layers: ['F.Cu', 'B.Cu'], stages: [{ name: 'main' }] };
const rule = (id: string): Row => ({ id, kind: 'part_distance', source: { path: 'hardware-design/boards/X/SPEC.md', sha256: 'x', page: 1 } });
const INTENTS = [{ id: 'usb-top', statement: 'USB-C on top edge', rule_ids: ['distance'] }];

/** A sealed board X with one placement rule, a valid route plan and an unapproved layout plan. */
function fixture(t: TestContext, plan: Row = {}) {
  const root = mkdtempSync(join(tmpdir(), 'layout-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, 'hardware-design/boards/X'); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'gate.json'), JSON.stringify({ project: 'X', checks: {} }));
  writeFileSync(join(folder, 'X.kicad_pcb'), '(kicad_pcb)');
  writeFileSync(join(folder, 'route.json'), JSON.stringify(ROUTE));
  writeFileSync(join(folder, 'SPEC.md'), 'source');
  writeFileSync(placementRulesPath(root, 'X'), JSON.stringify({ schema: SCHEMA, rules: [rule('distance')] }));
  reseal(root, 'X', { tool: 'fixture', run_id: null });
  const path = layoutPlanPath(root, 'X');
  writeFileSync(path, JSON.stringify({ schema: 'iot-lab.layout-plan.v1', intents: INTENTS, route_plan: 'hardware-design/boards/X/route.json', approval: null, ...plan }));
  return { root, folder, path, rules: placementRulesPath(root, 'X'), route: join(folder, 'route.json') };
}
const approve = (root: string) => approveLayoutPlan(root, 'X', 'Ana', 'reviewed the edge intents');
const events = (): { log: Row[]; emit: (kind: string, data?: Row) => void } => { const log: Row[] = []; return { log, emit: (kind, data) => { log.push({ kind, ...data }); } }; };

test('a plan without approval is not approved, and approval records the person, the reason and both hashes', async t => {
  const f = fixture(t);
  assert.equal(layoutPlanStatus(f.root, 'X').state, 'unapproved');
  assert.match(layoutGate(f.root, 'X', () => {})!.message, /tools\/pcb layout X --approve --by NAME --reason TEXT/);
  await approve(f.root);
  assert.equal(layoutPlanStatus(f.root, 'X').state, 'approved');
  assert.equal(layoutGate(f.root, 'X', () => {}), null);
  const saved = JSON.parse(readFileSync(f.path, 'utf8')) as { approval: Row; intents: unknown };
  assert.deepEqual(saved.approval, { by: 'Ana', reason: 'reviewed the edge intents', rules_sha256: sha256File(f.rules), route_plan_sha256: sha256File(f.route) });
  assert.deepEqual(saved.intents, INTENTS);
});

test('a board with no layout plan stops, and the message names the board and the file', t => {
  const f = fixture(t);
  rmSync(f.path);
  const block = layoutGate(f.root, 'X', () => {})!;
  assert.equal(block.code, 'layout_plan_missing');
  assert.match(block.message, /X has no layout plan/);
  assert.match(block.message, /hardware-design\/boards\/X\/layout-plan\.json/);
  assert.match(block.message, /tools\/pcb layout X --approve/);
});

test('a changed rule file makes the approval stale', async t => {
  const f = fixture(t);
  await approve(f.root);
  writeFileSync(f.rules, JSON.stringify({ schema: SCHEMA, rules: [rule('distance'), rule('other')] }));
  const status = layoutPlanStatus(f.root, 'X');
  assert.equal(status.state, 'stale');
  assert.deepEqual(status.stale, ['placement-constraints.json changed since the approval']);
  const block = layoutGate(f.root, 'X', () => {})!;
  assert.equal(block.code, 'layout_plan_stale');
  assert.match(block.message, /X/);
  assert.match(block.message, /tools\/pcb layout X --approve/);
});

test('a changed route plan makes the approval stale', async t => {
  const f = fixture(t);
  await approve(f.root);
  writeFileSync(f.route, JSON.stringify({ ...ROUTE, stages: [{ name: 'main' }, { name: 'late' }] }));
  const status = layoutPlanStatus(f.root, 'X');
  assert.equal(status.state, 'stale');
  assert.deepEqual(status.stale, ['the route plan changed since the approval']);
  assert.equal(layoutGate(f.root, 'X', () => {})!.code, 'layout_plan_stale');
});

test('an intent with an unknown rule id, or with no rule id, is invalid and cannot be approved', async t => {
  const unknown = fixture(t, { intents: [{ id: 'usb-top', statement: 'USB-C on top edge', rule_ids: ['distance', 'nope'] }] });
  assert.deepEqual(layoutPlanStatus(unknown.root, 'X').problems, ['intent usb-top: rule id nope is not in placement-constraints.json']);
  assert.equal(layoutGate(unknown.root, 'X', () => {})!.code, 'layout_plan_missing');
  await assert.rejects(approve(unknown.root), /rule id nope/);
  assert.equal((JSON.parse(readFileSync(unknown.path, 'utf8')) as Row).approval, null);
  const none = fixture(t, { intents: [{ id: 'usb-top', statement: 'USB-C on top edge', rule_ids: [] }] });
  assert.deepEqual(layoutPlanStatus(none.root, 'X').problems, ['intent usb-top: rule_ids needs at least one rule id']);
});

test('the plan shape is strict: no intents, unknown keys, a wrong schema and an empty statement are problems', t => {
  const problems = (plan: Row): string[] => layoutPlanStatus(fixture(t, plan).root, 'X').problems;
  assert.deepEqual(problems({ intents: [] }), ['intents must be a non-empty list']);
  assert.deepEqual(problems({ schema: 'iot-lab.layout-plan.v2' }), ['schema must be iot-lab.layout-plan.v1']);
  assert.deepEqual(problems({ extra: 1 }), ['unknown key extra']);
  assert.deepEqual(problems({ intents: [{ id: 'a', statement: ' ', rule_ids: ['distance'] }] }), ['intent a: statement must be a non-empty string']);
  assert.deepEqual(problems({ intents: [INTENTS[0], INTENTS[0]] }), ['duplicate intent id usb-top']);
});

test('the route plan is checked with the route plan schema and stays inside the project', t => {
  const bad = fixture(t);
  writeFileSync(bad.route, JSON.stringify({ ...ROUTE, backend: 'nope' }));
  assert.deepEqual(layoutPlanStatus(bad.root, 'X').problems, ['route plan: backend must be tracemaker or iotroute']);
  assert.deepEqual(layoutPlanStatus(fixture(t, { route_plan: '../route.json' }).root, 'X').problems, ['route_plan must be a path inside the project']);
  assert.deepEqual(layoutPlanStatus(fixture(t, { route_plan: 'hardware-design/boards/X/none.json' }).root, 'X').problems, ['route_plan hardware-design/boards/X/none.json is not a file']);
});

test('a malformed approval is invalid, not approved', t => {
  const f = fixture(t, { approval: { by: 'Ana', reason: 'ok', rules_sha256: 'x' } });
  assert.deepEqual(layoutPlanStatus(f.root, 'X').problems, ['approval needs by, reason, rules_sha256 and route_plan_sha256']);
});

test('approval needs a person and a reason, and a sealed board', async t => {
  const f = fixture(t);
  await assert.rejects(approveLayoutPlan(f.root, 'X', ' ', 'why'), /--by NAME/);
  await assert.rejects(approveLayoutPlan(f.root, 'X', 'Ana', ''), /--reason TEXT/);
  writeFileSync(join(f.folder, 'X.kicad_pcb'), '(kicad_pcb changed)');
  await assert.rejects(approve(f.root), /changed outside our tools/);
  assert.equal((JSON.parse(readFileSync(f.path, 'utf8')) as Row).approval, null);
});

test('the dispatcher shows the status, exits 1 until the plan is approved, and approves with a person and a reason', t => {
  const f = fixture(t), command = fileURLToPath(new URL('../pcb', import.meta.url));
  const layout = (...args: string[]) => spawnSync(command, ['--project', f.root, 'layout', 'X', ...args], { encoding: 'utf8' });
  const before = layout('--json');
  assert.equal(before.status, 1);
  assert.equal(JSON.parse(before.stdout).state, 'unapproved');
  assert.match(layout().stdout, /^FAIL: The layout plan of X is not approved/);
  assert.equal(layout('--runs-dir', join(f.root, 'runs'), '--json').status, 1);
  writeFileSync(f.path, '{not json');
  assert.equal(JSON.parse(layout('--json').stdout).state, 'invalid');
  writeFileSync(f.path, JSON.stringify({ schema: 'iot-lab.layout-plan.v1', intents: INTENTS, route_plan: 'hardware-design/boards/X/route.json', approval: null }));
  const partial = layout('--approve', '--by', 'Ana');
  assert.equal(partial.status, 2);
  assert.match(partial.stderr, /usage: pcb .* layout BOARD/);
  assert.equal(layout('--by', 'Ana').status, 2);
  const done = layout('--approve', '--by', 'Ana', '--reason', 'reviewed', '--json');
  assert.equal(done.status, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).state, 'approved');
  assert.match(layout().stdout, /^PASS: X layout plan approved by Ana/);
  writeFileSync(f.route, JSON.stringify({ ...ROUTE, stages: [{ name: 'other' }] }));
  const stale = layout();
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /^FAIL: The layout plan approval of X is stale/);
});

test('an exempt board continues and writes one event with the reason; a bad exemption fails closed', t => {
  const f = fixture(t);
  rmSync(f.path);
  assert.equal(layoutPlanStatus(f.root, 'X').state, 'missing');
  const registry = join(f.root, 'hardware-design/registry/boards.json');
  mkdirSync(join(f.root, 'hardware-design/registry'), { recursive: true });
  writeFileSync(registry, JSON.stringify({ schema_version: 1, boards: [{ id: 'X', layout_plan_exempt: { reason: 'legacy board' } }] }));
  const seen = events();
  assert.equal(layoutPlanStatus(f.root, 'X').state, 'exempt');
  assert.equal(layoutGate(f.root, 'X', seen.emit), null);
  assert.deepEqual(seen.log, [{ kind: 'layout_plan.exempt', board: 'X', reason: 'legacy board' }]);
  writeFileSync(registry, JSON.stringify({ schema_version: 1, boards: [{ id: 'X', layout_plan_exempt: { reason: ' ' } }] }));
  assert.throws(() => layoutGate(f.root, 'X', seen.emit), /layout_plan_exempt/);
  assert.equal(seen.log.length, 1);
});
