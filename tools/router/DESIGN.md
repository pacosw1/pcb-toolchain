# iot-lab router (in-house, rule-native)

Status: design (2026-10-31). User decision: "we really need to make our own autorouter with our knowledge and tools
and stop relying on others". First proof board: NET-CORE (branch claude/t113-net-core).

## 1. Why

- Fastroute is a closed binary. Our `.kicad_dru` rules must be translated into its DSN model, and
  `tools/route_rule_coverage.py` correctly refuses to launch it when a rule cannot be proved there (NET-CORE 2026-10-31:
  via size, pair, RMII, crystal and In2 layer rules all "unsupported").
- The rsixel A* router and Freerouting do not know our pair, RMII, return-via (RP-001) or current-path rules.
  Every board then ends in hand fixes (H7-CORE, ESP32-CORE, NET-CORE).
- A router that reads our rules as its own model needs no coverage proof: the constraint it routes with is the
  constraint the gate checks.

## 2. Acceptance (unchanged)

The router result is a proposal. A board is done only when KiCad DRC with `--schematic-parity` and
`node tools/gate.mjs BOARD` report every count 0. The router's own report is never evidence.

## 3. Inputs (read natively, nothing translated)

| Source | Used for |
| --- | --- |
| `.kicad_pcb` (pcbnew) | outline, pads (shape, layers, net), footprints, existing copper (locked), zones |
| `.kicad_pro` net classes + board setup | widths, clearances, via 0.6 / 0.3 minimum |
| `.kicad_dru` (parser of route_rule_coverage) | per-net / per-class clearance, width, pair width / gap / skew / uncoupled / via count, length, via count, layer disallow |
| `diff-pairs.json` | pair membership, impedance target, reference |
| `rp001-fast-nets.json` + gate `route_features.rule_compiler.extra.deny_layers` | layer policy (fast + power off In2) and return-via obligation |
| `reference-planes.json` | plane layers (no tracks), plane nets (pad vias instead of routes) |
| `current-paths.json` | minimum width along each power chain |

## 4. Architecture

```
tools/router/
  model.py      board + rules -> RouteModel (JSON): grid, layers, obstacles per layer, nets, pins, per-net rule set
  rules.py      .kicad_dru -> per-net constraints (reuses route_rule_coverage._forms / _condition, three-valued)
  core/         Rust crate (our code): multi-layer grid A*, negotiated congestion (PathFinder), via cost,
                per-net clearance halos, layer masks, length / via-count limits, pair centerline mode
  plan.py       stage order: pairs + crystals -> plane vias (+ return vias) -> power (width per current path,
                neck at fine pitch) -> fast nets (outer layers) -> slow nets (In2 allowed) -> rip-up / reroute
  write.py      RouteModel result -> tracks / vias into a copy of the board (pcbnew), locked input copper untouched
  run.py        CLI: python3 tools/router/run.py BOARD OUT.kicad_pcb [--stage ...]; then DRC + gate
```

Grid: 0.05 mm on 6 layers for a 72 x 80 mm board = 2.3 M cells per layer; the Rust core keeps an occupancy and
history-cost array per layer and a per-net clearance radius (track half width + rule clearance), so each net is
routed against inflated obstacles exactly as the DRU defines them.

Pairs: one centerline at pitch = width + gap, routed in the core with the doubled clearance, then offset into P / N
(the `pair_route` method, moved into the core); fan-out stubs from the pads (the `pair_stubs` method).

Return vias: after a fast-net via is placed, the core searches a GND via site within the RP-001 radius and reserves it
(via + clearance) before the next net; no site = the transition is rejected and the net reroutes.

## 5. Milestones

| Milestone | Done when |
| --- | --- |
| M0 model | `model.py` builds the RouteModel for NET-CORE; every DRU rule maps to a constraint or an explicit "not routed by this stage" |
| M1 NET-CORE | the router routes NET-CORE from the placement (pairs included); gate all 0 |
| M2 comparison | re-route H7-CORE or ESP32-CORE from placement; gate all 0; compare vias / length / time with the hand + Fastroute result |
| M3 default | `tools/pcb route --router iotlab`; Fastroute kept as a cross-check only |

