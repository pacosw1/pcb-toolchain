import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { reseal, schematicSha256 } from './cad-seal.ts';
import { SCHEMA } from './engineering-constraints.ts';
import { approveLayoutPlan, layoutGate, layoutPlanPath, layoutPlanStatus, type NetSource } from './layout-plan.ts';
import { approveFixture, NO_NETS, PNG } from './layout-plan-fixture.ts';
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
const SVG = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10"/></svg>\n';
const imageOf = (root: string): string => join(root, 'layout-image.png');
/** The copy that the approval keeps in the board folder. */
const COPY_PNG = 'hardware-design/boards/X/layout-plan.png', COPY_SVG = 'hardware-design/boards/X/layout-plan.svg';
const approve = (root: string, nets: NetSource = NO_NETS) => { writeFileSync(imageOf(root), PNG); return approveLayoutPlan(root, 'X', 'Ana', 'reviewed the edge intents', imageOf(root), nets); };
/** The nets of the board, as board-json would give them: every net, and those with two pads or more. */
const boardOf = (nets: string[], routable = nets): NetSource => () => ({ nets: new Set(nets), routable: new Set(routable) });
const events = (): { log: Row[]; emit: (kind: string, data?: Row) => void } => { const log: Row[] = []; return { log, emit: (kind, data) => { log.push({ kind, ...data }); } }; };

