// Source-bound lifecycle plans. Verifiers owned by other clusters are fakes here, so these tests cover the stage engine
// and the contract checks; the adapters against real part and schematic verifiers stay in test_design_contract.py.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { dependencyFiles, requirement, SCHEMA } from './design-contract-load.ts';
import { currentAssessment, evaluateCandidateLayout, evaluateContract } from './design-contract.ts';
import { designBinding, type DesignServices } from './design-contract-verifiers.ts';
import { sha256File } from './json-file.ts';
import { jsonDumps } from './py-compat.mjs';

type Row = Record<string, any>;

let root: string, path: string, calls: string[];

const unused = (name: string) => (): never => { throw new Error(`no verifier expected: ${name}`); };
const services: DesignServices = {
  pdfPages: () => 1, partDependencyFiles: () => [], verifySelection: unused('selection'),
  verifyManifest: (_root, _board, file) => {
    calls.push(`manifest ${file}`);
    return { status: 'passed', bindings: { U1: {} } };
  },
  checkSchematic: unused('schematic'), checkPlacement: unused('placement'), reviewedContract: unused('contract'),
  nativeInputs: () => ({ 'x.kicad_pcb': 'a'.repeat(64) }), generateEscapeEvidence: unused('escape'), requiredGateEvidence: unused('gate'),
  verifyCurrentInputs: unused('inputs'), readBoard: () => ({ parts: new Map([['J1', { pad_net_map: { 1: '/A' } }]]), native_inputs: {} }), runStage: unused('stage'),
};

function ideaFixture(board: string | null = null): string {
  const spec = join(root, 'idea.md');
  writeFileSync(spec, 'SYNTHETIC TEST IDEA. Output requirement 3.0..3.6V. Use test access P1.\n');
  const source = (section: string) => ({ path: 'idea.md', sha256: sha256File(spec), section });
  const value = {
    schema: SCHEMA, identity: { design_id: 'IDEA-FIXTURE', board, revision: 'synthetic-1' }, current_stage: 'requirements',
    requirements: [{
      id: 'OUTPUT', statement: 'Synthetic output interval', source: source('Output'), verification_stage: 'prototype',
      acceptance: { kind: 'interval', min: 3, max: 3.6, unit: 'V', source: source('Output requirement') },
    }],
    architecture: {
      source: source('Architecture'), interfaces: [{ id: 'OUTPUT-PORT', requirements: ['OUTPUT'], source: source('Interface') }],
      decisions: [{ id: 'TOPOLOGY', requirements: ['OUTPUT'], source: source('Architecture choice') }],
    },
    test_plans: [{
      id: 'OUTPUT-TEST', requirements: ['OUTPUT'], stage: 'prototype', method: 'Measure output under sourced operating condition', procedure: source('Procedure'),
      access: source('Test access'), equipment: source('Instrument capability'), failure_conditions: source('Failure response'),
      signals: [{ net: '/A', ref: 'J1', pad: '1' }], check: 'MEASURE',
    }],
    failure_conditions: [{ id: 'OUTSIDE-OUTPUT', requirements: ['OUTPUT'], source: source('Failure'), condition: 'Output outside reviewed interval', test_plan: 'OUTPUT-TEST' }],
    unknowns: [], checks: [{ id: 'MEASURE', stage: 'prototype', kind: 'bench', requirements: ['OUTPUT'], path: 'bench/results.json', plan: 'bench/plan.json' }], production: {},
  };
  const file = join(root, 'design.json');
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'design-contract-')));
  calls = [];
  path = ideaFixture();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const edit = (change: (value: Row) => void) => {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  change(value);
  writeFileSync(path, JSON.stringify(value));
};
const report = (through?: string): Row => evaluateContract(root, path, through, services);
const codes = (result: Row): string[] => result.blockers.map((row: Row) => row.code);

test('an idea without gate or CAD can record a plan; a future bench does not block', () => {
  const result = report('architecture');
  assert.equal(result.status, 'passed', jsonDumps(result.blockers));
  assert.equal(result.board, null);
  assert.equal(result.qualified, false);
  assert.equal(result.functional_qualification, false);
  assert.equal(result.stages.prototype.readiness, 'future_evidence_not_requested');
  assert.equal(result.requirement_results.OUTPUT.required_now, false);
});

