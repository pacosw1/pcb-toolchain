// Recorded engineering intervals and owned runs. Closing a cycle grants no qualification.
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { atomicJson, readObject, sha256File } from './json-file.ts';
import { evidenceFiles } from './pcb-evidence.ts';
import { boardConfig } from './pcb-workflow.ts';
import { sameValue } from './py-values.ts';
import { isFile } from './py-path.ts';
import { isNumber, timestamp, unionSeconds } from './timing.ts';

export const STAGES = ['requirements', 'architecture', 'parts', 'datasheets', 'schematic', 'placement',
  'routing', 'verification', 'release', 'prototype', 'production'] as const;
export type Stage = typeof STAGES[number];
export const OPERATION_STAGE: Readonly<Record<string, Stage>> = { parts: 'parts', placement: 'placement', routing: 'routing',
  repair: 'routing', edit: 'placement', route: 'routing', check: 'verification', release: 'release', readiness: 'release',
  blocks: 'schematic', build: 'placement', doctor: 'verification', schematic: 'schematic', design: 'requirements', outcomes: 'placement' };
type ObjectData = Record<string, unknown>;
export interface RunState { status: string; elapsed_s?: number; active_stages?: unknown[]; cause?: string; controller_alive?: boolean | null }
export interface ObservationReport extends ObjectData {
  schema?: string; scope?: string; status?: string; through?: string; blockers?: ObjectData[];
  board?: string; population_source?: { path: unknown; exists: unknown; sha256: unknown };
  inputs?: Record<string, string>; order_day_utc?: string; stock_current?: boolean;
}
// These readers are the owning CLI's shared implementations, never subprocesses hidden in a report renderer.
export interface CycleReaders {
  loadContract(root: string, path: string): { identity: { board?: string | null; design_id: string } };
  currentAssessment(report: ObservationReport): boolean;
  stockPopulationCurrent(report: ObservationReport): boolean;
  status(folder: string): RunState;
}
// The caller supplies its owned flock holder (tools/lib/file-lock.ts) and admission deadline.
export interface CycleOptions { readers: CycleReaders; now?: () => number; withLock: <T>(path: string, work: () => T) => Promise<T> }
export interface Activity {
  activity_id: string; stage: Stage; owner: string; description: string; started_unix_s: number;
  status: string; measurement: 'recorded_review_interval'; ended_unix_s?: number; elapsed_s?: number;
  evidence?: Record<string, string>; decision?: string;
}
export interface RunLink { run_id: string; folder: string; stage: Stage; manifest_sha256: string; result_sha256?: string }
export interface CycleRecord {
  schema: 'iot-lab.engineering-cycle.v1'; cycle_id: string; root: string; board: string; project: string | null;
  owner: string; scope: 'engineering_observation'; status: 'open' | 'recorded'; started_unix_s: number; ended_unix_s?: number;
  activities: Activity[]; runs: RunLink[]; qualified: false; release_approved: false;
  design_contract?: { path: string; sha256: string; design_id: string };
}
interface RunManifest { run_id: string; root: string; board: string; operation: string; design_stage?: Stage; created_at: string }
interface Terminal {
  status: string; cleanup?: { complete?: boolean }; evidence_sha256?: Record<string, string>; elapsed_s?: number;
  timing?: { supervisor_startup_s?: number }; cause?: string; ended_unix_s?: number;
}
interface RunObservation extends RunLink {
  status: string; elapsed_s: number | null; evidence_verified: boolean; timing?: Terminal['timing']; cause?: string;
  active_stages?: unknown[]; assessment_current?: boolean; assessment_status?: string; assessment_through?: string; blockers?: ObjectData[];
  order_day_utc?: string; availability_current_day?: boolean; availability_inputs_current?: boolean; stock_current?: boolean;
  observed_interval_unix_s?: [number, number]; interval_source?: string;
}
const terminalStates = new Set(['passed', 'failed', 'error', 'timeout', 'cancelled']);
const blockedStates = new Set(['blocked', 'failed', 'error', 'timeout']);
const now = (options: CycleOptions): number => options.now?.() ?? Date.now() / 1000;
const isStage = (stage: string | undefined): stage is Stage => STAGES.includes(stage as Stage);
const matchesHash = (path: string, expected: string): boolean => {
  try { return sha256File(path) === expected; } catch { return false; }
};
export const read = (path: string): CycleRecord => readObject<CycleRecord>(path, 'expected cycle object');

