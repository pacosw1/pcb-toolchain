import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { BoardLeases } from '../src/board-leases.ts';

test('existing board bytes migrate into private revision history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-revision-migration-')), file = path.join(dir, 'state.sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec('CREATE TABLE board_revisions (board TEXT PRIMARY KEY, sha256 TEXT NOT NULL, content BLOB NOT NULL, generation INTEGER NOT NULL, revision INTEGER NOT NULL) STRICT');
  legacy.prepare('INSERT INTO board_revisions VALUES (?,?,?,?,?)').run('p/B', 'digest', Buffer.from('original'), 3, 5); legacy.close();
  fs.chmodSync(file, 0o644);
  const current = new BoardLeases(file);
  try { assert.equal(Buffer.from(current.readVersion('p/B', 5)!.content).toString(), 'original'); assert.equal(fs.statSync(file).mode & 0o777, 0o600); }
  finally { current.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('leases are exclusive and generations survive restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-leases-'));
  const file = path.join(dir, 'leases.sqlite');
  let now = 10_000;
  const a = new BoardLeases(file, () => now), b = new BoardLeases(file, () => now);
  try {
    const first = a.acquire('project/board', 'mini', 2000)!;
    assert.equal(b.acquire('project/board', 'laptop', 2000), null);
    assert.ok(b.acquire('project/other', 'laptop', 2000));
    assert.equal(a.valid({ ...first, token: 'bad' }), false);
    now += 1000;
    assert.equal(a.renew(first, 2000)?.expiresAt, 13_000);
    now = 13_000;
    const second = b.acquire('project/board', 'laptop', 2000)!;
    assert.equal(second.generation, first.generation + 1);
    assert.equal(a.valid(first), false);
    assert.equal(a.release(first), false);
    assert.equal(b.release(second), true);
    a.close(); b.close();
    const restarted = new BoardLeases(file, () => now);
    try {
      assert.equal(restarted.acquire('project/board', 'linux', 2000)!.generation, second.generation + 1);
      assert.equal(restarted.renew(second, 2000), null);
    } finally { restarted.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('publication atomically fences lease and compares revision across connections and restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-publication-'));
  const file = path.join(dir, 'state.sqlite');
  let now = 20_000;
  const a = new BoardLeases(file, () => now), b = new BoardLeases(file, () => now);
  try {
    const first = a.acquire('project/board', 'mini', 1000)!;
    assert.equal(a.beginCommit(first), true);
    const original = a.publish(first, null, Buffer.from('original'));
    assert.throws(() => a.publish(first, null, Buffer.from('overwrite')), /revision changed/);
    assert.equal(a.endCommit(first), true);
    now += 1000;
    const next = b.acquire('project/board', 'linux', 1000)!;
    assert.equal(b.beginCommit(next), true);
    assert.throws(() => a.publish(first, original.revision, Buffer.from('stale')), /not pinned/);
    assert.throws(() => b.publish(next, 99, Buffer.from('wrong base')), /revision changed/);
    const published = b.publish(next, original.revision, Buffer.from('new'));
    assert.equal(published.generation, next.generation);
    const reverted = b.publish(next, published.revision, Buffer.from('original'));
    assert.equal(reverted.sha256, original.sha256);
    assert.throws(() => b.publish(next, original.revision, Buffer.from('stale base')), /revision changed/);
    const final = b.publish(next, reverted.revision, Buffer.from('new'));
    a.close(); b.close();
    const restarted = new BoardLeases(file, () => now);
    try {
      const stored = restarted.readBoard('project/board')!;
      assert.equal(stored.sha256, final.sha256);
      assert.equal(Buffer.from(stored.content).toString(), 'new');
      assert.equal(stored.generation, next.generation);
      assert.equal(stored.revision, final.revision);
      assert.equal(Buffer.from(restarted.readVersion('project/board', 1)!.content).toString(), 'original');
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    } finally { restarted.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a pinned commit excludes new writers after expiry and coordinator restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-pinned-'));
  const file = path.join(dir, 'state.sqlite');
  let now = 10000;
  let leases = new BoardLeases(file, () => now);
  try {
    const a = leases.acquire('project/A', 'mini', 1000)!;
    assert.equal(leases.beginCommit(a), true);
    assert.equal(leases.beginCommit(a), true); // a lost response may be retried
    assert.equal(leases.release(a), false);
    now += 2000;
    assert.equal(leases.acquire('project/A', 'laptop', 1000), null);
    leases.close();
    leases = new BoardLeases(file, () => now);
    assert.equal(leases.acquire('project/A', 'laptop', 1000), null);
    assert.equal(leases.endCommit({ ...a, token: '0'.repeat(64) }), false);
    assert.equal(leases.endCommit(a), true);
    const b = leases.acquire('project/A', 'laptop', 1000)!;
    assert.equal(b.generation, a.generation + 1);
    assert.equal(leases.beginCommit(a), false);
  } finally { leases.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
