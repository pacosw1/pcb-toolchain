// Engineering constraints on native pad geometry, not footprint-name guesses.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { bindInstance } from './block-bindings.ts';
import { checkManifest, nativeGeometry, reviewedContract, SCHEMA, type ReviewServices } from './engineering-constraints.ts';
import { sha256File } from './json-file.ts';
import { jsonDumps } from './py-compat.mjs';

type Row = Record<string, any>;

const fp = (ref: string, x: number, y: number, padX = 0) => `(footprint "Test:Exact" (layer "F.Cu") (at ${x} ${y}) (uuid "${ref}")
  (property "Reference" "${ref}" (at 0 0)) (property "Value" "fixture")
  (property "MPN" "EXACT") (property "LCSC" "C123")
  (fp_rect (start -0.5 -0.5) (end 0.5 0.5) (layer "F.CrtYd"))
  (pad "1" smd rect (at ${padX} 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask") (net "N") (uuid "${ref}-pad")))`;

let root: string, native: string, text: string, manifest: string, source: Row, review: Row, documentPath: string;
let escapeCalls: unknown[][];

const services: ReviewServices = {
  verifyManifest: () => structuredClone(review),
  verifyEscapeEvidence: (...args) => {
    escapeCalls.push(args);
    return [];
  },
};

const nativeHashes = () => Object.fromEntries(['.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_dru']
  .map(extension => [native.replace(/\.kicad_pcb$/, extension), sha256File(native.replace(/\.kicad_pcb$/, extension))]));

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-constraints-')));
  const folder = join(root, 'hardware-design/boards/X');
  mkdirSync(join(folder, 'cad'), { recursive: true });
  writeFileSync(join(folder, 'gate.json'), JSON.stringify({ project: 'cad/X', checks: { erc: true, drc: true } }));
  native = join(folder, 'cad/X.kicad_pcb');
  text = `(kicad_pcb (version 20260101) ${fp('U1', 10, 10, 1)}${fp('C1', 14, 10)}${fp('J1', 1, 3)}
    (gr_rect (start 0 0) (end 20 20) (layer "Edge.Cuts")))`;
  writeFileSync(native, text);
  for (const extension of ['.kicad_pro', '.kicad_dru', '.kicad_sch']) writeFileSync(native.replace(/\.kicad_pcb$/, extension), 'fixture');
  documentPath = join(root, 'reviewed.pdf');
  writeFileSync(documentPath, '%PDF-1.4 fixture-source-only\n');
  source = { path: 'reviewed.pdf', sha256: sha256File(documentPath), page: 1 };
  manifest = join(root, 'parts.json');
  writeFileSync(manifest, '{"fixture":true}\n');
  review = { status: 'passed', constraints: { schema: SCHEMA, rules: [] }, native_inputs: nativeHashes() };
  escapeCalls = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const rule = (kind: string, fields: Row): Row => ({ id: `reviewed-${kind}`, kind, source: structuredClone(source), ...fields });
const rules = (...list: Row[]) => { review.constraints.rules = list; };
const candidate = (body: string) => {
  const path = join(root, 'candidate.kicad_pcb');
  writeFileSync(path, body);
  return path;
};
const check = (path?: string, escapeEvidence?: string): Row => checkManifest(root, 'X', manifest, services, { candidate: path, escapeEvidence });
const pads = { a: { ref: 'U1', pad: '1' }, b: { ref: 'C1', pad: '1' } };

test('pin distance uses actual pad centers and the native candidate', () => {
  rules(rule('pin_distance', { ...pads, metric: 'pad_center_euclidean', max_mm: 3 }));
  assert.equal(check().status, 'passed');
  const report = check(candidate(text.replace('(at 14 10)', '(at 15 10)')));
  assert.equal(report.status, 'blocked');
  assert.equal(report.blockers[0].measured_mm, 4);
  assert.deepEqual(report.blockers[0].source, source);
  assert.equal(report.qualified, false);
});

