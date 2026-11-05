import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ProtectedBlobs } from '../src/protected-blobs.ts';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
test('protected blobs remain immutable, private and quota-reserved after uncertain writes', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-protected-')), root = path.join(parent, 'store');
  const first = Buffer.from('first'), second = Buffer.from('second');
  let store = new ProtectedBlobs(root, { maxBlobBytes: 10, quotaBytes: 11 });
  try {
    assert.equal(store.put(sha(first), first).reused, false);
    assert.equal(store.put(sha(first), first).reused, true);
    assert.equal(store.read(sha(first)).toString(), 'first');
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(root, 'objects', sha(first))).mode & 0o777, 0o600);
    fs.writeFileSync(path.join(root, 'objects', sha(second)), 'unexpected');
    assert.throws(() => store.put(sha(second), second), /outcome is unknown/);
    assert.equal(store.pending().length, 1);
    store.close(); store = new ProtectedBlobs(root, { maxBlobBytes: 10, quotaBytes: 11 });
    assert.throws(() => store.put(sha(second), second), /pending/);
    assert.throws(() => store.put(sha(Buffer.from('x')), Buffer.from('x')), /quota/);
  } finally { store.close(); fs.rmSync(parent, { recursive: true, force: true }); }
});
