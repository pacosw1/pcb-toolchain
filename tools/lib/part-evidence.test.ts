// Native part-use and PDF cache contracts; all approved fixtures are synthetic.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sha256File } from './json-file.ts';
import { BOARD, fakePdfinfo, FOLDER, makeFixture, syntheticPdf, writeReviewed } from './part-fixture.ts';
import { digest, encoded, readBoard } from './part-native.ts';
import { dependencyFiles, factsDigest, PROFILE, statusBoard, verifyManifest, verifySelection, type PartReport } from './part-review.ts';
import { stockBoard, stockPopulationCurrent, verifyPopulationSource, type StockReport } from './part-stock.ts';
import { inspectPdf } from './pdf-evidence.ts';
import { Atom, dump, item, items, parse, walk, type CadList } from './pq-cadlib.ts';
import { jsonDumps, jsonLoads } from './py-compat.mjs';
import type { Dict } from './py-dict.ts';
import { sortKeys } from './py-dict.ts';

const CLI = fileURLToPath(new URL('../part_evidence.ts', import.meta.url));
const TOOLS = dirname(CLI);
type Json = Record<string, any>;

const jsonFile = (path: string): Json => JSON.parse(readFileSync(path, 'utf8'));
const codes = (report: { blockers: { code: string }[] }) => new Set(report.blockers.map(row => row.code));
const hasCode = (report: PartReport | StockReport, code: string) => assert.ok(codes(report as never).has(code), `${code} not in ${JSON.stringify(report.blockers)}`);
const cli = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000 });

let root: string;
let manifest: string;
const board = (suffix: string) => join(root, FOLDER, `fixture.${suffix}`);
const verify = () => verifyManifest(root, BOARD, manifest);

/** Edits the manifest; with `reviewed`, the review follows the facts. */
function change(mutate: (value: Json) => void, reviewed = false): Json {
  const value = jsonFile(manifest);
  mutate(value);
  if (reviewed) writeReviewed(manifest, value as never);
  else writeFileSync(manifest, JSON.stringify(value));
  return value;
}

function editTree(path: string, edit: (tree: CadList) => void): void {
  const tree = parse(readFileSync(path, 'utf8'));
  edit(tree);
  writeFileSync(path, dump(tree));
}

function setUpBoard(): void {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'part-')));
  manifest = makeFixture(root);
  process.env.PDFINFO = fakePdfinfo(root);
}

function tearDown(): void {
  delete process.env.PDFINFO;
  rmSync(root, { recursive: true, force: true });
}

/** The first part as a shared profile plus its board use. */
function sharedProfile(): string {
  const value = jsonFile(manifest);
  const part = value.parts[0];
  const { reference: _, ...rest } = structuredClone(part);
  const profile: Json = { ...rest, schema: PROFILE };
  delete profile.native.pad_net_map;
  const use: Json = { pad_net_map: part.native.pad_net_map, required: {}, conditions: {}, refs: { PEER: 'J2' } };
  for (const rating of profile.ratings) {
    use.required[rating.id] = rating.required;
    delete rating.required;
    use.conditions[rating.id] = Object.fromEntries(rating.conditions.map((row: Json) => [row.quantity, row.required]));
    for (const row of rating.conditions) delete row.required;
  }
  if (profile.layout_constraints[0]) {
    profile.layout_constraints[0].a.ref = '$SELF';
    profile.layout_constraints[0].b.ref = '$PEER';
  }
  profile.review = structuredClone(value.review);
  const target = join(dirname(manifest), 'SYNTHETIC-TP-C900001.json');
  writeReviewed(target, profile as never);
  value.parts[0] = { reference: 'J1', profile: { path: target.slice(root.length + 1), sha256: sha256File(target) }, use };
  writeReviewed(manifest, value as never);
  return target;
}

