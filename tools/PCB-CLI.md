# PCB CLI

Run from any directory using the repository's `tools/pcb` executable. Examples
below assume the repository root; elsewhere use its absolute path. Requires
macOS or Linux, Python 3.9+, Node.js (CI uses 22), Git, and the same KiCad/tool
environment as `tools/gate.mjs`. Owned cancellation uses native Unix process
and socket support; Windows is not supported.
No installation or service is needed. `node tools/doctor.mjs` diagnoses that
environment. This first version observes **configured board gates**; it does not
build, route, export, qualify a release, or change gate targets.

```sh
tools/pcb check ENV-SENSE --follow
tools/pcb check ENV-SENSE --detach --json
tools/pcb status RUN_ID --json
tools/pcb events RUN_ID --json --wait 20
tools/pcb events RUN_ID --json --after CURSOR --wait 20
tools/pcb explain RUN_ID --json --limit 20
tools/pcb cancel RUN_ID --json
```

`check` follows by default. `--detach` immediately returns a run ID; the owned
supervisor continues after the invoking command exits. `--timeout 600` is the
default total execution budget in seconds. `--heartbeat 5` is the default
liveness interval. These are execution policies, not electrical thresholds.
Ctrl-C while following requests cancellation and follows the cleanup result.
`cancel` acknowledges a request; inspect status/events for confirmed termination.
It does not signal a stored PID. Cancellation and deadlines use the existing
`lean_owned` process-family broker; uncertain cleanup is an error.

Each run lives in `.gate/cli/RUN_ID/` (ignored by Git):

- `run.json`: operation, board/project, command, configuration hash and budgets.
- `events.jsonl`: ordered events from one supervisor; reconnectable byte cursors.
- `state.json`: atomic current status, active checks and last activity/progress.
- `result.json`: terminal outcome, metrics, input fingerprint and cleanup evidence.
- `gate/`: the gate's original native reports, provenance, live logs and events.
- `gate.log`, `worker.log`: gate/controller diagnostics.

Use `PCB_RUNS_DIR` or `--runs-dir` on each command to choose another run store.
Run IDs belong to that store and checkout. A worker lost without a terminal
result is reported as an error with cleanup unconfirmed. There is no automatic
resume or checkpoint promotion.

## Agent contract

`check --detach --json`, `status --json`, `explain --json` and `cancel --json`
return one JSON object. `check --json` while following and `events --json`
stream JSON Lines. Each event includes `schema_version`, `run_id`, `seq`, `time`,
`elapsed_s`, `type`, and a `cursor`. Pass the last returned **byte cursor**, not
the sequence number, to `events --after`. Old events/logs are not rescanned.
An incomplete trailing write is retried on the next read.

`events --wait` waits at most 60 seconds and returns as soon as events arrive or
the run is terminal. It returns at most 100 events by default; `--limit` accepts
1–1000. An empty response means no new events; read `status` for the current
state. A disconnected event reader does not cancel the run.

Events distinguish `tool.start`, `tool.output`, `tool.exit`, `check.end`,
`run.heartbeat`, `run.stopping`, and `run.end`. Tool output events carry at most
1600 characters per chunk; full output remains in the live tool log. Output
activity is not proof of algorithmic progress. A heartbeat explicitly reports
`progress: "unknown"`; native tools that expose no internal progress get no
invented percentage or ETA. `tool.exit` reports process exit, while `check.end`
reports the parsed gate verdict. Successful process exit alone cannot pass a
check.

The final `check` exit code is 0 for passed configured targets, 1 for findings,
2 for infrastructure/evidence errors, 124 for deadline, and 130 for cancellation.
Inspection commands return 0 when inspection succeeds, even for a failed run;
inspect their JSON status. Invalid arguments/runs return 2.

The CLI passes `--evidence-dir NEW_DIRECTORY` to the existing gate. This refuses
existing destinations and cannot combine with `--write`. It preserves tracked
metrics, CAD and the board's `.gate/latest.json`, so concurrent board/release
work does not consume or overwrite this observation run. The gate's source-change
detection and full targets remain authoritative. Detailed native findings from
`explain` retain the original report data and locations; other checks retain
metric causes and original logs.

## Verification

```sh
PYTHONPATH=tools python3 -m unittest -v test_pcb_cli
node --test tools/lib/gate-runtime.test.mjs tools/lib/gate-cli.test.mjs
```

The CLI integration fixtures execute the real gate with controlled fake external
tools. They exercise live output before exit, cursor replay, findings, source
changes, crash-after-clean-report, missing tools, deadlines, and cancellation
including a TERM-resistant descendant. They do not establish native KiCad or
shipping-board acceptance.

CIP runs these Python fixtures in `lean-cpu-unit-tests`; the existing
`tools/lib/*.test.mjs` glob in `workflow-unit-tests` includes the gate runtime
and command tests above.
