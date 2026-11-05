import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Board, Track } from './board-types.ts';
import type { SaveReport } from './board-edit.ts';
import { field, forms } from './sexpr.ts';
import type { SList } from './sexpr.ts';
import { atomicJson, sha256File } from './json-file.ts';
import { withSuffix } from './py-path.ts';
import { fingerprint } from './fingerprint.ts';
import { applyPlan, bridgeUuid, classify, diagnoseEvidence, IMPLEMENTATIONS, intersects, loadEvidence, nativeInputs, nm,
  observeRoute, planDependencies, prepareShift, protectedGeometry, retryKey, selectGap, selectVia, sourceInputs, verifyCopperScope } from './route-decision.ts';
import type { DecisionServices, DrcReport, Choice } from './route-decision.ts';
import { EscapeStageReceipts, escapeContext, generateEscape, generateEscapeEvidence, generateEscapeForCandidate, verifyEscapeEvidence } from './route-decision-escape.ts';
import type { EscapeContext, EscapeContract, EscapeEvidence, EscapeServices } from './route-decision-escape.ts';
const TOOLS = fileURLToPath(new URL('..', import.meta.url));
const GAP = `(kicad_pcb (version 20260101) (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
 (segment (start 0 0) (end 1 0) (width .25) (layer "F.Cu") (net "A") (uuid "left"))
 (segment (start 2 0) (end 3 0) (width .25) (layer "F.Cu") (net "A") (uuid "right")))`;
function apiBoard(path: string): Board {
  const root = forms(readFileSync(path, 'utf8'))[0] as SList;
  const kind = (name: string) => root.filter((v): v is SList => Array.isArray(v) && v[0] === name);
  const point = (form: SList, name: string) => { const p = field(form, name)!; return { x: nm(p[0]), y: nm(p[1]) }; };
  const text = (form: SList, name: string) => field(form, name)!.at(-1) as string;
  const tracks: Track[] = kind('segment').map(form => ({ id: text(form, 'uuid'), start: point(form, 'start'), end: point(form, 'end'),
    mid: null, width: nm(field(form, 'width')![0]), layer: text(form, 'layer'), net: text(form, 'net'), locked: field(form, 'locked') !== undefined }));
  const vias = kind('via').map(form => ({ id: text(form, 'uuid'), at: point(form, 'at'), size: nm(field(form, 'size')![0]), drill: nm(field(form, 'drill')![0]),
    net: text(form, 'net'), locked: false, layers: field(form, 'layers')!.slice() as string[], via_type: 'Through' }));
  const footprints = kind('footprint').map(form => { const at = point(form, 'at'); return {
    id: text(form, 'uuid'), position: at, graphics: [], zones: [], pads: form.filter((v): v is SList => Array.isArray(v) && v[0] === 'pad').map(pad => {
      const rel = point(pad, 'at'); return { id: text(pad, 'uuid'), net: text(pad, 'net'), position: { x: at.x + rel.x, y: at.y + rel.y } }; }) }; });
  return { path, copper_layers: ['F.Cu', 'B.Cu'], stackup: [], nets: { A: 'Default' }, footprints, copper: [...tracks.map(Track => ({ Track })), ...vias.map(Via => ({ Via }))], zones: [], graphics: [], texts: [], groups: [], constraints: { min_clearance: 0, min_track_width: 0, min_via_size: 0, copper_edge_clearance: 0 }, edges_bbox: { left: 0, top: 0, right: 0, bottom: 0 }, outlines: [] } as unknown as Board;
}
class Fixture {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'route-decision-'))); root = join(this.base, 'source');
  board = join(this.root, 'hardware-design/boards/X/native.kicad_pcb'); evidence = join(this.base, 'evidence');
  report: DrcReport = { source: 'native.kicad_pcb', coordinate_units: 'mm', included_severities: ['error', 'warning', 'exclusion'], violations: [], schematic_parity: [], unconnected_items: [{ items: [
    { uuid: 'left', description: 'Track [A]', pos: { x: 1, y: 0 } }, { uuid: 'right', description: 'Track [A]', pos: { x: 2, y: 0 } }] }] };
  saves = 0;
  services: DecisionServices = { board: apiBoard, save: (pcb, text, out) => {
    this.saves++; mkdirSync(out, { recursive: true }); const board = join(out, basename(pcb)); writeFileSync(board, text);
    for (const ext of ['.kicad_pro', '.kicad_dru', '.kicad_sch']) copyFileSync(withSuffix(pcb, ext), withSuffix(board, ext));
    return { board, violations: {}, errors: 0, unconnected: 0, parity: 0, passed: true } as SaveReport;
  } };
  constructor() {
    mkdirSync(dirname(this.board), { recursive: true }); mkdirSync(this.evidence);
    writeFileSync(this.board, GAP); for (const ext of ['.kicad_pro', '.kicad_dru', '.kicad_sch']) writeFileSync(withSuffix(this.board, ext), 'fixture');
    atomicJson(join(dirname(this.board), 'gate.json'), { project: 'native', checks: { erc: true, drc: true } });
    for (const name of IMPLEMENTATIONS) { const target = join(this.root, 'tools', name); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(TOOLS, name), target); }
    this.save();
  }
  close() { rmSync(this.base, { recursive: true, force: true }); }
  save() {
    atomicJson(join(this.evidence, 'drc.json'), this.report);
    atomicJson(join(this.evidence, 'record.json'), { schema: 'iot-lab.native-export.v1', status: 'reject', board: this.board, source_mutated: false,
      drc_returncode: 0, inputs: sourceInputs(this.board), drc_sha256: sha256File(join(this.evidence, 'drc.json')), drc_command: ['--schematic-parity', '--refill-zones', '--severity-all'] });
  }
  diagnose() { return diagnoseEvidence(this.root, 'X', join(this.evidence, 'record.json'), join(this.base, 'plan.json'), this.services); }
  workspace() { const out = join(this.base, 'workspace'); cpSync(this.root, out, { recursive: true }); return out; }
}
function fixture(t: TestContext): Fixture { const f = new Fixture(); t.after(() => f.close()); return f; }

