// Evidence mutations, honest unknowns and controlled partition checks; no CAD jobs. The thermal services are fakes except in the
// last group, which goes through the real proof.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { identityCommand, iotroutePolicy, POLICY, verifiedFailedAttempt, type RunContext, type Trial } from './outcome-controls.ts';
import { Evidence, sealedRun } from './outcome-evidence.ts';
import { retainedCopper, routedQuality } from './outcome-quality.ts';
import { sha256File } from './json-file.ts';
import { localThermalProof, thermalServices } from './outcome-thermal.ts';
import { cliObservation, evaluateStudy, REPORT, STUDY, terminalSummary, type OutcomeServices } from './placement-outcomes.ts';
import { cliObservation as wiredObservation } from '../placement_outcomes.ts';
import { forms, type SList } from './sexpr.ts';

type Row = Record<string, any>;

const fp = (ref: string, x: number, y: number) => `(footprint "Test:Exact" (layer "F.Cu") (at ${x} ${y}) (uuid "${ref}")
  (property "Reference" "${ref}" (at 0 0)) (property "Value" "fixture")
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "N") (uuid "${ref}-pad")))`;
const write = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};
const read = (path: string): Row => JSON.parse(readFileSync(path, 'utf8'));

function* walk(folder: string): Generator<string> {
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** The family decides the identity, as its native definition does in the Python fixture. */
const services: OutcomeServices = {
  pcbIdentity: path => /"family" "(\w+)"/.exec(readFileSync(path, 'utf8'))?.[1] ?? 'unknown',
  thermal: {
    discharge: () => { throw new Error('this fixture has no thermal discharge'); },
    validateCapability: () => ({ inputs: {} }),
  },
};

let root: string, study: Row, manifest: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'outcomes-')));
  study = { schema: STUDY, study_id: 'placement-review', arms: ['baseline', 'proposal'], development_families: ['DEV'], holdout_families: ['HOLD'], trials: [] };
  manifest = join(root, 'study.json');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function reseal(folder: string, status = 'passed'): void {
  const operation = read(join(folder, 'operation/result.json'));
  const paths = [join(folder, 'run.json')];
  for (const directory of ['operation', 'gate']) {
    if (statSync(join(folder, directory), { throwIfNoEntry: false })) paths.push(...walk(join(folder, directory)));
  }
  if (operation.candidate) paths.push(join(folder, 'workspace', relative(operation.workspace, operation.candidate)));
  write(join(folder, 'result.json'), {
    status, cleanup: { complete: true }, elapsed_s: 2, ended_unix_s: 1792108802, cause: `fixture ${status}`,
    evidence_sha256: Object.fromEntries(paths.map(path => [relative(folder, path), sha256File(path)])),
  });
}

function runFixture(split: string, family: string, arm: string, replicate: number, status = 'passed', controlled = true): [string, Row] {
  const name = `${split}-${arm}-${replicate}`, folder = join(root, name);
  const nativeRel = `hardware-design/boards/${family}/native.kicad_pcb`;
  const native = join(folder, 'workspace', nativeRel);
  const original = join(root, 'inputs', name, 'native.kicad_pcb');
  const text = `(kicad_pcb (version 20260101) ${fp('U1', family === 'DEV' ? 10 : 20, 10)}(property "family" "${family}"))`;
  mkdirSync(dirname(original), { recursive: true });
  mkdirSync(dirname(native), { recursive: true });
  writeFileSync(original, text);
  writeFileSync(native, text);
  const files: Row = { [nativeRel]: sha256File(original), 'tools/pcbtool.py': 'c'.repeat(64) };
  for (const extension of ['.kicad_sch', '.kicad_pro', '.kicad_dru']) {
    const path = native.replace(/\.kicad_pcb$/, extension);
    writeFileSync(path, `original ${extension}`);
    files[nativeRel.replace(/\.kicad_pcb$/, extension)] = sha256File(path);
  }
  const command = ['python3', 'tools/pcbtool.py', 'route', nativeRel, 'spec.json'];
  write(join(folder, 'run.json'), {
    root: '/historical/checkout', board: family, project: 'native', run_id: name, operation: 'route',
    created_at: '2026-10-16T00:00:00Z', spec: { route: {} }, gate_config_sha256: 'd'.repeat(64),
  });
  write(join(folder, 'operation/source.json'), { files });
  write(join(folder, 'operation/result.json'), {
    candidate: `/historical/checkout/.gate/cli/${name}/workspace/${nativeRel}`, workspace: `/historical/checkout/.gate/cli/${name}/workspace`,
    candidate_sha256: sha256File(native), candidate_verified: status === 'passed', identity_preserved: true, source_unchanged: true,
    protected_source_changes: [], status, cause: 'fixture outcome',
  });
  write(join(folder, 'operation/events.jsonl'), { type: 'tool.start', command });
  const errors = status === 'failed' ? 1 : 0;
  write(join(folder, 'gate/drc.json'), {
    source: 'native.kicad_pcb', coordinate_units: 'mm', included_severities: ['error', 'warning', 'exclusion'],
    violations: Array(errors).fill({ severity: 'error' }), schematic_parity: [], unconnected_items: [],
  });
  write(join(folder, 'gate/result.json'), {
    exit: status === 'passed' ? 0 : 1, changedDuringRun: false, preflightErrors: [],
    metrics: { drc_errors: errors, drc_unconnected: 0, drc_parity: 0, paths_low: 0 },
    checks: { drc: { status: errors ? 'failed' : 'passed', cached: false }, paths: { status: 'passed', cached: false } },
    provenance: { inputs: [{ path: nativeRel, sha256: sha256File(native) }], tools: { kicad: '10.0.6' } },
  });
  const trial: Row = {
    id: name, kind: 'cli_run', path: folder, arm, split, family, case: 'fixed-case', replicate,
    placement_input: { path: original, sha256: sha256File(original) },
  };
  if (controlled) {
    write(join(folder, 'operation/execution-policy.json'), {
      schema: POLICY, command, runtime: { image_id: `sha256:${'a'.repeat(64)}`, tools: { router: { sha256: 'b'.repeat(64), version: 'test fixture' } } },
      resources: { cpus: 2, memory_bytes: 2147483648, threads: 1 }, effort: { timeout_s: 30, passes: 40, max_repairs: 0, optimizer: 'if-routed' },
    });
    trial.execution_policy = 'operation/execution-policy.json';
  }
  reseal(folder, status);
  trial.sha256 = sha256File(join(folder, 'result.json'));
  study.trials.push(trial);
  return [folder, trial];
}

