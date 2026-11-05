import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditBoardIdentities, inspectBoardIdentity, readBoardIdentity } from './pcb-board-identity.ts';

test('Studio JSON board identity checks owner revision, paths and gate', t => {
  const root = mkdtempSync(join(tmpdir(), 'pcb-board-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const boards = join(root, 'hardware-design/boards'), folder = join(boards, 'OWNER');
  mkdirSync(join(folder, 'cad/P'), { recursive: true });
  mkdirSync(join(boards, 'OWNER-B'), { recursive: true });
  mkdirSync(join(root, 'hardware-design/registry'), { recursive: true });
  writeFileSync(join(root, 'hardware-design/registry/boards.json'), JSON.stringify({ schema_version: 1, boards: [
    { id: 'OWNER', directory: 'OWNER', kind: 'board', lifecycle: 'planned', revisions: [
      { revision: 'B', state: 'layout', spec: 'SPEC.md', project: 'cad/P/P', gate: 'OWNER-B' }
    ] }
  ] }));
  writeFileSync(join(folder, 'SPEC.md'), 'spec');
  for (const ext of ['kicad_pcb', 'kicad_sch']) writeFileSync(join(folder, `cad/P/P.${ext}`), 'native');
  writeFileSync(join(boards, 'OWNER-B/gate.json'), JSON.stringify({ project: '../OWNER/cad/P/P' }));
  const board = { schema: 'pcbstudio.board.v1', id: 'OWNER', lifecycle: 'planned', kind: 'board', revisions: [
    { rev: 'B', state: 'layout', spec: 'SPEC.md', pcb: 'cad/P/P.kicad_pcb', sch: 'cad/P/P.kicad_sch',
      gate: 'OWNER-B', gates: [{ name: 'OWNER-B' }] }
  ] };
  const path = join(folder, 'board.yaml'); writeFileSync(path, JSON.stringify(board));
  const result = inspectBoardIdentity(root, 'OWNER', readBoardIdentity(path)) as { ok: boolean; findings: { code: string }[] };
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  const mismatch = structuredClone(board); mismatch.revisions[0]!.pcb = '../escape';
  const errors = inspectBoardIdentity(root, 'OWNER', mismatch) as { ok: boolean; findings: { code: string }[] };
  assert.equal(errors.ok, false);
  assert.ok(errors.findings.some(x => x.code === 'missing_or_unsafe_path'));
  assert.ok(errors.findings.some(x => x.code === 'gate_project_mismatch'));
  const orphan = structuredClone(board); orphan.revisions.push({ ...orphan.revisions[0]!, rev: null as unknown as string });
  const unregistered = inspectBoardIdentity(root, 'OWNER', orphan) as { findings: { code: string }[] };
  assert.ok(unregistered.findings.some(x => x.code === 'unregistered_revision'));
  mkdirSync(join(root, 'tools')); writeFileSync(join(root, 'tools/build.sh'), '#!/bin/sh\n');
  const withPipeline = structuredClone(board) as typeof board & { revisions: ({ pipeline?: string } & typeof board.revisions[number])[] };
  withPipeline.revisions[0]!.pipeline = 'tools/build.sh';
  let authority = inspectBoardIdentity(root, 'OWNER', withPipeline) as { ok: boolean; findings: { code: string }[] };
  assert.ok(authority.findings.some(x => x.code === 'pipeline_authority_unknown'));
  writeFileSync(join(boards, 'OWNER-B/gate.json'), JSON.stringify({ project: '../OWNER/cad/P/P', pipeline: 'tools/other.sh' }));
  authority = inspectBoardIdentity(root, 'OWNER', withPipeline) as { ok: boolean; findings: { code: string }[] };
  assert.ok(authority.findings.some(x => x.code === 'pipeline_authority_mismatch'));
  writeFileSync(join(boards, 'OWNER-B/gate.json'), JSON.stringify({ project: '../OWNER/cad/P/P', pipeline: 'tools/build.sh' }));
  authority = inspectBoardIdentity(root, 'OWNER', withPipeline) as { ok: boolean; findings: { code: string }[] };
  assert.equal(authority.ok, true, JSON.stringify(authority.findings));
  const reg = join(root, 'hardware-design/registry/boards.json');
  const owner = { id: 'OWNER', directory: 'OWNER', kind: 'board', lifecycle: 'planned', revisions: [
    { revision: 'B', state: 'layout', spec: 'SPEC.md', project: 'cad/P/P', gate: 'OWNER-B' }
  ] };
  const gate = { id: 'OWNER-B', directory: 'OWNER-B', kind: 'gate-only', owner: 'OWNER', revision: 'B' };
  const variant = { id: 'VARIANT', kind: 'variant', directory: null, variant_of: 'OWNER' };
  writeFileSync(reg, JSON.stringify({ schema_version: 1, boards: [owner, gate, variant] }));
  const all = auditBoardIdentities(root) as { ok: boolean; counts: Record<string, number> };
  assert.equal(all.ok, true);
  assert.deepEqual(all.counts, { passed: 1, not_applicable: 2, missing: 0, conflict: 0 });
  const cli = fileURLToPath(new URL('../pcb', import.meta.url));
  const success = spawnSync(cli, ['--project', root, 'identity', '--all', '--json'], { encoding: 'utf8' });
  assert.equal(success.status, 0, success.stderr + success.stdout);
  assert.deepEqual(JSON.parse(success.stdout).counts, { passed: 1, not_applicable: 2, missing: 0, conflict: 0 });
  const pendingOwner = structuredClone(owner);
  pendingOwner.revisions[0]!.gate = null as unknown as string;
  const pendingGate = { ...gate, pending_gate: 'gate.pending.json' };
  writeFileSync(reg, JSON.stringify({ schema_version: 1, boards: [pendingOwner, pendingGate, variant] }));
  assert.equal((auditBoardIdentities(root) as { counts: Record<string, number> }).counts.conflict, 2);
  unlinkSync(join(boards, 'OWNER-B/gate.json'));
  writeFileSync(join(boards, 'OWNER-B/gate.pending.json'), '{}');
  // The owner manifest is now stale, but the pending gate-only entry is valid.
  assert.equal((auditBoardIdentities(root) as { counts: Record<string, number> }).counts.not_applicable, 2);
  writeFileSync(join(boards, 'OWNER-B/gate.json'), '{}');
  assert.equal((auditBoardIdentities(root) as { counts: Record<string, number> }).counts.not_applicable, 1);
  writeFileSync(join(boards, 'OWNER-B/gate.json'), JSON.stringify({ project: '../OWNER/cad/P/P', pipeline: 'tools/build.sh' }));
  writeFileSync(reg, JSON.stringify({ schema_version: 1, boards: [owner, gate, variant] }));
  unlinkSync(path);
  assert.equal((auditBoardIdentities(root) as { counts: Record<string, number> }).counts.missing, 1);
  const response = spawnSync(cli, ['--project', root, 'identity', '--all', '--json'], { encoding: 'utf8' });
  assert.equal(response.status, 1, response.stderr);
  assert.equal(JSON.parse(response.stdout).counts.missing, 1);
  writeFileSync(path, JSON.stringify(board));
  writeFileSync(reg, JSON.stringify({ schema_version: 1, boards: [owner, gate, variant, owner] }));
  assert.equal((auditBoardIdentities(root) as { counts: Record<string, number> }).counts.conflict, 2);
  writeFileSync(path, 'schema: pcbstudio.board.v1\n');
  assert.throws(() => readBoardIdentity(path), /JSON syntax/);
});
