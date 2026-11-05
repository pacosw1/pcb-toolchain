import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { operationCommand } from './pcb-workflow.ts';
import { snapshot } from './pcb-sources.ts';

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
