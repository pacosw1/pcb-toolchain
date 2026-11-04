// Compare attributed placement and routing outcomes without tuning or running CAD. Historical observations stay useful
// after canonical CAD changes. Comparative readiness also needs equal recorded execution controls, paired trials and a
// board-family holdout disjoint from development. No result qualifies CAD.
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { errorText } from './cli.ts';
import { positiveDegrees } from './decimal.ts';
import { identity } from './fingerprint.ts';
import { parseIso } from './iso-time.ts';
import { sha256File } from './json-file.ts';
import { canonical, footprints } from './native-board.ts';
import { executionPolicy, verifiedFailedAttempt, type Attempt, type RunContext, type ThermalServices, type Trial } from './outcome-controls.ts';
import { asDict, Evidence, finite, sealedRun } from './outcome-evidence.ts';
import { nativeObservation, retainedCopper, routedQuality, type NativeCounts } from './outcome-quality.ts';
import { lexists, pyRepr } from './py-compat.mjs';
import { isFile, joinPath, resolvePath, textOf } from './py-path.ts';
import { need, type Dict } from './py-values.ts';
import { forms, type SList } from './sexpr.ts';
import { unionSeconds } from './timing.ts';

export const STUDY = 'iot-lab.placement-outcome-study.v1';
export const REPORT = 'iot-lab.placement-outcome-comparison.v1';
const SIDECARS = ['.kicad_sch', '.kicad_pro', '.kicad_dru'];
const NEEDS_ACCEPTANCE = 'complete fresh native acceptance and verified execution controls are required';
const IMPLEMENTATION = ['placement-outcomes.ts', 'outcome-evidence.ts', 'outcome-controls.ts', 'outcome-quality.ts', 'native-board.ts', 'fingerprint.ts', 'decimal.ts', 'sexpr.ts', 'timing.ts'];

/** Borrowed from their owners: pcb_identity from the workflow family, the thermal proof from the routing family. */
export interface OutcomeServices {
  pcbIdentity: (path: string) => unknown;
  thermal: ThermalServices;
}

/** The repository sources this observer depends on. */
function toolInputs(): Map<string, string> {
  const here = dirname(fileURLToPath(import.meta.url));
  return new Map(IMPLEMENTATION.map(name => [joinPath(here, name), sha256File(joinPath(here, name))]));
}

function fullAcceptance(terminal: Dict, operation: Dict, gate: Dict, native: NativeCounts | null): boolean {
  const checks = Object.values(asDict(gate.checks)) as Dict[];
  return terminal.status === 'passed' && operation.candidate_verified === true && operation.identity_preserved === true && operation.source_unchanged === true
    && !(operation.protected_source_changes as unknown[] | undefined)?.length && gate.exit === 0 && gate.changedDuringRun === false
    && !(gate.preflightErrors as unknown[] | undefined)?.length && native !== null && native.errors === 0 && native.opens === 0 && native.parity === 0
    && checks.length > 0 && checks.every(row => row.status === 'passed' && !row.cached);
}

interface Placement { sha256: string | null; caseFingerprint: string | null; poseFingerprint: string | null; unknowns: string[] }

function expectedInput(evidence: Evidence, trial: Trial, manifest: Dict, source: Dict, relative: string): unknown {
  if (!manifest.from_run) return asDict(source.files)[relative];
  const parent = trial.parent_run as Dict | undefined;
  if (!parent) throw new Error('continued run needs its original sealed placement parent');
  const { operation } = sealedRun(evidence, need<string>(parent, 'path'), need<string>(parent, 'sha256'));
  if (parent.sha256 !== need(manifest.from_run, 'result_sha256')) throw new Error('continued input parent differs from the admitted run');
  return operation.candidate_sha256;
}

