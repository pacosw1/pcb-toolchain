// The design contract against the real verifiers: the part review, the placement rules, the raw bench and the selection, through
// the same services `tools/pcb design` and candidate operations use. Only the page count of the synthetic PDF is a stand-in.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';
import { currentAssessment, evaluateCandidateLayout, evaluateContract } from './design-contract-async.ts';
import { dependencyFiles, loadContract, SCHEMA } from './design-contract-load.ts';
import { adapter, designBinding, productionControls, type DesignServices } from './design-contract-verifiers-async.ts';
import { designServices } from './design-services.ts';
import { checkManifest } from './engineering-constraints.ts';
import { sha256File as sha } from './json-file.ts';
import { verifyManifest } from './part-review.ts';
import { BOARD, fakePdfinfo, FOLDER, makeFixture, writeReviewed } from './part-fixture.ts';
import { jsonDumps } from './py-compat.mjs';
import { SOURCES } from './schematic-contract.ts';
import { resolvePath } from './py-path.ts';

type Row = Record<string, any>;
let root: string, part: string, path: string, services: DesignServices;

const read = (file: string): Row => JSON.parse(readFileSync(file, 'utf8'));
const write = (file: string, value: unknown): void => writeFileSync(file, JSON.stringify(value));

function ideaFixture(board: string | null = null): string {
  const spec = join(root, 'idea.md');
  writeFileSync(spec, 'SYNTHETIC TEST IDEA. Output requirement3.0..3.6V. Explicit interface and architecture decision. Use test access P1. '
    + 'Failure: output outside sourced interval. Bench numbers are fixture data, never measured production hardware.\n');
  const source = (section: string) => ({ path: 'idea.md', sha256: sha(spec), section });
  const file = join(root, 'design.json');
  writeFileSync(file, `${JSON.stringify({
    schema: SCHEMA, identity: { design_id: 'IDEA-FIXTURE', board, revision: 'synthetic-1' }, current_stage: 'requirements',
    requirements: [{ id: 'OUTPUT', statement: 'Synthetic output interval', source: source('Output'), verification_stage: 'prototype',
      acceptance: { kind: 'interval', min: 3, max: 3.6, unit: 'V', source: source('Output requirement') } }],
    architecture: { source: source('Architecture'), interfaces: [{ id: 'OUTPUT-PORT', requirements: ['OUTPUT'], source: source('Interface') }],
      decisions: [{ id: 'TOPOLOGY', requirements: ['OUTPUT'], source: source('Architecture choice') }] },
    test_plans: [{ id: 'OUTPUT-TEST', requirements: ['OUTPUT'], stage: 'prototype', method: 'Measure output under sourced operating condition', procedure: source('Procedure'),
      access: source('Test access'), equipment: source('Instrument capability'), failure_conditions: source('Failure response'), signals: [{ net: '/A', ref: 'J1', pad: '1' }], check: 'MEASURE' }],
    failure_conditions: [{ id: 'OUTSIDE-OUTPUT', requirements: ['OUTPUT'], source: source('Failure'), condition: 'Output outside reviewed interval', test_plan: 'OUTPUT-TEST' }],
    unknowns: [], checks: [{ id: 'MEASURE', stage: 'prototype', kind: 'bench', requirements: ['OUTPUT'], path: 'bench/results.json', plan: 'bench/plan.json' }], production: {},
  }, null, 2)}\n`);
  return file;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'design-verifiers-')));
  process.env.PDFINFO = fakePdfinfo(root);
  services = designServices(root, join(root, 'design-output'));
  mkdirSync(join(root, 'design-output'));
});
afterEach(() => {
  delete process.env.PDFINFO;
  rmSync(root, { recursive: true, force: true });
});

/** Reviewed synthetic demands, before any native assets are available. */
function selectionFixture(): void {
  part = makeFixture(root);
  const value = read(part);
  for (const row of value.parts) row.native = {};
  value.budgets = [];
  writeReviewed(part, value as never);
  const folder = join(root, FOLDER);
  for (const name of readdirSync(folder)) if (name !== 'SPEC.md') rmSync(join(folder, name));
  path = ideaFixture();
  const contract = read(path);
  contract.identity.design_id = BOARD;
  contract.checks.push({ id: 'SELECT', stage: 'parts', kind: 'part_selection', requirements: ['OUTPUT'], path: relative(root, part), references: ['J1'] });
  write(path, contract);
}

