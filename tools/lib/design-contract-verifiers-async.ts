// One adapter per declared check kind: each runs the existing verifier and merges what it read into the report.
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Evidence, qualify, verifyBench } from './block-qualification.ts';
import { read, relativeFile, type SourceServices } from './design-contract-load.ts';
import { utf8Fingerprint } from './fingerprint.ts';
import { sha256File } from './json-file.ts';
import { verify } from './pcb-evidence.ts';
import { boardConfig } from './pcb-workflow.ts';
import { jsonDumps, jsonLoad } from './py-compat.mjs';
import { isFile, joinPath, pathExists, resolvePath } from './py-path.ts';
import { need, type Dict } from './py-values.ts';

const SHA = /^[a-f0-9]{64}$/;
const INPUT_FIELDS = ['inputs', 'native_inputs', 'tool_inputs', 'reader_inputs', 'source_inputs', 'evidence_inputs'];
const IMPLEMENTATION = ['design-contract-async.ts', 'design-contract-load.ts', 'design-contract-verifiers-async.ts', 'block-qualification.ts', 'engineering-constraints.ts', 'pcb-evidence.ts', 'part-native.ts'];
const here = dirname(fileURLToPath(import.meta.url));

export interface StageRun { returncode: number; stdout: string; stderr: string }

/** The verifiers and stages this module borrows from their owners. */
export interface DesignServices extends SourceServices {
  verifySelection: (root: string, board: string, path: string) => Dict;
  verifyManifest: (root: string, board: string, path: string) => Dict;
  checkSchematic: (root: string, board: string, path: string) => Promise<Dict>;
  checkPlacement: (root: string, board: string, path: string, options: { candidate?: string | null; escapeEvidence?: string | null }) => Dict;
  reviewedContract: (root: string, board: string, path: string) => Dict;
  /** route_decision.native_inputs: repository-relative path to hash of the native project. */
  nativeInputs: (root: string, board: string) => Dict;
  generateEscapeEvidence: (policy: Dict, candidate: string, output: string) => unknown;
  requiredGateEvidence: (run: string, gate: string, result: unknown) => Dict;
  verifyCurrentInputs: (root: string, board: string, gate: string) => Promise<void>;
  readBoard: (root: string, board: string) => Dict;
  runStage: (command: string[], options: { stage: string; timeoutSeconds: number; env: NodeJS.ProcessEnv }) => Promise<StageRun>;
}

export type Report = Dict & { inputs: Dict; tool_inputs: Dict; absent_inputs: string[]; schematic_contracts: string[] };
type Check = Dict & { id: string; kind: string; stage: string; path: string; requirements: string[] };
export interface AdapterOptions { candidate?: string | null; escapeEvidence?: string | null }

export function merge(report: Report, root: string, result: Dict): void {
  for (const name of (result.absent_inputs ?? []) as string[]) {
    const path = resolvePath(joinPath(root, name));
    if (pathExists(path)) throw new Error(`stale absent verifier input appeared: ${path}`);
    report.absent_inputs.push(path);
  }
  for (const field of INPUT_FIELDS) {
    const given = result[field] ?? {};
    const entries = given instanceof Map ? [...given] : Object.entries(given as Dict);
    for (const [name, digest] of entries as [string, unknown][]) {
      const path = resolvePath(joinPath(root, name));
      if (digest === null) {
        report.absent_inputs.push(path);
        continue;
      }
      if (typeof digest !== 'string' || !SHA.test(digest)) throw new Error('verifier returned malformed input hash');
      const old = report.inputs[path] ?? digest;
      report.inputs[path] = old;
      if (old !== digest || !isFile(path) || sha256File(path) !== digest) throw new Error(`stale verifier input: ${path}`);
    }
  }
}

/** The implementation a report depends on; a change during an assessment makes it stale. */
export function captureTools(report: Report): void {
  for (const name of IMPLEMENTATION) {
    const path = joinPath(here, name);
    const digest = sha256File(path);
    const previous = report.tool_inputs[path] ?? digest;
    report.tool_inputs[path] = previous;
    if (previous !== digest) throw new Error(`stale verifier implementation changed: ${path}`);
  }
}

