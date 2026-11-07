import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { boardHistory, historyText } from './board-history.ts';
import { reseal } from './cad-seal.ts';
import { changePath, recordChange } from './change-log.ts';
import { sha256File } from './json-file.ts';

const CLI = fileURLToPath(new URL('../pcb-state.ts', import.meta.url));
const at = (text: string) => () => new Date(text);

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'board-history-'))), folder = join(root, 'hardware-design/boards/X'), base = join(root, '.gate/cli');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(folder, { recursive: true });
  mkdirSync(base, { recursive: true });
  mkdirSync(join(root, '.gate/layout-plan'), { recursive: true });
  writeFileSync(join(folder, 'gate.json'), JSON.stringify({ project: 'X', checks: {} }));
  writeFileSync(join(folder, 'X.kicad_pcb'), '(kicad_pcb (general (thickness 1.6)) (layers (0 "F.Cu" signal)))');
  writeFileSync(join(folder, 'X.kicad_sch'), '(kicad_sch)');
  writeFileSync(join(folder, 'X.kicad_pro'), '{}');
  const run = (id: string, created: string, board = 'X', status = 'passed') => {
    const dir = join(base, id);
    mkdirSync(join(dir, 'images'), { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ run_id: id, board, operation: 'route', created_at: created, gate_config_sha256: 'g', action: { source_revision: 's' } }));
    writeFileSync(join(dir, 'images/top.svg'), '<svg/>');
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ status, cleanup: { complete: true }, evidence_sha256: { 'run.json': sha256File(join(dir, 'run.json')), 'images/top.svg': sha256File(join(dir, 'images/top.svg')) } }));
  };
  return { root, folder, base, run };
}

test('the log joins the change log, the seal log, the layout log and the runs in time order', t => {
  const f = fixture(t);
  f.run('run-b', '2026-11-06T12:00:00+00:00');
  reseal(f.root, 'X', { tool: 'pcb-adopt', run_id: 'run-b' });
  recordChange(f.root, 'X', { kind: 'baseline', reason: 'start', by: 'Ana', refs: [], now: at('2026-11-06T13:00:00Z') });
  recordChange(f.root, 'X', { kind: 'fab_defect', reason: 'short on U3', by: 'Ana', refs: ['U3'], now: at('2026-11-06T15:00:00Z') });
  writeFileSync(join(f.root, '.gate/layout-plan/X.jsonl'), JSON.stringify({ time: '2026-11-06T14:00:00.000Z', type: 'layout_plan.approved', board: 'X', by: 'Ana', reason: 'reviewed', rules_sha256: 'r', route_plan_sha256: 'p', schematic_sha256: 'c', image: 'i.png', image_sha256: 'h' }) + '\n');
  const history = boardHistory(f.root, 'X', f.base);
  assert.deepEqual(history.entries.map(entry => [entry.source, entry.id]), [['run', 'run-b'], ['seal', 'seal-1'], ['change', 'c-0001'], ['layout', 'layout-1'], ['change', 'c-0002']]);
  assert.deepEqual(history.problems, []);
});

test('each entry has its inputs and outputs', t => {
  const f = fixture(t);
  f.run('run-a', '2026-11-06T10:00:00+00:00');
  reseal(f.root, 'X', { tool: 'fixture', run_id: null });
  recordChange(f.root, 'X', { kind: 'baseline', reason: 'start', by: 'Ana', refs: [] });
  recordChange(f.root, 'X', { kind: 'fab_defect', reason: 'short', by: 'Ana', refs: ['U3'] });
  const { entries } = boardHistory(f.root, 'X', f.base);
  const run = entries.find(entry => entry.id === 'run-a')!, seal = entries.find(entry => entry.source === 'seal')!, change = entries.find(entry => entry.id === 'c-0002')!, base = entries.find(entry => entry.id === 'c-0001')!;
  assert.equal(run.sealed, true);
  assert.equal(run.status, 'passed');
  assert.deepEqual(run.inputs, [{ name: 'source_revision', sha256: 's' }, { name: 'gate_config', sha256: 'g' }]);
  assert.deepEqual(run.outputs.map(item => item.path), [join(f.base, 'run-a/run.json'), join(f.base, 'run-a/images/top.svg')]);
  assert.equal(seal.inputs[0]!.sha256, null);
  assert.ok(seal.outputs[0]!.sha256);
  assert.deepEqual(change.inputs, [{ name: 'U3' }]);
  assert.equal(base.outputs.length, 3);
  assert.equal(change.by, 'Ana');
});

