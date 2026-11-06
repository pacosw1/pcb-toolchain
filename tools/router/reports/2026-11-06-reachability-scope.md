# Selected-net reachability discrepancy (#1433)

The solver applied an unrelated zone-to-via clearance to every via. This was a
false fixed-obstacle envelope, before dead-component caching or route search.
The optimistic diagnosis grid did not apply that envelope, so its `ROUTER_MISS`
classification could coexist with the solver's zero legal endpoint cells.

`RefFill::load` previously took the maximum via rule over every net in every
zone on an adjacent layer, and the maximum clearance over every class/net.
`Board::track_fixed_code` and the reverse via-to-track check used that one
number for every foreign via. In the preserved models, PQ's `/L1`-specific
8 mm zone clearance became an 8.2 mm envelope around ordinary low-voltage vias.
AIO's 4 mm cross-domain rules similarly became 4.2 mm envelopes, including in
the FIELD reference domain. The extra 0.2 mm is the existing zone minimum-width
margin; it is not a new electrical requirement.

The fix keeps a setback for each actual via net and reference domain. The model
now emits `ref_fill.references` from the same ground/eligible alternate-reference
members that produce each domain's fill, including exempt domains. Clearance,
thermal gap, the matching via rule, that net's class clearance, board minimum,
and zone minimum thickness retain their existing values. Missing membership in
an old mixed-plane model keeps all adjacent zones conservatively: regenerate
the model rather than assuming it contains the new domain binding.

Spatial query radii retain conservative maxima. Actual collision tests use the
matching setback. A conservative shared via-cache rejection is rechecked for a
candidate net with a smaller applicable setback; it cannot cache that candidate's
freedom for a high-clearance net. Fixed and negotiated copper and both insertion
orders are covered. Existing same-reference-net eligibility, isolation pair
rules, geometry, EPS, width floors, escape limits and native gates are unchanged.

## Preserved-model diagnosis

Baseline source is `558c6975765389ea1a2f4899bdbc4686ef489b67`. The source models
are the archived 0.2.13 failures, not newly routed boards. A bounded test probe
loads each model and counts legal cells inside each pad with the core's actual
cost predicate, a 0.05 mm grid aligned to the original board origin, and the
unchanged 0.002 mm EPS. It allocates a local grid around the endpoint and does
not call the router, emit copper, refill, or modify the source project.

For the fixed mixed-domain probe only, the new reference-membership field was
derived from the preserved `reference-planes.json`. Removing that field restores
the exact parsed original model; no other model values differ. The compiler
regression independently checks emission of eligible members and exclusion of
capacitor-dependent and slow-only alternate references. Model/spec/derived
hashes are in the accompanying JSON.

| Archived endpoint | Checked width (mm) | Legal cells before | Legal cells after |
| --- | ---: | ---: | ---: |
| AIO U8.3, /DAC_ALARM | 0.2 | 0 / 172 | 163 / 172 |
| AIO U8.7, /LATCH | 0.2 | 0 / 177 | 177 / 177 |
| AIO Q32.1, /WD_OK | 0.2 | 0 / 194 | 144 / 194 |
| PQ L2.2, /BST_SW | 0.5 and 0.35 | 0 / 2502 | 2502 / 2502 |
| PQ U12.5, /BST_SW | 0.5 and 0.35 | 0 / 56 | 0 / 56 |

The remaining PQ entry is not waived. Its immediate GND and `/LINK_5V1` pads
and tracks still block the sampled entry cells; no rated 0.3 mm escape stub is
found under the unchanged conservative predicate. The restored L2.2 access is
not evidence that the complete PQ connection routes. No board repair or new
board acceptance is part of this investigation.

The separate native-board diagnosis grid uses the board minimum track width
(0.15 mm in these models), shrinks obstacles by half its 0.1 mm cell, and does
not consume the solver's complete current/reference/isolation model. Its path
is neither an accepted route nor proof of solver-rule feasibility. This change
does not promote the diagnosis grid to an acceptance gate.

## Regression evidence and limits

- A small selected-net regression routes successfully with an unrelated 8 mm
  via rule present and reports zero modeled hard/pair conflicts.
- Per-via-net tests retain the actual 8 mm rule and ignore an unrelated 9 mm
  class. Fixed/routed vias, reversed insertion, and a shared cache profile are
  checked.
- Mixed-reference tests separate GND and FIELD rule selection and preserve
  conservative old-model behavior. Existing thermal-gap, minimum-width,
  rip-up, physical-clearance, and own-pour regressions remain in the suite.
- `cargo test --release --locked --quiet`: 953 passed, two existing tests
  ignored, no failures. The temporary historical-model probe was removed
  before this full-suite run.

These are solver/model tests and archived-input diagnostics. They do not prove
native DRC/parity, full configured gates, runtime performance, a completed AIO
or PQ route, release installation, board adoption, or physical qualification.
The original board-run failures remain historical failures. New candidates
must use freshly generated source-bound models and normal native verification.

Raw model/spec copies, probe source/logs and binding receipts are retained at
`/private/tmp/pcb-reachability-evidence-1433` on the development host; a checksummed
archive is preserved on the existing worker before the handoff. The temporary
probe is not part of the production source or default test suite.
