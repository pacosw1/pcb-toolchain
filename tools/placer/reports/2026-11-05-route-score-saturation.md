# ENV-SENSE route-score saturation (#1370)

The zero scores reproduce on current main. They are **valid zero overflow values on a sparse demand map**, not missing
net data, a floating-point failure, or a problem already repaired by the exact-edge legalizer.

Checkpoints now expose `route_pressure`, the map's peak requested fraction of routing capacity before clipping.
`--param route_pressure=1` can use that value after equal overflow, before the existing cost. It is **off by default**:
the matched check changes the selected poses but verifies 1/2 winners under either policy, and the pressure-selected
clean route uses more vias and length. This is a discriminator and diagnostic, not a demonstrated routing-quality gain.

## Reproduction

One retained ENV-SENSE fixture on Hetzner (`gopadel-ci1`), outside CI. No second board, canonical CAD edits or Python additions.
Base source is `06b32160783ddb0058909634daeddf0ac6d28e5d`, including the exact-edge legalization repair from PR 53.
The fixture is the retained `/tmp/edge1356-proof` input used by [that study](2026-11-05-exact-edge-legalizer.md).

| Item | SHA-256 |
| --- | --- |
| Frozen problem | `ab59cf9e540274bff000bcfee9578a66d603b98b6b1623f8471457dcaeadebfd` |
| Original PCB | `b4bb4a9d759a5d6b9425127ca1a378b48f97e2c8b0b69cf0fa4d221bf2bce0f4` |
| Baseline placer | `90375ed0980cd7af41a68ef2f5fca6d17a9d98ad30617b3a8252e4c3719f9734` |
| Trial placer used to produce routed selections | `35e0afb36d822076a3f73d7f3984fa0e39245ec6f44ce68525848c38bef16eed` |
| Final default-off / opt-in replay placer | `5f80afed73b7150a622b69e0e218e429bb9c8ee89ea0025cc6a873de3ec634f3` |
| Unchanged native router | `f5df44552d3672b8e026db75710dd4eacc8a179cbf035e6d150fc89f0323b0ff` |

Build: `rust:1.93.1-bookworm`, release/locked. Native runtime: `iot-lab-route:10.0-nightly-4fe1ca2060`.
Scratch workspace: `/var/tmp/placer-score-1370`. Frozen inputs are mounted read-only in board jobs.

Two fixed search seeds, 1 and 2, use four workers, twelve epochs, 100,000 steps per epoch and top four candidates.
`--budget-s 1000` selects independent sprint workers but does not cut either run short: all twelve epochs execute.
The search gets four CPUs and 6 GiB; native checks get one CPU and 4 GiB in network-disabled containers.
This is a small matched reproduction, not a repeat of the historical scrambled-start, fifteen-seed study.

## Proven cause

`Scorer` uses the same RUDY model with `tracks=1` and the existing `limit=0.3`.
Its cell threshold is `limit * cell_area * layers / pitch = 0.3 * 1 * 2 / 0.4 = 1.5`.
`NetState::overflow` sums only demand above that threshold. The native Rust probe finds 900 cells, four nets with valid
nonzero track widths, peak demand 0.4395-0.5672, and **zero cells above 1.5 on every candidate**.
All eight diverse, legal poses therefore have `route_score=0` exactly as the formula defines it.

Peak utilization is `max(cell_demand * existing_cell_weight / capacity)`, with the same capacity and existing optional
region weights; it has no clipping threshold. It ranges from 0.08791 to 0.11344 here. No annealing objective, numeric
weight, existing overflow limit, placement constraint, legalization bound or native acceptance rule changes.