describe('part contract', () => {
  beforeEach(setUpBoard);
  afterEach(tearDown);

  test('an exact synthetic part contract passes without stock or qualification', () => {
    const result = verify();
    assert.equal(result.status, 'passed', JSON.stringify(result.blockers));
    assert.equal(result.checked_ratings.length, 4);
    assert.equal(jsonLoads(jsonDumps(result.checked_budgets[0]))?.constructor, Map);
    assert.match(jsonDumps(result.checked_budgets[0]), /"total": 0\.04/);
    assert.equal(result.qualified, false);
    assert.equal(result.stock_current, false);
  });

  test('a changed pin name blocks even with the same number', () => {
    editTree(board('kicad_sch'), tree => {
      const pin = walk(item(tree, 'lib_symbols') as CadList, 'pin').next().value as CadList;
      (item(pin, 'name') as CadList)[1] = 'WRONG';
    });
    hasCode(verify(), 'pin_map_mismatch');
  });

  test('matching hashes cannot approve unspecified actual pin types', () => {
    editTree(board('kicad_sch'), tree => {
      const pin = walk(item(tree, 'lib_symbols') as CadList, 'pin').next().value as CadList;
      pin[1] = new Atom('unspecified');
    });
    const actual = readBoard(root, BOARD);
    const value = change(v => {
      for (const part of v.parts) {
        const facts = actual.parts.get(part.reference);
        part.native.symbol_sha256 = facts?.symbol_sha256;
        part.native.pin_map = Object.fromEntries(facts?.pin_map ?? []);
      }
    }, true);
    const checked = verify();
    assert.equal(checked.status, 'blocked');
    assert.deepEqual([...codes(checked as never)], ['unspecified_pin_type']);
    assert.deepEqual(new Set(checked.blockers.map(row => row.reference)), new Set(value.parts.map((part: Json) => part.reference)));
    const planned = verifySelection(root, BOARD, manifest);
    assert.equal(planned.status, 'passed', JSON.stringify(planned.blockers));
    assert.equal(planned.native_verified, false);
    assert.equal(planned.bindings.size, 0);
  });

  test('changed installed land geometry blocks', () => {
    editTree(board('kicad_pcb'), tree => { (item(walk(tree, 'pad').next().value as CadList, 'size') as CadList)[1] = '0.1'; });
    hasCode(verify(), 'land_geometry_mismatch');
  });

  test('a native MPN mismatch blocks', () => {
    writeFileSync(board('kicad_pcb'), readFileSync(board('kicad_pcb'), 'utf8').replace('SYNTHETIC-TP', 'WRONG-MPN'));
    hasCode(verify(), 'native_identity_mismatch');
  });

  test('a partial planned native declaration cannot certify installed assets', () => {
    change(v => { v.parts[0].native = {}; }, true);
    const result = verify();
    assert.notEqual(result.status, 'passed');
    hasCode(result, 'native_asset_mismatch');
    hasCode(result, 'pin_pad_coverage');
  });

  test('an unmatched footprint and a BOM mismatch are blocked', () => {
    const original = readFileSync(board('kicad_pcb'), 'utf8');
    editTree(board('kicad_pcb'), tree => {
      const extra = structuredClone(items(tree, 'footprint')[0]) as CadList;
      const copy = parse(dump(tree));
      const clone = items(copy, 'footprint')[0] as CadList;
      void extra;
      (items(clone, 'property').find(row => row[1] === 'Reference') as CadList)[2] = 'J99';
      tree.push(clone);
    });
    hasCode(verify(), 'native_unmatched_footprint');
    writeFileSync(board('kicad_pcb'), original);
    editTree(board('kicad_pcb'), tree => { (items(tree, 'footprint')[0] as CadList).push([new Atom('attr'), new Atom('exclude_from_bom')]); });
    hasCode(verify(), 'native_identity_mismatch');
  });

  test('ratings and applicability conditions are enforced', () => {
    change(v => { v.parts[0].ratings[0].required.max = 6; }, true);
    hasCode(verify(), 'rating_exceeded');
    change(v => { v.parts[0].ratings[0].conditions[0].required.max = 100; }, true);
    hasCode(verify(), 'rating_conditions');
  });

  test('a limit edit without a fresh review is stale', () => {
    change(v => { v.parts[0].ratings[0].limit.max = 500; });
    hasCode(verify(), 'stale_review');
  });

  test('unknown units and missing conditions do not pass', () => {
    change(v => { v.parts[0].ratings[0].required.unit = 'mV'; }, true);
    hasCode(verify(), 'rating_exceeded');
    change(v => { delete v.parts[0].ratings[0].conditions; }, true);
    hasCode(verify(), 'invalid_part_evidence');
  });

  test('a changed PDF is stale', () => {
    const pdf = join(root, 'hardware-design/registry/datasheets/SYNTHETIC-TP.pdf');
    writeFileSync(pdf, Buffer.concat([readFileSync(pdf), Buffer.from('\nchanged original\n')]));
    const result = verify();
    hasCode(result, 'stale_source');
    assert.equal(result.status, 'stale');
  });

  test('an out-of-range page is blocked', () => {
    change(v => { v.parts[0].datasheets[0].page = 2; }, true);
    hasCode(verify(), 'invalid_part_evidence');
  });

  test('uncovered native parts and unresolved items block', () => {
    change(v => { v.parts.pop(); }, true);
    hasCode(verify(), 'unreviewed_native_parts');
    change(v => { v.parts[0].unresolved.push('not reviewed'); }, true);
    hasCode(verify(), 'unresolved_part_use');
  });

  test('a budget checks the complete actual net and the worst-case sum', () => {
    change(v => { v.budgets[0].loads[0].required.max = 0.2; }, true);
    hasCode(verify(), 'budget_exceeded');
    change(v => { v.budgets[0].loads.pop(); }, true);
    hasCode(verify(), 'budget_exceeded');
  });

  test('the dependency closure holds native, PDF, spec and review', () => {
    const files = dependencyFiles(root, manifest);
    assert.ok(files.includes('hardware-design/registry/datasheets/SYNTHETIC-TP.pdf'));
    assert.ok(files.includes('hardware-design/registry/part-reviews/SYNTHETIC-REVIEW.md'));
    assert.ok(files.includes(`${FOLDER}/fixture.kicad_pcb`));
  });

  test('a pose change does not invalidate part assets', () => {
    editTree(board('kicad_pcb'), tree => { (item(items(tree, 'footprint')[0] as CadList, 'at') as CadList).splice(1, 2, '6', '5'); });
    const result = verify();
    assert.equal(result.status, 'passed', JSON.stringify(result.blockers));
  });

  test('a manifest never promotes pending or missing evidence', () => {
    change(v => { v.review.verdict = 'pending'; });
    hasCode(verify(), 'review_pending');
    unlinkSync(manifest);
    assert.equal(statusBoard(root, BOARD).status, 'blocked');
  });

  test('a missing status manifest is an explicit absent input until the review exists', () => {
    const original = readFileSync(manifest);
    const relative = manifest.slice(root.length + 1);
    unlinkSync(manifest);
    const missing = statusBoard(root, BOARD);
    assert.equal(missing.status, 'blocked');
    hasCode(missing, 'missing_part_review');
    assert.ok((missing.absent_inputs as string[]).includes(relative));
    assert.ok(!(relative in missing.inputs));
    assert.ok(!('checked_ratings' in missing), 'Python has no checked_ratings here');
    writeFileSync(manifest, original);
    const present = statusBoard(root, BOARD);
    assert.equal(present.status, 'passed', JSON.stringify(present.blockers));
    assert.equal(present.inputs[manifest], sha256File(manifest));
  });

  test('a shared profile reuses across boards with board-owned demands', () => {
    const profile = sharedProfile();
    const first = verify();
    assert.equal(first.status, 'passed', JSON.stringify(first.blockers));
    assert.equal(((first.constraints.rules[0] as Dict).get('b') as Dict).get('ref'), 'J2');
    const old = `${FOLDER}/`;
    const next = 'hardware-design/boards/SECOND-FIXTURE/';
    cpSync(join(root, old), join(root, next), { recursive: true });
    const value = JSON.parse(readFileSync(manifest, 'utf8').replaceAll(old, next));
    value.board = 'SECOND-FIXTURE';
    const second = join(dirname(manifest), 'SECOND-FIXTURE.json');
    writeReviewed(second, value);
    const result = verifyManifest(root, 'SECOND-FIXTURE', second);
    assert.equal(result.status, 'passed', JSON.stringify(result.blockers));
    assert.deepEqual(result.profiles, first.profiles);
    assert.ok(dependencyFiles(root, second).includes(profile.slice(root.length + 1)));
  });

  test('profile changes and incomplete use fail closed', () => {
    const profile = sharedProfile();
    const value = jsonFile(profile);
    value.ratings[0].limit.max = 100;
    writeFileSync(profile, JSON.stringify(value));
    hasCode(verify(), 'stale_source');
    const repin = () => change(v => { v.parts[0].profile.sha256 = sha256File(profile); }, true);
    repin();
    hasCode(verify(), 'stale_profile_review');
    writeReviewed(profile, value as never);
    repin();
    change(v => { v.parts[0].use.conditions = {}; }, true);
    hasCode(verify(), 'invalid_part_evidence');
  });

  test('one profile can supply two instances without a rule ID collision', () => {
    sharedProfile();
    for (const suffix of ['kicad_sch', 'kicad_pcb']) writeFileSync(board(suffix), readFileSync(board(suffix), 'utf8').replaceAll('C900002', 'C900001'));
    change(v => {
      v.parts[1] = structuredClone(v.parts[0]);
      v.parts[1].reference = 'J2';
      v.parts[1].use.refs.PEER = 'J1';
    }, true);
    const result = verify();
    assert.equal(result.status, 'passed', JSON.stringify(result.blockers));
    assert.deepEqual(new Set(result.constraints.rules.map(rule => rule.get('id'))), new Set(['J1:fixture-distance', 'J2:fixture-distance']));
    assert.deepEqual(new Set(Object.values(result.constraint_origins as Record<string, Json>).map(row => row.source_rule_id)), new Set(['fixture-distance']));
  });

  test('board use cannot override profile limits or borrow another spec', () => {
    sharedProfile();
    change(v => { v.parts[0].use.limit = 500; }, true);
    hasCode(verify(), 'invalid_part_evidence');
    change(v => { delete v.parts[0].use.limit; }, true);
    const other = join(root, 'hardware-design/boards/OTHER/SPEC.md');
    mkdirSync(dirname(other));
    writeFileSync(other, 'Unrelated board demand');
    change(v => { v.parts[0].use.required.supply.source = { path: other.slice(root.length + 1), sha256: sha256File(other), section: 'Unrelated' }; }, true);
    hasCode(verify(), 'use_conditions_owner');
  });

  test('an unsupported lifecycle claim cannot be added to a manifest', () => {
    change(v => { v.qualified = true; }, true);
    hasCode(verify(), 'invalid_manifest');
  });

  test('the CLI keeps the original cause of a runtime failure', () => {
    const output = join(root, 'operation/result.json');
    const run = cli(['inspect', join(root, 'missing.pdf'), '--output', output, '--json']);
    assert.equal(run.status, 1);
    const result = jsonFile(output);
    assert.equal(result.qualified, false);
    assert.match(result.blockers[0].detail, /missing\.pdf/);
  });

  test('facts digest ignores the review and keeps number types', () => {
    const value = jsonLoads('{"a": 1.0, "review": {"x": 1}}') as Dict;
    assert.equal(factsDigest(value), digest(Buffer.from('{"a":1.0}')));
  });
});

