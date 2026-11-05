# PCB workflow CLI

For reviewed parts, sourced placement rules, diagnostic repairs and engineering
cycle measurement, see [PCB-ENGINEERING.md](PCB-ENGINEERING.md).
For source-bound datasets and small advisory models, see [PCB-ML.md](PCB-ML.md).

`tools/pcb` is the repository entrypoint for board context, builds, explicit
placement/routing changes, checks, fabrication candidates and block evidence.
It uses existing native tools and gate targets. Requirements: macOS/Linux,
Node 22.6+, Git, KiCad 10.0.6 and the prebuilt Rust tools. Remaining legacy scripts and upstream checks need Python on the worker. Windows is unsupported.
No CLI installation or service is needed. `tools/pcb doctor --follow` diagnoses
the required environment with bounded probes and live output.

```sh
tools/pcb list --json
tools/pcb context ENV-SENSE --json
tools/pcb next ENV-SENSE --json
tools/pcb check ENV-SENSE --changed --detach --json
tools/pcb events RUN_ID --json --after CURSOR --wait 20
tools/pcb status RUN_ID --json
tools/pcb explain RUN_ID --json
tools/pcb cancel RUN_ID --json
```

Before native CAD exists, check a reviewed part-use manifest with
`tools/pcb parts --json selection PLANNED-BOARD --manifest FILE`. This evaluates
sourced limits, demands and applicability conditions and streams the usual run
events. Its result explicitly leaves native assets, CAD and current assembly
stock unverified. `parts verify` remains the strict installed-native check.
Use a design `part_selection` check to include this early decision in
`tools/pcb design --json check DESIGN --contract FILE --through parts`.

`context` derives revision ownership, frozen status, native project, gate policy,
packet sources and commands from the registry, FOCUS and board files. Historical
gates remain observations until dependencies are verified again. Missing context
files remain explicit blockers.

`next` returns the first actionable blocker, its original evidence, and a
shell-safe `next_action.argv`/`command` with its working directory. It reads the
latest matching unified run, checks source/tool dependencies and sealed evidence,
and keeps stale, missing, running and candidate observations distinct. It never
executes the recommendation. Missing packet inputs name the exact file to review;
an old gate pointer cannot establish current readiness. Use `--runs-dir` when the
run store is outside the default location.

## Execution contract

`check`, `build`, `edit`, `route`, `repair`, `release`, `doctor`, `blocks`,
`readiness`, `parts`, `placement`, `routing`, `design`, `schematic`, `outcomes` and `ml` share one owned supervisor and
durable run record. They follow events by default.
`--detach --json` immediately returns one JSON object with a run ID. Following
with `--json`, and `events --json`, stream JSON Lines. Put lifecycle options
**before** arguments passed to the block/readiness tools:

```sh
tools/pcb blocks --detach --json native BLOCK-ID --output /absolute/new/evidence
tools/pcb blocks --json inventory ENV-SENSE
tools/pcb release BASE-PWR --detach --json
tools/pcb readiness --json BASE-PWR /absolute/candidate --stock /absolute/stock
```

Each event includes schema version, run ID, sequence, time, elapsed seconds,
type and a returned byte cursor. Reconnect using that cursor. Polling reads at
most 100 events by default (`--limit 1..1000`) and waits at most 60 seconds. Partial
trailing writes wait for the next read. Disconnecting a reader does not cancel.
Inspection commands return 0 when inspection works; read the run's verdict.

Actual tool start/output/exit events, parsed check verdicts, cache hits/misses,
dependency blocks, liveness heartbeats and one terminal event stay distinct.
Heartbeats explicitly report unknown progress; no invented ETA. Output events
carry at most 1600 characters per chunk; original logs stay live.
Terminal events, status and explain retain compact inventory counts and the exact
`result.json` path/hash. Full source/artifact hash maps remain in that sealed file.

`--timeout 600` and `--heartbeat 5` are execution policies in seconds. Ctrl-C
requests cancellation and follows cleanup. `cancel` acknowledges the request;
status confirms termination. The owned broker cleans the process family,
including TERM-resistant descendants. Uncertain cleanup is an error. Stored
PIDs are never blindly signalled; completed supervisors cannot be replayed.

