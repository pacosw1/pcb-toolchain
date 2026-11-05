# PCB system: integrated architecture and migration plan

Status: proposed direction, not an implemented security guarantee. This plan joins PCB Studio, the `pcb` CLI,
the coordinator, execution workers, and the project's boards into one system. Review it with the other active
repo agent before moving existing projects or changing OS ownership. The user requests no new or modified Python.
The ongoing removal of first-party Python is tracked in task 1332; task 1331 owns the Rust board reader. Job-side
components should use Rust where the job image has no Node, with TypeScript for Mac-side CLI/orchestration. The
third-party kicad-happy dependency is outside that port's scope.

The shared draft API and verification boundary is [SYSTEM-CONTRACT-v1.md](SYSTEM-CONTRACT-v1.md).

## Desired workflow

```text
                  authenticated, versioned API
  Studio / CLI  ------------------------------->  Coordinator
  view + intent                                   identity + authorization
       |                                          jobs + leases + revisions
       |                                                    |
       |                                              controlled commits
       |                                                    v
       +------------ live events <--------------- protected project store
                                                          |
                                                   immutable input snapshot
                                                          v
                                              worker / router / gate
                                              isolated candidate + evidence
```

1. A user chooses a project and a board in Studio or the CLI. Both clients call the same coordinator API.
2. The coordinator resolves a stable project/board identity, checks the caller and permissions, grants one fenced
   board lease, and creates a durable run against a specific immutable source revision.
3. A worker receives a bounded job and a read-only snapshot. Its tools may create candidates and publish progress,
   logs and previews; they do not write the protected canonical project.
4. The system verifies the candidate and its source/evidence against the required gate. An authenticated API commit
   checks the lease and expected revision at the authoritative store, atomically publishes the approved result, and
   records the actor, hashes, evidence and new revision. A stale worker cannot commit. Commit requests are idempotent;
   a durable journal records transitions and an uncertain mutation remains `UNKNOWN` until recovery proves its outcome.
5. Studio and CLI follow the same durable event stream, resume from a cursor after disconnect, and distinguish live
   previews, unverified candidates, approved canonical versions and disconnected workers.

## Ownership and trust boundaries

- The authoritative project store is service-owned, outside writable user checkouts. It must cover the complete
  gate-relevant project inputs, not only `.kicad_pcb`: schematics, project and rule files, libraries, source hashes,
  model references and declared dependencies. Manifests use safe relative paths, content hashes, atomic versions and
  explicit retention. Normal local worktrees are editable working copies, never authoritative merely because a watcher
  saw them.
- Resolve board aliases to the same canonical target before acquiring a lease or selecting a version. Bind verified
  evidence to the complete source and candidate manifests, toolchain/runtime identity and policy, not just a board hash.
- A dedicated service identity owns mutable protected data. Studio, CLI, agents and job containers use separate
  credentials and least-privilege API roles: view, submit, cancel and commit are distinct capabilities. A worker must
  not receive an unrestricted coordinator/admin token. Neither a shared bearer token nor a client-supplied claim that
  a gate passed is sufficient proof of authorization or verification.
- The toolkit and Studio release trees are owned by an OS-protected installation/update service, readable and executable
  by users but not writable by ordinary client processes. Updates go through a narrowly scoped API that verifies a
  trusted release signature, target path and manifest before an atomic switch; it must not execute client-supplied
  code as root. Rollback and a record of the active version are required. The current per-user read-only directories
  do not meet this boundary because their owner can change their permissions.
- Authentication between hosts uses per-host identities over the private network. Authorization must be enforced at
  the coordinator/API, not inferred from Tailscale membership or a UI button. Audit events identify the actor, host,
  operation, source revision, approval/evidence and outcome without logging secrets.
- A local administrator or root can override the OS boundary. This design protects against ordinary clients and
  accidental or unauthorized direct changes; it cannot make an administrator unable to change their own machine.
- On macOS a system helper/service requires administrator approval. See Apple's
  [Service Management documentation](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos).
  Prepare and validate its installation and rollback before asking for OS authentication; do not request passwords in chat.

## Current state and gaps

- The deployed coordinator owns a lease/revision SQLite store and durable live events. Guarded CLI adoption verifies
  locally, writes the checkout, then publishes the resulting board bytes to that store. It is not yet an API-only
  authoritative commit. The store does not independently verify client-supplied gate evidence and currently covers
  board bytes rather than a complete project revision.
- Studio and observers can show live boards, routing frames, activity, 3D snapshots and recorded placement frames.
  Existing placement epoch poses become available after each search; true in-search poses are not currently exposed
  by the existing optimizer. Direct scripts and KiCad edits can bypass the shared lease. Observed direct writers are
  a best-effort signal, not fencing.
