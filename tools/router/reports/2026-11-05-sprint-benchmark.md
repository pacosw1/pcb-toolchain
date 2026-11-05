# Long run versus packed sprints (#1318)

## Decision

**No-go for adding LLM scheduling/ranking on this evidence.** Keep the sprint
runner opt-in. On the eligible ENV-SENSE fixture, the existing single run reaches
the same fully verified board sooner and with less actual job CPU at the same
2-CPU/120-second ceiling. The portfolio has no verified quality improvement.
This is a bounded engineering decision, not a general claim about all boards or
all portfolio policies.

The current brief narrowed the older three-board task body to at most two small
active boards on Hetzner, ENV-SENSE plus a smaller eligible board. Current
`iot-lab` main `aa14d14ce1f728c558c988bd978fbcb60d4f391c` has no such smaller board:

| Active option | Footprints | Decision |
| --- | ---: | --- |
| ENV-SENSE | 23 | Frozen benchmark fixture |
| FIELD-24V-BUS B | 34 | Larger than ENV; outside the smaller-board brief |
| CELLULAR-B | 104 | Larger than ENV |
| BASE-PWR revisions | 139-211 | Explicitly excluded from this work |

NET-CORE and planned boards were not substituted. This leaves a one-board
experiment. It does not satisfy the superseded three-board task body or provide
statistical or large-board generalization.

## Fixed protocol

See [the protocol](2026-11-05-sprint-benchmark-protocol.md), written before the
first valid submission. Toolchain sources are pinned to
`696715dd81e6143c65af7652e18c1d70499d2a8a`; the test harness is additional,
non-production instrumentation. The Rust core source binding passed with no
missing, extra, or differing source files. The single and sprint admitted models
have identical top-level values except their isolated `pcb` path.

Both modes use the same frozen board, lock policy, admission, widths, native
write/copper/native checks, **fresh** configured gate and both existing board
semantic hooks. All five jobs reserve 4 GiB and disable automatic retries.
The single mode uses seed 0, 80 iterations and a core time cap 30 seconds below
the parent limit. Sprints use seeds 0,1,2,3, via cost 3, two-pass slices, two
concurrent core processes, 80 passes per seed and a 30-second verification
reserve. Outputs are isolated; only fully verified candidates count.

Jobs run sequentially through the existing daemon and cached-input client on
Hetzner. No production image, daemon configuration, or canonical CAD was changed.
The image is the already allowed `iot-lab-route:10.0-nightly-4fe1ca2060`.

## Measurements

| Trial | Job ID | CPUs / limit | First verified s | Job wall s | CPU s | Client s |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| single-cold-v2 | `20261105-190321-d3e136` | 2 / 120s | 55.741 | 55.741 | 89.073 | 76.631 |
| sprint-cold | `20261105-190449-e2aeda` | 2 / 120s | 72.068 | 72.193 | 135.050 | 87.472 |
| sprint-warm | `20261105-190622-9590eb` | 2 / 120s | 74.463 | 77.205 | 140.386 | 92.158 |
| single-warm | `20261105-190802-bbbbbf` | 2 / 120s | 56.116 | 56.116 | 93.766 | 72.270 |
| single-equal-cpu | `20261105-190924-956a6c` | 1 / 240s | 121.256 | 121.256 | 118.771 | 138.216 |

For the two-CPU runs, descriptive medians are 55.929 seconds to verification and
91.419 CPU-seconds for single, versus 73.266 seconds and 137.718 CPU-seconds for
sprints: 31.0% longer to acceptance and 50.6% more measured CPU, with identical
accepted quality. Two runs per mode are not a statistical performance claim.

At the equal 240 CPU-second reserved ceiling, sprints at two CPUs reach acceptance
sooner than single at one CPU (72.1-74.5 versus 121.3 seconds), while consuming
more measured CPU (135.0-140.4 versus 118.8 seconds). This is a real wall-time
tradeoff in this sample. However, the existing single mode at two CPUs beats both
options and uses less CPU. The experiment therefore finds no observed benefit
from the additional seed portfolio for the same two-CPU allocation.

Each successful row has zero native DRC errors, zero unconnected items and zero
parity errors, plus a fresh configured gate and both post-verification semantic
hooks passing. Every accepted board is byte-identical:
`7c4dd481c5454a055da4b956124c984cae450a17547d81c3abe5092b31316da3`,
177 tracks, 20 vias, 262.0 mm.

The first two-CPU single run is the first observed submission in this experiment,
not a globally cold-cache run. It packs 4,449 files and uploads 79 cache misses
(9,741 KB as reported by the client). All later submissions report zero missing
files and zero upload KB. Shared cache contents were never cleared. Fresh
verification is repeated even when every source asset is cached.

For single, `First verified` is a conservative upper bound at operation completion,
including final verification-workspace cleanup. Sprint uses its explicit
successful verification event. This small clock difference favors the sprint
column rather than the faster single result.

`Client` includes source staging, cache negotiation/upload, queue wait, image
setup, the entire routing and verification operation, cleanup, and result
retrieval. The separate `Job wall` clock covers the instrumented operation.
`CPU` is the cgroup usage delta over that same operation, including every child
and verification process. Container CPU before harness entry is retained in the
raw start/end counters; client packing CPU is outside that cgroup. The raw
container attempt interval and queue time are also retained. Individual packing,
cache negotiation and result retrieval clocks were not separated, so their
combined contribution must not be called pure upload time.

The equal-wall comparison gives both modes 2 CPUs for up to 120 seconds, a
240 CPU-second reserved ceiling. The additional single run has 1 CPU for up to
240 seconds: the same reserved ceiling with a different wall allowance. These
are equal **reserved CPU budgets**, not claims of equal actual CPU consumption.
Actual consumption is measured and reported above. No unused allocation is
artificially burned to make a run last until its limit.

