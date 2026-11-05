# Own-pour via eligibility (#1389)

The remaining ESP32-CORE B VDD_3V3 open after PR #63 came from a plane fanout via at (154.15, 102.25) inside the In2.Cu pour-only void. The old `Board::in_plane` accepted it because `plane_polys` retained only outer outlines, without holes or layer ownership. A read-only probe against the saved real model reproduces that acceptance; the retained native result independently reports one open, U1.2 to C2.1.

The model now also exports `plane_regions`: each own-pour layer and its polygon rings, including holes. Plane nets retain only configured plane-layer zones; other zone-bearing nets retain their existing all-zone scope. Layer-distinct pours remain distinct even when their outlines match. The router requires the candidate centre to lie in an own-pour polygon outside its holes on at least one layer not voided by a pour keepout at that point. A distant own-net zone on a different layer cannot supply this connection. A containing, unvoided own-net zone on another layer can.

Pour-only keepouts remain separate from physical via and track bans. This change permits the outer-layer bridge toward usable plane copper. Models without the new metadata retain their old outline constraint but conservatively refuse sites inside any pour void because they cannot establish layer ownership. Explicit empty geometry has no eligible site.

No numeric rule, clearance, via size, routing budget, waiver, or canonical CAD is changed. This is centre-membership eligibility, not proof of connected filled copper or sufficient annulus/thermal attachment. Fresh native refill, connectivity, parity, planes and the configured gate remain the acceptance authority.

Four synthetic regressions cover compiler export and layer selection, outline holes and pour-only voids, valid alternate layers versus distant zones, keepout holes and legacy handling. Real-board evidence stays outside CI. The isolated fixtures reuse the exact prior ESP32-CORE B and ENV-SENSE board bytes and restored declared driver evidence.

## Validation outcome

The full Rust suite passes 937 tests with two existing ignores using Rust 1.93.1. The clean release binary is `5c2eb23dbe5706386c34efecee1149efb968ea64c9f4d11e46bdc72b79d5e550`, built from implementation `d53c9ff8adfc058904843a5888febca6b25557ad`. Manual real-board probes were appended only to a separate analysis build after the immutable release binary was copied.

