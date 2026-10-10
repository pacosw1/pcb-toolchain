Tests (from the repo root; needs numpy and pcbnew, so use the KiCad Python): `/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3 -m unittest discover -s tools/placer -p 'test_*.py'` (without KiCad: `uv run --with numpy python -m unittest discover -s tools/placer -p 'test_*.py'` runs the cost and search tests; the pcbnew tests skip). Search and benchmark runs go on Hetzner only (`tools/remote.sh`); this Mac runs tests and short smoke runs only.

Seeded compaction: `--seeded-policy` enforces no scatter/global placement/swaps/turns, including legalizer turns. `--retain-candidates 3` preserves scored alternatives without routing them; legal candidates rank before illegal/incomplete ones. Per-step `placement-audit.json` shows seed and legalizer movement, components and constraint hashes. `w0` bounds one move, not total displacement; optional `--max-displacement 3` bounds cumulative seed displacement and rejects violations. This cap and `--congestion-feedback` remain opt-in pending routing evidence. Pin-escape feedback requires complete native-clean matching CAD evidence and is capped by `--feedback-max-mm` (default 1, maximum 2); `feedback.json` records provenance. See `hardware-design/reports/2026-10-09-base-b-placement-audit.md` for the measured limitations.

Search on Hetzner (the image has no numpy): pass a PyPI numpy wheel for CPython 3.13 x86_64 (for example numpy-2.2.6-cp313-cp313-manylinux_2_17_x86_64, sha256 1bc23a79bfabc5d056d106f9befb8d50c31ced2fbc70eedb8155aec74a45798f) with `--in`, and run `bash tools/placer/remote_run.sh run in/prob.json -o out/res.json --workers 30 --epochs 20 --steps 20000` (MC-MAIN: 250 s). Do not use short runs (for example 4 x 2000 steps): the end state is far from legal and the legalizer then takes more than 300 s.

Pin swap proposal (never edits the schematic): `python3 tools/placer/cli.py pinswap BOARD PINMAP.json -o proposal.json [--apply COPY.kicad_pcb]` (run it on Hetzner through `remote_run.sh`; MC-MAIN U1: 35 s). `--apply` writes a board copy with the swapped pad nets for a routing benchmark only; schematic parity fails on that copy.

Benchmark scope: `python3 tools/placer/validate.py strip BOARD OUT --only NETS.txt` removes only the tracks of the listed nets, so each candidate routes the same nets. Legality = spacing + board edge/keepouts; kept copper is a cost, and the writer rips up the copper that a moved pad lands on (`removed_collisions`).

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

Compaction (`compact_cli.py`, easy to hard): each unit gets a routing halo = s * 0.4 * sqrt(fan-out) mm (`compact.HALO`), used as its spacing. The first step uses a large s on a virtual board (the outline scaled by k about its centre, k from the unit area at fill 0.5). Each step: search on Hetzner, legalize, write, then 3 Freerouting runs (300 s, `--routes`). A step passes when the best run is at or below `--target` unrouted: one full route proves the placement is routable; the other runs show router variance (DOOR run 5: 3 and 3 open, different nets in each run). After a pass, s goes down 15 %. After the first fail, the step size is halved (bisect, 5 % tolerance). When the best pass is on a virtual board (k > 1), an outline phase follows. It tries the real board (k = 1) first, then bisects k to 2 %. Each step uses the largest halo that fits (`s_fit`). `--budget` defaults to 45 min. Full-board zones (ground pours) grow with the virtual outline, so the refill reaches the moved parts. `--snapshots DIR` writes `viewer.html` (self-contained: slider, play, click a part), `frames.json`, the timelapse (`movie.py`: PNG frames, `run.gif`, `run.mp4`) and one `kicad-cli` render of the best routed board per step.

