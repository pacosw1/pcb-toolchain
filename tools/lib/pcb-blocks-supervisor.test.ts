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

test('direct blocks CLI supervises the real inventory backend and seals its evidence', { skip: iotrouteMissing() }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-blocks-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = fileURLToPath(new URL('..', import.meta.url));
  symlinkSync(tools, join(root, 'tools'));
  const call = spawnSync(join(tools, 'pcb'), ['--project', root, 'blocks', '--detach', '--json', 'inventory', 'UNKNOWN'], { encoding: 'utf8' });
  assert.equal(call.status, 0, call.stderr || call.stdout);
  const state = JSON.parse(call.stdout), folder = join(root, '.gate/cli', state.run_id);
  assert.equal(state.board, 'BLOCKS');
  for (let i = 0; i < 200; i++) {
    const observed = status(folder);
    if (['passed', 'failed', 'error', 'cancelled', 'timeout'].includes(String(observed.get('status'))) && observed.get('controller_alive') !== true) break;
    await delay(100);
  }
  const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
  assert.equal(result.scope, 'block_evidence');
  assert.equal(result.operation, 'blocks');
  assert.equal(result.cleanup.complete, true);
  const manifest = JSON.parse(readFileSync(join(folder, 'run.json'), 'utf8'));
  assert.deepEqual(manifest.arguments, ['inventory', 'UNKNOWN']);
  assert.match(readFileSync(join(folder, 'operation/blocks.log'), 'utf8'), /UNKNOWN/);
  assert.ok(result.evidence_sha256['operation/result.json']);
});
