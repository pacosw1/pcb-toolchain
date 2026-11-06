import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { sealFixtureBoard } from './cad-seal-fixture.ts';
import { sha256File } from './json-file.ts';
import { sourceInputs } from './route-decision.ts';
import { iotrouteMissing } from './iotroute-bin.ts';
import { status } from './pcb-runs.ts';

test('routing diagnose uses real backend, seals blocked evidence and does not mutate the board', { skip: iotrouteMissing() }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-routing-run-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = fileURLToPath(new URL('..', import.meta.url)); symlinkSync(tools, join(root, 'tools'));
  const board = join(root, 'hardware-design/boards/X'), pcb = join(board, 'cad/X.kicad_pcb'); mkdirSync(join(board, 'cad'), { recursive: true });
  writeFileSync(join(board, 'gate.json'), '{"project":"cad/X","checks":{}}'); writeFileSync(pcb, '(kicad_pcb (version 20240108))'); sealFixtureBoard(root, 'X');
  const before = readFileSync(pcb);
  const call = spawnSync(join(tools, 'pcb'), ['--project', root, 'routing', '--detach', '--json', 'diagnose', 'X', '--evidence', join(root, 'missing.json')], { encoding: 'utf8' });
  assert.equal(call.status, 0, call.stderr || call.stdout);
  const folder = join(root, '.gate/cli', JSON.parse(call.stdout).run_id);
  for (let i = 0; i < 200; i++) { const state = status(folder); if (['passed', 'failed', 'error', 'cancelled', 'timeout'].includes(String(state.get('status'))) && state.get('controller_alive') !== true) break; await delay(100); }
  const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
  assert.equal(result.status, 'failed', result.cause); assert.equal(result.scope, 'routing_decision');
  assert.equal(result.engineering_status, 'blocked'); assert.equal(result.cleanup.complete, true); assert.equal(result.qualified, false);
  assert.ok(result.evidence_sha256['operation/report.json']); assert.deepEqual(readFileSync(pcb), before);
});

test('routing diagnosis seals real native-export evidence without editing source', { skip: iotrouteMissing() }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pcb-routing-evidence-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = fileURLToPath(new URL('..', import.meta.url)); symlinkSync(tools, join(root, 'tools'));
  const board = join(root, 'hardware-design/boards/X'), pcb = join(board, 'native.kicad_pcb'), evidence = join(root, 'evidence');
  mkdirSync(board, { recursive: true }); mkdirSync(evidence);
  writeFileSync(join(board, 'gate.json'), JSON.stringify({ project: 'native', checks: { erc: true, drc: true } }));
  writeFileSync(pcb, '(kicad_pcb (version 20260101) (layers (0 "F.Cu" signal) (2 "B.Cu" signal)))');
  for (const ext of ['.kicad_pro', '.kicad_dru', '.kicad_sch']) writeFileSync(join(board, 'native' + ext), 'fixture');
  sealFixtureBoard(root, 'X');
  const drc = join(evidence, 'drc.json'); writeFileSync(drc, JSON.stringify({ source: 'native.kicad_pcb', coordinate_units: 'mm', included_severities: ['error'], violations: [], schematic_parity: [], unconnected_items: [] }));
  const original = join(evidence, 'record.json'); writeFileSync(original, JSON.stringify({ schema: 'iot-lab.native-export.v1', status: 'reject', board: pcb, source_mutated: false, drc_returncode: 0, inputs: sourceInputs(pcb), drc_sha256: sha256File(drc), drc_command: ['--schematic-parity', '--refill-zones', '--severity-all'] }));
  const before = readFileSync(pcb);
  const call = spawnSync(join(tools, 'pcb'), ['--project', root, 'routing', '--detach', '--json', 'diagnose', 'X', '--evidence', original], { encoding: 'utf8' });
  assert.equal(call.status, 0, call.stderr || call.stdout);
  const folder = join(root, '.gate/cli', JSON.parse(call.stdout).run_id);
  for (let i = 0; i < 200; i++) { const state = status(folder); if (['passed', 'failed', 'error', 'cancelled', 'timeout'].includes(String(state.get('status'))) && state.get('controller_alive') !== true) break; await delay(100); }
  const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
  assert.equal(result.status, 'passed', result.cause); assert.equal(result.engineering_status, 'decision');
  assert.equal(result.engineering_inputs[original], sha256File(original)); assert.deepEqual(readFileSync(pcb), before);
});