describe('selection before CAD', () => {
  let value: Json;
  let pdf: string;
  const write = (next: Json, reviewed = true) => {
    if (reviewed) writeReviewed(manifest, next as never);
    else writeFileSync(manifest, JSON.stringify(next));
    return next;
  };
  const check = (output?: string) => verifySelection(root, BOARD, manifest, output);

  beforeEach(() => {
    setUpBoard();
    value = jsonFile(manifest);
    pdf = join(root, value.parts[0].datasheets[0].path);
    const folder = join(root, FOLDER);
    for (const name of readdirSync(folder)) if (name !== 'SPEC.md') unlinkSync(join(folder, name));
  });
  afterEach(tearDown);

  function partialProfile(): [string, Json] {
    write(structuredClone(value));
    const profile = sharedProfile();
    const stat = jsonFile(profile);
    stat.native = {};
    writeReviewed(profile, stat as never);
    const next = jsonFile(manifest);
    next.parts[0].profile.sha256 = sha256File(profile);
    delete next.parts[0].use.pad_net_map;
    next.budgets = [];
    for (const part of next.parts.slice(1)) part.native = {};
    write(next);
    return [profile, next];
  }

  test('a reviewed selection passes with no CAD and keeps its source closure', () => {
    const output = join(root, 'selection-report.json');
    const result = check(output);
    assert.equal(result.status, 'passed', JSON.stringify(result.blockers));
    assert.equal(result.scope, 'reviewed_part_selection');
    assert.deepEqual(new Set(Object.keys(result.selections as object)), new Set(['J1', 'J2', 'J3', 'J4']));
    assert.equal(result.bindings.size, 0);
    assert.deepEqual(result.native_inputs, {});
    for (const flag of ['native_verified', 'cad_verified', 'connectivity_verified', 'layout_verified', 'stock_verified', 'stock_current', 'qualified', 'release_approved']) {
      assert.equal(result[flag], false, flag);
    }
    assert.equal(result.checked_budgets[0]?.scope, 'declared_planned_net_only');
    assert.deepEqual(jsonFile(output), JSON.parse(jsonDumps(sortKeys(result))));
    assert.equal(result.inputs[manifest.slice(root.length + 1)], sha256File(manifest));
    assert.equal(result.inputs[pdf.slice(root.length + 1)], sha256File(pdf));
    assert.ok(!Object.keys(result.inputs).some(name => /\.kicad_(pcb|sch)$|gate\.json$/.test(name)));
    assert.deepEqual(new Set(dependencyFiles(root, manifest, false)), new Set(Object.keys(result.inputs)));
  });

  test('no planned assets are needed for applicability, but budgets need planned nets', () => {
    const next = structuredClone(value);
    for (const part of next.parts) part.native = {};
    write(next);
    hasCode(check(), 'planned_budget_scope');
    next.budgets = [];
    write(next);
    const result = check();
    assert.equal(result.status, 'passed', JSON.stringify(result.blockers));
    assert.equal(((result.selections as Json).J1.planned_native as Dict).size, 0);
    partialProfile();
    assert.equal(check().status, 'passed');
  });

  test('underspecified ratings, identity and unresolved items block', () => {
    const cases: [string, (v: Json) => void][] = [
      ['invalid_part_evidence', v => { delete v.parts[0].ratings[0].conditions; }],
      ['invalid_part_evidence', v => { delete v.parts[0].ratings[0].required.unit; }],
      ['rating_exceeded', v => { v.parts[0].ratings[0].required.max = 6; }],
      ['rating_conditions', v => { v.parts[0].ratings[0].conditions[0].required.max = 100; }],
      ['part_identity', v => { v.parts[0].mpn = ''; }],
      ['package_identity', v => { v.parts[0].package.variant = ''; }],
      ['unresolved_part_use', v => { v.parts[0].unresolved.push('maximum duty cycle not reviewed'); }],
    ];
    for (const [expected, mutate] of cases) {
      const next = structuredClone(value);
      mutate(next);
      write(next);
      const result = check();
      assert.notEqual(result.status, 'passed');
      hasCode(result, expected);
      if (expected === 'unresolved_part_use') assert.match(JSON.stringify(result.blockers), /maximum duty cycle/);
    }
  });

  test('ownership, review and the original source are enforced before CAD', () => {
    const cases: [string, (v: Json) => void, boolean][] = [
      ['manifest_identity', v => { v.board = 'ANOTHER-DESIGN'; }, true],
      ['manifest_identity', v => { v.project = 'hardware-design/boards/ANOTHER-DESIGN/project'; }, true],
      ['review_pending', v => { v.review.verdict = 'pending'; }, false],
      ['stale_review', v => { v.parts[0].ratings[0].limit.max = 8; }, false],
    ];
    for (const [expected, mutate, reviewed] of cases) {
      const next = structuredClone(value);
      mutate(next);
      write(next, reviewed);
      hasCode(check(), expected);
    }
    write(structuredClone(value));
    writeFileSync(pdf, Buffer.concat([readFileSync(pdf), Buffer.from('\nchanged original\n')]));
    assert.equal(check().status, 'stale');
    hasCode(check(), 'stale_source');
  });

  test('a demand cannot borrow another board\'s requirement', () => {
    const other = join(root, 'hardware-design/boards/OTHER/SPEC.md');
    mkdirSync(dirname(other));
    writeFileSync(other, 'Unrelated board requirement');
    const next = structuredClone(value);
    next.parts[0].ratings[0].required.source = { path: other.slice(root.length + 1), sha256: sha256File(other), section: 'Other board' };
    write(next);
    hasCode(check(), 'use_conditions_owner');
  });

  test('the pdfinfo used is bound as an input', () => {
    const result = check();
    assert.equal(result.status, 'passed', JSON.stringify(result.blockers));
    const binary = process.env.PDFINFO as string;
    assert.equal(result.tool_inputs?.[binary], sha256File(binary));
  });

  test('shared profile reuse keeps review conditions and hashes without CAD', () => {
    write(structuredClone(value));
    let profile = sharedProfile();
    const result = check();
    assert.equal(result.status, 'passed', JSON.stringify(result.blockers));
    const key = profile.slice(root.length + 1);
    assert.equal(result.profiles?.[key], sha256File(profile));
    assert.ok(dependencyFiles(root, manifest, false).includes(key));
    const next = jsonFile(manifest);
    next.parts[0].use.conditions = {};
    write(next);
    hasCode(check(), 'invalid_part_evidence');
    write(structuredClone(value));
    profile = sharedProfile();
    const stat = jsonFile(profile);
    stat.ratings[0].limit.max = 8;
    writeFileSync(profile, JSON.stringify(stat));
    const repinned = jsonFile(manifest);
    repinned.parts[0].profile.sha256 = sha256File(profile);
    write(repinned);
    hasCode(check(), 'stale_profile_review');
  });

  test('the selection CLI keeps the full report and prints a compact receipt', () => {
    const output = join(root, 'operation/report.json');
    const run = cli(['selection', BOARD, '--manifest', manifest, '--root', root, '--output', output, '--json'], { PDFINFO: process.env.PDFINFO });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const receipt = JSON.parse(run.stdout);
    const full = jsonFile(output);
    assert.equal(receipt.scope, 'reviewed_part_selection');
    assert.ok(!('inputs' in receipt));
    assert.ok(Object.keys(full.inputs).length);
    assert.equal(full.cad_verified, false);
    assert.deepEqual(receipt.report, { path: realpathSync(output), sha256: sha256File(output) });
  });
});

