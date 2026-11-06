import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { sealFixtureBoard } from './cad-seal-fixture.ts';
import { iotrouteMissing } from './iotroute-bin.ts';
import { status } from './pcb-runs.ts';

test('schematic supervisor binds the real blocked report without writing the board', { skip: iotrouteMissing() }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-schematic-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = fileURLToPath(new URL('..', import.meta.url)); symlinkSync(tools, join(root, 'tools'));
  const board = join(root, 'hardware-design/boards/X'); mkdirSync(board, { recursive: true });
  const config = join(board, 'gate.json'), contents = '{"project":"cad/X","checks":{"erc":true}}'; writeFileSync(config, contents); sealFixtureBoard(root, 'X');
  const call = spawnSync(join(tools, 'pcb'), ['--project', root, 'schematic', '--detach', '--json', 'check', 'X', '--contract', join(root, 'missing.json')], { encoding: 'utf8' });
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
  assert.equal(result.scope, 'schematic_function');
  assert.equal(result.cleanup.complete, true);
  assert.equal(result.qualified, false);
  assert.ok(result.evidence_sha256['operation/report.json']);
  assert.equal(readFileSync(config, 'utf8'), contents);
});