test('an unknown blocks only its explicit stage', () => {
  edit(value => { value.unknowns = [{ id: 'CURRENT', question: 'Maximum load not decided', owner: 'designer', blocking_stage: 'parts', source: value.requirements[0].source }]; });
  assert.equal(report('architecture').status, 'passed');
  assert.ok(codes(report('parts')).includes('unresolved_unknown'));
});

test('missing architecture and failure links block architecture', () => {
  edit(value => Object.assign(value, { architecture: null, failure_conditions: [] }));
  assert.equal(report('requirements').status, 'passed');
  assert.ok(codes(report('architecture')).includes('architecture_plan'));
});

test('a source change is stale; invalid numbers do not parse', () => {
  writeFileSync(join(root, 'idea.md'), 'Changed physical limit');
  assert.equal(report().status, 'stale');
  path = ideaFixture();
  writeFileSync(path, readFileSync(path, 'utf8').replace('"min": 3', '"min": NaN'));
  assert.equal(report().status, 'blocked');
});

test('invalid sources keep the requested stage and design identity', () => {
  writeFileSync(join(root, 'idea.md'), 'Changed source');
  const result = report('architecture');
  assert.equal(result.through, 'architecture');
  assert.equal(result.design_id, 'IDEA-FIXTURE');
  assert.equal(result.status, 'stale');
});

test('requirement lookup and the source closure are actual', () => {
  assert.equal((requirement(root, path, 'OUTPUT', services).acceptance as Row).unit, 'V');
  assert.deepEqual(dependencyFiles(root, path, 'architecture', services), ['design.json', 'idea.md']);
  assert.throws(() => requirement(root, path, 'MISSING', services), /unknown design requirement/);
});

test('DFT plans are required before layout', () => {
  edit(value => Object.assign(value, { test_plans: [], failure_conditions: [] }));
  const result = report('placement');
  assert.ok(codes(result).includes('architecture_plan'));
  assert.equal(result.stages.placement.readiness, 'upstream_stage_blocked');
  assert.equal(result.qualified, false);
});

test('a declared pass or an unknown verifier does not prove a function', () => {
  edit(value => { value.passed = true; });
  assert.equal(report().status, 'blocked');
});

test('unknown numeric conditions are not silently dropped', () => {
  edit(value => { value.requirements[0].acceptance.conditions = { temperature: 25 }; });
  const result = report();
  assert.equal(result.status, 'blocked');
  assert.match(result.blockers[0].detail, /conditions/);
  path = ideaFixture();
  edit(value => { value.checks[0].kind = 'file_exists'; });
  assert.equal(report().status, 'blocked');
});

test('future missing measurements become required only at prototype', () => {
  assert.equal(report('architecture').status, 'passed');
  const result = report('prototype');
  assert.ok(codes(result).includes('stage_evidence_missing'));
  assert.equal(result.requirement_results.OUTPUT.status, 'blocked');
  assert.equal(result.stages.prototype.readiness, 'upstream_stage_blocked');
});

test('production scope must name all controls, and an upstream failure stops later verifiers', () => {
  const result = report('production');
  assert.equal(result.status, 'blocked');
  assert.equal(result.stages.production.readiness, 'upstream_stage_blocked');
  assert.equal(result.stages.parts.status, 'blocked');
  assert.deepEqual(calls, []);
});

test('a missing active checker is bound even without a board', () => {
  edit(value => { value.checks.push({ id: 'PARTS', stage: 'parts', kind: 'part_use', requirements: ['OUTPUT'], path: 'missing-review.json', references: ['U1'] }); });
  const result = report('parts');
  assert.ok(result.absent_inputs.includes(join(root, 'missing-review.json')));
  assert.equal(currentAssessment(result), true);
  writeFileSync(join(root, 'missing-review.json'), '{}');
  assert.equal(currentAssessment(result), false);
});

