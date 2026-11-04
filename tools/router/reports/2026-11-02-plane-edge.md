# Router: reference-plane fill edge (2026-11-02, branch claude/router-plane-edge)

Goal: the router keeps a solid reference under the tracks the planes gate checks, so that INPUT-4D2A passes the
planes gate (the blocker left by PR #82, reports/2026-11-01-isolation.md section 4 item 2). Scratch copies only; the
committed boards are not changed. Evidence: KiCad 10.0 `kicad-cli pcb drc --schematic-parity` (run.py) and
`node tools/gate.mjs BOARD --fresh` in a clean detached origin/main worktree (routed board copied in, then restored).

## 1. What the gate measures (tools/si_planes.py, enforced D-124c screen)

- Each track of a checked net (not a ground, not exempt) on an outer layer of `adjacent` is sampled on its centre line
  (step_mm 0.25). A sample is good when the filled zone under it on the adjacent plane (`ZONE_FILLER` in memory,
  `GetFilledPolysList`, `Contains(point, -1, 0, True)`: accuracy 0, so **margin 0**) is a reference of the net's
  domain, or when it lies within pad / via radius + `via_allow_mm` (0.6) of the net's own pads and vias.
- A run of bad samples fails for a fast net always, for a net with no known driver edge unless it is a stub (INPUT
  /AI1, /AI2, ISO_5V: "unknown-driver"), and for other nets when the return detour is over the edge budget.

## 2. Cause of INPUT-4D2A planes 3

The isolation route (`iso/runs/input5`) had 115 bad samples (0.05 mm steps, own anchors excluded): /AI1 F.Cu 80,
/AI2 B.Cu 19, ISO_5V F.Cu 13, /ISO_SDA F.Cu 3 (passes by its I2C budget). Every one of them is also outside the fill
of the **router input** refilled alone (no routed copper): the void is static (zone setback and min-width removal at
the H1 / H2 screw-hole areas), not made by routed vias. So a static fill computed by KiCad is the right model.

## 3. The rule

- model.py `reference_fill` (runs last: it refills the zones of the loaded board in memory, never saves): `ref_fill`
  = per outer layer of `adjacent`, per domain, the filled polygons (outline + holes) of the domain ground and its
  alt_refs (no cap_mm, not slow_only) on the adjacent plane; the anchor discs of every pad (max size on F.Cu / 2) and
  locked via (d / 2) with their net; `via_allow` from the spec. Net `ref_domain` = `si_planes.net_domain` with the pad
  votes computed as si_planes.analyse does. Only `plane_ref` nets (checked, not power) get a domain.
- Core `reffill.rs`: the net's domain goes into `pflags` bits 2..7, so the per-profile fixed-copper memo stays exact.
  `Board::track_fixed_code` on a layer of `adjacent`: a track centre outside its domain's fill (or within the routing
  EPS 0.002 mm of the edge; the audit uses eps 0 = the gate's margin 0) is blocked, except inside the anchor discs of
  exactly one net (fixed code n: only that net may pass). The same function serves the search, the diagonal midpoints,
  the string pulling, the audit, reuse seeds and escape stubs, so every written track keeps it.
- Speed: 0.25 mm buckets classed inside / outside / mixed at load (a bucket no ring edge touches is classed by its
  centre); mixed buckets test the exact even-odd rule over the edges of their row. Unit test: the bucket answer equals
  the exact test at more than 400 k off-lattice points.
- Safe simplifications (stricter than the gate, never looser): two nets' anchor discs at one point block both; exempt
  areas, cap_mm and slow_only alt_refs are not used; the detour budget is not used (every crossing is avoided).
- Not modelled: antipads of routed vias (the existing plane clearance rule of `pref` nets keeps tracks off them), and
  routed tracks on a mixed plane layer (FW-IO In2) that cut the reference of B.Cu.

## 4. Results

| Case | Before (main / isolation run) | This branch | Gate (clean origin/main, fresh) |
| --- | --- | --- | --- |
| INPUT-4D2A, lock-from committed | 0 / 0 / 0, 1237.3 mm, 165 vias, planes 3 | **PASS 0 / 0 / 0**, converged it 10, 1233.4 mm, 165 vias, 232 s | **planes 0**, drc 0, parity 0, unconnected 0, pairs 0, paths_low 0, viapads 0, port labels 0; kicad_happy 10 = the 10 committed RP-001 exemptions, all STALE ("no finding matched": every exempted net got its return via). With an empty exemption file: **gate PASS** |
| NET-CORE (hand), lock-from committed | main: PASS, it 45, 1202.3 mm, 264 routed vias | PASS 0 / 0 / 0, it 40, 1179.8 mm, 266 routed vias | PASS (all 0) |
| FW-IO from the PR #85 placement (2815bf69) | committed (PR #85): 648 tracks, 145 vias | PASS 0 / 0 / 0, 657 tracks, 146 vias | PASS (all 0) |
| ESP32-CORE, lock-from committed | main: PASS, it 31, 3689.1 mm, 443 routed vias, 1726 s | PASS 0 / 0 / 0, it 19, 3702.2 mm, 455 routed vias, 1370 s | drc 0, parity 0, unconnected 0, planes 0, other routing counts 0; kicad_happy 9 = the 9 committed RP-001 exemptions, all STALE (0 findings), as in v8b. With an empty exemption file: **gate PASS** |

Why the routes changed: the rule blocks cells that the older rules left free. On NET-CORE that is 52.6 mm2 per outer
layer (0.1 mm sampling, voids.py): 51.5 mm2 thermal / antipad rings of GND drilled items on In1 / In4, 1.1 mm2 setback
of foreign drilled items beyond the plane clearance (the other 180 mm2 of void the plane clearance rule already
blocked). The negotiation differs from iteration 1 (3238 vs 3237 conflicts), so 26 of 58 nets end on other copper. The
main route ends with no sample in those voids either (diag2.py: 0 bad samples on main and on the branch), so the
change is a different legal end state, not a fix of a gate finding. FW-IO: also 0 bad samples on the committed and the
branch route. ESP32-CORE: 83.9 mm2 per outer layer (82.1 GND thermal / antipad rings, 1.8 setback); iteration 1
differs (9714 vs 9751 conflicts); 77 of 97 nets end on other copper; 0 bad samples on main and on the branch route.
FW-IO: voids.py crashed in pcbnew on this board (exit 139), so no area figure.

INPUT-4D2A twice (in1, in2): the lock copy, route.json and the routed board are byte-identical.

## 5. Tests

- `cargo test --release`: 75 pass (73 before; new tests_reffill.rs: the rule (void blocked, fill free, no adjacent
  plane free, no domain free, own anchor free, other net at the anchor blocked, EPS margin while routing and margin 0 in
  the audit, no `ref_fill` = old behaviour) and bucket vs exact test).
- `python3 -m unittest test_run test_pairrules test_iso_board`: 33 pass. KiCad Python `-m unittest test_model`: 7 pass
  (new: INPUT-4D2A `ref_fill` layers, domains, the /AI1 void point and fill points of both domains).

## 6. Open

- The 10 stale RP-001 exemptions in `hardware-design/boards/INPUT-4D2A/kicad-happy-exempt.json` must go when a routed
  INPUT-4D2A board is adopted (a committed board file: not changed here).
- A net with a known edge budget may legally cross a void; the router now never does. If that walls in a pin on some
  board, the next step is a priced crossing for budget nets (the gate's detour, not a new number).
