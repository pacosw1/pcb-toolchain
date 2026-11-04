import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { Board, BoardDocument } from './lib/board-types.ts';
import { pinnedKicadCommit } from './lib/board-json.ts';
import { buildDataset, CORPUS, Evidence, loadFeaturePacket, makeFeaturePacket, manifestDependencies, REQUEST, sealedRun, type CorpusTrial } from './pcb_ml_adapters.ts';
import { IMPLEMENTATIONS, readBoard } from './pcb_ml_features.ts';
import { artifactIdentity, encode, float, number, object, readObject, sha256File, without, writeArtifact, type Obj } from './pcb_ml_json.ts';
import { argumentsFor, dependencies, execute, type EnginePorts } from './pcb_ml.ts';

export function adapterFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pcb-ml-adapters-ts-'))), tools = dirname(fileURLToPath(import.meta.url));
  for (const name of IMPLEMENTATIONS) { const target = join(root, 'tools', name); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(tools, name), target); }
  const json = (name: string, value: unknown) => { const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, encode(value, true) + '\n'); return path; };
  const run = (id: string, split: 'train' | 'validation' | 'test' = 'train', status = 'passed'): CorpusTrial => {
    const folder = join(root, id), runPath = json(id + '/run.json', { operation: 'check', board: id, project: 'cad/ENV-SENSE', timeout_s: 60, run_id: id });
    const operation = json(id + '/operation/result.json', { scope: 'synthetic workflow fixture', status });
    const terminal = json(id + '/result.json', { status, elapsed_s: float(1), cleanup: { complete: true }, evidence_sha256: { 'run.json': sha256File(runPath), 'operation/result.json': sha256File(operation) } });
    return { id, family: split + '-FAMILY', split, path: folder, sha256: sha256File(terminal) };
  };
  return { root, json, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('workflow corpus uses pre-run fields; seals and current source context are mandatory', async t => {
  const f = adapterFixture(); t.after(f.cleanup);
  const trial = f.run('trial'), manifest = f.json('corpus.json', { schema: CORPUS, adapter: 'workflow', trials: [trial] });
  const table = await buildDataset(f.root, manifest, 'workflow');
  assert.equal(table.rows[0].targets.run_passed, 1); assert.equal(number(table.rows[0].features.budget_s), 60);
  assert.equal(table.rows[0].eligibility.features, true);
  f.json('trial/operation/undeclared.json', { unsealed: true });
  const bad = await buildDataset(f.root, manifest, 'bad');
  assert.equal(bad.rows[0].evidence_valid, false); assert.equal(bad.rows[0].targets.run_passed, null);
  assert.match((bad.rows[0].ineligible_reasons as string[])[0], /inventory differs/);
  assert.throws(() => sealedRun(new Evidence(f.root), trial.path, trial.sha256), /inventory differs/);
});

test('historical absences remain explicit; run aliases and cross-split reuse are blocked', async t => {
  const f = adapterFixture(); t.after(f.cleanup);
  const missing = { id: 'missing', family: 'F', split: 'train', path: 'missing', sha256: 'a'.repeat(64) };
  const manifest = f.json('missing-corpus.json', { schema: CORPUS, adapter: 'workflow', trials: [missing] });
  const dependencies = await manifestDependencies(f.root, manifest); assert.equal(dependencies[join(f.root, 'missing/run.json')], null);
  const table = await buildDataset(f.root, manifest, 'missing'); assert.equal(table.rows.length, 1); assert.equal(table.rows[0].evidence_valid, false);
  const trial = f.run('shared'); f.json('aliases.json', { schema: CORPUS, adapter: 'workflow', trials: [trial, { ...trial, id: 'alias' }] });
  const aliases = await buildDataset(f.root, 'aliases.json', 'aliases'); assert.equal(aliases.rows.filter(r => r.eligibility.features).length, 1);
  f.json('leak.json', { schema: CORPUS, adapter: 'workflow', trials: [trial, { ...trial, id: 'other', family: 'other', split: 'test' }] });
  await assert.rejects(buildDataset(f.root, 'leak.json', 'leak'), /cross-split/);
});

test('packets re-extract originals and reject resealed features, outcome fields and extractor drift', async t => {
  const f = adapterFixture(); t.after(f.cleanup);
  const source = f.json('future.json', { operation: 'route', timeout_s: 30, project: 'cad/ENV-SENSE' });
  const request = f.json('request.json', { schema: REQUEST, adapter: 'workflow', samples: [{ id: 'future', source: { path: source, sha256: sha256File(source) } }] });
  const packet = await makeFeaturePacket(f.root, request, 'packet'), packetPath = f.json('features.json', packet);
  assert.deepEqual(loadFeaturePacket(f.root, packetPath), packet);
  const changed = structuredClone(packet); object(changed.rows[0].features).budget_s = 999;
  changed.content_sha256 = artifactIdentity(without(changed, 'content_sha256')); f.json('changed.json', changed);
  assert.throws(() => loadFeaturePacket(f.root, 'changed.json'), /original source extraction/);
  const outcome = { ...packet, rows: [{ ...packet.rows[0], targets: { success: 1 } }] };
  outcome.content_sha256 = artifactIdentity(without(outcome, 'content_sha256')); f.json('outcome.json', outcome);
  assert.throws(() => loadFeaturePacket(f.root, 'outcome.json'), /cannot carry outcomes/);
  const legacy = { ...packet, feature_contract: { ...packet.feature_contract, version: 0 } };
  legacy.content_sha256 = artifactIdentity(without(legacy, 'content_sha256')); f.json('legacy.json', legacy);
  assert.throws(() => loadFeaturePacket(f.root, 'legacy.json'), /extractor contract changed/);
  writeFileSync(source, '{}'); assert.throws(() => loadFeaturePacket(f.root, packetPath), /source artifact changed/);
});

test('board API source and sidecar hashes are checked; routing read failures remain unknown', async t => {
  const f = adapterFixture(); t.after(f.cleanup);
  const source = join(f.root, 'ENV-SENSE.kicad_pcb'); writeFileSync(source, 'synthetic unreadable board');
  const request = f.json('request.json', { schema: REQUEST, adapter: 'routing', samples: [{ id: 'native', source: { path: source, sha256: sha256File(source) } }] });
  const reader = (): BoardDocument => { throw new Error('API source fixture unavailable'); };
  const packet = await makeFeaturePacket(f.root, request, 'native', { boardReader: reader });
  assert.equal(packet.rows[0].eligibility.features, false); assert.ok(Object.values(packet.rows[0].features).every(v => v === null));
  assert.match(packet.rows[0].eligibility.reasons[0].cause as string, /API source fixture unavailable/);
  assert.throws(() => readBoard(source, () => ({ schema: 'bad', board_sha256: 'a'.repeat(64) } as BoardDocument)), /schema\/source binding/);
});

test('real workflow dataset/train/evaluate/features/predict orchestration produces bound advisory receipts', async t => {
  const f = adapterFixture(); t.after(f.cleanup);
  const trials = [f.run('train', 'train'), f.run('validation', 'validation', 'failed'), f.run('test', 'test')];
  const corpus = f.json('corpus.json', { schema: CORPUS, adapter: 'workflow', trials });
  const run = async (folder: string, values: string[]) => {
    const path = join(f.root, folder, 'report.json'), report = await execute(f.root, values, path);
    assert.equal(report.status, 'passed', report.cause as string); assert.equal(report.qualified, false); assert.equal(report.adopt_model, false);
    for (const [name, digest] of Object.entries(object(report.artifacts))) assert.equal(sha256File(name), digest);
    return report;
  };
  await run('dataset', ['dataset', 'TABLE', '--manifest', corpus]);
  const table = join(f.root, 'dataset/dataset.json');
  await run('train', ['train', 'MODEL', '--dataset', table, '--target', 'run_passed']);
  const model = join(f.root, 'train/model.json');
  await run('evaluate', ['evaluate', 'EVALUATION', '--dataset', table, '--model', model]);
  const source = f.json('future.json', { operation: 'check', timeout_s: 60, project: 'cad/ENV-SENSE' });
  const request = f.json('request.json', { schema: REQUEST, adapter: 'workflow', samples: [{ id: 'future', source: { path: source, sha256: sha256File(source) } }] });
  await run('features', ['features', 'FEATURES', '--manifest', request]);
  const packet = join(f.root, 'features/features.json');
  const found = await dependencies(f.root, ['predict', 'P', '--model', model, '--features', packet]);
  assert.equal(found[source], sha256File(source)); assert.equal(found[table], undefined);
  await run('predict', ['predict', 'PREDICTIONS', '--model', model, '--features', packet]);
  const result = readObject(join(f.root, 'predict/predictions.json'));
  assert.equal((result.rows as Obj[])[0].status, 'predicted'); assert.equal(result.adopt_model, false);
  const cli = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'pcb_ml.ts'), 'train', 'CLI', '--root', f.root,
    '--dataset', table, '--target', 'run_passed', '--output', join(f.root, 'cli/report.json'), '--json'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(cli.stdout.trim().split('\n').length, 1);
  const summary = JSON.parse(cli.stdout); assert.equal(summary.status, 'passed'); assert.equal(summary.artifact_count, 1); assert.equal(summary.inputs, undefined);
  assert.equal(summary.report.sha256, sha256File(summary.report.path));
});

