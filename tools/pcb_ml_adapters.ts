// Source-bound ML adapters. Unknown/corrupt historical runs remain visible; feature packets are always re-extracted.
import { lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compare } from './lib/py-compat.mjs';
import { isRelativeTo } from './lib/py-path.ts';
import { finalizeDataset, SPLITS, type Dataset, type Features, type Split, type TargetSpec } from './pcb_ml_data.ts';
import {
  ADDED_LENGTH_DEFINITION, boardSources, featureContract, implementationInputs, nativeCopperMetrics, readBoard,
  ROUTING_FEATURES, routingFeatures, workflowCase, workflowFeatures, type Adapter, type BoardReader, type Measurements,
} from './pcb_ml_features.ts';
import {
  artifactIdentity, assertUnchanged, checkClosure, exactKeys, finite, fingerprint, float, isFile, isObject, number,
  object, readObject, resolve, same, sha256File, text, truthy, validateBindings, without, type Bindings, type Closure, type Obj,
} from './pcb_ml_json.ts';
import { fsum } from './pcb_ml_numeric.ts';

export const CORPUS = 'iot-lab.pcb-ml-corpus.v1';
export const REQUEST = 'iot-lab.pcb-ml-features-request.v1';
export const PACKET = 'iot-lab.pcb-ml-features.v1';
export const ACCEPTANCE_DEFINITION: Obj = { id: 'iot-lab.accepted-within-owned-budget.v2',
  positive: 'complete fresh native/configured acceptance within run.json:timeout_s with verified controls',
  verified_failure: 'zero for an unsuccessful attempt requires a sealed verified-routing-execution-attempt.v1 terminal failure',
  deadline_failure: 'a fully accepted native/configured outcome after the owned budget has acceptance-within-budget zero',
  unknown: 'missing or ambiguous execution evidence is not a negative label',
  quality: 'failure never supplies successful completion time, routed copper quality or added length' };
const regression = (unit: string): TargetSpec => ({ type: 'regression', direction: 'min', unit });
export const ROUTING_TARGETS: Record<string, TargetSpec> = { accepted_within_budget: { type: 'binary', direction: 'max' },
  owned_elapsed_s: regression('s'), successful_completion_elapsed_s: regression('s'), routed_track_length_mm: regression('mm'),
  added_route_track_length_mm: regression('mm'), routed_via_count: regression('count'), native_errors: regression('count'), native_opens: regression('count'), native_parity: regression('count') };
export const WORKFLOW_TARGETS: Record<string, TargetSpec> = { run_passed: { type: 'binary', direction: 'max' }, owned_elapsed_s: regression('s') };
const tools = dirname(fileURLToPath(import.meta.url));
export type CorpusTrial = Obj & { id: string; family: string; split: Split; path: string; sha256: string };
/** The sibling observer port supplies its full implementation closure; artifacts never choose or load code. */
export interface RoutingObserver { inputs: Bindings; cliObservation(evidence: Evidence, trial: CorpusTrial): Obj | Promise<Obj> }
export interface AdapterOptions { boardReader?: BoardReader; observer?: RoutingObserver }
export type FeaturePacket = Obj & { id: string; task: string; feature_names: string[]; feature_contract: Obj; inputs: Bindings;
  content_sha256: string; rows: (Obj & { id: string; source: { path: string; sha256: string }; features: Features; eligibility: { features: boolean; reasons: Obj[] } })[] };

