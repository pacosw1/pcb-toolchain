// One controlled Fastroute invocation: admit its policy, runtime and inputs, then cross-check the controls it actually used.
// A routed result still needs the full gate. The job itself is `iotroute fastroute`.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { availableParallelism, hostname, homedir, machine, release, type } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bind, PATCH } from './backend-quality.ts';
import { atomicJson, readObject, sha256File } from './json-file.ts';
import { jobMemory, limits } from './lean-resources.ts';
import { runStage } from './lean-stage.ts';
import { deadlineAfter } from './lean-workflow.ts';
import { thermalServices } from './outcome-thermal.ts';
import { validateGate } from './pcb-routing-admission.ts';
import { iotrouteBin } from './iotroute-bin.ts';
import { boardConfig } from './pcb-workflow.ts';
import { fileRoot } from './project-root.mjs';
import { isFile, isRelativeTo, joinPath, pathExists, relativeTo, resolvePath, which, withSuffix } from './py-path.ts';
import { sameValue, type Dict } from './py-values.ts';

const SCHEMA = 'iot-lab.routing-policy.v1';
const THERMAL_SCHEMA = 'iot-lab.routing-policy.v2';
const EXECUTION = 'iot-lab.placement-outcome-execution.v1';
const FIELDS = ['schema', 'layers', 'only_nets', 'passes', 'threads', 'timeout_s', 'optimizer', 'max_repairs'];
const COPPER = /^(?:F|B|In(?:[1-9]|[12][0-9]|30))\.Cu$/;
const SIDECARS = ['.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_dru'];
const PRODUCERS = ['route-features.json'];
const GIB = 1073741824;
const PROBE_S = 5;

export interface RoutingPolicy extends Dict {
  schema: string; layers: string[]; only_nets: string[]; passes: number; threads: number; timeout_s: number; optimizer: string; max_repairs: number; thermal_verification?: string;
}
interface Context { path: string | null; raw: Buffer; image_id: string | null; container_id: string | null; cpus: number; memory_bytes: number; observed_cgroup: Dict; kind?: string; identity?: string }
export interface Prepared {
  command: string[]; env: NodeJS.ProcessEnv; policy: Dict; policy_path: string; output: string; native: string; config: RoutingPolicy;
  context_path: string; context_sha256: string; runtime_kind: string;
}

const fail = (message: string): never => { throw new Error(message); };
const sha = (path: string): string => sha256File(path);
const asDict = (value: unknown): Dict => (value && typeof value === 'object' && !Array.isArray(value) ? value as Dict : {});
const fileHash = (path: string): string | null => (isFile(path) ? sha(path) : null);

function backendEffort(policy: unknown): Dict {
  const value = asDict(policy);
  if (value.mode !== 'legacy-unverified' && value.mode !== 'quality-first') fail('actual backend algorithm policy is missing or unknown');
  const result: Dict = { mode: value.mode };
  if (value.mode === 'quality-first') {
    for (const name of ['binary_sha256', 'manifest_sha256', 'patch_sha256', 'upstream_commit']) {
      if (typeof value[name] !== 'string' || !value[name]) fail('quality backend algorithm identity is incomplete');
      result[name] = value[name];
    }
  }
  return result;
}

const positiveInteger = (value: unknown): boolean => Number.isInteger(value) && (value as number) > 0;

