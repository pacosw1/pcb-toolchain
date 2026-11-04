import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { collect, COMMON, current } from './pcb-observation-inputs.ts';

function fixture(t: { after: (fn: () => void) => void }): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pcb-observation-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = fileURLToPath(new URL('../', import.meta.url));
  for (const name of [...COMMON, 'part_evidence.py', 'part_native.py', 'run_record.py', 'lib/kicad-population.mjs', 'pcb_observation_inputs.py']) {
    const path = join(root, 'tools', name); mkdirSync(dirname(path), { recursive: true }); copyFileSync(join(tools, name), path);
  }
  return root;
}

test('certified sources bind consumed files and lexical absences without running the launcher', t => {
  const root = fixture(t);
  const inputs = collect(root, 'parts', ['status', 'X'], process.execPath);
  assert.equal(inputs.policy.mode, 'audited_parts', inputs.policy.reason);
  assert.equal(current(inputs.policy), true);
  assert.ok(inputs.absent.includes(join(root, 'tools', 'json.py')));
  assert.ok(inputs.files[join(root, 'tools', 'part_native.py')]);
  assert.equal(inputs.files[join(root, 'tools', 'test_pcb_next.py')], undefined);
  writeFileSync(join(root, 'tools', 'unused.ts'), 'unused data');
  assert.equal(current(inputs.policy), true);
  symlinkSync(join(root, 'missing'), join(root, 'tools', 'json.py'));
  assert.equal(current(inputs.policy), false);
  assert.equal(collect(root, 'parts', ['status'], process.execPath).policy.mode, 'conservative');
});

test('a changed audited producer uses the conservative boundary', t => {
  const root = fixture(t), path = join(root, 'tools', 'part_native.py');
  writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('\n')]));
  const inputs = collect(root, 'parts', ['status'], process.execPath);
  assert.equal(inputs.policy.mode, 'conservative');
  assert.match(inputs.policy.reason, /audited producer changed: part_native.py/);
  assert.ok(inputs.files[path]);
  assert.ok(inputs.files[join(root, 'tools', 'pcb_cli.py')]);
});

test('unreviewed actions and unavailable launchers cannot claim an audited boundary', t => {
  const root = fixture(t);
  const stock = collect(root, 'parts', ['stock'], process.execPath);
  assert.equal(stock.policy.mode, 'conservative');
  const missing = collect(root, 'parts', ['inspect'], join(root, 'missing-runtime'));
  assert.equal(missing.policy.mode, 'conservative');
  assert.equal(current(missing.policy), false);
  assert.equal(current(null), false);
  assert.equal(current({ schema: 'unknown' }), false);
});
