# Router congestion map for the placer (2026-11-01)

Goal (user-approved plan 2026-11-01, step 2): the router tells the placer where the board is congested. Design:
DESIGN.md section 5d. Branch `claude/congestion-map` (on main c7e43156). Scratch evidence (not tracked):
`/private/tmp/claude-501/-Users-pacosw-code-iot-lab/f7557682-4961-4da4-8f78-b3604f97dd7d/scratchpad/cong/`
(`cases.txt` + `one.sh`: the 36 routes; `maps/<case>/{out.json,cong.json,run.log}`; `analyse.py` and `ana-{1,2,4}.txt`:
the diagnosis at 1 / 2 / 4 mm cells; `noreg.sh` + `noreg-hand.log`; `placer-run.sh` + `prun-hot/` + `prun-hot.raw`:
the placer run; `gate.sh`, `gates/`: independent gates in the detached origin/main worktree `g-main`).

## Map

`iotroute MODEL OUT --congestion MAP.json [--cong-cell 1.0] [--cong-free 0|1]`; run.py writes
`OUT.iotroute/congestion.json` with the alone routes on, only with `run.py --congestion` or env `IOTROUTE_CONGESTION=1`
(lead review: opt-in, because the map did not improve the placer and costs about 4 s per call; repair rank `hot` turns it on). Format: DESIGN.md 5d (per cell and layer: free room, occupied
fraction, routed length, capacity, mean history; per cell vias and via history; per net routed length, objective, pad
MST, alone objective and length, detour). NET-CORE at 1 mm: 73 x 81 cells x 3 routable layers, 445 kB.

Cost (36 routes, 6 routes in parallel on the Mac): map 4.1 s median (max 9.9 s), of which the alone routes 3.9 s; at
most 2.8 % of the route time (route median 289 s). The alone length bound is cheap (one strict A* per net with only
fixed copper), so it is on by default in run.py.

## Diagnosis (step 2)

Data: every routed placer step on disk, routed again with the branch core (`--iters 80`, the model.json of the
original run, map on): PR #79 run steps 0-3 (`P0`-`P3`), PR #80 run steps 1-2 (`U1` = `P1` byte-identical, dropped;
`U2`), rank-by-length run steps 0-4 (`K0`-`K4`), and the 25 `plen/routes` placements of PR #78 (escape A step 5,
escape C steps 0-7, blocks A 0-4 and B7 0-1, repair run 4 steps 0-6, hand, spread). 35 distinct routes: 27 PASS (core),
8 with one open net. The 6 routes that v9 made before (`P*`, `U*`) are byte-identical with the map on. Total length =
routed tracks + locked copper (as the PR #78 fit). Residual = total - (1.11 x MST + 236), MST from the map (signal
nets, test points included).

(a) Board quantity against the residual, PASS routes, Spearman (n 27; "previous step" rows: consecutive steps of
one run, n 17):

| Quantity | 1 mm | 2 mm | 4 mm |
| --- | --- | --- | --- |
| history, sum over cells and layers | +0.23 | +0.23 | +0.23 |
| history, max cell | -0.00 | +0.06 | +0.12 |
| via history, sum | +0.37 | +0.37 | +0.37 |
| occupied fraction, sum of squares | +0.35 | +0.38 | +0.38 |
| routed length / capacity, sum of squares (RUDY-like) | +0.35 | +0.44 | +0.42 |
| free room, sum of free fraction | -0.40 | -0.41 | -0.41 |
| routed vias | -0.02 | -0.02 | -0.02 |
| iterations | +0.15 | +0.15 | +0.15 |
| detour objective, sum (now - alone) | +0.26 | +0.26 | +0.26 |
| detour length, sum (routed - alone) | +0.54 | +0.54 | +0.54 |
| alone length sum - MST | +0.11 | +0.11 | +0.11 |
| same step: history at the signal pads | +0.15 | +0.10 | +0.29 |
| same step: occupied fraction at the signal pads | +0.43 | +0.29 | +0.29 |
| previous step: history at the signal pads of this step | +0.32 | +0.07 | +0.05 |
| previous step: change of that sum vs change of the residual | +0.02 | +0.35 | +0.60 |
| previous step: occupied fraction at the pads | -0.18 | -0.18 | -0.11 |

Only the detour length sum reaches 0.5, and it is not a placement quantity: it contains the routed length that the
residual measures, and it exists only after the route. Per net (option b of the plan): the routed length of step k+1
follows its own MST (Spearman 0.94, 15 step pairs) better than MST x the routed / MST ratio of step k (0.77), and the
per-net detour of step k ranks the detour of the same net in step k+1 at 0.38 (840 net pairs). The change-vs-change row
is +0.02 / +0.35 / +0.60 at 1 / 2 / 4 mm: it changes sign with the cell size, so it is not a signal.

