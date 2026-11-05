# Engineering workflow

Use the existing PCB CLI from requirements and architecture through parts,
schematic, placement, routing, prototype and production evidence.
KiCad remains authoritative. Original PDF evidence, reviewed engineering facts,
current sourcing evidence and measured qualification are separate records.

Start one observation cycle with one integration owner. Independent part and
datasheet reviews can run concurrently; candidate edits remain isolated and
adoption retains the existing single-writer lock and frozen-board defect check.

```sh
tools/pcb cycle start ENV-SENSE --owner integrator --json
tools/pcb parts --cycle CYCLE_ID --json status ENV-SENSE
tools/pcb parts --cycle CYCLE_ID --json inspect path/to/original.pdf --cache .gate/pdf-inspection
tools/pcb parts --cycle CYCLE_ID --json verify ENV-SENSE --manifest REVIEW.json
tools/pcb parts --cycle CYCLE_ID --json stock ENV-SENSE --candidate RELEASE_DIR --boards 5 --receipts NEW_STOCK_DIR
tools/pcb placement --cycle CYCLE_ID --json check ENV-SENSE --manifest REVIEW.json
tools/pcb edit ENV-SENSE --kind place --spec MOVE.json --engineering-manifest REVIEW.json --cycle CYCLE_ID --detach --json
tools/pcb routing --from-run PLACEMENT_RUN --cycle CYCLE_ID --json diagnose ENV-SENSE --evidence PLACEMENT_GATE_RESULT.json
tools/pcb routing --cycle CYCLE_ID --json diagnose ENV-SENSE --evidence DIAGNOSTICS.json
tools/pcb repair ENV-SENSE --plan PLAN.json --engineering-manifest REVIEW.json --cycle CYCLE_ID --detach --json
tools/pcb events RUN_ID --after 0 --wait 20 --json
tools/pcb explain RUN_ID --json
```

Explicit placement and routing JSON specs are strict: unknown fields, including
nested grid, route, via and move-via fields, fail before native work. Placement
accepts `place` (reference to `[x_mm, y_mm, rotation_deg]`) and `grids`; explicit
routing requires `routes` and optionally accepts `clear`, `move_vias` and `via`.
For example, `{"plcae":{"U1":[10,20,90]}}` is an error, not an empty placement.
Numeric fields must be finite numbers; booleans and arrays are not coerced. The
supervisor and direct `pcbtool` commands share these checks. This validates input
syntax; it does not grant movement authority or replace reviewed stage, scope,
native gate or adoption checks.

Put supervisor options before the action for `parts`, `placement` and `routing`;
arguments after the action belong to that backend. This also applies to `design`,
`schematic` and `outcomes`. Every operation uses the
existing journal, deadline, cancellation, process cleanup and evidence sealing.
Each terminal receipt points to `operation/report.json` or its candidate guard
and fresh gate evidence. Use that run ID as the handoff.

Use `--from-run RUN_ID` to continue a sealed placement/routing candidate in a new
isolated workspace. A candidate may have open connections while remaining a valid
input for further work: its exact original source, protected identity, parent CAD
and evidence must still match. Use the same parent on `routing diagnose` and
`repair`. No failed or partial candidate can be adopted; the final candidate must
pass all current checks. `next` recommends diagnosis for an otherwise valid
candidate with native opens and a supported repair when diagnosis produces one.

Part review and PDF inspection: [PART-EVIDENCE.md](PART-EVIDENCE.md).
Supported placement requirements and block reuse: [PLACEMENT-CONSTRAINTS.md](PLACEMENT-CONSTRAINTS.md).
Routing decisions and repair limits: [ROUTE-DECISIONS.md](ROUTE-DECISIONS.md).
Idea-to-production intent and test plans: [DESIGN-CONTRACT.md](DESIGN-CONTRACT.md).
Native schematic function assertions: [SCHEMATIC-CONTRACT.md](SCHEMATIC-CONTRACT.md).
Placement judged by actual routing outcomes: [PLACEMENT-OUTCOMES.md](PLACEMENT-OUTCOMES.md).

A candidate with a reviewed engineering manifest must pass exact part-evidence
checks before editing, placement requirements before routing, and placement/block
checks after edits. Geometric defects may be repaired by placement; stale or
unsupported engineering evidence cannot justify a candidate. The original source
and all reviewed dependencies must still match at adoption. Full configured native,
electrical and reference-path gates remain necessary; passing a local screen never
qualifies the board. No existing selected-part, stock or bench state is promoted.

## Observe the whole cycle

Owned commands linked with `--cycle` contribute their actual run outcome and
timings automatically. Record engineering review intervals explicitly:

```sh
tools/pcb cycle begin CYCLE_ID --stage datasheets --owner reviewer --description 'Review exact ordering code and pin table' --json
tools/pcb cycle end CYCLE_ID --activity ACTIVITY_ID --outcome blocked --evidence REVIEW.json --decision 'Package variant remains unresolved' --json
tools/pcb cycle attach CYCLE_ID --run RUN_ID --stage schematic --json
tools/pcb cycle status CYCLE_ID --json
tools/pcb cycle finish CYCLE_ID --json
```

Stages are requirements, architecture, parts, datasheets, schematic, placement,
routing, verification, release, prototype and production. The summary retains failures/rework, stage coverage,
review intervals, owned run durations, active stages and evidence freshness.
Covered elapsed time uses interval unions so parallel work is not counted twice.
Recorded failure and rework causes link back to the exact run or review activity;
current assessment freshness is reported separately from its preserved history.
Review intervals measure recorded elapsed time; human attention and unrecorded work
stay unknown. A cycle can close with recorded blockers once its activities and
owned jobs settle. `status: recorded` means observation ended; it grants no design,
release, procurement or bench qualification. Changed evidence is reported explicitly.

Candidate operations automatically consume an existing
`hardware-design/registry/part-reviews/BOARD.json`; `--engineering-manifest` selects
another explicit reviewed input. Boards without a review retain their existing
gate behavior and `parts status` reports the missing engineering coverage.

An explicit `--design-contract FILE`, or an existing
`hardware-design/registry/design-contracts/BOARD.json`, adds lifecycle prerequisite
checks to candidate operations. Build requires architecture evidence, placement
edits require schematic evidence, routing/repair requires placement evidence, and
release requires routing evidence. Missing or stale prerequisites stop before
candidate generation. The consumed source and checker dependencies stay bound
through adoption. Routing also checks the actual continued candidate's layout;
all edited candidates must pass declared placement and test-access constraints
before the fresh native gate. A native candidate's contract must name its exact
board. A design contract can start with `board: null`; its requirements
and architecture remain reviewable before a KiCad project exists.

`next DESIGN_ID --design-contract FILE --through STAGE --json` reads a sealed
assessment and checks its input fingerprints. It does not repeat native checks.
Two identical current failures produce `stuck` and a cited cause to resolve before
another attempt. Missing inputs becoming present expire the old blocker. No
lifecycle assessment promotes stock, procurement, physical qualification or
production approval.