test('exact gap diagnosis and one deterministic guarded edit preserve source copper', t => {
  const f = fixture(t), plan = f.diagnose(); assert.deepEqual(plan, f.diagnose());
  assert.equal(plan.choice?.strategy, 'straight_gap_bridge'); assert.deepEqual(plan.next_action.argv, ['tools/pcb', 'repair', 'X', '--plan', join(f.base, 'plan.json'), '--follow']);
  const workspace = f.workspace(), native = join(workspace, 'hardware-design/boards/X/native.kicad_pcb');
  const guard = applyPlan(workspace, 'X', plan, join(f.base, 'repair'), f.services);
  assert.equal(f.saves, 1); assert.equal(guard.status, 'proposed'); assert.equal(guard.qualified, false);
  assert.equal(apiBoard(native).copper.length, 3); assert.equal(apiBoard(f.board).copper.length, 2);
  assert.equal(protectedGeometry(apiBoard(f.board)), protectedGeometry(apiBoard(native), guard.added_items as string[]));
  assert.deepEqual(planDependencies(plan), plan.evidence_sha256);
  assert.throws(() => applyPlan(workspace, 'X', plan, join(f.base, 'second'), f.services), /changed since diagnosis/);
});
test('tampered decisions, original workspaces and changed evidence cannot edit copper', t => {
  const f = fixture(t), plan = f.diagnose(), workspace = f.workspace();
  assert.throws(() => applyPlan(f.root, 'X', plan, join(f.base, 'repair'), f.services), /isolated/);
  assert.throws(() => applyPlan(workspace, 'X', { ...plan, action: 'skip' }, join(f.base, 'repair'), f.services), /edited/);
  writeFileSync(join(f.evidence, 'drc.json'), '{}');
  assert.throws(() => applyPlan(workspace, 'X', plan, join(f.base, 'repair'), f.services), /changed/); assert.equal(f.saves, 0);
});
test('a wrong-width native save cannot pass the copper guard', t => {
  const f = fixture(t), plan = f.diagnose(), workspace = f.workspace();
  const save = f.services.save; f.services.save = (pcb, text, out) => save(pcb, text.replaceAll('(width 0.25)', '(width 0.1)'), out);
  assert.throws(() => applyPlan(workspace, 'X', plan, join(f.base, 'repair'), f.services), /width differs/);
  assert.equal(apiBoard(join(workspace, 'hardware-design/boards/X/native.kicad_pcb')).copper.length, 2);
});
test('classification preserves model limits and native/router disagreement', () => {
  const report: DrcReport = { violations: [], schematic_parity: [], unconnected_items: [{ items: [{ description: 'Pad 1 of U2 [A]' }, { description: 'Pad 2 of R1 [A]' }] }] };
  const rows = classify(report, { router: { completed_nets: ['A'] }, triage: { connections: [{ class: 'ROUTER_MISS', net: 'A' }], not_checked: 1 }, escape: { boxed_in: [{ ref: 'U2', net: 'A', pad: '1' }] } });
  assert.deepEqual(rows.map(r => r.classification), ['router_miss', 'constraints_unknown', 'escape_failure', 'native_router_disagreement', 'native_open']);
  assert.deepEqual(rows.at(-1)!.refs, ['R1', 'U2']); assert.match(rows[0]!.reason, /joint routability is unproven/);
});
test('schematic and unknown-rule findings take priority over gap repair', t => {
  const f = fixture(t); f.report.schematic_parity = [{}]; f.save(); assert.equal(f.diagnose().action, 'resolve_schematic_parity');
  f.report.schematic_parity = []; f.report.unconnected_items = []; f.save(); assert.equal(f.diagnose().action, 'run_remaining_configured_gates');
});
test('loose, recursive and source-unbound evidence is rejected', t => {
  const f = fixture(t); assert.throws(() => loadEvidence(f.root, 'X', join(f.evidence, 'drc.json')), /loose diagnostic/);
  const file = join(f.evidence, 'recursive.json'); atomicJson(file, { schema: 'iot-lab.route-evidence.v1', board: 'X', source_inputs: sourceInputs(f.board), artifacts: { native: { path: file, sha256: 'wrong' } } });
  assert.throws(() => loadEvidence(f.root, 'X', file), /changed routing/);
  writeFileSync(withSuffix(f.board, '.kicad_dru'), 'changed'); assert.throws(() => f.diagnose(), /stale or incomplete/);
});
test('native gate receipts need one completed process exit and bound board hashes', t => {
  const f = fixture(t), receipt = join(f.evidence, 'gate.json');
  const make = () => atomicJson(receipt, { changedDuringRun: false, preflightErrors: [], provenance: { inputs: Object.entries(nativeInputs(f.root, 'X').sources).map(([path, sha256]) => ({ path, sha256 })) }, checks: { drc: { status: 'failed', metrics: { errors: 0, unconnected: 1 } } } });
  make(); writeFileSync(join(f.evidence, 'events.jsonl'), '{"type":"tool.exit","stage":"drc","code":0}\n'); assert.equal(loadEvidence(f.root, 'X', receipt).report.unconnected_items.length, 1);
  writeFileSync(join(f.evidence, 'events.jsonl'), '{"type":"tool.exit","stage":"drc","code":1}\n'); assert.throws(() => loadEvidence(f.root, 'X', receipt), /process receipt/);
});
test('protected crossing, locked ends, ambiguous topology and non-45 gaps block selection', t => {
  const f = fixture(t), base = apiBoard(f.board);
  const board = structuredClone(base); board.copper.push({ Track: { id: 'cross', start: { x: 1_500_000, y: -1_000_000 }, end: { x: 1_500_000, y: 1_000_000 }, mid: null, width: 250_000, layer: 'F.Cu', net: 'B', locked: false } });
  assert.equal(selectGap(board, f.report).choice, null);
  const locked = structuredClone(base); if ('Track' in locked.copper[0]!) locked.copper[0].Track.locked = true; assert.equal(selectGap(locked, f.report).choice, null);
  const bend = structuredClone(base); if ('Track' in bend.copper[1]!) { bend.copper[1].Track.start.y = 200_000; bend.copper[1].Track.end.y = 200_000; }
  const report = structuredClone(f.report); report.unconnected_items[0]!.items![1]!.pos!.y = .2; assert.equal(selectGap(bend, report).choice, null);
});
test('exact segment intersection and native-grid conversion retain boundary cases', () => {
  assert.equal(intersects([0, 0], [3, 0], [2, 0], [4, 0]), true); assert.equal(intersects([0, 0], [1, 0], [2, 0], [3, 0]), false);
  assert.equal(intersects([0, 0], [2, 2], [0, 2], [2, 0]), true); assert.equal(nm('0.000001'), 1); assert.throws(() => nm('0.0000001'), /nanometre/);
  assert.equal(bridgeUuid('https://example.com'), '4fd35a71-71ef-5a55-a9d9-aa75c889a6d0');
});
test('API via records without explicit type and extent cannot justify repair', t => {
  const f = fixture(t), board = apiBoard(f.board); board.copper.push({ Via: { id: 'v', at: { x: 0, y: 0 }, size: 600000, drill: 300000, net: 'A', locked: false, layers: ['F.Cu', 'B.Cu'] } });
  const report: DrcReport = { violations: [{ type: 'clearance', severity: 'error', items: [{ uuid: 'v' }, { uuid: 'pad' }] }], schematic_parity: [], unconnected_items: [] };
  assert.equal(selectVia(board, report), null);
  const right = board.copper[1]!; if ('Track' in right) { right.Track.start = { x: 0, y: 0 }; right.Track.layer = 'B.Cu'; }
  assert.throws(() => prepareShift(board, 'v', 'left', .5), /API type\/layer extent/);
  const via = board.copper.at(-1)!; if ('Via' in via) Object.assign(via.Via, { via_type: 'Through', layers: ['F.Cu', 'B.Cu'] });
  assert.deepEqual(prepareShift(board, 'v', 'left', .5).destination, [500000, 0]);
});
test('observations bind route input/result bytes and abstain on stale artifacts', t => {
  const f = fixture(t), route = join(f.base, 'route'); mkdirSync(route); copyFileSync(f.board, join(route, 'routed.kicad_pcb'));
  atomicJson(join(route, 'input-manifest.json'), { board_sha256: sha256File(f.board) }); atomicJson(join(route, 'outcome.json'), { board_sha256: sha256File(join(route, 'routed.kicad_pcb')), status: 'stuck' }); atomicJson(join(route, 'drc.json'), f.report);
  assert.equal(observeRoute(f.board, route).action, 'diagnose_selected_connections'); writeFileSync(join(route, 'routed.kicad_pcb'), 'changed'); assert.equal(observeRoute(f.board, route).status, 'unverified');
});
function escapeFixture(f: Fixture) {
  const launcher = join(f.root, 'tools', 'grid-artifact'); writeFileSync(launcher, 'synthetic Rust generator identity');
  const runtimeFile = join(f.root, 'runtime-artifact'); writeFileSync(runtimeFile, 'observed runtime'); let calls = 0;
  const context = (): EscapeContext => ({ schema: 'iot-lab.escape-context.v2', files: { [launcher]: sha256File(launcher) }, config_inputs: {}, feature_config: { on: true }, environment: {},
    launcher: { path: launcher, sha256: sha256File(launcher) }, model_parameters: { grid_mm: .05, reach_mm: 2, halo_hint_mm: .5, pad_box_halo_mm: .3, layers: ['F.Cu', 'B.Cu'], skip_nets: [], net_filter: null, width_model: 'native_design_minimum', clearance_model: 'native_item_and_net_maximum' } });
  const services: EscapeServices = { context, produce: (_root, _board, native, _work, _timeout, c) => {
    calls++; return { schema: 'iot-lab.pin-escape-evidence.v1', board: native, qualified: false, status: 'screened', source_inputs: sourceInputs(native), generator_inputs: c.files,
      feature_config: c.feature_config, model_parameters: c.model_parameters, runtime: { schema: 'iot-lab.escape-runtime.v2', files: { generator: c.launcher, runtime: { path: runtimeFile, sha256: sha256File(runtimeFile) } } },
      screened_pads: [{ ref: 'U1', pad: '1' }], boxed_in: [], unsupported_constraints: [], not_checked: 0 };
  } };
  const contract: EscapeContract = { root: f.root, board: 'X', rules: [{ kind: 'escape', metric: 'native_minimum_track_escape', refs: ['U1'] }], geometry: { refs: { U1: { pads: { '1': [{ kind: 'smd', layers: ['F.Cu'] }] } } } } };
  return { services, contract, calls: () => calls, runtimeFile };
}
test('escape screens bind effective context, explicit pads and observed runtime', t => {
  const f = fixture(t), e = escapeFixture(f), output = join(f.evidence, 'escape.json'); generateEscape(f.root, 'X', output, 30, f.board, e.services);
  assert.deepEqual(verifyEscapeEvidence(e.contract, f.board, output, e.services), []);
  const raw = JSON.parse(readFileSync(output, 'utf8')) as EscapeEvidence; raw.screened_pads = []; atomicJson(output, raw);
  assert.equal(verifyEscapeEvidence(e.contract, f.board, output, e.services)[0]?.code, 'native_escape_evidence_invalid');
});
test('model enclosure is a scoped blocker and never a physical impossibility claim', t => {
  const f = fixture(t), e = escapeFixture(f), output = join(f.evidence, 'escape.json');
  const raw = generateEscape(f.root, 'X', output, 30, f.board, e.services); raw.boxed_in = [{ ref: 'U1', pad: 'U1.1' }]; atomicJson(output, raw);
  const blockers = verifyEscapeEvidence(e.contract, f.board, output, e.services); assert.equal(blockers[0]?.code, 'escape_model_enclosure'); assert.match(blockers[0]!.detail, /not physical impossibility/);
});
test('stage cache reuses a sealed receipt and regenerates changed observed runtime', t => {
  const f = fixture(t), e = escapeFixture(f), cache = new EscapeStageReceipts(undefined, e.services);
  const first = cache.get(e.contract, f.board, join(f.evidence, 'first.json'));
  assert.equal(cache.get(e.contract, f.board, join(f.evidence, 'second.json')), first); assert.equal(cache.hits, 1); assert.equal(e.calls(), 1);
  writeFileSync(e.runtimeFile, 'new runtime'); const fresh = cache.get(e.contract, f.board, join(f.evidence, 'third.json'));
  assert.notEqual(fresh, first); assert.equal(cache.generated, 2); assert.equal(e.calls(), 2);
});
test('stage cache rejects corrupted or previously failed receipts without retrying', t => {
  const f = fixture(t), e = escapeFixture(f), cache = new EscapeStageReceipts(undefined, e.services), output = cache.get(e.contract, f.board, join(f.evidence, 'first.json'));
  writeFileSync(output, '{}'); assert.throws(() => cache.get(e.contract, f.board, join(f.evidence, 'next.json')), /sealed stage/); assert.equal(e.calls(), 1);
  const failed = new EscapeStageReceipts(undefined, { context: e.services.context, produce: () => { throw new Error('native screen failure'); } });
  failed.get(e.contract, f.board, join(f.evidence, 'failed.json')); assert.throws(() => failed.get(e.contract, f.board, join(f.evidence, 'retry.json')), /already failed/); assert.equal(failed.generated, 1);
});
test('escape adapter writes one blocked receipt when the native producer fails', t => {
  const f = fixture(t), e = escapeFixture(f), output = join(f.evidence, 'blocked.json');
  const raw = generateEscapeEvidence(e.contract, f.board, output, { context: e.services.context, produce: () => { throw new Error('missing native generator'); } });
  assert.equal(raw.status, 'blocked'); assert.equal(raw.qualified, false); assert.ok(existsSync(output));
});

