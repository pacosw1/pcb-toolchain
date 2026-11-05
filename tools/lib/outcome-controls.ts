// Execution controls of a routing trial: what actually ran, against what its policy claims.
import { basename } from 'node:path';
import { errorText } from './cli.ts';
import { identity, sha256Text } from './fingerprint.ts';
import { parseIso } from './iso-time.ts';
import { sha256File } from './json-file.ts';
import { asDict, finite, type Evidence } from './outcome-evidence.ts';
import { compare, jsonCanonical, lexists, splitlines } from './py-compat.mjs';
import { isRelativeTo, joinPath, relativeTo, resolvePath, textOf, withSuffix } from './py-path.ts';
import { isDict, need, sameValue, type Dict } from './py-values.ts';

export const POLICY = 'iot-lab.placement-outcome-execution.v1';
export const ATTEMPT = 'iot-lab.verified-routing-execution-attempt.v1';
const SHA = /^[0-9a-f]{64}$/;
const IMAGE = /^sha256:[0-9a-f]{64}$/;
const PROJECT_EXTENSIONS = ['.kicad_pcb', '.kicad_pro', '.kicad_dru', '.kicad_sch'];
const WORKERS = ['global_rayon_threads', 'autorouter_workers', 'optimizer_workers'];
const THERMAL_CHECKBACK = '--native-thermal-checkback';
const POLICY_V2 = 'iot-lab.routing-policy.v2';
const ROUTING_POLICIES = ['iot-lab.routing-policy.v1', POLICY_V2];

/** Owned by the routing family: raw native thermal proof, reopened from its receipts. */
export interface ThermalServices {
  discharge: (capability: Dict, candidate: string, receipts: { fillReceipt: string; drcReceipt: string }) => Dict;
  validateCapability: (capability: Dict, source: string, base: string, options: { selectedNets: unknown }) => Dict;
}

export interface Trial extends Dict { execution_policy?: string; placement_input?: Dict }

/** The inputs of a run and what a check needs of them. */
export interface RunContext {
  evidence: Evidence;
  folder: string;
  trial: Trial;
  manifest: Dict;
  source: Dict;
  thermal: ThermalServices;
}

const jsonLines = (path: string): Dict[] => splitlines(textOf(path)).filter(line => line.trim()).map(line => JSON.parse(line) as Dict);
const isShaText = (value: unknown): boolean => typeof value === 'string' && SHA.test(value);
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

/** The producer's argv hash uses ordered JSON, unlike object identities. */
export const identityCommand = (command: unknown): string => sha256Text(jsonCanonical(command, { sort: false }));

function mergeThermalInputs(evidence: Evidence, inputs: Dict, label: string): void {
  for (const [name, digest] of Object.entries(inputs)) {
    if (digest !== null) {
      evidence.file(name, digest as string);
      continue;
    }
    if (lexists(name)) throw new Error(`absent native ${label} input appeared`);
    evidence.inputs.set(name, null);
  }
}

function ownedRecord(run: RunContext, obligation: Dict, key: string, name: string): Dict {
  const descriptor = obligation[key] ?? {};
  if (!isDict(descriptor) || descriptor.path !== `operation/router/${name}` || !isShaText(descriptor.sha256)) {
    throw new Error(`native thermal ${key} lacks an owned sealed binding`);
  }
  return run.evidence.read(joinPath(run.folder, 'operation/router', name), descriptor.sha256 as string);
}