export function folderFor(base: string, cycle: string): string {
  if (!/^cycle-[A-Za-z0-9_-]+$/.test(cycle)) throw new Error('invalid cycle ID');
  const folder = join(resolve(base), cycle);
  if (lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink() || !isFile(join(folder, 'cycle.json'))) throw new Error('unknown engineering cycle');
  return folder;
}

export function create(rootPath: string, basePath: string, board: string, owner: string, options: CycleOptions, contract?: string) {
  const root = realpathSync(rootPath), base = resolve(basePath);
  let design: CycleRecord['design_contract'];
  if (contract) {
    contract = realpathSync(contract);
    const { identity } = options.readers.loadContract(root, contract);
    if ((identity.board || identity.design_id) !== board) throw new Error('cycle subject differs from its exact design contract identity');
    design = { path: contract, sha256: sha256File(contract), design_id: identity.design_id };
  }
  let project: string | null = null;
  if (isFile(join(root, 'hardware-design/boards', board, 'gate.json'))) project = relative(root, boardConfig(root, board).project);
  else if (!design) throw new Error('a cycle before native CAD requires an explicit design contract');
  if (!owner.trim()) throw new Error('one integration owner is required');
  mkdirSync(base, { recursive: true });
  const folder = mkdtempSync(join(base, 'cycle-'));
  const data: CycleRecord = { schema: 'iot-lab.engineering-cycle.v1', cycle_id: basename(folder), root, board, project, owner,
    scope: 'engineering_observation', status: 'open', started_unix_s: now(options), activities: [], runs: [], qualified: false, release_approved: false };
  if (design) data.design_contract = design;
  atomicJson(join(folder, 'cycle.json'), data);
  return summarize(folder, options);
}

export async function mutate(folder: string, update: (data: CycleRecord) => void, options: CycleOptions): Promise<void> {
  await options.withLock(join(folder, 'cycle.lock'), () => {
    const data = read(join(folder, 'cycle.json'));
    if (data.status !== 'open') throw new Error('engineering observation cycle is closed');
    update(data); atomicJson(join(folder, 'cycle.json'), data);
  });
}

export async function begin(folder: string, stage: Stage, owner: string, description: string, options: CycleOptions) {
  if (!isStage(stage) || !owner.trim() || !description.trim()) throw new Error('review activity needs an explicit stage, owner and description');
  const activity_id = 'activity-' + randomUUID().replaceAll('-', '');
  await mutate(folder, data => { data.activities.push({ activity_id, stage, owner, description, started_unix_s: now(options),
    status: 'running', measurement: 'recorded_review_interval' }); }, options);
  return { activity_id, cycle_id: basename(folder), status: 'running' };
}

export async function end(folder: string, activityId: string, outcome: string, evidence: readonly string[], decision: string, options: CycleOptions) {
  if (!['passed', 'blocked', 'rework'].includes(outcome) || !evidence.length || !decision.trim()) throw new Error('ending review requires outcome, evidence and decision');
  const files = Object.fromEntries(evidence.map(path => [realpathSync(path), sha256File(path)]));
  await mutate(folder, data => {
    const row = data.activities.find(row => row.activity_id === activityId);
    if (!row || row.status !== 'running') throw new Error('review activity is absent or already ended');
    const ended = now(options);
    if (ended < row.started_unix_s) throw new Error('wall clock moved backwards; review interval is unmeasured');
    Object.assign(row, { status: outcome, ended_unix_s: ended, evidence: files, decision, elapsed_s: ended - row.started_unix_s });
  }, options);
  return summarize(folder, options);
}

