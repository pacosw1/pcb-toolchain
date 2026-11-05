# iot-lab router (in-house, rule-native)

Status: design (2026-10-31). User decision: "we really need to make our own autorouter with our knowledge and tools
and stop relying on others". First proof board: NET-CORE (branch claude/t113-net-core).

## 1. Why

- Fastroute is a closed binary. Our `.kicad_dru` rules must be translated into its DSN model, and
  `iotroute` rule coverage correctly refuses to launch it when a rule cannot be proved there (NET-CORE 2026-10-31:
  via size, pair, RMII, crystal and In2 layer rules all "unsupported").
- The rsixel A* router and Freerouting do not know our pair, RMII, return-via (RP-001) or current-path rules.
  Every board then ends in hand fixes (H7-CORE, ESP32-CORE, NET-CORE).
- A router that reads our rules as its own model needs no DSN proof: the constraint it routes with is the constraint
  the gate checks. What it still needs is admission: `iotroute model` refuses by name each native rule it does not
  hold (`core/src/model/coverage.rs`), and `iotroute route` and `iotroute run` stop there, before routing.

## 2. Acceptance (unchanged)

The router result is a proposal. A board is done only when KiCad DRC with `--schematic-parity` and
`node tools/gate.mjs BOARD` report every count 0. The router's own report is never evidence.

## 3. Inputs (read natively, nothing translated)

| Source | Used for |
| --- | --- |
| `.kicad_pcb` (pcbnew) | outline, pads (shape, layers, net), footprints, existing copper (locked), zones |
| `.kicad_pro` net classes + board setup | widths, clearances, via 0.6 / 0.3 minimum |
| `.kicad_dru` (parser of rule_coverage) | per-net / per-class clearance, width, pair width / gap / skew / uncoupled / via count, length, via count, layer disallow |
| `.kicad_dru` pair rules (core/src/model/pairs.rs, 2026-11-01) | clearance / creepage / hole clearance that read both items (class pairs, net pairs, footprint members, `A.X != B.X`, `intersectsCourtyard` / `intersectsArea`): clearance groups + pair table, KiCad order (last match wins, both orders); creepage as a straight clearance (safe form) |
| `diff-pairs.json` | pair membership, impedance target, reference |
| `rp001-fast-nets.json` + gate `route_features.rule_compiler.extra.deny_layers` | layer policy (fast + power off In2) and return-via obligation |
| `reference-planes.json` | plane layers (no tracks), plane nets (pad vias instead of routes) |
| `current-paths.json` | minimum width along each power chain |
| `thermal-vias.json` (optional, 2026-11-02) | via array in an exposed / thermal pad: count along the long / short side, pitches, drill, diameter, datasheet source; the pad must be on gate `viapads.allow` |

## 4. Architecture

