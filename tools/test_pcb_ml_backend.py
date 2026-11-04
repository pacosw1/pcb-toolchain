"""Real numeric core/model backend checks. Synthetic labels are not board evidence."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import pcb_ml
import pcb_ml_data as data
import pcb_ml_adapters as adapters
import pcb_ml_features as features
from pcb_evidence import evidence_files


class BackendTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='pcb-ml-backend-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.source = self.root / 'synthetic-numeric-source.json'
        self.source.write_text('{"scope":"synthetic numeric test only"}\n')

    def dataset(self, *, splits=('train', 'validation', 'test'), no_train_labels=False, name='dataset.json'):
        rows = []
        for split in splits:
            for index, value in enumerate((1., 2.)):
                identity = split + '-' + str(index)
                rows.append(dict(id=identity, family=split + '-synthetic-family', split=split,
                    case_fingerprint=data.artifact_identity('case-' + split),
                    source_fingerprint=data.artifact_identity('source-' + split),
                    pose_fingerprint=data.artifact_identity('pose-' + identity),
                    run_fingerprint=data.artifact_identity('run-' + identity),
                    features=dict(x=value), targets=dict(y=None if split == 'train' and no_train_labels else 3 * value),
                    evidence_valid=True, status='passed'))
        value = data.finalize_dataset(self.root, dataset_id='synthetic-fixture', task='synthetic-numeric',
            feature_names=['x'], target_specs=dict(y=dict(type='regression', direction='min', unit='synthetic')),
            rows=rows, inputs={str(self.source): pcb_ml.sha(self.source)},
            metadata=dict(feature_contract=dict(extractor='synthetic-reviewed-fixture', version=1)))
        path = self.root / name
        path.write_text(json.dumps(value) + '\n')
        return path

    def execute(self, *values, name=None):
        directory = self.root / (name or values[0] + '-operation')
        report = directory / 'report.json'
        result = pcb_ml.execute(self.root, list(values), report)
        self.assertEqual(json.loads(report.read_text()), result)
        self.assertFalse(result['qualified'])
        self.assertFalse(result['adopt_model'])
        for path, digest in result['artifacts'].items():
            self.assertTrue(Path(path).is_relative_to(directory))
            self.assertEqual(pcb_ml.sha(path), digest)
        return result

    def train(self, dataset=None, **options):
        result = self.execute('train', 'SYNTHETIC-MODEL', '--dataset', str(dataset or self.dataset()),
            '--target', 'y', '--algorithm', 'ridge', '--regularization', '0', **options)
        self.assertEqual(result['status'], 'passed', result)
        return Path(next(iter(result['artifacts'])))

    def workflow_fixture(self, *, unknown_feature=False):
        """Authored sealed protocol fixtures, not observations of real CAD work."""
        tools = Path(pcb_ml.__file__).resolve().parent
        for name in features.IMPLEMENTATIONS:
            target = self.root / 'tools' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(tools / name, target)
        trials = []
        for split in ('train','validation','test'):
            for index in range(2):
                folder = self.root / 'observations' / (split + '-' + str(index))
                (folder/'operation').mkdir(parents=True)
                manifest = dict(operation='check', board=split.upper()+'-FIXTURE', project='cad/fixture',
                                timeout_s=10+index, run_id=folder.name, root='/synthetic-fixture-only')
                (folder/'run.json').write_text(json.dumps(manifest))
                (folder/'operation/result.json').write_text(json.dumps(dict(status='passed',scope='fixture')))
                terminal = dict(status='passed', cleanup=dict(complete=True), elapsed_s=2+index,
                                evidence_sha256=evidence_files(folder))
                (folder/'result.json').write_text(json.dumps(terminal))
                trials.append(dict(id=folder.name,path=str(folder),sha256=pcb_ml.sha(folder/'result.json'),
                                   family=split.upper()+'-FIXTURE',split=split))
        corpus = self.root/'corpus.json'
        corpus.write_text(json.dumps(dict(schema=adapters.CORPUS,adapter='workflow',dataset_id='fixture',trials=trials)))
        source = self.root/'future-run-manifest.json'
        source.write_text(json.dumps(dict(operation='check',board='FUTURE-FIXTURE',project='cad/fixture',
                                         timeout_s=None if unknown_feature else 12)))
        request = self.root/'feature-request.json'
        request.write_text(json.dumps(dict(schema=adapters.REQUEST,adapter='workflow',id='future-request',
            samples=[dict(id='future',source=dict(path=str(source),sha256=pcb_ml.sha(source)))])))
        return corpus, request

    def workflow_model(self, *, unknown_feature=False):
        corpus, request = self.workflow_fixture(unknown_feature=unknown_feature)
        dataset_result = self.execute('dataset','WORKFLOW','--manifest',str(corpus))
        self.assertEqual(dataset_result['status'],'passed',dataset_result)
        dataset = Path(next(iter(dataset_result['artifacts'])))
        model_result = self.execute('train','WORKFLOW-MODEL','--dataset',str(dataset),'--target','owned_elapsed_s')
        self.assertEqual(model_result['status'],'passed',model_result)
        model = Path(next(iter(model_result['artifacts'])))
        packet_result = self.execute('features','FUTURE','--manifest',str(request))
        self.assertEqual(packet_result['status'],'passed',packet_result)
        packet = Path(next(iter(packet_result['artifacts'])))
        return dataset,model,packet

    def test_real_train_and_disjoint_evaluation_preserve_artifacts_and_scope(self):
        dataset = self.dataset()
        model = self.train(dataset)
        result = self.execute('evaluate', 'SYNTHETIC-EVAL', '--dataset', str(dataset), '--model', str(model))
        self.assertEqual(result['status'], 'passed', result)
        artifact = json.loads(Path(next(iter(result['artifacts']))).read_text())
        self.assertEqual(artifact['folds']['test']['counts']['target_eligible'], 2)
        self.assertLess(artifact['folds']['test']['model']['mse'], 1e-20)
        self.assertIn('does not establish statistical generalization', result['interpretation'])
        self.assertIn(str(self.source), result['inputs'])

    def test_missing_validation_test_retains_descriptive_evaluation_but_blocks(self):
        dataset = self.dataset(splits=('train',))
        model = self.train(dataset)
        result = self.execute('evaluate','TRAIN-ONLY','--dataset',str(dataset),'--model',str(model))
        self.assertEqual(result['status'], 'blocked', result)
        self.assertIn('VALIDATION/TEST', result['cause'])
        artifact = json.loads(Path(next(iter(result['artifacts']))).read_text())
        self.assertEqual(artifact['folds']['train']['model']['status'], 'observed')
        self.assertEqual(artifact['folds']['test']['model']['status'], 'unknown')

    def test_missing_train_labels_cannot_create_a_model(self):
        dataset = self.dataset(no_train_labels=True)
        result = self.execute('train','UNFIT','--dataset',str(dataset),'--target','y')
        self.assertEqual(result['status'], 'blocked', result)
        self.assertIn('no eligible TRAIN', result['cause'])
        self.assertEqual(result['artifacts'], {})

    def test_static_dependencies_bind_current_dataset_sources_and_explicit_absence(self):
        dataset = self.dataset()
        found = pcb_ml.dependencies(self.root, ['train','M','--dataset',str(dataset),'--target','y'])
        self.assertEqual(found[str(dataset)], pcb_ml.sha(dataset))
        self.assertEqual(found[str(self.source)], pcb_ml.sha(self.source))
        missing = self.root / 'absent-dataset.json'
        self.assertEqual(pcb_ml.dependencies(self.root, ['train','M','--dataset',str(missing),'--target','y']),
                         {str(missing):None})
        result = self.execute('train','M','--dataset',str(missing),'--target','y')
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(result['absent_inputs'], [str(missing)])
        self.assertNotIn(str(missing), result['inputs'])

    def test_malformed_dependency_metadata_fails_with_a_named_schema_error(self):
        path = self.root/'malformed.json'
        path.write_text(json.dumps(dict(inputs={},metadata=None)))
        with self.assertRaisesRegex(ValueError,'metadata must be an object'):
            pcb_ml.dependencies(self.root,['train','BAD','--dataset',str(path),'--target','y'])

    def test_dataset_tamper_stale_source_and_invalid_numeric_parameters_are_blocked(self):
        dataset = self.dataset()
        changed = json.loads(dataset.read_text())
        changed['rows'][0]['targets']['y'] = 9999
        dataset.write_text(json.dumps(changed))
        result = self.execute('train','TAMPER','--dataset',str(dataset),'--target','y',name='tamper')
        self.assertEqual(result['status'], 'blocked')
        self.assertIn('identity mismatch', result['cause'])
        dataset = self.dataset()
        self.source.write_text('{}')
        result = self.execute('train','STALE','--dataset',str(dataset),'--target','y',name='stale')
        self.assertEqual(result['status'], 'blocked')
        self.assertIn('source artifact changed', result['cause'])
        dataset = self.dataset()
        result = self.execute('train','BAD-ALPHA','--dataset',str(dataset),'--target','y','--regularization','nan',name='bad-alpha')
        self.assertEqual(result['status'], 'blocked')
        self.assertIn('finite', result['cause'])

    def test_inference_dependencies_do_not_require_historical_training_paths(self):
        model = self.train()
        history = json.loads(model.read_text())['training']['inputs']
        for name in history:
            Path(name).unlink()
        packet = self.root / 'request.json'
        packet.write_text(json.dumps(dict(inputs={})))
        found = pcb_ml.dependencies(self.root,['predict','P','--model',str(model),'--features',str(packet)])
        self.assertEqual(set(found), {str(model),str(packet)})

    def test_outputs_never_overwrite_input_or_existing_payload(self):
        dataset = self.dataset()
        before = dataset.read_bytes()
        with self.assertRaisesRegex(ValueError,'overwrite a consumed input'):
            pcb_ml.execute(self.root,['train','M','--dataset',str(dataset),'--target','y'],dataset)
        self.assertEqual(dataset.read_bytes(), before)
        occupied = self.root/'occupied'
        occupied.mkdir()
        (occupied/'model.json').write_text('original output')
        result = self.execute('train','M','--dataset',str(dataset),'--target','y',name='occupied')
        self.assertEqual(result['status'],'blocked')
        self.assertEqual(result['artifacts'],{})
        self.assertEqual((occupied/'model.json').read_text(),'original output')

    def test_cli_stdout_is_one_compact_summary_and_original_report_remains_full(self):
        dataset = self.dataset()
        output = self.root/'cli-operation/report.json'
        command = [sys.executable,str(Path(pcb_ml.__file__).resolve()),'train','M','--dataset',str(dataset),
                   '--target','y','--root',str(self.root),'--output',str(output),'--json']
        response = subprocess.run(command,text=True,capture_output=True,timeout=10)
        self.assertEqual(response.returncode,0,response.stdout+response.stderr)
        self.assertEqual(len(response.stdout.splitlines()),1)
        summary = json.loads(response.stdout)
        self.assertNotIn('inputs',summary)
        self.assertNotIn('artifacts',summary)
        self.assertEqual(summary['report']['sha256'],pcb_ml.sha(output))
        self.assertIn('started',response.stderr)
        self.assertTrue(json.loads(output.read_text())['inputs'])

    def test_real_dataset_train_evaluate_features_predict_pipeline(self):
        dataset,model,packet = self.workflow_model()
        evaluation = self.execute('evaluate','WORKFLOW-EVAL','--dataset',str(dataset),'--model',str(model))
        self.assertEqual(evaluation['status'],'passed',evaluation)
        prediction = self.execute('predict','FUTURE-PREDICTION','--model',str(model),'--features',str(packet))
        self.assertEqual(prediction['status'],'passed',prediction)
        artifact = json.loads(Path(next(iter(prediction['artifacts']))).read_text())
        self.assertEqual(artifact['provenance'],'contract_matched')
        self.assertEqual(artifact['rows'][0]['status'],'predicted')
        self.assertFalse(artifact['qualified'])
        self.assertFalse(artifact['adopt_weights'])
        self.assertFalse(artifact['adopt_model'])
        self.assertEqual(set(path.name for path in (self.root/'dataset-operation').iterdir()),{'dataset.json','report.json'})
        self.assertEqual(set(path.name for path in (self.root/'predict-operation').iterdir()),{'predictions.json','report.json'})

    def test_feature_packet_targets_or_rehashed_arbitrary_values_cannot_enter_prediction(self):
        _,model,packet = self.workflow_model()
        original = json.loads(packet.read_text())
        for mode in ('targets','features'):
            changed = json.loads(json.dumps(original))
            if mode == 'targets':
                changed['rows'][0]['targets'] = dict(owned_elapsed_s=1)
            else:
                changed['rows'][0]['features']['budget_s'] = 9999
            changed['content_sha256'] = data.artifact_identity({key:value for key,value in changed.items() if key!='content_sha256'})
            packet.write_text(json.dumps(changed))
            result = self.execute('predict','UNTRUSTED','--model',str(model),'--features',str(packet),name=mode)
            self.assertEqual(result['status'],'blocked',result)
            self.assertEqual(result['artifacts'],{})
            self.assertIn('outcomes or undeclared' if mode=='targets' else 'original source extraction',result['cause'])

    def test_predict_with_unknown_predecision_feature_retains_unknown_without_scoring(self):
        _,model,packet = self.workflow_model(unknown_feature=True)
        result = self.execute('predict','UNKNOWN','--model',str(model),'--features',str(packet))
        self.assertEqual(result['status'],'blocked',result)
        artifact = json.loads(Path(next(iter(result['artifacts']))).read_text())
        self.assertEqual(artifact['rows'][0]['status'],'unknown')
        self.assertIsNone(artifact['rows'][0]['prediction'])
        self.assertTrue(artifact['rows'][0]['reasons'])

    def test_prediction_verifies_current_feature_sources_without_historical_training_tree(self):
        dataset,model,packet = self.workflow_model()
        shutil.rmtree(self.root/'observations')
        dataset.unlink()
        (self.root/'corpus.json').unlink()
        found = pcb_ml.dependencies(self.root,['predict','DEPLOY','--model',str(model),'--features',str(packet)])
        self.assertFalse(any('/observations/' in name for name in found))
        result = self.execute('predict','DEPLOY','--model',str(model),'--features',str(packet),name='deployed')
        self.assertEqual(result['status'],'passed',result)
        (self.root/'future-run-manifest.json').write_text('{}')
        result = self.execute('predict','STALE','--model',str(model),'--features',str(packet),name='stale-packet')
        self.assertEqual(result['status'],'blocked',result)
        self.assertIn('source artifact changed',result['cause'])

    def test_missing_historical_trial_is_retained_as_ineligible_in_dataset_artifact(self):
        corpus,_ = self.workflow_fixture()
        value = json.loads(corpus.read_text())
        missing = self.root/'lost-run'
        value['trials'].append(dict(id='lost',path=str(missing),sha256='a'*64,family='LOST',split='train'))
        corpus.write_text(json.dumps(value))
        result = self.execute('dataset','PARTIAL','--manifest',str(corpus))
        self.assertEqual(result['status'],'blocked',result)
        self.assertIn(str(missing/'run.json'),result['absent_inputs'])
        artifact = json.loads(Path(next(iter(result['artifacts']))).read_text())
        row = next(row for row in artifact['rows'] if row['id']=='lost')
        self.assertFalse(row['eligibility']['features'])
        self.assertIsNone(row['targets']['owned_elapsed_s'])


if __name__ == '__main__':
    unittest.main()
