#!/usr/bin/env python3
"""Transparent, deterministic advisory models for attributed numeric PCB data.

Algorithms are registered in this source file, never loaded from an artifact.
All transforms and the constant baseline use eligible TRAIN rows only. Ridge
binary outputs are clipped scores, not a claim of probability calibration.
"""
import collections
import hashlib
import json
import math
from pathlib import Path
import re
import sys


MODEL = 'iot-lab.pcb-ml-model.v1'
EVALUATION = 'iot-lab.pcb-ml-evaluation.v1'
PREDICTION = 'iot-lab.pcb-ml-prediction.v1'
SPLITS = ('train', 'validation', 'test')


def _encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
                      allow_nan=False).encode()


def _identity(value):
    return hashlib.sha256(_encoded(value)).hexdigest()


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _number(value, name):
    if not _finite(value):
        raise ValueError(name + ' must be a finite number (not bool)')
    return float(value)


def _source_inputs():
    import pcb_ml_data
    return {'tools/pcb_ml_models.py': _sha(Path(__file__).resolve()),
            'tools/pcb_ml_data.py': _sha(Path(pcb_ml_data.__file__).resolve())}


def _source_paths():
    import pcb_ml_data
    paths = (Path(__file__).resolve(), Path(pcb_ml_data.__file__).resolve(), Path(sys.executable).resolve())
    return {str(path): _sha(path) for path in paths}


def _contract_inputs(root, contract, names):
    if not isinstance(contract, dict):
        return {}
    if 'features' in contract and [v.get('name') for v in contract['features']] != names:
        raise ValueError('feature extractor columns/order differ from numeric schema')
    bindings = contract.get('implementation_sha256')
    if bindings is None:
        return {}
    if not isinstance(bindings, dict) or not bindings:
        raise ValueError('feature extractor needs logical implementation hashes')
    inputs = {}
    for name, digest in bindings.items():
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or not name.startswith('tools/'):
            raise ValueError('feature implementation bindings must be logical tools-relative paths')
        actual = _resolve(root, name)
        if not actual.is_relative_to(Path(root).resolve()):
            raise ValueError('feature implementation escapes its checkout')
        inputs[str(actual)] = digest
    _check_inputs(inputs)
    return inputs


def _validate_bindings(inputs):
    if not isinstance(inputs, dict) or not inputs:
        raise ValueError('input bindings must be a path-to-SHA256 mapping')
    for name, digest in inputs.items():
        path = Path(name)
        if not path.is_absolute() or not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest):
            raise ValueError('invalid absolute input binding: ' + str(name))
    return inputs


def _check_inputs(inputs):
    _validate_bindings(inputs)
    for name, digest in inputs.items():
        if not Path(name).is_file() or _sha(name) != digest:
            raise ValueError('model input changed or missing: ' + name)


def _resolve(root, path):
    return (Path(root).resolve() / path).resolve()


def _write(root, output, value, protected=()):
    if output is None:
        return
    path = _resolve(root, output)
    if path in {Path(p).resolve() for p in protected}:
        raise ValueError('output would overwrite a consumed input')
    payload = json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False, allow_nan=False) + '\n'
    if path.exists():
        if path.read_text() == payload:
            return
        raise ValueError('output already exists with different content: ' + str(path))
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x') as handle:
        handle.write(payload)


