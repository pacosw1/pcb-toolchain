// Read-only decisions from sealed receipts. Commands are recommendations, never executed here.
import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { readObject as readSharedObject, sha256File } from './json-file.ts';
import { current as observationCurrent } from './pcb-observation-inputs.ts';
import { verify } from './pcb-evidence.ts';
import { boardConfig, context as boardContext } from './pcb-workflow.ts';
import { stockPopulationCurrent } from './part-stock.ts';
import { jsonDumps, PyError } from './py-compat.mjs';
import { caught, isFile, isRelativeTo, pathExists, resolvePath, which } from './py-path.ts';
import { sameValue } from './py-values.ts';
import { timestamp } from './timing.ts';
import type { ObservationReport, RunState } from './pcb-cycle.ts';

type Fields = Record<string, unknown>;
export const TERMINAL = new Set(['passed', 'failed', 'error', 'cancelled', 'timeout']);
export const OPERATIONS = new Set(['check', 'edit', 'route', 'repair', 'build', 'release', 'readiness', 'parts', 'placement', 'routing', 'schematic']);
const ACTIVE = new Set(['starting', 'running', 'stopping']);
const CANDIDATE = new Set(['build', 'edit', 'route', 'repair']);
const ENGINEERING = new Set(['parts', 'placement', 'routing', 'schematic']);
const DESIGN_STAGES = ['requirements', 'architecture', 'parts', 'schematic', 'placement', 'routing', 'prototype', 'production'];
export interface Manifest {
  run_id: string; root: string; board?: string; operation?: string; project?: string | null; created_at: string;
  arguments?: string[]; from_run?: { folder: string; result_sha256: string }; gate_config_sha256?: string; router?: string;
  design_contract?: { path: string; sha256: string }; design_stage?: string;
}
export interface Receipt extends Fields {
  status: string; evidence_sha256: Record<string, string>; cause?: string; input_sha256?: string;
  engineering_inputs?: Record<string, string>; engineering_absent_inputs?: string[]; engineering_policy?: unknown;
  candidate_verified?: boolean; identity_preserved?: boolean; source_unchanged?: boolean;
}
export interface Gate {
  exit?: number; changedDuringRun?: boolean; metrics?: Record<string, number | null>;
  checks?: Record<string, { status: string; metrics?: Record<string, number | null> }>;
  provenance?: { input_sha256?: string; inputs?: { path: string; sha256?: string | null }[] };
}
export interface InputVerification extends Fields { verified: true; input_sha256: string; release_supported?: boolean }
export interface ProbeResult { returncode: number; stdout: string; stderr: string }
export interface ProbeOptions { stage: string; timeoutS: number; env: NodeJS.ProcessEnv }
export type OwnedProbe = (command: string[], options: ProbeOptions) => Promise<ProbeResult>;
export interface NextReaders {
  status(folder: string): RunState;
  sourceState(root: string, board: string, extraInputs?: unknown): unknown;
  parentCandidate(root: string, board: string, reference: NonNullable<Manifest['from_run']>): unknown;
  currentAssessment(report: ObservationReport): boolean;
  runStage: OwnedProbe;
}
export interface NextOptions {
  readers: NextReaders; base?: string; designContract?: string; through?: string;
  verifyInputs?: (root: string, board: string, gate: string) => Promise<InputVerification>;
  now?: () => Date;
}
interface Context { project: string; revision: unknown; frozen: boolean; blockers: { rule: string; path: string }[]; previous_gate?: unknown }
export interface Decision extends Fields {
  evidence: Fields; observed_run: Fields | null; readiness_verified: boolean; state?: string;
  blocker?: Fields; next_action?: { kind?: string; argv: string[]; command: string; cwd: string };
}
const plain = <T>(value: unknown): T => JSON.parse(jsonDumps(value)) as T;
const receipt = (folder: string): Receipt => plain<Receipt>(verify(folder));
function stale(message: string): never { throw new PyError('ValueError', message); }
function readObject<T extends object = Fields>(path: string): T {
  const message = 'expected object: ' + path;
  try { return readSharedObject<T>(path, message); }
  catch (error) { if (error instanceof Error && error.message === message) stale(message); throw error; }
}
const isLink = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
const active = (state: RunState): boolean => state.controller_alive === true || ACTIVE.has(state.status);
const quote = (value: string): string => value && /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
const command = (root: string, argv: string[]) => ({ argv, command: argv.map(quote).join(' '), cwd: root });
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const today = (options: NextOptions): string => (options.now?.() ?? new Date()).toISOString().slice(0, 10);