function placementInput(evidence: Evidence, trial: Trial, manifest: Dict, source: Dict, services: OutcomeServices): Placement {
  const reference = trial.placement_input;
  if (!reference) return { sha256: null, caseFingerprint: null, poseFingerprint: null, unknowns: ['original placement input artifact is absent'] };
  const path = evidence.file(need<string>(reference, 'path'), need<string>(reference, 'sha256'));
  const sha256 = evidence.inputs.get(path) as string;
  const stem = `hardware-design/boards/${need<string>(manifest, 'board')}/${need<string>(manifest, 'project')}`;
  if (expectedInput(evidence, trial, manifest, source, `${stem}.kicad_pcb`) !== sha256) throw new Error('placement input differs from the original route input');
  const copper = retainedCopper(forms(textOf(path))[0] as SList);
  const files = asDict(source.files);
  const sidecars = Object.fromEntries(SIDECARS.map(extension => [extension, files[stem + extension] ?? null]));
  const unknowns = Object.values(sidecars).some(digest => !digest) ? ['original native sidecar identities are incomplete'] : [];
  const caseFingerprint = identity({ identity: services.pcbIdentity(path), retained_copper: copper, sidecars });
  const poses = new Map(footprints(path).map(part => [part.props.get('Reference') as string,
    [canonical(part.pose[0]), canonical(part.pose[1]), canonical(positiveDegrees(part.pose[2]))]]));
  return { sha256, caseFingerprint, poseFingerprint: identity(poses), unknowns };
}

function observedInterval(manifest: Dict, terminal: Dict): [number, number] | null {
  try {
    const start = parseIso(need<string>(manifest, 'created_at'));
    const end = terminal.ended_unix_s;
    return start.zoned && finite(end) && end >= start.seconds ? [start.seconds, end] : null;
  } catch {
    return null;
  }
}

function failureClass(status: unknown, native: NativeCounts | null, checks: Dict): string | null {
  if (status === 'timeout' || status === 'cancelled') return status;
  if (native?.errors) return 'native_errors';
  if (native?.parity) return 'native_parity';
  if (native?.opens) return 'routing_opens';
  if (status === 'failed' && Object.keys(checks).length) return 'configured_or_electrical_check';
  return status !== 'passed' ? 'tool_or_preflight' : null;
}

export function cliObservation(evidence: Evidence, trial: Trial, services: OutcomeServices): Dict {
  const { folder, terminal, manifest, operation, candidate } = sealedRun(evidence, need<string>(trial, 'path'), need<string>(trial, 'sha256'));
  if (!['route', 'repair'].includes(manifest.operation as string) && !(manifest.operation === 'edit' && manifest.kind === 'route')) {
    throw new Error('trial must measure actual routing/repair, not a proxy or check-only run');
  }
  const gatePath = joinPath(folder, 'gate/result.json');
  const gate = isFile(gatePath) ? evidence.read(gatePath) : {};
  const native = nativeObservation(evidence, folder, gate, candidate);
  const checks = asDict(gate.checks);
  const full = fullAcceptance(terminal, operation, gate, native);
  if (terminal.status === 'passed' && !full) throw new Error('passed run lacks complete fresh native/configured acceptance');
  const sourcePath = joinPath(folder, 'operation/source.json');
  const source = isFile(sourcePath) ? evidence.read(sourcePath) : {};
  const placement = placementInput(evidence, trial, manifest, source, services);
  const unknowns = [...placement.unknowns];
  const run: RunContext = { evidence, folder, trial, manifest, source, thermal: services.thermal };
  const [policy, missing] = executionPolicy(run, gate, { candidate, placementSha256: placement.sha256 });
  const attempt: Attempt = verifiedFailedAttempt(run, terminal, operation, unknowns.length ? null : placement.sha256);
  const acceptanceUnknowns: string[] = [];
  if (missing && attempt.status === 'verified') {
    acceptanceUnknowns.push(missing);
  } else if (missing) {
    unknowns.push(missing);
    if (terminal.status === 'failed') unknowns.push(`failed attempt execution is unverified: ${String(attempt.cause)}`);
  }
  const quality = full && policy ? routedQuality(evidence, candidate as string) : {
    routed_track_length_mm: null, routed_via_count: null,
    unknowns: { routed_track_length_mm: NEEDS_ACCEPTANCE, routed_via_count: NEEDS_ACCEPTANCE },
  };
  return {
    status: terminal.status, evidence_valid: true, board: need(manifest, 'board'), run_id: need(manifest, 'run_id'), evidence_directory: folder,
    failed_checks: Object.entries(checks).filter(([, check]) => asDict(check).status !== 'passed').map(([name]) => name).sort(),
    full_gate_success: full, native, electrical_metrics: Object.keys(asDict(gate.metrics)).length ? gate.metrics : null, routed_quality: quality,
    elapsed_s: finite(terminal.elapsed_s) ? terminal.elapsed_s : null, observed_interval_unix_s: observedInterval(manifest, terminal),
    timing_scope: 'owned route/repair and verification run; unrecorded engineering effort unknown', timing: terminal.timing ?? null,
    failure_class: failureClass(terminal.status, native, checks), cause: terminal.cause || operation.cause || null, case_fingerprint: placement.caseFingerprint,
    placement_input_sha256: placement.sha256, placement_pose_fingerprint: placement.poseFingerprint,
    policy_fingerprint: policy, execution_attempt: attempt, acceptance_unknowns: acceptanceUnknowns, unknowns, qualified: false,
  };
}

