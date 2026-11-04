# Router isolation boards (2026-11-01, branch claude/router-isolation)

Goal (user-approved 2026-11-01): the router models the DRU isolation rules natively (creepage, clearance between
two net classes / net sets / areas, isolation barriers) instead of stopping with `MODEL FAIL ... unknown N`.
Benchmark only: scratch copies, committed boards not changed. Evidence: KiCad 10.0 `kicad-cli pcb drc
--schematic-parity` (run.py / write.py) and `node tools/gate.mjs BOARD --fresh` in the detached origin/main worktree
`scratchpad/iso-main` (board copied in, then restored). Scratch: `scratchpad/iso/` (runs/, gate-*.txt, kt/ test boards).

## 1. Rule types found (POE-ETHERNET, RELAY-4, INPUT-4D2A, BASE-PWR-B, AC-24V, BACKUP-POWER, AIO, CHECKIN, IO-6X6, FW-CARRIER, PQ-METER-B)

| Rule type / condition form | Boards | Model before | Now |
| --- | --- | --- | --- |
| `(constraint creepage (min X))` with a class pair (`A.NetClass == 'P' && B.NetClass != 'P'`) | all 11 except FW-CARRIER | unknown (MODEL FAIL) | pair table, safe form (below) |
| creepage for named net pairs (`A.NetName == 'a' && B.NetName == 'b'`, OR of both orders) | POE, INPUT, AIO, IO-6X6 | unknown | pair table (exact resolution; usually a relaxation of the class creepage) |
| clearance for a class pair / class set (`(A.NetClass == 'F' \|\| ...) && (B.NetClass == 'H' \|\| ...)`, wildcards `'MAINS_K*'`) | all 11 | checked (ignored by the router) | pair table |
| attribute against attribute (`A.NetClass != B.NetClass`) | RELAY-4 | unknown | evaluated (pairrules.substitute) |
| footprint member (`A.memberOfFootprint('U3') && B.memberOfFootprint('U3')`, `!( ... )` exceptions) | INPUT, AIO, IO-6X6, BASE-PWR-B, BACKUP | unknown | evaluated per pad (track / via / zone: False) |
| spatial relaxation (`A.intersectsCourtyard('J1') && B.intersectsCourtyard('J1')`, a later rule) | POE | checked | region atom: pads / zones static (pcbnew Collide), routed copper in the core (below) |
| `B.Type == 'Pad' && B.Pad_Type == 'NPTH, mechanical' && B.Reference == 'H1'` with `hole_clearance` | RELAY-4 ('Mains to screw hole' 9.65 mm) | unknown | pair table (hole of H1 / H2 to mains copper) |
| `B.NetName != ''`, `B.NetName != 'unconnected-*'`, `B.Pad_Number == '3'` | BASE-PWR-B, BACKUP | unknown | evaluated |
| silk / courtyard / zone_connection with any selector | RELAY-4, INPUT, AIO, ... | unknown | checked (not a router item; KiCad DRC) |
| layer clause on a pair rule (`(layer inner)` 'Mains outer layers only') | PQ-METER-B | n/a | the larger of "applies" / "does not apply" on every layer (safe) |
| barrier rule area as a ring (outline + hole, no tracks / vias) | INPUT-4D2A BARRIER_BAND, RELAY-4 BARRIER_BAND | bbox (walled the whole host island) | exact outline and holes |

KiCad 10 resolution, measured with kicad-cli DRC on the test boards `scratchpad/iso/kt/t1..t4` (generator `kt/gen.py`):
- t1 / t2: of the matching rules of one constraint type the **last in the file wins** (not the largest): rule R (0.4,
  inside J1) after G (1.0) relaxes inside J1; R before G does not.
- t1 case 5: `intersectsCourtyard` is evaluated for the **whole item**: a long segment that touches the courtyard gets
  the relaxation along its full length.
- t3: the condition is tried with **A / B swapped**; a custom rule replaces the netclass clearance (0.12 mm passed with
  class 0.2); the board minimum clearance did not act as a floor for the custom rule (0.08 mm with min 0.1 passed).