Final codes: 0 passed for the stated scope, 1 findings/blocked, 2 infrastructure
or invalid evidence, 124 deadline, 130 cancellation. Passing a configured gate,
producing fabrication outputs, assembly readiness and measured qualification
are separate scopes. The terminal result names its scope.

## Checks and findings

Preflight checks required inputs/tools, then ERC/DRC run concurrently. Expensive
dependent checks wait for valid native evidence. Malformed reports, failed
invocations and parity defects block dependents. Editing also stops dependents
on DRC errors. Blocked metrics remain null; valid native defects remain actionable.

Default and `--fresh` run new checks. Editing-only `--changed` reuses per-check
receipts bound to source, rules, libraries, checker code, tool binaries/versions,
artifact hashes and parsed metrics. Corruption or changed inputs invalidate the
affected receipt. G5 and tracked `--write` reject cached mode. Checks preserve
canonical CAD, tracked metrics and the board's latest-gate pointer.

```sh
tools/pcb check ENV-SENSE --fresh --baseline PRIOR_RUN --json
```

`gate/findings.json` contains stable IDs, rule/severity, available refs/nets/pads,
coordinates, measurements/requirements/sources and original evidence links.
Missing thresholds are not invented. Deltas distinguish new, resolved, unchanged
and unverified findings. Blocked checks cannot silently resolve prior findings.

## Candidate changes

```sh
tools/pcb build BOARD --detach --json
tools/pcb edit BOARD --kind place --spec /absolute/placement.json --json
tools/pcb route BOARD --spec /absolute/routes.json --json
tools/pcb adopt RUN_ID --json
```

Build dispatch uses an existing board's configured pipeline; unsupported boards
fail explicitly. The entrypoint must be a regular, repository-relative file in
`tools/` or the registered board owner's source tree, without symlink components
or paths excluded from the candidate snapshot. The entrypoint is copied and
hashed with the candidate inputs. This check does not sandbox a script or prove
its external dependencies. It does not create a new board revision.
Placement specs use `{"place":{"R1":[x,y,degrees]}}`; routes use the existing
`pcbtool` format. Commands run in a separate board/dependency snapshot without
mutable links into canonical CAD. Historical runs/unrelated evidence are excluded.
Source hashes detect concurrent edits. Parts, locked footprint poses, pad/net assignments, outline,
stackup and rules remain protected; changes require an explicit design revision.
Identity checks tolerate serialization reordering of complete keepout rule areas
among their existing slots while preserving every area, UUID, name, geometry,
multiplicity and nested order. Copper-zone order and other protected forms
remain significant.

For a board with a `route.json` (schema `iot-lab.route.v1`, see `tools/router/core/src/plan/`), use
`tools/pcb route BOARD --router route-json --detach --json`. `--spec` is optional for this
router; the default is the board folder `route.json`. The run executes `iotroute route` on the
candidate board, then the normal gate, seal and `pcb adopt` flow applies.
Give it an unrouted candidate: `iotroute route` adds the `route.json` pours, and on a routed board
they overlap the pours already there (`zones_intersect`).
The backends are `tracemaker` (`$TRACEMAKER_BIN`) and `iotroute`. A `route.json` with `"backend": "fastroute"` stops with a
named error: Fastroute was removed on 2026-11-05.
`"backend": "iotroute"` runs each stage on our own router. Of `features` it takes `rule_compiler`, `via_off_small_pads`
and `via_halo`, which it always does; any other feature, a feature set to false, and a stage's `threads`, `unlock_nets` or
`via_skip` are refused by name (`tools/router/core/src/job/route_run/iotroute.rs`). `neck_um` is the narrowest a wider net may
neck and the width it retries at; a current floor above it stays, and a pad narrower than it is entered at the pad's width.

For the in-house router (tools/router/DESIGN.md), use
`tools/pcb route BOARD --router iotroute [--spec POLICY.json] --detach --json`. The run executes
`iotroute run` from the snapshot on the candidate board (model, iotroute, write, KiCad DRC with
parity on the saved fill), the same way as `route-json`. Then the normal gate, seal and `pcb adopt` flow
applies. A iotroute run FAIL (DRC, unconnected or parity not 0) is a failed route and the candidate is not
replaced. The router's own counts are never the verdict. `--spec` is optional; the policy has only these fields:

```json
{"schema":"iot-lab.iotroute-policy.v1","iters":80,"max_time_s":null,"keep":"lock-nets","return_exempt":false,"layers":[],"nets":[]}
```