const evaluate = (): Row => {
  write(manifest, study);
  return evaluateStudy(root, manifest, null, services);
};
const controlledStudy = () => {
  for (const [split, family] of [['development', 'DEV'], ['holdout', 'HOLD']] as const) {
    for (const arm of study.arms) for (const replicate of [1, 2]) runFixture(split, family, arm, replicate);
  }
};
const codes = (report: Row): string[] => report.blockers.map((row: Row) => row.code);
test('wired routing observer reads a sealed nonthermal trial without claiming qualification', () => {
  const [, trial] = runFixture('development', 'DEV', 'baseline', 1);
  const evidence = new Evidence(root);
  const result = wiredObservation(evidence, trial as Trial);
  assert.equal(result.evidence_valid, true);
  assert.equal(result.qualified, false);
  assert.equal(result.full_gate_success, true);
  assert.ok(evidence.inputs.size > 0);
});
const update = (path: string, change: (value: Row) => void) => {
  const value = read(path);
  change(value);
  write(path, value);
};
const resealed = (folder: string, trial: Row, status = 'passed') => {
  reseal(folder, status);
  trial.sha256 = sha256File(join(folder, 'result.json'));
};

test('equal paired disjoint trials allow review but never weight adoption', () => {
  controlledStudy();
  const report = evaluate();
  assert.equal(report.status, 'passed');
  assert.equal(report.comparative_readiness, true);
  assert.equal(report.qualified, false);
  assert.equal(report.adopt_weights, false);
  const baseline = report.arms.get('baseline');
  assert.equal(baseline.full_gate_successes, 4);
  assert.equal(baseline.observed_owned_elapsed_s, 8);
  assert.equal(baseline.recorded_run_coverage_s, 1792108802 - Date.parse('2026-10-16T00:00:00Z') / 1000);
  assert.ok(report.inputs.size);
  assert.ok([...report.tool_inputs.keys()].some((path: string) => path.endsWith('placement-outcomes.ts')));
});

test('absent controls stay observational and a timeout is in the denominator', () => {
  runFixture('development', 'DEV', 'baseline', 1, 'timeout', false);
  const report = evaluate();
  const row = report.observations[0];
  assert.equal(report.observational_ready, true);
  assert.equal(report.comparative_readiness, false);
  assert.equal(row.status, 'timeout');
  assert.equal(row.failure_class, 'timeout');
  assert.equal(report.arms.get('baseline').trials, 1);
  assert.equal(report.arms.get('baseline').full_gate_successes, 0);
  assert.ok(codes(report).includes('trial_controls_unknown'));
});

test('a prepared solver policy stays unknown and keeps the failed trial', () => {
  const [folder, trial] = runFixture('development', 'DEV', 'baseline', 1, 'timeout');
  update(join(folder, 'run.json'), run => { run.router = 'fastroute'; });
  const path = join(folder, trial.execution_policy);
  update(path, policy => { policy.controls = { status: 'prepared', effective_configuration_verified: false }; });
  resealed(folder, trial, 'timeout');
  const report = evaluate();
  const row = report.observations[0];
  assert.equal(row.evidence_valid, true);
  assert.equal(row.failure_class, 'timeout');
  assert.equal(row.policy_fingerprint, null);
  assert.ok(codes(report).includes('trial_controls_unknown'));
  const context = join(folder, 'operation/execution-context.json');
  write(context, { fixture: 'archived host context' });
  const effective = join(folder, 'operation/router/effective-configuration.json');
  write(effective, { fixture: 'observed controls' });
  const actual = join(folder, 'operation/router/input-manifest.json');
  write(actual, { fixture: 'observed input' });
  update(path, policy => {
    policy.execution_context = { path: 'operation/execution-context.json', sha256: sha256File(context) };
    Object.assign(policy.controls, {
      effective_configuration_verified: true, effective_configurations: { 'effective-configuration.json': sha256File(effective) }, input_manifest_sha256: sha256File(actual),
    });
  });
  resealed(folder, trial, 'timeout');
  assert.ok(evaluate().observations[0].policy_fingerprint);
  write(context, { fixture: 'changed host context' });
  resealed(folder, trial, 'timeout');
  const changed = evaluate().observations[0];
  assert.equal(changed.evidence_valid, false);
  assert.match(changed.cause, /evidence changed/);
});

