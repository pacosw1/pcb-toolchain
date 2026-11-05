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

test('readiness direct CLI runs the real backend and seals its blocked invocation', { skip: iotrouteMissing() }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-readiness-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = fileURLToPath(new URL('..', import.meta.url));
  symlinkSync(tools, join(root, 'tools'));
  const cli = join(tools, 'pcb');
  const call = spawnSync(cli, ['--project', root, 'readiness', '--detach', '--json', 'UNKNOWN', join(root, 'candidate'), '--boards', '2'], { encoding: 'utf8' });
  assert.equal(call.status, 0, call.stderr || call.stdout);
  const state = JSON.parse(call.stdout), folder = join(root, '.gate/cli', state.run_id);
  assert.equal(state.board, 'ASSEMBLY');
  for (let i = 0; i < 200; i++) {
    const observed = status(folder);
    if (['passed', 'failed', 'error', 'cancelled', 'timeout'].includes(String(observed.get('status'))) && observed.get('controller_alive') !== true) break;
    await delay(100);
  }
  const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
  assert.equal(result.status, 'error');
  assert.equal(result.scope, 'assembly_readiness');
  assert.equal(result.cleanup.complete, true);
  const manifest = JSON.parse(readFileSync(join(folder, 'run.json'), 'utf8'));
  assert.deepEqual(manifest.arguments, ['UNKNOWN', join(root, 'candidate'), '--boards', '2']);
  assert.match(readFileSync(join(folder, 'operation/readiness.log'), 'utf8'), /unsupported board/);
  assert.ok(result.evidence_sha256['operation/result.json']);
});
