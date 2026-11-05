// A reviewed contract on a placement problem: what it refuses, and that it survives its file. The fixture board is the one of
// tools/lib/engineering-constraints.test.ts.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { SCHEMA, contractDigest, type ReviewServices } from '../lib/engineering-constraints.ts';
import { parseTyped, sha256File } from '../lib/json-file.ts';
import { Float, jsonDumps } from '../lib/py-compat.mjs';
import { checkProblem, loadContract, modelAnchor, prepareProblem, rigidGroups, type ReviewedProblem } from './engineering-problem.ts';

const fp = (ref: string, x: number, y: number, padX = 0, locked = false) => `(footprint "Test:Exact" ${locked ? '(locked yes) ' : ''}(layer "F.Cu") (at ${x} ${y}) (uuid "${ref}")
  (property "Reference" "${ref}" (at 0 0)) (property "Value" "fixture")
  (fp_rect (start -0.5 -0.5) (end 0.5 0.5) (layer "F.CrtYd"))
  (pad "1" smd rect (at ${padX} 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask") (net "N") (uuid "${ref}-pad")))`;

let root: string, native: string, manifest: string, document: string;
let review: Record<string, any>, source: Record<string, unknown>;

const services: ReviewServices = { verifyManifest: () => parseTyped(jsonDumps(review)), verifyEscapeEvidence: () => [] };

const writeBoard = (parts: string) => writeFileSync(native, `(kicad_pcb (version 20260101) ${parts}(gr_rect (start 0 0) (end 20 20) (layer "Edge.Cuts")))`);

const nativeHashes = () => Object.fromEntries(['.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_dru']
  .map(extension => [native.replace(/\.kicad_pcb$/, extension), sha256File(native.replace(/\.kicad_pcb$/, extension))]));

const rule = (kind: string, fields: object) => ({ id: `${kind}-rule`, kind, source, ...fields });

function rules(...rows: object[]): void {
  review.constraints = { schema: SCHEMA, rules: rows };
  review.native_inputs = nativeHashes();
}

const unit = (name: string, x: number, y: number, refs = [name]) => ({ name, refs, x: new Float(x), y: new Float(y), fixed: false, rects: [] });

function problem(group = false): ReviewedProblem {
  const units = group ? [unit('U1', 10, 10, ['U1', 'C1']), unit('J1', 1, 3)] : [unit('U1', 10, 10), unit('C1', 14, 10), unit('J1', 1, 3)];
  return { board_file: native, units, nets: [], board: { outline: [[0, 0], [20, 0], [20, 20], [0, 20]] } };
}

const prepare = (group = false) => prepareProblem(root, 'X', manifest, problem(group), services);
const through = (pr: ReviewedProblem) => parseTyped<ReviewedProblem>(jsonDumps(pr));
const screen = (pr: ReviewedProblem, pose?: number[][]) => checkProblem(pr, pose ?? null, { services });

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-problem-')));
  const folder = join(root, 'hardware-design/boards/X');
  mkdirSync(join(folder, 'cad'), { recursive: true });
  writeFileSync(join(folder, 'gate.json'), JSON.stringify({ project: 'cad/X', checks: { erc: true, drc: true } }));
  native = join(folder, 'cad/X.kicad_pcb');
  writeBoard(fp('U1', 10, 10, 1) + fp('C1', 14, 10) + fp('J1', 1, 3));
  for (const extension of ['.kicad_pro', '.kicad_dru', '.kicad_sch']) writeFileSync(native.replace(/\.kicad_pcb$/, extension), 'fixture');
  document = join(root, 'reviewed.pdf');
  writeFileSync(document, '%PDF-1.4 fixture-source-only\n');
  source = { path: 'reviewed.pdf', sha256: sha256File(document), page: 1 };
  manifest = join(root, 'parts.json');
  writeFileSync(manifest, '{"fixture":true}\n');
  review = { status: 'passed' };
  rules();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const pinDistance = () => rule('pin_distance', { a: { ref: 'U1', pad: '1' }, b: { ref: 'C1', pad: '1' }, metric: 'pad_center_euclidean', max_mm: 2 });

test('a problem without a contract is a legacy one', () => {
  assert.equal(screen(problem()).status, 'legacy_unreviewed');
});