test('clearance uses copper edges and refuses an unsupported pad shape', () => {
  rules(rule('clearance', { ...pads, metric: 'copper_edge_2d', min_mm: 2 }));
  assert.equal(check().status, 'passed');
  assert.equal(check(candidate(text.replace('(at 14 10)', '(at 13 10)'))).blockers[0].measured_mm, 1);
  writeFileSync(native, text.replaceAll('smd rect', 'smd oval'));
  review.native_inputs[native] = sha256File(native);
  assert.match(check().unsupported[0], /unsupported exact copper/);
});

test('a connector corridor needs an outward exit and clear native courtyards', () => {
  rules(rule('connector_access', { ref: 'J1', metric: 'courtyard_corridor_2d', corridor_mm: [-4, -0.6, 0, 0.6], exit_side: 'L' }));
  assert.equal(check().status, 'passed');
  assert.deepEqual(check(candidate(text.replace('(at 14 10)', '(at 0 3)'))).blockers[0].blocking_refs, ['C1']);
  review.constraints.rules[0].exit_side = 'R';
  assert.equal(check().blockers[0].reaches_requested_edge, false);
});

test('fixed and native locked parts cannot move', () => {
  rules(rule('fixed', { refs: ['U1'] }));
  assert.equal(check(candidate(text.replace('(at 10 10)', '(at 11 10)'))).status, 'blocked');
  rules();
  const locked = text.replace('(uuid "U1")', '(uuid "U1") (locked yes)');
  writeFileSync(native, locked);
  review.native_inputs[native] = sha256File(native);
  assert.equal(check(candidate(locked.replace('(at 10 10)', '(at 11 10)'))).blockers[0].code, 'native_locked_part_moved');
});

test('a rigid group preserves relative native geometry', () => {
  rules(rule('rigid_group', { refs: ['U1', 'C1'] }));
  const together = text.replace('(at 10 10)', '(at 11 10)').replace('(at 14 10)', '(at 15 10)');
  assert.equal(check(candidate(together)).status, 'passed');
  assert.equal(check(candidate(text.replace('(at 14 10)', '(at 15 10)'))).status, 'blocked');
});

test('a missing review, unknown fields and unknown kinds fail closed', () => {
  review.status = 'blocked';
  review.blockers = [{ code: 'datasheet_review_missing' }];
  assert.match(check().blockers[0].detail, /incomplete/);
  review.status = 'passed';
  rules(rule('fixed', { refs: ['U1'], unmodeled_condition: 'hot_only' }));
  assert.match(check().unsupported[0], /unsupported constraint fields/);
  rules(rule('thermal_loop', { refs: ['U1'] }));
  assert.match(check().unsupported[0], /unsupported engineering constraint/);
});

test('a changed reviewed document makes the report stale', () => {
  rules(rule('fixed', { refs: ['U1'] }));
  writeFileSync(documentPath, 'changed PDF');
  assert.equal(check().status, 'stale');
});

test('a candidate may not change a part definition or the population', () => {
  rules(rule('fixed', { refs: ['U1'] }));
  assert.match(check(candidate(text.replace('(size 1 1)', '(size 2 2)'))).blockers[0].detail, /footprint geometry/);
  assert.match(check(candidate(text.replace(fp('J1', 1, 3), ''))).blockers[0].detail, /population differs/);
});

test('escape needs native evidence and never claims there is no path', () => {
  rules(rule('escape', { refs: ['U1'], metric: 'native_minimum_track_escape' }));
  const report = check();
  assert.equal(report.blockers[0].code, 'native_escape_evidence_missing');
  assert.ok(!jsonDumps(report).includes('unroutable'));
  assert.equal(check(undefined, join(root, 'escape.json')).status, 'passed');
  assert.equal(escapeCalls.length, 1);
});

