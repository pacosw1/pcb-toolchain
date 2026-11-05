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