function checkThermalLineage(run: RunContext, snapshot: Dict, initial: Dict, final: Dict, recordedRouter: string, original: string, expected: Map<string, string>, candidateSha: string): void {
  const relative = `hardware-design/boards/${need<string>(run.manifest, 'board')}/${need<string>(run.manifest, 'project')}`;
  const captured = joinPath(recordedRouter, 'native-thermal-source', basename(`${relative}.kicad_pcb`));
  const digest = expected.get('.kicad_pcb');
  const byExtension = (path: string) => Object.fromEntries([...expected].map(([extension, sha]) => [withSuffix(path, extension), sha]));
  if (snapshot.schema !== 'iot-lab.native-thermal-source.v1'
      || !sameValue(snapshot.original, { path: original, sha256: digest }) || !sameValue(snapshot.captured, { path: captured, sha256: digest })
      || !sameValue(snapshot.original_files, byExtension(original)) || !sameValue(snapshot.inputs, byExtension(captured))
      || !sameValue(initial.source, snapshot.captured) || !isDict(initial.base)
      || initial.base.path !== joinPath(recordedRouter, 'base.kicad_pcb')
      || !sameValue(final.candidate, { path: joinPath(recordedRouter, 'routed.kicad_pcb'), sha256: candidateSha })) {
    throw new Error('native thermal captured source or candidate lineage differs from the actual trial');
  }
}

/** Revalidate the sealed opt-in obligation before exposing a routing label. Returns what is missing, if anything. */
function nativeThermalControls(run: RunContext, policy: Dict, candidate: string | null, placementSha256: string | null | undefined): string | null {
  const { evidence, folder, trial, manifest, source } = run;
  const spec = manifest.spec ?? {};
  const requested = isDict(spec) && spec.thermal_verification === 'native-checkback';
  const effort = policy.effort ?? {}, controls = policy.controls ?? {};
  if (!isDict(effort) || !isDict(controls)) throw new Error('native thermal execution controls are malformed');
  const declared = effort.thermal_verification ?? null;
  const obligation = controls.native_thermal_obligations ?? null;
  if (isDict(spec) && ('thermal_verification' in spec || spec.schema === POLICY_V2) && !requested) throw new Error('unknown native thermal route specification');
  if (!requested) {
    if (declared !== null || obligation !== null || (Array.isArray(policy.command) && policy.command.includes(THERMAL_CHECKBACK))) {
      throw new Error('native thermal execution was not explicitly selected by the route spec');
    }
    return null;
  }
  if ((spec as Dict).schema !== POLICY_V2 || declared !== 'native-checkback') throw new Error('native thermal route specification and execution policy differ');
  if (!isDict(obligation) || obligation.status !== 'passed') return 'native thermal obligation is pending, missing or unfulfilled';
  if (candidate === null) throw new Error('native thermal discharge has no exact configured-gate candidate');
  const command = policy.command ?? [];
  if (!stringList(command) || command.length < 4 || command.filter(item => item === THERMAL_CHECKBACK).length !== 1) throw new Error('native thermal producer invocation is missing');
  const recordedRouter = command[3] as string;
  if (!recordedRouter.startsWith('/')) throw new Error('native thermal router evidence owner is unresolved');
  const initial = ownedRecord(run, obligation, 'initial', 'native-thermal-initial.json');
  const final = ownedRecord(run, obligation, 'final', 'native-thermal-final.json');
  const snapshot = ownedRecord(run, obligation, 'source_snapshot', 'native-thermal-source.json');
  const descriptor = obligation.candidate ?? {};
  if (!isDict(descriptor) || descriptor.path !== 'operation/router/routed.kicad_pcb' || descriptor.sha256 !== sha256File(candidate)) {
    throw new Error('native thermal candidate differs from the configured gate candidate');
  }
  evidence.file(joinPath(folder, 'operation/router/routed.kicad_pcb'), descriptor.sha256 as string);
  const relative = `hardware-design/boards/${need<string>(manifest, 'board')}/${need<string>(manifest, 'project')}`;
  const files = asDict(source.files);
  // The observation resolves and seals a continued parent first; source.json still describes the canonical CAD snapshot.
  const expected = new Map(PROJECT_EXTENSIONS.map(extension => [extension, (extension === '.kicad_pcb' ? placementSha256 : files[relative + extension]) as string]));
  const placement = trial.placement_input ?? {};
  if ([...expected.values()].some(digest => !isShaText(digest)) || !isDict(placement) || expected.get('.kicad_pcb') !== placement.sha256) {
    throw new Error('native thermal source lacks the original four-file placement binding');
  }
  checkThermalLineage(run, snapshot, initial, final, recordedRouter, command[2] as string, expected, descriptor.sha256 as string);
  const checked = run.thermal.discharge(initial, joinPath(recordedRouter, 'routed.kicad_pcb'), {
    fillReceipt: joinPath(recordedRouter, 'native-thermal-final-fill.json'), drcReceipt: joinPath(recordedRouter, 'native-thermal-final-drc.json'),
  });
  if (!sameValue(checked, final)) throw new Error('native thermal final receipt differs from independent raw-evidence validation');
  mergeThermalInputs(evidence, asDict(checked.inputs), 'thermal');
  return null;
}

