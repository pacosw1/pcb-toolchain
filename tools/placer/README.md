Tests (from the repo root; needs numpy and pcbnew, so use the KiCad Python): `/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3 -m unittest discover -s tools/placer -p 'test_*.py'` (without KiCad: `uv run --with numpy python -m unittest discover -s tools/placer -p 'test_*.py'` runs the cost and search tests; the pcbnew tests skip). Search and benchmark runs go on Hetzner only (`tools/remote.sh`); this Mac runs tests and short smoke runs only.

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

Compaction (`compact_cli.py`, easy to hard): each unit gets a routing halo = s * 0.4 * sqrt(fan-out) mm (`compact.HALO`), used as its spacing. The first step uses a large s on a virtual board (the outline scaled by k about its centre, k from the unit area at fill 0.5). Each step: search on Hetzner, legalize, write, then 2 Freerouting runs (300 s). A step passes when the best run is at or below `--target` unrouted. After a pass, s goes down 15 %. After the first fail, the step size is halved (bisect, 5 % tolerance). When the best pass is on a virtual board (k > 1), an outline phase follows. It tries the real board (k = 1) first, then bisects k to 2 %. Each step uses the largest halo that fits (`s_fit`). `--budget` defaults to 45 min. Full-board zones (ground pours) grow with the virtual outline, so the refill reaches the moved parts. `--snapshots DIR` writes `viewer.html` (self-contained: slider, play, click a part), `frames.json`, the timelapse (`movie.py`: PNG frames, `run.gif`, `run.mp4`) and one `kicad-cli` render of the best routed board per step.

Board constraints for `cli.py read`: `--edge REF=SIDES:SIDE` puts the N/S/E/W courtyard side of REF (as placed now) on one of the board edges in SIDES (L, R, T, B; T = smaller y); the miss counts as forbidden area and makes the unit illegal. `--keepout-zone 'H*_KEEPOUT'` makes named rule areas keepouts. `--zone-ref U1_ANTENNA=U5` moves a rule area with the unit of a part (an antenna or mains keepout of a block), and the area keeps other parts out (it may overlap another keepout: a hole keepout or a keepout of another unit); the part beyond an edge anchor is cut off. Other rule areas stay where they are. A connector staged wholly outside the outline is movable. `--scatter SEED` (compact_cli) starts each search from random places inside the board. A pad of a net class with a larger clearance than the D-040 class (for example the 3.0 mm mains classes) gets its own spacing rect; the courtyard keeps the D-040 class. A board slot inside a block border belongs to the block (a keepout rect that moves with it). The domain rules come from the board .kicad_dru (`dru.py`; `--domain 'MAINS_K*:8:3'` is an override for tests): each pad of such a net class keeps 8 mm to all other nets and 3 mm to another class of the domain; a part with domain pads gives every pad its own rect, and its courtyard, a block border, a slot and a part with no net pad keep only their own class to a domain pad. A .kicad_dru hole rule (RELAY-4 "Mains to screw hole" 9.65 mm) keeps its gap from the hole pads to the domain pads. `cli.py read` lists the clearance rules it cannot read (for example the IO-6X6 two-set "Isolation barrier") as NOT MODELLED. Hard (illegal) = what KiCad DRC enforces: courtyard over courtyard, pad clearance rects, domain and hole gaps, keepouts, the board edge. The D-040 halo between courtyards is a soft cost (`w_sp`, default 2.0 per mm2). Gate test: the RELAY-4 original is legal, and the benchmark B v2 placement P (`testdata/`) is illegal.

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
