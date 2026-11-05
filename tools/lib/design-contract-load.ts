// A design contract: declared requirements traced to verifiers, stage by stage. This module checks the declaration and
// its source integrity. No native or bench verdict is implied; missing future checker outputs are allowed here.
import { extname } from 'node:path';
import { evidenceFiles } from './pcb-evidence.ts';
import { readObject, sha256File } from './json-file.ts';
import { owned } from './part-native.ts';
import { compare, PyError } from './py-compat.mjs';
import { isFile, isRelativeTo, joinPath, relativeTo, resolvePath } from './py-path.ts';
import { isDict, need, type Dict } from './py-values.ts';

export const SCHEMA = 'iot-lab.design-contract.v1';
export const REPORT = 'iot-lab.design-assessment.v1';
export const STAGES = ['requirements', 'architecture', 'parts', 'schematic', 'placement', 'routing', 'prototype', 'production'];
const KINDS = ['part_selection', 'part_use', 'schematic', 'placement', 'native_gate', 'release', 'bench', 'block_qualification'];
const ALLOWED = ['schema', 'identity', 'current_stage', 'requirements', 'architecture', 'test_plans', 'failure_conditions', 'unknowns', 'checks', 'production'];
const CHECK_FIELDS = new Set(['id', 'stage', 'kind', 'requirements', 'path', 'references', 'constraint_ids', 'selectors', 'escape_evidence',
  'stock', 'orientation', 'boards', 'as-of', 'plan', 'library', 'block_id', 'binding', 'proof', 'bench']);
const REQUIREMENT_FIELDS = ['id', 'statement', 'source', 'verification_stage', 'acceptance'];
const PRODUCTION_CONTROLS = ['assembly', 'test_coverage', 'substitutions', 'lot_yield'];
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const DESIGN_ID = /^[A-Z0-9][A-Z0-9-]*$/;

/** What loading a contract needs of the parts cluster. */
export interface SourceServices {
  pdfPages: (path: string) => number;
  partDependencyFiles: (root: string, manifest: string, options: { includeNative: boolean }) => string[];
}

export const read = (path: string): Dict => readObject<Dict>(path, `expected JSON object: ${path}`);
export const relativeFile = (root: string, name: unknown): string => owned(resolvePath(root), name);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const sameKeys = (row: Dict, keys: readonly string[]): boolean => Object.keys(row).length === keys.length && keys.every(key => key in row);

export function source(root: string, descriptor: unknown, services: SourceServices, inputs?: Dict): string {
  if (!isDict(descriptor) || typeof descriptor.sha256 !== 'string') throw new Error('source requires repository-relative path, actual SHA-256 and locator');
  const path = relativeFile(root, descriptor.path);
  const digest = sha256File(path);
  if (digest !== descriptor.sha256) throw new Error(`stale source: ${String(descriptor.path)}`);
  if (extname(path).toLowerCase() === '.pdf') {
    const { page } = descriptor;
    if (!Number.isInteger(page) || (page as number) < 1 || (page as number) > services.pdfPages(path)) throw new Error('source PDF needs an actual one-based page');
  } else if (!text(descriptor.section)) {
    throw new Error('source requires a section/record locator');
  }
  if (inputs) inputs[path] = digest;
  return path;
}

/** A canonical finite range; units and conditions are never guessed or converted. */
function quantityRange(root: string, value: Dict, services: SourceServices): void {
  if (!text(value.unit)) throw new Error('quantity interval needs an explicit unit');
  const allowed = ['kind', 'min', 'max', 'unit', 'source'];
  if (Object.keys(value).some(key => !allowed.includes(key)) || (value.kind ?? 'interval') !== 'interval') {
    throw new Error('unsupported quantity interval fields/conditions; explicit reviewed model required');
  }
  const { min, max } = value;
  if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    throw new Error('quantity interval needs finite ordered min/max');
  }
  source(root, value.source, services);
}

