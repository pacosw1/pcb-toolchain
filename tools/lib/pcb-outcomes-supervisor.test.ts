import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { iotrouteMissing } from './iotroute-bin.ts';
import { status } from './pcb-runs.ts';

test('outcomes direct CLI binds the real blocked report and source evidence', { skip: iotrouteMissing() }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-outcomes-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = fileURLToPath(new URL('..', import.meta.url));
  symlinkSync(tools, join(root, 'tools'));
  const call = spawnSync(join(tools, 'pcb'), ['--project', root, 'outcomes', '--detach', '--json', 'evaluate', 'STUDY', '--manifest', join(root, 'missing.json')], { encoding: 'utf8' });
  assert.equal(call.status, 0, call.stderr || call.stdout);
  const folder = join(root, '.gate/cli', JSON.parse(call.stdout).run_id);
  for (let i = 0; i < 200; i++) {
    const observed = status(folder);
    if (['passed', 'failed', 'error', 'cancelled', 'timeout'].includes(String(observed.get('status'))) && observed.get('controller_alive') !== true) break;
    await delay(100);
  }
  const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
  assert.equal(result.status, 'failed', result.cause);
  assert.equal(result.engineering_status, 'blocked');
  assert.equal(result.scope, 'placement_outcomes');
  assert.equal(result.cleanup.complete, true);
  assert.equal(result.qualified, false);
  assert.ok(result.evidence_sha256['operation/report.json']);
  assert.ok(Object.keys(result.engineering_inputs).length > 1);
});