test('a rehashed trial pointer does not hide a tampered native report', () => {
  const [folder, trial] = runFixture('development', 'DEV', 'baseline', 1);
  update(join(folder, 'gate/drc.json'), raw => { raw.unconnected_items = [{ type: 'open' }]; });
  trial.sha256 = sha256File(join(folder, 'result.json'));
  const report = evaluate();
  assert.equal(report.observations[0].failure_class, 'evidence_invalid');
  assert.equal(report.comparative_readiness, false);
});

test('a policy mismatch and holdout leakage block comparison', () => {
  controlledStudy();
  const trial = study.trials.at(-1);
  update(join(trial.path, trial.execution_policy), policy => { policy.resources.threads = 8; });
  resealed(trial.path, trial);
  assert.ok(codes(evaluate()).includes('unequal_case_or_execution'));
  study.holdout_families = ['DEV'];
  assert.ok(codes(evaluate()).includes('holdout_not_disjoint'));
});

test('an equal claimed policy cannot hide a different actual route spec', () => {
  controlledStudy();
  const trial = study.trials.at(-1);
  update(join(trial.path, 'run.json'), run => { run.spec.route.passes = 900; });
  resealed(trial.path, trial);
  assert.ok(codes(evaluate()).includes('unequal_case_or_execution'));
});

test('failed held-out trials are counted and request diagnosis', () => {
  controlledStudy();
  const trial = study.trials.at(-1), folder: string = trial.path;
  update(join(folder, 'operation/result.json'), operation => { operation.candidate_verified = false; });
  update(join(folder, 'gate/result.json'), gate => {
    gate.exit = 1;
    gate.metrics.drc_errors = 1;
    gate.checks.drc.status = 'failed';
  });
  update(join(folder, 'gate/drc.json'), native => { native.violations = [{ severity: 'error' }]; });
  resealed(folder, trial, 'failed');
  const report = evaluate();
  assert.equal(report.comparative_readiness, true);
  assert.equal(report.arms.get('proposal').full_gate_successes, 3);
  assert.equal(report.arms.get('proposal').failure_classes.get('native_errors'), 1);
  assert.equal(report.next_action.kind, 'diagnose_failed_heldout_trials');
});

test('the original placement must match the recorded route input', () => {
  const [, trial] = runFixture('development', 'DEV', 'baseline', 1);
  const path = trial.placement_input.path;
  writeFileSync(path, readFileSync(path, 'utf8').replace('(at 10 10)', '(at 11 10)'));
  trial.placement_input.sha256 = sha256File(path);
  assert.match(evaluate().observations[0].cause, /original route input/);
});

test('an incomplete gate and an unknown native severity cannot pass', () => {
  const [folder, trial] = runFixture('development', 'DEV', 'baseline', 1);
  update(join(folder, 'gate/result.json'), gate => { gate.checks.paths.status = 'blocked'; });
  resealed(folder, trial);
  assert.equal(evaluate().observations[0].evidence_valid, false);
  update(join(folder, 'gate/drc.json'), raw => { raw.violations = [{ severity: 'unknown' }]; });
  resealed(folder, trial);
  assert.match(evaluate().observations[0].cause, /native report/);
});

test('the same sealed run cannot be two independent trials', () => {
  const [, trial] = runFixture('development', 'DEV', 'baseline', 1);
  study.trials.push({ ...trial, id: 'alias', arm: 'proposal' });
  assert.match(evaluate().observations[1].cause, /reused as an independent trial/);
});

test('a seal must list exactly the files of the run', () => {
  const [folder, trial] = runFixture('development', 'DEV', 'baseline', 1);
  writeFileSync(join(folder, 'operation/late.log'), 'added after the seal');
  const evidence = new Evidence(root);
  assert.throws(() => sealedRun(evidence, folder, trial.sha256), /inventory differs/);
});

test('retained copper ignores order and zone fill but keeps duplicates', () => {
  const copper = (text: string) => retainedCopper(forms(text)[0] as SList);
  const a = '(segment (start 0 0) (end 1 0) (width 1) (layer "F.Cu"))', b = '(via (at 1 1) (size 1) (drill 0.5) (layers "F.Cu" "B.Cu"))';
  assert.deepEqual(copper(`(kicad_pcb ${a}${b})`), copper(`(kicad_pcb ${b}${a})`));
  assert.notDeepEqual(copper(`(kicad_pcb ${a})`), copper(`(kicad_pcb ${a}${a})`));
  const zone = (fill: string) => `(kicad_pcb (zone (net "N") ${fill}))`;
  assert.deepEqual(copper(zone('(filled_polygon (pts))')), copper(zone('')));
});

