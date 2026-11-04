// Source-bound advisory tables. Adapters attribute features/targets; this module verifies their seals and partitions.
import { compare } from './lib/py-compat.mjs';
import {
  artifactIdentity, assertUnchanged, exactKeys, finite, Float, fingerprint, isObject, jsonCopy, names,
  normalizeInputs, number, object, readObject, resolve, same, text, without,
  type Bindings, type Json, type Numeric, type Obj,
} from './pcb_ml_json.ts';
export { artifactIdentity, assertUnchanged } from './pcb_ml_json.ts';

export const SCHEMA = 'iot-lab.pcb-ml-dataset.v1';
export const SPLITS = ['train', 'validation', 'test'] as const;
export type Split = typeof SPLITS[number];
export type TargetSpec = { type: 'binary' | 'regression'; direction: 'min' | 'max'; unit?: string };
export type Features = Record<string, Numeric | null>;
export type Eligibility = { features: boolean; targets: Record<string, boolean>; reasons: Obj[] };
export type DatasetRow = Obj & {
  id: string; family: string; case_fingerprint: string; source_fingerprint: string; run_fingerprint: string;
  pose_fingerprint?: string; split: Split; features: Features; targets: Features;
  evidence_valid: boolean; ineligible_reasons?: string[]; eligibility: Eligibility;
};
export type Dataset = {
  schema: string; dataset_id: string; task: string; feature_names: string[]; target_specs: Record<string, TargetSpec>;
  rows: DatasetRow[]; inputs: Bindings; metadata: Obj; content_sha256: string;
};
export interface DatasetInput {
  dataset_id: string; task: string; feature_names: string[]; target_specs: Record<string, TargetSpec>;
  rows: unknown[]; inputs: Bindings; metadata?: Obj | null;
}

function targetSpecs(value: unknown, features: string[]): Record<string, TargetSpec> {
  const specs = object(value, 'target_specs');
  if (!Object.keys(specs).length) throw new Error('target_specs must be a nonempty object');
  return Object.fromEntries(Object.entries(specs).map(([name, raw]) => {
    text(name, 'target name');
    if (features.includes(name)) throw new Error('feature name also names a target: ' + name);
    const spec = object(raw, 'target specification');
    if (Object.keys(spec).some(k => !['type', 'direction', 'unit'].includes(k))) throw new Error('unsupported target specification: ' + name);
    if (!['binary', 'regression'].includes(String(spec.type)) || !['min', 'max'].includes(String(spec.direction))) throw new Error('target requires type and direction: ' + name);
    if (spec.unit !== undefined) text(spec.unit, 'target unit');
    return [name, jsonCopy(spec) as TargetSpec];
  }));
}

function numericColumns(value: unknown, columns: string[], label: string): Features {
  const raw = object(value, label);
  if (Object.keys(raw).some(k => !columns.includes(k))) throw new Error(label + ' differ from schema');
  return Object.fromEntries(columns.map(name => {
    const value = raw[name] ?? null;
    if (value !== null) number(value, `${label} ${name}`);
    return [name, value as Numeric | null];
  }));
}