function byId(rows: unknown, label: string): Map<string, Dict> {
  if (!Array.isArray(rows) || rows.some(row => !isDict(row) || typeof row.id !== 'string' || !STABLE_ID.test(row.id))) throw new Error(`${label} require explicit stable IDs`);
  const indexed = new Map((rows as Dict[]).map(row => [row.id as string, row]));
  if (indexed.size !== rows.length) throw new Error(`${label} IDs must be unique`);
  return indexed;
}

function checkRefs(row: Dict, requirements: ReadonlyMap<string, Dict>): void {
  const refs = row.requirements;
  if (!Array.isArray(refs) || !refs.length || new Set(refs).size !== refs.length || refs.some(ref => !requirements.has(ref))) {
    throw new Error(`exact named requirements required: ${String(row.id ?? 'None')}`);
  }
}

function checkIdentity(value: Dict): void {
  const identity = value.identity ?? {};
  if (!isDict(identity) || !sameKeys(identity, ['design_id', 'board', 'revision']) || !DESIGN_ID.test((identity.design_id as string) ?? '')
      || (identity.board !== null && !DESIGN_ID.test(identity.board as string)) || !text(identity.revision)) {
    throw new Error('exact design identity, nullable board and revision required');
  }
}

function checkRequirement(root: string, row: Dict, services: SourceServices): void {
  if (!sameKeys(row, REQUIREMENT_FIELDS)) throw new Error('unsupported requirement fields');
  if (!text(row.statement) || !STAGES.includes(row.verification_stage as string)) throw new Error('requirement needs statement and verification stage');
  source(root, row.source, services);
  const acceptance = (row.acceptance ?? {}) as Dict;
  if (acceptance.kind === 'interval') {
    quantityRange(root, acceptance, services);
  } else if (acceptance.kind === 'review' && text(acceptance.criterion)) {
    if (!sameKeys(acceptance, ['kind', 'criterion', 'source'])) throw new Error('unsupported review acceptance fields');
    source(root, acceptance.source, services);
  } else {
    throw new Error(`explicit sourced interval/review acceptance required: ${String(row.id)}`);
  }
}

function checkVerifier(root: string, row: Dict, requirements: ReadonlyMap<string, Dict>): void {
  const id = row.id as string;
  if (Object.keys(row).some(key => !CHECK_FIELDS.has(key))) throw new Error(`unsupported verifier/check fields: ${id}`);
  if (!KINDS.includes(row.kind as string) || !STAGES.includes(row.stage as string) || typeof row.path !== 'string') throw new Error(`unsupported verifier/check stage: ${id}`);
  // Resolve declared paths without requiring not-yet-produced evidence.
  if (row.path.startsWith('/') || row.path.includes('\\') || row.path.split('/').includes('..') || !isRelativeTo(resolvePath(joinPath(root, row.path)), root)) {
    throw new Error('checker path must remain inside project root');
  }
  checkRefs(row, requirements);
}

function checkPlans(root: string, value: Dict, requirements: Map<string, Dict>, checks: Map<string, Dict>, services: SourceServices): Map<string, Dict> {
  const plans = byId(value.test_plans ?? [], 'test plans');
  for (const row of plans.values()) {
    checkRefs(row, requirements);
    if (!['prototype', 'production'].includes(row.stage as string) || !text(row.method)) throw new Error('test plan needs explicit method and prototype/production stage');
    for (const name of ['procedure', 'access', 'equipment', 'failure_conditions']) source(root, row[name], services);
    const { signals } = row;
    if (!Array.isArray(signals) || !signals.length || signals.some(signal => !isDict(signal) || !signal.net)) throw new Error('test plan requires explicit signals and planned/native access');
    if ((row.check ?? null) !== null && !checks.has(row.check as string)) throw new Error('test plan names an unknown verifier');
  }
  return plans;
}