function checkPolicyShape(runtime: Dict, resources: Dict, effort: Dict): void {
  const tools = runtime.tools;
  if (!IMAGE.test((runtime.image_id as string) ?? '') || !isDict(tools) || !Object.keys(tools).length
      || Object.values(tools).some(tool => !isShaText(asDict(tool).sha256 ?? '') || !asDict(tool).version)
      || ['cpus', 'memory_bytes', 'threads'].some(key => !finite(resources[key]) || (resources[key] as number) <= 0)
      || ['timeout_s', 'passes'].some(key => !finite(effort[key]) || (effort[key] as number) <= 0)
      || !finite(effort.max_repairs) || !effort.optimizer) {
    throw new Error('execution policy lacks actual runtime/resource/effort controls');
  }
}

function checkSolverControls(run: RunContext, value: Dict): string | null {
  const { evidence, folder } = run;
  const controls = asDict(value.controls);
  if (controls.effective_configuration_verified !== true) return 'solver effective execution controls are incomplete or unverified';
  const context = asDict(value.execution_context);
  const retained = resolvePath(joinPath(folder, (context.path as string) ?? ''));
  const configurations = controls.effective_configurations;
  if (!isRelativeTo(retained, joinPath(folder, 'operation')) || !isShaText(context.sha256 ?? '') || !isShaText(controls.input_manifest_sha256 ?? '')
      || !isDict(configurations) || !Object.keys(configurations).length) {
    throw new Error('solver controls lack sealed execution context or effective configuration bindings');
  }
  evidence.file(retained, context.sha256 as string);
  evidence.file(joinPath(folder, 'operation/router/input-manifest.json'), controls.input_manifest_sha256 as string);
  for (const [name, digest] of Object.entries(configurations)) {
    if (basename(name) !== name || !isShaText(digest)) throw new Error('solver effective configuration binding is malformed');
    evidence.file(joinPath(folder, 'operation/router', name), digest as string);
  }
  return null;
}

export type PolicyResult = [fingerprint: string | null, missing: string | null];

/** The claimed budget cannot hide a different actual route spec or tool implementation. Placement poses may differ. */
function actualIdentity(run: RunContext, gate: Dict): { actual: Dict; complete: boolean } {
  const { manifest, source, folder, evidence } = run;
  const exact = evidence.exact(joinPath(folder, 'run.json'));
  const files = asDict(source.files);
  const tools = Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith('tools/')));
  const gateTools = asDict(gate.provenance).tools ?? null;
  const strategy = asDict(asDict(asDict(manifest.plan).content).choice).strategy ?? null;
  const actual: Dict = {
    operation: manifest.operation ?? null, kind: manifest.kind ?? null, router: manifest.router ?? 'explicit', spec: exact.get('spec') ?? null,
    repair_strategy: strategy, source_tools: tools, gate_tools: gateTools, gate_policy: manifest.gate_config_sha256 ?? null,
    configured_checks: Object.keys(asDict(gate.checks)).sort(compare),
  };
  const complete = Object.keys(tools).length > 0 && Boolean(actual.gate_policy) && (!Object.keys(gate).length || Boolean(gateTools));
  return { actual, complete };
}

