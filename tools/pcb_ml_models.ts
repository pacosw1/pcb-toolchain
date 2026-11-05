// Transparent advisory models: TRAIN-only transforms and weights, fixed algorithms, no executable artifact payloads.
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare } from './lib/py-compat.mjs';
import { isRelativeTo } from './lib/py-path.ts';
import { loadDataset, SPLITS, type Dataset, type DatasetRow, type Features, type TargetSpec } from './pcb_ml_data.ts';
import {
  artifactIdentity, assertUnchanged, exactKeys, fingerprint, float, Float, ID, isObject, maybeFloat,
  jsonCopy, names, number, object, readObject, resolve, same, sha256File, text, validateBindings, without, writeArtifact,
  type Bindings, type Json, type Numeric, type Obj,
} from './pcb_ml_json.ts';
import { average, fsum } from './pcb_ml_numeric.ts';

export const MODEL = 'iot-lab.pcb-ml-model.v1';
export const EVALUATION = 'iot-lab.pcb-ml-evaluation.v1';
export const PREDICTION = 'iot-lab.pcb-ml-prediction.v1';
const tools = dirname(fileURLToPath(import.meta.url));
const IMPLEMENTATIONS = ['pcb_ml_models.ts', 'pcb_ml_data.ts', 'pcb_ml_json.ts', 'pcb_ml_numeric.ts',
  'lib/fingerprint.ts', 'lib/json-file.ts', 'lib/py-compat.mjs', 'lib/py-path.ts', 'lib/py-math.ts'];
type Column = { feature: string; magnitude: Numeric; center_scaled: Numeric; scale_scaled: Numeric; constant: boolean };
type MeanParameters = { value: Numeric };
type RidgeParameters = { coefficients: Numeric[]; intercept_scaled: Numeric; target_magnitude: Numeric; numerical_rank: number };
type Algorithm = { name: 'constant_mean' | 'ridge'; version: number; hyperparameters: Record<string, Numeric> };
export type Model = Obj & {
  model_id: string; task: string; target: string; target_spec: TargetSpec; feature_names: string[];
  feature_contract: Json; feature_contract_sha256: string; algorithm: Algorithm;
  normalization: { method: string; columns: Column[] }; parameters: MeanParameters | RidgeParameters;
  constant_baseline: MeanParameters; artifact_sha256: string;
  training: { dataset_path: string; dataset_content_sha256: string; inputs: Bindings; rows: Obj[];
    split_groups: Record<string, Record<string, string[]>> } & Obj;
};
export interface TrainOptions { modelId: string; target: string; algorithm?: string; hyperparameters?: Record<string, Numeric>; output?: string }
export interface PredictOptions { featureNames?: string[]; featureContract?: Json; task?: string }
export type FeatureRow = { id: string; features: Features };

export function sourceInputs(): Bindings {
  return Object.fromEntries(IMPLEMENTATIONS.map(name => [`tools/${name}`, sha256File(resolve(tools, name))]));
}
export function sourcePaths(): Bindings {
  return { ...Object.fromEntries(IMPLEMENTATIONS.map(name => [resolve(tools, name), sha256File(resolve(tools, name))])),
    [resolve('/', process.execPath)]: sha256File(process.execPath) };
}
export function contractInputs(root: string, contract: unknown, featureNames: string[]): Bindings {
  if (!isObject(contract)) return {};
  if (Object.hasOwn(contract, 'features')) {
    if (!Array.isArray(contract.features) || !same(contract.features.map(v => object(v).name), featureNames)) throw new Error('feature extractor columns/order differ from numeric schema');
  }
  if (contract.implementation_sha256 == null) return {};
  const bindings = object(contract.implementation_sha256, 'feature extractor implementations');
  if (!Object.keys(bindings).length) throw new Error('feature extractor needs logical implementation hashes');
  const inputs: Bindings = {};
  for (const [name, digest] of Object.entries(bindings)) {
    if (isAbsolute(name) || name.split('/').includes('..') || !name.startsWith('tools/')) throw new Error('feature implementation bindings must be logical tools-relative paths');
    const actual = resolve(root, name);
    if (!isRelativeTo(actual, resolve(root, '.'))) throw new Error('feature implementation escapes its checkout');
    inputs[actual] = fingerprint(digest, 'implementation hash');
  }
  checkInputs(inputs);
  return inputs;
}
export function checkInputs(inputs: Bindings): void {
  validateBindings(inputs);
  assertUnchanged('/', inputs);
}
export function dataset(root: string, path: string): Dataset {
  const data = loadDataset(root, path);
  // Loading normalizes feature columns and verifies every partition, including ineligible observations.
  for (const row of data.rows) if (!same(Object.keys(row.features), data.feature_names)) throw new Error('feature columns/order differ from dataset schema');
  return data;
}
export const usable = (row: DatasetRow, target?: string): boolean => row.eligibility.features === true
  && Object.values(row.features).every(v => v !== null)
  && (target === undefined || (row.eligibility.targets[target] === true && row.targets[target] != null));