Board constraints for `cli.py read`: `--edge REF=SIDES:SIDE` puts the N/S/E/W courtyard side of REF (as placed now) on one of the board edges in SIDES (L, R, T, B; T = smaller y); the miss counts as forbidden area and makes the unit illegal. `--keepout-zone 'H*_KEEPOUT'` makes named rule areas keepouts. `--zone-ref U1_ANTENNA=U5` moves a rule area with the unit of a part (an antenna or mains keepout of a block), and the area keeps other parts out (it may overlap another keepout: a hole keepout or a keepout of another unit); the part beyond an edge anchor is cut off. Other rule areas stay where they are. A connector staged wholly outside the outline is movable. `--scatter SEED` (compact_cli) starts each search from random places inside the board. A pad of a net class with a larger clearance than the D-040 class (for example the 3.0 mm mains classes) gets its own spacing rect; the courtyard keeps the D-040 class. A board slot inside a block border belongs to the block (a keepout rect that moves with it). The domain rules come from the board .kicad_dru (`dru.py`; `--domain 'MAINS_K*:8:3'` is an override for tests): each pad of such a net class keeps 8 mm to all other nets and 3 mm to another class of the domain; a part with no domain pad also stays 8 mm out of the convex hull of all domain pads (`pr['domain_areas']`, the mains area: the PORT2 winner had C24 below the mains connectors, its track under J4); a part with domain pads gives every pad its own rect, and its courtyard, a block border, a slot and a part with no net pad keep only their own class to a domain pad. A .kicad_dru hole rule (RELAY-4 "Mains to screw hole" 9.65 mm) keeps its gap from the hole pads to the domain pads. A .kicad_dru pair rule between two class sets (IO-6X6 "Isolation barrier" FIELD/FIELD_PWR to HOST/HOST_PWR 4 mm) makes each pad of those classes a domain pad with its net clearance; `pr['class_gaps']` holds the gap between each two domain classes (at least the net clearance). `cli.py read` lists the clearance rules it cannot read as NOT MODELLED. A block border (`u['border']`, User.1) is not checked by KiCad DRC: border over border and border over a foreign part are a soft cost (spacing); courtyards, pads, .kicad_dru gaps and keepouts stay hard. IO-6X6 has overlapping block borders (BLOCK2 vs DO1-2, 205 mm2, and BLOCK1 parts inside both): a silk/documentation issue for the board owner, not a DRC fault. Hard (illegal) = what KiCad DRC enforces: courtyard over courtyard, pad clearance rects, domain and hole gaps, keepouts, the board edge. The D-040 halo between courtyards is a soft cost (`w_sp`, default 2.0 per mm2). The copper-to-edge band (the board setting) applies to pads only; a courtyard or border stays inside the outline. A courtyard rect is the courtyard polygon box; a round courtyard (test point) is a circle (`u['rho']`). A no-footprint rule area holds parts only when it is on F.Cu (all parts are on top). A locked track or via is fixed copper (`board['fixed_copper']`): the writer never removes it, a pad over it is illegal (no net check: conservative), and a unit with a pad on a locked track of its net is fixed (POE-ETHERNET: 17 locked tracks). A courtyard may leave the outline only inside a keepout rect of its own unit (BASE-PWR `--zone-ref U1_ANTENNA=U1`: the WROOM antenna over the outline notch, D-021). A part with only NPTH pads (`u['nocu']`, a mounting hole) may lie under a keepout of another unit (BASE-PWR H1 in U1_ANTENNA). Other kept copper is a cost only; the writer rips up the clusters a moved part meets. Gate test: the RELAY-4, IO-6X6, INPUT-4D2A, POE-ETHERNET, PWR-24V-5V, FIELD-24V-BUS and BASE-PWR (with `--zone-ref U1_ANTENNA=U1`) originals are legal, and the benchmark B v2 placement P (`testdata/`) is illegal.

