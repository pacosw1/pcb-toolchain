// Controlled escape-screen orchestration and stage-local receipt reuse. The grid implementation is a separate native tool.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, parse, resolve } from 'node:path';
import { atomicJson, sha256File } from './json-file.ts';
import { fingerprint } from './fingerprint.ts';
import { resolvePath, withSuffix } from './py-path.ts';
import { deadlineAfter, remaining } from './lean-workflow.ts';
import { read, same, sourceInputs, nativeInputs, implementations, checkReport } from './route-decision-evidence.ts';
import type { DrcReport, FileDescriptor, Hashes } from './route-decision-evidence.ts';

const ENV = ['ROUTE_BOARD', 'ROUTE_FEATURES', 'ROUTE_FEATURES_FILE', 'ROUTE_GRID_BIN', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH'];
export interface ModelParameters {
  grid_mm: number; reach_mm: number; halo_hint_mm: number; pad_box_halo_mm: number; layers: string[];
  skip_nets: string[]; net_filter: null; width_model: string; clearance_model: string;
}
export interface EscapeContext {
  schema: string; files: Hashes; config_inputs: Hashes; feature_config: Record<string, unknown>;
  environment: Record<string, string | null>; launcher: FileDescriptor; model_parameters: ModelParameters;
}
export interface EscapeRuntime { schema: string; files: Record<string, FileDescriptor>; [key: string]: unknown }
export interface EscapePad { ref: string; pad: string | number; net?: string; [key: string]: unknown }
export interface EscapeEvidence {
  schema: string; board: string; status: string; qualified: boolean; cause?: string; source_inputs?: Hashes;
  generator_context?: EscapeContext; generator_inputs?: Hashes; feature_config?: Record<string, unknown>; model_parameters?: ModelParameters;
  runtime?: EscapeRuntime; unsupported_constraints?: unknown[]; not_checked?: number | null;
  screened_pads: EscapePad[]; boxed_in?: EscapePad[]; inputs?: Hashes;
  native_preflight?: FileDescriptor & { returncode: number }; native_validation?: string; scope?: string;
}
export interface EscapeRule { kind: string; metric?: string; refs?: string[]; pads?: { ref: string; pad: string | number }[]; [key: string]: unknown }
export interface EscapeContract {
  root?: string; board: string; inputs?: Hashes; rules: EscapeRule[];
  geometry: { refs: Record<string, { pads: Record<string, { kind?: string; layers?: string[] }[]> }> };
  [key: string]: unknown;
}
export interface EscapeBlocker { code: string; detail: string; evidence: string; refs?: string[]; pads?: EscapePad[] }
export interface EscapeServices {
  context(root: string, board: string): EscapeContext;
  produce(root: string, board: string, native: string, work: string, timeout: number, context: EscapeContext): EscapeEvidence;
}
function commandPath(name: string): string {
  const candidates = name.includes('/') ? [resolve(name)] : (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, name));
  for (const file of candidates) try { if (statSync(file).isFile()) { accessSync(file, constants.X_OK); return resolvePath(file); } } catch { /* Try the next PATH entry. */ }
  throw new Error('native escape grid executable is missing; set ROUTE_GRID_BIN to the Rust route-grid port');
}
export function escapeContext(root: string, board: string): EscapeContext {
  root = resolvePath(root);
  if (process.env.ROUTE_FEATURES_FILE || !['', board].includes(process.env.ROUTE_BOARD ?? board)) throw new Error('external escape feature file or different ROUTE_BOARD is unsupported');
  const { cfg, native } = nativeInputs(root, board), configFile = join(dirname(native), 'gate.json');
  const featureFile = join(root, 'tools/route-features.json');
  const defaults = read<{ features: Record<string, Record<string, unknown>> }>(featureFile).features.pin_escape_check;
  if (!defaults) throw new Error('pin escape feature defaults are missing');
  const feature = { ...defaults, ...cfg.route_features?.pin_escape_check };
  const switches = (process.env.ROUTE_FEATURES ?? '').split(',').filter(s => s.includes('=')).map(s => { const at = s.indexOf('='); return [s.slice(0, at).trim(), s.slice(at + 1).trim()]; });
  for (const selected of ['all', 'pin_escape_check']) for (const [name, value] of switches) if (name === selected) feature.on = !['0', 'off', 'false', ''].includes(value!);
  const parameters: ModelParameters = { grid_mm: Number(feature.grid_mm ?? .05), reach_mm: Number(feature.reach_mm ?? 2), halo_hint_mm: Number(feature.halo_hint_mm ?? .5),
    pad_box_halo_mm: .3, layers: ['F.Cu', 'B.Cu'], skip_nets: [], net_filter: null,
    width_model: 'native_design_minimum', clearance_model: 'native_item_and_net_maximum' };
  if ([parameters.grid_mm, parameters.reach_mm, parameters.halo_hint_mm].some(v => !Number.isFinite(v) || v <= 0)) throw new Error('escape resolution/reach/halo must be finite positive model parameters');
  const launcher = commandPath(process.env.ROUTE_GRID_BIN ?? 'route-grid');
  return { schema: 'iot-lab.escape-context.v2', files: { [featureFile]: sha256File(featureFile), [launcher]: sha256File(launcher) },
    config_inputs: { [configFile]: sha256File(configFile) }, feature_config: feature,
    environment: Object.fromEntries(ENV.map(name => [name, process.env[name] ?? null])), launcher: { path: launcher, sha256: sha256File(launcher) }, model_parameters: parameters };
}
/** A compiled producer records its own observed closure; no interpreted Python/pcbnew/numpy roles are assumed. */
export function escapeRuntimeValid(runtime: EscapeRuntime | undefined, launcher?: FileDescriptor): void {
  if (runtime?.schema !== 'iot-lab.escape-runtime.v2' || !runtime.files || !Object.keys(runtime.files).length) throw new Error('escape evidence lacks the actual native runtime closure');
  for (const item of Object.values(runtime.files)) {
    if (!item || !item.path.startsWith('/') || !existsSync(item.path) || sha256File(item.path) !== item.sha256) throw new Error('native escape runtime changed: ' + item?.path);
  }
  if (launcher && !Object.values(runtime.files).some(file => same(file, launcher))) throw new Error('escape evidence omits the executing grid artifact');
}
function produce(root: string, board: string, native: string, work: string, timeout: number, context: EscapeContext): EscapeEvidence {
  const deadline = deadlineAfter(timeout), budget = remaining(deadline);
  if (budget === null || budget <= 0) throw new Error('native escape screen deadline expired');
  const log = join(work, 'grid.log'), output = join(work, 'grid.json');
  // The native grid process owns any CAD subprocesses. This adapter only orchestrates it on the Mac.
  const run = spawnSync(context.launcher.path, ['escape', native, '--skip', '', '--layers', 'F.Cu,B.Cu', '--out', output],
    { cwd: root, env: { ...process.env, ROUTE_BOARD: board }, encoding: 'utf8', timeout: budget * 1000, maxBuffer: 4 * 1024 * 1024 });
  atomicJson(join(work, 'process.json'), { command: context.launcher.path, returncode: run.status, error: run.error?.message ?? null });
  // Keep one immutable process record next to the result, including failures.
  const text = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  // Logs are data, not code; no shell expansion is involved.
  writeFileSync(log, text);
  if (run.error || run.status !== 0) throw new Error('native grid runtime/screen failed; evidence=' + log);
  return read<EscapeEvidence>(output);
}
export const escapeServices: EscapeServices = { context: escapeContext, produce };
export function escapeRoot(contract: EscapeContract, candidate: string): string {
  let base = dirname(resolvePath(candidate));
  while (dirname(base) !== base) {
    if (existsSync(join(base, 'hardware-design/boards', contract.board, 'gate.json')) && nativeInputs(base, contract.board).native === resolvePath(candidate)) return base;
    base = dirname(base);
  }
  throw new Error('candidate has no configured escape owner');
}
const owner = (contract: EscapeContract, candidate: string): string => contract.root ? resolvePath(contract.root) : escapeRoot(contract, candidate);
export function verifyEscapeEvidence(contract: EscapeContract, candidate: string, evidence: string, services = escapeServices): EscapeBlocker[] {
  candidate = resolvePath(candidate); evidence = resolvePath(evidence);
  try {
    const raw = read<EscapeEvidence>(evidence);
    if (raw.status === 'blocked' && raw.cause) throw new Error('escape screen blocked: ' + raw.cause);
    if (raw.schema !== 'iot-lab.pin-escape-evidence.v1' || raw.qualified !== false || !['screened', 'blocked'].includes(raw.status)
      || resolvePath(raw.board ?? '') !== candidate || !same(raw.source_inputs, sourceInputs(candidate))) throw new Error('escape evidence does not bind exact candidate board/project/rules/schematic');
    const context = services.context(owner(contract, candidate), contract.board);
    if (!same(raw.generator_context, context) || !same(raw.generator_inputs, context.files) || !same(raw.feature_config, context.feature_config)
      || !same(raw.model_parameters, context.model_parameters)) throw new Error('escape generator, effective feature policy or model parameters changed');
    escapeRuntimeValid(raw.runtime, context.launcher);
    if (raw.unsupported_constraints?.length || raw.not_checked) throw new Error('escape screen has unsupported constraints or unscreened endpoints');
    for (const [path, digest] of Object.entries(contract.inputs ?? {})) if (sha256File(path) !== digest) throw new Error('reviewed source changed before escape decision: ' + path);
    const screened = new Set((raw.screened_pads ?? []).map(p => JSON.stringify([p.ref, String(p.pad)]))), requested = new Map<string, [string, string]>();
    for (const rule of contract.rules) {
      if (rule.kind !== 'escape') continue;
      if (rule.metric !== 'native_minimum_track_escape' || ['width_mm', 'clearance_mm', 'reach_mm', 'grid_mm', 'layers'].some(key => key in rule)) throw new Error('unsupported reviewed escape metric or parameter override');
      const pads = rule.pads?.length ? rule.pads.map(p => [p.ref, String(p.pad)] as [string, string])
        : (rule.refs ?? []).flatMap(ref => Object.entries(contract.geometry.refs[ref]?.pads ?? {}).filter(([, rows]) => rows.some(row => row.kind === 'smd' && row.layers?.some(l => l.endsWith('.Cu')))).map(([pad]) => [ref, pad] as [string, string]));
      for (const p of pads) requested.set(JSON.stringify(p), p);
    }
    if (!requested.size || [...requested.keys()].some(key => !screened.has(key))) throw new Error('reviewed escape pads were not all screened explicitly');
    if ([...requested.values()].some(([ref, pad]) => contract.geometry.refs[ref]?.pads[pad]?.length !== 1)) throw new Error('reviewed escape pad identity is missing or ambiguous');
    if (raw.native_preflight) {
      const native = raw.native_preflight;
      if (native.returncode !== 0 || !existsSync(native.path) || native.sha256 !== sha256File(native.path)) throw new Error('supplied native escape preflight is incomplete');
      const report = read<DrcReport>(native.path); checkReport(report, candidate);
      if (report.schematic_parity.length || report.violations.some(row => row.severity === 'error')) throw new Error('supplied native geometry/parity preflight failed or is incomplete');
    } else if (raw.native_validation !== 'not_run; fresh parent configured gate required') throw new Error('escape model omits its native validation status');
    const blocked = (raw.boxed_in ?? []).filter(p => requested.has(JSON.stringify([p.ref, String(p.pad).split('.').at(-1)])));
    return blocked.length ? [{ code: 'escape_model_enclosure', detail: 'bounded native-polygon grid enclosure; not physical impossibility', refs: [...new Set(blocked.map(p => p.ref))].sort(), pads: blocked, evidence }] : [];
  } catch (error) { return [{ code: 'native_escape_evidence_invalid', detail: (error as Error).message, evidence }]; }
}
export function generateEscape(root: string, board: string, output: string, timeout = 30, candidate?: string, services = escapeServices): EscapeEvidence {
  root = resolvePath(root); output = resolvePath(output);
  const native = candidate ? resolvePath(candidate) : nativeInputs(root, board).native, before = sourceInputs(native), context = services.context(root, board);
  if (existsSync(output)) throw new Error('new escape evidence file required');
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('finite positive timeout required');
  mkdirSync(dirname(output), { recursive: true });
  const work = join(dirname(output), parse(output).name + '-artifacts'); mkdirSync(work, { recursive: false });
  const result = services.produce(root, board, native, work, timeout, context);
  if (!same(sourceInputs(native), before) || !same(result.source_inputs, before)) throw new Error('native inputs changed during escape screen');
  if (!same(services.context(root, board), context) || !same(result.generator_inputs, context.files) || !same(result.feature_config, context.feature_config)
    || !same(result.model_parameters, context.model_parameters)) throw new Error('native escape generator, effective policy or parameters changed during screen');
  escapeRuntimeValid(result.runtime, context.launcher);
  result.status = result.unsupported_constraints?.length || result.boxed_in?.length ? 'blocked' : 'screened';
  result.generator_context = context; result.qualified = false;
  result.inputs = { ...Object.fromEntries(Object.entries(before).map(([name, hash]) => [withSuffix(native, parse(name).ext), hash])), ...context.files, ...context.config_inputs,
    [context.launcher.path]: context.launcher.sha256, ...Object.fromEntries(Object.values(result.runtime!.files).map(file => [file.path, file.sha256])) };
  result.native_validation = 'not_run; fresh parent configured gate required'; result.scope = 'bounded native-polygon/minimum-width escape model; no physical routability proof';
  atomicJson(output, result); return result;
}
export function generateEscapeEvidence(contract: EscapeContract, candidate: string, output: string, services = escapeServices): EscapeEvidence {
  candidate = resolvePath(candidate); output = resolvePath(output);
  try { return generateEscape(owner(contract, candidate), contract.board, output, 30, candidate, services); }
  catch (error) {
    const result: EscapeEvidence = { schema: 'iot-lab.pin-escape-evidence.v1', status: 'blocked', qualified: false, board: candidate, cause: (error as Error).message, screened_pads: [], not_checked: null };
    if (!existsSync(output)) atomicJson(output, result); return result;
  }
}
export function generateEscapeForCandidate(root: string, board: string, candidate: string, output: string, timeout = 30, services = escapeServices): EscapeEvidence {
  return generateEscape(root, board, output, timeout, candidate, services);
}
export class EscapeStageReceipts {
  readonly entries = new Map<string, FileDescriptor>(); hits = 0; generated = 0;
  readonly emit?: (event: string, fields: Record<string, unknown>) => void;
  readonly services: EscapeServices;
  constructor(emit?: (event: string, fields: Record<string, unknown>) => void, services: EscapeServices = escapeServices) {
    this.emit = emit; this.services = services;
  }
  key(contract: EscapeContract, candidate: string): string {
    const root = owner(contract, candidate);
    return fingerprint({ candidate, sources: sourceInputs(candidate), contract, context: this.services.context(root, contract.board), implementations: implementations(root),
      environment_sha256: fingerprint({ ...process.env, ROUTE_BOARD: contract.board }) });
  }
  get(contract: EscapeContract, candidate: string, output: string): string {
    candidate = resolvePath(candidate); output = resolvePath(output);
    for (const [name, digest] of Object.entries(contract.inputs ?? {})) if (sha256File(name) !== digest) throw new Error('reviewed escape input changed before screen: ' + name);
    const key = this.key(contract, candidate), previous = this.entries.get(key);
    if (previous) {
      if (!existsSync(previous.path) || sha256File(previous.path) !== previous.sha256) throw new Error('sealed stage escape receipt changed; inspect ' + previous.path);
      const raw = read<EscapeEvidence>(previous.path);
      if (raw.cause) throw new Error('same stage escape screen already failed: ' + raw.cause);
      let validRuntime = true; try { escapeRuntimeValid(raw.runtime); } catch { validRuntime = false; }
      if (validRuntime) {
        const blockers = verifyEscapeEvidence(contract, candidate, previous.path, this.services);
        if (blockers.some(row => row.code === 'native_escape_evidence_invalid')) throw new Error('stage escape receipt no longer verifies: ' + JSON.stringify(blockers));
        for (const [name, digest] of Object.entries(raw.inputs ?? {})) if (sha256File(name) !== digest) throw new Error('stage escape input changed: ' + name);
        if (this.key(contract, candidate) !== key || sha256File(previous.path) !== previous.sha256) throw new Error('stage escape inputs changed during reuse');
        this.hits++; this.emit?.('cache.hit', { check: 'escape', evidence: previous.path, key }); return previous.path;
      }
    }
    if (existsSync(output)) throw new Error('new stage escape evidence file required');
    this.generated++; this.emit?.('cache.miss', { check: 'escape', evidence: output, key });
    generateEscapeEvidence(contract, candidate, output, this.services);
    if (this.key(contract, candidate) !== key || !existsSync(output)) throw new Error('stage escape inputs changed or producer omitted its receipt');
    this.entries.set(key, { path: output, sha256: sha256File(output) }); return output;
  }
}