- t4: **creepage is a surface path on one layer**: 1.0 mm straight with a 0.4 mm slot between (path > 2 mm) passed a
  2.0 mm rule; F.Cu against B.Cu at the same place gave no creepage error.

## 2. How each rule is modelled

- `tools/router/pairrules.py` (new): each item (routed track / via per net, each pad, each zone) gets a clearance
  group = the values of all atoms of the pair rules for it (plus the attributes that are compared between A and B,
  plus the diff-pair key for `isCoupledDiffPair`). For every group pair the clearance, creepage and hole-clearance rules
  are resolved as KiCad does (last match wins, both orders, `route_rule_coverage._condition` as the three-valued
  evaluator after the extra functions are replaced by True / False). An undecidable pair stops the model (unknown), it
  is never guessed. The table value = max(resolved clearance, resolved creepage) for copper pairs, plus pair hole
  clearances that model.py's `hole_rules` cannot hold. The core keeps max(per-net clearance, table value): never below
  what the router did before.
- **Creepage: safe form.** The straight copper distance on one layer is never longer than the surface path (t4), so a
  straight clearance >= the creepage value is safe and conservative. It is applied on every layer (KiCad checks one
  layer; inner layers are extra margin). Slots are obstacles (Edge.Cuts edges, as before); the surface path around a
  slot is **not** modelled: on 10 of the 11 boards every creepage rule has a clearance rule of the same value for the
  same pair, so a slot gains nothing; the exception is BACKUP-POWER 'FIELD to no-net creepage' 0.7 mm (no clearance
  rule): there the safe form costs up to 0.5 mm.
  KiCad DRC creepage stays the judge.
- **Region relaxation** (POE 'PoE isolation inside J1'): a routed piece is "in J1" only when its own copper touches
  the courtyard; KiCad evaluates the written segment that contains the piece, so KiCad's atom is True whenever the
  core's is. That is safe only for a relaxing region; pairrules.py refuses a region that raises a value on routed
  copper. Inside J1 the clearance relaxes to 1.25 mm, but the class creepage (3 mm) still holds for every pair except
  the named /POE_V1P-/MAG_RDN and /POE_V2N-CHASSIS (1.25 mm): the table holds exactly that.
- **Zones**: the zone-to-net clearance of the pair rules goes into the zones' `net_clearance` (the pour model), the
  clearance part only (the KiCad filler does not use creepage).
- **Isolation barriers**: barrier rule areas are modelled exactly (outline minus holes). The plan-view rule of
  `tools/check_poe_plan_isolation.py` (POE copper 3 mm from other copper on *all* layers) is not a DRU rule and is
  not modelled (gap 3).
- Core (`main.rs`): `Shape.grp`, `Iso` table and region polygons; every clearance test adds the pair value
  (`track_hit` / `via_hit`); `pflags` and the via memo key carry the net's group entry; partner indexes per group (the
  normal query keeps the old radius, a 2 mm-bucket index of the far partners adds them: RELAY-4 iteration 1 68 s ->
  16.5 s); audit history over the isolation halo; spoke channels not reserved inside pour keepouts or within the pair
  value of foreign copper.

Fixes the isolation boards needed that are not pair rules (each with its cause):
1. **Plane reach** (POE run 1, unconnected 6): `ISO_GND` is a ground with no plane on the board, the VDD_3V3 In2
  zones do not reach J1.11 / J1.13, a TP1 fan-out via landed outside the In2 zone. model.py: a ground / alt-ref net is
  a plane net only when its zones reach every pad (pad copper on a zone, or an SMD pad within the 3 mm fan-out reach of
  its plane); else it is routed. The core puts plane fan-out vias inside the plane outlines.
2. **Return nets** (POE run 2, kicad-happy RP-001 8): the core placed returns only for a net named GND. model.py
  `return_net` (first plane ground) / `return_nets` (all grounds); a via whose net can never have a legal return
  (pair value > radius: POE nets) gets no layer change. Opt-in `run.py --return-exempt`: the gate's RP-001 exemptions
  (committed file, /SCSn) need no return.
