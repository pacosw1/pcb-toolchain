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

Next: negotiated congestion (PathFinder: shared cells with present + history cost, rip-up of all nets per pass) to
finish the 18 nets; F.Cu spoke channels at GND pads (starved_thermal); read hole clearance from the model rules.

## 6. Not in scope (first version)

Length matching by meanders, BGA escape, push-and-shove interactive editing. Added only when a board needs them.
