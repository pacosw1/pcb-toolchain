import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exemptBoard } from './design-exempt-fixture.ts';
import { sealFixtureBoard } from './cad-seal-fixture.ts';
import { atomicJson, readObject, sha256File } from './json-file.ts';
import { approveLayoutPlan } from './layout-plan.ts';
import { evidenceFiles } from './pcb-evidence.ts';
import { context as boardContext } from './pcb-workflow.ts';
import { jsonDumps, PyError } from './py-compat.mjs';
import { nextAction, verifyCurrentInputs } from './pcb-next.ts';
import type { NextOptions } from './pcb-next.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pcb-next-'))), board = join(root, 'hardware-design/boards/X');
  const project = join(board, 'cad/X'), base = join(root, '.gate/cli'), fingerprint = 'a'.repeat(64);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  exemptBoard(root, 'X');
  const config = { project: 'cad/X', stage: 'G3', checks: { erc: true, drc: true } };
  atomicJson(join(board, 'gate.json'), config);
  mkdirSync(join(board, 'cad'), { recursive: true });
  for (const ext of ['.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_dru']) writeFileSync(project + ext, 'fixture ' + ext);
  sealFixtureBoard(root, 'X');
  const context = JSON.parse(jsonDumps(boardContext(root, 'X'))) as { source_files: { path: string; sha256: string | null }[] };
  for (const source of context.source_files) if (source.sha256 === null) { const path = join(root, source.path); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'Fixture context source\n'); }
  let probes = 0;
  const sources = { board: 'X', files: { fixture: 'hash' }, sha256: 'fixture-source' };
  const options: NextOptions = { base, readers: {
    status: folder => readObject(join(folder, 'state.json')), sourceState: () => sources, parentCandidate: () => undefined,
    currentAssessment: () => true, runStage: async () => { throw new Error('unexpected actual probe'); },
  }, verifyInputs: async () => { probes++; return { verified: true, input_sha256: fingerprint, release_supported: true }; } };
  function seal(folder: string, receipt = readObject(join(folder, 'result.json'))) {
    receipt.evidence_sha256 = evidenceFiles(folder); atomicJson(join(folder, 'result.json'), receipt);
  }
  function run(name = 'run-latest', operation = 'check', status = 'passed', created = '2026-10-15T12:00:00Z') {
    const folder = join(options.base!, name); mkdirSync(folder, { recursive: true });
    const manifest = { schema_version: 1, run_id: name, root, board: operation === 'readiness' ? 'ASSEMBLY' : 'X',
      project: operation === 'readiness' ? null : 'cad/X', created_at: created, operation, arguments: operation === 'readiness' ? ['X', '/fixture/candidate'] : [], gate_config_sha256: sha256File(join(board, 'gate.json')) };
    atomicJson(join(folder, 'run.json'), manifest); atomicJson(join(folder, 'state.json'), { status, run_id: name });
    const metrics = { erc_errors: 0, erc_warnings: 0, drc_errors: status === 'failed' ? 1 : 0, drc_warnings: 0, drc_parity: 0, drc_unconnected: 0 };
    const checks = { erc: { status: 'passed', metrics: { erc_errors: 0, erc_warnings: 0 } }, drc: { status: status === 'failed' ? 'failed' : 'passed', metrics } };
    const native = project + '.kicad_pcb';
    atomicJson(join(folder, 'gate/result.json'), { exit: status === 'failed' ? 1 : 0, changedDuringRun: false, metrics, checks,
      provenance: { input_sha256: fingerprint, inputs: [{ path: 'hardware-design/boards/X/cad/X.kicad_pcb', sha256: sha256File(native) }] } });
    const finding = { id: 'fixture-clearance', stage: 'drc', rule: 'clearance', severity: 'error', message: 'U3.4 violates sourced clearance', refs: ['U3'],
      pads: [{ ref: 'U3', pad: '4' }], location: { x: 12.5, y: 8, unit: 'mm' }, evidence: { path: 'drc.json', pointer: '/violations/0' } };
    atomicJson(join(folder, 'gate/findings.json'), { board: 'X', project: 'cad/X', inputs_valid: true, input_sha256: fingerprint, findings: status === 'failed' ? [finding] : [] });
    atomicJson(join(folder, 'gate/erc.json'), { sheets: [{ violations: [] }] });
    atomicJson(join(folder, 'gate/drc.json'), { violations: [], schematic_parity: [], unconnected_items: [] });
    for (const name of ['events.jsonl', 'erc.log', 'drc.log']) writeFileSync(join(folder, 'gate', name), 'fixture checker log\n');
    const receipt: Record<string, unknown> = { status, cleanup: { complete: true }, input_sha256: fingerprint, metrics };
    if (['build', 'edit', 'route', 'repair'].includes(operation)) {
      const candidate = join(folder, 'workspace/hardware-design/boards/X/cad/X.kicad_pcb'); mkdirSync(join(candidate, '..'), { recursive: true }); writeFileSync(candidate, 'candidate fixture');
      atomicJson(join(folder, 'operation/source.json'), sources); atomicJson(join(folder, 'operation/result.json'), { candidate });
      Object.assign(receipt, { candidate_verified: true, identity_preserved: true, source_unchanged: true });
    }
    seal(folder, receipt); return folder;
  }
  function engineering(folder: string, report: Record<string, unknown>) {
    atomicJson(join(folder, 'operation/report.json'), report);
    const result = readObject(join(folder, 'result.json')); result.engineering_inputs = { [project + '.kicad_pcb']: sha256File(project + '.kicad_pcb') }; seal(folder, result);
  }
  return { root, board, project, base, options, config, fingerprint, run, seal, engineering, probes: () => probes, next: () => nextAction(root, 'X', options) };
}