function checkUnknowns(root: string, value: Dict, checks: Map<string, Dict>, services: SourceServices): void {
  for (const row of byId(value.unknowns ?? [], 'unknowns').values()) {
    if (!row.question || !row.owner || !STAGES.includes(row.blocking_stage as string)) throw new Error('unknown needs question, owner and explicit blocking stage');
    source(root, row.source, services);
    if ((row.resolution_check ?? null) !== null && !checks.has(row.resolution_check as string)) throw new Error('unknown resolution names an unknown verifier');
  }
}

function checkFailures(root: string, value: Dict, requirements: Map<string, Dict>, plans: Map<string, Dict>, services: SourceServices): void {
  for (const row of byId(value.failure_conditions ?? [], 'failure conditions').values()) {
    checkRefs(row, requirements);
    source(root, row.source, services);
    if (!row.condition || !plans.has(row.test_plan as string)) throw new Error('failure condition needs explicit condition and named test plan');
  }
}

function checkArchitecture(root: string, value: Dict, requirements: Map<string, Dict>, services: SourceServices): void {
  const architecture = value.architecture as Dict | null | undefined;
  if (architecture === null || architecture === undefined) return;
  source(root, architecture.source, services);
  for (const name of ['interfaces', 'decisions']) {
    for (const row of byId(architecture[name] ?? [], `architecture ${name}`).values()) {
      checkRefs(row, requirements);
      source(root, row.source, services);
    }
  }
}

function checkProduction(root: string, value: Dict, checks: Map<string, Dict>, services: SourceServices): void {
  const production = value.production ?? {};
  if (!isDict(production) || Object.keys(production).some(key => !PRODUCTION_CONTROLS.includes(key))) throw new Error('unknown production control');
  for (const [name, row] of Object.entries(production)) {
    if (!isDict(row) || typeof row.required !== 'boolean') throw new Error('production control requires explicit required boolean');
    source(root, row.source, services);
    if (row.required && !checks.has(row.check as string)) throw new Error(`required production control needs actual verifier: ${name}`);
  }
}

function validated(rootPath: string, pathGiven: string, services: SourceServices): Dict {
  const root = resolvePath(rootPath), path = resolvePath(pathGiven);
  const value = read(path);
  if (!sameKeys(value, ALLOWED) || value.schema !== SCHEMA || !STAGES.includes(value.current_stage as string)) throw new Error('unsupported design contract/schema/stage');
  checkIdentity(value);
  const requirements = byId(value.requirements, 'requirements');
  if (!requirements.size) throw new Error('at least one sourced requirement required');
  for (const row of requirements.values()) checkRequirement(root, row, services);
  const checks = byId(value.checks ?? [], 'checks');
  for (const row of checks.values()) checkVerifier(root, row, requirements);
  const plans = checkPlans(root, value, requirements, checks, services);
  checkUnknowns(root, value, checks, services);
  checkFailures(root, value, requirements, plans, services);
  checkArchitecture(root, value, requirements, services);
  checkProduction(root, value, checks, services);
  return value;
}

/** A field of the wrong shape is a malformed contract, whichever access found it. */
export function loadContract(root: string, path: string, services: SourceServices): Dict {
  try {
    return validated(root, path, services);
  } catch (error) {
    const malformed = error instanceof TypeError || (error instanceof PyError && ['KeyError', 'TypeError'].includes(error.type));
    if (malformed) throw new Error(`malformed design contract field: ${error.message}`);
    throw error;
  }
}

export function requirement(root: string, path: string, identifier: string, services: SourceServices): Dict {
  const rows = new Map((loadContract(root, path, services).requirements as Dict[]).map(row => [row.id, row]));
  const row = rows.get(identifier);
  if (!row) throw new Error(`unknown design requirement: ${identifier}`);
  return structuredClone(row);
}

