# AIO staged routing and reference feedback

The original AIO board reproduces exactly the same three reference-plane
findings as iot-lab PR #212's candidate, `run-ZmQgy8`. The staged route preserved
the defective input copper. It also skips single-run reference feedback, but
adding that loop alone cannot relocate fixed input tracks. Task #1421 stops
board experiments here under its repeated-failure rule; the failed candidate
remains unaccepted.

## Pinned evidence

The retained project is on the worker at
`/var/tmp/iot-aio-1396-0212-20261106T0016Z/project`; run paths below are relative
to `.gate/cli/run-ZmQgy8`.

| Item | Value |
| --- | --- |
| Original PCB and `operation/router/input/AIO.kicad_pcb` | `e78aacd648480582143331ea1e7de0e0499e8b61acddd65254907f39c4876008` |
| Candidate `operation/router/AIO.kicad_pcb` | `c74dd740ca97538ea304a6ba95eb97a277eee00d0a72c9f5d20e41cebdcb07db` |
| Toolchain | 0.2.12, source `743fd53f2f1d800da3a2f7acb25771252bad2a78` |
| Linux binary | `9f69901f68dd55ed035ed195d04a3d79b29a4f0528f8b17c082c8ec1dd19a25f` |
| Original worker image | `293bed2fbb778ea606f530c12d1f41fbe542f7460825d7a9f13128dc36b5929b` |
| Original resources | 2 CPUs, 32 GiB, 1800-second parent deadline |
| Original result | Failed configured gate; backend DRC/opens/parity all zero |

## What the staged path actually runs

`tools/lib/pcb-candidate-run.ts::routeJson` invokes `iotroute route`. Its in-house
backend, `job/route_run/iotroute.rs::route`, builds the model, applies the stage's
net/layer restrictions, and calls `Steps::route_and_write`. It does not call
`Run::ref_gate`. This call path is unchanged between the pinned 0.2.12 source and
the audited main revision `fb15068d86b5cc12e0a53c94ecf321bf8a1c5509`.

```text
plain run:  model -> core/write -> reference feedback -> native DRC -> outer gate
route-json: model -> stage scope -> core/write -> stage checks
            -> widths/pours/refill -> native DRC -> outer gate
```

The missing feedback is real, but its presence alone would not make the current
AIO plan a reroute. The stage starts from the fully routed original PCB.
`only_nets` and `skip_nets` select new routing work; they do not remove existing
copper. The core treats existing copper as fixed, and both the writer and final
stage enforce `keeps_copper`. `unlock_nets` is explicitly unsupported by this
backend. The AIO plan supplies no new pours, width rules or zone removals.

## Copper comparison

An independent comparison parsed the retained original and candidate native
forms with `tools/lib/sexpr.ts`, retaining numeric tokens, UUIDs and net fields.
Sorted segment/arc/via forms match on every protected and failing net. Across
the entire board, there are seven added GND segments and no removed forms.
The raw core route independently lists those same seven GND tracks and no vias.

| Net | Original items | Candidate items | Native forms |
| --- | ---: | ---: | --- |
| FIELD_0V | 451 | 451 | Identical |
| /AI1/SH | 10 | 10 | Identical |
| /AI2/SH | 10 | 10 | Identical |
| /AI3/SH | 10 | 10 | Identical |
| /AI4/SH | 12 | 12 | Identical |
| /WD_OK | 64 | 64 | Identical |
| /DAC_ALARM | 38 | 38 | Identical |
| /LATCH | 50 | 50 | Identical |

The model marks `/WD_OK` and `/DAC_ALARM` as soft reference nets and `/LATCH`
as hard. Raising soft costs only affects new search; it cannot relocate these
fixed input tracks. The old `aio_rp_repair.py` targeted RP-001 ground-via
proximity with explicit rip-up and stitching. It was not the shared
reference-plane feedback loop, and its removal alone does not establish the
cause of these detour/crossing findings.

## Original-board check

The original-board planes-only check ran on the worker from 01:09:40 to
01:11:23 UTC on 2026-11-06, with a 2-CPU/8-GiB cap, no network and the exact
original image/binary above. This is a correctness check, not a timing
comparison with the original 32-GiB route job. The retained project was mounted
read-only; the board and its sidecars were copied into an owned directory.

The command was the retained `iotroute-linux-x86_64 si-planes` with the copied
original PCB, the retained `reference-planes.json`, and `--tools /work/tools`.
It exited 1 with three failures. All three complete FAIL lines are identical to
the retained candidate gate log, including driver estimates and coordinates.

| Net, layer | Original and candidate result |
| --- | --- |
| /WD_OK, B.Cu | Two crossings; 10.2 mm detour against 1.6 mm limit; longest crossing at (121.1, 156.5) |
| /DAC_ALARM, B.Cu | One crossing; 22.4 mm detour against 13.4 mm limit; at (135.6, 152.4) |
| /LATCH, B.Cu | One forbidden fast crossing, 0.22 mm; at (138.2, 164.6) |

Both source and checked-copy hashes remain `e78aacd6...`. The owned container
was removed and its absence independently confirmed. Evidence is retained at
`/var/tmp/aio-feedback-1421/{comparison.json,original.planes.log,original.started,original.ended,original.exit}`;
the planes log SHA256 is
`c1d1ad448320c575a28993d675f736757dafc43f1a1fba12bb63b399655c2f62`.
The companion JSON retains the complete failure lines and copper comparisons.

An initial invocation at 01:08:58 UTC used the wrong tool-data directory and a
different image. It exited 2 at driver-evidence validation before checking
geometry. Its `setup1.*` evidence remains separate; it is not a board verdict.
The corrected invocation used the owner's confirmed runtime and original
project data. No reroute or input repair occurred between invocations.

## Required follow-up

The board workflow needs an explicitly reviewed isolated candidate that permits
rip-up/reroute of `/WD_OK`, `/DAC_ALARM` and `/LATCH`, while preserving FIELD_0V
and all four shunt nets exactly. Increasing passes, changing costs, or repeating
this unchanged-input stage cannot remove its fixed tracks. `only_nets` is not
an unlock operation, and the unsupported `unlock_nets` field must not be used.

The existing generic explicit route `clear` list and sealed `--from-run`
continuation are possible building blocks for preparing such a candidate;
this report does not execute that copper change or claim its outcome. A
route-json-only solution would need an explicit, scoped input-copper contract,
not silent deletion inside reference feedback. Any follow-up must retain the
five fixed-net comparisons, full fresh gate and layout semantic checks.

No runtime fix is made for these three findings: the proven immediate cause is
the supplied fixed copper, and weakening its preservation guard would violate
the current contract. The independently confirmed missing staged-feedback path
remains an integration concern for newly routed copper, coordinated with #1412
and #1416. Its existence is not evidence that feedback can repair this input.
No rules, exemptions, native CAD or board-specific scripts were changed. No
adoption, release approval or physical qualification is established.