(b) Opens. For each open net (the pad named in the core fail text, else the net's pads): the largest value in the 3 x 3
cells around it, as a percentile among the same value at every signal pad of the board (1.0 = the most congested pad;
a random pad is over the 90th percentile with probability 0.1):

| Quantity | same route, 1 mm | same route, 2 mm | same route, 4 mm | previous step map, 1 mm | n |
| --- | --- | --- | --- | --- | --- |
| history | **7 / 8** (0.96-0.99) | **7 / 8** (0.91-0.96) | 0 / 8 | 4 / 8 | 8 |
| via history | **7 / 8** | **7 / 8** | 1 / 8 | 6 / 8 (2 mm: 5 / 8) | 8 |
| occupied fraction | 3 / 8 | 0 / 8 | 2 / 8 | 2 / 8 | 8 |
| length / capacity | 3 / 8 | 2 / 8 | 2 / 8 | 2 / 8 | 8 |
| vias | 0 / 8 | 0 / 8 | 1 / 8 | 0 / 8 | 8 |

Opens: P1 /NAND_WP (U1.15), P2 ETH_AVDD, B7_1, BA2, BA3, R4_4, R4_5 /PHY_LED2, BA4 /PHY_LED1. The miss is BA4: the core
says "1 component(s) not reachable past fixed copper" (pad at 123.95, 133.80): the router never negotiated there, so
the map is 0 there; that is a placement legality fault, not congestion. With p = 0.1, 7 of 8 by chance has probability
below 1e-6.

Decision. The map explains where a route fails (history of the same route), not the length residual. The map of the
previous step does not rank the residual (0.05-0.32) and marks the next open only in part (history 4 / 8, via history
6 / 8, n 8). So:
- no search cost term (step 3a): a weight needs a source, and the only fit target with data (the residual) shows no
  relation; 8 opens are too few to fit a weight. A version with the term (`w_hc` x history at the pins, previous step's
  map) was built and removed before commit;
- repair rank (step 3b): the repair works on the failed route itself, where the history marks the open. Opt-in
  `compact_cli.py --repair-rank hot` (`repair.py run --rank hot`): proposals that take the most history of the failed
  route away from the unit's signal pins go first, then the old term order (`placer/congest.py`, `repair.hot_order`).
  No weight: a lexicographic order. Default stays `term`.

## Placer run (step 4)

`placer-run.sh prun-hot`: the PR #80 run (PR #79 command + `--repair-mode reuse --repair-per-round 8 --repair-routes 16`)
plus `--repair-rank hot`, branch worktree (router with the map). Wall 747 s (PR #80: 839 s).

| Step | s | result | length mm | vias | repair |
| --- | --- | --- | --- | --- | --- |
| 0 | 0.750 | PASS, chosen (sha256 2f5c7ffb..., the PR #79 / #80 board) | 1485.6 | 286 | - |
| 1 | 0.637 | FAIL /NAND_WP -> PASS after 1 proposal | 1486.9 | 298 | C13 decap slide, dhot -0.10 (the most history freed; also first in the term order) |
| 2 | 0.542 | FAIL -> PASS after 1 proposal | 1507.7 | 303 | C51, dhot 0.0 (5 proposals, none frees history; term order kept) |
| - | | `STOP length stop` (steps 1 and 2 rank after step 0) | | | |

**Success criterion not met**: the chosen step is step 0 again (1485.6 mm / 286 vias = PR #79); no denser step routes
shorter. The repaired boards of steps 1 and 2 are byte-identical to the PR #80 run: the hot order put the same proposal
first. The rank change is therefore not shown to help on NET-CORE; it does not hurt here, and it stays opt-in.

Independent check of the chosen board (scratch copy `chk/`, sha256 2f5c7ffb...): `kicad-cli pcb drc --schematic-parity`
errors 0, unconnected 0, parity 0 (115 warnings, as before); `node tools/gate.mjs NET-CORE --fresh` in the detached
origin/main worktree `g-main`: PASS (`gates/step0.txt`). Render `prun-hot-step0-top.png` (`kicad-cli pcb render --side
top`) and pcbnew coordinates: SW1 (166.5, 158.0) r 90, SW2 (166.5, 166.0) r 90, D1 (155.0, 177.0), D2 (161.0, 177.0) =
the fixed hand positions; TP1-TP10 in one column, pad x 169.75-170.25, y 125.95-151.25, inside the box
168.5-171.5 x 123.5-152.5.

## No regression and determinism

- Hand NET-CORE lock-from (= t1, `noreg.sh`): branch run.py (map on) against main's run (`reuse/noreg-hand`): lock copy,
  route.json and routed board byte-identical; congestion.json written (445 kB).
- The 6 v9 placer routes routed again with the map on: route.json byte-identical to the original runs.

## Tests

`cargo test --release`: 59 pass (3 new in tests_congestion.rs: default profile and MST; cell length / free room /
occupancy / history; the alone route gives the detour and leaves the copper unchanged). `test_run.py` 19 pass (1 new:
run.py passes `--congestion work/congestion.json --cong-free 1`), `test_model.py` pass. `placer/test_congest.py` 3 new
(map reader, pin history, hot order), `placer/test_repair.py` 20 pass.

## Remaining gaps

1. The residual of the MST fit (sd about 18 mm) stays unexplained by any placement-side quantity measured here. The
   largest same-route terms (occupied fraction at the pads, length / capacity) are near 0.4; a predictor from the
   placement alone (before the route) is still missing.
2. Fixed-copper walls (BA4) are not congestion: a pre-route check of pads that fixed copper walls in would catch them
   without a route.
