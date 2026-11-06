import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sha } from './pcb-workflow.ts';
import { sourceState } from './pcb-sources.ts';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { sealFixtureBoard } from './cad-seal-fixture.ts';
import { iotrouteMissing } from './iotroute-bin.ts';
import { status } from './pcb-runs.ts';

test('parts selection invokes real backend and seals blocked evidence', { skip: iotrouteMissing() }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-parts-run-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = fileURLToPath(new URL('..', import.meta.url)); symlinkSync(tools, join(root, 'tools'));
  const call = spawnSync(join(tools, 'pcb'), ['--project', root, 'parts', '--detach', '--json', 'selection', 'IDEA', '--manifest', join(root, 'missing.json')], { encoding: 'utf8' });
  assert.equal(call.status, 0, call.stderr || call.stdout);
  const folder = join(root, '.gate/cli', JSON.parse(call.stdout).run_id);
  for (let i = 0; i < 200; i++) { const state = status(folder); if (['passed', 'failed', 'error', 'cancelled', 'timeout'].includes(String(state.get('status'))) && state.get('controller_alive') !== true) break; await delay(100); }
  const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
  assert.equal(result.status, 'failed', result.cause); assert.equal(result.scope, 'part_evidence');
  assert.equal(result.engineering_status, 'blocked'); assert.equal(result.cleanup.complete, true); assert.equal(result.qualified, false);
  assert.ok(result.evidence_sha256['operation/report.json']);
});

test('parts PDF inspection confines actual extraction cache to the run', { skip: iotrouteMissing() }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-pdf-run-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = fileURLToPath(new URL('..', import.meta.url)); symlinkSync(tools, join(root, 'tools'));
  const chunks = ['%PDF-1.4\n']; const offsets: number[] = [];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
  for (const [i, value] of objects.entries()) { offsets.push(Buffer.byteLength(chunks.join(''))); chunks.push(`${i + 1} 0 obj\n${value}\nendobj\n`); }
  const xref = Buffer.byteLength(chunks.join('')); chunks.push(`xref\n0 5\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const pdf = join(root, 'source.pdf'); writeFileSync(pdf, chunks.join(''));
  const call = spawnSync(join(tools, 'pcb'), ['--project', root, 'parts', '--detach', '--json', 'inspect', pdf], { encoding: 'utf8' });
  assert.equal(call.status, 0, call.stderr || call.stdout);
  const folder = join(root, '.gate/cli', JSON.parse(call.stdout).run_id);
  for (let i = 0; i < 200; i++) { const state = status(folder); if (['passed', 'failed', 'error', 'cancelled', 'timeout'].includes(String(state.get('status'))) && state.get('controller_alive') !== true) break; await delay(100); }
  const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
  assert.equal(result.status, 'passed', result.cause); assert.equal(result.engineering_status, 'inspected');
  const report = JSON.parse(readFileSync(join(folder, 'operation/report.json'), 'utf8'));
  assert.ok(report.cache_directory.startsWith(join(realpathSync(folder), 'operation/cache') + '/'));
  assert.ok(Object.keys(result.evidence_sha256).some(name => name.startsWith('operation/cache/')));
});

test('parts from-run binds the sealed candidate and never mutates canonical CAD', { skip: iotrouteMissing() }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pcb-parts-parent-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = fileURLToPath(new URL('..', import.meta.url)); symlinkSync(tools, join(root, 'tools'));
  const folder = join(root, '.gate/cli/run-parent'), board = join(root, 'hardware-design/boards/X');
  const put = (path: string, value: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
  const config = JSON.stringify({ project: 'cad/X', stage: 'G3', checks: {} });
  const target = join(board, 'cad/X.kicad_pcb'), candidate = join(folder, 'workspace/hardware-design/boards/X/cad/X.kicad_pcb');
  put(join(board, 'gate.json'), config); put(join(folder, 'workspace/hardware-design/boards/X/gate.json'), config);
  put(target, '(kicad_pcb (version 20240108))'); put(candidate, '(kicad_pcb (version 20240108))');
  put(join(board, 'cad/X.kicad_sch'), '(kicad_sch (version 20250114))');
  sealFixtureBoard(root, 'X');
  put(join(folder, 'workspace/hardware-design/boards/X/cad/X.kicad_sch'), '(kicad_sch (version 20250114))');
  put(join(folder, 'run.json'), JSON.stringify({ root, board: 'X', operation: 'edit', node: process.execPath }));
  put(join(folder, 'operation/result.json'), JSON.stringify({ candidate, candidate_sha256: sha(candidate), candidate_verified: true, identity_preserved: true, source_unchanged: true, protected_source_changes: [] }));
  put(join(folder, 'operation/source.json'), JSON.stringify(sourceState(root, 'X')));
  const files = ['run.json', 'operation/result.json', 'operation/source.json', 'workspace/hardware-design/boards/X/cad/X.kicad_pcb'];
  put(join(folder, 'result.json'), JSON.stringify({ status: 'passed', cleanup: { complete: true }, evidence_sha256: Object.fromEntries(files.map(name => [name, sha(join(folder, name))])) }));
  const parentHash = sha(join(folder, 'result.json')), before = readFileSync(target);
  const call = spawnSync(join(tools, 'pcb'), ['--project', root, 'parts', '--from-run', 'run-parent', '--detach', '--json', 'status', 'X'], { encoding: 'utf8' });
  assert.equal(call.status, 0, call.stderr || call.stdout);
  const child = join(root, '.gate/cli', JSON.parse(call.stdout).run_id);
  for (let i = 0; i < 200; i++) { const state = status(child); if (['passed', 'failed', 'error', 'cancelled', 'timeout'].includes(String(state.get('status'))) && state.get('controller_alive') !== true) break; await delay(100); }
  const result = JSON.parse(readFileSync(join(child, 'result.json'), 'utf8'));
  assert.ok(['passed', 'failed'].includes(result.status), result.cause);
  assert.equal(result.engineering_inputs[join(folder, 'result.json')], parentHash);
  assert.equal(result.engineering_inputs[candidate], sha(candidate));
  assert.equal(JSON.parse(readFileSync(join(child, 'run.json'), 'utf8')).from_run.result_sha256, parentHash);
  assert.deepEqual(readFileSync(target), before);
  writeFileSync(candidate, '(kicad_pcb (version 999))');
  const stale = spawnSync(join(tools, 'pcb'), ['--project', root, 'parts', '--from-run', 'run-parent', '--detach', '--json', 'status', 'X'], { encoding: 'utf8' });
  assert.equal(stale.status, 2);
  assert.match(JSON.parse(stale.stdout).cause, /evidence changed/);
  assert.deepEqual(readFileSync(target), before);
});