test('a board with no design contract and no exemption is blocked; a contract or an exemption is not', async t => {
  const f = fixture(t);
  assert.notEqual((await f.next()).blocker?.code, 'design_contract_missing', 'the fixture board is exempt');
  rmSync(join(f.root, 'hardware-design/registry/boards.json'));
  const report = await f.next(); assert.equal(report.state, 'blocked'); assert.equal(report.blocker?.code, 'design_contract_missing'); assert.equal(f.probes(), 0);
  atomicJson(join(f.root, 'hardware-design/registry/design-contracts/X.json'), { identity: { design_id: 'X' }, current_stage: 'requirements' });
  assert.equal((await f.next()).blocker?.code, 'design_assessment_missing');
});

test('a board with no approved layout plan is blocked with the code and the command; an approved or exempt board is not', async t => {
  const f = fixture(t);
  assert.notEqual((await f.next()).blocker?.code, 'layout_plan_missing', 'the fixture board is exempt');
  exemptBoard(f.root, 'X', undefined, {}, false);
  const none = await f.next();
  assert.deepEqual([none.state, none.blocker?.code, none.next_action?.command], ['blocked', 'layout_plan_missing', 'tools/pcb layout X']);
  assert.match(String(none.blocker?.message), /X has no layout plan/);
  assert.equal(f.probes(), 0);
  writeFileSync(join(f.board, 'SPEC.md'), 'limit');
  writeFileSync(join(f.board, 'route.json'), JSON.stringify({ schema: 'iot-lab.route.v1', backend: 'tracemaker', layers: ['F.Cu', 'B.Cu'], stages: [{ name: 'main' }] }));
  writeFileSync(join(f.board, 'placement-constraints.json'), JSON.stringify({ schema: 'iot-lab.engineering-constraints.v1', rules: [{ id: 'near', kind: 'part_distance', source: { path: 'hardware-design/boards/X/SPEC.md', sha256: sha256File(join(f.board, 'SPEC.md')), page: 1 } }] }));
  writeFileSync(join(f.board, 'layout-plan.json'), JSON.stringify({ schema: 'iot-lab.layout-plan.v1', intents: [{ id: 'a', statement: 'U1 near the edge', rule_ids: ['near'] }], route_plan: 'hardware-design/boards/X/route.json', approval: null }));
  sealFixtureBoard(f.root, 'X');
  const unapproved = await f.next();
  assert.deepEqual([unapproved.state, unapproved.blocker?.code, unapproved.next_action?.command], ['blocked', 'layout_plan_missing', 'tools/pcb layout X --approve --by NAME --reason TEXT']);
  await approveLayoutPlan(f.root, 'X', 'Ana', 'reviewed');
  assert.ok(!String((await f.next()).blocker?.code ?? '').startsWith('layout_plan'));
  writeFileSync(join(f.board, 'route.json'), JSON.stringify({ schema: 'iot-lab.route.v1', backend: 'tracemaker', layers: ['F.Cu'], stages: [{ name: 'main' }] }));
  const stale = await f.next();
  assert.deepEqual([stale.state, stale.blocker?.code, stale.next_action?.command], ['blocked', 'layout_plan_stale', 'tools/pcb layout X --approve --by NAME --reason TEXT']);
  writeFileSync(join(f.board, 'layout-plan.json'), '{not json');
  assert.equal((await f.next()).blocker?.code, 'layout_plan_missing', 'an unreadable plan is not an approval');
});