function runFolders(base: string): string[] {
  if (!pathExists(base)) return [];
  return readdirSync(base, { withFileTypes: true }).filter(entry => entry.name.startsWith('run-') && entry.isDirectory() && !entry.isSymbolicLink()).map(entry => join(base, entry.name));
}

export function latestRun(root: string, board: string, project: string | null, base: string, readers: Pick<NextReaders, 'status'>, operations = OPERATIONS) {
  const matches: { time: number; folder: string; manifest: Manifest }[] = [], rejected: { path: string; cause: string }[] = [];
  for (const folder of runFolders(base)) {
    try {
      const manifest = readObject<Manifest>(join(folder, 'run.json')), operation = manifest.operation ?? 'check';
      const requested = operation === 'readiness' ? manifest.arguments?.[0] : manifest.board;
      if (requested !== board || !operations.has(operation)) continue;
      if (resolvePath(manifest.root ?? '') !== root) { rejected.push({ path: folder, cause: 'run belongs to a different checkout' }); continue; }
      if (operation !== 'readiness' && (manifest.project ?? null) !== project) { rejected.push({ path: folder, cause: 'run belongs to a different configured revision/project' }); continue; }
      if (manifest.run_id !== basename(folder) || !/^run-[A-Za-z0-9_-]+$/.test(basename(folder))) stale('run identity mismatch');
      const time = timestamp(manifest.created_at);
      if (time === null) stale('run timestamp has no timezone or is invalid');
      matches.push({ time, folder, manifest });
    } catch (error) { rejected.push({ path: folder, cause: messageOf(error) }); }
  }
  matches.sort((a, b) => b.time - a.time || (basename(a.folder) < basename(b.folder) ? 1 : -1));
  for (const match of matches) { try { if (active(readers.status(match.folder))) return { selected: match, rejected }; } catch { /* Validate the newest observation below. */ } }
  return { selected: matches[0] ?? null, rejected };
}

export function repoInputsUnchanged(root: string, gate: Gate): void {
  for (const entry of gate.provenance?.inputs ?? []) {
    if (entry.path.startsWith('external/')) continue;
    const path = resolvePath(resolve(root, entry.path));
    if (!isRelativeTo(path, root)) stale('recorded gate input escapes its checkout: ' + entry.path);
    if (entry.sha256 == null ? pathExists(path) : !isFile(path) || sha256File(path) !== entry.sha256) stale('recorded gate input changed: ' + entry.path);
  }
}

/** The owning supervisor supplies its shared owned runner, including descendant cleanup and inherited deadlines. */
export async function verifyCurrentInputs(root: string, board: string, gateDir: string, runStage: OwnedProbe): Promise<InputVerification> {
  const raw = readObject<Gate>(join(gateDir, 'result.json')); repoInputsUnchanged(root, raw);
  const node = which(process.env.NODE ?? 'node');
  if (!node) throw new Error('Node.js unavailable; dependency freshness is unverified');
  let result: ProbeResult;
  try {
    result = await runStage([node, join(root, 'tools/pcb_snapshot_inputs.mjs'), root, board, '--verify-inputs', gateDir],
      { stage: 'next-input-verification', timeoutS: 20, env: { ...process.env, IOT_LAB: root } });
  } catch (error) {
    const timeout = error as { name?: string; type?: string; cleanup?: { complete?: boolean } };
    if (timeout.name !== 'TimeoutError' && timeout.type !== 'subprocess.TimeoutExpired') throw error;
    throw new Error('dependency/tool verification exceeded its 20-second observation budget'
      + (timeout.cleanup?.complete === true ? '; owned probes stopped' : '; probe cleanup unconfirmed'));
  }
  if (result.returncode) throw new Error(result.stderr.trim() || result.stdout.trim() || 'dependency verification failed');
  const verified = JSON.parse(result.stdout) as InputVerification;
  if (verified.verified !== true || verified.input_sha256 !== raw.provenance?.input_sha256) stale('dependency verifier returned mismatched evidence');
  return verified;
}

