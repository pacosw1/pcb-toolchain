import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { atomicJson, sha256File } from './json-file.ts';
import { validateGate } from './pcb-routing-admission.ts';

test('shared gate validator rejects missing checks and binds a valid G4 gate without daemon Node', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'routing-admission-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tools/lib'), { recursive: true });
  copyFileSync(fileURLToPath(new URL('./gate-core.mjs', import.meta.url)), join(root, 'tools/lib/gate-core.mjs'));
  const config = join(root, 'hardware-design/boards/X/gate.json');
  atomicJson(config, { project: 'cad/X', stage: 'G4', checks: {} });
  await assert.rejects(validateGate(root, 'X'), /required check disabled/);
  atomicJson(config, { project: 'cad/X', stage: 'G4', checks: { erc: true, drc: true, paths: 'paths.json', viapads: {}, kicad_happy: {}, port_labels: true } });
  const admission = await validateGate(root, 'X');
  assert.equal(admission.stage, 'G4'); assert.equal(admission.inputs['hardware-design/boards/X/gate.json'], sha256File(config));
  assert.equal(admission.inputs['tools/lib/gate-core.mjs'], sha256File(join(root, 'tools/lib/gate-core.mjs')));
  atomicJson(config, { project: 'cad/X', stage: 'G3', checks: { erc: true } });
  await assert.rejects(validateGate(root, 'X'), /requires a G4 or G5 gate/);
});
