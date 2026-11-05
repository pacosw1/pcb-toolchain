# PCB system contract v1 (draft)

Status: proposed for review with the task 1332 verifier/worker owner. This is not an implemented API or a security
claim. It specifies the minimum boundary between Studio/CLI, the coordinator and a trusted verifier. Existing
`board-revisions` and local adoption do not yet satisfy it.
The matching [draft wire types](contracts/pcb-system-v1.ts) make field shapes concrete; they are not runtime validation.

## Identities and immutable inputs

- `project_id` is an opaque coordinator-assigned ID. `board_id` is the coordinator's canonical target within the
  project, not a checkout path, gate alias or display name. An alias resolves to exactly one canonical target at a
  specific `alias_revision`; ambiguous or changed aliases fail before lease acquisition and before commit.
- Every source and candidate is a project manifest `pcb.project-manifest.v1`: a sorted set of safe relative POSIX
  paths and each regular file's SHA-256 and byte length, plus an explicitly versioned dependency declaration. Reject
  absolute paths, empty segments, `.`, `..`, backslashes, NUL, duplicate paths and paths colliding after the target
  platform's normalization. The manifest covers the PCB, schematic, KiCad project/rules, libraries, scripts,
  reviewed constraints and all other gate inputs. The dependency declaration distinguishes required inputs,
  optional-but-absent inputs, and external immutable dependencies; required missing or undeclared inputs fail closed.
  Derived/live previews never become source inputs implicitly. A read-only ENV-SENSE probe found external and absent
  paths in the current closure; their roles must be classified, not silently discarded or universally treated as errors.
- Hash `SHA-256(UTF-8(JCS(document)))`, where JCS is [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785). Sort file
  entries by their UTF-8 path bytes before canonicalization. Hashes are lowercase 64-character hex. Reject duplicate
  JSON keys, non-finite numbers and values outside the chosen schema before hashing. Schema fields below are illustrative
  wire names; compatibility changes require a new version, not reinterpretation of an old digest.
- `toolchain_digest`, `runtime_digest` and `policy_digest` identify the exact immutable toolchain release, worker
  runtime/image and gate policy. The coordinator records the signer and checks an allowlisted trusted identity; a path,
  version label or client assertion alone does not identify trusted executable code. Runtime identity must be attested
  for the actual launched image/binary, not its mutable tag. The current daemon does not provide that attestation;
  matching cached outputs cannot substitute for it. A valid signature identifies an approved artifact, not correctness
  or protection from an administrator.
- Manifest v1 must specify regular-file mode and the executable bit, case/Unicode normalization and numeric limits
  before it is implemented. Reject hardlinks and unsupported metadata/dependencies explicitly; never silently rewrite
  semantics during import. Until a precise cross-platform normalization rule is approved, reject ambiguous paths.
- Existing `iot-lab` includes hundreds of KiCad library symlinks. The import design must either represent safe links
  explicitly or transform only links resolved entirely within the import root into immutable regular-file copies. A
  transform must record both link path/text and resolved target/hash in an import receipt, reject loops and escapes,
  check normalization/case collisions, and verify that KiCad dependency semantics are preserved. Runtime execution
  must not follow arbitrary links from an untrusted checkout. The choice and exact semantics remain under review; a
  blanket link ban would not import the current project intact.

## Job submission and execution

An authenticated principal submits an idempotent job request containing at least:

```json
{
  "schema": "pcb.job-request.v1",
  "request_id": "client-generated-unique-id",
  "project_id": "opaque-project-id",
  "board_id": "canonical-board-id",
  "alias_revision": 3,
  "source_revision": 42,
  "source_manifest_sha256": "64-lowercase-hex",
  "operation": "route",
  "toolchain_digest": "64-lowercase-hex",
  "runtime_digest": "64-lowercase-hex",
  "policy_digest": "64-lowercase-hex",
  "limits": { "run_seconds": 600, "queue_seconds": 3600 }
}
```

The coordinator authenticates and authorizes the principal, resolves the alias, confirms source revision and manifest,
then grants a board-scoped lease with a monotonic generation and a secret token. It durably records the job and lease
before dispatch. A worker gets only a job-specific capability and a read-only immutable snapshot, plus a private
candidate/output directory. It cannot mutate canonical data or mint a verification result. Queue and execution
budgets, event cursors, cancellation and disconnect state are durable. A client cannot extend its authority by choosing
another worker, filesystem path, source hash or operation. The worker sandbox must specify network access, credentials,
CPU/memory/disk/process budgets and cleanup; worker capabilities cannot be reused for another job or for commit.
This v1 job contract covers board mutation operations only. Read-only checks and non-board/supervised observations
need separate versioned request variants rather than a fabricated board revision.

## Verification

The coordinator invokes a trusted verifier, or authenticates a separately provisioned verifier identity over a channel
with job-scoped authorization. It never accepts a worker/client success flag as proof. The verifier runs the required
fresh gate and produces a `pcb.verification.v1` receipt binding:

```json
{
  "schema": "pcb.verification.v1",
  "verification_id": "coordinator-issued-id",
  "job_id": "durable-job-id",
  "attempt_id": "coordinator-issued-attempt-id",
  "project_id": "opaque-project-id",
  "board_id": "canonical-board-id",
  "alias_revision": 3,
  "lease_generation": 17,
  "source_revision": 42,
  "source_manifest_sha256": "64-lowercase-hex",
  "candidate_manifest_sha256": "64-lowercase-hex",
  "toolchain_digest": "64-lowercase-hex",
  "runtime_digest": "64-lowercase-hex",
  "policy_digest": "64-lowercase-hex",
  "evidence_manifest_sha256": "64-lowercase-hex",
  "verifier_identity": "trusted-verifier-id",
  "checks": [{ "id": "required-check-id", "outcome": "passed", "evidence_manifest_sha256": "64-lowercase-hex" }],
  "schematic_parity": "passed",
  "worker_cleanup": "confirmed",
  "cancellation": "not_cancelled",
  "outcome": "passed"
}
```

Evidence is immutable, content-addressed and reachable by the coordinator. Its manifest identifies the actual gate
outputs, exit status, source and candidate input coverage, and required policy checks. The verifier's authenticated
identity and the receipt's issuance are recorded server-side; a hash or an unsigned JSON file supplied by a client
is not verifier authority. The coordinator owns the verifier record and issues/revokes its authority; v1 does not
accept a client-created receipt. A later remote-verifier protocol must define signed, domain-separated payloads and
key IDs explicitly before it is accepted. Receipts have coordinator-enforced freshness and revocation semantics, and
all evidence, cleanup and cancellation state bind to the same job attempt. The receipt enumerates every required check/rule as `passed`, `failed`, `unsupported`,
`skipped` or `incomplete`. Success requires a complete fresh native/configured gate, schematic parity and confirmed
worker cleanup; process exit zero alone is insufficient. IDs must be unique and exactly cover the required policy set;
missing, duplicate, unsupported, skipped or incomplete required checks cannot pass. Schematic parity may be
`not_applicable` only when the versioned policy explicitly permits it. Evidence references identify immutable,
bounded blobs/manifests from the same attempt. Source/candidate bytes, transitive schematic/library/rule
inputs and exact evidence bytes must bind to the same execution. The existing owned-stage broker, snapshot and `pcb-evidence` mechanisms can be reused as
components only after their contracts are mapped to these requirements. The Rust transaction prototype is not wired
and does not establish this guarantee.

## Canonical commit

A principal with commit permission submits `pcb.commit-request.v1` with an idempotency key, job/attempt/verification IDs,
project/board/alias revision, source revision, candidate manifest digest and the lease generation/token. The
coordinator verifies authorization, the current canonical alias target, trusted receipt and complete immutable
candidate/evidence before entering its authoritative transaction. In that transaction it checks the pinned lease and
expected source revision, current policy and alias revisions, receipt revocation and freshness, cancellation state,
stores the full new project revision and audit record, and records the idempotent result.
Only then is the commit `COMMITTED`. A repeated key with identical request content returns the same result; a repeated
key with different content is rejected. Expired, superseded, mismatched or unpinned leases and changed source revisions
cannot commit. The commit updates the protected store; a separately requested export may create a user-editable copy
but cannot silently overwrite one.

The journal has at least `PREPARED`, `COMMITTED`, `REJECTED` and `UNKNOWN` states. A timeout or crash is not evidence
of failure: clients query by idempotency key. The coordinator reconciles durable transaction records and protected
bytes before returning `COMMITTED` or `REJECTED`; while evidence is incomplete, it returns `UNKNOWN` and does not allow
an unsafe retry or release a pin whose writer may still be active. Administrators can recover only through an audited
procedure that proves the writer has stopped. A remote job finishing is not a passed board gate or adoption.

Before database references can commit, content-addressed blobs and their containing directories must be durably
written and fsynced. Garbage collection protects in-flight uploads/manifests, pinned jobs and verifier receipts; quota,
disk-full and crash handling must leave either the old revision or a recoverable journal state, never a dangling
canonical reference. Idempotency results survive restart, and an `UNKNOWN` mutation is not automatically retried.
For quota accounting, the proposed store reserves bytes durably before accepting an upload and marks it ready only
after the verified blob and directory entry are durable. A crash may leave a counted pending reservation; recovery
must prove the uploader has stopped before reclaiming it. This favors an explicit, recoverable hold over silently
exceeding quota or deleting a concurrent upload.
Lease tokens must not be recorded in logs or stored in durable idempotency records; any request fingerprint used for
deduplication must be derived without persisting the token itself.

All IDs, numeric fields, sizes and limits require runtime schema validation. Nonnegative numeric values must be safe
integers and satisfy server-side versioned policy bounds; TypeScript types alone are not validation.

## Migration and compatibility

Import is a separate authorized, idempotent operation: compare a fully enumerated local working copy against an explicit
manifest, identify its source and divergent copies, then create an initial protected project revision without changing
or deleting the original worktree. Choose the source explicitly when hashes differ. Pin each project to a compatible
signed release and record migration/rollback state. Until a project has migrated, show its data as a working copy and
its legacy direct writers as unprotected; do not label it canonical. Direct filesystem edits cannot change protected
canonical state. Ordinary OS users cannot change service-owned data or release directories; administrators/root can.
