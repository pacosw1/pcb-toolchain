/**
 * Draft wire shapes for review; not an implemented API or authorization boundary.
 * See ../SYSTEM-CONTRACT-v1.md for invariants, hashing and unresolved import semantics.
 */
export type Sha256 = string
export type OpaqueId = string
export type JobOperation = 'build' | 'edit' | 'route' | 'repair' | 'release'
export type CheckOutcome = 'passed' | 'failed' | 'unsupported' | 'skipped' | 'incomplete'

export interface JobRequestV1 {
  schema: 'pcb.job-request.v1'
  request_id: OpaqueId
  project_id: OpaqueId
  board_id: OpaqueId
  alias_revision: number
  source_revision: number
  source_manifest_sha256: Sha256
  operation: JobOperation
  toolchain_digest: Sha256
  runtime_digest: Sha256
  policy_digest: Sha256
  limits: { run_seconds: number; queue_seconds: number }
}

export interface VerificationReceiptV1 {
  schema: 'pcb.verification.v1'
  verification_id: OpaqueId
  job_id: OpaqueId
  project_id: OpaqueId
  board_id: OpaqueId
  alias_revision: number
  lease_generation: number
  source_revision: number
  source_manifest_sha256: Sha256
  candidate_manifest_sha256: Sha256
  toolchain_digest: Sha256
  runtime_digest: Sha256
  policy_digest: Sha256
  evidence_manifest_sha256: Sha256
  verifier_identity: OpaqueId
  checks: { id: OpaqueId; outcome: CheckOutcome; evidence_sha256: Sha256 | null }[]
  schematic_parity: CheckOutcome
  worker_cleanup: 'confirmed' | 'unconfirmed'
  outcome: 'passed' | 'failed' | 'incomplete'
}

export interface CommitRequestV1 {
  schema: 'pcb.commit-request.v1'
  request_id: OpaqueId
  job_id: OpaqueId
  verification_id: OpaqueId
  project_id: OpaqueId
  board_id: OpaqueId
  alias_revision: number
  source_revision: number
  candidate_manifest_sha256: Sha256
  lease_generation: number
  /** Secret; never put this token in logs or durable idempotency records. */
  lease_token: string
}

export type CommitResultV1 =
  | { schema: 'pcb.commit-result.v1'; request_id: OpaqueId; state: 'PREPARED' | 'UNKNOWN' }
  | { schema: 'pcb.commit-result.v1'; request_id: OpaqueId; state: 'REJECTED'; reason: string }
  | { schema: 'pcb.commit-result.v1'; request_id: OpaqueId; state: 'COMMITTED'; revision: number; manifest_sha256: Sha256 }
