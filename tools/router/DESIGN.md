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

Next (was): negotiated congestion (PathFinder: shared cells with present + history cost, rip-up of all nets per pass) to
finish the 18 nets; F.Cu spoke channels at GND pads (starved_thermal); read hole clearance from the model rules.

## 6. Not in scope (first version)

Length matching by meanders, BGA escape, push-and-shove interactive editing. Added only when a board needs them.
