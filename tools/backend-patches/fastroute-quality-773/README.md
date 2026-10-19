# Fastroute quality frontier — CIP 773

Experimental, reviewable backend patch; the production binary is unchanged.
Apply only to upstream https://github.com/parisxmas/fastroute commit
`e5d52c4544795422b8b28077acc0605fdf11265a` (0.1.7). The patch and modified
upstream code remain GPL-3.0-or-later; the unmodified upstream license is
`LICENSE.upstream`. Retain source, patch and build provenance with distributed
binaries. This does not change IoT-Lab's unrelated file licensing.

The opt-in `--quality-first` flag records the prepared DSN's initial clearance
identity set before importing an initial SES. A candidate may remove existing
identities but cannot introduce another, even at the same count. Identity uses
actual tile geometry, net names/subnets, item type and pin component/index,
layer, clearance class, required/actual clearance and intersection. Generated
item IDs, arena keys and transient caches do not define identity. Exact geometry
changes can conservatively reject an otherwise equivalent inherited fault;
this rejection remains visible and is not a waiver of native rules.

The same frontier guards multistart candidates, checkpoints, routing/history
restores, optimizer incumbents/greedy winners and final output. An initial
feasible fallback is checkpointed before routing. Among eligible candidates,
distinct clearance identity count precedes opens, stage and score. A retained
best candidate is isolated from later mutations. The normal engine continues routing from that
frontier after a rejected pass. This changes search behavior and may leave more
opens; it does not guarantee completion or improve routing speed.

The guard, checkpoint callback and multistart comparison use the same admitted
distinct-identity key. Raw duplicate reports remain visible in statistics and
the checkpoint log; they cannot discard improved connectivity when the actual
fault identity set is unchanged. Geometry regressions use real unrouted pins to
check duplicate-report ranking, same-count new-fault rejection and the priority
of removing an existing fault. A captured-DSN zero-connection probe confirms
that the stored and restored board retain an accepted enhancement. This is
software verification; a new binary still needs its own native artifact QA.
Historical build-provenance artifacts below do not certify the updated source.

Pre-routing enhancements are also transactional against that original frontier.
After accepting an initial SES, the CLI clones its whole board, applies the
existing via-class/contact flags and trace-end bridges, and restores the whole
accepted input if an enhancement introduces a new clearance identity. The clone
retains item geometry, rules, undo history, search trees and feature flags. This
transaction runs before an autoroute engine exists; a live engine is rejected
because its transient state is intentionally absent from a board clone.
The original frontier is never promoted to include an unsafe bridge.

When the existing pristine single-endpoint probe identifies a blocked endpoint,
the engine immediately emits one `BLOCKED_ENDPOINT` INFO record. Its owned
snapshot names the original component/pad, nets/subnets, layers, DSN center and
bounds with unit/resolution, pristine revision and diagnostic item ID. Probe
state/details and failure count are recorded without another route attempt.
The wrapper retains this log even when its deadline prevents final reporting;
its run manifest binds the loaded DSN hash. No baseline promotion, hash dependency,
or extra final-report diagnosis is needed to preserve this evidence.

Trace connectivity also recognizes an exact integer endpoint on the bounded
centerline of another same-net, same-layer trace. Forward and reverse graph
contacts agree, and a contact point is returned only when it is unique. Contact
queries preserve retained trace geometry, IDs, fixed state and multiplicity;
they never split fixed source copper. Rational contact points remain unsupported.
Reverse queries use indexed overlapping tiles; their performance on dense, long
polylines is unmeasured, so no speed improvement is claimed.

Five `trace_tjunction` regressions cover symmetric contacts, negative geometry,
ambiguous junctions and cache invalidation after insert/remove. One instrumented
attempt on the captured FIELD DSN resolved its connection through insertion,
optimization and tail cleanup, preserving all 83 imported traces exactly.
This diagnostic is not a native-accepted route or training label. Native
artifact verification remains pending. Existing build-provenance artifacts
predate this extension; a new artifact must bind the complete updated patch,
exact upstream source, build and its own validation evidence.

## Repeatable isolated build

Start a new upstream checkout and verify its exact commit before applying:

```sh
git clone https://github.com/parisxmas/fastroute.git /tmp/fastroute-quality-source
git -C /tmp/fastroute-quality-source checkout --detach e5d52c4544795422b8b28077acc0605fdf11265a
git -C /tmp/fastroute-quality-source apply --check "$PWD/quality-first.patch"
git -C /tmp/fastroute-quality-source apply "$PWD/quality-first.patch"
cd /tmp/fastroute-quality-source
CARGO_BUILD_JOBS=2 cargo test --locked -p fr-engine pipeline::quality --lib
CARGO_BUILD_JOBS=2 cargo test --locked -p fr-engine --test quality_identity
CARGO_BUILD_JOBS=2 cargo test --locked -p fr-engine --test trace_tjunction -- --test-threads=1
CARGO_BUILD_JOBS=2 cargo build --locked -p fastroute
```

Use Rust/Cargo 1.93.1 and preserve the original `Cargo.lock` SHA256
`4761175c5d8df0ed4c2c69036df2686dc7e3a186cd085d2ae766936134cab9a6`.
The initial Linux validation used the existing Rust container digest
`sha256:ecbe59a8408895edd02d9ef422504b8501dd9fa1526de27a45b73406d734d659`,
two CPUs, 4 GiB, two Cargo jobs and external 120-second limits. Its Linux
executable cannot substitute for a native macOS executable. An isolated native
build uses its own toolchain/cache/target, two admitted CPUs and an external
300-second initial compile budget. Preserve a running handle across observation
timeouts; do not restart it or compare compile time to routing time.

Before invoking a candidate binary, verify its checksum against retained build
provenance and check that `--help` declares `--quality-first`; then always supply
that flag. An expected quality backend must fail closed rather than fall back
to an unpatched binary. The wrapper's independent native DRC, schematic parity,
exact pose/pad identities and excluded-copper guards remain authoritative.
Capability text alone is not proof of the expected source or artifact.

## Bounded evidence and remaining adoption gates

Two policy unit tests establish electrical quality ahead of opens/score and
same-count identity replacement rejection. Real engine geometry tests cover
regenerated item IDs, changed-gap/net counterexamples, unsafe checkpoint
suppression and retained clone isolation. `quality_probe` loads an actual DSN,
measures fresh frontier checks and tests safe-session acceptance without routing.
The retained BASE-B SES is rejected before routing: it imported 1,141 wires and
305 vias with zero parse errors, but introduced a detected clearance identity.
Original DSN/SES digests are retained in the associated report/provenance.

The private arm64 artifact's checksum and safe/unsafe session digests are bound
in `build-provenance.json`. The actual artifact rejected the unsafe session
without output and accepted original fixed wiring without routing. Independent
KiCad refill/parity found no errors or parity differences, 302 unchanged opens,
exact immutable copper/parts/setup/zone nodes and poses/pads, and 29 unchanged
project sidecars. This is artifact QA; the pre-route fixture is not a qualified
board. The earlier routed candidate still has 13 native opens and a new J2 fault.

The subsequent bounded routing trial timed out with a retained checkpoint:
independent KiCad found zero errors/parity differences and 11 opens. Replaying
that safe SES exposed a new clearance identity introduced by the trace-end
bridge itself. The updated production CLI rejects only that enhancement and
retains the exact checkpoint copper geometry. Its no-routing QA again found
zero native errors/parity differences and 11 opens, unchanged poses, original
copper, parts, setup, zone policy and all 29 project sidecars. The previous
artifact/proofs remain recorded separately in build provenance.

Whole-board rollback restores the disabled overlap-contact flag too: the
updated CLI reports 21 engine opens (6 ignored), versus 17 (3 ignored) with
overlap contacts enabled in the diagnostic model. Native connectivity and
checkpoint copper remain identical; these engine counts cannot substitute for
native opens. Actual geometry fixtures prove both unsafe whole-board rollback
and safe retained bridge copper, including merged traces; 85 library and six
geometry tests passed with no ignored tests on the isolated native toolchain.
Two additional endpoint tests prove exact pin attribution, control-character
escaping, immutable snapshots after candidate mutation, and non-pin geometry
fallback. The updated run passes 85 library and eight integration tests with
no ignored tests. A bounded single U15.5 probe checks the actual frozen DSN
endpoint record; it is distinct from a full routing run.

An explicitly bound wrapper requires this flag and artifact; legacy invocation
remains explicitly unverified. Production binary replacement has not occurred.
The identified selection fix permits a separately authorized bounded routing
correctness trial after integration checks. Controlled comparable routing
evidence is still required before claiming a speed improvement or adoption.
The prior 72-second interrupted compile's original cause remains unknown;
the instrumented cached build completed without signals or cleanup errors.