describe('stock observation', () => {
  let candidate: string;
  let manifestPath: string;
  let receipts: string;
  let called = 0;
  let mutate: (receipt: Json) => void;
  const day = () => new Date().toISOString().slice(0, 10);

  beforeEach(() => {
    setUpBoard();
    for (const suffix of ['kicad_sch', 'kicad_pcb']) {
      writeFileSync(board(suffix), readFileSync(board(suffix), 'utf8').replaceAll('C900002', 'C900001').replaceAll('C900004', 'C900003'));
    }
    writeFileSync(join(root, FOLDER, 'variants.json'), JSON.stringify({ variants: ['full', 'small'], fit: { J1: ['full'], J2: ['full'], J3: ['full', 'small'], J4: ['full', 'small'] } }));
    const snapshot = readBoard(root, BOARD);
    candidate = join(root, 'candidate');
    mkdirSync(join(candidate, 'fab'), { recursive: true });
    const gate = join(candidate, 'fab/gate-evidence.json');
    writeFileSync(gate, JSON.stringify({ board: BOARD, input_sha256: 'a'.repeat(64), result: { provenance: { inputs: Object.entries(snapshot.native_inputs).map(([path, sha256]) => ({ path, sha256 })) } } }));
    manifestPath = join(candidate, 'release-manifest.json');
    writeFileSync(manifestPath, JSON.stringify({
      schema_version: 1, scope: 'cad_fabrication_candidate', board: BOARD, input_sha256: 'a'.repeat(64), artifacts: { 'fab/gate-evidence.json': sha256File(gate) },
      assembly: { populations: { full: { references: { J1: 'C900001', J2: 'C900001', J3: 'C900003', J4: 'C900003' } }, small: { references: { J3: 'C900003', J4: 'C900003' } } } },
    }));
    receipts = join(root, 'receipts');
    called = 0;
    mutate = () => {};
  });
  afterEach(tearDown);

  const runner = (command: string[]) => {
    called += 1;
    assert.deepEqual(command.slice(0, 2), ['node', join(TOOLS, 'release-stock.mjs')]);
    assert.deepEqual(command.slice(-2), ['--boards', '3']);
    mkdirSync(receipts);
    const receipt: Json = {
      schema_version: 1, board: BOARD, candidate_sha256: sha256File(manifestPath), order_day_utc: day(), boards: 3, parts: {},
      source_url: 'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList',
    };
    for (const [code, required] of [['C900001', 6], ['C900003', 6]] as const) {
      const target = join(receipts, `${code}.json`);
      writeFileSync(target, JSON.stringify({ data: { componentPageInfo: { list: [{ componentCode: code, stockCount: required, componentModelEn: 'SYNTHETIC-TP' }] } } }));
      receipt.parts[code] = { required, fetched_at_utc: `${day()}T00:00:00+00:00`, response: `${code}.json`, response_sha256: sha256File(target) };
    }
    mutate(receipt);
    writeFileSync(join(receipts, 'stock.json'), JSON.stringify(receipt));
    return { status: 0 };
  };
  const observe = (name: string = BOARD, boards: unknown = 3) => stockBoard(root, name, candidate, boards, receipts, runner);
  const defaultPopulation = () => {
    const policy = join(root, FOLDER, 'variants.json');
    unlinkSync(policy);
    const value = jsonFile(manifestPath);
    value.assembly.populations = { DEFAULT: value.assembly.populations.full };
    writeFileSync(manifestPath, JSON.stringify(value));
    return policy;
  };

  test('an exact observation keeps the original responses and approves nothing', () => {
    const result = observe();
    assert.equal(result.status, 'observed', JSON.stringify(result.blockers));
    assert.ok(join(TOOLS, 'lib/py-compat.mjs') in (result.tool_inputs as object));
    assert.equal(result.stock_current, true);
    assert.equal(result.qualified, false);
    assert.equal(result.release_approved, false);
    assert.equal((result.observations as Json).C900001.required, 6);
    for (const name of ['C900001.json', 'stock.json']) assert.equal(result.inputs[join(receipts, name)], sha256File(join(receipts, name)));
  });

  test('an unknown board, candidate mismatch or bad quantity never queries', () => {
    assert.equal(observe('UNKNOWN').status, 'blocked');
    assert.equal(observe(BOARD, 0).status, 'blocked');
    assert.equal(observe(BOARD, true).status, 'blocked');
    const value = jsonFile(manifestPath);
    value.board = 'OTHER';
    writeFileSync(manifestPath, JSON.stringify(value));
    assert.equal(observe().status, 'blocked');
    assert.equal(called, 0);
  });

  test('a stale day, quantity or candidate binding is rejected', () => {
    const changes: ((r: Json) => void)[] = [
      r => { r.order_day_utc = '2000-01-01'; }, r => { r.boards = 2; }, r => { r.candidate_sha256 = '0'.repeat(64); },
      r => { r.parts.C900001.required = 3; }, r => { r.parts.C900001.response_sha256 = '0'.repeat(64); },
    ];
    for (const next of changes) {
      mutate = next;
      assert.equal(observe().status, 'blocked');
      rmSync(receipts, { recursive: true });
    }
  });

  test('existing receipts are kept and nothing is queried', () => {
    mkdirSync(receipts);
    writeFileSync(join(receipts, 'original'), 'keep');
    assert.equal(observe().status, 'blocked');
    assert.equal(called, 0);
    assert.equal(readFileSync(join(receipts, 'original'), 'utf8'), 'keep');
  });

  test('a changed native board does not query candidate stock', () => {
    writeFileSync(board('kicad_pcb'), `${readFileSync(board('kicad_pcb'), 'utf8')}\n`);
    assert.equal(observe().status, 'blocked');
    assert.equal(called, 0);
  });

  test('a wrong exact MPN is blocked even with the right code and stock', () => {
    mutate = receipt => {
      const path = join(receipts, 'C900001.json');
      const value = jsonFile(path);
      value.data.componentPageInfo.list[0].componentModelEn = 'WRONG-MPN';
      writeFileSync(path, JSON.stringify(value));
      receipt.parts.C900001.response_sha256 = sha256File(path);
    };
    assert.equal(observe().status, 'blocked');
  });

  test('an omitted reference, wrong variant or wrong LCSC never queries', () => {
    const original = readFileSync(manifestPath, 'utf8');
    const mutations: ((v: Json) => void)[] = [
      v => { delete v.assembly.populations.full.references.J4; }, v => { delete v.assembly.populations.small; },
      v => { v.assembly.populations.full.references.J1 = 'C999'; },
    ];
    for (const next of mutations) {
      const value = JSON.parse(original);
      next(value);
      writeFileSync(manifestPath, JSON.stringify(value));
      assert.equal(observe().status, 'blocked');
    }
    assert.equal(called, 0);
  });

  test('a malformed variant policy never queries', () => {
    const path = join(root, FOLDER, 'variants.json');
    const original = readFileSync(path, 'utf8');
    for (const fit of ['full', [], ['UNKNOWN'], ['full', 'full']]) {
      const value = JSON.parse(original);
      value.fit.J1 = fit;
      writeFileSync(path, JSON.stringify(value));
      assert.equal(observe().status, 'blocked');
    }
    assert.equal(called, 0);
  });

  test('an absent policy is bound, and an appearing one expires the stock', () => {
    const policy = defaultPopulation();
    const result = observe();
    assert.equal(result.status, 'observed', JSON.stringify(result.blockers));
    assert.deepEqual(result.population_source, { path: policy, exists: false, sha256: null });
    assert.equal(stockPopulationCurrent(result), true);
    writeFileSync(policy, '{"variants":["NEW"],"fit":{}}');
    assert.equal(stockPopulationCurrent(result), false);
    assert.throws(() => verifyPopulationSource(result), /appeared/);
  });

  test('a policy appearing during the query blocks acceptance', () => {
    const policy = defaultPopulation();
    mutate = () => writeFileSync(policy, '{"variants":["NEW"],"fit":{}}');
    const result = observe();
    assert.equal(result.status, 'blocked');
    assert.equal(result.stock_current, false);
    assert.match(result.blockers[0]?.detail as string, /appeared/);
  });

  test('a missing or malformed population binding never claims current', () => {
    assert.equal(stockPopulationCurrent({}), false);
    const result = observe();
    assert.equal(stockPopulationCurrent(result), true);
    (result.population_source as { sha256: unknown }).sha256 = null;
    assert.equal(stockPopulationCurrent(result), false);
  });
});

