#!/usr/bin/env python3
"""Supervised advisory ML artifacts; no native writers or automatic adoption."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile

import pcb_ml_data as data
import pcb_ml_models as models


SCHEMA = 'iot-lab.pcb-ml-result.v1'
ACTIONS = ('dataset', 'features', 'train', 'evaluate', 'predict',
           'engine-train', 'engine-evaluate', 'engine-export', 'engine-dataset', 'engine-public-corpus')
_SHA = re.compile(r'[a-f0-9]{64}\Z')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


def arguments(values):
    parser = Parser(description=__doc__)
    parser.add_argument('action', choices=ACTIONS)
    parser.add_argument('id')
    for name in ('manifest', 'dataset', 'model', 'features', 'target'):
        parser.add_argument('--' + name)
    parser.add_argument('--algorithm', choices=('mean', 'ridge'))
    parser.add_argument('--regularization', type=float)
    parser.add_argument('--epochs', type=int)
    parser.add_argument('--device', choices=('auto', 'cpu', 'mps'))
    parser.add_argument('--precision', choices=('float16', 'float32'))
    parser.add_argument('--root', type=Path, default=Path(os.environ.get('IOT_LAB', Path(__file__).resolve().parent.parent)))
    parser.add_argument('--output', type=Path)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(values)
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', args.id):
        raise ValueError('ML ID must be a plain identifier')
    required = {'dataset': {'manifest'}, 'features': {'manifest'}, 'train': {'dataset', 'target'},
                'evaluate': {'dataset', 'model'}, 'predict': {'model', 'features'},
                'engine-train': {'dataset', 'target'}, 'engine-evaluate': {'dataset', 'model'},
                'engine-export': {'model'}, 'engine-dataset': {'manifest'},
                'engine-public-corpus': {'manifest'}}[args.action]
    allowed = required | {'train': {'algorithm', 'regularization'},
                          'engine-train': {'epochs', 'device'},
                          'engine-export': {'precision'}}.get(args.action, set())
    supplied = {name for name in ('manifest', 'dataset', 'model', 'features', 'target', 'algorithm', 'regularization',
                                 'epochs', 'device', 'precision')
                if getattr(args, name) is not None}
    if required - supplied:
        raise ValueError(args.action + ' requires ' + ', '.join('--' + name for name in sorted(required - supplied)))
    if supplied - allowed:
        raise ValueError(args.action + ' does not accept ' + ', '.join('--' + name for name in sorted(supplied - allowed)))
    if args.algorithm == 'mean' and args.regularization is not None:
        raise ValueError('mean does not accept ridge regularization')
    return args


def read(path):
    value = json.loads(Path(path).read_text(), object_pairs_hook=data._object, parse_constant=data._constant)
    if not isinstance(value, dict):
        raise ValueError('ML source must be a JSON object: ' + str(path))
    return value


def _implementation():
    paths = [Path(__file__).resolve(), Path(data.__file__).resolve(), Path(models.__file__).resolve()]
    adapter = Path(__file__).resolve().with_name('pcb_ml_adapters.py')
    if adapter.is_file():
        paths.append(adapter)
    engine = Path(__file__).resolve().parent / 'pcb_engine' / 'ml.py'
    if engine.is_file():
        paths.append(engine)
        paths.append(engine.with_name('learning.py'))
    return {str(path): sha(path) for path in paths}


def dependencies(root, values):
    """Bind declared current sources without fitting or revalidating outcome labels.

    Historical model training paths are lineage, not an inference dependency.
    Current model implementation compatibility is checked by the model loader.
    """
    root = Path(root).resolve()
    args = arguments(values)
    found, visited = {}, set()

    def contract_files(value):
        metadata = value.get('metadata', {})
        if not isinstance(metadata, dict):
            raise ValueError('ML source metadata must be an object')
        contract = value.get('feature_contract', metadata.get('feature_contract'))
        if not isinstance(contract, dict):
            return
        implementations = contract.get('implementation_sha256', {})
        if not isinstance(implementations, dict):
            raise ValueError('feature contract implementations must be a file/hash mapping')
        for name, digest in implementations.items():
            path = Path(name)
            if (not isinstance(name, str) or path.is_absolute() or '..' in path.parts
                    or not name.startswith('tools/') or not isinstance(digest, str) or not _SHA.fullmatch(digest)):
                raise ValueError('invalid logical feature implementation binding')
            bind(name, inventory=False)

    def bind(name, inventory=True):
        path = (root / name).absolute()
        key = str(path)
        if key in visited:
            return
        visited.add(key)
        if not path.is_file():
            found[key] = None
            return
        found[key] = sha(path)
        if inventory:
            value = read(path)
            contract_files(value)
            declared = value.get('inputs', {})
            if not isinstance(declared, dict):
                raise ValueError('ML source inputs must be a file/hash mapping')
            for nested, digest in declared.items():
                if not isinstance(nested, str) or not isinstance(digest, str) or not _SHA.fullmatch(digest):
                    raise ValueError('invalid ML source input binding')
                # The map is already the producer's full closure. Native files,
                # logs and binaries can be members; do not reinterpret their bytes.
                bind(nested, inventory=False)

    if args.action == 'engine-public-corpus':
        bind(args.manifest, inventory=False)
    elif args.action == 'engine-dataset':
        from pcb_engine.learning import dependencies as engine_dependencies
        found.update(engine_dependencies(root, args.manifest))
    elif args.action in ('dataset', 'features'):
        bind(args.manifest, inventory=False)
        path = (root / args.manifest).absolute()
        if path.is_file():
            from pcb_ml_adapters import manifest_dependencies
            declared = manifest_dependencies(root, path)
            if not isinstance(declared, dict):
                raise ValueError('ML manifest dependencies must be a file/hash mapping')
            for name, digest in declared.items():
                if not isinstance(name, str) or not Path(name).is_absolute() or (digest is not None
                        and (not isinstance(digest, str) or not _SHA.fullmatch(digest))):
                    raise ValueError('invalid ML manifest dependency')
                bind(name, inventory=False)
    else:
        if args.dataset:
            bind(args.dataset)
        if args.model:
            bind(args.model, inventory=False)
            model_path = root / args.model
            if model_path.is_file():
                contract_files(read(model_path))
        if args.features:
            bind(args.features)
    return dict(sorted(found.items()))


def _write(path, value, protected):
    path = Path(path).absolute()
    if path.resolve() in {Path(name).resolve() for name in protected}:
        raise ValueError('output would overwrite a consumed input: ' + str(path))
    if path.exists() or path.is_symlink():
        raise ValueError('output already exists: ' + str(path))
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + '\n'
    handle, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(handle, 'w') as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        # Linking publishes complete bytes atomically and refuses replacement.
        os.link(temporary, path)
    except FileExistsError as error:
        raise ValueError('output already exists: ' + str(path)) from error
    finally:
        Path(temporary).unlink(missing_ok=True)


def _current(inputs):
    for name, digest in inputs.items():
        path = Path(name)
        if digest is None:
            if path.exists() or path.is_symlink():
                raise ValueError('previously absent ML source appeared: ' + name)
        elif not path.is_file() or sha(path) != digest:
            raise ValueError('ML source changed while producing artifacts: ' + name)


def execute(root, values, output):
    """Return/write one receipt; every durable payload belongs beside output."""
    root = Path(root).resolve()
    output = Path(output).absolute() if output is not None else None
    inputs = _implementation()
    tool_inputs = {str(Path(sys.executable).resolve()): sha(Path(sys.executable).resolve())}
    report = dict(schema=SCHEMA, action=values[0] if values else None,
                  id=values[1] if len(values) > 1 else None, status='blocked',
                  scope='advisory_ml_observation', qualified=False, adopt_model=False,
                  inputs={}, tool_inputs=tool_inputs, absent_inputs=[], artifacts={})
    protected = set(inputs) | set(tool_inputs)
    artifact, artifact_admitted = None, False
    try:
        args = arguments(values)
        if output is None:
            raise ValueError('--output is required for durable ML artifacts')
        for name in ('manifest', 'dataset', 'model', 'features'):
            if getattr(args, name):
                protected.add(str((root / getattr(args, name)).resolve()))
        for name, digest in dependencies(root, values).items():
            if name in inputs and inputs[name] != digest:
                raise ValueError('ML implementation changed during admission: ' + name)
            inputs[name] = digest
        protected.update(inputs)
        if output.resolve() in {Path(name).resolve() for name in protected}:
            raise ValueError('receipt output would overwrite a consumed input')
        missing = [name for name, digest in inputs.items() if digest is None]
        # A dataset adapter retains missing/corrupt historical attempts as
        # ineligible rows. Preserve that diagnostic artifact before blocking.
        direct = [str((root / getattr(args, name)).absolute()) for name in
                  ('manifest', 'dataset', 'model', 'features') if getattr(args, name)]
        if missing and (args.action != 'dataset' or any(name in missing for name in direct)):
            raise ValueError('requested ML source is missing: ' + missing[0])
        artifact = output.parent / {'dataset':'dataset.json', 'features':'features.json',
                                   'train':'model.json', 'evaluate':'evaluation.json',
                                   'predict':'predictions.json', 'engine-train':'model.json',
                                   'engine-evaluate':'evaluation.json',
                                   'engine-export':'export.json', 'engine-dataset':'dataset.json',
                                   'engine-public-corpus':'public-corpus.json'}[args.action]
        if (artifact.resolve() == output.resolve() or artifact.resolve() in
                {Path(name).resolve() for name in protected} or artifact.exists() or artifact.is_symlink()):
            raise ValueError('artifact output would overwrite an input or existing artifact')
        artifact_admitted = True
        print('ML ' + args.action + ' ' + args.id + ': started', file=sys.stderr, flush=True)
        if args.action in ('dataset', 'features'):
            from pcb_ml_adapters import build_dataset, make_feature_packet
            builder = build_dataset if args.action == 'dataset' else make_feature_packet
            keyword = {'dataset_id' if args.action == 'dataset' else 'packet_id': args.id}
            payload = builder(root, root / args.manifest, **keyword)
            _write(artifact, payload, protected)
        elif args.action == 'train':
            options = {} if args.regularization is None else {'alpha': args.regularization}
            payload = models.train_model(root, args.dataset, model_id=args.id, target=args.target,
                algorithm=args.algorithm or 'ridge', hyperparameters=options, output=artifact)
        elif args.action == 'evaluate':
            payload = models.evaluate_model(root, args.model, args.dataset, output=artifact)
        elif args.action.startswith('engine-'):
            from pcb_engine import ml as engine
            if args.action == 'engine-public-corpus':
                from pcb_engine.learning import ingest_public_corpus
                payload = ingest_public_corpus(root / args.manifest, output.parent / 'public-corpus')
                _write(artifact, payload, protected)
                for member in sorted((output.parent / 'public-corpus').rglob('*')):
                    if member.is_file():
                        report['artifacts'][str(member)] = sha(member)
            elif args.action == 'engine-dataset':
                from pcb_engine.learning import build_dataset
                payload = build_dataset(root, args.manifest, dataset_id=args.id)
                _write(artifact, payload, protected)
            elif args.action == 'engine-train':
                payload = engine.train(root, args.dataset, model_id=args.id, target=args.target,
                    epochs=args.epochs if args.epochs is not None else 200,
                    device=args.device or 'auto', output=artifact)
            elif args.action == 'engine-evaluate':
                payload = engine.evaluate(root, root / args.model, args.dataset, output=artifact)
            else:
                package = output.parent / 'ranker.mlpackage'
                payload = engine.export_coreml(root, root / args.model, package,
                                               precision=args.precision or 'float16')
                _write(artifact, payload, protected)
                for member in sorted(package.rglob('*')):
                    if member.is_file():
                        report['artifacts'][str(member)] = sha(member)
                registry = package.with_suffix('.registry.json')
                report['artifacts'][str(registry)] = sha(registry)
        else:
            from pcb_ml_adapters import load_feature_packet
            packet = load_feature_packet(root, root / args.features)
            eligible = [row for row in packet['rows'] if row['eligibility']['features'] is True]
            payload = models.predict_rows(root, args.model, eligible, feature_names=packet['feature_names'],
                                          feature_contract=packet['feature_contract'], task=packet['task'])
            predictions = {row['id']: row for row in payload['rows']}
            payload['rows'] = [predictions[row['id']] if row['id'] in predictions else
                dict(id=row['id'], prediction=None, status='unknown', reasons=row['eligibility']['reasons'])
                for row in packet['rows']]
            payload['prediction_id'] = args.id
            payload['adopt_model'] = False
            payload['feature_packet'] = dict(path=str((root / args.features).resolve()), content_sha256=packet['content_sha256'])
            payload['inputs'] = {name: digest for name, digest in inputs.items() if digest is not None}
            payload['content_sha256'] = data.artifact_identity(payload)
            _write(artifact, payload, protected)
        report['artifacts'][str(artifact)] = sha(artifact)
        for name, digest in payload.get('inputs', {}).items():
            path = str((root / name).resolve())
            if path in inputs and inputs[path] != digest:
                raise ValueError('artifact reported a changed ML input: ' + name)
            inputs[path] = digest
        _current(inputs)
        _current(tool_inputs)
        if missing:
            raise ValueError('declared historical ML source is missing; ineligible rows retained: ' + missing[0])
        if args.action in ('evaluate', 'engine-evaluate'):
            missing = [split for split in ('validation', 'test')
                       if not payload['folds'][split]['counts']['target_eligible']]
            if missing:
                raise ValueError('evaluation has no eligible ' + '/'.join(missing).upper() + ' target rows; descriptive metrics retained')
            report['interpretation'] = 'Computed disjoint-fold observations; sample count does not establish statistical generalization or a model winner.'
        if args.action == 'predict' and not any(row['status'] == 'predicted' for row in payload['rows']):
            raise ValueError('no eligible feature rows produced a finite prediction; unknown rows retained')
        report.update(status='passed', cause=args.action + ' artifact produced; advisory only')
    except (OSError, ValueError, KeyError, TypeError, ImportError) as error:
        report.update(status='blocked', cause=str(error))
    except Exception as error:
        report.update(status='failed', cause=type(error).__name__ + ': ' + str(error))
    report['inputs'] = {name: digest for name, digest in inputs.items() if digest is not None}
    report['absent_inputs'] = sorted(name for name, digest in inputs.items() if digest is None)
    if artifact_admitted and artifact.is_file() and not artifact.is_symlink():
        report['artifacts'][str(artifact)] = sha(artifact)
    if output is not None:
        _write(output, report, protected)
    return report


def main(values=None):
    values = list(sys.argv[1:] if values is None else values)
    try:
        args = arguments(values)
        report = execute(args.root, values, args.output)
        summary = {key: report[key] for key in ('schema', 'action', 'id', 'status', 'qualified', 'adopt_model', 'cause')}
        summary['artifact_count'] = len(report['artifacts'])
        if args.output and args.output.is_file():
            summary['report'] = dict(path=str(args.output.absolute()), sha256=sha(args.output))
        if args.json:
            print(json.dumps(summary, allow_nan=False))
        else:
            print(('PASS' if report['status'] == 'passed' else 'STUCK') + ': ' + report['cause'])
        return {'passed': 0, 'blocked': 1, 'failed': 2}[report['status']]
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps(dict(schema=SCHEMA, status='blocked', cause=str(error), qualified=False, adopt_model=False)))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
