The placer is Rust and TypeScript. `tools/placer/core` (crate and binary `iotplace`) holds everything that runs inside a job, where the route image has no node: `iotplace read` (problem from the board JSON of `iotroute board-json`), `run` (the search), `write` (a pose as a board copy, saved by KiCad 10), `scramble`, `gplace` (the analytic stage alone), `count` (the DRC counts), `strip`, `pinswap`, `repair-proposals`. Mac-side command lines and orchestration are TypeScript: `place.ts` (read, run, write, drc, pinswap, scramble), `compact-cli.ts` (the compaction driver; `compact.ts` is its schedule), `repair.ts`, `membership.ts`, `viewer.ts`, `movie.ts`, `bench.ts`. `place.ts` fetches the board JSON through a daemon job (`tools/lib/board-json.ts`). Modules of the crate: `numeric` (the arithmetic of the reference runs), `problem` and `params` (typed input; an unknown `--param` is an error), `model` (static tables), `layout` (current places), one module per cost term with its own state and undo (`rudy`, `spacing`, `domain`, `via`, `crossing`, `rows`, `escape`, `wirelen`, with `mask`), `evaluator` (the incremental cost), `search` (mover, anneal, legalizer, epochs), `engineering` (the reviewed contract as a legality term), `gplace`, `mains`, `dru`, `pinswap`, `congest`, `drc_count`, `bench`, `read`, `write`, `repair`.

Rust tests: `cargo test --release` in `tools/placer/core` (`tests/golden.rs`: seeded results of the Python search on ENV-SENSE, PWR-24V-5V and a synthetic problem). A seed gives the same poses as the Python search, bit for bit: `numeric` reproduces `random.Random` (MT19937), numpy pairwise sums, the compensated builtin `sum` of Python 3.12+ and `math.hypot`. Two things differ by design. With `global=1` the search does not match, because the analytic stage does not: numpy runs its matrix products on OpenBLAS, and the descent amplifies that roundoff about 1e9 times in 100 steps (5.5e-7 relative at step 100, 1e-5 mm at the end); `golden.rs` checks that trace instead. The history components of res.json come from the evaluator, not a second cost path: within 1e-15 of Python. About 100x the moves per second of the Python workers.

Not in the search: `schedule=lam`, `normalize`, `init=spectral`, gplace `rotate` (closed experiments below, no caller). `iotplace run` refuses them as unknown `--param`s rather than running another search. Removed from the tree on 2026-11-04 (git history has them; their results stay below): the Python placer, with `batch.py`, `batch_capabilities.py`, `bench_batch.py`, `gplace_torch.py` (the torch backends and `batch=1`), `surrogate.py`, `surrogate_gen.py`, `features.py` (the stopped surrogate), `bench_place.py`, `cypress_io.py` and `cypress/` (the closed Cypress comparison). Below, a name such as `anneal.py` or `cost.py` in a dated result is the Python module of that date.

A problem with a reviewed engineering contract: `place.ts read` attaches it (`engineering-problem.ts`), `place.ts run` verifies the sources and hands `iotplace run` the SHA-256 of the file it verified (`--engineering-frozen-model-sha256`); `iotplace run` refuses a reviewed problem without it. The search counts the pose-level misses in `legal_penalty` (`core/src/engineering.rs`), and `place.ts` writes the full report of each candidate. A job has no sources, so a remote result says the producer must recheck them before writing.

Tests: `cargo test --release --locked` in `tools/placer/core` on Hetzner; `node --no-warnings --experimental-strip-types --test tools/placer/*.test.ts` on the Mac. Search and benchmark runs go on Hetzner only (`tools/remote.sh`); this Mac runs tests and short smoke runs only.

Route-in-the-loop selection (opt-in, default off): `compact-cli.ts ... --retain-candidates 3 --route-top 3 [--route-top-budget S] [--route-top-pick first|length]` routes the first K legal retained candidates of a step one after the other (the first, plain run routes only candidate 0 and ignores the rest) and verifies each natively as every step is (`iotroute run`: DRC 0, unconnected 0, parity 0). `first` stops at the first verified candidate; `length` routes all K and takes the shortest verified one; with none verified the fewest unrouted wins (earliest on a tie). Each candidate gets `--route-top-budget` seconds, default (time left in the run) / K at the start of the step, so K candidates never use more than the single candidate would with the whole budget; a candidate that times out is a failure and the next one starts. Every candidate's cost, budget, elapsed time, counts, length and `chosen` flag is in the step's `route_top` of `run.json`; candidates beyond the first keep their files in `step-N/alt-SLOT/`. Not benchmarked yet: the arms (K=1 with the full budget against K=3 with a third each) need `tools/pcb bench` to cover compaction runs; until then this is unit-tested only.

Seeded compaction: `--seeded-policy` enforces no scatter/global placement/swaps/turns, including legalizer turns. `--retain-candidates 3` preserves scored alternatives without routing them; legal candidates rank before illegal/incomplete ones. Per-step `placement-audit.json` shows seed and legalizer movement, components and constraint hashes. `w0` bounds one move, not total displacement; optional `--max-displacement 3` bounds cumulative seed displacement and rejects violations. This cap and `--congestion-feedback` remain opt-in pending routing evidence. Pin-escape feedback requires complete native-clean matching CAD evidence and is capped by `--feedback-max-mm` (default 1, maximum 2); `feedback.json` records provenance. See `hardware-design/reports/2026-10-09-base-b-placement-audit.md` for the measured limitations.

Automatic clusters: `place.ts read BOARD --auto-clusters [--w-clu 1]` proposes ties from the netlist, the part fields and soft blocks, and prints each one with its reason: a crystal and its load caps, a regulator and its passives, a decap and its IC pin (`read/clusters.rs`; a `Group` field limits a cap to the ICs of its group). Each tie is a soft pull from pad to pad. The first `clu_phase` (0.5) of the epochs a cluster moves as one, then its parts also move alone inside `clu_local` (3) mm; `clu_gather` 1 starts each part at its pin. With the flag decaps are not rigid (`--decap-tie 0` unless given). Reviewed rigid groups stay units; a fixed unit, edge anchor, region box, near rule or reviewed rule keeps its unit out of a group (`search/cluster.rs`). Off by default.

Sprints: `place.ts run prob.json -o res.json --workers 8 --budget-s 2 --checkpoint ck.json` runs one independent seed per worker in a time box, with the steps fitted to the measured speed so the schedule always cools. `--checkpoint` writes `iot-lab.place-checkpoint.v0` after each epoch, also on a plain run. The route score comes before cost (`search/sprint.rs`). Checkpoints also report `route_pressure`, the same map's unclipped peak utilization: zero overflow can mean every cell is below the existing limit, not that the board will route. `--param route_pressure=1` opts into using pressure after equal overflow and before cost; it changes only final ranking, not search moves, geometry or rule limits. The default stays off: two matched ENV-SENSE seeds separated all eight poses but verified winners stayed 1/2, with more vias on the pressure-selected clean route. See [the saturation study](reports/2026-11-05-route-score-saturation.md). In every search, sprint or not, a pose with a pad inside the edge clearance, measured exactly, is illegal. Packing variants into one job and killing the ones behind belong to the sprint runner (#1317).

Clusters and sprints, ENV-SENSE (2026-11-05, Hetzner, 15 fixed seeds, scrambled start, 8 workers x 20 epochs, each arm the same moves). Verified = `iotroute run` PASS: DRC 0, unconnected 0, parity 0. tie = summed pad distance of the 8 proposed ties (the board as designed: 25 mm).

| Arm | 2 CPU-s verified | length mm | 17 CPU-s verified | length mm | tie mm |
|---|---|---|---|---|---|
| run, decaps rigid by position (the default read) | 4/15 | 204 | 10/15 | 192 | 25 |
| run, `--decap-tie 0` | 9/15 | 212 | 11/15 | 192 | 80 |
| run, clusters | 5/15 | 213 | 4/15 | 222 | 21 |
| sprint, decaps rigid | 9/15 | 204 | 10/15 | 204 | 25 |
| sprint, `--decap-tie 0` | 9/15 | 205 | 12/15 | 200 | 87 |
| sprint, clusters | 12/15 | 221 | 9/15 | 208 | 21 |

What it shows, at n = 15, where 9 against 12 is noise. Of the 180 `run` and first sprint winners 48 stopped at the router's preflight: pads 0.002-0.047 mm inside the 0.5 mm edge clearance, because the search measures on a 0.1 mm raster. The exact check took that to 0 of 90 sprint winners, and it is the whole gain: sprints without it passed 46/90, `run` 43/90, with it 61/90. No exchange keeps the seeds 9 mm apart (0.2-2.8 mm with it) but did not route better by itself. Clusters in a sprint pass as often as the loose sprint (21/30 each) with the decaps four times closer, at 4-8 % more track. The route score was 0 on every ENV-SENSE pose, so it picked nothing here: it is unproven. `clu_phase` 0 was no better (18/30). Workers wait 18-27 % of the time at the epoch barrier on runs this short. 8 times the CPU moved the default arm from 4 to 10 verified but not a sprint.

The first exact edge check in a plain `run` (default read, same seeds, 1.8 and 16 CPU-s) left verified at 4/15 and 10/15, with the same winners. The 4 poses per budget the preflight used to block became `NO LEGAL CANDIDATE` (exit 3) before any route: the exchange had pulled all 8 workers into one basin, so no other worker had a legal pose to offer. That check saved a route but recovered no board. The legalizer now also uses the same exact edge predicate when finding nearby legal positions, while retaining its spacing, keepout, displacement, rotation, and time limits. A focused ENV-SENSE case recovers an edge-rejected candidate with a 0.25 mm inward move and independently verifies it; this does not rerun or revise the historical 15-seed totals. See [the repair evidence](reports/2026-11-05-exact-edge-legalizer.md). `exact_edge=0` remains the old search for the golden comparison only.

Search on Hetzner: pass the Linux binary with `--in` and run `bash tools/placer/remote_run.sh run in/prob.json -o out/res.json --workers 30 --epochs 20 --steps 20000` (`tools/placer/remote_run.sh`; `compact-cli.ts` takes the binary from `bin/iotplace-linux-x86_64` under PCB_TOOLCHAIN_ROOT). A reviewed engineering problem also takes `--engineering-frozen-model-sha256` with the digest of the verified file. Do not use short runs (for example 4 x 2000 steps): the end state is far from legal and the legalizer then takes more than 300 s.

Pin swap proposal (never edits the schematic): `node --no-warnings --experimental-strip-types tools/placer/place.ts pinswap BOARD PINMAP.json -o proposal.json [--apply COPY.kicad_pcb]` (run it on Hetzner through `remote_run.sh`; MC-MAIN U1: 35 s). `--apply` writes a board copy with the swapped pad nets for a routing benchmark only; schematic parity fails on that copy.