const LEGACY_UNKNOWN = 'legacy archive lacks equal execution controls, full configured acceptance and held-out repetition';

/** The rows of a legacy placement loop archive. Every artifact resolves under the archive, not its recorded paths. */
function archiveObservations(evidence: Evidence, trial: Trial): Dict[] {
  const folder = resolvePath(joinPath(evidence.root, need<string>(trial, 'path')));
  const run = evidence.read(joinPath(folder, 'run.json'), need<string>(trial, 'sha256'));
  return need<Dict[]>(run, 'steps').map((step, index) => {
    const base = `step-${index}`;
    const names = ['prob.json', 'search/res.json', 'route-0/drc.json', 'route-0/report.json', 'route-0/routed.kicad_pcb'].map(name => `${base}/${name}`);
    for (const name of names) evidence.file(joinPath(folder, name));
    const candidate = need<Dict[]>(evidence.read(joinPath(folder, base, 'search/res.json')), 'candidates')[0] as Dict;
    const native = evidence.read(joinPath(folder, base, 'route-0/drc.json'));
    const errors = need<Dict[]>(native, 'violations').filter(row => row.severity === 'error').length;
    const opens = need<unknown[]>(native, 'unconnected_items').length;
    return {
      status: 'observed', evidence_valid: true, step: index, real_outline: Math.abs(need<number>(step, 'k') - 1) < 1e-6,
      native: { errors, opens, parity: null, warnings: null }, full_gate_success: false, elapsed_s: null,
      components: need(candidate, 'components'), proxy_cost: need(candidate, 'cost'),
      failure_class: errors ? 'native_errors' : opens ? 'routing_opens' : null, case_fingerprint: null, policy_fingerprint: null,
      unknowns: [LEGACY_UNKNOWN], qualified: false,
    };
  });
}

type Row = Dict;
interface Pair { key: [unknown, unknown, unknown, unknown]; arms: Map<unknown, Row> }

const tupleText = (key: readonly unknown[]): string => `(${pyRepr([...key]).slice(1, -1)})`;

function checkTrialIdentity(base: Dict, ids: Set<unknown>, arms: unknown[], development: Set<unknown>, holdout: Set<unknown>): void {
  const replicate = base.replicate;
  if (!base.id || ids.has(base.id) || !arms.includes(base.arm) || !['development', 'holdout'].includes(base.split as string)
      || !(base.split === 'development' ? development : holdout).has(base.family) || !base.case
      || !Number.isInteger(replicate) || (replicate as number) < 1) {
    throw new Error('trial identity, partition or repetition is invalid');
  }
}

class Study {
  readonly evidence: Evidence;
  readonly services: OutcomeServices;
  readonly rows: Row[] = [];
  readonly blockers: Dict[] = [];
  readonly pairs = new Map<string, Pair>();
  readonly usedRuns = new Set<string>();
  private readonly ids = new Set<unknown>();

  constructor(evidence: Evidence, services: OutcomeServices) {
    this.evidence = evidence;
    this.services = services;
  }

  private addLegacy(base: Dict, observation: Dict): void {
    const id = `${String(base.id)}:step-${String(observation.step)}`;
    this.rows.push({ ...base, ...observation, id });
    this.blockers.push({ code: 'legacy_observational_only', trial: id, detail: (observation.unknowns as string[]).join('; ') });
  }

  private addControlled(base: Dict, observation: Dict, runKeys: Set<string>, folder: string): void {
    runKeys.add(`manifest\0${String(this.evidence.inputs.get(joinPath(folder, 'run.json')))}`);
    if ([...runKeys].some(key => this.usedRuns.has(key))) throw new Error('same sealed run reused as an independent trial');
    const key = [base.split, base.family, base.case, base.replicate] as Pair['key'];
    const text = JSON.stringify(key);
    const pair = this.pairs.get(text) ?? { key, arms: new Map() };
    this.pairs.set(text, pair);
    if (pair.arms.has(base.arm)) throw new Error('duplicate arm within paired repetition');
    const row = { ...base, ...observation };
    pair.arms.set(base.arm, row);
    for (const used of runKeys) this.usedRuns.add(used);
    this.rows.push(row);
    const unknowns = observation.unknowns as string[];
    if (unknowns.length) this.blockers.push({ code: 'trial_controls_unknown', trial: base.id, detail: unknowns.join('; ') });
  }

