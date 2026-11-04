import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hostTarget, iotplaceBin } from './iotplace-bin.ts';

test('the override, then the toolchain; a foreign target has no override', t => {
  const root = mkdtempSync(join(tmpdir(), 'iotplace-bin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const override = join(root, 'mine');
  writeFileSync(override, '');
  chmodSync(override, 0o755);
  mkdirSync(join(root, 'bin'));
  const tool = join(root, 'bin', 'iotplace-other');
  writeFileSync(tool, '');
  assert.equal(iotplaceBin(hostTarget(), { IOTPLACE_BIN: override }), override);
  assert.equal(iotplaceBin('other', { IOTPLACE_BIN: override, PCB_TOOLCHAIN_ROOT: root }), tool);
  assert.throws(() => iotplaceBin('absent', { IOTPLACE_BIN: override, PCB_TOOLCHAIN_ROOT: root }), /no iotplace for absent/);
});