const pose = (row: DatasetRow): string => row.pose_fingerprint || 'unknown:' + row.id;
export function weights(rows: DatasetRow[]): number[] {
  const groups = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!groups.has(row.case_fingerprint)) groups.set(row.case_fingerprint, new Map());
    const group = groups.get(row.case_fingerprint)!, key = pose(row);
    group.set(key, (group.get(key) ?? 0) + 1);
  }
  return rows.map(row => 1 / (groups.get(row.case_fingerprint)!.size * groups.get(row.case_fingerprint)!.get(pose(row))!));
}

export function normalization(rows: DatasetRow[], featureNames: string[], w: number[]): Column[] {
  return featureNames.map(feature => {
    const raw = rows.map(row => row.features[feature]!);
    const largest = raw.reduce((a, b) => Math.abs(number(a)) >= Math.abs(number(b)) ? a : b);
    const magnitudeValue = number(largest) === 0 ? float(1) : largest instanceof Float ? float(Math.abs(largest.value))
      : typeof largest === 'bigint' ? (largest < 0n ? -largest : largest) : Math.abs(largest);
    const values = raw.map(v => number(v)), magnitude = number(magnitudeValue);
    const scaled = values.map(v => v / magnitude), center = average(scaled, w)!;
    const spread = Math.sqrt(fsum(scaled.map((v, i) => w[i] * (v - center) ** 2)) / fsum(w));
    return { feature, magnitude: magnitudeValue, center_scaled: float(center), scale_scaled: float(spread || 1), constant: Math.max(...values) === Math.min(...values) };
  });
}
export const transform = (features: Features, columns: Column[]): number[] => columns.map(column => column.constant ? 0
  : (number(features[column.feature]) / number(column.magnitude) - number(column.center_scaled)) / number(column.scale_scaled));

function solve(matrix: number[][], rhs: number[]): { coefficients: number[]; rank: number } {
  const n = rhs.length;
  if (!n) return { coefficients: [], rank: 0 };
  const rows = matrix.map((row, i) => [...row, rhs[i]]);
  // IEEE-754 binary64 epsilon, scaled by dimension and matrix magnitude; matches the original numerical-rank rule.
  const threshold = Number.EPSILON * n * Math.max(1, ...matrix.flat().map(Math.abs));
  const pivots: number[] = [];
  for (let col = 0; col < n; col++) {
    const index = pivots.length;
    let candidate = index;
    for (let i = index + 1; i < n; i++) if (Math.abs(rows[i][col]) > Math.abs(rows[candidate][col])) candidate = i;
    if (Math.abs(rows[candidate][col]) <= threshold) continue;
    [rows[index], rows[candidate]] = [rows[candidate], rows[index]];
    const pivot = rows[index][col]; rows[index] = rows[index].map(v => v / pivot);
    for (let i = 0; i < n; i++) if (i !== index) { const factor = rows[i][col]; rows[i] = rows[i].map((a, j) => a - factor * rows[index][j]); }
    pivots.push(col);
  }
  const coefficients = Array<number>(n).fill(0);
  pivots.forEach((col, i) => { coefficients[col] = number(rows[i][n], 'coefficient'); });
  return { coefficients, rank: pivots.length };
}