export class Evidence {
  readonly root: string;
  readonly inputs: Bindings = {};
  constructor(root: string) { this.root = resolve(root, '.'); }
  file(name: string, expected?: string | null): string {
    const path = resolve(this.root, name), digest = sha256File(path);
    if (expected != null && digest !== expected) throw new Error('evidence changed: ' + path);
    if (this.inputs[path] !== undefined && this.inputs[path] !== digest) throw new Error('evidence changed during observation: ' + path);
    this.inputs[path] = digest; return path;
  }
  read(name: string, expected?: string | null): Obj { return readObject(this.file(name, expected)); }
}
export function walkFiles(folder: string): string[] {
  if (!isFile(folder) && !lstatOrNull(folder)?.isDirectory()) return [];
  if (isFile(folder)) return [folder];
  return readdirSync(folder).sort(compare).flatMap(name => {
    const path = resolve(folder, name), stat = lstatOrNull(`${folder}/${name}`);
    return stat?.isDirectory() && !stat.isSymbolicLink() ? walkFiles(path) : isFile(path) ? [path] : [];
  });
}
function lstatOrNull(path: string) {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export function sealedRun(evidence: Evidence, folderName: string, expected: string): { folder: string; terminal: Obj; manifest: Obj; operation: Obj; candidate: string | null } {
  const folder = resolve(evidence.root, folderName), terminal = evidence.read(resolve(folder, 'result.json'), expected);
  if (!['passed', 'failed', 'error', 'timeout', 'cancelled'].includes(String(terminal.status)) || object(terminal.cleanup, 'cleanup').complete !== true) throw new Error('run is not terminal with confirmed owned cleanup');
  const hashes = object(terminal.evidence_sha256, 'terminal evidence seal');
  if (!Object.hasOwn(hashes, 'run.json')) throw new Error('run has no terminal evidence seal');
  for (const [name, digest] of Object.entries(hashes)) {
    const path = resolve(folder, name);
    if (!isRelativeTo(path, folder)) throw new Error('sealed run path escapes its folder');
    evidence.file(path, fingerprint(digest, 'sealed evidence hash'));
  }
  const manifest = evidence.read(resolve(folder, 'run.json')), operationPath = resolve(folder, 'operation/result.json');
  const operation = isFile(operationPath) ? evidence.read(operationPath) : {}, actual = new Set(['run.json']);
  for (const directory of ['operation', 'gate']) for (const path of walkFiles(resolve(folder, directory))) actual.add(relative(folder, path));
  let candidate: string | null = null;
  if (operation.candidate) {
    const recorded = resolve(evidence.root, text(operation.candidate, 'candidate'));
    const workspace = resolve(evidence.root, typeof operation.workspace === 'string' ? operation.workspace : dirname(recorded));
    if (!isRelativeTo(recorded, workspace)) throw new Error('candidate escapes recorded workspace');
    candidate = resolve(folder, 'workspace/' + relative(workspace, recorded));
    if (!isRelativeTo(candidate, resolve(folder, 'workspace'))) throw new Error('candidate path escapes archived workspace');
    actual.add(relative(folder, candidate)); evidence.file(candidate, fingerprint(operation.candidate_sha256, 'candidate hash'));
  }
  if (!same([...actual].sort(compare), Object.keys(hashes).sort(compare))) throw new Error('run evidence inventory differs from its terminal seal');
  return { folder, terminal, manifest, operation, candidate };
}

async function routingObserver(): Promise<RoutingObserver | undefined> {
  const path = resolve(tools, 'placement_outcomes.ts');
  if (!isFile(path)) return undefined;
  const module = await import(pathToFileURL(path).href) as { sourceInputs?: () => Bindings; cliObservation?: RoutingObserver['cliObservation'] };
  if (typeof module.sourceInputs !== 'function' || typeof module.cliObservation !== 'function') throw new Error('placement_outcomes.ts must export sourceInputs and cliObservation');
  return { inputs: { ...validateBindings(module.sourceInputs()), [path]: sha256File(path) }, cliObservation: module.cliObservation };
}
function manifest(root: string, name: string, schema?: string): [string, Obj & { adapter: Adapter }] {
  const path = resolve(root, name), value = readObject(path);
  if (![CORPUS, REQUEST].includes(String(value.schema)) || (schema && value.schema !== schema)) throw new Error('unsupported ML manifest schema');
  if (value.adapter !== 'routing' && value.adapter !== 'workflow') throw new Error('unsupported ML adapter');
  if (value.schema === CORPUS) {
    if (!Array.isArray(value.trials)) throw new Error('corpus trials must be a list');
    for (const raw of value.trials) {
      const trial = object(raw, 'corpus trial');
      for (const name of ['id', 'family', 'path']) text(trial[name], 'corpus trial ' + name);
      if (!SPLITS.includes(trial.split as Split)) throw new Error('invalid corpus trial split');
      fingerprint(trial.sha256, 'terminal SHA256');
    }
  }
  return [path, value as Obj & { adapter: Adapter }];
}
export function codeInputs(): Bindings {
  return { ...implementationInputs(), ...Object.fromEntries(['pcb_ml_adapters.ts', 'pcb_ml_data.ts'].map(name => [resolve(tools, name), sha256File(resolve(tools, name))])) };
}
export async function manifestDependencies(root: string, name: string, options: AdapterOptions = {}): Promise<Closure> {
  const [path, value] = manifest(root, name), result: Closure = codeInputs();
  const add = (name: string): string => { const path = resolve(root, name); result[path] = isFile(path) ? sha256File(path) : null; return path; };
  const source = (name: string) => { for (const path of value.adapter === 'routing' ? boardSources(resolve(root, name)) : [name]) add(path); };
  add(path);
  if (value.schema === REQUEST) {
    if (!Array.isArray(value.samples)) throw new Error('feature request samples must be a list');
    for (const sample of value.samples) source(text(object(object(sample).source).path, 'feature source path'));
  } else {
    if (value.adapter === 'routing') {
      const observer = options.observer ?? await routingObserver();
      if (observer) Object.assign(result, validateBindings(observer.inputs)); else result[resolve(tools, 'placement_outcomes.ts')] = null;
    }
    for (const raw of value.trials as Obj[]) {
      const trial = raw as CorpusTrial, folders = [trial.path];
      if (isObject(trial.parent_run) && typeof trial.parent_run.path === 'string') folders.push(trial.parent_run.path);
      for (const name of folders) {
        const folder = resolve(root, name), terminalPath = add(resolve(folder, 'result.json')); add(resolve(folder, 'run.json'));
        for (const directory of ['operation', 'gate']) walkFiles(resolve(folder, directory)).forEach(add);
        let terminal: Obj = {}; try { if (isFile(terminalPath)) terminal = readObject(terminalPath); } catch { /* corrupt history is retained */ }
        if (isObject(terminal.evidence_sha256)) for (const relative of Object.keys(terminal.evidence_sha256)) {
          const file = resolve(folder, relative); if (!isRelativeTo(file, folder)) throw new Error('sealed run path escapes its folder'); add(file);
        }
      }
      if (isObject(trial.placement_input) && typeof trial.placement_input.path === 'string') source(trial.placement_input.path);
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => compare(a, b)));
}

const nonnegative = (value: unknown): boolean => finite(value) && number(value) >= 0;
export function extract(adapter: Adapter, path: string, reader?: BoardReader): Measurements {
  if (adapter === 'workflow') return workflowFeatures(readObject(path));
  try { return routingFeatures(readBoard(path, reader)); }
  catch (error) { return [Object.fromEntries(ROUTING_FEATURES.map(([name]) => [name, null])), [{ code: 'native_input_invalid', cause: (error as Error).message }]]; }
}
const task = (adapter: Adapter): string => adapter === 'routing' ? 'routing_outcome' : 'workflow_outcome';
function workflowSourceContext(evidence: Evidence, folder: string, manifest: Obj): Obj[] {
  let entries: [string, unknown][] = [];
  const sourcePath = resolve(folder, 'operation/source.json');
  if (isFile(sourcePath)) { const files = evidence.read(sourcePath).files; if (isObject(files)) entries = Object.entries(files); }
  const gatePath = resolve(folder, 'gate/result.json');
  if (!entries.length && manifest.operation === 'check' && isFile(gatePath)) {
    const gate = evidence.read(gatePath), provenance = isObject(gate.provenance) ? gate.provenance : {};
    if (gate.changedDuringRun === false && Array.isArray(provenance.inputs)) entries = provenance.inputs.filter(isObject).map(row => [String(row.path), row.sha256]);
  }
  const result = new Map<string, Obj>();
  for (const [name, digest] of entries) {
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest) || !/\.(kicad_pcb|kicad_sch|kicad_pro|kicad_dru|kicad_sym|kicad_mod)$/.test(name)) continue;
    const normalized = name.includes('hardware-design/') ? name.slice(name.indexOf('hardware-design/')) : basename(name);
    result.set(artifactIdentity([normalized, digest]), { path: normalized, sha256: digest });
  }
  return [...result.values()].sort((a, b) => compare(a.path as string, b.path as string) || compare(a.sha256 as string, b.sha256 as string));
}
function addedTrackLength(evidence: Evidence, source: string, sourceSha: string, quality: Obj, reader?: BoardReader): Obj {
  const result: Obj = { definition: ADDED_LENGTH_DEFINITION.id, added_route_track_length_mm: null, retained_track_length_mm: null,
    final_track_length_mm: null, retained_copper_preserved: null, missing_source_items: null, source: null, candidate: null, unknowns: {} };
  const descriptor = object(quality.candidate, 'accepted candidate'), candidate = evidence.file(text(descriptor.path, 'candidate path'), fingerprint(descriptor.sha256, 'candidate hash'));
  evidence.file(source, sourceSha); result.source = { path: source, sha256: sourceSha }; result.candidate = descriptor;
  try {
    const before = nativeCopperMetrics(readBoard(source, reader)), after = nativeCopperMetrics(readBoard(candidate, reader));
    result.retained_track_length_mm = before.track_length_mm === null ? null : float(before.track_length_mm);
    result.final_track_length_mm = after.track_length_mm === null ? null : float(after.track_length_mm);
    if (before.copper === null || after.copper === null) throw new Error('retained copper proof unavailable: ' + JSON.stringify(Object.keys(before.unknowns).length ? before.unknowns : after.unknowns));
    let missing = 0; for (const [key, count] of before.copper) missing += Math.max(0, count - (after.copper.get(key) ?? 0));
    result.retained_copper_preserved = missing === 0; result.missing_source_items = missing;
    if (missing) throw new Error('source track/via geometry missing or changed; net subtraction is not proven added copper');
    if (!nonnegative(before.track_length_mm) || !nonnegative(after.track_length_mm)) throw new Error('source/final straight length unknown');
    if (after.track_length_mm !== number(quality.routed_track_length_mm)) throw new Error('final native measurement disagrees with accepted whole-board quality');
    const delta = fsum([after.track_length_mm!, -before.track_length_mm!]);
    if (delta < 0) throw new Error('negative added length; no zero clamp or assumed tolerance');
    result.added_route_track_length_mm = float(delta);
  } catch (error) { object(result.unknowns).added_route_track_length_mm = (error as Error).message; }
  evidence.file(source, sourceSha); evidence.file(candidate, descriptor.sha256 as string); return result;
}