test('receipts protect all consumed files; empty holdouts retain observations and missing history stays ineligible', async t => {
  const f = adapterFixture(); t.after(f.cleanup);
  const corpus = f.json('corpus.json', { schema: CORPUS, adapter: 'workflow', trials: [f.run('train')] });
  await execute(f.root, ['dataset', 'D', '--manifest', corpus], join(f.root, 'dataset/report.json'));
  const table = join(f.root, 'dataset/dataset.json'), args = ['train', 'T', '--dataset', table, '--target', 'run_passed'];
  const original = sha256File(table);
  await assert.rejects(execute(f.root, args, table), /overwrite/); assert.equal(sha256File(table), original);
  const trained = await execute(f.root, args, join(f.root, 'train/report.json')); assert.equal(trained.status, 'passed', trained.cause as string);
  const evaluation = await execute(f.root, ['evaluate', 'E', '--dataset', table, '--model', join(f.root, 'train/model.json')], join(f.root, 'evaluation/report.json'));
  assert.equal(evaluation.status, 'blocked'); assert.match(evaluation.cause as string, /no eligible VALIDATION\/TEST/);
  assert.equal(Object.keys(object(evaluation.artifacts)).length, 1);
  const collision = await execute(f.root, args, join(f.root, 'train/another-report.json'));
  assert.equal(collision.status, 'blocked'); assert.match(collision.cause as string, /existing artifact/);
  const missing = f.json('missing.json', { schema: CORPUS, adapter: 'workflow', trials: [{ id: 'missing', family: 'F', split: 'train', path: 'absent', sha256: 'a'.repeat(64) }] });
  const report = await execute(f.root, ['dataset', 'MISSING', '--manifest', missing], join(f.root, 'missing/report.json'));
  assert.equal(report.status, 'blocked'); assert.match(report.cause as string, /ineligible rows retained/);
  const diagnostic = readObject(join(f.root, 'missing/dataset.json')); assert.equal((diagnostic.rows as Obj[])[0].evidence_valid, false);
});