export const algorithms = (): Obj => ({ constant_mean: { version: 1, default_hyperparameters: {} }, ridge: { version: 1, default_hyperparameters: { alpha: float(1) } } });
function algorithmInfo(name: string, parameters: unknown = {}): Algorithm {
  const registered = name === 'mean' ? 'constant_mean' : name;
  if (registered !== 'constant_mean' && registered !== 'ridge') throw new Error('unknown registered algorithm: ' + name);
  const supplied = object(parameters, 'algorithm hyperparameters');
  if (Object.keys(supplied).some(k => registered !== 'ridge' || k !== 'alpha')) throw new Error('unsupported algorithm hyperparameters');
  if (registered === 'constant_mean') return { name: registered, version: 1, hyperparameters: {} };
  const alpha = number(supplied.alpha ?? 1, 'alpha');
  if (alpha < 0) throw new Error('alpha must be nonnegative');
  return { name: registered, version: 1, hyperparameters: { alpha: float(alpha) } };
}
function fit(x: number[][], y: number[], w: number[], info: Algorithm): MeanParameters | RidgeParameters {
  if (info.name === 'constant_mean') return { value: float(average(y, w)!) };
  const width = x[0].length, total = fsum(w), magnitude = Math.max(...y.map(Math.abs)) || 1;
  const scaled = y.map(v => v / magnitude), center = average(scaled, w)!;
  const matrix = Array.from({ length: width }, (_, i) => Array.from({ length: width }, (_, j) =>
    fsum(x.map((row, r) => w[r] * row[i] * row[j])) / total + (i === j ? number(info.hyperparameters.alpha) : 0)));
  const rhs = Array.from({ length: width }, (_, i) => fsum(x.map((row, r) => w[r] * row[i] * (scaled[r] - center))) / total);
  const solution = solve(matrix, rhs);
  return { coefficients: solution.coefficients.map(float), intercept_scaled: float(center), target_magnitude: float(magnitude), numerical_rank: solution.rank };
}
const countBy = (values: string[]): Record<string, number> => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries(counts);
};
export function counts(rows: DatasetRow[], target: string): Obj {
  const poses = rows.filter(r => r.pose_fingerprint).map(r => artifactIdentity([r.case_fingerprint, r.pose_fingerprint]));
  return { rows: rows.length, feature_eligible: rows.filter(r => usable(r)).length, target_eligible: rows.filter(r => usable(r, target)).length,
    families: new Set(rows.map(r => r.family)).size, cases: new Set(rows.map(r => r.case_fingerprint)).size,
    distinct_known_poses: new Set(poses).size, repeated_known_pose_runs: poses.length - new Set(poses).size,
    missing_pose_runs: rows.filter(r => !r.pose_fingerprint).length,
    ineligibility_reasons: countBy(rows.flatMap(r => r.eligibility.reasons.map(v => String(v.code ?? 'unknown')))) };
}

export function trainModel(root: string, datasetPath: string, options: TrainOptions): Model {
  if (!ID.test(options.modelId)) throw new Error('model_id must be a plain identifier');
  const sources = sourceInputs(), sourceFiles = sourcePaths(), path = resolve(root, datasetPath), digest = sha256File(path);
  const data = dataset(root, path), target = options.target, spec = data.target_specs[target];
  if (!spec) throw new Error('unknown declared target');
  const rows = data.rows.filter(r => r.split === 'train' && usable(r, target));
  if (!rows.length) throw new Error('no eligible TRAIN feature/target rows; model was not fitted');
  const y = rows.map(r => number(r.targets[target], 'training target'));
  const info = algorithmInfo(options.algorithm ?? 'ridge', options.hyperparameters ?? {}), w = weights(rows);
  const columns = normalization(rows, data.feature_names, w), parameters = fit(rows.map(r => transform(r.features, columns)), y, w, info);
  const inputs = { ...data.inputs, [path]: digest }; checkInputs(inputs);
  const contract = data.metadata.feature_contract ?? null, contractFiles = contractInputs(root, contract, data.feature_names);
  const result: Obj = { schema: MODEL, model_id: options.modelId, task: data.task, target, target_spec: spec,
    feature_names: data.feature_names, feature_contract: contract, feature_contract_sha256: artifactIdentity(contract), algorithm: info,
    normalization: { method: 'TRAIN-only maxabs then weighted standardization; no imputation', columns }, parameters,
    constant_baseline: { value: float(average(y, w)!) },
    training: { dataset_id: data.dataset_id, dataset_path: path, dataset_content_sha256: data.content_sha256, inputs,
      weighting: 'equal total weight per case, then per pose, then per repeated run',
      rows: rows.map(r => ({ id: r.id, family: r.family, case_fingerprint: r.case_fingerprint, source_fingerprint: r.source_fingerprint,
        pose_fingerprint: r.pose_fingerprint ?? null, run_fingerprint: r.run_fingerprint })),
      split_groups: Object.fromEntries(SPLITS.map(split => [split, Object.fromEntries(['family', 'case_fingerprint', 'source_fingerprint'].map(field =>
        [field, [...new Set(data.rows.filter(r => r.split === split).map(r => r[field] as string))].sort(compare)]))])),
      counts: counts(rows, target), folds: Object.fromEntries(SPLITS.map(split => [split, counts(data.rows.filter(r => r.split === split), target)])) },
    source_inputs: sources, runtime: { node: process.version, implementation: 'node', executable: resolve('/', process.execPath), executable_sha256: sha256File(process.execPath) },
    advisory: true, calibrated_probability: false, qualified: false, adopt_weights: false,
    unknowns: contract !== null ? [] : ['feature extractor contract is absent; schema alone cannot certify future packet provenance'] };
  checkInputs({ ...sourceFiles, ...contractFiles });
  result.artifact_sha256 = artifactIdentity(result);
  if (options.output) writeArtifact(resolve(root, options.output), result, Object.keys({ ...inputs, ...sourceFiles, ...contractFiles }), true);
  return result as Model;
}