export function validate(config: unknown, totalTimeoutS: number): RoutingPolicy {
  const value = asDict(config);
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('controlled routing requires an explicit routing policy');
  const thermal = value.schema === THERMAL_SCHEMA;
  const expected = thermal ? [...FIELDS, 'thermal_verification'] : FIELDS;
  if (!sameValue(Object.keys(value).sort(), [...expected].sort()) || (value.schema !== SCHEMA && !thermal) || (thermal && value.thermal_verification !== 'native-checkback'))
    fail('controlled routing requires exactly the routing-policy.v1 fields or explicit v2 native-checkback fields');
  for (const key of ['passes', 'threads', 'timeout_s']) if (!positiveInteger(value[key])) fail(`${key} must be a positive integer`);
  if (!Number.isFinite(totalTimeoutS) || totalTimeoutS <= 0 || (value.timeout_s as number) > totalTimeoutS) fail('router timeout must fit the complete CLI deadline');
  if (value.optimizer !== 'off' && value.optimizer !== 'if-routed') fail('controlled optimizer must be off or if-routed');
  if (value.max_repairs !== 0) fail('this policy permits zero separate CLI repair operations');
  for (const key of ['layers', 'only_nets']) {
    const names = value[key];
    if (!Array.isArray(names) || !names.length || names.some(name => typeof name !== 'string' || !name) || new Set(names).size !== names.length)
      fail(`${key} requires a nonempty list of distinct exact names`);
  }
  if ((value.layers as string[]).some(name => !COPPER.test(name))) fail('unsupported copper layer name');
  if ((value.only_nets as string[]).some(name => /[,*?[\]\r\n\0]/.test(name))) fail('only_nets must contain explicit comma-free net names, without macros');
  return structuredClone(value) as RoutingPolicy;
}

function executable(name: string): string {
  const path = which(name);
  return path ? resolvePath(path) : fail(`controlled routing executable is unavailable: ${name}`);
}

/** What the Rust route job runs on this host. A missing one stops the run here, by name. */
export function routeJobTools(): { iotroute: string; coverage: string; api: string; router: string; kicad: string } {
  const bundled = join(process.env.PCB_TOOLCHAIN_ROOT || fileRoot, 'bin/route-coverage-linux-x86_64');
  return {
    iotroute: executable(iotrouteBin()),
    coverage: executable(process.env.ROUTE_COVERAGE_BIN || (process.platform === 'linux' && isFile(bundled) ? bundled : 'route-coverage')),
    api: executable(process.env.KICAD_API_CLI || 'kicad-cli-nightly'),
    router: executable(process.env.FASTROUTE_BIN || join(homedir(), 'opt/fastroute/fastroute-0.1.7-macos-arm64/fastroute')),
    kicad: executable(process.env.KICAD_CLI ?? (process.platform === 'darwin' ? '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli' : 'kicad-cli')),
  };
}

/** The tools of `routeJobTools` as the job reads them. */
export const routeJobEnv = (tools: ReturnType<typeof routeJobTools>): NodeJS.ProcessEnv => ({ IOTROUTE_BIN: tools.iotroute, ROUTE_COVERAGE_BIN: tools.coverage, KICAD_API_CLI: tools.api, FASTROUTE_BIN: tools.router, KICAD_CLI: tools.kicad });