3. **Parallel current copies** (RELAY-4, hard fails on the 4 MAINS_COM nets): current-paths.json `parallel: true`
  (the paths gate takes max flow over F.Cu + B.Cu). The model rated one 10 A path (3.6 mm), which cannot pass the
  relay rows (5.0 mm pitch, 1.96 mm pads, 3.0 mm class clearance: at most 2.04 mm). Now a parallel chain whose pads
  are all through-hole is routed once on F.Cu, checked on both layers and written on both, each copy for half the
  current (1.39 mm at 2 oz, dT 10 K).
4. **Ring rule areas** (INPUT-4D2A, 22 hard fails): BARRIER_BAND is a ring; its bbox walled in the host island.

## 3. Results

Lock-from the committed board (pairs + via_count-0 nets kept: POE the MDI pairs; RELAY-4 / INPUT-4D2A nothing), final
core 7a770b84 unless noted. DRC / unconnected / parity = run.py (`kicad-cli pcb drc --schematic-parity` on the copy).
Gate = `node tools/gate.mjs BOARD --fresh` in the detached origin/main worktree. Length = routed tracks only.

| Board | Model before (stop reason) | DRC / unconn / parity | Gate (fresh) | Barrier check | Length / vias / time |
| --- | --- | --- | --- | --- | --- |
| POE-ETHERNET (poe9, `--return-exempt`) | MODEL FAIL unknown 2 ('PoE isolation' creepage, 'PoE creepage J1 pin pitch') | 0 / 1 / 0 (VDD_3V3A U1 pad) | drc 0, parity 0, unconnected 1, planes 1, pairs 0, paths_low 0, viapads 0, kicad_happy 0 (committed exemptions, /SCSn), port labels 0: NOT AT TARGET | `magnetics isolation barrier` PASS; board check "PoE copper 3 mm ... plan view" 8 items (not a DRU rule, gap 3) | 671.1 mm / 36 / 352 s (80 iterations, not converged) |
| POE-ETHERNET (poe2, earlier core: no return vias for PHY_GND) | same | **0 / 0 / 0** | drc 0, parity 0, unconnected 0, planes 1, kicad_happy 8 (RP-001: no return vias), rest 0 | PASS | 590.6 mm / 52 / 131 s (converged, iteration 7) |
| INPUT-4D2A (input6; gate on input5, route.json byte-identical) | MODEL FAIL unknown 3 ('Isolation barrier' creepage, 'Creepage across U3', 'Edge terminal body silk') | **0 / 0 / 75** (copy: sub-sheets in subfolders are not copied, run.py gap) | **drc 0, parity 0, unconnected 0**, pairs 0, paths_low 0, viapads 0, port labels 0, kicad_happy 0 with an empty exemption file (committed file: 10 stale, every exempted net got its return), **planes 3**: NOT AT TARGET | n/a | 1237.3 mm / 165 / 188 s (converged, iteration 10) |
| RELAY-4 (relay6, `--max-time 2700`) | MODEL FAIL unknown 5 (creepage x2, 'Mains to screw hole' hole_clearance, 2 silk) | 0 / 25 / 42 (copy parity: run.py sub-sheet gap as INPUT; not converged: 33-34 nets in conflict from iteration 3 to the 45 min limit, 27 iterations; the end step left 14 nets open) | not run (unconnected 25) | n/a | 441 tracks, 53 vias / 4388 s (end step 26 min) |
| BASE-PWR-B | shares BASE-PWR gate.json (names rev C): not run in this timebox | | | | |


## 4. Remaining failures and causes

1. **POE-ETHERNET: one open net, a negotiation standoff, not a rule.** With return vias (RP-001 radius 1.0 mm) the
   negotiation does not converge around J1 / the W5500. IOTROUTE_DIAG (iteration 30, `IOTROUTE_DIAG_NETS=10`, log
   `iso/poe-diag3.log`): /POE_V1N and /POE_V2N (both one-layer nets: a POE via can never have a legal return, every
   ground via keeps 3 mm) cross near J1; /POE_V2N strictly fails at J1.10 unless /POE_V1N or VDD_3V3 moves; the PHY
   nets stand off around their return vias (/ETH_RESET and VDD_3V3A, /LED_LINK_K and VDD_3V3). No pair in conflict is an
   isolation pair. The committed board solves it by hand with all four POE nets on B.Cu. Without return vias (poe2) the
   same rules converge at iteration 7 to DRC 0 / 0 / 0 (gate: RP-001 8). Next: a one-layer net choice (a net with no
   legal layer change negotiates its layer as a whole), not a rule change.
