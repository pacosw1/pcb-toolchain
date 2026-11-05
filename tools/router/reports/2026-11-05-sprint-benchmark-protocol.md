# Preregistered #1318 protocol
Pinned toolchain 696715d; frozen ENV-SENSE fixture from #1317 archive, source PCB 6abb00a0a30cd3f02d6e96a0cb326e16c1f050b735e5ed43770dcbf653844ae7.
No smaller eligible active board: ENV23 footprints, FIELD34, CELLULAR104; BASE excluded, NET-CORE excluded. At most two boards; use ENV only.
Sequential daemon jobs, pinned existing nightly image, Node22.23.2, source-built Linux router, 4GiB, retries0. No canonical adoption.
Order: single-cold (2CPU120s), sprint-cold (2CPU120s), sprint-warm (2CPU120s), single-warm (2CPU120s), single-equal-cpu (1CPU240s). Labels cold mean first observed submission for this experiment, not forced eviction of the shared cache. Report actual hit/miss bytes; do not clear shared cache.
Single seed0, 80iterations, max-time wall-minus30s. Sprint seeds0,1,2,3, via cost3, slices2passes, parallelism2, 80passes each, 30s verification reserve. Same prepared-source admission, lock, native gates; both get fresh configured gate and post_verify semantic hooks. No cached candidate acceptance.
Primary equal-wall/equal-resource ceiling: 2CPU120s each, 240reserved CPU-seconds. Additional equal-reserved-CPU comparison: single1CPU240s vs sprint2CPU120s, 240reserved CPU-seconds, explicit different wall. This is not an assertion of equal actual CPU; collect cgroup CPU including all job child processes. Gate failure, timeout or unavailable measurement remains visible.
Record all attempts, status, native DRC/opens/parity, wire/vias, first verified time, preparation/slicing/verification, cgroup CPU, full client overhead, cache transfer, source/binary/runtime hashes, terminal job/container cleanup. Small descriptive experiment: no statistical generalization or speedup threshold invented.

## Preregistered extension #1358 (2026-11-05 19:43 UTC)

User scope now permits exactly three boards total: retain the existing ENV-SENSE measurements, add FIELD-24V-BUS B and ESP32-CORE B. Hard stop at three. Benchmark runs remain sequential jobs local to Hetzner, never CI. Normal syntax/type checks and PR verification are separate from these benchmark jobs.

| New fixture | Source commit | PCB SHA-256 | Footprints / copper layers |
| --- | --- | --- | --- |
| FIELD-24V-BUS B | `ee20736e250cf1146496dc7044b596b4658bec23` | `2aec6532e0c3dfc6925453c74c31f99582514169e9355352117e91ad988861a5` | 34 / 2 |
| ESP32-CORE B | `a545d5e18428e03256ea876f45864b25061c1397` | `b6b97508157893ccca5c5c2cc3e0c90d55691a42d094f9c1015ad8b7f31bdb2b` | 78 / 4 |

ESP32 uses the explicitly requested historical rev B, not current rev C. Its file contains 78 footprint records; the initial brief's 84 is not used as measured inventory. Board copies and their declared dependency closures are frozen; canonical files stay untouched.

Reuse the exact prior Linux router (`71b5b44c16daf1673d31dab5b33900d8f88904ad1484204552d23460d89c69c0`), Node v22.23.2, pinned image, and toolchain `696715d`. All 212 router source hashes match the prior source binding. Only the measurement harness gains an explicit board argument. For each new board, repeat the five trials in the same order and with the same CPU/wall/RAM/retry limits above. Gate and admission failures or timeouts count as unsuccessful trials; no rules, stages, thresholds, or frozen CAD will be changed to admit a board. Report missing measurements as unavailable, never as a verification time or a zero cost. Do not rerun failed trials under the same label.

## Current-main ESP32 calibration (#1374)

Before any new comparison, run exactly one calibration on frozen ESP32-CORE B (the same `a545d5e1` fixture and `b6b97508...` PCB hash). Pin current main at `0ade1efd0be020424ee8d21b91e4340bb2ae176d`, including the plane-hole and GND reuse fixes, and build/hash its Linux router. Keep Node, image, board rules, source-lock policy, seed 0, 80 passes, two CPUs, four GiB, and fresh native/configured verification unchanged.