test('retry identity includes missing sidecars, configuration and routing environment', t => {
  const f = fixture(t), first = retryKey(f.board, { passes: 1 });
  assert.equal(first, retryKey(f.board, { passes: 1 })); assert.notEqual(first, retryKey(f.board, { passes: 2 }));
  rmSync(withSuffix(f.board, '.kicad_dru')); assert.notEqual(first, retryKey(f.board, { passes: 1 }));
  const missing = retryKey(f.board, { passes: 1 }), old = process.env.ROUTE_FEATURES;
  try { process.env.ROUTE_FEATURES = 'pin_escape_check=off'; assert.notEqual(missing, retryKey(f.board, { passes: 1 })); }
  finally { if (old === undefined) delete process.env.ROUTE_FEATURES; else process.env.ROUTE_FEATURES = old; }
});

test('duplicate native copper identities cannot select or verify a local repair', t => {
  const f = fixture(t), board = apiBoard(f.board), choice = selectGap(board, f.report).choice!;
  board.copper.push(structuredClone(board.copper[0]!));
  assert.throws(() => selectGap(board, f.report), /ambiguous native copper identity/);
  assert.throws(() => verifyCopperScope(board, board, choice, 'bridge'), /ambiguous native copper identity/);
});

/** A via against a pad of another net, with a track on each side of the via. */
const VIA_BOARD = `(kicad_pcb (version 20260101)
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
 (footprint "R" (at 3 4) (property "Reference" "R1") (uuid "fp"))
 (segment (start 0 0) (end 2 0) (width .25) (layer "F.Cu") (net "A") (uuid "top"))
 (segment (start -1 -1) (end 0 0) (width .15) (layer "B.Cu") (net "A") (uuid "bottom"))
 (via (at 0 0) (size .6) (drill .3) (layers "F.Cu" "B.Cu") (net "A") (uuid "via"))
 (footprint "U" (at -1 -1) (uuid "u") (property "Reference" "U1")
  (pad "1" smd rect (at 0 0) (size .8 .8) (layers "F.Cu") (net "B") (uuid "p"))))`;