test('missing native inputs name the exact source without a probe', async t => {
  const f = fixture(t); unlinkSync(f.project + '.kicad_pcb');
  const report = await f.next(); assert.equal(report.blocker?.code, 'missing_native_input'); assert.equal(f.probes(), 0);
});

test('CAD changed outside our tools is state cad_unsealed with the seal command, and next does not throw', async t => {
  const f = fixture(t); f.run();
  assert.equal((await f.next()).state, 'needs_release');
  writeFileSync(f.project + '.kicad_pcb', 'edited in KiCad');
  const report = await f.next();
  assert.equal(report.state, 'cad_unsealed'); assert.equal(report.blocker?.code, 'cad_changed');
  assert.deepEqual(report.blocker?.changed, ['hardware-design/boards/X/cad/X.kicad_pcb']);
  assert.equal(report.next_action?.command, 'tools/pcb seal X'); assert.equal(f.probes(), 1);
  unlinkSync(join(f.board, 'cad-seal.json'));
  const missing = await f.next(); assert.equal(missing.state, 'cad_unsealed'); assert.equal(missing.blocker?.code, 'cad_seal_missing');
});

test('legacy receipts cannot become current and G5 requests a fresh check', async t => {
  const f = fixture(t); atomicJson(join(f.board, '.gate/latest.json'), { run: 'old' }); atomicJson(join(f.board, '.gate/old/result.json'), { exit: 1 });
  const legacy = await f.next(); assert.equal(legacy.evidence.freshness, 'unverified_legacy'); assert.equal(legacy.state, 'needs_check');
  atomicJson(join(f.board, 'gate.json'), { ...f.config, stage: 'G5' });
  assert.ok((await f.next()).next_action?.argv.includes('--fresh')); assert.equal(f.probes(), 0);
});

test('current sealed checks supersede legacy failures without granting order readiness', async t => {
  const f = fixture(t); f.run(); const report = await f.next();
  assert.equal(report.evidence.freshness, 'current'); assert.equal(report.state, 'needs_release'); assert.equal(report.readiness_verified, false); assert.equal(f.probes(), 1);
});

test('a failed board with no copper names the automatic placer', async t => {
  const f = fixture(t); f.run('run-failed', 'check', 'failed');
  assert.equal((await f.next()).blocker?.placement_start, 'tools/pcb place X --json');
  const routed = await (async () => { const native = f.project + '.kicad_pcb'; writeFileSync(native, readFileSync(native, 'utf8') + '(segment (start 0 0) (end 1 0))\n'); f.run('run-failed-2', 'check', 'failed'); return f.next(); })();
  assert.equal(routed.blocker?.placement_start, undefined);
});

test('completed failures expose their native finding and location', async t => {
  const f = fixture(t); f.run('run-failed', 'check', 'failed'); const report = await f.next();
  assert.equal(report.blocker?.code, 'gate_finding'); assert.equal(report.blocker?.finding_id, 'fixture-clearance');
  assert.deepEqual(report.blocker?.location, { x: 12.5, y: 8, unit: 'mm' }); assert.equal(report.evidence.freshness, 'current');
});

test('changed config and invalid native artifacts fail before tool verification', async t => {
  const f = fixture(t), folder = f.run(); writeFileSync(join(folder, 'gate/drc.json'), '{}');
  assert.equal((await f.next()).evidence.freshness, 'invalid'); assert.equal(f.probes(), 0);
  f.seal(folder); atomicJson(join(f.board, 'gate.json'), { ...f.config, new_input: true });
  const report = await f.next(); assert.equal(report.evidence.freshness, 'stale'); assert.match(String(report.blocker?.message), /gate changed/); assert.equal(f.probes(), 0);
});