function invoke<T>(report: Report, run: () => T): T {
  captureTools(report);
  return run();
}

/**
 * Stable facts plus native identity; checker and result paths cannot form hash cycles. The numbers come from the file
 * itself: a plan written by another tool hashed 3.0 as a float.
 */
export function designBinding(root: string, contractPath: string, contract: Dict, services: DesignServices): string {
  const board = need<Dict>(contract, 'identity').board as string | null;
  if (!board) throw new Error('physical test evidence requires a native board identity');
  const exact = jsonLoad(contractPath) as Map<string, unknown>;
  return utf8Fingerprint({
    identity: exact.get('identity'), requirements: exact.get('requirements'), test_plans: exact.get('test_plans'), native_inputs: services.nativeInputs(root, board),
  });
}

/** Ask the existing gate collector for actual library and source dependencies. */
async function gateClosure(root: string, board: string, report: Report, services: DesignServices): Promise<void> {
  const run = await services.runStage(['node', joinPath(root, 'tools/pcb_snapshot_inputs.mjs'), root, board], {
    stage: 'design-gate-inputs', timeoutSeconds: 20, env: { ...process.env, IOT_LAB: root },
  });
  if (run.returncode) throw new Error(`gate source closure unavailable: ${run.stderr}`);
  for (const name of JSON.parse(run.stdout) as string[]) {
    const path = resolvePath(name);
    if (isFile(path)) report.inputs[path] = sha256File(path);
    else report.absent_inputs.push(path);
  }
}

function checkAcceptance(check: Check, requirements: Map<string, Dict>): void {
  for (const identifier of check.requirements) {
    const row = requirements.get(identifier) as Dict;
    const kind = (row.acceptance as Dict).kind;
    if (row.verification_stage === check.stage && ['prototype', 'production'].includes(check.stage) && (check.kind !== 'bench' || kind !== 'interval')) {
      throw new Error(`unsupported physical acceptance: CAD/review status cannot establish measured requirement ${identifier}`);
    }
  }
  const numeric = check.requirements.some(id => {
    const row = requirements.get(id) as Dict;
    return (row.acceptance as Dict).kind === 'interval' && row.verification_stage === check.stage;
  });
  if (!['schematic', 'placement', 'bench'].includes(check.kind) && numeric) {
    throw new Error('this verifier cannot establish numeric functional acceptance; use sourced schematic/placement/raw bench evidence');
  }
}

function checkPartResult(check: Check, listed: unknown, message: string): void {
  const refs = (check.references ?? []) as string[];
  const known = (listed ?? {}) as Dict;
  if (!refs.length || refs.some(ref => !(known instanceof Map ? known.has(ref) : ref in known))) throw new Error(message);
}

async function schematic(root: string, board: string, check: Check, path: string, report: Report, services: DesignServices): Promise<Dict> {
  const result = await invoke(report, () => services.checkSchematic(root, board, path));
  const descriptor = (read(path).design_contract ?? {}) as Dict;
  if (resolvePath(joinPath(root, (descriptor.path as string) ?? '')) !== report.contract || descriptor.sha256 !== report.contract_sha256) {
    throw new Error('schematic checker does not bind this exact design contract');
  }
  report.schematic_contracts.push(check.path);
  for (const identifier of check.requirements) {
    if (((result.requirement_results as Dict)?.[identifier] as Dict | undefined)?.status !== 'passed') {
      throw new Error(`schematic evidence lacks passing requirement coverage: ${identifier}`);
    }
  }
  return result;
}

/** source_set uses basenames beside the actual screened PCB, not paths relative to the project root. */
function mergeEscape(root: string, escape: string, result: Dict, report: Report): void {
  report.inputs[escape] = sha256File(escape);
  const screen = read(escape);
  const parent = dirname(need<string>(result, 'native'));
  const located = Object.fromEntries(Object.entries((screen.source_inputs ?? {}) as Dict).map(([name, digest]) => [joinPath(parent, name), digest]));
  delete screen.source_inputs;
  screen.inputs = { ...(screen.inputs as Dict ?? {}), ...located };
  merge(report, root, screen);
}

