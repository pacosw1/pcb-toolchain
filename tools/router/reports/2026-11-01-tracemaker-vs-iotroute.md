# Whole-board benchmark: iotroute vs TraceMaker on NET-CORE (2026-11-01)

Result: **iotroute completes the board and passes the full NET-CORE gate. TraceMaker does not complete it**, at 300 s
or at 600 s on 16 threads (600 s: 16 unconnected GND links, 12 starved_thermal, 19 RP-001, 2 paths_low, 1 planes
failure). TraceMaker makes a cleaner, more orthogonal route with about half the vias. Most of the via difference is the
GND return vias it did not place. No board file was changed. No tool report is used as evidence: every count below comes from KiCad 10.0.6
(`kicad-cli pcb drc --schematic-parity`) and `node tools/gate.mjs NET-CORE` on a scratch copy.

Branch `claude/tm-bench` (base main ecf4da83). Scratch evidence (not tracked):
`/private/tmp/claude-501/-Users-pacosw-code-iot-lab/f7557682-4961-4da4-8f78-b3604f97dd7d/scratchpad/tm-bench/`.

## Frozen input (same file for both routers)

`strip.py` (scratch) applied to `hardware-design/boards/NET-CORE/cad/NET-CORE/NET-CORE.kicad_pcb` at main ecf4da83:

| Kept and locked | Copper | Why |
| --- | --- | --- |
| 6 diff pairs (12 nets, `diff-pairs.json`): USB0, USB1, MDI_TX/RX, MDI2_TX/RX | all their copper (locked and unlocked on main) | the pairs are hand routes; iotroute has no pair stage (DESIGN 4) |
| 7 crystal nets (DRU "crystal nets", via_count 0) | all their copper | as above |
| GND pair-return copper (locked on main) | 3 tracks, 12 vias | returns of the locked pair vias |
| 5 copper zones + rule areas | refilled by KiCad for the stripped copper | not routed by a router |

Total kept: 201 tracks, 28 vias (the same set as the M2 NET-CORE regression). Removed: 1280 tracks, 252 vias.
Input board sha256 `9109c27c374ca3685cc73cb60e452a66adba81ad71968c1f63db754f7fc5f784` (`input.sha256` has all 7
files). Input KiCad DRC: 180 unconnected, 2 starved_thermal, parity 0. Both outputs keep all 229 input items
unchanged (`locked_same.py`: INPUT COPPER PASS for both).

Both results were written into a copy of the frozen project and every zone was refilled by KiCad before DRC
(`tools/router/write.py` for iotroute; `refill.py` (scratch) for TraceMaker, the board loaded next to the same
`.kicad_dru`). `.kicad_pro` was restored after each pcbnew save (checked with `cmp`).

## Runs

| | iotroute | TraceMaker |
| --- | --- | --- |
| Version | main ecf4da83 (core v5 + M2 fixes), `tools/router/core` tree fbcb6f25 | DingoOz/TraceMaker c6fcb7b4912bdabefeb7f4191c011b1a086335e0 (`tracemaker 0.9.0`) |
| Binary | Mac build; Linux build sha256 `293208c1…4fe8` (rust:1.93.1) | `/build/src/app/tracemaker` sha256 `bc6a8616432c4a93c9284d86e883f9f78d1a82809b6afba0664618a200a874de` |
| Image | rust:1.93.1 (run only) | `iot-lab-tracemak:cip839-c6fcb7b-python` = `sha256:b89827428c347646d32896ccf6506c39a3a7552080079de4e04176d1d299242a` (built from `tools/pcb_search/tracemaker/Dockerfile`, label revision c6fcb7b) |
| Host | Hetzner gopadel-ci1 (32 cores), `docker --network none --cpus 1`; also Mac (same result) | Hetzner gopadel-ci1, `docker --network none --cpus 16 --memory 24g`, input mounted read-only |
| Threads | 1 (the router is single-threaded) | 16 threads, portfolio of 16 variants |
| Budget | none: runs to convergence | `--time 300` (run 1), `--time 600` (run 2); per variant |
| Model / options | `model.py NET-CORE --pcb input` (rules applied 13, stage 12, plane 3, checked 2); `iotroute model.json out.json` | `route --no-gpu --no-kb --soft-zones --keep-vias-off-pads --vias-off-pads-below 5.601 --via-in-pad --component-rules off --no-tracks-on In1.Cu,In3.Cu,In4.Cu --widen-power --stitch-vias return --stitch-distance 2.0568 --stitch-return NET=GND` (x50 nets, the model's plane_ref nets) |

The TraceMaker binary was called directly, with the adapter's protective flags (`tools/pcb_search/tracemaker.py`:
`--no-kb --soft-zones --keep-vias-off-pads --vias-off-pads-below <max pad + e> --component-rules off`) plus the
whole-board rule flags. The adapter itself was not used: it needs a selected-net SRJ manifest and scopes the result to
those nets. No adapter change was necessary.