export function loadModel(root: string, path: string): Model {
  const model = readObject(resolve(root, path));
  if (model.schema !== MODEL) throw new Error('unsupported model artifact');
  if (model.artifact_sha256 !== artifactIdentity(without(model, 'artifact_sha256'))) throw new Error('model artifact checksum mismatch');
  const info = object(model.algorithm, 'model algorithm');
  if (!same(algorithmInfo(text(info.name, 'algorithm name'), info.hyperparameters), info)) throw new Error('unsupported model algorithm/version');
  if (!same(model.source_inputs, sourceInputs())) throw new Error('model implementation inputs changed');
  const training = object(model.training, 'model training'), inputs = validateBindings(training.inputs);
  if (typeof training.dataset_path !== 'string' || !Object.hasOwn(inputs, training.dataset_path)
      || !Array.isArray(training.rows) || !training.rows.length) throw new Error('model training provenance is incomplete');
  fingerprint(training.dataset_content_sha256, 'training dataset hash');
  const groups = object(training.split_groups, 'model split provenance');
  exactKeys(groups, [...SPLITS], 'model split provenance is incomplete');
  for (const group of Object.values(groups)) {
    const values = object(group, 'split group');
    exactKeys(values, ['family', 'case_fingerprint', 'source_fingerprint'], 'model split provenance is incomplete');
    if (Object.values(values).some(v => !Array.isArray(v) || v.some(x => typeof x !== 'string'))) throw new Error('model split provenance is incomplete');
  }
  number(object(model.constant_baseline, 'model constant baseline').value, 'model constant baseline');
  const featureNames = names(model.feature_names, 'model feature schema');
  const normalization = object(model.normalization, 'model normalizer');
  if (!Array.isArray(normalization.columns) || !same(normalization.columns.map(c => object(c).feature), featureNames)) throw new Error('model normalizer columns/order mismatch');
  for (const raw of normalization.columns) {
    const column = object(raw, 'normalization column');
    if (number(column.magnitude) <= 0 || number(column.scale_scaled) <= 0 || typeof column.constant !== 'boolean') throw new Error('invalid model normalization');
    number(column.center_scaled);
  }
  const parameters = object(model.parameters, 'model parameters');
  if (info.name === 'constant_mean') number(parameters.value, 'model parameter');
  else {
    number(parameters.intercept_scaled, 'model intercept');
    if (number(parameters.target_magnitude, 'model target magnitude') <= 0) throw new Error('invalid model target magnitude');
    if (!Array.isArray(parameters.coefficients) || parameters.coefficients.length !== featureNames.length) throw new Error('invalid model parameters');
    parameters.coefficients.forEach(v => number(v, 'model coefficient'));
  }
  const spec = object(model.target_spec, 'model target specification');
  if (!['binary', 'regression'].includes(String(spec.type)) || !['min', 'max'].includes(String(spec.direction))) throw new Error('invalid model target specification');
  if (model.feature_contract_sha256 !== artifactIdentity(model.feature_contract)) throw new Error('model feature contract hash mismatch');
  contractInputs(root, model.feature_contract, featureNames);
  if (model.advisory !== true || model.qualified !== false || model.adopt_weights !== false) throw new Error('model cannot claim CAD qualification or automatic adoption');
  return model as Model;
}