test('reviewed escape overrides cannot silently become grid defaults', () => {
  rules(rule('escape', { refs: ['U1'], metric: 'native_minimum_track_escape', width_mm: 1 }));
  assert.match(check().unsupported[0], /unsupported native escape overrides/);
});

test('geometry reads pads, courtyards, the outline and a rotation', () => {
  writeFileSync(native, text.replace('(at 10 10)', '(at 10 10 90)'));
  const geometry = nativeGeometry(native);
  const part = geometry.refs.get('U1');
  assert.deepEqual(geometry.bounds, [0, 0, 20, 20]);
  assert.equal(part?.quarter, 1);
  assert.deepEqual(part?.pads.get('1')?.[0]?.center, [10, 9]);
  assert.deepEqual(part?.courtyard, [9.5, 9.5, 10.5, 10.5]);
});

test('the contract digest is stable and changes with the geometry', () => {
  rules(rule('fixed', { refs: ['U1'] }));
  const first = reviewedContract(root, 'X', manifest, services);
  assert.equal(first.review_sha256, reviewedContract(root, 'X', manifest, services).review_sha256);
  writeFileSync(native, text.replace('(at 14 10)', '(at 14.5 10)'));
  review.native_inputs[native] = sha256File(native);
  assert.notEqual(first.review_sha256, reviewedContract(root, 'X', manifest, services).review_sha256);
});

test('a bound block is an actual native instance and never transfers qualification', () => {
  const block = join(root, 'MODULE.kicad_block');
  mkdirSync(block);
  const part = (ref: string, uid: string, net: string, xy: string, angle: number) => `(footprint "Lib:Exact" (layer "F.Cu") (at ${xy} ${angle})
    (path "${uid}") (property "Reference" "${ref}") (property "Value" "1k") (property "MPN" "ABC") (property "LCSC" "C123")
    (attr smd) (pad "1" smd rect (at 0 0 ${angle}) (size 1 2) (layers "F.Cu" "F.Paste" "F.Mask") (net "${net}") (uuid "${ref}-pad")))`;
  writeFileSync(join(block, 'MODULE.kicad_pcb'), `(kicad_pcb ${part('R1', '/one', 'A', '2 3', 90)}${part('R2', '/two', 'B', '5 8', 0)})`);
  for (const extension of ['.kicad_sch', '.kicad_pro', '.kicad_dru']) writeFileSync(join(block, `MODULE${extension}`), '{}');
  writeFileSync(join(block, 'facts.json'), JSON.stringify({ level: 0, ports: [], open_items: [] }));
  writeFileSync(native, `(kicad_pcb ${part('R7', '/instance/one', 'X', '13 18', 180)}${part('R8', '/instance/two', 'Y', '18 15', 90)}${part('R9', '/outside', 'Z', '28 28', 0)})`);
  review.native_inputs = nativeHashes();
  const bindingPath = join(root, 'binding.json');
  writeFileSync(bindingPath, jsonDumps(bindInstance(block, native, '/instance')));
  const bound = rule('rigid_group', { refs: ['R7', 'R8'], binding: { path: bindingPath, sha256: sha256File(bindingPath) } });
  rules(bound);
  assert.match(check().blockers[0].detail, /layout-rule coverage missing/);
  Object.assign(bound.binding, { layout_rule_ids: {}, boundary_rule_ids: ['boundary'] });
  const boundary = { ...rule('clearance', { a: { ref: 'R7', pad: '1' }, b: { ref: 'R9', pad: '1' }, metric: 'copper_edge_2d', min_mm: 1 }), id: 'boundary' };
  rules(bound, boundary);
  const report = check();
  assert.equal(report.status, 'passed', jsonDumps(report.blockers));
  assert.equal(report.reuse[0].qualification_transferred, false);
  writeFileSync(join(block, 'facts.json'), '{"level":1}');
  assert.equal(check().status, 'stale');
  assert.ok(readFileSync(bindingPath, 'utf8').includes('"block_id": "MODULE"'));
});
