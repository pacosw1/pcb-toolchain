// `tools/pcb ml` under the owned supervisor: real backend runs, then the seal rejecting reports that do not hold.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { finalizeDataset } from '../pcb_ml_data.ts';
import { artifactIdentity, encode, float, sha256File, type Obj } from '../pcb_ml_json.ts';
import { iotrouteMissing } from './iotroute-bin.ts';
import { verify } from './pcb-evidence.ts';
import { ml, producer, type Requested } from './pcb-outcomes-binding.ts';
import { status } from './pcb-runs.ts';

const tools = fileURLToPath(new URL('..', import.meta.url));
const needsBinary = { skip: iotrouteMissing() };

function project(t: { after(fn: () => void): void }): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pcb-ml-run-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  symlinkSync(tools, join(root, 'tools'));
  return root;
}

const pcb = (root: string, ...args: string[]) => spawnSync(join(tools, 'pcb'), ['--project', root, ...args], { encoding: 'utf8' });

async function settled(root: string, stdout: string): Promise<{ folder: string; result: Obj }> {
  const folder = join(root, '.gate/cli', (JSON.parse(stdout) as { run_id: string }).run_id);
  for (let i = 0; i < 600; i++) {
    const state = status(folder);
    if (['passed', 'failed', 'error', 'cancelled', 'timeout'].includes(String(state.get('status'))) && state.get('controller_alive') !== true) break;
    await delay(100);
  }
  return { folder, result: JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8')) as Obj };
}

function dataset(root: string): string {
  const source = join(root, 'evidence.json');
  writeFileSync(source, '{"scope":"synthetic numeric learning; no PCB qualification"}\n');
  const rows: Obj[] = ['train', 'validation', 'test'].flatMap(split => [-2, -1, 0, 1, 2].map((x, i) => ({
    id: `${split}-${i}`, family: `${split}-FAMILY`, case_fingerprint: artifactIdentity({ case: split }), source_fingerprint: artifactIdentity({ source: split }),
    pose_fingerprint: artifactIdentity({ pose: x }), run_fingerprint: artifactIdentity({ run: `${split}-${i}` }), split, features: { x },
    targets: { y: float(2 * x + 5) }, evidence_valid: true, status: 'passed', failure_class: null })));
  const data = finalizeDataset(root, { dataset_id: 'synthetic', task: 'synthetic', feature_names: ['x'], target_specs: { y: { type: 'regression', direction: 'max' } },
    rows, inputs: { [source]: sha256File(source) }, metadata: { feature_contract: { extractor: 'synthetic', version: 1 } } });
  const path = join(root, 'dataset.json');
  writeFileSync(path, encode(data, true) + '\n');
  return path;
}

test('a real ML training run seals its artifact and no board context is needed', needsBinary, async t => {
  const root = project(t), call = pcb(root, 'ml', '--detach', '--json', 'train', 'MODEL', '--dataset', dataset(root), '--target', 'y', '--algorithm', 'ridge');
  assert.equal(call.status, 0, call.stderr || call.stdout);
  const { folder, result } = await settled(root, call.stdout);
  assert.equal(result.status, 'passed', String(result.cause));
  assert.equal(result.scope, 'ml_observation');
  assert.deepEqual([result.ml_action, result.ml_id, result.qualified, result.adopt_model, result.release_approved], ['train', 'MODEL', false, false, false]);
  assert.equal((result.cleanup as Obj).complete, true);
  assert.equal(JSON.parse(readFileSync(join(folder, 'run.json'), 'utf8')).project, null);
  assert.equal(verify(folder).get('status'), 'passed');
  const artifact = Object.keys(result.artifacts as Obj)[0]!;
  assert.ok(artifact.startsWith(join(folder, 'operation')));
  writeFileSync(artifact, '{}');
  assert.throws(() => verify(folder), /changed/);
});

test('a missing input is a sealed blocked observation without a made-up hash', needsBinary, async t => {
  const root = project(t), missing = join(root, 'missing.json');
  const call = pcb(root, 'ml', '--detach', '--json', 'dataset', 'TRIAL', '--manifest', missing);
  assert.equal(call.status, 0, call.stderr || call.stdout);
  const { folder, result } = await settled(root, call.stdout);
  assert.equal(result.status, 'failed', String(result.cause));
  assert.equal(result.engineering_status, 'blocked');
  assert.ok((result.engineering_absent_inputs as string[]).includes(missing));
  assert.equal((result.engineering_inputs as Obj)[missing], undefined);
  assert.equal(verify(folder).get('status'), 'failed');
});

test('supervisor paths and unknown actions are rejected before admission', t => {
  const root = project(t);
  for (const args of [['dataset', 'TRIAL', '--output', join(root, 'report.json')], ['dataset', 'TRIAL', `--root=${root}`], ['execute', 'TRIAL']]) {
    assert.equal(pcb(root, 'ml', '--json', ...args).status, 2);
    assert.throws(() => readdirSync(join(root, '.gate/cli')), /ENOENT/);
  }
});

function sealed(t: { after(fn: () => void): void }, mutate: (report: Obj, folder: string) => void, requested: Requested = { files: {}, absent: [] }, code = 0) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pcb-ml-seal-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, 'run'), output = join(folder, 'operation'), artifact = join(output, 'dataset.json');
  mkdirSync(output, { recursive: true }); mkdirSync(join(root, 'tools'));
  writeFileSync(artifact, '{}');
  const report: Obj = { schema: 'iot-lab.pcb-ml-result.v1', action: 'dataset', id: 'TRIAL', status: 'passed', qualified: false, adopt_model: false,
    inputs: {}, tool_inputs: {}, absent_inputs: [], artifacts: { [artifact]: sha256File(artifact) }, cause: 'fixture' };
  mutate(report, folder);
  writeFileSync(join(output, 'report.json'), JSON.stringify(report));
  return () => ml(folder, root, ['dataset', 'TRIAL'], code, producer(root, process.execPath), requested);
}