export function prediction(model: Model, features: Features): [number | null, string[]] {
  if (!isObject(features) || !same(Object.keys(features), model.feature_names)) throw new Error('prediction feature columns/order differ from model');
  for (const [name, value] of Object.entries(features)) if (value !== null) number(value, 'prediction feature ' + name);
  const missing = Object.entries(features).filter(([, v]) => v === null).map(([name]) => 'missing feature: ' + name);
  if (missing.length) return [null, missing];
  try {
    const x = transform(features, model.normalization.columns), p = model.parameters;
    const value = 'value' in p ? number(p.value) : (number(p.intercept_scaled) + fsum(p.coefficients.map((a, i) => number(a) * x[i]))) * number(p.target_magnitude);
    if (!Number.isFinite(value)) throw new Error('nonfinite prediction');
    return [model.target_spec.type === 'binary' ? Math.min(1, Math.max(0, value)) : value, []];
  } catch { return [null, ['prediction exceeds finite numeric range']]; }
}

export function predictRows(root: string, modelPath: string, rows: FeatureRow[], options: PredictOptions = {}): Obj {
  const path = resolve(root, modelPath), digest = sha256File(path), model = loadModel(root, path);
  if (options.featureNames !== undefined && !same(options.featureNames, model.feature_names)) throw new Error('prediction schema columns/order differ from model');
  if (options.task !== undefined && options.task !== model.task) throw new Error('prediction task differs from model');
  if (options.featureContract != null && artifactIdentity(options.featureContract) !== model.feature_contract_sha256) throw new Error('prediction feature extractor contract differs from model');
  const seen = new Set<string>();
  const results = rows.map(row => {
    const id = text(row.id, 'prediction row ID');
    if (seen.has(id)) throw new Error('prediction rows need distinct nonempty IDs');
    seen.add(id);
    const [value, reasons] = prediction(model, row.features);
    return { id, prediction: maybeFloat(value), status: value !== null ? 'predicted' : 'unknown', reasons };
  });
  const inputs = { ...sourcePaths(), ...contractInputs(root, model.feature_contract, model.feature_names), [path]: digest }; checkInputs(inputs);
  return { schema: PREDICTION, model_id: model.model_id, model_sha256: model.artifact_sha256, task: model.task, target: model.target,
    target_spec: model.target_spec, feature_names: model.feature_names, feature_contract_sha256: model.feature_contract_sha256,
    provenance: options.featureContract != null ? 'contract_matched' : 'unknown_raw_feature_provenance',
    feature_inputs_sha256: artifactIdentity({ task: model.task, feature_names: model.feature_names, feature_contract: options.featureContract ?? null,
      rows: rows.map(row => ({ id: row.id, features: row.features })) }), inputs, rows: results,
    advisory: true, calibrated_probability: false, qualified: false, adopt_weights: false };
}

function metrics(rows: DatasetRow[], predictions: Map<string, number | null>, target: string, kind: string): Obj {
  const labelled = rows.filter(r => usable(r, target) && predictions.get(r.id) != null);
  if (!labelled.length) return { status: 'unknown', reason: 'no eligible labelled observations', observations: 0, cases: 0, mse: null, mae: null, brier: null, logloss: null };
  const w = weights(labelled), errors = labelled.map(r => predictions.get(r.id)! - number(r.targets[target], 'evaluation target'));
  let mse: number | null = null, mae: number | null = null;
  try { mse = average(errors.map(e => e * e), w); mae = average(errors.map(Math.abs), w); } catch { mse = mae = null; }
  const losses = kind === 'binary' ? labelled.map(r => {
    const probability = Math.min(1 - Number.EPSILON, Math.max(Number.EPSILON, predictions.get(r.id)!));
    return number(r.targets[target]) === 1 ? -Math.log(probability) : -Math.log1p(-probability);
  }) : [];
  return { status: mse !== null ? 'observed' : 'unknown', observations: labelled.length, cases: new Set(labelled.map(r => r.case_fingerprint)).size,
    weighting: 'equal case then pose then repeat', mse: maybeFloat(mse), mae: maybeFloat(mae), brier: kind === 'binary' ? maybeFloat(mse) : null,
    logloss: maybeFloat(average(losses, w)), reason: mse !== null ? null : 'numeric loss exceeds finite range', calibrated_probability: false };
}
function outcomes(rows: DatasetRow[]): Obj {
  const statuses: string[] = [], failures: string[] = [];
  for (const row of rows) {
    const observation = isObject(row.observation) ? row.observation : {};
    const status = Object.hasOwn(row, 'status') ? row.status : observation.status;
    const failure = Object.hasOwn(row, 'failure_class') ? row.failure_class : observation.failure_class;
    statuses.push(typeof status === 'string' ? status : 'unknown');
    if (typeof failure === 'string') failures.push(failure);
    else if (status !== 'passed' && status !== 'success') failures.push('unknown');
  }
  return { status_counts: countBy(statuses), failure_class_counts: countBy(failures) };
}