test('all-unknown prediction retains its packet rows and blocks scoring', async t => {
  const f = adapterFixture(); t.after(f.cleanup);
  const corpus = f.json('corpus.json', { schema: CORPUS, adapter: 'workflow', trials: [f.run('train')] });
  await execute(f.root, ['dataset', 'D', '--manifest', corpus], join(f.root, 'dataset/report.json'));
  await execute(f.root, ['train', 'T', '--dataset', join(f.root, 'dataset/dataset.json'), '--target', 'run_passed'], join(f.root, 'train/report.json'));
  const source = f.json('unknown.json', { operation: 'unknown' });
  const request = f.json('request.json', { schema: REQUEST, adapter: 'workflow', samples: [{ id: 'unknown', source: { path: source, sha256: sha256File(source) } }] });
  const packet = await makeFeaturePacket(f.root, request, 'unknown'); f.json('features.json', packet);
  const report = await execute(f.root, ['predict', 'P', '--model', join(f.root, 'train/model.json'), '--features', join(f.root, 'features.json')], join(f.root, 'predict/report.json'));
  assert.equal(report.status, 'blocked'); assert.match(report.cause as string, /no eligible feature rows/);
  const prediction = readObject(join(f.root, 'predict/predictions.json')); assert.equal((prediction.rows as Obj[])[0].prediction, null);
});