| Seed | Worker | Existing cost | Overflow | Unclipped peak utilization |
| --- | --- | --- | --- | --- |
| 1 | 1 (old winner) | 92.1406 | 0 | 0.098638 |
| 1 | 0 (pressure winner) | 98.1224 | 0 | 0.087909 |
| 1 | 2 | 98.9033 | 0 | 0.094174 |
| 1 | 3 | 100.9100 | 0 | 0.090460 |
| 2 | 0 (old winner) | 89.5278 | 0 | 0.100426 |
| 2 | 2 (pressure winner) | 91.0837 | 0 | 0.099342 |
| 2 | 1 | 91.9573 | 0 | 0.113441 |
| 2 | 3 | 93.3373 | 0 | 0.106617 |

## Change and preserved defaults

The checkpoint records both overflow and pressure. An opt-in sprint adds pressure to each candidate and orders it as:

```
legality -> mains faults -> overflow -> pressure -> existing cost -> worker
```

Defaults omit the candidate pressure field and preserve the prior ordering. Plain runs do not use this sprint ranking.
`route_pressure` accepts only 0 or 1, so it cannot silently become an unmeasured weight. Rust and the CLI's engineering
post-screen sort use the same order. The existing scalar `Scorer::score` API retains its overflow meaning.

Final-binary replay confirms identical worker-to-pose maps and search histories before/after, all fixed units preserved,
the default order unchanged, and opt-in order matching the trial candidates that were routed. Only the final ordering
changes. No candidate was moved or generated differently to improve this comparison.

## Independent routing and original full gate

All four distinct selected poses are written by the same native writer against the same frozen CAD, native board JSON
and original project/rule sidecars. The unchanged current-main router uses `--seed 7 --iters 6 --max-time 90` for every
candidate, followed by the full original ENV-SENSE gate with isolated, fresh evidence.

| Seed / selection | Worker | Native DRC / opens / parity | Track length | Vias | Full original gate |
| --- | --- | --- | --- | --- | --- |
| 1 / default | 1 | 0 / 1 / 0 | 177.2 mm | 23 | FAIL: one open |
| 1 / pressure | 0 | 0 / 1 / 0 | 204.4 mm | 19 | FAIL: one open, one kicad-happy finding |
| 2 / default | 0 | 0 / 0 / 0 | 179.6 mm | 24 | PASS |
| 2 / pressure | 2 | 0 / 0 / 0 | 186.0 mm | 31 | PASS |

Verified winners remain **1/2 vs 1/2**. The pressure-selected clean route takes 16.0 s versus 23.7 s for the default
in this sample, but has seven more vias and 6.4 mm more track. There are no repeated timing samples or general
success-rate claims. A lower RUDY pressure remains a proxy; it does not establish actual escape feasibility,
connectivity, return paths, thermal behavior or physical board qualification. Default ranking remains unchanged.

Setup-only attempts are retained separately and excluded from these board results: an initial writer call used the
greedy flag parser's wrong argument spelling, and the first scratch placement folder lacked the project sidecars.
Those were corrected before measured routes. The first full gate also lacked its scratch helper directory; after
supplying the unchanged helpers, only that incomplete gate was rerun as `gate-complete`. Its one-open result stayed
unchanged. No router attempt was repeated to tune a result or obtain a pass.

## Validation and evidence

- Full Rust placer suite: 412 tests passed on Hetzner, including the existing golden comparisons.
- CLI engineering screening tests: 9 passed, including preservation of native pressure ordering after review.
- New checks prove sub-threshold maps still distinguish pressure, legality/overflow remain primary, opt-in preserves
  the search poses, default candidate ordering stays unchanged, and a fractional switch is refused.
- Final native source/gate measurements, commands, hashes, replay checks and both acceptance outcomes are in
  [the JSON record](2026-11-05-route-score-saturation.json).

Durable raw evidence: `gopadel-ci1:/var/lib/cip/saved-artifacts/placer-score-1370/evidence.tar.gz` (2.6 MiB), SHA-256
`cc316fa495600631144d2f439cd80b80eef16f82ef97ea996ca6c902073c1360`.
It retains inputs, before/trial/final search outputs, diagnostics, four selected board copies and native/full-gate logs.
No production image or canonical layout was adopted.
