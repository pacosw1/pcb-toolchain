# ESP32 reference-plane model corrections (#1376)

The frozen ESP32-CORE B reference board at a545d5e1 (PCB SHA-256 b6b97508157893ccca5c5c2cc3e0c90d55691a42d094f9c1015ad8b7f31bdb2b) passes fresh native refill/DRC with zero errors, zero unconnected items and zero schematic-parity errors. With exact declared driver evidence restored, it also passes the native planes check. This supplies a real copper witness for the model audit, without adopting or editing canonical CAD.

## Two demonstrated mismatches

| Location | Reference copper | Rejection before the fix | Correction |
| --- | --- | --- | --- |
| U1.27 /IO2 and U1.26 /IO3 front escapes | F.Cu traces referenced to In1.Cu | The In2-only U1_ANT_NO_3V3 pour void blocked all reference layers | Scope a pour void to the trace layer's declared adjacent reference plane |
| U4.2 GND | 0.3 mm track to a 0.6/0.3 mm GND via at (161,121), 1.15 mm from the pad | A locked USB_DP track treated this GND via as a foreign-net antipad in its GND reference | Apply the foreign-antipad envelope only when the via is foreign to that known homogeneous reference plane |

The original GND via's copper gap to the nearby USB track is 0.19 mm, above the 0.15 mm clearance; its drill-to-copper gap is 0.34 mm, above 0.28 mm. The old added reference-hole setback rejects it despite those physical clearances and the native planes check passing. No numeric rule, via size, sampling radius, waiver, or board requirement is changed.

The correction keeps normal copper/drill/hole-to-hole/isolation/keepout checks, and retains the foreign-antipad envelope on the other reference plane. Mixed or unknown reference-plane nets remain conservative. The shared fixed-code cache remains net-independent: a blocked reference-net via is rechecked with its actual net, rather than caching its exemption for another net. Track-first/via-first and fixed/routed insertion orders use the same semantics.

Read-only probes on the real model changed all four front escape segments from blocked samples to zero blocked samples. Both real nearby GND via sites changed from blocked to legal. Ten other conservative bounding-box/spoke intersections on the reference routes were left unchanged; this work does not claim that the whole router geometry is exact.

## Evidence and validation

The four missing driver-evidence PDFs were recovered byte-for-byte from later iot-lab commit 8786e82739317d77d0ce281cb168d934b2431778 and matched their declared hashes: FM25V02A, STM32L431CCU6, MMBT3904RANGE and W25Q32JVZPIQ. They were added only to the isolated fixture. The original board, project rules and gate thresholds were retained. Provenance is archived with the experiment.

Synthetic regressions cover adjacent-layer scope, direct track prohibitions, legacy missing-map fallback, same-reference versus foreign/power vias, both insertion orders, fixed and routed copper, cached-code separation, physical clearances, hole-to-hole limits and mixed planes. The full Rust suite passed 933 tests with two existing ignores. The first core-only test workspace lacked driver JSON fixtures; the complete repository closure was restored and the full suite passed without weakening assertions.

The merged stuck reporter now correctly names all four native open nets in the before result. U4.2 is a core fanout finding; the native GND error names zone islands, so the report does not invent a U4.2 endpoint for that separate connection. The other native opens are /IO2 (J2.26 to U1.27), /IO3 (J2.27 to U1.26), and VDD_3V3 (U1.2 to C2.1).

Actual routing checks use only ESP32-CORE B and the retained ENV-SENSE fixture on Hetzner, never CI. The ESP32 after-run keeps seed 0, 80 passes, two CPUs and four GiB; the ENV regression uses the prior 120-second single-run policy. Canonical CAD and production runtimes remain untouched.

## Before and after

| Check | Before-fix ESP32 candidate | After-fix ESP32 candidate | ENV regression |
| --- | --- | --- | --- |
| Native DRC errors | 0 | 0 | 0 |
| Native unconnected items | 4 | 1 | 0 |
| Schematic parity errors | 0 | 0 | 0 |
| Reference planes | unavailable: missing evidence | 0 failures after the existing reference-feedback loop | not configured |
| Complete configured gate | not reached | not reached: native connectivity still fails | PASS plus both declared semantic checks |
| Accepted board | no | no | yes, unchanged bytes |

The after job is `20261105-213919-3f1a87`, using fix `e7c84a7` and binary `de2e6463a0b7f267decce4afebd09e4d5cbce5e43c0d40e6b9cc1f0449246f41`. The three targeted IO2/IO3/GND failures are removed. The existing native wrapper performs two reference rounds: the first found a short SPI_MISO crossing without a known driver edge; raising that net's existing reference cost avoided it in the second. No edge time was invented and no gate was bypassed. The complete native operation remains FAIL because VDD_3V3 is open.

Operation wall time is 636.610 s and actual job CPU 679.949 s. These are not a speedup comparison with the 236-second before result: the restored planes check now reaches the existing reference-feedback round that the before run could not execute. The client lost its log connection, but the server recorded a complete failed attempt and retained the output. A fresh authenticated results request recovered those completed records without a rerun. Server state, owned child cleanup, and container removal were independently checked.

ENV-SENSE job `20261105-214038-204c29` passes native 0/0/0, the fresh configured gate and both unchanged historical project semantic hooks. Its board is byte-identical to the earlier accepted baseline: `7c4dd481c5454a055da4b956124c984cae450a17547d81c3abe5092b31316da3`, 177 tracks, 20 vias, 262.0 mm. Those historical hooks are Python scripts executed on Hetzner, as in the retained baseline; no new Python was authored, and the router fixes and regressions are Rust.

## Remaining failure and stop

The fourth original connection is separate from the three core failures: VDD_3V3 from U1.2 to C2.1. The after output places a power-plane via at (154.15,102.25), entirely within the In2 no-pour rectangle (151.76,99.95)-(172.05,104.45). The model's plane polygon contains only the outer board outline, and its via-site membership test therefore accepts this site even though the power pour cannot reach it. The reference board instead uses a 0.64 mm F.Cu bridge from U1.2 toward C2.1 before joining the plane.

This residual was already present in the before DRC report; the two corrections did not introduce it. After the repeated VDD failure, this check stops and reports it. The two proven fixes are submitted separately; the own-plane void membership defect needs its own narrow proof and correction. No claim of a fully verified ESP32 board is made.

## Retained artifacts

Raw before/after probes, the reference DRC/planes checks, test logs, native job records, restored driver-evidence provenance, and cleanup audits are retained in the durable session artifacts/router-model-1376 directory. The separate reproduction archive preserves both frozen source closures and the tested runtime. Both archives passed gzip integrity checks.

| Archive | SHA-256 |
| --- | --- |
| router-model-1376-evidence.tar.gz | eb10ece1ae6c7be6be9c14e6d4c46bc55eb0b4e9845c451cddc3aeb6040e86e2 |
| router-model-1376-fixtures-runtime.tar.gz | 4a50a8e59763126bc1bb8a4bdfb48a2cf57dc9547c188e6c3f3caf04822e5e82 |