export interface PolicyOptions { candidate?: string | null; placementSha256?: string | null; verifyAcceptance?: boolean }

export function executionPolicy(run: RunContext, gate: Dict, { candidate = null, placementSha256 = null, verifyAcceptance = true }: PolicyOptions = {}): PolicyResult {
  const { evidence, folder, trial, manifest } = run;
  const name = trial.execution_policy;
  if (!name) return [null, 'execution policy/runtime/resource evidence is absent'];
  const path = resolvePath(joinPath(folder, name));
  if (!isRelativeTo(path, joinPath(folder, 'operation'))) throw new Error('execution policy must belong to sealed operation evidence');
  const value = evidence.read(path);
  if (value.schema !== POLICY) throw new Error('unsupported execution policy receipt');
  checkPolicyShape(asDict(value.runtime), asDict(value.resources), asDict(value.effort));
  if (manifest.router === 'fastroute') {
    const unverified = checkSolverControls(run, value);
    if (unverified) return [null, unverified];
    if (verifyAcceptance) {
      const missing = nativeThermalControls(run, value, candidate, placementSha256);
      if (missing) return [null, missing];
    }
  }
  const starts = jsonLines(evidence.file(joinPath(folder, 'operation/events.jsonl')));
  if (!starts.some(row => row.type === 'tool.start' && sameValue(row.command, value.command))) {
    throw new Error('execution policy command differs from the recorded actual invocation');
  }
  const { actual, complete } = actualIdentity(run, gate);
  if (!complete) return [null, 'actual source-tool, gate policy or native-tool identities are absent'];
  const exact = evidence.exact(path);
  return [identity({ runtime: exact.get('runtime') ?? {}, resources: exact.get('resources') ?? {}, effort: exact.get('effort') ?? {}, actual }), null];
}

/** The router folder as it was recorded, mapped onto this archive. */
class RouterArchive {
  readonly local: string;
  readonly recorded: string;
  private readonly evidence: Evidence;

  constructor(evidence: Evidence, folder: string, recorded: string) {
    this.evidence = evidence;
    this.local = joinPath(folder, 'operation/router');
    this.recorded = recorded;
  }

  owned(name: string, expected?: string | null): string {
    if (!isRelativeTo(name, this.recorded)) throw new Error('execution evidence escapes its router owner');
    const local = resolvePath(joinPath(this.local, relativeTo(name, this.recorded)));
    if (!isRelativeTo(local, resolvePath(this.local))) throw new Error('execution evidence escapes its archive');
    return this.evidence.file(local, expected);
  }
}

function checkFailureEnd(terminal: Dict, operation: Dict, placementSha256: string | null | undefined): void {
  if (!placementSha256 || terminal.source_unchanged !== true || operation.status !== 'failed' || asDict(terminal.cleanup).complete !== true) {
    throw new Error('failed attempt lacks intact source, terminal failure or confirmed cleanup');
  }
}

function checkFailureExit(controls: Dict, command: unknown, operation: Dict, terminal: Dict): void {
  const code = controls.tool_exit;
  if (controls.status !== 'observed' || !Number.isInteger(code) || code === 0 || operation.tool_exit !== code
      || !Array.isArray(command) || command.length < 4 || !Number.isInteger(operation.exit_code) || operation.exit_code === 0
      || terminal.exit_code !== operation.exit_code || !stringList(command)) {
    throw new Error('failed attempt lacks finalized observed controls and a matching nonzero tool exit');
  }
}