  private observe(trial: Trial, base: Dict, arms: unknown[], development: Set<unknown>, holdout: Set<unknown>): void {
    checkTrialIdentity(base, this.ids, arms, development, holdout);
    this.ids.add(base.id);
    const runKeys = new Set<string>();
    let folder = '';
    if (trial.kind === 'cli_run') {
      folder = resolvePath(joinPath(this.evidence.root, need<string>(trial, 'path')));
      runKeys.add(`folder\0${folder}`);
      runKeys.add(`result\0${need<string>(trial, 'sha256')}`);
      if ([...runKeys].some(key => this.usedRuns.has(key))) throw new Error('same sealed run reused as an independent trial');
    }
    const legacy = trial.kind === 'placement_archive';
    const observations = legacy ? archiveObservations(this.evidence, trial) : trial.kind === 'cli_run' ? [cliObservation(this.evidence, trial, this.services)] : [];
    if (!observations.length) throw new Error('unknown observation adapter');
    for (const observation of observations) {
      if (legacy) this.addLegacy(base, observation);
      else this.addControlled(base, observation, runKeys, folder);
    }
  }

  add(trial: Trial, arms: unknown[], development: Set<unknown>, holdout: Set<unknown>): void {
    const base = Object.fromEntries(['id', 'arm', 'split', 'family', 'case', 'replicate'].map(key => [key, trial[key] ?? null]));
    try {
      this.observe(trial, base, arms, development, holdout);
    } catch (error) {
      const text = errorText(error);
      this.rows.push({ ...base, status: 'unknown', evidence_valid: false, full_gate_success: false, elapsed_s: null, failure_class: 'evidence_invalid', cause: text, unknowns: [text] });
      this.blockers.push({ code: 'trial_evidence_invalid', trial: base.id, detail: text });
    }
  }

  checkPairs(arms: unknown[]): void {
    const [first, second] = arms;
    for (const { key, arms: pair } of this.pairs.values()) {
      const a = pair.get(first), b = pair.get(second);
      if (!a || !b || pair.size !== arms.length) this.blockers.push({ code: 'unpaired_trial', detail: tupleText(key) });
      else if (!a.case_fingerprint || a.case_fingerprint !== b.case_fingerprint || !a.policy_fingerprint || a.policy_fingerprint !== b.policy_fingerprint) {
        this.blockers.push({ code: 'unequal_case_or_execution', detail: tupleText(key) });
      }
    }
  }

  checkRepetition(): void {
    for (const split of ['development', 'holdout']) {
      const samples = [...this.pairs.values()].map(pair => pair.key).filter(key => key[0] === split);
      const cases = new Map<string, Set<unknown>>();
      for (const key of samples) {
        const name = JSON.stringify(key.slice(1, 3));
        cases.set(name, (cases.get(name) ?? new Set()).add(key[3]));
      }
      if (!samples.length || [...cases.values()].some(replicates => replicates.size < 2)) {
        this.blockers.push({ code: 'repetition_missing', detail: `${split}: paired repeated measurements are absent` });
      }
    }
  }

  checkHoldout(): void {
    const of = (split: string) => new Set(this.rows.filter(row => row.split === split && row.case_fingerprint).map(row => row.case_fingerprint));
    const holdout = of('holdout');
    if ([...of('development')].some(item => holdout.has(item))) {
      this.blockers.push({ code: 'holdout_input_overlap', detail: 'identical electrical/copper source case appears in both partitions' });
    }
  }