Benchmark scope: `iotplace strip BOARD OUT --only NETS.txt` removes only the tracks of the listed nets, so each candidate routes the same nets. Legality = spacing + board edge/keepouts; kept copper is a cost, and the writer rips up the copper that a moved pad lands on (`removed_collisions`).

Region-mode result, MC-MAIN at 942ab95 (2026-09-27, Hetzner, 5 Freerouting runs of 3.5 min each, same 84 nets stripped on each board):

| Board | Open before | Unrouted min / median / max | U1 subset min / median / max |
|---|---|---|---|
| Baseline | 312 | 188 / 265 / 280 | 135 / 196 / 210 |
| Region (--free-box 158 126 196 166) | 342 | 212 / 278 / 318 | 136 / 191 / 221 |
| Region + U1 pin swap | 342 | 249 / 284 / 330 | 160 / 190 / 223 |

The router routes only 47-64 connections in 3.5 min, so the spread is larger than the difference: this score cannot rank these placements.

KiCadRoutingTools (MIT, pinned 46c90458), read 2026-09-27, not used by this tool:
- `py_placer/place_optimize.py`: greedy quench of an existing placement (nudges inside a displacement cap, 90-degree turns, same-footprint swaps); cost = airwire length + crossings + halo whitespace, halo = 0.5 + 0.15 * sqrt(pins) mm (`placement/quench.py`). Local refinement, not a global search.
- `place_route_loop.py`: route, then re-quench only small parts on failed/blocker nets; accept on a better re-route, else widen the displacement cap. Not easy-to-hard: it does not shrink spacing.
- `py_router/target_swap.py`: Hungarian assignment for swappable diff-pair targets (scipy, own parser); no EXTI/pin-function rules, so it does not fit the U1 GPIO swap.
- `py_router/qfn_fanout`: QFN/QFP escape router; a possible later routing step for the U1 LQFP-100 escape.
Decision: keep this placer; the compaction halo uses the same form (base + coef * sqrt(pins)) as a cross-check.

Compaction (`compact-cli.ts`, easy to hard): each unit gets a routing halo = s * 0.4 * sqrt(fan-out) mm (`compact.HALO`), used as its spacing. The first step uses a large s on a virtual board (the outline scaled by k about its centre, k from the unit area at fill 0.5). Each step: search on Hetzner, legalize, write, then 3 Freerouting runs (300 s; historical, the step now routes with `iotroute run`). A step passes when the best run is at or below `--target` unrouted: one full route proves the placement is routable; the other runs show router variance (DOOR run 5: 3 and 3 open, different nets in each run). After a pass, s goes down 15 %. After the first fail, the step size is halved (bisect, 5 % tolerance). When the best pass is on a virtual board (k > 1), an outline phase follows. It tries the real board (k = 1) first, then bisects k to 2 %. Each step uses the largest halo that fits (`s_fit`). `--budget` defaults to 45 min. Full-board zones (ground pours) grow with the virtual outline, so the refill reaches the moved parts. `--snapshots DIR` writes `viewer.html` (self-contained: slider, play, click a part), `frames.json`, the timelapse (`movie.ts`: PNG frames, `run.gif`, `run.mp4`) and one `kicad-cli` render of the best routed board per step.

Board constraints for `place.ts read`: `--edge REF=SIDES:SIDE` puts the N/S/E/W courtyard side of REF (as placed now) on one of the board edges in SIDES (L, R, T, B; T = smaller y); the miss counts as forbidden area and makes the unit illegal. `--keepout-zone 'H*_KEEPOUT'` makes named rule areas keepouts. `--zone-ref U1_ANTENNA=U5` moves a rule area with the unit of a part (an antenna or mains keepout of a block), and the area keeps other parts out (it may overlap another keepout: a hole keepout or a keepout of another unit); the part beyond an edge anchor is cut off. Other rule areas stay where they are. A connector staged wholly outside the outline is movable. `--scatter SEED` (compact_cli) starts each search from random places inside the board. A pad of a net class with a larger clearance than the D-040 class (for example the 3.0 mm mains classes) gets its own spacing rect; the courtyard keeps the D-040 class. A board slot inside a block border belongs to the block (a keepout rect that moves with it). The domain rules come from the board .kicad_dru (`core/src/dru.rs`; `--domain 'MAINS_K*:8:3'` is an override for tests): each pad of such a net class keeps 8 mm to all other nets and 3 mm to another class of the domain; a part with no domain pad also stays 8 mm out of the convex hull of all domain pads (`pr['domain_areas']`, the mains area: the PORT2 winner had C24 below the mains connectors, its track under J4); a part with domain pads gives every pad its own rect, and its courtyard, a block border, a slot and a part with no net pad keep only their own class to a domain pad. A .kicad_dru hole rule (RELAY-4 "Mains to screw hole" 9.65 mm) keeps its gap from the hole pads to the domain pads. A .kicad_dru pair rule between two class sets (IO-6X6 "Isolation barrier" FIELD/FIELD_PWR to HOST/HOST_PWR 4 mm) makes each pad of those classes a domain pad with its net clearance; `pr['class_gaps']` holds the gap between each two domain classes (at least the net clearance). `place.ts read` lists the clearance rules it cannot read as NOT MODELLED. A block border (`u['border']`, User.1) is not checked by KiCad DRC: border over border and border over a foreign part are a soft cost (spacing); courtyards, pads, .kicad_dru gaps and keepouts stay hard. IO-6X6 has overlapping block borders (BLOCK2 vs DO1-2, 205 mm2, and BLOCK1 parts inside both): a silk/documentation issue for the board owner, not a DRC fault. Hard (illegal) = what KiCad DRC enforces: courtyard over courtyard, pad clearance rects, domain and hole gaps, keepouts, the board edge. The D-040 halo between courtyards is a soft cost (`w_sp`, default 2.0 per mm2). The copper-to-edge band (the board setting) applies to pads only; a courtyard or border stays inside the outline. A courtyard rect is the courtyard polygon box; a round courtyard (test point) is a circle (`u['rho']`). A no-footprint rule area holds parts only when it is on F.Cu (all parts are on top). A locked track or via is fixed copper (`board['fixed_copper']`): the writer never removes it, a pad over it is illegal (no net check: conservative), and a unit with a pad on a locked track of its net is fixed (POE-ETHERNET: 17 locked tracks). A courtyard may leave the outline only inside a keepout rect of its own unit (BASE-PWR `--zone-ref U1_ANTENNA=U1`: the WROOM antenna over the outline notch, D-021). A part with only NPTH pads (`u['nocu']`, a mounting hole) may lie under a keepout of another unit (BASE-PWR H1 in U1_ANTENNA). Other kept copper is a cost only; the writer rips up the clusters a moved part meets. Gate test: the RELAY-4, IO-6X6, INPUT-4D2A, POE-ETHERNET, PWR-24V-5V, FIELD-24V-BUS and BASE-PWR (with `--zone-ref U1_ANTENNA=U1`) originals are legal, and the benchmark B v2 placement P (`testdata/`) is illegal.

Routing room terms. Congestion (RUDY) default: the old term (`tracks` 0, `limit` 0.1), the cost of P2 and P2R. With `tracks` 1 it scales each net by its track (`read` sets `net['track']` = net-class track width + clearance from the `.kicad_pro`; demand x track / pitch). Track RUDY at `limit` 0.3 ranked the 9 routed poses of RELAY-4 bench v5 best (`fixtures/relay4-bench-v5.json`; rank correlation with the unrouted count 0.60; limit 0.1: 0.50, 0.5: -0.23, 0.7: 0.17). Its holdout failed: P5 (the P2R config with track RUDY 0.3) routed 7 8 8 6 8 (median 8) vs P2R 7 8 8 7 5 (median 7), so the default stays the old term until a bench shows a gain. At `limit` 0.7 the P3 search drove the term to 0 and routed worse (11-13 opens) than O (8). The track RUDY 0.7 calibration came from bench v3 and v4 (`fixtures/relay4-bench-v3.json`, `relay4-bench-v4.json`): cong O 206 < S 1369 < P 1559 (v3 opens O 8, S 133, P 142), and O < P2 < P (v4 opens O 8, P2 6, P 67). Without the tracks, `limit` 0.1 ranked O worst on v4 (O 237, P 73, P2 70); most P opens were 24V-class nets (0.5 mm tracks). The clearance in the track is at least the `.kicad_dru` gap between two classes of the net's domain (RELAY-4 mains: 3 mm); the domain gap to other nets stays a placement spacing. A problem read before this change has no tracks: read it again. Diagnosis (bench v4): P also had one relay channel out of its row (BLOCK6 8 mm below the other 3), which broke the 24V/coil bus along the relays. If the width term does not fix that, a soft row-alignment term for repeated blocks is the next candidate. Row term (`row`, weight `w_row`, default 0 = not computed): repeated blocks (movable units of 2 or more parts with the same part count, pad count and rect sizes) cost the sum of |minor coordinate - median| on the axis with the smaller spread, plus `row_pitch` (default 1) x the sum of |gap - mean gap| along the other axis (a block 8 mm out of a row of 4 costs 8). Blocks are one kind when their rect sizes differ by 0.2 mm or less. RELAY-4 relay channels: alignment O 0, P2 1.1, P 8.4 mm; the pitch part does not rank them (O is 24/15/24 mm by design), so use `row_pitch=0` there. Via room (`via`, weight `w_via` 10 per pad): `place.ts read --via-net FIELD_GND` lists the nets whose pads need a plane via (`pr['via_nets']`); each unit has its copper pads with net codes (`u['cu']`). A via-net pad needs one free site of the 16 that `tools/gnd_pad_vias.py` tries (4 sides and 4 corners, 0.2 and 0.5 mm beyond the pad edge + via radius; via 0.6 mm, clearance 0.2 mm). A site is blocked by pad copper of another net (via radius + clearance), by the board edge (edge clearance + via radius), by a no-via rule area of the board (`board['via_keepouts']`), or by a no-via rule area that moves with a unit (`--zone-ref`; a `u['cu']` row with net -1, via radius only). Tracks are not modelled. RELAY-4 FIELD_GND check: via O 0, W 0, S 22, P 28; gnd_pad_vias found no place for the same 28 P pads (all in MAINS_INNER_KEEPOUT or BARRIER_BAND).

Benchmark B, known-good recovery, RELAY-4 (2026-09-27; Hetzner). All signal tracks are removed and the FIELD_GND copper stays. Scramble seed 7 is uniform. S = a legal random placement (a search with w_wl=0 w_cong=0). P = the placer search from S. There are 5 Freerouting runs of 3.5 min each. The subset is the 56 signal nets.

| Board | HPWL (proxy) | Unrouted per run | Signal subset | DRC errors |
|---|---|---|---|---|
| O original | 1109 | 6 / 6 / 7 / 7 / 8 | 6-8 | 0-1 |
| S scrambled | 3330 | 136 / 136 / 139 / 139 / 140 | 97-100 | 342-386 |
| P placer from S | 1233 | 129 / 129 / 130 / 130 / 137 | 100-108 | 229-241 |

