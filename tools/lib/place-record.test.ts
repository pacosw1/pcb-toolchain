import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { candidateFields } from './pcb-candidate-admission.ts';
import { sha } from './pcb-workflow.ts';
import { placeChoice, placeRecordPath, writePlaceRecord, type PlaceRow } from './place-record.ts';

function scratch(t: TestContext, text = '{"place":{"U1":[1,2,90]}}'): { root: string; spec: string } {
  const root = mkdtempSync(join(tmpdir(), 'place-record-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const spec = join(root, 'spec.json');
  writeFileSync(spec, text);
  return { root, spec };
}
const row = (seed: number, spec: string, legal = true): PlaceRow => ({ seed, spec, spec_sha256: sha(spec), legal, moved: 1,
  margins: { smallest_mm: 0.4, rules: [] }, wirelength: 10, estimates: null, misses: [] });

test('the record holds the table and the spec hashes of the last place call', t => {
  const { root, spec } = scratch(t);
  writePlaceRecord(root, 'X', [row(1, spec), row(2, spec, false)]);
  const record = JSON.parse(readFileSync(placeRecordPath(root, 'X'), 'utf8'));
  assert.equal(placeRecordPath(root, 'X'), join(root, '.gate/place/X-candidates.json'));
  assert.equal(record.board, 'X');
  assert.deepEqual(record.rows.map((r: PlaceRow) => [r.seed, r.legal, r.spec_sha256]), [[1, true, sha(spec)], [2, false, sha(spec)]]);
});

test('a spec that is a row of the record is a table choice that carries the whole table', t => {
  const { root, spec } = scratch(t);
  writePlaceRecord(root, 'X', [row(3, spec)]);
  const choice = placeChoice(root, 'X', spec);
  assert.equal(choice.source, 'table');
  assert.equal(choice.seed, 3);
  assert.equal(choice.record_sha256, sha(placeRecordPath(root, 'X')));
  assert.deepEqual((choice.table as PlaceRow[]).map(r => r.seed), [3]);
  assert.equal(placeChoice(root, 'X', spec, 'hand').source, 'table', 'a row of the table wins over the origin word');
});

test('a spec with no row and no origin stops and names the next action', t => {
  const { root, spec } = scratch(t);
  const next = /is not a row of .*X-candidates\.json; run `tools\/pcb place X --seeds N` and pass one of its specs, or pass --origin hand or --origin move/;
  assert.throws(() => placeChoice(root, 'X', spec), next, 'no record');
  writePlaceRecord(root, 'X', [row(1, spec)]);
  writeFileSync(spec, '{"place":{"U1":[9,9,0]}}');
  assert.throws(() => placeChoice(root, 'X', spec), next, 'the spec changed after the record');
});

test('an origin word records a spec made outside the table; another word stops', t => {
  const { root, spec } = scratch(t);
  assert.deepEqual(placeChoice(root, 'X', spec, 'hand'), { source: 'hand' });
  assert.deepEqual(placeChoice(root, 'X', spec, 'move'), { source: 'move' });
  assert.throws(() => placeChoice(root, 'X', spec, 'guess'), /--origin must be hand or move/);
});

test('admission of a place edit records the choice in the run fields', t => {
  const { root, spec } = scratch(t);
  assert.throws(() => candidateFields(root, 'edit', 'X', { kind: 'place', spec }), /is not a row of/);
  assert.deepEqual((candidateFields(root, 'edit', 'X', { kind: 'place', spec, origin: 'hand' }).place_choice), { source: 'hand' });
  writePlaceRecord(root, 'X', [row(4, spec)]);
  assert.equal((candidateFields(root, 'edit', 'X', { kind: 'place', spec }).place_choice as { seed: number }).seed, 4);
  writeFileSync(spec, JSON.stringify({ routes: [] }));
  assert.equal(candidateFields(root, 'edit', 'X', { kind: 'route', spec }).place_choice, undefined);
});