test('routed quality measures centreline length and vias, and names what it cannot read', () => {
  const pcb = join(root, 'routed.kicad_pcb');
  const segment = (x: number) => `(segment (start 0 0) (end ${x} 4) (width 0.2) (layer "F.Cu") (net "N"))`;
  writeFileSync(pcb, `(kicad_pcb ${segment(3)}${segment(3)}(via (at 1 1) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "N")))`);
  const quality = routedQuality(new Evidence(root), pcb);
  assert.equal(quality.routed_track_length_mm, 10);
  assert.equal(quality.routed_via_count, 1);
  writeFileSync(pcb, `(kicad_pcb (arc (start 0 0) (mid 1 1) (end 2 0)) (via (at 1 1) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu")))`);
  const arc = routedQuality(new Evidence(root), pcb);
  assert.equal(arc.routed_track_length_mm, null);
  assert.equal(arc.routed_via_count, 1);
  assert.match((arc.unknowns as Row).routed_track_length_mm, /arc/);
  writeFileSync(pcb, '(kicad_pcb (via');
  assert.match((routedQuality(new Evidence(root), pcb).unknowns as Row).routed_via_count, /unbalanced/);
});

test('a saved report has a compact summary', () => {
  const output = join(root, 'full-report.json');
  const full: Row = {
    schema: REPORT, study_id: 'large-study', status: 'blocked', blockers: [{ code: 'controls_unknown' }], observational_ready: true,
    next_action: { kind: 'complete_comparison_evidence', reason: 'Record equal controls', argv: ['tools/pcb', 'outcomes'] },
  };
  write(output, full);
  const summary = terminalSummary(full, output);
  assert.equal(summary.blockers, 1);
  assert.deepEqual(summary.report, { path: output, sha256: sha256File(output) });
  assert.ok(!('inputs' in summary));
});

test('the argv hash is ordered JSON', () => {
  assert.notEqual(identityCommand(['a', 'b']), identityCommand(['b', 'a']));
});

/** A finalized controlled Fastroute failure before a configured gate; no programs run. */
function failedExecution(): [string, Row, () => Row] {
  const [folder, trial] = runFixture('development', 'DEV', 'baseline', 1, 'failed');
  rmSync(join(folder, 'gate'), { recursive: true });
  write(join(folder, 'operation/result.json'), { status: 'failed', exit_code: 1, tool_exit: 1, source_unchanged: true });
  const original: string = trial.placement_input.path, router = join(folder, 'operation/router'), script = '/recorded/tools/fastroute_job.py';
  mkdirSync(router);
  const stem = 'hardware-design/boards/DEV/native';
  const source = read(join(folder, 'operation/source.json'));
  for (const extension of ['.kicad_sch', '.kicad_pro', '.kicad_dru']) writeFileSync(original.replace(/\.kicad_pcb$/, extension), `original ${extension}`);
  const projectFiles = ['.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_dru'];
  const onDisk = (extension: string) => original.replace(/\.kicad_pcb$/, extension);
  for (const extension of projectFiles) source.files[stem + extension] = sha256File(onDisk(extension));
  source.files['tools/fastroute_job.py'] = 'e'.repeat(64);
  source.files['hardware-design/boards/DEV/gate.json'] = 'd'.repeat(64);
  write(join(folder, 'operation/source.json'), source);
  const spec = { schema: 'iot-lab.routing-policy.v1', layers: ['F.Cu'], only_nets: ['N'], passes: 40, threads: 1, timeout_s: 30, optimizer: 'off', max_repairs: 0 };
  update(join(folder, 'run.json'), run => Object.assign(run, { router: 'fastroute', timeout_s: 120, spec }));
  const backend = { mode: 'quality-first', binary_sha256: 'b'.repeat(64), manifest_sha256: 'f'.repeat(64), patch_sha256: '1'.repeat(64), upstream_commit: '2'.repeat(40) };
  const config = {
    board: original, outdir: router, passes: 40, layers: 'F.Cu', only_nets: 'N', threads: 1, max_time: 30, optimizer: 'off', preflight: true,
    skip_net: '', plane_nets: '', gnd_vias: false, route_planes: false, unlock_nets: '', set: [], neck_um: 0, native_thermal_checkback: false,
  };
  const manifestPath = join(router, 'input-manifest.json');
  write(manifestPath, { board_sha256: sha256File(original), router_sha256: 'b'.repeat(64), configuration: config, features: { _board_dir: 'ignored owner path' } });
  const dsn = join(router, 'router-model.dsn');
  writeFileSync(dsn, 'synthetic source-bound DSN\n');
  const invocation = ['/recorded/fastroute', '-de', dsn, '-mp', '40', '--quality-first', '--max-time=30',
    '--router.autorouter.max_threads=1', '--router.optimizer.max_threads=1', '--router.optimizer.enabled=false'];
  const coverage = join(router, 'rule-coverage.json');
  write(coverage, {
    status: 'passed', solver_launch_allowed: true, active_nets: ['N'], job_layers: ['F.Cu'], backend_command: invocation,
    backend_command_sha256: identityCommand(invocation), dsn: { path: dsn, sha256: sha256File(dsn) },
  });
  const effective = join(router, 'effective-configuration.json');
  write(effective, {
    configuration: config, backend_policy: backend, backend_resources: { global_rayon_threads: 1, autorouter_workers: 1, optimizer_workers: 1 },
    command: invocation, dsn_sha256: sha256File(dsn), rule_coverage: { path: coverage, sha256: sha256File(coverage) },
  });
  write(join(router, 'backend-policy.json'), backend);
  write(join(router, 'stages.jsonl'), { stage: 'router-screen', command: invocation, status: 'complete', returncode: 0, cleanup: { complete: true } });
  const context = join(folder, 'operation/execution-context.json');
  const command = ['/recorded/python', script, original, router];
  const policyPath = join(folder, trial.execution_policy);
  const policy = read(policyPath);
  write(context, { Id: '3'.repeat(64), Image: policy.runtime.image_id, HostConfig: { NetworkMode: 'none', Memory: policy.resources.memory_bytes, NanoCpus: 2000000000 } });
  Object.assign(policy, {
    command, effort: { timeout_s: 120, router_timeout_s: 30, passes: 40, max_repairs: 0, optimizer: 'off', backend_policy: backend, feature_policy: {} },
    inputs: { ...Object.fromEntries(projectFiles.map(extension => [onDisk(extension), source.files[stem + extension]])), [script]: 'e'.repeat(64), '/recorded/fastroute': 'b'.repeat(64) },
    environment: { FASTROUTE_BIN: '/recorded/fastroute' },
    execution_context: { path: 'operation/execution-context.json', sha256: sha256File(context), container_id: '3'.repeat(64) },
    controls: {
      status: 'observed', effective_configuration_verified: true, tool_exit: 1,
      effective_configurations: { 'effective-configuration.json': sha256File(effective) }, input_manifest_sha256: sha256File(manifestPath),
    },
  });
  write(policyPath, policy);
  const start = Date.parse('2026-10-16T00:00:00Z') / 1000;
  writeFileSync(join(folder, 'operation/events.jsonl'), `${JSON.stringify({ type: 'tool.start', span_id: 'route', command, started_unix_s: start })}\n${
    JSON.stringify({ type: 'tool.exit', span_id: 'route', code: 1, status: 'failed', ended_unix_s: start + 1 })}\n`);
  const seal = () => {
    reseal(folder, 'failed');
    update(join(folder, 'result.json'), terminal => Object.assign(terminal, { source_unchanged: true, exit_code: 1 }));
    trial.sha256 = sha256File(join(folder, 'result.json'));
    return trial;
  };
  seal();
  return [folder, trial, seal];
}