`layers` limits every net to these copper layers, and `nets` routes only these nets (`iotroute run --layer`, `--net`); empty means all.
The DRC still judges the whole board, so `nets` belongs with `keep: all` on a board whose other nets are already routed.

`return_exempt: true` gives no return vias to the nets the board's gate exempts from RP-001 (`iotroute run --return-exempt`). Use it on a
board with such exemptions: a route that gives an exempt net its returns leaves the exemption stale, and the gate fails on the stale entry.

`keep: lock-nets` (default) removes all tracks and vias of the candidate and keeps only the copper of the
diff-pair nets and the DRU `via_count 0` nets (crystals), locked. `keep: all` keeps and locks all copper and
routes only the open connections. The binary comes from a cache folder per sha256 of the core sources
(`~/Library/Caches/iot-lab/iotroute/<sha>`); cargo builds it there when it is missing.

The default `--router explicit` keeps the existing track/via proposal behavior.

Candidates must pass fresh configured gates and applicable BASE/ENV semantic
checks. `adopt` verifies settled cleanup, candidate/evidence hashes, unchanged
original inputs and current native dependencies. Under the board writer lock it
backs up the original and atomically replaces only the canonical PCB. Frozen
boards require `--baseline FAILED_RUN --defect FINDING_ID` from a currently
verified failed check, with that error resolved by complete candidate evidence.
Unexecuted dependent checks never count as passing baseline evidence.

## Release, blocks and measurement

[Release workflow](RELEASE-WORKFLOW.md) describes fresh staged fabrication,
actual Gerber/BOM/CPL checks, atomic publication and separate current stock,
complete-assembly and supplier-orientation readiness. Producing a fabrication
candidate does not declare G5 approval or order boards.

[Block qualification](BLOCK-QUALIFICATION.md) describes native inventory and
source/target-bound receipts. Draft, verified applicability and measured bench
proof remain different states. Missing native bindings/reviews stay draft.

```sh
tools/pcb note RUN_ID --kind intervention 'corrected upstream pin mapping'
tools/pcb note RUN_ID --kind rework 'changed placement after native failure'
tools/pcb benchmark COLD_RUN WARM_RUN --json
```

Measurements include wall time, observed child CPU with accounting scope, cache
hits and time to complete configured targets. Failed/incomplete/tampered evidence
gets no compliance time. Comparisons require matching board, scope and source
fingerprints. Interventions/rework are explicit notes, not guessed counts or a
claim of zero human effort. Router proxy scores cannot substitute for gates.

Run status and heartbeats expose each active stage's elapsed time and age of its
last output. Terminal results and `benchmark` include measured startup, snapshot,
preflight, native KiCad, export, validation, cleanup and evidence-sealing spans. Durations use the
producer's monotonic clock; wall totals use interval unions so concurrent ERC/DRC
and nested commands are not added twice. Missing queue boundaries or interrupted
stages remain explicit unknowns. These measurements do not imply an ETA.

Run state lives in `.gate/cli/RUN_ID/`: admission `run.json`, ordered events,
atomic state, terminal result, original `gate/` reports and `operation/` logs and
source manifests. Release candidates have their own manifest. Choose another
store with `PCB_RUNS_DIR`/`--runs-dir`. Receipts detect file changes; they are
local provenance, not third-party signatures. Preserve the run for handoff.

## Verification

```sh
node --test --experimental-strip-types --no-warnings tools/lib/pcb-*.test.ts
```

Fast fixtures exercise the real supervisor, evidence seal and adoption with
controlled external tools. They establish neither shipping-board nor measured
qualification.

`tools/pcb_workflow_smoke.ts --project DIR --board BOARD --output NEW_DIR` runs one
real board through the real CLI in a throwaway copy, on Hetzner in the pinned native
image: native rejection of a short, a clearance and a wrong pad net; a placement
defect detected, repaired and adopted as real bytes on a frozen board, with a tampered
candidate refused first; an injected track gap diagnosed, repaired and adopted; and the
engineering cycle over those runs. The source project must stay unchanged. It proves the
workflow, not the board. The thermal cases of `lib/placement-outcomes.test.ts` need
`ROUTE_COVERAGE_BIN` on Linux and skip elsewhere.
