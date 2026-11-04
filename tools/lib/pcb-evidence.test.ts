import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { summarize } from './pcb-benchmark.ts';
import { evidenceFiles, verify } from './pcb-evidence.ts';
import { sha } from './pcb-workflow.ts';
import { jsonDumps, PyError } from './py-compat.mjs';

let folder: string;
const put = (name: string, text: string, base = folder) => {
  const path = join(base, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};
const seal = (extra: object = {}, base = folder) => {
  const receipt = { status: 'passed', cleanup: { complete: true }, evidence_sha256: evidenceFiles(base), ...extra };
  put('result.json', JSON.stringify(receipt), base);
};
const attributeError = (error: unknown) => error instanceof PyError && (error as PyError).type === 'AttributeError';

beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'run-')));
  put('run.json', '{"board":"X","operation":"check"}');
  put('gate/result.json', '{"exit":0,"changedDuringRun":false,"provenance":{"input_sha256":"abc"}}');
  put('operation/log.txt', 'log');
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

test('evidence covers run.json and every file under operation and gate, nested ones too', () => {
  put('gate/deep/er.json', '{}');
  put('workspace/ignored.txt', 'x');
  assert.deepEqual(Object.keys(evidenceFiles(folder)), ['gate/deep/er.json', 'gate/result.json', 'operation/log.txt', 'run.json']);
});

test('a candidate inside the workspace is bound, one outside is refused', () => {
  const candidate = put('workspace/b.kicad_pcb', 'board');
  put('operation/result.json', JSON.stringify({ candidate }));
  assert.equal(evidenceFiles(folder)['workspace/b.kicad_pcb'], sha(candidate));
  put('operation/result.json', JSON.stringify({ candidate: put('elsewhere.kicad_pcb', 'x') }));
  assert.throws(() => evidenceFiles(folder), /candidate escapes its isolated workspace/);
});

test('release artifacts must be the run candidate folder and hold no symlink', () => {
  const directory = join(folder, 'candidate');
  put('candidate/fab.zip', 'zip');
  put('operation/result.json', JSON.stringify({ artifact_directory: directory }));
  assert.ok('candidate/fab.zip' in evidenceFiles(folder));
  symlinkSync(join(folder, 'run.json'), join(directory, 'link'));
  assert.throws(() => evidenceFiles(folder), /symlinks cannot be sealed/);
  put('other/x', 'x');
  put('operation/result.json', JSON.stringify({ artifact_directory: join(folder, 'other') }));
  assert.throws(() => evidenceFiles(folder), /escape their run candidate/);
  put('operation/result.json', JSON.stringify({ artifact_directory: join(folder, 'gone') }));
  assert.ok(evidenceFiles(folder));
});

test('the candidate error comes first when both are wrong, as in Python', () => {
  put('operation/result.json', JSON.stringify({ candidate: put('out.txt', 'x'), artifact_directory: folder }));
  assert.throws(() => evidenceFiles(folder), /candidate escapes/);
});

test('verify returns the receipt of intact evidence', () => {
  seal();
  assert.equal(verify(folder).get('status'), 'passed');
});

test('verify refuses a receipt with no binding, changed evidence or an escaping name', () => {
  put('result.json', '{"status":"passed","cleanup":{"complete":true}}');
  assert.throws(() => verify(folder), /does not bind its evidence/);
  seal();
  put('operation/log.txt', 'changed');
  assert.throws(() => verify(folder), /verified run evidence changed: operation\/log.txt/);
  put('operation/log.txt', 'log');
  seal({ evidence_sha256: { 'run.json': sha(join(folder, 'run.json')), '../outside': 'x' } });
  assert.throws(() => verify(folder), /verified run evidence changed: \.\.\/outside/);
});

test('verify needs a verdict and confirmed cleanup', () => {
  seal({ status: 'error' });
  assert.throws(() => verify(folder), /confirmed process cleanup/);
  seal({ cleanup: { complete: false } });
  assert.throws(() => verify(folder), /confirmed process cleanup/);
  seal({ cleanup: null });
  assert.throws(() => verify(folder), attributeError);
});

const benchmarkRow = (value: object) => JSON.parse(jsonDumps(value)) as { runs: Record<string, any>[]; comparable: boolean; comparison_reason: string };

test('a verified gate run counts its time to targets and keeps float types', () => {
  put('events.jsonl', '{"type":"cache.hit"}\n{"type":"check.end","status":"passed"}\n{"type":"check.end","status":"blocked"}\n{"type":"check.end","status":"error"}\n');
  put('notes.jsonl', '{"kind":"intervention"}\n{"kind":"rework"}\n');
  seal({ scope: 'configured_board_gate', input_sha256: 'abc', elapsed_s: 12.5, timing: { busy_wall_s: 1 } });
  const summary = summarize([folder]);
  const row = benchmarkRow(summary).runs[0]!;
  assert.equal(row.evidence_verified, true);
  assert.equal(row.time_to_configured_targets_s, 12.5);
  assert.deepEqual([row.cache_hits, row.completed_checks, row.blocked_checks, row.error_checks], [1, 1, 1, 1]);
  assert.deepEqual([row.recorded_interventions, row.recorded_rework], [1, 1]);
  assert.equal(benchmarkRow(summary).comparable, false);
});

test('a whole float receipt value stays a float in the summary', () => {
  put('result.json', '{"status":"failed","elapsed_s":12.0,"timing":{"x":1}}');
  assert.match(jsonDumps(summarize([folder])), /"elapsed_s": 12\.0/);
});

test('changed evidence or a failed gate gives no time to targets', () => {
  seal({ scope: 'configured_board_gate', input_sha256: 'abc', elapsed_s: 1.5, timing: { x: 1 } });
  put('operation/log.txt', 'changed');
  const row = benchmarkRow(summarize([folder])).runs[0]!;
  assert.deepEqual([row.evidence_verified, row.time_to_configured_targets_s], [false, null]);
});

test('runs compare only with the same fingerprint, scope and board', () => {
  seal({ scope: 's', input_sha256: 'abc', timing: { x: 1 } });
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'run-')));
  put('run.json', '{"board":"X"}', other);
  put('result.json', '{"status":"failed","scope":"s","source_sha256":"abc","input_sha256":"zzz","timing":{"x":1}}', other);
  assert.equal(benchmarkRow(summarize([folder, other])).comparable, true);
  put('run.json', '{"board":"Y"}', other);
  const summary = benchmarkRow(summarize([folder, other]));
  assert.equal(summary.comparable, false);
  assert.match(summary.comparison_reason, /requires at least two runs/);
  rmSync(other, { recursive: true });
});
