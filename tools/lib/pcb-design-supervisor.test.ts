import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { iotrouteMissing } from './iotroute-bin.ts';
import { status } from './pcb-runs.ts';

test('a project without its release tools stops before a run and names the sync', t => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-design-no-tools-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = fileURLToPath(new URL('..', import.meta.url));
  const file = join(root, 'design.json'); writeFileSync(file, JSON.stringify({ identity: { design_id: 'IDEA', board: null } }));
  const call = spawnSync(join(tools, 'pcb'), ['--project', root, 'design', '--detach', '--json', 'check', 'IDEA', '--contract', file], { encoding: 'utf8' });
  assert.equal(call.status, 2);
  const cause = String(JSON.parse(call.stdout).cause);
  assert.match(cause, /tools\/design_contract\.ts/); assert.match(cause, /pcb toolchain-sync/);
  assert.ok(!existsSync(join(root, '.gate/cli')) || readdirSync(join(root, '.gate/cli')).filter(name => name.startsWith('run-')).length === 0, 'no run record');
});

test('design CLI evaluates an actual sourced pre-CAD contract under supervision', { skip: iotrouteMissing() }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-design-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = fileURLToPath(new URL('..', import.meta.url)); symlinkSync(tools, join(root, 'tools'));
  const text = 'A sourced synthetic output requirement'; writeFileSync(join(root, 'idea.md'), text);
  const source = { path: 'idea.md', sha256: createHash('sha256').update(text).digest('hex'), section: 'requirements' };
  const contract = { schema: 'iot-lab.design-contract.v1', identity: { design_id: 'IDEA', board: null, revision: '1' }, current_stage: 'requirements',
    requirements: [{ id: 'OUTPUT', statement: 'Output', source, verification_stage: 'prototype', acceptance: { kind: 'interval', min: 3, max: 3.6, unit: 'V', source } }],
    architecture: { source, interfaces: [{ id: 'PORT', requirements: ['OUTPUT'], source }], decisions: [{ id: 'TOPOLOGY', requirements: ['OUTPUT'], source }] },
    test_plans: [{ id: 'TEST', requirements: ['OUTPUT'], stage: 'prototype', method: 'Measure', procedure: source, access: source, equipment: source, failure_conditions: source, signals: [{ net: '/A', ref: 'J1', pad: '1' }], check: 'MEASURE' }],
    failure_conditions: [{ id: 'FAILURE', requirements: ['OUTPUT'], source, condition: 'Outside interval', test_plan: 'TEST' }], unknowns: [],
    checks: [{ id: 'MEASURE', stage: 'prototype', kind: 'bench', requirements: ['OUTPUT'], path: 'bench/results.json', plan: 'bench/plan.json' }], production: {} };
  const file = join(root, 'design.json'); writeFileSync(file, JSON.stringify(contract));
  const call = spawnSync(join(tools, 'pcb'), ['--project', root, 'design', '--detach', '--json', 'check', 'IDEA', '--contract', file, '--through', 'architecture'], { encoding: 'utf8' });
  assert.equal(call.status, 0, call.stderr || call.stdout);
  const folder = join(root, '.gate/cli', JSON.parse(call.stdout).run_id);
  for (let i = 0; i < 200; i++) { const observed = status(folder); if (['passed', 'failed', 'error', 'cancelled', 'timeout'].includes(String(observed.get('status'))) && observed.get('controller_alive') !== true) break; await delay(100); }
  const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
  assert.equal(result.status, 'passed', result.cause);
  assert.equal(result.scope, 'design_assessment'); assert.equal(result.qualified, false); assert.equal(result.cleanup.complete, true);
  assert.ok(result.evidence_sha256['operation/report.json']);
  assert.equal(JSON.parse(readFileSync(join(folder, 'operation/report.json'), 'utf8')).through, 'architecture');
});