function nativeFixture(): void {
  part = makeFixture(root);
  path = ideaFixture(BOARD);
  writeFileSync(join(root, FOLDER, 'fixture.kicad_pro'), '{}\n');
  writeFileSync(join(root, FOLDER, 'fixture.kicad_dru'), '(version 1)\n');
}

const contract = (): Row => loadContract(root, path, SOURCES) as Row;
const reportBase = (): Row => ({ inputs: {}, tool_inputs: {}, absent_inputs: [], contract: path, contract_sha256: sha(path), schematic_contracts: [] });
const run = (value: Row, row: Row, options?: Row, using = services): Promise<Row> => adapter(root, value as never, row as never, reportBase() as never, using, options) as Promise<Row>;
const partRow = (): Row => ({ id: 'PARTS', kind: 'part_use', stage: 'parts', requirements: ['OUTPUT'], path: relative(root, part), references: ['J1'] });

test('a reviewed selection passes before CAD with no native or stock claim, and goes stale with its demand', async () => {
  selectionFixture();
  const guarded: DesignServices = { ...services, readBoard: () => { throw new Error('native reader forbidden before CAD'); } };
  const result = await evaluateContract(root, path, 'parts', guarded) as Row;
  assert.equal(result.status, 'passed', JSON.stringify(result.blockers));
  const checked = result.check_results.SELECT;
  assert.equal(checked.kind, 'part_selection');
  for (const flag of ['native_verified', 'cad_verified', 'stock_current']) assert.equal(checked[flag], false, flag);
  assert.equal(result.qualified, false);
  assert.equal(result.board, null);
  assert.equal(currentAssessment(result), true);
  writeFileSync(join(root, FOLDER, 'SPEC.md'), 'Changed demand');
  assert.equal(currentAssessment(result), false);
});

test('a wrong design owner or an unreviewed reference blocks the selection', async () => {
  selectionFixture();
  const value = read(path);
  value.identity.design_id = 'OTHER-IDEA';
  write(path, value);
  assert.equal((await evaluateContract(root, path, 'parts', services) as Row).status, 'blocked');
  value.identity.design_id = BOARD;
  value.checks.at(-1).references = ['U-NOT-REVIEWED'];
  write(path, value);
  const result = await evaluateContract(root, path, 'parts', services) as Row;
  assert.equal(result.status, 'blocked');
  assert.match(JSON.stringify(result.blockers), /exact reviewed planned references/);
});

test('a previous planned revision cannot supply the parts decision', async () => {
  selectionFixture();
  const value = read(path);
  value.identity.revision = 'synthetic-2';
  write(path, value);
  const result = await evaluateContract(root, path, 'parts', services) as Row;
  assert.equal(result.status, 'blocked');
  assert.match(JSON.stringify(result.blockers), /exact design revision/);
});

test('an early selection cannot supply native or numeric final acceptance', async () => {
  selectionFixture();
  const value = read(path);
  value.identity.board = BOARD;
  value.checks.at(-1).kind = 'part_use';
  write(path, value);
  assert.equal((await evaluateContract(root, path, 'parts', services) as Row).status, 'blocked');
  value.checks.at(-1).kind = 'part_selection';
  value.requirements[0].verification_stage = 'parts';
  write(path, value);
  const result = await evaluateContract(root, path, 'parts', services) as Row;
  assert.equal(result.status, 'blocked');
  assert.match(JSON.stringify(result.blockers), /cannot establish numeric functional acceptance/);
});

test('the real part verifier runs, and a changed MPN is not accepted', async () => {
  nativeFixture();
  assert.equal((await run(contract(), partRow())).status, 'passed');
  const native = join(root, FOLDER, 'fixture.kicad_pcb');
  writeFileSync(native, readFileSync(native, 'utf8').replace('SYNTHETIC-TP', 'WRONG-MPN'));
  await assert.rejects(run(contract(), partRow()), /verifier blocked/);
});