test('a plan without approval is not approved, and approval records the person, the reason and both hashes', async t => {
  const f = fixture(t);
  assert.equal(layoutPlanStatus(f.root, 'X').state, 'unapproved');
  assert.match(layoutGate(f.root, 'X', () => {})!.message, /tools\/pcb layout X --approve --by NAME --reason TEXT/);
  await approve(f.root);
  assert.equal(layoutPlanStatus(f.root, 'X').state, 'approved');
  assert.equal(layoutGate(f.root, 'X', () => {}), null);
  const saved = JSON.parse(readFileSync(f.path, 'utf8')) as { approval: Row; intents: unknown };
  assert.deepEqual(saved.approval, { by: 'Ana', reason: 'reviewed the edge intents', rules_sha256: sha256File(f.rules), route_plan_sha256: sha256File(f.route),
    schematic_sha256: schematicSha256(f.root, 'X'), image: COPY_PNG, image_sha256: sha256File(imageOf(f.root)) });
  assert.equal(layoutPlanStatus(f.root, 'X').image, COPY_PNG);
  assert.equal(sha256File(join(f.root, COPY_PNG)), sha256File(imageOf(f.root)), 'the board folder holds a copy of the image');
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

test('a sealed change of the schematic or the project file makes the approval stale', async t => {
  const f = fixture(t);
  writeFileSync(join(f.folder, 'X.kicad_sch'), '(kicad_sch one)');
  writeFileSync(join(f.folder, 'X.kicad_pro'), '{}');
  reseal(f.root, 'X', { tool: 'fixture', run_id: null });
  await approve(f.root);
  assert.equal(layoutPlanStatus(f.root, 'X').state, 'approved');
  writeFileSync(join(f.folder, 'X.kicad_sch'), '(kicad_sch two)');
  reseal(f.root, 'X', { tool: 'fixture', run_id: null });
  const status = layoutPlanStatus(f.root, 'X');
  assert.equal(status.state, 'stale');
  assert.deepEqual(status.stale, ['the schematic changed since the approval']);
  assert.equal(layoutGate(f.root, 'X', () => {})!.code, 'layout_plan_stale');
  await approve(f.root);
  assert.equal(layoutPlanStatus(f.root, 'X').state, 'approved', 'a new approval binds the new schematic');
  writeFileSync(join(f.folder, 'X.kicad_pro'), '{"changed": true}');
  reseal(f.root, 'X', { tool: 'fixture', run_id: null });
  assert.deepEqual(layoutPlanStatus(f.root, 'X').stale, ['the schematic changed since the approval']);
});

test('a change of the board layout alone keeps the approval', async t => {
  const f = fixture(t);
  await approve(f.root);
  writeFileSync(join(f.folder, 'X.kicad_pcb'), '(kicad_pcb moved)');
  reseal(f.root, 'X', { tool: 'fixture', run_id: null });
  assert.equal(layoutPlanStatus(f.root, 'X').state, 'approved');
});

test('the approval stays approved after the original image is deleted, because the board folder keeps a copy', async t => {
  const f = fixture(t);
  await approve(f.root);
  rmSync(imageOf(f.root));
  const status = layoutPlanStatus(f.root, 'X');
  assert.equal(status.state, 'approved');
  assert.equal(status.image, COPY_PNG);
  assert.equal(layoutGate(f.root, 'X', () => {}), null);
});

test('a changed or missing copy of the approved image makes the approval stale', async t => {
  const f = fixture(t), copy = join(f.root, COPY_PNG);
  await approve(f.root);
  writeFileSync(imageOf(f.root), Buffer.concat([PNG, Buffer.from('redrawn original')]));
  assert.equal(layoutPlanStatus(f.root, 'X').state, 'approved', 'the original is not read after the approval');
  writeFileSync(copy, Buffer.concat([PNG, Buffer.from('redrawn')]));
  const status = layoutPlanStatus(f.root, 'X');
  assert.equal(status.state, 'stale');
  assert.deepEqual(status.stale, ['the approved image changed since the approval']);
  assert.equal(layoutGate(f.root, 'X', () => {})!.code, 'layout_plan_stale');
  rmSync(copy);
  assert.deepEqual(layoutPlanStatus(f.root, 'X').stale, ['the approved image is missing']);
  await approve(f.root);
  assert.equal(layoutPlanStatus(f.root, 'X').state, 'approved');
});

test('an SVG image is accepted and kept as layout-plan.svg; a new approval with another type removes the old copy', async t => {
  const f = fixture(t), svg = join(f.root, 'layout-image.svg');
  writeFileSync(svg, SVG);
  await approveLayoutPlan(f.root, 'X', 'Ana', 'ok', svg, NO_NETS);
  assert.equal(layoutPlanStatus(f.root, 'X').image, COPY_SVG);
  assert.equal(readFileSync(join(f.root, COPY_SVG), 'utf8'), SVG);
  rmSync(svg);
  assert.equal(layoutPlanStatus(f.root, 'X').state, 'approved');
  await approve(f.root);
  assert.equal(layoutPlanStatus(f.root, 'X').image, COPY_PNG);
  assert.equal(existsSync(join(f.root, COPY_SVG)), false, 'one copy only');
  assert.equal(layoutPlanStatus(f.root, 'X').state, 'approved');
  // The kept copy can be the given file: the approval of the same copy again works and keeps the file.
  await approveLayoutPlan(f.root, 'X', 'Bob', 'again', join(f.root, COPY_PNG), NO_NETS);
  assert.equal(layoutPlanStatus(f.root, 'X').state, 'approved');
  assert.equal(sha256File(join(f.root, COPY_PNG)), sha256File(imageOf(f.root)));
});

test('the approved image must be a PNG or SVG file inside the project', async t => {
  const f = fixture(t), by = (image: string) => approveLayoutPlan(f.root, 'X', 'Ana', 'ok', image, NO_NETS);
  await assert.rejects(by(join(f.root, 'none.png')), /image .* is not a file/);
  writeFileSync(join(f.root, 'text.png'), 'not a png');
  await assert.rejects(by(join(f.root, 'text.png')), /is not a PNG or SVG file/);
  writeFileSync(join(f.root, 'fake.svg'), '<html><svg></svg></html>');
  await assert.rejects(by(join(f.root, 'fake.svg')), /is not a PNG or SVG file/);
  assert.equal(existsSync(join(f.root, COPY_PNG)) || existsSync(join(f.root, COPY_SVG)), false, 'a refused image leaves no copy');
  const outside = mkdtempSync(join(tmpdir(), 'layout-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'a.png'), PNG);
  await assert.rejects(by(join(outside, 'a.png')), /image must be inside the project/);
  await assert.rejects(approveLayoutPlan(f.root, 'X', 'Ana', 'ok', ''), /--image FILE/);
  assert.equal((JSON.parse(readFileSync(f.path, 'utf8')) as Row).approval, null);
});

test('approval fails when the route plan misses a routable net of the board, or names a net that is not on it', async t => {
  const staged = (only_nets: string[]) => ({ ...ROUTE, stages: [{ name: 'main', only_nets }] });
  const f = fixture(t);
  writeFileSync(f.route, JSON.stringify(staged(['A'])));
  await assert.rejects(approve(f.root, boardOf(['A', 'B', 'C'], ['A', 'B'])), /no stage routes 1 net of this board: B/);
  writeFileSync(f.route, JSON.stringify(staged(['A', 'Z'])));
  await assert.rejects(approve(f.root, boardOf(['A'])), /stages\[0\]\.only_nets: Z is not a net of this board/);
  assert.equal((JSON.parse(readFileSync(f.path, 'utf8')) as Row).approval, null);
  assert.equal(existsSync(join(f.root, COPY_PNG)), false, 'a refused approval leaves no copy');
  writeFileSync(f.route, JSON.stringify(staged(['A', 'B'])));
  await approve(f.root, boardOf(['A', 'B', 'C'], ['A', 'B']));
  assert.equal(layoutPlanStatus(f.root, 'X').state, 'approved');
  // A stage with no only_nets routes every net.
  const all = fixture(t);
  await approve(all.root, boardOf(['A', 'B']));
  assert.equal(layoutPlanStatus(all.root, 'X').state, 'approved');
});

test('approval fails closed when the nets of the board cannot be read, for example when the board file is missing', async t => {
  const f = fixture(t), missing: NetSource = () => { throw new Error('ENOENT: no such file or directory, open X.kicad_pcb'); };
  await assert.rejects(approve(f.root, missing), /route plan nets: ENOENT: no such file/);
  assert.equal((JSON.parse(readFileSync(f.path, 'utf8')) as Row).approval, null);
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
  assert.deepEqual(layoutPlanStatus(f.root, 'X').problems, ['approval needs by, reason, rules_sha256, route_plan_sha256, schematic_sha256, image and image_sha256']);
});

test('approval needs a person and a reason, and a sealed board', async t => {
  const f = fixture(t);
  await assert.rejects(approveLayoutPlan(f.root, 'X', ' ', 'why', imageOf(f.root)), /--by NAME/);
  await assert.rejects(approveLayoutPlan(f.root, 'X', 'Ana', '', imageOf(f.root)), /--reason TEXT/);
  writeFileSync(join(f.folder, 'X.kicad_pcb'), '(kicad_pcb changed)');
  await assert.rejects(approve(f.root), /changed outside our tools/);
  assert.equal((JSON.parse(readFileSync(f.path, 'utf8')) as Row).approval, null);
});

test('the dispatcher shows the status, exits 1 until the plan is approved, and approves with a person and a reason', async t => {
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
  // The image of the newest run that has one is shown, so a person knows what to look at.
  const older = join(f.root, '.gate/cli/run-a'), newer = join(f.root, '.gate/cli/run-b');
  for (const [folder, created] of [[older, '2026-11-01T00:00:00Z'], [newer, '2026-11-02T00:00:00Z']] as const) {
    mkdirSync(join(folder, 'images'), { recursive: true });
    writeFileSync(join(folder, 'run.json'), JSON.stringify({ board: 'X', created_at: created }));
    writeFileSync(join(folder, 'images/top.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  }
  assert.equal(JSON.parse(layout('--json').stdout).image, '.gate/cli/run-b/images/top.svg');
  assert.match(layout().stdout, /\nimage: \.gate\/cli\/run-b\/images\/top\.svg\n/);
  const partial = layout('--approve', '--by', 'Ana', '--reason', 'reviewed');
  assert.equal(partial.status, 2);
  assert.match(partial.stderr, /usage: pcb .* layout BOARD .*--image FILE/);
  assert.equal(layout('--by', 'Ana').status, 2);
  assert.equal(layout('--image', imageOf(f.root)).status, 2);
  writeFileSync(imageOf(f.root), PNG);
  // The command reads the nets of the board (here the fixture has no project file). It fails closed and approves nothing.
  const refused = layout('--approve', '--by', 'Ana', '--reason', 'reviewed', '--image', imageOf(f.root));
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /route plan nets: .*No such file or directory/);
  assert.equal(layoutPlanStatus(f.root, 'X').state, 'unapproved');
  await approveFixture(f.root, 'X');
  const done = layout('--json');
  assert.equal(JSON.parse(done.stdout).state, 'approved');
  assert.equal(JSON.parse(done.stdout).image, COPY_PNG);
  assert.match(layout().stdout, /^PASS: X layout plan approved by Ana\nimage: hardware-design\/boards\/X\/layout-plan\.png/);
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