function placement(root: string, board: string, check: Check, path: string, requirements: Map<string, Dict>, report: Report, services: DesignServices, options: AdapterOptions): Dict {
  const escape = options.escapeEvidence !== null && options.escapeEvidence !== undefined ? resolvePath(options.escapeEvidence)
    : check.escape_evidence ? joinPath(root, check.escape_evidence as string) : null;
  const result = invoke(report, () => services.checkPlacement(root, board, path, { candidate: options.candidate, escapeEvidence: escape }));
  if (result.status !== 'passed') {
    merge(report, root, result);
    throw new Error(`actual placement verifier blocked: ${jsonDumps(result.blockers ?? [])}`);
  }
  if (escape !== null) mergeEscape(root, escape, result, report);
  const measurements = new Map(((result.measurements ?? []) as Dict[]).map(row => [row.id as string, row]));
  const requested = (check.constraint_ids ?? []) as string[];
  if (!requested.length || requested.some(id => !measurements.has(id))) throw new Error('placement check lacks exact measured rule IDs');
  for (const identifier of check.requirements) {
    const selected = ((check.selectors ?? {}) as Dict)[identifier] as string | undefined;
    if (selected === undefined || !requested.includes(selected)) throw new Error(`placement requirement lacks exact constraint selector: ${identifier}`);
    const row = requirements.get(identifier) as Dict, acceptance = row.acceptance as Dict;
    const measured = (measurements.get(selected) as Dict).measured_mm;
    if (acceptance.kind === 'interval' && row.verification_stage === check.stage
        && (acceptance.unit !== 'mm' || typeof measured !== 'number' || !((acceptance.min as number) <= measured && measured <= (acceptance.max as number)))) {
      throw new Error(`actual native placement measurement misses requirement interval: ${identifier}`);
    }
  }
  return result;
}

async function nativeGate(root: string, board: string, check: Check, path: string, report: Report, services: DesignServices): Promise<Dict> {
  const run = dirname(path), manifest = read(path);
  const verified = verify(run);
  const operation = (manifest.operation as string) ?? 'check';
  const actualRoot = ['build', 'edit', 'route', 'repair'].includes(operation) ? joinPath(run, 'workspace') : need<string>(manifest, 'root');
  if (need(manifest, 'board') !== board || resolvePath(actualRoot) !== resolvePath(root)) throw new Error('native run belongs to another board/workspace');
  const gate = joinPath(run, 'gate');
  const raw = services.requiredGateEvidence(run, gate, verified);
  await services.verifyCurrentInputs(root, board, gate);
  await gateClosure(root, board, report, services);
  const checks = boardConfig(root, board).cfg.get('checks') as Map<string, unknown>;
  const required = check.stage === 'schematic' ? ['erc'] : [...checks].filter(([, value]) => value !== false && value !== null).map(([name]) => name);
  const statuses = (raw.checks ?? {}) as Dict;
  if (required.some(name => (statuses[name] as Dict | undefined)?.status !== 'passed')) {
    throw new Error(`native stage evidence is missing or failed: ${[...required].sort().join(',')}`);
  }
  for (const name of (verified.get('evidence_sha256') as Map<string, unknown>).keys()) report.inputs[joinPath(run, name)] = sha256File(joinPath(run, name));
  const inputs = ((raw.provenance as Dict).inputs as Dict[]).filter(item => !(item.path as string).startsWith('external/'));
  return { status: 'passed', inputs: Object.fromEntries(inputs.map(item => [joinPath(root, item.path as string), item.sha256])) };
}

function* treeFiles(path: string): Generator<string> {
  if (!lstatSync(path).isDirectory()) {
    yield path;
    return;
  }
  for (const name of readdirSync(path)) yield* treeFiles(joinPath(path, name));
}

