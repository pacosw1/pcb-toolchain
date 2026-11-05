import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { materializeSnapshot } from '../src/protected-materialize.ts';
import type { SnapshotNode } from '../src/protected-materialize.ts';

const bytes = Buffer.from('footprint');
const sha = createHash('sha256').update(bytes).digest('hex');
const nodes: SnapshotNode[] = [{ path: 'lib/part', kind: 'file', sha256: sha, size: bytes.length, executable: false },
  { path: 'boards/part', kind: 'link', target: '../lib/part' }];
test('materializes verified files and in-root links in a private snapshot', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-snapshot-'));
  try {
    const root = materializeSnapshot(parent, nodes, () => bytes, { maxFiles: 10, maxBytes: 100 });
    assert.equal(fs.readFileSync(path.join(root, 'boards/part'), 'utf8'), 'footprint');
    assert.equal(fs.readlinkSync(path.join(root, 'boards/part')), '../lib/part');
    assert.equal(fs.statSync(path.join(root, 'lib/part')).mode & 0o777, 0o644);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
test('rejects corrupted content and removes the incomplete snapshot', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-snapshot-'));
  try {
    assert.throws(() => materializeSnapshot(parent, nodes, () => Buffer.from('bad'), { maxFiles: 10, maxBytes: 100 }), /blob mismatch/);
    assert.deepEqual(fs.readdirSync(parent), []);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
test('rejects destination filesystem case collisions when present', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-snapshot-'));
  try {
    const probe = path.join(parent, 'probe'); fs.mkdirSync(probe); fs.writeFileSync(path.join(probe, 'A'), '');
    const caseInsensitive = fs.existsSync(path.join(probe, 'a')); fs.rmSync(probe, { recursive: true });
    if (!caseInsensitive) return;
    const conflict: SnapshotNode[] = ['A/x', 'a/y'].map(p => ({ path: p, kind: 'file', sha256: sha, size: bytes.length, executable: false }));
    assert.throws(() => materializeSnapshot(parent, conflict, () => bytes, { maxFiles: 10, maxBytes: 100 }));
    assert.deepEqual(fs.readdirSync(parent), []);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
