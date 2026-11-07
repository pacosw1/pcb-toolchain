import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { sha256File } from './json-file.ts';
import { contractKey, contractProblem, STAGE_CONTRACTS } from './stage-contracts.ts';

/** A run folder with the declared files, and the evidence map that a seal would record. */
function run(t: TestContext, skip: string[] = []): { folder: string; evidence: Record<string, string> } {
  const folder = mkdtempSync(join(tmpdir(), 'stage-contract-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const evidence: Record<string, string> = {};
  for (const name of [...STAGE_CONTRACTS.route.inputs, ...STAGE_CONTRACTS.route.outputs]) {
    if (skip.includes(name)) continue;
    mkdirSync(join(folder, name, '..'), { recursive: true });
    writeFileSync(join(folder, name), name);
    evidence[name] = sha256File(join(folder, name));
  }
  return { folder, evidence };
}

test('place, edit, route, build and repair have a contract; a place edit is the place stage; other operations have none', () => {
  assert.equal(contractKey({ operation: 'edit', kind: 'place' }), 'place');
  assert.equal(contractKey({ operation: 'edit', kind: 'route' }), 'edit');
  assert.equal(contractKey({ operation: 'edit' }), 'edit');
  assert.equal(contractKey({ operation: 'route' }), 'route');
  assert.equal(contractKey({ operation: 'build' }), 'build');
  assert.equal(contractKey({ operation: 'repair' }), 'repair');
  for (const operation of ['release', 'check']) assert.equal(contractKey({ operation }), null, operation);
  assert.deepEqual(STAGE_CONTRACTS.route.outputs, ['images/top.svg', 'images/bottom.svg']);
  assert.deepEqual(Object.keys(STAGE_CONTRACTS).sort(), ['build', 'edit', 'layout', 'place', 'repair', 'route']);
});

test('a run passes the contract when each declared file exists and its hash is in the sealed record', t => {
  const { folder, evidence } = run(t);
  for (const operation of ['route', 'edit']) assert.equal(contractProblem({ operation }, folder, evidence), null);
  assert.equal(contractProblem({ operation: 'edit', kind: 'place' }, folder, evidence), null);
  for (const operation of ['build', 'repair']) assert.equal(contractProblem({ operation }, folder, evidence), null, operation);
  assert.equal(contractProblem({ operation: 'release' }, folder, {}), null, 'no contract, no problem');
});

test('a missing output, an output not in the sealed record and a changed output each fail and name the file', t => {
  const missing = run(t, ['images/bottom.svg']);
  assert.match(contractProblem({ operation: 'route' }, missing.folder, missing.evidence)!, /route stage output images\/bottom\.svg is missing/);
  const unsealed = run(t);
  delete unsealed.evidence['images/top.svg'];
  assert.match(contractProblem({ operation: 'edit', kind: 'place' }, unsealed.folder, unsealed.evidence)!, /place stage output images\/top\.svg is not in the sealed run record/);
  const changed = run(t);
  writeFileSync(join(changed.folder, 'images/top.svg'), 'other');
  assert.match(contractProblem({ operation: 'route' }, changed.folder, changed.evidence)!, /images\/top\.svg is not in the sealed run record/);
  const noImages = run(t, ['images/top.svg', 'images/bottom.svg']);
  for (const operation of ['build', 'repair']) assert.match(contractProblem({ operation }, noImages.folder, noImages.evidence)!, new RegExp(`${operation} stage output images/top\\.svg is missing`));
  const noInput = run(t, ['operation/source.json']);
  assert.match(contractProblem({ operation: 'route' }, noInput.folder, noInput.evidence)!, /route stage input operation\/source\.json is missing/);
});