/** Readiness does the actual fab, native, selection, stock and orientation checks; a saved result is insufficient. */
async function release(root: string, board: string, check: Check, path: string, report: Report, services: DesignServices): Promise<Dict> {
  const folder = dirname(path);
  await services.verifyCurrentInputs(root, board, joinPath(folder, 'gate'));
  await gateClosure(root, board, report, services);
  const command = ['node', joinPath(root, 'tools/check-release-readiness.mjs'), board, folder];
  for (const name of ['stock', 'orientation', 'boards', 'as-of']) {
    if (name in check) command.push(`--${name}`, ['stock', 'orientation'].includes(name) ? resolvePath(joinPath(root, check[name] as string)) : String(check[name]));
  }
  const run = await services.runStage(command, { stage: 'design-release-readiness', timeoutSeconds: 90, env: { ...process.env, IOT_LAB: root } });
  const result = JSON.parse(run.stdout) as Dict;
  if (run.returncode || result.status !== 'ready_for_user_review') throw new Error(`existing release-readiness checks blocked: ${jsonDumps(result.findings ?? result)}`);
  report.temporal_context ??= [];
  (report.temporal_context as Dict[]).push({
    check: check.id, order_day_utc: need(result, 'order_day_utc'), requires_current_day: !('as-of' in check), scope: 'order_preparation_observation',
  });
  // Retain all original candidate and order-review sources, not only the top-level passed result.
  const extras = ['stock', 'orientation'].filter(name => name in check).map(name => resolvePath(joinPath(root, check[name] as string)));
  for (const target of [folder, ...extras]) {
    for (const file of treeFiles(target)) if (statSync(file).isFile()) report.inputs[resolvePath(file)] = sha256File(file);
  }
  result.status = 'passed';
  return result;
}

function blockQualification(root: string, check: Check, report: Report): Dict {
  if (['library', 'block_id', 'binding', 'proof', 'bench'].some(name => !check[name])) {
    throw new Error('block qualification needs original binding/proof/raw bench inputs, not a declared receipt status');
  }
  const result = invoke(report, () => qualify(joinPath(root, check.library as string), check.block_id as string, relativeFile(root, check.binding), relativeFile(root, check.proof), root, relativeFile(root, check.bench)));
  if (result.level !== 2) throw new Error('actual original block bench verification incomplete');
  return { ...result, status: 'passed' };
}

function checkBenchTests(check: Check, plan: Dict, contract: Dict): void {
  const tests = (plan.tests ?? []) as Dict[];
  for (const identifier of check.requirements) {
    const acceptance = ((contract.requirements as Dict[]).find(row => row.id === identifier) as Dict).acceptance as Dict;
    const selected = tests.filter(test => test.requirement === identifier);
    if (acceptance.kind !== 'interval' || !selected.length || selected.some(test =>
      ['min', 'max', 'unit'].some(key => test[key] !== acceptance[key])
      || ['path', 'sha256'].some(key => ((test.source ?? {}) as Dict)[key] !== (acceptance.source as Dict)[key]))) {
      throw new Error(`raw bench tests must match exact sourced requirement interval: ${identifier}`);
    }
  }
}

function bench(root: string, contract: Dict, check: Check, path: string, report: Report, services: DesignServices): Dict {
  const planPath = relativeFile(root, check.plan);
  const plan = read(planPath);
  const binding = designBinding(root, report.contract as string, contract, services);
  if (plan.binding_sha256 !== binding) throw new Error('bench plan does not bind exact design/native facts');
  checkBenchTests(check, plan, contract);
  const evidence = new Evidence();
  const proof = { bench_plan: { path: planPath, sha256: sha256File(planPath) } };
  const tested = invoke(report, () => verifyBench(path, proof, binding, evidence, root));
  return { status: 'passed', evidence_inputs: evidence.files, bench: tested };
}

function selection(root: string, contract: Dict, check: Check, path: string, report: Report, services: DesignServices): Dict {
  const identity = contract.identity as Dict;
  if (read(path).revision !== identity.revision) throw new Error('part selection must bind this exact design revision');
  const result = invoke(report, () => services.verifySelection(root, (identity.board ?? identity.design_id) as string, path));
  checkPartResult(check, result.selections, 'part selection needs exact reviewed planned references');
  return result;
}

