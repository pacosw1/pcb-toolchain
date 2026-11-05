# TraceMaker v0.12.1 and current iotroute: frozen NET-CORE

Task #1378. One board on Hetzner, outside CI; no canonical CAD or electrical requirement changes.

**Neither new route passes the original full gate.** Current iotroute leaves one `/PHY_RSTn` connection open;
TraceMaker leaves 19 native opens and 13 starved thermals, plus plane/current-path/return-via findings.
Both preserve every frozen copper object and all footprint/pad placement. The original fully routed control still
passes the same gate. This does not reproduce the older report's clean iotroute reroute on current main.

## Measured results

All acceptance counts below are from the saved, natively refilled board and original full gate, not the routers' own claims.
Both gates completed every required check, with `changedDuringRun=false`, no preflight errors and no cache reuse.
Raw measurements and exact command arrays are in [the JSON record](2026-11-05-tracemaker-v0.12.1-net-core.json).

| Metric | Current iotroute | TraceMaker 0.12.1 |
| --- | --- | --- |
| Measured wall time, including finalization | 418.58 s | 643.83 s |
| Process CPU time, user + system | 416.00 s | 643.15 s |
| Maximum process RSS | 604,820 KiB | 4,035,492 KiB |
| Router/wrapper exit | 1, FAIL | 3, partial |
| Native DRC errors | 0 | 13, all `starved_thermal` |
| Native opens | 1 | 19 |
| Native parity errors | 0 | 0 |
| ERC errors / warnings | 0 / 368 | 0 / 368 |
| DRC warnings | 116 | 115 |
| Reference-plane failures | 0 | 1 |
| Pair failures | 0 | 0 |
| Current-path findings | 0 | 6 |
| Via-in-pad failures | 0 | 0 |
| kicad-happy findings | 0 | 22 reported; see truncation limit below |
| Port-label failures | 0 | 0 |
| Full gate | FAIL, one open | FAIL, five check categories |
| Frozen copper changed/lost | 0 of 229 | 0 of 229 |
| Footprint/pad placement preserved | yes | yes |
| New tracks / total tracks | 924 / 1,125 | 740 / 941 |
| New vias / total vias | 253 / 281 | 130 / 158 |
| New straight-track length | 1,211.8 mm | 1,200.4 mm |
| Total straight-track length | 1,572.3 mm | 1,560.9 mm |
| Arcs | 0 | 0 |

The native iotroute open is U7.15 to a track on In2.Cu on `/PHY_RSTn`. The core reached 80 passes in 242.5 s;
strict rerouting/cascade recovery did not close that net, and length recovery took another 39.7 s. Total core time was
405.4 s. The wrapper's saved-board DRC and the independent full gate agree on zero DRC/parity errors and one open.
This rerun does not reproduce the older clean result; it does not identify which source/runtime change explains the
difference, and does not repair the router.

TraceMaker claims 179/180 connections, but native refill finds **18 GND opens plus `/ETH_TX_EN` between U7.16 and U1.124**.
Its own pre-output refill reported 20 unconnected items and 12 starved thermals; native final checks find 19 and 13.
Its return pass added nine vias. The full current-path checker reports VBUS and `/SW_3V3` below 1 A (0.15 mm necks),
and four VCC_1V8 path findings. The plane failure is the unknown-driver `/ETH_MDC` crossing on B.Cu.
The kicad-happy count includes **21 named RP-001 findings plus a truncation marker**; 22 is the report count, not an
exact complete count of affected nets. Do not treat that truncated list as complete diagnostic coverage.

At these limits TraceMaker uses fewer new tracks/vias and similar track length, but neither output is accepted.
This is one seed/variant on one placement, with no repeated timing samples, no whole-fleet or physical SI qualification,
and no evidence for changing the default router. The old 16-core TraceMaker runs are not an equal-resource comparison
with this one-core run.

## Input and implementation identity

The original input survived at `gopadel-ci1:/root/tm-bench-20261101/input`. Its PCB SHA-256 matches the
[original comparison](2026-11-01-tracemaker-vs-iotroute.md) exactly. No reconstruction or equivalence assumption was needed.
The seven files were copied into `/var/tmp/tracemaker-1378/input` and mounted read-only during the experiment.
Gate specifications and board metadata come from iot-lab `ecf4da837a8dbccba473f2945b276b87ae06dd6d`.
Current driver-table evidence missing from the initial scratch copy was supplied from iot-lab
`8786e82739317d77d0ce281cb168d934b2431778`; all edge/driver evidence files match their declared SHA-256 values.
No rule or table entry was removed to make a checker run.

