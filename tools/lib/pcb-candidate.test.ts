import assert from 'node:assert/strict';
import { chmodSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { sealFixtureBoard } from './cad-seal-fixture.ts';
import { iotrouteMissing } from './iotroute-bin.ts';
import { adopt, parentCandidate, replaceAtomically } from './pcb-candidate.ts';
import { sourceState } from './pcb-sources.ts';
import { sha } from './pcb-workflow.ts';

function scratch(t: { after(fn: () => void): void }): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pcb-candidate-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

test('atomic candidate replacement handles short writes without truncating the target', t => {
  const root = scratch(t), target = join(root, 'board.kicad_pcb');
  put(target, 'before');
  chmodSync(target, 0o644);
  const owner = statSync(target);
  const candidate = Buffer.from('candidate\0with\nmore bytes');
  let calls = 0, checked = false;
  replaceAtomically(target, candidate, () => { checked = true; assert.equal(readFileSync(target, 'utf8'), 'before'); },
    (fd, bytes, offset, length) => { calls++; return writeSync(fd, bytes, offset, Math.min(length, 3)); });
  assert.ok(calls > 1);
  assert.equal(checked, true);
  assert.deepEqual(readFileSync(target), candidate);
  assert.equal(statSync(target).mode & 0o7777, 0o644);
  assert.deepEqual([statSync(target).uid, statSync(target).gid], [owner.uid, owner.gid]);
  assert.deepEqual(readdirSync(root), ['board.kicad_pcb']);
});

test('write or freshness failure keeps canonical bytes and removes the temporary file', t => {
  const root = scratch(t), target = join(root, 'board.kicad_pcb');
  put(target, 'before');
  chmodSync(target, 0o644);
  let descriptor = -1;
  assert.throws(() => replaceAtomically(target, Buffer.from('candidate'), () => {}, fd => { descriptor = fd; return 0; }), /invalid progress/);
  assert.throws(() => fstatSync(descriptor), /EBADF/);
  assert.equal(readFileSync(target, 'utf8'), 'before');
  assert.deepEqual(readdirSync(root), ['board.kicad_pcb']);
  let writes = 0;
  assert.throws(() => replaceAtomically(target, Buffer.from('candidate'), () => {}, (fd, bytes, offset, length) => {
    descriptor = fd;
    if (writes++ === 0) return writeSync(fd, bytes, offset, Math.min(length, 2));
    throw new Error('disk write failed');
  }), /disk write failed/);
  assert.throws(() => fstatSync(descriptor), /EBADF/);
  assert.equal(readFileSync(target, 'utf8'), 'before');
  assert.deepEqual(readdirSync(root), ['board.kicad_pcb']);
  assert.throws(() => replaceAtomically(target, Buffer.from('candidate'), () => { throw new Error('changed'); }), /changed/);
  assert.equal(readFileSync(target, 'utf8'), 'before');
  assert.deepEqual(readdirSync(root), ['board.kicad_pcb']);
  assert.throws(() => replaceAtomically(target, Buffer.from('candidate'), () => { chmodSync(target, 0o600); }), /metadata changed/);
  assert.equal(readFileSync(target, 'utf8'), 'before');
  assert.deepEqual(readdirSync(root), ['board.kicad_pcb']);
  const link = join(root, 'linked.kicad_pcb');
  symlinkSync(target, link);
  assert.throws(() => replaceAtomically(link, Buffer.from('candidate'), () => {}), /regular file/);
  assert.equal(readFileSync(target, 'utf8'), 'before');
});

function candidateFixture(t: { after(fn: () => void): void }) {
  const root = scratch(t), folder = join(root, '.gate/cli/run-candidate');
  const board = join(root, 'hardware-design/boards/X');
  const target = join(board, 'cad/X.kicad_pcb');
  const workspaceBoard = join(folder, 'workspace/hardware-design/boards/X');
  const candidate = join(workspaceBoard, 'cad/X.kicad_pcb');
  const config = JSON.stringify({ project: 'cad/X', stage: 'G3', checks: {} });
  put(join(board, 'gate.json'), config);
  put(join(workspaceBoard, 'gate.json'), config);
  put(target, '(kicad_pcb (version 20240108))');
  put(candidate, '(kicad_pcb (version 20240108))');
  sealFixtureBoard(root, 'X');
  const manifest = { root, board: 'X', operation: 'edit', node: process.execPath };
  const operation: Record<string, unknown> = { candidate, candidate_sha256: sha(candidate), candidate_verified: true,
    identity_preserved: true, protected_source_changes: [], artifacts: {} };
  const save = (resultOverrides: Record<string, unknown> = {}) => {
    put(join(folder, 'run.json'), JSON.stringify(manifest));
    put(join(folder, 'operation/result.json'), JSON.stringify(operation));
    put(join(folder, 'operation/source.json'), '{"files":{}}');
    put(join(folder, 'gate/result.json'), '{}');
    put(join(folder, 'gate/findings.json'), '{}');
    const hashes = Object.fromEntries(['run.json', 'operation/result.json', 'operation/source.json', 'gate/result.json', 'gate/findings.json']
      .map(name => [name, sha(join(folder, name))]));
    put(join(folder, 'result.json'), JSON.stringify({ status: 'passed', cleanup: { complete: true },
      candidate_sha256: sha(candidate), evidence_sha256: hashes, ...resultOverrides }));
  };
  save();
  return { root, folder, target, candidate, manifest, operation, save };
}

test('adoption rejects unsealed, failed and unverified candidates before canonical mutation', async t => {
  const f = candidateFixture(t), before = readFileSync(f.target);
  f.save({ evidence_sha256: {} });
  await assert.rejects(adopt(f.root, f.folder), /does not bind/);
  f.save({ status: 'failed' });
  await assert.rejects(adopt(f.root, f.folder), /successful, settled candidate/);
  f.operation.candidate_verified = false; f.save();
  await assert.rejects(adopt(f.root, f.folder), /lacks full gate verification/);
  f.operation.candidate_verified = 'false'; f.save();
  await assert.rejects(adopt(f.root, f.folder), /lacks full gate verification/);
  f.operation.candidate_verified = true; f.operation.identity_preserved = 'false'; f.save();
  await assert.rejects(adopt(f.root, f.folder), /lacks full gate verification/);
  f.operation.identity_preserved = true; f.operation.protected_source_changes = {}; f.save();
  await assert.rejects(adopt(f.root, f.folder), /lacks full gate verification/);
  f.operation.protected_source_changes = []; f.save({ cleanup: { complete: 'false' } });
  await assert.rejects(adopt(f.root, f.folder), /confirmed process cleanup/);
  assert.deepEqual(readFileSync(f.target), before);
});

test('parent continuation rejects malformed identity, cleanup and continuation flags', t => {
  const f = candidateFixture(t), before = readFileSync(f.target);
  f.operation.source_unchanged = true;
  f.operation.identity_preserved = 'false'; f.save();
  const reference = () => ({ folder: f.folder, result_sha256: sha(join(f.folder, 'result.json')) });
  assert.throws(() => parentCandidate(f.root, 'X', reference()), /parent lacks settled, source-preserving/);
  f.operation.identity_preserved = true; f.operation.continuation_allowed = 'false'; f.save();
  assert.throws(() => parentCandidate(f.root, 'X', reference()), /parent lacks settled, source-preserving/);
  f.operation.continuation_allowed = true; f.save({ cleanup: { complete: 'false' } });
  assert.throws(() => parentCandidate(f.root, 'X', reference()), /confirmed process cleanup/);
  assert.deepEqual(readFileSync(f.target), before);
});

test('parent continuation refuses unbound operation, source and candidate evidence', t => {
  const f = candidateFixture(t), before = readFileSync(f.target);
  f.operation.source_unchanged = true; f.save();
  const reference = () => ({ folder: f.folder, result_sha256: sha(join(f.folder, 'result.json')) });
  for (const missing of ['operation/result.json', 'operation/source.json']) {
    const receipt = JSON.parse(readFileSync(join(f.folder, 'result.json'), 'utf8'));
    delete receipt.evidence_sha256[missing];
    put(join(f.folder, 'result.json'), JSON.stringify(receipt));
    assert.throws(() => parentCandidate(f.root, 'X', reference()), /does not bind required candidate evidence/);
    f.save();
  }
  assert.throws(() => parentCandidate(f.root, 'X', reference()), /does not bind required candidate evidence/);
  const receipt = JSON.parse(readFileSync(join(f.folder, 'result.json'), 'utf8'));
  receipt.evidence_sha256[relative(f.folder, f.candidate)] = sha(f.candidate);
  put(join(f.folder, 'result.json'), JSON.stringify(receipt));
  put(f.candidate, '(kicad_pcb (version 999))');
  assert.throws(() => parentCandidate(f.root, 'X', reference()), /verified run evidence changed/);
  assert.deepEqual(readFileSync(f.target), before);
});

test('parent continuation accepts a fully bound unchanged candidate', t => {
  const f = candidateFixture(t), before = readFileSync(f.target);
  // Synthetic dependency probe returns no additional files; no native CAD is opened or modified.
  put(join(f.root, 'tools/pcb_snapshot_inputs.mjs'), 'console.log("[]")\n');
  f.operation.source_unchanged = true; f.save();
  put(join(f.folder, 'operation/source.json'), JSON.stringify(sourceState(f.root, 'X')));
  const receipt = JSON.parse(readFileSync(join(f.folder, 'result.json'), 'utf8'));
  receipt.evidence_sha256['operation/source.json'] = sha(join(f.folder, 'operation/source.json'));
  receipt.evidence_sha256[relative(f.folder, f.candidate)] = sha(f.candidate);
  put(join(f.folder, 'result.json'), JSON.stringify(receipt));
  const output = parentCandidate(f.root, 'X', { folder: f.folder, result_sha256: sha(join(f.folder, 'result.json')) });
  assert.equal(output.candidate, f.candidate);
  assert.equal(output.dependencies[f.candidate], sha(f.candidate));
  assert.deepEqual(readFileSync(f.target), before);
});

test('adoption requires its source, operation and gate evidence to be bound', async t => {
  const f = candidateFixture(t), before = readFileSync(f.target);
  const required = ['operation/result.json', 'operation/source.json', 'gate/result.json', 'gate/findings.json'];
  for (const omitted of required) {
    const receipt = JSON.parse(readFileSync(join(f.folder, 'result.json'), 'utf8'));
    delete receipt.evidence_sha256[omitted];
    put(join(f.folder, 'result.json'), JSON.stringify(receipt));
    await assert.rejects(adopt(f.root, f.folder), /does not bind required candidate evidence/);
    assert.deepEqual(readFileSync(f.target), before);
    f.save();
  }
  put(join(f.folder, 'operation/source.json'), '{"files":{"tampered":true}}');
  await assert.rejects(adopt(f.root, f.folder), /verified run evidence changed/);
  assert.deepEqual(readFileSync(f.target), before);
});

test('adoption into a board with a frozen registry field is refused until a person records an unfreeze', { skip: iotrouteMissing() }, async t => {
  const f = candidateFixture(t), before = readFileSync(f.target);
  put(join(f.root, 'hardware-design/registry/boards.json'), JSON.stringify({ schema_version: 1, boards: [{ id: 'X', directory: 'X', frozen: { reason: 'sent to the fab' } }] }));
  await assert.rejects(adopt(f.root, f.folder), /X is frozen: sent to the fab/);
  assert.deepEqual(readFileSync(f.target), before);
});

test('adoption rejects stale candidate and frozen board without a named baseline', { skip: iotrouteMissing() }, async t => {
  const f = candidateFixture(t), before = readFileSync(f.target);
  f.operation.candidate_sha256 = '0'.repeat(64); f.save();
  await assert.rejects(adopt(f.root, f.folder), /does not match the verified native board/);
  f.operation.candidate_sha256 = sha(f.candidate); f.save();
  put(join(f.root, 'FOCUS.md'), '## Frozen\n- X\n');
  await assert.rejects(adopt(f.root, f.folder), /provide --baseline RUN_ID and --defect FINDING_ID/);
  const baseline = join(f.root, '.gate/cli/run-baseline');
  put(join(baseline, 'run.json'), JSON.stringify({ root: f.root, board: 'X' }));
  put(join(baseline, 'gate/result.json'), '{}');
  put(join(baseline, 'gate/findings.json'), '{}');
  put(join(baseline, 'result.json'), JSON.stringify({ status: 'failed', cleanup: { complete: true },
    evidence_sha256: { 'run.json': sha(join(baseline, 'run.json')) } }));
  await assert.rejects(adopt(f.root, f.folder, 'DEFECT', baseline), /does not bind required candidate evidence/);
  // A fully bound frozen baseline still needs the fresh native probe, and a probe that cannot run is not a pass.
  put(join(baseline, 'gate/result.json'), JSON.stringify({ exit: 1, provenance: { inputs: [] } }));
  put(join(baseline, 'gate/findings.json'), JSON.stringify({ findings: [{ id: 'DEFECT', severity: 'error', stage: 'drc' }], inputs_valid: true, completed_checks: ['drc'] }));
  put(join(baseline, 'result.json'), JSON.stringify({ status: 'failed', cleanup: { complete: true },
    evidence_sha256: Object.fromEntries(['run.json', 'gate/result.json', 'gate/findings.json'].map(name => [name, sha(join(baseline, name))])) }));
  f.manifest.node = '/not-a-real-node'; f.save();
  put(join(f.folder, 'gate/findings.json'), JSON.stringify({ complete: true, inputs_valid: true, findings: [] }));
  const receipt = JSON.parse(readFileSync(join(f.folder, 'result.json'), 'utf8'));
  receipt.evidence_sha256['gate/findings.json'] = sha(join(f.folder, 'gate/findings.json'));
  put(join(f.folder, 'result.json'), JSON.stringify(receipt));
  await assert.rejects(adopt(f.root, f.folder, 'DEFECT', baseline), /not-a-real-node|ENOENT|No such file/);
  assert.deepEqual(readFileSync(f.target), before);
});