## What consumed the time

The two-CPU single runs spend 29.2-30.7 seconds in the complete native run,
including 8.1-10.7 seconds in the core. Their subsequent fresh gates take
19.8-20.8 seconds; schematic semantics take 4.5-5.4 seconds and PCB semantics
about 0.4 seconds. Remaining operation time includes workspace copying and
bookkeeping.

Sprints prepare once in 7.7-9.7 seconds. Seed 0 completes search at 28.0-29.5
seconds, then spends 44.1-45.0 seconds in native/gate/semantic verification while
other core work can still compete for the aggregate two CPUs. First acceptance
occurs at 72.1-74.5 seconds. These overlapping intervals are not added to estimate
CPU. The cgroup counter is authoritative for the measured job CPU window.

Both sprint trials retain all four variants. Seed 0 is the sole verified winner.
Seed 3 finishes search with a raw progress claim of 259.742 mm and 19 vias, but
never receives full verification. Its apparent improvement is not an accepted
quality result. Seeds 1 and 2 likewise remain stopped/yielded rather than verified.
The controller defers further verification because the measured verification
cost plus 20% requires 52.9-54.0 seconds, exceeding the remaining work budget.
No predictive quality pruning or gate relaxation was used.

This points to deterministic verification scheduling and contention accounting
as a more direct next investigation than adding a model to rank seeds. It does
not establish that verifying seed 3 would pass or fit the budget, and this
benchmark makes no production-policy change.

## Failures and cleanup

Two initial client invocations (`single-cold`, `single-first`) fail before job
creation because the scratch toolchain copy omits `apps/job-daemon/src/client.ts`.
The first attempt to copy that directory also lacks its parent directory. The
scratch copy is corrected from the same pinned sources, then the first measured
run uses label `single-cold-v2`. Both failed invocation logs are retained; neither
consumes a hidden routing attempt or disappears from the evidence.

All five actual jobs pass in exactly one attempt with retries set to zero.
Independent API reads confirm terminal `passed` status and `trimmed=true`; Docker
inspection confirms all five owned containers are absent. All 55 recorded owned
stages confirm complete cleanup. Unverified variants remain explicitly labeled.

The full source PCB hash is unchanged at the end of every measured operation.
No routed candidate is adopted into a canonical board and no release is deployed.

## Reproduction and evidence

The standalone helpers under `tools/router/benchmarks/` reproduce the experiment:

- `1318-job.ts`: the in-container common acceptance and measurement harness.
- `1318-submit.mjs`: cached-input submission, explicit CPU/wall/RAM/retry limits.
- `1318-collect.mjs`: independent terminal status and container cleanup checks.
- `1318-analyze.mjs`: derives the measurement summary from returned artifacts.

Prepare a scratch root named `/var/tmp/router-benchmark-1318.SUFFIX` with
`toolchain/`, `project/`, `happy/`, and `evidence/`. Use the pinned toolchain
sources, the frozen #1317 ENV-SENSE source closure and its existing semantic
hooks, and build the Linux router from those sources. Put the checksum-verified
Node runtime and router binary in `toolchain/bin/`. The submit helper reads the
existing daemon token file in place; credentials are never copied to the job or
the evidence archive. Do not replace the frozen fixture with a current live board
and still label the result a reproduction.

Run the submit helper sequentially with these `(label, mode, CPUs, seconds)`
arguments after its scratch-root argument:

| Label | Mode | CPUs | Seconds |
| --- | --- | ---: | ---: |
| single-cold-v2 | single | 2 | 120 |
| sprint-cold | sprint | 2 | 120 |
| sprint-warm | sprint | 2 | 120 |
| single-warm | single | 2 | 120 |
| single-equal-cpu | single | 1 | 240 |

Preserve failures and use new output labels rather than overwriting a trial.
The helpers require the daemon host's existing environment and Docker access.
They do not provision infrastructure or modify service configuration.

| Binding | Value |
| --- | --- |
| Frozen source PCB SHA-256 | `6abb00a0a30cd3f02d6e96a0cb326e16c1f050b735e5ed43770dcbf653844ae7` |
| Linux router SHA-256 | `71b5b44c16daf1673d31dab5b33900d8f88904ad1484204552d23460d89c69c0` |
| Node | `v22.23.2` |
| Node binary SHA-256 | `3517c2df0b2f8cd7f422b4b8450ef81c6889f08eb03e281d6de9079b15e6a327` |
| Image ID | `sha256:8c1c6d83c4050f4876f21926846e4e1d640b6be5194f448c3e239392c83a20af` |
| kicad-happy pin | `a6bba1a` |
| Original #1317 fixture archive SHA-256 | `8f48b53c8d72ed207fc9050fe27dbf1f13dfedfb2f18cb2526adfeb57052bd70` |

The compact machine-readable results are in
[`2026-11-05-sprint-benchmark.json`](2026-11-05-sprint-benchmark.json). Full native
records, fresh gate outputs, semantic logs, all per-variant artifacts, submission
logs (including setup failures), source bindings, independent job status and
cleanup checks are retained in `live-evidence-1318.tar.gz` (gzip integrity checked).
Archive SHA-256:
`8fadc96dc16aa12c7a66ff001d169f93afda037aaafab15738352bcd2f476be2`.
The archive and tested Linux binary are retained under the session durable
`artifacts/router-benchmark-1318/` directory.

Validation: the harness and three JavaScript helpers pass syntax checks; the
harness passes strict TypeScript checking with the repository's Node types.
The actual five daemon jobs provide the acceptance-path verification. No router
implementation or gate threshold changes are included in this report PR.