```
tools/router/
  core/src/model   `iotroute model`: board + rules -> RouteModel (JSON): layers, obstacles, nets, pins, per-net rule set
  core/src/kicad   KiCad 11 IPC API client (protos pinned in core/proto) and the geometry pcbnew gave: boards are read through it
  rules.py      .kicad_dru -> per-net constraints (reuses rule_coverage forms and conditions, three-valued)
  core/         Rust crate (our code): multi-layer grid A*, negotiated congestion (PathFinder), via cost,
                per-net clearance halos, layer masks, length / via-count limits, pair centerline mode
  plan.py       stage order: pairs + crystals -> plane vias (+ return vias) -> power (width per current path,
                neck at fine pitch) -> fast nets (outer layers) -> slow nets (In2 allowed) -> rip-up / reroute
  iotroute write  RouteModel result -> tracks / vias into a copy of the board as text, then kicad-cli refills and saves; locked input copper untouched (core/src/write.rs, replaced write.py 2026-11-04)
  core/src/run     CLI: iotroute run BOARD OUT.kicad_pcb; model, core, write, then DRC
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
| M0 model | `iotroute model` (first `model.py`) builds the RouteModel for NET-CORE; every DRU rule maps to a constraint or an explicit "not routed by this stage" |
| M1 NET-CORE | the router routes NET-CORE from the placement (pairs included); gate all 0 |
| M2 comparison | re-route H7-CORE or ESP32-CORE from placement; gate all 0; compare vias / length / time with the hand + Fastroute result |
| M3 default | `tools/pcb route --router iotroute`, the only router. Fastroute was removed on 2026-11-05 (section 5b) |

## 5b. Fastroute removed (user decision 2026-11-05)

Fastroute is a closed third-party binary. `iotroute` is the only router going forward; the cross-check role that M3 kept for
Fastroute is gone too. Removed: `pcb route --router fastroute`, `iotroute fastroute` and its job, `FASTROUTE_BIN`, the DSN and SES
code and the rule-coverage proof of the DSN model. `iotroute route` keeps its staged plan, stage checks and pours; a `route.json`
with `"backend": "fastroute"` stops with a named error until that runner has an iotroute backend. Old sealed Fastroute records
stay readable in placement outcomes.

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
| 2026-11-01 | core v9 (branch claude/router-v9): length recovery. Diagnosis tool `IOTROUTE_LENDIAG` (per net: objective now / strict / with fixed copper only, and the blocking nets). Cause: a net keeps a detour (around a net that later moved, or around history) once the copper is legal; nothing re-routes it. Fix: after a legal end state each routed net is routed again strictly with the history off and an admissible heuristic, kept only when legal (audit, RP-001 returns, pour faults) and its A* objective falls by more than one grid pitch (`--recover 0` skips it). Determinism: run.py `--lock-from` kept random KIIDs from `Duplicate()` (KiCad saves tracks sorted by KIID: the copper order changed per run); now the source KIID; write.py seeds the KIID generator from the input and result bytes. 51 unit tests | **Partly met.** Same binary, all DRC 0 / 0 / 0 and the v8 gate result, all shorter: hand NET-CORE 1592.9 -> 1558.6 mm, 285 -> 280 vias (target 1495 not reached: RMII nets held by other nets, antipad web price, model rules after v4); dense placer step A4 1645.2 -> 1614.8 mm; ESP32-CORE 4007.9 -> 3898.2 mm, 488 -> 459 vias; H7-CORE 4773.9 -> 4648.0 mm, 553 -> 517 vias; spread NET-CORE 1568.5 -> 1529.6 mm; BASE-PWR-C 2387.0 -> 2336.5 mm (kicad_happy 2 = DC-002 design exemptions, as v8). ESP32-CORE and hand NET-CORE twice: input copy, route.json and board byte-identical. Recovery costs 405-484 s on H7 / ESP32. reports/2026-11-01-v9.md |

| 2026-11-01 | partial re-route (branch claude/router-reuse): `run.py --reuse PREV` starts from the copper of an earlier route and routes only what the moved parts affect (section 5c); placer repair mode `reuse` (default) | NET-CORE, 4 repair-like cases on the passing PR #79 step 0 board (1-2 parts / one 8-part block moved 0.5-1.0 mm): all 4 reuse routes DRC 0 / 0 / 0 + gate PASS, core 14-48 s against 148-188 s for the full route of the same moved board (run.py total 36-66 s against 158-206 s, 9 processes on the Mac); length +2.4 to +15.7 mm (+0.2 to +1.1 %), 2-9 vias fewer. Same input 3 times: byte-identical route.json and board. `--reuse` off: hand NET-CORE and ESP32-CORE lock-from byte-identical to main (v9). PR #79 placer run with the reuse repair: 14.0 min (PR #79 21.6 min by file times), steps s 0.637 and s 0.542 pass with their first repair proposal (PR #79: s 0.637 and s 0.694 failed), gate PASS on the chosen and repaired boards; compaction steps keep the full route (50-63 % of parts move). reports/2026-11-01-reuse.md |
| 2026-11-01 | congestion map (branch claude/congestion-map): `--congestion MAP.json [--cong-cell 1.0] [--cong-free 0|1]` (core congestion.rs), written after OUT.json; run.py writes `OUT.iotroute/congestion.json` (free routes on) only with `--congestion` or env `IOTROUTE_CONGESTION=1` (lead review: opt-in, about 4 s per call; placer repair rank `hot` turns it on). Section 5d | 36 NET-CORE routes (placer steps of PR #76-#80 + hand + spread): map 4 s median (<= 2.8 % of the route), the 6 v9 routes byte-identical with the map on. Step 2 diagnosis: no map quantity ranks the residual of the PR #78 MST fit at 0.5 or more (n 27; best: track length over capacity, squared, 0.35-0.44; the previous step's history at the pads 0.05-0.32); the PathFinder history at the open is in the top 9 % of the signal pads in 7 of 8 failed routes (1-2 mm cells; the 8th: walled in by fixed copper). No search cost term; placer repair rank `hot` (opt-in). NET-CORE PR #80 placer run + `--repair-rank hot`: the same proposals and boards as PR #80, chosen step 0 1485.6 mm / 286 vias, DRC 0 / 0 / 0 + gate PASS: **not shorter**. Hand NET-CORE t1: route.json and board byte-identical to main. reports/2026-11-01-congestion.md |
| 2026-11-01 | isolation boards (branch claude/router-isolation): DRU pair rules natively (pairrules.py: clearance groups and pair table resolved the KiCad 10 way, checked with kicad-cli on test boards; creepage in the safe form; region relaxation for routed copper; core `Shape.grp`, pair value in every clearance test, partner indexes, isolation history halo). Isolation-board fixes: plane reach (a ground is a plane net only where its zones reach its pads; fan-out vias inside the plane), return ground per net and no layer change without a legal return, opt-in `run.py --return-exempt`, parallel current copies (current-paths `parallel`), exact ring rule areas, spoke channels not in pour keepouts, plane-rule nets out of pour-keepout voids. reports/2026-11-01-isolation.md | **Partly met.** Model: POE-ETHERNET / RELAY-4 / INPUT-4D2A MODEL ok (before: FAIL unknown 2 / 5 / 3). INPUT-4D2A: DRC 0 / 0, gate parity 0, every gate count 0 except planes 3 (plane fill edge at the screw holes), kicad_happy 0 with empty exemptions. POE-ETHERNET: DRC 0, unconnected 1 (J1 standoff of one-layer POE nets), gate planes 1, kicad_happy 0 (committed exemption), barrier check PASS; earlier core without returns 0 / 0 / 0. RELAY-4: model ok, mains parallel copies route; not converged in 45 min (33 nets: SELV / 24V against FIELD_GND return and fan-out vias, not isolation pairs); end state DRC 0, unconnected 25. Hand NET-CORE and ESP32-CORE lock-from byte-identical to main (route.json and board, final core). 73 cargo tests |
| 2026-11-02 | plane fill edge (branch claude/router-plane-edge): the planes gate reference rule as a fixed rule. model.py `reference_fill` refills the zones of the router input with KiCad's ZONE_FILLER (in memory, as si_planes) and writes `ref_fill`: per outer layer of reference-planes.json `adjacent`, per domain, the filled polygons of the domain ground (+ alt_refs with no cap_mm, not slow_only) on the adjacent plane, the own-net anchor discs (pad: max size / 2, locked via: d / 2; + via_allow_mm) and net `ref_domain` (si_planes.net_domain). Core reffill.rs: domain in pflags bits 2..7; Board::track_fixed_code blocks a track centre of such a net on an `adjacent` layer outside its domain's fill (margin = the gate's 0, + the routing EPS), except inside one net's anchor discs (fixed code n; two nets = MULTI, stricter); inside / outside / mixed buckets of 0.25 mm, exact even-odd in mixed buckets. Not modelled (stricter or out of scope): exempt areas, cap_mm / slow_only alt_refs, the detour budget (every crossing is avoided), routed In2 tracks on a mixed layer. 75 cargo tests, test_model 7 | INPUT-4D2A lock-from: converged it 10, PASS 0 / 0 / 0, 1233.4 mm, 165 vias (isolation run: 1237.3 mm, 165); gate in the clean origin/main worktree: planes 0 (was 3), all other counts 0 except kicad_happy 10 = the 10 committed RP-001 exemptions now STALE (every exempted net got its return); with an empty exemption file gate PASS. Hand NET-CORE lock-from: route changed (26 nets; 1179.8 vs 1202.3 mm, 266 vs 264 routed vias), PASS 0 / 0 / 0, gate PASS: the rule removes 52.6 mm2 per outer layer (GND thermal / antipad rings) from the search from iteration 1; main's route used none of it at the end. FW-IO from the PR #85 placement: PASS 0 / 0 / 0, gate PASS (route changed: 657 / 146 vs 648 / 145). ESP32-CORE lock-from: route changed (77 nets, 455 vs 443 routed vias, it 19 vs 31), PASS 0 / 0 / 0, gate all 0 except kicad_happy 9 = the 9 committed RP-001 exemptions STALE (empty exemption file: PASS, as v8b). INPUT twice: byte-identical. reports/2026-11-02-plane-edge.md |
| 2026-11-02 | layer negotiation (branch claude/router-layer-negotiation, core `layers.rs`): a one-layer net (DRU via_count budget 0 with the locked vias counted, or no legal RP-001 return for any of its vias) whose fixed items all have copper on 2 or more routable layers chooses its layer as a whole: it is routed once per candidate layer (all joins on it) and keeps the lowest A* cost x (1 + layer history), ties to the lower layer; a wall on one layer marks no `dead` proof; no single layer joins it = routed as before. Layer history: each iteration that ends with the net in conflict adds --hist to the layer its copper is on (Grid `lhist`). No model.py change. 77 cargo tests (4 new in tests_layers.rs) | **Partly met.** POE-ETHERNET `--return-exempt`: the POE nets are in the conflict set in 5 iterations (main 5239249c: 37, iterations 4-40) and never after iteration 9, but the run ends as on main: DRC 0, unconnected 1 (VDD_3V3A), parity 0. The remaining standoff is the PHY field return vias, not one-layer nets: the same core with no return obligation converges at iteration 7 (0 failed); power nets exempt (the kicad-happy RP-001 scope skips VDD_*): 1 open (/MOSI); all four POE nets forced to B.Cu (the hand board): not converged. Hand NET-CORE and ESP32-CORE lock-from and FW-IO byte-identical to main. reports/2026-11-02-layer-negotiation.md |
| 2026-11-02 | RP-001 in the gate's scope + exempt areas (same branch, after PR #94): model.py `return_scope` (tools/router/rpscope.py runs the gate's own kicad-happy a6bba1a net filters: analyze_pcb.py:3925 is_power_net_name / is_ground_name with the schematic power rails, emc_rules.py:3900 _is_power_or_ground) adds the nets the gate never checks to `return_exempt`; reference_fill: a net listed in a spec exempt area gets its own domain = fill + boxes (pcbnew union, no seam) | **STUCK on POE-ETHERNET.** hand NET-CORE PASS 0/0/0 (1113 mm, 264 vias), gate PASS; ESP32-CORE PASS 0/0/0 (477 vias), gate PASS with an empty exemption file (committed file: 9 stale RP-001 exemptions); FW-IO PASS 0/0/0, gate PASS. POE `--return-exempt`: FAIL 0/2/0: /ETH_CT is walled in by the PR #94 reference rule (stricter than the gate's D-124c screen, which passes the hand route's 1.5 mm stub at J1.3), /SCLK open after a J1 standoff. reports/2026-11-02-layer-negotiation.md section 6 |
| 2026-11-02 | reference rule in the gate's scope (branch claude/router-ref-gate-scope): model.py `ref_soft` = not si_planes.is_fast (fast patterns now loaded with si_planes.load_fast); core: a soft net is priced off its reference (x (1 + model `ref_cost`, default 3.0), string pulling keeps it on), not blocked; hard (fast) nets blocked as PR #94; run.py `ref_gate_rounds` runs the gate's own si_planes on the written board, raises the price of each soft net with a D-124c FAIL line (x10, twice), then sets it hard, and routes again (at most 4 rounds) | **STUCK on POE-ETHERNET.** INPUT-4D2A PASS 0/0/0, planes 0, gate PASS (empty exemption file; committed: 10 stale); hand NET-CORE and FW-IO PASS, gate PASS. POE: FAIL 0/1/0 after 4 rounds. /ETH_CT's only gate-accepted exit (B.Cu east from J1.3, 1.24 mm run, detour 0 as on the hand board) is held by VDD_3V3 (J1.11, B.Cu y 112.65); its 11.7 mm F.Cu alternative is rejected by si_planes; set hard, J1.3 has no exit. The J1 standoff of PR #98 again. reports/2026-11-02-ref-gate-scope.md |
| 2026-11-02 | thermal via arrays (branch claude/router-thermal-vias): optional board file `thermal-vias.json` (per pad: vias along the long / short side, pitches, drill, diameter, datasheet source). model.py `thermal_via_spec` refuses a missing source, a pad that is not an SMD plane-net pad on gate `viapads.allow`, a via under the board / net class / DRU via minimums, a pitch under hole-to-hole, a via disc not inside the pad copper (pcbnew HitTest); writes pad `thermal_vias` (exact centres). Core `fixed_vip_vias`: each spec via at its exact place as fixed copper of the pad's net before routing (a GND return site; the pour model and every rule see it as any fixed via); an illegal one is a note, never moved; the plane fan-out then adds no via. No file = model byte-identical. 82 cargo tests (2 new), 48 py tests (3 new) | FW-IO U4.9 (LM5164 Fig. 28 p.25: 2 x 2 in the EP, 1.27 / 1.10 mm, 0.3 / 0.6 mm) lock-from: PASS 0 / 0 / 0, 4 vias in the EP (= spec; without the file 1), 150 vias (147), tracks byte-identical to the run without the file, converged it 8; gate --fresh PASS. Two runs byte-identical. NET-CORE and INPUT-4D2A lock-from: route.json byte-identical to the main binary on the same model, PASS 0 / 0 / 0, gate PASS (INPUT: with an empty exemption file, the 10 committed RP-001 exemptions are stale as on main). reports/2026-11-02-thermal-vias.md |
| 2026-11-04 | seeds and progress (branch iotroute-seed-checkpoint, core `seed.rs`, `checkpoint.rs`): `--seed`, `--checkpoint`, `--stall-passes`, section 5e. No new dependency. 92 cargo tests (10 new) | Flags off: route.json and written board byte-identical to main on CHECKIN-FRONT, ENV-SENSE, PWR-24V-5V, AC-24V. ENV-SENSE: no seed 0 / 1 / 0, 5 of 8 seeds 0 / 0 / 0. PWR-24V-5V: seeds change nothing. Checkpoint 0.04-0.17 % of the run |
| 2026-11-04 | model off Python (CIP #1331): `iotroute model` replaces model.py and pairrules.py. The board comes through the IPC API of the pinned nightly (kicad-cli-nightly api-server, commit in core/proto/PIN); the zone fill comes from a copy KiCad 10 refilled, read the same way, so fill, DRC and parity stay on KiCad 10. Equal to model.py on ENV-SENSE and PWR-24V-5V: every key and value, list order kept. kicad-happy stays a Python boundary (rpscope.py). |
| 2026-11-04 | run off Python: `iotroute run` replaces run.py (core/src/run), with its arguments, lines, exit codes and record. Locked inputs are a text edit saved by `kicad-cli pcb upgrade`; pads and poses come through the API; copper counts from the saved text. On ENV-SENSE and PWR-24V-5V, plain, --lock-from and --reuse: byte-equal boards to run.py. The planes screen is still si_planes.py. |

Next (was): negotiated congestion (PathFinder: shared cells with present + history cost, rip-up of all nets per pass) to
finish the 18 nets; F.Cu spoke channels at GND pads (starved_thermal); read hole clearance from the model rules.

## 5c. Partial re-route (`iotroute run --reuse`, core `reuse.rs`, user-approved 2026-11-01)

Why: every placer loop routed the whole board (NET-CORE 1-3 min, cores 25-30 min), but a repair proposal moves only
1-2 parts. A person fixes a board after a part move by re-routing the nets the move broke, not the board.

Input. `iotroute run BOARD OUT --pcb MOVED --reuse PREV [--reuse-fallback full|none]`. PREV is an earlier iotroute run result
(PREV.iotroute/route.json, bound to PREV by the board_sha256 of PREV.iotroute/result.json). iotroute run writes the seed
(work/seed.json, schema iot-lab.route-seed.v0): the tracks and vias of that route (with their roles), `moved_refs` (the
footprints whose position (> 100 nm), orientation or side differ between PREV and the route input; another part set
stops), `failed_nets` (route.json failed + the nets named in the error violations and unconnected items of
PREV.iotroute/drc.json) and `passes` (iterations of the earlier negotiation; for a PREV that was itself a reuse route,
seed passes + passes - 1).

Selection (core `reuse::load_seed`, after the fixed setup of the run: fixed returns, via-in-pad vias, forced fan-outs):
- a signal / power net is ripped up when it has a pad on a moved part, is in `failed_nets`, has a seed item that breaks
  a rule against the fixed copper of the new board (pads, locked copper, spoke channels, keepouts, board edge; the
  audit's plain rule, eps 0), or when its fixed items and seed copper do not form one component (open);
- every other net keeps its seed copper as routed copper of the net (owner = net). It is soft: when a ripped net
  conflicts with it, the negotiation rips it up like any routed copper. This is the step-by-step fallback;
- a plane net keeps each fan-out cluster (seed items that touch) that touches a pad of the net, touches no moved pad
  and breaks no fixed rule; iteration 1 fans out only the pads with no own copper (`Ctx::fan_keep`); later iterations
  re-fan the whole net when it is in conflict, as a full route does;
- a return via goes to the nearest kept signal via within the RP-001 radius (then the lower net index), else it is
  dropped; a signal via that lost its return makes its net re-route after iteration 1 (ret_missing, as before);
- seed vias that the fixed setup made again are not loaded twice; a lone plane-net via that touches no pad (a fixed
  return of a locked via that moved) is dropped.

Negotiation. Iteration 1 routes only the ripped nets and the plane re-fans. The present cost starts where the earlier
negotiation ended (0.5 x --pres-mult^(passes - 1), capped at --pres-max): the kept copper is the legal end state of
that negotiation. With the start price 0.5 the ripped nets crossed the kept copper and the conflicts spread (NET-CORE
C24 case: 4 ripped nets, 21 nets in conflict at iteration 4, core 90 s); with the end price: 4 iterations, 26 s. A
strict first route of each ripped net (kept copper blocks) was measured and removed: a failed strict search cost 20 s
for one net (PHY_LED2) and gave the same result. History starts at 0. Everything after the negotiation (graceful end,
cascade, third-net repair, RP-001 and pour end steps, return pruning) is the full-route code.

Length recovery: only the nets routed in this run and the nets with routed copper within `--reuse-near` (default
1.0 mm, a scope choice, not a rule) of a change box (moved pads, seed copper not loaded, new copper of a routed net).

Fallback (iotroute run). `--reuse-fallback full` (CLI default): a reuse result that is not PASS (KiCad DRC on the written
board) is compared with the full route of the same input; the result with fewer DRC errors + unconnected + parity
(then fewer core failed nets) is kept, a tie keeps the full route; result.json `reuse.attempts` and `reuse.chosen`
name both. `none` (the placer repair): the reuse result is the result; the repair rejects a proposal that is not
better, as before.

Acceptance is unchanged (section 2): DRC 0 / 0 / 0 with parity + gate on the written board. Same input = byte-identical
output (Vec order, seed order; the seed file is written with sorted keys). Without `--reuse` the core path is unchanged.

Not used for compaction steps: between NET-CORE compaction steps 50-63 % of all parts move (every movable unit; PR #79
run and the rank-by-length run), and 22-30 % of all nets (most routed nets) have a pad on a moved part; see
reports/2026-11-01-reuse.md.

## 5d. Congestion map (`--congestion`, core `congestion.rs`, user-approved plan 2026-11-01 step 2)

Why: the placer cost `w_mst` ranks the routed length (Spearman 0.82), but on dense steps the routed length grows more
than the MST, and dense steps fail in the board interior. The router knows where it negotiated; the placer did not.

Output (schema `iot-lab.route-congestion.v0`, JSON, written after OUT.json; it never changes OUT.json: the free routes
put the copper back). Square cells of `--cong-cell` mm (default 1.0) from the outline box corner (`origin`), row-major
(`nx` x `ny`). Per routable layer (`layers[]`, arrays of nx * ny):
- `free`: fraction of the sample points (step 2 x pitch = 0.1 mm, finer than the 0.15 mm narrowest track) where a
  default track (the most common signal width / clearance of the model: `track_w`, `track_clr`) is not blocked by
  fixed copper (pads, locked copper, keepouts, board edge);
- `occ`: fraction of the free points where routed copper (any net, plane fan-out included) blocks that track;
- `len`: routed track length in the cell (mm); `cap`: free x cell area / (track_w + track_clr), the length of parallel
  default tracks that fit (mm);
- `hist`: mean PathFinder history of the routing grid cells in the cell, summed over all iterations (0 when the run
  converged in iteration 1; a reuse route starts it at 0).
Per cell: `vias` (routed vias), `vhist` (mean via history). Per non-plane net with 2 or more pads (`nets[]`): pads,
pad bbox, routed track length and vias, the A* objective (`cost`, v9 net_cost), the Euclidean MST of the pad centres and,
with `--cong-free 1`, `free_cost` / `free_len` of the net routed alone (other routed copper off, history off, the v9
recover search) and `detour` = cost - free_cost; `failed` names a net in OUT.json failed. The alone route is one strict
A* per net: NET-CORE 4 s median under load, so iotroute run turns it on.

Cell size: 1 mm by data (reports/2026-11-01-congestion.md): the open signal holds at 1 and 2 mm (7 / 8 opens in the top
9 % of the pads) and is lost at 4 mm (0 / 8 over the 90th percentile): a 4 mm cell averages the hot area of a 0.5 mm
pitch IC with its quiet neighbours. The placer reads the history only (`tools/placer/core/src/congest.rs`).

Use (data, n 27 routed placer steps + 8 failed routes): the map explains where a route fails (history), not the length
residual; the previous step's map does not rank the residual and marks the next step's open only in part (4-6 / 8). So
there is no placer search term (no data source for its weight); the repair can rank its proposals by the history they
take away from the unit pins (`compact-cli.ts --repair-rank hot`).

## 5e. Seeds, checkpoint, early stop (`--seed`, `--checkpoint`, `--stall-passes`, core `seed.rs`, `checkpoint.rs`)

**Resume prototype (not yet validated for production):** `--resume-save FILE` saves negotiation state at nonterminal pass
boundaries; `--resume FILE` restores one. The same binary, model bytes, source identifier and routing flags are required;
the pass limit may increase. Resume and save may name the same literal, non-symlink path. `--reuse` is not supported.
Convergence or unchanged hard failures atomically replace the save with a terminal marker. Integrity checks detect accidental
corruption; they are not authentication. The counters measure elapsed wall and process CPU through each saved boundary,
excluding the current write, post-boundary finalization and time between invocations. Progress-file elapsed time is per
invocation. Resumed runs reject `--max-time`; an external supervisor must enforce a total deadline. The state file contains
full grids and can be large; overhead, physical-board replay, hard-door replay and return-via replay are not yet established.

Why: 5-8 short parallel runs on a 32-core box instead of one long blind run. The router had no seed and printed one line at
the end, so runs could not differ and nothing could see them.

`--seed N` changes prices and orders, never a rule. The fixed steps stay first and unseeded (returns of locked vias, fixed
VIP and thermal vias, forced fan-out tracks). Then:
- the base order is shuffled inside each class (plane fan-out, power, fast, slow); no net moves to another class. The rip-up
  order stays fewest moves first, then this base order;
- a smooth random field moves the A* cost of each routing cell and via site by at most 12.5 %, one field per routable
  layer and one for the vias. The length recovery and the DRU length search do not see it, and the history stays history:
  the congestion map and the checkpoint read no noise.

Order alone already varies the route, but the field gives copper less alike (see below). No seed: the field is empty, the
base order untouched, and the output is byte-identical to the unseeded core. The generator is SplitMix64; integer steps and
IEEE add, multiply and divide give the same field on Mac and Linux.

`--checkpoint FILE`, schema `iot-lab.route-checkpoint.v0`: pass 0 at the start (a path that cannot be written stops the run
there), one file after each pass, one at the end, each written to FILE.tmp and renamed. Fields: `state` running or done,
`stop` (converged, iters, max-time, hard-fails, stall-passes, cancelled), `seed`, `bind`, `pass`, `elapsed_s`, `unrouted`
(nets whose last search left them open), `conflicts` (nets to route again, audit pairs and samples, pour faults,
`search_limited`: nets stopped by the pop limit, so not proved blocked), `vias`, `wire_mm`, `best`, `passes_since_best`,
`worst_nets` (8: open first, then most conflict samples, with why), `hot` (8 cells of 1 mm, the DESIGN 5d size: conflict
pairs of this pass first, then history, with centre in mm and hottest layer). A file that stays `running` is a run that was
killed. `bind`: source (iotroute run sources_sha256, by `--source-sha`), binary, model file, rules and geometry hashes (the model
split by key, the `pcb` path in neither) and the flags. SHA-256 is a local function, no crate. The file only reads what the
pass knows, so it cannot change the route (a test and the board runs compare the bytes).

Stop. With --checkpoint, SIGTERM or SIGINT ends the negotiation at the end of the pass, as `--max-time` does: at a pass end
every net has its copper, so the best pass is restored, the strict end steps make it legal and OUT.json is written; the length
recovery is skipped. A second signal kills. Both bound the negotiation only: the pass under way and the end steps run on, and
on a big board these take minutes, longer than the 2 s `pcb` gives a job between SIGTERM and SIGKILL. iotroute run does not forward a
signal, so it reaches the core only when sent to the core itself or its process group. A run that is killed keeps its last
checkpoint and no route, so for a bounded job set `--max-time` under the job timeout.

`--stall-passes N` (default off): stop after N passes in a row that do not beat the best pass, and end as `--max-time` does. Best
= fewest nets in conflict, then fewest audit pairs: the score that picks the pass a run ends from, so a pass that does not beat
it would not change what an early stop keeps. The reason is in OUT.json `notes`, the ROUTE line (`stop stall-passes`), iotroute run
`stages.core.claim.stop` and the checkpoint. N under 4 can end a run before a pour fault gets its hard door (DOOR_STALL 3).
No default: the score cannot see the present cost rise, and a run can look stuck and still converge (AC-24V seed 5 below).

Replay: same binary, model, flags and seed give the same bytes, on Mac and Linux. Not equal: a run ended by `--max-time` or a
signal (the pass it ends at depends on the clock), and the checkpoint itself (`elapsed_s`). iotroute run's reference rounds route
again into the same checkpoint file, so it shows the last round. Seeds change the order of the lists in OUT.json, so
different bytes do not prove different copper: compare `tracks` as a set.

One unexplained case outside the core. In one daemon job, PWR-24V-5V's `iotroute run --lock-from` wrote its locked input with two
footprint keepout zones swapped (H3 / H5), for every run of that job. The model then differs only in that list order (so
`geometry_sha256` differs too) and route.json stays the same, but the writer seeds its KIIDs from that file, so the board has the
same copper with other UUIDs and track order. It did not come back: main's and this iotroute run gave the main board in 8 of 8 runs in
one folder of the route image (other OUT names included), and in serial, parallel and 1, 2 and 3 CPU runs. make_locked_input is not
touched here. If two boards of one input differ, compare route.json first.

Resume is not built. It needs the live copper with its owners and order (shape ids feed the audit and the search ties), return
and fan-out vias, the hard doors, hist / vhist / lhist (grid-sized, a binary file), present cost, moves, net states, the best
snapshot, the dead proofs and the stall counters; the RNG needs nothing, it is used only at the start. Those are locals of a
500-line loop, so it first needs that loop made a struct, and a test that a resumed run equals an unbroken one byte for byte.

Data (2026-11-04, routed on the Hetzner box; each board 8 seeds; DRC with parity through iotroute run on the job daemon). All seeds
converged in the core on all boards. Overlap = shared 0.1 mm copper points of two seeds over the smaller route, mean of 28 pairs.

| Board (footprints) | No seed: DRC errors / open / parity, vias, wire mm, passes | 8 seeds: DRC 0 / 0 / 0 | vias | wire mm | passes | Overlap, order only -> order + field |
| --- | --- | --- | --- | --- | --- | --- |
| ENV-SENSE (23) | 0 / 1 / 0, 30, 261.6, 7 | **5 of 8** | 22-29 | 256.0-266.8 | 7-11 | 0.50 -> 0.37 |
| CHECKIN-FRONT (14) | 0 / 5 / 0, 17, 214.8, 8 | 0 of 8 (open 3-8: GND items, the board has no zone) | 12-20 | 206.3-215.3 | 7-11 | 0.42 -> 0.37 |
| AC-24V (30) | 0 / 0 / 0, 10, 628.0, 5 | 8 of 8 | 9-12 | 609.5-625.3 | 2-20 | 0.74 -> 0.66 |
| PWR-24V-5V (29) | 0 / 0 / 0, 17, 106.0, 1 | 8 of 8 | 17 | 106.0 | 1 | 1.00: the same copper |

So seeds pay where nets contend and do nothing where they do not: PWR-24V-5V routes in one pass, and the length recovery
pulls every seed back to the same shortest copper. Best of 8 on ENV-SENSE turns an open board into a clean one; on length alone
the spread is small (2-4 %), on vias large. Not measured: a board the unseeded router cannot finish (POE-ETHERNET, RELAY-4),
which is where seeds matter most; those are over the 30-footprint limit of this work.

AC-24V seed 5 sat at 1 net, 1 pair from pass 2 to pass 19 and converged at pass 20 (226 s). With `--stall-passes 6` it stopped at
pass 8 (159 s) with the same counts: failed 0, 181 tracks, 9 vias. Longest run of passes with no progress in a run that converged:
17 on that seed, 2 on all other runs.

Defaults to tune (order + field against only the field or only the order, amplitude 0.25 / 0.5 / 1.0, lattice 1 / 2 / 4 mm, on
CHECKIN-FRONT and ENV-SENSE, 8 seeds each): the spread of vias and wire does not move with amplitude or lattice, so the smallest
amplitude and the 5d cell size. A field of added cost only ran 1.1-1.7 x slower than order alone on those two boards; with
mean 0 the times match within the noise of the shared box.

Cost: the checkpoint spent 0.04-0.17 % of the run (0.008 s of 7 s, 0.107 s of 190 s; own timer, hashes included). Flags off and
checkpoint on against main: inside the run-to-run noise of the shared box (5 pairs each: CHECKIN-FRONT 6.7 / 6.9 / 7.3 s,
ENV-SENSE 26.4 / 24.1 / 24.4 s).

## 6. Not in scope (first version)

Length matching by meanders, BGA escape, push-and-shove interactive editing. Added only when a board needs them.