def _dataset(root, path):
    from pcb_ml_data import load_dataset
    data = load_dataset(root, path)
    names = data.get('feature_names')
    if (not isinstance(names, list) or not names or len(set(names)) != len(names)
            or any(not isinstance(n, str) or not n for n in names)):
        raise ValueError('dataset needs distinct ordered numeric feature names')
    if set(names) & set(data['target_specs']):
        raise ValueError('declared outcome targets cannot also be input features')
    # The loader performs this validation too; keep the model boundary explicit
    # so replacing the loader with a permissive adapter cannot mix holdouts.
    owners = {}
    seen_runs = set()
    for row in data['rows']:
        if row['split'] not in SPLITS:
            raise ValueError('unknown split')
        if list(row['features']) != names:
            raise ValueError('feature columns/order differ from dataset schema')
        for name, value in row['features'].items():
            if value is not None:
                _number(value, 'feature ' + name)
        for field in ('family', 'case_fingerprint', 'source_fingerprint', 'pose_fingerprint'):
            value = row.get(field)
            if value:
                key = (field, (row['case_fingerprint'], value) if field == 'pose_fingerprint' else value)
                if key in owners and owners[key] != row['split']:
                    raise ValueError(field + ' overlaps independent splits')
                owners[key] = row['split']
        run = row.get('run_fingerprint')
        if not run or (run in seen_runs and _usable(row)):
            raise ValueError('missing or reused eligible run identity')
        if _usable(row):
            seen_runs.add(run)
    return data


def _usable(row, target=None):
    eligibility = row.get('eligibility', {})
    if eligibility.get('features') is not True or any(v is None for v in row['features'].values()):
        return False
    return target is None or (eligibility.get('targets', {}).get(target) is True
                              and row.get('targets', {}).get(target) is not None)


def _pose(row):
    # Unknown poses are individual observations, never independent-case claims.
    return row.get('pose_fingerprint') or ('unknown:' + row['id'])


def _weights(rows):
    groups = collections.defaultdict(lambda: collections.Counter())
    for row in rows:
        groups[row['case_fingerprint']][_pose(row)] += 1
    return [1.0 / (len(groups[row['case_fingerprint']]) *
                   groups[row['case_fingerprint']][_pose(row)]) for row in rows]


def _average(values, weights=None):
    if not values:
        return None
    weights = weights or [1.0] * len(values)
    scale = max(abs(v) for v in values) or 1.0
    result = math.fsum((value / scale) * weight for value, weight in zip(values, weights)) / math.fsum(weights) * scale
    return _number(result, 'derived average')


def _normalization(rows, names, weights):
    result = []
    for name in names:
        values = [row['features'][name] for row in rows]
        magnitude = max(abs(v) for v in values) or 1.0
        scaled = [v / magnitude for v in values]
        center = _average(scaled, weights)
        spread = math.sqrt(math.fsum(w * (v - center) ** 2 for v, w in zip(scaled, weights)) / math.fsum(weights))
        constant = max(values) == min(values)
        result.append(dict(feature=name, magnitude=magnitude, center_scaled=center,
                           scale_scaled=spread if spread else 1.0, constant=constant))
    return result


def _transform(features, normalization):
    return [(features[item['feature']] / item['magnitude'] - item['center_scaled']) / item['scale_scaled']
            if not item['constant'] else 0.0 for item in normalization]


def _solve(matrix, rhs):
    """Partial-pivot elimination; numerical rank uses machine precision only."""
    n = len(rhs)
    if not n:
        return [], 0
    rows = [list(a) + [b] for a, b in zip(matrix, rhs)]
    threshold = sys.float_info.epsilon * n * max(1.0, max(abs(v) for row in matrix for v in row))
    pivots = []
    for col in range(n):
        index = len(pivots)
        candidate = max(range(index, n), key=lambda i: abs(rows[i][col]))
        if abs(rows[candidate][col]) <= threshold:
            continue
        rows[index], rows[candidate] = rows[candidate], rows[index]
        pivot = rows[index][col]
        rows[index] = [v / pivot for v in rows[index]]
        for i in range(n):
            if i != index:
                factor = rows[i][col]
                rows[i] = [a - factor * b for a, b in zip(rows[i], rows[index])]
        pivots.append(col)
    solution = [0.0] * n
    for i, col in enumerate(pivots):
        solution[col] = _number(rows[i][-1], 'coefficient')
    return solution, len(pivots)


def _fit_mean(x, y, weights, parameters):
    return dict(value=_average(y, weights))


