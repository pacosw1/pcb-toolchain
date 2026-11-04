# Router layer negotiation of one-layer nets (2026-11-02, branch claude/router-layer-negotiation)

Goal: a net that is restricted to one layer chooses its layer as a whole in the PathFinder negotiation, with history
cost, deterministic, so that POE-ETHERNET passes (the remaining blocker of PR #82, reports/2026-11-01-isolation.md
item 1). Benchmark only: scratch copies, committed boards not changed. Scratch: `scratchpad/rln/` (runs/, ref/,
noreg/, the core-only experiments `*.log` / `*.json`).

Result: **FAIL** for acceptance 1. The layer negotiation removes the POE-net standoff, but the POE run still ends
with one open net. Cause: return vias (RP-001) in the PHY field. This is not a one-layer-net standoff.

## 1. Change (core only, no model.py change)

- `core/src/layers.rs` (new). `Ctx::layer_choice(net)` finds a one-layer net: one of these must be true, and every
  fixed item of the net (pads, locked copper) must have copper on 2 or more of its routable layers:
  - the DRU via_count budget is 0 (`max_vias` <= locked input vias);
  - the net needs a return via but `ret_reachable` is false: the isolation pair value keeps every ground via out of
    the RP-001 radius. On POE-ETHERNET this is the 4 POE nets.

  For such a net, `route_one_layer` routes it once on each candidate layer, with all joins on that layer. It keeps the
  route with the lowest price = A* cost (the g of each join, summed: new `NetResult.cost`) x (1 + layer history).
  A route that joins all components always wins over one that does not. On a tie, the lower routable layer wins.
  A wall found on one layer does not set a `dead` proof for the net. When no single layer joins the net, the net is
  routed as before (one layer per join, through-hole pads join the layers). In the length recovery the history is off.
- Layer history (`Grid.lhist`, per net x routable layer). The audit runs at the end of each iteration. Each one-layer
  net that the audit finds in conflict gets `--hist` (0.3) on the layer of its copper (`Ctx::layer_hist`). A net that
  keeps losing on one layer then moves to the other layer as a whole, and it can move back later.
- `main.rs`: `mod layers`, the `route_net` dispatch, `best_g` / `out.cost` in `route_net_inner`, and one call after the
  audit. The Grid literals get `lhist: Vec::new()`.

## 2. POE-ETHERNET (`run.py POE-ETHERNET OUT --lock-from <committed board> --return-exempt`)

| Core | POE nets in the conflict set | Result (run.py: DRC / unconnected / parity) | Core time |
| --- | --- | --- | --- |
| main 5239249c (`runs/main-ret`) | 37 iterations (4-40) | FAIL 0 / 1 / 0, VDD_3V3A open (best iteration 58) | 382 s |
| branch (`runs/b1-ret`) | 5 iterations (5-9), never after | FAIL 0 / 1 / 0, VDD_3V3A open (best iteration 23) | 504 s |

Both runs end with the same conflict set from iteration 20 to 80: /ETH_CT, /ETH_RESET, /ETH_RX_BIAS, /LED_LINK_K,
VDD_3V3 and VDD_3V3A. `IOTROUTE_DIAG=20` (`diag1.log`) shows these conflicts:
- /ETH_CT at J1.3 is blocked by VDD_3V3 and /LED_LINK_K;
- /ETH_RESET and /ETH_RX_BIAS are blocked by VDD_3V3A;
- VDD_3V3A has no strict route even when any one other net is removed.

None of the conflict pairs has a POE net.

Experiments on the same model, core only, branch binary:

| Variant | Result |
| --- | --- |
| no return obligation for any net (`nr1`) | **converged, iteration 7, failed 0** (48 vias, 61 s) |
| VDD_3V3 and VDD_3V3A need no return (`pw1`). kicad-happy a6bba1a RP-001 skips power-named nets (`emc_rules._is_power_or_ground`: prefix `vdd_`), so the router is stricter than the gate here | not converged; best iteration 4 nets / 2 pairs; /MOSI open |
| all 4 POE nets forced to B.Cu (as in the committed hand board) (`allb`) | not converged; failed 2 (/POE_V2N, VDD_3V3A): /POE_V1N and /POE_V2N cross on one layer, and the router does not find the hand detour around U2 |
| `--ret-cost 3`, `--via-cost 6` (stopped at iteration 13-14) | the same PHY conflict set (a router knob is not the fix) |

Conclusion: the one-layer POE nets now negotiate their layer and leave the conflict set early. The blocker that
remains is the density of RP-001 return vias (PHY_GND, 1.0 mm radius) around U1 / J1. It is a router issue, with an
input part:
- VDD_3V3 is a routed net. Its In2 zones do not reach J1.11 / J1.13 (isolation report, plane reach), so all
  14 of its pads are routed as tracks through the PHY field.
