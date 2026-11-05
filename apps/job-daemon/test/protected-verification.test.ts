import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateTrustedVerification } from '../src/protected-verification.ts';

const hash = 'a'.repeat(64);
const expected = { verification_id: 'verify-1', job_id: 'job-1', attempt_id: 'attempt-1', project_id: 'project-1', board_id: 'board-1',
  alias_revision: 1, lease_generation: 2, source_revision: 3, source_manifest_sha256: hash, candidate_manifest_sha256: hash,
  toolchain_digest: hash, runtime_digest: hash, policy_digest: hash, evidence_manifest_sha256: hash, verifier_identity: 'verifier-1', required_checks: ['drc', 'erc'],
  parity_not_applicable_allowed: false, now_ms: 2000, max_receipt_age_ms: 1000 };
const receipt = () => ({ schema: 'pcb.verification.v1', verification_id: 'verify-1', job_id: 'job-1', attempt_id: 'attempt-1',
  project_id: 'project-1', board_id: 'board-1', alias_revision: 1, lease_generation: 2, source_revision: 3,
  source_manifest_sha256: hash, candidate_manifest_sha256: hash, toolchain_digest: hash, runtime_digest: hash, policy_digest: hash,
  evidence_manifest_sha256: hash, verifier_identity: 'verifier-1', issued_at_ms: 1500, expires_at_ms: 2500,
  checks: [{ id: 'drc', outcome: 'passed', evidence_manifest_sha256: hash }, { id: 'erc', outcome: 'passed', evidence_manifest_sha256: hash }],
  schematic_parity: 'passed', worker_cleanup: 'confirmed', cancellation: 'not_cancelled', outcome: 'passed' });

test('trusted receipt validation rejects stale, mismatched, incomplete and duplicated verification', () => {
  assert.equal(validateTrustedVerification(receipt(), expected).outcome, 'passed');
  assert.throws(() => validateTrustedVerification({ ...receipt(), attempt_id: 'other' }, expected), /attempt_id/);
  assert.throws(() => validateTrustedVerification({ ...receipt(), expires_at_ms: 2000 }, expected), /stale/);
  assert.throws(() => validateTrustedVerification({ ...receipt(), cancellation: 'cancelled' }, expected), /cleanup/);
  assert.throws(() => validateTrustedVerification({ ...receipt(), schematic_parity: 'not_applicable' }, expected), /parity/);
  assert.throws(() => validateTrustedVerification({ ...receipt(), checks: [receipt().checks[0], receipt().checks[0]] }, expected), /duplicated/);
  assert.throws(() => validateTrustedVerification({ ...receipt(), checks: [{ ...receipt().checks[0], outcome: 'skipped' }, receipt().checks[1]] }, expected), /not passed/);
  assert.throws(() => validateTrustedVerification({ ...receipt(), unexpected: true }, expected), /invalid verification/);
});
