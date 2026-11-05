// Structural checks for a coordinator-owned verification record. Not an API or proof of verifier identity.
// Callers must obtain the record from trusted storage and recheck authority, revocation, cancellation, lease and CAS
// within the same canonical transaction. A client-supplied receipt must never be passed here as trusted evidence.
import type { VerificationReceiptV1 } from '../../../contracts/pcb-system-v1.ts';

const SHA = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const fields = ['schema', 'verification_id', 'job_id', 'attempt_id', 'project_id', 'board_id', 'alias_revision',
  'lease_generation', 'source_revision', 'source_manifest_sha256', 'candidate_manifest_sha256', 'toolchain_digest',
  'runtime_digest', 'policy_digest', 'evidence_manifest_sha256', 'verifier_identity', 'issued_at_ms', 'expires_at_ms',
  'checks', 'schematic_parity', 'worker_cleanup', 'cancellation', 'outcome'];
const hashes = ['source_manifest_sha256', 'candidate_manifest_sha256', 'toolchain_digest', 'runtime_digest', 'policy_digest', 'evidence_manifest_sha256'] as const;
const identifiers = ['verification_id', 'job_id', 'attempt_id', 'project_id', 'board_id', 'verifier_identity'] as const;
const integers = ['alias_revision', 'lease_generation', 'source_revision', 'issued_at_ms', 'expires_at_ms'] as const;
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const exactKeys = (x: Record<string, unknown>, expected: string[]): boolean => Object.keys(x).length === expected.length && expected.every(k => Object.hasOwn(x, k));

export interface VerificationExpectation {
  verification_id: string; job_id: string; attempt_id: string; project_id: string; board_id: string;
  alias_revision: number; lease_generation: number; source_revision: number; source_manifest_sha256: string;
  candidate_manifest_sha256: string; toolchain_digest: string; runtime_digest: string; policy_digest: string;
  evidence_manifest_sha256: string; verifier_identity: string; required_checks: string[]; parity_not_applicable_allowed: boolean; now_ms: number; max_receipt_age_ms: number;
}

export function validateTrustedVerification(value: unknown, expected: VerificationExpectation): VerificationReceiptV1 {
  if (!object(value) || !exactKeys(value, fields) || value.schema !== 'pcb.verification.v1') throw new Error('invalid verification receipt');
  for (const key of hashes) if (typeof value[key] !== 'string' || !SHA.test(value[key] as string)) throw new Error(`invalid ${key}`);
  for (const key of identifiers) if (typeof value[key] !== 'string' || !ID.test(value[key] as string)) throw new Error(`invalid ${key}`);
  for (const key of integers) if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1) throw new Error(`invalid ${key}`);
  for (const key of [...identifiers, ...hashes, 'alias_revision', 'lease_generation', 'source_revision'] as const)
    if (value[key] !== expected[key]) throw new Error(`verification ${key} does not match`);
  if (!Number.isSafeInteger(expected.now_ms) || !Number.isSafeInteger(expected.max_receipt_age_ms) || expected.now_ms < 1 || expected.max_receipt_age_ms < 1 ||
      (value.issued_at_ms as number) > expected.now_ms || (value.expires_at_ms as number) <= expected.now_ms ||
      (value.expires_at_ms as number) <= (value.issued_at_ms as number) || expected.now_ms - (value.issued_at_ms as number) > expected.max_receipt_age_ms)
    throw new Error('verification receipt is stale or has invalid timing');
  if (value.outcome !== 'passed' || value.worker_cleanup !== 'confirmed' || value.cancellation !== 'not_cancelled')
    throw new Error('verification did not pass with confirmed cleanup');
  if (value.schematic_parity !== 'passed' && !(value.schematic_parity === 'not_applicable' && expected.parity_not_applicable_allowed))
    throw new Error('schematic parity is not satisfied');
  if (!Array.isArray(expected.required_checks) || !expected.required_checks.length || expected.required_checks.length > 5000 ||
      !expected.required_checks.every(x => typeof x === 'string' && ID.test(x)) || new Set(expected.required_checks).size !== expected.required_checks.length ||
      !Array.isArray(value.checks) || value.checks.length !== expected.required_checks.length) throw new Error('required check set is invalid');
  const remaining = new Set(expected.required_checks);
  for (const check of value.checks) {
    if (!object(check) || !exactKeys(check, ['id', 'outcome', 'evidence_manifest_sha256']) || typeof check.id !== 'string' ||
        !remaining.delete(check.id) || check.outcome !== 'passed' || typeof check.evidence_manifest_sha256 !== 'string' || !SHA.test(check.evidence_manifest_sha256))
      throw new Error('required verification check is missing, duplicated or not passed');
  }
  if (remaining.size) throw new Error('required verification check is missing');
  return value as unknown as VerificationReceiptV1;
}