test('a contract keeps its digest and anchor through the problem file', () => {
  rules(rule('pin_distance', { a: { ref: 'U1', pad: '1' }, b: { ref: 'C1', pad: '1' }, metric: 'pad_center_euclidean', max_mm: new Float(2) }));
  const prepared = prepare();
  const read = through(prepared);
  assert.equal(contractDigest(loadContract(read.engineering!)), prepared.engineering!.review_sha256);
  assert.equal(modelAnchor(read), prepared.engineering!.model_anchor_sha256);
  assert.equal(screen(read).status, 'blocked');
});

test('a pose violation stays repairable and a move passes it', () => {
  rules(pinDistance());
  const prepared = through(prepare());
  assert.equal(prepared.engineering!.initial_screen && (prepared.engineering!.initial_screen as { status: string }).status, 'blocked');
  assert.equal(screen(prepared, [[10, 10, 0], [13, 10, 0], [1, 3, 0]]).status, 'passed');
});

test('a rigid group must be read as one unit and may then move whole', () => {
  rules(rule('rigid_group', { refs: ['U1', 'C1'] }));
  assert.throws(() => prepare(), /one intact placement unit/);
  const prepared = through(prepare(true));
  assert.equal(screen(prepared, [[13, 10, 0], [1, 3, 0]]).status, 'passed');
  assert.deepEqual(rigidGroups(loadContract(prepared.engineering!)), [['U1', 'C1']]);
});

test('a fixed rule fixes its unit, and moving it is blocked', () => {
  rules(rule('fixed', { refs: ['U1'] }));
  const prepared = through(prepare());
  assert.equal(prepared.units[0]!.fixed, true);
  assert.equal(screen(prepared, [[11, 10, 0], [14, 10, 0], [1, 3, 0]]).blockers[0]!.code, 'constraint_violation');
});

test('a native locked part cannot move even with no rule', () => {
  writeBoard(fp('U1', 10, 10, 1, true) + fp('C1', 14, 10) + fp('J1', 1, 3));
  rules(rule('fixed', { refs: ['C1'] }));
  const moved = screen(through(prepare()), [[11, 10, 0], [14, 10, 0], [1, 3, 0]]);
  assert.equal(moved.status, 'blocked');
  assert.equal(moved.blockers[0]!.code, 'native_locked_part_moved');
});

test('a changed anchor, rule, map or source stops the check', () => {
  rules(pinDistance());
  const prepared = through(prepare());
  const moved = through(prepared);
  moved.units[1]!.x = new Float(13);
  assert.throws(() => screen(moved), /anchors changed/);
  const relaxed = through(prepared);
  relaxed.engineering!.rules[0]!.max_mm = 3000;
  assert.throws(() => screen(relaxed), /payload changed/);
  const remapped = through(prepared);
  remapped.units[1]!.refs = ['J1'];
  remapped.units[2]!.refs = ['C1'];
  remapped.engineering!.model_anchor_sha256 = modelAnchor(remapped);
  assert.throws(() => screen(remapped), /mapping changed/);
  const elsewhere = through(prepared);
  elsewhere.board_file = join(root, 'other.kicad_pcb');
  assert.throws(() => screen(elsewhere), /another native|differs from the reviewed native/);
  writeFileSync(document, 'changed source PDF');
  assert.throws(() => screen(prepared), /input changed/);
});

test('a forged contract with a matching digest fails against the real review', () => {
  rules(pinDistance());
  const forged = through(prepare());
  forged.engineering!.rules[0]!.max_mm = 3000;
  forged.engineering!.review_sha256 = contractDigest(loadContract(forged.engineering!));
  assert.throws(() => screen(forged), /differs from the actual reviewed source/);
  assert.equal(checkProblem(forged, null, { verifySources: false, services }).status, 'passed', 'a frozen model has no sources to compare');
});

test('a model of another board or population is refused', () => {
  rules();
  const other = problem();
  other.board_file = join(root, 'other.kicad_pcb');
  assert.throws(() => prepareProblem(root, 'X', manifest, other, services), /another native source/);
  const fewer = problem();
  fewer.units.pop();
  assert.throws(() => prepareProblem(root, 'X', manifest, fewer, services), /exact reviewed native population/);
});

test('a pose must have a row per unit and a whole turn', () => {
  const prepared = through(prepare());
  assert.throws(() => screen(prepared, [[1, 1, 0]]), /cardinality/);
  assert.throws(() => screen(prepared, [[1, 1, 0.5], [2, 2, 0], [3, 3, 0]]), /invalid engineering placement pose/);
});