test('CLI validates action-specific flags and engine orchestration forwards typed options to sibling ports', async t => {
  for (const values of [['train', 'bad/id', '--dataset', 'x', '--target', 'y'], ['train', 'T', '--dataset', 'x'],
    ['features', 'F', '--manifest', 'x', '--target', 'y'], ['train', 'T', '--dataset', 'x', '--target', 'y', '--algorithm', 'mean', '--regularization', '1'],
    ['train', 'T', '--dataset', 'x', '--target', 'y', '--regularization', '0x1'], ['engine-train', 'T', '--dataset', 'x', '--target', 'y', '--epochs', '1.5']])
    assert.throws(() => argumentsFor(values));
  const f = adapterFixture(); t.after(f.cleanup);
  const source = f.json('dataset.json', { inputs: {} });
  let seen: unknown;
  const unavailable = () => { throw new Error('unexpected engine method'); };
  const engine: EnginePorts = { dependencies: unavailable, buildDataset: unavailable, ingestPublicCorpus: unavailable, evaluate: unavailable, exportCoreml: unavailable,
    train(root, dataset, options) { seen = { root, dataset, ...options }; const value = { inputs: {} }; writeArtifact(options.output, value); return value; } };
  const report = await execute(f.root, ['engine-train', 'ENGINE', '--dataset', source, '--target', 'y', '--epochs', '3', '--device', 'cpu'], join(f.root, 'engine/report.json'), { engine });
  assert.equal(report.status, 'passed', report.cause as string);
  assert.deepEqual(seen, { root: f.root, dataset: source, modelId: 'ENGINE', target: 'y', epochs: 3, device: 'cpu', output: join(f.root, 'engine/model.json') });
});

test('routing labels require known controls and the owned budget; verified failure is the only negative failure label', async t => {
  const f = adapterFixture(); t.after(f.cleanup);
  const trial = f.run('route'), source = join(f.root, 'ENV-SENSE.kicad_pcb'); writeFileSync(source, 'synthetic original source');
  const board: Board = { path: source, copper_layers: ['F.Cu', 'B.Cu'], stackup: [], nets: {}, footprints: [], copper: [], zones: [], graphics: [], texts: [], groups: [],
    constraints: { min_clearance: 0, min_track_width: 0, min_via_size: 0, copper_edge_clearance: 0 }, edges_bbox: { left: 0, right: 0, top: 0, bottom: 0 }, outlines: [] };
  const boardReader = (path: string): BoardDocument => ({ schema: 'iot-lab.board.v1', kicad_commit: pinnedKicadCommit(), kicad: 'fixture',
    board_sha256: sha256File(path), project_sha256: '', rules_sha256: '', board });
  const policy = f.json('route/operation/policy.json', { effort: { router_timeout_s: 1 } });
  const terminal = readObject(join(trial.path, 'result.json')); object(terminal.evidence_sha256)['operation/policy.json'] = sha256File(policy);
  const placement = { path: source, sha256: sha256File(source) };
  const observation: Obj = { unknowns: [], full_gate_success: true, policy_fingerprint: artifactIdentity('policy'),
    case_fingerprint: artifactIdentity('case'), placement_pose_fingerprint: artifactIdentity('pose'),
    routed_quality: { candidate: placement, routed_track_length_mm: float(0), routed_via_count: 0 }, native: { errors: 0, opens: 0, parity: 0 } };
  const observer = { inputs: { [fileURLToPath(import.meta.url)]: sha256File(fileURLToPath(import.meta.url)) },
    cliObservation(evidence: Evidence, input: CorpusTrial) { sealedRun(evidence, input.path, input.sha256); return observation; } };
  const build = async (elapsed: number, status = 'passed') => {
    terminal.elapsed_s = elapsed; terminal.status = status; f.json('route/result.json', terminal);
    const request = f.json('corpus.json', { schema: CORPUS, adapter: 'routing', trials: [{ ...trial, sha256: sha256File(join(trial.path, 'result.json')), placement_input: placement, execution_policy: 'operation/policy.json' }] });
    return (await buildDataset(f.root, request, 'routing', { observer, boardReader })).rows[0];
  };
  const accepted = await build(59); assert.equal(accepted.targets.accepted_within_budget, 1); assert.equal(number(accepted.targets.added_route_track_length_mm), 0);
  assert.equal(accepted.owned_run_budget_s, 60); assert.equal(accepted.solver_timeout_s, 1);
  const late = await build(61); assert.equal(late.targets.accepted_within_budget, 0); assert.equal(late.targets.routed_track_length_mm, null);
  observation.full_gate_success = false; observation.execution_attempt = { status: 'verified' }; observation.policy_fingerprint = null;
  const failed = await build(60, 'timeout'); assert.equal(failed.targets.accepted_within_budget, 0); assert.equal(failed.targets.successful_completion_elapsed_s, null);
  observation.execution_attempt = { status: 'unknown' }; observation.policy_fingerprint = {};
  assert.equal((await build(60, 'timeout')).targets.accepted_within_budget, null);
});
