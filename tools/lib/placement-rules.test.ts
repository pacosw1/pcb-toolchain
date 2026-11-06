import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkProblem, prepareProblem } from '../placer/engineering-problem.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { canonicalRules, changeRules } from '../pcb-constraints.ts';
import { reseal, verifySeal } from './cad-seal.ts';
import { SCHEMA, type Rule } from './engineering-constraints.ts';
import { gateInputs, fingerprint } from './gate-inputs.mjs';
import { sha256File } from './json-file.ts';
import { checkPlacementRules, loadPlacementRules, placementRulesPath, verifyManifest } from './placement-rules.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'placement-rules-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, 'hardware-design/boards/X'); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'gate.json'), JSON.stringify({ project: 'X', checks: {} }));
  writeFileSync(join(folder, 'X.kicad_pcb'), '(kicad_pcb (footprint "X" (at 1 2) (property "Reference" "U1")) (footprint "X" (at 4 6) (property "Reference" "H1")))');
  writeFileSync(join(folder, 'SPEC.md'), 'source');
  const rule: Rule = { id: 'distance', kind: 'part_distance', source: { path: 'hardware-design/boards/X/SPEC.md', sha256: sha256File(join(folder, 'SPEC.md')), page: 1 }, a: 'U1', b: ['H1'], metric: 'origin_nearest_euclidean', max_mm: 4 };
  reseal(root, 'X', { tool: 'fixture', run_id: null });
  return { root, folder, rule, path: placementRulesPath(root, 'X') };
}

test('a board file needs no part review and logs each missed rule', t => {
  const f = fixture(t);
  assert.equal(checkPlacementRules(f.root, 'X'), null);
  writeFileSync(f.path, JSON.stringify({ schema: SCHEMA, rules: [f.rule] }));
  assert.equal(verifyManifest(f.root, 'X', f.path).status, 'passed');
  const output = join(f.folder, 'report.json');
  const report = checkPlacementRules(f.root, 'X', undefined, output)!;
  assert.equal(report.status, 'blocked');
  assert.match(readFileSync(output.replace('.json', '.log'), 'utf8'), /FAIL distance measured=5 limit=.*max.*4/);
  writeFileSync(f.path, JSON.stringify({ schema: 'unknown', rules: [] }));
  assert.notEqual(verifyManifest(f.root, 'X', f.path).status, 'passed');
});

test('canonical additions reseal, log one reason, and invalidate gate evidence', async t => {
  const f = fixture(t), spec = join(f.root, 'rule.json');
  writeFileSync(spec, JSON.stringify(f.rule));
  const before = fingerprint(f.root, gateInputs(f.root, 'X').files).input_sha256;
  await changeRules(f.root, 'X', { add: spec, reason: 'measured source limit' });
  verifySeal(f.root, 'X');
  const bytes = readFileSync(f.path, 'utf8');
  assert.ok(bytes.endsWith('\n')); assert.match(bytes, /\n  "rules":/);
  assert.equal(loadPlacementRules(f.root, 'X').rules.length, 1);
  assert.notEqual(fingerprint(f.root, gateInputs(f.root, 'X').files).input_sha256, before);
  const log = readFileSync(join(f.root, '.gate/cad-seal/X.jsonl'), 'utf8').trim().split('\n').map(row => JSON.parse(row));
  assert.equal(log.length, 2); assert.equal(log[1].reason, 'measured source limit');
  await assert.rejects(changeRules(f.root, 'X', { add: spec, reason: 'duplicate' }), /distinct/);
  assert.equal(readFileSync(f.path, 'utf8'), bytes);
  await changeRules(f.root, 'X', { remove: 'distance', reason: 'superseded' });
  verifySeal(f.root, 'X'); assert.equal(loadPlacementRules(f.root, 'X').rules.length, 0);
  writeFileSync(f.path, JSON.stringify({ schema: SCHEMA, rules: [f.rule] }));
  assert.throws(() => verifySeal(f.root, 'X'), /placement-constraints/);
  await assert.rejects(changeRules(f.root, 'X', { remove: 'distance', reason: 'hand edit' }), /changed outside/);
});

test('canonical keys are independent of input order and sources stay bound', t => {
  const f = fixture(t);
  const other = { ...f.rule, id: 'a' };
  const reversed = Object.fromEntries(Object.entries(f.rule).reverse()) as Rule;
  assert.equal(JSON.stringify(canonicalRules([f.rule, other])), JSON.stringify(canonicalRules([other, reversed])));
  writeFileSync(f.path, JSON.stringify({ schema: SCHEMA, rules: [f.rule] }));
  writeFileSync(join(f.folder, 'SPEC.md'), 'changed');
  assert.throws(() => loadPlacementRules(f.root, 'X'), /source changed/);
});

test('the placer reads board rules through its normal review service', t => {
  const f = fixture(t);
  writeFileSync(f.path, JSON.stringify({ schema: SCHEMA, rules: [f.rule] }));
  const problem = prepareProblem(f.root, 'X', f.path, {
    board_file: join(f.folder, 'X.kicad_pcb'), board: { outline: [[0, 0], [10, 0], [10, 10], [0, 10]] },
    units: [{ name: 'U1', refs: ['U1'], x: 1, y: 2, fixed: false }, { name: 'H1', refs: ['H1'], x: 4, y: 6, fixed: true }],
  } as never);
  assert.equal(checkProblem(problem).status, 'blocked');
  assert.equal(checkProblem(problem, [[2, 3, 0], [4, 6, 0]]).status, 'passed');
});

test('the dispatcher reads and adds board rules with a reason', t => {
  const f = fixture(t), spec = join(f.root, 'new.json'); writeFileSync(spec, JSON.stringify(f.rule));
  const command = fileURLToPath(new URL('../pcb', import.meta.url));
  const invoke = (args: string[]) => JSON.parse(execFileSync(command, ['--project', f.root, 'constraints', 'X', ...args, '--json'], { encoding: 'utf8' }));
  assert.equal(invoke([]).rules.length, 0);
  const report = invoke(['--add', spec, '--reason', 'board rule']);
  assert.equal(report.rules.length, 1);
  assert.equal(report.measurements[0].margin_mm, -1);
  verifySeal(f.root, 'X');
});