  summary(arm: unknown): Dict {
    const group = this.rows.filter(row => row.arm === arm);
    const durations = group.map(row => row.elapsed_s).filter(finite);
    const failures = new Map<string, number>();
    for (const { failure_class: name } of group) if (name) failures.set(name as string, (failures.get(name as string) ?? 0) + 1);
    const intervals = group.map(row => row.observed_interval_unix_s).filter(Boolean) as [unknown, unknown][];
    const total = durations.reduce((sum, value) => sum + value, 0);
    return {
      trials: group.length, full_gate_successes: group.filter(row => row.full_gate_success).length, unknown_outcomes: group.filter(row => !row.evidence_valid).length,
      failure_classes: failures, observed_owned_elapsed_s: durations.length ? total : null,
      total_owned_elapsed_s: durations.length === group.length && group.length ? total : null, recorded_run_coverage_s: unionSeconds(intervals),
      total_recorded_run_coverage_s: group.length && intervals.length === group.length ? unionSeconds(intervals) : null,
      unknown_duration_count: group.length - durations.length,
    };
  }
}

function checkUnchanged(evidence: Evidence): void {
  for (const [name, digest] of evidence.inputs) {
    if (digest === null ? lexists(name) : sha256File(name) !== digest) throw new Error('study evidence changed during evaluation');
  }
}

function nextAction(ready: boolean, rows: Row[], blockers: Dict[], studyId: string, manifest: string): Dict {
  const failed = rows.find(row => row.split === 'holdout' && !row.full_gate_success);
  if (ready && failed) {
    return {
      kind: 'diagnose_failed_heldout_trials', reason: 'Diagnose the recorded held-out failures before considering any policy change',
      argv: ['tools/pcb', 'explain', '--runs-dir', dirname(need<string>(failed, 'evidence_directory')), need<string>(failed, 'run_id'), '--json'],
    };
  }
  return {
    kind: ready ? 'review_controlled_outcomes' : 'complete_comparison_evidence',
    reason: ready ? 'Review paired complete native/electrical outcomes before any separate policy decision' : blockers[0]?.detail,
    argv: ['tools/pcb', 'outcomes', '--json', 'evaluate', studyId, '--manifest', manifest],
  };
}

export function evaluateStudy(root: string, manifest: string, studyIdGiven: string | null, services: OutcomeServices): Dict {
  const evidence = new Evidence(root);
  const path = resolvePath(joinPath(evidence.root, manifest));
  const value = evidence.read(path);
  const studyId = (studyIdGiven || value.study_id) as string;
  if (value.schema !== STUDY || value.study_id !== studyId) throw new Error('unknown study schema or identity');
  const arms = value.arms ?? [];
  if (!Array.isArray(arms) || arms.length !== 2 || new Set(arms).size !== 2) throw new Error('study needs distinct baseline/proposal arms');
  const development = new Set((value.development_families ?? []) as unknown[]), holdout = new Set((value.holdout_families ?? []) as unknown[]);
  const study = new Study(evidence, services);
  if (!development.size || !holdout.size || [...development].some(family => holdout.has(family))) {
    study.blockers.push({ code: 'holdout_not_disjoint', detail: 'declare nonempty board-family development/holdout sets with no overlap' });
  }
  for (const trial of (value.trials ?? []) as Trial[]) study.add(trial, arms, development, holdout);
  if (!study.rows.length) study.blockers.push({ code: 'no_observations', detail: 'provide actual archived routing/native outcomes' });
  study.checkPairs(arms);
  study.checkRepetition();
  study.checkHoldout();
  const summary = new Map(arms.map(arm => [arm as string, study.summary(arm)]));
  checkUnchanged(evidence);
  const { rows, blockers } = study;
  const ready = !blockers.length;
  return {
    schema: REPORT, study_id: studyId, status: ready ? 'passed' : 'blocked', qualified: false, adopt_weights: false,
    observational_ready: rows.some(row => row.evidence_valid), comparative_readiness: ready,
    scope: 'declared historical routing trials only; omitted attempts, current CAD validity and unrecorded engineering effort are unknown',
    holdout_scope: 'disjoint declared board families and native case identities; unrecorded model-selection access is unknown',
    observations: rows, arms: summary, blockers, inputs: evidence.inputs, tool_inputs: toolInputs(), next_action: nextAction(ready, rows, blockers, studyId, path),
  };
}

export function terminalSummary(result: Dict, output: string): Dict {
  const path = resolvePath(output);
  return {
    schema: result.schema, status: result.status, study_id: result.study_id, qualified: false, observational_ready: result.observational_ready ?? false,
    comparative_readiness: result.comparative_readiness ?? false, adopt_weights: false, blockers: ((result.blockers ?? []) as unknown[]).length,
    next_action: result.next_action ?? null, report: { path, sha256: sha256File(path) },
  };
}
