import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ProtectedLeaseStore } from '../src/protected-leases.ts';

class Fixture extends ProtectedLeaseStore {
  seed(): void {
    this.db.prepare("INSERT INTO protected_targets VALUES ('p','b',3,1,'ACTIVE')").run();
    this.db.prepare("INSERT INTO protected_aliases VALUES ('p','a','b',1),('p','other','b',1)").run();
  }
}
test('canonical aliases share a fenced lease and expired pins fail closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-authority-')); let now = 100;
  let store = new Fixture(path.join(dir, 'store'), { maxBlobBytes: 100, quotaBytes: 1000 }, () => now); store.seed();
  const issued = store.issueFromTrustedService('issue-1', 'admin', { role: 'submit', principal: 'user', project: 'p', board: 'b', operation: 'route',
    job: null, attempt: null, issuedAtMs: 100, expiresAtMs: 20_000, maxUses: 50 });
  if (issued.state !== 'ISSUED') throw new Error('issuance failed');
  const req = { requestId: 'request-1', project: 'p', board: 'b', alias: 'a', aliasRevision: 1, sourceRevision: 3, operation: 'route', ttlMs: 1000 };
  try {
    const first = store.acquire(issued.token, req); assert.equal(first.state, 'ACQUIRED'); if (first.state !== 'ACQUIRED') return;
    assert.equal(store.acquire(issued.token, { ...req, requestId: 'request-2', alias: 'other' }).state, 'BUSY');
    assert.equal(store.acquire(issued.token, req).state, 'UNKNOWN');
    store.release(issued.token, { ...req, generation: first.generation, token: first.token });
    const second = store.acquire(issued.token, { ...req, requestId: 'request-3' }); assert.equal(second.state, 'ACQUIRED'); if (second.state !== 'ACQUIRED') return;
    assert.equal(second.generation, first.generation + 1);
    assert.throws(() => store.pin(issued.token, { ...req, generation: first.generation, token: first.token }), /stale/);
    store.pin(issued.token, { ...req, generation: second.generation, token: second.token });
    now = 1200; store.close(); store = new Fixture(path.join(dir, 'store'), { maxBlobBytes: 100, quotaBytes: 1000 }, () => now);
    assert.equal(store.acquire(issued.token, { ...req, requestId: 'request-4', alias: 'other' }).state, 'BUSY');
    assert.throws(() => store.renew(issued.token, { ...req, generation: second.generation, token: second.token }, 1000), /stale/);
    assert.throws(() => store.release(issued.token, { ...req, generation: second.generation, token: second.token }), /cannot be released/);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('attempt binding pins the matching lease atomically before dispatch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-authority-')); let now = 100;
  const store = new Fixture(path.join(dir, 'store'), { maxBlobBytes: 100, quotaBytes: 1000 }, () => now); store.seed();
  const issued = store.issueFromTrustedService('issue-2', 'admin', { role: 'submit', principal: 'user', project: 'p', board: 'b', operation: 'route',
    job: null, attempt: null, issuedAtMs: 100, expiresAtMs: 20_000, maxUses: 50 });
  if (issued.state !== 'ISSUED') throw new Error('issuance failed');
  const req = { requestId: 'request-5', project: 'p', board: 'b', alias: 'a', aliasRevision: 1, sourceRevision: 3, operation: 'route', ttlMs: 1000 };
  const binding = { job: 'job-1', attempt: 'attempt-1', sourceManifest: 'a'.repeat(64), policyDigest: 'b'.repeat(64), runtimeDigest: 'c'.repeat(64), toolchainDigest: 'd'.repeat(64) };
  try {
    const acquired = store.acquire(issued.token, req); if (acquired.state !== 'ACQUIRED') throw new Error('acquire failed');
    const lease = { ...req, generation: acquired.generation, token: acquired.token };
    assert.throws(() => store.bindAttempt(issued.token, { ...lease, token: '0'.repeat(64) }, binding), /cannot bind/);
    store.bindAttempt(issued.token, lease, binding);
    assert.throws(() => store.bindAttempt(issued.token, lease, { ...binding, attempt: 'attempt-2' }), /cannot bind/);
    now = 1200;
    assert.equal(store.acquire(issued.token, { ...req, requestId: 'request-6' }).state, 'BUSY');
    assert.throws(() => store.release(issued.token, lease), /cannot be released/);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