Result: FAIL. The placer gets the HPWL back to within 11 % of the original, but it does not get the routability back. The errors before routing show the cause. RELAY-4 has MAINS_K1-K4 net classes with 3.0 mm clearance, plus a creepage barrier band. The placer knows only the D-040 spacing (0.5 / 1.0 mm) and has no mains/SELV domain region. Thus relays, mains connectors and SELV parts end up too close, and kept FIELD_GND vias sit next to relay pads. Next fixes: pad-pair spacing from the net-class clearance, and a domain box per net class (mains side / barrier band as a keepout for the other domain).

Benchmark B v2 (2026-09-27; same set-up; the spacing class now grows to the net-class clearance of the pads):

| Board | Unrouted per run | Signal subset | DRC errors |
|---|---|---|---|
| O original | 7 / 8 / 9 / 7 / 8 | 7-9 | 0-1 |
| S scrambled | 147 / 141 / 152 / 142 / 146 | 111-122 | 136-160 |
| P placer from S | 119 / 116 / 127 / 126 / 132 | 97-111 | 224-245 |

Result: still FAIL. P is better than S by about 20 open connections, but far from O. The DRC errors of P show the cause that stays: there is no mains/SELV domain region, and the kept FIELD_GND vias clash with moved parts. Next fix: a domain box per net class.

Benchmark DOOR W, warm start from a hand placement (2026-09-27; Hetzner). DOOR-RELAY at 64f8baa (hand placement 84 x 60 mm, USB tracks locked = fixed copper, 38 of 49 units movable). Search from the hand pose, w0 5 mm, 18 workers, default cost; the winner and the unchanged hand board (O) get 5 Freerouting runs each (`fr_job.sh`, GNDVIAS=1, alternating).

| Board | HPWL | Unrouted per run | Median |
|---|---|---|---|
| O hand board | 1286 | 4 / 0 / 4 / 0 / 5 | 4 |
| W placer from O | 1018 | 0 / 0 / 1 / 1 / 7 | 1 |

Result: PASS (W median <= O median). DRC classes (per run, W / O): no new class in W. Errors: track_width 8-9 / 7-9, copper_edge_clearance 0-3 / 0-4, skew_out_of_range 0 / 0-1. Warnings: silk_overlap 177 / 131, silk_over_copper 94 / 82 (silk only; refdes silk is removed before fab), track_dangling 2-6 / 1-3, via_dangling 0-3 / 0-2. No track or via in the U1_ANTENNA keepout in any W or O run. W is evidence only; the repo board stays the hand board.

Benchmark ALL line, RELAY-4 (2026-09-27; closed). ALL = the paper changes together (`global=1 init=spectral`, Lam schedule base_lam 0.133, `p_swap=0.25 swap_ratio=1e9`, `w_x=2`, `normalize=1`, t0 5, w0 5) on relay-scr4 (old RUDY). One change per step, 5 routes each:

| Variant | Unrouted per run | Median |
|---|---|---|
| ALL | 89 / 92 / 95 / 104 / 99 | 95 |
| ALLN: geometric schedule (t0 sampled, default w0) | 79 / 65 / 71 / 64 / 73 | 71 |
| ALLN-n0: also `normalize=0` | 37 / 16 / 16 / 14 / 28 | 16 |
| P2 / P2R (scatter start, default search) | 9 / 4 / 5 / 6 / 10; 7 / 8 / 8 / 7 / 5 | 6; 7 |

Result: the Lam schedule (move window by T, frozen at w1 from epoch 2) and `normalize=1` (congestion 10x and crossing 23x relative to HPWL; the normalized cost ranked ALLN better than P2) hurt on RELAY-4. gplace + spectral + swap 0.25 + w_x 2 give no gain over the P2 scatter start (16 vs 6-7). They stay options with their defaults off (`global` unset, `schedule` geometric, `p_swap` 0.1, `swap_ratio` 1.5, `w_x` 0, `normalize` 0). The main line is the P2 method plus seed portfolio selection (`bench.portfolio_pick`). No more ALL ablations unless the portfolio fails.

Mains path check (2026-09-28): `mains=1` (default 0) runs `core/src/mains.rs` on each final candidate: the nets of the `.kicad_dru` domain classes (RELAY-4: the 12 MAINS_K* tier-1 nets) need a legal straight/L/45/Z/grid path with the dru gaps. A candidate with faults ranks after every legal candidate without; its fault records (blocking ref, net, shortfall mm) are in `candidates[].mains` of res.json. It needs a problem read with `route_rules` and `cu_nets` (kicad_io). 3.6 s (O) to 14 s (s67) per pose. Off until a bench shows a gain.

Analytic global placement (`core/src/gplace.rs`, optimize `--param global=1`): ePlace style WA wirelength + electrostatic density (DCT Poisson on a bins x bins grid; fixed units, the area outside the outline and keepouts are fixed charge), Nesterov with a growing density weight until the overflow is below 0.1, and RePlAce cell inflation where RUDY is above the routing capacity (2 rounds, at most 2x area). Edge anchors are projected onto their side. The annealer then starts from the global places and turns (use a low `t0`). On RELAY-4 the global stage takes about 0.1 s. Rotation (`rotate=1`, default 0): every `rot_every` (25) iterations and at the end, each movable unit with `rotate` not false takes the turn (0/90/180/270) with the lowest WA + lambda x density energy, one unit at a time (discrete, exact on the same objective; a soft angle would make the unit boxes non-rectangular in the density map). DCT fix (2026-09-28): the u = 0 and v = 0 modes now have half weight in the inverse DCT-II (as in DREAMPlace); before, the potential of those modes was 2x too large. Test: a cosine density gives the exact potential and field. Backend (`backend=torch`, `gplace_torch.py`): the same wa() and density() on torch tensors; `device` cpu (float64, equal to numpy to 1e-9) or mps (float32); the loop, the turns and the projection stay in numpy. torch 2.8 with MPS is in the KiCad Python user site; without torch the numpy backend runs and the torch tests skip.

Prior art checked on 2026-09-27 (no code copied):
- SA_PCB (gitlab.lukevassallo.com/luke/SA_PCB, the SA baseline of RL_PCB): no license file (only `src/main.cpp` has a BSD-3 header; the KicadParser submodule has no license). Do not vendor it. We use its ideas only: the modified Lam schedule (base_lam 0.133, T factor 0.885), swap probability 0.25, and cost terms normalized on observed values. Its reader parses KiCad 5 files (`version 20171130`); a KiCad 10 board is not checked, so it gives no second baseline on RELAY-4 without a converter.
- Lam + window by T freezes when T drops by a large factor (ALL); a VPR limiter fights the Lam controller; the geometric schedule stays the default.
- RL_PCB (github.com/LukeVassallo/RL_PCB, MIT): reward = tan of a weighted mean of clipped normalized Euclidean wirelength gain, HPWL gain and a no-overlap flag; "adaptive" = the reference values follow the best seen. Not used.

Benchmark GP (2026-09-28, RELAY-4 bench v4 set-up: relay-scr4 start = scramble seed 7, written against relay-prob4, 5 Freerouting runs of 3.5 min with FIELD_GND pad vias, `route5.sh`). The GP stage runs on the Mac or on Hetzner; the search and the routes ran on Hetzner. Short anneal = 12 workers, 6 epochs x 8000 steps (about 150 s). GP time = best of 3 on this Mac (M-series, arm64), 47 movable units, bins 64.

| Run | GP | Anneal | GP time numpy / torch cpu / torch mps | HPWL after GP | HPWL final | Unrouted per run | Median |
|---|---|---|---|---|---|---|---|
| CS (control) | none | short, t0 sampled | - | - | 1673 | 106 / 94 / 78 / 103 / 81 | 94 |
| GP0c | centre, rotate 0 | short, t0 5, w0 5 | 0.75 / 0.38 / 7.5 s (1000 iterations) | 1427 | 844 | 6 / 5 / 8 / 5 / 5 | 5 |
| GPc | centre, rotate 1 | short, t0 5, w0 5 | 1.11 / 0.54 / 10.7 s (153 iterations) | 1256 | 819 | 8 / 5 / 5 / 7 / 9 | 7 |
| GPp | scramble pose (as Cypress), rotate 1 | short, t0 5, w0 5 | 1.08 / 0.53 / 8.2 s | 1757 | 890 | 7 / 9 / 8 / 14 / 8 | 8 |
| P2R (bench v4) | none | 8 workers, 16 x 30000 (785 s) | - | - | 796 | 7 / 8 / 8 / 7 / 5 | 7 |
| Cypress #09 (cypress-eval.md, bench v3) | Cypress CPU | none (not legal) | on Hetzner | - | 877 | 39 / 36 / 38 / 35 / 40 | 38 |
| O original | - | - | - | - | 1109 | 8 / 6 / 8 / 7 / 8 | 8 |

Result: at the same short search budget, GP + anneal routes to a median of 5-8 open connections; without GP the median is 94. GP + a 150 s anneal equals the 785 s P2R search (7) and the hand layout O (8), and beats Cypress (38). All GP candidates are legal under our rules. Rotation gives no gain here (5 vs 7 is inside the router spread) and stays off by default. GP0c has 2 clearance errors in 3 of 5 runs: a Freerouting 24V_SW track 7.8 mm from K1 pad 7 (rule 8 mm); the router does not know the .kicad_dru domain rule. torch cpu is 2x faster than numpy; mps is 10x slower (a 64 x 64 grid and 47 units are too small for the GPU launch cost). The rotate=0 GP stops at 1000 iterations with the overflow at 0.10-0.102 (the stop is 0.1); the rotate=1 runs reach it at about 153. Not done: the RePlAce adaptive mu (the density weight grows by a fixed mu 1.05).

Routability surrogate (2026-09-29, stopped): `features.py` (6-channel raster + 7 scalars), `surrogate.py` (CNN + scalars, log1p target, pairwise rank loss inside each board, per-net routed head, optional D4 augmentation; `build`, `train`, `eval`; `Surrogate.score` / `batch_score`), `surrogate_gen.py` (sample poses: small anneal moves, large moves sigma 8-16 mm frac 0.4-0.7, GP + short anneal; legalize, route 90 s with Freerouting on Hetzner, DRC; rich labels). Recipe: `surrogate_gen.py prep`, then `surrogate_gen.py --case ... --timeout 00:01:30` through `tools/remote.sh`, then `surrogate.py build`, `surrogate.py train --holdout B,B --device mps [--aug]`. Weights are not stored.