export function requiredGateEvidence(folder: string, gateDir: string, result: Receipt): Gate {
  const raw = readObject<Gate>(join(gateDir, 'result.json')), required = ['result.json', 'events.jsonl', 'findings.json'];
  for (const name of ['erc', 'drc']) if (['passed', 'failed'].includes(raw.checks?.[name]?.status ?? '')) required.push(name + '.json', name + '.log');
  for (const name of required) {
    const path = join(gateDir, name);
    if (!isRelativeTo(path, folder) || !(relative(folder, path) in result.evidence_sha256)) stale('terminal receipt does not bind required gate evidence: ' + path);
  }
  if (result.input_sha256 != null && result.input_sha256 !== raw.provenance?.input_sha256) stale('terminal and gate input fingerprints disagree');
  if (raw.changedDuringRun !== false) stale('gate inputs changed during the recorded invocation');
  return raw;
}

interface Finding extends Fields { stage?: string; severity?: string; evidence?: { path?: string; pointer?: string }; id?: string; rule?: string; message?: string }
export function currentFinding(_folder: string, gateDir: string, raw: Gate, board: string, project: string): Fields {
  const report = readObject<{ board?: string; project?: string; inputs_valid?: boolean; input_sha256?: string; findings?: Finding[] }>(join(gateDir, 'findings.json'));
  if (report.board !== board || report.project !== project || report.inputs_valid !== true || report.input_sha256 !== raw.provenance?.input_sha256) stale('findings do not match valid gate input evidence');
  for (const stage of new Set(['preflight', 'erc', 'drc', ...Object.keys(raw.checks ?? {})])) {
    const check = raw.checks?.[stage];
    if (check?.status !== 'failed' || !check.metrics || !Object.keys(check.metrics).length || Object.values(check.metrics).some(value => value === null)) continue;
    for (const finding of report.findings ?? []) {
      const pointer = finding.evidence?.pointer ?? '', hard = pointer.startsWith('/schematic_parity/') || pointer.startsWith('/unconnected_items/');
      if (finding.stage !== stage || (finding.severity !== 'error' && !hard)) continue;
      const path = resolvePath(join(gateDir, finding.evidence?.path ?? ''));
      if (!isRelativeTo(path, gateDir) || !isFile(path)) stale('finding evidence escapes or is missing from its gate directory');
      const details = Object.fromEntries(['refs', 'pads', 'nets', 'location', 'measured', 'required', 'source'].filter(key => key in finding).map(key => [key, finding[key]]));
      return { code: 'gate_finding', stage, finding_id: finding.id ?? null, rule: finding.rule ?? null, message: finding.message ?? null,
        evidence: { ...finding.evidence, path, sha256: sha256File(path) }, ...details };
    }
  }
  return stale('failed gate has no attributable completed-stage finding');
}

function engineeringInputsCurrent(result: Receipt, subject: 'design assessment' | 'engineering observation'): void {
  const inputs = result.engineering_inputs;
  if (!inputs || !Object.keys(inputs).length) stale(subject === 'design assessment' ? 'design assessment lacks source bindings' : 'engineering observation lacks current input bindings');
  if ('engineering_policy' in result && !observationCurrent(result.engineering_policy)) stale('engineering code resolution changed since the ' + (subject === 'design assessment' ? 'assessment' : 'observation'));
  for (const [name, digest] of Object.entries(inputs!)) if (!isFile(name) || sha256File(name) !== digest) stale(subject === 'design assessment' ? 'design assessment source or tool changed' : 'engineering observation input changed: ' + name);
  if ((result.engineering_absent_inputs ?? []).some(name => pathExists(name) || isLink(name))) stale(subject === 'design assessment' ? 'a previously absent design input appeared' : 'a previously absent engineering input appeared');
}