function ranking(rows: DatasetRow[], predictions: Map<string, number | null>, target: string, direction: string, targetDirection = direction): Obj {
  const cases = new Map<string, Map<string, DatasetRow[]>>();
  for (const row of rows) if (usable(row) && predictions.get(row.id) != null && row.pose_fingerprint) {
    if (!cases.has(row.case_fingerprint)) cases.set(row.case_fingerprint, new Map());
    const poses = cases.get(row.case_fingerprint)!;
    if (!poses.has(row.pose_fingerprint)) poses.set(row.pose_fingerprint, []);
    poses.get(row.pose_fingerprint)!.push(row);
  }
  const reports: Obj[] = [], concordances: number[] = [], selectedRows: DatasetRow[] = [], known: number[] = [];
  for (const [caseId, poses] of [...cases].sort(([a], [b]) => compare(a, b))) {
    const candidates = [...poses].sort(([a], [b]) => compare(a, b)).map(([poseId, group]) => {
      const values = group.filter(r => usable(r, target)).map(r => number(r.targets[target]));
      return { pose: poseId, rows: group, score: average(group.map(r => predictions.get(r.id)!))!, target: average(values), known: values.length, unknown: group.length - values.length };
    });
    const chosen = [...candidates].sort((a, b) => (direction === 'min' ? a.score - b.score : b.score - a.score) || compare(a.pose, b.pose))[0];
    let pairs = 0, credit = 0;
    for (let i = 0; i < candidates.length; i++) for (const right of candidates.slice(i + 1)) {
      const left = candidates[i];
      if (left.target === null || right.target === null || left.target === right.target) continue;
      pairs++;
      let product = Math.sign(left.score - right.score) * Math.sign(left.target - right.target);
      if (direction !== targetDirection) product = -product;
      credit += product > 0 ? 1 : product === 0 ? 0.5 : 0;
    }
    const concordance = pairs ? credit / pairs : null;
    if (concordance !== null) concordances.push(concordance);
    selectedRows.push(...chosen.rows); if (chosen.target !== null) known.push(chosen.target);
    reports.push({ case_fingerprint: caseId, poses: candidates.length, pair_count: pairs, concordance: maybeFloat(concordance),
      selected_pose: chosen.pose, selected_prediction: float(chosen.score), selected_observed_target: maybeFloat(chosen.target),
      selected_known_label_runs: chosen.known, selected_unknown_label_runs: chosen.unknown, selected_run_ids: chosen.rows.map(r => r.id), selected_outcomes: outcomes(chosen.rows) });
  }
  const complete = reports.length > 0 && reports.every(r => r.selected_unknown_label_runs === 0);
  let selectedSum: number | null = null;
  if (complete) try { selectedSum = fsum(known); } catch { /* unavailable numeric aggregate */ }
  return { cases: reports.length, cases_with_rankable_pairs: concordances.length, mean_case_concordance: maybeFloat(average(concordances)),
    selected_observed_target_sum: maybeFloat(selectedSum), selected_target_aggregation: 'sum of per-case selected-pose mean labels; repeated runs are not independent cases',
    selected_outcome_complete: complete, selected_unknown_label_runs: reports.reduce((n, r) => n + number(r.selected_unknown_label_runs), 0),
    selected_actual_outcomes: outcomes(selectedRows), cases_without_scorable_pose: new Set(rows.filter(r => !cases.has(r.case_fingerprint)).map(r => r.case_fingerprint)).size,
    unknown_prediction_runs: rows.filter(r => predictions.get(r.id) == null).length, rows_without_known_pose: rows.filter(r => !r.pose_fingerprint).length,
    tie_break: 'lexicographic immutable pose fingerprint; actual target is never consulted', case_reports: reports };
}