Result: the targets (held-out board Spearman >= 0.7, top-10% recall >= 0.8) are not met, and the work stopped. Data: 149 routed samples, 14-28 per board; 102 of them hit the 90 s timeout. Router noise (3 routes of one pose) is 27-32 % of the pose spread on RELAY-4, IO-6X6 and INPUT-4D2A, 75 % on DOOR-RELAY, and above 100 % on BASE-PWR and POE-ETHERNET. On the held-out generated samples the model Spearman is -0.45 to 0.30, and HPWL is -0.39 to 0.04. On the 44 old RELAY-4 placer poses (3.5-min median labels), the model with RELAY-4 held out gives 0.39 / 0.67 (no aug) and 0.79 / 1.00 (aug); HPWL gives 0.66 / 0.83. Speed: features 4 ms per pose; the model 0.03 ms per pose on MPS at batch 512, 0.8-1.1 ms on CPU. A new attempt needs labels with less noise (median of 3 or more routes, or a longer route) and more samples per board.

Holdout GP (2026-09-29, IO-6X6 and DOOR-RELAY; the same set-up as the RELAY-4 GP bench). Inputs come fresh from the repo boards. The tracks are stripped; the plane and zone nets stay (DOOR also keeps the locked USB tracks). Then `place.ts read` and scramble seed 7. The original is legal on both boards. There are 5 Freerouting runs of 3.5 min with GND pad vias. The Hetzner load was 12-60 from other jobs, so the wall times are not exact.

| Board | Run | Search | HPWL final | Unrouted per run | Median |
|---|---|---|---|---|---|
| IO-6X6 | O (hand) | - | 1705 | 13 / 6 / 11 / 16 / 1 | 11 |
| IO-6X6 | CS (no GP) | 12 workers, 4 x 5000, 227 s | 2154 | 170 / 177 / 151 / 161 / 127 | 161 |
| IO-6X6 | GP0c | 12 workers, 4 x 5000, 289 s | 1398 | 74 / 125 / 141 / 100 / 74 | 100 |
| IO-6X6 | P2R | 8 workers, 16 x 30000, 1911 s | 1451 | 86 / 89 / 162 / 160 / 102 | 102 |
| DOOR-RELAY | O (hand) | - | 1286 | 29 / 21 / 19 / 26 / 34 | 26 |
| DOOR-RELAY | CS (no GP) | 12 workers, 6 x 8000, 107 s | 1155 | 11 / 24 / 12 / 11 / 18 | 12 |
| DOOR-RELAY | GP0c | 12 workers, 6 x 8000, 105 s | 1138 | 18 / 9 / 11 / 14 / 22 | 14 |
| DOOR-RELAY | P2R | 8 workers, 16 x 30000, 1197 s | 1028 | 16 / 10 / 9 / 11 / 11 | 11 |

Result: GP + a short anneal does not hold as a general gain. On IO-6X6 it equals P2R (100 vs 102) in 1/6 of the search time, and it is better than CS (161). All three are far from the hand layout (11). On DOOR-RELAY it gives no gain (14 vs CS 12 and P2R 11), and it has 14 copper_edge_clearance errors per run where the others have none. The IO-6X6 search is 4-6x slower per move (150-310 moves/s), so its short budget is 4 x 5000, not 6 x 8000. The DOOR O here (26) is not the DOOR W bench O (4), because this bench strips all signal tracks. Decision: GP stays off by default (`global` unset). It is an option for a fast first pose on a board where the anneal alone does not recover (RELAY-4, IO-6X6).

Batched annealing on torch (`batch.py`, 2026-09-29; option `--param batch=1 chains=C spec=P batch_device=cpu|mps`; the scalar workers stay the default). `BatchCost` gives the `cost.components` terms for N poses as one batch: static gap tables per rect pair (same rules as `_pen` / `_domain_gap`), summed-area lookups for the forbidden area, RUDY by a difference array, the domain-area hull by gift wrapping. `Chains` runs C chains; each step evaluates P proposals per chain from its state and applies the first accepted one (exact sequential Metropolis, up to P moves per step). The best chains are legalized and ranked by `anneal._finish`, so legality is the same. Not supported (ValueError): `w_x`, `w_row`, `pin_demand`, via nets, the Lam schedule. Tests (`test_batch.py`, real problems `testdata/relay4-prob.json`, `io6x6-prob.json`): batch terms equal the scalar terms to 1e-6 relative (cpu float64), 1e-3 on mps (float32).

Benchmark (`bench_batch.py`; this Mac, M3 Max, other agents active, load 13-30; scramble seed 7; 60 s wall clock per run; seeds 1 2 3; final cost = scalar `cost.total` of the best pose; evals = cost evaluations, moves = sequential moves per chain summed over the chains; scalar = one thread, batch cpu = 12 torch threads):

| Board | Mode | Evals/s | Moves/s | Final cost per seed | Median |
|---|---|---|---|---|---|
| RELAY-4 | scalar | 1875 | 1875 | 2064 / 1836 / 1818 | 1836 |
| RELAY-4 | cpu C256 P1 | 4881 | 4881 | 4458 / 5169 / 3541 | 4458 |
| RELAY-4 | cpu C32 P8 | 6641 | 1474 | 7264 / 3693 / 3856 | 3856 |
| RELAY-4 | mps C256 P1 | 10334 | 10334 | 4810 / 2782 / 3004 | 3004 |
| RELAY-4 | mps C32 P8 | 9737 | 2136 | 3207 / 3097 / 2642 | 3097 |
| RELAY-4 | mps C64 P16 | 24582 | 2651 | 3016 / 2912 / 4251 | 3016 |
| IO-6X6 | scalar | 675 | 675 | 3520 / 3838 / 3371 | 3520 |
| IO-6X6 | cpu C256 P1 | 2513 | 2513 | 7767 / 6096 / 8309 | 7767 |
| IO-6X6 | cpu C32 P8 | 2254 | 526 | 7298 / 5308 / 6355 | 6355 |
| IO-6X6 | mps C256 P1 | 13946 | 13946 | 4775 / 3732 / 4383 | 4383 |
| IO-6X6 | mps C32 P8 | 16575 | 4161 | 4314 / 3260 / 3897 | 3897 |
| IO-6X6 | mps C64 P16 | 25340 | 3044 | 4670 / 4111 / 4472 | 4472 |

Result: FAIL for the search. Evaluations per second go up 5-13x (RELAY-4) and 4-38x (IO-6X6), and mps beats cpu torch by 2-6x. But one batch step takes 25-100 ms whatever the batch size (kernel launch and sync overhead), so each chain makes only 10-40 moves per second against 700-1900 for a scalar chain. At an equal wall-clock budget, every batch variant ends worse than the single scalar chain (RELAY-4 median 3004-4458 vs 1836; IO-6X6 3897-7767 vs 3520). Speculative proposals help little: at the high early temperature most first proposals are accepted. The scalar path stays the default. Use `BatchCost` where many independent poses need a cost (candidate ranking, surrogate labels): about 14-25k evaluations/s on mps. Next step, if wanted: fused kernels (fewer launches per step) or batched incremental state on the cpu without torch overhead.

Attempt 2 (2026-09-29 night, surrogate stays off): labels = the median of 3 Freerouting routes at 3.5 min (`surrogate_gen.py --reps 3 --timeout 00:03:30`; a route that ignores its job timeout is killed at the limit + 120 s and the pose is routed again, at most 2 extra), on RELAY-4, IO-6X6, INPUT-4D2A, DOOR-RELAY only. Features: 8 channels (`rudy_h`, `rudy_v` added). Loss: MSE + rank inside each board (`w_mse` 1) or rank only (`w_mse` 0). Training: the new labels + the old 3.5-min placer poses (62; 9 BACKUP-POWER poses do not rebuild), whole boards held out (RELAY-4 + INPUT-4D2A, IO-6X6 + DOOR-RELAY), 80 epochs, 3 seeds, MPS.

Data: 197 poses, 47 illegal (24 %), 98 labels (RELAY-4 24, IO-6X6 29, INPUT-4D2A 22, DOOR-RELAY 23), 52 legal poses without a label (most before the hang fix). All labels are timeouts at 3.5 min. Route SD / pose spread SD: RELAY-4 5.4 / 20.7, IO-6X6 8.9 / 55.1, INPUT-4D2A 4.5 / 51.8, DOOR-RELAY 7.7 / 38.7. Hang bias: 11 labels with a hung route (median 27) vs 87 without (median 23).

Held-out Spearman / top-10% recall, mean of 3 seeds (gen = new poses, old = placer poses):

| Board (set) | w_mse 1 | w_mse 1 + D4 | w_mse 0 | w_mse 0 + D4 | HPWL |
|---|---|---|---|---|---|
| RELAY-4 gen (24) | 0.12 / 0.33 | 0.17 / 0.33 | 0.13 / 0.50 | 0.21 / 0.67 | 0.27 / 0.50 |
| RELAY-4 old (44) | 0.54 / 0.56 | 0.61 / 0.72 | 0.14 / 0.50 | 0.45 / 0.72 | 0.66 / 0.83 |
| INPUT-4D2A gen (22) | 0.32 / 0.17 | 0.71 / 0.17 | -0.76 / 0.00 | -0.29 / 0.17 | -0.48 / 0.00 |
| IO-6X6 gen (29) | -0.12 / 0.08 | -0.39 / 0.00 | 0.35 / 0.33 | -0.41 / 0.00 | -0.67 / 0.00 |
| DOOR-RELAY gen (23) | 0.51 / 0.83 | 0.76 / 1.00 | -0.73 / 0.00 | -0.26 / 0.33 | -0.41 / 0.00 |
| DOOR-RELAY old (13) | 0.14 / 0.67 | 0.16 / 1.00 | 0.03 / 0.33 | 0.14 / 0.33 | 0.53 / 1.00 |

Result: the targets are met only on DOOR-RELAY gen (w_mse 1 + D4: 0.76 / 1.00, seeds 0.73-0.78). On the generated poses that variant beats HPWL on 3 of 4 held-out boards (INPUT-4D2A, IO-6X6, DOOR-RELAY), but on those poses HPWL has the wrong sign (spread-out poses route better). On the old placer poses, which are what the placer would score, HPWL wins on both boards (RELAY-4 0.66 vs 0.61, DOOR-RELAY 0.53 vs 0.16). The variant was picked on the same held-out data. The surrogate stays off in the placer; HPWL + a Freerouting check stays the placement score. rank-only (w_mse 0) is not stable across boards. Weights are not stored (scratch only).