| Check | Before (#1376 candidate) | After (#1389 candidate) |
| --- | --- | --- |
| Native DRC errors | 0 | 0 |
| Native unconnected items | 1 | 0 |
| Schematic parity errors | 0 | 0 |
| Native reference-plane failures | 0 after feedback | 0 after feedback |
| Full configured gate | not reached | FAIL: five stale RP-001 exemptions |
| Fully accepted board | no | no |

The final ESP32 candidate is `e9464aaa21ec7792469d02c4cd7244314ab9e4dd1655ad960536a3b709c499bf`, with 956 tracks, 201 vias and 2225.0 mm of tracks. Nearby VDD_3V3 plane via centres now lie at (151.75,103.95), (150.95,103.95) and (150.10,102.75), outside the no-pour rectangle. Native connectivity confirms attachment; merely moving the centres is not the acceptance proof.

The single ESP32 job `20261105-222252-211747` retained seed 0, 80 passes, two CPUs and 4 GiB, with the existing reference-feedback loop. Its first native write had no opens. The first planes check found the same kind of short SPI_MISO unknown-driver crossing as the prior baseline; the existing feedback loop raised its reference cost and the second candidate passed planes. No edge time was invented. The complete operation took 687.244 wall seconds and 759.832 cgroup CPU seconds, including the subsequently failed gate. This is not a pure search-speed comparison.

The client lost its log stream, while the server continued the same job. Completed results were recovered through the authenticated results endpoint without resubmission. Both owned stages reported complete cleanup, and the container was independently confirmed absent.

ENV-SENSE job `20261105-222302-920784` passes native 0/0/0, the fresh configured gate and both unchanged historical semantic checks. Its accepted output is byte-identical to the baseline: `7c4dd481c5454a055da4b956124c984cae450a17547d81c3abe5092b31316da3`, 177 tracks, 20 vias, 262.0 mm. It took 56.246 wall seconds and 86.293 cgroup CPU seconds under the unchanged two-CPU, 120-second policy. Historical semantic hooks run Python on Hetzner as before; no new Python was authored and no Python was run on the Mac.

## Full gate: resource failure isolated, stale records retained

The initial 4 GiB fresh gate passed native ERC/DRC, paths, via pads and port labels, but its concurrent planes/pairs refill processes were killed. The daemon recorded `outcome: oom`; kernel memory-cgroup logs identify the two killed `kicad-cli` processes. This is a checker execution error, not a zero-count result.

Coordinator message 1274 authorized exactly one gate-only rerun at 8 GiB on Hetzner. Job `20261105-223805-a7a9c0` used the identical candidate and binary, the same image, two CPUs, no routing and no exemption edits. All configured error counts completed at zero: ERC, DRC, parity, unconnected, planes, pairs, paths, via pads and port labels. The gate still exits 1 solely because the unchanged exemption file contains five stale RP-001 entries. KiCad Happy reports zero actual findings and five stale exemptions. Both gate records report `changedDuringRun: false`; neither is represented as a full gate pass.

All five stale entries describe layer transitions present in the original rev B copper that are absent from this routed candidate:

| Exempt net | Rev B transition vias | Rev B track layers | Candidate transition vias | Candidate track layers |
| --- | --- | --- | --- | --- |
| /ETH_RSTn | 2 | F.Cu, B.Cu | 0 | F.Cu |
| /EXP_P04 | 1 | F.Cu, B.Cu | 0 | F.Cu |
| /EXP_P06 | 1 | F.Cu, B.Cu | 0 | F.Cu |
| /SPI_MOSI_S | 2 | F.Cu, B.Cu | 0 | F.Cu |
| /WDI | 2 | F.Cu, B.Cu | 0 | F.Cu |

The audit compares original board copper read through the native API with the final route. Only USB tracks were locked, so the route's via list is complete; the original transition coordinates match the exemption reasons. The configured Happy check has no `return_planes` override and its exempt-transition test uses 1 mm. The original vias of these nets lack a GND via within that radius; the candidate has no vias for those nets at all. This explains why the retained reasons no longer match. It does not establish that this narrow change introduced the stale records: the preceding candidate never reached the full gate.

The exemptions remain untouched and the gate remains failed. Cleaning project evidence is separate work. This report claims the demonstrated routing/model correction and named checks, not full board acceptance, physical hardware qualification, canonical CAD adoption, or production deployment.

## Reproduction evidence

The source PCB hashes remain `b6b97508157893ccca5c5c2cc3e0c90d55691a42d094f9c1015ad8b7f31bdb2b` (ESP32-CORE B at iot-lab `a545d5e18428e03256ea876f45864b25061c1397`) and `6abb00a0a30cd3f02d6e96a0cb326e16c1f050b735e5ed43770dcbf653844ae7` (ENV-SENSE). Full fixture comparisons against the prior runs show only the five implementation/test source files changed; board, rule, gate and driver-evidence files are unchanged. The native image is `sha256:8c1c6d83c4050f4876f21926846e4e1d640b6be5194f448c3e239392c83a20af` and Node is 22.23.2.

Raw probes, test logs, both routing job results, the separate 8 GiB gate, OOM evidence, cleanup records, restored-driver provenance and the stale-transition audit are retained under the durable session's `artifacts/plane-void-1389`. A separate archive retains the exact frozen source closures and runtime. No real-board fixture is added to CI.

| Archive | SHA-256 |
| --- | --- |
| esp1389-source.tar.gz | 3398da27db3c68175128bb60fefa8fe53ebce0605a362f91389b3d4c2d2cca0c |
| plane-void-1389-fixtures-runtime.tar.gz | 9703e8beb0733096dd1d2fa62b8b05f0b693add5a261b6051ac21aa7a6a5784b |
| plane-void-1389-evidence.tar.gz | c40a26ef3fbcce8e6cac58a0ee72b62f9944d3824ca918b5268e0abf0aa612bd |