async function probe(command: string[], env: NodeJS.ProcessEnv, probes: Dict[]): Promise<string> {
  let run;
  try {
    run = await runStage(command, { stage: 'routing-runtime-probe', deadline: deadlineAfter(PROBE_S), env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  } catch (error) {
    return fail(`controlled routing runtime probe failed: ${(error as Error).message}`);
  }
  const text = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  probes.push({ command, returncode: run.returncode, output: text });
  if (run.returncode || !text) fail(`controlled routing version probe failed: ${JSON.stringify(command)}`);
  return text;
}

const firstLine = (path: string): string => readFileSync(path, 'utf8').trim();

/** Enforceable limits as the kernel shows them; never inferred from the host CPU count. */
function cgroups(): Dict {
  const result: Dict = {};
  if (isFile('/sys/fs/cgroup/cpu.max')) {
    const [quota, period] = firstLine('/sys/fs/cgroup/cpu.max').split(/\s+/);
    result.cpus = quota === 'max' ? null : Number(quota) / Number(period);
  } else if (isFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us') && isFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us')) {
    const amount = Number(firstLine('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
    result.cpus = amount > 0 ? amount / Number(firstLine('/sys/fs/cgroup/cpu/cpu.cfs_period_us')) : null;
  }
  if (isFile('/sys/fs/cgroup/memory.max')) {
    const raw = firstLine('/sys/fs/cgroup/memory.max');
    result.memory_bytes = raw === 'max' ? null : Number(raw);
  } else if (isFile('/sys/fs/cgroup/memory/memory.limit_in_bytes')) {
    const amount = Number(firstLine('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
    result.memory_bytes = amount > 0 ? amount : null;
  }
  if (process.platform === 'linux') result.affinity_cpus = availableParallelism();
  return result;
}

function containerContext(): Context {
  const name = process.env.PCB_EXECUTION_CONTEXT;
  if (!name) fail('controlled routing needs the host-recorded Docker inspect context');
  const path = joinPath(process.cwd(), name);
  if (!isFile(path) || lstatSync(path).isSymbolicLink()) fail('execution context must be an original regular inspect receipt');
  const raw = readFileSync(path);
  let value = JSON.parse(raw.toString()) as unknown;
  if (Array.isArray(value)) {
    if (value.length !== 1) fail('execution context must identify exactly one running container');
    value = value[0];
  }
  const inspect = asDict(value);
  if (!/^[0-9a-f]{64}$/.test(String(inspect.Id ?? ''))) fail('execution context is not an original container inspect response');
  const image = String(inspect.Image ?? '');
  if (!/^sha256:[0-9a-f]{64}$/.test(image)) fail('execution context lacks the immutable actual image identity');
  if (asDict(inspect.Config).Hostname !== hostname()) fail('execution context belongs to another container hostname');
  const covering = ((inspect.Mounts ?? []) as Dict[]).filter(mount => isRelativeTo(path, String(mount.Destination ?? '/__missing__')))
    .sort((a, b) => String(b.Destination).split('/').length - String(a.Destination).split('/').length);
  if (!covering.length || covering[0]!.RW !== false) fail('original execution context must be mounted read-only');
  const host = asDict(inspect.HostConfig);
  if (host.NetworkMode !== 'none') fail('controlled routing requires the recorded network-none runner');
  const nano = host.NanoCpus as number, memory = host.Memory as number;
  if (!positiveInteger(nano) || !positiveInteger(memory)) fail('actual runner must enforce explicit CPU and memory limits');
  const cpus = nano / 1e9, observed = cgroups();
  if (('cpus' in observed && observed.cpus !== cpus) || ('memory_bytes' in observed && observed.memory_bytes !== memory)) fail('actual cgroup limits differ from the host inspect receipt');
  if ('affinity_cpus' in observed && (observed.affinity_cpus as number) < cpus) fail('actual CPU affinity is narrower than the recorded quota');
  return { path, raw, image_id: image, container_id: String(inspect.Id), cpus, memory_bytes: memory, observed_cgroup: observed };
}

/** The local executor, described honestly: cooperative budgets are not quotas. */
function nativeContext(): Context {
  const [cpus, memoryGib] = limits(), logical = availableParallelism();
  if (cpus > logical) fail('native CPU budget exceeds available logical processors');
  const value = { cpus, enforcement: 'cooperative-reservation-and-backend-worker-caps', logical_cpus: logical, machine: machine(), memory_bytes: Math.trunc(memoryGib * GIB),
    memory_is_hard_limit: false, network_isolated: false, release: release(), schema: 'iot-lab.native-execution-context.v1', system: type() };
  const raw = Buffer.from(JSON.stringify(value) + '\n');
  return { path: null, raw, image_id: null, container_id: null, cpus, memory_bytes: value.memory_bytes, observed_cgroup: {}, kind: 'native', identity: createHash('sha256').update(raw).digest('hex') };
}

function features(root: string, board: string): Dict {
  const value = asDict(readObject<Dict>(join(root, 'tools/route-features.json')).features);
  for (const [name, changes] of Object.entries(asDict(readObject<Dict>(join(root, 'hardware-design/boards', board, 'gate.json')).route_features)))
    value[name] = { ...asDict(value[name]), ...asDict(changes) };
  return value;
}

export async function prepare(rootPath: string, nativePath: string, outputPath: string, spec: unknown, totalTimeoutS: number, board: string, runtime: 'container' | 'native'): Promise<Prepared> {
  const root = resolvePath(rootPath), native = resolvePath(nativePath), output = resolvePath(outputPath);
  const config = validate(spec, totalTimeoutS);
  if (!isRelativeTo(native, root) || !isFile(native)) fail('solver input must be the isolated workspace native PCB');
  if (pathExists(output)) fail('solver output must be a fresh directory');
  if (withSuffix(boardConfig(root, board).project, '.kicad_pcb') !== native) fail('controlled route input differs from the configured board');
  const gate = await validateGate(root, board);
  if (process.env.ROUTE_FEATURES || process.env.ROUTE_FEATURES_FILE) fail('external route feature overrides are unsupported in controlled trials');
  if (![undefined, '', board].includes(process.env.ROUTE_BOARD)) fail('route environment belongs to another board');
  if (['PYTHONHOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH'].some(key => process.env[key])) fail('external runtime loader overrides are unsupported in controlled trials');
  const context = runtime === 'native' ? nativeContext() : containerContext();
  if (config.threads > context.cpus) fail(runtime === 'container' ? 'router threads exceed the actual container CPU quota' : 'router threads exceed the admitted native CPU budget');
  const jobTools = routeJobTools(), { iotroute, coverage, api, router, kicad } = jobTools;
  const policyFeatures = features(root, board);
  const thermal = config.thermal_verification === 'native-checkback', rules = asDict(policyFeatures.routing_rules);
  if (thermal && rules.on) fail('native thermal checkback requires internal routing/repair stages disabled');
  const bound = [...PRODUCERS.map(name => join(root, 'tools', name)).filter(isFile), join(root, 'hardware-design/boards', board, 'gate.json'),
    fileURLToPath(import.meta.url), iotroute, coverage, api, router, kicad];
  const inputs: Record<string, string> = Object.fromEntries(bound.map(path => [path, sha(path)]));
  for (const [name, digest] of Object.entries(gate.inputs)) inputs[join(root, name)] = digest;
  for (const extension of SIDECARS) {
    const path = withSuffix(native, extension);
    if (!isFile(path)) fail('controlled routing requires the exact four native sidecars');
    inputs[path] = sha(path);
  }
  const memoryGib = context.memory_bytes / GIB;
  const env: NodeJS.ProcessEnv = { ...process.env, IOT_LAB: root, ROUTE_BOARD: board, ...routeJobEnv(jobTools), IOT_CPU_BUDGET: String(Math.floor(context.cpus)), IOT_RESOURCE_CPU: String(config.threads), IOT_MEMORY_BUDGET_GIB: String(memoryGib),
    // Native runs leave room for the persistent compute worker: the router records this reservation before launching.
    IOT_JOB_MEMORY_GIB: String(runtime === 'native' ? Math.min(jobMemory(), memoryGib) : memoryGib) };
  const probes: Dict[] = [];
  const versions: Record<string, string> = {};
  for (const [name, path] of [['iotroute', iotroute], ['kicad_api', api], ['router', router], ['kicad', kicad]] as const) versions[name] = await probe([path, '--version'], env, probes);
  const quality = env.FASTROUTE_QUALITY_MANIFEST ? resolvePath(env.FASTROUTE_QUALITY_MANIFEST) : null;
  if (quality) {
    if (!isFile(quality)) fail('selected quality backend manifest is unavailable');
    inputs[quality] = sha(quality);
    env.FASTROUTE_QUALITY_MANIFEST = quality;
  }
  const backendPolicy = bind(router, quality);
  if (quality) {
    inputs[PATCH] = sha(PATCH);
    const validation = readObject<{ native_validation: { evidence: { path: string; sha256: string }[] } }>(quality).native_validation;
    for (const evidence of validation.evidence) inputs[evidence.path] = evidence.sha256;
  }
  const command = [iotroute, 'fastroute', native, output, '--preflight', '--skip-net', '', '--plane-nets', '', '--only-nets', config.only_nets.join(','), '--layers', config.layers.join(','),
    '--passes', String(config.passes), '--threads', String(config.threads), '--max-time', String(config.timeout_s), '--optimizer', config.optimizer, '--snapshot-interval-s', '0',
    ...(thermal ? ['--native-thermal-checkback'] : [])];
  const parent = dirname(output), receipt = join(parent, 'execution-policy.json'), original = join(parent, 'execution-context.json');
  mkdirSync(parent, { recursive: true });
  if (pathExists(receipt) || pathExists(original)) fail('controlled execution receipts must be new');
  writeFileSync(original, context.raw);
  const contextSha = createHash('sha256').update(context.raw).digest('hex');
  const tools = Object.fromEntries(([['iotroute', iotroute], ['kicad_api', api], ['router', router], ['kicad', kicad]] as const).map(([name, path]) => [name, { version: versions[name], sha256: sha(path) }]));
  const policy: Dict = { schema: runtime === 'container' ? EXECUTION : 'iot-lab.placement-outcome-execution.v2', command,
    runtime: { image_id: context.image_id, tools, ...(runtime === 'native' ? { kind: 'native', host_identity: context.identity } : {}) },
    resources: { cpus: context.cpus, memory_bytes: context.memory_bytes, threads: config.threads,
      ...(runtime === 'native' ? { enforcement: 'cooperative-reservation-and-backend-worker-caps', memory_is_hard_limit: false, network_isolated: false } : {}) },
    effort: { timeout_s: totalTimeoutS, router_timeout_s: config.timeout_s, passes: config.passes, max_repairs: 0, optimizer: config.optimizer,
      backend_policy: backendEffort(backendPolicy), max_repairs_scope: 'separate CLI repair operations only',
      internal_repair_iterations: rules.on ? rules.repair_iterations ?? 2 : 0, feature_policy: policyFeatures, ...(thermal ? { thermal_verification: 'native-checkback' } : {}) },
    execution_context: { path: `operation/${basename(original)}`, sha256: contextSha, container_id: context.container_id, observed_cgroup: context.observed_cgroup,
      ...(runtime === 'native' ? { kind: 'native', attribution: 'locally observed OS and cooperative resource budget; no container isolation' }
        : { attribution: 'host Docker inspect matched to running hostname and exposed cgroup limits' }) },
    gate_admission: { stage: gate.stage, validator: 'gate-core.validateConfig' }, inputs,
    environment: Object.fromEntries(['ROUTE_BOARD', 'ROUTE_FEATURES', 'ROUTE_FEATURES_FILE', 'FASTROUTE_BIN', 'FASTROUTE_QUALITY_MANIFEST', 'KICAD_CLI', 'KICAD_API_CLI', 'IOTROUTE_BIN', 'ROUTE_COVERAGE_BIN',
      'IOT_CPU_BUDGET', 'IOT_RESOURCE_CPU', 'IOT_MEMORY_BUDGET_GIB', 'IOT_JOB_MEMORY_GIB'].map(key => [key, env[key] ?? null])),
    controls: { status: 'prepared', effective_configuration_verified: false }, qualified: false };
  atomicJson(join(parent, 'runtime-probes.json'), probes);
  atomicJson(receipt, policy);
  return { command, env, policy, policy_path: receipt, output, native, config, context_path: context.path ?? original, context_sha256: contextSha, runtime_kind: runtime };
}

const jsonFiles = (folder: string, pattern: RegExp): string[] => readdirSync(folder).filter(name => pattern.test(name)).sort().map(name => join(folder, name));
/** The sha256 of json.dumps(value, separators=(',', ':')): plain ASCII. */
const commandSha = (command: unknown[]): string => createHash('sha256')
  .update(JSON.stringify(command).replace(/[\u0080-￿]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)).digest('hex');

function incomplete(prepared: Prepared, policy: Dict, returncode: number, cause: string): Dict {
  Object.assign(policy.controls as Dict, { status: 'incomplete', effective_configuration_verified: false, tool_exit: returncode });
  atomicJson(prepared.policy_path, policy);
  return { status: 'failed', controls_verified: false, candidate: null, cause };
}

function inputsCurrent(coverage: Dict, label: string): void {
  for (const [name, digest] of Object.entries(asDict(coverage.inputs))) if (fileHash(name) !== digest) fail(`${label} changed: ${name}`);
}

/** Native thermal evidence must describe this exact input before any stage may rely on it. */
function initialThermal(prepared: Prepared, inputs: Record<string, string>, output: string): Dict {
  const snapshotPath = join(output, 'native-thermal-source.json');
  const snapshot = isFile(snapshotPath) ? readObject<Dict>(snapshotPath) : null;
  const captured = join(output, 'native-thermal-source', basename(prepared.native));
  const originals = Object.fromEntries(SIDECARS.map(suffix => [withSuffix(prepared.native, suffix), inputs[withSuffix(prepared.native, suffix)]]));
  const copies = Object.fromEntries(SIDECARS.map(suffix => [withSuffix(captured, suffix), inputs[withSuffix(prepared.native, suffix)]]));
  const digest = inputs[prepared.native];
  if (snapshot?.schema !== 'iot-lab.native-thermal-source.v1' || !sameValue(snapshot.original, { path: prepared.native, sha256: digest })
      || !sameValue(snapshot.captured, { path: captured, sha256: digest }) || !sameValue(snapshot.original_files, originals) || !sameValue(snapshot.inputs, copies)
      || Object.entries(copies).some(([name, hash]) => !isFile(name) || lstatSync(name).isSymbolicLink() || sha(name) !== hash))
    fail('native thermal original snapshot differs from the controlled input');
  const initial = join(output, 'native-thermal-initial.json');
  if (!isFile(initial)) fail('native thermal execution lacks the initial capability');
  return thermalServices().validateCapability(readObject<Dict>(initial), captured, join(output, 'base.kicad_pcb'), { selectedNets: prepared.config.only_nets });
}

function checkStage(path: string, expected: Dict, policy: Dict, config: RoutingPolicy, output: string, thermal: boolean, initial: Dict | null, capabilities: Dict[]): void {
  const value = readObject<Dict>(path), effort = asDict(policy.effort);
  if (Object.entries(expected).some(([key, item]) => !sameValue(asDict(value.configuration)[key], item))) fail('a router stage changed the controlled configuration');
  if (!sameValue(backendEffort(value.backend_policy), effort.backend_policy)) fail('a router stage changed the backend algorithm');
  const resources = asDict(value.backend_resources);
  if (['global_rayon_threads', 'autorouter_workers', 'optimizer_workers'].some(key => resources[key] !== config.threads)) fail('actual router worker caps differ from the controlled policy');
  const binding = asDict(value.rule_coverage), coveragePath = String(binding.path ?? '');
  if (dirname(coveragePath) !== output || !isFile(coveragePath) || sha(coveragePath) !== binding.sha256) fail('router stage lacks sealed rule-coverage admission');
  const coverage = readObject<Dict>(coveragePath), pending = coverage.status === 'pending_native';
  if ((coverage.status !== 'passed' && !(thermal && pending)) || coverage.solver_launch_allowed !== true) fail('router stage ran without passing rule coverage');
  if (pending) {
    const capability = coverage.native_thermal_capability as Dict;
    if (!capability || !sameValue(capability, initial)) fail('pending thermal coverage lacks its initial native capability');
    const obligations = [{ constraint: 'min_resolved_spokes', required_count: String(capability.required_count), capability_sha256: capability.content_sha256 }];
    if (coverage.model_status !== 'partial' || !sameValue(coverage.native_postconditions, obligations)) fail('pending thermal coverage has missing or different native obligations');
    capabilities.push(capability);
  }
  const dsn = asDict(coverage.dsn), dsnPath = String(dsn.path ?? '');
  if (!isFile(dsnPath) || sha(dsnPath) !== dsn.sha256 || dsn.sha256 !== value.dsn_sha256) fail('rule coverage differs from actual router model');
  const command = value.command as unknown[];
  const flag = Array.isArray(command) ? command.indexOf('-de') : -1;
  if (flag < 0 || command.filter(arg => arg === '-de').length !== 1 || flag + 1 >= command.length || command[flag + 1] !== dsnPath) fail('router command does not use its admitted model');
  const quality = asDict(effort.backend_policy).mode === 'quality-first' ? 1 : 0;
  if (command.filter(arg => arg === '--quality-first').length !== quality) fail('router command backend algorithm differs from the controlled policy');
  if (!sameValue(coverage.backend_command, command) || coverage.backend_command_sha256 !== commandSha(command)) fail('router command differs from project-rule admission');
  inputsCurrent(coverage, 'router rule-coverage input');
}

function dischargeThermal(prepared: Prepared, controls: Dict, output: string, candidate: string, returncode: number, initial: Dict | null, capabilities: Dict[]): void {
  if (returncode !== 0) {
    controls.native_thermal_obligations = { status: 'unfulfilled', cause: 'producer did not complete with a discharged native obligation' };
    return;
  }
  const finalPath = join(output, 'native-thermal-final.json');
  if (!initial || !isFile(finalPath)) fail('native thermal obligation was not discharged before completion');
  const final = readObject<Dict>(finalPath);
  for (const capability of capabilities.length ? capabilities : [initial!]) {
    const checked = thermalServices().discharge(capability, candidate, { fillReceipt: join(output, 'native-thermal-final-fill.json'), drcReceipt: join(output, 'native-thermal-final-drc.json') });
    if (!sameValue(checked, final)) fail('final thermal receipt differs from actual native discharge');
  }
  const runRoot = dirname(dirname(prepared.policy_path));
  const retained = (path: string): Dict => ({ path: relativeTo(path, runRoot), sha256: sha(path) });
  controls.native_thermal_obligations = { status: 'passed', initial: retained(join(output, 'native-thermal-initial.json')), final: retained(finalPath),
    source_snapshot: retained(join(output, 'native-thermal-source.json')), candidate: retained(candidate) };
}

/** Cross-checks the controls the router actually used. A routed result still needs the full gate. */
export function finalize(prepared: Prepared, returncode: number): Dict {
  const output = prepared.output, policy = structuredClone(prepared.policy), config = prepared.config, inputs = policy.inputs as Record<string, string>;
  const controls = policy.controls as Dict, effort = asDict(policy.effort), runtime = asDict(policy.runtime);
  for (const [name, digest] of Object.entries(inputs)) if (fileHash(name) !== digest) fail(`controlled routing input/tool changed: ${name}`);
  if (sha(prepared.context_path) !== prepared.context_sha256) fail('original host execution context changed during routing');
  const copied = join(dirname(prepared.policy_path), 'execution-context.json');
  if (!isFile(copied) || sha(copied) !== prepared.context_sha256) fail('retained original execution context differs from the host receipt');
  if (prepared.runtime_kind === 'native' && !nativeContext().raw.equals(readFileSync(copied))) fail('native host or resource policy changed during routing');
  const manifest = join(output, 'input-manifest.json');
  if (!isFile(manifest)) {
    if (returncode === 0) fail('successful router did not record its effective input configuration');
    return incomplete(prepared, policy, returncode, 'router did not record its effective input configuration');
  }
  const actual = readObject<Dict>(manifest), configuration = asDict(actual.configuration);
  const thermal = config.thermal_verification === 'native-checkback';
  const expected: Dict = { board: prepared.native, outdir: output, passes: config.passes, layers: config.layers.join(','), only_nets: config.only_nets.join(','), threads: config.threads,
    max_time: config.timeout_s, optimizer: config.optimizer, preflight: true, skip_net: '', plane_nets: '', gnd_vias: false, route_planes: false, unlock_nets: '', set: [], neck_um: 0,
    ...(thermal ? { native_thermal_checkback: true } : {}) };
  if (!thermal && configuration.native_thermal_checkback) fail('strict v1 routing cannot activate native thermal checkback');
  if (Object.entries(expected).some(([key, value]) => !sameValue(configuration[key], value))) fail('router effective configuration differs from the controlled policy');
  if (actual.board_sha256 !== inputs[prepared.native]) fail('router operated on another placement input');
  if (actual.router_sha256 !== asDict(asDict(runtime.tools).router).sha256) fail('router binary differs from the recorded runtime');
  const backend = join(output, 'backend-policy.json');
  if (!isFile(backend) || !sameValue(backendEffort(readObject(backend)), effort.backend_policy)) fail('router backend algorithm differs from the controlled policy');
  const observed = { ...asDict(actual.features) };
  delete observed._board_dir;
  if (!sameValue(observed, effort.feature_policy)) fail('actual route features differ from the source-bound policy');
  const configurations = jsonFiles(output, /^effective-configuration.*\.json$/);
  const blocked: Dict[] = [];
  for (const path of jsonFiles(output, /^rule-coverage.*\.json$/)) {
    const coverage = readObject<Dict>(path);
    if (coverage.status === 'blocked' && coverage.solver_launch_allowed === false) {
      inputsCurrent(coverage, 'rule coverage input');
      blocked.push({ path, sha256: sha(path), cause: coverage.cause });
    }
  }
  if (blocked.length) {
    if (returncode === 0) fail('solver success contradicts blocked rule coverage');
    Object.assign(controls, { status: 'blocked', effective_configuration_verified: false, tool_exit: returncode, rule_coverage: blocked, solver_launched: configurations.length > 0 });
    atomicJson(prepared.policy_path, policy);
    return { status: 'failed', controls_verified: false, candidate: null, qualified: false, rule_coverage: blocked, solver_launched: configurations.length > 0,
      cause: `router rule coverage blocked before solver: ${blocked.map(row => String(row.cause)).join('; ')}` };
  }
  if (!configurations.length) {
    if (returncode === 0) fail('successful solver lacks actual backend worker-cap evidence');
    return incomplete(prepared, policy, returncode, 'no observed backend invocation/worker caps; inspect retained failure evidence');
  }
  const capabilities: Dict[] = [], initial = thermal ? initialThermal(prepared, inputs, output) : null;
  for (const path of configurations) checkStage(path, expected, policy, config, output, thermal, initial, capabilities);
  const outcomePath = join(output, 'outcome.json'), outcome = isFile(outcomePath) ? readObject<Dict>(outcomePath) : null;
  const candidate = join(output, 'routed.kicad_pcb'), produced = outcome?.status === 'complete' || outcome?.status === 'stuck';
  if (returncode === 0 && outcome?.status !== 'complete') fail('successful router lacks a complete candidate outcome');
  if (produced && (!isFile(candidate) || outcome.board_sha256 !== sha(candidate) || outcome.optimizer !== config.optimizer)) fail('router outcome is not bound to the actual candidate/optimizer');
  if (thermal) dischargeThermal(prepared, controls, output, candidate, returncode, initial, capabilities);
  const phasePath = join(output, 'stages.jsonl');
  const phases = existsSync(phasePath) ? readFileSync(phasePath, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as Dict) : null;
  Object.assign(controls, { status: 'observed', effective_configuration_verified: true, tool_exit: returncode,
    effective_configurations: Object.fromEntries(configurations.map(path => [basename(path), sha(path)])), input_manifest_sha256: sha(manifest), outcome,
    native_repair_phases: phases && phases.filter(row => /repair|thermal/i.test(String(row.stage ?? ''))) });
  atomicJson(prepared.policy_path, policy);
  return { status: returncode === 0 ? 'passed' : 'failed', controls_verified: true, outcome, qualified: false, native_gate_required: true, candidate: produced ? candidate : null,
    cause: returncode === 0 ? 'actual effective controls match; full candidate gate remains required' : `router exited ${returncode}; outcome=${String(outcome?.status ?? 'unknown')}` };
}