| Input | SHA-256 |
| --- | --- |
| NET-CORE.kicad_pcb | `9109c27c374ca3685cc73cb60e452a66adba81ad71968c1f63db754f7fc5f784` |
| NET-CORE.kicad_pro | `e7eabad4694910793f3402500c2ff6687277744c2aa61056527bdc8ed9ed2101` |
| NET-CORE.kicad_dru | `c3668dc562af2a0430d636cb546690b617b0df0908a94f3d5aedcfe876dcd928` |
| NET-CORE.kicad_sch | `a3eed01ec162ebe823841c0dcdd76021cae073cc710cfebc1a7cc32e0e5e4f11` |
| NET-CORE.kicad_prl | `26efd7d1adf51cbde76d4004c2388c43d4f8fa5884dda4053d8eb9d5b91bd0a5` |
| fp-lib-table | `e2da9309f937aa006df09ade5f9a92fc7ab815502fcc318ddb242fd7ce849c23` |
| sym-lib-table | `b9ea706ce87735f3d6700455999bdba69b3e1bca838c41f7279d7b728a3158c5` |

`iotroute board-json` replaces the deleted Python/native_export path. Its versioned native export reads
77 nets, 491 pads and **201 tracks plus 28 vias, all 229 locked**. These are the original pair/crystal routes and
locked GND returns, with the same placement, pours and rule areas. The native model reports 13 applied, 2 checked,
3 plane and 12 stage rules. Its return radius remains 2.0568 mm, and 50 nets require reference planes.

| Component | Identity |
| --- | --- |
| iotroute/toolchain source | pcb-toolchain main `415414197bb66c0d0b875130c1e10e43fae6bd32` |
| iotroute binary | SHA-256 `113d45f068e59a6b6573900b6ab4198a73e50b08a486434aebaaebda5422142b` |
| iotroute build | `rust:1.93.1-bookworm`, `cargo build --release --locked` |
| TraceMaker source | tag `v0.12.1`, `db5950f4b8710d322ecaea3599077688a158ebfb`, clean source |
| TraceMaker binary | SHA-256 `5994c8c6e7102e8c2ad2994ee00e642bdb4635a74e82daa2974a7b3b37687e6f` |
| TraceMaker image | `sha256:89102765567daa0540bb2ac2133b54824cc91b794341fa3e175b6bce72de40c2` |
| TraceMaker build | GCC 15.2.0, upstream CPU `RelWithDebInfo` configuration, `TM_WERROR=ON`, CUDA/Metal off |
| Clipper2 | `21ebba05db8894f0c7217ad35ea518080f324946` |
| Native runtime image | `iot-lab-route:10.0-nightly-4fe1ca2060`, image `sha256:8c1c6d83c4050f4876f21926846e4e1d640b6be5194f448c3e239392c83a20af` |
| Native API | pinned KiCad commit `4fe1ca20605d722a8972dabe11b4a90fc6b3d879` |
| kicad-happy | existing pinned `a6bba1a`; dependency, unchanged |

The former Dockerfile's `Release` / `-O3` configuration failed GCC's `-Werror=nonnull` diagnostic in upstream
`router.cpp:4858`. The upstream `cpu-only`/`dist` presets use `RelWithDebInfo`; that configuration built successfully
without disabling warnings or patching upstream source. Placement was built, never run or adopted.

## Resource and option policy

Both runs receive **one CPU, 8 GiB memory and a 600-second routing budget** in network-disabled containers on the same host.
They run sequentially. A GNU `timeout` wrapper allows 660 seconds for routing and finalization, then TERM followed by KILL
after ten seconds. TraceMaker uses one thread and one variant. iotroute uses seed 0 and at most 80 passes.
Native export/model preparation is recorded separately. `iotroute run` additionally performs model generation,
write/refill/native acceptance inside its measured interval; the final full gate is separately recorded for both outputs.
GNU time reports process CPU seconds and maximum RSS; maximum RSS is the largest process, not aggregate cgroup peak.

The historical `route.json` named the removed Fastroute backend. The first native wrapper invocation refused it before
routing. Only `backend: fastroute` was changed to `backend: iotroute` **in the scratch caller configuration**, with both
file hashes recorded in `caller-conversion.json`; every other field and every acceptance rule stays intact.
The frozen input already contains all required locked copper, so the corrected invocation uses it directly without
`--lock-from`: that option reconstructs pair/crystal copper and would drop 3 locked GND tracks and 12 locked GND vias.
The refused invocation is retained as setup evidence, excluded from routing measurements. No TraceMaker rerun was needed.

