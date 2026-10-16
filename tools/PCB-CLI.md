# PCB workflow CLI

For reviewed parts, sourced placement rules, diagnostic repairs and engineering
cycle measurement, see [PCB-ENGINEERING.md](PCB-ENGINEERING.md).

`tools/pcb` is the repository entrypoint for board context, builds, explicit
placement/routing changes, checks, fabrication candidates and block evidence.
It uses existing native tools and gate targets. Requirements: macOS/Linux,
Python 3.9+, Node (CI uses 22), Git and KiCad 10.0.6. Windows is unsupported.
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
`readiness`, `parts`, `placement` and `routing` share one owned supervisor and
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

Build dispatch uses existing board pipelines; unsupported boards fail explicitly.
Placement specs use `{"place":{"R1":[x,y,degrees]}}`; routes use the existing
`pcbtool.py` format. Commands run in a separate board/dependency snapshot without
mutable links into canonical CAD. Historical runs/unrelated evidence are excluded.
Source hashes detect concurrent edits. Parts, locked footprint poses, pad/net assignments, outline,
stackup and rules remain protected; changes require an explicit design revision.

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
PYTHONPATH=tools python3 -m unittest test_pcb_cli test_pcb_workflow test_block_qualification test_native_workflow_smoke
node --test tools/lib/*.test.mjs
```

Fast fixtures exercise real CLI/gate orchestration with controlled external
tools. [Mandatory native CI](../.cip/NATIVE.md) runs real KiCad ERC/DRC/parity/
refill, placement and routing import, plus short/clearance/pad-net defect rejection
on synthetic boards. Missing runtimes/unexecuted cases fail; no skip-as-pass.
Neither fixture suite establishes shipping-board or measured qualification.

The separate mandatory `real-board-regression` job runs
`tools/real_board_regression.py --output NEW_DIRECTORY --json` using the pinned
native runtime. It copies current ENV-SENSE, injects a C1 placement defect, detects
it through the CLI, repairs the original pose, runs every configured gate and
both ENV semantic checks, rejects evidence tampering, and adopts the named frozen
defect only inside the copy. All original footprint poses and retained tracks/vias
are compared independently, the backup is byte-exact, and shipping sources must
remain unchanged. This tests the real workflow without qualifying a board.
