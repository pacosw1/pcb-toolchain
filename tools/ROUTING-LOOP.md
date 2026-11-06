# Experimental routing loop

The existing benchmark decision remains **no-go for a demonstrated scheduling
speedup**. The user explicitly authorized this experimental, opt-in controller.
It is disabled by default and makes no quality, performance or board-qualification
claim. It orchestrates existing supervised candidate runs; it does not add an
LLM inside the geometric solver or a second routing engine.

The CLI coding agent or Studio's existing Claude agent is the decision driver.
At a boundary it reads the source-bound report, supplies one fixed move and a
reason, then waits for the next supervised round. A manual Studio decision uses
exactly the same controller. Model output is data, never shell text.

## CLI

Create a bounded policy outside canonical CAD:

```json
{
  "experimental": true,
  "max_rounds": 3,
  "deadline_s": 900,
  "done_when": "verified",
  "route": {
    "schema": "iot-lab.iotroute-policy.v1",
    "iters": 80,
    "max_time_s": 120,
    "keep": "all",
    "layers": ["F.Cu", "B.Cu"],
    "nets": []
  }
}
```

```sh
tools/pcb --project PROJECT loop start BOARD --experimental --policy loop-policy.json --json
tools/pcb --project PROJECT loop wait LOOP_ID --wait 20 --json
tools/pcb --project PROJECT loop status LOOP_ID --json
tools/pcb --project PROJECT loop decide LOOP_ID --revision REVISION --decision-file decision.json --json
tools/pcb --project PROJECT loop cancel LOOP_ID --json
tools/pcb --project PROJECT loop list --json
```

A decision is a JSON object with exactly a reason and a move:

```json
{"reason":"The bound report identifies an unfinished work limit. Continue the retained candidate once.","move":{"kind":"change_setting","setting":"passes","value":120}}
```

| Move | Controller behavior |
| --- | --- |
| `change_setting` | Existing pass/time/layer validation; no expansion beyond admitted trace layers. |
| `reroute_stuck` | Existing partial reuse from the retained, sealed route and its bound work files. |
| `widen_region` | Existing named-blocker reuse; no expansion beyond an explicitly admitted net subset. |
| `single_reuse` | Explicitly switch a retained sprint trial to ordinary partial reuse when the admitted reservation covers the existing two-CPU/four-GiB ordinary runner. |
| `move_part`, `move_cluster`, `swap_pins` | Stop with a proposal for a separate explicit reviewed edit action. The routing loop does not grant placement or schematic authority. |
| `ask_user` | Stop and retain the question and reason. |
| `stop` | Stop with evidence; retain any already verified candidate. |

Packed sprints use the existing `route.sprints` policy instead of
`route.max_time_s`. Their native preparation cannot combine with partial reuse;
the controller rejects an implicit switch. `single_reuse` is explicit and may
not increase the admitted resource ceiling. Yield/resume state is retained in
the ordinary sprint artifacts, with a hash-bound pointer when available. Across
separate candidate rounds, this version uses existing copper-reuse semantics;
it does not claim to resume a checkpoint against a changed model/binary/policy.

The experimental knobs are not electrical requirements. Limits are 1 to 8
rounds and 30 to 7200 seconds overall; these are admission bounds, not a promise
that native verification fits. The ordinary supervisor owns every child and
its cleanup. The loop deadline includes daemon queue time and uses the existing
steady clock to prevent wall-clock rollback from granting more budget.

## Durable evidence and stop rules

One `.gate/loops/loop-ID/state.json` records immutable source/policy bindings,
round/child IDs, decisions/reasons, receipt hashes, reports, available resumable
state, and separate search and verified incumbents. `events.jsonl` records
state transitions. Every candidate remains an ordinary `.gate/cli/run-ID` with
its existing isolated workspace, native/configured checks, semantic hooks and
terminal seal. No loop result is an adoption receipt.

Decision revisions are checked under the existing file lock. Replaying the
same decision is idempotent; a changed stale decision is refused. A persisted
launch intent is recovered from its exact child context. An ambiguous launch
stops rather than starting duplicate work. A saved terminal boundary can be
reconciled after a process restart. Source or immutable-policy drift blocks new
rounds. Cancellation/timeout is not settled until the child receipt confirms
cleanup; such receipts cannot qualify a candidate or permit adoption.

The same failure cause twice stops unchanged native retries. Invalid inputs,
missing bound diagnoses and unconfirmed cleanup stop earlier. No hard rule,
clearance, return exemption, frozen part, reviewed movement boundary or final
gate can be bought with a better soft score. Passing candidates are compared
only when their whole-board length/via scores are known under the existing
`routedQuality` definition. Unsupported geometry stays unknown, never zero.
Search progress is unqualified; it never replaces the verified incumbent.

## Studio

Runs shows **Experimental routing loop**. Enable it explicitly and select the
round/time bounds. The existing agent tools are `start_loop`, `wait_loop`,
`decide_loop` and `cancel_loop`; every decision requires a reason. The agent
waits at boundaries, not inside individual graph-search steps.

Round history exposes each decision, retained candidate and live round.
**Watch round** reuses the existing live solver viewer and labeled local/remote
job stream. **View candidate** opens the private candidate. Canonical adoption
remains the separate, reverified `pcb adopt` workflow. No loop adoption tool or
web-viewer write permission was added.

The project must use a toolchain release containing `pcb loop`. Updating the
app alone does not rewrite its pinned toolchain or certify existing boards.

## Verification scope

Controller tests cover explicit opt-in, source/layer/net/immutable-policy bounds,
revision replay/concurrency, interrupted launch/boundary recovery, repeated
causes, steady deadlines, cancellation, cleanup and incumbent retention. The
production-backend test uses actual ordinary supervisors, snapshots, move
validation and sealed receipts with deterministic router/gate fixture tools.
Studio bridge and agent-tool tests use the same command/API contracts. The
Electron test navigates the real rendered app with a temporary project and local
live-data fixture, checks the applied selected-round events, and captures live
and candidate screenshots. These are controller/UI proofs, not native PCB
acceptance, a benchmark of LLM decisions, fabrication or physical qualification.