def _fit_ridge(x, y, weights, parameters):
    width = len(x[0]); total = math.fsum(weights)
    magnitude = max(abs(v) for v in y) or 1.0
    scaled = [v / magnitude for v in y]
    center = _average(scaled, weights)
    matrix = [[math.fsum(w * row[i] * row[j] for row, w in zip(x, weights)) / total
               + (parameters['alpha'] if i == j else 0.0) for j in range(width)] for i in range(width)]
    rhs = [math.fsum(w * row[i] * (value - center) for row, value, w in zip(x, scaled, weights)) / total
           for i in range(width)]
    coefficients, rank = _solve(matrix, rhs)
    return dict(coefficients=coefficients, intercept_scaled=center,
                target_magnitude=magnitude, numerical_rank=rank)


def _predict_mean(parameters, row):
    return parameters['value']


def _predict_ridge(parameters, row):
    return (parameters['intercept_scaled'] + math.fsum(a * b for a, b in zip(parameters['coefficients'], row))) * parameters['target_magnitude']


# Pluggable by reviewed source changes only. An artifact selects a registered
# name/version; it cannot supply a callable, import path, pickle or expression.
_REGISTRY = {
    'constant_mean': dict(version=1, fit=_fit_mean, predict=_predict_mean, defaults={}),
    'ridge': dict(version=1, fit=_fit_ridge, predict=_predict_ridge, defaults={'alpha': 1.0}),
}


def algorithms():
    return {name: dict(version=value['version'], default_hyperparameters=dict(value['defaults']))
            for name, value in _REGISTRY.items()}


def _algorithm(name, hyperparameters=None):
    name = 'constant_mean' if name == 'mean' else name
    if name not in _REGISTRY:
        raise ValueError('unknown registered algorithm: ' + str(name))
    algorithm = _REGISTRY[name]
    supplied = {} if hyperparameters is None else hyperparameters
    if not isinstance(supplied, dict) or set(supplied) - set(algorithm['defaults']):
        raise ValueError('unsupported algorithm hyperparameters')
    parameters = {**algorithm['defaults'], **supplied}
    if 'alpha' in parameters:
        parameters['alpha'] = _number(parameters['alpha'], 'alpha')
        if parameters['alpha'] < 0:
            raise ValueError('alpha must be nonnegative')
    return name, algorithm, parameters


def _counts(rows, target):
    poses = [(row['case_fingerprint'], row.get('pose_fingerprint')) for row in rows if row.get('pose_fingerprint')]
    return dict(rows=len(rows), feature_eligible=sum(_usable(r) for r in rows),
                target_eligible=sum(_usable(r, target) for r in rows),
                families=len({r['family'] for r in rows}),
                cases=len({r['case_fingerprint'] for r in rows}),
                distinct_known_poses=len(set(poses)), repeated_known_pose_runs=len(poses) - len(set(poses)),
                missing_pose_runs=sum(not r.get('pose_fingerprint') for r in rows),
                ineligibility_reasons=dict(collections.Counter(reason.get('code', 'unknown') if isinstance(reason, dict) else str(reason) for r in rows
                    for reason in r.get('eligibility', {}).get('reasons', []))))


