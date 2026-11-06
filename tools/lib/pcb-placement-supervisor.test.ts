import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { sealFixtureBoard } from './cad-seal-fixture.ts';
import { BOARD, makeFixture } from './part-fixture.ts';
import { sha256File } from './json-file.ts';
import { iotrouteMissing } from './iotroute-bin.ts';
import { status } from './pcb-runs.ts';

test('placement supervisor seals a real blocked review without mutating canonical CAD', { skip: iotrouteMissing() }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-placement-run-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = fileURLToPath(new URL('..', import.meta.url)); symlinkSync(tools, join(root, 'tools'));
  const board = join(root, 'hardware-design/boards/X'), pcb = join(board, 'cad/X.kicad_pcb'); mkdirSync(join(board, 'cad'), { recursive: true });
  writeFileSync(join(board, 'gate.json'), '{"project":"cad/X","checks":{}}'); writeFileSync(pcb, '(kicad_pcb (version 20240108))'); sealFixtureBoard(root, 'X');
  const before = readFileSync(pcb), missing = join(root, 'missing.json');
  const call = spawnSync(join(tools, 'pcb'), ['--project', root, 'placement', '--detach', '--json', 'check', 'X', '--manifest', missing], { encoding: 'utf8' });
  assert.equal(call.status, 0, call.stderr || call.stdout);
  const folder = join(root, '.gate/cli', JSON.parse(call.stdout).run_id);
  for (let i = 0; i < 200; i++) { const state = status(folder); if (['passed', 'failed', 'error', 'cancelled', 'timeout'].includes(String(state.get('status'))) && state.get('controller_alive') !== true) break; await delay(100); }
  const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
  assert.equal(result.status, 'failed', result.cause); assert.equal(result.scope, 'placement_constraints');
  assert.equal(result.engineering_status, 'blocked'); assert.equal(result.cleanup.complete, true); assert.equal(result.qualified, false);
  assert.ok(result.evidence_sha256['operation/report.json']); assert.ok(result.engineering_absent_inputs.some((item: string) => item.endsWith('/missing.json')));
  assert.deepEqual(readFileSync(pcb), before);
});

test('placement supervisor evaluates a source-bound reviewed synthetic board', { skip: iotrouteMissing() }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pcb-placement-review-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = fileURLToPath(new URL('..', import.meta.url)); symlinkSync(tools, join(root, 'tools'));
  const manifest = makeFixture(root), pcb = join(root, 'hardware-design/boards', BOARD, 'fixture.kicad_pcb'), before = readFileSync(pcb);
  sealFixtureBoard(root, BOARD);
  const call = spawnSync(join(tools, 'pcb'), ['--project', root, 'placement', '--detach', '--json', 'check', BOARD, '--manifest', manifest], { encoding: 'utf8' });
  assert.equal(call.status, 0, call.stderr || call.stdout);
  const folder = join(root, '.gate/cli', JSON.parse(call.stdout).run_id);
  for (let i = 0; i < 200; i++) { const state = status(folder); if (['passed', 'failed', 'error', 'cancelled', 'timeout'].includes(String(state.get('status'))) && state.get('controller_alive') !== true) break; await delay(100); }
  const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
  assert.equal(result.status, 'passed', result.cause); assert.equal(result.engineering_status, 'passed');
  const report = JSON.parse(readFileSync(join(folder, 'operation/report.json'), 'utf8'));
  assert.ok(report.measurements.length); assert.equal(result.engineering_inputs[pcb], sha256File(pcb));
  assert.deepEqual(readFileSync(pcb), before);
});
