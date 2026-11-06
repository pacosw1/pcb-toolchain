import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { repairSnapshot } from './route-decision-cli.ts';
import { operationCommand } from './pcb-workflow.ts';
import { snapshot, sourceState } from './pcb-sources.ts';

test('an admitted build entrypoint exists as an independent file in the candidate snapshot', t => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-build-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (relative: string, content: string) => {
    const path = join(root, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path;
  };
  put('tools/pcb_snapshot_inputs.mjs', 'console.log("[]")');
  put('hardware-design/boards/X/gate.json', JSON.stringify({ project: 'cad/X', pipeline: 'tools/build-x.sh' }));
  for (const ext of ['kicad_pcb', 'kicad_sch', 'kicad_pro']) put(`hardware-design/boards/X/cad/X.${ext}`, 'synthetic');
  const script = put('tools/build-x.sh', '#!/bin/sh\necho candidate\n');
  assert.deepEqual(operationCommand(root, 'X', 'build'), ['sh', 'tools/build-x.sh']);
  const candidate = join(root, 'candidate');
  const state = snapshot(root, candidate, 'X');
  assert.ok(state.files['tools/build-x.sh']);
  assert.equal(readFileSync(join(candidate, 'tools/build-x.sh'), 'utf8'), '#!/bin/sh\necho candidate\n');
  writeFileSync(script, 'changed original');
  assert.equal(readFileSync(join(candidate, 'tools/build-x.sh'), 'utf8'), '#!/bin/sh\necho candidate\n');
});

test('a registered sibling revision copies the owner pipeline and its own gate', t => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-build-sibling-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (relative: string, content: string) => {
    const path = join(root, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path;
  };
  put('tools/pcb_snapshot_inputs.mjs', 'console.log(JSON.stringify([process.argv[2] + "/hardware-design/boards/X-B/gate.json"]))');
  put('hardware-design/registry/boards.json', JSON.stringify({ boards: [{ id: 'X', directory: 'X', revisions: [{ revision: 'B', gate: 'X-B', project: 'cad/X-B/X-B' }] }] }));
  put('hardware-design/boards/X-B/gate.json', JSON.stringify({ project: '../X/cad/X-B/X-B', pipeline: 'hardware-design/boards/X/build-revision.sh' }));
  const script = 'hardware-design/boards/X/build-revision.sh'; put(script, '#!/bin/sh\necho candidate\n');
  for (const ext of ['kicad_pcb', 'kicad_sch', 'kicad_pro']) put(`hardware-design/boards/X/cad/X-B/X-B.${ext}`, 'synthetic');
  const candidate = join(root, 'candidate'); snapshot(root, candidate, 'X-B');
  assert.deepEqual(operationCommand(candidate, 'X-B', 'build'), ['sh', script]);
  assert.equal(readFileSync(join(candidate, script), 'utf8'), '#!/bin/sh\necho candidate\n');
});

test('a board snapshot carries the shared art that board labels read, and no other board', t => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-art-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (relative: string, content: string) => {
    const path = join(root, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path;
  };
  put('tools/pcb_snapshot_inputs.mjs', 'console.log("[]")');
  put('hardware-design/boards/X/gate.json', JSON.stringify({ project: 'cad/X', pipeline: 'tools/build-x.sh' }));
  for (const ext of ['kicad_pcb', 'kicad_sch', 'kicad_pro']) put(`hardware-design/boards/X/cad/X.${ext}`, 'synthetic');
  put('hardware-design/boards/_art/pitsa-logo.png', 'logo');
  put('hardware-design/boards/Y/gate.json', '{}');
  const candidate = join(root, 'candidate');
  const state = snapshot(root, candidate, 'X');
  assert.equal(readFileSync(join(candidate, 'hardware-design/boards/_art/pitsa-logo.png'), 'utf8'), 'logo');
  assert.ok(!state.files['hardware-design/boards/Y/gate.json']);
});

for (const [name, capture] of [['candidate', snapshot], ['standalone repair', repairSnapshot]] as const) {
  test(`${name} snapshots bind datasheets from nested and shared schematic sheets`, t => {
    const root = mkdtempSync(join(tmpdir(), 'pcb-sheet-datasheets-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const put = (relative: string, content: string | Uint8Array) => {
      const path = join(root, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
    };
    // Exercise the real sheet dependency resolver, without native KiCad or a project checkout.
    put('tools/pcb_snapshot_inputs.mjs', `import {gateInputs} from ${JSON.stringify(new URL('./gate-inputs.mjs', import.meta.url).href)}; console.log(JSON.stringify(gateInputs(process.argv[2],process.argv[3]).files));`);
    put('tools/gate.mjs', 'export {};');
    const config = { project: 'cad/X', checks: {}, snapshot_schematic_datasheets: true };
    put('hardware-design/boards/X/gate.json', JSON.stringify(config));
    for (const ext of ['kicad_pcb', 'kicad_pro', 'kicad_dru']) put(`hardware-design/boards/X/cad/X.${ext}`, '{}');
    put('hardware-design/boards/X/cad/X.kicad_sch', `(kicad_sch
      (symbol (property "Datasheet" "top.pdf"))
      (sheet (property "Sheetfile" "sub/child.kicad_sch"))
      (sheet (property "Sheetfile" "sub/child.kicad_sch")))`);
    put('hardware-design/boards/X/cad/sub/child.kicad_sch', `(kicad_sch
      (symbol (property "Datasheet" "child.pdf"))
      (sheet (property "Sheetfile" "../../../../blocks/shared.kicad_sch")))`);
    put('hardware-design/blocks/shared.kicad_sch', `(kicad_sch
      (symbol (property "Datasheet" "shared.pdf"))
      (sheet (property "Sheetfile" "../boards/X/cad/X.kicad_sch")))`);
    const pdfs = ['top.pdf', 'child.pdf', 'shared.pdf'];
    for (const pdf of [...pdfs, 'unrelated.pdf']) put(`hardware-design/registry/datasheets/${pdf}`, Buffer.from(`%PDF original ${pdf}\n\0unchanged`));
    const before = sourceState(root, 'X');
    const workspace = join(root, 'candidate'); capture(root, workspace, 'X');
    for (const pdf of pdfs) {
      const relative = `hardware-design/registry/datasheets/${pdf}`;
      assert.deepEqual(readFileSync(join(workspace, relative)), readFileSync(join(root, relative)), pdf);
      assert.ok(before.files[relative], `fingerprint must bind ${pdf}`);
    }
    assert.equal(existsSync(join(workspace, 'hardware-design/registry/datasheets/unrelated.pdf')), false);
    put('hardware-design/registry/datasheets/child.pdf', 'changed original child PDF');
    assert.notEqual(sourceState(root, 'X').sha256, before.sha256);
    assert.match(readFileSync(join(workspace, 'hardware-design/registry/datasheets/child.pdf'), 'utf8'), /original child/);
    put('hardware-design/boards/X/gate.json', JSON.stringify({ ...config, snapshot_schematic_datasheets: false }));
    const disabled = join(root, 'disabled'); capture(root, disabled, 'X');
    for (const pdf of pdfs) assert.equal(existsSync(join(disabled, `hardware-design/registry/datasheets/${pdf}`)), false);
  });
}