export async function adapter(root: string, contract: Dict, check: Check, report: Report, services: DesignServices, options: AdapterOptions = {}): Promise<Dict> {
  const board = (contract.identity as Dict).board as string;
  const { kind } = check;
  if (!board && kind !== 'part_selection') throw new Error('this verifier requires configured native CAD');
  const path = relativeFile(root, check.path);
  report.inputs[path] = sha256File(path);
  const requirements = new Map((contract.requirements as Dict[]).map(row => [row.id as string, row]));
  checkAcceptance(check, requirements);
  let result: Dict;
  if (kind === 'part_selection') {
    result = selection(root, contract, check, path, report, services);
  } else if (kind === 'part_use') {
    result = invoke(report, () => services.verifyManifest(root, board, path));
    checkPartResult(check, result.bindings, 'part check needs exact reviewed native references');
  } else if (kind === 'schematic') {
    result = await schematic(root, board, check, path, report, services);
  } else if (kind === 'placement') {
    result = placement(root, board, check, path, requirements, report, services, options);
  } else if (kind === 'native_gate') {
    result = await nativeGate(root, board, check, path, report, services);
  } else if (kind === 'release') {
    result = await release(root, board, check, path, report, services);
  } else if (kind === 'block_qualification') {
    result = blockQualification(root, check, report);
  } else {
    result = bench(root, contract, check, path, report, services);
  }
  merge(report, root, result);
  if (result.status !== 'passed') throw new Error(`actual ${kind} verifier blocked: ${jsonDumps(result.blockers ?? [])}`);
  const scope = kind === 'bench' || kind === 'block_qualification' ? 'current_raw_measurements' : `current_${kind}_evidence`;
  const checked: Dict = { status: 'passed', kind, path: check.path, requirements: check.requirements, scope };
  if (kind === 'part_selection') Object.assign(checked, { native_verified: false, cad_verified: false, stock_current: false });
  return checked;
}

/** Manufacturing facts require applicable verifiers, not CAD or voltage reuse. */
export function productionControls(contract: Dict): Dict[] {
  const blockers: Dict[] = [];
  const production = (contract.production ?? {}) as Dict;
  for (const name of ['assembly', 'test_coverage', 'substitutions', 'lot_yield']) {
    const row = production[name] as Dict | undefined;
    if (row === undefined || row === null) {
      blockers.push({ code: 'production_scope', detail: `Explicit sourced required/not-required control needed: ${name}`, stage: 'production', control: name });
    } else if (row.required) {
      blockers.push({
        code: 'unsupported_production_control',
        detail: `No supported original manufactured-population/control verifier for ${name}; CAD/fab readiness, selected native parts or unrelated raw bench values cannot establish this control`,
        stage: 'production', control: name, check: row.check ?? null,
      });
    }
  }
  return blockers;
}

export function dftAccess(root: string, contract: Dict, report: Report, services: DesignServices): Dict[] {
  const blockers: Dict[] = [];
  const plans = contract.test_plans as Dict[], board = (contract.identity as Dict).board as string | null;
  const needed = (contract.requirements as Dict[]).filter(row => ['prototype', 'production'].includes(row.verification_stage as string)).map(row => row.id as string);
  const covered = new Set(plans.flatMap(plan => plan.requirements as string[]));
  const uncovered = needed.filter(id => !covered.has(id)).sort();
  if (!plans.length || uncovered.length) {
    blockers.push({ code: 'dft_coverage', detail: 'DFT plans must cover future physical acceptance before layout', stage: 'placement', requirements: uncovered });
  }
  if (!board) return [...blockers, { code: 'native_design_missing', detail: 'Native CAD and physical test access required before placement', stage: 'placement' }];
  const native = services.readBoard(root, board);
  merge(report, root, native);
  const parts = native.parts as Map<string, Dict>;
  for (const plan of plans) {
    for (const signal of plan.signals as Dict[]) {
      const pads = parts.get(signal.ref as string)?.pad_net_map as Dict | Map<string, unknown> | undefined;
      const net = pads instanceof Map ? pads.get(String(signal.pad)) : pads?.[String(signal.pad)];
      if (net !== signal.net) {
        blockers.push({ code: 'dft_native_access', detail: 'DFT signal requires exact actual native pad/net endpoint', stage: 'placement', test_plan: plan.id, signal });
      }
    }
  }
  return blockers;
}
