import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as cycle from './pcb-cycle.ts';
import { atomicJson, readObject, sha256File } from './json-file.ts';
import { evidenceFiles } from './pcb-evidence.ts';

function fixture(t: { after: (work: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pcb-cycle-'))), base = join(root, '.gate/cli');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let clock = 100;
  const options: cycle.CycleOptions = { now: () => clock, withLock: async (_path, work) => work(), readers: {
    loadContract: (_root, path) => readObject(path), currentAssessment: () => true, stockPopulationCurrent: () => true,
    status: folder => readObject(join(folder, 'state.json')),
  } };
  atomicJson(join(root, 'hardware-design/boards/X/gate.json'), { project: 'cad/X' });
  const state = cycle.create(root, base, 'X', 'integrator', options), folder = cycle.folderFor(base, state.cycle_id);
  const evidence = join(root, 'review.json'); atomicJson(evidence, { source: 'fixture', unresolved: ['package'] });
  function run(name: string, start: number, duration: number, status = 'passed', board = 'X') {
    const folder = join(base, 'run-' + name); mkdirSync(folder);
    atomicJson(join(folder, 'run.json'), { run_id: 'run-' + name, root, board, operation: 'parts', created_at: `2026-10-16T00:00:${String(start).padStart(2, '0')}Z` });
    atomicJson(join(folder, 'result.json'), { status, cleanup: { complete: true }, elapsed_s: duration, timing: { supervisor_startup_s: 0 }, evidence_sha256: evidenceFiles(folder) });
    return folder;
  }
  return { root, base, folder, evidence, options, run, clock: (value: number) => { clock = value; } };
}

test('reviews retain exact blockers, union time, and changed evidence', async t => {
  const f = fixture(t), activity = await cycle.begin(f.folder, 'datasheets', 'reviewer', 'check exact package', f.options);
  f.clock(115);
  const state = await cycle.end(f.folder, activity.activity_id, 'blocked', [f.evidence], 'exact package unresolved', f.options);
  assert.equal(state.stages.datasheets.review_elapsed_s, 15);
  assert.equal(state.stages.datasheets.blocked, 1);
  assert.equal(state.qualified, false);
  assert.equal(state.recorded_failure_rework_causes[0].cause, 'exact package unresolved');
  writeFileSync(f.evidence, 'changed');
  assert.equal(cycle.summarize(f.folder, f.options).evidence_issues.length, 1);
  await assert.rejects(cycle.finish(f.folder, f.options), /changed evidence/);
});

test('overlapping failed and passed jobs use union time and sealed closure', async t => {
  const f = fixture(t), first = f.run('a', 0, 10), second = f.run('b', 5, 10, 'timeout');
  await cycle.attach(f.folder, first, f.options, 'parts'); await cycle.attach(f.folder, second, f.options, 'datasheets');
  const state = await cycle.finish(f.folder, f.options);
  assert.equal(state.covered_elapsed_s, 15); assert.equal(state.status, 'recorded');
  assert.equal(state.stages.datasheets.blocked, 1); assert.equal(state.runs[1].status, 'timeout');
  assert.equal(state.qualified, false); assert.equal(state.release_approved, false);
  const receipt = readObject(join(first, 'result.json')); receipt.elapsed_s = 1; atomicJson(join(first, 'result.json'), receipt);
  assert.equal(cycle.summarize(f.folder, f.options).evidence_issues.length, 1);
  await assert.rejects(cycle.begin(f.folder, 'routing', 'designer', 'late work', f.options), /closed/);
});

test('open reviews and wrong-board jobs prevent closure', async t => {
  const f = fixture(t), activity = await cycle.begin(f.folder, 'schematic', 'designer', 'review pin mapping', f.options);
  await assert.rejects(cycle.finish(f.folder, f.options), /end recorded review/);
  await assert.rejects(cycle.attach(f.folder, f.run('wrong', 0, 1, 'passed', 'Y'), f.options), /another board/);
  await cycle.end(f.folder, activity.activity_id, 'rework', [f.evidence], 'correct pin mapping', f.options);
  assert.equal((await cycle.finish(f.folder, f.options)).stages.schematic.rework, 1);
});

test('detach removes a run that never got a result, and keeps one that did', async t => {
  const f = fixture(t), stuck = f.run('stuck', 0, 1), sealed = f.run('sealed', 2, 1);
  rmSync(join(stuck, 'result.json')); atomicJson(join(stuck, 'state.json'), { status: 'starting' });
  await cycle.attach(f.folder, stuck, f.options); await cycle.attach(f.folder, sealed, f.options);
  await assert.rejects(cycle.finish(f.folder, f.options), /verified terminal/);
  await assert.rejects(cycle.detach(f.folder, 'run-sealed', f.options), /has a result/);
  await assert.rejects(cycle.detach(f.folder, 'run-other', f.options), /not linked/);
  await cycle.detach(f.folder, 'run-stuck', f.options);
  assert.deepEqual(cycle.read(join(f.folder, 'cycle.json')).runs.map(row => row.run_id), ['run-sealed']);
  assert.equal((await cycle.finish(f.folder, f.options)).status, 'recorded');
});

test('changed manifests and incomplete cleanup cannot be hidden by closure', async t => {
  const f = fixture(t), folder = f.run('changed', 0, 2);
  await cycle.attach(f.folder, folder, f.options);
  atomicJson(join(folder, 'run.json'), {});
  await assert.rejects(cycle.finish(f.folder, f.options), /changed evidence|verified terminal/);
});

test('startup delay is included, and missing admission boundaries remain unknown', async t => {
  const f = fixture(t), folder = f.run('delay', 0, 20), path = join(folder, 'result.json');
  const receipt = readObject(path); receipt.timing = { supervisor_startup_s: 100 }; atomicJson(path, receipt);
  await cycle.attach(f.folder, folder, f.options);
  assert.equal(cycle.summarize(f.folder, f.options).covered_elapsed_s, 120);
  delete receipt.timing; atomicJson(path, receipt);
  const state = cycle.summarize(f.folder, f.options);
  assert.equal(state.covered_elapsed_s, null); assert.match(state.runs[0].interval_source!, /^unknown/);
});

test('finish rechecks concurrent activities under the mutation lock', async t => {
  const f = fixture(t);
  f.options.withLock = async (_path, work) => {
    const path = join(f.folder, 'cycle.json'), data = cycle.read(path);
    data.activities.push({ activity_id: 'concurrent', stage: 'parts', owner: 'reviewer', description: 'review', status: 'running',
      started_unix_s: 100, measurement: 'recorded_review_interval' }); atomicJson(path, data);
    return work();
  };
  await assert.rejects(cycle.finish(f.folder, f.options), /end recorded review/);
  assert.equal(cycle.read(join(f.folder, 'cycle.json')).status, 'open');
});

test('stock expiry and changed population preserve historical sealed evidence', async t => {
  const f = fixture(t), folder = f.run('stock', 0, 1);
  atomicJson(join(folder, 'operation/report.json'), { scope: 'assembly_stock_observation', board: 'X', order_day_utc: '2000-01-01',
    stock_current: true, inputs: { [f.evidence]: sha256File(f.evidence) } });
  const path = join(folder, 'result.json'), receipt = readObject(path); receipt.evidence_sha256 = evidenceFiles(folder); atomicJson(path, receipt);
  await cycle.attach(f.folder, folder, f.options);
  const state = cycle.summarize(f.folder, f.options);
  assert.equal(state.runs[0].evidence_verified, true); assert.equal(state.runs[0].availability_inputs_current, true);
  assert.equal(state.runs[0].availability_current_day, false); assert.equal(state.runs[0].stock_current, false);
  f.options.readers.stockPopulationCurrent = () => false;
  assert.equal((await cycle.finish(f.folder, f.options)).runs[0].availability_inputs_current, false);
});

test('pre-CAD cycles bind an exact design contract identity', t => {
  const f = fixture(t), contract = join(f.root, 'contract.json'); atomicJson(contract, { identity: { design_id: 'IDEA' } });
  assert.throws(() => cycle.create(f.root, f.base, 'IDEA', 'owner', f.options), /explicit design contract/);
  assert.throws(() => cycle.create(f.root, f.base, 'WRONG', 'owner', f.options, contract), /identity/);
  const state = cycle.create(f.root, f.base, 'IDEA', 'owner', f.options, contract);
  assert.equal(state.project, null); assert.equal(state.design_context_current, true);
});
