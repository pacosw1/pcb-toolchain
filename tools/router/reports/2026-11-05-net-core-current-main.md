# NET-CORE current-main calibration (#1395)

**NET-CORE now passes the original full gate: opens fell from 1 to 0. ENV-SENSE regression also passes.** All 229 frozen copper objects and footprint/pad placement are preserved. Per #1395, stop the fix investigation: no router, rule, exemption, or CAD change is needed.

This follows the frozen NET-CORE experiment in [#1378](2026-11-05-tracemaker-v0.12.1-net-core.md), whose native candidate had zero DRC errors, one open on `/PHY_RSTn`, and zero parity errors. Its original fully routed control passed the full gate. This experiment tests main after PRs 63 and 64; it does not rerun TraceMaker.

## Reproduction and invariants

- Clean source: `c073af76a4c35d77b5475b7549c30bdc257e741f`.
- Whole-repository source archive SHA-256: `94b69aa3f78e6eeede48a84779c6ebe4d9e12eb52252d6acac79d9409b6672a6`.
- Release binary SHA-256: `529ceda5e2e95273460dadc1780faa7928762c7c91f39d8ac97c367d6158ce56`; built with `rust:1.93.1-bookworm`, `cargo build --release --locked`.
- Runtime: `iot-lab-route:10.0-nightly-4fe1ca2060`, image ID `sha256:8c1c6d83c4050f4876f21926846e4e1d640b6be5194f448c3e239392c83a20af`.
- Scratch root: `gopadel-ci1:/var/tmp/net-core-1395`; no canonical CAD writes.
- Frozen PCB SHA-256: `9109c27c374ca3685cc73cb60e452a66adba81ad71968c1f63db754f7fc5f784`.
- Input contains 77 nets, 491 pads, and 229 locked copper objects (201 tracks and 28 vias). Every input file and all board rule/gate/exemption JSON files hash-match the retained #1378 workspace.
- The historical `route.json` backend selector remains converted from `fastroute` to `iotroute`; all other fields are unchanged. There is no `--lock-from`, because the frozen input already contains the required locked copper.
- Same native routing policy: network disabled, 1 CPU, 8 GiB, default seed 0, 80 passes, 600-second routing budget; GNU timeout 660 seconds, TERM then KILL after 10 seconds. Preparation is outside route timing; model/write/refill checks inside `run` remain included. The independent full gate uses 8 GiB.
- Original fully routed control recovered from iot-lab `ecf4da837a8dbccba473f2945b276b87ae06dd6d`; PCB SHA-256 `cbe5b29ca487a9dd180e01442e58735fe4914bc23d68107a047573aaa7caf642` exactly matches the passing #1378 control gate provenance.

The independent gate uses current-main tooling with the unchanged original board gate and evidence closure. An initial controller invocation omitted its scratch-root argument and refused before preparation or routing; its error is retained. The corrected invocation performs the single native run.

ENV-SENSE uses the same clean binary and the frozen #1389 fixture with the existing semantic hooks, a 120-second single-run harness, 2 CPUs, and 8 GiB. It runs after NET-CORE verification. Historical Python hooks execute only on Hetzner; no new Python implementation is introduced.

## Results

| Check | #1378 native baseline | Current main |
|---|---:|---:|
| Native DRC errors | 0 | 0 |
| Native opens | 1 (/PHY_RSTn) | 0 |
| Native parity errors | 0 | 0 |
| Original full gate | FAIL | PASS |
| Changed frozen copper objects | 0 / 229 | 0 / 229 |
| Placement preserved | yes | yes |
| Tracks / vias | 1125 / 281 | 1118 / 263 |
| Straight track length | 1572.266 mm | 1563.866 mm |
| Route wall time | 418.58 s | 355.72 s |
| User + system CPU | 416.00 s | 353.61 s |
| Maximum process RSS | 604820 KiB | 601664 KiB |

The current full gate reports zero ERC errors, DRC errors, parity errors, opens, plane failures, pair failures, low current paths, via-pad violations, KiCad Happy findings, and port-label failures. It retains 368 ERC warnings and 115 DRC warnings (baseline: 368 and 116). The gate used fresh checks and reports no inputs changing during verification.

The core exhausted 80 passes and reported `converged=false`; strict cleanup/cascade closed the remaining search open, and final native DRC plus the independent gate accepted the saved board. Acceptance is based on those checks, not the core's convergence field. Length recovery kept 54 reroutes. No additional seed, routing attempt, policy change, or fix was tried.

The native candidate hash is `f1deebad65c71c77ad65bec595297ceea491089d8da519ddc50a7bae6d2ffe05`. Independent refill/save produced final accepted PCB `8895966ccac913b3c79effe035ceb05b5872881ff119bb5a1b1dff5e5826c4d4`; the geometry audit and fresh full gate refer to that final board.

### ENV-SENSE regression

The same binary passes native DRC/opens/parity (0/0/0), the fresh original full gate, and both unchanged historical schematic/layout semantic hooks. The result is 177 tracks, 20 vias, 262.0 mm, and SHA-256 `7c4dd481c5454a055da4b956124c984cae450a17547d81c3abe5092b31316da3`, byte-identical to the accepted #1389 candidate. All gate error counts are zero; 117 ERC and 28 DRC warnings remain. Native execution took 13.3 seconds; the complete harness took 18.18 seconds.

The first ENV launcher failed to create its output directory because the container's default user could not write the root-owned scratch directory. No routing started. Its log/exit/launcher are preserved; running as `0:0`, as for NET-CORE, fixed the launch. There was one actual ENV routing execution. All owned stages report complete cleanup, and no task-owned containers remain.

## Evidence and limits

Raw inputs, current executable/tooling, native exports/models, commands, process records, logs, timing, final candidates, full gates, provenance/geometry audits, source archive, and failed setup records are retained on `gopadel-ci1` under `/var/lib/cip/saved-artifacts/net-core-1395/`:

| Archive | SHA-256 |
|---|---|
| net-core-evidence-runtime.tar.gz | 24c36cdde4611b75878e161fa13d192833db832fe8d9427c5ff7a7ba42013916 |
| env-sense-evidence-runtime.tar.gz | ed98a3fd258eae7cae5d689a16bceb1ef21c21617ca7064dfb5da2e3eb253ee1 |

The [machine-readable report](2026-11-05-net-core-current-main.json) records the exact native/gate command arrays and checks. The isolated native runner and ENV launch script are also inside the archives. No stale exemptions were edited; NET-CORE's unchanged Happy exemption list is empty.

This establishes one frozen-board calibration and one regression result on the tested revision. It does not isolate which intervening fix closed the prior open, prove broader router quality, adopt routed copper into canonical CAD, install a runtime, or establish physical qualification. Real-board execution occurred on Hetzner, outside CI. The PR contains evidence only.
