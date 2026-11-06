# Long run versus packed sprints (#1318, #1358)

Follow-up: the [ESP32-CORE rev B comparison (#1399)](2026-11-06-esp32-sprints.md) uses the repaired pinned solver, eight GiB and a calibrated budget. Both matched singles qualify for that benchmark; neither sprint does. Its full gates still fail, and its feedback-policy and shared-host limitations remain explicit. The historical measurements below are unchanged.

## Decision after the three-board extension

**The no-go for adding LLM scheduling/ranking holds on this evidence.** FIELD-24V-BUS adds another fully verified comparison with no quality improvement from sprints and greater whole-job CPU. ESP32-CORE rev B produces no verified candidate within either tested budget, so its quality comparison is inconclusive. The matched comparisons use pinned toolchain `696715d`. A subsequent [current-main single calibration](#current-main-esp32-calibration-1374) also did not verify and therefore stopped before any sprint comparison. There is no statistical or general large-board claim. See the [extension results](#three-board-extension-1358).

## Original ENV-SENSE decision

**No-go for adding LLM scheduling/ranking on this evidence.** Keep the sprint
runner opt-in. On the eligible ENV-SENSE fixture, the existing single run reaches
the same fully verified board sooner and with less actual job CPU at the same
2-CPU/120-second ceiling. The portfolio has no verified quality improvement.
This is a bounded engineering decision, not a general claim about all boards or
all portfolio policies.

The original #1318 brief narrowed the older three-board task body to at most two small
active boards on Hetzner, ENV-SENSE plus a smaller eligible board. At that time,
`iot-lab` main `aa14d14ce1f728c558c988bd978fbcb60d4f391c` had no such smaller board:

| Active option | Footprints | Decision |
| --- | ---: | --- |
| ENV-SENSE | 23 | Frozen benchmark fixture |
| FIELD-24V-BUS B | 34 | Larger than ENV; outside the smaller-board brief |
| CELLULAR-B | 104 | Larger than ENV |
| BASE-PWR revisions | 139-211 | Explicitly excluded from this work |

NET-CORE and planned boards were not substituted. That original scope left a one-board
experiment. The extension below adds the two subsequently authorized fixtures;
neither experiment provides statistical generalization.

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

## Three-board extension (#1358)

The user expanded the scope to exactly three frozen boards total. The existing ENV-SENSE data above is retained unchanged. New trials cover FIELD-24V-BUS B (34 footprints, two copper layers) and the explicitly requested historical ESP32-CORE B at `a545d5e1` (78 footprint records, four copper layers). The initial brief said 84; the frozen file has 78. Current ESP32 revision C was not substituted. Fixture commits and full hashes are preregistered in [the protocol](2026-11-05-sprint-benchmark-protocol.md#preregistered-extension-1358-2026-11-05-1943-utc).

Protocol commit `923a25e` precedes these runs. The exact original Linux binary, Node runtime, image, and all 212 bound router source files were reused. The harness gains a board argument; solver and acceptance rules do not change. All real-board trials ran sequentially through the existing Hetzner-local daemon, **not in CI**. Normal PR syntax/type/unit verification is separate. No canonical CAD or production runtime was changed.

### FIELD-24V-BUS B

| Trial | Job ID | CPUs / limit | Status | First verified s | Job wall s | CPU s | Client s |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| single-cold-v2 | `20261105-194805-0328a4` | 2 / 120s | PASS | 43.363 | 43.363 | 68.495 | 60.114 |
| sprint-cold | `20261105-194951-813b09` | 2 / 120s | PASS | 43.348 | 102.272 | 190.566 | 118.137 |
| sprint-warm | `20261105-195149-add659` | 2 / 120s | PASS | 54.862 | 99.642 | 187.856 | 112.269 |
| single-warm | `20261105-195341-ebd01f` | 2 / 120s | PASS | 47.745 | 47.745 | 76.708 | 61.873 |
| single-equal-cpu | `20261105-195442-06e01f` | 1 / 240s | PASS | 77.356 | 77.356 | 74.828 | 89.881 |

All five clean trials pass native DRC, connectivity and schematic parity, plus the board's fresh configured gate. Every selected output has the same hash, `cb6e5c1c15f1533539e852efb8a7153b9beed84f079d14277e7aca2adb59c2ed`: 319.7 mm of track and two vias. Each sprint verifies two candidates. In the cold-labeled trial, another variant fails verification and the fourth is stopped at the budget. In the warm trial, one additional variant is stopped and the fourth never starts. All of these states remain in the evidence.

At two CPUs the descriptive median time to first verification is **45.554 s single versus 49.105 s sprint**. Median whole-operation CPU is **72.602 versus 189.211 s**, about 2.61 times as much for the portfolio, with no selected quality gain. The first cold-labeled pair differs by only 0.014 s, and the single clock includes final cleanup; this is not evidence of a meaningful sprint timing win. Two repetitions per mode are not a statistical claim.

The one-CPU single run verifies in 77.356 s with 74.828 actual CPU-seconds. The two-CPU portfolio can reach its first accepted candidate sooner under the same reserved 240 CPU-second ceiling, but the two-CPU single run already reaches acceptance as soon or sooner with much less whole-job CPU. CPU at the instant of first verification was not sampled; do not infer it from the whole-job number.

### ESP32-CORE B

| Trial | Job ID | CPUs / limit | Status | First verified s | Job wall s | CPU s | Client s |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| single-cold | `20261105-195616-08147d` | 2 / 120s | ERROR | N/A | 117.317 | 131.671 | 133.834 |
| sprint-cold | `20261105-195832-945e60` | 2 / 120s | ERROR | N/A | 112.352 | 198.780 | 132.192 |
| sprint-warm | `20261105-200040-fa1c7d` | 2 / 120s | ERROR | N/A | 112.242 | 199.693 | 126.216 |
| single-warm | `20261105-200250-2182cf` | 2 / 120s | ERROR | N/A | 117.321 | 130.630 | 135.484 |
| single-equal-cpu | `20261105-200505-0c5c50` | 1 / 240s | ERROR | N/A | 237.247 | 235.401 | 256.113 |

**Zero of five trials produces a fully verified candidate.** Single runs are stopped by the parent budget (native exit -15); both sprint reports end with reason `deadline` and no accepted candidates. The first sprint retains variants at passes 3/4/2/2; the repeat retains two stopped and two yielded variants at pass 2. These are partial search records, not accepted route quality. Native logs and every variant's output/checkpoint remain available. This does not show that the board cannot be routed, nor establish a single-versus-sprint quality winner on the larger fixture. Longer budgets or newer solver revisions were not substituted.

### Overhead, exclusions, and audit

The first FIELD submission `single-cold` (`20261105-194615-4b4a01`) actually completed PASS at 45.370 s and 71.251 CPU-seconds, but is excluded from comparison: macOS archive metadata added AppleDouble source files (9,390 staged files). Its raw successful record is retained, not relabeled a routing failure. Generated metadata was removed only from the isolated copies and the exact 212-file core binding was rechecked with no extras before the clean `single-cold-v2` trial. No source semantics or gate threshold changed.

All clean FIELD submissions report 4,125 cached files, zero missing and zero uploaded KB. The first ESP32 submission reports 3,677 files, 131 misses and 41,150 KB; its repeats upload zero. The shared cache was never cleared. The labels identify order, not globally cold-cache measurements; the excluded attempt warmed FIELD's cache. Client-minus-operation overhead, queue intervals, container intervals and raw cgroup counters are retained in the JSON. This combined overhead must not be called pure transfer time.

An independent final audit rehashed every accepted board, native result, gate result and sprint verification receipt; confirmed fresh gate exit 0 without source changes; checked owned child cleanup; and independently found **all 11 new-trial containers absent** (ten clean trials plus the excluded setup case). Frozen source PCB hashes remain unchanged. Failed trials have null first-verified time and no accepted quality.

The appended `extension_1358` in [the machine-readable report](2026-11-05-sprint-benchmark.json) preserves all trial outcomes, failed portfolios and exclusions. Full raw evidence and the complete frozen project/runtime closure are retained under the session's durable `artifacts/benchmark-1358/` directory, with gzip integrity checked:

| Archive | SHA-256 |
| --- | --- |
| `benchmark-1358-evidence.tar.gz` | `0540aa93c6350269de5eadbacd0609035f72379ab6d485df39a20d400cec23b6` |
| `benchmark-1358-fixtures-runtime.tar.gz` | `20fc64aabae3b2a159e278a556d7447dcf60d8f44262c93575db2d440fe3e705` |

Validation: strict TypeScript and JavaScript syntax checks pass. Analyzer fixtures check board-specific paths, null verification time on failure, and retention of failed portfolio progress without a native accepted result. The benchmark itself ran only on Hetzner. The conclusion remains a no-go for additional LLM scheduling on the measured evidence, with the larger-board comparison explicitly inconclusive.

## Current-main ESP32 calibration (#1374)

The follow-up pins main at `0ade1efd0be020424ee8d21b91e4340bb2ae176d`, including the plane-hole and GND reuse fixes. It reuses the exact historical ESP32-CORE B board, rules, locked USB pair policy, Node runtime and image. The newly built Linux router is `6a22f3f5f38766d54d63a326e1acbe4c10373c8a2742a5babc2b56165d6de869`; all 212 source files were checked against the pinned tree. Protocol commit `0403f6f` precedes this single calibration.

The calibration keeps seed 0, 80 passes, two CPUs and four GiB, while omitting both the old experiment timer and native `--max-time`. The daemon's existing 21,600-second maximum is only an operational ceiling. The run terminates naturally; it does not hit that ceiling or a 120/240-second timer.

| Measurement | Observed value |
| --- | --- |
| Job | `20261105-205510-d1a805` |
| Operation wall / actual CPU | 236.246 s / 268.081 CPU-s |
| Client wall | 251.194 s |
| Core | 17 passes, 194.1 s, FAIL with three failed nets |
| Native write | 0 DRC errors, 4 unconnected items, 0 schematic-parity errors |
| Final operation | ERROR, native exit 2 |
| First fully verified / shared comparison budget | unavailable / not selected |
| Comparison trials / retries | 0 / 0 |

There are two separate failure findings. The routed board already fails native connectivity. Then the reference-planes check cannot produce a result because required driver evidence `hardware-design/registry/datasheets/FM25V02A-GTR_C66029.pdf` is absent from the historical fixture. The current table expects SHA-256 `3993f988368aa8dc94b79a888234274959b7e4e091c693535530f3f4dddafefd`; that path does not exist in the frozen `a545d5e1` tree. The full fresh configured gate is never reached. Root result counts are null because of this error; the 0/4/0 counts above are specifically the native write's actual DRC report. No evidence file was invented and no rule was disabled.

| Net | Preserved finding |
| --- | --- |
| `/IO2` | Router's fixed-copper reachability test fails at J2.26 (129.65, 145.45); native DRC reports J2.26 to U1.27 open |
| `/IO3` | Same test fails at J2.27 (127.11, 142.91); native DRC reports J2.27 to U1.26 open |
| `GND` | Router finds no sampled via site within 3 mm of U4.2 (161.00, 122.15); native DRC also reports disconnected GND zone islands |
| `VDD_3V3` | Native DRC reports U1.2 to C2.1 open; this is additional to the core's three failed-net list |

These are scoped model/search and native-output findings, not proofs of physical impossibility. The router's sample radius is a search limit, not a new electrical requirement. The search eliminated its reported routing conflicts, but that did not establish connectivity after write/refill.

For the requested stuck report, a separate postmortem directory holds copies of the actual native `write/drc.json` and model. Running the existing `iotroute stuck` on those records performs no routing. It reports four unconnected items but, without triage data, an empty named-net list and the misleading text “0 nets open.” That limitation was handed to the existing stuck-report task. The raw DRC endpoints and core failure records above remain the evidence; empty diagnostic rows are not a clean result.

**Stop decision:** the single calibration did not verify, so no shared comparison budget was derived, no sprint trials were launched, and no budget was increased. The incomplete verification input and native connectivity failures prevent a valid current-main time-to-verification baseline. There is no new evidence to change the LLM no-go; the larger-board relative-performance question remains unmeasured.

The job ended after one attempt, owned child cleanup is complete, its container is independently absent, and the frozen PCB hash is unchanged. The measurement harness now supports the finite-work `measure 0 ESP32-CORE` mode and reports its experiment deadline as null, separately from the daemon safety ceiling. Existing timed runs retain their verification reserve. No solver, gate, canonical board or production-runtime changes are included.

The JSON's `calibration_1374` retains timing, native and write outcomes, all four DRC connection records, the missing-evidence requirement, diagnostic limitation and zero comparison count. Raw evidence and the complete frozen fixture/runtime are preserved under durable `artifacts/benchmark-1374/`, with gzip integrity and hashes checked:

| Archive | SHA-256 |
| --- | --- |
| `benchmark-1374-evidence.tar.gz` | `a2b048faa8677d735113ef36e68d90e84d62b3d1308d62c5053522dd6517421d` |
| `benchmark-1374-fixture-runtime.tar.gz` | `bd1cd297ed2944d5fbdfda9c7757f74f48e9b497fe176c825f5807c25ab6133e` |