export async function attach(folder: string, runPath: string, options: CycleOptions, explicitStage?: Stage): Promise<void> {
  const runFolder = realpathSync(runPath), manifest = readObject<RunManifest>(join(runFolder, 'run.json'));
  const stage = explicitStage || (manifest.operation === 'design' ? manifest.design_stage : undefined) || OPERATION_STAGE[manifest.operation];
  if (!isStage(stage)) throw new Error('operation requires an explicit engineering stage');
  await mutate(folder, data => {
    if (realpathSync(manifest.root) !== data.root || manifest.board !== data.board) throw new Error('run belongs to another board or checkout');
    if (data.runs.some(row => row.run_id === manifest.run_id)) throw new Error('run already belongs to this cycle');
    data.runs.push({ run_id: manifest.run_id, folder: runFolder, stage, manifest_sha256: sha256File(join(runFolder, 'run.json')) });
  }, options);
}

function observeRun(link: RunLink, data: CycleRecord, options: CycleOptions): RunObservation {
  const folder = link.folder, row: RunObservation = { ...link, status: 'unobserved', elapsed_s: null, evidence_verified: false };
  if (!matchesHash(join(folder, 'run.json'), link.manifest_sha256)) throw new Error('linked run manifest changed');
  const manifest = readObject<RunManifest>(join(folder, 'run.json'));
  if (manifest.board !== data.board || realpathSync(manifest.root) !== data.root) throw new Error('linked run changed board or checkout');
  if (!existsSync(join(folder, 'result.json'))) return { ...row, ...options.readers.status(folder) };
  const terminal = readObject<Terminal>(join(folder, 'result.json'));
  if (!terminalStates.has(terminal.status)) throw new Error('linked run is not terminal');
  if (terminal.cleanup?.complete !== true) throw new Error('linked run cleanup is unconfirmed');
  if (!sameValue(terminal.evidence_sha256, evidenceFiles(folder))) throw new Error('linked run evidence changed');
  if (link.result_sha256 && !matchesHash(join(folder, 'result.json'), link.result_sha256)) throw new Error('closed cycle run result changed');
  Object.assign(row, { status: terminal.status, elapsed_s: terminal.elapsed_s ?? null, evidence_verified: true,
    result_sha256: sha256File(join(folder, 'result.json')), timing: terminal.timing, cause: terminal.cause });
  const reportPath = join(folder, 'operation/report.json');
  if (existsSync(reportPath)) {
    const report = readObject<ObservationReport>(reportPath);
    if (report.schema === 'iot-lab.design-assessment.v1') Object.assign(row, { assessment_current: options.readers.currentAssessment(report),
      assessment_status: report.status, assessment_through: report.through, blockers: report.blockers ?? [] });
    if (report.scope === 'assembly_stock_observation') {
      row.order_day_utc = report.order_day_utc;
      row.availability_current_day = report.order_day_utc === new Date(now(options) * 1000).toISOString().slice(0, 10);
      row.availability_inputs_current = !!Object.keys(report.inputs ?? {}).length && Object.entries(report.inputs ?? {}).every(([name, digest]) => matchesHash(resolve(data.root, name), digest))
        && options.readers.stockPopulationCurrent(report);
      row.stock_current = !!(row.availability_current_day && row.availability_inputs_current && report.stock_current);
    }
  }
  const start = timestamp(manifest.created_at), ended = terminal.ended_unix_s, startup = terminal.timing?.supervisor_startup_s;
  if (start === null) throw new Error('invalid run timestamp');
  if (isNumber(ended) && ended >= start) {
    row.observed_interval_unix_s = [start, ended]; row.interval_source = 'recorded_submission_and_terminal_boundaries';
  } else if (isNumber(row.elapsed_s) && isNumber(startup) && startup >= 0) {
    row.observed_interval_unix_s = [start, start + startup + row.elapsed_s]; row.interval_source = 'recorded_submission_startup_and_supervisor_duration';
  } else row.interval_source = 'unknown; no admission/start boundary';
  return row;
}