Routing room terms. Congestion (RUDY) default: the old term (`tracks` 0, `limit` 0.1), the cost of P2 and P2R. With `tracks` 1 it scales each net by its track (`read` sets `net['track']` = net-class track width + clearance from the `.kicad_pro`; demand x track / pitch). Track RUDY at `limit` 0.3 ranked the 9 routed poses of RELAY-4 bench v5 best (`fixtures/relay4-bench-v5.json`; rank correlation with the unrouted count 0.60; limit 0.1: 0.50, 0.5: -0.23, 0.7: 0.17). Its holdout failed: P5 (the P2R config with track RUDY 0.3) routed 7 8 8 6 8 (median 8) vs P2R 7 8 8 7 5 (median 7), so the default stays the old term until a bench shows a gain. At `limit` 0.7 the P3 search drove the term to 0 and routed worse (11-13 opens) than O (8). The track RUDY 0.7 calibration came from bench v3 and v4 (`fixtures/relay4-bench-v3.json`, `relay4-bench-v4.json`): cong O 206 < S 1369 < P 1559 (v3 opens O 8, S 133, P 142), and O < P2 < P (v4 opens O 8, P2 6, P 67). Without the tracks, `limit` 0.1 ranked O worst on v4 (O 237, P 73, P2 70); most P opens were 24V-class nets (0.5 mm tracks). The clearance in the track is at least the `.kicad_dru` gap between two classes of the net's domain (RELAY-4 mains: 3 mm); the domain gap to other nets stays a placement spacing. A problem read before this change has no tracks: read it again. Diagnosis (bench v4): P also had one relay channel out of its row (BLOCK6 8 mm below the other 3), which broke the 24V/coil bus along the relays. If the width term does not fix that, a soft row-alignment term for repeated blocks is the next candidate. Row term (`row`, weight `w_row`, default 0 = not computed): repeated blocks (movable units of 2 or more parts with the same part count, pad count and rect sizes) cost the sum of |minor coordinate - median| on the axis with the smaller spread, plus `row_pitch` (default 1) x the sum of |gap - mean gap| along the other axis (a block 8 mm out of a row of 4 costs 8). Blocks are one kind when their rect sizes differ by 0.2 mm or less. RELAY-4 relay channels: alignment O 0, P2 1.1, P 8.4 mm; the pitch part does not rank them (O is 24/15/24 mm by design), so use `row_pitch=0` there. Via room (`via`, weight `w_via` 10 per pad): `cli.py read --via-net FIELD_GND` lists the nets whose pads need a plane via (`pr['via_nets']`); each unit has its copper pads with net codes (`u['cu']`). A via-net pad needs one free site of the 16 that `tools/gnd_pad_vias.py` tries (4 sides and 4 corners, 0.2 and 0.5 mm beyond the pad edge + via radius; via 0.6 mm, clearance 0.2 mm). A site is blocked by pad copper of another net (via radius + clearance), by the board edge (edge clearance + via radius), by a no-via rule area of the board (`board['via_keepouts']`), or by a no-via rule area that moves with a unit (`--zone-ref`; a `u['cu']` row with net -1, via radius only). Tracks are not modelled. RELAY-4 FIELD_GND check: via O 0, W 0, S 22, P 28; gnd_pad_vias found no place for the same 28 P pads (all in MAINS_INNER_KEEPOUT or BARRIER_BAND).

Benchmark B, known-good recovery, RELAY-4 (2026-09-27; Hetzner; `bench_b.sh`). All signal tracks are removed and the FIELD_GND copper stays. Scramble seed 7 is uniform. S = a legal random placement (a search with w_wl=0 w_cong=0). P = the placer search from S. There are 5 Freerouting runs of 3.5 min each. The subset is the 56 signal nets.

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

Mains path check (2026-09-28): `mains=1` (default 0) runs `mainspath.faults` on each final candidate: the nets of the `.kicad_dru` domain classes (RELAY-4: the 12 MAINS_K* tier-1 nets) need a legal straight/L/45/Z/grid path with the dru gaps. A candidate with faults ranks after every legal candidate without; its fault records (blocking ref, net, shortfall mm) are in `candidates[].mains` of res.json. It needs a problem read with `route_rules` and `cu_nets` (kicad_io). 3.6 s (O) to 14 s (s67) per pose. Off until a bench shows a gain.