async function row(root: string, trial: CorpusTrial, adapter: Adapter, evidence: Evidence, options: AdapterOptions): Promise<Obj> {
  const folder = resolve(root, trial.path), original = adapter === 'routing' ? trial.placement_input : { path: resolve(folder, 'run.json'), sha256: null };
  const sourcePath = isObject(original) && typeof original.path === 'string' ? resolve(root, original.path) : null;
  const sourceSha = sourcePath && isFile(sourcePath) ? sha256File(sourcePath) : null;
  let raw: Obj = {}; try { raw = readObject(resolve(folder, 'run.json')); } catch { /* retain missing/corrupt run */ }
  const sourceId = artifactIdentity({ adapter, source_sha256: sourceSha, declared_sha256: isObject(original) ? original.sha256 ?? null : null, unavailable_run_sha256: sourceSha === null ? trial.sha256 : null });
  const runId = isFile(resolve(folder, 'run.json')) ? sha256File(resolve(folder, 'run.json')) : artifactIdentity({ missing_run_manifest: true, terminal_sha256: trial.sha256 });
  const contract = featureContract(adapter);
  let values: Features = Object.fromEntries((contract.features as Obj[]).map(c => [c.name as string, null])), featureReasons: Obj[] = [];
  const reasons: string[] = [];
  if (sourcePath) try {
    evidence.file(sourcePath, isObject(original) ? original.sha256 as string | null : null);
    [values, featureReasons] = extract(adapter, sourcePath, options.boardReader);
  } catch (error) { reasons.push('pre-decision source invalid: ' + (error as Error).message); }
  else reasons.push('original pre-decision input is absent');
  let observation: Obj | null = null, terminal: Obj = {}, manifest = raw, valid = true;
  try {
    if (adapter === 'routing') {
      if (!options.observer) throw new Error('routing observations require the placement_outcomes.ts port');
      observation = object(await options.observer.cliObservation(evidence, trial), 'routing observation');
      if (!Array.isArray(observation.unknowns) || observation.unknowns.some(v => typeof v !== 'string')) throw new Error('routing observation unknowns must be strings');
      reasons.push(...observation.unknowns as string[]);
      manifest = evidence.read(resolve(folder, 'run.json')); terminal = evidence.read(resolve(folder, 'result.json'), trial.sha256);
    } else ({ terminal, manifest } = sealedRun(evidence, trial.path, trial.sha256));
  } catch (error) { valid = false; reasons.push('sealed observation invalid: ' + (error as Error).message); }
  valid &&= sourceSha !== null && !reasons.some(r => r.startsWith('pre-decision source invalid'));
  const elapsed = nonnegative(terminal.elapsed_s) ? terminal.elapsed_s : null;
  let targets: Obj, caseId: string | null = null, pose: string | null = null, details: Obj;
  if (adapter === 'routing') {
    const attempt = observation && isObject(observation.execution_attempt) ? observation.execution_attempt : {};
    const verifiedFailure = attempt.status === 'verified', knownControls = truthy(observation?.policy_fingerprint) || verifiedFailure;
    const policy = knownControls ? evidence.read(resolve(folder, text(trial.execution_policy, 'execution policy'))) : {};
    const budget = nonnegative(manifest.timeout_s) && number(manifest.timeout_s) > 0 ? manifest.timeout_s : null;
    const full = observation?.full_gate_success === true, native = observation && isObject(observation.native) ? observation.native : null;
    const accepted = knownControls && full && elapsed !== null && budget !== null && number(elapsed) <= number(budget);
    const quality = observation && isObject(observation.routed_quality) ? observation.routed_quality : {};
    const acceptance = full && knownControls && elapsed !== null && budget !== null ? Number(number(elapsed) <= number(budget)) : verifiedFailure ? 0 : null;
    targets = { accepted_within_budget: acceptance, owned_elapsed_s: elapsed, successful_completion_elapsed_s: full ? elapsed : null,
      native_errors: native?.errors ?? null, native_opens: native?.opens ?? null, native_parity: native?.parity ?? null,
      routed_track_length_mm: accepted ? quality.routed_track_length_mm ?? null : null, routed_via_count: accepted ? quality.routed_via_count ?? null : null };
    const added = accepted && valid ? addedTrackLength(evidence, sourcePath!, sourceSha!, quality, options.boardReader)
      : { definition: ADDED_LENGTH_DEFINITION.id, added_route_track_length_mm: null, unknowns: { added_route_track_length_mm: 'complete within-budget acceptance and known effective controls required' } };
    targets.added_route_track_length_mm = added.added_route_track_length_mm;
    caseId = typeof observation?.case_fingerprint === 'string' ? observation.case_fingerprint : null;
    pose = typeof observation?.placement_pose_fingerprint === 'string' ? observation.placement_pose_fingerprint : null;
    details = { observation: observation ?? {}, added_route_quality: added, acceptance_target_contract: ACCEPTANCE_DEFINITION,
      controls_known: knownControls, owned_run_budget_s: budget, solver_timeout_s: isObject(policy.effort) ? policy.effort.router_timeout_s ?? null : null,
      acceptance_budget_source: 'run.json:timeout_s', completion_censoring: { observed: full && elapsed !== null, elapsed_to_terminal_s: elapsed,
        terminal_status: terminal.status ?? null, cause: full ? null : 'successful completion was not observed' } };
  } else {
    targets = { run_passed: valid ? Number(terminal.status === 'passed') : null, owned_elapsed_s: elapsed };
    const context = valid ? workflowSourceContext(evidence, folder, manifest) : [];
    caseId = artifactIdentity({ manifest: workflowCase(manifest), native_sources: context });
    details = { status: terminal.status ?? null, cause: terminal.cause ?? null, predecision_native_sources: context, timing: terminal.timing ?? null,
      timing_scope: 'owned supervised operation to terminal outcome; no physical qualification' };
  }
  return { id: trial.id, family: trial.family, split: trial.split, source_fingerprint: sourceId, run_fingerprint: runId,
    case_fingerprint: caseId ?? artifactIdentity({ unverified_case: sourceId, manifest: workflowCase(raw) }), evidence_valid: valid,
    features: values, targets, ineligible_reasons: [...new Set(reasons)].sort(compare), feature_unknowns: featureReasons,
    source: { path: sourcePath, sha256: sourceSha }, run: { path: folder, result_sha256: trial.sha256 }, ...details,
    ...(pose ? { pose_fingerprint: pose } : {}) };
}