test('unsealed required native evidence and unknown checker verdicts cannot promote', async t => {
  const f = fixture(t), folder = f.run(); unlinkSync(join(folder, 'gate/drc.log')); f.seal(folder);
  assert.equal((await f.next()).state, 'needs_check'); assert.equal(f.probes(), 0);
  writeFileSync(join(folder, 'gate/drc.log'), 'log');
  const gate = readObject(join(folder, 'gate/result.json')); gate.checks = { erc: { status: 'unknown' }, drc: { status: 'passed' } };
  atomicJson(join(folder, 'gate/result.json'), gate); f.seal(folder);
  assert.match(String((await f.next()).blocker?.message), /unknown configured check/);
});

test('older live work takes precedence over newer terminal work', async t => {
  const f = fixture(t), older = f.run('run-older', 'check', 'running', '2026-10-14T12:00:00Z'); f.run();
  const report = await f.next(); assert.equal(report.state, 'observe'); assert.equal(report.observed_run?.run_id, 'run-older'); assert.equal(f.probes(), 0);
  atomicJson(join(older, 'state.json'), { status: 'unknown' });
  assert.equal((await f.next()).observed_run?.run_id, 'run-latest');
});

test('unknown run states are blocked', async t => {
  const f = fixture(t), folder = f.run(); atomicJson(join(folder, 'state.json'), { status: 'unknown' });
  assert.equal((await f.next()).blocker?.code, 'invalid_run_state'); assert.equal(f.probes(), 0);
});

test('other revisions and checkouts are rejected without shadowing the matching run', async t => {
  const f = fixture(t); f.run('run-old', 'check', 'passed', '2026-10-14T12:00:00Z'); const wrong = f.run();
  const path = join(wrong, 'run.json'), manifest = readObject(path); manifest.project = 'cad/other'; atomicJson(path, manifest);
  const report = await f.next(); assert.equal(report.observed_run?.run_id, 'run-old'); assert.equal((report.ignored_observations as unknown[]).length, 1);
});

test('verified candidates require explicit adoption; frozen boards name required defect evidence', async t => {
  const f = fixture(t); f.run('run-edit', 'edit');
  assert.equal((await f.next()).next_action?.kind, 'explicit_adoption');
  writeFileSync(join(f.root, 'FOCUS.md'), '# FOCUS\n## Frozen\n- X\n## Done when\nfixed\n');
  const frozen = await f.next(); assert.equal(frozen.blocker?.code, 'frozen_candidate_needs_named_defect');
  assert.deepEqual(frozen.blocker?.required_inputs, ['baseline_run_id', 'finding_id']);
  f.options.readers.sourceState = () => ({ changed: true });
  assert.equal((await f.next()).evidence.freshness, 'stale');
});

test('routing repairs require current sources and current parent admission', async t => {
  const f = fixture(t), folder = f.run('run-diagnosis', 'routing'); f.engineering(folder, { status: 'repairable' });
  assert.equal((await f.next()).next_action?.kind, 'repair');
  const path = join(folder, 'run.json'), manifest = readObject(path); manifest.from_run = { folder: join(f.base, 'run-parent'), result_sha256: 'sealed' }; atomicJson(path, manifest); f.seal(folder);
  f.options.readers.parentCandidate = () => { throw new PyError('ValueError', 'canonical inputs changed since parent candidate creation'); };
  assert.equal((await f.next()).evidence.freshness, 'stale');
  delete manifest.from_run; atomicJson(path, manifest); f.seal(folder); writeFileSync(f.project + '.kicad_pcb', 'changed'); sealFixtureBoard(f.root, 'X');
  assert.equal((await f.next()).evidence.freshness, 'stale'); assert.equal(f.probes(), 0);
});

test('dated stock expires and a newly present population policy invalidates the old observation', async t => {
  const f = fixture(t), folder = f.run('run-stock', 'parts'), population = join(f.board, 'variants.json');
  f.engineering(folder, { scope: 'assembly_stock_observation', board: 'X', status: 'passed', stock_current: true, order_day_utc: '2000-01-01', candidate: '/fixture/candidate', boards: 2,
    population_source: { path: population, exists: false, sha256: null } });
  const expired = await f.next(); assert.equal(expired.state, 'needs_stock_refresh'); assert.ok(expired.next_action?.argv.includes('2')); assert.equal(expired.blocker?.stock_current, false);
  atomicJson(population, { variants: ['FULL'], fit: {} });
  assert.equal((await f.next()).evidence.freshness, 'stale'); assert.equal(f.probes(), 0);
});