iotroute is deterministic: the Mac and the Linux outputs are byte-identical (sha256 `b7b71ebb…a11b`). It is the same
result as the M2 NET-CORE regression (11 iterations, 1334 tracks, 248 vias).

## Results

| Item | iotroute | TraceMaker 300 s | TraceMaker 600 s |
| --- | --- | --- | --- |
| Wall time | 172 s (Hetzner, 1 CPU; 11 iterations, converged). Mac under load avg 18: 210 s. | 304 s on 16 threads (best variant 7 "fast bends, dear vias"; all 16 variants used the full 300 s) | 604 s on 16 threads (best variant 13 "seeded 5"; all 16 variants used the full 600 s) |
| Router's own claim | ROUTE PASS, failed 0 | 179/180 connections, 21 unconnected after refill, "refill repair: skipped, the time limit is used up" | 180/180 connections, 16 unconnected after refill, "refill repair: skipped, the time limit is used up" |
| **drc_unconnected** | **0** | **21** (20 GND pad / pour-island links, /ETH_TXD0 U1.123-U7.17) | **16** (all GND pad / pour-island links) |
| **drc_errors** | **0** | **15** (starved_thermal, GND_F) | **12** (starved_thermal) |
| drc_parity | 0 | 0 | 0 |
| drc_warnings | 96 | 95 | 95 |
| erc_errors / warnings | 0 / 4 | 0 / 4 | 0 / 4 |
| planes_failures | 0 | 1 (fast-crossing B.Cu /ETH_RXD0, 0.82 mm) | 1 (unknown-driver crossing B.Cu /ETH_MDC) |
| pairs_failures | 0 | 0 | 0 |
| paths_low | 0 | 3 (VBUS 0.82 A < 1.0 A, /SW_3V3 0.82 A < 1.0 A: 0.15 mm necks; VCC_1V8 U1.28-U1.97 no copper path) | 2 (/SW_3V3 0.82 A < 1.0 A: 0.15 mm neck; VCC_1V8 U1.28-U1.97 no copper path) |
| viapads | 0 | 0 | 0 |
| kicad_happy_findings | 0 (28 transitions stitched) | 19 (all RP-001, missing return via) | 19 (all RP-001) |
| port_label_failures | 0 | 0 | 0 |
| gate | **PASS** (all checks at target) | NOT AT TARGET (5 checks) | NOT AT TARGET (5 checks) |
| Routed track length | 1142.4 mm | 1269.6 mm | 1250.0 mm |
| Routed segments | 1334 | 849 | 651 |
| Layer use F / In2 / B (mm) | 703.4 / 105.0 / 333.9 | 892.0 / 223.1 / 154.5 | 898.2 / 198.1 / 153.7 |
| Vias (GND / VDD_3V3 / signal) | 248 (123 / 49 / 76) | 125 (8 / 49 / 68) | 135 (17 / 49 / 69) |
| Segments off 0/45/90 (count / length) | 41.2 % / 75.9 % | 19.4 % / 7.0 % | 8.1 % / 2.2 % |
| PWR-class segments below 0.5 mm | 237 | 95 | 71 |

Track numbers count only the routed (unlocked) copper; the 201 locked tracks and 28 vias are the same in all columns.
Angle test: a segment is "off" when its angle is more than 0.5 degrees from a multiple of 45 degrees (arcs excluded;
neither router made arcs). Measured by `measure.py` (scratch) with pcbnew.

## Rules each router could not express