function checkFailureBudget(spec: unknown, manifest: Dict, effort: Dict, resources: Dict, terminal: Dict): asserts spec is Dict {
  const budget = manifest.timeout_s;
  if (!isDict(spec) || !ROUTING_POLICIES.includes(spec.schema as string) || !finite(budget) || budget <= 0 || effort.timeout_s !== budget || !finite(terminal.elapsed_s)
      || ['passes', 'max_repairs', 'optimizer'].some(key => spec[key] !== effort[key]) || spec.threads !== resources.threads || spec.timeout_s !== effort.router_timeout_s
      || ['layers', 'only_nets'].some(key => !stringList(spec[key]) || !(spec[key] as string[]).length || (spec[key] as string[]).some(item => !item))) {
    throw new Error('failed attempt budget/specification differs from its observed controls');
  }
}

function checkFailureInputs(policy: Dict, manifest: Dict, source: Dict, native: string, command: string[], placementSha256: string): void {
  const relative = `hardware-design/boards/${need<string>(manifest, 'board')}/${need<string>(manifest, 'project')}`;
  const inputs = asDict(policy.inputs), files = asDict(source.files);
  const expected = ['.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_dru'].map(extension =>
    [withSuffix(native, extension), extension === '.kicad_pcb' ? placementSha256 : files[relative + extension]] as const);
  if (expected.some(([name, digest]) => !isShaText(digest) || inputs[name] !== digest)
      || inputs[command[1] as string] !== (files['tools/fastroute_job.py'] ?? null) || !files['tools/fastroute_job.py']
      || files[`hardware-design/boards/${String(manifest.board)}/gate.json`] !== manifest.gate_config_sha256) {
    throw new Error('failed attempt source/tool/gate-policy binding differs from the original input');
  }
}

function checkFailureContext(evidence: Evidence, folder: string, policy: Dict, runtime: Dict, resources: Dict): void {
  const recorded = asDict(policy.execution_context);
  const text = textOf(evidence.file(joinPath(folder, need<string>(recorded, 'path')), need<string>(recorded, 'sha256')));
  let context: unknown = JSON.parse(text);
  if (Array.isArray(context) && context.length === 1) context = context[0];
  if (!isDict(context)) throw new Error('failed attempt execution context is ambiguous');
  if (!isDict(context.HostConfig)) throw new Error('failed attempt lacks the original container resource receipt');
  const host = context.HostConfig;
  if (context.Image !== runtime.image_id || context.Id !== (recorded.container_id ?? null) || host.NetworkMode !== 'none'
      || host.Memory !== resources.memory_bytes || host.NanoCpus !== (resources.cpus as number) * 1_000_000_000) {
    throw new Error('failed attempt runtime/resources differ from the retained execution context');
  }
}

function checkFailureLaunch(evidence: Evidence, folder: string, command: string[], code: unknown, manifest: Dict, terminal: Dict): void {
  const events = jsonLines(evidence.file(joinPath(folder, 'operation/events.jsonl')));
  const starts = events.filter(row => row.type === 'tool.start' && sameValue(row.command, command));
  const start = starts[0];
  if (starts.length !== 1 || !start?.span_id) throw new Error('failed attempt actual launch is missing or ambiguous');
  const exits = events.filter(row => row.type === 'tool.exit' && row.span_id === start.span_id);
  const end = exits.length === 1 ? exits[0]?.ended_unix_s : null, began = start.started_unix_s;
  const created = parseIso(need<string>(manifest, 'created_at'));
  const stop = terminal.ended_unix_s;
  if (exits.length !== 1 || exits[0]?.code !== code || exits[0]?.status !== 'failed' || !created.zoned || !finite(began) || !finite(end) || end < began
      || !finite(stop) || !(created.seconds <= began && began <= end && end <= stop)) {
    throw new Error('failed attempt termination is missing, ambiguous or outside its owned run');
  }
}