test('readiness remains a dated review and custom run directories stay in executable argv', async t => {
  const f = fixture(t); f.options.base = join(f.root, 'runs with spaces'); f.run('run-ready', 'readiness');
  const report = await f.next(); assert.equal(report.blocker?.code, 'readiness_requires_current_review'); assert.equal(report.readiness_verified, false);
  assert.deepEqual(report.next_action?.argv.slice(2, 4), ['--runs-dir', f.options.base]); assert.ok(report.next_action?.command.includes("'" + f.options.base + "'")); assert.equal(f.probes(), 0);
});

test('dependency verification rejects changed sources before launching and enforces its fingerprint', async t => {
  const f = fixture(t), folder = f.run(), gate = join(folder, 'gate');
  const verified = await verifyCurrentInputs(f.root, 'X', gate, async (_command, options) => {
    assert.equal(options.timeoutS, 20); return { returncode: 0, stderr: '', stdout: JSON.stringify({ verified: true, input_sha256: f.fingerprint }) };
  }); assert.equal(verified.verified, true);
  await assert.rejects(verifyCurrentInputs(f.root, 'X', gate, async () => ({ returncode: 0, stderr: '', stdout: '{"verified":true,"input_sha256":"wrong"}' })), /mismatched evidence/);
  await assert.rejects(verifyCurrentInputs(f.root, 'X', gate, async () => { throw Object.assign(new Error(), { name: 'TimeoutError', cleanup: { complete: true } }); }), /owned probes stopped/);
  writeFileSync(f.project + '.kicad_pcb', 'changed');
  await assert.rejects(verifyCurrentInputs(f.root, 'X', gate, async () => { assert.fail('changed input must fail before probe'); }), /input changed/);
});

test('dependency probes preserve the invoked name of a multicall Node shim', async t => {
  const f = fixture(t), folder = f.run(), executable = join(f.root, 'multicall'), alias = join(f.root, 'node-alias');
  writeFileSync(executable, 'fixture executable identity'); chmodSync(executable, 0o755); symlinkSync(executable, alias);
  const previous = process.env.NODE; process.env.NODE = alias;
  try {
    await verifyCurrentInputs(f.root, 'X', join(folder, 'gate'), async command => {
      assert.equal(command[0], alias);
      return { returncode: 0, stderr: '', stdout: JSON.stringify({ verified: true, input_sha256: f.fingerprint }) };
    });
  } finally { if (previous === undefined) delete process.env.NODE; else process.env.NODE = previous; }
});

test('design assessments stop at the repeated unchanged failure and expire with their contract', async t => {
  const f = fixture(t), contract = join(f.root, 'design.json'); atomicJson(contract, { identity: { design_id: 'IDEA' }, current_stage: 'requirements' });
  f.options.designContract = contract;
  for (const name of ['run-a', 'run-b']) {
    const folder = f.run(name, 'design', 'failed'), manifest = readObject(join(folder, 'run.json'));
    Object.assign(manifest, { board: 'IDEA', project: null, design_stage: 'requirements', design_contract: { path: contract, sha256: sha256File(contract) } }); atomicJson(join(folder, 'run.json'), manifest);
    f.engineering(folder, { schema: 'iot-lab.design-assessment.v1', design_id: 'IDEA', through: 'requirements', status: 'blocked', blockers: [{ code: 'requirements_missing', detail: 'provide the requirement', requirement: 'R1' }] });
  }
  const report = await nextAction(f.root, 'IDEA', f.options); assert.equal(report.state, 'stuck'); assert.equal(report.blocker?.code, 'repeated_unchanged_failure'); assert.equal(report.blocker?.repeated_failures, 2);
  atomicJson(contract, { identity: { design_id: 'IDEA' }, current_stage: 'architecture' });
  assert.equal((await nextAction(f.root, 'IDEA', f.options)).blocker?.code, 'design_assessment_stale');
});