test('a seal line has no time, and the entry says how it got its place', t => {
  const f = fixture(t);
  reseal(f.root, 'X', { tool: 'one', run_id: null });
  f.run('run-a', '2026-11-06T10:00:00+00:00');
  writeFileSync(join(f.folder, 'X.kicad_sch'), '(kicad_sch (x))');
  reseal(f.root, 'X', { tool: 'two', run_id: 'run-a' });
  writeFileSync(join(f.folder, 'X.kicad_sch'), '(kicad_sch (y))');
  reseal(f.root, 'X', { tool: 'three', run_id: null });
  const { entries } = boardHistory(f.root, 'X', f.base);
  assert.deepEqual(entries.map(entry => [entry.id, entry.at, entry.placed_by]), [
    ['seal-1', null, 'log_order'], ['run-a', '2026-11-06T10:00:00+00:00', 'time'], ['seal-2', null, 'run'], ['seal-3', null, 'log_order']]);
});

test('a run of another board is not in the log', t => {
  const f = fixture(t);
  f.run('run-a', '2026-11-06T10:00:00+00:00', 'Y');
  assert.deepEqual(boardHistory(f.root, 'X', f.base).entries, []);
});

test('a run with changed evidence reads as not sealed, with the cause', t => {
  const f = fixture(t);
  f.run('run-a', '2026-11-06T10:00:00+00:00');
  writeFileSync(join(f.base, 'run-a/images/top.svg'), '<svg>changed</svg>');
  const [entry] = boardHistory(f.root, 'X', f.base).entries;
  assert.equal(entry!.sealed, false);
  assert.match(entry!.cause ?? '', /evidence changed/);
  assert.deepEqual(entry!.outputs, []);
});

test('a broken source is a problem in the output and the other sources stay', t => {
  const f = fixture(t);
  f.run('run-a', '2026-11-06T10:00:00+00:00');
  reseal(f.root, 'X', { tool: 'fixture', run_id: null });
  recordChange(f.root, 'X', { kind: 'baseline', reason: 'start', by: 'Ana', refs: [] });
  writeFileSync(changePath(f.root, 'X'), 'not JSON\n');
  writeFileSync(join(f.root, '.gate/layout-plan/X.jsonl'), 'not JSON\n');
  mkdirSync(join(f.base, 'run-bad'));
  const history = boardHistory(f.root, 'X', f.base);
  assert.deepEqual(history.entries.map(entry => entry.source), ['seal', 'run']);
  assert.equal(history.problems.length, 3);
  assert.match(history.problems.join('\n'), /change log/);
  assert.match(history.problems.join('\n'), /layout log line 1/);
  assert.match(history.problems.join('\n'), /run-bad/);
});

test('history reads and writes nothing', t => {
  const f = fixture(t);
  f.run('run-a', '2026-11-06T10:00:00+00:00');
  const before = readdirSync(f.root, { recursive: true }).length;
  boardHistory(f.root, 'X', f.base);
  assert.equal(readdirSync(f.root, { recursive: true }).length, before);
});

test('the text log has one line for each entry', t => {
  const f = fixture(t);
  f.run('run-a', '2026-11-06T10:00:00+00:00');
  assert.match(historyText(boardHistory(f.root, 'X', f.base)), /2026-11-06T10:00:00\+00:00 run run-a route passed/);
});

test('pcb history prints JSON and text', t => {
  const f = fixture(t), run = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, '--project', f.root, 'history', ...args], { encoding: 'utf8' });
  f.run('run-a', '2026-11-06T10:00:00+00:00');
  const json = run('X', '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).schema, 'iot-lab.board-history.v1');
  assert.equal(JSON.parse(json.stdout).entries.length, 1);
  assert.match(run('X').stdout, /run-a/);
  assert.notEqual(run().status, 0);
});