/** A `--router iotroute` run with the receipt the candidate operation writes from its record. */
function iotrouteRun(status: string, exit: number): [string, Row, () => void] {
  const [folder, trial] = runFixture('development', 'DEV', 'baseline', 1, status);
  const command = ['node', 'tools/router/route-dispatch.mjs', '--', 'iotroute', 'run', 'DEV', 'o.kicad_pcb'];
  const record = {
    status: exit ? 'FAIL' : 'PASS', iters: 40, seed: 7, input_sha256: trial.placement_input.sha256,
    stages: { binary: { sha256: 'b'.repeat(64), sources_sha256: 'c'.repeat(64) } }, remote: { image: 'job-image', cpus: 2, memory_bytes: 4294967296 },
  };
  const summary = join(folder, 'operation/router-summary.json');
  write(summary, record);
  write(join(folder, trial.execution_policy), iotroutePolicy(command, record, sha256File(summary), 120, exit));
  update(join(folder, 'run.json'), run => Object.assign(run, { router: 'iotroute', timeout_s: 120 }));
  if (exit) update(join(folder, 'operation/result.json'), result => Object.assign(result, { tool_exit: exit, exit_code: 1, status: 'failed' }));
  const start = Date.parse('2026-10-16T00:00:00Z') / 1000;
  writeFileSync(join(folder, 'operation/events.jsonl'), `${JSON.stringify({ type: 'tool.start', span_id: 'route', command, started_unix_s: start })}\n${
    JSON.stringify({ type: 'tool.exit', span_id: 'route', code: exit, status: exit ? 'failed' : 'passed', ended_unix_s: start + 1 })}\n`);
  const seal = () => {
    reseal(folder, status);
    if (exit) update(join(folder, 'result.json'), terminal => Object.assign(terminal, { source_unchanged: true, exit_code: 1 }));
    trial.sha256 = sha256File(join(folder, 'result.json'));
  };
  seal();
  return [folder, trial, seal];
}

test('an iotroute run counts: a passed one by its policy, a failed one as a verified attempt', () => {
  iotrouteRun('passed', 0);
  assert.match(evaluate().observations[0].policy_fingerprint, /^[0-9a-f]{64}$/);
  study.trials = [];
  iotrouteRun('failed', 1);
  const row = evaluate().observations[0];
  assert.equal(row.execution_attempt.status, 'verified', row.execution_attempt.cause);
  assert.equal(row.full_gate_success, false);
});

test('an iotroute receipt that differs from the run record is not a control', () => {
  const [folder, trial, seal] = iotrouteRun('failed', 1);
  update(join(folder, trial.execution_policy), policy => { policy.effort.passes = 41; });
  seal();
  const row = evaluate().observations[0];
  assert.equal(row.evidence_valid, false);
  assert.match(row.cause, /differs from its execution policy/);
});