- The router also places returns for power nets, which the gate does not ask for.

## 3. Gate (acceptance 2)

Not run. No routed board reached DRC 0 / 0 / 0. The known planes cause (/ETH_CT over the J1 no-plane area, D-124c)
is in reports/2026-11-01-isolation.md item 2.

## 4. No regression and tests

- Hand NET-CORE lock-from (`noreg/hand1`): lock copy, route.json and routed board are byte-identical to main
  5239249c (`ref/hand`), PASS 0 / 0 / 0, 280 vias.
- FW-IO (`run.py FW-IO OUT`, `noreg/fwio1`): PASS 0 / 0 / 0. route.json and board are byte-identical to main
  (`ref/fwio`).
- ESP32-CORE lock-from (`noreg/esp1`): lock copy, route.json and routed board are byte-identical to main
  (`ref/esp`), PASS 0 / 0 / 0, 459 vias.
- `cargo test --release`: 77 pass (73 + 4 new in tests_layers.rs):
  - one-layer nets are found (via_count 0, locked vias use the budget, SMD pads and vias-allowed nets are not);
  - the layer history moves the whole net to B.Cu and back, and the tries leave no copper;
  - a wall on one layer is no dead proof (with walls on both layers the net fails as before);
  - two crossing one-layer nets converge on different layers.
- KiCad Python `-m unittest test_run test_pairrules test_iso_board test_model`: 39 pass.

## 5. Next

The PHY-field return density is the next item. Each option below has data from section 2:
1. RP-001 scope: power nets need no return. This is the gate rule scope. It changes the other boards, so it needs a
   user decision and new noreg references.
2. VDD_3V3 as a partial plane net: fan out the pads inside its In2 zones and route only J1.11 / J1.13. This is a
   model.py change.
3. Price the return-via space in the negotiation (history on the return sites that the PHY nets fight over).

## 6. Follow-up (lead decision 2026-11-02): RP-001 in the gate's scope, rebase on PR #94

Rebased on origin/main 1c7bd0f6 (PR #94 plane fill edge: model `ref_fill`, core `reffill.rs`). The only conflicts were
the test module list and the DESIGN 5b rows. `cargo test --release`: 79 pass.

### 6.1 RP-001 scope (model.py + new tools/router/rpscope.py)

The gate drops a net from RP-001 in two places. Both decide by net name, plus the schematic power rails that the gate
passes in:
- kicad-happy a6bba1a `skills/kicad/scripts/analyze_pcb.py` line 3925 (analyze_layer_transitions):
  `is_power_net_name(name, power_rails) or is_ground_name(name)` (kicad_utils.py lines 1052 / 1135). The power_rails
  are statistics.power_rails of analyze_schematic.py (analyze_pcb.py lines 6567-6574). They are used because
  tools/kicad_happy_gate.py run_gate (lines 407-429) passes `<board>.kicad_sch` (resolve_board, line 87).
- `skills/emc/scripts/emc_rules.py` line 3900 (check_layer_transition_stitching): `_is_power_or_ground(net_name)`
  (line 65).

rpscope.py imports these functions from the pinned clone; it does not copy a list. It runs them with the gate's
interpreter (Python 3.10+, as tools/lib/env.mjs). model.py adds the nets those functions skip to `return_exempt` for
every board with a kicad_happy check, and writes them to `return_scope`. The skip lists, as the gate's functions
decide them:

| Board | Nets with no RP-001 return obligation |
| --- | --- |
| POE-ETHERNET | /1V2O, CHASSIS, ISO_GND, PHY_GND, PRIMARY_5V, VDD_3V3, VDD_3V3A |
| NET-CORE | /SW_3V3, ETH_AVDD, GND, LDOB_OUT, VBUS, VCC_1V8, VCC_DRAM, VDD_3V3, VDD_CORE |
| ESP32-CORE | /1V2O, /BZ_VCC, /VDD_3V3A, /VDD_RTC, 3V3_OUT, GND, USB_VBUS, VBAT, VDD_3V3, VIN_REG, VSYS_IN |
| FW-IO | 3V3, 5V, 5V_PG, GND, V24, V24P |

FW-IO 5V_PG is a power-good signal. The gate skips it anyway: emc `_is_power_or_ground` matches `^[+-]?\d+\.?\d*v`.
The router mirrors the gate, so 5V_PG also needs no return.

New route state. Committed boards are not changed. Gate = `node tools/gate.mjs BOARD --fresh` in a clean origin/main
worktree (5f677962):

| Board | run.py (DRC / unconnected / parity, length, vias) | Before (main, section 4) | Gate --fresh |
| --- | --- | --- | --- |
| hand NET-CORE lock-from (`runs/hand-2`) | PASS 0 / 0 / 0, 1113 mm, 264 vias | 1133 mm, 280 vias | PASS, all counts 0 (`gate-hand-2.txt`) |
| ESP32-CORE lock-from (`runs/esp-2`) | PASS 0 / 0 / 0, 1887 mm, 477 vias (not converged at 80 iterations, GND / VDD_3V3; the end step closed it) | 1843 mm, 459 vias | with the committed exemption file: kicad_happy 9, all of them STALE RP-001 exemptions (this route stitches those 9 nets), every other count 0 (`gate-esp-2.txt`). With an empty exemption file (as v8 / v9): PASS, all counts 0 (`gate-esp-2e.txt`) |
| FW-IO (`runs/fwio-2`) | PASS 0 / 0 / 0, 696 mm, 166 vias | 676 mm, 160 vias | PASS, all counts 0 (`gate-fwio-2.txt`) |

### 6.2 Exempt areas of the reference rule (model.py reference_fill)

After the rebase, the POE run had 3 hard fails from iteration 1: /ETH_CT, /LED_ACT_K and /LED_LINK_K were "not
reachable past fixed copper" at their J1 pads (`runs/b2-ret`). The same model without `ref_fill` gives 0 hard fails.
The cause is PR #94: "Exempt areas are not modelled (safe)". On POE that is not safe. The J1 box (WIZnet rule: no
plane under the RJ45) has no reference copper. The spec exempts /MAG_* and /LED_*_K inside the box, as
si_planes.evaluate does. The router walled them in.

