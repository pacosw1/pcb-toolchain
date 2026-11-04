# Router reference rule in the gate's scope (2026-11-02, branch claude/router-ref-gate-scope)

Goal (lead decision 2026-11-02): the PR #94 reference-plane rule must accept exactly what `tools/si_planes.py` accepts,
never less. That covers short stubs off the plane, the detour / edge budget, alt refs with cap_mm / slow_only, and the
report-only WARN cases. In the core, a crossing that the gate accepts gets a cost, not a block, and a crossing that the
gate rejects stays blocked. Benchmark only: scratch copies, committed boards and reference-planes.json not changed.
Scratch: `scratchpad/rrg/` (runs/, gate-*.txt, ev-*, dump_d124c.py).

Result: **STUCK** on POE-ETHERNET: FAIL 0 / 1 / 0, /ETH_CT open. INPUT-4D2A, hand NET-CORE and FW-IO: PASS, gate PASS.

## 1. What the gate accepts (read from si_planes.py, not copied)

The gate counts only the D-124c enforced screen (`d124c_reference_failures`, si_planes.py line 1284). For a checked
net that is not fast and not power, each run of unreferenced samples is a crossing:
- a run with fewer than two terminal groups is a stub (`d124c_detour_mm`: "Fewer than two terminals: a stub, no
  crossing: 0"), and it passes;
- a run whose terminal snap discs meet in reference copper has detour 0 and passes at any edge. A terminal next to
  the net's own pad or via has snap = anchor radius + via_allow_mm + step_mm;
- otherwise the return detour must be within detour_budget_mm(tr) for a known edge time; with no rule at all when
  the budget is larger than the board perimeter;
- an unknown driver passes only with detour 0;
- a fast net may cross no gap; a track over another domain's ground fails for every net.

D-124d findings (native projection, stub proof, timing evidence) are WARN lines. They are not counted.

Example, the committed POE board (`dump_d124c.py`, which wraps si_planes and does not change it): the hand route of
/ETH_CT leaves J1.3 on B.Cu with a 1.24 mm run. Its terminals are (121.05, 113.83, snap 1.61), next to the J1.3
anchor, and (122.53, 113.83, snap 0.25), on the fill. Detour 0.0, so it passes. PR #94 blocked every off-reference
sample, so the router could not find this route.

## 2. Change

The core prices the soft nets' off-reference steps, and the gate's si_planes judges the written board:
- **model.py `reference_fill`:**
  - every checked net with a domain gets `ref_soft = not si_planes.is_fast(net, s)`;
  - the fast patterns are now loaded with `si_planes.load_fast`, as si_planes main does. Without it no net was fast:
    NET-CORE has 27 fast reference nets, which stay hard.
- **core `reffill.rs` / `main.rs`:**
  - a soft net is not blocked off its reference (pflags bit 7; the domain uses bits 2..6);
  - each off-reference A* step costs x (1 + price). The price is the model net `ref_cost`, default 3.0. This is a
    search preference like the via cost, not a rule;
  - string pulling keeps a soft net on its reference where the A* path stayed on it, so the price is not undone
    after the search;
  - hard nets stay blocked, as in PR #94.
- **run.py `ref_gate_rounds`:**
  - after the write, run.py runs `tools/si_planes.py BOARD <gate.json checks.planes spec>`, the gate's own planes
    check;
  - each soft net named in a D-124c FAIL line (domain-cross, fast-crossing, unknown-driver, detour) gets its price
    x10, at most twice, and then it is set hard (blocked);
  - the board is routed again, at most 4 times. The record is in result.json `stages.ref_gate.rounds`;
  - a board with no soft nets or no planes check has no rounds.

Exact by construction: the router never decides on its own which crossing is legal. A soft run stays in the result
only when si_planes passes it.

## 3. Results

run.py lock-from the committed board (FW-IO: from its project board). Gate = `node tools/gate.mjs BOARD --fresh` in a
clean origin/main worktree (9271fac3).

| Board | run.py (DRC / unconnected / parity) | ref_gate rounds | Gate --fresh |
| --- | --- | --- | --- |
| INPUT-4D2A (`runs/input4`) | PASS 0 / 0 / 0, 156 vias | 1 round, 0 FAIL lines | PASS, planes 0, all counts 0, with an empty exemption file (committed file: 10 stale RP-001 entries, as in reports/2026-11-01-isolation.md) (`gate-input4e.txt`) |
| hand NET-CORE (`runs/hand4`) | PASS 0 / 0 / 0, 264 vias | 1 round, 0 FAIL lines | PASS, all counts 0 (`gate-hand4.txt`) |
| FW-IO (`runs/fwio4`) | PASS 0 / 0 / 0, 166 vias | 1 round, 0 FAIL lines | PASS, all counts 0 (`gate-fwio4.txt`) |
| POE-ETHERNET (`runs/poe3`, `--return-exempt`) | FAIL 0 / 1 / 0 (/ETH_CT) | 4 rounds | not run |

Gap left: a hard (fast) net is still blocked on PR #94's reference area. That area leaves out alt refs with cap_mm or
slow_only, so in that corner a fast net is stricter than the gate. None of the four boards has a fast net over such
an alt ref.

POE-ETHERNET rounds (`runs/poe3/.../planes-r*.log`):

| Round | Core | si_planes FAIL lines | Action |
| --- | --- | --- | --- |
| 1 | not converged: /ETH_CT, /ETH_RESET, /LED_LINK_K, /MOSI stand off at J1 | /ETH_CT 11.8 mm off-reference run on F.Cu at (118.1, 111.0), no reference path; /LED_ACT_K run 6.7 mm at (170.4, 127.6), detour 4.2 mm, unknown driver | price x10 |
| 2 | not converged, 1 open | /ETH_CT 11.7 mm; /LED_ACT_K; /LED_LINK_K 13.2 mm at (168.1, 127.8) | price x10 |
| 3 | PASS in the core (failed 0) | /ETH_CT 11.7 mm; /LED_LINK_K 4.4 mm; /LED_ACT_K 2.9 mm | /ETH_CT and /LED_ACT_K hard, /LED_LINK_K x10 |
| 4 | converged at iteration 55; /ETH_CT not reachable past fixed copper at J1.3 | 0 | end: FAIL 0 / 1 / 0 |

## 4. Cause of the POE failure (STUCK: the same J1 standoff as in reports/2026-11-02-layer-negotiation.md)

/ETH_CT has one accepted exit: B.Cu east from J1.3, about 1.2 mm off the plane, as on the hand board. The router does
not take it, even at x100 price. In the round-2 board, VDD_3V3 runs on B.Cu at y = 112.65 from x = 118.9 to 124.75,
right across that corridor. It comes from J1.11, which is outside every VDD_3V3 zone. The /LED_*_K nets also cross J1
on B.Cu. The other side of J1.3 is F.Cu, which the locked /MAG_* pairs occupy. So /ETH_CT keeps its 11.7 mm F.Cu
alternative through the J1 box. The core accepts that route (soft, only priced), and the gate rejects it. Once
/ETH_CT is set hard, J1.3 has no legal exit left.

This is the J1 standoff of PR #98 a second time, now with the reference rule in the gate's scope, so I stopped
(same failure twice).

Partial-plane model for VDD_3V3: not done. It would not open the corridor. J1.11 and J1.13 lie outside every
VDD_3V3 zone, and the nearest In2 VDD_3V3 fill starts at x = 122.5, so their tracks still cross J1. That is the
track that blocks /ETH_CT.

## 5. Next (a decision for the lead)

1. A negotiation that prices the accepted alternative of a net against the corridor it needs. For example, history
   on the cells of a rejected soft run, plus present cost on the routed nets in the gate-accepted corridor of
   /ETH_CT (the snap-disc region of J1.3). Then VDD_3V3 moves off B.Cu y = 112.65, instead of /ETH_CT taking the
   long F.Cu run.
2. Or: route J1.11 / J1.13 VDD_3V3 north around J1 on F.Cu, as on the hand board (F 83 mm, 6 vias). The router
   should find this once item 1 exists.

## 6. Tests

- `cargo test --release`: 80 pass. New: tests_reffill `soft_reference_is_priced_not_blocked`. It checks that a soft
  net is not blocked over the void, that a hard net is, that soft and hard nets keep separate memo profiles, and that
  the A* plus string pulling route around a 4 mm void.
- KiCad Python `-m unittest test_run test_pairrules test_iso_board test_model`: 45 pass. New:
  - test_run `RefGate`: FAIL-line parse; no soft net means no round;
  - test_model `test_soft_reference_nets_follow_si_planes`: NET-CORE /ETH_REF_CLK hard (fast file), /CH_LED0 soft,
    POE /ETH_CT soft.