export async function buildDataset(root: string, name: string, datasetId?: string, options: AdapterOptions = {}): Promise<Dataset> {
  const [path, value] = manifest(root, name, CORPUS);
  const observer = value.adapter === 'routing' ? options.observer ?? await routingObserver() : undefined;
  options = { ...options, observer };
  const closure = await manifestDependencies(root, path, options); checkClosure(root, closure);
  const evidence = new Evidence(root); evidence.file(path);
  const rows: Obj[] = [];
  for (const trial of value.trials as CorpusTrial[]) rows.push(await row(root, trial, value.adapter, evidence, options));
  const inputs = checkClosure(root, closure);
  for (const [name, digest] of Object.entries(evidence.inputs)) {
    if (inputs[name] !== undefined && inputs[name] !== digest) throw new Error('source changed during observation: ' + name);
    inputs[name] = digest;
  }
  const contract = featureContract(value.adapter), metadata: Obj = { adapter: value.adapter, feature_contract: contract,
    source_manifest: { path, sha256: inputs[path] }, absent_inputs: Object.entries(closure).filter(([, d]) => d === null).map(([p]) => p),
    qualification: 'advisory observations only; no CAD or physical qualification' };
  if (value.adapter === 'routing') metadata.derived_targets = { added_route_track_length_mm: ADDED_LENGTH_DEFINITION, accepted_within_budget: ACCEPTANCE_DEFINITION };
  const result = finalizeDataset(root, { dataset_id: text(datasetId ?? value.dataset_id, 'dataset ID'), task: task(value.adapter),
    feature_names: (contract.features as Obj[]).map(c => c.name as string), target_specs: value.adapter === 'routing' ? ROUTING_TARGETS : WORKFLOW_TARGETS,
    rows, inputs, metadata });
  checkClosure(root, closure); return result;
}
export async function makeFeaturePacket(root: string, name: string, packetId?: string, options: AdapterOptions = {}): Promise<FeaturePacket> {
  const [path, value] = manifest(root, name, REQUEST), closure = await manifestDependencies(root, path), inputs = checkClosure(root, closure);
  const contract = featureContract(value.adapter), seen = new Set<string>();
  const rows = (value.samples as Obj[]).map(sample => {
    const id = text(sample.id, 'feature sample ID');
    if (seen.has(id)) throw new Error('feature samples require unique nonempty IDs'); seen.add(id);
    const descriptor = object(sample.source), source = resolve(root, text(descriptor.path, 'feature source path'));
    if (inputs[source] !== fingerprint(descriptor.sha256, 'feature source hash')) throw new Error('feature source changed or lacks its expected hash');
    const [features, reasons] = extract(value.adapter, source, options.boardReader);
    return { id, source: { path: source, sha256: descriptor.sha256 as string }, features, eligibility: { features: Object.values(features).every(v => v !== null), reasons } };
  });
  const result: Obj = { schema: PACKET, id: text(packetId ?? value.id, 'feature packet ID'), task: task(value.adapter),
    feature_names: (contract.features as Obj[]).map(c => c.name as string), feature_contract: contract, rows: rows.sort((a, b) => compare(a.id, b.id)), inputs };
  result.content_sha256 = artifactIdentity(result); checkClosure(root, closure); return result as FeaturePacket;
}
export function loadFeaturePacket(root: string, name: string, options: AdapterOptions = {}): FeaturePacket {
  const value = readObject(resolve(root, name));
  exactKeys(value, ['schema', 'id', 'task', 'feature_names', 'feature_contract', 'rows', 'inputs', 'content_sha256'], 'unsupported feature packet schema');
  if (value.schema !== PACKET) throw new Error('unsupported feature packet schema');
  if (artifactIdentity(without(value, 'content_sha256')) !== value.content_sha256) throw new Error('feature packet content identity mismatch');
  const inputs = assertUnchanged(root, value.inputs), adapter = object(value.feature_contract).adapter as Adapter, contract = featureContract(adapter);
  const columns = (contract.features as Obj[]).map(c => c.name as string);
  if (!same(value.feature_contract, contract) || value.task !== task(adapter) || !same(value.feature_names, columns)) throw new Error('feature packet extractor contract changed');
  if (Object.entries(codeInputs()).some(([name, digest]) => inputs[name] !== digest)) throw new Error('feature packet omits current extractor source bindings');
  if (!Array.isArray(value.rows)) throw new Error('feature packet rows must be a list');
  const seen = new Set<string>();
  for (const raw of value.rows) {
    const row = object(raw); exactKeys(row, ['id', 'source', 'features', 'eligibility'], 'feature packet rows cannot carry outcomes or undeclared fields');
    const id = text(row.id, 'feature sample ID'); if (seen.has(id)) throw new Error('feature packet sample IDs must be unique'); seen.add(id);
    const descriptor = object(row.source); exactKeys(descriptor, ['path', 'sha256'], 'feature packet source binding is malformed');
    const source = resolve(root, text(descriptor.path, 'feature source path'));
    if (inputs[source] !== descriptor.sha256) throw new Error('feature packet source is not in its bound inventory');
    if (adapter === 'routing' && boardSources(source).some(path => isFile(path) && inputs[path] !== sha256File(path))) throw new Error('feature packet omits a current board sidecar binding');
    const [measured, reasons] = extract(adapter, source, options.boardReader), expected = { features: Object.values(measured).every(v => v !== null), reasons };
    if (!same(row.features, measured) || !same(row.eligibility, expected)) throw new Error('feature packet values differ from original source extraction');
    row.features = Object.fromEntries(columns.map(name => [name, measured[name]]));
  }
  assertUnchanged(root, value.inputs); return value as FeaturePacket;
}
