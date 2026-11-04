import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
import { EscapeStageReceipts, generateEscape, generateEscapeEvidence, verifyEscapeEvidence } from './route-decision-escape.ts';
import type { EscapeContext, EscapeContract, EscapeEvidence, EscapeServices } from './route-decision-escape.ts';
const TOOLS = fileURLToPath(new URL('..', import.meta.url));
const GAP = `(kicad_pcb (version 20260101) (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
 (segment (start 0 0) (end 1 0) (width .25) (layer "F.Cu") (net "A") (uuid "left"))
 (segment (start 2 0) (end 3 0) (width .25) (layer "F.Cu") (net "A") (uuid "right")))`;
function apiBoard(path: string): Board {
  const root = forms(readFileSync(path, 'utf8'))[0] as SList;
  const segments = root.filter((v): v is SList => Array.isArray(v) && v[0] === 'segment');
  const point = (form: SList, name: string) => { const p = field(form, name)!; return { x: nm(p[0]), y: nm(p[1]) }; };
  const tracks: Track[] = segments.map(form => ({ id: field(form, 'uuid')![0] as string, start: point(form, 'start'), end: point(form, 'end'),
    mid: null, width: nm(field(form, 'width')![0]), layer: field(form, 'layer')![0] as string, net: field(form, 'net')!.at(-1) as string, locked: form.includes('locked') }));
  return { path, copper_layers: ['F.Cu', 'B.Cu'], stackup: [], nets: { A: 'Default' }, footprints: [], copper: tracks.map(Track => ({ Track })), zones: [], graphics: [], edges_bbox: { left: 0, top: 0, right: 0, bottom: 0 }, outlines: [] };
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
  const f = fixture(t), board = apiBoard(f.board); board.copper.push({ Via: { id: 'v', at: { x: 0, y: 0 }, size: 600000, drill: 300000, net: 'A', locked: false } });
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