/** Every descriptor with a path and a hash, anywhere in a value; a hash that no longer matches is stale. */
function walkDescriptors(root: string, item: unknown, files: Set<string>): void {
  if (Array.isArray(item)) {
    for (const child of item) walkDescriptors(root, child, files);
  } else if (isDict(item)) {
    if (typeof item.path === 'string' && 'sha256' in item && !(item.exists === false && item.sha256 === null)) {
      const target = relativeFile(root, item.path);
      if (sha256File(target) !== item.sha256) throw new Error(`stale dependency: ${item.path}`);
      files.add(target);
    }
    for (const child of Object.values(item)) walkDescriptors(root, child, files);
  }
}

function addExtras(root: string, row: Dict, files: Set<string>): void {
  for (const name of ['escape_evidence', 'plan', 'binding', 'proof', 'bench']) {
    if (!row[name]) continue;
    const extra = resolvePath(joinPath(root, row[name] as string));
    if (!isFile(extra)) continue;
    files.add(extra);
    if (name !== 'escape_evidence') continue;
    for (const original of Object.keys((read(extra).inputs ?? {}) as Dict)) {
      const path = resolvePath(joinPath(root, original));
      if (isRelativeTo(path, root) && isFile(path)) files.add(path);
    }
  }
}

function addBench(root: string, row: Dict, target: string, files: Set<string>): void {
  const plan = relativeFile(root, row.plan);
  files.add(plan);
  walkDescriptors(root, read(plan), files);
  const measured = read(target);
  const descriptors = [measured.raw_data, ...((measured.instruments ?? []) as Dict[]).map(item => item.calibration_evidence)];
  const folder = target.slice(0, target.lastIndexOf('/'));
  for (const descriptor of descriptors) {
    if (!isDict(descriptor)) throw new Error('bench artifact descriptor missing');
    const artifact = resolvePath(joinPath(folder, need<string>(descriptor, 'path')));
    if (!isRelativeTo(artifact, root) || sha256File(artifact) !== descriptor.sha256) throw new Error('stale bench artifact');
    files.add(artifact);
  }
}

function addVerifier(root: string, row: Dict, target: string, files: Set<string>, services: SourceServices): void {
  const { kind } = row;
  if (kind === 'part_selection' || kind === 'part_use' || kind === 'placement') {
    for (const name of services.partDependencyFiles(root, target, { includeNative: kind !== 'part_selection' })) files.add(joinPath(root, name));
  } else if (kind === 'native_gate') {
    const folder = target.slice(0, target.lastIndexOf('/'));
    for (const name of Object.keys(evidenceFiles(folder))) files.add(joinPath(folder, name));
  } else if (kind === 'bench') {
    addBench(root, row, target, files);
  } else if (kind !== 'release') {
    // Source clauses of the actual manifest, including its exact design descriptor, travel with the candidate.
    walkDescriptors(root, read(target), files);
  }
}

/** Source, plan and check closure for isolated admission; never runs a verifier. */
export function dependencyFiles(rootPath: string, pathGiven: string, through: string | null | undefined, services: SourceServices): string[] {
  const root = resolvePath(rootPath), path = resolvePath(pathGiven);
  const value = loadContract(root, path, services);
  const stage = through || (value.current_stage as string);
  if (!STAGES.includes(stage)) throw new Error('unknown design stage');
  const files = new Set([path]);
  walkDescriptors(root, value, files);
  for (const row of (value.checks ?? []) as Dict[]) {
    if (STAGES.indexOf(row.stage as string) > STAGES.indexOf(stage)) continue;
    addExtras(root, row, files);
    const target = resolvePath(joinPath(root, row.path as string));
    if (!isFile(target)) continue;
    files.add(target);
    addVerifier(root, row, target, files, services);
  }
  return [...files].map(file => {
    if (!isRelativeTo(file, root)) throw new Error(`design dependency escapes project root: ${file}`);
    return relativeTo(file, root);
  }).sort(compare);
}