/** The configuration a controlled router must have recorded for this spec. */
const expectedConfiguration = (spec: Dict, native: string, router: string): Dict => ({
  board: native, outdir: router, passes: spec.passes, layers: (spec.layers as string[]).join(','), only_nets: (spec.only_nets as string[]).join(','),
  threads: spec.threads, max_time: spec.timeout_s, optimizer: spec.optimizer, preflight: true, skip_net: '', plane_nets: '', gnd_vias: false,
  route_planes: false, unlock_nets: '', set: [], neck_um: 0, native_thermal_checkback: spec.thermal_verification === 'native-checkback',
});

/** A missing native_thermal_checkback reads as false, any other missing key as absent. */
const configurationDiffers = (actual: Dict, expected: Dict): boolean => Object.entries(expected).some(([key, value]) =>
  !sameValue(actual[key] ?? (key === 'native_thermal_checkback' ? false : null), value));

function checkFailureManifest(actual: Dict, expected: Dict, backend: Dict, effort: Dict, runtime: Dict, placementSha256: string): void {
  const features = Object.fromEntries(Object.entries(asDict(actual.features)).filter(([key]) => key !== '_board_dir'));
  if (actual.board_sha256 !== placementSha256 || actual.router_sha256 !== (asDict(asDict(runtime.tools).router).sha256 ?? null)
      || (backend.binary_sha256 ?? null) !== (actual.router_sha256 ?? null) || !Object.keys(backend).length
      || configurationDiffers(asDict(actual.configuration), expected) || !sameValue(features, effort.feature_policy)) {
    throw new Error('failed attempt effective input/backend configuration differs from its policy');
  }
}

function backendOption(invocation: string[], key: string): string {
  const values = invocation.slice(0, -1).flatMap((item, index) => item === key ? [invocation[index + 1] as string] : []);
  values.push(...invocation.filter(item => item.startsWith(`${key}=`)).map(item => item.slice(key.length + 1)));
  if (values.length !== 1) throw new Error(`failed attempt backend option is missing or ambiguous: ${key}`);
  return values[0] as string;
}

function checkBackendArgv(invocation: string[], spec: Dict): void {
  const asInt = (key: string): number => {
    const text = backendOption(invocation, key);
    if (!/^\s*[+-]?\d+\s*$/.test(text)) throw new Error(`invalid literal for int() with base 10: '${text}'`);
    return Number(text);
  };
  if (asInt('-mp') !== spec.passes || Number(backendOption(invocation, '--max-time')) !== spec.timeout_s
      || ['--router.autorouter.max_threads', '--router.optimizer.max_threads'].some(key => asInt(key) !== spec.threads)
      || (spec.optimizer === 'off' && backendOption(invocation, '--router.optimizer.enabled') !== 'false')) {
    throw new Error('failed attempt actual backend argv differs from its effort/worker budget');
  }
}

function checkPendingThermal(run: RunContext, router: RouterArchive, coverage: Dict, spec: Dict, placementSha256: string): void {
  const { evidence, thermal } = run;
  const initial = evidence.read(joinPath(router.local, 'native-thermal-initial.json'));
  const source = router.owned(need<string>(need(initial, 'source'), 'path')), base = router.owned(need<string>(need(initial, 'base'), 'path'));
  const checked = thermal.validateCapability(initial, source, base, { selectedNets: spec.only_nets });
  mergeThermalInputs(evidence, need<Dict>(checked, 'inputs'), 'admission');
  const obligations = [{ constraint: 'min_resolved_spokes', required_count: String(initial.required_count ?? 'None'), capability_sha256: initial.content_sha256 ?? null }];
  if (initial.schema !== 'iot-lab.native-thermal-capability.v1' || initial.status !== 'pending_native'
      || !sameValue(initial.selected_nets, [...spec.only_nets as string[]].sort(compare)) || !sameValue(coverage.native_thermal_capability, initial)
      || coverage.model_status !== 'partial' || asDict(initial.source).sha256 !== placementSha256 || !sameValue(coverage.native_postconditions, obligations)) {
    throw new Error('failed attempt pending rule admission lacks its original native capability');
  }
}