| Rule (source) | iotroute | TraceMaker |
| --- | --- | --- |
| Diff pairs: width, gap, skew, uncoupled length (DRU, `diff-pairs.json`) | no pair stage: pre-routed and locked | pre-routed and locked (same input). Its rule engine does not evaluate `isCoupledDiffPair()` ("pair inner gap", 0.12 mm): taken as false (its own warning). Its own `tracemaker drc` then reports 63 false clearance errors between the legs of the locked USB pairs (KiCad: 0). `--diff-pairs` not used: nothing to route. |
| RP-001 return via within 2.057 mm (gate `return_planes`, kicad-happy) | in the search; own GND via 0.45 / 0.2 mm | **not in the search.** Only a post-route pass (`--stitch-vias return`); it placed 6 vias (300 s) / 15 vias (600 s); for most transitions "0 stitched after" (no room). 19 RP-001 findings remain. All its vias are 0.6 / 0.3 mm (no separate GND via size). |
| Current widths (`current-paths.json` amps, IPC-2221, dT 20 K) | amps to width per chain; neck-downs only where the paths gate passes | **not expressible** (no current input). Approximated with the net-class width 0.5 mm by `--widen-power`, a post-pass "where there is room". 3 paths_low. |
| via_count max (USB 4, MDI 2, RMII 4, REF_CLK 2, crystals 0) | applied per net | **not parsed** (no `via_count` in its source). KiCad DRC after the route: 0 violations (not violated by chance). |
| length max (RMII 50 mm, REF_CLK 60 mm) | applied per net | parsed (`length_constraint`); DRC 0 violations |
| In2.Cu per-net disallow (PWR, pairs, crystals) | per-net layer set | DRU disallow with layer + condition is evaluated; DRC 0 violations |
| No tracks on In1 / In3 / In4 (planes) | plane layers | `--no-tracks-on In1.Cu,In3.Cu,In4.Cu` (+ DRU) |
| Pour connectivity, starved_thermal (min 2 spokes) | pour model negotiated in the search (v5) | `--soft-zones`: refill and repair after routing; the repair needs time left over. 15 starved_thermal, 20 GND unconnected. |
| Via in pad only at U7.25, U1.129, U8.25 (gate viapads) | model allow list | `--via-in-pad` allows any enclosed pad; no per-pad list. viapads 0 here. |
| Hole rules (hole_to_hole 0.45, hole_clearance 0.28) | applied | parsed; DRC 0 |

## Verdict

1. On this board iotroute is the only router with a complete, gate-clean result (172 s, 1 core). TraceMaker still has 16
   GND opens and 12 starved thermals after 600 s on 16 cores, and it cannot express RP-001 or current paths in the search.
2. TraceMaker's geometry is better to review: 2.2 % of its length is off 0/45/90 (iotroute 75.9 %), half the segments
   and about half the vias. Most of the via gap is GND return vias: iotroute 123, TraceMaker 17.
3. Worth taking from TraceMaker: octilinear output and a portfolio of variants. Not a reason to change router.

## Renders (kicad-cli pcb render)

- iotroute top: `/private/tmp/claude-501/-Users-pacosw-code-iot-lab/f7557682-4961-4da4-8f78-b3604f97dd7d/scratchpad/tm-bench/render/iotroute-top.png`
- iotroute bottom: `/private/tmp/claude-501/-Users-pacosw-code-iot-lab/f7557682-4961-4da4-8f78-b3604f97dd7d/scratchpad/tm-bench/render/iotroute-bottom.png`
- TraceMaker 300 s top: `/private/tmp/claude-501/-Users-pacosw-code-iot-lab/f7557682-4961-4da4-8f78-b3604f97dd7d/scratchpad/tm-bench/render/tracemaker-300s-top.png`
- TraceMaker 300 s bottom: `/private/tmp/claude-501/-Users-pacosw-code-iot-lab/f7557682-4961-4da4-8f78-b3604f97dd7d/scratchpad/tm-bench/render/tracemaker-300s-bottom.png`
- TraceMaker 600 s top: `/private/tmp/claude-501/-Users-pacosw-code-iot-lab/f7557682-4961-4da4-8f78-b3604f97dd7d/scratchpad/tm-bench/render/tracemaker-600s-top.png`
- TraceMaker 600 s bottom: `/private/tmp/claude-501/-Users-pacosw-code-iot-lab/f7557682-4961-4da4-8f78-b3604f97dd7d/scratchpad/tm-bench/render/tracemaker-600s-bottom.png`

## Limits of this benchmark

- One board. NET-CORE was placed and tuned for iotroute (its committed route is an iotroute result), so the
  placement may favour iotroute.
- Different compute: iotroute 1 core with no time limit; TraceMaker 16 cores with a fixed time. iotroute on Hetzner ran
  at the same time as TraceMaker run 1 (32-core host, 17 cores in use).
- The TraceMaker image was built on 2026-10-13 from the same Dockerfile and pin; it was not rebuilt for this run.
