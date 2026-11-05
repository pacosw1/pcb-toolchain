import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ProtectedCapabilityStore } from '../src/protected-capability-store.ts';
import type { CapabilityScope, CapabilityTarget } from '../src/protected-capability.ts';

class Fixture extends ProtectedCapabilityStore {
  init(): void { this.db.exec('CREATE TABLE IF NOT EXISTS changes (n INTEGER NOT NULL) STRICT'); }
  apply(token: string, target: CapabilityTarget, fail = false): void {
    this.withCapability(token, target, () => { this.db.prepare('INSERT INTO changes VALUES (1)').run(); if (fail) throw new Error('abort'); });
  }
  count(): number { return (this.db.prepare('SELECT COUNT(*) AS n FROM changes').get() as { n: number }).n; }
}
test('issuance is fail-closed on retry and use is atomic with the protected action', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-capability-')), root = path.join(parent, 'store');
  const scope: CapabilityScope = { role: 'worker', principal: 'host-1', project: 'p', board: 'b', operation: 'route',
    job: 'job-1', attempt: 'attempt-1', issuedAtMs: 100, expiresAtMs: 1000, maxUses: 1 };
  const target: CapabilityTarget = { role: 'worker', project: 'p', board: 'b', operation: 'route', job: 'job-1', attempt: 'attempt-1' };
  const store = new Fixture(root, { maxBlobBytes: 100, quotaBytes: 1000 }, () => 200); store.init();
  try {
    const issued = store.issueFromTrustedService('request-1', 'admin-1', scope); assert.equal(issued.state, 'ISSUED'); if (issued.state !== 'ISSUED') return;
    assert.deepEqual(store.issueFromTrustedService('request-1', 'admin-1', scope), { state: 'UNKNOWN', id: issued.id });
    assert.throws(() => store.issueFromTrustedService('request-1', 'admin-1', { ...scope, board: 'other' }), /different request/);
    assert.throws(() => store.apply(issued.token, target, true), /abort/); assert.equal(store.count(), 0);
    store.apply(issued.token, target); assert.equal(store.count(), 1);
    assert.throws(() => store.apply(issued.token, target), /not authorized/);
    assert.equal(store.revokeFromTrustedService(issued.id, 'admin-1'), true); assert.equal(store.revokeFromTrustedService(issued.id, 'admin-1'), true);
    assert.equal(fs.readFileSync(path.join(root, 'authority.sqlite')).includes(issued.token), false);
  } finally { store.close(); fs.rmSync(parent, { recursive: true, force: true }); }
});