describe('PDF cache', () => {
  let folder: string;
  let pdf: string;
  let log: string;
  let commands: Record<'pdfinfo' | 'pdftotext' | 'pdftoppm', string>;
  const scripts = {
    pdfinfo: "echo 'Pages: 2'",
    pdftotext: "printf 'FIRST PAGE\\fSECOND PAGE\\f'",
    pdftoppm: 'for last; do :; done; echo "fixture PNG $*" > "$last.png"',
  };
  const inspect = (pages: number[] = [], dpi = 144) => inspectPdf(pdf, join(folder, 'cache'), pages, dpi, commands);
  const calls = (name: string) => readFileSync(log, 'utf8').split('\n').filter(line => line.startsWith(`${name} `)).map(line => line.split(' ').slice(1));
  const pageText = (directory: string, page: number) => readFileSync(join(directory, `pages/000${page}.txt`), 'utf8');

  beforeEach(() => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'pdf-')));
    pdf = join(folder, 'document.pdf');
    syntheticPdf(pdf);
    log = join(folder, 'extractor-calls.log');
    writeFileSync(log, '');
    commands = {} as typeof commands;
    for (const [name, body] of Object.entries(scripts) as [keyof typeof scripts, string][]) {
      const path = join(folder, name);
      writeFileSync(path, `#!/bin/sh\nif [ "$*" = "-v" ]; then echo 'synthetic extractor v1'; exit 0; fi\necho "${name} $*" >> '${log}'\n${body}\n`);
      chmodSync(path, 0o755);
      commands[name] = path;
    }
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  test('cold and warm runs, and identical bytes at another path', async () => {
    const first = await inspect();
    const second = await inspect();
    assert.equal(first.cache_hit, false);
    assert.equal(second.cache_hit, true);
    assert.equal(first.receipt.get('page_count'), 2n);
    assert.equal(first.receipt.get('reviewed'), false);
    assert.equal(pageText(first.cache_directory, 2), 'SECOND PAGE');
    assert.ok(join(first.cache_directory, 'pages/0002.txt') in first.inputs);
    assert.equal(first.tool_inputs[commands.pdftotext], sha256File(commands.pdftotext));
    const other = join(folder, 'same-bytes.pdf');
    copyFileSync(pdf, other);
    assert.equal((await inspectPdf(other, join(folder, 'cache'), [], 144, commands)).cache_hit, true);
  });

  test('the PDF, extractor executable and options change the key', async () => {
    const first = await inspect();
    writeFileSync(pdf, Buffer.concat([readFileSync(pdf), Buffer.from('\nchanged\n')]));
    const changed = await inspect();
    assert.notEqual(first.cache_key, changed.cache_key);
    writeFileSync(commands.pdftotext, `${readFileSync(commands.pdftotext, 'utf8')}# changed executable same version\n`);
    const toolChanged = await inspect();
    assert.notEqual(changed.cache_key, toolChanged.cache_key);
    const rendered = await inspect([1]);
    assert.notEqual(toolChanged.cache_key, rendered.cache_key);
    assert.ok((rendered.receipt.get('artifacts') as Dict).has('renders/0001.png'));
  });

  test('corrupt cached text forces extraction', async () => {
    const first = await inspect();
    writeFileSync(join(first.cache_directory, 'pages/0001.txt'), 'corrupted');
    const second = await inspect();
    assert.equal(second.cache_hit, false);
    assert.equal(pageText(second.cache_directory, 1), 'FIRST PAGE');
  });

  test('new render pages and DPI reuse text without reading the PDF again', async () => {
    const first = await inspect();
    const one = await inspect([1]);
    const two = await inspect([2], 288);
    assert.equal(first.text_cache_hit, false);
    writeFileSync(commands.pdftoppm, `${readFileSync(commands.pdftoppm, 'utf8')}# changed renderer; same version\n`);
    const three = await inspect([2], 288);
    assert.equal(new Set([first, one, two, three].map(row => row.cache_key)).size, 4);
    for (const [row, page, dpi] of [[one, 1, 144], [two, 2, 288], [three, 2, 288]] as const) {
      assert.equal(row.cache_hit, false);
      assert.equal(row.text_cache_hit, true);
      assert.equal(row.receipt.get('schema'), 1n);
      const options = row.receipt.get('options') as Dict;
      assert.deepEqual(options.get('render_pages'), [BigInt(page)]);
      assert.equal(options.get('dpi'), BigInt(dpi));
      assert.ok((row.receipt.get('artifacts') as Dict).has(`renders/000${page}.png`));
      assert.equal(pageText(row.cache_directory, 2), 'SECOND PAGE');
    }
    assert.equal(calls('pdftotext').length, 1);
    assert.equal(calls('pdfinfo').length, 1);
    const renders = calls('pdftoppm');
    assert.equal(renders.length, 3);
    renders.forEach((args, index) => {
      const [page, dpi] = [['1', '144'], ['2', '288'], ['2', '288']][index] as [string, string];
      assert.equal(args[args.indexOf('-f') + 1], page);
      assert.equal(args[args.indexOf('-l') + 1], page);
      assert.equal(args[args.indexOf('-r') + 1], dpi);
    });
  });

  test('a changed text or page-count tool cannot reuse extracted text', async () => {
    const first = await inspect();
    writeFileSync(commands.pdftotext, readFileSync(commands.pdftotext, 'utf8').replace('FIRST PAGE', 'UPDATED FIRST PAGE'));
    const second = await inspect([1]);
    assert.equal(second.text_cache_hit, false);
    assert.notEqual(first.cache_key, second.cache_key);
    assert.equal(pageText(second.cache_directory, 1), 'UPDATED FIRST PAGE');
    writeFileSync(commands.pdfinfo, `${readFileSync(commands.pdfinfo, 'utf8')}# changed executable; same version\n`);
    const third = await inspect([2]);
    assert.equal(third.text_cache_hit, false);
    assert.equal(calls('pdftotext').length, 3);
    assert.equal(calls('pdfinfo').length, 3);
  });

  test('a corrupt text entry is not copied into a new render request', async () => {
    const first = await inspect();
    const text = join(first.text_cache_directory, 'pages');
    writeFileSync(join(text, '0002.txt'), 'corrupted second canonical page');
    assert.equal(pageText(first.cache_directory, 2), 'SECOND PAGE');
    const rendered = await inspect([2]);
    assert.equal(rendered.text_cache_hit, false);
    assert.equal(pageText(rendered.cache_directory, 1), 'FIRST PAGE');
    assert.equal(pageText(rendered.cache_directory, 2), 'SECOND PAGE');
    unlinkSync(join(text, '0001.txt'));
    const again = await inspect([1], 288);
    assert.equal(again.text_cache_hit, false);
    assert.equal(pageText(again.cache_directory, 1), 'FIRST PAGE');
    assert.equal(calls('pdftotext').length, 3);
    assert.equal(calls('pdfinfo').length, 3);
  });

  test('an older full receipt seeds text for later render reuse', async () => {
    const first = await inspect();
    const keys = ['schema', 'pdf_sha256', 'tools', 'options', 'key', 'scope', 'page_count', 'reviewed', 'artifacts'];
    const receipt = new Map(keys.map(key => [key, first.receipt.get(key)]));
    const raw = Buffer.concat([encoded(receipt), Buffer.from('\n')]);
    writeFileSync(join(first.cache_directory, 'receipt.json'), raw);
    writeFileSync(join(first.cache_directory, 'receipt.sha256'), `${digest(raw)}\n`);
    rmSync(join(folder, 'cache/text'), { recursive: true });
    const existing = await inspect();
    assert.equal(existing.cache_hit, true);
    const rendered = await inspect([1], 288);
    assert.equal(rendered.cache_hit, false);
    assert.equal(rendered.text_cache_hit, true);
    assert.equal(calls('pdftotext').length, 1);
    assert.equal(calls('pdfinfo').length, 1);
    assert.equal(calls('pdftoppm').length, 1);
  });

  test('the inspect CLI keeps the full report and prints a compact receipt', () => {
    const output = join(folder, 'inspection/report.json');
    const env = { PDFTOTEXT: commands.pdftotext, PDFINFO: commands.pdfinfo, PDFTOPPM: commands.pdftoppm };
    const args = ['inspect', pdf, '--cache', join(folder, 'cache'), '--json'];
    const compact = cli([...args, '--output', output], env);
    assert.equal(compact.status, 0, compact.stderr + compact.stdout);
    const terminal = JSON.parse(compact.stdout);
    const full = jsonFile(output);
    assert.equal(terminal.scope, 'pdf_inspection');
    assert.equal(terminal.status, 'inspected');
    assert.equal(terminal.qualified, false);
    assert.ok(!('inputs' in terminal) && !('receipt' in terminal));
    assert.equal(full.receipt.page_count, 2);
    assert.deepEqual(terminal.report, { path: output, sha256: sha256File(output) });
    assert.ok(Object.keys(JSON.parse(cli(args, env).stdout).inputs).length);
  });

  test('a rewritten receipt with a wrong identity cannot reuse the key', async () => {
    const first = await inspect();
    const path = join(first.cache_directory, 'receipt.json');
    const value = jsonLoads(readFileSync(path)) as Dict;
    value.set('pdf_sha256', '0'.repeat(64));
    const raw = Buffer.concat([encoded(value), Buffer.from('\n')]);
    writeFileSync(path, raw);
    writeFileSync(join(first.cache_directory, 'receipt.sha256'), `${digest(raw)}\n`);
    const second = await inspect();
    assert.equal(second.cache_hit, false);
    assert.equal(second.receipt.get('pdf_sha256'), sha256File(pdf));
  });

  test('a non-PDF or an invalid page never publishes', async () => {
    writeFileSync(pdf, 'not PDF');
    await assert.rejects(inspect(), /input is not a PDF/);
    syntheticPdf(pdf);
    await assert.rejects(inspect([3]), /render page is outside actual PDF/);
    assert.ok(!existsSync(join(folder, 'cache/none')));
  });
});