export async function designNext(root: string, identifier: string, contractPath: string, base: string, options: NextOptions): Promise<Decision> {
  const contract = resolvePath(contractPath), value = readObject<{ identity: { design_id: string; board?: string }; current_stage?: string }>(contract);
  if (value.identity.design_id !== identifier) stale('next design subject differs from its contract identity');
  const stage = options.through ?? value.current_stage;
  if (!stage || !DESIGN_STAGES.includes(stage)) stale('next needs a declared lifecycle stage');
  const board = value.identity.board || identifier, { selected, rejected } = latestRun(root, board, null, base, options.readers, new Set(['design']));
  const output: Decision = { schema_version: 1, design_id: identifier, board, through: stage, scope: 'next_design_decision_only', qualified: false,
    readiness_verified: false, observed_run: null, ignored_observations: rejected, evidence: { freshness: 'missing' } };
  const finish = (state: string, code: string, message: string, argv: string[], details: Fields = {}) => {
    Object.assign(output, { state, blocker: { code, message, ...details }, next_action: command(root, argv) }); return output;
  };
  const check = ['tools/pcb', 'design', '--runs-dir', base, '--json', 'check', identifier, '--contract', contract, '--through', stage!];
  if (!selected) return finish('needs_check', 'design_assessment_missing', 'No owned assessment for this design stage', check);
  const { folder, manifest } = selected, state = options.readers.status(folder);
  output.observed_run = { run_id: basename(folder), operation: 'design', status: state.status };
  if (active(state)) { output.evidence.freshness = 'running'; return finish('observe', 'run_in_progress', 'Current design assessment must settle', ['tools/pcb', 'events', '--runs-dir', base, basename(folder), '--json', '--wait', '20']); }
  try {
    const result = receipt(folder), binding = manifest.design_contract;
    if (!binding || resolvePath(binding.path) !== contract || binding.sha256 !== sha256File(contract) || manifest.design_stage !== stage) stale('design contract or requested stage changed');
    engineeringInputsCurrent(result, 'design assessment');
    const reportPath = join(folder, 'operation/report.json'), report = readObject<ObservationReport>(reportPath);
    if (report.design_id !== identifier || report.through !== stage) stale('assessment report belongs to another design or stage');
    if (!options.readers.currentAssessment(report)) stale('design assessment inputs or dated release context expired');
    output.evidence = { freshness: 'current', report: reportPath, report_sha256: sha256File(reportPath), receipt: join(folder, 'result.json') };
    output.readiness_verified = result.status === 'passed' && report.status === 'passed';
    output.assessment = { status: report.status, stages: report.stages, next_stage: report.next_stage, requirement_results: report.requirement_results };
    const first = report.blockers?.[0] ?? {}; let repeated = 0;
    if (result.status === 'failed') for (const other of runFolders(base)) {
      try {
        const prior = readObject<Manifest>(join(other, 'run.json'));
        if (prior.operation !== 'design' || prior.board !== board || prior.design_stage !== stage || !sameValue(prior.design_contract, binding) || resolvePath(prior.root) !== root) continue;
        const observation = receipt(other), old = readObject<ObservationReport>(join(other, 'operation/report.json'));
        if (observation.status === 'failed' && sameValue(observation.engineering_inputs, result.engineering_inputs)
          && sameValue(observation.engineering_absent_inputs ?? [], result.engineering_absent_inputs ?? []) && sameValue(old.blockers, report.blockers)) repeated++;
      } catch { /* Invalid prior evidence cannot count as a repeated current failure. */ }
    }
    return finish(repeated >= 2 ? 'stuck' : output.readiness_verified ? 'review' : 'blocked',
      repeated >= 2 ? 'repeated_unchanged_failure' : String(first.code ?? 'design_stage_review'),
      repeated >= 2 ? 'Same current failure recorded twice; resolve its cited cause before retrying' : String(first.detail ?? report.cause ?? 'Review current stage evidence and the next engineering decision'),
      ['tools/pcb', 'explain', '--runs-dir', base, basename(folder), '--json'], { stage, requirement_id: first.requirement_id ?? first.requirement ?? null,
        evidence: first.evidence ?? null, repeated_failures: repeated, engineering_next_action: report.next_action ?? null });
  } catch (error) { output.evidence = { freshness: 'stale_or_invalid', cause: messageOf(error) }; return finish('needs_check', 'design_assessment_stale', messageOf(error), check); }
}