export function summarize(folderPath: string, options: CycleOptions) {
  const folder = realpathSync(folderPath), data = read(join(folder, 'cycle.json'));
  const issues: ObjectData[] = [], intervals: [number, number][] = [];
  const activities = data.activities.map(activity => {
    if (activity.status !== 'running') {
      for (const [path, expected] of Object.entries(activity.evidence ?? {})) if (!matchesHash(path, expected)) issues.push({ activity_id: activity.activity_id, cause: 'review evidence changed', path });
      intervals.push([activity.started_unix_s, activity.ended_unix_s!]);
    }
    return { ...activity };
  });
  const runs = data.runs.map(link => {
    try { const row = observeRun(link, data, options); if (row.observed_interval_unix_s) intervals.push(row.observed_interval_unix_s); return row; }
    catch (error) {
      const cause = error instanceof Error ? error.message : String(error); issues.push({ run_id: link.run_id, cause });
      return { ...link, status: 'stale', elapsed_s: null, evidence_verified: false, cause } as RunObservation;
    }
  });
  const observed = new Set([...activities, ...runs].map(row => row.stage));
  const stages = Object.fromEntries(STAGES.map(stage => {
    const reviews = activities.filter(row => row.stage === stage), jobs = runs.filter(row => row.stage === stage);
    return [stage, { observed: observed.has(stage), review_elapsed_s: unionSeconds(reviews.filter(row => row.ended_unix_s !== undefined).map(row => [row.started_unix_s, row.ended_unix_s])),
      run_elapsed_s: unionSeconds(jobs.flatMap(row => row.observed_interval_unix_s ? [row.observed_interval_unix_s] : [])),
      sum_run_duration_s: jobs.length ? jobs.reduce((sum, row) => sum + (isNumber(row.elapsed_s) ? row.elapsed_s : 0), 0) : null,
      run_interval_coverage: jobs.length && jobs.every(row => row.observed_interval_unix_s) ? 'complete' : jobs.some(row => row.observed_interval_unix_s) ? 'partial' : 'unavailable',
      runs: jobs.length, rework: reviews.filter(row => row.status === 'rework').length, blocked: [...reviews, ...jobs].filter(row => blockedStates.has(row.status)).length }];
  }));
  const recordedCauses = [...activities, ...runs].filter(row => blockedStates.has(row.status) || row.status === 'rework').flatMap(row => {
    const job = row as RunObservation, review = row as Activity;
    const causes = job.blockers?.length ? job.blockers : [{ detail: review.decision || job.cause || 'Cause unrecorded' }];
    return causes.map(cause => ({ stage: row.stage, outcome: row.status, run_id: job.run_id ?? null, activity_id: review.activity_id ?? null,
      code: cause.code ?? null, cause: cause.detail ?? null, requirement: cause.requirement ?? null, check: cause.check ?? null }));
  });
  return { ...data, ...(data.design_contract ? { design_context_current: matchesHash(data.design_contract.path, data.design_contract.sha256) } : {}),
    activities, runs, stages, evidence_issues: issues, recorded_failure_rework_causes: recordedCauses, covered_elapsed_s: unionSeconds(intervals),
    unobserved_stages: STAGES.filter(stage => !observed.has(stage)), elapsed_s: Math.max(0, (data.ended_unix_s ?? now(options)) - data.started_unix_s),
    effort_scope: 'recorded intervals and owned runs; human attention and unrecorded work are unknown', evidence: join(folder, 'cycle.json') };
}

export async function finish(folder: string, options: CycleOptions) {
  await mutate(folder, data => {
    const state = summarize(folder, options);
    if (state.evidence_issues.length || state.activities.some(row => row.status === 'running')) throw new Error('resolve changed evidence and end recorded review activities before closing');
    if (state.runs.some(row => !row.evidence_verified)) throw new Error('linked runs must have verified terminal evidence before closing');
    for (const link of data.runs) link.result_sha256 = sha256File(join(link.folder, 'result.json'));
    data.status = 'recorded'; data.ended_unix_s = now(options);
  }, options);
  return summarize(folder, options);
}