test('the seal accepts a clean report and binds what it reports', t => {
  const result = sealed(t, () => {})();
  assert.equal(result.status, 'passed');
  assert.equal(result.scope, 'ml_observation');
});

test('wrong identity, type, qualification, adoption or verdict is rejected', t => {
  for (const [field, value] of [['action', 'train'], ['id', 'OTHER']] as const) assert.throws(sealed(t, report => { report[field] = value; }), /another action or ID/);
  assert.throws(sealed(t, report => { report.schema = 'other'; }), /type or verdict/);
  assert.throws(sealed(t, report => { report.qualified = true; }), /type or verdict/);
  assert.throws(sealed(t, report => { report.adopt_model = true; }), /non-adopting/);
  assert.throws(sealed(t, report => { report.status = 'blocked'; }, undefined, 0), /verdict/);
});

test('artifact escapes, tampering and empty inventories are rejected', t => {
  assert.throws(sealed(t, report => { report.artifacts = {}; }), /no owned output artifact/);
  assert.throws(sealed(t, report => { report.artifacts = { '../outside.json': 'a'.repeat(64) }; }), /outside its owned operation/);
  assert.throws(sealed(t, report => { report.artifacts = { 'report.json': 'a'.repeat(64) }; }), /outside its owned operation/);
  assert.throws(sealed(t, (report, folder) => { report.artifacts = { [join(folder, 'operation/dataset.json')]: 'b'.repeat(64) }; }), /changed/);
  assert.throws(sealed(t, report => { report.artifacts = { x: 'short' }; }), /invalid artifacts inventory/);
});

test('a declared input cannot change and a declared absence cannot appear', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pcb-ml-inputs-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nested = join(root, 'nested.json'), appeared = join(root, 'appeared.json');
  writeFileSync(nested, '{}');
  const digest = sha256File(nested);
  writeFileSync(nested, '{"changed":true}');
  assert.throws(sealed(t, () => {}, { files: { [nested]: digest }, absent: [] }), /ML input changed/);
  writeFileSync(appeared, '{}');
  assert.throws(sealed(t, report => { report.status = 'blocked'; }, { files: {}, absent: [appeared] }, 1), /absent input appeared/);
  assert.throws(sealed(t, () => {}, { files: {}, absent: [appeared] }), /absent requested input/);
});
