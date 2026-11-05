// Trace declared requirements to existing engineering verifiers, stage by stage. A passed assessment means its explicit
// stage evidence is current. It never qualifies hardware, proves an unmodeled function or authorizes production.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { errorText } from './cli.ts';
import { dependencyFiles, loadContract, read, relativeFile, REPORT, STAGES } from './design-contract-load.ts';
import { adapter, captureTools, dftAccess, merge, productionControls, type DesignServices, type Report } from './design-contract-verifiers-async.ts';
import { sha256File } from './json-file.ts';
import { lexists, utcNow } from './py-compat.mjs';
import { isFile, isRelativeTo, joinPath, resolvePath } from './py-path.ts';
import { isDict, type Dict } from './py-values.ts';

const REQUIRED_KIND: Record<string, string> = { parts: 'part_use', schematic: 'schematic', placement: 'placement', routing: 'native_gate', prototype: 'bench' };
const LIMITS = ['Only declared requirements/evidence are evaluated. Plan completeness and recorded review are not functional or bench correctness. No production or procurement approval.'];
const staleText = (text: string): boolean => text.includes('stale') || text.includes('changed');

type Check = Parameters<typeof adapter>[2];

/** A screen shared by one stage: returns the evidence file to use, which may be an earlier one. */
export interface EscapeScreens { get: (policy: Dict, candidate: string, requested: string) => string }

function newReport(fields: Dict): Report {
  return { inputs: {}, tool_inputs: {}, absent_inputs: [], blockers: [], check_results: {}, schematic_contracts: [], ...fields } as Report;
}

const blockersOf = (report: Report): Dict[] => report.blockers as Dict[];

function escapeFor(row: Check, policy: Dict, candidate: string, owned: string, report: Report, services: DesignServices, screens?: EscapeScreens): string {
  const requested = joinPath(owned, `${row.id}-escape.json`);
  if (!screens) {
    services.generateEscapeEvidence(policy, candidate, requested);
    (report.generated_evidence as string[]).push(requested);
    return requested;
  }
  const escape = screens.get(policy, candidate, requested);
  (report[escape === requested ? 'generated_evidence' : 'reused_evidence'] as string[]).push(escape);
  return escape;
}

function ownedFolder(root: string, directory: string | null | undefined): string {
  if (directory === null || directory === undefined) throw new Error('candidate escape checks require an explicit new owned evidence_directory');
  const owned = resolvePath(directory);
  if (owned === root || ['hardware-design', 'tools', 'registry'].some(name => isRelativeTo(owned, joinPath(root, name)))) {
    throw new Error('candidate escape evidence must be outside canonical CAD/tools/registry');
  }
  mkdirSync(dirname(owned), { recursive: true });
  mkdirSync(owned);
  return owned;
}

export interface CandidateOptions { candidate?: string | null; evidenceDirectory?: string | null; escapeScreens?: EscapeScreens }

async function replayPlacement(root: string, value: Dict, checks: Check[], report: Report, services: DesignServices, options: CandidateOptions): Promise<void> {
  const board = (value.identity as Dict).board as string;
  const candidate = options.candidate ?? null;
  let owned: string | null = null;
  for (const row of checks) {
    let escape: string | null = null;
    if (candidate !== null) {
      captureTools(report);
      const policy = services.reviewedContract(root, board, relativeFile(root, row.path));
      merge(report, root, policy);
      if ((policy.rules as Dict[]).some(rule => rule.kind === 'escape')) {
        owned ??= ownedFolder(root, options.evidenceDirectory);
        escape = escapeFor(row, policy, candidate, owned, report, services, options.escapeScreens);
      }
    }
    (report.check_results as Dict)[row.id] = await adapter(root, value, row, report, services, { candidate, escapeEvidence: escape });
  }
}

/**
 * Replay canonical reviewed layout and DFT against optional candidate geometry. Canonical root and path retain original
 * fixed and rigid poses: an edited workspace cannot become its own baseline. No old stage run is reevaluated.
 */
