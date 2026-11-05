import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { gateNote, project, record } from './metadata.mjs';

const script = fileURLToPath(new URL('../board_3d.sh', import.meta.url));
const helper = fileURLToPath(new URL('./metadata.mjs', import.meta.url));
const core = { erc_errors: 0, drc_errors: 0, drc_parity: 0, drc_unconnected: 0 };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'board3d-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const board = join(root, 'hardware-design/boards/TEST'), out = join(root, 'out');
  mkdirSync(join(board, 'cad'), { recursive: true }); mkdirSync(out);
  const put = value => writeFileSync(join(board, 'gate-metrics.json'), JSON.stringify(value));
  return { root, board, out, put };
}

test('gate notes require current board, valid schema and complete numeric metrics', t => {
  const f = fixture(t);
  assert.match(gateNote(f.root, 'TEST', 'sha'), /^gate UNVERIFIED: no readable/);
  f.put({ schema_version: 1 });
  assert.match(gateNote(f.root, 'TEST', 'sha'), /not schema 2/);
  f.put({ schema_version: 2, board: 'TEST', pcb_sha256: 'sha', metrics: { ...core, drc_errors: false } });
  assert.match(gateNote(f.root, 'TEST', 'sha'), /metrics missing drc_errors/);
  f.put({ schema_version: 2, board: 'TEST', pcb_sha256: 'old', metrics: core });
  assert.match(gateNote(f.root, 'TEST', 'sha'), /stale/);
  f.put({ schema_version: 2, board: 'TEST', pcb_sha256: 'sha', metrics: { ...core, drc_errors: 2, drc_warnings: 4 } });
  assert.equal(gateNote(f.root, 'TEST', 'sha'), 'gate NOT at target: drc_errors 2');
  f.put({ schema_version: 2, board: 'TEST', pcb_sha256: 'sha', metrics: { ...core, drc_warnings: 4 } });
  assert.equal(gateNote(f.root, 'TEST', 'sha'), 'gate at target');
});

test('record preserves other boards and updates only the selected row', t => {
  const f = fixture(t);
  writeFileSync(join(f.board, 'gate.json'), JSON.stringify({ project: 'cad/design' }));
  assert.equal(project(join(f.board, 'gate.json')), 'cad/design');
  writeFileSync(join(f.out, 'TEST.glb'), 'fixture');
  writeFileSync(join(f.out, 'boards.json'), JSON.stringify([{ name: 'OTHER', note: 'kept' }, { name: 'TEST', note: 'old' }]));
  f.put({ schema_version: 2, board: 'TEST', pcb_sha256: 'current', metrics: core });
  assert.deepEqual(record(f.root, f.out, 'TEST', 'current'), { note: 'gate at target', bytes: 7 });
  const rows = JSON.parse(readFileSync(join(f.out, 'boards.json'), 'utf8'));
  assert.deepEqual(rows, [{ name: 'OTHER', note: 'kept' }, { name: 'TEST', pcb_sha256: 'current', note: 'gate at target' }]);
});

test('board 3D shell renders and updates the index without Python', t => {
  const f = fixture(t), tools = join(f.root, 'tools'), fake = join(f.root, 'bin');
  mkdirSync(join(tools, 'board3d'), { recursive: true }); mkdirSync(fake);
  copyFileSync(script, join(tools, 'board_3d.sh')); copyFileSync(helper, join(tools, 'board3d/metadata.mjs'));
  writeFileSync(join(tools, 'board3d/index.html'), 'viewer');
  writeFileSync(join(f.board, 'gate.json'), JSON.stringify({ project: 'cad/X' }));
  const board = join(f.board, 'cad/X.kicad_pcb'); writeFileSync(board, 'synthetic fixture');
  const sha = execFileSync('shasum', ['-a', '256', board], { encoding: 'utf8' }).split(' ')[0];
  f.put({ schema_version: 2, board: 'TEST', pcb_sha256: sha, metrics: core });
  const executable = (name, body) => { const path = join(fake, name); writeFileSync(path, body); chmodSync(path, 0o755); };
  executable('kicad-cli', '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then shift; printf output > "$1"; exit 0; fi; shift; done\nexit 2\n');
  executable('npx', '#!/bin/sh\ncp "$4" "$5"\n');
  executable('python3', '#!/bin/sh\necho unexpected-python >&2; exit 88\n');
  const result = spawnSync('sh', [join(tools, 'board_3d.sh'), 'TEST'], { encoding: 'utf8', env: { ...process.env, PATH: `${fake}:${dirname(process.execPath)}:/usr/bin:/bin`, BOARD3D_OUT: f.out } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /PASS 6 bytes GLB, 0 3D models not found; gate at target/);
  assert.equal(JSON.parse(readFileSync(join(f.out, 'boards.json'), 'utf8'))[0].pcb_sha256, sha);
});
