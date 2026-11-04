import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { artifactIdentity, finalizeDataset, loadDataset, splitRows, type DatasetInput } from './pcb_ml_data.ts';
import { encode, Float, parseJson, sha256File } from './pcb_ml_json.ts';

export function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pcb-ml-data-ts-')));
  const source = join(root, 'source.json'); writeFileSync(source, '{"observed":true}\n');
  const row = (id = 'a', changes = {}) => ({ id, family: 'F1', case_fingerprint: artifactIdentity('case'),
    source_fingerprint: artifactIdentity('source'), run_fingerprint: artifactIdentity(id), pose_fingerprint: artifactIdentity('pose'),
    split: 'train', features: { density: new Float(0.25), opens: 1 }, targets: { routed: 1, duration: new Float(2.5) }, evidence_valid: true, ...changes });
  const input = (rows: unknown[] = [row()], changes = {}): DatasetInput => ({ dataset_id: 'routing-dev', task: 'routing_outcome',
    feature_names: ['opens', 'density'], target_specs: { routed: { type: 'binary', direction: 'max' }, duration: { type: 'regression', direction: 'min', unit: 's' } },
    rows, inputs: { 'source.json': sha256File(source) }, ...changes });
  const save = (value: unknown) => { const path = join(root, 'dataset.json'); writeFileSync(path, encode(value) + '\n'); return path; };
  return { root, source, row, input, save, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('sealed table roundtrip retains metadata and ordered features; source aliases normalize', t => {
  const f = fixture(); t.after(f.cleanup);
  const alias = join(f.root, 'alias.json'); symlinkSync(f.source, alias);
  const table = finalizeDataset(f.root, f.input([f.row('a', { status: 'timeout', censoring: { right_censored: true } })],
    { inputs: { [alias]: sha256File(f.source), [f.source]: sha256File(f.source) } }));
  assert.deepEqual(Object.keys(table.rows[0].features), ['opens', 'density']);
  assert.deepEqual(table.inputs, { [f.source]: sha256File(f.source) });
  assert.deepEqual(loadDataset(f.root, f.save(table)), table);
  assert.equal(splitRows(table, 'train', 'routed').length, 1);
  assert.deepEqual(table.rows[0].censoring, { right_censored: true });
});

test('unknowns, ineligible evidence and deterministic run aliases never supply extra samples', t => {
  const f = fixture(); t.after(f.cleanup);
  const run = artifactIdentity('shared');
  const rows = [f.row('z', { run_fingerprint: run }), f.row('missing', { features: { opens: 2 }, targets: {} }),
    f.row('bad', { evidence_valid: false }), f.row('a', { run_fingerprint: run }), f.row('repeat')];
  const table = finalizeDataset(f.root, f.input(rows));
  assert.deepEqual(splitRows(table, 'train', 'routed').map(r => r.id), ['a', 'repeat']);
  assert.deepEqual(table.rows.find(r => r.id === 'z')!.eligibility.reasons, [{ code: 'duplicate_run', duplicate_of: 'a' }]);
  assert.equal(table.rows.find(r => r.id === 'missing')!.features.density, null);
  assert.deepEqual(finalizeDataset(f.root, f.input([...rows].reverse())), table);
  assert.throws(() => finalizeDataset(f.root, f.input([f.row('a', { run_fingerprint: run }), f.row('z', { run_fingerprint: run, targets: { routed: 0 } })])), /one sealed run/);
});

test('all partitions include ineligible rows; schema, binary types and source mutations fail', t => {
  const f = fixture(); t.after(f.cleanup);
  for (const field of ['family', 'case_fingerprint', 'source_fingerprint', 'run_fingerprint']) {
    const first = f.row();
    const other = f.row('test', { split: 'test', family: 'F2', case_fingerprint: artifactIdentity('C2'), source_fingerprint: artifactIdentity('S2'),
      run_fingerprint: artifactIdentity('R2'), pose_fingerprint: artifactIdentity('P2'), evidence_valid: false, [field]: first[field as keyof typeof first] });
    assert.throws(() => finalizeDataset(f.root, f.input([first, other])), /cross-split/);
  }
  for (const value of [true, false, NaN, Infinity, '1']) assert.throws(() => finalizeDataset(f.root, f.input([f.row('x', { features: { opens: value } })])));
  for (const value of [new Float(1), new Float(0), 2, -1]) assert.throws(() => finalizeDataset(f.root, f.input([f.row('x', { targets: { routed: value } })])), /binary target/);
  assert.throws(() => finalizeDataset(f.root, f.input([f.row('x', { features: { leaked_target: 1 } })])), /differ/);
  assert.throws(() => finalizeDataset(f.root, f.input([], { inputs: {} })), /source artifacts/);
  const table = finalizeDataset(f.root, f.input()); f.save(table); writeFileSync(f.source, 'changed');
  assert.throws(() => loadDataset(f.root, 'dataset.json'), /source artifact changed/);
});

test('eligibility is recomputed after verifying the seal; empty and unknown selectors', t => {
  const f = fixture(); t.after(f.cleanup);
  const table = finalizeDataset(f.root, f.input([f.row('bad', { evidence_valid: false })]));
  table.rows[0].eligibility.features = true;
  const { content_sha256: _, ...payload } = table; table.content_sha256 = artifactIdentity(payload);
  assert.throws(() => loadDataset(f.root, f.save(table)), /eligibility/);
  const empty = finalizeDataset(f.root, f.input([]));
  assert.deepEqual(loadDataset(f.root, f.save(empty)), empty);
  assert.deepEqual(splitRows(empty, 'train'), []);
  assert.throws(() => splitRows(empty, 'holdout' as 'train'), /invalid dataset split/);
  assert.throws(() => splitRows(empty, 'test', 'missing'), /unknown target/);
});

test('strict canonical JSON preserves float/int identities and rejects ambiguity', () => {
  assert.equal(artifactIdentity({ b: 2, a: 1 }), artifactIdentity({ a: 1, b: 2 }));
  assert.notEqual(artifactIdentity(1), artifactIdentity(new Float(1)));
  assert.equal(encode(parseJson('{"a":1.0,"b":12345678901234567890,"c":-0.0}')), '{"a":1.0,"b":12345678901234567890,"c":-0.0}');
  for (const json of ['{"x":1,"x":2}', '{"x":{"a":0,"\\u0061":1}}']) assert.throws(() => parseJson(json), /duplicate JSON key/);
  for (const json of ['{"x":NaN}', '{"x":Infinity}', '{"x":1e999}']) assert.throws(() => parseJson(json), /finite/);
  for (const json of ['[1,]', '{"a":1,}', '1 2', '\ufeff{}']) assert.throws(() => parseJson(json));
  assert.throws(() => artifactIdentity({ x: '\ud800' }), /canonical JSON/);
  assert.equal(encode(parseJson('{"__proto__":{"x":1}}')), '{"__proto__":{"x":1}}');
});