2. **planes (POE 1, INPUT 3): si_planes reference coverage, outside the isolation rules.** POE: /ETH_CT leaves J1.3
   through the J1 area that has no plane under it (WIZnet rule, reference-planes.json) and the D-124c screen does not
   prove the run a stub. INPUT: /AI1, /AI2, ISO_5V run 0.1-0.2 mm from the H1 / H2 screw-hole rule areas, over the
   border strip where the In1 / In2 fill stops. The new rule (plane-rule nets keep out of pour-keepout voids) is
   correct but does not reach this strip; the router needs the plane fill edge (a pour model of the plane layers),
   and no sourced margin was taken.
3. **POE plan-view isolation** (`tools/check_poe_plan_isolation.py`, check-poe-candidate.mjs): PoE copper 3 mm from other
   copper on all layers in plan view. KiCad DRC and the DRU apply the PoE rule per layer only. Not modelled; to model
   it, the pair table would also apply across layers for the POE groups, and its source would be a board spec key
   (not the checker script).
4. **RELAY-4: not converged, not an isolation pair.** From iteration 3 to the 45 min limit 32-34 nets stay in
   conflict (3300-5700 conflict samples per iteration, ~80-100 s per iteration). IOTROUTE_DIAG at iteration 4
   (`iso/relay-diag2.log`): every printed conflict pair is a SELV or 24V net against a FIELD_GND via (return and plane
   fan-out vias at the 1.0 mm RP-001 radius) in the dense SELV field around U1 / U2; /COIL1, /COIL2, /COIL3 cannot reach
   their U2 driver pads past the routed copper of several nets together (no single net opens them). The mains side is
   not in the conflict set: the parallel copies route at 1.39 mm per layer between the relay rows. Before this branch the
   model stopped; the first run with the pair table had 4 hard fails (the parallel-copy cause, fixed). Next: the same
   one-layer / return-density negotiation work as POE (item 1), then a spread placement (the board is routed by hand at a
   density the router does not reach yet).
5. Creepage around slots is not modelled (safe form only); BASE-PWR-B and the 7 other isolation boards were not routed
   (their models: see test_model.py for POE / RELAY / INPUT; the other boards' rule forms are in table 1).


## 5. No regression and tests

- `cargo test --release`: 73 pass (59 before; new in tests_iso.rs: pair clearance, region relaxation, routed groups,
  via pair value, screw-hole pair hole clearance, memo key per group, query reach, partner-index equivalence, parallel
  copy, plane fan-out limit, ring rule area, no layer change without a legal return, per-net return ground, plane-void
  rule; each uses fields or functions that do not exist before this branch).
- `python3 -m unittest test_run test_pairrules test_iso_board`: 32 pass (test_pairrules: KiCad resolution cases t1-t4, attribute
  compare, footprint exception, undecidable pair, layer clause, creepage over the relaxed clearance, known hole rule,
  raising region refused, trigger). KiCad Python `-m unittest test_model`: 6 pass (3 new: POE pair rules / plane reach
  / return nets, RELAY parallel copy and 9.65 mm hole value, INPUT ring band). `test_iso_board.py` (KiCad + cargo,
  tiny board): with the pair table the route is DRC-clean; with the table taken out KiCad reports rule G (clearance)
  and rule C (creepage) on the route: router and kicad-cli agree on both cases.
- No regression (same scripts as v9, references made by origin/main 0bac26d8 in `iso/ref/`): hand NET-CORE lock-from
  (t1) on the final core: lock copy, route.json and routed board byte-identical (PASS 0 / 0 / 0, 280 vias; also after
  each intermediate core: hand1-hand4). ESP32-CORE lock-from on the final core: lock copy, route.json and routed board byte-identical (PASS 0 / 0 / 0, 459 vias,
  1312 s with 4-5 router processes beside it).
- NET-CORE / ESP32-CORE models: equal to main except the new `plane_polys` key of their plane nets (both planes cover
  the board, so the fan-out limit does not act); no `iso`, `return_net`, `twin` keys.