function viaFixture(t: TestContext): Fixture {
  const f = fixture(t); writeFileSync(f.board, VIA_BOARD);
  f.report.unconnected_items = []; f.report.violations = [{ type: 'clearance', severity: 'error', items: [{ uuid: 'via' }, { uuid: 'p' }] }]; f.save();
  return f;
}
const candidateBoard = (workspace: string): string => join(workspace, 'hardware-design/boards/X/native.kicad_pcb');
const gapRows = (a: { x: number; y: number }, b: { x: number; y: number }, net = 'A') => [{ items: [
  { uuid: 'left', description: `Track [${net}]`, pos: a }, { uuid: 'right', description: `Track [${net}]`, pos: b }] }];

test('a display anchor at the far track end uses the exact source gap, and equal pairs are not guessed', t => {
  const f = fixture(t);
  // KiCad's left display position is the connected start, while the removed 45-degree segment met its end.
  writeFileSync(f.board, `(kicad_pcb (version 20260101)
    (segment (start 120.4078 122.2914) (end 119.45 122.2914) (width .25) (layer "F.Cu") (net "/V_GAS") (uuid "left"))
    (segment (start 119.1767 122.0181) (end 119.1767 121.5) (width .25) (layer "F.Cu") (net "/V_GAS") (uuid "right"))
    (segment (start 120.7092 122.5928) (end 120.4078 122.2914) (width .25) (layer "F.Cu") (net "/V_GAS") (uuid "left-connected"))
    (segment (start 118.5 121.5) (end 119.1767 121.5) (width .25) (layer "F.Cu") (net "/V_GAS") (uuid "right-connected")))`);
  f.report.unconnected_items = gapRows({ x: 120.4078, y: 122.2914 }, { x: 119.1767, y: 122.0181 }, '/V_GAS'); f.save();
  const plan = f.diagnose(), choice = plan.choice!;
  assert.ok(choice.strategy === 'straight_gap_bridge');
  assert.deepEqual(choice.points_mm, [['119.45', '122.2914'], ['119.1767', '122.0181']]);
  const workspace = f.workspace(), guard = applyPlan(workspace, 'X', plan, join(f.base, 'repair'), f.services);
  assert.equal(protectedGeometry(apiBoard(f.board)), protectedGeometry(apiBoard(candidateBoard(workspace)), guard.added_items as string[]));
  writeFileSync(f.board, GAP.replace('(start 2 0) (end 3 0)', '(start 0 1) (end 1 1)'));
  f.report.unconnected_items = gapRows({ x: 0, y: 0 }, { x: 0, y: 1 }); f.save();
  assert.equal(f.diagnose().choice, null);
});
test('an existing output, and any changed source, sidecar, evidence or implementation, refuse a plan before any write', t => {
  const f = fixture(t), first = f.diagnose(), existing = f.workspace(); mkdirSync(join(f.base, 'out'));
  assert.throws(() => applyPlan(existing, 'X', first, join(f.base, 'out'), f.services), /new/);
  rmSync(existing, { recursive: true });
  for (const path of [f.board, withSuffix(f.board, '.kicad_dru'), join(f.evidence, 'drc.json'), join(f.root, 'tools/route_decision.ts')]) {
    const plan = f.diagnose(), workspace = f.workspace(), old = readFileSync(path); writeFileSync(path, Buffer.concat([old, Buffer.from(' ')]));
    try {
      assert.throws(() => applyPlan(workspace, 'X', plan, join(f.base, 'repair'), f.services), Error, path);
      assert.equal(readFileSync(candidateBoard(workspace), 'utf8'), GAP, path);
    } finally { writeFileSync(path, old); rmSync(workspace, { recursive: true }); }
  }
  assert.equal(readFileSync(f.board, 'utf8'), GAP); assert.equal(f.saves, 0);
});
test('rehashing an edited choice does not authorise unreported copper', t => {
  const f = fixture(t), plan = structuredClone(f.diagnose());
  if (plan.choice?.strategy !== 'straight_gap_bridge') throw new Error('a gap plan is expected');
  const points = plan.choice.points_mm as unknown as string[][]; points[1]![0] = '900';
  const { plan_sha256: _old, ...body } = plan;
  assert.throws(() => applyPlan(f.workspace(), 'X', { ...plan, plan_sha256: fingerprint(body) }, join(f.base, 'repair'), f.services), /stale/);
});
test('a crossing, a width change, a lock or an off-end report never gives a choice', t => {
  const f = fixture(t);
  for (const source of [`${GAP.slice(0, -1)}(segment (start 1.5 -1) (end 1.5 1) (width .2) (layer "F.Cu") (net "B") (uuid "blocker")))`,
    GAP.replace('(width .25) (layer "F.Cu") (net "A") (uuid "right")', '(width .3) (layer "F.Cu") (net "A") (uuid "right")'),
    GAP.replace('(uuid "left")', '(locked yes) (uuid "left")')]) {
    writeFileSync(f.board, source); f.save(); assert.equal(f.diagnose().choice, null, source);
  }
  writeFileSync(f.board, GAP); f.report.unconnected_items[0]!.items![0]!.pos!.x = .5; f.save();
  assert.equal(f.diagnose().choice, null);
});
test('unknown rules in the evidence stop a local repair', t => {
  const f = fixture(t), rules = join(f.evidence, 'rules.log'), envelope = join(f.evidence, 'envelope.json');
  writeFileSync(rules, 'rule isolation: term memberOfFootprint not compiled');
  const artifact = (path: string) => ({ path, sha256: sha256File(path) });
  atomicJson(envelope, { schema: 'iot-lab.route-evidence.v1', board: 'X', source_inputs: sourceInputs(f.board), artifacts: { native: artifact(join(f.evidence, 'record.json')), rules: artifact(rules) } });
  const plan = diagnoseEvidence(f.root, 'X', envelope, null, f.services);
  assert.equal(plan.action, 'resolve_constraint_coverage'); assert.equal(plan.choice, null);
});
test('a router miss names no cause, and a disagreement needs an explicit completed net', t => {
  const f = fixture(t), classified = (name: string, rows: { classification: string }[]) => rows.some(row => row.classification === name);
  const miss = classify(f.report, { triage: { connections: [{ net: 'A', class: 'ROUTER_MISS' }] } }).find(row => row.classification === 'router_miss')!;
  assert.match(miss.reason, /joint routability is unproven/); assert.deepEqual(miss.refs, []);
  assert.equal(classified('native_router_disagreement', classify(f.report, { router: { stats: { unrouted: 0 } } } as never)), false);
  assert.equal(classified('native_router_disagreement', classify(f.report, { router: { completed_nets: ['A'] } })), true);
});
test('a via repair keeps every track and everything not selected', t => {
  const f = viaFixture(t), plan = f.diagnose(); assert.equal(plan.choice?.strategy, 'via_shift_bridge');
  const workspace = f.workspace(), guard = applyPlan(workspace, 'X', plan, join(f.base, 'via-repair'), f.services);
  assert.deepEqual(guard.allowed_original_edits, ['via']);
  assert.equal(protectedGeometry(apiBoard(f.board), ['via']), protectedGeometry(apiBoard(candidateBoard(workspace)), ['via', ...guard.added_items as string[]]));
});
test('a save that changes other copper, the via or the bridge cannot pass the guard', t => {
  const f = viaFixture(t), plan = f.diagnose(), save = f.services.save;
  for (const [old, changed, cause] of [['(at 3 4)', '(at 8 9)', /protected geometry/], ['(size .6)', '(size .9)', /./], ['(width 0.15) (layer "B.Cu")', '(width 0.1) (layer "B.Cu")', /./]] as const) {
    const workspace = f.workspace(), before = readFileSync(f.board);
    f.services.save = (pcb, text, out) => { assert.ok(text.includes(old), old); return save(pcb, text.replace(old, changed), out); };
    try {
      assert.throws(() => applyPlan(workspace, 'X', plan, join(f.base, `bad-${changed.length}`), f.services), cause);
      assert.deepEqual(readFileSync(candidateBoard(workspace)), before);
    } finally { rmSync(workspace, { recursive: true }); }
  }
});