test('a verified failed attempt separates execution from native acceptance', () => {
  failedExecution();
  const row = evaluate().observations[0];
  assert.equal(row.execution_attempt.status, 'verified', row.execution_attempt.cause);
  assert.match(row.execution_attempt.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(row.full_gate_success, false);
  assert.equal(row.native, null);
});

test('each broken control sends a failed attempt back to unknown', () => {
  const policyOf = (folder: string, trial: Row) => join(folder, trial.execution_policy);
  const breaks: [string, RegExp, (folder: string, trial: Row) => void][] = [
    ['tool exit', /matching nonzero tool exit/, (folder, trial) => update(policyOf(folder, trial), policy => { policy.controls.tool_exit = 2; })],
    ['spec passes', /budget\/specification/, folder => update(join(folder, 'run.json'), run => { run.spec.passes = 41; })],
    ['container memory', /runtime\/resources differ/, (folder, trial) => {
      const context = join(folder, 'operation/execution-context.json');
      update(context, value => { value.HostConfig.Memory = 1; });
      update(policyOf(folder, trial), policy => { policy.execution_context.sha256 = sha256File(context); });
    }],
    ['source hash', /source\/tool\/gate-policy/, (folder, trial) => update(policyOf(folder, trial), policy => { policy.inputs[policy.command[2]] = 'f'.repeat(64); })],
    ['launch', /launch is missing/, folder => writeFileSync(join(folder, 'operation/events.jsonl'), `${JSON.stringify({ type: 'tool.start', command: ['other'] })}\n`)],
    ['backend cleanup', /cleanup is unconfirmed/, folder => update(join(folder, 'operation/router/stages.jsonl'), stage => { stage.cleanup.complete = false; })],
  ];
  for (const [name, cause, change] of breaks) {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);
    study.trials = [];
    const [folder, trial, seal] = failedExecution();
    change(folder, trial);
    seal();
    const row = evaluate().observations[0];
    const text = String(row.execution_attempt?.cause ?? row.cause);
    assert.notEqual(row.execution_attempt?.status, 'verified', name);
    assert.match(text, name === 'launch' ? /recorded actual invocation|launch is missing/ : cause, name);
  }
});

test('a failed run that is not a controlled router stays unknown', () => {
  const [folder, trial] = runFixture('development', 'DEV', 'baseline', 1, 'failed');
  const context: RunContext = { evidence: new Evidence(root), folder, trial, manifest: read(join(folder, 'run.json')), source: {}, thermal: services.thermal };
  const attempt = verifiedFailedAttempt(context, { status: 'failed' }, {}, 'a'.repeat(64));
  assert.equal(attempt.status, 'unknown');
  assert.match(attempt.cause as string, /not a finalized failed controlled/);
});

// The thermal proof itself: receipts go through the real route-coverage binary, which reopens the raw native reports. It is a
// Linux job binary (ROUTE_COVERAGE_BIN), so these run on Hetzner. Only its board read is a stub: no KiCad runs here.
const realProof = { skip: process.platform === 'linux' && process.env.ROUTE_COVERAGE_BIN ? false : 'needs the Linux route-coverage binary in ROUTE_COVERAGE_BIN' };
const proofServices: OutcomeServices = { ...services, thermal: thermalServices() };
const SIDECARS = ['.kicad_pcb', '.kicad_pro', '.kicad_dru', '.kicad_sch'];
const sibling = (path: string, extension: string): string => path.replace(/\.kicad_pcb$/, extension);
const descriptor = (path: string): Row => ({ path, sha256: sha256File(path) });

function boardReader(): string {
  const script = join(root, 'board-json.mjs'), launcher = join(root, 'board-json-stub');
  writeFileSync(script, `import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
const path = process.argv[3], hash = file => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : '';
const sidecar = extension => path.replace(/\\.kicad_pcb$/, extension);
const pad = { id: 'U1-pad', number: '1', kind: 'Smd', shape: 'Rect', net: 'N', position: { x: 0, y: 0 }, orientation: 0, size: { x: 1, y: 1 }, drill: { x: 0, y: 0 }, layers: ['F.Cu'], copper: [] };
process.stdout.write(JSON.stringify({ schema: 'iot-lab.board.v1', board_sha256: hash(path), project_sha256: hash(sidecar('.kicad_pro')), rules_sha256: hash(sidecar('.kicad_dru')),
  board: { copper_layers: ['F.Cu', 'B.Cu'], footprints: [{ reference: 'U1', layer: 'F.Cu', position: { x: 0, y: 0 }, orientation: 0, pads: [pad] }], copper: [] } }));
`);
  writeFileSync(launcher, `#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`, { mode: 0o755 });
  return launcher;
}

/** Fill and DRC receipts of `candidate`, in the form the native producers write them. */
function nativeReceipts(router: string, candidate: string, label: string): { fill: string; drc: string; report: string } {
  const fill = join(router, `${label}-fill.json`), drc = join(router, `${label}-drc.json`), report = join(router, `${label}-report.json`);
  const inputs = Object.fromEntries([candidate, sibling(candidate, '.kicad_pro'), sibling(candidate, '.kicad_dru')].map(path => [path, sha256File(path)]));
  write(fill, { schema: 'iot-lab.native-thermal-fill.v1', candidate: descriptor(candidate), inputs: { ...inputs, [join(router, 'absent-optional-input')]: null }, fill_result: true,
    tool: descriptor(join(router, 'recorded-python')), pcbnew_version: '10.0.6', invocation: { operation: 'ZONE_FILLER.Fill', saved: true } });
  write(report, { kicad_version: '10.0.6', coordinate_units: 'mm', source: candidate.split('/').at(-1), included_severities: ['error', 'warning', 'exclusion'], ignored_checks: [],
    violations: [], schematic_parity: [], unconnected_items: [] });
  const cli = join(router, 'recorded-kicad-cli');
  write(drc, { schema: 'iot-lab.native-thermal-drc.v1', candidate: descriptor(candidate), inputs, tool: descriptor(cli), returncode: 0,
    command: [cli, 'pcb', 'drc', '--severity-all', '--format', 'json', '--units', 'mm', '-o', report, candidate], report: descriptor(report) });
  return { fill, drc, report };
}

