import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { finalizeDataset } from './pcb_ml_data.ts';
import { artifactIdentity, encode, float, number, object, readObject, same, sha256File, type Obj } from './pcb_ml_json.ts';
import { algorithms, dependencyFiles, evaluateModel, predictRows, trainModel } from './pcb_ml_models.ts';
import { fsum } from './pcb_ml_numeric.ts';

export function modelFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pcb-ml-models-ts-'))), source = join(root, 'evidence.json');
  writeFileSync(source, '{"scope":"synthetic numeric learning; no PCB qualification"}\n');
  mkdirSync(join(root, 'tools')); const extractor = join(root, 'tools/synthetic_features.ts');
  writeFileSync(extractor, '// Synthetic, never dynamically loaded.\n');
  const contract = { extractor: 'synthetic x/constant', version: 1, implementation_sha256: { 'tools/synthetic_features.ts': sha256File(extractor) } };
  const rows = (binary = false): Obj[] => ['train', 'validation', 'test'].flatMap(split =>
    (split === 'train' ? [-3, -2, -1, 0, 1, 2, 3] : split === 'validation' ? [-2.5, 0.5, 2.5] : [-2, 1, 3]).map((x, i) => ({
      id: `${split}-${i}`, family: split + '-FAMILY', case_fingerprint: artifactIdentity({ case: split }), source_fingerprint: artifactIdentity({ source: split }),
      pose_fingerprint: artifactIdentity({ pose: x }), run_fingerprint: artifactIdentity({ run: `${split}-${i}` }), split, features: { x, constant: float(7) },
      targets: { y: binary ? Number(x > 0) : float(2 * x + 5) }, evidence_valid: true, status: 'passed', failure_class: null })));
  const save = (samples = rows(), name = 'dataset.json', binary = false, featureNames = ['x', 'constant'], metadata: Obj = {}) => {
    const data = finalizeDataset(root, { dataset_id: 'synthetic-learning', task: 'synthetic', feature_names: featureNames,
      target_specs: { y: { type: binary ? 'binary' : 'regression', direction: 'max' } }, rows: samples,
      inputs: { [source]: sha256File(source) }, metadata: { feature_contract: contract, ...metadata } });
    const path = join(root, name); writeFileSync(path, encode(data, true) + '\n'); return path;
  };
  const fit = (path = save(), output = 'model.json', options = {}) => trainModel(root, path, { modelId: 'synthetic', target: 'y', output, ...options });
  return { root, source, extractor, contract, rows, save, fit, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('ridge learns a known line on disjoint folds and is reproducible; TRAIN owns normalization', t => {
  const f = modelFixture(); t.after(f.cleanup);
  const path = f.save(), model = f.fit(path, 'first.json', { hyperparameters: { alpha: 0 } });
  assert.equal(model.normalization.columns[0].magnitude, 3);
  const report = evaluateModel(f.root, 'first.json', path), fold = object(object(report.folds).test);
  // The analytic fixture y=2x+5 has zero residual; allow only binary64 elimination roundoff (epsilon squared).
  assert.ok(number(object(fold.model).mse) < (Number.EPSILON * 100) ** 2);
  assert.equal(number(object(fold.within_case).mean_case_concordance), 1);
  assert.ok(number(object(fold.constant_baseline).mse) > 1);
  f.fit(path, 'second.json', { hyperparameters: { alpha: 0 } });
  assert.equal(readFileSync(join(f.root, 'first.json'), 'utf8'), readFileSync(join(f.root, 'second.json'), 'utf8'));
  const rows = f.rows();
  rows.filter(r => r.split === 'test').forEach(r => { object(r.features).x = number(object(r.features).x) * 1e6; object(r.targets).y = -999999; });
  const changed = f.fit(f.save(rows, 'changed.json'), 'changed-model.json', { hyperparameters: { alpha: 0 } });
  assert.deepEqual(changed.parameters, model.parameters); assert.deepEqual(changed.normalization, model.normalization);
  assert.equal(report.qualified, false); assert.equal(report.adopt_weights, false);
});

test('prediction reads only id/features and checks order, numeric types, task and extractor', t => {
  const f = modelFixture(); t.after(f.cleanup); f.fit();
  const row = { id: 'candidate', features: { x: 2, constant: 7 }, targets: { y: 'never read' } };
  const first = predictRows(f.root, 'model.json', [row], { featureNames: ['x', 'constant'], featureContract: f.contract, task: 'synthetic' });
  row.targets.y = 'changed label'; assert.deepEqual(predictRows(f.root, 'model.json', [row], { featureContract: f.contract }), first);
  for (const options of [{ featureNames: ['constant', 'x'] }, { task: 'other' }, { featureContract: { version: 99 } }])
    assert.throws(() => predictRows(f.root, 'model.json', [row], options), /differ/);
  assert.throws(() => predictRows(f.root, 'model.json', [{ id: 'bad', features: { constant: 7, x: 2 } }]), /order/);
  assert.throws(() => predictRows(f.root, 'model.json', [{ id: 'bad', features: { x: true as unknown as number, constant: 7 } }]), /finite number/);
  const unknown = predictRows(f.root, 'model.json', [{ id: 'unknown', features: { x: null, constant: 7 } }]);
  assert.equal(object((unknown.rows as Obj[])[0]).status, 'unknown');
  const files = dependencyFiles(f.root, 'model.json', 'dataset.json'); assert.equal(files[f.source], sha256File(f.source));
  rmSync(join(f.root, 'dataset.json')); rmSync(f.source);
  assert.ok((predictRows(f.root, 'model.json', [row]).rows as Obj[])[0].prediction !== null);
  writeFileSync(f.extractor, '// changed\n'); assert.throws(() => predictRows(f.root, 'model.json', [row]), /changed/);
});

test('binary scores, mean registry, singular features, and invalid algorithms', t => {
  const f = modelFixture(); t.after(f.cleanup);
  const rows = f.rows(true); rows.forEach(r => { const features = object(r.features); r.features = { x: features.x, duplicate: features.x, constant: 7 }; });
  const path = f.save(rows, 'binary.json', true, ['x', 'duplicate', 'constant']);
  const model = f.fit(path, 'ridge.json', { hyperparameters: { alpha: 0 } });
  assert.equal(object(model.parameters).numerical_rank, 1);
  const prediction = predictRows(f.root, 'ridge.json', [{ id: 'far', features: { x: 100, duplicate: 100, constant: 7 } }]);
  assert.equal(number((prediction.rows as Obj[])[0].prediction), 1);
  assert.equal(prediction.calibrated_probability, false);
  assert.equal(f.fit(path, 'mean.json', { algorithm: 'mean' }).algorithm.name, 'constant_mean');
  assert.deepEqual(Object.keys(algorithms()), ['constant_mean', 'ridge']);
  for (const options of [{ algorithm: 'import/code' }, { hyperparameters: { eval: 1 } }, { hyperparameters: { alpha: true } }, { hyperparameters: { alpha: -1 } }, { hyperparameters: { alpha: NaN } }])
    assert.throws(() => f.fit(path, 'bad.json', options));
});

test('repeats share case/pose weight and selected unknown labels keep ranking outcomes incomplete', t => {
  const f = modelFixture(); t.after(f.cleanup);
  const rows = f.rows(), original = f.fit(f.save(rows, 'first.json'), 'first-model.json');
  const repeat = { ...rows[0], id: 'repeat', run_fingerprint: artifactIdentity('repeat') };
  const repeated = f.fit(f.save([...rows, repeat], 'repeated.json'), 'repeated-model.json');
  assert.deepEqual(original.parameters, repeated.parameters);
  const selected = rows.find(r => r.id === 'test-2')!; object(selected.targets).y = null; selected.status = 'timeout'; selected.failure_class = 'timeout';
  const path = f.save(rows, 'unknown.json'); f.fit(path, 'unknown-model.json');
  const ranking = object(object(object(evaluateModel(f.root, 'unknown-model.json', path).folds).test).within_case);
  assert.equal(ranking.selected_unknown_label_runs, 1); assert.equal(ranking.selected_observed_target_sum, null);
  assert.deepEqual(object(ranking.selected_actual_outcomes).failure_class_counts, { timeout: 1 });
});

test('seals, provenance, overwrite protection, empty TRAIN, and tiny labels', t => {
  const f = modelFixture(); t.after(f.cleanup);
  const path = f.save(), model = f.fit(path);
  assert.throws(() => f.fit(path, 'dataset.json'), /overwrite/);
  const samples = f.rows(); samples.forEach(r => { if (r.split === 'train') object(r.targets).y = null; });
  assert.throws(() => f.fit(f.save(samples, 'empty.json'), 'empty-model.json'), /no eligible TRAIN/);
  const broken = readObject(join(f.root, 'model.json')); object(broken.training).inputs = {};
  const { artifact_sha256: _, ...payload } = broken; broken.artifact_sha256 = artifactIdentity(payload);
  writeFileSync(join(f.root, 'broken.json'), encode(broken)); assert.throws(() => predictRows(f.root, 'broken.json', []), /input bindings/);
  const tiny = f.rows(); tiny.forEach(r => { object(r.targets).y = float(number(object(r.targets).y) * 1e-250); });
  const tinyPath = f.save(tiny, 'tiny.json'); f.fit(tinyPath, 'tiny-model.json', { hyperparameters: { alpha: 0 } });
  assert.equal(number(object(object(object(evaluateModel(f.root, 'tiny-model.json', tinyPath).folds).test).within_case).mean_case_concordance), 1);
  writeFileSync(join(f.root, 'duplicate.json'), '{"schema":"duplicate",' + encode(model).slice(1));
  assert.throws(() => predictRows(f.root, 'duplicate.json', []), /duplicate JSON key/);
});

test('partial sums retain cancellation and use round-to-even', () => {
  assert.equal(fsum([1e100, 1, -1e100]), 1);
  assert.equal(fsum([1, 1e-16, 1e-16]), 1.0000000000000002);
  assert.throws(() => fsum([Number.MAX_VALUE, Number.MAX_VALUE]), /finite range/);
});

test('numeric model and all folds exactly match the constrained Hetzner Python reference', t => {
  const reference = readObject(fileURLToPath(new URL('./pcb_ml_baseline.fixture.json', import.meta.url)));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pcb-ml-reference-ts-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'evidence.json'); writeFileSync(source, reference.source_text as string);
  const input = object(reference.dataset), data = finalizeDataset(root, { dataset_id: input.dataset_id as string, task: input.task as string,
    feature_names: input.feature_names as string[], target_specs: { y: { type: 'regression', direction: 'max' } },
    rows: input.rows as Obj[], inputs: { [source]: sha256File(source) } });
  writeFileSync(join(root, 'dataset.json'), encode(data, true));
  const model = trainModel(root, 'dataset.json', { modelId: 'BASELINE', target: 'y', hyperparameters: { alpha: 0 }, output: 'model.json' });
  const report = evaluateModel(root, 'model.json', 'dataset.json');
  assert.ok(same({ normalization: model.normalization, parameters: model.parameters, constant_baseline: model.constant_baseline, folds: report.folds }, reference.expected));
});