test('a current-day release expires; explicit history does not', () => {
  const result = report();
  assert.equal(currentAssessment(result), true);
  result.temporal_context = [{ order_day_utc: '2000-01-01', requires_current_day: true }];
  assert.equal(currentAssessment(result), false);
  result.temporal_context[0].requires_current_day = false;
  assert.equal(currentAssessment(result), true);
  assert.equal(result.qualified, false);
});

test('a contract changed during an assessment is stale', () => {
  // A PDF source makes every load call pdfPages, after the contract was hashed and before the final recheck.
  writeFileSync(join(root, 'doc.pdf'), '%PDF-fixture');
  edit(value => { value.requirements[0].source = { path: 'doc.pdf', sha256: sha256File(join(root, 'doc.pdf')), page: 1 }; });
  const text = readFileSync(path, 'utf8');
  let loads = 0;
  const changing: DesignServices = {
    ...services,
    pdfPages: () => {
      loads++;
      writeFileSync(path, `${text}\n`);
      return 1;
    },
  };
  const result = evaluateContract(root, path, 'architecture', changing);
  assert.ok(loads > 0);
  assert.equal(result.status, 'stale');
  assert.match((result.blockers as Row[])[0]?.detail, /stale input changed/);
});

test('the bench binding hashes the numbers as the file wrote them', () => {
  path = ideaFixture('FIX-1');
  const whole = readFileSync(path, 'utf8');
  const contract = JSON.parse(whole);
  const asInt = designBinding(root, path, contract, services);
  writeFileSync(path, whole.replace('"min": 3', '"min": 3.0'));
  assert.notEqual(designBinding(root, path, contract, services), asInt);
  assert.throws(() => designBinding(root, path, { identity: { board: null } }, services), /native board identity/);
});

test('a candidate layout without a placement verifier is blocked before any work', () => {
  const result = evaluateCandidateLayout(root, path, services);
  assert.equal(result.status, 'blocked');
  assert.ok(codes(result).includes('candidate_layout_contract_missing'));
  assert.ok(codes(result).includes('native_design_missing'));
});

/** A contract whose parts stage has one reviewed part_use check. */
function partsContract(references: string[]): void {
  path = ideaFixture('FIX-1');
  mkdirSync(join(root, 'reviews'), { recursive: true });
  writeFileSync(join(root, 'reviews/parts.json'), '{}');
  edit(value => {
    value.requirements[0].verification_stage = 'parts';
    value.requirements[0].acceptance = { kind: 'review', criterion: 'Reviewed', source: value.requirements[0].source };
    delete value.test_plans[0].check;
    value.checks = [{ id: 'PARTS', stage: 'parts', kind: 'part_use', requirements: ['OUTPUT'], path: 'reviews/parts.json', references }];
  });
}

test('a verifier that passes is recorded against its requirement', () => {
  partsContract(['U1']);
  const result = report('parts');
  assert.equal(result.status, 'passed', jsonDumps(result.blockers));
  assert.deepEqual(calls, [`manifest ${join(root, 'reviews/parts.json')}`]);
  assert.equal(result.check_results.PARTS.status, 'passed');
  assert.equal(result.check_results.PARTS.scope, 'current_part_use_evidence');
  assert.deepEqual(result.requirement_results.OUTPUT, { status: 'passed', checks: ['PARTS'], scope: 'actual_verifier_coverage' });
  assert.ok(join(root, 'reviews/parts.json') in result.inputs);
});

test('a verifier run on the wrong references blocks its requirement', () => {
  partsContract(['U9']);
  const result = report('parts');
  assert.equal(result.status, 'blocked');
  assert.equal(result.check_results.PARTS.status, 'blocked');
  assert.match(result.blockers[0].detail, /exact reviewed native references/);
  assert.ok(codes(result).includes('requirement_unverified'));
});

test('a stage plan that is not clean stops the verifier before it runs', () => {
  partsContract(['U1']);
  edit(value => { value.unknowns = [{ id: 'OPEN', question: 'Load?', owner: 'designer', blocking_stage: 'parts', source: value.requirements[0].source }]; });
  const result = report('parts');
  assert.deepEqual(calls, []);
  assert.equal(result.check_results.PARTS.scope, 'stage_plan_blocked_before_verifier');
});
