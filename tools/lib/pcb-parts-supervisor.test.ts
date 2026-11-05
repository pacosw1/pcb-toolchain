import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
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