## 5a. NET-CORE requirements (from the hand-finished route, 2026-10-31)

The Codex hand finish of NET-CORE reached DRC 0 but left gate findings. The router must not produce them:
- a fast net keeps the plane clearance (0.25 mm) from every foreign via and PTH pad, so it never runs over a plane
  antipad (si_planes fast-crossing: 6 findings on the hand route);
- every signal via gets a GND return via within the RP-001 radius (16 kicad-happy RP-001 findings); GND vias go
  through the In3 VDD_3V3 plane (antipad), only copper items block them;
- every SMD pad of a plane net gets its own fan-out via (VDD_3V3 has no other path to In3);
- power nets route at the class width and neck only near fine-pitch pads (current-paths.json is the gate).

## 5b. Status

| Date | Step | Result (DRC with parity on a copy, tools/router/write.py) |
| --- | --- | --- |
| 2026-10-31 | core v0: exact-geometry A*, plane fan-out, return vias, sequential + reorder passes | NET-CORE from hand.kicad_pcb (pairs + crystals locked, zones copied from the canonical board): 576 tracks, 244 vias in 37 s; DRC 2 (starved_thermal), unconnected 45 (18 nets not finished), parity 0 |

| 2026-10-31 | core v1: PathFinder (soft routed copper, present cost capped at 8, history 0.3/iteration, rip-up of involved nets only), plane fan-out negotiated per plane net, enclosed start component reported and skipped | NET-CORE: not converged after 30 iterations (806 s): conflicts plateau at 3-4k, all in the PHY / RMII field (ETH_*, CH_DVDDK, J2 LEDs, VDD_CORE). Input defects found: C14.1 (VCC_1V8) is walled in by the hand-routed OSC24 crystal loop (0.65 mm gap, a via needs 0.9 mm); the GND exposed pads of U7/U8 at (131, 140) and (149, 140) have no fan-out site (they need vias in the pad, a viapads exemption) |
| 2026-11-01 | core v2 (branch claude/router-converge): overuse = exact end-of-iteration audit of all routed copper (plain rule, both sides of each conflict get history, rip-up set = nets still in conflict); present cost uncapped (x1.5 to 1000); fixed-copper verdict memoized per rule profile (fixed / routed index split); joins searched in the net box + 5 mm, flood fill proves "no path", walled-in components remembered; best iteration restored and the fewest nets ripped when not converged (written copper always legal); rule fixes: via vs fast track keeps plane clearance and hole-to-copper (v1 checked these only from the track side), diagonal-step midpoint checked (0.003 mm bulge), track ends only inside the pad's inscribed ellipse (bbox corners of round pads), own fan-out via per plane-net pad | NET-CORE, same machine: v1 30 iterations 2822 s, not converged (routing-time conflicts 5443 -> 3-4.6k), 13 nets failed, DRC 6 (clearance 2, starved_thermal 4), unconnected 18. v2 80 iterations 125 s (iteration 1: 9 s vs 72 s): audit pairs 3431 -> 873 (it 5) -> 106 (it 14) -> 12 (it 28), then a 2-net standoff at U8 pins 9/10 (CH_DVDDK escape vs VDD_3V3 fan-out via, 0.5 mm pitch); graceful end rips CH_DVDDK: DRC 3 (starved_thermal), unconnected 3 (CH_DVDDK + the two known input defects), parity 0, audit hard 0 |
| 2026-11-01 | core v3 (branch claude/router-v3 = v2 + the two features of claude/router-thermal, re-implemented): hole clearance, hole-to-hole and plane clearance read from the model `hole_rules` (flags override, new --hole-clr); thermal spoke channels from the model `zones` reserved as fixed copper of the pad's net (Kind::Spoke: in the memoized fixed-copper verdict, never a pin), forced fan-out track at pads short of spokes, short pads in the notes | NET-CORE (model regenerated with the thermal-branch model.py: hole-clr 0.28, hole-to-hole 0.45, plane-clr 0.25): without spokes the OUT.json is byte-identical to v2. With spokes: 222 channels reserved, 6 forced fan-out tracks, 5 pads short (fixed copper); 80 iterations 111 s, audit pairs 2818 -> 906 (it 5) -> 69 (it 10), same 2-net standoff (CH_DVDDK ripped). write.py: DRC 3 (starved_thermal 3) -> 1 (C28.2, input copper), unconnected 3 (same nets), parity 0 |
| 2026-11-01 | core v4 (branch claude/router-v4): gate findings made hard rules. DRU via_count per net with the locked input vias counted (max 0 = one layer; over budget = vias priced x10 / x100, then none; else a named fail). RP-001: a via site with no possible GND site within 2.0 mm is no legal layer change; the return via is placed with the join (negotiated, an existing GND via counts), a rejected transition bans the site and the join reroutes; end-of-iteration and final return audits. si_planes: every checked net (model plane_ref: not ground, power or exempt) keeps the plane clearance from foreign drilled items on the layers in model `adjacent`. Power: model min_width per current-paths chain (tools/pcbtool.py IPC formula, dT and stackup thickness), floored at the board min track width; no neck below it. Track ends 0.01 mm inside the copper (the v3 "no copper path" items: ends on the pad edge, which pad.HitTest excludes). Weighted A* without reopening (v3 reopened each cell about 28 times: /J2_LEDG_A hit the 8 M pop cap on 0.3 M cells). Stop when only unchanged hard fails stay for 3 iterations | NET-CORE b4f1cbd0 (crystals locked): converged in 16 iterations, 62 s, failed 0; write.py: DRC 0, unconnected 0, parity 0. Gate: drc_errors 0, unconnected 0, planes_failures 0, pairs 0, viapads 0, kicad_happy 0, port labels 0, paths_low 2 (no LOW pair; ETH_AVDD and VCC_1V8 are missing from current-paths.json: input). v3 on 61149d08: 232 s, failed 1, DRC 3 (too_many_vias), planes 6, paths_low 7, kicad_happy 1 |
| 2026-11-01 | core v5 (branch claude/router-v5): pour model and KiCad starved_thermal as a negotiated rule (core/src/pour.rs). Outer pours filled on a 0.025 mm grid as KiCad fills them (clearance + min_thickness / 2 erosion, relief gap, spokes only where the KiCad spoke test point is fill, DRU zone clearances via model `net_clearance`), 4-connected pieces, items per piece (pads, vias, track ends); KiCad rule: a spoke into a single-connection piece is ignored, track spokes, custom pads need their proxy spokes. A fault = conflict of the routed wall nets: door history on their cells (0-1 search from the spoke test point to a via / track end of the net) and re-route; after 3 iterations the door path is reserved as pour (hard door); final check + strict fallback; remaining faults are failed. island_removal_mode (0, always) read and reported: it removes only pieces with no item, so it does not change the rule. model.py adds pad shape / spoke angle / proxy_spokes, zone island settings and net_clearance | Pour model vs KiCad DRC (iotroute --check): v4 failing board finds only C46.2 (1 spoke + 2 to an island, the KiCad text); 1faf8ad8 and both v5 boards: 0. NET-CORE b4f1cbd0 + 1faf8ad8 current-paths (v4: starved_thermal 1 at C46.2): fault from iteration 13, hard door at 15 (wall /ETH_TXD0), converged iteration 21, 86 s; write.py DRC 0, unconnected 0, parity 0; gate all 0. b4f1cbd0 alone: 73 s, no fault, DRC 0 / 0 / 0. 11 unit tests |
| 2026-11-01 | M2 (branch claude/router-m2, 3828f343): H7-CORE re-route from the rev A placement, pairs + crystals locked. Fixes: via in pad for gate viapads-allowed pads (model `via_in_pad`); return via = GND net via (not 0.45 / 0.2); RP-001 radius and counted items from the board gate (model `return_rule`, kicad-happy formula: H7-CORE 1.0 mm, GND vias only); reserve-then-route for RP-001 rejects; fixed returns for locked input vias. 16 unit tests | H7-CORE final: 489 s, not converged at 80 iterations (2-net standoffs at the 1.0 mm radius), end step re-routes the last net; write.py DRC 1 (starved_thermal J2.18 B.Cu: pour model says pass, the same mismatch as run 1 at J2.16: stopped), unconnected 0, parity 0; gate other counts 0, kicad-happy 0 with no exemptions (existing route: 19 exempted). Length 4736 vs 6308 mm, vias 683 vs 526. Report reports/2026-11-01-m2-h7-core.md. NET-CORE regression: 52 s, DRC 0 / 0 / 0, gate PASS |
| 2026-11-01 | M3 + M4 integration (branch claude/router-integration): `run.py` (model -> iotroute -> write.py -> own KiCad DRC with parity on the saved fill; binary cached per sha256 of the core sources, `--bin` must not be older than its sources; `--lock-from` keeps pair + via_count 0 copper), `tools/pcb route --router iotroute` (same flow as route-json, policy iot-lab.iotroute-policy.v1), `compact_cli.py --router iotroute` (score = DRC + unconnected + parity + gate, placer/iotroute_step.py; Fastroute stays default) | NET-CORE main board, lock-nets: FAIL 1 1 0 (starved_thermal U8.6, /CH_DVDDK open: the known U8 standoff), 1527 mm, 295 vias, 338 s; same result in the pcb route snapshot (deterministic). keep all: PASS, gate all 0. Compaction step 0 (81 parts moved, max 3 mm): DRC 0, unconnected 1 (/CH_DVDDK), 1495 mm, 279 vias (committed route: 0 / 0 / 0, 1495 mm, 280 vias); gate not run (DRC part 1) |
| 2026-11-01 | core v6 (branch claude/router-v6): pour model = KiCad fillCopperZone (spokes eroded with the fill as one union; thermal pad drill cut after re-inflation; Dijkstra door, hard door only over the blocked part); octilinear string pulling; shared GND returns (hand-over on rip-up, multi-via site choice, prune); `--via-cost` / `--ret-cost`; plane antipad web = 2 x plane zone clearance + zone min_thickness (source: the In1/In2 zone settings and the KiCad min-width prune; priced by default, `--web-hard 1` rule: the rule did not converge on NET-CORE twice); power nets at class width, neck only in pad-entry zones; t1 fixes (roomiest locked-via return site, pour-model pre-check for forced fan-outs, straight track-spoke fan-out, fixed via in viapads-allowed pads, end-step rip-up cascade). 28 unit tests | `--check` agrees with KiCad on M2 runs 1 / 2 / 4 / 6 and the 5 NET-CORE reference boards. H7-CORE build 9407dcbf: converged it 35, 731 s; DRC 0 / 0 / 0; gate all 0 with no kicad-happy exemptions (existing: 19); 563 vias (v5 683, existing 526); 0.0 % length off 0/45/90 (v5 80 %); PWR under class width outside a pad entry 0 (v5 40, existing 151). HEAD on H7-CORE (--web-hard 1): not converged, /SPI_SCK + VDD_3V3 open, RMII length 52.6 > 50 (Net.max_len not routed). NET-CORE committed compact, lock-from (t1): DRC 0 / 0 / 0, gate PASS (v5: starved_thermal U8.6 + /CH_DVDDK open). Report reports/2026-11-01-v6-h7-core.md |
| 2026-11-01 | core v7 (branch claude/router-v7): convergence. Diagnosis tool `IOTROUTE_DIAG=<iteration>` (conflict pairs with history, strict-route check, single nets whose removal opens the route). Standoff cause: history went on one cell per conflict sample, the loser moved one pitch; return vias were placed after the search and their conflicts never priced; the same net always moved. Fixes: history on the keep-out of each conflict (and on the owner's signal vias for a return via in conflict); rip-up order fewest moves first; conflict-free return vias in route_net (ban of the via sites within one via radius, v6 rule after 8 rejections); end-step third-net repair; DRU length a hard A* bound (model `via_length` = F.Cu-B.Cu stackup height per via, as KiCad counts it) with a shortest-path fallback and a final guard; priced web query reach cut (same result, t1 CPU -17 %). 34 unit tests | Same binary, default flags: H7-CORE rev A (M2 locked set) converged it 29, DRC 0 / 0 / 0, gate PASS with no kicad-happy exemptions, 556 vias, RMII 43.8 / 50 mm; spread NET-CORE converged it 43, DRC 0 / 0 / 0, gate PASS (v6 HEAD: /ETH_TXD0 open); NET-CORE lock-from (t1) converged it 13, DRC 0 / 0 / 0, gate PASS. Same input twice = byte-identical result. ESP32-CORE lock-from (unseen): see report. Report reports/2026-11-01-v7.md |
| 2026-11-01 | core v8 (branch claude/router-v8): unseen boards. Fix 1: per-layer current width (model `min_width_layers`; the paths gate rates each piece with its own layer copper) and the rated pin escape of the paths gate (model pad `escape` from tools/pin-ratings.json with pcbtool.footprint_pin_rating + pin_escape): a rated pin necks to the pad's narrow side for the length the pad geometry needs, capped by the escape length, merged into one piece from END_IN inside the pad; a power pad in no power chain necks like a signal pad; the full width is checked at neck boundaries. Fix 2: rule areas (board and footprint keepouts: tracks per layer, vias) as fixed rules; DRU disallow by item type. Fix 3: third-net repair of a plane net only near pads with no fan-out via. Fix 4: fan-out via sites out to 3 mm when 2 mm has none. Fix 5: board edge = Edge.Cuts outline segments. Later: full width kept in an escape zone where it fits, escape start on a 0.01 mm lattice in a rect pad, leaf pads of a power net joined last, power-net via drill sized for the net current (pcbtool.via_amps). run.py copies schematic sub-sheets | **Acceptance not met (timebox).** ESP32-CORE (unseen, lock-from): v7 DRC 11 / 8 -> core b5 run b6 DRC 0 / 0 / 0, gate all 0 except paths_low 1 (kicad_happy 0 with no exemptions). Core b7 (final commit): both NET-CORE cases PASS (deterministic), BASE-PWR-C (second unseen) DRC 0 / 0 / 0 with all routing gates 0 (kicad_happy 2 = DC-002 design exemptions), but ESP32-CORE ends in a GND standoff (DRC 1, 3 open) and H7-CORE gets DRC 0 / 0 / 0 with paths_low 2 (core b5: paths_low 2 too; v7 PASS). POE-ETHERNET and other isolation boards: model stops on DRU creepage. reports/2026-11-01-v8.md |
| 2026-11-01 | core v8b (branch claude/router-v8): pin escape by construction. A rated pin (model pad escape, tools/pin-ratings.json) has no neck zone; its only narrower entry is one straight stub from inside the pad (any angle, at most the pad's long side, the pad's narrow width, legal against fixed copper), offered to the A* as extra source / target cells and priced like the cells under it (the paths gate pin_escape rule by construction). Leaf phase offers no source stubs. model.py: a plane-net pad of a chain that one net via cannot carry gets a larger fan-out via (pcbtool.via_amps). Fan-out: a forced fan-out ray goes on past a site in via conflict and may end on a via of the net that stays; a normal fan-out with no free site may end on such a via (IOTROUTE_DIAG: the ESP32-CORE GND standoff was two forced U12 fan-out vias in one column, GND against GND, no other net named). 49 unit tests | **Acceptance met with one binary (c6), except ESP32-CORE byte determinism (2 runs: same copper, via list order differs)**: ESP32-CORE (unseen, lock-from) converged it 31, DRC 0 / 0 / 0, gate PASS with empty kicad-happy exemptions (committed board: 9 RP-001); H7-CORE rev A converged it 27, 549 vias, DRC 0 / 0 / 0, gate PASS (v8 b7 paths_low 2), deterministic; spread NET-CORE (it 18, 254 vias) and NET-CORE t1 DRC 0 / 0 / 0, gate PASS; BASE-PWR-C route byte-identical to v8 b7 (routing checks 0). reports/2026-11-01-v8.md section v8b |

Next (was): negotiated congestion (PathFinder: shared cells with present + history cost, rip-up of all nets per pass) to
finish the 18 nets; F.Cu spoke channels at GND pads (starved_thermal); read hole clearance from the model rules.

## 6. Not in scope (first version)

Length matching by meanders, BGA escape, push-and-shove interactive editing. Added only when a board needs them.