function normalizeRows(value: unknown, features: string[], specs: Record<string, TargetSpec>): DatasetRow[] {
  if (!Array.isArray(value)) throw new Error('rows must be a list');
  const ids = new Set<string>(), owners = new Map<string, string>();
  const runs = new Map<string, { signature: string; owner: string }>();
  const rows = value.map(raw => {
    const row = object(jsonCopy(raw), 'each row');
    const id = text(row.id, 'row id');
    if (ids.has(id)) throw new Error('duplicate row id: ' + id);
    ids.add(id); text(row.family, 'row family');
    for (const name of ['case_fingerprint', 'source_fingerprint', 'run_fingerprint']) fingerprint(row[name], 'row ' + name);
    if (row.pose_fingerprint != null) fingerprint(row.pose_fingerprint, 'row pose_fingerprint');
    if (!SPLITS.includes(row.split as Split)) throw new Error('invalid row split: ' + row.split);
    if (typeof row.evidence_valid !== 'boolean') throw new Error('row evidence_valid must be a boolean: ' + id);
    const adapterReasons = row.ineligible_reasons ?? [];
    if (!Array.isArray(adapterReasons) || adapterReasons.some(v => typeof v !== 'string' || !v.trim())) throw new Error('ineligible_reasons must contain nonempty strings: ' + id);
    row.features = numericColumns(row.features, features, 'row features');
    row.targets = numericColumns(row.targets, Object.keys(specs), 'row targets');
    for (const [name, value] of Object.entries(row.targets)) {
      if (value !== null && specs[name].type === 'binary' && (value instanceof Float || !finite(value) || ![0, 1].includes(number(value)))) throw new Error('binary target must be integer 0 or 1: ' + name);
    }
    for (const name of ['family', 'case_fingerprint', 'source_fingerprint', 'run_fingerprint', 'pose']) {
      const identity = name === 'pose' ? row.pose_fingerprint == null ? null : [row.case_fingerprint, row.pose_fingerprint] : row[name];
      if (identity === null) continue;
      const key = artifactIdentity([name, identity]);
      if (owners.has(key) && owners.get(key) !== row.split) throw new Error('cross-split ' + name + ' leakage: ' + id);
      owners.set(key, row.split as string);
    }
    const attribution = Object.fromEntries(['family', 'case_fingerprint', 'source_fingerprint', 'pose_fingerprint', 'features', 'targets', 'evidence_valid'].map(k => [k, row[k] ?? null]));
    attribution.ineligible_reasons = adapterReasons;
    const signature = artifactIdentity(attribution), run = row.run_fingerprint as string, previous = runs.get(run);
    if (previous && previous.signature !== signature) throw new Error('conflicting observations for one sealed run: ' + id);
    runs.set(run, { signature, owner: previous && compare(previous.owner, id) < 0 ? previous.owner : id });
    return row;
  });
  return rows.map(row => {
    const reasons: Obj[] = [], adapterReasons = row.ineligible_reasons as string[] | undefined;
    let valid = row.evidence_valid === true && !adapterReasons?.length;
    if (!row.evidence_valid) reasons.push({ code: 'evidence_invalid' });
    for (const cause of adapterReasons ?? []) reasons.push({ code: 'adapter_ineligible', cause });
    const owner = runs.get(row.run_fingerprint as string)!.owner;
    if (row.id !== owner) { valid = false; reasons.push({ code: 'duplicate_run', duplicate_of: owner }); }
    let featureOk = valid;
    for (const [name, value] of Object.entries(row.features as Features)) if (value === null) { featureOk = false; reasons.push({ code: 'feature_unknown', feature: name }); }
    const targets: Record<string, boolean> = {};
    for (const [name, value] of Object.entries(row.targets as Features)) {
      targets[name] = valid && value !== null;
      if (value === null) reasons.push({ code: 'target_unknown', target: name });
    }
    row.eligibility = { features: featureOk, targets, reasons };
    return row as DatasetRow;
  }).sort((a, b) => compare(a.id, b.id));
}

function payload(root: string, input: DatasetInput): Dataset {
  const featureNames = names(input.feature_names, 'feature_names'), specs = targetSpecs(input.target_specs, featureNames);
  if (input.metadata != null && !isObject(input.metadata)) throw new Error('metadata must be an object');
  const result = {
    schema: SCHEMA, dataset_id: text(input.dataset_id, 'dataset_id'), task: text(input.task, 'task'),
    feature_names: featureNames, target_specs: specs, rows: normalizeRows(input.rows, featureNames, specs),
    inputs: normalizeInputs(root, input.inputs), metadata: jsonCopy(input.metadata ?? {}) as Obj,
  };
  return { ...result, content_sha256: artifactIdentity(result) };
}

export function finalizeDataset(root: string, input: DatasetInput): Dataset {
  const inputs = assertUnchanged(root, input.inputs);
  const result = payload(root, { ...input, inputs });
  assertUnchanged(root, inputs);
  return result;
}

function validate(root: string, value: unknown): Dataset {
  const source = object(value, 'dataset');
  exactKeys(source, ['schema', 'dataset_id', 'task', 'feature_names', 'target_specs', 'rows', 'inputs', 'metadata', 'content_sha256'], 'unsupported or malformed dataset schema');
  if (source.schema !== SCHEMA) throw new Error('unsupported or malformed dataset schema');
  fingerprint(source.content_sha256, 'dataset content_sha256');
  if (artifactIdentity(without(source, 'content_sha256')) !== source.content_sha256) throw new Error('dataset content identity mismatch');
  const result = payload(root, source as unknown as DatasetInput);
  if (!same(result, source)) throw new Error('dataset eligibility or normalized contract mismatch');
  return result;
}

export function loadDataset(root: string, path: string): Dataset {
  const source = readObject(resolve(root, path));
  const inputs = assertUnchanged(root, source.inputs), result = validate(root, source);
  assertUnchanged(root, inputs);
  return result;
}

export function splitRows(dataset: Dataset, split: Split, target?: string): DatasetRow[] {
  if (!SPLITS.includes(split)) throw new Error('invalid dataset split: ' + split);
  const validated = validate('/', dataset);
  if (target !== undefined && !Object.hasOwn(validated.target_specs, target)) throw new Error('unknown target: ' + target);
  return validated.rows.filter(row => row.split === split && row.eligibility.features && (target === undefined || row.eligibility.targets[target]));
}