export function evaluateModel(root: string, modelPath: string, datasetPath: string, options: { output?: string } = {}): Obj {
  const modelFile = resolve(root, modelPath), dataFile = resolve(root, datasetPath), modelDigest = sha256File(modelFile), dataDigest = sha256File(dataFile);
  const model = loadModel(root, modelPath), data = dataset(root, datasetPath), target = model.target;
  if (data.task !== model.task || !same(data.feature_names, model.feature_names)) throw new Error('evaluation task or feature columns/order differ from model');
  if (!same(data.target_specs[target], model.target_spec)) throw new Error('evaluation target type/direction/unit differs from model');
  if (artifactIdentity(data.metadata.feature_contract ?? null) !== model.feature_contract_sha256) throw new Error('evaluation feature extractor contract differs from model');
  for (const field of ['family', 'case_fingerprint', 'source_fingerprint', 'run_fingerprint']) {
    const fitted = new Set(model.training.rows.map(r => r[field]).filter(Boolean));
    if (data.rows.some(r => r.split !== 'train' && fitted.has(r[field]))) throw new Error('evaluation holdout overlaps model training ' + field);
  }
  for (const [original, groups] of Object.entries(model.training.split_groups)) for (const [field, values] of Object.entries(groups)) {
    if (data.rows.some(r => values.includes(r[field] as string) && r.split !== original)) throw new Error('evaluation relabels a previously bound ' + original + ' group as another split');
  }
  const predictions = new Map(data.rows.map(r => [r.id, usable(r) ? prediction(model, r.features)[0] : null]));
  const baseline = new Map(data.rows.map(r => [r.id, usable(r) ? number(model.constant_baseline.value) : null]));
  const proxy = data.metadata.proxy_baseline;
  if (proxy != null && (!isObject(proxy) || Object.keys(proxy).length !== 2 || !model.feature_names.includes(proxy.feature as string) || !['min', 'max'].includes(proxy.direction as string))) throw new Error('proxy baseline needs an explicit feature and ranking direction');
  const folds = Object.fromEntries(SPLITS.map(split => {
    const rows = data.rows.filter(r => r.split === split);
    return [split, { counts: counts(rows, target), actual_outcomes: outcomes(rows), model: metrics(rows, predictions, target, model.target_spec.type),
      constant_baseline: metrics(rows, baseline, target, model.target_spec.type), within_case: ranking(rows, predictions, target, model.target_spec.direction),
      constant_within_case: ranking(rows, baseline, target, model.target_spec.direction),
      existing_proxy_baseline: isObject(proxy) ? { feature: proxy.feature, direction: proxy.direction,
        scope: 'ranking only; proxy units are not assumed to be target units', within_case: ranking(rows, new Map(rows.map(r => [r.id, usable(r) && r.features[proxy.feature as string] !== null ? number(r.features[proxy.feature as string]) : null])), target, proxy.direction as string, model.target_spec.direction) }
        : { status: 'unknown', reason: 'no declared proxy baseline' } }];
  }));
  const inputs = { ...data.inputs, [dataFile]: dataDigest, [modelFile]: modelDigest, ...sourcePaths(), ...contractInputs(root, model.feature_contract, model.feature_names) }; checkInputs(inputs);
  const result: Obj = { schema: EVALUATION, model_id: model.model_id, model_sha256: model.artifact_sha256, dataset_id: data.dataset_id,
    dataset_content_sha256: data.content_sha256, task: data.task, target, target_spec: model.target_spec, folds: jsonCopy(folds), inputs,
    assessment: 'observed metrics only; no improvement, holdout winner or engineering readiness decision is automated',
    duration_semantics: 'Targets retain their declared meaning. Timeout time-to-outcome is not exact time-to-success; unavailable completion labels remain unknown.',
    advisory: true, calibrated_probability: false, qualified: false, adopt_weights: false };
  result.content_sha256 = artifactIdentity(result);
  if (options.output) writeArtifact(resolve(root, options.output), result, [...Object.keys(inputs), ...Object.keys(model.training.inputs)], true);
  return result;
}

export function dependencyFiles(root: string, modelPath?: string, datasetPath?: string): Bindings {
  const inputs = sourcePaths();
  if (modelPath !== undefined) {
    const model = loadModel(root, modelPath);
    Object.assign(inputs, contractInputs(root, model.feature_contract, model.feature_names), { [resolve(root, modelPath)]: sha256File(resolve(root, modelPath)) });
  }
  if (datasetPath !== undefined) Object.assign(inputs, dataset(root, datasetPath).inputs, { [resolve(root, datasetPath)]: sha256File(resolve(root, datasetPath)) });
  checkInputs(inputs);
  return inputs;
}