Fix: a net listed in an exempt area gets its own domain = its ground's fill plus the boxes, as one exact union
(pcbnew SHAPE_POLY_SET BooleanAdd). The first version used separate polygons. That left a seam at x = 122.5, where
the box edge meets the fill edge, and the core's edge margin closed it (`runs/b3-ret`: the same 3 hard fails). Only
POE-ETHERNET has exempt areas. The NET-CORE and FW-IO models are byte-identical before and after this change
(`chk-nc.json`, `chk-fw.json`).

### 6.3 POE-ETHERNET result: STUCK

`runs/b4-ret` (`--lock-from`, `--return-exempt`, final model): **FAIL 0 / 2 / 0**, not converged.
- /ETH_CT is a hard fail: its J1.3 pad is not reachable past fixed copper.
- /SCLK is open after a /LED_ACT_K vs /SCLK standoff.
- VDD_3V3 is in the conflict set up to about iteration 20, then leaves it.

/ETH_CT: the router is stricter than the gate here, and the cause is in the reference rule of PR #94:
- J1.3 (119.69, 113.82) lies 2.8 mm inside the J1 box. /ETH_CT is not listed for the box. The own-pad allowance
  (pad radius + via_allow 0.6 mm) ends at x = 121.05; the fill starts at x = 122.5. So every exit has an
  unreferenced run of at least 1.45 mm.
- The router's rule (#94) allows no unreferenced sample of a checked net.
- The gate's enforced D-124c screen passes the committed hand route of /ETH_CT: B.Cu J1.3 -> (122.9, 113.83),
  run 1.5 mm. si_planes on the committed board gives `0 reference-plane failures`, with only
  `WARN D-124d-proposed unknown-driver B.Cu /ETH_CT ... longest run 1.5 mm at (121.8, 113.8)`, which is report-only.
- So "planes 1" now shows up as "unconnected 1".

Scratch experiment `runs/b5-ctx`: /ETH_CT added to the J1 box in a worktree copy of reference-planes.json, reverted
right after its model stage, never committed. Result: FAIL 0 / 1 / 0. /ETH_CT and /LED_LINK_K stand off at J1, and
/LED_LINK_K stays open.

Not done: the partial-plane model for VDD_3V3. It cannot clear /ETH_CT, which is blocked by fixed copper plus the
reference rule. VDD_3V3 also leaves the conflict set by about iteration 20 in b4.

Next. Each item is a decision for the lead or the user:
1. Reference rule (PR #94 owner): model the D-124c enforced screen, or at least its accepted stub / detour cases,
   instead of "no unreferenced sample". The router must never be stricter than the gate.
2. Or an input decision: add /ETH_CT to the J1 exempt area of reference-planes.json. /ETH_CT is a centre tap that
   leaves J1 like /MAG_* and /LED_*_K do. This is a committed spec change, so it is the user's call.
3. Then the J1 standoff (/LED_ACT_K or /LED_LINK_K against /SCLK or /ETH_CT), and if needed the VDD_3V3
   partial-plane model.