/** The real context of an escape screen, over a fixture root: feature file, gate config and launcher are its inputs. */
function realEscape(t: TestContext, f: Fixture, e: ReturnType<typeof escapeFixture>): EscapeServices {
  const launcher = join(f.root, 'tools', 'grid-artifact'); chmodSync(launcher, 0o755);
  copyFileSync(join(TOOLS, 'route-features.json'), join(f.root, 'tools/route-features.json'));
  const old = process.env.ROUTE_GRID_BIN; process.env.ROUTE_GRID_BIN = launcher;
  t.after(() => { if (old === undefined) delete process.env.ROUTE_GRID_BIN; else process.env.ROUTE_GRID_BIN = old; });
  return { ...e.services, context: escapeContext };
}
const twoPads = (e: ReturnType<typeof escapeFixture>): EscapeContract => structuredClone(e.contract);
const asEvidence = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as EscapeEvidence;

test('escape evidence needs every reviewed pad, the exact sources and a clean screen', t => {
  const f = fixture(t), e = escapeFixture(f), output = join(f.evidence, 'escape.json');
  const proof = generateEscape(f.root, 'X', output, 30, f.board, e.services);
  assert.equal(proof.native_validation, 'not_run; fresh parent configured gate required'); assert.equal(e.calls(), 1);
  for (const changes of [{ screened_pads: [] }, { screened_pads: [{ ref: 'OTHER', pad: '1' }] }, { source_inputs: {} },
    { unsupported_constraints: ['class-to-class clearance'] }, { native_validation: 'passed' }]) {
    atomicJson(output, { ...proof, ...changes });
    assert.equal(verifyEscapeEvidence(e.contract, f.board, output, e.services)[0]?.code, 'native_escape_evidence_invalid', JSON.stringify(changes));
  }
  atomicJson(output, proof); assert.deepEqual(verifyEscapeEvidence(e.contract, f.board, output, e.services), []);
  writeFileSync(withSuffix(f.board, '.kicad_pro'), 'different project');
  assert.ok(verifyEscapeEvidence(e.contract, f.board, output, e.services).length);
});
test('an explicit pad scope counts and a reviewed override is refused', t => {
  const f = fixture(t), e = escapeFixture(f), contract = twoPads(e), output = join(f.evidence, 'escape.json');
  const proof = generateEscape(f.root, 'X', output, 30, f.board, e.services);
  contract.rules[0]!.pads = [{ ref: 'U1', pad: '1' }];
  assert.deepEqual(verifyEscapeEvidence(contract, f.board, output, e.services), []);
  const override = structuredClone(contract); (override.rules[0] as Record<string, unknown>).width_mm = .5;
  assert.match(verifyEscapeEvidence(override, f.board, output, e.services)[0]!.detail, /unsupported reviewed/);
  atomicJson(output, { ...proof, boxed_in: [{ ref: 'U1', pad: 'U1.1', net: 'A' }] });
  assert.equal(verifyEscapeEvidence(contract, f.board, output, e.services)[0]?.code, 'escape_model_enclosure');
});
test('an escape screen is refused after a changed policy, gate, launcher, runtime or parameter, or an outside override', t => {
  const f = fixture(t), e = escapeFixture(f), services = realEscape(t, f, e), output = join(f.evidence, 'escape.json');
  const proof = generateEscape(f.root, 'X', output, 30, f.board, services);
  assert.deepEqual(verifyEscapeEvidence(e.contract, f.board, output, services), []);
  for (const target of [join(f.root, 'tools/route-features.json'), join(f.root, 'tools/grid-artifact'), join(dirname(f.board), 'gate.json'), e.runtimeFile]) {
    const old = readFileSync(target); writeFileSync(target, Buffer.concat([old, Buffer.from(' ')]));
    try { assert.ok(verifyEscapeEvidence(e.contract, f.board, output, services).length, target); } finally { writeFileSync(target, old); }
  }
  const changed = structuredClone(proof); assert.ok(changed.model_parameters); changed.model_parameters.grid_mm = .5; atomicJson(output, changed);
  assert.ok(verifyEscapeEvidence(e.contract, f.board, output, services).length);
  atomicJson(output, proof);
  for (const [name, value] of [['ROUTE_FEATURES_FILE', join(f.root, 'tools/route-features.json')], ['ROUTE_BOARD', 'OTHER']] as const) {
    process.env[name] = value;
    try {
      assert.ok(verifyEscapeEvidence(e.contract, f.board, output, services).length, name);
      assert.throws(() => generateEscape(f.root, 'X', join(f.base, `unknown-${name}.json`), 30, f.board, services), /external/);
    } finally { delete process.env[name]; }
  }
});
function copyCandidate(f: Fixture, folder: string): string {
  const candidate = join(f.base, folder, 'native.kicad_pcb'); mkdirSync(dirname(candidate));
  for (const ext of ['.kicad_pcb', '.kicad_pro', '.kicad_dru', '.kicad_sch']) copyFileSync(withSuffix(f.board, ext), withSuffix(candidate, ext));
  return candidate;
}
test('an explicit candidate keeps the reviewed root policy and its own exact sources', t => {
  const f = fixture(t), e = escapeFixture(f), candidate = copyCandidate(f, 'compact'), output = join(f.base, 'compact-screen.json'), seen: string[][] = [];
  const services: EscapeServices = { ...e.services, produce: (root, board, native, work, timeout, c) => { seen.push([root, board, native]); return e.services.produce(root, board, native, work, timeout, c); } };
  const contract = { ...e.contract, root: f.root }, result = generateEscapeForCandidate(f.root, 'X', candidate, output, 30, services);
  assert.deepEqual(seen, [[f.root, 'X', candidate]]); assert.deepEqual(result.source_inputs, sourceInputs(candidate));
  assert.deepEqual(verifyEscapeEvidence(contract, candidate, output, services), []);
  writeFileSync(withSuffix(candidate, '.kicad_dru'), 'new candidate rule');
  assert.ok(verifyEscapeEvidence(contract, candidate, output, services).length);
});
test('a stage shares one verified receipt and a later stage screens again', t => {
  const f = fixture(t), e = escapeFixture(f), candidate = copyCandidate(f, 'candidate'), contract = { ...e.contract, root: f.root }, events: string[] = [];
  const screens = new EscapeStageReceipts(kind => events.push(kind), e.services), first = join(f.base, 'pre-engineering.json'), second = join(f.base, 'pre-design.json');
  assert.equal(screens.get(contract, candidate, first), first); assert.equal(screens.get(contract, candidate, second), first);
  assert.equal(existsSync(second), false); assert.equal(e.calls(), 1);
  assert.equal(new EscapeStageReceipts(undefined, e.services).get(contract, candidate, join(f.base, 'post.json')), join(f.base, 'post.json')); assert.equal(e.calls(), 2);
  assert.deepEqual([screens.generated, screens.hits], [1, 1]); assert.deepEqual(events, ['cache.miss', 'cache.hit']);
});
test('a stage receipt goes stale with the candidate, policy, code, environment or observed runtime', t => {
  const f = fixture(t), e = escapeFixture(f), services = realEscape(t, f, e), candidate = copyCandidate(f, 'candidate'), contract = { ...e.contract, root: f.root };
  const targets = [...['.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_dru'].map(ext => withSuffix(candidate, ext)), join(f.root, 'tools/grid-artifact'),
    join(f.root, 'tools/route_decision.ts'), join(dirname(f.board), 'gate.json'), e.runtimeFile];
  targets.forEach((target, n) => {
    const screens = new EscapeStageReceipts(undefined, services), next = join(f.base, `next-${n}.json`); screens.get(contract, candidate, join(f.base, `first-${n}.json`));
    const old = readFileSync(target), before = e.calls(); writeFileSync(target, Buffer.concat([old, Buffer.from(' ')]));
    try { assert.equal(screens.get(contract, candidate, next), next, target); } finally { writeFileSync(target, old); }
    assert.equal(e.calls(), before + 1, target); assert.equal(screens.hits, 0, target);
  });
  const environment = new EscapeStageReceipts(undefined, services); environment.get(contract, candidate, join(f.base, 'env-first.json'));
  process.env.LD_PRELOAD = 'synthetic-cache-key-only';
  try { assert.equal(environment.get(contract, candidate, join(f.base, 'env-next.json')), join(f.base, 'env-next.json')); } finally { delete process.env.LD_PRELOAD; }
  const policy = new EscapeStageReceipts(undefined, services); policy.get(contract, candidate, join(f.base, 'policy-first.json'));
  const changed = structuredClone(contract); changed.rules[0]!.metric = 'native_minimum_track_escape'; (changed.rules[0] as Record<string, unknown>).id = 'changed-reviewed-rule';
  assert.equal(policy.get(changed, candidate, join(f.base, 'policy-next.json')), join(f.base, 'policy-next.json'));
  assert.equal(asEvidence(join(f.base, 'policy-next.json')).status, 'screened');
});
