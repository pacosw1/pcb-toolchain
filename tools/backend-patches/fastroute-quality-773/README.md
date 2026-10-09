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
clearance count precedes opens, stage and score. A retained best candidate is
isolated from later mutations. The normal engine continues routing from that
frontier after a rejected pass. This changes search behavior and may leave more
opens; it does not guarantee completion or improve routing speed.

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

An explicitly bound wrapper requires this flag and artifact; legacy invocation
remains explicitly unverified. Production binary replacement has not occurred.
The identified selection fix permits a separately authorized bounded routing
correctness trial after integration checks. Controlled comparable routing
evidence is still required before claiming a speed improvement or adoption.
The prior 72-second interrupted compile's original cause remains unknown;
the instrumented cached build completed without signals or cleanup errors.