interface StageContext {
  run: RunContext;
  router: RouterArchive;
  spec: Dict;
  backend: Dict;
  expected: Dict;
  binary: unknown;
  inputs: Dict;
  routerSha: unknown;
  stages: Dict[];
  thermal: boolean;
  placementSha256: string;
}

function checkFailureStage(context: StageContext, name: string, digest: string): string[] {
  const { run, router, spec, backend, expected, binary, inputs, routerSha, stages, thermal, placementSha256 } = context;
  const effective = run.evidence.read(joinPath(router.local, name), digest);
  const worker = asDict(effective.backend_resources);
  if (configurationDiffers(asDict(effective.configuration), expected)
      || Object.entries(backend).some(([key, value]) => !sameValue(asDict(effective.backend_policy)[key], value))
      || WORKERS.some(key => worker[key] !== spec.threads)) {
    throw new Error('failed attempt backend stage changed its effective controls');
  }
  const invocation = effective.command;
  const binding = asDict(effective.rule_coverage);
  const coverage = JSON.parse(textOf(router.owned((binding.path as string) ?? '', binding.sha256 as string | undefined))) as Dict;
  const pending = coverage.status === 'pending_native';
  if (coverage.solver_launch_allowed !== true || !(coverage.status === 'passed' || (thermal && pending))
      || !sameValue(coverage.active_nets, spec.only_nets) || !sameValue(coverage.job_layers, spec.layers)
      || !sameValue(coverage.backend_command, invocation) || coverage.backend_command_sha256 !== identityCommand(invocation)) {
    throw new Error('failed attempt backend stage lacks exact rule admission');
  }
  if (pending) checkPendingThermal(run, router, coverage, spec, placementSha256);
  const dsn = asDict(coverage.dsn);
  router.owned((dsn.path as string) ?? '', dsn.sha256 as string | undefined);
  const argv = invocation as string[];
  const model = Array.isArray(invocation) ? argv.indexOf('-de') : -1;
  if (effective.dsn_sha256 !== (dsn.sha256 ?? null) || !Array.isArray(invocation) || argv.filter(item => item === '-de').length !== 1
      || model + 1 >= argv.length || argv[model + 1] !== (dsn.path ?? null)) {
    throw new Error('failed attempt backend did not use its admitted DSN');
  }
  if (!argv.length || argv[0] !== binary || inputs[binary as string] !== routerSha
      || argv.filter(item => item === '--quality-first').length !== Number(backend.mode === 'quality-first')) {
    throw new Error('failed attempt actual backend executable differs from its recorded runtime');
  }
  checkBackendArgv(argv, spec);
  const ran = stages.filter(row => sameValue(row.command, argv));
  const only = ran[0];
  if (ran.length !== 1 || only?.status !== 'complete' || !Number.isInteger(only.returncode) || asDict(only.cleanup).complete !== true) {
    throw new Error('failed attempt backend launch/termination/cleanup is unconfirmed');
  }
  return argv;
}

function checkNoExtraStages(stages: Dict[], configured: string[][], binary: unknown): void {
  const isBackend = (row: Dict): boolean => String(row.stage ?? '').startsWith('router')
    || (Array.isArray(row.command) && row.command.length > 0 && row.command[0] === binary && !sameValue(row.command, [binary, '--help']));
  const actual = stages.filter(isBackend).map(row => identityCommand(row.command ?? null)).sort(compare);
  if (!sameValue(actual, configured.map(identityCommand).sort(compare))) throw new Error('failed attempt has unconfigured or duplicate actual backend stages');
}

export interface Attempt extends Dict { status: string; fingerprint: string | null; cause?: string }