function benchFixture(): { value: Row; row: Row; raw: string } {
  const value = contract(), binding = designBinding(root, path, value as never, services);
  const folder = join(root, 'bench');
  mkdirSync(folder);
  const calibration = join(folder, 'calibration.txt');
  writeFileSync(calibration, 'Synthetic test calibration attribution, no actual instrument claim.\n');
  const descriptor = { path: 'calibration.txt', sha256: sha(calibration), locator: 'Synthetic instrument' };
  const source = { path: 'idea.md', sha256: sha(join(root, 'idea.md')), locator: 'Synthetic output acceptance' };
  write(join(folder, 'plan.json'), { schema: 'iot-lab.block-bench-plan.v1', binding_sha256: binding, approved_by: 'synthetic-fixture', approved_at: '2026-10-16T00:00:00Z',
    tests: [{ id: 'OUTPUT-TEST', requirement: 'OUTPUT', min: 3, max: 3.6, unit: 'V', source }] });
  const raw = join(folder, 'raw.csv');
  writeFileSync(raw, 'test_id,value,unit,instrument_id\nOUTPUT-TEST,3.3,V,METER\n');
  write(join(folder, 'results.json'), { schema: 'iot-lab.block-bench.v1', binding_sha256: binding, operator: 'synthetic-fixture', measured_at: '2026-10-16T01:00:00Z', board_serial: 'SYNTHETIC-NO-HARDWARE',
    instruments: [{ id: 'METER', calibration_evidence: descriptor }], raw_data: { path: 'raw.csv', sha256: sha(raw) } });
  return { value, row: value.checks[0], raw };
}

test('the raw bench verifier recomputes the number, whatever the results file claims', async () => {
  nativeFixture();
  const { value, row, raw } = benchFixture(), report = reportBase();
  const result = await adapter(root, value as never, row as never, report as never, services) as Row;
  assert.equal(result.status, 'passed');
  assert.ok(report.inputs[raw]);
  writeFileSync(raw, readFileSync(raw, 'utf8').replace('3.3', '4.0'));
  const measured = join(root, 'bench/results.json'), data = read(measured);
  data.status = 'passed';
  data.raw_data.sha256 = sha(raw);
  write(measured, data);
  await assert.rejects(run(value, row), /outside sourced limits/);
});

test('a changed acceptance breaks the bench binding', async () => {
  nativeFixture();
  const { row } = benchFixture(), changed = read(path);
  changed.requirements[0].acceptance.max = 5;
  write(path, changed);
  await assert.rejects(run(contract(), row), /exact design\/native/);
});

function addSchematicCheck(): string {
  const value = read(path);
  value.checks.push({ id: 'SCHEMATIC', kind: 'schematic', stage: 'schematic', requirements: ['OUTPUT'], path: 'schematic.json' });
  write(path, value);
  return join(root, 'schematic.json');
}

test('a child contract naming the design has no text locator and no hash cycle', () => {
  nativeFixture();
  const child = addSchematicCheck();
  write(child, { design_contract: { path: 'design.json', sha256: sha(path) } });
  const files = dependencyFiles(root, path, 'schematic', services);
  assert.ok(files.includes('schematic.json'));
  assert.ok(files.includes('design.json'));
});

test('an absent policy descriptor is not treated as an existing document', () => {
  nativeFixture();
  const child = addSchematicCheck();
  write(child, { population_source: { path: 'variants.json', sha256: null, exists: false } });
  assert.ok(dependencyFiles(root, path, 'schematic', services).includes('schematic.json'));
});

test('a passing report of an unrelated checker cannot certify requirements', async () => {
  nativeFixture();
  write(join(root, 'schematic.json'), { design_contract: { path: 'design.json', sha256: sha(path) } });
  const row = { id: 'SCHEMATIC', kind: 'schematic', stage: 'schematic', requirements: ['OUTPUT'], path: 'schematic.json' };
  const fake: DesignServices = { ...services, checkSchematic: async () => ({ status: 'passed', requirement_results: {}, inputs: {} }) };
  await assert.rejects(run(contract(), row, undefined, fake), /coverage/);
});

test('a declared block bench receipt without its original proof is rejected', async () => {
  nativeFixture();
  writeFileSync(join(root, 'fake-block.json'), '{"status":"passed","level":2,"qualification":"bench_validated"}');
  const value = contract();
  value.requirements[0].acceptance = { kind: 'review', criterion: 'Exact block bench evidence', source: value.requirements[0].source };
  await assert.rejects(run(value, { id: 'BLOCK', kind: 'block_qualification', stage: 'parts', requirements: ['OUTPUT'], path: 'fake-block.json' }), /original binding\/proof\/raw bench/);
});

test('a real voltage measurement does not establish lot yield or test coverage', async () => {
  nativeFixture();
  const { value, row } = benchFixture();
  assert.equal((await run(value, row)).status, 'passed');
  value.production = Object.fromEntries(['lot_yield', 'test_coverage'].map(name => [name, { required: true, source: value.requirements[0].source, check: row.id }]));
  const blocked = (productionControls(value as never) as Row[]).filter(row => row.code === 'unsupported_production_control').map(row => row.control);
  assert.deepEqual(new Set(blocked), new Set(['lot_yield', 'test_coverage']));
});

