// The Fastroute admission and its receipt protocol on synthetic evidence: real probes of stub executables, no router, no CAD.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { iotrouteMissing } from './iotroute-bin.ts';
import { sha256File as sha } from './json-file.ts';
import { finalize, prepare, type Prepared, validate } from './pcb-routing-trial.ts';

type Row = Record<string, any>;
const needsBinary = { skip: iotrouteMissing() };
const CHECKS = { erc: true, drc: true, paths: 'paths.json', viapads: {}, kicad_happy: {}, port_labels: true };
const CONFIG = { schema: 'iot-lab.routing-policy.v1', layers: ['F.Cu', 'B.Cu'], only_nets: ['/A', '/B'], passes: 2, threads: 1, timeout_s: 8, optimizer: 'off', max_repairs: 0 };

const json = (path: string, value: unknown): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
  return path;
};

function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pcb-routing-trial-')));
  const saved = { ...process.env };
  t.after(() => { process.env = saved; rmSync(root, { recursive: true, force: true }); });
  const native = join(root, 'hardware-design/boards/TRIAL/cad/TRIAL.kicad_pcb');
  json(join(root, 'hardware-design/boards/TRIAL/gate.json'), { project: 'cad/TRIAL', checks: CHECKS, route_features: { routing_rules: { on: false } } });
  mkdirSync(dirname(native), { recursive: true });
  for (const suffix of ['kicad_pcb', 'kicad_sch', 'kicad_pro', 'kicad_dru']) writeFileSync(native.replace(/kicad_pcb$/, suffix), `synthetic ${suffix}`);
  mkdirSync(join(root, 'tools/lib'), { recursive: true });
  copyFileSync(fileURLToPath(new URL('./gate-core.mjs', import.meta.url)), join(root, 'tools/lib/gate-core.mjs'));
  for (const name of ['fastroute_job.py', 'route_rule_coverage.py', 'route_features.py']) writeFileSync(join(root, 'tools', name), '# synthetic producer identity; never executed\n');
  json(join(root, 'tools/route-features.json'), { features: { routing_rules: { on: true, repair_iterations: 2 } } });
  const bin = (name: string): string => {
    const path = join(root, 'bin', name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/sh\necho ${name} 1.0\n`, { mode: 0o755 });
    return path;
  };
  const python = bin('python'), router = bin('router'), kicad = bin('kicad');
  Object.assign(process.env, { KICAD_PYTHON: python, FASTROUTE_BIN: router, KICAD_CLI: kicad, IOT_CPU_BUDGET: '4', IOT_MEMORY_BUDGET_GIB: '4', IOT_JOB_MEMORY_GIB: '2' });
  delete process.env.ROUTE_BOARD; delete process.env.ROUTE_FEATURES; delete process.env.ROUTE_FEATURES_FILE; delete process.env.FASTROUTE_QUALITY_MANIFEST;
  let counter = 0;
  const start = (config: unknown = CONFIG): Promise<Prepared> => prepare(root, native, join(root, `run-${++counter}/operation/router`), config, 20, 'TRIAL', 'native');
  return { root, native, router, start };
}

/** What a complete job leaves behind. `coverageStatus` of the stage gate; `launched` is whether the solver then ran. */
function routerOutput(f: ReturnType<typeof fixture>, prepared: Prepared, { coverageStatus = 'passed', launched = true, outcome = 'complete' } = {}) {
  const output = prepared.output, config = prepared.config;
  const configuration = { board: f.native, outdir: output, passes: config.passes, layers: config.layers.join(','), only_nets: config.only_nets.join(','), threads: config.threads,
    max_time: config.timeout_s, optimizer: config.optimizer, preflight: true, skip_net: '', plane_nets: '', gnd_vias: false, route_planes: false, unlock_nets: '', set: [], neck_um: 0, native_thermal_checkback: config.thermal_verification === 'native-checkback' };
  json(join(output, 'input-manifest.json'), { configuration, board_sha256: sha(f.native), router_sha256: sha(f.router), features: (prepared.policy.effort as Row).feature_policy });
  const backend = { mode: 'legacy-unverified', qualified: false };
  json(join(output, 'backend-policy.json'), backend);
  const dsn = join(output, 'router-model.dsn');
  writeFileSync(dsn, '(pcb "synthetic receipt protocol model")\n');
  const command = [f.router, '-de', dsn, '-do', join(output, 'router.ses')];
  const coverage = json(join(output, 'rule-coverage.json'), { status: coverageStatus, solver_launch_allowed: coverageStatus === 'passed', cause: coverageStatus === 'passed' ? 'admitted' : 'RP-001: stitching unsupported',
    backend_command: command, backend_command_sha256: createHash('sha256').update(JSON.stringify(command)).digest('hex'), inputs: { [dsn]: sha(dsn), [f.native]: sha(f.native) }, dsn: { path: dsn, sha256: sha(dsn) } });
  if (!launched) {
    json(join(output, 'outcome.json'), { status: 'blocked' });
    return output;
  }
  json(join(output, 'effective-configuration.json'), { configuration, command, backend_policy: backend, dsn_sha256: sha(dsn), rule_coverage: { path: coverage, sha256: sha(coverage) },
    backend_resources: { global_rayon_threads: config.threads, autorouter_workers: config.threads, optimizer_workers: config.threads } });
  const candidate = join(output, 'routed.kicad_pcb');
  writeFileSync(candidate, 'synthetic routed candidate; requires native gate\n');
  json(join(output, 'outcome.json'), { status: outcome, board_sha256: sha(candidate), optimizer: config.optimizer });
  return output;
}

const change = (path: string, update: (value: Row) => void): void => {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Row;
  update(value);
  writeFileSync(path, JSON.stringify(value));
};

test('the policy accepts exactly its fields and fits the whole deadline', () => {
  assert.deepEqual(validate(CONFIG, 20), CONFIG);
  const rejected: [unknown, RegExp][] = [
    [null, /explicit routing policy/], [{ ...CONFIG, extra: 1 }, /exactly the routing-policy/], [{ ...CONFIG, passes: 0 }, /passes must be a positive integer/],
    [{ ...CONFIG, timeout_s: 21 }, /fit the complete CLI deadline/], [{ ...CONFIG, optimizer: 'always' }, /optimizer must be off or if-routed/], [{ ...CONFIG, max_repairs: 1 }, /zero separate CLI repair/],
    [{ ...CONFIG, layers: [] }, /layers requires a nonempty list/], [{ ...CONFIG, layers: ['F.Cu', 'F.Cu'] }, /distinct exact names/], [{ ...CONFIG, layers: ['Top'] }, /unsupported copper layer/],
    [{ ...CONFIG, only_nets: ['/A*'] }, /comma-free net names/], [{ ...CONFIG, schema: 'iot-lab.routing-policy.v2' }, /exactly the routing-policy/],
  ];
  for (const [config, cause] of rejected) assert.throws(() => validate(config, 20), cause);
  assert.ok(validate({ ...CONFIG, schema: 'iot-lab.routing-policy.v2', thermal_verification: 'native-checkback' }, 20).thermal_verification);
});

test('preparation binds the normalized configuration and observed controls before launch', needsBinary, async t => {
  const f = fixture(t), prepared = await f.start();
  assert.equal(prepared.command[1], join(f.root, 'tools/fastroute_job.py'));
  assert.deepEqual(prepared.command.slice(4, 13), ['--preflight', '--skip-net', '', '--plane-nets', '', '--only-nets', '/A,/B', '--layers', 'F.Cu,B.Cu']);
  const policy = prepared.policy as Row;
  assert.equal(policy.schema, 'iot-lab.placement-outcome-execution.v2');
  assert.equal(policy.runtime.tools.router.sha256, sha(f.router));
  assert.equal(policy.effort.internal_repair_iterations, 0);
  assert.equal(policy.effort.feature_policy.routing_rules.on, false);
  assert.deepEqual(policy.effort.backend_policy, { mode: 'legacy-unverified' });
  assert.equal(policy.inputs[f.native], sha(f.native));
  assert.equal(policy.inputs[join(f.root, 'tools/lib/gate-core.mjs')], sha(join(f.root, 'tools/lib/gate-core.mjs')));
  assert.equal(prepared.env.ROUTE_BOARD, 'TRIAL');
  assert.deepEqual(JSON.parse(readFileSync(prepared.policy_path, 'utf8')).command, prepared.command);
});

test('admission stops on a foreign board, missing sidecars, an overridden environment or too many threads', needsBinary, async t => {
  const f = fixture(t);
  process.env.ROUTE_BOARD = 'OTHER';
  await assert.rejects(f.start(), /belongs to another board/);
  delete process.env.ROUTE_BOARD;
  process.env.ROUTE_FEATURES = '{}';
  await assert.rejects(f.start(), /external route feature overrides/);
  delete process.env.ROUTE_FEATURES;
  await assert.rejects(f.start({ ...CONFIG, threads: 64 }), /exceed the admitted native CPU budget/);
  rmSync(f.native.replace(/kicad_pcb$/, 'kicad_dru'));
  await assert.rejects(f.start(), /exact four native sidecars/);
});

test('a complete run with matching controls passes but still requires the gate', needsBinary, async t => {
  const f = fixture(t), prepared = await f.start();
  const output = routerOutput(f, prepared), result = finalize(prepared, 0);
  assert.equal(result.status, 'passed');
  assert.equal(result.candidate, join(output, 'routed.kicad_pcb'));
  assert.equal(result.native_gate_required, true);
  assert.equal(result.qualified, false);
  const controls = JSON.parse(readFileSync(prepared.policy_path, 'utf8')).controls as Row;
  assert.equal(controls.effective_configuration_verified, true);
  assert.equal(controls.status, 'observed');
});

test('a failed router keeps its verdict and any stuck candidate stays a candidate', needsBinary, async t => {
  const f = fixture(t), prepared = await f.start();
  routerOutput(f, prepared, { outcome: 'stuck' });
  const result = finalize(prepared, 1);
  assert.equal(result.status, 'failed');
  assert.match(String(result.cause), /router exited 1; outcome=stuck/);
  assert.ok(result.candidate);
});

test('changed tools, inputs, outputs and configuration are rejected', needsBinary, async t => {
  const f = fixture(t);
  const tampered: [(output: string, prepared: Prepared) => void, RegExp][] = [
    [() => writeFileSync(join(f.root, 'tools/route_features.py'), '# changed\n'), /input\/tool changed/],
    [output => change(join(output, 'input-manifest.json'), value => { value.configuration.passes = 9; }), /effective configuration differs/],
    [output => change(join(output, 'input-manifest.json'), value => { value.board_sha256 = 'a'.repeat(64); }), /another placement input/],
    [output => change(join(output, 'input-manifest.json'), value => { value.router_sha256 = 'a'.repeat(64); }), /router binary differs/],
    [output => change(join(output, 'input-manifest.json'), value => { value.features = {}; }), /route features differ/],
    [output => change(join(output, 'backend-policy.json'), value => { value.mode = 'other'; }), /backend algorithm policy is missing/],
    [output => change(join(output, 'effective-configuration.json'), value => { value.configuration.threads = 9; }), /router stage changed the controlled configuration/],
    [output => change(join(output, 'effective-configuration.json'), value => { value.backend_resources.autorouter_workers = 9; }), /worker caps differ/],
    [output => change(join(output, 'effective-configuration.json'), value => { value.rule_coverage.sha256 = 'a'.repeat(64); }), /sealed rule-coverage/],
    [output => writeFileSync(join(output, 'router-model.dsn'), 'replaced\n'), /differs from actual router model/],
    [output => change(join(output, 'effective-configuration.json'), value => { value.command[2] = 'other.dsn'; }), /does not use its admitted model/],
    [output => writeFileSync(join(output, 'routed.kicad_pcb'), 'replaced\n'), /not bound to the actual candidate/],
    [output => rmSync(join(output, 'outcome.json')), /lacks a complete candidate outcome/],
  ];
  for (const [mutate, cause] of tampered) {
    const original = readFileSync(join(f.root, 'tools/route_features.py'));
    const prepared = await f.start(), output = routerOutput(f, prepared);
    mutate(output, prepared);
    assert.throws(() => finalize(prepared, 0), cause);
    writeFileSync(join(f.root, 'tools/route_features.py'), original);
  }
});

test('a missing record is a failure, never a silent success', needsBinary, async t => {
  const f = fixture(t), failed = await f.start();
  const result = finalize(failed, 1);
  assert.equal(result.status, 'failed');
  assert.match(String(result.cause), /did not record its effective input configuration/);
  assert.throws(() => finalize(failed, 0), /did not record its effective input/);
});

test('blocked rule coverage keeps its cause and contradicts a success exit', needsBinary, async t => {
  const f = fixture(t), prepared = await f.start();
  routerOutput(f, prepared, { coverageStatus: 'blocked', launched: false });
  const result = finalize(prepared, 1);
  assert.equal(result.status, 'failed');
  assert.match(String(result.cause), /rule coverage blocked before solver: RP-001/);
  assert.equal(result.solver_launched, false);
  assert.throws(() => finalize(prepared, 0), /success contradicts blocked rule coverage/);
});

test('thermal policy needs internal repairs off and cannot pass without native evidence', needsBinary, async t => {
  const f = fixture(t), thermal = { ...CONFIG, schema: 'iot-lab.routing-policy.v2', thermal_verification: 'native-checkback' };
  const prepared = await f.start(thermal);
  assert.ok(prepared.command.includes('--native-thermal-checkback'));
  assert.equal((prepared.policy.effort as Row).thermal_verification, 'native-checkback');
  routerOutput(f, prepared);
  assert.throws(() => finalize(prepared, 0), /native thermal original snapshot differs/);
  json(join(f.root, 'hardware-design/boards/TRIAL/gate.json'), { project: 'cad/TRIAL', checks: CHECKS });
  await assert.rejects(f.start(thermal), /requires internal routing\/repair stages disabled/);
});