function verifiedFingerprint(run: RunContext, terminal: Dict, operation: Dict, placementSha256: string | null | undefined): string {
  const { evidence, folder, trial, manifest, source } = run;
  checkFailureEnd(terminal, operation, placementSha256);
  const sha = placementSha256 as string;
  const [, missing] = executionPolicy(run, {}, { placementSha256: sha, verifyAcceptance: false });
  if (missing) throw new Error(missing);
  const policyPath = joinPath(folder, need<string>(trial, 'execution_policy'));
  const policy = evidence.read(policyPath);
  const controls = asDict(policy.controls), effort = need<Dict>(policy, 'effort'), runtime = need<Dict>(policy, 'runtime'), resources = need<Dict>(policy, 'resources');
  checkFailureExit(controls, policy.command, operation, terminal);
  const command = policy.command as string[];
  const native = command[2] as string, recordedRouter = command[3] as string;
  if (!native.startsWith('/') || !recordedRouter.startsWith('/')) throw new Error('failed attempt evidence owners are unresolved');
  const router = new RouterArchive(evidence, folder, recordedRouter);
  const spec = manifest.spec ?? {};
  checkFailureBudget(spec, manifest, effort, resources, terminal);
  checkFailureInputs(policy, manifest, source, native, command, sha);
  checkFailureContext(evidence, folder, policy, runtime, resources);
  checkFailureLaunch(evidence, folder, command, controls.tool_exit, manifest, terminal);
  const actual = evidence.read(joinPath(router.local, 'input-manifest.json'), need<string>(controls, 'input_manifest_sha256'));
  const expected = expectedConfiguration(spec, native, recordedRouter);
  const backend = asDict(effort.backend_policy);
  checkFailureManifest(actual, expected, backend, effort, runtime, sha);
  const receipt = evidence.read(joinPath(router.local, 'backend-policy.json'));
  if (Object.entries(backend).some(([key, value]) => !sameValue(receipt[key], value))) throw new Error('failed attempt backend algorithm differs from its policy');
  const stages = jsonLines(evidence.file(joinPath(router.local, 'stages.jsonl')));
  const binary = asDict(policy.environment).FASTROUTE_BIN ?? null;
  const context: StageContext = {
    run, router, spec, backend, expected, binary, inputs: asDict(policy.inputs), routerSha: need(actual, 'router_sha256'), stages,
    thermal: spec.thermal_verification === 'native-checkback', placementSha256: sha,
  };
  const configured = Object.entries(need<Dict>(controls, 'effective_configurations')).map(([name, digest]) => checkFailureStage(context, name, digest as string));
  checkNoExtraStages(stages, configured, binary);
  const exactPolicy = evidence.exact(policyPath), exactRun = evidence.exact(joinPath(folder, 'run.json'));
  const files = asDict(source.files);
  return identity({
    schema: ATTEMPT, runtime: exactPolicy.get('runtime'), resources: exactPolicy.get('resources'), effort: exactPolicy.get('effort'),
    operation: manifest.operation ?? null, router: need(manifest, 'router'), spec: exactRun.get('spec'),
    source_tools: Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith('tools/'))), gate_policy: need(manifest, 'gate_config_sha256'),
  });
}

/**
 * Verify an unsuccessful execution, without asserting native acceptance. Only finalized controlled Fastroute failures
 * qualify; prepared, prelaunch, cancelled and ambiguous runs stay unknown.
 */
export function verifiedFailedAttempt(run: RunContext, terminal: Dict, operation: Dict, placementSha256: string | null | undefined): Attempt {
  const result: Attempt = { schema: ATTEMPT, status: 'unknown', fingerprint: null, qualified: false };
  if (terminal.status !== 'failed' || run.manifest.router !== 'fastroute') return { ...result, cause: 'not a finalized failed controlled routing attempt' };
  try {
    const fingerprint = verifiedFingerprint(run, terminal, operation, placementSha256);
    return { ...result, status: 'verified', fingerprint, cause: 'verified execution terminated unsuccessfully; native acceptance remains unproved' };
  } catch (error) {
    return { ...result, cause: errorText(error) };
  }
}