export async function evaluateCandidateLayout(rootPath: string, pathGiven: string, services: DesignServices, options: CandidateOptions = {}): Promise<Report> {
  const root = resolvePath(rootPath), path = resolvePath(pathGiven);
  const report = newReport({
    schema: 'iot-lab.design-candidate-layout.v1', scope: 'candidate_declared_layout_and_dft_only', status: 'blocked', design_id: null, board: null,
    qualified: false, production_approved: false, release_approved: false, generated_evidence: [], reused_evidence: [],
  });
  try {
    const initial = sha256File(path);
    Object.assign(report, { contract: path, contract_sha256: initial });
    report.inputs[path] = initial;
    const candidate = options.candidate ? resolvePath(options.candidate) : null;
    if (candidate) report.inputs[candidate] = sha256File(candidate);
    const value = loadContract(root, path, services);
    const identity = value.identity as Dict;
    Object.assign(report, { identity, design_id: identity.design_id, board: identity.board });
    captureTools(report);
    for (const name of dependencyFiles(root, path, 'architecture', services)) report.inputs[joinPath(root, name)] = sha256File(joinPath(root, name));
    report.inputs[path] = initial;
    const checks = (value.checks as Check[]).filter(row => row.kind === 'placement');
    if (!checks.length) blockersOf(report).push({ code: 'candidate_layout_contract_missing', detail: 'No declared placement verifier for the candidate', stage: 'placement' });
    blockersOf(report).push(...dftAccess(root, value, report, services));
    if (!blockersOf(report).length) await replayPlacement(root, value, checks, report, services, { ...options, candidate });
    if (Object.entries(report.inputs).some(([name, digest]) => sha256File(name) !== digest)) throw new Error('stale candidate design source changed during layout evaluation');
    captureTools(report);
    report.status = blockersOf(report).length ? 'blocked' : 'passed';
  } catch (error) {
    const text = errorText(error);
    blockersOf(report).push({ code: 'candidate_layout_evidence', detail: text, stage: 'placement' });
    report.status = staleText(text) ? 'stale' : 'blocked';
  }
  return report;
}

function bindDeclaredFiles(root: string, checks: Check[], cutoff: number, report: Report): void {
  for (const check of checks) {
    if (STAGES.indexOf(check.stage) > cutoff) continue;
    for (const key of ['path', 'escape_evidence', 'plan', 'binding', 'proof', 'bench']) {
      if (!check[key]) continue;
      const target = resolvePath(joinPath(root, check[key] as string));
      if (!isFile(target)) report.absent_inputs.push(target);
    }
  }
}

function checkStagePlan(name: string, value: Dict, checks: Check[], report: Report, root: string, services: DesignServices): void {
  const block = (code: string, detail: string, extra: Dict = {}) => blockersOf(report).push({ code, detail, stage: name, ...extra });
  if (name === 'production') blockersOf(report).push(...productionControls(value));
  for (const unknown of value.unknowns as Dict[]) {
    if (unknown.blocking_stage === name && !unknown.resolution_check) block('unresolved_unknown', unknown.question as string, { unknown: unknown.id, owner: unknown.owner });
  }
  if (name === 'architecture') {
    const architecture = value.architecture as Dict | null;
    const empty = (rows: unknown) => !(rows as unknown[] | undefined)?.length;
    if (!architecture || empty(architecture.interfaces) || empty(architecture.decisions) || empty(value.failure_conditions)) {
      block('architecture_plan', 'Explicit interfaces, decisions and failure-condition test links required');
    }
  }
  if (name === 'placement') blockersOf(report).push(...dftAccess(root, value, report, services));
  const required = REQUIRED_KIND[name];
  if (!required) return;
  const kinds = new Set(checks.filter(row => row.stage === name).map(row => row.kind));
  const allowed = [required, ...(name === 'parts' ? ['part_selection'] : name === 'prototype' ? ['block_qualification'] : [])];
  if (!allowed.some(kind => kinds.has(kind))) block('stage_evidence_missing', `Stage requires actual ${name === 'parts' ? 'part_selection or part_use' : required} evidence`);
  if (name === 'schematic' && !kinds.has('native_gate')) block('stage_evidence_missing', 'Schematic stage also requires actual successful native ERC evidence');
}

