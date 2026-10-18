"""Small-model numerical and attribution boundaries; no CAD/router execution."""
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import pcb_ml_data as data
import pcb_ml_models as models


class PcbMlModelsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='pcb-ml-models-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.evidence = self.root / 'synthetic-numeric-evidence.json'
        self.evidence.write_text('{"scope":"synthetic numeric learning test; no PCB qualification"}\n')
        self.extractor = self.root / 'tools/synthetic_features.py'
        self.extractor.parent.mkdir()
        self.extractor.write_text('# Explicit synthetic feature implementation, never dynamically loaded.\n')
        self.contract = dict(extractor='explicit synthetic x/constant', version=1,
                             stage='pre-decision', configuration=dict(units='synthetic'),
                             implementation_sha256={'tools/synthetic_features.py': hashlib.sha256(self.extractor.read_bytes()).hexdigest()})

    def rows(self, binary=False):
        result = []
        for split, values in [('train', [-3, -2, -1, 0, 1, 2, 3]),
                              ('validation', [-2.5, 0.5, 2.5]), ('test', [-2, 1, 3])]:
            for index, x in enumerate(values):
                identity = split + '-' + str(index)
                result.append(dict(id=identity, family=split + '-FAMILY',
                    case_fingerprint=data.artifact_identity({'case': split}),
                    source_fingerprint=data.artifact_identity({'source': split}),
                    pose_fingerprint=data.artifact_identity({'pose': x}),
                    run_fingerprint=data.artifact_identity({'run': identity}), split=split,
                    features=dict(x=x, constant=7.0), targets=dict(y=int(x > 0) if binary else 2.0 * x + 5),
                    evidence_valid=True, status='passed', failure_class=None))
        return result

    def dataset(self, rows=None, *, filename='dataset.json', binary=False, names=None, metadata=None):
        table = data.finalize_dataset(self.root, dataset_id='synthetic-learning', task='synthetic',
            feature_names=names or ['x', 'constant'],
            target_specs=dict(y=dict(type='binary' if binary else 'regression', direction='max')),
            rows=self.rows(binary) if rows is None else rows,
            inputs={str(self.evidence): hashlib.sha256(self.evidence.read_bytes()).hexdigest()},
            metadata=dict(feature_contract=self.contract, **(metadata or {})))
        path = self.root / filename
        path.write_text(json.dumps(table, indent=2, allow_nan=False) + '\n')
        return path

    def fit(self, dataset=None, *, filename='model.json', **kwargs):
        return models.train_model(self.root, dataset or self.dataset(), model_id='synthetic-model',
                                  target='y', output=self.root / filename, **kwargs)

    def test_known_linear_learning_beats_mean_on_disjoint_family_holdout(self):
        dataset = self.dataset()
        fitted = self.fit(dataset, hyperparameters={'alpha': 0})
        report = models.evaluate_model(self.root, 'model.json', dataset)
        self.assertLess(report['folds']['test']['model']['mse'], 1e-20)
        self.assertGreater(report['folds']['test']['constant_baseline']['mse'], 1)
        self.assertEqual(fitted['training']['counts']['families'], 1)
        self.assertEqual(report['folds']['test']['counts']['families'], 1)
        self.assertEqual(report['folds']['test']['within_case']['mean_case_concordance'], 1)
        self.assertFalse(report['adopt_weights']); self.assertFalse(report['qualified'])
        self.assertNotIn('winner', report)

    def test_test_labels_and_extremes_do_not_fit_normalization_or_parameters(self):
        original = self.fit(self.dataset(filename='first.json'), filename='first-model.json')
        rows = self.rows()
        for row in rows:
            if row['split'] == 'test':
                row['features']['x'] *= 1000000
                row['targets']['y'] = -999999
        changed = self.fit(self.dataset(rows, filename='other.json'), filename='other-model.json')
        self.assertEqual(original['normalization'], changed['normalization'])
        self.assertEqual(original['parameters'], changed['parameters'])
        self.assertEqual(original['constant_baseline'], changed['constant_baseline'])
        self.assertNotEqual(original['training']['dataset_content_sha256'], changed['training']['dataset_content_sha256'])

    def test_predict_ignores_target_payload_but_rejects_schema_contract_and_numeric_drift(self):
        self.fit()
        request = dict(id='candidate', features=dict(x=2, constant=7), targets={'y': 'not read'})
        first = models.predict_rows(self.root, 'model.json', [request], feature_names=['x', 'constant'],
                                     feature_contract=self.contract, task='synthetic')
        request['targets'] = {'y': -9999999999999}
        self.assertEqual(first, models.predict_rows(self.root, 'model.json', [request],
            feature_names=['x', 'constant'], feature_contract=self.contract, task='synthetic'))
        self.assertEqual(first['provenance'], 'contract_matched')
        raw = models.predict_rows(self.root, 'model.json', [request])
        self.assertEqual(raw['provenance'], 'unknown_raw_feature_provenance')
        for options in [dict(feature_names=['constant', 'x']), dict(feature_contract={'version': 2}), dict(task='other')]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                models.predict_rows(self.root, 'model.json', [request], **options)
        for features in [dict(constant=7, x=2), dict(x=2), dict(x=2, constant=7, extra=4),
                         dict(x=True, constant=7), dict(x=float('nan'), constant=7), dict(x=float('inf'), constant=7)]:
            with self.subTest(features=features), self.assertRaises(ValueError):
                models.predict_rows(self.root, 'model.json', [dict(id='bad', features=features)])

    def test_artifact_dataset_and_actual_source_tamper_rejected(self):
        path = self.dataset(); fitted = self.fit(path)
        model = self.root / 'model.json'
        value = json.loads(model.read_text()); value['parameters']['coefficients'][0] += 1
        model.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'checksum'):
            models.predict_rows(self.root, model, [])
        model.write_text(json.dumps(fitted))
        original = self.evidence.read_text(); self.evidence.write_text(original + ' ')
        with self.assertRaisesRegex(ValueError, 'source artifact changed'):
            models.train_model(self.root, path, model_id='invalid-new-fit', target='y')
        # Historical labels need not be available/current for frozen weights.
        self.assertEqual(models.predict_rows(self.root, model, [])['rows'], [])
        self.evidence.write_text(original)
        table = json.loads(path.read_text()); table['rows'][0]['targets']['y'] += 2
        path.write_text(json.dumps(table))
        with self.assertRaises(ValueError):
            models.train_model(self.root, path, model_id='changed', target='y')
        self.assertEqual(models.predict_rows(self.root, model, [])['rows'], [])
        self.extractor.write_text(self.extractor.read_text() + '# extractor changed\n')
        with self.assertRaisesRegex(ValueError, 'input changed'):
            models.predict_rows(self.root, model, [])

    def test_train_missing_labels_and_features_are_explicit_never_zero_filled(self):
        rows = self.rows()
        rows[0]['features']['x'] = None; rows[1]['targets']['y'] = None
        for row in rows:
            if row['split'] == 'test':
                row['targets']['y'] = None
                row['status'] = 'timeout'; row['failure_class'] = 'timeout'
                row['censoring'] = 'completion unknown; elapsed only time-to-outcome'
        path = self.dataset(rows); fitted = self.fit(path)
        self.assertEqual(fitted['training']['counts']['rows'], 5)
        self.assertEqual(fitted['training']['folds']['train']['rows'], 7)
        report = models.evaluate_model(self.root, 'model.json', path)
        heldout = report['folds']['test']
        self.assertEqual(heldout['model']['status'], 'unknown')
        self.assertIsNone(heldout['model']['mse'])
        self.assertEqual(heldout['actual_outcomes']['failure_class_counts'], {'timeout': 3})
        self.assertFalse(heldout['within_case']['selected_outcome_complete'])
        self.assertIsNone(heldout['within_case']['selected_observed_target_sum'])
        predicted = models.predict_rows(self.root, 'model.json', [dict(id='missing', features=dict(x=None, constant=7))])
        self.assertIsNone(predicted['rows'][0]['prediction'])
        self.assertEqual(predicted['rows'][0]['status'], 'unknown')

    def test_empty_training_rejected_empty_folds_and_single_class_supported(self):
        rows = [r for r in self.rows(binary=True) if r['split'] == 'train']
        for row in rows:
            row['targets']['y'] = 0
        path = self.dataset(rows, binary=True); self.fit(path)
        report = models.evaluate_model(self.root, 'model.json', path)
        self.assertEqual(report['folds']['train']['model']['brier'], 0)
        self.assertTrue(math.isfinite(report['folds']['train']['model']['logloss']))
        self.assertEqual(report['folds']['test']['model']['status'], 'unknown')
        no_train = self.dataset([r for r in self.rows() if r['split'] != 'train'], filename='no-train.json')
        with self.assertRaisesRegex(ValueError, 'no eligible TRAIN'):
            models.train_model(self.root, no_train, model_id='empty', target='y')

    def test_binary_rare_labels_clipped_scores_and_mean_baseline_metrics(self):
        rows = self.rows(binary=True)
        for row in rows:
            if row['split'] == 'train':
                row['targets']['y'] = int(row['id'] == 'train-6')
        path = self.dataset(rows, binary=True); self.fit(path, hyperparameters={'alpha': 0})
        report = models.evaluate_model(self.root, 'model.json', path)
        self.assertTrue(math.isfinite(report['folds']['test']['model']['brier']))
        self.assertTrue(math.isfinite(report['folds']['test']['model']['logloss']))
        prediction = models.predict_rows(self.root, 'model.json', [dict(id='outside', features=dict(x=100, constant=7))])
        self.assertTrue(0 <= prediction['rows'][0]['prediction'] <= 1)
        self.assertFalse(prediction['calibrated_probability'])

    def test_repetitions_are_balanced_within_case_and_cannot_hide_unknown_selected_label(self):
        rows = self.rows()
        repeat = copy.deepcopy(rows[0]); repeat['id'] = 'repeat'; repeat['run_fingerprint'] = data.artifact_identity({'run': 'repeat'})
        path = self.dataset(rows, filename='normal.json'); original = self.fit(path, filename='normal-model.json')
        repeated_path = self.dataset(rows + [repeat], filename='repeated.json')
        repeated = self.fit(repeated_path, filename='repeated-model.json')
        self.assertEqual(original['parameters'], repeated['parameters'])
        self.assertEqual(repeated['training']['counts']['repeated_known_pose_runs'], 1)
        self.assertEqual(repeated['training']['counts']['cases'], 1)
        report = models.evaluate_model(self.root, 'repeated-model.json', repeated_path)
        self.assertEqual(report['folds']['train']['model']['cases'], 1)
        rows = self.rows(); selected = max((r for r in rows if r['split'] == 'test'), key=lambda r: r['features']['x'])
        selected['targets']['y'] = None; selected['status'] = 'timeout'; selected['failure_class'] = 'timeout'
        changed = self.dataset(rows, filename='unknown-selected.json'); self.fit(changed, filename='unknown-model.json')
        ranking = models.evaluate_model(self.root, 'unknown-model.json', changed)['folds']['test']['within_case']
        self.assertEqual(ranking['selected_unknown_label_runs'], 1)
        self.assertEqual(ranking['selected_actual_outcomes']['failure_class_counts'], {'timeout': 1})
        self.assertIsNone(ranking['selected_observed_target_sum'])

    def test_singular_and_constant_columns_deterministic_reproducible_registry(self):
        rows = self.rows()
        for row in rows:
            row['features'] = dict(x=row['features']['x'], duplicate=row['features']['x'], constant=7)
        path = self.dataset(rows, names=['x', 'duplicate', 'constant'])
        first = self.fit(path, filename='first.json', hyperparameters={'alpha': 0})
        second = self.fit(path, filename='second.json', hyperparameters={'alpha': 0})
        self.assertEqual(first, second)
        self.assertEqual((self.root / 'first.json').read_bytes(), (self.root / 'second.json').read_bytes())
        self.assertEqual(first['parameters']['numerical_rank'], 1)
        self.assertLess(models.evaluate_model(self.root, 'first.json', path)['folds']['test']['model']['mse'], 1e-20)
        mean = self.fit(path, filename='mean.json', algorithm='mean')
        self.assertEqual(mean['algorithm']['name'], 'constant_mean')
        self.assertEqual(set(models.algorithms()), {'constant_mean', 'ridge'})
        for options in [dict(algorithm='path/to/code.py'), dict(hyperparameters={'eval': '1+1'}),
                        dict(hyperparameters={'alpha': True}), dict(hyperparameters={'alpha': -1}),
                        dict(hyperparameters={'alpha': float('nan')})]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                models.train_model(self.root, path, model_id='invalid', target='y', **options)

    def test_family_case_source_leakage_and_validation_relabel_are_rejected(self):
        for field in ('family', 'case_fingerprint', 'source_fingerprint'):
            rows = self.rows(); rows[-1][field] = rows[0][field]
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.dataset(rows, filename=field + '.json')
        path = self.dataset(); self.fit(path)
        changed = self.rows()
        for row in changed:
            if row['split'] == 'validation':
                row['split'] = 'test'
        relabelled = self.dataset(changed, filename='relabelled.json')
        with self.assertRaisesRegex(ValueError, 'relabels'):
            models.evaluate_model(self.root, 'model.json', relabelled)

    def test_proxy_ranking_explicit_direction_and_unknowns(self):
        rows = self.rows(binary=True)
        for row in rows:
            row['features'] = dict(x=row['features']['x'], constant=7, proxy=-row['features']['x'])
        path = self.dataset(rows, binary=True, names=['x', 'constant', 'proxy'],
                            metadata={'proxy_baseline': dict(feature='proxy', direction='min')})
        self.fit(path)
        report = models.evaluate_model(self.root, 'model.json', path)
        proxy = report['folds']['test']['existing_proxy_baseline']
        self.assertEqual(proxy['within_case']['mean_case_concordance'], 1)
        self.assertNotIn('mse', proxy)

    def test_dependencies_bind_exact_evidence_dataset_model_and_sources(self):
        path = self.dataset(); self.fit(path)
        files = models.dependency_files(self.root, 'model.json', path)
        for filename in (self.evidence, path, self.root / 'model.json', Path(models.__file__).resolve(), Path(data.__file__).resolve()):
            self.assertEqual(files[str(filename)], hashlib.sha256(filename.read_bytes()).hexdigest())
        with self.assertRaisesRegex(ValueError, 'overwrite'):
            models.train_model(self.root, path, model_id='overwrite', target='y', output=path)

    def test_missing_provenance_and_ambiguous_model_json_are_rejected(self):
        self.fit(); path = self.root / 'model.json'; original = json.loads(path.read_text())
        for mutate in (lambda v: v['training']['inputs'].clear(),
                       lambda v: v['training'].pop('dataset_path'),
                       lambda v: v.pop('constant_baseline')):
            value = copy.deepcopy(original); mutate(value)
            value['artifact_sha256'] = data.artifact_identity({k: v for k, v in value.items() if k != 'artifact_sha256'})
            path.write_text(json.dumps(value))
            with self.assertRaises(ValueError):
                models.predict_rows(self.root, path, [])
        path.write_text('{"schema":"duplicate",' + json.dumps(original)[1:])
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            models.predict_rows(self.root, path, [])

    def test_ranking_tiny_finite_labels_do_not_underflow_into_ties(self):
        rows = self.rows()
        for row in rows:
            row['targets']['y'] *= 1e-250
        path = self.dataset(rows); self.fit(path, hyperparameters={'alpha': 0})
        report = models.evaluate_model(self.root, 'model.json', path)
        self.assertEqual(report['folds']['test']['within_case']['mean_case_concordance'], 1)

    def test_deploy_fresh_checkout_without_original_labels_and_reject_changed_extractor(self):
        dataset = self.dataset(); fitted = self.fit(dataset)
        deployment = self.root / 'deployment'; (deployment / 'tools').mkdir(parents=True)
        for module in (models, data):
            shutil.copyfile(module.__file__, deployment / 'tools' / Path(module.__file__).name)
        shutil.copyfile(self.extractor, deployment / 'tools/synthetic_features.py')
        shutil.copyfile(self.root / 'model.json', deployment / 'model.json')
        feature_source = deployment / 'candidate-source.json'
        feature_source.write_text('{"x":2,"constant":7,"scope":"fresh synthetic predecision input"}')
        packet = dict(task='synthetic', feature_names=['x', 'constant'], feature_contract=self.contract,
                      rows=[dict(id='fresh-candidate', features=dict(x=2, constant=7))],
                      inputs={'candidate-source.json': hashlib.sha256(feature_source.read_bytes()).hexdigest()})
        packet['content_sha256'] = data.artifact_identity(packet)
        (deployment / 'features.json').write_text(json.dumps(packet))
        dataset.unlink(); self.evidence.unlink()
        script = '''import json
from pathlib import Path
import pcb_ml_data as data
import pcb_ml_models as models
p=json.loads(Path('features.json').read_text())
assert p['content_sha256']==data.artifact_identity({k:v for k,v in p.items() if k!='content_sha256'})
data.assert_unchanged(Path('.'),p['inputs'])
r=models.predict_rows(Path('.'),'model.json',p['rows'],feature_names=p['feature_names'],feature_contract=p['feature_contract'],task=p['task'])
print(json.dumps(r))
'''
        environment = {**os.environ, 'PYTHONPATH': str(deployment / 'tools'), 'PYTHONDONTWRITEBYTECODE': '1'}
        result = subprocess.run([sys.executable, '-c', script], cwd=deployment, env=environment,
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        prediction = json.loads(result.stdout)
        self.assertIsNotNone(prediction['rows'][0]['prediction'])
        self.assertEqual(prediction['model_sha256'], fitted['artifact_sha256'])
        self.assertNotIn(str(self.evidence), prediction['inputs'])
        self.assertNotIn(str(dataset), prediction['inputs'])
        copied_extractor = deployment / 'tools/synthetic_features.py'
        copied_extractor.write_text(copied_extractor.read_text() + '# changed extractor\n')
        rejected = subprocess.run([sys.executable, '-c', script], cwd=deployment, env=environment,
                                  text=True, capture_output=True, timeout=10)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn('model input changed', rejected.stderr)

    def test_optional_unknown_diagnostics_do_not_crash_or_infer_outcomes(self):
        rows = self.rows()
        heldout = [r for r in rows if r['split'] == 'test']
        for row, diagnostic in zip(heldout, [None, ['not a diagnostic object'], 'unknown']):
            row.pop('status'); row.pop('failure_class')
            row['observation'] = diagnostic
        path = self.dataset(rows); self.fit(path)
        report = models.evaluate_model(self.root, 'model.json', path)
        actual = report['folds']['test']['actual_outcomes']
        self.assertEqual(actual['status_counts'], {'unknown': 3})
        self.assertEqual(actual['failure_class_counts'], {'unknown': 3})
        self.assertEqual(report['folds']['test']['model']['observations'], 3)


if __name__ == '__main__':
    unittest.main()