def train_model(root, dataset_path, *, model_id, target, algorithm='ridge', hyperparameters=None, output=None):
    if not isinstance(model_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', model_id):
        raise ValueError('model_id must be a plain identifier')
    sources = _source_inputs()
    source_paths = _source_paths()
    path = _resolve(root, dataset_path)
    dataset_sha = _sha(path)
    data = _dataset(root, dataset_path)
    if target not in data['target_specs']:
        raise ValueError('unknown declared target')
    spec = data['target_specs'][target]
    if spec.get('type') not in ('binary', 'regression') or spec.get('direction') not in ('min', 'max'):
        raise ValueError('unsupported target type/direction')
    rows = [r for r in data['rows'] if r['split'] == 'train' and _usable(r, target)]
    if not rows:
        raise ValueError('no eligible TRAIN feature/target rows; model was not fitted')
    y = [_number(r['targets'][target], 'training target') for r in rows]
    if spec['type'] == 'binary' and any(value not in (0, 1) for value in y):
        raise ValueError('binary training labels must be 0 or 1')
    name, implementation, hyperparameters = _algorithm(algorithm, hyperparameters)
    weights = _weights(rows)
    normalization = _normalization(rows, data['feature_names'], weights)
    x = [_transform(r['features'], normalization) for r in rows]
    parameters = implementation['fit'](x, y, weights, hyperparameters)
    inputs = {str(_resolve(root, key)): value for key, value in data['inputs'].items()}
    inputs[str(path)] = dataset_sha
    _check_inputs(inputs)
    contract = data.get('metadata', {}).get('feature_contract')
    contract_inputs = _contract_inputs(root, contract, data['feature_names'])
    result = dict(schema=MODEL, model_id=model_id, task=data['task'], target=target, target_spec=spec,
                  feature_names=data['feature_names'], feature_contract=contract,
                  feature_contract_sha256=_identity(contract),
                  algorithm=dict(name=name, version=implementation['version'], hyperparameters=hyperparameters),
                  normalization=dict(method='TRAIN-only maxabs then weighted standardization; no imputation', columns=normalization),
                  parameters=parameters, constant_baseline=dict(value=_average(y, weights)),
                  training=dict(dataset_id=data['dataset_id'], dataset_path=str(path),
                      dataset_content_sha256=data['content_sha256'], inputs=inputs,
                      weighting='equal total weight per case, then per pose, then per repeated run',
                      rows=[dict(id=r['id'], family=r['family'], case_fingerprint=r['case_fingerprint'], source_fingerprint=r['source_fingerprint'],
                                 pose_fingerprint=r.get('pose_fingerprint'), run_fingerprint=r['run_fingerprint']) for r in rows],
                      split_groups={split: {field: sorted({r[field] for r in data['rows'] if r['split'] == split})
                          for field in ('family', 'case_fingerprint', 'source_fingerprint')} for split in SPLITS},
                      counts=_counts(rows, target), folds={split: _counts([r for r in data['rows'] if r['split'] == split], target) for split in SPLITS}),
                  source_inputs=sources, runtime=dict(python=sys.version, implementation=sys.implementation.name,
                      executable=str(Path(sys.executable).resolve()), executable_sha256=_sha(Path(sys.executable).resolve())),
                  advisory=True, calibrated_probability=False, qualified=False, adopt_weights=False,
                  unknowns=[] if contract is not None else ['feature extractor contract is absent; schema alone cannot certify future packet provenance'])
    _check_inputs({**source_paths, **contract_inputs})
    result['artifact_sha256'] = _identity(result)
    _write(root, output, result, protected=[*inputs, *source_paths, *contract_inputs])
    return result


def _unique_object(pairs):
    value = {}
    for name, item in pairs:
        if name in value:
            raise ValueError('duplicate model JSON key: ' + name)
        value[name] = item
    return value


def _model(root, path):
    model = json.loads(_resolve(root, path).read_text(), object_pairs_hook=_unique_object)
    if not isinstance(model, dict) or model.get('schema') != MODEL:
        raise ValueError('unsupported model artifact')
    digest = model.get('artifact_sha256')
    if digest != _identity({k: v for k, v in model.items() if k != 'artifact_sha256'}):
        raise ValueError('model artifact checksum mismatch')
    info = model.get('algorithm', {})
    name, implementation, hyperparameters = _algorithm(info.get('name'), info.get('hyperparameters'))
    if name != info['name'] or implementation['version'] != info.get('version') or hyperparameters != info['hyperparameters']:
        raise ValueError('unsupported model algorithm/version')
    if model.get('source_inputs') != _source_inputs():
        raise ValueError('model implementation inputs changed')
    training = model.get('training', {})
    # Historical training provenance is retained for audit. Deployment needs
    # model weights and compatible feature code, never the original labels,
    # original checkout paths or the original training Python binary.
    _validate_bindings(training.get('inputs'))
    if (training.get('dataset_path') not in training['inputs']
            or not isinstance(training.get('dataset_content_sha256'), str)
            or not re.fullmatch(r'[a-f0-9]{64}', training['dataset_content_sha256'])
            or not isinstance(training.get('rows'), list) or not training['rows']
            or set(training.get('split_groups', {})) != set(SPLITS)):
        raise ValueError('model training provenance is incomplete')
    for groups in training['split_groups'].values():
        if (not isinstance(groups, dict) or set(groups) != {'family', 'case_fingerprint', 'source_fingerprint'}
                or any(not isinstance(values, list) for values in groups.values())):
            raise ValueError('model split provenance is incomplete')
    if not _finite(model.get('constant_baseline', {}).get('value')):
        raise ValueError('model constant baseline is invalid')
    names = model.get('feature_names')
    if not isinstance(names, list) or not names or len(set(names)) != len(names):
        raise ValueError('invalid model feature schema')
    columns = model.get('normalization', {}).get('columns', [])
    if [r.get('feature') for r in columns] != names:
        raise ValueError('model normalizer columns/order mismatch')
    for column in columns:
        if (any(not _finite(column.get(k)) for k in ('magnitude', 'center_scaled', 'scale_scaled'))
                or column['magnitude'] <= 0 or column['scale_scaled'] <= 0
                or not isinstance(column.get('constant'), bool)):
            raise ValueError('invalid model normalization')
    parameters = model.get('parameters', {})
    values = ([parameters.get('value')] if name == 'constant_mean' else
              [parameters.get('intercept_scaled'), parameters.get('target_magnitude'), *parameters.get('coefficients', [])])
    if any(not _finite(v) for v in values) or (name == 'ridge' and len(parameters.get('coefficients', [])) != len(names)):
        raise ValueError('invalid model parameters')
    if model.get('target_spec', {}).get('type') not in ('binary', 'regression') or model['target_spec'].get('direction') not in ('min', 'max'):
        raise ValueError('invalid model target specification')
    if model.get('feature_contract_sha256') != _identity(model.get('feature_contract')):
        raise ValueError('model feature contract hash mismatch')
    _contract_inputs(root, model.get('feature_contract'), names)
    if model.get('advisory') is not True or model.get('qualified') is not False or model.get('adopt_weights') is not False:
        raise ValueError('model cannot claim CAD qualification or automatic adoption')
    return model


def _prediction(model, features):
    if not isinstance(features, dict) or list(features) != model['feature_names']:
        raise ValueError('prediction feature columns/order differ from model')
    for name, value in features.items():
        if value is not None:
            _number(value, 'prediction feature ' + name)
    missing = [name for name, value in features.items() if value is None]
    if missing:
        return None, ['missing feature: ' + name for name in missing]
    try:
        x = _transform(features, model['normalization']['columns'])
        value = _REGISTRY[model['algorithm']['name']]['predict'](model['parameters'], x)
        if not _finite(value):
            return None, ['prediction exceeds finite numeric range']
        if model['target_spec']['type'] == 'binary':
            value = min(1.0, max(0.0, value))
        return value, []
    except (OverflowError, ValueError):
        return None, ['prediction exceeds finite numeric range']


def predict_rows(root, model_path, rows, *, feature_names=None, feature_contract=None, task=None):
    """Read only each row's id/features; outcome labels cannot enter prediction."""
    model_file = _resolve(root, model_path)
    model_sha = _sha(model_file)
    model = _model(root, model_path)
    if feature_names is not None and feature_names != model['feature_names']:
        raise ValueError('prediction schema columns/order differ from model')
    if task is not None and task != model['task']:
        raise ValueError('prediction task differs from model')
    if feature_contract is not None and _identity(feature_contract) != model['feature_contract_sha256']:
        raise ValueError('prediction feature extractor contract differs from model')
    results = []; feature_inputs = []
    seen = set()
    for row in rows:
        row_id = row.get('id')
        if not isinstance(row_id, str) or not row_id or row_id in seen:
            raise ValueError('prediction rows need distinct nonempty IDs')
        seen.add(row_id)
        feature_inputs.append(dict(id=row_id, features=row['features']))
        value, reasons = _prediction(model, row['features'])
        results.append(dict(id=row_id, prediction=value, status='predicted' if value is not None else 'unknown', reasons=reasons))
    inputs = {**_source_paths(), **_contract_inputs(root, model.get('feature_contract'), model['feature_names']), str(model_file): model_sha}
    _check_inputs(inputs)
    return dict(schema=PREDICTION, model_id=model['model_id'], model_sha256=model['artifact_sha256'],
                task=model['task'], target=model['target'], target_spec=model['target_spec'],
                feature_names=model['feature_names'], feature_contract_sha256=model['feature_contract_sha256'],
                provenance='contract_matched' if feature_contract is not None else 'unknown_raw_feature_provenance',
                feature_inputs_sha256=_identity(dict(task=model['task'], feature_names=model['feature_names'],
                                                    feature_contract=feature_contract, rows=feature_inputs)), inputs=inputs,
                rows=results, advisory=True, calibrated_probability=False, qualified=False, adopt_weights=False)


def _metrics(rows, predictions, target, kind):
    scored = [(row, predictions.get(row['id'])) for row in rows if _usable(row, target)
              and predictions.get(row['id']) is not None]
    if not scored:
        return dict(status='unknown', reason='no eligible labelled observations', observations=0,
                    cases=0, mse=None, mae=None, brier=None, logloss=None)
    labelled = [r for r, _ in scored]; weights = _weights(labelled)
    errors = [prediction - _number(row['targets'][target], 'evaluation target') for row, prediction in scored]
    if kind == 'binary' and any(row['targets'][target] not in (0, 1) for row in labelled):
        raise ValueError('binary evaluation labels must be 0 or 1')
    try:
        mse = _average([e * e for e in errors], weights)
        mae = _average([abs(e) for e in errors], weights)
    except (OverflowError, ValueError):
        mse = mae = None
    losses = []
    if kind == 'binary':
        for row, prediction in scored:
            probability = min(1.0 - sys.float_info.epsilon, max(sys.float_info.epsilon, prediction))
            losses.append(-math.log(probability) if row['targets'][target] == 1 else -math.log1p(-probability))
    return dict(status='observed' if mse is not None else 'unknown', observations=len(scored),
                cases=len({r['case_fingerprint'] for r in labelled}), weighting='equal case then pose then repeat',
                mse=mse, mae=mae, brier=mse if kind == 'binary' else None,
                logloss=_average(losses, weights) if losses else None,
                reason=None if mse is not None else 'numeric loss exceeds finite range',
                calibrated_probability=False)


def _outcomes(rows):
    statuses = collections.Counter(); failures = collections.Counter()
    for row in rows:
        observation = row.get('observation', {})
        if not isinstance(observation, dict):
            observation = {}
        status = row.get('status', observation.get('status'))
        failure = row.get('failure_class', observation.get('failure_class'))
        statuses[status if isinstance(status, str) else 'unknown'] += 1
        if isinstance(failure, str):
            failures[failure] += 1
        elif status not in ('passed', 'success'):
            failures['unknown'] += 1
    return dict(status_counts=dict(statuses), failure_class_counts=dict(failures))


def _ranking(rows, predictions, target, direction, target_direction=None):
    target_direction = target_direction or direction
    cases = collections.defaultdict(lambda: collections.defaultdict(list))
    for row in rows:
        if _usable(row) and predictions.get(row['id']) is not None and row.get('pose_fingerprint'):
            cases[row['case_fingerprint']][row['pose_fingerprint']].append(row)
    case_reports = []; concordances = []
    for case, poses in sorted(cases.items()):
        candidates = []
        for pose, group in sorted(poses.items()):
            values = [r['targets'][target] for r in group if _usable(r, target)]
            candidates.append(dict(pose=pose, rows=group, score=_average([predictions[r['id']] for r in group]),
                                   target=_average(values), known=len(values), unknown=len(group) - len(values)))
        # Tie-break depends only on the immutable pose ID, never actual labels.
        chosen = min(candidates, key=lambda c: ((c['score'] if direction == 'min' else -c['score']), c['pose']))
        pairs = 0; credit = 0.0
        for i, left in enumerate(candidates):
            for right in candidates[i + 1:]:
                if left['target'] is None or right['target'] is None or left['target'] == right['target']:
                    continue
                pairs += 1
                product = ((left['score'] > right['score']) - (left['score'] < right['score'])) * ((left['target'] > right['target']) - (left['target'] < right['target']))
                if direction != target_direction:
                    product = -product
                credit += 1.0 if product > 0 else 0.5 if product == 0 else 0.0
        concordance = credit / pairs if pairs else None
        if concordance is not None:
            concordances.append(concordance)
        case_reports.append(dict(case_fingerprint=case, poses=len(candidates), pair_count=pairs,
                                 concordance=concordance, selected_pose=chosen['pose'],
                                 selected_prediction=chosen['score'], selected_observed_target=chosen['target'],
                                 selected_known_label_runs=chosen['known'], selected_unknown_label_runs=chosen['unknown'],
                                 selected_run_ids=[r['id'] for r in chosen['rows']],
                                 selected_outcomes=_outcomes(chosen['rows'])))
    complete = bool(case_reports) and all(r['selected_unknown_label_runs'] == 0 for r in case_reports)
    known = [r['selected_observed_target'] for r in case_reports if r['selected_observed_target'] is not None]
    selected_statuses = collections.Counter(); selected_failures = collections.Counter()
    for row in case_reports:
        selected_statuses.update(row['selected_outcomes']['status_counts'])
        selected_failures.update(row['selected_outcomes']['failure_class_counts'])
    try:
        selected_sum = math.fsum(known) if complete else None
    except OverflowError:
        selected_sum = None
    return dict(cases=len(case_reports), cases_with_rankable_pairs=len(concordances),
                mean_case_concordance=_average(concordances),
                selected_observed_target_sum=selected_sum,
                selected_target_aggregation='sum of per-case selected-pose mean labels; repeated runs are not independent cases',
                selected_outcome_complete=complete,
                selected_unknown_label_runs=sum(r['selected_unknown_label_runs'] for r in case_reports),
                selected_actual_outcomes=dict(status_counts=dict(selected_statuses), failure_class_counts=dict(selected_failures)),
                cases_without_scorable_pose=len({r['case_fingerprint'] for r in rows} - set(cases)),
                unknown_prediction_runs=sum(predictions.get(r['id']) is None for r in rows),
                rows_without_known_pose=sum(not r.get('pose_fingerprint') for r in rows),
                tie_break='lexicographic immutable pose fingerprint; actual target is never consulted',
                case_reports=case_reports)


def evaluate_model(root, model_path, dataset_path, *, output=None):
    model_sha = _sha(_resolve(root, model_path))
    dataset_sha = _sha(_resolve(root, dataset_path))
    model = _model(root, model_path)
    data = _dataset(root, dataset_path)
    if data['task'] != model['task'] or data['feature_names'] != model['feature_names']:
        raise ValueError('evaluation task or feature columns/order differ from model')
    target = model['target']
    if data['target_specs'].get(target) != model['target_spec']:
        raise ValueError('evaluation target type/direction/unit differs from model')
    contract = data.get('metadata', {}).get('feature_contract')
    if _identity(contract) != model['feature_contract_sha256']:
        raise ValueError('evaluation feature extractor contract differs from model')
    training = model['training']['rows']
    for field in ('family', 'case_fingerprint', 'source_fingerprint', 'run_fingerprint'):
        fitted = {r[field] for r in training if r.get(field)}
        if any(r.get(field) in fitted for r in data['rows'] if r['split'] != 'train'):
            raise ValueError('evaluation holdout overlaps model training ' + field)
    for original, groups in model['training']['split_groups'].items():
        for field, values in groups.items():
            if any(r[field] in values and r['split'] != original for r in data['rows']):
                raise ValueError('evaluation relabels a previously bound ' + original + ' group as another split')
    predictions = {r['id']: _prediction(model, r['features'])[0] if _usable(r) else None for r in data['rows']}
    baseline = {r['id']: model['constant_baseline']['value'] if _usable(r) else None for r in data['rows']}
    proxy = data.get('metadata', {}).get('proxy_baseline')
    if proxy is not None and (not isinstance(proxy, dict) or set(proxy) != {'feature', 'direction'}
                              or proxy['feature'] not in model['feature_names'] or proxy['direction'] not in ('min', 'max')):
        raise ValueError('proxy baseline needs an explicit feature and ranking direction')
    folds = {}
    for split in SPLITS:
        rows = [r for r in data['rows'] if r['split'] == split]
        folds[split] = dict(counts=_counts(rows, target), actual_outcomes=_outcomes(rows),
                           model=_metrics(rows, predictions, target, model['target_spec']['type']),
                           constant_baseline=_metrics(rows, baseline, target, model['target_spec']['type']),
                           within_case=_ranking(rows, predictions, target, model['target_spec']['direction']),
                           constant_within_case=_ranking(rows, baseline, target, model['target_spec']['direction']))
        if proxy is not None:
            scores = {r['id']: r['features'][proxy['feature']] if _usable(r) else None for r in rows}
            folds[split]['existing_proxy_baseline'] = dict(feature=proxy['feature'], direction=proxy['direction'],
                scope='ranking only; proxy units are not assumed to be target units',
                within_case=_ranking(rows, scores, target, proxy['direction'], model['target_spec']['direction']))
        else:
            folds[split]['existing_proxy_baseline'] = dict(status='unknown', reason='no declared proxy baseline')
    inputs = {str(_resolve(root, k)): v for k, v in data['inputs'].items()}
    inputs.update({str(_resolve(root, dataset_path)): dataset_sha,
                   str(_resolve(root, model_path)): model_sha, **_source_paths(),
                   **_contract_inputs(root, model.get('feature_contract'), model['feature_names'])})
    _check_inputs(inputs)
    result = dict(schema=EVALUATION, model_id=model['model_id'], model_sha256=model['artifact_sha256'],
                  dataset_id=data['dataset_id'], dataset_content_sha256=data['content_sha256'],
                  task=data['task'], target=target, target_spec=model['target_spec'], folds=folds, inputs=inputs,
                  assessment='observed metrics only; no improvement, holdout winner or engineering readiness decision is automated',
                  duration_semantics='Targets retain their declared meaning. Timeout time-to-outcome is not exact time-to-success; unavailable completion labels remain unknown.',
                  advisory=True, calibrated_probability=False, qualified=False, adopt_weights=False)
    result['content_sha256'] = _identity(result)
    _write(root, output, result, protected=[*inputs, *model['training']['inputs']])
    return result


def dependency_files(root, model_path=None, dataset_path=None):
    """Return consumed files without fitting, running CAD or loading code paths."""
    inputs = _source_paths()
    if model_path is not None:
        model = _model(root, model_path)
        inputs.update(_contract_inputs(root, model.get('feature_contract'), model['feature_names']))
        inputs[str(_resolve(root, model_path))] = _sha(_resolve(root, model_path))
    if dataset_path is not None:
        data = _dataset(root, dataset_path)
        inputs.update({str(_resolve(root, k)): v for k, v in data['inputs'].items()})
        inputs[str(_resolve(root, dataset_path))] = _sha(_resolve(root, dataset_path))
    _check_inputs(inputs)
    return inputs