async function runStageChecks(name: string, start: number, root: string, value: Dict, checks: Check[], report: Report, services: DesignServices): Promise<void> {
  const results = report.check_results as Dict;
  for (const check of checks) {
    if (check.stage !== name) continue;
    if (blockersOf(report).length > start) {
      results[check.id] = { status: 'blocked', kind: check.kind, path: check.path, scope: 'stage_plan_blocked_before_verifier' };
      continue;
    }
    try {
      results[check.id] = await adapter(root, value, check, report, services);
    } catch (error) {
      const text = errorText(error);
      results[check.id] = { status: staleText(text) ? 'stale' : 'blocked', kind: check.kind, path: check.path };
      blockersOf(report).push({ code: 'check_evidence', detail: text, stage: name, check: check.id });
    }
  }
}

function scoreRequirements(name: string, value: Dict, checks: Check[], report: Report): void {
  const results = report.check_results as Record<string, Dict>, requirements = report.requirement_results as Dict;
  for (const row of value.requirements as Dict[]) {
    if (row.verification_stage !== name) continue;
    const id = row.id as string;
    const passed = checks.filter(check => check.requirements.includes(id) && check.stage === name && results[check.id]?.status === 'passed').map(check => check.id);
    const planning = ['requirements', 'architecture'].includes(name) && (row.acceptance as Dict).kind === 'review';
    requirements[id] = {
      status: passed.length || planning ? 'passed' : 'blocked', checks: passed,
      scope: planning && !passed.length ? 'documented_acceptance_plan_only' : 'actual_verifier_coverage',
    };
    if (!passed.length && !planning) blockersOf(report).push({ code: 'requirement_unverified', detail: 'No actual verifier covers required acceptance', stage: name, requirement: id });
  }
  for (const unknown of value.unknowns as Dict[]) {
    if (unknown.blocking_stage === name && unknown.resolution_check && results[unknown.resolution_check as string]?.status !== 'passed') {
      blockersOf(report).push({ code: 'unresolved_unknown', detail: unknown.question, stage: name, unknown: unknown.id, owner: unknown.owner });
    }
  }
}

async function evaluateStages(root: string, value: Dict, checks: Check[], cutoff: number, report: Report, services: DesignServices): Promise<void> {
  const stages = report.stages as Record<string, Dict>;
  for (const [index, name] of STAGES.entries()) {
    if (index > cutoff) {
      stages[name] = { status: 'blocked', required_now: false, readiness: 'future_evidence_not_requested' };
      continue;
    }
    if (Object.values(stages).some(row => row.required_now && row.status !== 'passed')) {
      stages[name] = { status: 'blocked', required_now: true, readiness: 'upstream_stage_blocked' };
      continue;
    }
    const start = blockersOf(report).length;
    checkStagePlan(name, value, checks, report, root, services);
    await runStageChecks(name, start, root, value, checks, report, services);
    scoreRequirements(name, value, checks, report);
    const rows = blockersOf(report).slice(start);
    stages[name] = {
      status: rows.some(row => staleText(row.detail as string)) ? 'stale' : rows.length ? 'blocked' : 'passed',
      required_now: true, readiness: index < 2 ? 'acceptance_plan_recorded' : 'declared_stage_evidence_evaluated',
    };
  }
}

function checkStillCurrent(report: Report): void {
  for (const [name, digest] of Object.entries(report.inputs)) {
    if (!isFile(name) || sha256File(name) !== digest) throw new Error(`stale input changed during assessment: ${name}`);
  }
  captureTools(report);
  if (report.absent_inputs.some(name => lexists(name))) throw new Error('stale absent input appeared during assessment');
}