- Releases and installed Studio apps on both Macs are owned by the logged-in user. Their existing project worktrees
  include independent changes and must not be reset, replaced or silently made inaccessible.
- Older pinned toolchains retain their behavior and may lack new preview/binding support. A new system must give an
  explicit compatibility and migration path rather than quietly substituting a different toolchain.

## Implementation sequence

1. **Agree on the contract.** Coordinate with the other active repo agent on APIs, trust boundaries, the current
   task/branch overlap, version/signature policy and migration. Record the final decisions and owners. Keep this plan
   explicitly proposed until that discussion is reflected here.
2. **Protected canonical store.** Add authenticated reads and immutable version history, then a project manifest
   store with safe paths, complete input coverage, version compare-and-swap and actor audit. Establish an authoritative
   server-side verification contract; do not treat arbitrary client-reported success as a verified candidate.
3. **Single workflow API.** Route Studio and CLI actions through the same service for project selection, submission,
   status, cancellation, previews, verification and commit. Workers receive scoped capabilities tied to a job and
   fenced source revision. Durable jobs and event cursors survive host/coordinator restarts.
4. **Controlled execution and writes.** Run tooling against isolated working snapshots. Commit only approved files
   through the coordinator's authoritative transaction. Direct edits to old checkouts are imports or drafts, not
   canonical writes. Define explicit conflict resolution for diverged work and board/alias identity.
5. **Protected software installation.** Build the signed, constrained update helper and OS-owned directories for both
   Macs and the Linux host; separate normal runtime privileges from installation/update privileges. Provide recovery,
   rollback and a clear administrator-authentication handoff. Do not change ownership of existing project trees.
6. **Migrate deliberately.** Inventory active jobs, project revisions, dirty files and dependencies. Import a chosen
   project as an initial protected revision only after checking its exact bytes and identity. Preserve old worktrees,
   allow compare/export, and switch clients per project with a reversible migration record.
7. **Live experience.** Publish real placement and routing progress and recorded frames from the actual toolchain;
   do not fabricate motion or private reasoning. A non-Python producer for true in-search placement positions is
   still needed. Make remote workers continue publishing when the originating client is unavailable.
8. **Rollout and proof.** Use a small isolated project first, then the actual project. Prove that ordinary users and
   workers cannot write the protected directories directly, API writes enforce roles and fencing, stale/duplicate
   commits fail, verified adoption is atomic, and restart/reconnect preserves the job and revision. Check deployed
   versions on all three machines and preserve rollback before migrating real project data.

## Repo-agent review

The active Codex agent on task 1332 reviewed this direction (CIP message 351). They recommend reusing the existing
owned-stage broker, isolated snapshots, `pcb-evidence` receipts and fresh native gate as components while keeping the
verifier and canonical write authority server-owned. Those components are not themselves an OS security boundary. The
experimental Rust target-lock/journal is unwired, has Linux-only metadata limitations and does not yet guarantee shared
legacy-lock coordination or verification. Dirty worktrees must be explicit imports. Signed software updates and the
protected project store should remain separate privilege boundaries. The plan remains proposed until the API,
ownership and verifier responsibilities are agreed.

The agreed working split (CIP message 353): task 1332 owns the Rust verifier/worker and Python-removal interfaces;
this work owns the coordinator project store/API and Studio integration. The versioned contract is awaiting review;
neither side should interpret a draft as authorization to bypass the existing fail-closed adoption path.

An initial read-only inventory of currently reporting worktrees found 46 board paths, 612 observed copies and 18 paths
with differing board hashes. These are observations, not a decision about which copy is canonical; active worktrees can
change and require a fresh inventory before migration.

The verifier owner also found 506 tracked library symlinks in the current `iot-lab` main tree (CIP message 360).
Safe link representation or an explicit, verified in-root import transform is required; silently dropping those links
would break the project. The exact normalization implementation and version must match between TypeScript and Rust.

## Decisions to settle with the other agent

- Exact canonical project schema and how complete source snapshots and approved gate evidence are represented.
- Trusted verifier location and how a gate result is bound to source, candidate, toolchain and policy hashes.
- Host/user/service identities, API role model, credential issuance and trusted release-signing key custody.
- macOS helper/update mechanism and how Linux and macOS installations share one version contract.
- Per-project migration, local working-copy editing/import rules, merge/conflict handling and rollback.
- How task 1332 and its ongoing Python-removal work fit the shared plan without duplicate work or overwrites.