function updateNative(folder: string, trial: Row, text: string): void {
  writeFileSync(trial.placement_input.path, text);
  trial.placement_input.sha256 = sha256File(trial.placement_input.path);
  const operation = read(join(folder, 'operation/result.json')), inner = relative(operation.workspace, operation.candidate), candidate = join(folder, 'workspace', inner);
  writeFileSync(candidate, text);
  update(join(folder, 'operation/result.json'), value => { value.candidate_sha256 = sha256File(candidate); });
  update(join(folder, 'operation/source.json'), value => { value.files[inner] = sha256File(trial.placement_input.path); });
  update(join(folder, 'gate/result.json'), value => { value.provenance.inputs[0].sha256 = sha256File(candidate); });
  resealed(folder, trial);
}

function thermalFixture(fromParent = false) {
  process.env.IOTROUTE_BIN = boardReader();
  const [folder, trial] = runFixture('development', 'DEV', 'baseline', 1);
  const relativeBoard = 'hardware-design/boards/DEV/native', original = join(folder, 'workspace', `${relativeBoard}.kicad_pcb`);
  update(join(folder, 'run.json'), run => { Object.assign(run, { router: 'fastroute', spec: { schema: 'iot-lab.routing-policy.v2', thermal_verification: 'native-checkback' } }); });
  if (fromParent) {
    const [parent, parentTrial] = runFixture('development', 'DEV', 'proposal', 2);
    const text = readFileSync(trial.placement_input.path, 'utf8').replace('(at 10 10)', '(at 11 10)');
    updateNative(parent, parentTrial, text);
    writeFileSync(trial.placement_input.path, text);
    trial.placement_input.sha256 = sha256File(trial.placement_input.path);
    writeFileSync(original, text);
    update(join(folder, 'run.json'), run => { run.from_run = { result_sha256: parentTrial.sha256 }; });
    trial.parent_run = { path: parent, sha256: parentTrial.sha256 };
  }
  const router = join(folder, 'operation/router'), source = join(router, 'native-thermal-source/native.kicad_pcb');
  const base = join(router, 'base.kicad_pcb'), final = join(router, 'routed.kicad_pcb');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(join(router, 'recorded-python'), 'synthetic recorded Python binary identity');
  writeFileSync(join(router, 'recorded-kicad-cli'), 'synthetic recorded KiCad binary identity');
  write(sibling(original, '.kicad_pro'), { board: { design_settings: { rules: { min_resolved_spokes: 2 }, rule_severities: { starved_thermal: 'error' }, drc_exclusions: [] } } });
  writeFileSync(sibling(original, '.kicad_dru'), '(version 1)\n');
  const sources = read(join(folder, 'operation/source.json'));
  for (const extension of SIDECARS) {
    if (!fromParent || extension !== '.kicad_pcb') sources.files[relativeBoard + extension] = sha256File(sibling(original, extension));
    for (const path of [source, base, final]) writeFileSync(sibling(path, extension), readFileSync(sibling(original, extension)));
  }
  // The workspace input is promoted after the producer finishes: the captured source, not that alias, owns admission.
  writeFileSync(final, `${readFileSync(final, 'utf8')}\n`);
  const first = nativeReceipts(router, base, 'native-thermal-initial'), last = nativeReceipts(router, final, 'native-thermal-final');
  const initial = localThermalProof('admit', { source, base, enabled: true, selected_nets: ['N'], initial_fill_receipt: first.fill, initial_drc_receipt: first.drc });
  const discharged = localThermalProof('discharge', { capability: initial, candidate: final, fill_receipt: last.fill, drc_receipt: last.drc });
  write(join(router, 'native-thermal-initial.json'), initial);
  write(join(router, 'native-thermal-final.json'), discharged);
  write(join(router, 'native-thermal-source.json'), { schema: 'iot-lab.native-thermal-source.v1', qualified: false, original: { path: original, sha256: trial.placement_input.sha256 }, captured: descriptor(source),
    original_files: Object.fromEntries(SIDECARS.map(extension => [sibling(original, extension), sha256File(sibling(source, extension))])),
    inputs: Object.fromEntries(SIDECARS.map(extension => [sibling(source, extension), sha256File(sibling(source, extension))])) });
  writeFileSync(original, readFileSync(final));
  update(join(folder, 'operation/result.json'), value => { value.candidate_sha256 = sha256File(original); });
  update(join(folder, 'gate/result.json'), value => { value.provenance.inputs[0].sha256 = sha256File(original); });
  write(join(folder, 'operation/source.json'), sources);
  const context = join(folder, 'operation/execution-context.json'), effective = join(router, 'effective-configuration.json'), actual = join(router, 'input-manifest.json');
  write(context, { fixture: 'archived host context' });
  write(effective, { fixture: 'observed controls' });
  write(actual, { fixture: 'observed input' });
  const retained = (path: string): Row => ({ path: relative(folder, path), sha256: sha256File(path) });
  const policyPath = join(folder, trial.execution_policy), policy = read(policyPath);
  policy.effort.thermal_verification = 'native-checkback';
  policy.command = ['python3', '/recorded/tools/fastroute_job.py', original, router, '--native-thermal-checkback'];
  policy.execution_context = { path: 'operation/execution-context.json', sha256: sha256File(context) };
  policy.controls = { effective_configuration_verified: true, effective_configurations: { 'effective-configuration.json': sha256File(effective) }, input_manifest_sha256: sha256File(actual),
    native_thermal_obligations: { status: 'passed', initial: retained(join(router, 'native-thermal-initial.json')), final: retained(join(router, 'native-thermal-final.json')),
      source_snapshot: retained(join(router, 'native-thermal-source.json')), candidate: retained(final) } };
  write(policyPath, policy);
  write(join(folder, 'operation/events.jsonl'), { type: 'tool.start', command: policy.command });
  resealed(folder, trial);
  return { folder, trial, policy, policyPath, router, source, base, final, report: last.report, drc: last.drc };
}

