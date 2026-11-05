import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capabilityHash, newCapability, scopeMatches, validateScope, verifyCapability } from '../src/protected-capability.ts';
import type { CapabilityScope, CapabilityTarget } from '../src/protected-capability.ts';

test('capabilities are bounded to role, board, operation and attempt', () => {
  const token = newCapability(), hash = capabilityHash(token);
  assert.equal(verifyCapability(token, hash), true);
  assert.equal(verifyCapability(newCapability(), hash), false);
  const scope: CapabilityScope = { role: 'worker', principal: 'host-1', project: 'project-1', board: 'board-1', operation: 'route',
    job: 'job-1', attempt: 'attempt-1', issuedAtMs: 100, expiresAtMs: 1000, maxUses: 2 };
  const target: CapabilityTarget = { role: 'worker', project: 'project-1', board: 'board-1', operation: 'route', job: 'job-1', attempt: 'attempt-1' };
  validateScope(scope);
  assert.equal(scopeMatches(scope, target, 200, 0, false), true);
  assert.equal(scopeMatches(scope, { ...target, role: 'verifier' }, 200, 0, false), false);
  assert.equal(scopeMatches(scope, { ...target, attempt: 'attempt-2' }, 200, 0, false), false);
  assert.equal(scopeMatches(scope, { ...target, operation: 'edit' }, 200, 0, false), false);
  assert.equal(scopeMatches(scope, target, 1000, 0, false), false);
  assert.equal(scopeMatches(scope, target, 200, 2, false), false);
  assert.equal(scopeMatches(scope, target, 200, 0, true), false);
});