Lean workflow experiment (CIP epic 60; PR #2): `BASEB_LEAN=1 sh tools/base_b_pipeline.sh`
uses the existing seeded/locked placement and all electrical rules, skips polishing compaction
candidates, and gives virtual diagnostics a separate 600-second cap (`BASEB_DIAGNOSTIC_BUDGET`).
This effort policy is opt-in until identical-input BASE-B comparisons establish quality and time benefit.
The baseline effort policy remains available with `BASEB_LEAN=0`. The overall `BASEB_BUDGET`
now includes the pipeline, not just search, with bounded checkpoint shutdown grace.

Each pipeline has a fresh run directory (`BASEB_WORK` may name a new directory) and one cooperating
heavy-job slot on this Mac. A competing invocation exits with retry status 75; it does not terminate
other jobs. This is a WIP guard, not global CIP admission or a measured memory allocator.
Old `BASEB_LOOP` reuse is refused until complete input/rule/library/tool fingerprint matching is available.
Per-job manifests and `stages.jsonl` retain attribution/timing; they are not cache/release certificates.
Virtual or timed-out candidates cannot be promoted, and actual CAD must retain the accepted 100x100 outline.

Native preflight stops existing copper shorts/clearance faults; ordinary opens and router-internal
skipped-net/pair-gap warnings do not establish a defect. Required per-step images reflect the repaired
board. Final gates remain mandatory, and failed gates stop fab/high-quality exports. Successful router
imports are explicitly unqualified until those full checks and Gerber connectivity succeed.

Bounded routing comparison (run with KiCad Python):

```sh
"$KICAD_PY" tools/lean_route_bench.py BOARD.kicad_pcb /tmp/new-comparison \
  --board-name BASE-PWR-B --seconds 30 --threads 1 --passes 40 \
  --route-args '--layers F.Cu,B.Cu --plane-nets GND,/CAN_GND --neck-um 800 --pairs-json hardware-design/boards/BASE-PWR/diff-pairs.json --skip-net "*GND*,/USB_DP,/USB_DN,/USB_MCU_DP,/USB_MCU_DN"'
```

Supply the full accepted routing options, including pair configuration, for the board being compared.
The harness freezes local CAD/config, records tool/input hashes, alternates A/B order when requested,
and reports incomplete runs honestly. It cannot adopt settings or qualify a release. Repeat on identical
inputs under recorded competing load, compare opens/DRC/plane/pair/current-path/label checks and full
gate results, and report time to compliant output. Smoke-test timings do not substantiate the earlier
15–30 minute estimate; no BASE-B runtime saving has been measured yet.

# Cooperating Mac resource budgets (CIP 779)

Local `place.ts run` and compaction stages share
`~/.cache/iot-lab/resources`. Defaults reserve at most 12 CPU worker tokens
(or the machine count if smaller), 16 GiB total declared memory, and 8 GiB
per job. These are conservative initial settings, not measured optimal settings.
Set `IOT_CPU_BUDGET`, `IOT_MEMORY_BUDGET_GIB`, and `IOT_JOB_MEMORY_GIB` consistently
for cooperating jobs. All active clients must agree on capacity; a mismatch
fails closed. An explicit request larger than capacity is rejected.

Placement workers each receive one native library thread (`OMP_NUM_THREADS`,
`OPENBLAS_NUM_THREADS`, `MKL_NUM_THREADS`, `VECLIB_MAXIMUM_THREADS`,
`NUMEXPR_NUM_THREADS`, `BLIS_NUM_THREADS`). A child inherits its live parent's
reservation and must stay within it. CPU reservations count supported worker
pools; they are not hard OS CPU quotas. Memory is declared capacity, not an RSS
limit, and unmanaged processes remain outside admission control.

Admission is FIFO with a 30 second maximum wait, shortened by an inherited run
deadline. SIGTERM/interrupt cancels waiting work. A crashed owner releases its
file locks automatically; the next caller removes its stale reservation ticket.
No existing router is killed or displaced. Admission events record queued,
admitted, released, cancelled or failed work; compaction keeps them beside its
stage log. Logs/checkpoints remain when admission fails.

The profiler preserves raw process RSS/CPU, compressor, swap and paging samples,
plus wall/child CPU timing and admission events. System VM counters cannot
attribute swap to a router. Sampled RSS includes shared pages and the profiler,
and can miss peaks; `ps` CPU is a lifetime average. GPU memory is explicitly
unavailable from this profiler. A resource profile never qualifies a board.
Re-run matched isolated/competing workloads on frozen inputs and retain complete
native gates before changing production settings. See the task 779 report for
the initial 8/12/15 worker observations and remaining acceptance work.

GPU decision (CIP 780, 2026-10-09): scalar CPU remains the default. The Torch
installation and M3 Max results above are historical; Torch is absent in the
current native KiCad Python. No GPU runtime was installed or current GPU
benchmark run. Batch policy checks now run without Torch and before optional
imports/global work; a live chain also rejects a switch to Lam before mutating
its state. Never set active crossings, rows, pin demand or via-room terms to
zero to enable batching. See `hardware-design/reports/2026-10-09-lean-gpu-decision.md`
for the measured evidence, no-go decision, future trigger and unmet conditional
prototype/adoption criteria.
# Locked copper layers

The snapshot records each pad's actual copper layer membership in
`pad_copper_layers`, aligned with `pad_rects` (or a block's `edge_pads`).
`fixed_copper_layers` records locked segments and vias on each layer they occupy,
including the actual via span. The hard legality check rejects a moved copper pad
over locked copper on a shared layer. A top-only SMD pad can cover a bottom-layer
track; a through-hole pad cannot. Bodies/courtyards alone do not obstruct copper.
Unlocked kept copper retains the existing soft-cost and writer rip-up policy.

Old snapshots without pad membership conservatively treat pads as occupying all
layers with locked copper. A legacy `via` row without a span blocks every copper
pad. Regenerate the snapshot to avoid these conservative restrictions. Explicit
empty membership denotes a pad without copper; malformed alignment is rejected.
This uses the existing pad-box/raster approximation and does not replace native
KiCad DRC or establish same-net connectivity or electrical qualification.

## Compaction routing decisions

The router is `iotroute run`; a step's score is its KiCad DRC and then its gate. A failed step bisects the halo. An
identical failed source/rules/effort fingerprint stops with exit 3 without another route, and `route-decision.json`
names the earlier evidence. Fastroute and its route decision, bounded feedback and skipped-net scope were removed on
2026-11-05. Every result remains `qualified:false`; fresh complete configured checks and explicit adoption remain
necessary.

## Failure-driven repair (`repair.ts`, `iotplace repair-proposals`, `compact-cli.ts --repair`)

The in-house router is the judge (idea: TraceMaker `src/place/routable.cpp` at c6fcb7b, `tools/pcb_search/README.md`
"Repair locally"). `repair.ts` owns the loop, the board edits and the score; `iotplace repair-proposals` (`core/src/repair/`)
ranks the moves of a round. A board edit is text, refilled and saved by KiCad 10 `kicad-cli`:

```sh
node tools/placer/repair.ts prepare SRC.kicad_pcb PLACE.kicad_pcb --board NET-CORE [--keep lock-nets|locked]
iotroute run NET-CORE ROUTED.kicad_pcb --pcb PLACE.kicad_pcb              # the failed full route
node tools/placer/repair.ts run NET-CORE PLACE.kicad_pcb ROUTED.kicad_pcb --outdir DIR [--mode reuse|local|full]
    [--max-routes 8] [--per-round 4] [--no-rotate] [--no-decap-slide] [--rank term|hot] [--read ARG ...]
```

- prepare: all footprints unlocked; `lock-nets` (default) keeps only the pair + crystal copper (as iotroute run
  `--lock-from`); `locked` also keeps every other locked track and via of SRC (hand geometry). NET-CORE needs
  `locked`: its 15 locked GND items include the stubs of U8.6 and U3.2. Without them the router reports
  "fixed copper alone walls it in (input)" and KiCad reports starved_thermal on those pads.
- Failures = the KiCad DRC errors, unconnected items and parity items of ROUTED (`ROUTED.iotroute/drc.json`),
  with their locations. A zone item has no location.
- Candidates = movable units near a failure (within `legal_radius`, 5 mm) or with a failure pad. A unit is a whole
  block (User.1 border) or a decap-tie group: its internal layout does not change. Connectors and fixed units
  (locked copper on a pad, mounting holes, edge connectors) do not move.
- Proposals = legal places on the legalizer grid (`legal_step` 0.25 mm, out to `legal_radius`) and 4 turns
  (`Evaluator.legal_penalty_at` = 0: courtyard, pad clearance, domain gaps, keepouts, board edge; all parts on top).
  A proposal must decrease the failure term: unconnected pad-to-pad distance, minus the free room around each
  located item. Rank: term decrease, placement cost, displacement; round-robin over the units. Deterministic.
- Decap slide: a decap tied to its IC (`iotplace read --decap-tie`, 3 mm) may move alone when the tie stays true
  (pad-edge gap to the IC pin <= the tie distance).
- Route: `reuse` (default since 2026-11-01, see the last section) routes the moved placement with `iotroute run --reuse` from
  the present candidate's route. `local` rips the copper that the moved pads meet and the unlocked clusters within `legal_radius`
  of a failure or on a failed net, keeps and locks the rest, and routes only what is open (NET-CORE: 40 s against
  270 s for a full route). `full` routes the moved placement board again.
- Accept only a strictly lower key: (DRC errors + unconnected + parity, gate metrics, length, vias), measured by
  `iotroute-step.ts` (kicad-cli DRC with parity on the saved board, then the board gate). The previous candidate stays
  until then.
- Stop: score 0, no proposal, a round without a better route, `--max-routes`, or only failures that no move can
  repair: a DRC item on a pad of a fixed unit that the full start route reports as "fixed copper alone walls it in
  (input)". `DIR/repair.json` has every attempt and the cause. Results are scratch candidates (`qualified: false`).

Compaction: `compact-cli.ts ... --router iotroute --repair [--repair-mode reuse|local|full] [--repair-routes 8]
[--repair-per-round 4] [--read-args '...']` (`--repair-mode reuse` is the default since 2026-11-01) runs the repair on each failed step that has located DRC failures.
The step passes when the repair reaches score 0; `step-N/repair/repair.json` names the repaired board.
`--read-args` must be the `place.ts read` arguments of PROB.json (the repair reads the problem again from each board).

A failed step leaves `step-N/route-decision.json`. A refused rule, a run with no verdict and a parity failure stop the run; opens
go on bisecting the halo, and a step whose only opens are plane nets counts as routed, never as qualified. A finished step with no
DRC error teaches the next search room round its boxed-in pins, at most `--feedback-max-mm` (1, up to 2) per part, and with
`--congestion-feedback` round the parts that enclose an open. `--routes N` (1) tries other seeds until one passes; the best counts.
`--gnd-vias` makes GND a plane net: pad vias into its pour, no tracks. There is no `--optimizer`: iotroute has no optimizer pass.

Result (2026-11-01, router v6, scratch only): NET-CORE compaction from the spread placement (1faf8ad8, lock-net
copper), halo 1.04 -> 0.61, 7 steps. Step 3 (s 0.64) failed on 1 clearance (C50 GND pad 0.13 mm from a locked
ETH_RXP via; rule 0.15 mm, below the 0.1 mm mask raster); one decap slide of C50 (0.5 mm) gave DRC 0/0/0 + gate PASS
in one 40 s local route. Steps 4 and 5 left one PHY_LED net open; 4 and 1 proposals did not repair them. Best step
(s 0.615): 1567 mm, 291 vias, gate PASS (spread 1888 mm / 301 vias with v6; hand compaction d6bbe911 1495 mm / 280
vias). The HPWL search does not keep functional groups together: the sum of the reference block boxes grew from 4626
to 6302 mm2 (reference 2652 mm2). Next: block borders on the spread board before compaction.

Problem reader changes (2026-11-01, `core/src/read`): a User.1 border drawn as 4 lines is a block border, like a
rectangle shape (NET-CORE draws its borders as lines; before, it had 0 blocks). A part rect covers its copper pads
when they go beyond the courtyard (NET-CORE J1 USB-C: pad A1B12 is 0.8 mm outside; a compaction step put D3 on it:
shorting_items + solder_mask_bridge).

## Block-aware compaction (`membership.ts`, `iotplace read --blocks`, 2026-11-01)

Membership source (before placement, so the spread board gets it): `membership.ts derive SCH PCB -o members.json
[--tighten] --draw OUT.kicad_pcb [--reference REF.kicad_pcb]`. Component = the schematic
`Group` field. Block = one IC (U, > 3 pads) + the passives that its schematic Description names, else by net
affinity in the same group (signal nets first; rails only for a part on rails only, a decap). Connector support
(Description names a connector, no IC), indicator LEDs, switches, test points and holes are not in a block. `--draw`
writes the User.1 / User.2 borders + labels (the viewer source); `--tighten` moves block passives toward their IC on
their own centre line (same side, same turn) to TIGHT_GAP 0.25 mm.
Reader (`--blocks members.json`): a labelled User.1 border holds exactly its block parts: a rigid unit (internal
layout fixed, the halo spaces blocks, not parts in a block). A block with a fixed part is soft: its parts stay
single units with a cohesion net (`--w-block`, default 4). Each component has a cohesion net (`--w-comp`, default
1). A cohesion net = the half perimeter of the group box in the HPWL term, with no RUDY demand and no halo fan-out.
Locked copper private to a block (every end inside its border, a net only on block parts: a crystal route) moves
with the block; locked copper to another unit (a diff pair to a connector) stays fixed and fixes its end units.
`compact-cli.ts --k-cap 1` keeps every halo step on the real outline (a rigid block counts its border box in the
area model; NET-CORE got k 1.02-1.05, and a virtual step is no candidate for the real board).

Result (2026-11-01, NET-CORE from the spread placement 1faf8ad8, lock-net copper, scratch only, each board checked
with `kicad-cli pcb drc --schematic-parity` + `gate.mjs`). Membership from the schematic: 8 blocks (U1-U8), 5
components; vs the builder BLOCKS of the hand board: U4, U5, U6, U8 Jaccard 1.0, U1 0.94 (R3 / C30 are in the SoC
group of the schematic, the builder puts them in U2 RESET), U7 0.73 (MDI terminations and FB1 / C49 join U7; the
builder splits J2 MDI / ETH1 SUPPLY). Soft blocks (pair or crystal copper on a part): U1, U3, U7, U8. Rigid: U2, U4,
U5, U6. Box sum = the builder BLOCKS courtyard boxes (hand board 2242 mm2, spread 2535).

| Board | length mm | vias | box sum mm2 | DRC / unconn / parity | gate |
| --- | --- | --- | --- | --- | --- |
| hand compaction (committed, router v4) | 1495 | 280 | 2242 | 0 / 0 / 0 | PASS |
| same placement, router v7 (lock-from) | 1558 | 287 | 2242 | 0 / 0 / 0 | PASS |
| PR #71 best, no blocks (v6) | 1567 | 291 | 4096 | 0 / 0 / 0 | PASS |
| blocks + tighten, s 0.637 (v6) | 1645 | 286 | 2284 | 0 / 0 / 0 | PASS |
| same placement, router v7 | 1689 | 296 | 2284 | 0 / 0 / 0 | PASS |
| blocks, no tighten, s 0.75 (v7 judge) | 1704 | 310 | - | 0 / 0 / 0 (router) | PASS (step) |

The blocks keep the functional groups together (box sum 2284 vs 4096 without blocks, 2242 by hand), but the length
does not beat the hand board. Steps at s 0.54-0.61 routed 1534-1569 mm with 1 open each (PHY_LED2 / PHY_LED1 at the U7
west pins 1-3, a pin escape walled in by the ETH1 parts); the repair found no legal move that opens it (also v7 on
the s 0.54 placement: 1 open). The run without tighten (v7 judge) failed the same way at s 0.637 and was stopped. The hand board puts R26 west of the Y2 / R20 field for that escape. Next: a pin-escape
term for a fixed IC side (escape channel per used pin) before more halo shrink.

## Pin-escape term (`core/src/escape.rs`, `--param w_esc=W [esc_hard=1]`, 2026-11-01)

Cause (PR #73): compaction steps at halo 0.54-0.61 left PHY_LED1 / PHY_LED2 open at U7 (LAN8742A) pads 2-3. C47 sat
0.97 mm below their pad toes, R20 below pads 3-4 and C49 to the east: no fan-out room. The hand board has no part in
that place; its PHY_LED1 via is 1.66 mm from the pad 3 toe.

Model. IC = reference U with more than 3 copper pads. Pin = a pad on the outer edge of the pad box of its part (not
the exposed pad). Each pin has three rays from its pad toe: the outward normal and +-45 degrees. Ray = a track to one
via: track radius rt = track / 2 + clearance, via radius rv = via_d / 2 + clearance, length L = clearance + via_d / 2
+ n (via_d + clearance), n = ceil((via_d + clearance) / pitch) when the side pitch is smaller than the via pitch, else 0
(the vias of the neighbour pins on the same ray). Sources (NET-CORE): Default class track 0.15 mm and clearance 0.15
mm (`.kicad_pro`), via 0.6 mm (`.kicad_dru` "via size", board minimum via diameter); `place.ts read` writes them to
`pr['escape_rules']`. LAN8742A pitch 0.5 mm: rt 0.225, rv 0.45, L 1.95 mm. Obstacles = copper pads of other nets (all
units; the pads of the pin's own part do not count). A partner pad (same net) never blocks, and a partner pad within
L of the toe on the outer side frees the pin (decap, series resistor). blocked(ray) = penetration / rt in [0, 1];
blocked(pin) = the smallest of its three rays. Side deficit = max(0, pins whose net has a pad on another part - sum of
(1 - blocked) over all pins of the side). escape = sum of deficits; cost w_esc x escape. `esc_hard=1`: a side with
need > 0 and every pin blocked is illegal (legal_penalty of the IC and of each unit whose copper meets its rays).
Evaluator: incremental (only the pins whose ray box meets the old or new copper box of a moved unit); NET-CORE
1350 moves/s against 1900 without the term. Not modelled: the board edge, kept tracks, the via-to-via conflict
between pins (only through n in L).

Check (NET-CORE, the three boards of PR #73, w_esc term values): hand board U7 pads 2/3 blocked 0 / 0; step 4 of
the PR #73 run (1 open at U7 pad 3) 0.36 / 0.16 (C47, R20, C49).

Repair (`core/src/repair/corridor.rs`): an unconnected item at an escape pin gives escape proposals: legal single-unit moves of the
units whose copper is within rt of a ray of that pin (`corridor_blockers`), ranked by the sum of blocked(pin) after
the move (must decrease), then the cost with w_esc 20, then displacement. A tied decap moves in the loose problem
when its tie stays true. These proposals alternate with the failure-point proposals. PR #73 step 4: the old repair
proposed only R27 (no gain); the new one proposes C47 0.75 mm south (blocked 0.16 -> 0) and C49 moves.

CPU tokens: an iotroute routing stage reserves `iotroute_step.router_cpu()` = 1 (the router core has no thread or
parallel crate) + 1 (the kicad-cli DRC phase of iotroute run) instead of the whole budget. The 16 GiB declared memory with
8 GiB per job still limits the Mac to 2 compaction runs side by side (a third run waits 30 s, then stops).

Result (2026-11-01, NET-CORE from the spread placement 1faf8ad8, blocks, router v7 judge, scratch only). Run A
`--param w_esc=20`, run C `w_esc=60`; 4 workers, 10 x 15000 steps, `--repair`. Every step passed (DRC 0/0/0 + gate)
down to s 0.333 (A) and 0.283 (C); PR #73 left 1 open at s 0.54-0.61. The routed length does not fall with the halo
below s 0.54 (A: 1580 / 1937 / 1661 / 1914 mm at s 0.542 / 0.461 / 0.392 / 0.333): the router makes detours on the
denser board. The escape repair moved C47 (the PR #73 blocker) once in run C step 1 and passed at once.

| Board | length mm | vias | box sum mm2 | DRC / unconn / parity | gate |
| --- | --- | --- | --- | --- | --- |
| hand compaction (committed, router v4) | 1495 | 280 | 2242 | 0 / 0 / 0 | PASS |
| same placement, router v7 | 1558 | 287 | 2242 | 0 / 0 / 0 | PASS |
| PR #73 best (blocks + tighten, v6) | 1645 | 286 | 2284 | 0 / 0 / 0 | PASS |
| escape A step 2, s 0.542 (v7) | 1580 | 296 | 2407 | 0 / 0 / 0 | PASS |
| escape C step 4, s 0.392 (v7, router claim) | 1583 | 304 | - | 0 / 0 / 0 (router) | PASS (step) |

A step 2 is better than PR #73 (-65 mm) but 22 mm / 9 vias worse than the hand placement routed by the same judge.
U7 pads 2-3 have blocked 0 on it. Next: rank the passing steps by routed length (not the smallest halo), and add a
length-aware term: the placement cost (HPWL) is flat at 1656-1711 over all steps, so it does not predict the route.

## Rank by routed length (`compact.choose`, `--rank`, `--length-patience`, 2026-11-01)

Cause: the halo rank kept the passing step with the smallest halo. On NET-CORE (escape A) that is s 0.333 with
1914 mm, but s 0.542 routed 1580 mm. Below s 0.54 the routed length does not fall, and HPWL does not predict it.

- Measure: each `--router iotroute` step records `measure` = {length_mm, vias, routed} in `run.json`. Source: the
  `iotroute run --json` record (`copper_counts`: pcbnew track lengths and via count of the saved routed board, not the
  router core claim). A step that passes through the repair takes the measure of the repaired board (the repair
  key, from the same iotroute run record). `box_sum` = the block box sum of the search pose in the problem model (rigid
  block border boxes + the box of each soft block cohesion net; a repair move is not in it).
- Rank (`--rank length`, default for `--router iotroute`): a real-outline step first, then the shortest routed
  length, then fewer vias, then the smaller box sum. `--rank halo` = the old rule (smallest halo, maximum
  compaction; default for the other routers, which give no measure). No measured passing step: the halo rule.
- Stop (`--length-patience K`, default 2, 0 = off): the halo shrink stops when the last K measured passing steps all
  rank after the best step so far. A failed step does not count and does not reset the count. Why K = 2: one longer
  step is not a trend (escape A: 1663 mm at s 0.637 came between 1622 and 1580 mm), and the router is
  deterministic, so a second longer step at a smaller halo is a repeat, not noise. Each extra step costs one search
  plus one route (NET-CORE: 6-7 min in escape A, 4 min in the run below). With K = 2 escape A would stop after s 0.392 (5 steps, not 7) and keep
  s 0.542. The outline phase (a virtual best step) still runs after a length stop.
- Summary line: `BEST board ... step N s ... length ... mm vias ... box ... mm2 routed ...: <reason>`.

Result (2026-11-01, router v8, scratch only). Same input and parameters as escape A (spread placement f9fcd2ed, blocks,
`--param w_esc=20`, `--repair`, 4 workers, 10 x 15000 steps, `--virtual-first --k-cap 1`). The search is deterministic:
the placement costs of steps 0-4 are the same as in escape A; only the router changed (v7 -> v8). 5 steps in 20 min:

| Step | s | length mm | vias | box mm2 (problem model) | note |
| --- | --- | --- | --- | --- | --- |
| 0 | 0.750 | 1686.4 | 319 | 1614 | passed through the repair |
| 1 | 0.637 | 1649.8 | 304 | 1633 | |
| 2 | 0.542 | 1597.5 | 304 | 1654 | chosen |
| 3 | 0.461 | 1696.2 | 293 | 1564 | ranks after step 2 (1 of 2) |
| 4 | 0.392 | 1645.2 | 304 | 1604 | ranks after step 2 (2 of 2): length stop |

`STOP length stop: the 2 passing steps after step 2 (s 0.542, 1597.5 mm) rank after it`. The halo rank would have
kept step 4 (+48 mm). Independent check of the step 2 routed board (scratch copy): `kicad-cli pcb drc
--schematic-parity` 0 / 0 / 0, `node tools/gate.mjs NET-CORE --fresh` PASS (detached origin/main worktree), pcbnew
1597.5 mm / 304 vias (the same as the iotroute run measure). Against the table above: the same placement routed 1580 mm /
296 vias with v7; the hand placement routed 1558 mm / 287 vias with v7 (not routed again with v8 here). The rank
choice and the stop worked; the length gap to the hand placement is the next problem (a length-aware term).

## Wire-length term and test-point pins (`core/src/wirelen.rs`, `--param w_mst=W`, `place.ts read --tp-pins`, 2026-11-01)

Cause (data, router v8, scratch only). 23 routed NET-CORE placements with 0 unconnected: escape A steps 0-5, escape
C steps 0-7, PR #73 run A steps 0-1, PR #73 run B7 step 0, PR #71 run 4 steps 0-3 and 6, and the hand placement
(`iotroute run --lock-from`). 18 are DRC 0 / 0 / 0; 5 have 1-2 DRC items and 0 unconnected (C1, C3, C6, BA0, R4_3). 6 more
routes left 1 open and are not in the data. Escape A steps 0-4 are the rank-by-length run boards; the others were
routed again with v8 (`iotroute run BOARD OUT --pcb PLACE --iters 80`).
Each placement metric comes from the pads of the routed board (repair moves included). Spearman with the routed length:

| Metric (signal nets: not GND, not VDD_3V3) | Spearman | n |
| --- | --- | --- |
| MST of all pad centres per net, test-point pads included | **0.82** (0.84 on the 18 PASS boards) | 23 |
| rectilinear MST, same pads | 0.76 | 23 |
| test-point attach length (MST with TP - MST without TP) | 0.73 | 23 |
| HPWL of the pads, TP included | 0.72 | 23 |
| RUDY demand, sum of squares of demand / capacity (1 mm cells, 3 signal layers, pitch 0.3 mm) | 0.66 | 23 |
| search problem MST of the pad points, TP pins (same as row 1 minus a constant per run) | 0.75 | 23 |
| search problem HPWL, TP pins | 0.68 | 23 |
| crossings of the net MST edges | 0.28 | 23 |
| MST without test-point pads | 0.35 | 23 |
| search problem HPWL as before (no TP pins, cohesion nets excluded) | -0.07 | 23 |

Linear fit: routed = 1.11 x MST + 236 mm (Pearson 0.84). Per net (excess = routed - MST): the nets with the largest
spread of routed length over the boards are VBUS, /SOC_RSTn, VCC_DRAM, /UART0_TX, VCC_1V8, /UART0_RX and VDD_CORE
(sd 12-19 mm). Each has a test point (TP2, TP10, TP9, TP4, TP8, TP5, TP7), and its routed length follows its MST
(r 0.95-0.99, VDD_CORE 0.55). The reader gave a test point no pin ("spacing 0, no pads or pins in the cost", for the
MC-MAIN TP203 case), so the search moved the test points at random: TP1 went from x 114 to x 159 in escape A. The
test-point attach length was 160-250 mm on the compaction steps and 66 mm on the hand board. Example: escape A step 3
routed 100 mm more than step 2; 75 mm of it is MST, and VBUS (+43 mm, TP2), VCC_1V8 (+24 mm, TP8) and UART0 (+17 mm,
TP4 / TP5) make most of it. The nets with the largest mean excess are the RMII nets between U1 and U7 (/ETH_TXD0,
/ETH_TXD1, /ETH_TX_EN: MST 14 mm, routed 29-30 mm) and the locked pair copper (USB0, ETH_RX): both ends are fixed, so
a placement term cannot change them. The search HPWL did not see the test points, used one box per unit and net, and
the cohesion nets (weight 4 per soft block) were half of it: it ranked the routed length at -0.07.

Change.
- `place.ts read --tp-pins` (`read_problem(tp_pins=True)`): the pad of a test point is a pin of its net (HPWL and MST).
  Default off (the old behaviour).
- The reader writes `net['pts']` (the pad centres of the net on each unit, local) and `pr['plane_nets']` (nets with a
  copper zone; NET-CORE: GND, VDD_3V3).
- `core/src/wirelen.rs`: cost term `w_mst` x the sum over the signal nets (not cohesion, not plane nets) of the Euclidean MST of
  the pad centres (Prim). Evaluator: incremental, the MST of the nets of the moved units only (the same net list as
  the HPWL update); NET-CORE 1050 moves/s against 1120 without the term. A problem without `pts` uses the pin box
  centres. The batch (torch) path rejects `w_mst` (fail closed).
- Weight source: the fit slope 1.11 mm of route per mm of MST, so w_mst 1 (the HPWL term stays at w_wl 1 for the
  cohesion nets).

Result (2026-11-01, router v8, scratch only). Same input and parameters as escape A / the rank-by-length run (spread
placement f9fcd2ed, blocks membersA.json, `--param w_esc=20`, `--repair`, 4 workers, 10 x 15000 steps,
`--virtual-first --k-cap 1`, default `--rank length`, `--length-patience 2`) plus `--tp-pins` (problem and
`--read-args`) and `--param w_mst=1`. 4 steps in about 25 min:

| Step | s | length mm | vias | MST mm (pads, TP) | TP attach mm | note |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 0.750 | 1421.6 | 293 | 1073.6 | 34.5 | |
| 1 | 0.637 | 1390.9 | 287 | 1051.1 | 14.6 | chosen |
| 2 | 0.542 | 1490.8 | 294 | 1076.5 | 29.0 | ranks after step 1 (1 of 2) |
| 3 | 0.461 | 1490.6 | 286 | 1088.9 | 24.8 | ranks after step 1 (2 of 2): length stop |

Independent check of the step 1 routed board (scratch copy, sha256 75a473f9...): `kicad-cli pcb drc
--schematic-parity` 0 / 0 / 0, `node tools/gate.mjs NET-CORE --fresh` PASS (detached origin/main worktree); pcbnew
1390.9 mm / 287 vias. Against the same router (v8):

| Board | length mm | vias | DRC / unconn / parity | gate |
| --- | --- | --- | --- | --- |
| hand placement (`iotroute run --lock-from`, v8) | 1592.9 | 285 | 0 / 0 / 0 | - (router PASS) |
| rank-by-length run, step 2 (no TP pins, w_mst 0) | 1597.5 | 304 | 0 / 0 / 0 | PASS |
| this run, step 1 (TP pins + w_mst 1) | 1390.9 | 287 | 0 / 0 / 0 | PASS |

-206.6 mm against 1597.5 mm and -202.0 mm (2 vias more) against the hand placement. Most of the gain is the test
points: their attach length fell from 161 mm (step 2 before) to 15 mm (the hand board has 66 mm), and the MST without
test points fell by 31 mm (1068 -> 1037). This run does not separate `--tp-pins` alone from `w_mst`. The test points
now sit next to their nets, not on the board edge as on the hand board (UART0, rails at x 170.3): review the test
access before an order. Below s 0.64 the routed length still rises more than the MST (step 2: +25 mm MST, +100 mm
routed): the MST does not model the detours of a dense board. Next: a detour or congestion term for the dense steps.

Lead review (render of step 1 against the hand board): the comparison is not like for like. Not only the test points
moved: the RST / FEL buttons (SW1, SW2) left the right edge next to their silkscreen labels, and the two LEDs left the
bottom edge. The hand board keeps these user-facing parts at the edge. The problem file gave them no edge or fixed
constraint, so the search moved them freely. Before a placer result is adopted, buttons, LEDs and edge test points
need a constraint (`fix` or an edge region); then compare the length again.

## Fixed user-facing parts and a test-point region (`place.ts read --in-box PATTERN=X0,Y0,X1,Y1`, 2026-11-01)

Cause: the w_mst run above gave the user-facing parts no constraint. The search moved the RST / FEL buttons, the LEDs
and the test points. User decision (2026-11-01): buttons and LEDs stay at their hand-board positions; the test
points make one group in a region along the right edge, in any order.

Change. `--in-box 'TP*=X0,Y0,X1,Y1'` (`read_problem(in_boxes=...)`): each movable unit with a matching part keeps its
courtyard rects (spacing not included) inside the box. `cost.box_miss` = the sum of the four overshoots in mm: forbidden
area in the search cost, illegal in `legal_penalty` (legalizer, repair). A translate move keeps the unit in its box
(a unit outside moves in). `compact.virtual` scales the box with the outline. The batch path rejects it. A pattern with
no match, two boxes on one unit or a box smaller than the unit is an error. Without the option the problem file does
not change (NET-CORE probA_tp: the same sha256 84a58409...).

NET-CORE constraints (spread placement f9fcd2ed; SW1, SW2, D1, D2 are already at the hand positions in it):
- `--fix SW1 SW2 D1 D2`: SW1 RESET (166.5, 158.0) r 90, SW2 FEL (166.5, 166.0) r 90 (silkscreen RST at y 162.6 and FEL
  at y 170.6 under them), D1 STATUS (155.0, 177.0), D2 PWR (161.0, 177.0). D3 (SMF5.0A) is a TVS diode, not an LED.
- `--in-box 'TP*=168.5,123.5,171.5,152.5'` (TP1-TP10). Hand-board right-edge group TP3/4/5/8/9: courtyard box x
  169.0-171.6, y 138.3-152.5. Right side: the placer edge line 171.5 (outline 172.0 minus edge clearance 0.5); the
  hand x 170.3 is 0.05 mm over it in the placer model. Left side: 169.0 minus 0.5 mm (the `--edge` anchor tolerance),
  so a test point has 0.5 mm of x play. Bottom: the hand group bottom 152.5 (SW1 spacing below it). Height: 10 test
  points at the hand pitch 2.9 mm = 29.0 mm, so top 123.5. A short search on the s 0.75 problem was legal with it.
- Same run parameters as the w_mst run (blocks membersA.json, `--tp-pins`, `--param w_esc=20 w_mst=1`, `--repair`,
  4 workers, 10 x 15000 steps, `--virtual-first --k-cap 1`, rank length, router iotroute), plus the two options in
  the problem and in `--read-args`. Router v9 (current main).

| Step | s | result | length mm | vias |
| --- | --- | --- | --- | --- |
| 0 | 0.750 | PASS, chosen | 1485.6 | 286 |
| 1 | 0.637 | FAIL after repair: 1 open, /NAND_WP U6 pad 3 - U1 pad 15 | 1465.6 | 297 |
| 2 | 0.694 | FAIL after repair: 1 open, ETH_AVDD at U7 / R22 | 1525.3 | 310 |
| 3 | 0.722 | PASS | 1530.5 | 306 |

| Board | length mm | vias | DRC / unconn / parity | gate |
| --- | --- | --- | --- | --- |
| hand placement (`iotroute run --lock-from`, v9) | 1558.6 | 280 | 0 / 0 / 0 | PASS |
| w_mst run step 1, no constraints (v8) | 1390.9 | 287 | 0 / 0 / 0 | PASS |
| this run step 0, constraints (v9) | 1485.6 | 286 | 0 / 0 / 0 | PASS |

Independent check of step 0 (scratch copy, sha256 2f5c7ffb...): `kicad-cli pcb drc --schematic-parity` 0 / 0 / 0,
`node tools/gate.mjs NET-CORE --fresh` PASS (detached origin/main worktree). By coordinates: SW1, SW2, D1, D2 at the
hand positions and rotations; all 10 test points in one column, pad x 169.75-170.25, y 125.95-151.25, model rects in
the box. The KiCad courtyard (1.297 mm radius with the line, model 1.25 mm) goes up to 0.05 mm past the box.
The constraints cost 95 mm against the unconstrained run. The result stays 73 mm shorter than the hand placement
with 6 more vias. The halo shrink failed at s 0.694 and below on interior escapes, not at the constrained parts.

## Repair with a partial re-route (`--repair-mode reuse`, router `iotroute run --reuse`, 2026-11-01)

Cause: each repair proposal moves 1-2 parts, but it was routed as a whole board (`full`) or with the copper locked
around a ripped region (`local`). `local` cannot move the kept copper, and its rip left pieces: PR #79 step 1 (s 0.637),
proposal C13: 1 unconnected item, a 0.05 mm VCC_DRAM track stub at C25.1 (in all 4 local attempts).

Change. `repair.run(..., mode='reuse')` (default; `compact-cli.ts --repair-mode reuse`) writes the moved placement
(PLACE + the move, lock-net copper only) and routes it with `iotroute run --reuse <present candidate's routed board>
--reuse-fallback none`. The router keeps the copper of the nets that the move does not touch and routes the rest
(tools/router/DESIGN.md 5c); the negotiation may still move kept copper. The key and the accept rule do not change.

Compaction steps do not use reuse: between steps 50-63 % of all parts move (every movable unit), and most routed nets
have a pad on a moved part. Measured on PR #79 step 1 from step 0: core 131 s (full 119 s), 1555 mm against 1466 mm.

Result (2026-11-01, scratch only). The PR #79 command (same inputs and parameters, router v9 + reuse) with
`--repair-mode reuse --repair-per-round 8 --repair-routes 16`:

| Step | s | PR #79 (`local` repair) | this run (`reuse` repair) |
| --- | --- | --- | --- |
| 0 | 0.750 | PASS 1485.6 mm / 286 vias, chosen | PASS, the same board (sha256 2f5c7ffb...), chosen |
| 1 | 0.637 | FAIL: 1 open /NAND_WP; 4 local proposals, each 1 open (VCC_DRAM stub) | **PASS** after 1 proposal (C13 decap slide, the PR #79 first proposal): 1486.9 mm / 298 vias, route 20 s |
| 2 | 0.694 / 0.542 | s 0.694 FAIL: ETH_AVDD at U7 / R22 (2 local proposals, round 1 no proposal) | s 0.542 **PASS** after 1 proposal (C51 0.5 mm): 1507.7 mm / 303 vias, route 18 s |
| 3 | 0.722 | PASS 1530.5 mm | not run: length stop (steps 1 and 2 rank after step 0) |

Wall time 839 s (14.0 min) against 1297 s (21.6 min, run1.raw file times) for PR #79; the user noted about 34 min.
Searches 358 s, step routes 381 s, repair routes 38 s. Every failed step now passes with its first proposal, so the
higher proposal caps were not used. The PR #79 s 0.694 step was not visited (the halo went 0.637 -> 0.542); its
repair run alone with reuse (`repair.run` on PR #79 step-2 board, same parameters): the same first proposal as PR #79
(C49 -> 127.80, 134.95) gives DRC 0 / 0 / 0 + gate PASS, 1499.8 mm / 292 vias, route 53 s (PR #79 local: 2 open,
105 s). Independent checks (detached origin/main worktree, `node tools/gate.mjs NET-CORE --fresh`, which runs KiCad
DRC with parity): chosen step 0 board, the repaired step 1 and step 2 boards and the s 0.694 repair board: gate PASS,
DRC 0 / 0 / 0. The chosen board did not change (step 0 stays the shortest: 1485.6 mm); the repair made the smaller
halos legal, but they route longer.

## Repair rank by router congestion (`--repair-rank hot`, `core/src/congest.rs`, 2026-11-01)

Cause: the router now writes a congestion map with each route (`OUT.iotroute/congestion.json`, tools/router/DESIGN.md
5d). Data (tools/router/reports/2026-11-01-congestion.md, 35 NET-CORE routes): the PathFinder history of a failed
route is highest at its open (7 of 8 opens at a signal pad in the top 9 % of the board's pads, 1-2 mm cells; the 8th
was walled in by fixed copper). No map quantity ranks the routed-length residual of the w_mst fit at 0.5 or more, and
the previous step's map does not rank it either, so there is no search cost term.

Change. `core/src/congest.rs`: `from_route(congestion.json)` = the history per cell summed over the layers; `Model(pr, map).value(
unit, x, y, r)` = the history at the unit's signal pins (net `pts`, no cohesion or plane nets) at that pose.
`repair.hot_order` (`repair.run(..., rank_mode='hot')`, `repair.ts run --rank hot`, `compact-cli.ts --repair-rank hot`):
each proposal gets `dhot` = history at the pins after the move - before, from the map of the route being repaired; the
proposals go in the order (dhot, old order): first the moves that take the most history away from the pins. No map:
the old order. Default `term` (the old rank).

Result (2026-11-01, scratch only, router with the map). The PR #80 command plus `--repair-rank hot`: 747 s, the same
steps and boards as the PR #80 run (step 0 PASS 1485.6 mm / 286 vias, chosen; step 1 s 0.637 repaired by the C13 decap
slide, dhot -0.10, 1486.9 mm; step 2 s 0.542 repaired by C51, dhot 0, 1507.7 mm; length stop). The hot order put the
same proposal first in both repairs, so the run does not show a gain; the rank stays opt-in. Chosen board: DRC 0 / 0 / 0
with parity and gate PASS (detached origin/main worktree); SW1, SW2, D1, D2 at the fixed positions and TP1-TP10 in the
box.

## Flush edge anchors and near rules (`--edge REF=SIDES:SIDE:INSET[:TOL]`, `--near`, 2026-11-02)

Cause (FW-IO 100 x 60 compaction, a9aafcd6, lead review): the default edge anchor puts the courtyard side on the
copper-to-edge line (0.5 mm) with tol 0.5, so connectors ended 0-1 mm inside the edge (J4/J5 0.9 mm, J3 0.1 mm out),
and nothing kept the 24 V protection at its connector (SMCJ33A 50 mm from J1 against 5 mm on the 100 x 80 board).

- `--edge J2=B:S:0` sets the line `INSET` mm from the outline (0 = flush) with tol 0.05 mm (`:TOL` sets it):
  `u['edge']['inset']`, used by `cost.edge_miss` and the gplace projection; the batch path rejects it.
- `--near D1.1=J1.1:9`: pad 1 of D1 stays within 9 mm (centre to centre) of pad 1 of J1, a part of a FIXED unit
  (`u['near']` rows [lx, ly, wx, wy, d], `cost.near_miss`): forbidden area in the search, illegal in legal_penalty.
  A movable target is an error (the term depends on one unit, so the incremental cost stays exact); the batch path
  rejects it.
- Free silk strip in front of a connector: a footprint-only F.Cu rule area `Jn_SILK` with `--zone-ref Jn_SILK=Jn`
  (moves with the connector, keeps parts out; KiCad DRC checks it on the board).

Result (FW-IO, scratch): near rules for D1 / D3 / R3 at the J1 pins (9-12 mm) with s 1.0 / 0.5 / 0.25 gave no legal
candidate: the search left 24V IN and U2 TJA1051 1.4-2.3 mm beyond the limits and turned them (the legalizer timed
out). The committed board fixes those parts at their 100 x 80 places under J1 (`--fix`) instead.

### Node-only recorded playback

For a saved compaction `run.json`:

```sh
node --experimental-strip-types --no-warnings tools/placer/viewer.ts run.json playback.html --frames-json frames.json --seconds 15
```

This read-only viewer shows recorded epoch and result poses, approximate unit
rectangles, the ratsnest and recorded cost values in a self-contained HTML file.
It records the source SHA-256 and refuses to overwrite output. It does **not**
compute RUDY heat, emit PNG/GIF/MP4, render routed boards, or establish DRC or
qualification. The legacy Python viewer and movie remain until their other
outputs have separately validated replacements and callers are migrated.