const evaluateProof = (): Row => {
  write(manifest, study);
  return evaluateStudy(root, manifest, null, proofServices);
};
const observeProof = (trial: Row): Row => cliObservation(new Evidence(root), trial as Trial, proofServices);

test('the thermal consumer reopens the raw proof after workspace promotion', realProof, () => {
  const f = thermalFixture(), report = evaluateProof(), observed = report.observations[0];
  assert.equal(observed.evidence_valid, true, observed.cause);
  assert.equal(observed.full_gate_success, true);
  assert.notEqual(observed.policy_fingerprint, null);
  assert.deepEqual(observed.unknowns, []);
  assert.notEqual(sha256File(f.policy.command[2]), f.trial.placement_input.sha256);
  for (const path of [f.source, f.base, f.final, f.report, join(f.router, 'recorded-kicad-cli'), join(f.router, 'recorded-python')]) assert.equal(report.inputs.get(path), sha256File(path), path);
  assert.equal(report.inputs.get(join(f.router, 'absent-optional-input')), null);
  assert.ok(report.inputs.has(join(f.router, 'absent-optional-input')));
});

test('a pending thermal obligation cannot expose quality labels', realProof, () => {
  const f = thermalFixture();
  f.policy.controls.native_thermal_obligations.status = 'pending_native';
  write(f.policyPath, f.policy);
  resealed(f.folder, f.trial);
  const row = observeProof(f.trial);
  assert.equal(row.policy_fingerprint, null);
  assert.equal(row.routed_quality.routed_track_length_mm, null);
  assert.match(row.unknowns[0], /unfulfilled/);
});

test('a continued placement binds the sealed parent, not canonical CAD', realProof, () => {
  const f = thermalFixture(true);
  assert.notEqual(read(join(f.folder, 'operation/source.json')).files['hardware-design/boards/DEV/native.kicad_pcb'], f.trial.placement_input.sha256);
  const row = observeProof(f.trial);
  assert.notEqual(row.policy_fingerprint, null);
  assert.deepEqual(row.unknowns, []);
});

test('a raw thermal error is rejected even with a resealed pass receipt', realProof, () => {
  const f = thermalFixture();
  update(f.report, raw => { raw.violations = [{ type: 'starved_thermal', severity: 'error' }]; });
  update(f.drc, value => { value.report = descriptor(f.report); });
  resealed(f.folder, f.trial);
  const row = evaluateProof().observations[0];
  assert.equal(row.evidence_valid, false);
  assert.match(row.cause, /thermal/);
});

test('malformed or mismatched thermal bindings fail closed', realProof, () => {
  const f = thermalFixture(), original = JSON.stringify(f.policy);
  const variant = (change: (policy: Row) => void): Row => { const policy = JSON.parse(original); change(policy); return policy; };
  const obligations = (policy: Row): Row => policy.controls.native_thermal_obligations;
  const bad = [variant(policy => { obligations(policy).candidate = []; }),
    variant(policy => { obligations(policy).initial = { path: 'operation/router/native-thermal-initial.json', sha256: 123 }; }),
    variant(policy => { policy.command = policy.command.filter((item: string) => item !== '--native-thermal-checkback'); }),
    variant(policy => { obligations(policy).candidate.sha256 = 'a'.repeat(64); })];
  for (const policy of bad) {
    write(f.policyPath, policy);
    resealed(f.folder, f.trial);
    const row = evaluateProof().observations[0];
    assert.equal(row.evidence_valid, false);
    assert.equal(row.full_gate_success, false);
  }
  write(f.policyPath, JSON.parse(original));
  update(join(f.folder, 'run.json'), run => { run.spec.schema = 'iot-lab.routing-policy.v1'; });
  resealed(f.folder, f.trial);
  assert.match(evaluateProof().observations[0].cause, /specification/);
  update(join(f.folder, 'run.json'), run => { delete run.spec.thermal_verification; });
  write(f.policyPath, variant(policy => { delete policy.effort.thermal_verification; delete policy.controls.native_thermal_obligations; }));
  resealed(f.folder, f.trial);
  assert.match(evaluateProof().observations[0].cause, /explicitly selected/);
});