Analytic global placement (`gplace.py`, optimize `--param global=1`): ePlace style WA wirelength + electrostatic density (DCT Poisson on a bins x bins grid; fixed units, the area outside the outline and keepouts are fixed charge), Nesterov with a growing density weight until the overflow is below 0.1, and RePlAce cell inflation where RUDY is above the routing capacity (2 rounds, at most 2x area). Edge anchors are projected onto their side. The annealer then starts from the global places and turns (use a low `t0`). On RELAY-4 the global stage takes about 0.1 s. Rotation (`rotate=1`, default 0): every `rot_every` (25) iterations and at the end, each movable unit with `rotate` not false takes the turn (0/90/180/270) with the lowest WA + lambda x density energy, one unit at a time (discrete, exact on the same objective; a soft angle would make the unit boxes non-rectangular in the density map). DCT fix (2026-09-28): the u = 0 and v = 0 modes now have half weight in the inverse DCT-II (as in DREAMPlace); before, the potential of those modes was 2x too large. Test: a cosine density gives the exact potential and field. Backend (`backend=torch`, `gplace_torch.py`): the same wa() and density() on torch tensors; `device` cpu (float64, equal to numpy to 1e-9) or mps (float32); the loop, the turns and the projection stay in numpy. torch 2.8 with MPS is in the KiCad Python user site; without torch the numpy backend runs and the torch tests skip.

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

Holdout GP (2026-09-29, IO-6X6 and DOOR-RELAY; the same set-up as the RELAY-4 GP bench). Inputs come fresh from the repo boards. The tracks are stripped; the plane and zone nets stay (DOOR also keeps the locked USB tracks). Then `cli.py read` and scramble seed 7. The original is legal on both boards. There are 5 Freerouting runs of 3.5 min with GND pad vias. The Hetzner load was 12-60 from other jobs, so the wall times are not exact.

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

Local `cli.py run`, compaction stages, and `fastroute_job.py` share
`~/.cache/iot-lab/resources`. Defaults reserve at most 12 CPU worker tokens
(or the machine count if smaller), 16 GiB total declared memory, and 8 GiB
per job. These are conservative initial settings, not measured optimal settings.
Set `IOT_CPU_BUDGET`, `IOT_MEMORY_BUDGET_GIB`, and `IOT_JOB_MEMORY_GIB` consistently
for cooperating jobs. All active clients must agree on capacity; a mismatch
fails closed. An explicit request larger than capacity is rejected.

Placement workers each receive one native library thread (`OMP_NUM_THREADS`,
`OPENBLAS_NUM_THREADS`, `MKL_NUM_THREADS`, `VECLIB_MAXIMUM_THREADS`,
`NUMEXPR_NUM_THREADS`, `BLIS_NUM_THREADS`). Fastroute's admitted `--threads`
applies to both its autorouter and optimizer, supported by pinned 0.1.7 help.
Use `--threads`, not `--set` thread overrides. A child inherits its live parent's
reservation and must stay within it. CPU reservations count supported worker
pools; they are not hard OS CPU quotas. Memory is declared capacity, not an RSS
limit, and unmanaged processes remain outside admission control.

Admission is FIFO with a 30 second maximum wait, shortened by an inherited run
deadline. SIGTERM/interrupt cancels waiting work. A crashed owner releases its
file locks automatically; the next caller removes its stale reservation ticket.
No existing router is killed or displaced. Admission events record queued,
admitted, released, cancelled or failed work; compaction keeps them beside its
stage log. Logs/checkpoints remain when admission fails.

For a bounded resource profile (use a fresh output directory):

```sh
IOT_CPU_BUDGET=15 "$PY" tools/lean_resources.py --cpu 8 --memory-gib 8 \
  --seconds 60 --output /tmp/placement-resource-profile -- \
  "$PY" tools/placer/cli.py run /tmp/frozen/prob.json -o /tmp/result.json \
  --workers 8 --epochs 3 --steps 8000 --seed 1 --top 1
```

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