TraceMaker retains the old benchmark's protective options, verified against the new binary's `route --help`:
`--no-gpu --no-kb --soft-zones --keep-vias-off-pads --vias-off-pads-below 5.601 --via-in-pad
--component-rules off --no-tracks-on In1.Cu,In3.Cu,In4.Cu --widen-power --stitch-vias return
--stitch-distance 2.0568`, with an explicit `--stitch-return NET=GND` for each of the 50 native model plane-reference nets.
The 5.601 mm threshold is derived from the native pad sizes, not copied without checking.

| Requirement | Treatment and limit |
| --- | --- |
| Pair/crystal geometry | Identical pre-routed locked copper; both outputs checked against all 229 input copper objects |
| Pair inner-gap selector | TraceMaker explicitly warns `isCoupledDiffPair()` is unsupported and taken as false; KiCad decides acceptance |
| Return-path vias | Same native radius/net list supplied; TraceMaker stitching is an after-route pass, not a search constraint |
| Current paths | Original current-paths gate unchanged; `--widen-power` attempts class-width restoration after routing, not an exact per-chain current-path solver. New upstream typed current rules exist, but this experiment does not invent a translation of the project's path specification |
| Via-count limits | No `via_count` implementation found in the pinned upstream io/model/drc/route sources; original KiCad rules remain authoritative |
| Via-in-pad | TraceMaker's enclosed-pad permission is broader than the project's three-pad allow list; original viapads gate remains authoritative |
| Hole clearance | TraceMaker warns it conservatively applies the 0.280 mm hole clearance around every hole; native DRC applies the original conditional rule |
| Plane layers and pours | Original plane-layer deny list; native refill before DRC/parity, reference-plane and return-path checks |

## Reproduction and evidence

On the Linux Docker host, prepare a dedicated `/var/tmp/tracemaker-1378...` scratch directory with:

- `input/`: the seven immutable files above.
- `project/hardware-design/boards/NET-CORE/`: original board metadata and gate from `ecf4da83`, with a writable CAD copy.
- `project/tools/`, `toolchain/tools/`: current toolchain source, with the required shared registry evidence.
- `toolchain/bin/iotroute-linux-x86_64` and `node-linux-x86_64`, `bin/node` and `bin/iotroute` symlinks to them.
- `toolchain/hardware-design` linked to `../project/hardware-design` so the native checkers find their hashed evidence.
- `happy/`: the pinned kicad-happy dependency; `time`: GNU time copied from the TraceMaker image for native measurement.

Build the TraceMaker image with `tools/pcb_search/tracemaker/Dockerfile`, tag `tracemaker:1378-v0.12.1`.
Then run `tools/tracemaker_bench.sh prepare ROOT`, `route ROOT`, and `verify ROOT`.
Route refuses an existing `runs/` directory. Verification writes only scratch copies, preserves original electrical sidecars,
exports the routed geometry through the native API and runs the full original gate with isolated evidence.
Every Docker invocation, exit code, log and wall duration is retained. Frozen input hashes are compared before/after each mode.
`verification-summary.json` separates completed measurements from accepted boards; an experiment that successfully
measures a failing board does not turn its failures into acceptance.

As a control, the **original fully routed board** from `ecf4da83` passes every original gate under the current toolchain:
zero ERC/DRC/parity/opens, plane/pair/current-path/via-in-pad/return-via/port-label failures. This is not the stripped input
and is not a new router result. Its 368 ERC and 116 DRC warnings are informational; the old report's warning counts came
from a different native runtime. Earlier scratch control failures (missing executable environment and evidence files)
are retained separately and were corrected before candidate validation.

The retained evidence archive is on Hetzner at
`/var/lib/cip/saved-artifacts/tracemaker-1378/baseline-evidence.tar.gz` (4.8 MiB), SHA-256
`b92db74d066e0bd7bf1626742e3d90e30477ba62fb2f6d5baba58dece4b548c5`.
It includes frozen inputs, native exports/model, exact caller conversion, commands/logs/timing, both candidates,
both full gates, locked-geometry checks, the passing original-route control and build evidence. The experimental images
remain local to the host; no default runtime, job-daemon image, source CAD or router was deployed/adopted.