export async function nextAction(rootPath: string, board: string, options: NextOptions): Promise<Decision> {
  const root = resolvePath(rootPath), base = resolvePath(options.base ?? process.env.PCB_RUNS_DIR ?? join(root, '.gate/cli'));
  const defaultDesign = join(root, 'hardware-design/registry/design-contracts', board + '.json');
  if (options.designContract || isFile(defaultDesign)) {
    const path = options.designContract ?? defaultDesign, identifier = readObject<{ identity: { design_id: string } }>(path).identity.design_id;
    if (options.designContract && identifier !== board) stale('explicit design next subject must be its design_id');
    return designNext(root, identifier, path, base, options);
  }
  const context = plain<Context>(boardContext(root, board)), { cfg } = boardConfig(root, board), checkMode = cfg.get('stage') === 'G5' ? '--fresh' : '--changed';
  const { selected, rejected } = latestRun(root, board, cfg.get('project') as string, base, options.readers);
  const missing = context.blockers.find(row => ['missing_native_input', 'missing_context_source'].includes(row.rule));
  const output: Decision = { schema_version: 1, board, project: context.project, revision: context.revision, frozen: context.frozen, scope: 'next_decision_only',
    context_blockers: context.blockers.filter(row => ['missing_native_input', 'missing_context_source'].includes(row.rule)), ignored_observations: rejected,
    observed_run: null, evidence: { freshness: 'missing' }, readiness_verified: false, qualification: 'guidance only; no release, order or measured qualification granted' };
  const finish = (state: string, code: string, message: string, kind: string, args: string[], details: Fields = {}) => {
    const argv = ['tools/pcb', args[0], ...(base === resolvePath(join(root, '.gate/cli')) ? [] : ['--runs-dir', base]), ...args.slice(1)];
    Object.assign(output, { state, blocker: { code, message, ...details }, next_action: { kind, ...command(root, argv) } }); return output;
  };
  const check = (code: string, message: string, details: Fields = {}) => finish('needs_check', code, message, 'check', ['check', board, checkMode, '--follow', '--json'], details);
  let selectedState: RunState | null = null;
  if (selected) {
    const { folder, manifest } = selected;
    output.observed_run = { run_id: basename(folder), operation: manifest.operation ?? 'check', created_at: manifest.created_at, manifest: join(folder, 'run.json'), evidence_dir: folder };
    try {
      const recorded = readObject<RunState>(join(folder, 'state.json'));
      if (!TERMINAL.has(recorded.status) && !ACTIVE.has(recorded.status)) stale('unknown run state: ' + recorded.status);
      selectedState = options.readers.status(folder); output.observed_run.status = selectedState.status;
      if (!TERMINAL.has(selectedState.status) && !ACTIVE.has(selectedState.status)) stale('unknown run state: ' + selectedState.status);
      if (active(selectedState)) { output.evidence.freshness = 'running'; return finish('observe', 'run_in_progress', 'Existing run must settle before another decision', 'observe', ['events', basename(folder), '--json', '--wait', '20'], { evidence: { path: join(folder, 'state.json'), active_stages: selectedState.active_stages ?? [] } }); }
    } catch (error) {
      output.evidence = { freshness: 'invalid', cause: messageOf(error) };
      return finish('blocked', 'invalid_run_state', messageOf(error), 'inspect', ['status', basename(folder), '--json'], { evidence: { path: join(folder, 'state.json') } });
    }
  }
  if (missing) return finish('blocked', missing.rule, 'Required board input is missing: ' + missing.path, 'inspect_required_source', ['context', board, '--json'], { evidence: { path: join(root, missing.path), exists: false } });
  if (!selected) { output.evidence = { freshness: context.previous_gate ? 'unverified_legacy' : 'missing', ...(context.previous_gate ? { legacy_observation: context.previous_gate } : {}) }; return check('current_check_missing', 'No current unified run evidence for this board revision'); }
  const { folder, manifest } = selected, operation = manifest.operation ?? 'check';
  const explain = ['explain', basename(folder), '--json'];
  if (!['passed', 'failed'].includes(selectedState!.status)) { output.evidence = { freshness: 'incomplete', cause: selectedState!.cause ?? null }; return finish('blocked', 'run_not_completed', selectedState!.cause ?? 'Run has no completed gate verdict', 'inspect', explain, { evidence: { path: join(folder, 'worker.log') } }); }
  let phase: 'artifacts' | 'source' | 'freshness' = 'artifacts';
  try {
    const result = receipt(folder);
    output.evidence = { freshness: 'artifacts_verified', receipt: join(folder, 'result.json'), receipt_sha256: sha256File(join(folder, 'result.json')) };
    if (operation === 'readiness') return finish('review', 'readiness_requires_current_review', 'Order-preparation evidence needs review of its recorded inputs and date', 'inspect', explain, { evidence: { path: join(folder, 'operation/readiness.log') } });
    if (ENGINEERING.has(operation)) {
      phase = 'source';
      if (manifest.from_run) options.readers.parentCandidate(root, board, manifest.from_run);
      engineeringInputsCurrent(result, 'engineering observation');
      const reportPath = join(folder, 'operation/report.json'), report = readObject<ObservationReport>(reportPath);
      if (report.scope === 'assembly_stock_observation' && !stockPopulationCurrent(report)) stale('assembly population source presence or contents changed since stock observation');
      Object.assign(output.evidence, { freshness: 'current', report: reportPath, report_sha256: sha256File(reportPath) });
      if (report.scope === 'assembly_stock_observation' && report.order_day_utc !== today(options)) {
        output.evidence.freshness = 'expired_stock_day';
        if (typeof report.candidate === 'string' && Number.isInteger(report.boards) && Number(report.boards) > 0) {
          const destination = join(root, '.gate/assembly-stock', `${board}-${today(options)}-${randomUUID().replaceAll('-', '')}`);
          return finish('needs_stock_refresh', 'stock_day_expired', 'Assembly availability observation is from another UTC day', 'refresh_stock', ['parts', '--json', 'stock', board, '--candidate', report.candidate, '--boards', String(report.boards), '--receipts', destination], { evidence: { path: reportPath }, stock_current: false });
        }
        return finish('needs_stock_refresh', 'stock_day_expired', 'Assembly availability observation is from another UTC day', 'inspect_stock_context', explain, { evidence: { path: reportPath }, stock_current: false });
      }
      if (operation === 'routing' && report.status === 'repairable') return finish('needs_repair', 'bounded_route_repair', 'Current native evidence supports one bounded isolated repair', 'repair', ['repair', board, '--plan', reportPath, ...(manifest.from_run ? ['--from-run', basename(manifest.from_run.folder)] : []), '--follow', '--json'], { evidence: { path: reportPath }, qualified: false });
      const blockers = report.blockers?.length ? report.blockers : Array.isArray(report.findings) ? report.findings as Fields[] : [], first = blockers[0] ?? {};
      return finish(result.status === 'passed' ? 'review' : 'blocked', String(first.code ?? operation + '_review'), String(first.detail ?? first.message ?? report.cause ?? operation + ' evidence needs an engineering decision'), 'inspect_engineering_evidence', explain, { evidence: { path: reportPath }, engineering_status: report.status ?? null, qualified: false });
    }
    phase = 'source';
    if (manifest.gate_config_sha256 !== sha256File(join(root, 'hardware-design/boards', board, 'gate.json'))) stale('configured board gate changed since the run');
    const gateDir = operation === 'release' ? join(folder, pathExists(join(folder, 'candidate/gate')) ? 'candidate/gate' : 'release-work/gate') : join(folder, 'gate');
    if (!pathExists(join(gateDir, 'result.json'))) { output.evidence.freshness = 'recorded_only'; return finish('blocked', 'operation_failed_before_gate', result.cause ?? 'Operation has no completed gate evidence', 'inspect', explain, { evidence: { path: join(folder, 'operation', operation + '.log') } }); }
    phase = 'artifacts';
    const raw = requiredGateEvidence(folder, gateDir, result), checks = raw.checks ?? {}, configured = cfg.get('checks') as Map<string, unknown> ?? new Map();
    const enabled = [...configured].filter(([, value]) => value !== false && value !== null).map(([key]) => key).sort();
    if (!sameValue(Object.keys(checks).sort(), enabled) || Object.values(checks).some(check => !['passed', 'failed', 'blocked', 'error'].includes(check.status))) stale('gate has missing or unknown configured check states');
    if (raw.exit === 0 && (Object.values(checks).some(check => check.status !== 'passed') || !Object.keys(raw.metrics ?? {}).length || Object.values(raw.metrics ?? {}).some(value => value === null))) stale('passed gate lacks complete configured check verdicts');
    let verificationRoot = root;
    if (CANDIDATE.has(operation)) {
      phase = 'source'; const sources = readObject(join(folder, 'operation/source.json'));
      if (!sameValue(options.readers.sourceState(root, board, sources.extra_inputs), sources)) stale('canonical inputs changed since candidate creation');
      verificationRoot = join(folder, 'workspace');
    }
    phase = 'freshness';
    const verified = await (options.verifyInputs ?? ((root, board, dir) => verifyCurrentInputs(root, board, dir, options.readers.runStage)))(verificationRoot, board, gateDir);
    Object.assign(output.evidence, { freshness: 'current', input_sha256: verified.input_sha256, gate: gateDir });
    if (raw.exit === 1) {
      if (operation === 'route' && manifest.router === 'engine') {
        const path = join(folder, 'operation/engine-summary.json');
        if (result.evidence_sha256['operation/engine-summary.json'] !== sha256File(path)) stale('engine decision is not bound to sealed run evidence');
        const engine = readObject(path);
        return finish('stuck', 'engine_search_exhausted', String(engine.cause ?? 'Engine search ended without a fully accepted candidate'), 'inspect_engine_decision', explain, { evidence: { path }, findings: engine.findings ?? [], retry_unchanged_inputs: false });
      }
      if (CANDIDATE.has(operation) && result.identity_preserved === true && result.source_unchanged === true && ['erc_errors', 'drc_errors', 'drc_parity'].every(key => raw.metrics?.[key] === 0) && (raw.metrics?.drc_unconnected ?? 0) > 0) return finish('needs_diagnosis', 'candidate_connectivity_open', 'Isolated candidate preserves design identity but needs routing diagnosis', 'diagnose_candidate', ['routing', '--from-run', basename(folder), '--json', 'diagnose', board, '--evidence', join(gateDir, 'result.json')], { evidence: { path: join(gateDir, 'drc.json') } });
      const { code, message, ...details } = currentFinding(folder, gateDir, raw, board, cfg.get('project') as string);
      return finish('blocked', String(code), String(message), 'inspect_finding', explain, details);
    }
    if (raw.exit !== 0 || result.status !== 'passed') return finish('blocked', 'operation_failed', result.cause ?? 'Operation did not pass after its native gate', 'inspect', explain, { evidence: { path: join(folder, 'operation', operation + '.log') } });
    if (CANDIDATE.has(operation)) {
      if (!result.candidate_verified || !result.identity_preserved) stale('candidate lacks verified design identity and gate evidence');
      if (context.frozen) return finish('review', 'frozen_candidate_needs_named_defect', 'Frozen-board adoption requires a current failed baseline and exact defect ID', 'inspect_candidate', explain, { evidence: { path: join(folder, 'operation/result.json') }, required_inputs: ['baseline_run_id', 'finding_id'] });
      return finish('review', 'candidate_not_adopted', 'Verified isolated candidate has not changed canonical CAD', 'explicit_adoption', ['adopt', basename(folder), '--json'], { evidence: { path: join(folder, 'operation/result.json') }, mutates_cad: true });
    }
    if (operation === 'release') return finish('needs_review', 'assembly_readiness_unverified', 'Fabrication candidate does not establish stock, assembly orientation or order readiness', 'readiness', ['readiness', '--json', board, join(folder, 'candidate')], { evidence: { path: join(folder, 'candidate/release-manifest.json') } });
    if (verified.release_supported) return finish('needs_release', 'release_evidence_missing', 'Configured checks passed; fabrication and assembly evidence remain separate', 'generate_release_candidate', ['release', board, '--follow', '--json'], { evidence: { path: join(gateDir, 'result.json') } });
    return finish('review', 'next_stage_unverified', 'Configured gate passed; review the next stage and board workflow before changing scope', 'review_stage', ['context', board, '--json'], { evidence: { path: join(gateDir, 'result.json') } });
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT' || (error instanceof PyError && error.type === 'FileNotFoundError');
    const freshness = missing ? 'missing' : phase === 'artifacts' ? 'invalid' : error instanceof SyntaxError || caught(error, 'ValueError') ? 'stale' : 'unverified';
    Object.assign(output.evidence, { freshness, cause: messageOf(error) });
    return check('evidence_not_current', messageOf(error), { evidence: { path: join(folder, 'result.json') } });
  }
}
