# Exact edge legalization (#1356)

The default exact edge admission check already covered plain runs and sprints in `fef68e2`. The remaining problem was the legalizer: it skipped units whose raster penalty was zero, even when the final exact pad-edge check rejected them.

The same exact geometry predicate now serves final admission and the existing legalizer's current-position and trial-position checks. The ring search keeps its existing step, radius, cost ranking, spacing/keepout checks, fixed-unit exclusion, displacement bounds, permitted rotations, and deadline. No annealing, random-number, or router search behavior changes. A failure to find a legal spot remains a failure; no clearance is relaxed.

## Retained real case

One ENV-SENSE copy, run locally on Hetzner. Canonical board SHA-256 `b4bb4a9d759a5d6b9425127ca1a378b48f97e2c8b0b69cf0fa4d221bf2bce0f4`; frozen placement problem SHA-256 `ab59cf9e540274bff000bcfee9578a66d603b98b6b1623f8471457dcaeadebfd`. Baseline binary is released `696715d`.

Both arms use `iotplace run PROBLEM -o RESULT --seed 1 --workers 2 --epochs 12 --steps 100000` with default parameters. Their histories and prelegal poses are identical. Worker 0's final pose is unchanged. Only worker 1's U3 moves, from `(123.55,112.85,0)` to `(123.80,112.85,0)`: 0.25 mm inward, no rotation. All fixed units remain unchanged. Legal candidate count changes from 1/2 to 2/2.

| Worker 1 check | Before | After |
| --- | --- | --- |
| Raster overlap / edge penalty | 0 / 0 | 0 / 0 |
| Exact edge admission | `edge:U3` | legal |
| KiCad preflight | 2 copper-edge errors: 0.470 mm actual, 0.500 mm required | passes |
| `iotroute run` DRC / unconnected / parity | blocked before search | 0 / 0 / 0, PASS |
| Verified candidate count for this matched case | 0/1 | 1/1 |

Both candidate poses are written to scratch board copies by `iotplace write`, using the same source and board JSON. The unchanged released router uses `--seed 7 --iters 6 --max-time 90`. The repaired candidate verifies with 165 tracks, 25 vias, and 178.8 mm track length. This is one recovered candidate, not a rerun of the historical 15-seed benchmark or evidence of a general success-rate increase. No canonical board is edited. These real-board checks run on Hetzner, not in CI.

The common worker 0 pose, identical in both arms, was also written and verified once. It has 0 DRC errors and 0 parity errors but 1 unconnected item: FAIL, despite the core's native PASS claim. Therefore the complete two-candidate shortlist improves from **0/2 to 1/2 independently verified** at this fixed routing budget. The top-ranked candidate changes from worker 0 (FAIL) to repaired worker 1 (PASS).

## Regression checks

The plain-run regression starts with a pad inside an off-grid edge's clearance while its raster penalty is zero. It checks exact repair and continued raster legality, verifies the shared plain-run result, confirms a displacement bound prevents the move, and preserves `exact_edge=0` golden behavior. The full Rust placer suite passes, including sprint and golden comparisons.