Calibration uses `measure 0 ESP32-CORE`: zero means no experiment wall timer and no native `--max-time`, not a zero-second measurement. The existing 80-pass terminal result is the finite work stop. The daemon's configured maximum timeout (21,600 seconds on this host) remains an operational ceiling, not the proposed shared comparison budget. There is one attempt, with no automatic retries. A failed native result, failed configured gate, or operational stop ends this experiment with its diagnostic evidence; do not increase the budget or run sprints after an unverified single result.

Only if this calibration fully verifies will its measured phases determine a shared comparison budget. That budget and comparison policy must be recorded here before launching comparison trials. Until then there is no new single-versus-sprint result or revised LLM decision. All actual runs stay on Hetzner, never CI; only this one frozen board is in scope.

## ESP32-CORE single-versus-sprints follow-up (#1399)

### Calibration registration

This report-only follow-up uses the same frozen ESP32-CORE rev B source from
`a545d5e18428e03256ea876f45864b25061c1397`, PCB SHA-256
`b6b97508157893ccca5c5c2cc3e0c90d55691a42d094f9c1015ad8b7f31bdb2b`.
The previously restored FM25V02A PDF is retained unchanged:
`3993f988368aa8dc94b79a888234274959b7e4e091c693535530f3f4dddafefd`.
Pin current toolchain main `228b964205037621c36cbc39f92bd0f6d8301d86`.
Build its Linux router with Rust 1.93.1; record the resulting binary hash before
submission. Keep Node v22.23.2 and runtime image
`sha256:8c1c6d83c4050f4876f21926846e4e1d640b6be5194f448c3e239392c83a20af`.
All board runs are sequential Hetzner jobs, never CI, on isolated copies.

First run exactly one `measure 0 ESP32-CORE` calibration: seed 0, 80 passes,
source-lock and return-exemption policy unchanged, two CPUs, eight GiB for the
whole job including the fresh configured gate. No experiment wall timeout or
native `--max-time` is added during calibration; the daemon's 21,600-second
operational ceiling remains. The historical reproduction harness is copied with
only its resource declaration changed from four to eight GiB; archive that copy
and its diff. No router, gate, rule or exemption changes are permitted.

The benchmark success definition is deliberately separate from board acceptance:
require fresh native DRC, opens and schematic parity all zero, and every configured
geometric/electrical check complete with zero error/failure counts and zero active
kicad-happy findings. Warnings remain reported separately. Unused/stale RP-001
exemption entries are counted and named separately; they do not become actual
geometric violations or get removed. Any other gate error, missing check, stale
input, incomplete cleanup or timeout is unsuccessful. The historical five stale
entries were ETH_RSTn, EXP_P04, EXP_P06, SPI_MOSI_S and WDI; each trial's actual
set must be reported. The unchanged full gate and sprint controller may still
return failure and no accepted incumbent. Report those official outcomes too.

First benchmark-verified time means the completion of the first fresh gate that
meets the definition above, measured from job/portfolio start. It is not the
controller's full-acceptance time. Derive it from retained native, gate and owned
stage evidence; never substitute a promising score or route completion. Report
whole-job cgroup CPU, native candidate length/vias, preparation, slicing, native
and configured verification, client/cache overhead, and terminal cleanup.

If calibration fails for a reason other than stale exemptions, stop and report;
do not launch comparison trials or change rules. After a qualifying calibration,
preregister the measured shared budget, CPU limits, trial count and order here
and in the task record before the first comparison. No comparison trial is
registered or started by this calibration section.

Calibration binary SHA-256:
`3f307aa46709d9b843b2cb7faefb971c12db35780d82f0dc509c26a5fbb77f46`.
Node executable SHA-256:
`3517c2df0b2f8cd7f422b4b8450ef81c6889f08eb03e281d6de9079b15e6a327`.
The clean source archive hash is
`086c78924035e07a86eca067fa63b6799778306d3cc819d5a9a14f7659b336cf`;
211 router source files match the archive in both measurement copies, and all
2,723 frozen hardware-design files match the retained #1389 fixture.