test('a real part review does not establish an approved substitution', async () => {
  nativeFixture();
  const value = contract();
  assert.equal((await run(value, partRow())).status, 'passed');
  value.production = { substitutions: { required: true, source: value.requirements[0].source, check: 'PARTS' } };
  assert.ok((productionControls(value as never) as Row[]).some(row => row.code === 'unsupported_production_control' && row.control === 'substitutions'));
});

test('a physical review requirement cannot be closed by part selection', async () => {
  nativeFixture();
  const value = contract();
  value.requirements[0].acceptance = { kind: 'review', criterion: 'Whole device function works', source: value.requirements[0].source };
  await assert.rejects(run(value, { ...partRow(), id: 'CAD-AS-BUILD', stage: 'prototype' }), /unsupported physical acceptance/);
});

function layoutFixture(): Row {
  const value = read(path);
  value.checks.push({ id: 'LAYOUT', kind: 'placement', stage: 'placement', requirements: ['OUTPUT'], path: relative(root, part), constraint_ids: ['fixture-distance'], selectors: { OUTPUT: 'fixture-distance' } });
  write(path, value);
  return value;
}

/** The board text with one footprint moved to `x`. */
function moved(text: string, reference: string, x: number): string {
  const at = text.indexOf(`"Reference" "${reference}"`), start = text.lastIndexOf('(footprint', at);
  const head = text.slice(start, at).replace(/\(at [-\d.]+/, `(at ${x}`);
  return text.slice(0, start) + head + text.slice(at);
}

test('the candidate layout replays the actual rules without a prior gate or bench', async () => {
  nativeFixture();
  layoutFixture();
  const result = await evaluateCandidateLayout(root, path, services) as Row;
  assert.equal(result.status, 'passed', JSON.stringify(result.blockers));
  assert.deepEqual(Object.keys(result.check_results), ['LAYOUT']);
  assert.equal(result.qualified, false);
  const native = join(root, FOLDER, 'fixture.kicad_pcb');
  writeFileSync(native, moved(readFileSync(native, 'utf8'), 'J2', 25));
  const rejected = await evaluateCandidateLayout(root, path, services) as Row;
  assert.equal(rejected.status, 'blocked');
  assert.match(rejected.blockers[0].detail, /placement verifier blocked/);
});

test('a test point on a pad the board does not have blocks before any layout work', async () => {
  nativeFixture();
  const value = layoutFixture();
  value.test_plans[0].signals[0].pad = 'NO-PAD';
  write(path, value);
  const result = await evaluateCandidateLayout(root, path, services) as Row;
  assert.ok(result.blockers.some((row: Row) => row.code === 'dft_native_access'));
});

test('a fixed pose is judged against the unchanged canonical board', async () => {
  nativeFixture();
  layoutFixture();
  const parts = read(part), note = join(dirname(part), 'FIXED-J1.md');
  writeFileSync(note, 'SYNTHETIC fixture rule: J1 must retain its original native placement.\n');
  parts.parts[0].layout_constraints.push({ id: 'fixture-fixed', kind: 'fixed', refs: ['J1'], source: { path: relative(root, note), sha256: sha(note), section: 'Synthetic fixed fixture', page: 1 } });
  writeReviewed(part, parts as never);
  const original = join(root, FOLDER, 'fixture.kicad_pcb'), candidate = join(root, 'candidate.kicad_pcb');
  writeFileSync(candidate, moved(readFileSync(original, 'utf8'), 'J1', 5.1));
  const before = sha(original);
  const baseline = await evaluateCandidateLayout(root, path, services) as Row;
  const checked = await evaluateCandidateLayout(root, path, services, { candidate }) as Row;
  assert.equal(baseline.status, 'passed', JSON.stringify(baseline.blockers));
  assert.equal(checked.status, 'blocked');
  assert.match(checked.blockers[0].detail, /fixture-fixed/);
  assert.equal(sha(original), before);
});

test('a candidate escape screen is owned and fresh, and leaves the canonical policy alone', async () => {
  nativeFixture();
  const value = layoutFixture(), parts = read(part), note = join(dirname(part), 'ESCAPE-J1.md');
  writeFileSync(note, 'SYNTHETIC fixture: J1.1 requires a native minimum-track escape screen.\n');
  parts.parts[0].layout_constraints.push({ id: 'fixture-escape', kind: 'escape', refs: ['J1'], pads: [{ ref: 'J1', pad: '1' }], metric: 'native_minimum_track_escape',
    source: { path: relative(root, note), sha256: sha(note), section: 'Synthetic escape fixture', page: 1 } });
  writeReviewed(part, parts as never);
  const canonical = join(root, 'canonical-escape.json');
  writeFileSync(canonical, '{"status":"canonical-original"}\n');
  value.checks.at(-1).escape_evidence = 'canonical-escape.json';
  write(path, value);
  const original = join(root, FOLDER, 'fixture.kicad_pcb'), candidate = join(root, 'candidate.kicad_pcb');
  copyFileSync(original, candidate);
  const guarded = [original, path, part, canonical], before = guarded.map(sha);
  const directory = join(root, 'owned-operation/layout-evidence'), receipt = join(directory, 'LAYOUT-escape.json');
  const artifact = join(root, 'native-screen-fixture.json');
  writeFileSync(artifact, '{"synthetic":"wiring-only; no native screen"}\n');
  let generated = 0, verified = 0;
  const review = { verifyManifest: (r: string, b: string, p: string) => JSON.parse(jsonDumps(verifyManifest(r, b, p))),
    verifyEscapeEvidence: (_contract: unknown, actual: string, evidence: string) => {
      verified += 1;
      assert.equal(actual, candidate);
      assert.equal(evidence, receipt);
      assert.equal(read(evidence).board, candidate);
      return [];
    } };
  const fake: DesignServices = { ...services,
    generateEscapeEvidence: (policy: Row, actual: string, output: string) => {
      generated += 1;
      assert.equal(policy.native, original);
      assert.equal(actual, candidate);
      assert.equal(output, receipt);
      assert.ok(policy.rules.some((rule: Row) => rule.id === 'fixture-escape'));
      write(output, { schema: 'iot-lab.pin-escape-evidence.v1', board: actual, qualified: false, inputs: { [candidate]: sha(candidate), [artifact]: sha(artifact) } });
    },
    checkPlacement: (r, b, p, options) => JSON.parse(jsonDumps(checkManifest(r, b, p, review as never, options))) };
  const missing = await evaluateCandidateLayout(root, path, fake, { candidate }) as Row;
  assert.equal(missing.status, 'blocked');
  assert.match(missing.blockers[0].detail, /evidence_directory/);
  assert.equal(generated, 0);
  const checked = await evaluateCandidateLayout(root, path, fake, { candidate, evidenceDirectory: directory }) as Row;
  const reused = await evaluateCandidateLayout(root, path, fake, { candidate, evidenceDirectory: directory }) as Row;
  assert.equal(reused.status, 'blocked');
  assert.match(reused.blockers[0].detail, /EEXIST|File exists/);
  const forbidden = join(root, 'registry/forbidden-evidence');
  const rejected = await evaluateCandidateLayout(root, path, fake, { candidate, evidenceDirectory: forbidden }) as Row;
  assert.equal(rejected.status, 'blocked');
  assert.throws(() => readdirSync(forbidden), /ENOENT/);
  assert.equal(checked.status, 'passed', JSON.stringify(checked.blockers));
  assert.equal(generated, 1);
  assert.equal(verified, 1);
  assert.deepEqual(checked.generated_evidence, [receipt]);
  assert.equal(checked.inputs[receipt], sha(receipt));
  assert.equal(checked.inputs[artifact], sha(artifact));
  assert.deepEqual(guarded.map(sha), before);
});

const cli = fileURLToPath(new URL('../design_contract.ts', import.meta.url));
const design = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, ...args], { encoding: 'utf8' });

test('--output keeps the full evidence and stdout is a compact receipt', () => {
  path = ideaFixture();
  const output = join(root, 'assessment.json');
  const run = design('check', 'IDEA-FIXTURE', '--contract', path, '--root', root, '--through', 'architecture', '--json', '--output', output);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const receipt = JSON.parse(run.stdout) as Row, full = read(output);
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.qualified, false);
  assert.deepEqual(receipt.report, { path: resolvePath(output), sha256: sha(output) });
  assert.equal(receipt.inputs, undefined);
  assert.equal(receipt.requirement_results, undefined);
  assert.ok(Object.keys(full.inputs).length);
  assert.ok(full.requirement_results.OUTPUT);
  assert.equal(receipt.blockers, full.blockers.length);
});

test('a wrong design ID on the command line keeps a durable blocked report', () => {
  path = ideaFixture();
  const output = join(root, 'result.json');
  const run = design('check', 'WRONG', '--root', root, '--contract', path, '--json', '--output', output);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.equal(read(output).blockers.at(-1).code, 'design_identity');
});