function finishRequirements(value: Dict, cutoff: number, report: Report): void {
  const results = report.requirement_results as Dict;
  for (const row of value.requirements as Dict[]) {
    if ((row.id as string) in results) continue;
    const required = STAGES.indexOf(row.verification_stage as string) <= cutoff;
    results[row.id as string] = {
      status: 'blocked', required_now: required, scope: required ? 'upstream_stage_not_evaluated' : 'future_verification_not_requested', verification_stage: row.verification_stage,
    };
  }
}

async function assess(root: string, path: string, through: string | null | undefined, report: Report, services: DesignServices): Promise<void> {
  const initial = sha256File(path);
  Object.assign(report, { root, contract: path, contract_sha256: initial });
  report.inputs[path] = initial;
  const raw = read(path);
  report.through = through || (raw.current_stage ?? null);
  const declared = raw.identity ?? {};
  if (isDict(declared)) Object.assign(report, { identity: declared, design_id: declared.design_id ?? null, board: declared.board ?? null });
  const value = loadContract(root, path, services);
  const identity = value.identity as Dict;
  captureTools(report);
  Object.assign(report, { identity, design_id: identity.design_id, board: identity.board });
  const stage = through || (value.current_stage as string);
  if (!STAGES.includes(stage)) throw new Error('unknown assessment stage');
  report.through = stage;
  for (const name of dependencyFiles(root, path, stage, services)) report.inputs[joinPath(root, name)] = sha256File(joinPath(root, name));
  report.inputs[path] = initial;
  const cutoff = STAGES.indexOf(stage);
  const checks = value.checks as Check[];
  bindDeclaredFiles(root, checks, cutoff, report);
  await evaluateStages(root, value, checks, cutoff, report, services);
  checkStillCurrent(report);
  finishRequirements(value, cutoff, report);
  const stages = Object.values(report.stages as Record<string, Dict>);
  report.status = stages.some(row => row.required_now && row.status === 'stale') ? 'stale' : blockersOf(report).length ? 'blocked' : 'passed';
}

function nextAction(report: Report): void {
  const index = STAGES.indexOf(report.through as string);
  if (index >= 0) report.next_stage = STAGES[index + 1] ?? null;
  const first = blockersOf(report)[0];
  report.next_action = {
    kind: first ? 'resolve_declared_blocker' : 'review_next_stage_plan',
    cause: first ? first.detail : 'Current declared stage evidence assessed; later physical evidence remains separate',
    stage: first ? first.stage : report.next_stage ?? null, requirement_id: first?.requirement ?? null, check: first?.check ?? null,
  };
}

export async function evaluateContract(rootPath: string, pathGiven: string, through: string | null | undefined, services: DesignServices): Promise<Report> {
  const root = resolvePath(rootPath), path = resolvePath(pathGiven);
  const report = newReport({
    schema: REPORT, scope: 'declared_design_stage_evidence', status: 'blocked', design_id: null, board: null, qualified: false, release_approved: false,
    production_approved: false, functional_qualification: false, stages: {}, requirement_results: {}, temporal_context: [], through: through ?? null, limits: LIMITS,
  });
  captureTools(report);
  try {
    await assess(root, path, through, report, services);
  } catch (error) {
    const text = errorText(error);
    blockersOf(report).push({ code: 'contract_input', detail: text, stage: through || 'requirements' });
    report.status = staleText(text) ? 'stale' : 'blocked';
  }
  nextAction(report);
  return report;
}

const today = (): string => utcNow().slice(0, 10);

/** A cheap freshness observation for next and cycle; never reruns a verifier. */
export function currentAssessment(report: Dict): boolean {
  try {
    if (report.schema !== REPORT || !Object.keys((report.inputs ?? {}) as Dict).length) return false;
    for (const field of ['inputs', 'tool_inputs']) {
      for (const [name, digest] of Object.entries((report[field] ?? {}) as Dict)) {
        if (!name.startsWith('/') || !isFile(name) || sha256File(name) !== digest) return false;
      }
    }
    if (((report.absent_inputs ?? []) as string[]).some(name => lexists(name))) return false;
    return !((report.temporal_context ?? []) as Dict[]).some(row => row.requires_current_day && row.order_day_utc !== today());
  } catch {
    return false;
  }
}
